//! Хост: мир и правила из модов (docs/mods.md, «Хост»). Каждый тик:
//!
//! 1. приказы игроков — обработчики `commands` видов;
//! 2. системы видов по порядку (`systems`): движок собирает сущности по `query`, отдаёт их столбцы буферами, после
//!    системы забирает назад столбцы компонентов из `write`, потом выполняет её команды (`ctx:spawn`, `ctx:set` …) и
//!    раздаёт события (`ctx:emit` → `on` видов);
//! 3. сигналы (`ctx:signal`) копятся для клиентов: выстрел, взрыв, готовый юнит — им звучать и вспыхивать.

use crate::schema::{ComponentId, Schema};
use crate::world::{encode_checked, Entity, World};
use kharos_content::vm::function;
use kharos_content::{Content, Mod, Side};
use mlua::{AnyUserData, Function, Lua, MultiValue, Table, UserData, UserDataFields, UserDataMethods, Value};
use serde_json::{Map, Value as Json};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

/// Сигнал клиентам: имя и что к нему приложено.
#[derive(Clone, Debug, PartialEq)]
pub struct Signal {
  pub name: String,
  pub payload: Json,
}

/// Система вида.
struct System {
  /// `раздел/вид.ключ` — для сообщений и `after`/`before`.
  name: String,
  key: String,
  proto: Table,
  query: Vec<ComponentId>,
  /// Условия на числовые поля: компонент, столбец, значение.
  filter: Vec<(ComponentId, usize, f64)>,
  write: Vec<ComponentId>,
  every: u64,
  /// Сколько времени система заняла: сборка столбцов, Luau, возврат столбцов и команды — в секундах, всего.
  spent: [f64; 4],
  after: Vec<String>,
  before: Vec<String>,
  run: Run,
}

/// Чем система считает: своей функцией Luau над столбцами или системой движка (`engine = "follow"`, tools.rs).
enum Run {
  Luau(Function),
  Engine(fn(&mut State)),
}

/// Отложенная команда системы или обработчика.
enum Op {
  Spawn(Entity, Vec<(ComponentId, Map<String, Json>)>),
  Destroy(Entity),
  Add(Entity, ComponentId, Map<String, Json>),
  Set(Entity, ComponentId, Map<String, Json>),
  Remove(Entity, ComponentId),
}

/// Что общее у хоста и `ctx` в скриптах.
pub struct State {
  pub world: World,
  ops: Vec<Op>,
  pub(crate) events: Vec<(String, Json)>,
  pub signals: Vec<Signal>,
  pub tick: u64,
  pub dt: f64,
  rng: u64,
  /// Места сущностей по клеткам для `ctx:near`; None — устарела.
  grid: Option<Grid>,
  /// Обзор игроков; None — у партии нет карты (data.size).
  pub vision: Option<crate::vision::Vision>,
  /// Местность партии (data.land — вид из lands/): тот же генератор, что рисует клиент.
  pub land: Option<kharos_engine::terrain::Land>,
  /// Ход: поиски пути, занятость, правила местности партии (data.rules).
  pub motion: crate::motion::Motion,
  pub rules: crate::motion::Rules,
  /// Виды оружия — раздел `weapons/` контента.
  pub weapons: crate::combat::Weapons,
  /// Сети и энергосети связанных (`Link`).
  pub networks: crate::networks::Networks,
  /// Слои карты — раздел `layers/` модов (tiles.rs).
  pub layers: kharos_engine::layers::Layers,
  /// Что игроки помнят о чужом в тумане (memory.rs).
  pub memory: crate::memory::Memory,
  /// Реплика: мир клиента по сети — только то, что прислал сервер (crates/net). Систем у неё нет, обзор — по своим
  /// глазам (`Vision::only`), память — присланная.
  pub replica: bool,
}

impl State {
  /// Мир и всё, что нужно ходу (motion).
  pub fn scene(&mut self) -> crate::motion::Scene<'_> {
    let bounds = self.vision.as_ref().map(|vision| vision.bounds);
    crate::motion::Scene { world: &mut self.world, land: self.land.as_mut(), motion: &mut self.motion, bounds, rules: &self.rules, layers: &self.layers, tick: self.tick }
  }
}

/// Клетки 4 × 4 тайла: сущности с Position.
struct Grid {
  cells: HashMap<(i32, i32), Vec<(Entity, f64, f64)>>,
}

const CELL: f64 = 4.0;

impl Grid {
  fn build(world: &World) -> Self {
    let position = world.schema.id("Position").expect("Position");
    let store = &world.stores[position];
    let mut cells: HashMap<(i32, i32), Vec<(Entity, f64, f64)>> = HashMap::new();
    for (row, &entity) in store.entities.iter().enumerate() {
      let (x, y) = (store.nums[0][row], store.nums[1][row]);
      cells.entry(((x / CELL).floor() as i32, (y / CELL).floor() as i32)).or_default().push((entity, x, y));
    }
    Self { cells }
  }
}

pub struct Host {
  pub content: Content,
  /// Партия — вид из `games/`.
  pub game: String,
  pub state: Rc<RefCell<State>>,
  systems: Vec<System>,
  handlers: HashMap<String, Vec<(String, Function)>>,
  commands: HashMap<String, (String, Function)>,
  orders: Vec<(u32, String, Json)>,
  ctx: AnyUserData,
  /// Что `ctx.storage` — память модов, уходит в сохранение.
  storage: Table,
}

/// Ошибка тика или загрузки: где и что.
pub type Error = String;

fn lua_error(what: impl std::fmt::Display) -> impl FnOnce(mlua::Error) -> Error {
  move |error| format!("{what}: {error}")
}

/// Генератор местности партии: вид `lands/<data.land>`, поверх — `data.generator` (поля генератора) и `data.seed`.
/// None — у партии нет местности. Один и тот же у хоста и клиента.
pub fn land_config(content: &Content, data: &Table) -> Result<Option<kharos_engine::terrain::GeneratorConfig>, Error> {
  let Some(name) = data.get::<Option<String>>("land").map_err(lua_error("data.land"))? else { return Ok(None) };
  let kind = content.get("lands", &name).ok_or_else(|| format!("нет местности lands/{name}"))?;
  let mut generator: Json = content.lua.from_value(kind.get::<Value>("data").map_err(lua_error(format!("lands/{name}.data")))?).map_err(lua_error(format!("lands/{name}.data")))?;
  if let (Json::Object(fields), Some(changes)) = (&mut generator, data.get::<Option<Table>>("generator").map_err(lua_error("data.generator"))?) {
    let changes: Json = content.lua.from_value(Value::Table(changes)).map_err(lua_error("data.generator"))?;
    if let Json::Object(changes) = changes {
      fields.extend(changes);
    }
  }
  if let (Json::Object(fields), Some(seed)) = (&mut generator, data.get::<Option<f64>>("seed").map_err(lua_error("data.seed"))?) {
    fields.insert("seed".into(), Json::from(seed));
  }
  serde_json::from_value(generator).map(Some).map_err(|problem| format!("lands/{name}.data: {problem}"))
}

