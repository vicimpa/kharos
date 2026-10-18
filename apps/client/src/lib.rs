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
mod render;
mod saves;
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
  /// Когда партию слота сохраняли в последний раз, секунды запуска.
  saved_at: f64,
  /// Сколько партий запущено: по нему сценарий узнаёт, что новая партия появилась.
  pub generation: u64,
}

/// Как запускать приложение: со звуком ли (в режиме сценария звука нет).
pub struct AppOptions {
  pub sound: bool,
}

impl Default for AppOptions {
  fn default() -> Self {
    Self { sound: true }
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
    let sound = if options.sound { audio::Engine::new() } else { None };
    if sound.is_none() && options.sound {
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
    let mut app = Self { renderer, game: None, loading, first, mods, sound, link, quit: false, saved_at: 0.0, generation: 0 };
    if app.loading.is_none() {
      app.begin()?;
    }
    Ok(app)
  }

  /// Первая партия — после загрузки.
  fn begin(&mut self) -> Result<(), String> {
    self.loading = None;
    let game = Self::launch(&mut self.renderer, &self.mods, self.first.as_deref(), &serde_json::Value::Object(Default::default()), None, self.sound.clone(), self.link.clone())?;
    self.game = Some(game);
    self.generation += 1;
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
  fn launch(renderer: &mut Renderer, mods: &[Mod], game: Option<&str>, options: &serde_json::Value, slot: Option<String>, sound: Option<Rc<audio::Engine>>, link: AppLink) -> Result<Game, String> {
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
    let mut game = Game::new(mods.to_vec(), game, options, world.as_ref(), 1, fonts, sound, link.clone())?;
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
      loading.pump(std::env::var_os("KHAROS_SHOT").is_some())?;
      loading.draw(&mut self.renderer, input, size);
      if loading.finished() {
        self.begin()?;
      }
      return Ok(());
    }
    // Графика игрока (settings.graphics в моде): рендер читает её каждый кадр, смена видна сразу.
    self.renderer.graphics = self.graphics();
    let Some(game) = &mut self.game else { return Ok(()) };
    let (frame, view) = game.frame(input)?;
    let size = [size[0] as i32, size[1] as i32];
    self.renderer.draw_world(&view, &frame, size);
    {
      let state = game.state.borrow();
      self.renderer.draw_batch(&state.draw, &state.gui.fonts.atlas, &view, true, game.palette());
      self.renderer.draw_glow(&state.glow, &state.gui.fonts.atlas, &view, game.palette());
      self.renderer.draw_batch(&state.gui.batch, &state.gui.fonts.atlas, &view, false, game.palette());
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
        self.link.borrow_mut().editing = editor;
        self.game = Some(Self::launch(&mut self.renderer, &self.mods, Some(&game), &options, slot, self.sound.clone(), self.link.clone())?);
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
    self.game = Some(Self::launch(&mut self.renderer, &self.mods, Some(game), options, None, self.sound.clone(), self.link.clone())?);
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
