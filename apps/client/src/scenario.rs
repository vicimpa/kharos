//! Режим сценария: клиент идёт по сценарию на Luau, без человека — для тестов и роликов.
//!
//!   kharos --scenario путь.luau [--show] [--fps 60] [--lang ru] [--timeout 600] [--size 1280x800] [--scale 1] [--no-ui]
//!
//! `--size` — кадр такого размера в логических пикселях в своём буфере, а не в окне (любой, хоть 540x960), `--scale`
//! — физических пикселей на логический; `--no-ui` — мир без интерфейса (он считается, щелчки по нему работают);
//! `--record файл.mp4` — видео всего прогона (нужен ffmpeg), из сценария — `s:record(файл)` и `s:stop()`; `--sound` —
//! со звуком: граф звука считается офлайн кадр в кадр с картинкой (crate::offline), на `--timeout` секунд вперёд.
//!
//! Время игры — номер кадра ÷ fps, а не часы: прогон не зависит от скорости машины и повторяется кадр в кадр. Окно
//! невидимо (`--show` — видно), настройки и сохранения — во временной папке, звука нет. Код выхода — итог: 0 — сценарий
//! дошёл до конца, 1 — упал или не уложился в `--timeout` секунд игры.
//!
//! Файл сценария возвращает таблицу: `run(s)` — сам сценарий, сопрограммой в своей машине Luau (переживает смену
//! партий); `client` и `host` — функции, которые сценарий зовёт в машине клиента и хоста идущей партии:
//! `s:client("имя", аргументы)` → `client.имя(c, аргументы)`, `s:host(...)` → `host.имя(ctx, аргументы)`. Значения
//! между машинами ходят как JSON. Что умеет `s` — PRELUDE ниже и docs/scenarios.md.

use crate::input::Input;
use crate::App;
use mlua::{Function, Lua, Table, Thread, ThreadStatus, Value};
use serde_json::{json, Value as Json};

/// Настройки запуска сценария из командной строки.
pub struct Options {
  pub path: String,
  pub show: bool,
  pub fps: f64,
  pub lang: String,
  pub timeout: f64,
  /// Кадр в своём буфере: логические пиксели и плотность.
  pub size: Option<[u32; 2]>,
  pub scale: f32,
  pub ui: bool,
  /// Видео всего прогона.
  pub record: Option<String>,
  /// Звук: офлайновый счёт, в записи — дорожкой.
  pub sound: bool,
}

/// Режим сценария, если он задан флагом `--scenario`.
pub fn options() -> Option<Options> {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).cloned();
  let path = value("--scenario")?;
  Some(Options {
    path,
    show: args.iter().any(|arg| arg == "--show"),
    fps: value("--fps").and_then(|fps| fps.parse().ok()).unwrap_or(60.0),
    lang: value("--lang").unwrap_or_else(|| "ru".into()),
    timeout: value("--timeout").and_then(|seconds| seconds.parse().ok()).unwrap_or(600.0),
    size: value("--size").and_then(|size| size.split_once('x').and_then(|(w, h)| Some([w.trim().parse().ok()?, h.trim().parse().ok()?]))),
    scale: value("--scale").and_then(|scale| scale.parse().ok()).unwrap_or(1.0),
    ui: !args.iter().any(|arg| arg == "--no-ui"),
    record: value("--record"),
    sound: args.iter().any(|arg| arg == "--sound"),
  })
}

/// Объект `s` сценария: каждая просьба к игре — yield с таблицей { op, … }; движок исполняет её и возобновляет
/// сценарий — сразу или через сколько-то кадров.
const PRELUDE: &str = r#"
local s = {}
local yield = coroutine.yield
local function ask(request) return yield(request) end
-- Ждать: секунд игры или кадров.
function s:wait(seconds) ask({ op = "wait", frames = math.max(1, math.round(seconds * self.fps)) }) end
function s:frames(n) ask({ op = "wait", frames = math.max(1, n) }) end
-- Ждать, пока check() не вернёт правду; дольше seconds секунд игры — провал.
function s:wait_for(check, seconds, message)
  local limit = self.frame + math.round((seconds or 30) * self.fps)
  while not check() do
    if self.frame >= limit then error(message or "не дождались", 2) end
    ask({ op = "wait", frames = 1 })
  end
