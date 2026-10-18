//! Подача из модов (docs/mods.md, «Клиент»): клиентская машина Luau и что она видит.
//!
//! Каждый кадр: сигналы хоста → `signals` видов; камера партии; панели (`ui/`); управление (`controls/`); атмосфера
//! (`atmosphere/`); музыка (`music/`). Скриптам дан `c`:
//!
//! - `c.input` — ввод кадра, `c.camera` — камера, `c.shared` — общая память скриптов клиента, `c.atmosphere` — свет,
//!   ветер и огни сцены, `c.music` — настроение и громкость музыки;
//! - мир на чтение, сглаженный между тиками: `c:each`, `c:get`, `c:proto`, `c:pick`, `c:within`;
//! - `c:send(приказ, аргументы)` — хосту; `c:sound(голос, …)`, `c:particle(…)`;
//! - `c.draw` — рисование поверх мира в тайлах, `c.ui` — интерфейс в пикселях экрана.

use crate::atlas::Look;
use crate::input::{Input, BUTTONS};
use crate::render::View;

use kharos_world::host::State;
use kharos_world::Entity;
use mlua::{Lua, LuaSerdeExt, Table, UserData, UserDataFields, UserDataMethods, Value};
use serde_json::Value as Json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Частица: место и скорость в тайлах, сколько живёт, цвет и размер в текселях.
#[derive(Clone, Copy, Debug)]
pub struct Particle {
  pub x: f32,
  pub y: f32,
  pub vx: f32,
  pub vy: f32,
  pub age: f32,
  pub life: f32,
  pub color: u32,
  pub size: f32,
  /// Сносит ли ветром.
  pub drift: bool,
}

/// След на земле (decalsPass.ts): отрезок в тайлах, ширина в тайлах, цвет 0..1, непрозрачность, доля закрашенных
/// пикселей, зерно растворения, возраст и срок в секундах.
#[derive(Clone, Copy, Debug)]
pub struct Decal {
  pub line: [f32; 4],
  pub width: f32,
  pub color: [f32; 3],
  pub opacity: f32,
  pub density: f32,
  pub seed: f32,
  pub age: f32,
  pub life: f32,
}

/// Больше следов разом не бывает: самые старые уступают место новым (TRACE_LIMIT).
pub const DECAL_LIMIT: usize = 12_000;

/// Разовый звук, заказанный скриптом за кадр: запись банка, громкость, сторона, скорость.
pub struct SoundOrder {
  pub voice: String,
  pub gain: f32,
  pub pan: f32,
  pub rate: f32,
}

/// Значок вида для скриптов: портрет (или кадр значка) в атласе и его размер в пикселях.
pub struct LookInfo {
  pub uv: [f32; 4],
  pub size: [f32; 2],
  pub picture: bool,
}

/// Схема карты новой игры (preview.ts): сторона, что считается, сколько рядов готово, доли видов местности.
pub struct Preview {
  pub key: String,
  pub config: Option<kharos_engine::terrain::GeneratorConfig>,
  pub palette: Vec<Vec<Vec<u8>>>,
  pub side: f64,
  pub row: usize,
  pub pixels: Vec<u8>,
  pub counts: [u32; 4],
  pub inside: u32,
  /// Когда правка пришла: считать — после паузы PREVIEW_SETTLE, пока тянут ползунок — нет.
  pub changed: f64,
  /// Ряды досчитаны, а в текстуру ещё не залиты.
  pub dirty: bool,
}

/// Сторона схемы в пикселях, мс счёта за кадр, пауза после правки в секундах, цвет вне карты.
pub const PREVIEW_SIZE: usize = 256;
const PREVIEW_BUDGET: f64 = 0.008;
const PREVIEW_SETTLE: f64 = 0.12;
const PREVIEW_OUTSIDE: [u8; 4] = [8, 17, 28, 255];

impl Preview {
  pub fn new() -> Self {
    Self { key: String::new(), config: None, palette: Vec::new(), side: 0.0, row: PREVIEW_SIZE, pixels: PREVIEW_OUTSIDE.repeat(PREVIEW_SIZE * PREVIEW_SIZE), counts: [0; 4], inside: 0, changed: 0.0, dirty: true }
  }

  /// Порция счёта: ряды сверху вниз, пока не вышел бюджет кадра.
  fn step(&mut self, now: f64) {
    let Some(config) = &self.config else { return };
    if self.row >= PREVIEW_SIZE || now - self.changed < PREVIEW_SETTLE {
      return;
    }
    let started = std::time::Instant::now();
    let scale = self.side / PREVIEW_SIZE as f64;
    while self.row < PREVIEW_SIZE && started.elapsed().as_secs_f64() < PREVIEW_BUDGET {
      let y = (self.row as f64 + 0.5 - PREVIEW_SIZE as f64 / 2.0) * scale;
      for column in 0..PREVIEW_SIZE {
        let x = (column as f64 + 0.5 - PREVIEW_SIZE as f64 / 2.0) * scale;
        let (terrain, biome) = kharos_engine::terrain::sample_terrain(config, x, y);
        self.counts[terrain as usize & 3] += 1;
        self.inside += 1;
        let color = self.palette.get(biome as usize).and_then(|row| row.get(terrain as usize)).cloned().unwrap_or(vec![128, 128, 128]);
        let at = (self.row * PREVIEW_SIZE + column) * 4;
        self.pixels[at..at + 4].copy_from_slice(&[color[0], color[1], color[2], 255]);
      }
      self.row += 1;
    }
    self.dirty = true;
  }
}

