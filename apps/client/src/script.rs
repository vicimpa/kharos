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
use mlua::{Lua, Table, UserData, UserDataFields, UserDataMethods, Value};
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

/// След на земле (decalsPass.ts): отрезок в тайлах, ширина в тайлах, кадр атласа (u, v, ширина, высота; ширина 0 —
/// белый пиксель), цвет 0..1, непрозрачность, доля закрашенных пикселей, зерно растворения, возраст и срок в секундах.
#[derive(Clone, Copy, Debug)]
pub struct Decal {
  pub line: [f32; 4],
  pub width: f32,
  pub frame: [f32; 4],
  pub color: [f32; 3],
  pub opacity: f32,
  pub density: f32,
  pub seed: f32,
  pub age: f32,
  pub life: f32,
}

/// Слои следов снизу вверх — колеи, отметины (гарь, щербинки), остовы — и сколько в каждом бывает разом: самые старые
/// уступают место новым (TRACE_LIMIT, MARK_LIMIT, WRECK_LIMIT).
pub const DECAL_LIMITS: [usize; 3] = [12_000, 3_000, 800];

/// Разовый звук, заказанный скриптом за кадр: запись банка, громкость, сторона, скорость.
pub struct SoundOrder {
  pub voice: String,
  pub gain: f32,
  pub pan: f32,
  pub rate: f32,
}

/// Как сущность показана этим кадром (`c:dress`).
#[derive(Clone, Copy, Debug)]
pub struct Dress {
  /// Доля облика снизу, остальное — чертёж.
  pub built: f32,
  /// Непрозрачность вместе с тенью.
  pub fade: f32,
  /// Кадры работы облика.
  pub working: bool,
  /// Выключено: первый кадр, темнее, без огней.
  pub off: bool,
  /// Вариант облика — направление кадра (соседи стены и трубы); None — по повороту сущности.
  pub variant: Option<usize>,
}

impl Default for Dress {
  fn default() -> Self {
    Self { built: 1.0, fade: 1.0, working: false, off: false, variant: None }
  }
}

/// Облик вида вне сущности на этот кадр (`c:show`): середина в тайлах, сколько показано снизу (остальное — чертёж),
/// оттенок с предумноженной альфой, чья сторона, поверх ли зданий призраком.
#[derive(Clone, Copy, Debug)]
pub struct Shown {
  pub proto: u32,
  pub x: f32,
  pub y: f32,
  pub built: f32,
  pub tint: [f32; 4],
  pub player: u32,
  pub over: bool,
  /// Кадр облика; без него — по времени, как у сущностей.
  pub phase: Option<usize>,
  /// Во сколько раз крупнее облика: размер тайла облика — scale тайлов мира.
  pub scale: f32,
  /// Слой вместо слоя облика (пыль под летающими — 4); None — слой облика.
  pub layer: Option<usize>,
  /// Отбрасывает ли тень.
  pub shadow: bool,
}

/// Значок вида для скриптов: портрет (или кадр значка) в атласе и его размер в пикселях.
pub struct LookInfo {
  pub uv: [f32; 4],
  pub size: [f32; 2],
  pub picture: bool,
  /// Кадры облика по фазам и направлениям (`Look::cell`) и сколько направлений.
  pub cells: Vec<[f32; 4]>,
  pub directions: usize,
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
    let started = crate::clock::seconds();
    let scale = self.side / PREVIEW_SIZE as f64;
    while self.row < PREVIEW_SIZE && crate::clock::seconds() - started < PREVIEW_BUDGET {
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
  pub decals: [std::collections::VecDeque<Decal>; 3],
  /// Слой поверх мира — в тайлах; glow — его светящаяся часть, складывается с картинкой.
  pub draw: crate::ui::Batch,
  pub glow: crate::ui::Batch,
  /// Огни кадра (`c:light`): x, y, радиус пятна и ореола в пикселях местности, яркость.
  pub lights: Vec<[f32; 5]>,
  pub gui: crate::gui::Gui,
  pub looks: HashMap<u32, LookInfo>,
  /// Синтезатор, если звуку есть куда выйти.
  pub audio: Option<Rc<crate::audio::Audio>>,
  /// Местность — для вопросов скриптов.
  pub land: Option<RefCell<kharos_engine::terrain::Land>>,
  /// Таблицы видов клиентской машины по номерам.
  pub protos: Vec<Table>,
  pub preview: Preview,
  /// Как сущности показаны этим кадром (`c:dress`).
  pub dressed: HashMap<Entity, Dress>,
  /// Облики видов вне сущностей этого кадра (`c:show`).
  pub shown: Vec<Shown>,
  /// Партия по сети: чат, игроки и команды сервера; None — своя игра.
  pub net: Option<NetInfo>,
}

/// Что сервер говорит помимо мира: чат, кто играет, какие команды можно.
#[derive(Default)]
pub struct NetInfo {
  /// Строки чата и когда они пришли (`c.time`).
  pub lines: Vec<(Json, f64)>,
  pub players: Json,
  pub commands: Json,
  pub admin: bool,
  /// Что игрок написал в чат: уйдёт серверу после кадра.
  pub said: Vec<String>,
}

/// Издалека слышно тише: при таком масштабе громкость полная, при вдвое меньшем — вдвое тише (hearing.ts).
const NEAR_ZOOM: f32 = 32.0;
/// На сколько звук случайно выше или ниже: одинаковые выстрелы подряд не звучат как запись (DETUNE в audio.ts).
const DETUNE: f64 = 0.08;

impl ClientState {
  /// Кладёт след в слой layer; полон — уходит самый старый.
  pub fn lay(&mut self, layer: usize, mut decal: Decal) {
    let [x1, y1, ..] = decal.line;
    let count: usize = self.decals.iter().map(|list| list.len()).sum();
    decal.seed = kharos_engine::terrain::hash(x1 as f64 * 16.0, y1 as f64 * 16.0, self.time + count as f64) as f32 * 1000.0;
    let list = &mut self.decals[layer];
    if list.len() >= DECAL_LIMITS[layer] {
      list.pop_front();
    }
    list.push_back(decal);
  }

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

