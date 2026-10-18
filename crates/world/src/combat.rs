//! Бой — инструмент движка, перенос `crates/sim` (systems/combat.rs) — а значит, и TS (combat.ts, `fight`): тот же
//! порядок дел и та же арифметика. Снаряды летят и бьют, стрелки выбирают цели, гонятся и стреляют, погибшие
//! пропадают. Кто во что попадает — метки: юниты (`Mover`) и здания (`Footprint`) с прочностью `Health`; кто стреляет —
//! `Armed` (оружие, поворот, откуда вылетает выстрел); стойка юнита — `Tactics`. Виды оружия — раздел `weapons/`
//! контента (`data` как в weapons.json).
//!
//! Что видно игроку — подаче: выстрелы (`Shot`) и взрывы (`Blast`) — сущности мира, следы на земле — сигналы
//! `scar`, `burn`, `wreck`; гибель — событие `killed` для механик.
//!
//! Взрывы по площади (`Burst`) бьют всех без разбора; погибшее с `Meltdown` оставляет такой взрыв на своём месте.
//! Обречённые (`Doomed`) гибнут в свой черёд обычной гибелью (сдача и уничтожение своих, defeat.ts).
//!
//! Купола щитов (`Shield`) гасят урон по своим и союзным под ними и останавливают чужие снаряды на краю (shields.ts).
//!
//! Боеприпасы: выстрел тратит `Armed.cost` из магазина носителя (`Magazine`), без запаса не стреляют; юнит с
//! магазином меньше `least` пуст — бросает цель.
//!
//! Пока без защиты новичка и плит фундамента: они придут со своими механиками (docs/port.md).

use crate::host::{Signal, State};
use crate::motion::Scene;
use crate::schema::ComponentId;
use crate::world::{Entity, World};
use kharos_engine::math::{js_atan2, js_cos, js_hypot, js_round, js_sin, turn_toward, wrap};
use kharos_engine::terrain::SWAMP;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Раз во сколько тиков свободный стрелок высматривает цель.
const SCAN_TICKS: u64 = 5;
/// Насколько безобидная цель «дальше» опасной при выборе.
const HARMLESS: f64 = 1000.0;
/// Раз во сколько тиков едущий за целью сверяет путь к ней.
const CHASE_TICKS: u64 = 20;
const CHASE_MARGIN: f64 = 1.5;
/// На сколько тайлов дальше бьют турели зданий.
const TOWER_RANGE: f64 = 2.0;
/// Сколько поисков пути и тайлов за тик достаётся погоням.
const CHASE_SEARCHES: u32 = 16;
const CHASE_TILES: f64 = 15000.0;
const SHOOTER_STRIDE: u64 = 17;
const STUCK_LIMIT: f64 = 3.0;
/// Насколько стрелок может не довернуть к цели и всё же стрелять, радиан.
const AIM: f64 = 0.12;
const BEAM_TICKS: f64 = 3.0;
const CHAIN_RANGE: f64 = 2.5;
const CHAIN_DECAY: f64 = 0.6;
const OVERFLY: f64 = 1.5;
const SPLASH_EDGE: f64 = 0.5;
const MARK_CELL: f64 = 8.0;
const MARK_PAD: f64 = 2.0;
const SLOT_MARGIN: f64 = 0.5;
const SLOT_GAP: f64 = 0.4;
const SLOT_REACH: f64 = 0.75;
const SLOT_PATIENCE: f64 = 10.0;
const SLOT_REPLAN: f64 = 4.0;
const SLOT_CELL: f64 = 2.5;
const GUARD_RANGE: f64 = 4.0;
const FULL_RING: f64 = 0.25;
/// Дальше этого от места, где стоял, юнит в обороне за врагом не гонится (`LEASH` в tactics.ts).
const LEASH: f64 = 8.0;
/// Красные пустоши — номер биома.
const RED_WASTES: u8 = 2;
/// Нет цели.
const NONE: f64 = -1.0;
/// Погрешность долей: магазин, в котором на выстрел не хватает меньше этого, — полон на выстрел.
const EPSILON: f64 = 1e-9;

/// Вид оружия (weapons.json).
#[derive(Clone, Debug, Default)]
pub struct Weapon {
  pub shot: String,
  pub range: f64,
  pub min_range: Option<f64>,
  pub damage: f64,
  pub reload: f64,
  pub speed: Option<f64>,
  pub splash: Option<f64>,
  pub chain: Option<f64>,
  pub lob: bool,
  pub air: bool,
  pub only_air: bool,
  pub vs: HashMap<String, f64>,
}

impl Weapon {
  pub fn parse(data: &Map<String, Value>) -> Self {
    let number = |name: &str| data.get(name).and_then(Value::as_f64);
    let flag = |name: &str| data.get(name).and_then(Value::as_bool).unwrap_or(false);
    let vs = data.get("vs").and_then(Value::as_object).map(|vs| vs.iter().filter_map(|(armor, value)| value.as_f64().map(|value| (armor.clone(), value))).collect()).unwrap_or_default();
    Self { shot: data.get("shot").and_then(Value::as_str).unwrap_or("bullet").to_owned(), range: number("range").unwrap_or(0.0), min_range: number("minRange"), damage: number("damage").unwrap_or(0.0), reload: number("reload").unwrap_or(1.0), speed: number("speed"), splash: number("splash"), chain: number("chain"), lob: flag("lob"), air: flag("air"), only_air: flag("onlyAir"), vs }
  }

  /// Останавливает ли стена выстрел такого вида.
  fn stops_at_wall(&self) -> bool {
    !matches!(self.shot.as_str(), "rocket" | "arc")
  }
}

/// Виды оружия партии по именам.
#[derive(Clone, Debug, Default)]
pub struct Weapons(pub HashMap<String, Weapon>);

fn slot(world: &World, component: ComponentId, field: &str) -> usize {
  world.schema.components[component].field(field).map_or(0, |field| field.slot)
}

/// Номера компонентов и столбцов боя — один раз на тик.
struct Cols {
  position: ComponentId,
  facing: ComponentId,
  owner: ComponentId,
  mover: ComponentId,
  path: ComponentId,
  footprint: ComponentId,
  player: ComponentId,
  attached: ComponentId,
  health: ComponentId,
  armed: ComponentId,
  tactics: ComponentId,
  shot: ComponentId,
  blast: ComponentId,
  burst: ComponentId,
  meltdown: ComponentId,
  doomed: ComponentId,
  doomed_left: usize,
  shield: ComponentId,
  magazine: ComponentId,
  ammo: usize,
  least: usize,
  cost: usize,
  sight: ComponentId,
  proto: ComponentId,
  mover_radius: usize,
  mover_class: usize,
  path_slot: usize,
  path_goal_x: usize,
  path_goal_y: usize,
  path_wait: usize,
  width: usize,
  height: usize,
  passable: usize,
  wall: usize,
  player_id: usize,
  allies: usize,
  parent: usize,
  angle: usize,
  value: usize,
  hit: usize,
  hp: usize,
  weapon: usize,
  turn: usize,
  muzzle: usize,
  target: usize,
  chase: usize,
  cooldown: usize,
  stuck: usize,
  ordered: usize,
  stance: usize,
  away: usize,
  home_x: usize,
  home_y: usize,
  patrol: usize,
  resupply: usize,
  throttle: ComponentId,
  share: usize,
}

impl Cols {
  fn of(world: &World) -> Self {
    let id = |name: &str| world.schema.id(name).expect("компонент движка");
    let (mover, path, footprint, player, attached, health, armed, tactics, throttle) = (id("Mover"), id("Path"), id("Footprint"), id("Player"), id("Attached"), id("Health"), id("Armed"), id("Tactics"), id("Throttle"));
    Self {
      position: id("Position"),
      facing: id("Facing"),
      owner: id("Owner"),
      mover,
      path,
      footprint,
      player,
      attached,
      health,
      armed,
      tactics,
      shot: id("Shot"),
      blast: id("Blast"),
      burst: id("Burst"),
      meltdown: id("Meltdown"),
      doomed: id("Doomed"),
      doomed_left: slot(world, id("Doomed"), "left"),
      shield: id("Shield"),
      magazine: id("Magazine"),
      ammo: slot(world, id("Magazine"), "ammo"),
      least: slot(world, id("Magazine"), "least"),
      cost: slot(world, armed, "cost"),
      sight: id("Sight"),
      proto: id("Proto"),
      mover_radius: slot(world, mover, "radius"),
      mover_class: slot(world, mover, "class"),
      path_slot: slot(world, path, "slot"),
      path_goal_x: slot(world, path, "goalX"),
      path_goal_y: slot(world, path, "goalY"),
      path_wait: slot(world, path, "wait"),
      width: slot(world, footprint, "width"),
      height: slot(world, footprint, "height"),
      passable: slot(world, footprint, "passable"),
      wall: slot(world, footprint, "wall"),
      player_id: slot(world, player, "id"),
      allies: slot(world, player, "allies"),
      parent: slot(world, attached, "parent"),
      angle: slot(world, attached, "angle"),
      value: slot(world, health, "value"),
      hit: slot(world, health, "hit"),
      hp: slot(world, health, "hp"),
      weapon: slot(world, armed, "weapon"),
      turn: slot(world, armed, "turn"),
      muzzle: slot(world, armed, "radius"),
      target: slot(world, armed, "target"),
      chase: slot(world, armed, "chase"),
      cooldown: slot(world, armed, "cooldown"),
      stuck: slot(world, armed, "stuck"),
      ordered: slot(world, armed, "ordered"),
      stance: slot(world, tactics, "stance"),
      away: slot(world, tactics, "away"),
      home_x: slot(world, tactics, "homeX"),
      home_y: slot(world, tactics, "homeY"),
      patrol: slot(world, tactics, "patrol"),
      resupply: slot(world, tactics, "resupply"),
      throttle,
      share: slot(world, throttle, "share"),
    }
  }

