//! Сообщения между клиентом и сервером (protocol.ts). Управляющие — JSON текстом, кадры мира — двоичные: первый байт
//! — вид (`FRAME`), дальше кадр (frame.rs).

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// Версия провода: поднимать при каждом изменении сообщений и кадра. Правила, схема и подача сверяются суммой модов.
pub const VERSION: u32 = 1;

/// Порт сервера по умолчанию.
pub const DEFAULT_PORT: u16 = 8787;

/// Первый байт двоичного сообщения сервера: кадр мира.
pub const FRAME: u8 = 0;

/// Самый длинный ник; длиннее обрезается.
pub const NAME_LENGTH: usize = 24;

/// Ник, каким его примет хост: без управляющих символов и лишних пробелов, не длиннее NAME_LENGTH.
pub fn clean_name(name: &str) -> String {
  let words: Vec<&str> = name.split(|c: char| c.is_whitespace() || c.is_control()).filter(|word| !word.is_empty()).collect();
  words.join(" ").chars().take(NAME_LENGTH).collect()
}

/// Что клиент шлёт серверу.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
  /// Первое сообщение: версия провода, сумма модов клиента, ник, под каким именем сервер помнит игрока (если
  /// помнит) и пароль сервера.
  Hello {
    version: u32,
    mods: String,
    name: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    password: String,
  },
  /// Приказ игрока: имя обработчика `commands` и аргументы.
  Command { name: String, args: Json },
  /// Строка чата: сообщение всем или команда серверу, если начинается с «/».
  Chat { text: String },
}

/// Что сервер шлёт клиенту текстом.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
  /// Ответ на вход: за кого клиент играет и из чего собрать реплику — партия, её настройки и зерно (тот же `Host::new`,
  /// что у сервера); tick — тик мира. id — под каким именем сервер помнит игрока: клиент хранит его и входит с ним снова.
  Welcome { player: u32, id: String, game: String, options: Json, seed: u64, tick: u64 },
  /// Сервер не пускает клиента и закрывает соединение. reason — ключ словаря (`net.*`); password — дело в пароле.
  Refused {
    reason: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    password: bool,
  },
  /// Новые строки чата. Сервер их не хранит: вошедший позже прошлых не увидит.
  Chat { lines: Vec<ChatLine> },
  /// Кто играет на сервере: ники и кто сейчас в сети. Приходит после входа и при каждом изменении.
  Players { players: Vec<PlayerInfo> },
  /// Команды чата, которые подключению можно, — для дописывания; admin — оно сейчас администратор.
  Commands { commands: Vec<CommandInfo>, admin: bool },
}

/// Строка чата: кто и что. text — что написал игрок, строкой; что пишет сервер — `{ key, params }` ключом словаря, и
/// каждый читает это на своём языке.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatLine {
  pub player: u32,
  pub name: String,
  pub text: Json,
  /// Сообщение самого сервера: кто зашёл, вышел; пустой name — ответ на команду.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub system: bool,
  /// Личное сообщение (/msg): ник того, кому оно. Приходит только ему и автору.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub whisper: Option<String>,
}

/// Игрок сервера, каким его видят все.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerInfo {
  pub player: u32,
  pub name: String,
  pub online: bool,
}

/// Команда чата, какой её знает клиент: имя без «/», аргументы (`<player>` дописывается ником) и пароль ли она ждёт
/// (клиент спрашивает его скрытым полем). Что делает — `chat.help.<имя>` словаря.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandInfo {
  pub name: String,
  pub args: Vec<String>,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub secret: bool,
}

/// Самое длинное сообщение чата; длиннее обрезается.
pub const CHAT_LENGTH: usize = 200;

/// Сообщение чата, каким его примет хост: без управляющих символов и лишних пробелов, не длиннее CHAT_LENGTH.
pub fn clean_chat(text: &str) -> String {
  let words: Vec<&str> = text.split(|c: char| c.is_whitespace() || c.is_control()).filter(|word| !word.is_empty()).collect();
  words.join(" ").chars().take(CHAT_LENGTH).collect()
}

/// Текст сервера ключом словаря: каждый игрок прочтёт его на своём языке.
pub fn host_text(key: &str, params: Json) -> Json {
  serde_json::json!({ "key": format!("host.{key}"), "params": params })
}

