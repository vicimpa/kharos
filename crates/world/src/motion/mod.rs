//! Ход юнитов — инструмент движка, перенос `crates/sim` (walk.rs, systems/movement.rs) — а значит, и TS (units.ts,
//! movement.ts, path.ts): тот же порядок, та же арифметика. Что юнит умеет — компонент движка `Mover` (скорость,
//! поворот, радиус, род), куда идёт — `Path`; здания занимают тайлы `Footprint`. Как быстро род идёт по местности —
//! правила партии (`data.rules`: vehicleSand, vehicleSwamp, heavySwamp, infantryCliff, frozenSwamp…).
//!
//! Системы `plan_paths` и `move_units` вид ставит в тик сам (`engine = "move_units"`), приказы дают механики:
//! `ctx:move_group`, `ctx:move`, `ctx:stop`, свободные тайлы — `ctx:free_tiles`.

pub mod path;

use crate::schema::ComponentId;
use crate::vision::Bounds;
use crate::world::{Entity, World};
use kharos_engine::math::{js_atan2, js_cos, js_hypot, js_sin, turn_toward, wrap};
use kharos_engine::terrain::{Land, FOOT_BIT, MOUNTAIN, SAND, SWAMP};
use path::{beyond_window, is_clear, smooth_path, Grid, Search, SEARCH_LIMIT};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Во сколько раз быстрее, чем по голой скале, идут по дороге.
pub const ROAD_SPEED: f64 = 1.5;
/// Медленнее этой доли скорости местность не замедляет.
const SLOWEST: f64 = 0.05;
/// После скольких перепрокладок подряд юнит считается застрявшим в заторе.
pub const JAM_TRIES: f64 = 3.0;
/// Сколько тайлов осматривает поиск, когда к цели надо только подойти на расстояние.
const APPROACH_LIMIT: f64 = 3000.0;
/// Дальше скольких колец от цели места группе не ищутся.
const MAX_GROUP_RADIUS: i32 = 40;
/// Шаг между местами юнитов в группе, в тайлах.
const GROUP_SPACING: i32 = 2;
/// Во сколько раз дольше ищется путь, если обычный поиск не дошёл до цели.
const LONG_SEARCH: f64 = 4.0;
/// Сколько тайлов заливает проверка кармана перед долгим поиском.
const LONG_POCKET: usize = 1000;
/// На сколько колец от цели, в которую не встать, ищется тайл, куда встать можно.
const STAND_RADIUS: i32 = 8;
/// Номер солончаков в биоме тайла.
const SALT_FLATS: u8 = 1;

// Ход (movement.ts).
const WAIT_TICKS: f64 = 30.0;
const SLIDE_TICKS: f64 = 4.0;
const PROGRESS: f64 = 0.05;
const MAX_TRIES: f64 = JAM_TRIES;
const GIVE_UP_REACH: f64 = 4.0;
const REACHED: f64 = 0.6;
const SETTLE: f64 = 1.0;
const ORBIT_MARGIN: f64 = 1.3;
const HORIZON: f64 = 1.2;
const AIMED: f64 = 0.05;
const GAP: f64 = 0.1;
const AVOIDANCE: f64 = 2.0;
const SEPARATIONS: usize = 2;
const LOST_SEARCHES: usize = 8;
const LOST_TILES: f64 = 8000.0;
const SENSE: f64 = 2.5;
const CELL: f64 = 2.0;
const DRIFT: f64 = 1.0;
const LARGE: f64 = 0.9;
/// Сколько тайлов за тик осматривают поиски пути упёршихся юнитов, ехавших напрямую.
const PLAN_TILES: f64 = 20000.0;

type Tiles = HashSet<(i32, i32)>;

/// Правила хода партии: доли замедления по родам и местности.
#[derive(Clone, Debug, Default)]
pub struct Rules(pub Map<String, Value>);

impl Rules {
  pub fn get(&self, name: &str) -> f64 {
    self.0.get(name).and_then(Value::as_f64).unwrap_or(0.0)
  }

  /// Замедления по родам, разобранные один раз: песок и болото по роду, подножие обрыва пехоте, мороз солончаков.
  fn speeds(&self) -> Speeds {
    let by = |what: &str| Class::ALL.map(|class| self.get(&format!("{}{what}", class.name())));
    Speeds { sand: by("Sand"), swamp: by("Swamp"), cliff: self.get("infantryCliff"), frozen: self.get("frozenSwamp") }
  }
}

#[derive(Clone, Copy)]
struct Speeds {
  sand: [f64; 4],
  swamp: [f64; 4],
  cliff: f64,
  frozen: f64,
}

/// Род юнита: по нему — где ему стоять и как его замедляет местность.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
  Vehicle,
  Heavy,
  Infantry,
  Air,
}

impl Class {
  const ALL: [Class; 4] = [Class::Vehicle, Class::Heavy, Class::Infantry, Class::Air];

  pub fn parse(text: &str) -> Class {
    match text {
      "heavy" => Class::Heavy,
      "infantry" => Class::Infantry,
      "air" => Class::Air,
      _ => Class::Vehicle,
    }
  }

  fn name(self) -> &'static str {
    match self {
      Class::Vehicle => "vehicle",
      Class::Heavy => "heavy",
      Class::Infantry => "infantry",
      Class::Air => "air",
    }
  }
}

/// Занятость: тайл → здание, собирается заново, когда меняется состав мира.
#[derive(Default)]
pub struct Occupancy {
  tiles: HashMap<(i32, i32), Entity>,
  revision: Option<u64>,
}

impl Occupancy {
  /// Тайлы основания с серединой (x, y), шириной w и высотой h.
  pub fn tiles_of(x: f64, y: f64, width: f64, height: f64) -> (i32, i32, i32, i32) {
    let left = (x - width / 2.0).round() as i32;
    let top = (y - height / 2.0).round() as i32;
    (left, top, left + width.round() as i32, top + height.round() as i32)
  }

  fn refresh(&mut self, world: &World) {
    if self.revision == Some(world.revision) {
      return;
    }
    self.revision = Some(world.revision);
    self.tiles.clear();
    let schema = &world.schema;
    let (Some(footprint), Some(position)) = (schema.id("Footprint"), schema.id("Position")) else { return };
    let (width, height) = (slot(world, footprint, "width"), slot(world, footprint, "height"));
    let store = &world.stores[footprint];
    for (row, &entity) in store.entities.iter().enumerate() {
      let Some(place) = world.stores[position].row(entity) else { continue };
      let (x, y) = (world.stores[position].nums[0][place], world.stores[position].nums[1][place]);
      let (left, top, right, bottom) = Self::tiles_of(x, y, store.nums[width][row], store.nums[height][row]);
      for tile_y in top..bottom {
        for tile_x in left..right {
          self.tiles.insert((tile_x, tile_y), entity);
        }
      }
    }
  }

