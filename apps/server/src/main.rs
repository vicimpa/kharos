//! Сервер Kharos (apps/server/main.ts в TS; docs/net.md, Н3). Мир считает один поток: машина Luau не переходит между
//! потоками. Каждое подключение — свой поток с WebSocket; с потоком игры они говорят каналами. TLS здесь нет: wss даёт
//! nginx перед сервером.
//!
//! Настройки — settings.json в рабочей папке (SETTINGS меняет путь): нет файла — он пишется со значениями по
//! умолчанию. Консоль — те же команды, что в чате у администратора (`help`, `say`, `kick`, `save`, `stop` …), и
//! `players` — все игроки мира.

use kharos_content::{discover, Mod};
use kharos_net::protocol::{Message, DEFAULT_PORT};
use kharos_net::server::{Caller, PeerId, Request, Server, STEP};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;
use std::io::{BufRead, ErrorKind};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// Как часто сервер сохраняет мир и пишет в консоль, что с ним.
const SAVE_EVERY: Duration = Duration::from_secs(30);
const REPORT_EVERY: Duration = Duration::from_secs(60);
/// Длиннее сообщение клиента сокет не принимает: приказ всем своим юнитам в разы короче.
const MESSAGE_MOST: usize = 256 * 1024;
/// Сколько ждать, пока подключение пришлёт что-нибудь, прежде чем заглянуть, нет ли чего отправить.
const POLL: Duration = Duration::from_millis(5);
/// Сколько ждать рукопожатия WebSocket.
const HANDSHAKE: Duration = Duration::from_secs(10);

/// Настройки из settings.json.
struct Settings {
  port: u16,
  /// Пароль на вход; пустой — заходит кто угодно.
  password: String,
  /// Пароль режима администратора (/admin в чате); пустой — режима нет.
  admin: String,
  /// Файл сохранения мира.
  save: PathBuf,
  /// Партия нового мира — вид из games/, её настройки (ложатся в data партии: size, fog …) и зерно.
  game: String,
  options: Json,
  seed: u64,
  /// Папки с модами: каждая — как `mods` у клиента; у клиентов должны быть те же моды.
  mods: Vec<PathBuf>,
}

fn defaults() -> Json {
  let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |time| time.as_secs() % 2_147_483_647);
  json!({ "port": DEFAULT_PORT, "password": "", "admin": "", "save": "save.kharos.json", "game": "skirmish", "options": { "size": 512, "spread": true, "protection": 10 }, "seed": seed, "mods": ["mods"] })
}

/// Настройки: нет файла — пишется по умолчанию, чтобы было что править; неизвестные ключи — предупреждение, а не тишина.
fn settings() -> Result<Settings, String> {
  let path = PathBuf::from(std::env::var("SETTINGS").unwrap_or_else(|_| "settings.json".into()));
  let mut all = defaults();
  match std::fs::read_to_string(&path) {
    Ok(text) => {
      let read: Json = serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
      for (key, value) in read.as_object().ok_or_else(|| format!("{}: ожидался объект", path.display()))? {
        if all.get(key).is_none() {
          eprintln!("{}: неизвестный параметр {key}", path.display());
        }
        all[key] = value.clone();
      }
    }
    Err(error) if error.kind() == ErrorKind::NotFound => {
      std::fs::write(&path, serde_json::to_string_pretty(&all).expect("JSON")).map_err(|error| format!("{}: {error}", path.display()))?;
      println!("настройки по умолчанию записаны в {}", path.display());
    }
    Err(error) => return Err(format!("{}: {error}", path.display())),
  }
  let text = |key: &str| all[key].as_str().map(str::to_string).ok_or_else(|| format!("{key}: ожидалась строка"));
  Ok(Settings {
    port: std::env::var("PORT").ok().and_then(|port| port.parse().ok()).or_else(|| all["port"].as_u64().map(|port| port as u16)).ok_or("port: ожидалось число")?,
    password: text("password")?,
    admin: text("admin")?,
    save: PathBuf::from(std::env::var("SAVE").or_else(|_| text("save"))?),
    game: text("game")?,
    options: all["options"].clone(),
    seed: all["seed"].as_u64().ok_or("seed: ожидалось число")?,
    mods: all["mods"].as_array().ok_or("mods: ожидался список")?.iter().map(|dir| dir.as_str().map(PathBuf::from).ok_or("mods: ожидались строки")).collect::<Result<_, _>>()?,
  })
}