/// Состояние клиента, общее у Rust и `c`.
pub struct ClientState {
  pub world: Rc<RefCell<State>>,
  /// Место и направление сущностей тиком раньше — для сглаживания; alpha — доля тика с последнего.
  pub prev: HashMap<Entity, [f64; 3]>,
  pub alpha: f64,
  pub view: View,
  pub input: Input,
  pub time: f64,
  pub dt: f64,
  pub player: u32,
  pub outbox: Vec<(String, Json)>,
  pub sounds: Vec<SoundOrder>,
  pub particles: Vec<Particle>,
  pub decals: std::collections::VecDeque<Decal>,
  /// Слой поверх мира — в тайлах.
  pub draw: crate::ui::Batch,
  pub gui: crate::gui::Gui,
  pub looks: HashMap<u32, LookInfo>,
  /// Синтезатор, если звуку есть куда выйти.
  pub audio: Option<Rc<crate::audio::Audio>>,
  /// Местность — для вопросов скриптов.
  pub land: Option<RefCell<kharos_engine::terrain::Land>>,
  /// Таблицы видов клиентской машины по номерам.
  pub protos: Vec<Table>,
  pub preview: Preview,
}

/// Издалека слышно тише: при таком масштабе громкость полная, при вдвое меньшем — вдвое тише (hearing.ts).
const NEAR_ZOOM: f32 = 32.0;
/// На сколько звук случайно выше или ниже: одинаковые выстрелы подряд не звучат как запись (DETUNE в audio.ts).
const DETUNE: f64 = 0.08;

impl ClientState {
  /// Насколько слышно то, что в (x, y): 1 — на экране вблизи, 0 — далеко за краем; за краем звук стихает на reach
  /// полуширин экрана (nearness в hearing.ts).
  pub fn nearness(&self, x: f32, y: f32, reach: f32) -> f32 {
    let view = &self.view;
    let half = [view.screen[0] / 2.0 / view.zoom, view.screen[1] / 2.0 / view.zoom];
    let outside = 0f32.max((x - view.x).abs() - half[0]).max((y - view.y).abs() - half[1]);
    (1.0 - outside / (half[0] * reach)).max(0.0) * (view.zoom / NEAR_ZOOM).min(1.0)
  }

  /// В какой стороне x: −1 — у левого края экрана, 1 — у правого (sideOf).
  pub fn side(&self, x: f32) -> f32 {
    (x - self.view.x) / (self.view.screen[0] / 2.0 / self.view.zoom)
  }

  fn component(&self, name: &str) -> mlua::Result<usize> {
    self.world.borrow().world.schema.id(name).ok_or_else(|| mlua::Error::runtime(format!("нет компонента {name}")))
  }

