//! Связь клиента с сервером (connect.ts): сообщения туда и обратно. Петля (`KHAROS_NET=loopback`) держит сервер в том
//! же процессе и ведёт его тики по часам кадров — так игра через реплику проверяется без сокетов; `Socket` — WebSocket
//! в своём потоке (окно).

use kharos_content::Mod;
use kharos_net::protocol::{mods_sum, ClientMessage, Message, ServerMessage, VERSION};
#[cfg(not(target_arch = "wasm32"))]
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
    _ => Ok(None),
  }
}

/// Адрес, по которому не стоит и пробовать: не ws:// или wss://, или страница по https, а сервер — по ws:// не на этом
/// компьютере (браузер такое блокирует). Ошибка — { key, url }.
pub fn refuse_url(url: &str) -> Option<serde_json::Value> {
  if !(url.starts_with("ws://") || url.starts_with("wss://")) || url.len() < 7 {
    return Some(serde_json::json!({ "key": "net.cannotConnect", "url": url }));
  }
  #[cfg(target_arch = "wasm32")]
  {
    let secure = web_sys::window().and_then(|window| window.location().protocol().ok()).is_some_and(|protocol| protocol == "https:");
    let local = ["ws://localhost", "ws://127.0.0.1", "ws://[::1]"].iter().any(|start| url.starts_with(start));
    if secure && url.starts_with("ws://") && !local {
      return Some(serde_json::json!({ "key": "net.insecure", "url": url }));
    }
  }
  None
}

/// Сервер в том же процессе.
#[cfg(not(target_arch = "wasm32"))]
pub struct Loopback {
  server: Server,
  peer: PeerId,
  inbox: Vec<Message>,
  last: Option<f64>,
  accumulator: f64,
}

#[cfg(not(target_arch = "wasm32"))]
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
    let mut found = None;
    for message in self.receive() {
      match found {
        // Пришедшее вместе с приветствием (команды, игроки) — партии.
        Some(_) => self.inbox.push(message),
        None => found = welcome(&message)?,
      }
    }
    found.ok_or_else(|| "сервер не ответил на вход".into())
  }
}

#[cfg(not(target_arch = "wasm32"))]
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

/// Связь с сервером по адресу url (ws:// или wss://): вход уходит, как только она откроется. Не ждёт: открылась ли
/// она и что ответил сервер, видно по `receive` и `closed`.
pub fn open(url: &str, hello: Message) -> Box<dyn Link> {
  #[cfg(not(target_arch = "wasm32"))]
  return Box::new(Socket::open(url, hello));
  #[cfg(target_arch = "wasm32")]
  return Box::new(WebLink::open(url, hello));
}

/// Связь и то, что из неё уже прочитано: приветствие пришло вместе с первыми кадрами — они не пропадут.
pub struct Buffered {
  pub link: Box<dyn Link>,
  pub pending: Vec<Message>,
}

impl Link for Buffered {
  fn send(&mut self, message: Message) {
    self.link.send(message);
  }

  fn receive(&mut self) -> Vec<Message> {
    let mut all = std::mem::take(&mut self.pending);
    all.extend(self.link.receive());
    all
  }

  fn update(&mut self, now: f64) -> Result<(), String> {
    self.link.update(now)
  }

  fn closed(&self) -> Option<String> {
    if self.pending.is_empty() {
      self.link.closed()
    } else {
      None
    }
  }
}

/// WebSocket в своём потоке: поток подключается, потом пишет накопленное и ждёт входящее попеременно; с игрой говорит
/// каналами. Обрыв — ключ словаря: `net.cannotConnect` (не открылась), `net.lost` (оборвалась).
#[cfg(not(target_arch = "wasm32"))]
pub struct Socket {
  out: std::sync::mpsc::Sender<Message>,
  inbox: std::sync::mpsc::Receiver<Message>,
  closed: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Socket {
  pub fn open(url: &str, hello: Message) -> Self {
    use std::io::ErrorKind;
    let (out, outbox) = std::sync::mpsc::channel::<Message>();
    let (deliver, inbox) = std::sync::mpsc::channel();
    let closed = std::sync::Arc::new(std::sync::Mutex::new(None));
    let flag = closed.clone();
    let _ = out.send(hello);
    let url = url.to_string();
    std::thread::spawn(move || {
      let mut socket = match tungstenite::connect(url.as_str()) {
        Ok((socket, _)) => socket,
        Err(error) => {
          eprintln!("{url}: {error}");
          *flag.lock().expect("флаг") = Some("net.cannotConnect".into());
          return;
        }
      };
      if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_ref() {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(5)));
      }
      'live: loop {
        while let Ok(message) = outbox.try_recv() {
          let frame = match message {
            Message::Text(text) => tungstenite::Message::text(text),
            Message::Binary(bytes) => tungstenite::Message::binary(bytes),
          };
          if socket.write(frame).is_err() {
            break 'live;
          }
        }
        match socket.flush() {
          Ok(()) => {}
          Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
          Err(_) => break,
        }
        match socket.read() {
          Ok(tungstenite::Message::Text(text)) => {
            let _ = deliver.send(Message::Text(text.to_string()));
          }
          Ok(tungstenite::Message::Binary(bytes)) => {
            let _ = deliver.send(Message::Binary(bytes.to_vec()));
          }
          Ok(tungstenite::Message::Close(_)) => break,
          Ok(_) => {}
          Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
          Err(_) => break,
        }
        // Игра закрыла связь (вышла из партии) — поток кончается.
        if matches!(outbox.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)) {
          let _ = socket.close(None);
          let _ = socket.flush();
          break;
        }
      }
      *flag.lock().expect("флаг") = Some("net.lost".into());
    });
    Self { out, inbox, closed }
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
    self.closed.lock().expect("флаг").clone()
  }
}

