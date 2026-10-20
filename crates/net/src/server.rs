//! Хост с подключёнными игроками (createHost в host.ts). Про сокеты не знает: подключение приносит сообщения и
//! забирает свои, сервер за WebSocket и петля в одном процессе (`KHAROS_NET=loopback`) зовут одно и то же.

use crate::protocol::{clean_name, mods_sum, ClientMessage, Message, ServerMessage, FRAME, VERSION};
use crate::{Rules, Shared, View};
use kharos_content::Mod;
use kharos_world::Host;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::rc::Rc;

pub type PeerId = u64;

/// Совпадают ли строки, за одно и то же время при любом месте расхождения: пароль не подобрать по задержке ответа.
fn same(a: &str, b: &str) -> bool {
  let (a, b) = (a.as_bytes(), b.as_bytes());
  let mut differ = (a.len() != b.len()) as u8;
  for index in 0..a.len().max(b.len()) {
    differ |= a.get(index).copied().unwrap_or(0) ^ b.get(index).copied().unwrap_or(0);
  }
  differ == 0
}

/// Игрок сервера: номер в мире и ник.
#[derive(Clone, Debug, PartialEq)]
pub struct Player {
  pub number: u32,
  pub name: String,
}

struct Peer {
  /// За кого играет — после входа.
  player: Option<u32>,
  view: Option<View>,
  outbox: Vec<Message>,
  /// Пора закрыть: отказ ушёл или клиент прислал не то.
  closing: bool,
}

pub struct Server {
  pub host: Host,
  game: String,
  options: Json,
  seed: u64,
  password: String,
  rules: Rc<Rules>,
  mods: String,
  peers: BTreeMap<PeerId, Peer>,
  next_peer: PeerId,
  /// Под каким именем сервер помнит игрока → игрок.
  pub players: BTreeMap<String, Player>,
  /// Счётчик для новых имён.
  minted: u64,
}

/// Длина тика.
pub const STEP: f64 = 0.05;

/// Версия сохранения сервера.
pub const SAVE_VERSION: u64 = 1;

impl Server {
  /// Новый мир партии game: тот же `Host::new`, что соберёт себе каждый клиент для реплики.
  pub fn new(mods: Vec<Mod>, game: Option<&str>, seed: u64, options: Json, password: String) -> Result<Self, String> {
    let sum = mods_sum(&mods);
    let mut host = Host::new(mods, game, seed, &options)?;
    host.start()?;
    Self::with(host, sum, seed, options, password, BTreeMap::new())
  }

  /// Мир из сохранения (`save`): партия, настройки и зерно — оттуда, игроки — те же.
  pub fn load(mods: Vec<Mod>, saved: &Json, password: String) -> Result<Self, String> {
    if saved.get("version").and_then(Json::as_u64) != Some(SAVE_VERSION) {
      return Err("сохранение другой версии".into());
    }
    let game = saved.get("game").and_then(Json::as_str).ok_or("в сохранении нет партии")?;
    let seed = saved.get("seed").and_then(Json::as_u64).unwrap_or(1);
    let options = saved.get("options").cloned().unwrap_or(Json::Null);
    let sum = mods_sum(&mods);
    let mut host = Host::new(mods, Some(game), seed, &options)?;
    host.restore(saved.get("world").ok_or("в сохранении нет мира")?)?;
    let mut players = BTreeMap::new();
    for (id, player) in saved.get("players").and_then(Json::as_object).into_iter().flatten() {
      let number = player.get("number").and_then(Json::as_u64).ok_or("игрок без номера")? as u32;
      let name = player.get("name").and_then(Json::as_str).unwrap_or("").to_string();
      players.insert(id.clone(), Player { number, name });
    }
    Self::with(host, sum, seed, options, password, players)
  }

  fn with(host: Host, mods: String, seed: u64, options: Json, password: String, players: BTreeMap<String, Player>) -> Result<Self, String> {
    let schema = host.state.borrow().world.schema.clone();
    let rules = Rc::new(Rules::of(&host.content, &schema)?);
    Ok(Self { game: host.game.clone(), host, options, seed, password, rules, mods, peers: BTreeMap::new(), next_peer: 1, players, minted: 0 })
  }

  /// Сохранение сервера: мир, игроки по именам, партия, её настройки и зерно.
  pub fn save(&self) -> Result<Json, String> {
    let players: serde_json::Map<String, Json> = self.players.iter().map(|(id, player)| (id.clone(), serde_json::json!({ "number": player.number, "name": player.name }))).collect();
    Ok(serde_json::json!({ "version": SAVE_VERSION, "game": self.game, "seed": self.seed, "options": self.options, "players": players, "world": self.host.snapshot()? }))
  }

  /// Сколько подключений вошло в игру.
  pub fn online(&self) -> usize {
    self.peers.values().filter(|peer| peer.player.is_some()).count()
  }

  /// Новое подключение: ждёт входа.
  pub fn connect(&mut self) -> PeerId {
    let id = self.next_peer;
    self.next_peer += 1;
    self.peers.insert(id, Peer { player: None, view: None, outbox: Vec::new(), closing: false });
    id
  }