  fn num(&self, world: &World, component: ComponentId, slot: usize, entity: Entity) -> Option<f64> {
    let store = &world.stores[component];
    store.row(entity).map(|row| store.nums[slot][row])
  }

  fn put(&self, world: &mut World, component: ComponentId, slot: usize, entity: Entity, value: f64) {
    let store = &mut world.stores[component];
    if let Some(row) = store.row(entity) {
      store.nums[slot][row] = value;
    }
  }

  fn flag(&self, world: &World, component: ComponentId, slot: usize, entity: Entity) -> bool {
    self.num(world, component, slot, entity) == Some(1.0)
  }

  fn position(&self, world: &World, entity: Entity) -> Option<(f64, f64)> {
    let store = &world.stores[self.position];
    store.row(entity).map(|row| (store.nums[0][row], store.nums[1][row]))
  }

  fn owner(&self, world: &World, entity: Entity) -> f64 {
    self.num(world, self.owner, 0, entity).unwrap_or(0.0)
  }

  fn class<'w>(&self, world: &'w World, entity: Entity) -> Option<&'w str> {
    self.num(world, self.mover, self.mover_class, entity).map(|class| world.strings.text(class as u32))
  }

  fn flies(&self, world: &World, entity: Entity) -> bool {
    self.class(world, entity) == Some("air")
  }

  /// Носитель турели; не турель — она сама (`carrierOf`).
  fn carrier(&self, world: &World, entity: Entity) -> Entity {
    self.num(world, self.attached, self.parent, entity).map_or(entity, |parent| parent as Entity)
  }

  /// Оружие стрелка (`weaponOf`).
  fn weapon<'w>(&self, world: &World, weapons: &'w Weapons, entity: Entity) -> Option<(&'w str, &'w Weapon)> {
    let name = world.strings.text(self.num(world, self.armed, self.weapon, entity)? as u32);
    weapons.0.get_key_value(name).map(|(name, spec)| (name.as_str(), spec))
  }

  fn stance<'w>(&self, world: &'w World, entity: Entity) -> &'w str {
    self.num(world, self.tactics, self.stance, entity).map_or("defensive", |stance| world.strings.text(stance as u32))
  }

  fn patrols(&self, world: &World, entity: Entity) -> bool {
    let store = &world.stores[self.tactics];
    store.row(entity).is_some_and(|row| store.anys[self.patrol][row].as_array().is_some_and(|patrol| !patrol.is_empty()))
  }

  fn armed(&self, world: &World, entity: Entity) -> Option<Armed> {
    let store = &world.stores[self.armed];
    let row = store.row(entity)?;
    let get = |slot: usize| store.nums[slot][row];
    Some(Armed { target: get(self.target), chase: get(self.chase) == 1.0, cooldown: get(self.cooldown), stuck: get(self.stuck), ordered: get(self.ordered) == 1.0 })
  }

  fn put_armed(&self, world: &mut World, entity: Entity, armed: Armed) {
    let store = &mut world.stores[self.armed];
    let Some(row) = store.row(entity) else { return };
    for (slot, value) in [(self.target, armed.target), (self.chase, armed.chase as u8 as f64), (self.cooldown, armed.cooldown), (self.stuck, armed.stuck), (self.ordered, armed.ordered as u8 as f64)] {
      store.nums[slot][row] = value;
    }
  }

  /// Юнит уходит в погоню без приказа: запоминает, откуда (`leaveHome`).
  fn leave_home(&self, world: &mut World, entity: Entity) {
    if !world.has(entity, self.tactics) {
      let _ = world.add(entity, self.tactics, &Map::new());
    }
    if self.flag(world, self.tactics, self.away, entity) || self.patrols(world, entity) {
      return;
    }
    let (x, y) = self.position(world, entity).unwrap_or((0.0, 0.0));
    self.put(world, self.tactics, self.away, entity, 1.0);
    self.put(world, self.tactics, self.home_x, entity, x.floor());
    self.put(world, self.tactics, self.home_y, entity, y.floor());
  }
}

/// Всё, во что можно попасть: юнит или здание (`Mark`).
struct Mark {
  entity: Entity,
  player: f64,
  x: f64,
  y: f64,
  left: f64,
  top: f64,
  width: f64,
  height: f64,
  radius: f64,
  air: bool,
  armor: &'static str,
  wall: bool,
  hp: f64,
  value: f64,
  hit: f64,
  arms: Option<u8>,
}

/// Расстояние от точки до прямоугольника; внутри — ноль (`rectDistance`).
fn rect_distance(left: f64, top: f64, width: f64, height: f64, x: f64, y: f64) -> f64 {
  js_hypot((left - x).max(0.0).max(x - left - width), (top - y).max(0.0).max(y - top - height))
}

fn distance_to(mark: &Mark, x: f64, y: f64) -> f64 {
  0f64.max(rect_distance(mark.left, mark.top, mark.width, mark.height, x, y) - mark.radius)
}

fn hostile(a: f64, b: f64) -> bool {
  a != b && a != 0.0 && b != 0.0
}

fn friend(friends: &HashMap<u64, Vec<f64>>, player: f64, other: f64) -> bool {
  friends.get(&(player as u64)).is_some_and(|allies| allies.contains(&other))
}

fn on_turn(tick: u64, entity: Entity, ticks: u64) -> bool {
  (tick + entity as u64).is_multiple_of(ticks)
}

/// Метки по ячейкам (`gridOf`): каждая метка находится раз за поиск, в порядке ячеек.
struct Grid {
  cells: HashMap<(i64, i64), Vec<usize>>,
  seen: Vec<u32>,
  query: u32,
}

impl Grid {
  fn new(marks: &[Mark]) -> Self {
    let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (index, mark) in marks.iter().enumerate() {
      let left = (mark.left / MARK_CELL).floor() as i64;
      let top = (mark.top / MARK_CELL).floor() as i64;
      let right = ((mark.left + mark.width) / MARK_CELL).floor() as i64;
      let bottom = ((mark.top + mark.height) / MARK_CELL).floor() as i64;
      for y in top..=bottom {
        for x in left..=right {
          cells.entry((x, y)).or_default().push(index);
        }
      }
    }
    Self { cells, seen: vec![0; marks.len()], query: 0 }
  }

  fn near(&mut self, x: f64, y: f64, radius: f64) -> Vec<usize> {
    self.query += 1;
    let mut found = Vec::new();
    let reach = radius + MARK_PAD;
    let bottom = ((y + reach) / MARK_CELL).floor() as i64;
    let right = ((x + reach) / MARK_CELL).floor() as i64;
    for cell_y in ((y - reach) / MARK_CELL).floor() as i64..=bottom {
      for cell_x in ((x - reach) / MARK_CELL).floor() as i64..=right {
        let Some(cell) = self.cells.get(&(cell_x, cell_y)) else { continue };
        for &index in cell {
          if self.seen[index] == self.query {
            continue;
          }
          self.seen[index] = self.query;
          found.push(index);
        }
      }
    }
    found
  }
}

/// Состояние оружия (`Armed`).
#[derive(Clone, Copy)]
struct Armed {
  target: f64,
  chase: bool,
  cooldown: f64,
  stuck: f64,
  ordered: bool,
}

/// Гонящийся за целью носитель (`Pursuer`).
struct Pursuer {
  entity: Entity,
  x: f64,
  y: f64,
  radius: f64,
  reach: f64,
  foot: bool,
  settled: bool,
  player: f64,
}

/// Взрыв тика: ground — в землю, такой оставляет гарь.
struct Blast {
  x: f64,
  y: f64,
  size: f64,
  ground: bool,
}

/// То, что поворачивается: юнит или турель (`turnerOf`); поворот и откуда вылетает выстрел — из `Armed`.
struct Turner {
  entity: Entity,
  turret: bool,
  turn: f64,
  radius: f64,
}

impl Turner {
  fn of(cols: &Cols, world: &World, entity: Entity) -> Self {
    let turn = cols.num(world, cols.armed, cols.turn, entity).unwrap_or(0.0);
    let radius = cols.num(world, cols.armed, cols.muzzle, entity).unwrap_or(0.0);
    Self { entity, turret: world.has(entity, cols.attached), turn, radius }
  }

  /// Поворот носителя турели: она хранит угол относительно него.
  fn base(&self, cols: &Cols, world: &World) -> f64 {
    cols.num(world, cols.facing, 0, cols.carrier(world, self.entity)).unwrap_or(0.0)
  }

  fn facing(&self, cols: &Cols, world: &World) -> f64 {
    if self.turret {
      wrap(self.base(cols, world) + cols.num(world, cols.attached, cols.angle, self.entity).unwrap_or(0.0))
    } else {
      cols.num(world, cols.facing, 0, self.entity).unwrap_or(0.0)
    }
  }