  /// Место и направление сущности сейчас — между прошлым и этим тиком.
  pub fn pose(&self, entity: Entity) -> Option<[f64; 3]> {
    let state = self.world.borrow();
    let world = &state.world;
    let position = world.schema.id("Position")?;
    let facing = world.schema.id("Facing")?;
    let row = world.stores[position].row(entity)?;
    let x = world.stores[position].nums[0][row];
    let y = world.stores[position].nums[1][row];
    let angle = world.stores[facing].row(entity).map_or(0.0, |row| world.stores[facing].nums[0][row]);
    let Some(&[px, py, pa]) = self.prev.get(&entity) else { return Some([x, y, angle]) };
    let t = self.alpha;
    let turn = (angle - pa + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
    Some([px + (x - px) * t, py + (y - py) * t, pa + turn * t])
  }

  /// Запоминает места перед тиком.
  pub fn remember(&mut self) {
    let state = self.world.borrow();
    let world = &state.world;
    let (Some(position), Some(facing)) = (world.schema.id("Position"), world.schema.id("Facing")) else { return };
    self.prev.clear();
    let store = &world.stores[position];
    for (row, &entity) in store.entities.iter().enumerate() {
      let angle = world.stores[facing].row(entity).map_or(0.0, |row| world.stores[facing].nums[0][row]);
      self.prev.insert(entity, [store.nums[0][row], store.nums[1][row], angle]);
    }
  }

  /// Сущность под точкой мира: юниты по радиусу, здания по прямоугольнику; ближайшая к точке.
  pub fn pick(&self, x: f64, y: f64) -> Option<Entity> {
    let state = self.world.borrow();
    let world = &state.world;
    let position = world.schema.id("Position")?;
    let unit = world.schema.id("Unit");
    let building = world.schema.id("Building");
    let mut best: Option<(f64, Entity)> = None;
    let owner = world.schema.id("Owner");
    for &entity in &world.stores[position].entities {
      let Some([ex, ey, _]) = self.pose(entity) else { continue };
      let foreign = owner.and_then(|id| world.num(entity, id, "player")).is_some_and(|player| player as u32 != self.player);
      if foreign && state.vision.as_ref().is_some_and(|vision| !vision.sees(self.player, ex, ey)) {
        continue;
      }
      let (dx, dy) = (x - ex, y - ey);
      let hit = if let Some(radius) = unit.and_then(|id| world.num(entity, id, "radius")) {
        dx * dx + dy * dy <= (radius + 0.15).powi(2)
      } else if let Some(id) = building.filter(|&id| world.has(entity, id)) {
        let (w, h) = (world.num(entity, id, "width").unwrap_or(1.0), world.num(entity, id, "height").unwrap_or(1.0));
        dx.abs() <= w / 2.0 && dy.abs() <= h / 2.0
      } else {
        false
      };
      if hit {
        let distance = dx * dx + dy * dy;
        if best.is_none_or(|(d, _)| distance < d) {
          best = Some((distance, entity));
        }
      }
    }
    best.map(|(_, entity)| entity)
  }
}

/// Цвет из Luau: 0xRRGGBB — непрозрачный, 0xAARRGGBB — с альфой в старшем байте; alpha — множитель.
pub fn color(value: u32, alpha: Option<f32>) -> [u8; 4] {
  let a = if value > 0xffffff { (value >> 24) as f32 / 255.0 } else { 1.0 } * alpha.unwrap_or(1.0);
  [(value >> 16) as u8, (value >> 8) as u8, value as u8, (a.clamp(0.0, 1.0) * 255.0).round() as u8]
}

/// `c` в скриптах клиента.
#[derive(Clone)]
pub struct Ctx {
  pub state: Rc<RefCell<ClientState>>,
  pub input: Table,
  pub camera: Table,
  pub shared: Table,
  pub atmosphere: Table,
  pub music: Table,
  pub protos: Table,
  pub game: Table,
  pub app: AppLink,
}

/// Просьба скриптов к приложению — исполняется после кадра.
#[derive(Clone, Debug)]
pub enum AppRequest {
  /// Начать партию games/<game> с настройками (ложатся в её data).
  Start { game: String, options: Json },
  /// Закрыть игру.
  Quit,
}

/// Что приложение знает и о чём его просят — общее у всех партий запуска.
#[derive(Default)]
pub struct AppState {
  pub request: Option<AppRequest>,
  /// Партия меню (`menu` в mod.luau): в неё ведёт c.app:menu().
  pub menu: Option<String>,
  /// Идущая партия и её настройки.
  pub game: String,
  pub options: Json,
}

pub type AppLink = Rc<RefCell<AppState>>;

/// `c.app` — приложение: начать партию, выйти в меню, закрыть игру.
pub struct AppApi(AppLink);

impl UserData for AppApi {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("game", |_, app| Ok(app.0.borrow().game.clone()));
    fields.add_field_method_get("menu", |_, app| Ok(app.0.borrow().menu.clone()));
    fields.add_field_method_get("options", |lua, app| kharos_content::vm::to_lua(lua, &app.0.borrow().options));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // c.app:start("skirmish", { seed, size, generator, weather, name }) — новая партия после этого кадра.
    methods.add_method("start", |lua, app, (game, options): (String, Option<Value>)| {
      let options: Json = lua.from_value(options.unwrap_or(Value::Nil))?;
      app.0.borrow_mut().request = Some(AppRequest::Start { game, options: if options.is_null() { Json::Object(Default::default()) } else { options } });
      Ok(())
    });
    // В главное меню — партию меню.
    methods.add_method("to_menu", |_, app, ()| {
      let mut state = app.0.borrow_mut();
      if let Some(menu) = state.menu.clone() {
        state.request = Some(AppRequest::Start { game: menu, options: Json::Object(Default::default()) });
      }
      Ok(())
    });
    // Открыть адрес в системном браузере.
    methods.add_method("open", |_, _, url: String| {
      if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(mlua::Error::runtime(format!("{url}: открываются только адреса http и https")));
      }
      #[cfg(target_os = "macos")]
      let command = std::process::Command::new("open").arg(&url).spawn();
      #[cfg(target_os = "windows")]
      let command = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
      #[cfg(all(unix, not(target_os = "macos")))]
      let command = std::process::Command::new("xdg-open").arg(&url).spawn();
      if let Err(error) = command {
        eprintln!("{url}: {error}");
      }
      Ok(())
    });
    methods.add_method("quit", |_, app, ()| {
      app.0.borrow_mut().request = Some(AppRequest::Quit);
      Ok(())
    });
  }
}

fn entity(value: f64) -> mlua::Result<Entity> {
  if value >= 1.0 && value.fract() == 0.0 {
    Ok(value as Entity)
  } else {
    Err(mlua::Error::runtime(format!("{value} — не номер сущности")))
  }
}