  pub fn at(&self, x: i32, y: i32) -> Option<Entity> {
    self.tiles.get(&(x, y)).copied()
  }
}

/// Состояние хода между тиками: поиски пути с их нормой, где тела были тиком раньше, занятость.
#[derive(Default)]
pub struct Motion {
  pub search: Search,
  prev: HashMap<Entity, (f64, f64)>,
  pub occupancy: Occupancy,
}

impl Motion {
  /// Где тела были тиком раньше — для сохранения (у TS это prevX, prevY в Unit).
  pub fn save(&self) -> Value {
    let mut list: Vec<(&Entity, &(f64, f64))> = self.prev.iter().collect();
    list.sort_by_key(|(entity, _)| **entity);
    Value::Array(list.into_iter().map(|(entity, (x, y))| json!([entity, x, y])).collect())
  }

  pub fn load(&mut self, saved: &Value) {
    self.prev.clear();
    for item in saved.as_array().into_iter().flatten() {
      if let (Some(entity), Some(x), Some(y)) = (item.get(0).and_then(Value::as_u64), item.get(1).and_then(Value::as_f64), item.get(2).and_then(Value::as_f64)) {
        self.prev.insert(entity as Entity, (x, y));
      }
    }
  }
}

fn slot(world: &World, component: ComponentId, field: &str) -> usize {
  world.schema.components[component].field(field).map_or(0, |field| field.slot)
}

/// Номера компонентов и столбцов хода — один раз на вызов.
struct Cols {
  position: ComponentId,
  facing: ComponentId,
  owner: ComponentId,
  mover: ComponentId,
  path: ComponentId,
  footprint: ComponentId,
  player: ComponentId,
  speed: usize,
  turn: usize,
  radius: usize,
  class: usize,
  rooted: usize,
  points: usize,
  passable: usize,
  goal_x: usize,
  goal_y: usize,
  wait: usize,
  tries: usize,
  near: usize,
  best: usize,
  direct: usize,
  stuck: usize,
}

impl Cols {
  fn of(world: &World) -> Self {
    let id = |name: &str| world.schema.id(name).expect("компонент движка");
    let (mover, path, footprint) = (id("Mover"), id("Path"), id("Footprint"));
    Self { position: id("Position"), facing: id("Facing"), owner: id("Owner"), mover, path, footprint, player: id("Player"), speed: slot(world, mover, "speed"), turn: slot(world, mover, "turn"), radius: slot(world, mover, "radius"), class: slot(world, mover, "class"), rooted: slot(world, mover, "rooted"), points: slot(world, path, "points"), passable: slot(world, footprint, "passable"), goal_x: slot(world, path, "goalX"), goal_y: slot(world, path, "goalY"), wait: slot(world, path, "wait"), tries: slot(world, path, "tries"), near: slot(world, path, "near"), best: slot(world, path, "best"), direct: slot(world, path, "direct"), stuck: slot(world, path, "stuck") }
  }

  fn num(&self, world: &World, component: ComponentId, slot: usize, entity: Entity) -> Option<f64> {
    let store = &world.stores[component];
    store.row(entity).map(|row| store.nums[slot][row])
  }

  fn position(&self, world: &World, entity: Entity) -> Option<(f64, f64)> {
    let store = &world.stores[self.position];
    store.row(entity).map(|row| (store.nums[0][row], store.nums[1][row]))
  }

  fn facing(&self, world: &World, entity: Entity) -> f64 {
    self.num(world, self.facing, 0, entity).unwrap_or(0.0)
  }

  /// Ход сущности: скорость, поворот, радиус, род, стоит ли на месте.
  fn spec(&self, world: &World, entity: Entity) -> Option<Spec> {
    let store = &world.stores[self.mover];
    let row = store.row(entity)?;
    let class = Class::parse(world.strings.text(store.nums[self.class][row] as u32));
    Some(Spec { speed: store.nums[self.speed][row], turn: store.nums[self.turn][row], radius: store.nums[self.radius][row], class, rooted: store.nums[self.rooted][row] != 0.0 })
  }
}

#[derive(Clone, Copy)]
struct Spec {
  speed: f64,
  turn: f64,
  radius: f64,
  class: Class,
  rooted: bool,
}

impl Spec {
  fn air(&self) -> bool {
    self.class == Class::Air
  }

  fn foot(&self) -> bool {
    self.class == Class::Infantry
  }

  /// Самая высокая доля скорости, какая бывает у юнита (`fastestOf`).
  fn fastest(&self) -> f64 {
    match self.class {
      Class::Heavy | Class::Air => 1.0,
      _ => ROAD_SPEED,
    }
  }
}

/// Мир и всё, что ходу нужно от партии.
pub struct Scene<'a> {
  pub world: &'a mut World,
  pub land: Option<&'a mut Land>,
  pub motion: &'a mut Motion,
  pub bounds: Option<Bounds>,
  pub rules: &'a Rules,
}

/// Земля под ногами: местность, здания и правила — можно ли стоять и как быстро идти (`Ground` в walk.rs).
struct Ground<'a> {
  land: Option<&'a mut Land>,
  world: &'a World,
  cols: &'a Cols,
  occupancy: &'a Occupancy,
  bounds: Option<Bounds>,
  speeds: Speeds,
}