  fn set_facing(&self, cols: &Cols, world: &mut World, value: f64) {
    if self.turret {
      let base = self.base(cols, world);
      let angle = wrap(value - base);
      cols.put(world, cols.attached, cols.angle, self.entity, angle);
      cols.put(world, cols.facing, 0, self.entity, base + angle);
    } else {
      cols.put(world, cols.facing, 0, self.entity, value);
    }
  }
}

/// Купол щита, который держится в этот тик (`Dome`).
struct Dome {
  entity: Entity,
  player: f64,
  x: f64,
  y: f64,
  radius: f64,
}

/// Бой: всё, что знает тик боя о мире, — метки, сетка, союзы, турели носителей, погибшие и взрывы.
struct Fight<'a> {
  cols: Cols,
  weapons: &'a Weapons,
  marks: Vec<Mark>,
  index: HashMap<Entity, usize>,
  grid: Grid,
  dead: Vec<Entity>,
  dead_set: HashSet<Entity>,
  blasts: Vec<Blast>,
  friends: HashMap<u64, Vec<f64>>,
  turrets: HashMap<Entity, Vec<Entity>>,
  tick: u64,
  step: f64,
  domes: Vec<Dome>,
  signals: Vec<Signal>,
}

impl Fight<'_> {
  /// Держит ли купол удар сейчас: с запасом и не погашен.
  fn holds(&self, world: &World, dome: &Dome) -> bool {
    let cols = &self.cols;
    let charge = cols.num(world, cols.shield, slot(world, cols.shield, "charge"), dome.entity).unwrap_or(0.0);
    let down = cols.num(world, cols.shield, slot(world, cols.shield, "down"), dome.entity).unwrap_or(0.0);
    charge > 0.0 && self.tick as f64 >= down
  }

  /// Списывает урон с запаса купола; запас кончился — купол гаснет на свой срок. Возвращает, сколько списано (`drain`).
  fn drain(&self, world: &mut World, dome: usize, damage: f64) -> f64 {
    let cols = &self.cols;
    let entity = self.domes[dome].entity;
    let field = |name: &str| slot(world, cols.shield, name);
    let (charge_at, hit_at, down_at, recover_at) = (field("charge"), field("hit"), field("down"), field("recover"));
    let charge = cols.num(world, cols.shield, charge_at, entity).unwrap_or(0.0);
    let taken = charge.min(damage);
    let left = charge - taken;
    cols.put(world, cols.shield, hit_at, entity, self.tick as f64);
    if left <= 0.0 {
      let recover = cols.num(world, cols.shield, recover_at, entity).unwrap_or(0.0);
      cols.put(world, cols.shield, charge_at, entity, 0.0);
      cols.put(world, cols.shield, down_at, entity, self.tick as f64 + js_round(recover / self.step));
    } else {
      cols.put(world, cols.shield, charge_at, entity, left);
    }
    taken
  }

  /// Гасит урон по цели игрока player в (x, y), пришедший из (from_x, from_y); from_air — стрелял летающий. Урон
  /// берёт тот из подходящих куполов, у кого запас больше. Возвращает, сколько прошло сквозь щит (`absorb`).
  #[allow(clippy::too_many_arguments)]
  fn absorb(&self, world: &mut World, player: f64, x: f64, y: f64, damage: f64, from_x: f64, from_y: f64, from_air: bool) -> f64 {
    let charge_at = slot(world, self.cols.shield, "charge");
    let mut best: Option<(usize, f64)> = None;
    for (at, dome) in self.domes.iter().enumerate() {
      if !self.holds(world, dome) || js_hypot(x - dome.x, y - dome.y) > dome.radius {
        continue;
      }
      if !from_air && js_hypot(from_x - dome.x, from_y - dome.y) <= dome.radius {
        continue;
      }
      if dome.player != player && !friend(&self.friends, dome.player, player) {
        continue;
      }
      let charge = self.cols.num(world, self.cols.shield, charge_at, dome.entity).unwrap_or(0.0);
      if best.is_none_or(|(_, most)| charge > most) {
        best = Some((at, charge));
      }
    }
    match best {
      Some((dome, _)) => damage - self.drain(world, dome, damage),
      None => damage,
    }
  }

  /// Купол, который остановит снаряд игрока player, летящий из (x, y) в (to_x, to_y) за этот тик, и точка на его краю,
  /// где снаряд рвётся (`stopper`). Останавливает купол чужого, если снаряд входит в него снаружи, а сброшенный
  /// летающим — и уже внутри: бомба падает сверху. Из нескольких — первый на пути.
  #[allow(clippy::too_many_arguments)]
  fn stopper(&self, world: &World, player: f64, x: f64, y: f64, to_x: f64, to_y: f64, from_air: bool) -> Option<(usize, f64, f64)> {
    let mut best: Option<(usize, f64, f64, f64)> = None;
    let (dx, dy) = (to_x - x, to_y - y);
    for (at, dome) in self.domes.iter().enumerate() {
      if !self.holds(world, dome) || dome.player == player || friend(&self.friends, dome.player, player) {
        continue;
      }
      if js_hypot(x - dome.x, y - dome.y) <= dome.radius {
        if from_air && best.is_none_or(|(_, _, _, first)| first > 0.0) {
          best = Some((at, x, y, 0.0));
        }
        continue;
      }
      // Где отрезок пути входит в круг: наименьший корень |p + t·d − c| = r на [0, 1].
      let (fx, fy) = (x - dome.x, y - dome.y);
      let a = dx * dx + dy * dy;
      if a == 0.0 {
        continue;
      }
      let b = 2.0 * (fx * dx + fy * dy);
      let c = fx * fx + fy * fy - dome.radius * dome.radius;
      let disc = b * b - 4.0 * a * c;
      if disc < 0.0 {
        continue;
      }
      let t = (-b - disc.sqrt()) / (2.0 * a);
      if !(0.0..=1.0).contains(&t) || best.is_some_and(|(_, _, _, first)| first <= t) {
        continue;
      }
      best = Some((at, x + dx * t, y + dy * t, t));
    }
    best.map(|(dome, x, y, _)| (dome, x, y))
  }

  fn mark(&self, entity: Entity) -> Option<usize> {
    self.index.get(&entity).copied()
  }

  fn kill(&mut self, entity: Entity) {
    if self.dead_set.insert(entity) {
      self.dead.push(entity);
    }
  }

  /// Сущность и её турели.
  fn gunners(&self, entity: Entity) -> Vec<Entity> {
    let mut all = vec![entity];
    all.extend(self.turrets.get(&entity).into_iter().flatten().copied());
    all
  }

  fn can_hit(&self, weapon: &Weapon, player: f64, mark: usize) -> bool {
    let mark = &self.marks[mark];
    hostile(player, mark.player) && !friend(&self.friends, player, mark.player) && (if mark.air { weapon.air } else { !weapon.only_air }) && !self.dead_set.contains(&mark.entity)
  }

  /// Может ли метка навредить такому стрелку (`threatens`).
  fn threatens(&mut self, world: &World, mark: usize, air: bool) -> bool {
    let arms = match self.marks[mark].arms {
      Some(arms) => arms,
      None => {
        let mut arms = 0;
        for gunner in self.gunners(self.marks[mark].entity) {
          let Some((_, spec)) = self.cols.weapon(world, self.weapons, gunner) else { continue };
          arms |= (if spec.only_air { 0 } else { 1 }) | (if spec.air { 2 } else { 0 });
        }
        self.marks[mark].arms = Some(arms);
        arms
      }
    };
    arms & (if air { 2 } else { 1 }) != 0
  }

  /// Наносит урон метке (`hit`): source — кто стрелял.
  /// (from_x, from_y) — откуда пришло: щит гасит только пришедшее из-за купола.
  #[allow(clippy::too_many_arguments)]
  fn hit(&mut self, world: &mut World, mark: usize, amount: f64, weapon: &Weapon, source: Entity, from_x: f64, from_y: f64) {
    let entity = self.marks[mark].entity;
    if self.dead_set.contains(&entity) {
      return;
    }
    self.marks[mark].hit = self.tick as f64;
    let mut damage = amount * weapon.vs.get(self.marks[mark].armor).copied().unwrap_or(1.0);
    if !self.domes.is_empty() {
      let from_air = self.mark(source).is_some_and(|from| self.marks[from].air);
      let (player, x, y) = (self.marks[mark].player, self.marks[mark].x, self.marks[mark].y);
      damage = self.absorb(world, player, x, y, damage, from_x, from_y, from_air);
    }
    self.marks[mark].value -= damage / self.marks[mark].hp;
    if self.marks[mark].value <= 0.0 {
      self.kill(entity);
      return;
    }
    let Some(from) = self.mark(source) else { return };
    let cols = &self.cols;
    if world.has(entity, cols.path) && !cols.patrols(world, entity) {
      return;
    }
    let unit = world.has(entity, cols.mover);
    let stance = if unit { cols.stance(world, entity).to_owned() } else { "defensive".to_owned() };
    if stance == "passive" {
      return;
    }
    let player = self.marks[mark].player;
    let air = self.marks[mark].air;
    for gunner in self.gunners(entity) {
      let (Some(mut armed), Some((_, spec))) = (self.cols.armed(world, gunner), self.cols.weapon(world, self.weapons, gunner)) else { continue };
      if !self.can_hit(spec, player, from) {
        continue;
      }
      if armed.target != NONE {
        let busy = self.mark(armed.target as Entity);
        if armed.ordered || busy.is_none_or(|busy| self.threatens(world, busy, air)) {
          continue;
        }
      }
      armed.target = source as f64;
      armed.chase = unit && stance != "hold";
      armed.ordered = false;
      armed.stuck = 0.0;
      self.cols.put_armed(world, gunner, armed);
      if armed.chase {
        self.cols.leave_home(world, entity);
      }
    }
  }

  /// Попадание в точку (`impact`): урон цели или всем врагам в радиусе взрыва; blocked — только стенам.
  #[allow(clippy::too_many_arguments)]
  fn impact(&mut self, world: &mut World, weapon: &Weapon, player: f64, source: Entity, target: f64, (x, y): (f64, f64), (from_x, from_y): (f64, f64), blocked: bool) {
    let Some(splash) = weapon.splash else {
      if let Some(mark) = (target >= 0.0).then(|| self.mark(target as Entity)).flatten() {
        if self.can_hit(weapon, player, mark) {
          self.hit(world, mark, weapon.damage, weapon, source, from_x, from_y);
        }
      }
      return;
    };
    for mark in self.grid.near(x, y, splash) {
      if blocked && !self.marks[mark].wall {
        continue;
      }
      if !self.can_hit(weapon, player, mark) {
        continue;
      }
      let distance = distance_to(&self.marks[mark], x, y);
      if distance > splash {
        continue;
      }
      self.hit(world, mark, weapon.damage * (1.0 - (1.0 - SPLASH_EDGE) * (distance / splash)), weapon, source, from_x, from_y);
    }
  }

  fn signal(&mut self, name: &str, payload: Value) {
    self.signals.push(Signal { name: name.to_owned(), payload });
  }
}