fn mods(roots: &[PathBuf]) -> Result<Vec<Mod>, String> {
  let mut all = Vec::new();
  for root in roots {
    all.extend(discover(root).map_err(|error| format!("моды {}: {error}", root.display()))?);
  }
  Ok(all)
}

/// Пишет во временный файл и подменяет им сохранение: упавший посреди записи сервер не оставит половину файла.
fn store(server: &Server, path: &Path) {
  let started = Instant::now();
  let result = server.save().and_then(|saved| {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, saved.to_string()).and_then(|_| std::fs::rename(&temporary, path)).map_err(|error| error.to_string())
  });
  match result {
    Ok(()) => println!("мир сохранён за {} мс", started.elapsed().as_millis()),
    Err(error) => eprintln!("сохранение: {error}"),
  }
}

/// Мир из сохранения, а без него — новый. Файл, который не читается, откладывается в сторону: молча перезаписать его
/// значило бы потерять старый мир.
fn world(settings: &Settings, mods: Vec<Mod>) -> Result<Server, String> {
  match std::fs::read_to_string(&settings.save) {
    Ok(text) => {
      let loaded = serde_json::from_str::<Json>(&text).map_err(|error| error.to_string()).and_then(|saved| Server::load(mods.clone(), &saved, settings.password.clone()));
      match loaded {
        Ok(server) => {
          println!("мир загружен из {}", settings.save.display());
          return Ok(server);
        }
        Err(error) => {
          let aside = settings.save.with_extension(format!("broken-{}", std::process::id()));
          eprintln!("{}: {error}; отложен в {}, мир начинается заново", settings.save.display(), aside.display());
          std::fs::rename(&settings.save, &aside).map_err(|error| error.to_string())?;
        }
      }
    }
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    Err(error) => return Err(format!("{}: {error}", settings.save.display())),
  }
  println!("новый мир: {}, зерно {}", settings.game, settings.seed);
  Server::new(mods, Some(&settings.game), settings.seed, settings.options.clone(), settings.password.clone())
}

/// Что приходит потоку игры.
enum Event {
  Open(u64, Sender<Out>),
  Message(u64, Message),
  Closed(u64),
  Console(String),
}

/// Что поток игры шлёт подключению.
enum Out {
  Send(Message),
  Close,
}

/// Поток подключения: рукопожатие, потом попеременно — отправить накопленное и подождать входящее.
fn connection(stream: TcpStream, id: u64, events: Sender<Event>) {
  let address = stream.peer_addr().map(|address| address.to_string()).unwrap_or_default();
  let _ = stream.set_nodelay(true);
  let _ = stream.set_read_timeout(Some(HANDSHAKE));
  let config = tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(MESSAGE_MOST)).max_frame_size(Some(MESSAGE_MOST));
  let mut socket = match tungstenite::accept_with_config(stream, Some(config)) {
    Ok(socket) => socket,
    Err(error) => {
      eprintln!("{address}: рукопожатие: {error}");
      return;
    }
  };
  let _ = socket.get_ref().set_read_timeout(Some(POLL));
  let (sender, outbox) = channel();
  if events.send(Event::Open(id, sender)).is_err() {
    return;
  }
  'live: loop {
    loop {
      match outbox.try_recv() {
        Ok(Out::Send(message)) => {
          let frame = match message {
            Message::Text(text) => tungstenite::Message::text(text),
            Message::Binary(bytes) => tungstenite::Message::binary(bytes),
          };
          if socket.write(frame).is_err() {
            break 'live;
          }
        }
        Ok(Out::Close) => {
          let _ = socket.flush();
          let _ = socket.close(None);
          let _ = socket.flush();
          break 'live;
        }
        Err(std::sync::mpsc::TryRecvError::Empty) => break,
        Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'live,
      }
    }
    match socket.flush() {
      Ok(()) => {}
      Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
      Err(_) => break,
    }
    match socket.read() {
      Ok(tungstenite::Message::Text(text)) => {
        let _ = events.send(Event::Message(id, Message::Text(text.to_string())));
      }
      Ok(tungstenite::Message::Binary(bytes)) => {
        let _ = events.send(Event::Message(id, Message::Binary(bytes.to_vec())));
      }
      Ok(tungstenite::Message::Close(_)) => break,
      Ok(_) => {}
      Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
      Err(_) => break,
    }
  }
  let _ = events.send(Event::Closed(id));
}