impl Host {
  /// Загружает моды на стороне хоста и собирает схему, системы, команды и обработчики. game — вид из `games/`: из
  /// партий правила берутся только у неё; None — партия по умолчанию (`game` в манифесте, последний мод главнее).
  /// options — настройки партии из меню, ложатся в её `data` (`Content::apply_options`).
  pub fn new(mods: Vec<Mod>, game: Option<&str>, seed: u64, options: &Json) -> Result<Self, Error> {
    let content = Content::load(Side::Host, mods).map_err(|error| error.to_string())?;
    let game = match game {
      Some(game) => game.to_string(),
      None => content.default_game().ok_or("партия не задана: нет game ни в одном mod.luau")?,
    };
    let game = game.as_str();
    if content.id("games", game).is_none() {
      return Err(format!("нет партии games/{game}"));
    }
    content.apply_options(game, options)?;
    let schema = Rc::new(schema_of(&content)?);
    let state = Rc::new(RefCell::new(State { world: World::new(schema.clone()), ops: Vec::new(), events: Vec::new(), signals: Vec::new(), tick: 0, dt: 0.05, rng: seed.max(1), grid: None, vision: None, land: None, motion: Default::default(), rules: Default::default(), weapons: Default::default(), networks: Default::default(), layers: crate::tiles::of(&content)?, memory: Default::default(), replica: false }));
    {
      let mut state = state.borrow_mut();
      state.memory = crate::memory::Memory::new(&state.layers);
    }
    let lua = &content.lua;
    let storage = lua.create_table();
    let game_table = content.get("games", game).expect("партия");
    let ctx = lua.create_userdata(Ctx { state: state.clone(), protos: content.protos.clone(), game: game_table, storage: storage.clone(), list: content.list.iter().map(|proto| (proto.section.clone(), proto.name.clone())).collect() }).map_err(lua_error("ctx"))?;

    let mut systems = Vec::new();
    let mut handlers: HashMap<String, Vec<(String, Function)>> = HashMap::new();
    let mut commands = HashMap::new();
    for proto in content.list.iter().filter(|proto| proto.section != "games" || proto.name == game) {
      let table = content.by_id(proto.id).expect("вид");
      let label = format!("{}/{}", proto.section, proto.name);
      if let Some(list) = table.get::<Option<Table>>("systems").map_err(lua_error(format!("{label}.systems")))? {
        let mut keys: Vec<(String, Table)> = list.pairs::<String, Table>().collect::<mlua::Result<_>>().map_err(lua_error(format!("{label}.systems: система — таблица")))?;
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, spec) in keys {
          systems.push(system_of(lua, &schema, &state, &label, key, spec, table.clone())?);
        }
      }
      if let Some(on) = table.get::<Option<Table>>("on").map_err(lua_error(format!("{label}.on")))? {
        let mut list: Vec<(String, Function)> = on.pairs::<String, Function>().collect::<mlua::Result<_>>().map_err(lua_error(format!("{label}.on: обработчик — функция")))?;
        list.sort_by(|a, b| a.0.cmp(&b.0));
        for (event, handler) in list {
          handlers.entry(event).or_default().push((label.clone(), handler));
        }
      }
      if let Some(list) = table.get::<Option<Table>>("commands").map_err(lua_error(format!("{label}.commands")))? {
        for pair in list.pairs::<String, Function>() {
          let (name, handler) = pair.map_err(lua_error(format!("{label}.commands: команда — функция")))?;
          commands.insert(name, (label.clone(), handler));
        }
      }
    }
    let systems = order_systems(systems)?;
    // Правила хода партии: замедление по родам и местности (data.rules).
    if let Some(rules) = content.get("games", game).and_then(|table| table.get::<Option<Table>>("data").ok().flatten()).and_then(|data| data.get::<Option<Table>>("rules").ok().flatten()) {
      if let Json::Object(map) = content.lua.from_value::<Json>(Value::Table(rules)).map_err(lua_error("data.rules"))? {
        state.borrow_mut().rules = crate::motion::Rules(map);
      }
    }
    // Виды оружия для боя: data каждого вида из weapons/.
    for proto in content.list.iter().filter(|proto| proto.section == "weapons") {
      let data = content.by_id(proto.id).and_then(|table| table.get::<Option<Table>>("data").ok().flatten());
      if let Some(data) = data {
        if let Json::Object(map) = content.lua.from_value::<Json>(Value::Table(data)).map_err(lua_error(format!("weapons/{}.data", proto.name)))? {
          state.borrow_mut().weapons.0.insert(proto.name.clone(), crate::combat::Weapon::parse(&map));
        }
      }
    }
    // Обзор — по карте партии: data.size тайлов от центра, data.fog — есть ли туман (по умолчанию есть).
    let data: Option<Table> = content.get("games", game).and_then(|table| table.get::<Option<Table>>("data").ok().flatten());
    if let Some(size) = data.as_ref().and_then(|data| data.get::<Option<i32>>("size").ok().flatten()) {
      let fog = data.as_ref().and_then(|data| data.get::<Option<bool>>("fog").ok().flatten()).unwrap_or(true);
      state.borrow_mut().vision = Some(crate::vision::Vision::new(crate::vision::Bounds { left: -size, top: -size, right: size, bottom: size }, fog));
      if let Some(config) = land_config(&content, data.as_ref().expect("data"))? {
        state.borrow_mut().land = Some(kharos_engine::terrain::Land::new(config, kharos_engine::terrain::LandArea::of(-size, -size, size, size)));
      }
    }
    Ok(Self { content, game: game.to_string(), state, systems, handlers, commands, orders: Vec::new(), ctx, storage })
  }

  pub fn lua(&self) -> &Lua {
    &self.content.lua
  }

  /// Номер вида раздел/имя.
  pub fn proto_id(&self, section: &str, name: &str) -> Option<u32> {
    self.content.id(section, name)
  }

  /// Имена систем по порядку тика.
  pub fn system_names(&self) -> Vec<String> {
    self.systems.iter().map(|system| system.name.clone()).collect()
  }

  /// Начало партии: `start(ctx, партия)` вида из `games/` и событие `start`.
  pub fn start(&mut self) -> Result<(), Error> {
    let game = self.game.clone();
    let game = game.as_str();
    let table = self.content.get("games", game).ok_or_else(|| format!("нет партии games/{game}"))?;
    if let Some(start) = function(&table, "start").map_err(lua_error(format!("games/{game}.start")))? {
      start.call::<()>((&self.ctx, &table)).map_err(lua_error(format!("games/{game}.start")))?;
      self.settle(&format!("games/{game}.start"))?;
    }
    self.emit("start", serde_json::json!({ "game": game }))
  }

  /// Игрок вошёл: событие `player_joined { player }`.
  pub fn join(&mut self, player: u32) -> Result<(), Error> {
    self.emit("player_joined", serde_json::json!({ "player": player }))
  }

  /// Приказ игрока: выполнится в начале следующего тика.
  pub fn send(&mut self, player: u32, name: &str, args: Json) {
    self.orders.push((player, name.to_string(), args));
  }

  /// Событие от движка: обработчики видов и их команды.
  pub fn emit(&mut self, name: &str, payload: Json) -> Result<(), Error> {
    self.state.borrow_mut().events.push((name.to_string(), payload));
    self.settle(name)
  }

  /// Приказ игрока сразу, а не в начале тика (orderNow в editor.ts): мир редактора стоит, систем нет.
  pub fn command_now(&mut self, player: u32, name: &str, args: Json) -> Result<(), Error> {
    {
      // Сигналы и места по клеткам — этого приказа, как у тика.
      let mut state = self.state.borrow_mut();
      state.signals.clear();
      state.grid = None;
    }
    let Some((label, handler)) = self.commands.get(name).cloned() else { return Ok(()) };
    let args = kharos_content::vm::to_lua(self.lua(), &args).map_err(lua_error(format!("приказ {name}")))?;
    handler.call::<()>((&self.ctx, player, args)).map_err(lua_error(format!("{label}.commands.{name}")))?;
    self.settle(&format!("{label}.commands.{name}"))
  }

  /// Зовёт функцию машины хоста с `ctx` и аргументом, потом применяет её изменения и раздаёт события, как после приказа:
  /// так сценарий (режим сценария клиента) читает и правит мир. Возвращает, что вернула функция, значением JSON.
  pub fn call(&mut self, function: &Function, args: &Json, label: &str) -> Result<Json, Error> {
    let lua = self.lua().clone();
    let args = kharos_content::vm::to_lua(&lua, args).map_err(lua_error(label))?;
    let result = function.call::<Value>((&self.ctx, args)).map_err(lua_error(label))?;
    self.settle(label)?;
    lua.from_value::<Json>(result).map_err(lua_error(format!("{label}: результат")))
  }

  /// Один тик длиной dt секунд.
  pub fn tick(&mut self, dt: f64) -> Result<(), Error> {
    {
      let mut state = self.state.borrow_mut();
      state.tick += 1;
      state.dt = dt;
      state.signals.clear();
      state.grid = None;
    }
    for (player, name, args) in std::mem::take(&mut self.orders) {
      let Some((label, handler)) = self.commands.get(&name).cloned() else { continue };
      let args = kharos_content::vm::to_lua(self.lua(), &args).map_err(lua_error(format!("приказ {name}")))?;
      handler.call::<()>((&self.ctx, player, args)).map_err(lua_error(format!("{label}.commands.{name}")))?;
      self.settle(&format!("{label}.commands.{name}"))?;
    }
    let tick = self.state.borrow().tick;
    for index in 0..self.systems.len() {
      if tick % self.systems[index].every != 0 {
        continue;
      }
      self.run_system(index)?;
    }
    {
      let mut state = self.state.borrow_mut();
      let State { world, vision, layers, memory, land, .. } = &mut *state;
      if let Some(vision) = vision {
        let look = tick % crate::vision::TICKS == 1;
        if look {
          vision.update(world);
        }
        memory.update(world, vision, layers, land.as_mut(), look);
      }
    }
    Ok(())
  }

  fn run_system(&mut self, index: usize) -> Result<(), Error> {
    let started = clock();
    let system = &self.systems[index];
    if let Run::Engine(tool) = system.run {
      {
        let mut state = self.state.borrow_mut();
        tool(&mut state);
        state.grid = None;
      }
      let ran = clock();
      let name = system.name.clone();
      self.settle(&name)?;
      self.systems[index].spent[1] += ran - started;
      return Ok(());
    }
    let Run::Luau(run) = &system.run else { unreachable!() };
    let lua = &self.content.lua;
    let (query, rows) = {
      let state = self.state.borrow();
      let world = &state.world;
      let mut entities = world.query(&system.query);
      if !system.filter.is_empty() {
        entities.retain(|&entity| system.filter.iter().all(|&(component, slot, value)| world.stores[component].row(entity).is_some_and(|row| world.stores[component].nums[slot][row] == value)));
      }
      let query = columns(lua, world, &system.query, &entities).map_err(lua_error(&system.name))?;
      (query, entities)
    };
    let built = clock();
    run.call::<()>((&query, &self.ctx, &system.proto)).map_err(lua_error(&system.name))?;
    let ran = clock();
    if !system.write.is_empty() && !rows.is_empty() {
      let mut state = self.state.borrow_mut();
      write_back(&mut state.world, &query, &system.write, &rows).map_err(lua_error(&system.name))?;
      if system.write.contains(&state.world.schema.id("Position").expect("Position")) {
        state.grid = None;
      }
    }
    let written = clock();
    let name = system.name.clone();
    self.settle(&name)?;
    let spent = &mut self.systems[index].spent;
    for (slot, (from, to)) in [(started, built), (built, ran), (ran, written), (written, clock())].into_iter().enumerate() {
      spent[slot] += to - from;
    }
    Ok(())
  }

  /// Время систем с начала, в миллисекундах: имя и четыре части — сборка столбцов, Luau, возврат столбцов, команды
  /// и события.
  pub fn timings(&self) -> Vec<(String, [f64; 4])> {
    self.systems.iter().map(|system| (system.name.clone(), system.spent.map(|seconds| seconds * 1000.0))).collect()
  }

  /// Выполняет отложенные команды и раздаёт события, пока они есть.
  fn settle(&mut self, after: &str) -> Result<(), Error> {
    for _ in 0..64 {
      apply(&mut self.state.borrow_mut()).map_err(|error| format!("{after}: {error}"))?;
      let events = std::mem::take(&mut self.state.borrow_mut().events);
      if events.is_empty() {
        return Ok(());
      }
      for (name, payload) in events {
        let Some(list) = self.handlers.get(&name).cloned() else { continue };
        let value = kharos_content::vm::to_lua(self.lua(), &payload).map_err(lua_error(&name))?;
        for (label, handler) in list {
          handler.call::<()>((&self.ctx, value.clone())).map_err(lua_error(format!("{label}.on.{name}")))?;
          apply(&mut self.state.borrow_mut()).map_err(|error| format!("{label}.on.{name}: {error}"))?;
        }
      }
    }
    Err(format!("{after}: события порождают друг друга без конца"))
  }

  /// Сигналы последнего тика.
  pub fn signals(&self) -> Vec<Signal> {
    self.state.borrow().signals.clone()
  }

  /// Память модов (`ctx.storage`) — JSON для сохранения.
  pub fn storage(&self) -> Result<Json, Error> {
    self.lua().from_value(Value::Table(self.storage.clone())).map_err(lua_error("storage"))
  }

  /// Снимок партии для сохранения: тик, случай, сущности (компоненты по именам, вид — «раздел/имя», чтобы
  /// сохранение пережило правку модов), обзор игроков и память модов (`ctx.storage`).
  pub fn snapshot(&self) -> Result<Json, Error> {
    // Правки земли: исходные и нынешние байты тайлов, знание игроков.
    let land = {
      let mut state = self.state.borrow_mut();
      let State { land, memory, .. } = &mut *state;
      land.as_mut().map(|land| memory.land.save(land))
    };
    let state = self.state.borrow();
    let world = &state.world;
    let proto = world.schema.id("Proto");
    let mut entities = Vec::new();
    for entity in world.entities() {
      let mut components = Map::new();
      for (id, component) in world.schema.components.iter().enumerate() {
        let Some(mut values) = world.get(entity, id) else { continue };
        if Some(id) == proto {
          self.proto_name(&mut values);
        }
        components.insert(component.name.clone(), Json::Object(values));
      }
      entities.push(serde_json::json!({ "id": entity, "components": components }));
    }
    let memory = state.memory.save(&state.layers, |parts| {
      if let Some(Json::Object(values)) = parts.get_mut("Proto") {
        self.proto_name(values);
      }
    });
    let vision = state.vision.as_ref().map(|vision| vision.cells.iter().map(|(player, cells)| (player.to_string(), Json::from(run_length(&cells.bytes())))).collect::<Map<String, Json>>());
    Ok(serde_json::json!({
      "game": self.game,
      "tick": state.tick,
      "rng": state.rng,
      "next": world.next_id(),
      "entities": entities,
      "vision": vision,
      "motion": state.motion.save(),
      "layers": crate::tiles::save(&state.layers),
      "memory": memory,
      "land": land,
      "storage": saved(&Value::Table(self.storage.clone()))?,
    }))
  }

  /// Вид в снимке: номер — именем «раздел/имя».
  fn proto_name(&self, values: &mut Map<String, Json>) {
    let number = values.get("id").and_then(Json::as_f64).unwrap_or(-1.0);
    let name = self.content.list.get(number as usize).map(|proto| format!("{}/{}", proto.section, proto.name));
    values.insert("id".into(), name.map_or(Json::Null, Json::from));
  }

  /// Вид из снимка: имя «раздел/имя» — номером; вида больше нет — false.
  fn proto_number(&self, values: &mut Map<String, Json>) -> bool {
    let number = values.get("id").and_then(Json::as_str).and_then(|path| path.split_once('/')).and_then(|(section, name)| self.content.id(section, name));
    match number {
      Some(number) => {
        values.insert("id".into(), Json::from(number));
        true
      }
      None => false,
    }
  }

  /// Партия из снимка (`snapshot`) — вместо `start` и `join`: хост уже создан с теми же модами и настройками.
  pub fn restore(&mut self, snapshot: &Json) -> Result<(), Error> {
    let get = |key: &str| snapshot.get(key).ok_or_else(|| format!("в сохранении нет {key}"));
    {
      let mut state = self.state.borrow_mut();
      state.tick = get("tick")?.as_u64().unwrap_or(0);
      state.rng = get("rng")?.as_u64().unwrap_or(1).max(1);
      let schema = state.world.schema.clone();
      let mut world = World::new(schema.clone());
      // Номера строк — те же: фильтры систем запомнили их, когда хост собирался.
      world.strings = state.world.strings.clone();
      for item in get("entities")?.as_array().ok_or("entities — список")? {
        let entity = item.get("id").and_then(Json::as_u64).ok_or("сущность без номера")? as Entity;
        world.revive(entity);
        let Some(Json::Object(components)) = item.get("components") else { continue };
        for (name, values) in components {
          // Компонента больше нет в модах — его поля теряются, сущность остаётся.
          let Some(id) = schema.id(name) else { continue };
          let Json::Object(values) = values else { continue };
          let mut values = values.clone();
          // Вида больше нет — и сущности нет.
          if name == "Proto" && !self.proto_number(&mut values) {
            world.destroy(entity);
            break;
          }
          world.add(entity, id, &values).map_err(|problem| format!("сущность {entity}, {name}: {problem}"))?;
        }
      }
      world.set_next(get("next")?.as_u64().unwrap_or(1) as Entity);
      state.world = world;
      if let Some(saved) = snapshot.get("motion") {
        state.motion.load(saved);
      }
      state.layers = crate::tiles::of(&self.content)?;
      if let Some(saved) = snapshot.get("layers") {
        crate::tiles::load(&mut state.layers, saved);
      }
      state.memory = crate::memory::Memory::new(&state.layers);
      let State { land, memory, .. } = &mut *state;
      if let (Some(saved), Some(land)) = (snapshot.get("land").filter(|saved| !saved.is_null()), land.as_mut()) {
        // Земля партии собирается заново по генератору: правки ложатся поверх.
        *land = kharos_engine::terrain::Land::new(land.config.clone(), land.area);
        memory.land.load(land, saved);
      }
      if let Some(saved) = snapshot.get("memory") {
        let State { memory, layers, .. } = &mut *state;
        memory.load(layers, saved, |parts| match parts.get_mut("Proto") {
          Some(Json::Object(values)) => self.proto_number(values),
          _ => false,
        });
      }
      if let (Some(vision), Some(Json::Object(saved))) = (state.vision.as_mut(), snapshot.get("vision")) {
        for (player, cells) in saved {
          let (Ok(player), Some(cells)) = (player.parse::<u32>(), cells.as_array()) else { continue };
          vision.set_explored(player, run_length_decode(cells));
        }
      }
    }
    let lua = self.lua().clone();
    let storage = restored(&lua, snapshot.get("storage").unwrap_or(&Json::Null))?;
    if let Value::Table(saved) = storage {
      for pair in saved.pairs::<Value, Value>() {
        let (key, value) = pair.map_err(lua_error("storage"))?;
        self.storage.set(key, value).map_err(lua_error("storage"))?;
      }
    }
    Ok(())
  }
}

