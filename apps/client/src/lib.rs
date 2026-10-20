//! Клиент Kharos (docs/content.md, К4): окно, рендер, звук — движок; что рисовать, как звучать, как управлять — моды.
//! Одиночная игра: хост в том же процессе.
//!
//! KHAROS_MODS — папки с модами через `:` (по умолчанию `mods` рядом или выше по дереву), KHAROS_GAME — партия.

pub mod atlas;
mod clock;
mod audio;
mod game;
mod gl;
mod gui;
mod input;
mod lang;
mod loading;
mod net;
mod render;
mod saves;
#[cfg(not(target_arch = "wasm32"))]
mod offline;
#[cfg(not(target_arch = "wasm32"))]
mod record;
#[cfg(not(target_arch = "wasm32"))]
mod scenario;
mod script;
mod store;
#[cfg(not(target_arch = "wasm32"))]
mod shell;
#[cfg(target_arch = "wasm32")]
mod web;
mod ui;
mod webaudio;

use game::Game;
use input::Input;
#[cfg(not(target_arch = "wasm32"))]
use kharos_content::discover;
use kharos_content::Mod;
use render::Renderer;
use script::{AppLink, AppRequest, AppState};
use std::cell::RefCell;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
use std::rc::Rc;

/// Шрифты интерфейса — Ark Pixel 12 и 10 px (OFL), как у TS-клиента, обрезанные до алфавитов (tools/fonts.py).
const FONTS: [&[u8]; 2] = [include_bytes!("../fonts/ark-pixel-12px.otf"), include_bytes!("../fonts/ark-pixel-10px.otf")];

pub struct App {
  renderer: Renderer,
  /// Партия; пока идёт загрузка — её нет.
  game: Option<Game>,
  /// Экран загрузки: пока считаются звуки; потом — первая партия (first).
  loading: Option<loading::Loading>,
  first: Option<String>,
  mods: Vec<Mod>,
  /// Общий синтезатор: банк записей считается один раз на запуск.
  sound: Option<Rc<audio::Engine>>,
  link: AppLink,
  /// Пора закрыть игру.
  pub quit: bool,
  /// Идёт вход на сервер: ждём приветствия, партия меню живёт.
  joining: Option<Joining>,
  /// Когда партию слота сохраняли в последний раз, секунды запуска.
  saved_at: f64,
  /// Сколько партий запущено: по нему сценарий узнаёт, что новая партия появилась.
  pub generation: u64,
  /// Рисовать ли интерфейс: без него — только мир (ролики); считается он всё равно, и щелчки по нему работают.
  pub show_ui: bool,
  /// Загрузка считает звуки за один кадр.
  patient: bool,
  /// Зерно math.random клиентских скриптов партии.
  seed: Option<u32>,
}

/// Откуда звук: на устройство, никакого или готовый синтезатор (офлайновый счёт режима сценария).
pub enum Sound {
  Device,
  Off,
  Engine(Rc<audio::Engine>),
}

/// Как запускать приложение: звук и терпеливая загрузка (звуки считаются за один кадр — так у снимков и сценариев
/// счёт кадров не зависит от скорости машины).
pub struct AppOptions {
  pub sound: Sound,
  pub patient: bool,
  /// Зерно `math.random` клиентских скриптов каждой партии: прогон сценария повторяется кадр в кадр (дым, петли
  /// моторов со случайного места); None — случайное, как в игре.
  pub seed: Option<u32>,
}

impl Default for AppOptions {
  fn default() -> Self {
    Self { sound: Sound::Device, patient: std::env::var_os("KHAROS_SHOT").is_some(), seed: None }
  }
}

/// Как часто пишется партия слота, секунд (SAVE_INTERVAL в packages/host/src/local.ts).
const SAVE_INTERVAL: f64 = 5.0;

/// Моды, зашитые в сборку для браузера (build.rs): имя мода, файлы — путь от корня мода и содержимое.
#[cfg(target_arch = "wasm32")]
const BUNDLED: &[(&str, &[(&str, &[u8])])] = include!(concat!(env!("OUT_DIR"), "/mods.rs"));