/// Метки мира: юниты, потом здания (`collectMarks`).
fn collect_marks(cols: &Cols, world: &World) -> (Vec<Mark>, HashMap<Entity, usize>) {
  let mut marks = Vec::new();
  let mut index = HashMap::new();
  let health = &world.stores[cols.health];
  for (row, &entity) in health.entities.iter().enumerate() {
    let Some((x, y)) = cols.position(world, entity) else { continue };
    let (value, hit, hp) = (health.nums[cols.value][row], health.nums[cols.hit][row], health.nums[cols.hp][row]);
    let player = cols.owner(world, entity);
    let mark = if let Some(class) = cols.class(world, entity) {
      let radius = cols.num(world, cols.mover, cols.mover_radius, entity).unwrap_or(0.0);
      let armor: &'static str = match class {
        "infantry" => "infantry",
        "heavy" => "heavy",
        "air" => "air",
        _ => "vehicle",
      };
      Mark { entity, player, x, y, left: x, top: y, width: 0.0, height: 0.0, radius, air: armor == "air", armor, wall: false, hp, value, hit, arms: None }
    } else if world.has(entity, cols.footprint) {
      let width = cols.num(world, cols.footprint, cols.width, entity).unwrap_or(1.0);
      let height = cols.num(world, cols.footprint, cols.height, entity).unwrap_or(1.0);
      let wall = cols.flag(world, cols.footprint, cols.wall, entity) && !cols.flag(world, cols.footprint, cols.passable, entity);
      Mark { entity, player, x, y, left: x - width / 2.0, top: y - height / 2.0, width, height, radius: 0.0, air: false, armor: "building", wall, hp, value, hit, arms: None }
    } else {
      continue;
    };
    index.insert(entity, marks.len());
    marks.push(mark);
  }
  // Юниты — первыми, как в TS: от порядка зависит, кого поиск найдёт раньше.
  let mut order: Vec<usize> = (0..marks.len()).collect();
  order.sort_by_key(|&at| marks[at].armor == "building");
  let mut sorted = Vec::with_capacity(marks.len());
  let mut slots: Vec<Option<Mark>> = marks.into_iter().map(Some).collect();
  index.clear();
  for at in order {
    let mark = slots[at].take().expect("метка");
    index.insert(mark.entity, sorted.len());
    sorted.push(mark);
  }
  (sorted, index)
}

/// Союзы: игрок → его союзники (`alliances`).
fn alliances(cols: &Cols, world: &World) -> HashMap<u64, Vec<f64>> {
  let store = &world.stores[cols.player];
  let mut all = HashMap::new();
  for row in 0..store.len() {
    let allies: Vec<f64> = store.anys[cols.allies][row].as_array().map(|list| list.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
    if !allies.is_empty() {
      all.insert(store.nums[cols.player_id][row] as u64, allies);
    }
  }
  all
}

/// Первая чужая стена на отрезке выстрела и точка входа в неё (`wallOnPath`).
fn wall_on_path(scene: &mut Scene, fight: &Fight, player: f64, (x0, y0): (f64, f64), (x1, y1): (f64, f64)) -> Option<(Entity, f64, f64)> {
  let (dx, dy) = (x1 - x0, y1 - y0);
  if dx == 0.0 && dy == 0.0 {
    return None;
  }
  let (last_x, last_y) = (x1.floor() as i32, y1.floor() as i32);
  let step_x = if dx > 0.0 { 1 } else { -1 };
  let step_y = if dy > 0.0 { 1 } else { -1 };
  let delta_x = if dx != 0.0 { (1.0 / dx).abs() } else { f64::INFINITY };
  let delta_y = if dy != 0.0 { (1.0 / dy).abs() } else { f64::INFINITY };
  let (mut tile_x, mut tile_y) = (x0.floor() as i32, y0.floor() as i32);
  let mut cross_x = if dx != 0.0 { (if dx > 0.0 { tile_x as f64 + 1.0 - x0 } else { x0 - tile_x as f64 }) / dx.abs() } else { f64::INFINITY };
  let mut cross_y = if dy != 0.0 { (if dy > 0.0 { tile_y as f64 + 1.0 - y0 } else { y0 - tile_y as f64 }) / dy.abs() } else { f64::INFINITY };
  let mut t = 0.0;
  for _ in 0..64 {
    if let Some(building) = scene.occupant(tile_x, tile_y) {
      let owner = fight.cols.owner(scene.world, building);
      if fight.mark(building).is_some_and(|mark| fight.marks[mark].wall) && owner != player && !friend(&fight.friends, player, owner) {
        return Some((building, x0 + dx * t, y0 + dy * t));
      }
    }
    if tile_x == last_x && tile_y == last_y {
      return None;
    }
    if cross_x < cross_y {
      t = cross_x;
      tile_x += step_x;
      cross_x += delta_x;
    } else {
      t = cross_y;
      tile_y += step_y;
      cross_y += delta_y;
    }
  }
  None
}

/// Места вокруг цели для гонящихся (`slotsAround`).
fn slots_around(scene: &mut Scene, fight: &mut Fight, target: usize, pursuers: &[Pursuer]) -> HashMap<Entity, (f64, f64)> {
  let mut slots = HashMap::new();
  let mut taken: HashMap<(i64, i64), Vec<(f64, f64, f64)>> = HashMap::new();
  let cell = |x: f64, y: f64| ((x / SLOT_CELL).floor() as i64, (y / SLOT_CELL).floor() as i64);
  let free = |taken: &HashMap<(i64, i64), Vec<(f64, f64, f64)>>, x: f64, y: f64, radius: f64| {
    let (cell_x, cell_y) = cell(x, y);
    for dy in -1..=1 {
      for dx in -1..=1 {
        for &(other_x, other_y, other) in taken.get(&(cell_x + dx, cell_y + dy)).map(Vec::as_slice).unwrap_or_default() {
          if js_hypot(other_x - x, other_y - y) < other + radius + SLOT_GAP {
            return false;
          }
        }
      }
    }
    true
  };
  let mark = &fight.marks[target];
  let (target_entity, target_radius, width, height) = (mark.entity, mark.radius, mark.width, mark.height);
  let center_x = mark.left + width / 2.0;
  let center_y = mark.top + height / 2.0;
  let mut order: Vec<&Pursuer> = pursuers.iter().collect();
  order.sort_by(|a, b| {
    let by_settled = (b.settled as i32 - a.settled as i32) as f64;
    let key = if by_settled != 0.0 { by_settled } else { js_hypot(a.x - center_x, a.y - center_y) - js_hypot(b.x - center_x, b.y - center_y) };
    key.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
  });
  let mut full: Vec<(f64, f64)> = Vec::new();
  for pursuer in order {
    if pursuer.settled {
      taken.entry(cell(pursuer.x, pursuer.y)).or_default().push((pursuer.x, pursuer.y, pursuer.radius));
      continue;
    }
    let bearing = js_atan2(pursuer.y - center_y, pursuer.x - center_x);
    let ring = pursuer.reach + target_radius + width.min(height) / 2.0;
    if full.iter().any(|&(other, radius)| (other - ring).abs() < FULL_RING && radius <= pursuer.radius) {
      continue;
    }
    let step = (pursuer.radius + SLOT_GAP / 2.0) / ring.max(1.0);
    let mut k = 0.0;
    while k * step <= std::f64::consts::PI {
      let angles = if k != 0.0 { vec![bearing + k * step, bearing - k * step] } else { vec![bearing] };
      let mut found = None;
      for angle in angles {
        let (dx, dy) = (js_cos(angle), js_sin(angle));
        let edge = (if dx != 0.0 { width / 2.0 / dx.abs() } else { f64::INFINITY }).min(if dy != 0.0 { height / 2.0 / dy.abs() } else { f64::INFINITY });
        let out = (if edge.is_finite() { edge } else { 0.0 }) + target_radius + pursuer.reach;
        let (x, y) = (center_x + dx * out, center_y + dy * out);
        if !scene.walkable(x.floor() as i32, y.floor() as i32, pursuer.foot) || !free(&taken, x, y, pursuer.radius) {
          continue;
        }
        if k * step > std::f64::consts::PI / 2.0 && guarded(fight, target_entity, x, y, pursuer.player) {
          continue;
        }
        found = Some((x, y));
        break;
      }
      k += 1.0;
      let Some((x, y)) = found else { continue };
      slots.insert(pursuer.entity, (x, y));
      taken.entry(cell(x, y)).or_default().push((x, y, pursuer.radius));
      break;
    }
    if !slots.contains_key(&pursuer.entity) {
      full.push((ring, pursuer.radius));
    }
  }
  slots
}

/// Есть ли у места другие враги, кроме самой цели.
fn guarded(fight: &mut Fight, target: Entity, x: f64, y: f64, player: f64) -> bool {
  fight.grid.near(x, y, GUARD_RANGE).into_iter().any(|index| {
    let mark = &fight.marks[index];
    mark.entity != target && hostile(player, mark.player) && !friend(&fight.friends, player, mark.player) && !fight.dead_set.contains(&mark.entity) && distance_to(mark, x, y) <= GUARD_RANGE
  })
}

/// Взрыв в точке: сколько тиков он виден.
fn blast_life(size: f64, step: f64) -> f64 {
  js_round((0.25 + size * 0.2) / step)
}

fn spawn(world: &mut World, parts: Vec<(ComponentId, Value)>) -> Entity {
  let entity = world.spawn();
  for (component, values) in parts {
    let Value::Object(values) = values else { continue };
    let _ = world.add(entity, component, &values);
  }
  entity
}

/// Снаряд, долетевший в этот тик.
struct Landed<'w> {
  entity: Entity,
  weapon: &'w Weapon,
  player: f64,
  source: Entity,
  target: f64,
  x: f64,
  y: f64,
  from_x: f64,
  from_y: f64,
  blocked: bool,
  air: bool,
}