impl Ground<'_> {
  fn in_bounds(&self, x: i32, y: i32) -> bool {
    self.bounds.is_none_or(|bounds| bounds.contains(x, y))
  }

  fn tile(&mut self, x: i32, y: i32) -> [u8; 4] {
    match &mut self.land {
      Some(land) => land.tile(x, y),
      None => [SAND, 0, 0, 0],
    }
  }

  /// Может ли наземный юнит находиться в тайле (`isWalkable`): проходимая местность, не подножие обрыва (кроме
  /// пехоты), не здание — кроме открытого проезда.
  fn is_walkable(&mut self, x: i32, y: i32, foot: bool) -> bool {
    if !self.in_bounds(x, y) {
      return false;
    }
    let [terrain, _, _, relief] = self.tile(x, y);
    if terrain == MOUNTAIN || (!foot && relief & FOOT_BIT != 0) {
      return false;
    }
    match self.occupancy.at(x, y) {
      None => true,
      Some(building) => self.cols.num(self.world, self.cols.footprint, self.cols.passable, building).is_some_and(|open| open != 0.0),
    }
  }

  /// Может ли юнит находиться в тайле (`canStand`): летающему — любой внутри карты.
  fn can_stand(&mut self, air: bool, x: i32, y: i32, foot: bool) -> bool {
    if air {
      self.in_bounds(x, y)
    } else {
      self.is_walkable(x, y, foot)
    }
  }

  /// Доля полной скорости юнита на тайле (`terrainSpeed`). Покрытия (дороги, фундамент) пока нет.
  fn terrain_speed(&mut self, class: Class, x: i32, y: i32) -> f64 {
    if class == Class::Air {
      return 1.0;
    }
    let [terrain, biome, _, relief] = self.tile(x, y);
    let speeds = self.speeds;
    if class == Class::Infantry && terrain != MOUNTAIN && relief & FOOT_BIT != 0 {
      return SLOWEST.max(1.0 - speeds.cliff);
    }
    if terrain == SAND {
      return SLOWEST.max(1.0 - speeds.sand[class as usize]);
    }
    if terrain == SWAMP {
      let frozen = if biome >> 6 == SALT_FLATS { speeds.frozen } else { 1.0 };
      return SLOWEST.max(1.0 - speeds.swamp[class as usize] * frozen);
    }
    1.0
  }

  /// Видит ли юнит готовую дорогу (`roadInSight`): дорог пока нет.
  fn road_in_sight(&self, _entity: Entity) -> bool {
    false
  }

  /// Куда техника доедет из тайла заливкой (`vehicleReach`).
  fn vehicle_reach(&mut self, x: i32, y: i32, limit: usize, foot: bool) -> Tiles {
    let mut reached = Tiles::from([(x, y)]);
    let mut queue = vec![(x, y)];
    let mut at = 0;
    while at < queue.len() && reached.len() < limit {
      let (from_x, from_y) = queue[at];
      for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let tile = (from_x + dx, from_y + dy);
        if reached.contains(&tile) || !self.is_walkable(tile.0, tile.1, foot) {
          continue;
        }
        reached.insert(tile);
        queue.push(tile);
      }
      at += 1;
    }
    reached
  }

  /// Проходимые тайлы вокруг точки, от ближних к дальним, через GROUP_SPACING (`freeTilesNear`).
  fn free_tiles_near(&mut self, x: i32, y: i32, count: usize, from_radius: i32, blocked: Option<&Tiles>, air: bool) -> Vec<i32> {
    let search_radius = MAX_GROUP_RADIUS.min(8.max((count as f64).sqrt().ceil() as i32));
    let mut tiles = Vec::new();
    let mut radius = from_radius;
    while radius <= search_radius && tiles.len() < count * 2 {
      for dy in -radius..=radius {
        for dx in -radius..=radius {
          if dx.abs().max(dy.abs()) != radius {
            continue;
          }
          let (tile_x, tile_y) = (x + dx * GROUP_SPACING, y + dy * GROUP_SPACING);
          if tiles.len() >= count * 2 || blocked.is_some_and(|blocked| blocked.contains(&(tile_x, tile_y))) {
            continue;
          }
          if self.can_stand(air, tile_x, tile_y, false) {
            tiles.push(tile_x);
            tiles.push(tile_y);
          }
        }
      }
      radius += 1;
    }
    tiles
  }

  /// Ближайший к (x, y) тайл, где наземный может стоять и нет стоящих (`nearestStand`).
  fn nearest_stand(&mut self, x: i32, y: i32, from_x: i32, from_y: i32, foot: bool, taken: &Tiles) -> Option<(i32, i32)> {
    for ring in 1..=STAND_RADIUS {
      let mut best = None;
      let mut best_order = f64::INFINITY;
      for dy in -ring..=ring {
        for dx in -ring..=ring {
          if dx.abs().max(dy.abs()) != ring {
            continue;
          }
          let (tile_x, tile_y) = (x + dx, y + dy);
          if !self.is_walkable(tile_x, tile_y, foot) || taken.contains(&(tile_x, tile_y)) {
            continue;
          }
          let order = ((dx * dx + dy * dy) as f64) * 1e6 + ((tile_x - from_x) as f64).powi(2) + ((tile_y - from_y) as f64).powi(2);
          if order >= best_order {
            continue;
          }
          best = Some((tile_x, tile_y));
          best_order = order;
        }
      }
      if best.is_some() {
        return best;
      }
    }
    None
  }
}

/// Тайлы, занятые стоящими юнитами (`standingUnits`): путь их обходит.
fn standing_units(world: &World, cols: &Cols, ignore: &HashSet<Entity>, radius: f64, air: bool, jammed: bool) -> Tiles {
  let mut tiles = Tiles::new();
  let tries = cols.tries;
  for &entity in &world.stores[cols.mover].entities {
    let Some(spec) = cols.spec(world, entity) else { continue };
    if ignore.contains(&entity) || spec.air() != air {
      continue;
    }
    if world.has(entity, cols.path) && !(jammed && cols.num(world, cols.path, tries, entity).unwrap_or(0.0) >= JAM_TRIES) {
      continue;
    }
    let Some((x, y)) = cols.position(world, entity) else { continue };
    let reach = spec.radius + radius;
    let (right, bottom) = ((x + reach).floor() as i32, (y + reach).floor() as i32);
    for tile_y in (y - reach).floor() as i32..=bottom {
      let dy = tile_y as f64 + 0.5 - y;
      for tile_x in (x - reach).floor() as i32..=right {
        let dx = tile_x as f64 + 0.5 - x;
        if dx * dx + dy * dy < reach * reach {
          tiles.insert((tile_x, tile_y));
        }
      }
    }
  }
  tiles
}

/// Сетка поиска пути юнита: свой тайл проходим всегда, занятое стоящими — нет; цена шага — по местности.
struct Walker<'g, 'a> {
  ground: &'g mut Ground<'a>,
  from: (i32, i32),
  foot: bool,
  class: Class,
  taken: &'g Tiles,
}

impl Grid for Walker<'_, '_> {
  fn walkable(&mut self, x: i32, y: i32) -> bool {
    (x, y) == self.from || (self.ground.is_walkable(x, y, self.foot) && !self.taken.contains(&(x, y)))
  }

  fn slowness(&mut self, x: i32, y: i32) -> f64 {
    1.0 / self.ground.terrain_speed(self.class, x, y)
  }
}

/// Сетка «где может стоять это тело» без цены шага: для проверки прямой мимо занятой точки.
struct Stand<'g, 'a> {
  ground: &'g mut Ground<'a>,
  air: bool,
  foot: bool,
}