impl UserData for Ctx {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("input", |_, c| Ok(c.input.clone()));
    fields.add_field_method_get("camera", |_, c| Ok(c.camera.clone()));
    fields.add_field_method_get("shared", |_, c| Ok(c.shared.clone()));
    fields.add_field_method_get("atmosphere", |_, c| Ok(c.atmosphere.clone()));
    fields.add_field_method_get("music", |_, c| Ok(c.music.clone()));
    fields.add_field_method_get("protos", |_, c| Ok(c.protos.clone()));
    fields.add_field_method_get("game", |_, c| Ok(c.game.clone()));
    fields.add_field_method_get("time", |_, c| Ok(c.state.borrow().time));
    fields.add_field_method_get("dt", |_, c| Ok(c.state.borrow().dt));
    fields.add_field_method_get("player", |_, c| Ok(c.state.borrow().player));
    fields.add_field_method_get("tick", |_, c| Ok(c.state.borrow().world.borrow().tick));
    // Секунды игры, сглаженные между тиками: по ним идут сутки и погода — у всех игроков одинаково.
    fields.add_field_method_get("clock", |_, c| {
      let state = c.state.borrow();
      let tick = state.world.borrow().tick as f64;
      Ok((tick + state.alpha) * crate::game::STEP)
    });
    fields.add_field_method_get("draw", |_, c| Ok(Draw(c.state.clone())));
    fields.add_field_method_get("app", |_, c| Ok(AppApi(c.app.clone())));
    fields.add_field_method_get("ui", |_, c| Ok(UiApi(c.state.clone())));
    fields.add_field_method_get("audio", |_, c| Ok(c.state.borrow().audio.clone().map(AudioApi)));
    fields.add_field_method_get("screen", |lua, c| {
      let state = c.state.borrow();
      let table = lua.create_table()?;
      table.set("w", state.view.screen[0])?;
      table.set("h", state.view.screen[1])?;
      Ok(table)
    });
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("send", |lua, c, (name, args): (String, Option<Value>)| {
      let args: Json = lua.from_value(args.unwrap_or(Value::Nil))?;
      c.state.borrow_mut().outbox.push((name, args));
      Ok(())
    });
    // Разовая запись банка: c:sound("click", { volume = 0.35 }) — без места, c:sound("rollout", { x, y, volume,
    // reach }) — в мире: тише вдали и в своей стороне, как play в soundscape.ts. Высота чуть случайна.
    methods.add_method("sound", |_, c, (name, options): (String, Option<Table>)| {
      let get = |key: &str| options.as_ref().and_then(|table| table.get::<Option<f64>>(key).ok().flatten());
      let mut state = c.state.borrow_mut();
      let volume = get("volume").unwrap_or(1.0) as f32;
      let (gain, pan) = match (get("x"), get("y")) {
        (Some(x), Some(y)) => (volume * state.nearness(x as f32, y as f32, get("reach").unwrap_or(0.6) as f32), state.side(x as f32) * 0.8),
        _ => (volume, get("pan").unwrap_or(0.0) as f32),
      };
      let detune = get("detune").unwrap_or(DETUNE);
      let rate = match &state.audio {
        Some(audio) => 1.0 + (audio.random() * 2.0 - 1.0) * detune,
        None => 1.0,
      } as f32;
      state.sounds.push(SoundOrder { voice: name, gain, pan, rate });
      Ok(())
    });
    // Местность в тайле: вид (0 — болото, 1 — песок, 2 — скала, 3 — гора) и биом (0 — эрг, 1 — солончаки,
    // 2 — красные пустоши, 3 — топи); nil — местности нет.
    methods.add_method("terrain", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let Some(land) = &state.land else { return Ok((None, None)) };
      let tile = land.borrow_mut().tile(x.floor() as i32, y.floor() as i32);
      Ok((Some(tile[0] & 3), Some(tile[1] >> 6)))
    });
    // Слышимость точки мира (0..1) и её сторона (−1..1): для своих голосов — моторов, гулов.
    methods.add_method("nearness", |_, c, (x, y, reach): (f32, f32, Option<f32>)| Ok(c.state.borrow().nearness(x, y, reach.unwrap_or(0.6))));
    methods.add_method("side", |_, c, x: f32| Ok(c.state.borrow().side(x)));
    // c:particle({ x, y, vx, vy, life, color, size, drift }).
    methods.add_method("particle", |_, c, spec: Table| {
      let get = |key: &str, default: f32| spec.get::<Option<f32>>(key).map(|value| value.unwrap_or(default));
      let particle = Particle { x: get("x", 0.0)?, y: get("y", 0.0)?, vx: get("vx", 0.0)?, vy: get("vy", 0.0)?, age: 0.0, life: get("life", 1.0)?, color: spec.get::<Option<u32>>("color")?.unwrap_or(0xffffff), size: get("size", 1.0)?, drift: spec.get::<Option<bool>>("drift")?.unwrap_or(true) };
      let mut state = c.state.borrow_mut();
      if state.particles.len() < 20_000 {
        state.particles.push(particle);
      }
      Ok(())
    });
    // След на земле: c:decal({ from = { x, y }, to = { x, y }, width, color, opacity, density, life }) — отрезок и
    // ширина в тайлах, цвет — 0xrrggbb или { r, g, b } от 0 до 1. Лежит под юнитами и темнеет ночью с землёй; с
    // четверти срока растворяется пиксель за пикселем; вне обзора своего игрока забывается.
    methods.add_method("decal", |_, c, spec: Table| {
      let point = |key: &str| -> mlua::Result<[f32; 2]> {
        let table: Table = spec.get(key)?;
        Ok([table.get(1)?, table.get(2)?])
      };
      let get = |key: &str, default: f32| spec.get::<Option<f32>>(key).map(|value| value.unwrap_or(default));
      let color = match spec.get::<Value>("color")? {
        Value::Table(rgb) => [rgb.get(1)?, rgb.get(2)?, rgb.get(3)?],
        Value::Nil => [1.0; 3],
        value => {
          let value = u32::try_from(value.as_i64().unwrap_or(0xffffff)).unwrap_or(0xffffff);
          [(value >> 16 & 0xff) as f32 / 255.0, (value >> 8 & 0xff) as f32 / 255.0, (value & 0xff) as f32 / 255.0]
        }
      };
      let ([x1, y1], [x2, y2]) = (point("from")?, point("to")?);
      let opacity = get("opacity", 1.0)?;
      let life = get("life", 60.0)?;
      if opacity <= 0.0 || life <= 0.0 {
        return Ok(());
      }
      let mut state = c.state.borrow_mut();
      let seed = kharos_engine::terrain::hash(x1 as f64 * 16.0, y1 as f64 * 16.0, state.time + state.decals.len() as f64) as f32 * 1000.0;
      if state.decals.len() >= DECAL_LIMIT {
        state.decals.pop_front();
      }
      state.decals.push_back(Decal { line: [x1, y1, x2, y2], width: get("width", 1.0 / 16.0)?, color, opacity, density: get("density", 1.0)?, seed, age: 0.0, life });
      Ok(())
    });
    // Сущности со всеми компонентами списка — номерами.
    methods.add_method("each", |_, c, components: Vec<String>| {
      let state = c.state.borrow();
      let ids = components.iter().map(|name| state.component(name)).collect::<mlua::Result<Vec<_>>>()?;
      let world = state.world.borrow();
      Ok(world.world.query(&ids))
    });
    // Значение компонента; Position и Facing — сглаженные между тиками.
    methods.add_method("get", |lua, c, (e, component): (f64, String)| {
      let e = entity(e)?;
      let state = c.state.borrow();
      let id = state.component(&component)?;
      let value = state.world.borrow().world.get(e, id);
      let Some(mut map) = value else { return Ok(Value::Nil) };
      if component == "Position" || component == "Facing" {
        if let Some([x, y, angle]) = state.pose(e) {
          if component == "Position" {
            map.insert("x".into(), Json::from(x));
            map.insert("y".into(), Json::from(y));
          } else {
            map.insert("angle".into(), Json::from(angle));
          }
        }
      }
      kharos_content::vm::to_lua(lua, &Json::Object(map))
    });
    methods.add_method("has", |_, c, (e, component): (f64, String)| {
      let state = c.state.borrow();
      let id = state.component(&component)?;
      let has = state.world.borrow().world.has(entity(e)?, id);
      Ok(has)
    });
    methods.add_method("alive", |_, c, e: f64| Ok(entity(e).is_ok_and(|e| c.state.borrow().world.borrow().world.alive(e))));
    // Вид сущности — таблица вида клиентской машины.
    methods.add_method("proto", |_, c, e: f64| {
      let state = c.state.borrow();
      let id = state.component("Proto")?;
      let proto = state.world.borrow().world.num(entity(e)?, id, "id");
      Ok(proto.and_then(|proto| state.protos.get(proto as usize).cloned()))
    });
    methods.add_method("mine", |_, c, e: f64| {
      let state = c.state.borrow();
      let id = state.component("Owner")?;
      let owner = state.world.borrow().world.num(entity(e)?, id, "player");
      Ok(owner == Some(state.player as f64))
    });
    methods.add_method("pick", |_, c, (x, y): (f64, f64)| Ok(c.state.borrow().pick(x, y)));
    // Видит ли свой игрок тайл сейчас и бывал ли он в виду (туман войны).
    methods.add_method("sees", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      Ok(world.vision.as_ref().is_none_or(|vision| vision.sees(state.player, x, y)))
    });
    methods.add_method("explored", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      Ok(world.vision.as_ref().is_none_or(|vision| vision.explored(state.player, x, y)))
    });
    // Случайное число 0..1 от координат и сида — тот же hash, что у генератора местности и погоды в TS.
    methods.add_function("hash", |_, (x, y, seed): (f64, f64, f64)| Ok(kharos_engine::terrain::hash(x, y, seed)));
    // Сущности с Position в прямоугольнике мира и со всеми компонентами списка.
    methods.add_method("within", |_, c, (x1, y1, x2, y2, components): (f64, f64, f64, f64, Option<Vec<String>>)| {
      let state = c.state.borrow();
      let mut ids = components.unwrap_or_default().iter().map(|name| state.component(name)).collect::<mlua::Result<Vec<_>>>()?;
      ids.push(state.component("Position")?);
      let (left, right, top, bottom) = (x1.min(x2), x1.max(x2), y1.min(y2), y1.max(y2));
      let list = state.world.borrow().world.query(&ids);
      Ok(list.into_iter().filter(|&e| state.pose(e).is_some_and(|[x, y, _]| x >= left && x <= right && y >= top && y <= bottom)).collect::<Vec<_>>())
    });
    methods.add_method("to_screen", |_, c, (x, y): (f32, f32)| {
      let [sx, sy] = c.state.borrow().view.to_screen(x, y);
      Ok((sx, sy))
    });
    methods.add_method("to_world", |_, c, (x, y): (f32, f32)| {
      let [wx, wy] = c.state.borrow().view.to_world(x, y);
      Ok((wx, wy))
    });
  }
}