/// Моды в браузере — из сборки: те же файлы, что на диске.
#[cfg(target_arch = "wasm32")]
fn mods() -> Result<Vec<Mod>, String> {
  let mut all = Vec::new();
  for (name, list) in BUNDLED {
    let mut files = kharos_content::Files::default();
    for (path, bytes) in *list {
      if path.ends_with(".luau") {
        files.files.insert(path.to_string(), String::from_utf8_lossy(bytes).into_owned());
      } else {
        files.assets.insert(path.to_string(), bytes.to_vec());
      }
    }
    all.push(Mod { name: name.to_string(), files: Rc::new(files), dir: None });
  }
  Ok(all)
}

/// Моды: из KHAROS_MODS или папки `mods` в текущей папке и выше.
#[cfg(not(target_arch = "wasm32"))]
fn mods() -> Result<Vec<Mod>, String> {
  let roots: Vec<PathBuf> = match std::env::var("KHAROS_MODS") {
    Ok(list) => std::env::split_paths(&list).collect(),
    Err(_) => {
      let mut dir = std::env::current_dir().map_err(|error| error.to_string())?;
      loop {
        if dir.join("mods").is_dir() {
          break vec![dir.join("mods")];
        }
        if !dir.pop() {
          return Err("нет папки mods: запустите из папки игры или задайте KHAROS_MODS".into());
        }
      }
    }
  };
  let mut all = Vec::new();
  for root in roots {
    all.extend(discover(&root).map_err(|error| format!("{}: {error}", root.display()))?);
  }
  Ok(all)
}

/// Настройка запуска: на нативе — переменная окружения env, в браузере — параметр адреса query.
fn setting(env: &str, query: &str) -> Option<String> {
  #[cfg(not(target_arch = "wasm32"))]
  {
    let _ = query;
    std::env::var(env).ok()
  }
  #[cfg(target_arch = "wasm32")]
  {
    let _ = env;
    web::query(query)
  }
}

/// Партия меню — `menu` в манифестах модов, последний мод главнее.
fn menu_of(mods: &[Mod]) -> Result<Option<String>, String> {
  let content = kharos_content::Content::load(kharos_content::Side::Client, mods.to_vec()).map_err(|error| error.to_string())?;
  Ok(content.manifests.iter().rev().find_map(|manifest| manifest.get::<Option<String>>("menu").ok().flatten()))
}

impl App {
  pub fn new(gl: glow::Context) -> Result<Self, String> {
    Self::with(gl, AppOptions::default())
  }

  pub fn with(gl: glow::Context, options: AppOptions) -> Result<Self, String> {
    let mut renderer = Renderer::new(gl)?;
    renderer.load_skin(&gui::skin_pixels(), gui::SKIN_SIZE);
    let mods = mods()?;
    let device = matches!(options.sound, Sound::Device);
    let sound = match options.sound {
      Sound::Device => audio::Engine::new(),
      Sound::Off => None,
      Sound::Engine(engine) => Some(engine),
    };
    if sound.is_none() && device {
      eprintln!("звука нет: некуда выводить");
    }
    let menu = menu_of(&mods)?;
    // KHAROS_GAME (в браузере — ?game=) — сразу в партию (проверки, снимки); иначе — в меню, а без меню — в партию
    // по умолчанию.
    let first = setting("KHAROS_GAME", "game").or_else(|| menu.clone());
    let prefs = script::Prefs::load();
    let link: AppLink = Rc::new(RefCell::new(AppState { menu, language: prefs.get("lang").and_then(serde_json::Value::as_str).map(str::to_string), system_languages: lang::system(), prefs, saves: Some(saves::Saves::load()), ..Default::default() }));
    // Звуки считаются под экраном загрузки, партия начинается, когда они готовы.
    let loading = match &sound {
      Some(engine) => {
        let state = link.borrow();
        loading::Loading::new(&mods, engine.clone(), gui::Fonts::new(&FONTS)?, state.language.as_deref(), &state.system_languages)?
      }
      None => None,
    };
    let mut app = Self { renderer, game: None, loading, first, mods, sound, link, quit: false, joining: None, saved_at: 0.0, generation: 0, show_ui: true, patient: options.patient, seed: options.seed };
    if app.loading.is_none() {
      app.begin()?;
    }
    Ok(app)
  }