end
-- Партия: games/имя с настройками (как c.app:start); ждёт её первого кадра.
function s:start(game, options) ask({ op = "start", game = game, options = options or {} }) end
-- Функции файла сценария в машине клиента и хоста идущей партии.
function s:client(name, args) return ask({ op = "client", name = name, args = args }) end
function s:host(name, args) return ask({ op = "host", name = name, args = args }) end
-- Ввод: координаты — логические пиксели окна; щелчок и клавиша — нажатие в этом кадре, отпускание в следующем, и
-- сценарий идёт дальше, когда интерфейс успел откликнуться.
function s:pointer(x, y) ask({ op = "pointer", x = x, y = y }) end
function s:click(x, y, button) ask({ op = "click", x = x, y = y, button = button or "left" }) end
function s:key(name) ask({ op = "key", name = name }) end
function s:hold(name, down) ask({ op = "hold", name = name, down = down ~= false }) end
function s:type(text) ask({ op = "type", text = text }) end
function s:wheel(lines) ask({ op = "wheel", lines = lines }) end
-- Интерфейс по прошлому кадру: место узла по номеру, все тексты, щелчок по узлу или по надписи (сначала — надпись
-- целиком, потом — где она встречается).
function s:ui_rect(id) return ask({ op = "ui_rect", id = id }) end
function s:ui_texts() return ask({ op = "ui_texts" }) end
function s:ui_find(text) return ask({ op = "ui_find", text = text }) end
function s:ui_has(text) return ask({ op = "ui_find", text = text }) ~= nil end
function s:ui_click(what, button)
  local rect = ask({ op = "ui_rect", id = what }) or ask({ op = "ui_find", text = what })
  if not rect then error("в интерфейсе нет " .. tostring(what), 2) end
  ask({ op = "click", x = rect.x + rect.w / 2, y = rect.y + rect.h / 2, button = button or "left" })
end
-- Рисовать ли интерфейс (считается он всё равно).
function s:ui(on) ask({ op = "ui", on = on ~= false }) end
-- Видео с этого кадра до s:stop() или конца сценария (нужен ffmpeg).
function s:record(path) ask({ op = "record", path = path }) end
function s:stop() ask({ op = "stop" }) end
-- Снимок кадра в PNG — после того, как кадр нарисован.
function s:shot(path) ask({ op = "shot", path = path }) end
function s:log(...) print("сценарий:", ...) end
function s:fail(message) error(message or "провал", 2) end
function s:check(ok, message) if not ok then error(message or "проверка не прошла", 2) end return ok end
return s
"#;

/// Что делать с вводом в каком кадре.
enum Action {
  Pointer(Option<[f32; 2]>),
  Button(usize, bool),
  Key(String, bool),
  Text(String),
  Wheel(f32),
}

/// Чего сценарий ждёт, прежде чем идти дальше.
enum Wait {
  Frame(u64),
  /// Новой партии: номер запуска, после которого она появится.
  Start(u64),
}