/// `c.draw` — поверх мира, в тайлах; толщины — в пикселях экрана.
pub struct Draw(Rc<RefCell<ClientState>>);

impl UserData for Draw {
  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("line", |_, draw, (x1, y1, x2, y2, value, width, alpha): (f32, f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      let mut state = draw.0.borrow_mut();
      let zoom = state.view.zoom;
      state.draw.line([x1, y1], [x2, y2], width.unwrap_or(1.0) / zoom, color(value, alpha));
      Ok(())
    });
    // Круг: width — толщина кольца в пикселях, без неё — заливка.
    methods.add_method("circle", |_, draw, (x, y, radius, value, width, alpha): (f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      let mut state = draw.0.borrow_mut();
      let zoom = state.view.zoom;
      let segments = ((radius * zoom).sqrt() * 4.0).clamp(12.0, 64.0) as usize;
      state.draw.circle([x, y], radius, width.map(|width| width / zoom), color(value, alpha), segments);
      Ok(())
    });
    methods.add_method("rect", |_, draw, (x1, y1, x2, y2, value, width, alpha): (f32, f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      let mut state = draw.0.borrow_mut();
      let zoom = state.view.zoom;
      let rgba = color(value, alpha);
      let (left, right, top, bottom) = (x1.min(x2), x1.max(x2), y1.min(y2), y1.max(y2));
      match width {
        None => state.draw.rect([left, top], [right, bottom], rgba),
        Some(width) => {
          let w = width / zoom;
          for (a, b) in [([left, top], [right, top]), ([right, top], [right, bottom]), ([right, bottom], [left, bottom]), ([left, bottom], [left, top])] {
            state.draw.line(a, b, w, rgba);
          }
        }
      }
      Ok(())
    });
  }
}