/// Клетки обзора — парами «значение, сколько подряд»: разведанное лежит большими пятнами.
fn run_length(cells: &[u8]) -> Vec<u32> {
  let mut runs = Vec::new();
  let mut iter = cells.iter().peekable();
  while let Some(&cell) = iter.next() {
    // Видимое в сохранении — разведанное: что видно сейчас, обзор пересчитает сам.
    let value = cell.min(1);
    let mut count = 1;
    while iter.peek().is_some_and(|&&next| next.min(1) == value) {
      iter.next();
      count += 1;
    }
    runs.push(value as u32);
    runs.push(count);
  }
  runs
}

fn run_length_decode(runs: &[Json]) -> Vec<u8> {
  let mut cells = Vec::new();
  for pair in runs.chunks(2) {
    let (Some(value), Some(count)) = (pair.first().and_then(Json::as_u64), pair.get(1).and_then(Json::as_u64)) else { continue };
    cells.extend(std::iter::repeat_n(value as u8, count as usize));
  }
  cells
}

/// Значение Luau для сохранения: таблица — списком пар [ключ, значение], чтобы числовые ключи не стали строками.
fn saved(value: &Value) -> Result<Json, Error> {
  Ok(match value {
    Value::Nil => Json::Null,
    Value::Boolean(flag) => Json::from(*flag),
    Value::Integer(number) => Json::from(*number),
    Value::Number(number) => Json::from(*number),
    Value::String(text) => Json::from(text.to_str().map_err(lua_error("storage"))?.to_string()),
    Value::Table(table) => {
      let mut pairs = Vec::new();
      for pair in table.pairs::<Value, Value>() {
        let (key, value) = pair.map_err(lua_error("storage"))?;
        pairs.push(Json::Array(vec![saved(&key)?, saved(&value)?]));
      }
      serde_json::json!({ "table": pairs })
    }
    other => return Err(format!("в ctx.storage не сохраняется {}", other.type_name())),
  })
}