impl Grid for Stand<'_, '_> {
  fn walkable(&mut self, x: i32, y: i32) -> bool {
    self.ground.can_stand(self.air, x, y, self.foot)
  }
}

/// Чем кончился приказ движения.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moved {
  /// Проложен новый путь.
  Set,
  /// Идти некуда: пути больше нет.
  Removed,
  /// Путь остался прежним.
  Kept,
}

/// Путь, как он лежит в Path: меняется на месте и пишется обратно в конце.
#[derive(Clone, Debug)]
struct Route {
  points: Vec<f64>,
  goal_x: f64,
  goal_y: f64,
  wait: f64,
  tries: f64,
  near: f64,
  direct: bool,
  stuck: bool,
  best: f64,
  /// Точки менялись — список пишется обратно.
  dirty: bool,
}

impl Route {
  fn read(world: &World, cols: &Cols, entity: Entity) -> Option<Route> {
    let store = &world.stores[cols.path];
    let row = store.row(entity)?;
    let field = |slot: usize| store.nums[slot][row];
    let points = store.anys[cols.points][row].as_array().map(|list| list.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
    Some(Route { points, goal_x: field(cols.goal_x), goal_y: field(cols.goal_y), wait: field(cols.wait), tries: field(cols.tries), near: field(cols.near), direct: field(cols.direct) != 0.0, stuck: field(cols.stuck) != 0.0, best: field(cols.best), dirty: false })
  }

  /// Пишет обратно то, что ход меняет на месте: точки, ожидание, попытки, лучшее расстояние, застрял ли.
  fn write(&self, world: &mut World, cols: &Cols, entity: Entity, changed_points: bool) {
    let store = &mut world.stores[cols.path];
    let Some(row) = store.row(entity) else { return };
    if changed_points {
      store.anys[cols.points][row] = Value::Array(self.points.iter().map(|&value| json!(value)).collect());
    }
    store.nums[cols.wait][row] = self.wait;
    store.nums[cols.tries][row] = self.tries;
    store.nums[cols.best][row] = self.best;
    store.nums[cols.stuck][row] = if self.stuck { 1.0 } else { 0.0 };
  }
}

/// Кладёт юниту путь: новый — со всеми полями по умолчанию, есть — поля поверх.
fn put_path(world: &mut World, cols: &Cols, entity: Entity, fields: Value) {
  let Value::Object(fields) = fields else { return };
  let _ = world.add(entity, cols.path, &fields);
}

impl Scene<'_> {
  fn ground<'s>(&'s mut self, cols: &'s Cols) -> (Ground<'s>, &'s mut Search) {
    self.motion.occupancy.refresh(self.world);
    let ground = Ground { land: self.land.as_deref_mut(), world: self.world, cols, occupancy: &self.motion.occupancy, bounds: self.bounds, speeds: self.rules.speeds() };
    (ground, &mut self.motion.search)
  }

  /// Можно ли юниту рода class встать в тайл: летающему — внутри карты, наземному — проходимое и не здание.
  pub fn can_stand(&mut self, class: &str, x: i32, y: i32) -> bool {
    let cols = Cols::of(self.world);
    let (mut ground, _) = self.ground(&cols);
    let class = Class::parse(class);
    ground.can_stand(class == Class::Air, x, y, class == Class::Infantry)
  }

  /// Сколько от полной скорости рода class на тайле.
  pub fn terrain_speed(&mut self, class: &str, x: i32, y: i32) -> f64 {
    let cols = Cols::of(self.world);
    let (mut ground, _) = self.ground(&cols);
    ground.terrain_speed(Class::parse(class), x, y)
  }

  /// Здание на тайле.
  pub fn occupant(&mut self, x: i32, y: i32) -> Option<Entity> {
    self.motion.occupancy.refresh(self.world);
    self.motion.occupancy.at(x, y)
  }

  /// Свободные тайлы вокруг точки — x, y подряд (`freeTilesNear`); стоящие юниты не в счёт, если ignore_units.
  pub fn free_tiles(&mut self, x: i32, y: i32, count: usize, from_radius: i32, air: bool) -> Vec<i32> {
    let cols = Cols::of(self.world);
    let taken = standing_units(self.world, &cols, &HashSet::new(), 0.0, air, false);
    let (mut ground, _) = self.ground(&cols);
    ground.free_tiles_near(x, y, count, from_radius, Some(&taken), air)
  }

  /// Отправляет юнит в тайл (x, y): прокладывает путь и кладёт его в Path (`orderMove`).
  #[allow(clippy::too_many_arguments)]
  pub fn order_move(&mut self, entity: Entity, mut x: i32, mut y: i32, ignore: Option<&HashSet<Entity>>, tries: f64, near: f64, limit: Option<f64>) -> Moved {
    let cols = Cols::of(self.world);
    let Some((px, py)) = cols.position(self.world, entity) else { return Moved::Kept };
    let Some(spec) = cols.spec(self.world, entity) else { return Moved::Kept };
    if spec.rooted {
      return Moved::Kept;
    }
    let air = spec.air();
    let jam = tries >= JAM_TRIES;
    let own = HashSet::from([entity]);
    let taken = standing_units(self.world, &cols, ignore.unwrap_or(&own), spec.radius, air, jam);
    let (mut ground, search) = self.ground(&cols);
    // Путь пишется в мир после того, как поиск отпустил землю.
    let mut result: Option<(Value, Moved)> = None;
    let mut removed = false;
    'plan: {
      if near == 0.0 && taken.contains(&(x, y)) {
        let free = ground.free_tiles_near(x, y, 1, 1, Some(&taken), air);
        if free.is_empty() {
          removed = true;
          break 'plan;
        }
        (x, y) = (free[0], free[1]);
      }
      if air {
        if !ground.in_bounds(x, y) {
          removed = true;
          break 'plan;
        }
        result = Some((json!({ "points": [x as f64 + 0.5, y as f64 + 0.5], "goalX": x, "goalY": y, "wait": 0, "tries": tries, "near": near, "direct": false, "stuck": false, "best": -1, "slot": false }), Moved::Set));
        break 'plan;
      }
      let (from_x, from_y) = (px.floor() as i32, py.floor() as i32);
      let foot = spec.foot();
      if near == 0.0 && (x, y) != (from_x, from_y) && !ground.is_walkable(x, y, foot) {
        if let Some(stand) = ground.nearest_stand(x, y, from_x, from_y, foot, &taken) {
          (x, y) = stand;
        }
      }
      let fastest = if spec.fastest() > 1.0 && ground.road_in_sight(entity) { 1.0 / spec.fastest() } else { 1.0 };
      let mut walker = Walker { ground: &mut ground, from: (from_x, from_y), foot, class: spec.class, taken: &taken };
      let mut tiles = search.find_path(&mut walker, from_x, from_y, x, y, near, if near != 0.0 { APPROACH_LIMIT } else { limit.unwrap_or(SEARCH_LIMIT) }, fastest);
      let reaches = |path: &[i32]| {
        if path.is_empty() {
          return from_x == x && from_y == y;
        }
        let (dx, dy) = ((path[path.len() - 2] - x) as f64, (path[path.len() - 1] - y) as f64);
        dx * dx + dy * dy <= near * near
      };
      // Поиск оборвала норма тика, а не преграда: прежний путь остаётся как был.
      if search.cut() && !reaches(&tiles) {
        return Moved::Kept;
      }
      if near == 0.0 && !reaches(&tiles) && !beyond_window(from_x, from_y, x, y) {
        let pocket = walker.ground.vehicle_reach(x, y, LONG_POCKET, foot);
        if pocket.len() >= LONG_POCKET || pocket.contains(&(from_x, from_y)) {
          let longer = search.find_path(&mut walker, from_x, from_y, x, y, near, limit.unwrap_or(SEARCH_LIMIT) * LONG_SEARCH, fastest);
          if reaches(&longer) {
            tiles = longer;
          }
        }
      }
      if near != 0.0 && tiles.is_empty() && (((from_x - x) * (from_x - x) + (from_y - y) * (from_y - y)) as f64) <= near * near {
        return self.order_move(entity, x, y, ignore, tries, 0.0, Some(APPROACH_LIMIT));
      }
      let centers: Vec<f64> = tiles.iter().map(|&value| value as f64 + 0.5).collect();
      let points = smooth_path(&mut walker, px, py, &centers);
      if !points.is_empty() {
        result = Some((json!({ "points": points, "goalX": x, "goalY": y, "wait": 0, "tries": tries, "near": near, "roads": fastest < 1.0, "direct": false, "stuck": false, "best": -1, "slot": false }), Moved::Set));
      } else if !jam {
        removed = true;
      } else {
        return Moved::Kept;
      }
    }
    // Земля отпущена: дальше мир меняется.
    let world = &mut *self.world;
    if removed {
      world.remove(entity, cols.path);
      return Moved::Removed;
    }
    match result {
      Some((fields, moved)) => {
        put_path(world, &cols, entity, fields);
        moved
      }
      None => Moved::Kept,
    }
  }

  /// Приказ группе идти в тайл (`orderGroupMove`): каждому — свой тайл рядом с целью; наземные едут к нему напрямую,
  /// объезжая встречное, а путь ищут, только если упрутся (`plan_paths`); летающие — по прямой.
  pub fn order_group_move(&mut self, all: &[Entity], x: i32, y: i32) {
    let cols = Cols::of(self.world);
    let specs: Vec<(Entity, Spec)> = all.iter().filter_map(|&entity| cols.spec(self.world, entity).map(|spec| (entity, spec))).collect();
    let Some((_, first)) = specs.first() else { return };
    let air = first.air();
    let units: Vec<Entity> = specs.iter().filter(|(_, spec)| spec.air() == air).map(|(entity, _)| *entity).collect();
    if units.len() < specs.len() {
      let rest: Vec<Entity> = specs.iter().filter(|(_, spec)| spec.air() != air).map(|(entity, _)| *entity).collect();
      self.order_group_move(&rest, x, y);
    }
    // Друг другу юниты группы не препятствие: они трогаются вместе.
    let group: HashSet<Entity> = units.iter().copied().collect();
    let radius = specs.iter().filter(|(_, spec)| spec.air() == air).map(|(_, spec)| spec.radius).fold(f64::NEG_INFINITY, f64::max);
    let taken = standing_units(self.world, &cols, &group, radius, air, false);
    let tiles = {
      let (mut ground, _) = self.ground(&cols);
      ground.free_tiles_near(x, y, units.len(), 0, Some(&taken), air)
    };
    if tiles.is_empty() {
      return;
    }
    for (i, &entity) in units.iter().enumerate() {
      // Мест может оказаться меньше, чем юнитов; тогда лишние идут в последнее.
      let at = (i * 2).min(tiles.len() - 2);
      let (tile_x, tile_y) = (tiles[at], tiles[at + 1]);
      if air {
        self.order_move(entity, tile_x, tile_y, Some(&group), 0.0, 0.0, None);
      } else {
        if cols.spec(self.world, entity).is_some_and(|spec| spec.rooted) {
          continue;
        }
        put_path(self.world, &cols, entity, json!({ "points": [tile_x as f64 + 0.5, tile_y as f64 + 0.5], "goalX": tile_x, "goalY": tile_y, "wait": 0, "tries": 0, "near": 0, "roads": false, "direct": true, "stuck": false, "best": -1, "slot": false }));
      }
    }
  }

  /// Встать: путь снимается.
  pub fn stop(&mut self, entity: Entity) {
    let cols = Cols::of(self.world);
    self.world.remove(entity, cols.path);
  }

  /// Раз в тик, до движения: пути упёршимся, ехавшим напрямую (`planPaths`).
  pub fn plan_paths(&mut self) {
    let cols = Cols::of(self.world);
    let (direct, stuck) = (cols.direct, cols.stuck);
    let waiting: Vec<Entity> = self.world.stores[cols.path].entities.iter().copied().filter(|&entity| cols.num(self.world, cols.path, direct, entity) == Some(1.0) && cols.num(self.world, cols.path, stuck, entity) == Some(1.0)).collect();
    let searched_before = self.motion.search.searched();
    let previous = self.motion.search.open_quota(PLAN_TILES);
    for entity in waiting {
      if cols.num(self.world, cols.path, stuck, entity) != Some(1.0) {
        continue;
      }
      let Some(route) = Route::read(self.world, &cols, entity) else { continue };
      self.order_move(entity, route.goal_x as i32, route.goal_y as i32, None, 0.0, route.near, None);
      if self.motion.search.searched() - searched_before >= PLAN_TILES {
        break;
      }
    }
    self.motion.search.close_quota(previous);
  }

  /// Раз в тик: двигает юниты по их путям (`moveUnits`). step — длина тика в секундах.
  pub fn move_units(&mut self, step: f64) {
    let cols = Cols::of(self.world);
    let world: &World = self.world;
    let mut crowd = Crowd { bodies: Vec::new(), cells: HashMap::new(), large: Vec::new() };
    let mut index = HashMap::new();
    let mut starts: Vec<(f64, f64)> = Vec::new();
    let mut facing_now: Vec<f64> = Vec::new();
    let mut specs: Vec<Spec> = Vec::new();
    for &entity in &world.stores[cols.mover].entities {
      let (Some((x, y)), Some(spec)) = (cols.position(world, entity), cols.spec(world, entity)) else { continue };
      let (prev_x, prev_y) = self.motion.prev.get(&entity).copied().unwrap_or((x, y));
      let (mut vx, mut vy) = ((x - prev_x) / step, (y - prev_y) / step);
      if js_hypot(vx, vy) > spec.speed * 1.5 {
        (vx, vy) = (0.0, 0.0);
      }
      let owner = cols.num(world, cols.owner, 0, entity).unwrap_or(0.0);
      let body = Body { entity, x, y, radius: spec.radius, mass: spec.radius * spec.radius, vx, vy, air: spec.air(), foot: spec.foot(), moving: world.has(entity, cols.path), rooted: spec.rooted, owner };
      index.insert(entity, crowd.bodies.len());
      starts.push((x, y));
      facing_now.push(cols.facing(world, entity));
      if spec.radius > LARGE {
        crowd.large.push(crowd.bodies.len());
      } else {
        crowd.cells.entry(((x / CELL).floor() as i32, (y / CELL).floor() as i32)).or_default().push(crowd.bodies.len());
      }
      crowd.bodies.push(body);
      specs.push(spec);
    }
    let mut allies: HashMap<u64, Vec<f64>> = HashMap::new();
    let player_id = slot(world, cols.player, "id");
    let allies_slot = slot(world, cols.player, "allies");
    let mut allied = |a: f64, b: f64| {
      a != b
        && allies
          .entry(a as u64)
          .or_insert_with(|| {
            let store = &world.stores[cols.player];
            (0..store.entities.len()).find(|&row| store.nums[player_id][row] == a).and_then(|row| store.anys[allies_slot][row].as_array().map(|list| list.iter().filter_map(Value::as_f64).collect())).unwrap_or_default()
          })
          .contains(&b)
    };
    let yields = |crowd: &Crowd, body: usize, by: usize, allied: &mut dyn FnMut(f64, f64) -> bool| {
      let (them, by) = (&crowd.bodies[body], &crowd.bodies[by]);
      !them.rooted && (them.moving || them.owner == by.owner || allied(them.owner, by.owner))
    };

    self.motion.occupancy.refresh(world);
    let mut ground = Ground { land: self.land.as_deref_mut(), world, cols: &cols, occupancy: &self.motion.occupancy, bounds: self.bounds, speeds: self.rules.speeds() };
    let mut movers: Vec<Mover> = Vec::new();
    for &entity in &world.stores[cols.path].entities {
      let Some(&me) = index.get(&entity) else { continue };
      let Some(route) = Route::read(world, &cols, entity) else { continue };
      if route.points.len() < 2 {
        continue;
      }
      let spec = specs[me];
      let (speed, turn, radius) = (spec.speed, spec.turn, spec.radius);
      let (body_air, body_foot) = (crowd.bodies[me].air, crowd.bodies[me].foot);
      let (x, y) = (crowd.bodies[me].x, crowd.bodies[me].y);
      // Юнит, под которым выросло здание, выходит из него: внутри здания тайлы ему не преграда.
      let inside = !ground.can_stand(body_air, x.floor() as i32, y.floor() as i32, body_foot);
      let rooted = crowd.bodies[me].rooted;
      movers.push(Mover { index: me, route, walled: false, slid: false });
      if rooted {
        continue;
      }
      let mover = movers.last_mut().unwrap();
      let points = &mover.route.points;
      let open = |ground: &mut Ground, x: f64, y: f64| inside || ground.can_stand(body_air, x.floor() as i32, y.floor() as i32, body_foot);
      let (dx, dy) = (points[0] - x, points[1] - y);
      let distance = js_hypot(dx, dy);
      let facing = facing_now[me];
      let wanted = if distance != 0.0 { js_atan2(dy, dx) } else { facing };
      let last = points.len() == 2;
      let heading = if distance != 0.0 && !(last && distance < radius + SETTLE) { crowd.steer(me, dx / distance, dy / distance, speed) } else { wanted };
      let facing = turn_toward(facing, heading, turn * step);
      facing_now[me] = facing;
      let askew = wrap(heading - facing).abs();
      let mut moved = speed * ground.terrain_speed(spec.class, x.floor() as i32, y.floor() as i32) * step * 0f64.max(js_cos(askew));
      let off = wrap(wanted - facing).abs();
      let avoiding = wrap(heading - wanted).abs() > AIMED;
      if !avoiding && distance < ((2.0 * speed) / turn) * js_sin(off.min(std::f64::consts::PI / 2.0)) * ORBIT_MARGIN {
        moved = 0.0;
      }
      if moved == 0.0 {
        continue;
      }
      // Глядя точно на точку пути, юнит приходит в неё ровно, без перелёта.
      if facing == wanted && moved >= distance {
        if open(&mut ground, points[0], points[1]) {
          (crowd.bodies[me].x, crowd.bodies[me].y) = (points[0], points[1]);
        } else {
          mover.walled = true;
        }
        continue;
      }
      let (step_x, step_y) = (js_cos(facing) * moved, js_sin(facing) * moved);
      if open(&mut ground, x + step_x, y + step_y) {
        (crowd.bodies[me].x, crowd.bodies[me].y) = (x + step_x, y + step_y);
        continue;
      }
      // Впереди непроходимое — скользит вдоль него: по той оси, по которой можно и которая ближе к точке.
      let along_x = if open(&mut ground, x + step_x, y) { step_x * dx } else { f64::NEG_INFINITY };
      let along_y = if open(&mut ground, x, y + step_y) { step_y * dy } else { f64::NEG_INFINITY };
      if along_x > 0.0 && along_x >= along_y {
        crowd.bodies[me].x = x + step_x;
      } else if along_y > 0.0 {
        crowd.bodies[me].y = y + step_y;
      } else {
        mover.walled = true;
      }
      mover.slid = true;
    }

    // Расталкивание: начинают те, кто ехал, — стоящие, которых сдвинули, продолжают цепочку.
    let mut pushed: Vec<usize> = movers.iter().map(|mover| mover.index).collect();
    let mut in_pushed: HashSet<usize> = pushed.iter().copied().collect();
    let mut pass = 0;
    let mut moved = true;
    while pass < SEPARATIONS && moved {
      moved = false;
      for body in pushed.clone() {
        for other in crowd.gather(body, 0.0) {
          let (bx, by) = (crowd.bodies[body].x, crowd.bodies[body].y);
          let (ox, oy) = (crowd.bodies[other].x, crowd.bodies[other].y);
          let (mut normal_x, mut normal_y) = (ox - bx, oy - by);
          let distance = js_hypot(normal_x, normal_y);
          let overlap = crowd.bodies[body].radius + crowd.bodies[other].radius - distance;
          if overlap <= 0.0 {
            continue;
          }
          if distance > 1e-6 {
            normal_x /= distance;
            normal_y /= distance;
          } else {
            // Стоят точка в точку: расходятся в сторону, заданную номерами, — одинаково при каждом прогоне.
            let angle = ((crowd.bodies[body].entity as u64 * 7 + crowd.bodies[other].entity as u64 * 13) % 360) as f64;
            normal_x = js_cos(angle);
            normal_y = js_sin(angle);
          }
          let body_free = yields(&crowd, body, other, &mut allied);
          let other_free = yields(&crowd, other, body, &mut allied);
          let (body_mass, other_mass) = (crowd.bodies[body].mass, crowd.bodies[other].mass);
          let mut body_share = if !body_free {
            0.0
          } else if !other_free {
            1.0
          } else {
            other_mass / (body_mass + other_mass)
          };
          if body_free && other_free && crowd.bodies[body].moving != crowd.bodies[other].moving {
            body_share = if crowd.bodies[body].moving { 0.0 } else { 1.0 };
          }
          let mut other_share = if other_free { 1.0 - body_share } else { 0.0 };
          let other_x = ox + normal_x * overlap * other_share;
          let other_y = oy + normal_y * overlap * other_share;
          let (other_air, other_foot) = (crowd.bodies[other].air, crowd.bodies[other].foot);
          if other_share != 0.0 && !ground.can_stand(other_air, other_x.floor() as i32, other_y.floor() as i32, other_foot) {
            other_share = 0.0;
            body_share = if body_free { 1.0 } else { 0.0 };
          }
          let body_x = bx - normal_x * overlap * body_share;
          let body_y = by - normal_y * overlap * body_share;
          let (body_air, body_foot) = (crowd.bodies[body].air, crowd.bodies[body].foot);
          if body_share != 0.0 && ground.can_stand(body_air, body_x.floor() as i32, body_y.floor() as i32, body_foot) {
            (crowd.bodies[body].x, crowd.bodies[body].y) = (body_x, body_y);
            moved = true;
          }
          if other_share != 0.0 {
            moved = true;
            (crowd.bodies[other].x, crowd.bodies[other].y) = (other_x, other_y);
            if in_pushed.insert(other) {
              pushed.push(other);
            }
          }
        }
      }
      pass += 1;
    }

    let mut stopped: Vec<Entity> = Vec::new();
    let mut lost: Vec<Lost> = Vec::new();
    let mut further: Vec<Further> = Vec::new();
    for mover in &mut movers {
      let me = mover.index;
      let (entity, x, y, radius, air, foot) = {
        let body = &crowd.bodies[me];
        (body.entity, body.x, body.y, body.radius, body.air, body.foot)
      };
      let route = &mut mover.route;
      let left = js_hypot(route.points[0] - x, route.points[1] - y);
      let last = route.points.len() == 2;
      let blocker = if left < radius + LARGE + SETTLE {
        let (px, py) = (route.points[0], route.points[1]);
        crowd.gather(me, SENSE).into_iter().find(|&other| js_hypot(crowd.bodies[other].x - px, crowd.bodies[other].y - py) < radius + crowd.bodies[other].radius)
      } else {
        None
      };
      // Промежуточную точку занял сосед, а юнит уже рядом: точка пропускается, если следующая видна по прямой.
      if let Some(blocker) = blocker {
        if !last && left < radius + crowd.bodies[blocker].radius + SETTLE {
          let clear = air || is_clear(&mut Stand { ground: &mut ground, air, foot }, x, y, route.points[2], route.points[3]);
          if clear {
            route.points.drain(0..2);
            route.dirty = true;
            route.best = -1.0;
            route.wait = 0.0;
            continue;
          }
        }
      }
      let settled = blocker.is_some_and(|blocker| {
        let them = &crowd.bodies[blocker];
        last && left < radius + them.radius + SETTLE && (!yields(&crowd, blocker, me, &mut allied) || (them.moving && them.entity < entity))
      });
      if left == 0.0 || settled || (!last && left < REACHED) {
        route.points.drain(0..2);
        route.dirty = true;
        route.tries = 0.0;
        route.best = -1.0;
        route.wait = 0.0;
        if !route.points.is_empty() {
          continue;
        }
        // Путь к далёкой цели кончается раньше неё: тогда это не приезд, и юнит ищет путь дальше отсюда.
        let (gx, gy) = (x - route.goal_x - 0.5, y - route.goal_y - 0.5);
        let reached = if route.near != 0.0 { gx * gx + gy * gy <= (route.near + 1.0) * (route.near + 1.0) } else { (x.floor() == route.goal_x && y.floor() == route.goal_y) || (settled && js_hypot(gx, gy) < radius + SETTLE + 1.0) };
        if reached || air {
          stopped.push(entity);
        } else {
          route.points.extend([x, y]);
          route.dirty = true;
          let blocked = if settled { blocker.map(|other| (crowd.bodies[other].x.floor() as i32, crowd.bodies[other].y.floor() as i32)) } else { None };
          further.push(Further { entity, x: route.goal_x as i32, y: route.goal_y as i32, near: route.near, blocked });
        }
        continue;
      }
      // Ехал напрямую и упёрся в местность или здание: путь нужен сразу.
      if route.direct && (mover.slid || mover.walled) {
        route.wait += 1.0;
        if route.wait >= SLIDE_TICKS {
          route.stuck = true;
          route.wait = 0.0;
          route.best = -1.0;
        }
        continue;
      }
      if route.best < 0.0 || left < route.best - PROGRESS {
        route.best = left;
        route.wait = 0.0;
        continue;
      }
      route.wait += 1.0;
      if route.wait >= WAIT_TICKS {
        // Юнит не может идти дальше: прокладывает путь заново или, если уже пробовал, встаёт (`giveUp`).
        let close = js_hypot(x - route.goal_x - 0.5, y - route.goal_y - 0.5) <= route.near + GIVE_UP_REACH;
        if route.direct {
          route.wait = 0.0;
          if mover.walled || {
            route.tries += 1.0;
            route.tries >= MAX_TRIES
          } {
            route.stuck = true;
          }
        } else if route.tries >= MAX_TRIES && close {
          stopped.push(entity);
        } else if lost.len() < LOST_SEARCHES {
          lost.push(Lost { entity, index: me, x: route.goal_x as i32, y: route.goal_y as i32, tries: (route.tries + 1.0).min(MAX_TRIES), near: route.near });
        }
        route.wait = 0.0;
        route.best = -1.0;
      }
    }

    // Запись: места, повороты, пути; где тела были в начале тика — для скорости на следующем.
    let bodies: Vec<(Entity, f64, f64)> = crowd.bodies.iter().map(|body| (body.entity, body.x, body.y)).collect();
    for (at, &(entity, x, y)) in bodies.iter().enumerate() {
      self.motion.prev.insert(entity, starts[at]);
      if let Some(row) = self.world.stores[cols.position].row(entity) {
        self.world.stores[cols.position].nums[0][row] = x;
        self.world.stores[cols.position].nums[1][row] = y;
      }
      if let Some(row) = self.world.stores[cols.facing].row(entity) {
        self.world.stores[cols.facing].nums[0][row] = facing_now[at];
      }
    }
    self.motion.prev.retain(|entity, _| index.contains_key(entity));
    for mover in &movers {
      mover.route.write(self.world, &cols, crowd.bodies[mover.index].entity, mover.route.dirty);
    }
    for entity in stopped {
      self.world.remove(entity, cols.path);
    }

    let searched_before = self.motion.search.searched();
    let previous = self.motion.search.open_quota(LOST_TILES + SEARCH_LIMIT);
    let over = |scene: &Scene| scene.motion.search.searched() - searched_before >= LOST_TILES;
    for Further { entity, x, y, near, blocked } in further {
      if over(self) {
        continue;
      }
      let Some((px, py)) = cols.position(self.world, entity) else { continue };
      let from = (px.floor() as i32, py.floor() as i32);
      self.order_move(entity, x, y, None, 0.0, near, None);
      // Ближе к цели не подойти — встаёт: иначе искал бы на месте каждый тик.
      let end = Route::read(self.world, &cols, entity).map(|route| route.points).unwrap_or_default();
      if end.len() >= 2 {
        let end = (end[end.len() - 2].floor() as i32, end[end.len() - 1].floor() as i32);
        if end == from || Some(end) == blocked {
          self.world.remove(entity, cols.path);
        }
      }
    }
    for Lost { entity, index: me, x, y, tries, near } in lost {
      if over(self) {
        break;
      }
      let result = self.order_move(entity, x, y, None, tries, near, None);
      if !self.world.has(entity, cols.path) || result == Moved::Set || self.motion.search.cut() {
        continue;
      }
      // Нового пути нет — обступили со всех сторон. Обступили стоящие без приказа — значит, доехал.
      let neighbours = crowd.gather(me, GAP);
      if tries >= MAX_TRIES && !neighbours.is_empty() && neighbours.iter().all(|&other| !crowd.bodies[other].moving) {
        self.world.remove(entity, cols.path);
      }
    }
    self.motion.search.close_quota(previous);
  }
}