/// `c.audio` — синтезатор (как Audio в audio.ts): разовые записи, петли, свои голоса.
pub struct AudioApi(Rc<crate::audio::Audio>);

impl UserData for AudioApi {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("now", |_, audio| Ok(audio.0.now()));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // Запись банка сразу: громкость, сторона −1..1, скорость (1 — как есть).
    methods.add_method("play", |_, audio, (name, volume, pan, rate): (String, f32, Option<f32>, Option<f32>)| {
      audio.0.play(&name, volume, pan.unwrap_or(0.0), rate.unwrap_or(1.0));
      Ok(())
    });
    // Фоновая петля банка: громкость (0 — молчит) и сторона; меняется плавно, сколько ни зови.
    methods.add_method("loop", |_, audio, (name, volume, pan): (String, f32, Option<f32>)| {
      audio.0.loop_level(&name, volume, pan.unwrap_or(0.0));
      Ok(())
    });
    // Свой голос — вид из sounds/ со схемой или таблица { graph, update }: { bus, into (узел другого голоса), at,
    // length, note, velocity, args }.
    methods.add_method("voice", |lua, audio, (voice, options): (Value, Option<Table>)| {
      let get = |key: &str| options.as_ref().map_or(Ok(None), |table| table.get::<Option<f64>>(key));
      let bus = options.as_ref().map_or(Ok(None), |table| table.get::<Option<String>>("bus"))?.unwrap_or_else(|| "world".into());
      let into = crate::audio::NodeTarget::from_value(&options.as_ref().map_or(Ok(Value::Nil), |table| table.get::<Value>("into"))?)?;
      let args = options.as_ref().map_or(Ok(Value::Nil), |table| table.get::<Value>("args"))?;
      audio.0.start(lua, &voice, &bus, into.as_ref(), get("at")?, get("length")?, get("note")?.unwrap_or(440.0), get("velocity")?.unwrap_or(1.0), args)
    });
    methods.add_method("volume", |_, audio, (bus, volume): (String, f32)| {
      audio.0.set_volume(&bus, volume);
      Ok(())
    });
    methods.add_method("random", |_, audio, ()| Ok(audio.0.random()));
  }
}

/// `c.ui` — интерфейс, как `Ui` в gui/ui.ts: узлы описываются каждый кадр, раскладывает и рисует движок.
pub struct UiApi(Rc<RefCell<ClientState>>);

fn click_table(lua: &Lua, click: crate::gui::Click) -> mlua::Result<Table> {
  let table = lua.create_table()?;
  table.set("button", click.button)?;
  table.set("shift", click.shift)?;
  table.set("ctrl", click.ctrl)?;
  table.set("alt", click.alt)?;
  table.set("long", click.long)?;
  Ok(table)
}

impl UiApi {
  /// Узел с детьми: открыть, выполнить children (без займа состояния — скрипт сам зовёт ui), закрыть.
  fn node(&self, style: crate::gui::Style, children: Option<mlua::Function>) -> mlua::Result<()> {
    self.0.borrow_mut().gui.open(style, None);
    let result = children.map_or(Ok(()), |children| children.call::<()>(()));
    self.0.borrow_mut().gui.close();
    result
  }
}