/// WebSocket браузера: события кладут пришедшее в очередь, игра забирает её в кадре.
#[cfg(target_arch = "wasm32")]
pub struct WebLink {
  /// Нет — адрес не принят: связь сразу закрыта.
  socket: Option<web_sys::WebSocket>,
  inbox: std::rc::Rc<std::cell::RefCell<Vec<Message>>>,
  /// Отправленное до того, как связь открылась.
  waiting: std::rc::Rc<std::cell::RefCell<Vec<Message>>>,
  closed: std::rc::Rc<std::cell::RefCell<Option<String>>>,
  _handlers: Vec<wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>>,
}

#[cfg(target_arch = "wasm32")]
fn web_send(socket: &web_sys::WebSocket, message: &Message) {
  let _ = match message {
    Message::Text(text) => socket.send_with_str(text),
    Message::Binary(bytes) => socket.send_with_u8_array(bytes),
  };
}

#[cfg(target_arch = "wasm32")]
impl WebLink {
  pub fn open(url: &str, hello: Message) -> Self {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::JsCast;
    let inbox = Rc::new(RefCell::new(Vec::new()));
    let waiting = Rc::new(RefCell::new(vec![hello]));
    let closed = Rc::new(RefCell::new(None));
    let socket = match web_sys::WebSocket::new(url) {
      Ok(socket) => socket,
      Err(_) => {
        *closed.borrow_mut() = Some("net.cannotConnect".into());
        return Self { socket: None, inbox, waiting, closed, _handlers: Vec::new() };
      }
    };
    socket.set_binary_type(web_sys::BinaryType::Arraybuffer);
    let opened = Rc::new(Cell::new(false));
    let on_open = {
      let (socket, waiting, opened) = (socket.clone(), waiting.clone(), opened.clone());
      Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
        opened.set(true);
        for message in waiting.borrow_mut().drain(..) {
          web_send(&socket, &message);
        }
      })
    };
    let on_message = {
      let inbox = inbox.clone();
      Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
        let Ok(event) = event.dyn_into::<web_sys::MessageEvent>() else { return };
        let data = event.data();
        if let Some(text) = data.as_string() {
          inbox.borrow_mut().push(Message::Text(text));
        } else if let Ok(buffer) = data.dyn_into::<js_sys::ArrayBuffer>() {
          inbox.borrow_mut().push(Message::Binary(js_sys::Uint8Array::new(&buffer).to_vec()));
        }
      })
    };
    let on_close = {
      let (closed, opened) = (closed.clone(), opened.clone());
      Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
        *closed.borrow_mut() = Some(if opened.get() { "net.lost" } else { "net.cannotConnect" }.into());
      })
    };
    socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));
    Self { socket: Some(socket), inbox, waiting, closed, _handlers: vec![on_open, on_message, on_close] }
  }
}

#[cfg(target_arch = "wasm32")]
impl Link for WebLink {
  fn send(&mut self, message: Message) {
    match &self.socket {
      Some(socket) if socket.ready_state() == web_sys::WebSocket::OPEN => web_send(socket, &message),
      _ => self.waiting.borrow_mut().push(message),
    }
  }

  fn receive(&mut self) -> Vec<Message> {
    std::mem::take(&mut *self.inbox.borrow_mut())
  }

  fn closed(&self) -> Option<String> {
    self.closed.borrow().clone()
  }
}

#[cfg(target_arch = "wasm32")]
impl Drop for WebLink {
  fn drop(&mut self) {
    if let Some(socket) = &self.socket {
      socket.set_onopen(None);
      socket.set_onmessage(None);
      socket.set_onclose(None);
      let _ = socket.close();
    }
  }
}