fn restored(lua: &Lua, value: &Json) -> Result<Value, Error> {
  Ok(match value {
    Json::Null => Value::Nil,
    Json::Bool(flag) => Value::Boolean(*flag),
    // Целое Luau — разрядности платформы (на wasm32 — 32 бита): большее — числом.
    Json::Number(number) => match number.as_i64().and_then(|integer| mlua::Integer::try_from(integer).ok()) {
      Some(integer) => Value::Integer(integer),
      None => Value::Number(number.as_f64().unwrap_or(0.0)),
    },
    Json::String(text) => Value::String(lua.create_string(text)),
    Json::Object(map) => {
      let table = lua.create_table();
      for pair in map.get("table").and_then(Json::as_array).into_iter().flatten() {
        let (Some(key), Some(value)) = (pair.get(0), pair.get(1)) else { continue };
        table.set(restored(lua, key)?, restored(lua, value)?).map_err(lua_error("storage"))?;
      }
      Value::Table(table)
    }
    Json::Array(_) => Value::Nil,
  })
}

/// Секунды от произвольного начала — для замеров.
fn clock() -> f64 {
  #[cfg(not(target_arch = "wasm32"))]
  {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
  }
  #[cfg(target_arch = "wasm32")]
  {
    0.0
  }
}

/// Схема: компоненты движка и всё, что объявили виды в `components`.
fn schema_of(content: &Content) -> Result<Schema, Error> {
  let mut schema = Schema::new();
  for proto in &content.list {
    let table = content.by_id(proto.id).expect("вид");
    let label = format!("{}/{}", proto.section, proto.name);
    let Some(components) = table.get::<Option<Table>>("components").map_err(lua_error(format!("{label}.components")))? else { continue };
    let mut list: Vec<(String, Table)> = components.pairs::<String, Table>().collect::<mlua::Result<_>>().map_err(lua_error(format!("{label}.components: компонент — таблица полей")))?;
    list.sort_by(|a, b| a.0.cmp(&b.0));
    for (component, fields) in list {
      let mut fields: Vec<(String, Value)> = fields.pairs::<String, Value>().collect::<mlua::Result<_>>().map_err(lua_error(format!("{label}.components.{component}")))?;
      fields.sort_by(|a, b| a.0.cmp(&b.0));
      schema.component(&component);
      for (field, default) in fields {
        let default: Json = content.lua.from_value(default).map_err(lua_error(format!("{label}.components.{component}.{field}")))?;
        schema.declare(&component, &field, default).map_err(|error| format!("{label}: {error}"))?;
      }
    }
  }
  Ok(schema)
}

fn system_of(lua: &Lua, schema: &Schema, state: &Rc<RefCell<State>>, label: &str, key: String, spec: Table, proto: Table) -> Result<System, Error> {
  let name = format!("{label}.{key}");
  let component = |component: &str| schema.id(component).ok_or_else(|| format!("{name}: нет компонента {component}"));
  let names = |field: &str| -> Result<Vec<String>, Error> { Ok(spec.get::<Option<Vec<String>>>(field).map_err(lua_error(format!("{name}.{field}")))?.unwrap_or_default()) };
  let query = names("query")?.iter().map(|one| component(one)).collect::<Result<Vec<_>, _>>()?;
  let write = names("write")?.iter().map(|one| component(one)).collect::<Result<Vec<_>, _>>()?;
  if let Some(missing) = write.iter().find(|id| !query.contains(id)) {
    return Err(format!("{name}: write.{} нет в query", schema.components[*missing].name));
  }
  let mut filter = Vec::new();
  if let Some(conditions) = spec.get::<Option<Table>>("where").map_err(lua_error(format!("{name}.where")))? {
    for pair in conditions.pairs::<String, Table>() {
      let (component_name, fields) = pair.map_err(lua_error(format!("{name}.where")))?;
      let id = component(&component_name)?;
      for field_pair in fields.pairs::<String, Value>() {
        let (field_name, value) = field_pair.map_err(lua_error(format!("{name}.where.{component_name}")))?;
        let field = schema.components[id].field(&field_name).filter(|field| field.kind.columnar()).ok_or_else(|| format!("{name}: where — нет числового поля {component_name}.{field_name}"))?;
        let json: Json = lua.from_value(value).map_err(lua_error(&name))?;
        let number = encode_checked(&mut state.borrow_mut().world.strings, field.kind, &json).ok_or_else(|| format!("{name}: where.{component_name}.{field_name} — не того вида"))?;
        filter.push((id, field.slot, number));
      }
    }
  }
  let every = spec.get::<Option<u64>>("every").map_err(lua_error(format!("{name}.every")))?.unwrap_or(1).max(1);
  let order = |field: &str| -> Result<Vec<String>, Error> { Ok(spec.get::<Option<StringOrList>>(field).map_err(lua_error(format!("{name}.{field}")))?.map(|list| list.0).unwrap_or_default()) };
  let (after, before) = (order("after")?, order("before")?);
  let run = match spec.get::<Option<String>>("engine").map_err(lua_error(format!("{name}.engine")))? {
    Some(tool) => Run::Engine(crate::tools::find(&tool).ok_or_else(|| format!("{name}: нет системы движка {tool}"))?),
    None => Run::Luau(function(&spec, "run").map_err(lua_error(&name))?.ok_or_else(|| format!("{name}: нет run"))?),
  };
  Ok(System { name, key, proto, query, filter, write, every, spent: [0.0; 4], after, before, run })
}