impl UserData for UiApi {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("width", |_, ui| Ok(ui.0.borrow().gui.width));
    fields.add_field_method_get("height", |_, ui| Ok(ui.0.borrow().gui.height));
    fields.add_field_method_get("now", |_, ui| Ok(ui.0.borrow().gui.now()));
    // Нажатие кнопки за кадр: "click" или "deny" (недоступна), иначе nil; навели ли на доступную — для звука.
    fields.add_field_method_get("pressed", |_, ui| Ok(ui.0.borrow().gui.pressed_button.map(|disabled| if disabled { "deny" } else { "click" })));
    fields.add_field_method_get("hovered_button", |_, ui| Ok(ui.0.borrow().gui.hovered_button));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // Узел с детьми; на верхнем уровне — корневая панель (anchor — где она на экране).
    methods.add_method("box", |_, ui, (style, children): (Option<Table>, Option<mlua::Function>)| ui.node(crate::gui::style(style.as_ref())?, children));
    // Строка текста: font ("body", "small", "title"), color, shadow, lift, wrap, ellipsis.
    methods.add_method("text", |_, ui, (text, style): (String, Option<Table>)| {
      let leaf = crate::gui::text_leaf(text, style.as_ref())?;
      ui.0.borrow_mut().gui.leaf(Default::default(), leaf);
      Ok(())
    });
    // Картинка: портрет вида, вписанный в width × height, как toCanvas в portraits.ts (вдвое и больше — целым
    // увеличением), стороной team (0 — своя); "coin" — монета кредитов; "minimap" — местность всей карты.
    methods.add_method("image", |_, ui, (kind, width, height, team): (Value, f32, f32, Option<usize>)| {
      let mut state = ui.0.borrow_mut();
      match kind {
        Value::Table(proto) => {
          let id: u32 = proto.get("id")?;
          let Some(info) = state.looks.get(&id) else { return Ok(()) };
          let [w, h] = info.size;
          let fit = (width / w).min(height / h);
          let scale = if fit >= 2.0 { fit.floor() } else { fit };
          let (dw, dh) = ((w * scale).round(), (h * scale).round());
          let image = if info.picture { crate::gui::Image::Picture { uv: info.uv } } else { crate::gui::Image::Sprite { uv: info.uv, team: team.unwrap_or(0) % crate::render::TEAMS } };
          let pad = [((height - dh) / 2.0).floor(), 0.0, 0.0, ((width - dw) / 2.0).floor()];
          state.gui.open(crate::gui::Style { width: Some(width), height: Some(height), padding: pad, ..Default::default() }, None);
          state.gui.leaf(Default::default(), crate::gui::Leaf::Image { image, width: dw, height: dh });
          state.gui.close();
        }
        Value::String(name) if name.to_str()?.as_ref() == "minimap" => state.gui.leaf(Default::default(), crate::gui::Leaf::Image { image: crate::gui::Image::Minimap, width, height }),
        _ => state.gui.leaf(Default::default(), crate::gui::Leaf::Image { image: crate::gui::Image::Coin, width, height }),
      }
      Ok(())
    });
    methods.add_method("space", |_, ui, (width, height, grow): (Option<f32>, Option<f32>, Option<f32>)| {
      let style = crate::gui::Style { width: Some(width.unwrap_or(0.0)), height: Some(height.unwrap_or(0.0)), grow: grow.unwrap_or(0.0), ..Default::default() };
      ui.0.borrow_mut().gui.leaf(style, crate::gui::Leaf::Space);
      Ok(())
    });
    // Кнопка: рамка по наведению и нажатию; active — нажатое состояние, disabled — не нажимается. Возвращает щелчок
    // (таблица { button, shift, ctrl, alt, long }) в кадре после него или nil.
    methods.add_method("button", |lua, ui, (id, style, children): (String, Option<Table>, Option<mlua::Function>)| {
      let get = |key: &str| style.as_ref().map_or(Ok(false), |table| table.get::<Option<bool>>(key).map(|value| value.unwrap_or(false)));
      let (active, disabled) = (get("active")?, get("disabled")?);
      let mut parsed = crate::gui::Style { direction: crate::gui::Direction::Row, align: crate::gui::Align::Center, justify: crate::gui::Align::Center, padding: [4.0, 10.0, 4.0, 10.0], gap: 6.0, ..Default::default() };
      if let Some(table) = &style {
        let given = crate::gui::style(Some(table))?;
        let has = |key: &str| table.contains_key(key).unwrap_or(false);
        parsed = crate::gui::Style { direction: if has("direction") { given.direction } else { parsed.direction }, align: if has("align") { given.align } else { parsed.align }, justify: if has("justify") { given.justify } else { parsed.justify }, padding: if has("padding") { given.padding } else { parsed.padding }, gap: if has("gap") { given.gap } else { parsed.gap }, ..given };
      }
      let skin = ui.0.borrow_mut().gui.button_skin(&id, parsed.skin, active, disabled);
      parsed.skin = Some(skin);
      parsed.id = Some(id.clone());
      ui.node(parsed, children)?;
      let click = if disabled { None } else { ui.0.borrow().gui.frame_clicks.get(&id).copied() };
      click.map(|click| click_table(lua, click)).transpose()
    });
    methods.add_method("clicked", |lua, ui, id: String| ui.0.borrow().gui.frame_clicks.get(&id).copied().map(|click| click_table(lua, click)).transpose());
    methods.add_method("hovered", |_, ui, id: String| Ok(ui.0.borrow().gui.hovered(&id)));
    methods.add_method("within", |_, ui, id: String| Ok(ui.0.borrow().gui.within(&id)));
    // Левая кнопка зажата на узле: где указатель в нём (доли ширины и высоты), иначе nil.
    methods.add_method("held", |_, ui, id: String| Ok(ui.0.borrow().gui.held(&id).map(|(u, v)| vec![u, v])));
    // Подсказка узла id, когда на нём задержали указатель: строка — текстом с переносом, функция — строит панель
    // узлами (карточка), как ui.tip в TS. anchor — где панель на экране ({ left, right, top, bottom }); без него — у
    // указателя.
    methods.add_method("tip", |_, ui, (id, content, anchor): (String, Value, Option<Table>)| {
      if !ui.0.borrow().gui.tip_due(&id) {
        return Ok(());
      }
      match content {
        Value::Function(build) => {
          let anchor = anchor.as_ref().map(crate::gui::anchor).transpose()?;
          let saved = ui.0.borrow_mut().gui.begin_tip();
          let result = build.call::<()>(());
          ui.0.borrow_mut().gui.end_tip(saved, anchor);
          result
        }
        Value::String(text) => {
          ui.0.borrow_mut().gui.tip(&id, text.to_str()?.to_string());
          Ok(())
        }
        _ => Ok(()),
      }
    });
    methods.add_method("rect", |lua, ui, id: String| {
      let Some(rect) = ui.0.borrow().gui.rect(&id) else { return Ok(None) };
      let table = lua.create_table()?;
      table.set("x", rect.x)?;
      table.set("y", rect.y)?;
      table.set("width", rect.w)?;
      table.set("height", rect.h)?;
      Ok(Some(table))
    });
    // Поле ввода: ui:input(id, значение, { width, placeholder, maxLength, digits, password, focus, color, background,
    // outline }) → { value, focused, keys } — набранное, в фокусе ли, клавиши, отданные панели ("Enter", "Escape",
    // "Tab", "ArrowUp", "ArrowDown", "Blur").
    methods.add_method("input", |lua, ui, (id, value, options): (String, String, Option<Table>)| {
      let mut parsed = crate::gui::FieldOptions::default();
      if let Some(table) = &options {
        parsed.width = table.get("width")?;
        parsed.placeholder = table.get("placeholder")?;
        parsed.max_length = table.get("maxLength")?;
        parsed.digits = table.get::<Option<bool>>("digits")?.unwrap_or(false);
        parsed.password = table.get::<Option<bool>>("password")?.unwrap_or(false);
        parsed.focus = table.get::<Option<bool>>("focus")?.unwrap_or(false);
        parsed.color = crate::gui::color(&table.get("color")?);
        parsed.background = crate::gui::color(&table.get("background")?);
        parsed.outline = crate::gui::color(&table.get("outline")?);
      }
      let field = ui.0.borrow_mut().gui.input(&id, &value, &parsed);
      let result = lua.create_table()?;
      result.set("value", field.value)?;
      result.set("focused", field.focused)?;
      result.set("keys", field.keys)?;
      Ok(result)
    });
    // Схема карты новой игры, как preview.ts: ui:preview(местность из lands/, правки генератора, сид, сторона карты в
    // тайлах, ширина, высота) — считается порциями по кадрам после паузы в правках; → { ready, rock, swamp }.
    methods.add_method("preview", |lua, ui, (land, changes, seed, side, width, height): (Table, Option<Table>, f64, f64, f32, f32)| {
      let mut generator: Json = lua.from_value(land.get::<Value>("data")?)?;
      if let (Json::Object(fields), Some(changes)) = (&mut generator, changes) {
        if let Json::Object(changes) = lua.from_value::<Json>(Value::Table(changes))? {
          fields.extend(changes);
        }
      }
      if let Json::Object(fields) = &mut generator {
        fields.insert("seed".into(), Json::from(seed));
      }
      let key = format!("{generator}|{side}");
      let mut state = ui.0.borrow_mut();
      let now = state.time;
      let preview = &mut state.preview;
      if preview.key != key {
        preview.key = key;
        preview.config = Some(serde_json::from_value(generator).map_err(mlua::Error::external)?);
        preview.palette = land.get::<Option<Vec<Vec<Vec<u8>>>>>("minimap")?.unwrap_or_default();
        preview.side = side;
        preview.row = 0;
        preview.counts = [0; 4];
        preview.inside = 0;
        preview.changed = now;
      }
      preview.step(now);
      let ready = preview.row >= PREVIEW_SIZE;
      let total = preview.inside.max(1) as f64;
      let (rock, swamp) = (preview.counts[2] as f64 / total, preview.counts[0] as f64 / total);
      state.gui.leaf(crate::gui::Style { alpha: if ready { None } else { Some(0.6) }, ..Default::default() }, crate::gui::Leaf::Image { image: crate::gui::Image::Preview, width, height });
      let result = lua.create_table()?;
      result.set("ready", ready)?;
      result.set("rock", rock)?;
      result.set("swamp", swamp)?;
      Ok(result)
    });
    // Прописными — с кириллицей (string.upper у Luau знает только латиницу).
    methods.add_function("upper", |_, (_, text): (Value, String)| Ok(text.to_uppercase()));
    // Ширина строки шрифтом font.
    methods.add_method("measure", |_, ui, (text, font): (String, Option<String>)| Ok(ui.0.borrow_mut().gui.fonts.width(crate::gui::FontName::parse(font.as_deref().unwrap_or("body")), &text)));
  }
}