pub struct Scenario {
  lua: Lua,
  thread: Thread,
  s: Table,
  source: String,
  name: String,
  fps: f64,
  timeout: f64,
  lang: String,
  ui: bool,
  /// Кадр в своём буфере: логические пиксели и плотность.
  pub size: Option<[u32; 2]>,
  pub scale: f32,
  pub frame: u64,
  /// Ввод по кадрам.
  actions: Vec<(u64, Action)>,
  wait: Option<Wait>,
  /// Что вернуть сценарию, когда он пойдёт дальше.
  reply: Option<Json>,
  shots: Vec<String>,
  /// Запись: какую начать после кадра (размер кадра известен только тогда) и идущая.
  record: Option<String>,
  recorder: Option<crate::record::Recorder>,
  /// Записи со звуком: видео дописано до кадра, звук к нему положат, когда счёт звука кончится.
  sounded: Vec<(crate::record::Recorder, u64, u64)>,
  /// Начало идущей записи — кадр.
  recording_from: u64,
  /// Офлайновый звук и его синтезатор.
  offline: Option<crate::offline::Offline>,
  engine: Option<std::rc::Rc<crate::audio::Engine>>,
  /// Таблица файла сценария в машинах клиента и хоста партии номер generation.
  loaded: Option<(u64, Option<Table>, Option<Table>)>,
  started: bool,
  begun: bool,
  reported: bool,
  /// Итог: Some(Ok) — дошёл до конца, Some(Err) — упал.
  pub done: Option<Result<(), String>>,
}

fn lua_error(what: impl std::fmt::Display) -> impl FnOnce(mlua::Error) -> String {
  move |error| format!("{what}: {error}")
}

impl Scenario {
  pub fn new(options: &Options) -> Result<Self, String> {
    let source = std::fs::read_to_string(&options.path).map_err(|error| format!("{}: {error}", options.path))?;
    let name = std::path::Path::new(&options.path).file_stem().map_or("сценарий".into(), |stem| stem.to_string_lossy().into_owned());
    let lua = Lua::new();
    let s: Table = lua.load(PRELUDE).set_name("=сценарий/s").eval().map_err(lua_error("s"))?;
    s.set("fps", options.fps).map_err(lua_error("s"))?;
    let file: Table = lua.load(source.as_str()).set_name(format!("={}", options.path)).eval().map_err(lua_error(&options.path))?;
    let run: Function = file.get("run").map_err(|_| format!("{}: нет run(s)", options.path))?;
    let thread = lua.create_thread(run).map_err(lua_error("сопрограмма"))?;
    // Звук — офлайн, на весь предел времени: синтезатор строится до начала счёта, чтобы граф был готов к кадру 0.
    let (offline, engine) = if options.sound {
      let offline = crate::offline::Offline::new(options.timeout, options.fps);
      let engine = crate::audio::Engine::offline(offline.ctx.clone());
      (Some(offline), Some(engine))
    } else {
      (None, None)
    };
    Ok(Self { lua, thread, s, source, name, fps: options.fps, timeout: options.timeout, lang: options.lang.clone(), ui: options.ui, size: options.size, scale: options.scale, frame: 0, actions: Vec::new(), wait: None, reply: None, shots: Vec::new(), record: options.record.clone(), recorder: None, sounded: Vec::new(), recording_from: 0, offline, engine, loaded: None, started: false, begun: false, reported: false, done: None })
  }

  /// Звук приложения: синтезатор офлайнового счёта или никакого.
  pub fn sound(&self) -> crate::Sound {
    match &self.engine {
      Some(engine) => crate::Sound::Engine(engine.clone()),
      None => crate::Sound::Off,
    }
  }

  /// Перед кадром — звук дошёл до него и стоит; после — идёт дальше.
  pub fn audio_begin(&mut self) {
    let frame = self.frame;
    if let Some(offline) = &mut self.offline {
      offline.begin(frame);
    }
  }

  pub fn audio_end(&mut self) {
    if let Some(offline) = &mut self.offline {
      offline.end();
    }
  }

  /// Время игры этого кадра.
  pub fn time(&self) -> f64 {
    self.frame as f64 / self.fps
  }