/// Порядок систем: `after` и `before` — ключи (`drive`) или полные имена (`moves/wheels.drive`); иначе — по видам.
fn order_systems(systems: Vec<System>) -> Result<Vec<System>, Error> {
  let count = systems.len();
  let matches = |system: &System, name: &str| system.key == name || system.name == name;
  let mut needs: Vec<Vec<usize>> = vec![Vec::new(); count];
  let specs: Vec<(Vec<String>, Vec<String>)> = systems.iter().map(|system| (system.after.clone(), system.before.clone())).collect();
  for (index, (after, before)) in specs.iter().enumerate() {
    for name in after {
      let found: Vec<usize> = (0..count).filter(|&other| other != index && matches(&systems[other], name)).collect();
      if found.is_empty() {
        return Err(format!("{}: after — нет системы {name}", systems[index].name));
      }
      needs[index].extend(found);
    }
    for name in before {
      let found: Vec<usize> = (0..count).filter(|&other| other != index && matches(&systems[other], name)).collect();
      if found.is_empty() {
        return Err(format!("{}: before — нет системы {name}", systems[index].name));
      }
      for other in found {
        needs[other].push(index);
      }
    }
  }
  let mut done = vec![false; count];
  let mut order = Vec::with_capacity(count);
  while order.len() < count {
    let Some(next) = (0..count).find(|&index| !done[index] && needs[index].iter().all(|&need| done[need])) else {
      let stuck: Vec<&str> = (0..count).filter(|&index| !done[index]).map(|index| systems[index].name.as_str()).collect();
      return Err(format!("системы ждут друг друга по кругу: {}", stuck.join(", ")));
    };
    done[next] = true;
    order.push(next);
  }
  let mut slots: Vec<Option<System>> = systems.into_iter().map(Some).collect();
  Ok(order.into_iter().map(|index| slots[index].take().expect("система")).collect())
}

/// Строка или список строк.
struct StringOrList(Vec<String>);

impl mlua::FromLua for StringOrList {
  fn from_lua(value: Value, lua: &Lua) -> mlua::Result<Self> {
    match value {
      Value::String(text) => Ok(Self(vec![text.to_str()?.to_string()])),
      other => Ok(Self(Vec::<String>::from_lua(other, lua)?)),
    }
  }
}

/// Таблица запроса: `n`, `entity` и по компоненту — таблица буферов f64 его числовых полей.
fn columns(lua: &Lua, world: &World, components: &[ComponentId], entities: &[Entity]) -> mlua::Result<Table> {
  let query = lua.create_table();
  query.raw_set("n", entities.len())?;
  query.raw_set("entity", lua.create_buffer(entities.iter().flat_map(|&entity| (entity as f64).to_le_bytes()).collect::<Vec<u8>>())?)?;
  for &component in components {
    let def = &world.schema.components[component];
    let store = &world.stores[component];
    let rows: Vec<usize> = entities.iter().map(|&entity| store.row(entity).expect("сущность из запроса")).collect();
    let table = lua.create_table();
    for field in def.fields.iter().filter(|field| field.kind.columnar()) {
      let column = &store.nums[field.slot];
      let mut bytes = Vec::with_capacity(rows.len() * 8);
      for &row in &rows {
        bytes.extend_from_slice(&column[row].to_le_bytes());
      }
      table.raw_set(field.name.as_str(), lua.create_buffer(bytes)?)?;
    }
    query.raw_set(def.name.as_str(), table)?;
  }
  Ok(query)
}

/// Забирает из буферов запроса столбцы компонентов write.
fn write_back(world: &mut World, query: &Table, write: &[ComponentId], entities: &[Entity]) -> mlua::Result<()> {
  let schema = world.schema.clone();
  for &component in write {
    let def = &schema.components[component];
    let table: Table = query.raw_get(def.name.as_str())?;
    let rows: Vec<usize> = entities.iter().map(|&entity| world.stores[component].row(entity).expect("сущность из запроса")).collect();
    for field in def.fields.iter().filter(|field| field.kind.columnar()) {
      let buffer: mlua::Buffer = table.raw_get(field.name.as_str())?;
      let bytes = buffer.to_vec();
      let column = &mut world.stores[component].nums[field.slot];
      for (at, &row) in rows.iter().enumerate() {
        column[row] = f64::from_le_bytes(bytes[at * 8..at * 8 + 8].try_into().expect("8 байт"));
      }
    }
  }
  Ok(())
}

/// Выполняет отложенные команды по порядку.
fn apply(state: &mut State) -> Result<(), Error> {
  let position = state.world.schema.id("Position").expect("Position");
  for op in std::mem::take(&mut state.ops) {
    match op {
      Op::Spawn(entity, components) => {
        state.world.revive(entity);
        for (component, values) in components {
          state.world.add(entity, component, &values)?;
        }
        state.grid = None;
        // Событие видам: новую сущность можно доснарядить (турели на носителе и т. п.).
        let proto = state.world.schema.id("Proto").and_then(|id| state.world.num(entity, id, "id"));
        state.events.push(("spawned".into(), serde_json::json!({ "entity": entity, "proto": proto })));
      }
      Op::Destroy(entity) => {
        state.world.destroy(entity);
        state.grid = None;
      }
      // Пропавшей к этому времени сущности команды не нужны: её мог убрать кто-то раньше в том же тике.
      Op::Add(entity, component, values) => {
        if state.world.alive(entity) {
          state.world.add(entity, component, &values)?;
          state.grid = if component == position { None } else { state.grid.take() };
        }
      }
      Op::Set(entity, component, values) => {
        if state.world.alive(entity) && state.world.has(entity, component) {
          state.world.set(entity, component, &values)?;
          state.grid = if component == position { None } else { state.grid.take() };
        }
      }
      Op::Remove(entity, component) => state.world.remove(entity, component),
    }
  }
  Ok(())
}

/// `ctx` в скриптах хоста.
struct Ctx {
  state: Rc<RefCell<State>>,
  protos: Table,
  /// Вид партии из `games/`.
  game: Table,
  storage: Table,
  /// Раздел и имя вида по номеру.
  list: Vec<(String, String)>,
}

impl Ctx {
  fn component(&self, name: &str) -> mlua::Result<ComponentId> {
    self.state.borrow().world.schema.id(name).ok_or_else(|| mlua::Error::runtime(format!("нет компонента {name}")))
  }

  /// Вид по значению: таблица вида, номер или `раздел/имя`.
  fn proto(&self, kind: &Value) -> mlua::Result<(u32, Table)> {
    let id = match kind {
      Value::Table(table) => table.get::<u32>("id")?,
      Value::Integer(id) => *id as u32,
      Value::Number(id) => *id as u32,
      Value::String(text) => {
        let text = text.to_str()?.to_string();
        let (section, name) = text.split_once('/').ok_or_else(|| mlua::Error::runtime(format!("вид «{text}»: нужно раздел/имя")))?;
        self.list.iter().position(|(s, n)| s == section && n == name).ok_or_else(|| mlua::Error::runtime(format!("нет вида {text}")))? as u32
      }
      other => return Err(mlua::Error::runtime(format!("вид — таблица, номер или раздел/имя, а не {}", other.type_name()))),
    };
    let (section, name) = self.list.get(id as usize).ok_or_else(|| mlua::Error::runtime(format!("нет вида с номером {id}")))?;
    let table = self.protos.get::<Table>(section.as_str())?.get::<Table>(name.as_str())?;
    Ok((id, table))
  }

  /// Значения компонентов из таблицы `{ Компонент = { поле = значение } }`.
  fn components(&self, lua: &Lua, table: Table) -> mlua::Result<BTreeMap<String, Map<String, Json>>> {
    let mut result = BTreeMap::new();
    for pair in table.pairs::<String, Value>() {
      let (component, values) = pair?;
      let values: Json = lua.from_value(values)?;
      let values = match values {
        Json::Object(map) => map,
        // Пустая таблица Luau — и пустой список, и пустой объект.
        Json::Array(list) if list.is_empty() => Map::new(),
        other => return Err(mlua::Error::runtime(format!("{component}: нужны поля, а не {other}"))),
      };
      result.insert(component, values);
    }
    Ok(result)
  }

  fn values(&self, lua: &Lua, values: Option<Value>) -> mlua::Result<Map<String, Json>> {
    match values {
      None | Some(Value::Nil) => Ok(Map::new()),
      Some(value) => match lua.from_value::<Json>(value)? {
        Json::Object(map) => Ok(map),
        Json::Array(list) if list.is_empty() => Ok(Map::new()),
        other => Err(mlua::Error::runtime(format!("нужны поля, а не {other}"))),
      },
    }
  }

  fn random(&self) -> f64 {
    let mut state = self.state.borrow_mut();
    // splitmix64: один и тот же ряд на всех платформах.
    state.rng = state.rng.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = state.rng;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64
  }
}

fn entity_of(value: f64) -> mlua::Result<Entity> {
  if value >= 1.0 && value.fract() == 0.0 && value <= u32::MAX as f64 {
    Ok(value as Entity)
  } else {
    Err(mlua::Error::runtime(format!("{value} — не номер сущности")))
  }
}

