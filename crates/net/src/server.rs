//! Хост с подключёнными игроками (createHost в host.ts). Про сокеты не знает: подключение приносит сообщения и
//! забирает свои, сервер за WebSocket и петля в одном процессе (`KHAROS_NET=loopback`) зовут одно и то же.
//!
//! Кроме мира — чат и команды сервера: строка с «/» — команда (`help`, `list`, `me`, `msg`, `admin`, `logout`, `hide`,
//! `say`, `kick`, `save`, `stop`), остальное — сообщение всем. Ответы сервера — ключами словаря (`host.*`): каждый
//! игрок читает их на своём языке.

use crate::protocol::{clean_chat, clean_name, host_text, mods_sum, parse_command, ChatLine, ClientMessage, CommandInfo, Message, PlayerInfo, ServerMessage, FRAME, VERSION};
use crate::{Rules, Shared, View};
use kharos_content::Mod;
use kharos_world::Host;
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

pub type PeerId = u64;

/// Длина тика.
pub const STEP: f64 = 0.05;

/// Версия сохранения сервера.
pub const SAVE_VERSION: u64 = 1;

/// Как часто подключение может писать в чат, в секундах.
const CHAT_GAP: f64 = 0.5;
/// Длиннее скольких байт сообщение клиента не читается: приказ всем своим юнитам в разы короче.
const MESSAGE_MOST: usize = 64 * 1024;
/// Сколько сообщений в секунду подключение шлёт в среднем и сколько разом: что сверх — отбрасывается.
const MESSAGE_RATE: f64 = 30.0;
const MESSAGE_BURST: f64 = 120.0;
/// Сколько отброшенных сообщений подключению прощается разом и сколько в секунду: дальше его отключают.
const FLOOD_BURST: f64 = 300.0;
const FLOOD_RATE: f64 = 1.0;
/// Сколько секунд после неверного пароля администратора подключение не может попробовать снова.
const ADMIN_LOCK: f64 = 3.0;

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
  admin: bool,
  /// Когда писал в чат и до какого времени не может пробовать пароль администратора.
  chatted: f64,
  locked: f64,
  /// Ведро сообщений и ведро прощённых отброшенных (MESSAGE_*, FLOOD_*), когда их пополняли.
  tokens: f64,
  strikes: f64,
  filled: f64,
}

/// Что сервер просит у того, кто его держит.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Request {
  Save,
  Stop,
}

/// Кто зовёт команду: подключение или консоль сервера (она всегда администратор).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Caller {
  Peer(PeerId),
  Console,
}

/// Команда сервера: только администратору, только из игры, только из консоли, ждёт ли пароль.
struct Command {
  name: &'static str,
  args: &'static [&'static str],
  admin: bool,
  game: bool,
  console: bool,
  secret: bool,
}