  /// Перед кадром: сценарий идёт, пока не попросит ждать; ввод этого кадра — во input.
  pub fn before(&mut self, app: &mut App, input: &mut Input) {
    if self.done.is_some() || self.reported || app.game().is_none() {
      return;
    }
    if !self.started {
      self.started = true;
      app.set_language(&self.lang);
      app.show_ui = self.ui;
    }
    if self.time() > self.timeout {
      self.done = Some(Err(format!("не уложился в {} с игры", self.timeout)));
      return;
    }
    let due = match &self.wait {
      None => true,
      Some(Wait::Frame(frame)) => self.frame >= *frame,
      Some(Wait::Start(generation)) => app.generation > *generation,
    };
    if due {
      self.wait = None;
      if let Err(error) = self.run(app) {
        self.done = Some(Err(error));
      }
    }
    let frame = self.frame;
    for (_, action) in self.actions.iter().filter(|(at, _)| *at == frame) {
      match action {
        Action::Pointer(point) => input.pointer = *point,
        Action::Button(index, down) => input.button(*index, *down),
        Action::Key(name, down) => input.key(name, *down, false),
        Action::Text(text) => input.text.push_str(text),
        Action::Wheel(lines) => input.wheel += lines,
      }
    }
    self.actions.retain(|(at, _)| *at > frame);
  }

  /// Итог — один раз, когда он есть; идущая запись дописывается.
  pub fn report(&mut self) -> Option<Result<(), String>> {
    let mut done = self.done.take()?;
    self.reported = true;
    if let Err(error) = self.stop_recording().and_then(|()| self.finish_sound()) {
      done = done.and(Err(error));
    }
    Some(done)
  }

  fn stop_recording(&mut self) -> Result<(), String> {
    let Some(recorder) = self.recorder.take() else { return Ok(()) };
    let frames = recorder.frames;
    eprintln!("сценарий: записано {frames} кадров ({:.1} с)", frames as f64 / self.fps);
    // Со звуком видео ждёт конца счёта звука.
    if self.offline.is_some() {
      self.sounded.push((recorder, self.recording_from, self.recording_from + frames));
      return Ok(());
    }
    recorder.finish(None)
  }

  /// Конец счёта звука: каждой записи со звуком — её кусок дорожки.
  fn finish_sound(&mut self) -> Result<(), String> {
    let Some(offline) = self.offline.take() else { return Ok(()) };
    let channels = offline.finish()?;
    let rate = crate::offline::RATE as f64;
    for (recorder, from, to) in self.sounded.drain(..) {
      let start = ((from as f64 / self.fps) * rate) as usize;
      let end = ((to as f64 / self.fps) * rate) as usize;
      let piece: Vec<Vec<f32>> = channels.iter().map(|channel| channel[start.min(channel.len())..end.min(channel.len())].to_vec()).collect();
      let wav = std::env::temp_dir().join(format!("kharos-sound-{}-{from}.wav", std::process::id()));
      let wav = wav.to_string_lossy().into_owned();
      crate::record::write_wav(&wav, &piece, rate as u32)?;
      let result = recorder.finish(Some(&wav));
      let _ = std::fs::remove_file(&wav);
      result?;
    }
    Ok(())
  }

  /// После кадра: снимки и запись этого кадра.
  pub fn after(&mut self, app: &App, size: [u32; 2]) {
    for path in self.shots.drain(..) {
      app.shot(&path, size);
    }
    // Запись — с кадров партии: экран до неё (меню под загрузкой) не нужен.
    if app.game().is_some() && self.started {
      if let Some(path) = self.record.take() {
        match crate::record::Recorder::start(&path, size, self.fps, self.offline.is_some()) {
          Ok(recorder) => {
            self.recorder = Some(recorder);
            self.recording_from = self.frame;
          }
          Err(error) => self.done = Some(Err(error)),
        }
      }
      if let Some(recorder) = &mut self.recorder {
        if recorder.size() != size {
          self.done = Some(Err("размер кадра сменился посреди записи".into()));
        } else if let Err(error) = recorder.frame(&app.pixels(size)) {
          self.done = Some(Err(error));
        }
      }
    }
    self.frame += 1;
  }