/// Купола щитов, которые держатся в этот тик (`domes`): с запасом и не погашенные.
fn collect_domes(cols: &Cols, world: &World, tick: u64) -> Vec<Dome> {
  let store = &world.stores[cols.shield];
  let field = |name: &str| slot(world, cols.shield, name);
  let (charge, down, radius) = (field("charge"), field("down"), field("radius"));
  let mut domes = Vec::new();
  for (row, &entity) in store.entities.iter().enumerate() {
    if store.nums[charge][row] <= 0.0 || (tick as f64) < store.nums[down][row] {
      continue;
    }
    let Some((x, y)) = cols.position(world, entity) else { continue };
    domes.push(Dome { entity, player: cols.owner(world, entity), x, y, radius: store.nums[radius][row] });
  }
  domes
}

/// Система боя (`fight`): снаряды, стрелки, гибель.
pub fn fight(state: &mut State) {
  let (tick, step) = (state.tick, state.dt);
  let bounds = state.vision.as_ref().map(|vision| vision.bounds);
  let State { world, land, motion, rules, weapons, signals, events, layers, .. } = state;
  let mut scene = Scene { world, land: land.as_mut(), motion, bounds, rules, layers, tick };
  let cols = Cols::of(scene.world);
  let (marks, index) = collect_marks(&cols, scene.world);
  let grid = Grid::new(&marks);
  let friends = alliances(&cols, scene.world);
  let mut turrets: HashMap<Entity, Vec<Entity>> = HashMap::new();
  {
    let store = &scene.world.stores[cols.attached];
    for (row, &entity) in store.entities.iter().enumerate() {
      turrets.entry(store.nums[cols.parent][row] as Entity).or_default().push(entity);
    }
  }
  let domes = collect_domes(&cols, scene.world, tick);
  let mut fight = Fight { cols, weapons, marks, index, grid, dead: Vec::new(), dead_set: HashSet::new(), blasts: Vec::new(), friends, turrets, tick, step, domes, signals: Vec::new() };

  fly(&mut scene, &mut fight, step);
  shoot(&mut scene, &mut fight, tick, step);
  finish(&mut scene, &mut fight, step, events);
  signals.append(&mut fight.signals);
}

/// Взрывы доживают свой срок, снаряды летят; попадания — после обхода.
fn fly(scene: &mut Scene, fight: &mut Fight, step: f64) {
  let cols = &fight.cols;
  let world = &mut *scene.world;
  let mut gone = Vec::new();
  let (age_slot, life_slot) = (slot(world, cols.blast, "age"), slot(world, cols.blast, "life"));
  let blasts = &mut world.stores[cols.blast];
  for row in 0..blasts.len() {
    blasts.nums[age_slot][row] += 1.0;
    if blasts.nums[age_slot][row] >= blasts.nums[life_slot][row] {
      gone.push(blasts.entities[row]);
    }
  }

  let shot_slot = |name: &str| slot(world, cols.shot, name);
  let [weapon_at, age_at, life_at, to_x_at, to_y_at, prev_x_at, prev_y_at, target_at, player_at, source_at, blocked_at, air_at, from_x_at, from_y_at] = ["weapon", "age", "life", "toX", "toY", "prevX", "prevY", "target", "player", "source", "blocked", "air", "fromX", "fromY"].map(shot_slot);
  let mut landed = Vec::new();
  for entity in world.stores[cols.shot].entities.clone() {
    let Some((mut x, mut y)) = cols.position(world, entity) else { continue };
    let get = |world: &World, at: usize| cols.num(world, cols.shot, at, entity).unwrap_or(0.0);
    let Some(shot_weapon) = fight.weapons.0.get(world.strings.text(get(world, weapon_at) as u32)) else {
      gone.push(entity);
      continue;
    };
    let age = get(world, age_at) + 1.0;
    let life = get(world, life_at);
    cols.put(world, cols.shot, age_at, entity, age);
    let Some(speed) = shot_weapon.speed else {
      if age >= life {
        gone.push(entity);
      }
      continue;
    };
    let (mut to_x, mut to_y) = (get(world, to_x_at), get(world, to_y_at));
    let target = get(world, target_at);
    if shot_weapon.shot != "shell" {
      if let Some(mark) = (target >= 0.0).then(|| fight.mark(target as Entity)).flatten() {
        to_x = fight.marks[mark].x;
        to_y = fight.marks[mark].y;
      }
    }
    for (at, value) in [(prev_x_at, x), (prev_y_at, y), (to_x_at, to_x), (to_y_at, to_y)] {
      cols.put(world, cols.shot, at, entity, value);
    }
    let (dx, dy) = (to_x - x, to_y - y);
    let distance = js_hypot(dx, dy);
    let travel = speed * step;
    // Купол чужого щита на пути: снаряд рвётся на его краю, урон берёт щит, внутрь ничего не долетает.
    if !fight.domes.is_empty() {
      let share = if distance > 0.0 { (travel / distance).min(1.0) } else { 1.0 };
      let source = get(world, source_at) as Entity;
      let from_air = world.has(source, cols.mover) && cols.flies(world, source);
      if let Some((dome, stop_x, stop_y)) = fight.stopper(world, get(world, player_at), x, y, x + dx * share, y + dy * share, from_air) {
        fight.drain(world, dome, shot_weapon.damage);
        cols.put(world, cols.position, 0, entity, stop_x);
        cols.put(world, cols.position, 1, entity, stop_y);
        fight.blasts.push(Blast { x: stop_x, y: stop_y, size: shot_weapon.splash.unwrap_or(0.2), ground: false });
        gone.push(entity);
        continue;
      }
    }
    if distance <= travel || age >= life {
      let reached = distance <= travel;
      if reached {
        (x, y) = (to_x, to_y);
      }
      cols.put(world, cols.position, 0, entity, x);
      cols.put(world, cols.position, 1, entity, y);
      if reached || shot_weapon.splash.is_some() {
        let (player, source) = (get(world, player_at), get(world, source_at) as Entity);
        landed.push(Landed { entity, weapon: shot_weapon, player, source, target, x, y, from_x: get(world, from_x_at), from_y: get(world, from_y_at), blocked: get(world, blocked_at) == 1.0, air: get(world, air_at) == 1.0 });
      } else {
        gone.push(entity);
      }
      continue;
    }
    x += (dx / distance) * travel;
    y += (dy / distance) * travel;
    cols.put(world, cols.position, 0, entity, x);
    cols.put(world, cols.position, 1, entity, y);
  }
  for shot in landed {
    fight.impact(scene.world, shot.weapon, shot.player, shot.source, shot.target, (shot.x, shot.y), (shot.from_x, shot.from_y), shot.blocked);
    fight.blasts.push(Blast { x: shot.x, y: shot.y, size: shot.weapon.splash.unwrap_or(0.2), ground: !shot.air });
    gone.push(shot.entity);
  }
  for entity in gone {
    scene.world.destroy(entity);
  }
}