fn listen(port: u16, events: Sender<Event>) -> Result<(), String> {
  let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|error| format!("порт {port}: {error}"))?;
  println!("слушаю ws://0.0.0.0:{port}");
  std::thread::spawn(move || {
    let next = AtomicU64::new(1);
    for stream in listener.incoming().flatten() {
      let (id, events) = (next.fetch_add(1, Ordering::Relaxed), events.clone());
      std::thread::spawn(move || connection(stream, id, events));
    }
  });
  Ok(())
}

fn console(events: Sender<Event>) {
  std::thread::spawn(move || {
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
      if events.send(Event::Console(line)).is_err() {
        return;
      }
    }
  });
}

fn run() -> Result<(), String> {
  let settings = settings()?;
  let mods = mods(&settings.mods)?;
  let mut server = world(&settings, mods)?;
  server.admin = settings.admin.clone();
  let (events, inbox): (Sender<Event>, Receiver<Event>) = channel();
  listen(settings.port, events.clone())?;
  console(events);
  // Подключение → его номер у сервера и куда ему писать.
  let mut peers: BTreeMap<u64, (PeerId, Sender<Out>)> = BTreeMap::new();
  let step = Duration::from_secs_f64(STEP);
  let (mut next, mut saved, mut reported) = (Instant::now() + step, Instant::now(), Instant::now());
  let (mut ticks, mut spent) = (0u32, Duration::ZERO);
  loop {
    match inbox.recv_timeout(next.saturating_duration_since(Instant::now())) {
      Ok(Event::Open(id, sender)) => {
        peers.insert(id, (server.connect(), sender));
      }
      Ok(Event::Message(id, message)) => {
        if let Some((peer, _)) = peers.get(&id) {
          server.receive(*peer, message)?;
        }
      }
      Ok(Event::Closed(id)) => {
        if let Some((peer, _)) = peers.remove(&id) {
          server.disconnect(peer);
        }
      }
      Ok(Event::Console(line)) => match line.trim() {
        "players" => {
          for (id, player) in &server.players {
            println!("{} «{}» — {}", player.number, player.name, &id[..8]);
          }
        }
        "" => {}
        command => server.command(command, Caller::Console),
      },
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return Err("потоки сети остановились".into()),
    }
    for line in server.log.drain(..) {
      println!("{line}");
    }
    for request in std::mem::take(&mut server.requests) {
      store(&server, &settings.save);
      if request == Request::Stop {
        return Ok(());
      }
    }
    // Входящее разбирается до каждого тика, а тик — по часам: отстали больше чем на секунду — не догоняем.
    let now = Instant::now();
    if now < next {
      continue;
    }
    next = if now - next > Duration::from_secs(1) { now + step } else { next + step };
    let started = Instant::now();
    server.tick()?;
    for (peer, sender) in peers.values() {
      let (messages, closing) = server.take(*peer);
      for message in messages {
        let _ = sender.send(Out::Send(message));
      }
      if closing {
        let _ = sender.send(Out::Close);
      }
    }
    spent += started.elapsed();
    ticks += 1;
    if saved.elapsed() >= SAVE_EVERY {
      store(&server, &settings.save);
      saved = Instant::now();
    }
    if reported.elapsed() >= REPORT_EVERY {
      println!("тик {}: игроков в сети {}, всего {}, тик в среднем {:.1} мс", server.host.state.borrow().tick, server.online(), server.players.len(), spent.as_secs_f64() * 1000.0 / ticks.max(1) as f64);
      (ticks, spent, reported) = (0, Duration::ZERO, Instant::now());
    }
  }
}

fn main() {
  if let Err(error) = run() {
    eprintln!("{error}");
    std::process::exit(1);
  }
}