impl UserData for Ctx {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("tick", |_, this| Ok(this.state.borrow().tick));
    fields.add_field_method_get("dt", |_, this| Ok(this.state.borrow().dt));
    // Шаг тика в секундах — то же, что dt; у клиента dt — кадр, а step — тик.
    fields.add_field_method_get("step", |_, this| Ok(this.state.borrow().dt));
    fields.add_field_method_get("storage", |_, this| Ok(this.storage.clone()));
    fields.add_field_method_get("protos", |_, this| Ok(this.protos.clone()));
    fields.add_field_method_get("game", |_, this| Ok(this.game.clone()));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // Новая сущность вида kind: компоненты из `entity` вида (таблица или функция от вида), поверх — fields. kind = nil —
    // сущность без вида (игрок, память механики). Номер известен сразу, а появится сущность после системы.
    methods.add_method("spawn", |lua, this, (kind, fields): (Value, Option<Table>)| {
      let mut components = BTreeMap::new();
      if !kind.is_nil() {
        let (id, proto) = this.proto(&kind)?;
        let template = match proto.get::<Value>("entity")? {
          // Шаблон-функция получает свой вид и все виды: обзор, например, зависит от дальности оружия турелей.
          Value::Function(make) => make.call::<Option<Table>>((&proto, &this.protos))?,
          Value::Table(table) => Some(table),
          Value::Nil => None,
          other => return Err(mlua::Error::runtime(format!("entity вида — таблица или функция, а не {}", other.type_name()))),
        };
        if let Some(table) = template {
          components = this.components(lua, table)?;
        }
        components.insert("Proto".into(), Map::from_iter([("id".to_string(), Json::from(id))]));
      }
      if let Some(fields) = fields {
        for (component, values) in this.components(lua, fields)? {
          components.entry(component).or_default().extend(values);
        }
      }
      let mut list = Vec::new();
      for (component, values) in components {
        list.push((this.component(&component)?, values));
      }
      let mut state = this.state.borrow_mut();
      let entity = state.world.reserve();
      state.ops.push(Op::Spawn(entity, list));
      Ok(entity)
    });
    // Применяет накопленные правки мира сразу, а не после обработчика: так готовая база (сценка витрины, песочница)
    // ставит здание за зданием и видит, что место уже занято (placeBuilding в TS пишет в мир сразу).
    methods.add_method("flush", |_, this, ()| apply(&mut this.state.borrow_mut()).map_err(mlua::Error::runtime));
    methods.add_method("destroy", |_, this, entity: f64| {
      this.state.borrow_mut().ops.push(Op::Destroy(entity_of(entity)?));
      Ok(())
    });
    methods.add_method("add", |lua, this, (entity, component, values): (f64, String, Option<Value>)| {
      let op = Op::Add(entity_of(entity)?, this.component(&component)?, this.values(lua, values)?);
      this.state.borrow_mut().ops.push(op);
      Ok(())
    });
    methods.add_method("set", |lua, this, (entity, component, values): (f64, String, Value)| {
      let op = Op::Set(entity_of(entity)?, this.component(&component)?, this.values(lua, Some(values))?);
      this.state.borrow_mut().ops.push(op);
      Ok(())
    });
    methods.add_method("remove", |_, this, (entity, component): (f64, String)| {
      let op = Op::Remove(entity_of(entity)?, this.component(&component)?);
      this.state.borrow_mut().ops.push(op);
      Ok(())
    });
    // Значение компонента сейчас — таблицей; нет — nil. Изменения в буферах идущей системы сюда ещё не попали.
    methods.add_method("get", |lua, this, (entity, component): (f64, String)| {
      let id = this.component(&component)?;
      let value = this.state.borrow().world.get(entity_of(entity)?, id);
      match value {
        Some(map) => kharos_content::vm::to_lua(lua, &Json::Object(map)),
        None => Ok(Value::Nil),
      }
    });
    methods.add_method("has", |_, this, (entity, component): (f64, String)| {
      let id = this.component(&component)?;
      Ok(this.state.borrow().world.has(entity_of(entity)?, id))
    });
    methods.add_method("alive", |_, this, entity: f64| Ok(entity_of(entity).is_ok_and(|entity| this.state.borrow().world.alive(entity))));
    // Запрос из системы: та же таблица столбцов, только на чтение.
    methods.add_method("query", |lua, this, components: Vec<String>| {
      let ids = components.iter().map(|name| this.component(name)).collect::<mlua::Result<Vec<_>>>()?;
      let state = this.state.borrow();
      let entities = state.world.query(&ids);
      columns(lua, &state.world, &ids, &entities)
    });
    // Сущности со всеми компонентами списком, по возрастанию номеров — как c:each у клиента: правилам, общим хосту
    // и клиенту (lib/), столбцы не нужны.
    methods.add_method("each", |_, this, components: Vec<String>| {
      let ids = components.iter().map(|name| this.component(name)).collect::<mlua::Result<Vec<_>>>()?;
      let mut entities = this.state.borrow().world.query(&ids);
      entities.sort_unstable();
      Ok(entities)
    });
    // Сущности с Position в круге (x, y, r), по возрастанию номеров; components — ещё и с ними.
    methods.add_method("near", |_, this, (x, y, radius, components): (f64, f64, f64, Option<Vec<String>>)| {
      let ids = components.unwrap_or_default().iter().map(|name| this.component(name)).collect::<mlua::Result<Vec<_>>>()?;
      let mut state = this.state.borrow_mut();
      if state.grid.is_none() {
        state.grid = Some(Grid::build(&state.world));
      }
      let grid = state.grid.as_ref().expect("сетка");
      let mut found = Vec::new();
      let (left, right) = (((x - radius) / CELL).floor() as i32, ((x + radius) / CELL).floor() as i32);
      let (top, bottom) = (((y - radius) / CELL).floor() as i32, ((y + radius) / CELL).floor() as i32);
      for cy in top..=bottom {
        for cx in left..=right {
          for &(entity, ex, ey) in grid.cells.get(&(cx, cy)).map(Vec::as_slice).unwrap_or(&[]) {
            if (ex - x).powi(2) + (ey - y).powi(2) <= radius * radius && ids.iter().all(|&id| state.world.has(entity, id)) {
              found.push(entity);
            }
          }
        }
      }
      found.sort_unstable();
      Ok(found)
    });
    // Номер строки для сравнения со столбцом поля `Str` и обратно.
    methods.add_method("id", |_, this, text: String| Ok(this.state.borrow_mut().world.strings.id(&text)));
    methods.add_method("text", |_, this, id: f64| Ok(this.state.borrow().world.strings.text(id as u32).to_string()));
    methods.add_method("proto", |_, this, kind: Value| Ok(this.proto(&kind)?.1));
    methods.add_method("emit", |lua, this, (name, payload): (String, Option<Value>)| {
      let payload: Json = lua.from_value(payload.unwrap_or(Value::Nil))?;
      this.state.borrow_mut().events.push((name, payload));
      Ok(())
    });
    methods.add_method("signal", |lua, this, (name, payload): (String, Option<Value>)| {
      let payload: Json = lua.from_value(payload.unwrap_or(Value::Nil))?;
      this.state.borrow_mut().signals.push(Signal { name, payload });
      Ok(())
    });
    // Случайное, одинаковое у всех, кто считает тот же мир: random() — [0, 1), random(n) — 1..n, random(a, b) — a..b.
    methods.add_method("random", |_, this, args: MultiValue| {
      let value = this.random();
      let numbers: Vec<f64> = args.iter().filter_map(|value| value.as_f64()).collect();
      Ok(match numbers.as_slice() {
        [] => value,
        [n] => (value * n.floor()).floor() + 1.0,
        [a, b, ..] => a.floor() + (value * (b.floor() - a.floor() + 1.0)).floor(),
      })
    });
    // Пакетный инструмент: расталкивает сущности запроса q (нужны Position и Unit.radius в нём), чтобы корпуса не
    // перекрывались; strength — доля перекрытия, снимаемая за вызов. Пишет прямо в буферы q.Position — вернутся с
    // write системы. Стоящий (moving = 0 в q.Drive, если он есть) уступает идущему втрое охотнее.
    methods.add_method("separate", |_, _, (query, strength): (Table, Option<f64>)| {
      let strength = strength.unwrap_or(0.5);
      let n: usize = query.raw_get("n")?;
      let position: Table = query.raw_get("Position")?;
      let unit: Table = query.raw_get("Unit")?;
      let (xs, ys): (mlua::Buffer, mlua::Buffer) = (position.raw_get("x")?, position.raw_get("y")?);
      let radii: mlua::Buffer = unit.raw_get("radius")?;
      let moving: Option<mlua::Buffer> = query.raw_get::<Option<Table>>("Drive")?.map(|drive| drive.raw_get("moving")).transpose()?;
      let read = |buffer: &mlua::Buffer| -> Vec<f64> { buffer.to_vec().chunks_exact(8).map(|bytes| f64::from_le_bytes(bytes.try_into().expect("8 байт"))).collect() };
      let (mut x, mut y, radius) = (read(&xs), read(&ys), read(&radii));
      let moving = moving.map(|buffer| read(&buffer)).unwrap_or_else(|| vec![0.0; n]);
      let largest = radius.iter().copied().fold(0.25, f64::max);
      let cell = largest * 2.0;
      // Плоская хеш-сетка: голова списка по корзине и следующий в клетке — без выделений на клетку.
      let size = (n * 2).next_power_of_two().max(16);
      let mask = size - 1;
      let coords: Vec<(i32, i32)> = (0..n).map(|i| ((x[i] / cell).floor() as i32, (y[i] / cell).floor() as i32)).collect();
      let bucket = |(cx, cy): (i32, i32)| ((cx as u32).wrapping_mul(73856093) ^ (cy as u32).wrapping_mul(19349663)) as usize & mask;
      let mut head = vec![usize::MAX; size];
      let mut next = vec![usize::MAX; n];
      for i in 0..n {
        let b = bucket(coords[i]);
        next[i] = head[b];
        head[b] = i;
      }
      let (mut dx, mut dy) = (vec![0.0; n], vec![0.0; n]);
      for i in 0..n {
        let (cx, cy) = coords[i];
        for oy in -1..=1 {
          for ox in -1..=1 {
            let target = (cx + ox, cy + oy);
            let mut j = head[bucket(target)];
            while j != usize::MAX {
              let other = j;
              j = next[j];
              if other <= i || coords[other] != target {
                continue;
              }
              let (ex, ey) = (x[other] - x[i], y[other] - y[i]);
              let reach = radius[i] + radius[other];
              let distance_squared = ex * ex + ey * ey;
              if distance_squared >= reach * reach {
                continue;
              }
              let distance = distance_squared.sqrt();
              // Совпавшие точно — разводятся по номеру, одинаково у всех.
              let (ux, uy) = if distance > 1e-9 {
                (ex / distance, ey / distance)
              } else {
                let angle = (i * 7 + other * 13) as f64;
                (angle.cos(), angle.sin())
              };
              let overlap = (reach - distance) * strength;
              let (wi, wj) = (if moving[i] != 0.0 { 1.0 } else { 3.0 }, if moving[other] != 0.0 { 1.0 } else { 3.0 });
              let (si, sj) = (wi / (wi + wj), wj / (wi + wj));
              dx[i] -= ux * overlap * si;
              dy[i] -= uy * overlap * si;
              dx[other] += ux * overlap * sj;
              dy[other] += uy * overlap * sj;
            }
          }
        }
      }
      for i in 0..n {
        x[i] += dx[i];
        y[i] += dy[i];
      }
      let write = |mut buffer: mlua::Buffer, values: &[f64]| buffer.write_bytes(0, &values.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<u8>>());
      write(xs.clone(), &x);
      write(ys.clone(), &y);
      Ok(())
    });
    // Местность в тайле: вид (0 — болото, 1 — песок, 2 — скала, 3 — гора), биом (0 — эрг, 1 — солончаки, 2 — красные
    // пустоши, 3 — топи) и подножие ли обрыва; nil — у партии нет местности.
    methods.add_method("terrain", |_, this, (x, y): (f64, f64)| {
      let mut state = this.state.borrow_mut();
      let Some(land) = &mut state.land else { return Ok((None, None, None)) };
      let tile = land.tile(x.floor() as i32, y.floor() as i32);
      let foot = tile[0] != kharos_engine::terrain::MOUNTAIN && tile[3] & kharos_engine::terrain::FOOT_BIT != 0;
      Ok((Some(tile[0] & 3), Some(tile[1] >> 6), Some(foot)))
    });
    // Ход (motion). Приказ группе идти в тайл: каждому свой тайл рядом, наземные едут напрямую и ищут путь, только
    // упёршись (orderGroupMove).
    methods.add_method("move_group", |_, this, (units, x, y): (Vec<f64>, f64, f64)| {
      let units = units.into_iter().map(entity_of).collect::<mlua::Result<Vec<_>>>()?;
      this.state.borrow_mut().scene().order_group_move(&units, x.floor() as i32, y.floor() as i32);
      Ok(())
    });
    // Путь одному в тайл, с поиском (orderMove); near — подойти на столько тайлов; ignore — стоящие, сквозь которых
    // путь можно вести (подъедет — попросит посторониться), вместе с самим юнитом. → "set", "removed" или "kept".
    methods.add_method("move", |_, this, (entity, x, y, near, ignore): (f64, f64, f64, Option<f64>, Option<Vec<f64>>)| {
      let entity = entity_of(entity)?;
      let ignore = ignore.map(|list| list.into_iter().map(entity_of).collect::<mlua::Result<std::collections::HashSet<_>>>()).transpose()?;
      let moved = this.state.borrow_mut().scene().order_move(entity, x.floor() as i32, y.floor() as i32, ignore.as_ref(), 0.0, near.unwrap_or(0.0), None);
      Ok(match moved {
        crate::motion::Moved::Set => "set",
        crate::motion::Moved::Removed => "removed",
        crate::motion::Moved::Kept => "kept",
      })
    });
    // Бой (combat). Приказ атаковать (orderAttack): свои юниты игрока player и их турели берут цель и идут к ней.
    methods.add_method("attack", |_, this, (player, units, target): (f64, Vec<f64>, f64)| {
      let units = units.into_iter().map(entity_of).collect::<mlua::Result<Vec<_>>>()?;
      Ok(crate::combat::order_attack(&mut this.state.borrow_mut(), player, &units, entity_of(target)?))
    });
    // Стойка своим вооружённым юнитам (setStance): aggressive, defensive, hold, passive.
    methods.add_method("stance", |_, this, (player, units, stance): (f64, Vec<f64>, String)| {
      let units = units.into_iter().map(entity_of).collect::<mlua::Result<Vec<_>>>()?;
      Ok(crate::combat::set_stance(&mut this.state.borrow_mut(), player, &units, &stance))
    });
    // Встать: путь снимается.
    methods.add_method("stop", |_, this, entity: f64| {
      let entity = entity_of(entity)?;
      this.state.borrow_mut().scene().stop(entity);
      Ok(())
    });
    // Свободные тайлы вокруг тайла (freeTilesNear): count мест через тайл, от кольца from; x и y подряд.
    methods.add_method("free_tiles", |_, this, (x, y, count, from, air): (f64, f64, usize, Option<i32>, Option<bool>)| Ok(this.state.borrow_mut().scene().free_tiles(x.floor() as i32, y.floor() as i32, count, from.unwrap_or(0), air.unwrap_or(false))));
    // Наземные юниты, чей центр в прямоугольнике тайлов (x, y — левый верхний угол), по возрастанию номеров.
    methods.add_method("units_in", |_, this, (x, y, width, height): (f64, f64, f64, f64)| Ok(this.state.borrow_mut().scene().units_in(x, y, width, height)));
    // Выгнать юнитов units из прямоугольника на свободные тайлы рядом (evictUnits); radius — запас вокруг стоящих.
    methods.add_method("evict", |_, this, (units, x, y, width, height, radius): (Vec<f64>, f64, f64, f64, f64, Option<f64>)| {
      let units = units.into_iter().map(entity_of).collect::<mlua::Result<Vec<_>>>()?;
      this.state.borrow_mut().scene().evict(&units, x, y, width, height, radius.unwrap_or(0.0));
      Ok(())
    });
    // Сколько тайлов (не больше limit) техника объедет из тайла заливкой (vehicleReach) и, если дан тайл (tx, ty), —
    // попал ли он в эту заливку.
    methods.add_method("reach", |_, this, (x, y, limit, tx, ty): (f64, f64, usize, Option<f64>, Option<f64>)| {
      let probe = tx.zip(ty).map(|(tx, ty)| (tx.floor() as i32, ty.floor() as i32));
      Ok(this.state.borrow_mut().scene().reach_to(x.floor() as i32, y.floor() as i32, limit, probe))
    });
    // Тайлы, куда техника доедет из тайла заливкой (vehicleReach), не больше limit: x, y подряд.
    methods.add_method("reach_tiles", |_, this, (x, y, limit): (f64, f64, usize)| Ok(this.state.borrow_mut().scene().reach_tiles(x.floor() as i32, y.floor() as i32, limit)));
    // Можно ли юниту рода class (vehicle, heavy, infantry, air) встать в тайл.
    methods.add_method("can_stand", |_, this, (class, x, y): (String, f64, f64)| Ok(this.state.borrow_mut().scene().can_stand(&class, x.floor() as i32, y.floor() as i32)));
    // Проходим ли тайл наземному (isWalkable): внутри карты, по проходимой местности, не сквозь здание; foot — пехоте
    // можно и у подножия обрыва.
    methods.add_method("walkable", |_, this, (x, y, foot): (f64, f64, Option<bool>)| Ok(this.state.borrow_mut().scene().walkable(x.floor() as i32, y.floor() as i32, foot.unwrap_or(false))));
    // Видит ли игрок тайл сейчас; без тумана — всё.
    methods.add_method("sees", |_, this, (player, x, y): (f64, f64, f64)| Ok(this.state.borrow().vision.as_ref().is_none_or(|vision| vision.sees(player as u32, x, y))));
    // Бывал ли тайл в виду игрока; без тумана — всё.
    methods.add_method("explored", |_, this, (player, x, y): (f64, f64, f64)| Ok(this.state.borrow().vision.as_ref().is_none_or(|vision| vision.explored(player as u32, x, y))));
    // Хранимые байты тайла земли (tileBytes): вид, биом, байт вершины, рельеф (ярус, CLIFF_BIT, барханы); nil — земли нет.
    methods.add_method("tile", |_, this, (x, y): (f64, f64)| {
      let mut state = this.state.borrow_mut();
      Ok(match state.land.as_mut().map(|land| land.stored(x.floor() as i32, y.floor() as i32)) {
        Some([a, b, c, d]) => (Some(a), Some(b), Some(c), Some(d)),
        None => (None, None, None, None),
      })
    });
    // Вершина горы, частью которой стоит тайл (peakOf): x, y и радиус; не гора — nil.
    methods.add_method("peak", |_, this, (x, y): (f64, f64)| {
      let mut state = this.state.borrow_mut();
      Ok(match state.land.as_mut().and_then(|land| land.peak_of(x.floor() as i32, y.floor() as i32)) {
        Some((px, py, radius)) => (Some(px), Some(py), Some(radius)),
        None => (None, None, None),
      })
    });
    // Правит землю пакетом (setTile, editTile в landMemory.ts): x, y и четыре хранимых байта подряд. Правку другие
    // игроки узнают, только увидев (memory.rs).
    // truth — правка редактора (paint в editor.ts): сразу правда для всех, как будто мир таким и сгенерирован; знание
    // игроков о тайле забывается.
    methods.add_method("edit_tiles", |_, this, (flat, truth): (Vec<f64>, Option<bool>)| {
      let mut state = this.state.borrow_mut();
      let State { land, memory, .. } = &mut *state;
      let Some(land) = land.as_mut() else { return Ok(()) };
      land.begin_batch();
      for tile in flat.chunks(6).filter(|tile| tile.len() == 6) {
        let (x, y, bytes) = (tile[0].floor() as i32, tile[1].floor() as i32, [tile[2] as u8, tile[3] as u8, tile[4] as u8, tile[5] as u8]);
        if truth == Some(true) {
          land.write_tile(x, y, bytes);
          memory.land.forget(x, y, land.stored(x, y));
        } else {
          memory.land.edit(land, x, y, bytes);
        }
      }
      land.end_batch();
      Ok(())
    });
    // Система движка по имени (tools.rs) сразу, вне тика: редактор ставит турели на носители (settle в editor.ts).
    methods.add_method("engine", |_, this, name: String| {
      let mut state = this.state.borrow_mut();
      apply(&mut state).map_err(mlua::Error::runtime)?;
      let run = crate::tools::find(&name).ok_or_else(|| mlua::Error::runtime(format!("нет системы движка {name}")))?;
      run(&mut state);
      Ok(())
    });
    // Помнит ли кто-нибудь ушедшее (memory.rs), чья середина в прямоугольнике [x1, x2) × [y1, y2): там его призрак.
    methods.add_method("remembered_in", |_, this, (x1, y1, x2, y2): (f64, f64, f64, f64)| {
      let state = this.state.borrow();
      let gone = |entity: &Entity| !state.world.alive(*entity);
      Ok(state.memory.known.values().flat_map(|known| known.iter()).any(|(entity, record)| gone(entity) && record.x >= x1 && record.x < x2 && record.y >= y1 && record.y < y2))
    });
    // Доля полной скорости рода class радиусом radius на тайле.
    methods.add_method("terrain_speed", |_, this, (class, x, y, radius): (String, f64, f64, Option<f64>)| Ok(this.state.borrow_mut().scene().terrain_speed(&class, radius.unwrap_or(0.0), x.floor() as i32, y.floor() as i32)));
    // Слои карты (tiles.rs): значение канала тайла (0 — пусто), запись и непустые тайлы прямоугольника —
    // x, y, значение подряд.
    methods.add_method("layer", |_, this, (name, x, y, channel): (String, f64, f64, Option<usize>)| {
      let state = this.state.borrow();
      let id = crate::tiles::id(&state.layers, &name)?;
      let channel = crate::tiles::channel(&state.layers, id, channel)?;
      Ok(state.layers.get(id, kharos_engine::layers::Owner::World, x.floor() as i32, y.floor() as i32, channel))
    });
    methods.add_method("set_layer", |_, this, (name, x, y, value, channel): (String, f64, f64, f64, Option<usize>)| {
      let mut state = this.state.borrow_mut();
      let id = crate::tiles::id(&state.layers, &name)?;
      let channel = crate::tiles::channel(&state.layers, id, channel)?;
      state.layers.set(id, kharos_engine::layers::Owner::World, x.floor() as i32, y.floor() as i32, channel, value);
      state.memory.touch(id, x.floor() as i32, y.floor() as i32);
      Ok(())
    });
    methods.add_method("layer_in", |_, this, (name, x, y, width, height, channel): (String, f64, f64, f64, f64, Option<usize>)| {
      let state = this.state.borrow();
      let id = crate::tiles::id(&state.layers, &name)?;
      let channel = crate::tiles::channel(&state.layers, id, channel)?;
      let (left, top) = (x.floor() as i32, y.floor() as i32);
      Ok(crate::tiles::within(&state.layers, id, channel, left, top, left + width.ceil() as i32, top + height.ceil() as i32))
    });
    // Здание на тайле (Footprint) или nil.
    methods.add_method("occupant", |_, this, (x, y): (f64, f64)| Ok(this.state.borrow_mut().scene().occupant(x.floor() as i32, y.floor() as i32)));
    // Сид местности партии.
    methods.add_method("seed", |_, this, ()| Ok(this.state.borrow().land.as_ref().map(|land| land.config.seed)));
    // Случайное 0..1 от координат и сида — тот же hash, что у генератора местности TS.
    methods.add_function("hash", |_, (x, y, seed): (f64, f64, f64)| Ok(kharos_engine::terrain::hash(x, y, seed)));
    // Сети (networks.rs): энергосети всех игроков — { player, members = { … }, circles = { x, y, r, … } } по порядку
    // игроков, у каждого — сначала с ядром; networks — сети связности, с рёбрами edges = { a, b, длина, … }.
    methods.add_method("grids", |lua, this, ()| {
      let mut state = this.state.borrow_mut();
      let State { world, networks, .. } = &mut *state;
      crate::networks::to_lua(lua, networks.grids(world), false)
    });
    methods.add_method("networks", |lua, this, ()| {
      let mut state = this.state.borrow_mut();
      let State { world, networks, .. } = &mut *state;
      crate::networks::to_lua(lua, networks.networks(world), true)
    });
    // Кратчайшие пути по трубам сети от узла: { [узел] = длина } по всей его сети; не в сети — nil.
    methods.add_method("distances", |lua, this, start: f64| {
      let mut state = this.state.borrow_mut();
      let State { world, networks, .. } = &mut *state;
      match networks.distances(world, entity_of(start)?) {
        Some(routes) => {
          let table = lua.create_table();
          for (&node, &length) in &routes.dist {
            table.raw_set(node, length)?;
          }
          Ok(Some(table))
        }
        None => Ok(None),
      }
    });
    // Путь по сети от from к to: узлы, где он поворачивает, с началом и концом; пусто — пути нет.
    methods.add_method("route", |_, this, (from, to): (f64, f64)| {
      let mut state = this.state.borrow_mut();
      let State { world, networks, .. } = &mut *state;
      Ok(networks.route(world, entity_of(from)?, entity_of(to)?))
    });
    // Номер пересчёта сетей: пока он тот же, сети те же.
    methods.add_method("network_version", |_, this, ()| {
      let mut state = this.state.borrow_mut();
      let State { world, networks, .. } = &mut *state;
      Ok(networks.version(world))
    });
    methods.add_method("count", |_, this, component: String| {
      let id = this.component(&component)?;
      Ok(this.state.borrow().world.stores[id].len())
    });
  }
}