/// Таблица ввода для скриптов: x, y — экран, wx, wy — мир, down/pressed/released по кнопкам, wheel, keys (зажатые),
/// hits (нажатые за кадр), text, over_ui (указатель над интерфейсом), focused, touch (указатель — касание).
pub fn fill_input(lua: &Lua, table: &Table, input: &Input, view: &View, over_ui: bool) -> mlua::Result<()> {
  let (x, y) = input.pointer.map_or((f32::NAN, f32::NAN), |[x, y]| (x, y));
  table.set("x", x)?;
  table.set("y", y)?;
  table.set("inside", input.pointer.is_some())?;
  let [wx, wy] = view.to_world(x, y);
  table.set("wx", wx)?;
  table.set("wy", wy)?;
  for (name, values) in [("down", input.down), ("pressed", input.pressed), ("released", input.released)] {
    let buttons = lua.create_table()?;
    for (index, button) in BUTTONS.iter().enumerate() {
      buttons.set(*button, values[index])?;
    }
    table.set(name, buttons)?;
  }
  table.set("wheel", input.wheel)?;
  let keys = lua.create_table()?;
  for key in &input.keys {
    keys.set(key.as_str(), true)?;
  }
  table.set("keys", keys)?;
  let hits = lua.create_table()?;
  for key in &input.hits {
    hits.set(key.as_str(), true)?;
  }
  table.set("hits", hits)?;
  table.set("text", input.text.as_str())?;
  table.set("over_ui", over_ui)?;
  table.set("focused", input.focused)?;
  table.set("touch", input.touch)?;
  Ok(())
}

/// Значок облика для `c.ui:image` (после упаковки атласа): портрет, если он есть, иначе кадр значка.
pub fn look_info(look: &Look) -> LookInfo {
  match look.portrait_uv {
    Some(uv) => LookInfo { uv, size: look.portrait_size, picture: look.picture },
    None => LookInfo { uv: look.cells[look.cell(look.icon as f64 / look.directions.max(1) as f64 * crate::atlas::TURN, 0)], size: [look.size[0] as f32, look.size[1] as f32], picture: look.picture },
  }
}