/// Слова строки: через пробел, а в двойных кавычках — вместе с пробелами, как ник «Игрок 3».
pub fn split_words(text: &str) -> Vec<String> {
  let mut words = Vec::new();
  let mut chars = text.chars().peekable();
  while let Some(&c) = chars.peek() {
    if c.is_whitespace() {
      chars.next();
      continue;
    }
    let mut word = String::new();
    if c == '"' {
      chars.next();
      for c in chars.by_ref() {
        if c == '"' {
          break;
        }
        word.push(c);
      }
    } else {
      while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
          break;
        }
        word.push(c);
        chars.next();
      }
    }
    words.push(word);
  }
  words
}

/// Строка чата командой: имя (строчными), слова после него и текст после skip слов как есть (у команд, чей последний
/// аргумент — сообщение). Не команда — None.
pub fn parse_command(text: &str) -> Option<(String, Vec<String>, impl Fn(usize) -> String + '_)> {
  let body = text.strip_prefix('/')?;
  let mut words = split_words(body);
  if words.is_empty() {
    return None;
  }
  let name = words.remove(0).to_lowercase();
  let rest = move |skip: usize| -> String {
    // Пропускаем имя и skip слов (слово в кавычках — целиком), остальное — как есть.
    let mut left = body.trim_start();
    for _ in 0..=skip {
      if left.starts_with('"') {
        left = match left[1..].find('"') {
          Some(end) => &left[end + 2..],
          None => "",
        };
      } else {
        left = left.find(char::is_whitespace).map_or("", |end| &left[end..]);
      }
      left = left.trim_start();
    }
    left.trim().to_string()
  };
  Some((name, words, rest))
}

/// Сумма модов текстом, как её шлёт клиент: имена и содержимое всех файлов по порядку (FNV-1a). Совпала — у клиента
/// те же правила, схема и подача, что у сервера.
pub fn mods_sum(mods: &[kharos_content::Mod]) -> String {
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  for one in mods {
    for byte in one.name.bytes().chain([0]).chain(one.files.checksum().to_le_bytes()) {
      hash = (hash ^ byte as u64).wrapping_mul(0x0100_0000_01b3);
    }
  }
  format!("{hash:016x}")
}

impl ClientMessage {
  pub fn text(&self) -> String {
    serde_json::to_string(self).expect("сообщение — JSON")
  }

  pub fn parse(text: &str) -> Result<Self, String> {
    serde_json::from_str(text).map_err(|error| format!("сообщение клиента: {error}"))
  }
}

impl ServerMessage {
  pub fn text(&self) -> String {
    serde_json::to_string(self).expect("сообщение — JSON")
  }

  pub fn parse(text: &str) -> Result<Self, String> {
    serde_json::from_str(text).map_err(|error| format!("сообщение сервера: {error}"))
  }
}

/// Сообщение по проводу: текст или байты (у WebSocket — свои виды кадров).
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
  Text(String),
  Binary(Vec<u8>),
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn commands_are_split_by_words_and_quotes() {
    assert_eq!(split_words(r#"msg "Игрок 3" привет  всем"#), ["msg", "Игрок 3", "привет", "всем"]);
    let (name, args, rest) = parse_command(r#"/MSG "Игрок 3" привет  всем"#).unwrap();
    assert_eq!((name.as_str(), args.len()), ("msg", 3));
    assert_eq!(rest(1), "привет  всем");
    assert_eq!(rest(0), r#""Игрок 3" привет  всем"#);
    assert!(parse_command("привет").is_none());
    assert_eq!(clean_chat(" a \u{1}  b "), "a b");
  }

  #[test]
  fn names_are_cleaned_and_messages_round_trip() {
    assert_eq!(clean_name("  Вася \u{7}  Пупкин \n"), "Вася Пупкин");
    assert_eq!(clean_name(&"я".repeat(40)).chars().count(), NAME_LENGTH);
    let hello = ClientMessage::Hello { version: VERSION, mods: "07".into(), name: "Вася".into(), id: None, password: String::new() };
    assert_eq!(ClientMessage::parse(&hello.text()).unwrap(), hello);
    assert_eq!(ClientMessage::parse(r#"{"type":"hello","version":1,"mods":"0","name":"a"}"#).unwrap(), ClientMessage::Hello { version: 1, mods: "0".into(), name: "a".into(), id: None, password: String::new() });
    let welcome = ServerMessage::Welcome { player: 2, id: "x".into(), game: "skirmish".into(), options: json!({}), seed: 7, tick: 3 };
    assert_eq!(ServerMessage::parse(&welcome.text()).unwrap(), welcome);
    assert_eq!(ServerMessage::Refused { reason: "net.version".into(), password: false }.text(), r#"{"type":"refused","reason":"net.version"}"#);
  }
}