struct Body {
  entity: Entity,
  x: f64,
  y: f64,
  radius: f64,
  mass: f64,
  vx: f64,
  vy: f64,
  air: bool,
  foot: bool,
  moving: bool,
  rooted: bool,
  owner: f64,
}

struct Mover {
  index: usize,
  route: Route,
  walled: bool,
  slid: bool,
}

struct Further {
  entity: Entity,
  x: i32,
  y: i32,
  near: f64,
  blocked: Option<(i32, i32)>,
}

struct Lost {
  entity: Entity,
  index: usize,
  x: i32,
  y: i32,
  tries: f64,
  near: f64,
}

/// Тела по ячейкам: соседей ищут по ним.
struct Crowd {
  bodies: Vec<Body>,
  cells: HashMap<(i32, i32), Vec<usize>>,
  large: Vec<usize>,
}

impl Crowd {
  /// Соседи тела, чьи края ближе reach тайлов к его краю (`gather`).
  fn gather(&self, me: usize, reach: f64) -> Vec<usize> {
    let mut found = Vec::new();
    let body = &self.bodies[me];
    let (x, y) = (body.x, body.y);
    let check = |found: &mut Vec<usize>, other: usize| {
      let them = &self.bodies[other];
      if other == me || them.air != body.air {
        return;
      }
      let far = body.radius + them.radius + reach;
      let (offset_x, offset_y) = (them.x - x, them.y - y);
      if offset_x * offset_x + offset_y * offset_y < far * far {
        found.push(other);
      }
    };
    let far = body.radius + LARGE + reach + DRIFT;
    let (right, bottom) = (((x + far) / CELL).floor() as i32, ((y + far) / CELL).floor() as i32);
    for cy in ((y - far) / CELL).floor() as i32..=bottom {
      for cx in ((x - far) / CELL).floor() as i32..=right {
        for &other in self.cells.get(&(cx, cy)).map_or(&[][..], Vec::as_slice) {
          check(&mut found, other);
        }
      }
    }
    for &other in &self.large {
      check(&mut found, other);
    }
    found
  }