  pub fn disconnect(&mut self, peer: PeerId) {
    self.peers.remove(&peer);
  }

  /// Что отправить подключению и не пора ли его закрыть.
  pub fn take(&mut self, peer: PeerId) -> (Vec<Message>, bool) {
    match self.peers.get_mut(&peer) {
      Some(state) => (std::mem::take(&mut state.outbox), state.closing),
      None => (Vec::new(), true),
    }
  }

  /// Кто сейчас играет за кого: номер игрока подключения.
  pub fn player_of(&self, peer: PeerId) -> Option<u32> {
    self.peers.get(&peer).and_then(|state| state.player)
  }

  fn refuse(&mut self, peer: PeerId, reason: &str, password: bool) {
    if let Some(state) = self.peers.get_mut(&peer) {
      state.outbox.push(Message::Text(ServerMessage::Refused { reason: reason.into(), password }.text()));
      state.closing = true;
    }
  }

  /// Новое имя игрока: его не угадать по прошлым — оно и есть пропуск к его миру.
  fn mint(&mut self) -> String {
    use std::hash::{BuildHasher, Hasher};
    self.minted += 1;
    let keys = std::collections::hash_map::RandomState::new();
    let mut parts = [0u64; 2];
    for (index, part) in parts.iter_mut().enumerate() {
      let mut hasher = keys.build_hasher();
      hasher.write_u64(self.minted);
      hasher.write_usize(index);
      hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |time| time.as_nanos()));
      *part = hasher.finish();
    }
    format!("{:016x}{:016x}", parts[0], parts[1])
  }

  /// Сообщение подключения.
  pub fn receive(&mut self, peer: PeerId, message: Message) -> Result<(), String> {
    let Some(state) = self.peers.get(&peer) else { return Ok(()) };
    if state.closing {
      return Ok(());
    }
    let text = match message {
      Message::Text(text) => text,
      Message::Binary(_) => {
        self.refuse(peer, "net.garbled", false);
        return Ok(());
      }
    };
    let message = match ClientMessage::parse(&text) {
      Ok(message) => message,
      Err(_) => {
        self.refuse(peer, "net.garbled", false);
        return Ok(());
      }
    };
    match (state.player, message) {
      (None, ClientMessage::Hello { version, mods, name, id, password }) => self.hello(peer, version, mods, name, id, password),
      (Some(player), ClientMessage::Command { name, args }) => {
        self.host.send(player, &name, args);
        Ok(())
      }
      _ => {
        self.refuse(peer, "net.garbled", false);
        Ok(())
      }
    }
  }

  fn hello(&mut self, peer: PeerId, version: u32, mods: String, name: String, id: Option<String>, password: String) -> Result<(), String> {
    if version != VERSION {
      self.refuse(peer, if version < VERSION { "net.older" } else { "net.newer" }, false);
      return Ok(());
    }
    if mods != self.mods {
      self.refuse(peer, "net.mods", false);
      return Ok(());
    }
    if !self.password.is_empty() && !same(&password, &self.password) {
      self.refuse(peer, if password.is_empty() { "net.passwordNeeded" } else { "net.wrongPassword" }, true);
      return Ok(());
    }
    let name = clean_name(&name);
    let known = id.filter(|id| self.players.contains_key(id));
    let (id, player) = match known {
      Some(id) => {
        let player = self.players.get_mut(&id).expect("знаком");
        if !name.is_empty() {
          player.name = name;
        }
        (id.clone(), player.number)
      }
      None => {
        let number = self.players.values().map(|player| player.number).max().unwrap_or(0) + 1;
        let id = self.mint();
        self.players.insert(id.clone(), Player { number, name });
        self.host.join(number)?;
        (id, number)
      }
    };
    let tick = self.host.state.borrow().tick;
    let welcome = ServerMessage::Welcome { player, id, game: self.game.clone(), options: self.options.clone(), seed: self.seed, tick };
    let state = self.peers.get_mut(&peer).expect("подключение");
    state.player = Some(player);
    state.view = Some(View::new(player));
    state.outbox.push(Message::Text(welcome.text()));
    Ok(())
  }

  /// Тик мира и кадры всем вошедшим: каждый тик по кадру, даже пустому, — по ним клиент ведёт часы.
  pub fn tick(&mut self) -> Result<(), String> {
    self.host.tick(STEP)?;
    let signals = self.host.signals();
    let mut state = self.host.state.borrow_mut();
    let shared = Shared::after_tick(&mut state, self.rules.clone(), signals);
    let schema = state.world.schema.clone();
    for peer in self.peers.values_mut() {
      let Some(view) = peer.view.as_mut() else { continue };
      let frame = view.frame(&mut state, &shared);
      let mut bytes = vec![FRAME];
      bytes.extend(frame.encode(&schema));
      peer.outbox.push(Message::Binary(bytes));
    }
    Ok(())
  }
}