  /// Первая партия — после загрузки.
  fn begin(&mut self) -> Result<(), String> {
    self.loading = None;
    let game = Self::launch(&mut self.renderer, &self.mods, self.first.as_deref(), &serde_json::Value::Object(Default::default()), None, self.sound.clone(), self.link.clone(), self.seed, None)?;
    self.game = Some(game);
    self.generation += 1;
    // В браузере ?server=адрес (и ?name=ник) — сразу на сервер: ссылка «играть на сервере».
    #[cfg(target_arch = "wasm32")]
    if let Some(url) = web::query("server") {
      let mut state = self.link.borrow_mut();
      let name = web::query("name").or_else(|| state.prefs.get("server").and_then(|server| server.get("name")).and_then(serde_json::Value::as_str).map(str::to_string)).unwrap_or_default();
      self.joining = Some(Joining::new(&self.mods, &mut state, &url, &name, "", crate::clock::seconds()));
    }
    Ok(())
  }

  /// Браузер играет звук только после касания или клавиши: оболочка будит его на каждом.
  pub fn wake_sound(&self) {
    if let Some(sound) = &self.sound {
      webaudio::wake(&sound.ctx);
    }
  }

  /// Пишет партию в её слот, если он есть; редактор пишется только по просьбе (force).
  pub fn save(&mut self) {
    if self.link.borrow().editing {
      return;
    }
    self.store();
  }

  /// Пишет партию в её слот, если он есть.
  fn store(&mut self) {
    let Some(slot) = self.link.borrow().slot.clone() else { return };
    let Some(game) = &self.game else { return };
    match game.save() {
      Ok((world, camera, tick)) => {
        if let Some(saves) = self.link.borrow_mut().saves.as_mut() {
          saves.store(&slot, tick, camera, &world);
        }
      }
      Err(error) => eprintln!("сохранение: {error}"),
    }
  }

  /// Новая партия: хост, клиентская машина, атлас, земля и мини-карта — в рендер.
  #[allow(clippy::too_many_arguments)]
  /// remote — партия по сети: приветствие сервера и связь с ним.
  fn launch(renderer: &mut Renderer, mods: &[Mod], game: Option<&str>, options: &serde_json::Value, slot: Option<String>, sound: Option<Rc<audio::Engine>>, link: AppLink, seed: Option<u32>, remote: Option<(net::Welcome, Box<dyn net::Link>)>) -> Result<Game, String> {
    let fonts = gui::Fonts::new(&FONTS)?;
    renderer.reset_font();
    // Мир слота — из сохранения; пустой слот заводит новый мир по настройкам.
    let (world, camera) = {
      let state = link.borrow();
      let saves = state.saves.as_ref();
      let world = slot.as_ref().and_then(|id| saves.and_then(|saves| saves.world(id)));
      let camera = slot.as_ref().and_then(|id| saves.and_then(|saves| saves.get(id)).and_then(|meta| meta.get("camera").cloned()));
      (world, camera)
    };
    let remote = match remote {
      Some(remote) => Some(remote),
      None => Self::remote(mods, game, options, world.is_some(), &link)?,
    };
    let mut game = match remote {
      Some((welcome, remote)) => Game::join(mods.to_vec(), welcome, remote, fonts, sound, link.clone())?,
      None => Game::new(mods.to_vec(), game, options, world.as_ref(), 1, fonts, sound, link.clone())?,
    };
    // Зерно math.random скриптов: в сценарии — постоянное, в игре — от часов, каждая партия звучит по-своему.
    let seed = seed.unwrap_or_else(|| crate::clock::epoch_millis() as u64 as u32);
    game.client.lua.load(format!("math.randomseed({seed})")).exec().map_err(|error| format!("зерно скриптов: {error}"))?;
    if let Some(camera) = camera.filter(|_| world.is_some()) {
      game.set_camera(&camera);
    }
    {
      let mut state = link.borrow_mut();
      state.game = game.host.game.clone();
      state.options = options.clone();
      state.slot = slot.clone();
      if let Some(id) = &slot {
        state.prefs.set("last", serde_json::Value::from(id.as_str()));
      }
    }
    if let Some((pixels, size)) = game.atlas.take() {
      renderer.load_atlas(&pixels, size);
    }
    Self::upload_land(renderer, &mut game);
    Ok(game)
  }