  /// Сценарий идёт до первой просьбы ждать или до конца.
  fn run(&mut self, app: &mut App) -> Result<(), String> {
    loop {
      if self.thread.status() != ThreadStatus::Resumable {
        self.done = Some(Ok(()));
        return Ok(());
      }
      self.s.set("frame", self.frame).map_err(lua_error("s"))?;
      self.s.set("time", self.time()).map_err(lua_error("s"))?;
      if let Some(game) = app.game() {
        self.s.set("tick", game.host.state.borrow().tick).map_err(lua_error("s"))?;
      }
      let reply = match self.reply.take() {
        // null JSON — nil, а не особое значение: иначе «ничего не нашлось» в сценарии не равно nil.
        Some(value) => kharos_content::vm::to_lua(&self.lua, &value).map_err(lua_error("ответ сценарию"))?,
        None => Value::Nil,
      };
      // Первый раз сценарий получает s, дальше — ответ на свою просьбу.
      let request: Value = if self.begun { self.thread.resume(reply) } else { self.thread.resume(self.s.clone()) }.map_err(|error| format!("{}: {error}", self.name))?;
      self.begun = true;
      if self.thread.status() != ThreadStatus::Resumable {
        self.done = Some(Ok(()));
        return Ok(());
      }
      let request: Json = self.lua.from_value(request).map_err(lua_error("просьба сценария"))?;
      if self.handle(app, &request)? {
        return Ok(());
      }
    }
  }