  /// Сущность под точкой мира: юниты по радиусу корпуса (Mover), здания и площадки по основанию; ближайшая к точке.
  pub fn pick(&self, x: f64, y: f64) -> Option<Entity> {
    let state = self.world.borrow();
    let world = &state.world;
    let position = world.schema.id("Position")?;
    let unit = world.schema.id("Mover");
    // Основание: у здания — Footprint, у площадки, которая тайлов ещё не занимает, — размер в Building.
    let building = world.schema.id("Footprint");
    let site = world.schema.id("Building");
    let mut best: Option<(f64, Entity)> = None;
    let owner = world.schema.id("Owner");
    for &entity in &world.stores[position].entities {
      let Some([ex, ey, _]) = self.pose(entity) else { continue };
      let foreign = owner.and_then(|id| world.num(entity, id, "player")).is_some_and(|player| player as u32 != self.player);
      if foreign && !state.shows(self.player, entity) {
        continue;
      }
      let (dx, dy) = (x - ex, y - ey);
      let hit = if let Some(radius) = unit.and_then(|id| world.num(entity, id, "radius")) {
        dx * dx + dy * dy <= (radius + 0.15).powi(2)
      } else if let Some(id) = building.filter(|&id| world.has(entity, id)).or(site.filter(|&id| world.has(entity, id))) {
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
  /// Словари языков модов (`lang`).
  pub strings: Rc<crate::lang::Strings>,
}

impl Ctx {
  /// Язык, которым говорит интерфейс.
  fn language(&self) -> Option<&crate::lang::Language> {
    let app = self.app.borrow();
    self.strings.pick(app.language.as_deref(), &app.system_languages)
  }
}

/// Просьба скриптов к приложению — исполняется после кадра.
#[derive(Clone, Debug)]
pub enum AppRequest {
  /// Начать партию games/<game> с настройками (ложатся в её data); slot — слот сохранений, куда она пишется.
  Start { game: String, options: Json, slot: Option<String>, editor: bool },
  /// Записать партию в её слот сейчас (редактор: правки пишутся кнопкой, а не сами).
  Save,
  /// Новый мир идущей партии с настройками — без перезагрузки панелей (витрина меню).
  Reset { options: Json },
  /// Закрыть игру.
  Quit,
  /// Войти на сервер по адресу: ник и пароль.
  Join { url: String, name: String, password: String },
}

/// Сетевая игра для меню: куда подключаемся, где играем, что пошло не так.
#[derive(Default)]
pub struct NetState {
  /// Адрес сервера, к которому идёт подключение.
  pub connecting: Option<String>,
  /// Адрес сервера идущей партии.
  pub server: Option<String>,
  /// Почему не вышло или оборвалось: { key — ключ словаря, url, seconds, password — дело в пароле }.
  pub error: Option<Json>,
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
  /// Настройки игрока на диске — `c.app:get` и `c.app:set` (как localStorage у страницы).
  pub prefs: Prefs,
  /// Слоты сохранений и слот идущей партии.
  pub saves: Option<crate::saves::Saves>,
  pub slot: Option<String>,
  /// Идущая партия — редактор: мир стоит, сам он не пишется.
  pub editing: bool,
  /// Язык, выбранный игроком (`lang` в настройках), и языки системы — кому говорить, если не выбран.
  pub language: Option<String>,
  pub system_languages: Vec<String>,
  pub net: NetState,
}

/// Настройки игрока: объект JSON под ключом `client.json` (store.rs): на десктопе — `~/.config/kharos/client.json`
/// (Windows — `%APPDATA%\Kharos`), в браузере — `localStorage`.
#[derive(Default)]
pub struct Prefs {
  values: serde_json::Map<String, Json>,
}

impl Prefs {
  pub fn load() -> Self {
    let values = crate::store::read("client.json").and_then(|text| serde_json::from_str::<Json>(&text).ok()).and_then(|value| match value {
      Json::Object(map) => Some(map),
      _ => None,
    });
    Self { values: values.unwrap_or_default() }
  }

  pub fn get(&self, key: &str) -> Option<&Json> {
    self.values.get(key)
  }

  /// Запись — сразу на диск: настройки меняют редко, а выйти из игры могут когда угодно.
  pub fn set(&mut self, key: &str, value: Json) {
    if value.is_null() {
      self.values.remove(key);
    } else {
      self.values.insert(key.to_string(), value);
    }
    if let Err(error) = crate::store::write("client.json", &serde_json::to_string_pretty(&self.values).unwrap_or_default()) {
      eprintln!("настройки: {error}");
    }
  }
}

pub type AppLink = Rc<RefCell<AppState>>;

/// `c.app` — приложение: начать партию, выйти в меню, закрыть игру.
pub struct AppApi(AppLink);

impl UserData for AppApi {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("game", |_, app| Ok(app.0.borrow().game.clone()));
    fields.add_field_method_get("menu", |_, app| Ok(app.0.borrow().menu.clone()));
    fields.add_field_method_get("options", |lua, app| kharos_content::vm::to_lua(lua, &app.0.borrow().options));
    // Слот идущей партии и последний, в который играли (для «Продолжить»), если он ещё есть.
    fields.add_field_method_get("slot", |_, app| Ok(app.0.borrow().slot.clone()));
    // Идущая партия — редактор.
    fields.add_field_method_get("editing", |_, app| Ok(app.0.borrow().editing));
    // Язык, который выбрал игрок (nil — как у системы).
    fields.add_field_method_get("language", |_, app| Ok(app.0.borrow().language.clone()));
    // Сетевая игра: адрес, к которому подключаемся, адрес идущей партии и ошибка — { key, url, seconds, password }.
    // Версия сетевого провода (crates/net): «Об игре».
    fields.add_field_method_get("protocol", |_, _| Ok(kharos_net::protocol::VERSION));
    fields.add_field_method_get("connecting", |_, app| Ok(app.0.borrow().net.connecting.clone()));
    fields.add_field_method_get("server", |_, app| Ok(app.0.borrow().net.server.clone()));
    fields.add_field_method_get("net_error", |lua, app| match &app.0.borrow().net.error {
      Some(error) => kharos_content::vm::to_lua(lua, error),
      None => Ok(Value::Nil),
    });
    fields.add_field_method_get("last", |_, app| {
      let state = app.0.borrow();
      let last = state.prefs.get("last").and_then(Json::as_str).map(str::to_string);
      Ok(last.filter(|id| state.saves.as_ref().is_some_and(|saves| saves.get(id).is_some())))
    });
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // c.app:start("skirmish", { seed, size, generator, weather, name }) — новая партия после этого кадра.
    methods.add_method("start", |lua, app, (game, options): (String, Option<Value>)| {
      let options: Json = lua.from_value(options.unwrap_or(Value::Nil))?;
      app.0.borrow_mut().request = Some(AppRequest::Start { game, options: if options.is_null() { Json::Object(Default::default()) } else { options }, slot: None, editor: false });
      Ok(())
    });
    // c.app:reset({ seed, weather, scene… }) — новый мир этой же партии; панели, их память и звук остаются.
    methods.add_method("reset", |lua, app, options: Option<Value>| {
      let options: Json = lua.from_value(options.unwrap_or(Value::Nil))?;
      app.0.borrow_mut().request = Some(AppRequest::Reset { options: if options.is_null() { Json::Object(Default::default()) } else { options } });
      Ok(())
    });
    // В главное меню — партию меню.
    methods.add_method("to_menu", |_, app, ()| {
      let mut state = app.0.borrow_mut();
      if let Some(menu) = state.menu.clone() {
        state.request = Some(AppRequest::Start { game: menu, options: Json::Object(Default::default()), slot: None, editor: false });
      }
      Ok(())
    });
    // c.app:join(адрес, ник, пароль) — войти на сервер: подключение идёт между кадрами, партия меню живёт.
    methods.add_method("join", |_, app, (url, name, password): (String, Option<String>, Option<String>)| {
      let mut state = app.0.borrow_mut();
      state.net.error = None;
      state.request = Some(AppRequest::Join { url, name: name.unwrap_or_default(), password: password.unwrap_or_default() });
      Ok(())
    });
    // Забыть ошибку сети: меню её показало.
    methods.add_method("clear_net_error", |_, app, ()| {
      app.0.borrow_mut().net.error = None;
      Ok(())
    });
    // Настройки игрока на диске: c.app:get(ключ) → значение или nil, c.app:set(ключ, значение) — nil удаляет.
    methods.add_method("get", |lua, app, key: String| match app.0.borrow().prefs.get(&key) {
      Some(value) => kharos_content::vm::to_lua(lua, value),
      None => Ok(Value::Nil),
    });
    methods.add_method("set", |lua, app, (key, value): (String, Value)| {
      let value: Json = lua.from_value(value)?;
      app.0.borrow_mut().prefs.set(&key, value);
      Ok(())
    });
    // Сохранения: список слотов (свежие первыми) — { id, name, created, updated, tick, game, options }.
    methods.add_method("saves", |lua, app, ()| {
      let list = app.0.borrow().saves.as_ref().map(|saves| saves.list()).unwrap_or_default();
      kharos_content::vm::to_lua(lua, &Json::Array(list.into_iter().map(Json::Object).collect()))
    });
    // Новый слот: партия и её настройки — мир заведётся при первом запуске. → номер слота.
    methods.add_method("create", |lua, app, (name, game, options): (String, String, Option<Value>)| {
      let options: Json = lua.from_value(options.unwrap_or(Value::Nil))?;
      let mut state = app.0.borrow_mut();
      Ok(state.saves.as_mut().map(|saves| saves.create(&name, &game, options)))
    });
    // Играть в слот: его мир, а если он ещё пуст — новый по партии и настройкам слота.
    methods.add_method("play", |_, app, id: String| {
      let mut state = app.0.borrow_mut();
      let Some(slot) = state.saves.as_ref().and_then(|saves| saves.get(&id)).cloned() else { return Ok(false) };
      let game = slot.get("game").and_then(Json::as_str).unwrap_or_default().to_string();
      let options = slot.get("options").cloned().unwrap_or(Json::Object(Default::default()));
      state.request = Some(AppRequest::Start { game, options, slot: Some(id), editor: false });
      Ok(true)
    });
    // Править слот в редакторе (editor.ts): его мир стоит, правки — c:send("edit", …), записать — c.app:save().
    // Пустой слот — новый мир без игроков («Новая карта» → «В редактор»).
    methods.add_method("edit", |_, app, id: String| {
      let mut state = app.0.borrow_mut();
      let Some(slot) = state.saves.as_ref().and_then(|saves| saves.get(&id)).cloned() else { return Ok(false) };
      let game = slot.get("game").and_then(Json::as_str).unwrap_or_default().to_string();
      let options = slot.get("options").cloned().unwrap_or(Json::Object(Default::default()));
      state.request = Some(AppRequest::Start { game, options, slot: Some(id), editor: true });
      Ok(true)
    });
    // Записать идущую партию в её слот сейчас.
    methods.add_method("save", |_, app, ()| {
      app.0.borrow_mut().request = Some(AppRequest::Save);
      Ok(())
    });
    methods.add_method("rename", |_, app, (id, name): (String, String)| {
      if let Some(saves) = app.0.borrow_mut().saves.as_mut() {
        saves.rename(&id, &name);
      }
      Ok(())
    });
    methods.add_method("remove", |_, app, id: String| {
      if let Some(saves) = app.0.borrow_mut().saves.as_mut() {
        saves.remove(&id);
      }
      Ok(())
    });
    // Дата из миллисекунд эпохи, как у страницы: «18 окт., 06:41».
    // Местное время отметки (мс от эпохи): { day, month = 1–12, hour, minute } — подпись собирает мод.
    methods.add_function("date", |lua, (_, millis): (Value, f64)| {
      let [day, month, hour, minute] = crate::saves::date(millis);
      let parts = lua.create_table();
      parts.set("day", day)?;
      parts.set("month", month)?;
      parts.set("hour", hour)?;
      parts.set("minute", minute)?;
      Ok(parts)
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
      // В браузере — новая вкладка.
      #[cfg(target_arch = "wasm32")]
      let command = web_sys::window().ok_or("нет окна").and_then(|window| window.open_with_url_and_target(&url, "_blank").map_err(|_| "окно не открылось"));
      if let Err(error) = command {
        eprintln!("{url}: {error}");
      }
      Ok(())
    });
    // Язык интерфейса: запоминается в настройках, строки меняются со следующего кадра; nil — как у системы.
    methods.add_method("set_language", |_, app, id: Option<String>| {
      let mut state = app.0.borrow_mut();
      state.prefs.set("lang", id.clone().map_or(Json::Null, Json::String));
      state.language = id;
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
    // Шаг тика хоста в секундах: правилам, общим хосту и клиенту.
    fields.add_field_method_get("step", |_, _| Ok(crate::game::STEP));
    fields.add_field_method_get("player", |_, c| Ok(c.state.borrow().player));
    // Партия по сети: есть чат и игроки сервера.
    fields.add_field_method_get("online", |_, c| Ok(c.state.borrow().net.is_some()));
    fields.add_field_method_get("tick", |_, c| Ok(c.state.borrow().world.borrow().tick));
    // Секунды игры, сглаженные между тиками: по ним идут сутки и погода — у всех игроков одинаково.
    fields.add_field_method_get("clock", |_, c| {
      let state = c.state.borrow();
      let tick = state.world.borrow().tick as f64;
      Ok((tick + state.alpha) * crate::game::STEP)
    });
    fields.add_field_method_get("draw", |_, c| Ok(Draw(c.state.clone(), false)));
    // То же, что draw, только светится: цвета складываются с картинкой (вспышки, лучи, пламя).
    fields.add_field_method_get("glow", |_, c| Ok(Draw(c.state.clone(), true)));
    // Доля тика, прошедшая с последнего, — для сглаживания между тиками.
    fields.add_field_method_get("alpha", |_, c| Ok(c.state.borrow().alpha));
    fields.add_field_method_get("app", |_, c| Ok(AppApi(c.app.clone())));
    // Код языка интерфейса: «ru», «en».
    fields.add_field_method_get("lang", |_, c| Ok(c.language().map(|language| language.id.clone())));
    fields.add_field_method_get("ui", |_, c| Ok(UiApi(c.state.clone())));
    fields.add_field_method_get("audio", |_, c| Ok(c.state.borrow().audio.clone().map(AudioApi)));
    fields.add_field_method_get("screen", |lua, c| {
      let state = c.state.borrow();
      let table = lua.create_table();
      table.set("w", state.view.screen[0])?;
      table.set("h", state.view.screen[1])?;
      Ok(table)
    });
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // Строка словаря на языке игрока с подстановками: c:t("hud.depositTip", { name = "Металл" }). Ключа нет — сам
    // текст, тоже с подстановками; nil — nil (`c:t(kind.data.title) or kind.name`).
    methods.add_method("t", |_, c, (key, params): (Option<String>, Option<Table>)| {
      let Some(key) = key else { return Ok(None) };
      let text = c.language().map_or(key.as_str(), |language| language.text(&key));
      let Some(params) = params else { return Ok(Some(text.to_string())) };
      Ok(Some(crate::lang::substitute(text, |name| match params.raw_get::<Value>(name).ok()? {
        Value::String(text) => Some(text.to_string_lossy()),
        Value::Integer(number) => Some(number.to_string()),
        Value::Number(number) if number.fract() == 0.0 && number.abs() < 1e15 => Some((number as i64).to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
      })))
    });
    // Языки модов по месту в списке: { id = "ru", name = "Русский" }.
    methods.add_method("languages", |lua, c, ()| {
      let list = lua.create_table();
      for language in &c.strings.languages {
        let entry = lua.create_table();
        entry.set("id", language.id.as_str())?;
        entry.set("name", language.name.as_str())?;
        list.push(entry)?;
      }
      Ok(list)
    });
    // Чат партии по сети (chat.ts): c:chat() — строки { player, name, text, system, whisper, own, at }, где text —
    // строка или { key, params } словаря; c:players() — { player, name, online }; c:commands() — { commands, admin };
    // c:say(текст) — строку серверу (с «/» — команда). Своя игра — пусто, и c.online — ложь.
    methods.add_method("chat", |lua, c, ()| {
      let state = c.state.borrow();
      let player = state.player;
      let list: Vec<Json> = state.net.as_ref().map(|net| net.lines.iter().map(|(line, at)| {
        let mut line = line.clone();
        let own = line.get("player").and_then(Json::as_u64) == Some(player as u64) && line.get("system").and_then(Json::as_bool) != Some(true);
        line["own"] = Json::Bool(own);
        line["at"] = Json::from(*at);
        line
      }).collect()).unwrap_or_default();
      kharos_content::vm::to_lua(lua, &Json::Array(list))
    });
    methods.add_method("players", |lua, c, ()| kharos_content::vm::to_lua(lua, &c.state.borrow().net.as_ref().map(|net| net.players.clone()).filter(|players| !players.is_null()).unwrap_or(Json::Array(Vec::new()))));
    methods.add_method("commands", |lua, c, ()| {
      let state = c.state.borrow();
      let (commands, admin) = state.net.as_ref().map(|net| (net.commands.clone(), net.admin)).unwrap_or((Json::Null, false));
      let commands = if commands.is_null() { Json::Array(Vec::new()) } else { commands };
      kharos_content::vm::to_lua(lua, &serde_json::json!({ "commands": commands, "admin": admin }))
    });
    methods.add_method("say", |_, c, text: String| {
      if let Some(net) = c.state.borrow_mut().net.as_mut() {
        net.said.push(text);
      }
      Ok(())
    });
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
      let Some(land) = &state.land else { return Ok((None, None, None)) };
      let tile = land.borrow_mut().tile(x.floor() as i32, y.floor() as i32);
      let foot = tile[0] != kharos_engine::terrain::MOUNTAIN && tile[3] & kharos_engine::terrain::FOOT_BIT != 0;
      Ok((Some(tile[0] & 3), Some(tile[1] >> 6), Some(foot)))
    });
    // Хранимые байты тайла и вершина горы под ним — как ctx:tile и ctx:peak, по земле, какой её знает свой игрок.
    methods.add_method("tile", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let Some(land) = &state.land else { return Ok((None, None, None, None)) };
      let [a, b, d, e] = land.borrow_mut().stored(x.floor() as i32, y.floor() as i32);
      let tile = (Some(a), Some(b), Some(d), Some(e));
      Ok(tile)
    });
    methods.add_method("peak", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let Some(land) = &state.land else { return Ok((None, None, None)) };
      let peak = land.borrow_mut().peak_of(x.floor() as i32, y.floor() as i32);
      Ok(match peak {
        Some((px, py, radius)) => (Some(px), Some(py), Some(radius)),
        None => (None, None, None),
      })
    });
    // Здание на тайле (Footprint) или nil — как ctx:occupant.
    methods.add_method("occupant", |_, c, (x, y): (f64, f64)| {
      let state = c.state.borrow();
      let mut world = state.world.borrow_mut();
      Ok(world.scene().occupant(x.floor() as i32, y.floor() as i32))
    });
    // Сети — как ctx:grids, ctx:networks и ctx:network_version.
    methods.add_method("grids", |lua, c, ()| {
      let state = c.state.borrow();
      let mut world = state.world.borrow_mut();
      let kharos_world::host::State { world, networks, .. } = &mut *world;
      kharos_world::networks::to_lua(lua, networks.grids(world), false)
    });
    methods.add_method("networks", |lua, c, ()| {
      let state = c.state.borrow();
      let mut world = state.world.borrow_mut();
      let kharos_world::host::State { world, networks, .. } = &mut *world;
      kharos_world::networks::to_lua(lua, networks.networks(world), true)
    });
    methods.add_method("network_version", |_, c, ()| {
      let state = c.state.borrow();
      let mut world = state.world.borrow_mut();
      let kharos_world::host::State { world, networks, .. } = &mut *world;
      Ok(networks.version(world))
    });
    // Как сущность показана этим кадром: { built — доля снизу, остальное чертёж (стройка, сворачивание); fade —
    // непрозрачность вместе с тенью (тающий MCV); working — кадры работы облика (`working` у облика); off — стоит на
    // первом кадре, темнее и без огней (выключенное); variant — вариант облика, направление кадра (соседи стены и
    // трубы) }. Несколько вызовов за кадр складываются.
    methods.add_method("dress", |_, c, (e, options): (f64, Table)| {
      let (built, fade): (Option<f32>, Option<f32>) = (options.get("built")?, options.get("fade")?);
      let (working, off): (Option<bool>, Option<bool>) = (options.get("working")?, options.get("off")?);
      let variant: Option<usize> = options.get("variant")?;
      let mut state = c.state.borrow_mut();
      let dress = state.dressed.entry(entity(e)?).or_default();
      if let Some(built) = built {
        dress.built = built.clamp(0.0, 1.0);
      }
      if let Some(fade) = fade {
        dress.fade = fade.clamp(0.0, 1.0);
      }
      dress.working = working.unwrap_or(dress.working);
      dress.off = off.unwrap_or(dress.off);
      dress.variant = variant.or(dress.variant);
      Ok(())
    });
    // Облик вида kind серединой в (x, y) на этот кадр: { built — доля снизу, остальное чертёж; tint — {r, g, b, a}
    // с предумноженной альфой; player — чья сторона (по умолчанию своя); over — призраком поверх зданий; phase —
    // кадр облика, без него — по времени }.
    methods.add_method("show", |_, c, (kind, x, y, options): (Table, f32, f32, Option<Table>)| {
      let get = |key: &str| options.as_ref().map_or(Ok(Value::Nil), |table| table.get::<Value>(key));
      let built = get("built")?.as_f64().unwrap_or(1.0).clamp(0.0, 1.0) as f32;
      let tint = match get("tint")? {
        Value::Table(table) => [table.get::<f32>(1)?, table.get::<f32>(2)?, table.get::<f32>(3)?, table.get::<f32>(4)?],
        _ => [1.0; 4],
      };
      let mut state = c.state.borrow_mut();
      let player = get("player")?.as_f64().map_or(state.player, |player| player as u32);
      let over = get("over")?.as_boolean().unwrap_or(false);
      let phase = get("phase")?.as_f64().map(|phase| phase.max(0.0) as usize);
      let scale = get("scale")?.as_f64().unwrap_or(1.0) as f32;
      let layer = get("layer")?.as_f64().map(|layer| layer.clamp(0.0, 8.0) as usize);
      let shadow = get("shadow")?.as_boolean().unwrap_or(true);
      state.shown.push(Shown { proto: kind.get("id")?, x, y, built, tint, player, over, phase, scale, layer, shadow });
      Ok(())
    });
    // Слышимость точки мира (0..1) и её сторона (−1..1): для своих голосов — моторов, гулов.
    methods.add_method("nearness", |_, c, (x, y, reach): (f32, f32, Option<f32>)| Ok(c.state.borrow().nearness(x, y, reach.unwrap_or(0.6))));
    methods.add_method("side", |_, c, x: f32| Ok(c.state.borrow().side(x)));
    // Огонь в кадре (lights.add в renderer.ts): точка в тайлах, радиусы пятна на земле и ореола — в пикселях
    // местности (0 — без него), яркость 0..1. Пятно видно, когда темнее полудня, ореол — всегда.
    methods.add_method("light", |_, c, (x, y, cut, bloom, level): (f32, f32, f32, f32, f32)| {
      let mut state = c.state.borrow_mut();
      if state.lights.len() < 4096 && level > 0.0 {
        state.lights.push([x, y, cut, bloom, level]);
      }
      Ok(())
    });
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
      let decal = Decal { line: [x1, y1, x2, y2], width: get("width", 1.0 / 16.0)?, frame: [0.0; 4], color, opacity, density: get("density", 1.0)?, seed: 0.0, age: 0.0, life };
      c.state.borrow_mut().lay(0, decal);
      Ok(())
    });
    // Картинка на земле (stamp в decalsPass.ts): кадр облика kind (фаза phase, направление по углу angle) в его
    // натуральную величину с серединой в (x, y), ровно по сетке пикселей мира; непрозрачность, срок в секундах и слой —
    // 1 (отметины) или 2 (остовы). c:stamp({ kind, phase, angle, x, y, opacity, life, layer }).
    methods.add_method("stamp", |_, c, spec: Table| {
      let kind: Table = spec.get("kind")?;
      let id: u32 = kind.get("id")?;
      let get = |key: &str, default: f32| spec.get::<Option<f32>>(key).map(|value| value.unwrap_or(default));
      let (x, y, opacity, life) = (get("x", 0.0)?, get("y", 0.0)?, get("opacity", 1.0)?, get("life", 60.0)?);
      let layer = spec.get::<Option<usize>>("layer")?.unwrap_or(1).min(2);
      let (uv, size) = {
        let state = c.state.borrow();
        let Some(info) = state.looks.get(&id) else { return Ok(()) };
        let directions = info.directions.max(1);
        let direction = (spec.get::<Option<f64>>("angle")?.unwrap_or(0.0) / crate::atlas::TURN * directions as f64).round().rem_euclid(directions as f64) as usize;
        let phases = (info.cells.len() / directions).max(1);
        let phase = spec.get::<Option<usize>>("phase")?.unwrap_or(0) % phases;
        let Some(&uv) = info.cells.get(phase * directions + direction) else { return Ok(()) };
        (uv, info.size[0])
      };
      if opacity <= 0.0 || life <= 0.0 {
        return Ok(());
      }
      let left = ((x - size / 32.0) * 16.0).round() / 16.0;
      let top = ((y - size / 32.0) * 16.0).round() / 16.0;
      let half = size / 32.0;
      let decal = Decal { line: [left, top + half, left + size / 16.0, top + half], width: size / 16.0, frame: [uv[0], uv[1], uv[2] - uv[0], uv[3] - uv[1]], color: [1.0; 3], opacity, density: 1.0, seed: 0.0, age: 0.0, life };
      c.state.borrow_mut().lay(layer, decal);
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
    // Слои карты — как ctx:layer и ctx:layer_in: значение канала тайла и непустые тайлы прямоугольника (x, y,
    // значение подряд).
    methods.add_method("layer", |_, c, (name, x, y, channel): (String, f64, f64, Option<usize>)| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      let id = kharos_world::tiles::id(&world.layers, &name)?;
      let channel = kharos_world::tiles::channel(&world.layers, id, channel)?;
      Ok(world.known_layer(state.player, id, x.floor() as i32, y.floor() as i32, channel))
    });
    methods.add_method("layer_in", |_, c, (name, x, y, width, height, channel): (String, f64, f64, f64, f64, Option<usize>)| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      let id = kharos_world::tiles::id(&world.layers, &name)?;
      let channel = kharos_world::tiles::channel(&world.layers, id, channel)?;
      let (left, top) = (x.floor() as i32, y.floor() as i32);
      Ok(world.known_layer_within(state.player, id, channel, left, top, left + width.ceil() as i32, top + height.ceil() as i32))
    });
    // Видит ли свой игрок сущность живой: своё — всегда, чужое запоминаемое (Memorable) — пока его место в обзоре,
    // остальное — пока виден тайл под ним.
    methods.add_method("visible", |_, c, e: f64| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      Ok(world.shows(state.player, entity(e)?))
    });
    // Знает ли свой игрок сущность: видит живой или помнит призраком.
    methods.add_method("knows", |_, c, e: f64| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      let e = entity(e)?;
      Ok(world.shows(state.player, e) || world.ghosts(state.player).iter().any(|(ghost, _)| *ghost == e))
    });
    // Что свой игрок помнит в тумане (memory.rs): { id, x, y, width, height, kind (вид, как c:proto), parts —
    // компоненты, какими их видели }; с прямоугольником — только те, чья середина в нём.
    methods.add_method("ghosts", |lua, c, (x1, y1, x2, y2): (Option<f64>, Option<f64>, Option<f64>, Option<f64>)| {
      let state = c.state.borrow();
      let world = state.world.borrow();
      let list = lua.create_table();
      for (e, record) in world.ghosts(state.player) {
        if let (Some(x1), Some(y1), Some(x2), Some(y2)) = (x1, y1, x2, y2) {
          if record.x < x1 || record.x > x2 || record.y < y1 || record.y > y2 {
            continue;
          }
        }
        let ghost = lua.create_table();
        ghost.set("id", e as f64)?;
        ghost.set("x", record.x)?;
        ghost.set("y", record.y)?;
        ghost.set("width", record.width)?;
        ghost.set("height", record.height)?;
        if let Some(proto) = record.num("Proto", "id").and_then(|proto| state.protos.get(proto as usize)) {
          ghost.set("kind", proto.clone())?;
        }
        ghost.set("parts", kharos_content::vm::to_lua(lua, &Json::Object(record.parts.clone()))?)?;
        list.push(ghost)?;
      }
      Ok(list)
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

/// `c.draw` — поверх мира, в тайлах; толщины — в пикселях экрана. `c.glow` — то же в светящийся слой.
pub struct Draw(Rc<RefCell<ClientState>>, bool);

impl Draw {
  fn batch<R>(&self, paint: impl FnOnce(&mut crate::ui::Batch, f32) -> R) -> R {
    let mut state = self.0.borrow_mut();
    let zoom = state.view.zoom;
    paint(if self.1 { &mut state.glow } else { &mut state.draw }, zoom)
  }
}

impl UserData for Draw {
  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("line", |_, draw, (x1, y1, x2, y2, value, width, alpha): (f32, f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      draw.batch(|batch, zoom| batch.line([x1, y1], [x2, y2], width.unwrap_or(1.0) / zoom, color(value, alpha)));
      Ok(())
    });
    // Круг: width — толщина кольца в пикселях, без неё — заливка.
    methods.add_method("circle", |_, draw, (x, y, radius, value, width, alpha): (f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      draw.batch(|batch, zoom| {
        let segments = ((radius * zoom).sqrt() * 4.0).clamp(12.0, 64.0) as usize;
        batch.circle([x, y], radius, width.map(|width| width / zoom), color(value, alpha), segments)
      });
      Ok(())
    });
    methods.add_method("rect", |_, draw, (x1, y1, x2, y2, value, width, alpha): (f32, f32, f32, f32, u32, Option<f32>, Option<f32>)| {
      let rgba = color(value, alpha);
      let (left, right, top, bottom) = (x1.min(x2), x1.max(x2), y1.min(y2), y1.max(y2));
      draw.batch(|batch, zoom| match width {
        None => batch.rect([left, top], [right, bottom], rgba),
        Some(width) => {
          let w = width / zoom;
          for (a, b) in [([left, top], [right, top]), ([right, top], [right, bottom]), ([right, bottom], [left, bottom]), ([left, bottom], [left, top])] {
            batch.line(a, b, w, rgba);
          }
        }
      });
      Ok(())
    });
    // Кадр облика вида kind (фаза phase, направление по углу angle) квадратом side тайлов с серединой в (x, y);
    // цвет — множитель 0xRRGGBB, alpha — непрозрачность. Без цвета стороны: для взрывов, дыма и прочих картинок.
    methods.add_method("sprite", |_, draw, (kind, phase, x, y, side, value, alpha, angle): (Table, usize, f32, f32, f32, Option<u32>, Option<f32>, Option<f64>)| {
      let id: u32 = kind.get("id")?;
      let uv = {
        let state = draw.0.borrow();
        let Some(info) = state.looks.get(&id) else { return Ok(()) };
        let directions = info.directions.max(1);
        let direction = (angle.unwrap_or(0.0) / crate::atlas::TURN * directions as f64).round().rem_euclid(directions as f64) as usize;
        let phases = (info.cells.len() / directions).max(1);
        let Some(&uv) = info.cells.get((phase % phases) * directions + direction) else { return Ok(()) };
        uv
      };
      let half = side / 2.0;
      let rgba = color(value.unwrap_or(0xffffff), alpha);
      draw.batch(|batch, _| batch.quad([x - half, y - half], [x + half, y + half], uv, rgba, crate::ui::Paint::Picture));
      Ok(())
    });
    // Кадр спрайта на прямоугольник мира (left, top, width, height в тайлах); flip — отражён по горизонтали.
    methods.add_method("stretch", |_, draw, (kind, phase, left, top, width, height, flip, value, alpha): (Table, usize, f32, f32, f32, f32, Option<bool>, Option<u32>, Option<f32>)| {
      let id: u32 = kind.get("id")?;
      let uv = {
        let state = draw.0.borrow();
        let Some(info) = state.looks.get(&id) else { return Ok(()) };
        let directions = info.directions.max(1);
        let phases = (info.cells.len() / directions).max(1);
        let Some(&uv) = info.cells.get((phase % phases) * directions) else { return Ok(()) };
        uv
      };
      let uv = if flip.unwrap_or(false) { [uv[2], uv[1], uv[0], uv[3]] } else { uv };
      let rgba = color(value.unwrap_or(0xffffff), alpha);
      draw.batch(|batch, _| batch.quad([left, top], [left + width, top + height], uv, rgba, crate::ui::Paint::Picture));
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
  let table = lua.create_table();
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
        Value::String(name) if name.to_str()? == "minimap" => state.gui.leaf(Default::default(), crate::gui::Leaf::Image { image: crate::gui::Image::Minimap, width, height }),
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
      let table = lua.create_table();
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
      let result = lua.create_table();
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
      let result = lua.create_table();
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
    let buttons = lua.create_table();
    for (index, button) in BUTTONS.iter().enumerate() {
      buttons.set(*button, values[index])?;
    }
    table.set(name, buttons)?;
  }
  table.set("wheel", input.wheel)?;
  let keys = lua.create_table();
  for key in &input.keys {
    keys.set(key.as_str(), true)?;
  }
  table.set("keys", keys)?;
  let hits = lua.create_table();
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
    Some(uv) => LookInfo { uv, size: look.portrait_size, picture: look.picture, cells: look.cells.clone(), directions: look.directions },
    None => LookInfo { uv: look.cells[look.cell(look.icon as f64 / look.directions.max(1) as f64 * crate::atlas::TURN, 0)], size: [look.size[0] as f32, look.size[1] as f32], picture: look.picture, cells: look.cells.clone(), directions: look.directions },
  }
}