  /// Куда ехать, чтобы не столкнуться (`steer`).
  fn steer(&self, me: usize, dir_x: f64, dir_y: f64, speed: f64) -> f64 {
    let body = &self.bodies[me];
    let (mut away_x, mut away_y) = (0.0, 0.0);
    let (own_x, own_y) = (dir_x * speed, dir_y * speed);
    for other in self.gather(me, SENSE) {
      let them = &self.bodies[other];
      let (offset_x, offset_y) = (them.x - body.x, them.y - body.y);
      let (relative_x, relative_y) = (own_x - them.vx, own_y - them.vy);
      let closing = relative_x * relative_x + relative_y * relative_y;
      let reach = body.radius + them.radius + GAP;
      let when = if closing > 1e-6 { (offset_x * relative_x + offset_y * relative_y) / closing } else { 0.0 };
      if when <= 0.0 || when > HORIZON {
        continue;
      }
      let (miss_x, miss_y) = (offset_x - relative_x * when, offset_y - relative_y * when);
      let miss = js_hypot(miss_x, miss_y);
      if miss >= reach {
        continue;
      }
      let length = closing.sqrt();
      let side_x = if miss > 1e-3 { -miss_x / miss } else { -relative_y / length };
      let side_y = if miss > 1e-3 { -miss_y / miss } else { relative_x / length };
      let urgency = (1.0 - when / HORIZON) * ((reach - miss) / reach);
      away_x += side_x * urgency;
      away_y += side_y * urgency;
    }
    js_atan2(dir_y + away_y * AVOIDANCE, dir_x + away_x * AVOIDANCE)
  }
}