/// Стрелки: выбор цели, погоня, поворот и выстрел.
fn shoot(scene: &mut Scene, fight: &mut Fight, tick: u64, step: f64) {
  let shooters: Vec<Entity> = scene.world.stores[fight.cols.armed].entities.clone();

  // Кто за какой целью гонится — наземные носители, на начало тика.
  let mut pursuers: Vec<(Entity, Vec<Pursuer>)> = Vec::new();
  for &entity in &shooters {
    let cols = &fight.cols;
    let world = &*scene.world;
    let Some(armed) = cols.armed(world, entity) else { continue };
    if !armed.chase || armed.target == NONE {
      continue;
    }
    let carrier = cols.carrier(world, entity);
    let (Some(class), Some((_, spec))) = (cols.class(world, carrier), cols.weapon(world, fight.weapons, entity)) else { continue };
    let Some((x, y)) = cols.position(world, carrier) else { continue };
    if class == "air" {
      continue;
    }
    let reach = (spec.min_range.unwrap_or(0.0) + SLOT_MARGIN).max(spec.range - SLOT_MARGIN);
    let target = fight.mark(armed.target as Entity);
    let at = match pursuers.iter().position(|(other, _)| *other == armed.target as Entity) {
      Some(at) => at,
      None => {
        pursuers.push((armed.target as Entity, Vec::new()));
        pursuers.len() - 1
      }
    };
    let around = &mut pursuers[at].1;
    let known = around.iter().position(|pursuer| pursuer.entity == carrier);
    if known.is_some_and(|known| around[known].reach <= reach) {
      continue;
    }
    let settled = !world.has(carrier, cols.path) && target.is_some_and(|target| distance_to(&fight.marks[target], x, y) <= spec.range);
    let radius = cols.num(world, cols.mover, cols.mover_radius, carrier).unwrap_or(0.0);
    let pursuer = Pursuer { entity: carrier, x, y, radius, reach, foot: class == "infantry", settled, player: cols.owner(world, carrier) };
    match known {
      Some(known) => around[known] = pursuer,
      None => around.push(pursuer),
    }
  }
  let mut slots: HashMap<Entity, HashMap<Entity, (f64, f64)>> = HashMap::new();

  let in_chase = |fight: &Fight, world: &World, carrier: Entity| fight.gunners(carrier).into_iter().any(|gunner| fight.cols.armed(world, gunner).is_some_and(|armed| armed.chase && armed.target != NONE));

  let mut searches = 0;
  let mut chasing: HashSet<Entity> = HashSet::new();
  let searched_before = scene.motion.search.searched();
  let first = if shooters.is_empty() { 0 } else { ((tick * SHOOTER_STRIDE) % shooters.len() as u64) as usize };
  for turn in 0..shooters.len() {
    let entity = shooters[(first + turn) % shooters.len()];
    let Some(mut armed) = fight.cols.armed(scene.world, entity) else { continue };
    if armed.cooldown > 0.0 {
      armed.cooldown -= 1.0;
    }
    'shooter: {
      let cols = &fight.cols;
      let world = &*scene.world;
      let carrier = cols.carrier(world, entity);
      let mounted = carrier != entity;
      let body = fight.mark(carrier);
      let place = cols.position(world, entity);
      let turner = Turner::of(cols, world, entity);
      let weapon = cols.weapon(world, fight.weapons, entity);
      let (Some(body), Some((self_x, self_y)), Some((weapon_type, spec))) = (body, place, weapon) else { break 'shooter };
      let self_player = fight.marks[body].player;
      let body_air = fight.marks[body].air;
      let building = world.has(carrier, cols.footprint);
      let range = spec.range + if building { TOWER_RANGE } else { 0.0 };

      let mut target = if armed.target >= 0.0 { fight.mark(armed.target as Entity) } else { None };
      if target.is_some_and(|target| !fight.can_hit(spec, self_player, target)) {
        target = None;
      }
      let mover = carrier;
      let moving = world.has(mover, cols.path);
      let unit_carrier = world.has(carrier, cols.mover);
      // Расстрелявший магазин молчит: цель бросает и новой не ищет, пока не пополнится.
      let empty = unit_carrier && cols.num(world, cols.magazine, cols.ammo, carrier).is_some_and(|ammo| ammo < cols.num(world, cols.magazine, cols.least, carrier).unwrap_or(0.0) - EPSILON);
      if empty {
        // Путь погони — боя, а не игрока: гнаться больше не за чем.
        if armed.chase {
          scene.world.remove(mover, fight.cols.path);
        }
        armed.target = NONE;
        armed.chase = false;
        armed.ordered = false;
        break 'shooter;
      }
      let resupplying = cols.flag(world, cols.tactics, cols.resupply, carrier);
      let stance = if unit_carrier {
        if resupplying {
          "hold".to_owned()
        } else {
          cols.stance(world, carrier).to_owned()
        }
      } else {
        "defensive".to_owned()
      };
      let had_tactics = world.has(carrier, cols.tactics);
      let patrol = cols.patrols(world, carrier);
      let away = cols.flag(world, cols.tactics, cols.away, carrier);
      let patrolling = patrol || (stance == "aggressive" && away);
      let led = moving && !patrolling && !in_chase(fight, world, carrier);
      let sight = cols.num(world, cols.sight, 0, carrier).unwrap_or(0.0);
      let lookout = if unit_carrier && stance == "aggressive" && !led { range.max(sight) } else { range };
      let look = |fight: &mut Fight, world: &World, dangerous: bool| {
        let mut found = None;
        let mut best = f64::INFINITY;
        for mark in fight.grid.near(self_x, self_y, lookout) {
          if !fight.can_hit(spec, self_player, mark) {
            continue;
          }
          let danger = fight.threatens(world, mark, body_air);
          if dangerous && !danger {
            continue;
          }
          let distance = distance_to(&fight.marks[mark], self_x, self_y);
          if distance > lookout || distance < spec.min_range.unwrap_or(0.0) {
            continue;
          }
          let order = distance + (if fight.marks[mark].armor == "building" { range } else { 0.0 }) + (if danger { 0.0 } else { HARMLESS });
          if order >= best {
            continue;
          }
          best = order;
          found = Some(mark);
        }
        found
      };
      // Занятый целью, которую выбрал сам и которая ему не опасна, бросает её ради того, кто опасен.
      if let Some(current) = target {
        if !armed.ordered && stance != "passive" && on_turn(tick, entity, SCAN_TICKS) && !fight.threatens(world, current, body_air) {
          if let Some(danger) = look(fight, world, true) {
            target = Some(danger);
            armed.target = fight.marks[danger].entity as f64;
            armed.stuck = 0.0;
            if distance_to(&fight.marks[danger], self_x, self_y) > range && unit_carrier {
              armed.chase = true;
              fight.cols.leave_home(scene.world, carrier);
            }
          }
        }
      }
      let world = &*scene.world;
      let target = match target {
        Some(target) => target,
        None => {
          armed.target = NONE;
          armed.chase = false;
          armed.ordered = false;
          if stance == "passive" || (moving && !mounted && !patrolling) || !on_turn(tick, entity, SCAN_TICKS) {
            break 'shooter;
          }
          let Some(found) = look(fight, world, moving && !patrol && away) else { break 'shooter };
          armed.target = fight.marks[found].entity as f64;
          if distance_to(&fight.marks[found], self_x, self_y) > range {
            armed.chase = true;
            fight.cols.leave_home(scene.world, carrier);
          }
          found
        }
      };

      // Юнит в обороне, убежавший за врагом дальше поводка от места, где стоял, бросает погоню и вернётся туда.
      let cols = &fight.cols;
      let world = &*scene.world;
      if !armed.ordered && armed.chase && stance == "defensive" && had_tactics && cols.flag(world, cols.tactics, cols.away, carrier) {
        let home_x = cols.num(world, cols.tactics, cols.home_x, carrier).unwrap_or(0.0);
        let home_y = cols.num(world, cols.tactics, cols.home_y, carrier).unwrap_or(0.0);
        if js_hypot(self_x - home_x - 0.5, self_y - home_y - 0.5) > LEASH {
          armed.target = NONE;
          armed.chase = false;
          break 'shooter;
        }
      }

      let distance = distance_to(&fight.marks[target], self_x, self_y);
      if distance > range {
        if !armed.chase || !world.has(mover, cols.mover) {
          armed.target = NONE;
          break 'shooter;
        }
        if mounted && chasing.contains(&mover) {
          break 'shooter;
        }
        let every = if moving { CHASE_TICKS } else { SCAN_TICKS << (armed.stuck.min(STUCK_LIMIT) as u32) };
        if !on_turn(tick, entity, every) {
          break 'shooter;
        }
        let target_entity = fight.marks[target].entity;
        if !slots.contains_key(&target_entity) {
          let around = pursuers.iter().find(|(other, _)| *other == target_entity).map(|(_, list)| list.as_slice()).unwrap_or_default();
          let made = slots_around(scene, fight, target, around);
          slots.insert(target_entity, made);
        }
        let cols = &fight.cols;
        let world = &*scene.world;
        let slot = slots[&target_entity].get(&mover).copied();
        let (goal_x, goal_y) = match slot {
          Some((x, y)) => (x.floor(), y.floor()),
          None => (fight.marks[target].x.floor(), fight.marks[target].y.floor()),
        };
        let (at_x, at_y) = cols.position(world, mover).unwrap_or((0.0, 0.0));
        let close = slot.is_some_and(|(x, y)| js_hypot(at_x - x, at_y - y) < SLOT_REPLAN);
        let path = |at: usize| cols.num(world, cols.path, at, mover).unwrap_or(0.0);
        if world.has(mover, cols.path) && !close && (path(cols.path_slot) == 1.0) == slot.is_some() && (path(cols.path_goal_x) - goal_x).abs() <= 1.0 && (path(cols.path_goal_y) - goal_y).abs() <= 1.0 {
          break 'shooter;
        }
        let over = searches >= CHASE_SEARCHES || scene.motion.search.searched() - searched_before >= CHASE_TILES;
        searches += 1;
        if over {
          break 'shooter;
        }
        let near = if slot.is_some() { 0.0 } else { 0f64.max(spec.range - CHASE_MARGIN) + fight.marks[target].width.max(fight.marks[target].height) / 2.0 };
        chasing.insert(mover);
        let previous = scene.motion.search.open_quota(CHASE_TILES - (scene.motion.search.searched() - searched_before));
        scene.order_move(mover, goal_x as i32, goal_y as i32, None, 0.0, near, None);
        let cols = &fight.cols;
        if scene.world.has(mover, cols.path) {
          if slot.is_some() {
            cols.put(scene.world, cols.path, cols.path_slot, mover, 1.0);
          }
          armed.stuck = 0.0;
        } else if !scene.motion.search.cut() {
          armed.stuck += 1.0;
        }
        scene.motion.search.close_quota(previous);
        break 'shooter;
      }
      // В мёртвой зоне оружие молчит.
      if distance < spec.min_range.unwrap_or(0.0) {
        if !armed.chase {
          armed.target = NONE;
        }
        break 'shooter;
      }
      let (at_x, at_y) = cols.position(world, mover).unwrap_or((0.0, 0.0));
      let path = |at: usize| cols.num(world, cols.path, at, mover).unwrap_or(0.0);
      let to_slot = moving && path(cols.path_slot) == 1.0 && armed.chase && path(cols.path_wait) < SLOT_PATIENCE && js_hypot(at_x - path(cols.path_goal_x) - 0.5, at_y - path(cols.path_goal_y) - 0.5) > SLOT_REACH;
      if to_slot && !mounted {
        break 'shooter;
      }
      if moving && !to_slot && (!mounted || armed.chase || patrolling) {
        scene.world.remove(mover, cols.path);
      }

      let (target_x, target_y, target_air, target_entity) = (fight.marks[target].x, fight.marks[target].y, fight.marks[target].air, fight.marks[target].entity);
      let wanted = js_atan2(target_y - self_y, target_x - self_x);
      let facing = turner.facing(cols, scene.world);
      turner.set_facing(cols, scene.world, turn_toward(facing, wanted, turner.turn * step));
      if armed.cooldown > 0.0 || wrap(wanted - turner.facing(cols, scene.world)).abs() > AIM {
        break 'shooter;
      }
      // Носитель с долей работы (Throttle) перезаряжается во столько раз дольше, с нулевой — молчит: так контент
      // глушит турели зданий без энергии, выключенных и сворачивающихся.
      let share = cols.num(scene.world, cols.throttle, cols.share, carrier).unwrap_or(1.0);
      if share <= 0.0 {
        break 'shooter;
      }
      // Выстрел — из магазина носителя: не хватает — молчит, пока не пополнят.
      let cost = cols.num(scene.world, cols.armed, cols.cost, entity).unwrap_or(0.0);
      if cost > 0.0 {
        if let Some(ammo) = cols.num(scene.world, cols.magazine, cols.ammo, carrier) {
          if ammo < cost - EPSILON {
            break 'shooter;
          }
          cols.put(scene.world, cols.magazine, cols.ammo, carrier, (ammo - cost).max(0.0));
        }
      }
      armed.cooldown = 1f64.max(js_round(spec.reload / step / share));

      // Выстрел — из точки перед стрелком.
      let facing = turner.facing(cols, scene.world);
      let from_x = self_x + js_cos(facing) * turner.radius;
      let from_y = self_y + js_sin(facing) * turner.radius;
      let shot = |fields: Value| {
        let mut all = json!({ "weapon": weapon_type, "player": self_player, "source": carrier, "fromX": from_x, "fromY": from_y, "prevX": from_x, "prevY": from_y });
        all.as_object_mut().expect("поля").extend(fields.as_object().expect("поля").clone());
        all
      };
      let over_wall = building || body_air || target_air || !spec.stops_at_wall() || spec.lob;
      let wall = if over_wall { None } else { wall_on_path(scene, fight, self_player, (self_x, self_y), (target_x, target_y)) };
      let (hit_x, hit_y) = wall.map_or((target_x, target_y), |(_, x, y)| (x, y));
      let (position, shot_id) = (fight.cols.position, fight.cols.shot);
      if let Some(speed) = spec.speed {
        let reach = if spec.shot == "shell" { js_hypot(hit_x - from_x, hit_y - from_y) } else { range * OVERFLY };
        let life = 1f64.max((reach / speed / step).ceil());
        let target = wall.map_or(target_entity, |(wall, _, _)| wall);
        let fields = shot(json!({ "target": target, "toX": hit_x, "toY": hit_y, "blocked": wall.is_some(), "air": wall.is_none() && target_air, "life": life }));
        spawn(scene.world, vec![(position, json!({ "x": from_x, "y": from_y })), (shot_id, fields)]);
        break 'shooter;
      }
      if let Some((wall, _, _)) = wall {
        let fields = shot(json!({ "target": wall, "toX": hit_x, "toY": hit_y, "life": BEAM_TICKS }));
        spawn(scene.world, vec![(position, json!({ "x": from_x, "y": from_y })), (shot_id, fields)]);
        fight.signal("burn", json!({ "x": hit_x, "y": hit_y }));
        if let Some(mark) = fight.mark(wall) {
          fight.hit(scene.world, mark, spec.damage, spec, carrier, from_x, from_y);
        }
        break 'shooter;
      }
      // Лазер, разряд и огонь бьют сразу; разряд и огонь перескакивают дальше на ближайших врагов.
      let mut damage = spec.damage;
      let mut from = (from_x, from_y);
      let mut next = Some(target);
      let mut struck = HashSet::new();
      let mut jump = 0.0;
      while let Some(current) = next {
        if jump > spec.chain.unwrap_or(0.0) {
          break;
        }
        let (current_entity, current_x, current_y, current_air) = (fight.marks[current].entity, fight.marks[current].x, fight.marks[current].y, fight.marks[current].air);
        struck.insert(current_entity);
        let fields = shot(json!({ "fromX": from.0, "fromY": from.1, "target": current_entity, "toX": current_x, "toY": current_y, "life": BEAM_TICKS }));
        spawn(scene.world, vec![(position, json!({ "x": from.0, "y": from.1 })), (shot_id, fields)]);
        // Разряд, перескочивший под куполом, всё равно пришёл снаружи: щит судит по стрелку.
        fight.hit(scene.world, current, damage, spec, carrier, from_x, from_y);
        if !current_air {
          fight.signal("burn", json!({ "x": current_x, "y": current_y }));
        }
        damage *= CHAIN_DECAY;
        from = (current_x, current_y);
        next = None;
        let mut nearest = CHAIN_RANGE;
        for mark in fight.grid.near(current_x, current_y, CHAIN_RANGE) {
          if struck.contains(&fight.marks[mark].entity) || !fight.can_hit(spec, self_player, mark) {
            continue;
          }
          let distance = distance_to(&fight.marks[mark], current_x, current_y);
          if distance >= nearest {
            continue;
          }
          nearest = distance;
          next = Some(mark);
        }
        jump += 1.0;
      }
    }
    fight.cols.put_armed(scene.world, entity, armed);
  }
}

/// Едкое болото, гибель и взрывы.
fn finish(scene: &mut Scene, fight: &mut Fight, step: f64, events: &mut Vec<(String, Value)>) {
  // Обречённые: пришёл черёд — гибель, как от выстрела; что без прочности, просто пропадает.
  let doomed = scene.world.stores[fight.cols.doomed].entities.clone();
  for entity in doomed {
    let cols = &fight.cols;
    let left = cols.num(scene.world, cols.doomed, cols.doomed_left, entity).unwrap_or(0.0) - 1.0;
    cols.put(scene.world, cols.doomed, cols.doomed_left, entity, left);
    if left > 0.0 {
      continue;
    }
    if fight.index.contains_key(&entity) {
      fight.kill(entity);
    } else {
      scene.world.destroy(entity);
    }
  }

  // Аварии и ядерные удары бьют всех вокруг без разбора — своих и союзников тоже.
  let bursts = scene.world.stores[fight.cols.burst].entities.clone();
  for entity in bursts {
    let cols = &fight.cols;
    let Some((x, y)) = cols.position(scene.world, entity) else {
      scene.world.destroy(entity);
      continue;
    };
    let get = |name: &str| cols.num(scene.world, cols.burst, slot(scene.world, cols.burst, name), entity).unwrap_or(0.0);
    let (radius, damage, core) = (get("radius"), get("damage"), get("core"));
    for mark in fight.grid.near(x, y, radius) {
      if fight.dead_set.contains(&fight.marks[mark].entity) {
        continue;
      }
      let distance = distance_to(&fight.marks[mark], x, y);
      if distance > radius {
        continue;
      }
      let share = if distance <= core { 1.0 } else { (radius - distance) / (radius - core) };
      let target = &mut fight.marks[mark];
      target.hit = fight.tick as f64;
      target.value -= damage * share / target.hp;
      if target.value <= 0.0 {
        let dead = target.entity;
        fight.kill(dead);
      }
    }
    fight.blasts.push(Blast { x, y, size: radius, ground: true });
    scene.world.destroy(entity);
  }

  // Болото красных пустошей жжёт стоящих в нём наземных юнитов; мост над ним — покрытие — не жжёт.
  let burn = scene.rules.get("toxicSwamp") * step;
  if burn > 0.0 {
    let paved: Vec<bool> = fight.marks.iter().map(|mark| scene.paved(mark.x.floor() as i32, mark.y.floor() as i32) != 0).collect();
    if let Some(land) = scene.land.as_deref_mut() {
      for (at, mark) in fight.marks.iter_mut().enumerate() {
        if mark.air || mark.radius == 0.0 || fight.dead_set.contains(&mark.entity) || paved[at] {
          continue;
        }
        let [terrain, biome, ..] = land.tile(mark.x.floor() as i32, mark.y.floor() as i32);
        if terrain != SWAMP || biome >> 6 != RED_WASTES {
          continue;
        }
        mark.hit = fight.tick as f64;
        mark.value -= burn;
        if mark.value <= 0.0 && fight.dead_set.insert(mark.entity) {
          fight.dead.push(mark.entity);
        }
      }
    }
  }

  // Прочность — обратно в мир.
  let cols = &fight.cols;
  for mark in &fight.marks {
    if fight.dead_set.contains(&mark.entity) {
      continue;
    }
    cols.put(scene.world, cols.health, cols.value, mark.entity, mark.value);
    cols.put(scene.world, cols.health, cols.hit, mark.entity, mark.hit);
  }

  for entity in fight.dead.clone() {
    let mark = &fight.marks[fight.index[&entity]];
    let size = if mark.radius != 0.0 { mark.radius * 2.0 } else { mark.width.max(mark.height) * 0.7 };
    let (x, y, air, player, armor) = (mark.x, mark.y, mark.air, mark.player, mark.armor);
    fight.blasts.push(Blast { x, y, size, ground: !air });
    let cols = &fight.cols;
    let proto = cols.num(scene.world, cols.proto, 0, entity);
    let facing = cols.num(scene.world, cols.facing, 0, entity).unwrap_or(0.0);
    // От техники остаётся остов, от пехоты — только гарь.
    if !air && matches!(armor, "vehicle" | "heavy") {
      fight.signal("wreck", json!({ "x": x, "y": y, "facing": facing, "proto": proto }));
    }
    // Что было на погибшем — механикам: груз со склада, топливо и прочее, чего движок не знает.
    let remains = scene.world.components(entity);
    events.push(("killed".to_owned(), json!({ "entity": entity, "player": player, "x": x, "y": y, "air": air, "proto": proto, "remains": remains })));
    // Здание с топливом взрывается в следующем бою.
    let cols = &fight.cols;
    if scene.world.has(entity, cols.meltdown) {
      let get = |name: &str| cols.num(scene.world, cols.meltdown, slot(scene.world, cols.meltdown, name), entity).unwrap_or(0.0);
      let (radius, damage) = (get("radius"), get("damage"));
      let (position, burst) = (cols.position, cols.burst);
      spawn(scene.world, vec![(position, json!({ "x": x, "y": y })), (burst, json!({ "radius": radius, "damage": damage }))]);
    }
    scene.world.destroy(entity);
  }
  let (position, blast) = (fight.cols.position, fight.cols.blast);
  for item in std::mem::take(&mut fight.blasts) {
    spawn(scene.world, vec![(position, json!({ "x": item.x, "y": item.y })), (blast, json!({ "size": item.size, "life": blast_life(item.size, step) }))]);
    if item.ground {
      fight.signal("scar", json!({ "x": item.x, "y": item.y, "size": item.size }));
      // Механикам: наземный взрыв разбивает то, что лежит на земле (плиты фундамента).
      events.push(("blast".to_owned(), json!({ "x": item.x, "y": item.y, "size": item.size })));
    }
  }
}

/// Приказ атаковать (`orderAttack`): свои юниты из units и их турели берут цель target и идут к ней. false — никто не
/// может её достать.
pub fn order_attack(state: &mut State, player: f64, units: &[Entity], target: Entity) -> bool {
  let cols = Cols::of(&state.world);
  let world = &mut state.world;
  if !world.alive(target) || !world.has(target, cols.health) {
    return false;
  }
  let owner = cols.owner(world, target);
  let friends = alliances(&cols, world);
  if !hostile(player, owner) || friend(&friends, player, owner) {
    return false;
  }
  let air = cols.flies(world, target);
  let mut turrets: HashMap<Entity, Vec<Entity>> = HashMap::new();
  {
    let store = &world.stores[cols.attached];
    for (row, &entity) in store.entities.iter().enumerate() {
      turrets.entry(store.nums[cols.parent][row] as Entity).or_default().push(entity);
    }
  }
  let weapons = &state.weapons;
  // Берёт ли цель этот стрелок; отдаёт дальность его оружия или 0.
  let aim = |world: &mut World, entity: Entity| {
    let Some((_, spec)) = cols.weapon(world, weapons, entity) else { return 0.0 };
    let Some(mut armed) = cols.armed(world, entity) else { return 0.0 };
    if if air { !spec.air } else { spec.only_air } {
      return 0.0;
    }
    armed.target = target as f64;
    armed.chase = true;
    armed.ordered = true;
    armed.stuck = 0.0;
    cols.put_armed(world, entity, armed);
    spec.range
  };
  let mut ordered = false;
  let mut seen = HashSet::new();
  for &entity in units {
    if !seen.insert(entity) || cols.owner(world, entity) != player {
      continue;
    }
    // Приказ атаки снимает патруль и возвращение на место: юнит идёт за целью, куда велели.
    clear_tactics(&cols, world, entity);
    if aim(world, entity) != 0.0 {
      world.remove(entity, cols.path);
      ordered = true;
      continue;
    }
    // Безоружный носитель подвозит турели на выстрел: путь к цели ему проложит бой, как гонящемуся.
    let mut any = false;
    for &turret in turrets.get(&entity).into_iter().flatten() {
      any |= aim(world, turret) != 0.0;
    }
    if any {
      world.remove(entity, cols.path);
      ordered = true;
    }
  }
  ordered
}

/// Снимает патруль и возвращение на место (`clearTactics`).
fn clear_tactics(cols: &Cols, world: &mut World, entity: Entity) {
  if !world.has(entity, cols.tactics) {
    return;
  }
  let _ = world.set(entity, cols.tactics, &json!({ "patrol": [], "leg": 0, "away": false }).as_object().expect("поля").clone());
}

/// Стойка своим вооружённым юнитам (`setStance`): aggressive, defensive, hold или passive.
pub fn set_stance(state: &mut State, player: f64, units: &[Entity], stance: &str) -> bool {
  if !matches!(stance, "aggressive" | "defensive" | "hold" | "passive") {
    return false;
  }
  let cols = Cols::of(&state.world);
  let world = &mut state.world;
  let mut turrets: HashMap<Entity, Vec<Entity>> = HashMap::new();
  {
    let store = &world.stores[cols.attached];
    for (row, &entity) in store.entities.iter().enumerate() {
      turrets.entry(store.nums[cols.parent][row] as Entity).or_default().push(entity);
    }
  }
  let mut any = false;
  for &entity in units {
    if cols.owner(world, entity) != player || !world.has(entity, cols.mover) {
      continue;
    }
    let mut gunners = vec![entity];
    gunners.extend(turrets.get(&entity).into_iter().flatten().copied());
    if !gunners.iter().any(|&gunner| cols.weapon(world, &state.weapons, gunner).is_some()) {
      continue;
    }
    if !world.has(entity, cols.tactics) {
      let _ = world.add(entity, cols.tactics, &Map::new());
    }
    let _ = world.set(entity, cols.tactics, &json!({ "stance": stance }).as_object().expect("поля").clone());
    any = true;
    // Стрелять нельзя — бросает и самовыбранную цель; приказанную тоже: игрок сказал «не стрелять».
    if stance == "passive" {
      for gunner in gunners {
        if let Some(mut armed) = cols.armed(world, gunner) {
          armed.target = NONE;
          armed.chase = false;
          armed.ordered = false;
          cols.put_armed(world, gunner, armed);
        }
      }
    }
  }
  any
}

/// Турели без цели разворачиваются по корпусу носителя (`restTurrets`).
pub fn rest_turrets(state: &mut State) {
  let step = state.dt;
  let world = &mut state.world;
  let cols = Cols::of(world);
  for entity in world.stores[cols.attached].entities.clone() {
    let Some(armed) = cols.armed(world, entity) else { continue };
    if armed.target != NONE {
      continue;
    }
    let angle = cols.num(world, cols.attached, cols.angle, entity).unwrap_or(0.0);
    let turn = cols.num(world, cols.armed, cols.turn, entity).unwrap_or(0.0);
    cols.put(world, cols.attached, cols.angle, entity, turn_toward(angle, 0.0, turn * step));
  }
}
