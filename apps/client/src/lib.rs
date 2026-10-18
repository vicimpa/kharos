//! Клиент Kharos (docs/content.md, К4): окно, рендер, звук — движок; что рисовать, как звучать, как управлять — моды.
//! Одиночная игра: хост в том же процессе.
//!
//! KHAROS_MODS — папки с модами через `:` (по умолчанию `mods` рядом или выше по дереву), KHAROS_GAME — партия.

pub mod atlas;
mod audio;
mod game;
mod gl;
mod gui;
mod input;
mod render;
mod saves;
mod script;
#[cfg(not(target_arch = "wasm32"))]
mod shell;
mod ui;

use game::Game;
use input::Input;
use kharos_content::{discover, Mod};
use render::Renderer;
use script::{AppLink, AppRequest, AppState};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

/// Шрифты интерфейса — Ark Pixel 12 и 10 px (OFL), как у TS-клиента, обрезанные до алфавитов (tools/fonts.py).
const FONTS: [&[u8]; 2] = [include_bytes!("../fonts/ark-pixel-12px.otf"), include_bytes!("../fonts/ark-pixel-10px.otf")];

pub struct App {
  renderer: Renderer,
  game: Game,
  mods: Vec<Mod>,
  /// Общий синтезатор: банк записей считается один раз на запуск.
  sound: Option<Rc<audio::Engine>>,
  link: AppLink,
  /// Пора закрыть игру.
  pub quit: bool,
  /// Когда партию слота сохраняли в последний раз, секунды запуска.
  saved_at: f64,
}

/// Как часто пишется партия слота, секунд (SAVE_INTERVAL в packages/host/src/local.ts).
const SAVE_INTERVAL: f64 = 5.0;

/// Моды: из KHAROS_MODS или папки `mods` в текущей папке и выше.
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

/// Партия меню — `menu` в манифестах модов, последний мод главнее.
fn menu_of(mods: &[Mod]) -> Result<Option<String>, String> {
  let content = kharos_content::Content::load(kharos_content::Side::Client, mods.to_vec()).map_err(|error| error.to_string())?;
  Ok(content.manifests.iter().rev().find_map(|manifest| manifest.get::<Option<String>>("menu").ok().flatten()))
}

impl App {
  pub fn new(gl: glow::Context) -> Result<Self, String> {
    let mut renderer = Renderer::new(gl)?;
    renderer.load_skin(&gui::skin_pixels(), gui::SKIN_SIZE);
    let mods = mods()?;
    let sound = audio::Engine::new();
    if sound.is_none() {
      eprintln!("звука нет: некуда выводить");
    }
    let menu = menu_of(&mods)?;
    // KHAROS_GAME — сразу в партию (проверки, снимки); иначе — в меню, а без меню — в партию по умолчанию.
    let first = std::env::var("KHAROS_GAME").ok().or_else(|| menu.clone());
    let link: AppLink = Rc::new(RefCell::new(AppState { menu, prefs: script::Prefs::load(), saves: Some(saves::Saves::load()), ..Default::default() }));
    let game = Self::launch(&mut renderer, &mods, first.as_deref(), &serde_json::Value::Object(Default::default()), None, sound.clone(), link.clone())?;
    Ok(Self { renderer, game, mods, sound, link, quit: false, saved_at: 0.0 })
  }

  /// Пишет партию в её слот, если он есть.
  pub fn save(&mut self) {
    let Some(slot) = self.link.borrow().slot.clone() else { return };
    match self.game.save() {
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
    let (frame, view) = self.game.frame(input)?;
    let size = [size[0] as i32, size[1] as i32];
    self.renderer.draw_world(&view, &frame, size);
    {
      let state = self.game.state.borrow();
      self.renderer.draw_batch(&state.draw, &state.gui.fonts.atlas, &view, true, self.game.palette());
      self.renderer.draw_glow(&state.glow, &state.gui.fonts.atlas, &view, self.game.palette());
      self.renderer.draw_batch(&state.gui.batch, &state.gui.fonts.atlas, &view, false, self.game.palette());
    }
    // Схема карты новой игры досчитала ряды — в текстуру.
    {
      let mut state = self.game.state.borrow_mut();
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
      Some(AppRequest::Start { game, options, slot }) => {
        self.save();
        self.game = Self::launch(&mut self.renderer, &self.mods, Some(&game), &options, slot, self.sound.clone(), self.link.clone())?;
        self.saved_at = input.time;
      }
      Some(AppRequest::Reset { options }) => {
        self.game.reset(self.mods.clone(), &options, 1)?;
        self.link.borrow_mut().options = options;
        Self::upload_land(&mut self.renderer, &mut self.game);
      }
      Some(AppRequest::Quit) => {
        self.save();
        self.quit = true;
      }
      None => {}
    }
    Ok(())
  }

  pub fn shot(&self, path: &str, size: [u32; 2]) {
    self.renderer.shot(path, size);
  }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn run() {
  shell::run();
}
