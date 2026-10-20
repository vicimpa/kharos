//! Связь клиента с сервером (connect.ts): сообщения туда и обратно. Петля (`KHAROS_NET=loopback`) держит сервер в том
//! же процессе и ведёт его тики по часам кадров — так игра через реплику проверяется без сокетов; `Socket` — WebSocket
//! в своём потоке (окно).

use kharos_content::Mod;
use kharos_net::protocol::{mods_sum, ClientMessage, Message, ServerMessage, VERSION};
use kharos_net::server::{PeerId, Server, STEP};

pub trait Link {
  fn send(&mut self, message: Message);
  /// Что пришло с прошлого раза.
  fn receive(&mut self) -> Vec<Message>;
  /// Кадр клиента в now секунд.
  fn update(&mut self, _now: f64) -> Result<(), String> {
    Ok(())
  }
  /// Связь оборвалась: почему (ключ словаря или текст).
  fn closed(&self) -> Option<String>;
}

/// Вход: что сказал сервер.
pub struct Welcome {
  pub player: u32,
  pub id: String,
  pub game: String,
  pub options: serde_json::Value,
  pub seed: u64,
}

/// Первое сообщение клиента.
pub fn hello(mods: &[Mod], name: &str, id: Option<String>, password: &str) -> Message {
  Message::Text(ClientMessage::Hello { version: VERSION, mods: mods_sum(mods), name: name.into(), id, password: password.into() }.text())
}

/// Приветствие или отказ из сообщения сервера; None — не они.
pub fn welcome(message: &Message) -> Result<Option<Welcome>, String> {
  let Message::Text(text) = message else { return Ok(None) };
  match ServerMessage::parse(text)? {
    ServerMessage::Welcome { player, id, game, options, seed, .. } => Ok(Some(Welcome { player, id, game, options, seed })),
    ServerMessage::Refused { reason, .. } => Err(reason),
  }
}

/// Сервер в том же процессе.
pub struct Loopback {
  server: Server,
  peer: PeerId,
  inbox: Vec<Message>,
  last: Option<f64>,
  accumulator: f64,
}

impl Loopback {
  pub fn new(server: Server) -> Self {
    let mut server = server;
    let peer = server.connect();
    Self { server, peer, inbox: Vec::new(), last: None, accumulator: 0.0 }
  }

  fn collect(&mut self) {
    self.inbox.extend(self.server.take(self.peer).0);
  }

  /// Входит, как вошёл бы клиент по сети: приветствие — сразу.
  pub fn enter(&mut self, mods: &[Mod]) -> Result<Welcome, String> {
    self.send(hello(mods, "", None, ""));
    let messages = self.receive();
    let mut found = None;
    for message in &messages {
      if let Some(welcome) = welcome(message)? {
        found = Some(welcome);
      }
    }
    found.ok_or_else(|| "сервер не ответил на вход".into())
  }
}

impl Link for Loopback {
  fn send(&mut self, message: Message) {
    if let Err(error) = self.server.receive(self.peer, message) {
      eprintln!("петля: {error}");
    }
    self.collect();
  }

  fn receive(&mut self) -> Vec<Message> {
    std::mem::take(&mut self.inbox)
  }

  fn update(&mut self, now: f64) -> Result<(), String> {
    let dt = self.last.map_or(0.0, |last| (now - last).clamp(0.0, 0.25));
    self.last = Some(now);
    self.accumulator += dt;
    let mut ticks = 0;
    while self.accumulator >= STEP && ticks < 5 {
      self.server.tick()?;
      self.accumulator -= STEP;
      ticks += 1;
    }
    if ticks == 5 {
      self.accumulator = 0.0;
    }
    self.collect();
    Ok(())
  }

  fn closed(&self) -> Option<String> {
    None
  }
}

/// WebSocket в своём потоке: поток пишет накопленное и ждёт входящее попеременно, с игрой говорит каналами.
#[cfg(not(target_arch = "wasm32"))]
pub struct Socket {
  out: std::sync::mpsc::Sender<Message>,
  inbox: std::sync::mpsc::Receiver<Message>,
  closed: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Socket {
  /// Подключается к url (ws://адрес:порт) и сразу шлёт вход.
  pub fn connect(url: &str, hello: Message) -> Result<Self, String> {
    use std::io::ErrorKind;
    let (mut socket, _) = tungstenite::connect(url).map_err(|error| format!("{url}: {error}"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_ref() {
      let _ = stream.set_nodelay(true);
      let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(5)));
    }
    let (out, outbox) = std::sync::mpsc::channel::<Message>();
    let (deliver, inbox) = std::sync::mpsc::channel();
    let closed = std::sync::Arc::new(std::sync::Mutex::new(None));
    let flag = closed.clone();
    out.send(hello).map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
      let reason = 'live: loop {
        while let Ok(message) = outbox.try_recv() {
          let frame = match message {
            Message::Text(text) => tungstenite::Message::text(text),
            Message::Binary(bytes) => tungstenite::Message::binary(bytes),
          };
          if let Err(error) = socket.write(frame) {
            break 'live error.to_string();
          }
        }
        match socket.flush() {
          Ok(()) => {}
          Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
          Err(error) => break error.to_string(),
        }
        match socket.read() {
          Ok(tungstenite::Message::Text(text)) => {
            let _ = deliver.send(Message::Text(text.to_string()));
          }
          Ok(tungstenite::Message::Binary(bytes)) => {
            let _ = deliver.send(Message::Binary(bytes.to_vec()));
          }
          Ok(tungstenite::Message::Close(_)) => break "сервер закрыл соединение".into(),
          Ok(_) => {}
          Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
          Err(error) => break error.to_string(),
        }
      };
      *flag.lock().expect("флаг") = Some(reason);
    });
    Ok(Self { out, inbox, closed })
  }

  /// Ждёт приветствия до timeout: вошли — приветствие, отказ или тишина — ошибка. Пришедшее после приветствия
  /// остаётся в очереди.
  pub fn welcome(&mut self, timeout: std::time::Duration) -> Result<Welcome, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
      let left = deadline.saturating_duration_since(std::time::Instant::now());
      match self.inbox.recv_timeout(left) {
        Ok(message) => {
          if let Some(welcome) = welcome(&message)? {
            return Ok(welcome);
          }
        }
        Err(_) => return Err(self.closed().unwrap_or_else(|| "сервер не ответил на вход".into())),
      }
    }
  }
}

#[cfg(not(target_arch = "wasm32"))]
impl Link for Socket {
  fn send(&mut self, message: Message) {
    let _ = self.out.send(message);
  }

  fn receive(&mut self) -> Vec<Message> {
    self.inbox.try_iter().collect()
  }

  fn closed(&self) -> Option<String> {
    // Что пришло до обрыва, игра разберёт раньше: обрыв — когда очередь пуста.
    self.closed.lock().expect("флаг").clone()
  }
}