  /// Партия по сети. KHAROS_SERVER=ws://адрес:порт — на сервер (ник — KHAROS_NAME; под каким именем сервер помнит
  /// игрока, хранится в настройках по адресу). KHAROS_NET=loopback — новая партия (не меню, не редактор, не из
  /// сохранения) через сервер в том же процессе: клиент видит реплику, приказы идут сообщениями.
  fn remote(mods: &[Mod], game: Option<&str>, options: &serde_json::Value, saved: bool, link: &AppLink) -> Result<Option<(net::Welcome, Box<dyn net::Link>)>, String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
      let mut state = link.borrow_mut();
      if saved || state.editing || game.is_some_and(|game| state.menu.as_deref() == Some(game)) {
        return Ok(None);
      }
      if let Ok(url) = std::env::var("KHAROS_SERVER") {
        // Проверки и снимки: вход ждём здесь же, а не между кадрами.
        let name = std::env::var("KHAROS_NAME").unwrap_or_default();
        let password = std::env::var("KHAROS_PASSWORD").unwrap_or_default();
        let mut joining = Joining::new(mods, &mut state, &url, &name, &password, crate::clock::seconds());
        drop(state);
        loop {
          match joining.poll(crate::clock::seconds()) {
            Ok(Some(welcome)) => {
              let (welcome, link) = joining.enter(welcome, &mut link.borrow_mut());
              return Ok(Some((welcome, link)));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(error) => return Err(format!("{url}: {error}")),
          }
        }
      }
      if std::env::var("KHAROS_NET").as_deref() != Ok("loopback") {
        return Ok(None);
      }
      let seed = options.get("seed").and_then(serde_json::Value::as_f64).map_or(1, |seed| seed as u64);
      let server = kharos_net::Server::new(mods.to_vec(), game, seed, options.clone(), String::new())?;
      let mut loopback = net::Loopback::new(server);
      let welcome = loopback.enter(mods)?;
      Ok(Some((welcome, Box::new(loopback))))
    }
    #[cfg(target_arch = "wasm32")]
    {
      let _ = (mods, game, options, saved, link);
      Ok(None)
    }
  }

  /// Вход на сервер между кадрами: ждём приветствия; вошли — партия по сети, нет — ошибка для окна «Сеть».
  fn join(&mut self, now: f64) -> Result<(), String> {
    let Some(joining) = self.joining.as_mut() else { return Ok(()) };
    match joining.poll(now) {
      Ok(None) => Ok(()),
      Ok(Some(welcome)) => {
        let joining = self.joining.take().expect("вход");
        let url = joining.url.clone();
        let remote = joining.enter(welcome, &mut self.link.borrow_mut());
        self.save();
        self.link.borrow_mut().editing = false;
        self.game = Some(Self::launch(&mut self.renderer, &self.mods, None, &serde_json::Value::Null, None, self.sound.clone(), self.link.clone(), self.seed, Some(remote))?);
        self.generation += 1;
        let mut state = self.link.borrow_mut();
        state.net.connecting = None;
        state.net.server = Some(url);
        Ok(())
      }
      Err(error) => {
        self.joining = None;
        let mut state = self.link.borrow_mut();
        state.net.connecting = None;
        state.net.error = Some(error);
        Ok(())
      }
    }
  }

  /// Земля и мини-карта партии — в рендер.
  fn upload_land(renderer: &mut Renderer, game: &mut Game) {
    if let Some((pixels, size)) = game.minimap.take() {
      renderer.load_minimap(&pixels, size);
    }
    match game.land.take() {
      Some(land) => renderer.set_land(land),
      None => renderer.clear_land(),
    }
  }

  pub fn frame(&mut self, input: &Input, size: [u32; 2]) -> Result<(), String> {
    if let Some(loading) = &mut self.loading {
      // Снимок кадра ждёт загрузку целиком: так счёт его кадров не зависит от скорости расчёта.
      loading.pump(self.patient)?;
      loading.draw(&mut self.renderer, input, size);
      if loading.finished() {
        self.begin()?;
      }
      return Ok(());
    }
    // Графика игрока (settings.graphics в моде): рендер читает её каждый кадр, смена видна сразу.
    self.renderer.graphics = self.graphics();
    self.join(input.time)?;
    let Some(game) = &mut self.game else { return Ok(()) };
    let (frame, view) = game.frame(input)?;
    // Связь с сервером кончилась — в меню, к окну «Сеть» с причиной.
    if let Some(reason) = game.disconnected() {
      let mut state = self.link.borrow_mut();
      let url = state.net.server.take();
      state.net.error = Some(serde_json::json!({ "key": reason, "url": url, "password": reason.contains("assword") }));
      if let Some(menu) = state.menu.clone() {
        state.request = Some(AppRequest::Start { game: menu, options: serde_json::Value::Object(Default::default()), slot: None, editor: false });
      }
    }
    let size = [size[0] as i32, size[1] as i32];
    self.renderer.draw_world(&view, &frame, size);
    {
      let state = game.state.borrow();
      self.renderer.draw_batch(&state.draw, &state.gui.fonts.atlas, &view, true, game.palette());
      self.renderer.draw_glow(&state.glow, &state.gui.fonts.atlas, &view, game.palette());
      if self.show_ui {
        self.renderer.draw_batch(&state.gui.batch, &state.gui.fonts.atlas, &view, false, game.palette());
      }
    }
    // Схема карты новой игры досчитала ряды — в текстуру.
    {
      let mut state = game.state.borrow_mut();
      if state.preview.dirty {
        state.preview.dirty = false;
        self.renderer.load_preview(&state.preview.pixels, script::PREVIEW_SIZE);
      }
    }
    // Просьбы скриптов к приложению — после кадра: партия, которая просит, дорисована.
    // Партия слота пишется сама раз в SAVE_INTERVAL и перед уходом из неё.
    if input.time - self.saved_at >= SAVE_INTERVAL {
      self.saved_at = input.time;
      self.save();
    }
    let request = self.link.borrow_mut().request.take();
    match request {
      Some(AppRequest::Start { game, options, slot, editor }) => {
        self.save();
        self.link.borrow_mut().net.server = None;
        self.link.borrow_mut().editing = editor;
        self.game = Some(Self::launch(&mut self.renderer, &self.mods, Some(&game), &options, slot, self.sound.clone(), self.link.clone(), self.seed, None)?);
        self.generation += 1;
        self.saved_at = input.time;
      }
      Some(AppRequest::Save) => self.store(),
      Some(AppRequest::Reset { options }) => {
        if let Some(game) = &mut self.game {
          game.reset(self.mods.clone(), &options, 1)?;
          Self::upload_land(&mut self.renderer, game);
        }
        self.link.borrow_mut().options = options;
      }
      Some(AppRequest::Join { url, name, password }) => {
        let mut state = self.link.borrow_mut();
        if let Some(error) = net::refuse_url(&url) {
          state.net.error = Some(error);
        } else {
          self.joining = Some(Joining::new(&self.mods, &mut state, &url, &name, &password, input.time));
        }
      }
      Some(AppRequest::Quit) => {
        self.save();
        self.quit = true;
      }
      None => {}
    }
    Ok(())
  }

  /// Настройки графики из c.app (ключ graphics); чего нет — высокое.
  fn graphics(&self) -> render::Graphics {
    let state = self.link.borrow();
    let saved = state.prefs.get("graphics");
    let number = |key: &str| saved.and_then(|value| value.get(key)).and_then(serde_json::Value::as_f64);
    let level = |key: &str| number(key).map_or(2, |value| value.clamp(0.0, 2.0) as usize);
    render::Graphics { resolution: number("resolution").unwrap_or(1.0) as f32, terrain: level("terrain"), shadows: level("shadows"), weather: level("weather") }
  }

  /// Предел кадров в секунду (graphics.fps); None — без предела.
  pub fn fps_limit(&self) -> Option<f64> {
    let state = self.link.borrow();
    state.prefs.get("graphics").and_then(|value| value.get("fps")).and_then(serde_json::Value::as_f64).filter(|fps| *fps > 0.0)
  }

  /// Рисовать кадр не в окно, а в свой буфер такого размера (физические пиксели).
  pub fn offscreen(&mut self, size: [u32; 2]) {
    self.renderer.offscreen([size[0] as i32, size[1] as i32]);
  }

  /// Пиксели нарисованного кадра RGBA, строками сверху вниз.
  pub fn pixels(&self, size: [u32; 2]) -> Vec<u8> {
    self.renderer.pixels(size)
  }

  /// Идущая партия.
  pub fn game(&self) -> Option<&Game> {
    self.game.as_ref()
  }

  pub fn game_mut(&mut self) -> Option<&mut Game> {
    self.game.as_mut()
  }

  /// Новая партия сразу, мимо просьб скриптов (их, как витрина меню, кладут каждый кадр): для сценария.
  pub fn start(&mut self, game: &str, options: &serde_json::Value) -> Result<(), String> {
    self.link.borrow_mut().request = None;
    self.link.borrow_mut().editing = false;
    self.game = Some(Self::launch(&mut self.renderer, &self.mods, Some(game), options, None, self.sound.clone(), self.link.clone(), self.seed, None)?);
    self.generation += 1;
    Ok(())
  }

  /// Язык интерфейса: строки словаря берутся на нём с этого кадра.
  pub fn set_language(&self, language: &str) {
    self.link.borrow_mut().language = Some(language.to_string());
  }

  pub fn shot(&self, path: &str, size: [u32; 2]) {
    self.renderer.shot(path, size);
  }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn run() {
  shell::run();
}