const fn command(name: &'static str, args: &'static [&'static str]) -> Command {
  Command { name, args, admin: false, game: false, console: false, secret: false }
}

const COMMANDS: &[Command] = &[
  command("help", &[]),
  command("list", &[]),
  Command { game: true, ..command("me", &["<action>"]) },
  Command { game: true, ..command("msg", &["<player>", "<text>"]) },
  Command { game: true, secret: true, ..command("admin", &[]) },
  Command { admin: true, game: true, ..command("logout", &[]) },
  Command { admin: true, game: true, ..command("hide", &[]) },
  Command { admin: true, ..command("say", &["<text>"]) },
  Command { admin: true, ..command("kick", &["<player>"]) },
  Command { admin: true, ..command("save", &[]) },
  Command { admin: true, console: true, ..command("stop", &[]) },
];

pub struct Server {
  pub host: Host,
  game: String,
  options: Json,
  seed: u64,
  password: String,
  /// Пароль режима администратора (/admin); пустой — режима нет.
  pub admin: String,
  /// Подпись сообщений администратора и консоли (/say) и ник игрока без ника — на языке сервера.
  pub server_name: String,
  pub default_name: String,
  rules: Rc<Rules>,
  mods: String,
  peers: BTreeMap<PeerId, Peer>,
  next_peer: PeerId,
  /// Под каким именем сервер помнит игрока → игрок.
  pub players: BTreeMap<String, Player>,
  /// Скрытые администраторы (/hide): для остальных их нет — ни в списке, ни в сообщениях о входе. До перезапуска.
  hidden: BTreeSet<u32>,
  /// Счётчик для новых имён.
  minted: u64,
  started: std::time::Instant,
  /// Что написать в консоль сервера: вход, выход, чат, ответы консоли.
  pub log: Vec<String>,
  pub requests: Vec<Request>,
}

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
    Ok(Self {
      game: host.game.clone(),
      host,
      options,
      seed,
      password,
      admin: String::new(),
      server_name: "[Сервер]".into(),
      default_name: "Игрок {number}".into(),
      rules,
      mods,
      peers: BTreeMap::new(),
      next_peer: 1,
      players,
      hidden: BTreeSet::new(),
      minted: 0,
      started: std::time::Instant::now(),
      log: Vec::new(),
      requests: Vec::new(),
    })
  }

  /// Сохранение сервера: мир, игроки по именам, партия, её настройки и зерно.
  pub fn save(&self) -> Result<Json, String> {
    let players: serde_json::Map<String, Json> = self.players.iter().map(|(id, player)| (id.clone(), json!({ "number": player.number, "name": player.name }))).collect();
    Ok(json!({ "version": SAVE_VERSION, "game": self.game, "seed": self.seed, "options": self.options, "players": players, "world": self.host.snapshot()? }))
  }

  /// Сколько подключений вошло в игру.
  pub fn online(&self) -> usize {
    self.peers.values().filter(|peer| peer.player.is_some()).count()
  }

  fn now(&self) -> f64 {
    self.started.elapsed().as_secs_f64()
  }

  /// Новое подключение: ждёт входа.
  pub fn connect(&mut self) -> PeerId {
    let id = self.next_peer;
    self.next_peer += 1;
    let now = self.now();
    self.peers.insert(id, Peer { player: None, view: None, outbox: Vec::new(), closing: false, admin: false, chatted: f64::NEG_INFINITY, locked: 0.0, tokens: MESSAGE_BURST, strikes: FLOOD_BURST, filled: now });
    id
  }

  /// Подключение закрылось: игрок, у которого не осталось вкладок, выходит из игры.
  pub fn disconnect(&mut self, peer: PeerId) {
    let Some(state) = self.peers.remove(&peer) else { return };
    let Some(player) = state.player else { return };
    if self.peers.values().any(|other| other.player == Some(player)) {
      return;
    }
    self.log.push(format!("{} выходит", self.name_of(player)));
    if !self.hidden.contains(&player) {
      self.notice(player, host_text("leaves", json!({})));
    }
    self.announce();
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

  // Игроки и чат.

  /// Ник игрока: свой, а без него — «Игрок N».
  pub fn name_of(&self, player: u32) -> String {
    self.players.values().find(|known| known.number == player).map(|known| known.name.clone()).filter(|name| !name.is_empty()).unwrap_or_else(|| self.default_name.replace("{number}", &player.to_string()))
  }

  /// Игрок по номеру или нику без учёта регистра; скрытых находит только администратор.
  fn find(&self, text: &str, admin: bool) -> Option<u32> {
    let numbers: BTreeSet<u32> = self.players.values().map(|player| player.number).collect();
    let found = text.parse::<u32>().ok().filter(|number| numbers.contains(number)).or_else(|| {
      let lower = text.to_lowercase();
      numbers.iter().copied().find(|&number| self.name_of(number).to_lowercase() == lower)
    })?;
    (admin || !self.hidden.contains(&found)).then_some(found)
  }

  fn is_online(&self, player: u32) -> bool {
    self.peers.values().any(|peer| peer.player == Some(player))
  }

  fn send_to(&mut self, filter: impl Fn(&Peer) -> bool, message: &ServerMessage) {
    let text = message.text();
    for peer in self.peers.values_mut().filter(|peer| peer.player.is_some() && !peer.closing) {
      if filter(peer) {
        peer.outbox.push(Message::Text(text.clone()));
      }
    }
  }

  /// Строки чата всем вошедшим.
  fn broadcast(&mut self, lines: Vec<ChatLine>) {
    self.send_to(|_| true, &ServerMessage::Chat { lines });
  }

  /// Сообщение сервера о игроке: «<ник> text».
  fn notice(&mut self, about: u32, text: Json) {
    let name = self.name_of(about);
    self.broadcast(vec![ChatLine { player: about, name, text, system: true, whisper: None }]);
  }

  /// Ответ на команду только тому, кто её позвал.
  fn reply(&mut self, caller: Caller, text: Json) {
    match caller {
      Caller::Console => self.log.push(match &text {
        Json::String(line) => line.clone(),
        other => other.to_string(),
      }),
      Caller::Peer(peer) => {
        let line = ServerMessage::Chat { lines: vec![ChatLine { player: 0, name: String::new(), text, system: true, whisper: None }] };
        if let Some(state) = self.peers.get_mut(&peer) {
          state.outbox.push(Message::Text(line.text()));
        }
      }
    }
  }

  /// Кто играет — каждому своими глазами: скрытых видит только сам скрытый.
  fn announce(&mut self) {
    let online: BTreeSet<u32> = self.peers.values().filter_map(|peer| peer.player).collect();
    let mut all: Vec<(u32, String)> = self.players.values().map(|player| (player.number, self.name_of(player.number))).collect();
    all.sort();
    let hidden = self.hidden.clone();
    for peer in self.peers.values_mut().filter(|peer| !peer.closing) {
      let Some(viewer) = peer.player else { continue };
      let players = all.iter().filter(|(number, _)| !hidden.contains(number) || *number == viewer).map(|(number, name)| PlayerInfo { player: *number, name: name.clone(), online: online.contains(number) }).collect();
      peer.outbox.push(Message::Text(ServerMessage::Players { players }.text()));
    }
  }

  /// Команды, которые подключению можно: для дописывания у клиента.
  fn send_commands(&mut self, peer: PeerId) {
    let Some(state) = self.peers.get_mut(&peer) else { return };
    let admin = state.admin;
    let commands = COMMANDS.iter().filter(|command| !command.console && (admin || !command.admin)).map(|command| CommandInfo { name: command.name.into(), args: command.args.iter().map(|arg| arg.to_string()).collect(), secret: command.secret }).collect();
    state.outbox.push(Message::Text(ServerMessage::Commands { commands, admin }.text()));
  }

  /// Пропускает ли ведро сообщение подключения; не унимается — отказ и отключение.
  fn admit(&mut self, peer: PeerId) -> bool {
    let now = self.now();
    let Some(state) = self.peers.get_mut(&peer) else { return false };
    let dt = (now - state.filled).max(0.0);
    state.filled = now;
    state.tokens = (state.tokens + dt * MESSAGE_RATE).min(MESSAGE_BURST);
    state.strikes = (state.strikes + dt * FLOOD_RATE).min(FLOOD_BURST);
    if state.tokens >= 1.0 {
      state.tokens -= 1.0;
      return true;
    }
    state.strikes -= 1.0;
    if state.strikes < 0.0 {
      self.refuse(peer, "host.flood", false);
    }
    false
  }

  /// Сообщение подключения.
  pub fn receive(&mut self, peer: PeerId, message: Message) -> Result<(), String> {
    let Some(state) = self.peers.get(&peer) else { return Ok(()) };
    if state.closing || !self.admit(peer) {
      return Ok(());
    }
    let player = self.peers[&peer].player;
    let text = match message {
      Message::Text(text) if text.len() <= MESSAGE_MOST => text,
      _ => {
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
    match (player, message) {
      (None, ClientMessage::Hello { version, mods, name, id, password }) => self.hello(peer, version, mods, name, id, password),
      (Some(player), ClientMessage::Command { name, args }) => {
        self.host.send(player, &name, args);
        Ok(())
      }
      (Some(player), ClientMessage::Chat { text }) => {
        self.chat(peer, player, &text);
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
    let returning = self.is_online(player);
    let tick = self.host.state.borrow().tick;
    let welcome = ServerMessage::Welcome { player, id, game: self.game.clone(), options: self.options.clone(), seed: self.seed, tick };
    let state = self.peers.get_mut(&peer).expect("подключение");
    state.player = Some(player);
    state.view = Some(View::new(player));
    state.outbox.push(Message::Text(welcome.text()));
    self.send_commands(peer);
    if !returning {
      self.log.push(format!("{} заходит", self.name_of(player)));
      if !self.hidden.contains(&player) {
        self.notice(player, host_text("joins", json!({})));
      }
    }
    self.announce();
    Ok(())
  }

  /// Строка чата игрока: команда или сообщение всем.
  fn chat(&mut self, peer: PeerId, player: u32, text: &str) {
    if text.starts_with('/') {
      self.command(text, Caller::Peer(peer));
      return;
    }
    let now = self.now();
    let Some(state) = self.peers.get_mut(&peer) else { return };
    if now - state.chatted < CHAT_GAP {
      return;
    }
    state.chatted = now;
    let text = clean_chat(text);
    if text.is_empty() {
      return;
    }
    let name = self.name_of(player);
    self.log.push(format!("<{name}> {text}"));
    self.broadcast(vec![ChatLine { player, name, text: Json::String(text), system: false, whisper: None }]);
  }

  /// Команда сервера из чата или консоли.
  pub fn command(&mut self, text: &str, caller: Caller) {
    let line = if text.starts_with('/') { text.to_string() } else { format!("/{text}") };
    let Some((name, args, rest)) = parse_command(&line) else { return };
    let (admin, player) = match caller {
      Caller::Console => (true, None),
      Caller::Peer(peer) => (self.peers.get(&peer).is_some_and(|state| state.admin), self.player_of(peer)),
    };
    let found = COMMANDS.iter().find(|command| command.name == name);
    let Some(command) = found.filter(|command| (admin || !command.admin) && if player.is_some() { !command.console } else { !command.game }) else {
      self.reply(caller, host_text("noCommand", json!({ "name": name })));
      return;
    };
    let usage = host_text("usage", json!({ "command": format!("/{} {}", command.name, command.args.join(" ")).trim_end() }));
    match command.name {
      "help" => {
        for each in COMMANDS {
          if (each.admin && !admin) || (if player.is_some() { each.console } else { each.game }) {
            continue;
          }
          let shown = format!("/{} {}", each.name, each.args.join(" "));
          self.reply(caller, host_text("help", json!({ "command": shown.trim_end(), "name": each.name, "help": { "key": format!("chat.help.{}", each.name) } })));
        }
      }
      "list" => {
        let present: BTreeSet<u32> = self.peers.values().filter_map(|peer| peer.player).collect();
        let here: Vec<String> = present.iter().filter(|who| !self.hidden.contains(who)).map(|&who| self.name_of(who)).collect();
        let reply = if here.is_empty() { host_text("listEmpty", json!({})) } else { host_text("list", json!({ "count": here.len(), "names": here.join(", ") })) };
        self.reply(caller, reply);
        let unseen: Vec<String> = present.iter().filter(|who| self.hidden.contains(who)).map(|&who| self.name_of(who)).collect();
        if admin && !unseen.is_empty() {
          self.reply(caller, host_text("listHidden", json!({ "names": unseen.join(", ") })));
        }
      }
      "me" => {
        let (Some(player), text) = (player, clean_chat(&rest(0))) else { return };
        if !text.is_empty() {
          let name = format!("* {}", self.name_of(player));
          self.broadcast(vec![ChatLine { player, name, text: Json::String(text), system: true, whisper: None }]);
        }
      }
      "msg" => {
        let Some(player) = player else { return };
        let Some(to) = args.first().and_then(|name| self.find(name, admin)) else {
          self.reply(caller, host_text("noPlayer", json!({ "name": args.first().cloned().unwrap_or_default() })));
          return;
        };
        let text = clean_chat(&rest(1));
        if text.is_empty() {
          self.reply(caller, usage);
          return;
        }
        let line = ServerMessage::Chat { lines: vec![ChatLine { player, name: self.name_of(player), text: Json::String(text), system: false, whisper: Some(self.name_of(to)) }] };
        self.send_to(|peer| peer.player == Some(to) || peer.player == Some(player), &line);
        if !self.is_online(to) || (self.hidden.contains(&to) && !admin) {
          self.reply(caller, host_text("notOnline", json!({ "name": self.name_of(to) })));
        }
      }
      "admin" => {
        let Caller::Peer(peer) = caller else { return };
        let now = self.now();
        if self.admin.is_empty() {
          self.reply(caller, host_text("noAdminMode", json!({})));
        } else if admin {
          self.reply(caller, host_text("alreadyAdmin", json!({})));
        } else if now < self.peers[&peer].locked {
          self.reply(caller, host_text("wait", json!({})));
        } else if !same(&args.join(" "), &self.admin) {
          self.peers.get_mut(&peer).expect("подключение").locked = now + ADMIN_LOCK;
          self.log.push(format!("! неверный пароль администратора от {}", self.name_of(player.unwrap_or(0))));
          self.reply(caller, host_text("wrongPassword", json!({})));
        } else {
          self.peers.get_mut(&peer).expect("подключение").admin = true;
          self.send_commands(peer);
          self.log.push(format!("! {} — администратор", self.name_of(player.unwrap_or(0))));
          self.reply(caller, host_text("adminOn", json!({})));
        }
      }
      "logout" => {
        let Caller::Peer(peer) = caller else { return };
        self.peers.get_mut(&peer).expect("подключение").admin = false;
        self.send_commands(peer);
        self.reply(caller, host_text("adminOff", json!({})));
      }
      "hide" => {
        let Some(who) = player else { return };
        // Для остальных — как будто вышел или зашёл.
        if self.hidden.remove(&who) {
          self.notice(who, host_text("joins", json!({})));
          self.reply(caller, host_text("shown", json!({})));
        } else {
          self.notice(who, host_text("leaves", json!({})));
          self.hidden.insert(who);
          self.reply(caller, host_text("hidden", json!({})));
        }
        self.announce();
      }
      "say" => {
        let text = clean_chat(&rest(0));
        if text.is_empty() {
          self.reply(caller, usage);
          return;
        }
        self.log.push(format!("{} {text}", self.server_name));
        let name = self.server_name.clone();
        self.broadcast(vec![ChatLine { player: 0, name, text: Json::String(text), system: true, whisper: None }]);
      }
      "kick" => {
        let Some(who) = self.find(&args.join(" "), true) else {
          self.reply(caller, host_text("noPlayer", json!({ "name": args.join(" ") })));
          return;
        };
        let peers: Vec<PeerId> = self.peers.iter().filter(|(_, peer)| peer.player == Some(who)).map(|(&id, _)| id).collect();
        if peers.is_empty() {
          self.reply(caller, host_text("notOnline", json!({ "name": self.name_of(who) })));
          return;
        }
        for peer in peers {
          self.refuse(peer, "host.kickedYou", false);
        }
        self.notice(who, host_text("kicked", json!({})));
        self.log.push(format!("! {} отключён", self.name_of(who)));
      }
      "save" => self.requests.push(Request::Save),
      "stop" => self.requests.push(Request::Stop),
      _ => {}
    }
  }

  /// Тик мира и кадры всем вошедшим: каждый тик по кадру, даже пустому, — по ним клиент ведёт часы.
  pub fn tick(&mut self) -> Result<(), String> {
    self.host.tick(STEP)?;
    let signals = self.host.signals();
    let mut state = self.host.state.borrow_mut();
    let shared = Shared::after_tick(&mut state, self.rules.clone(), signals);
    let schema = state.world.schema.clone();
    for peer in self.peers.values_mut() {
      let Some(view) = peer.view.as_mut().filter(|_| !peer.closing) else { continue };
      let frame = view.frame(&mut state, &shared);
      let mut bytes = vec![FRAME];
      bytes.extend(frame.encode(&schema));
      peer.outbox.push(Message::Binary(bytes));
    }
    Ok(())
  }
}