  /// Исполняет просьбу; true — сценарий ждёт следующих кадров.
  fn handle(&mut self, app: &mut App, request: &Json) -> Result<bool, String> {
    let op = request["op"].as_str().unwrap_or("");
    let number = |key: &str| request[key].as_f64().unwrap_or(0.0) as f32;
    let frame = self.frame;
    match op {
      "wait" => {
        self.wait = Some(Wait::Frame(frame + request["frames"].as_u64().unwrap_or(1)));
        Ok(true)
      }
      "start" => {
        let game = request["game"].as_str().ok_or("s:start: нет партии")?.to_string();
        let options = request["options"].clone();
        let options = if options.is_object() { options } else { json!({}) };
        let before = app.generation;
        app.start(&game, &options)?;
        self.wait = Some(Wait::Start(before));
        Ok(true)
      }
      "client" | "host" => {
        let name = request["name"].as_str().ok_or(format!("s:{op}: нет имени"))?;
        self.reply = Some(self.call(app, op, name, &request["args"])?);
        Ok(false)
      }
      "pointer" => {
        let point = request["x"].as_f64().map(|x| [x as f32, number("y")]);
        self.actions.push((frame, Action::Pointer(point)));
        self.wait = Some(Wait::Frame(frame + 1));
        Ok(true)
      }
      "click" => {
        let index = match request["button"].as_str() {
          Some("right") => 1,
          Some("middle") => 2,
          _ => 0,
        };
        self.actions.push((frame, Action::Pointer(Some([number("x"), number("y")]))));
        self.actions.push((frame, Action::Button(index, true)));
        self.actions.push((frame + 1, Action::Button(index, false)));
        // Нажатие, отпускание и кадр на отклик: выделение и щелчок по кнопке видны интерфейсу только в следующем кадре.
        self.wait = Some(Wait::Frame(frame + 3));
        Ok(true)
      }
      "key" => {
        let name = request["name"].as_str().unwrap_or("").to_string();
        self.actions.push((frame, Action::Key(name.clone(), true)));
        self.actions.push((frame + 1, Action::Key(name, false)));
        self.wait = Some(Wait::Frame(frame + 3));
        Ok(true)
      }
      "hold" => {
        let name = request["name"].as_str().unwrap_or("").to_string();
        self.actions.push((frame, Action::Key(name, request["down"].as_bool().unwrap_or(true))));
        self.wait = Some(Wait::Frame(frame + 1));
        Ok(true)
      }
      "type" => {
        self.actions.push((frame, Action::Text(request["text"].as_str().unwrap_or("").to_string())));
        self.wait = Some(Wait::Frame(frame + 1));
        Ok(true)
      }
      "wheel" => {
        self.actions.push((frame, Action::Wheel(number("lines"))));
        self.wait = Some(Wait::Frame(frame + 1));
        Ok(true)
      }
      "ui_rect" => {
        let id = request["id"].as_str().unwrap_or("");
        self.reply = app.game().and_then(|game| game.state.borrow().gui.rect(id)).map(|rect| json!({ "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h }));
        Ok(false)
      }
      "ui_texts" => {
        let texts = app.game().map(|game| game.state.borrow().gui.texts()).unwrap_or_default();
        self.reply = Some(Json::Array(texts.into_iter().map(|(text, rect, id)| json!({ "text": text, "id": id, "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h })).collect()));
        Ok(false)
      }
      "ui_find" => {
        let wanted = request["text"].as_str().unwrap_or("");
        let texts = app.game().map(|game| game.state.borrow().gui.texts()).unwrap_or_default();
        // Сначала надпись целиком, потом — где она встречается.
        let found = texts.iter().find(|(text, ..)| text.trim() == wanted).or_else(|| texts.iter().find(|(text, ..)| text.contains(wanted)));
        self.reply = found.map(|(text, rect, id)| json!({ "text": text, "id": id, "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h }));
        Ok(false)
      }
      "ui" => {
        app.show_ui = request["on"].as_bool().unwrap_or(true);
        Ok(false)
      }
      "record" => {
        self.stop_recording()?;
        self.record = Some(request["path"].as_str().ok_or("s:record: нет пути")?.to_string());
        Ok(false)
      }
      "stop" => {
        self.record = None;
        self.stop_recording()?;
        Ok(false)
      }
      "shot" => {
        // Снимок — этого кадра, когда он нарисован; сценарий идёт дальше со следующего.
        self.shots.push(request["path"].as_str().ok_or("s:shot: нет пути")?.to_string());
        self.wait = Some(Wait::Frame(frame + 1));
        Ok(true)
      }
      other => Err(format!("s: непонятная просьба {other:?}")),
    }
  }

  /// Функция файла сценария в машине клиента или хоста идущей партии.
  fn call(&mut self, app: &mut App, side: &str, name: &str, args: &Json) -> Result<Json, String> {
    let generation = app.generation;
    let game = app.game_mut().ok_or("партии нет")?;
    if self.loaded.as_ref().is_none_or(|(loaded, ..)| *loaded != generation) {
      let load = |lua: &Lua, side: &str| -> Result<Option<Table>, String> {
        let file: Table = lua.load(self.source.as_str()).set_name(format!("=сценарий {}", self.name)).eval().map_err(lua_error(format!("сценарий у {side}")))?;
        file.get::<Option<Table>>(side).map_err(lua_error(side))
      };
      let client = load(&game.client.lua, "client")?;
      let host = load(game.host.lua(), "host")?;
      self.loaded = Some((generation, client, host));
    }
    let (_, client, host) = self.loaded.as_ref().expect("загружен");
    let table = if side == "client" { client } else { host };
    let function: Function = table.as_ref().and_then(|table| table.get::<Option<Function>>(name).ok().flatten()).ok_or_else(|| format!("в сценарии нет {side}.{name}"))?;
    let label = format!("{side}.{name}");
    if side == "host" {
      return game.host.call(&function, args, &label);
    }
    let lua = game.client.lua.clone();
    let args = kharos_content::vm::to_lua(&lua, args).map_err(lua_error(&label))?;
    let result: Value = function.call((game.script_ctx(), args)).map_err(lua_error(&label))?;
    lua.from_value(result).map_err(lua_error(format!("{label}: результат")))
  }
}