#[cfg(target_arch = "wasm32")]
pub fn run() {
  web::run();
}

/// Вход на сервер: связь открыта, вход послан, ждём приветствия.
struct Joining {
  link: Box<dyn net::Link>,
  url: String,
  name: String,
  started: f64,
  /// Пришедшее вместе с приветствием: первые кадры.
  pending: Vec<kharos_net::Message>,
}

/// Сколько ждать приветствия.
const JOIN_WAIT: f64 = 10.0;

impl Joining {
  /// Открывает связь и шлёт вход: под каким именем сервер помнит игрока — из настроек по адресу.
  fn new(mods: &[Mod], state: &mut AppState, url: &str, name: &str, password: &str, now: f64) -> Self {
    let id = state.prefs.get("servers").and_then(|servers| servers.get(url)).and_then(|entry| entry.get("id")).and_then(serde_json::Value::as_str).map(str::to_string);
    state.net.connecting = Some(url.to_string());
    state.net.error = None;
    let link = net::open(url, net::hello(mods, name, id, password));
    Self { link, url: url.to_string(), name: name.to_string(), started: now, pending: Vec::new() }
  }

  /// Вошли — приветствие; отказ, обрыв или тишина дольше JOIN_WAIT — ошибка { key, url, seconds, password }.
  fn poll(&mut self, now: f64) -> Result<Option<net::Welcome>, serde_json::Value> {
    let failed = |key: &str| serde_json::json!({ "key": key, "url": self.url, "seconds": JOIN_WAIT, "password": key.contains("assword") });
    self.link.update(now).map_err(|error| serde_json::json!({ "key": error }))?;
    let mut found = None;
    for message in self.link.receive() {
      if found.is_some() {
        self.pending.push(message);
        continue;
      }
      match net::welcome(&message) {
        Ok(Some(welcome)) => found = Some(welcome),
        Ok(None) => {}
        Err(reason) => return Err(failed(&reason)),
      }
    }
    if found.is_some() {
      return Ok(found);
    }
    if let Some(reason) = self.link.closed() {
      return Err(failed(&reason));
    }
    if now - self.started > JOIN_WAIT {
      return Err(failed("net.noReply"));
    }
    Ok(None)
  }

  /// Вошли: имя игрока на этом сервере, ник и адрес — в настройки (недавние серверы); связь — партии.
  fn enter(self, welcome: net::Welcome, state: &mut AppState) -> (net::Welcome, Box<dyn net::Link>) {
    let mut servers = state.prefs.get("servers").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
    servers.insert(self.url.clone(), serde_json::json!({ "id": welcome.id, "played": crate::clock::epoch_millis(), "name": self.name }));
    state.prefs.set("servers", serde_json::Value::Object(servers));
    state.prefs.set("server", serde_json::json!({ "url": self.url, "name": self.name }));
    (welcome, Box::new(net::Buffered { link: self.link, pending: self.pending }))
  }
}
