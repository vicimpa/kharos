//! Мир, каким его знает подключение (View и Known в host.ts), и кадр того, что поменялось с прошлого раза. Хост
//! сверяет каждое подключение после тика: что игрок видит, какими компоненты ему ушли, какие призраки, слои, тайлы
//! земли и строки он уже знает.

use crate::frame::{runs_of, Change, Frame, Ghost, Part, Recalled, Value};
use crate::rules::{Relation, Rules};
use kharos_engine::layers::{Owner, Scope};
use kharos_world::host::{Signal, State};
use kharos_world::memory::Remembered;
use kharos_world::{ComponentId, Entity, Kind, World};
use serde_json::{Map, Value as Json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

/// Компонент, каким он ушёл: числа столбцов и таблицы по порядку полей схемы.
#[derive(Clone, Debug, PartialEq)]
struct Sent {
  component: ComponentId,
  nums: Vec<f64>,
  anys: Vec<Json>,
}

/// Общее для всех подключений за тик: правила, союзы, чанки слоёв, сигналы, сущности.
pub struct Shared {
  pub rules: Rc<Rules>,
  friends: BTreeMap<u32, Vec<u32>>,
  layers: Vec<kharos_engine::layers::Change>,
  signals: Vec<Signal>,
  entities: Vec<Entity>,
  /// Значения по умолчанию для скрытых полей и новых компонентов: по компоненту — числа столбцов и таблицы.
  defaults: Vec<(Vec<f64>, Vec<Json>)>,
}

impl Shared {
  /// После тика хоста: забирает изменённые чанки слоёв (их больше никто не берёт) и сигналы тика.
  pub fn after_tick(state: &mut State, rules: Rc<Rules>, signals: Vec<Signal>) -> Self {
    let layers = state.layers.take_changes();
    let world = &state.world;
    let defaults = world
      .schema
      .components
      .iter()
      .map(|component| {
        let mut nums = vec![0.0; component.nums];
        let mut anys = vec![Json::Null; component.anys];
        for field in &component.fields {
          match field.kind {
            Kind::Any => anys[field.slot] = field.default.clone(),
            // Строка по умолчанию, которой в мире ещё нет, не совпадёт ни с одним номером.
            Kind::Str => nums[field.slot] = field.default.as_str().and_then(|text| world.strings.find(text)).map_or(f64::NAN, f64::from),
            _ => nums[field.slot] = kharos_world::world::encode_checked(&mut Default::default(), field.kind, &field.default).unwrap_or(0.0),
          }
        }
        (nums, anys)
      })
      .collect();
    Self { friends: rules.friends(world), rules, layers, signals, entities: world.entities(), defaults }
  }
}

/// Мир, каким его знает одно подключение.
pub struct View {
  pub player: u32,
  started: bool,
  known: HashMap<Entity, Vec<Sent>>,
  strings: HashSet<u32>,
  ghosts: BTreeMap<Entity, Rc<Remembered>>,
  /// Запоминаемые слои: номер слоя, какую правку памяти видели, что ушло ((y, x) → каналы).
  recalls: BTreeMap<usize, (u64, BTreeMap<(i32, i32), Vec<f64>>)>,
  /// Земля: с какой правкой знания сверяли и что ушло.
  land_seen: Option<(u64, u64)>,
  land: BTreeMap<(i32, i32), [u8; 4]>,
}

fn fogged(state: &State) -> bool {
  state.vision.as_ref().is_some_and(|vision| vision.fog)
}

/// Видит ли смотрящий место (x, y): без тумана — всегда.
fn sees(state: &State, viewer: u32, x: f64, y: f64) -> bool {
  state.vision.as_ref().is_none_or(|vision| vision.sees(viewer, x, y))
}

impl View {
  pub fn new(player: u32) -> Self {
    Self { player, started: false, known: HashMap::new(), strings: HashSet::new(), ghosts: BTreeMap::new(), recalls: BTreeMap::new(), land_seen: None, land: BTreeMap::new() }
  }

  /// Уходит ли сущность игроку и кем она ему приходится: со списком зрителей — по нему, своё и игроки — всегда,
  /// запоминаемое чужое — по сверке памяти, остальное с местом — если он видит тайл под ней, без места — всегда (как `shows`, но и для того, что
  /// живёт не на карте).
  pub fn relation(&self, state: &State, shared: &Shared, entity: Entity) -> Option<Relation> {
    let world = &state.world;
    let rules = &shared.rules;
    let friends = shared.friends.get(&self.player).map_or(&[][..], Vec::as_slice);
    let relation = rules.relation(world, entity, self.player, friends);
    if let Some(listed) = rules.audience(world, entity, self.player, relation) {
      return listed.then_some(relation);
    }
    if relation == Relation::Mine || rules.is_player(world, entity) || !fogged(state) {
      return Some(relation);
    }
    if world.schema.id("Memorable").is_some_and(|memorable| world.has(entity, memorable)) {
      return state.memory.sees(self.player, entity).then_some(relation);
    }
    let Some(position) = world.schema.id("Position") else { return Some(relation) };
    match (world.num(entity, position, "x"), world.num(entity, position, "y")) {
      (Some(x), Some(y)) => sees(state, self.player, x, y).then_some(relation),
      _ => Some(relation),
    }
  }

  /// Компоненты сущности, какими они уходят тому, кем она ему приходится relation.
  /// Сущность, какой её получит тот, кем она ему приходится relation: компоненты по именам, строки — строками.
  pub fn seen(world: &World, shared: &Shared, entity: Entity, relation: Relation) -> Map<String, Json> {
    let mut all = Map::new();
    for sent in Self::parts(world, shared, entity, relation) {
      let mut values = Map::new();
      for field in &world.schema.components[sent.component].fields {
        let value = match field.kind {
          Kind::Any => sent.anys[field.slot].clone(),
          Kind::Str if sent.nums[field.slot].is_nan() => field.default.clone(),
          kind => kharos_world::world::decode(&world.strings, kind, sent.nums[field.slot]),
        };
        values.insert(field.name.clone(), value);
      }
      all.insert(world.schema.components[sent.component].name.clone(), Json::Object(values));
    }
    all
  }

  fn parts(world: &World, shared: &Shared, entity: Entity, relation: Relation) -> Vec<Sent> {
    let rules = &shared.rules;
    let mut parts = Vec::new();
    for (component, store) in world.stores.iter().enumerate() {
      let Some(row) = store.row(entity) else { continue };
      if !rules.shows_component(world, entity, component, relation) {
        continue;
      }
      let mut sent = Sent { component, nums: store.nums.iter().map(|column| column[row]).collect(), anys: store.anys.iter().map(|column| column[row].clone()).collect() };
      let fields = &world.schema.components[component].fields;
      for index in rules.hidden_fields(component, relation) {
        let field = &fields[index];
        let (nums, anys) = &shared.defaults[component];
        match field.kind {
          Kind::Any => sent.anys[field.slot] = anys[field.slot].clone(),
          _ => sent.nums[field.slot] = nums[field.slot],
        }
      }
      parts.push(sent);
    }
    parts
  }

  /// Кадр того, что поменялось для игрока с прошлого раза. Первый приносит всё: видимое, призраки, слои, землю и
  /// разведанное.
  pub fn frame(&mut self, state: &mut State, shared: &Shared) -> Frame {
    let mut frame = Frame { tick: state.tick, ..Default::default() };
    let first = !self.started;
    self.started = true;
    self.entities(state, shared, &mut frame);
    self.ghosts(state, shared, &mut frame);
    self.layers(state, shared, first, &mut frame);
    self.land(state, &mut frame);
    self.signals(state, shared, &mut frame);
    if first && fogged(state) {
      let vision = state.vision.as_ref().expect("туман — у партии с картой");
      frame.explored = vision.cells.get(&self.player).map(|cells| runs_of(cells));
    }
    frame
  }

  fn entities(&mut self, state: &State, shared: &Shared, frame: &mut Frame) {
    let world = &state.world;
    let mut seen = HashSet::new();
    for &entity in &shared.entities {
      let Some(relation) = self.relation(state, shared, entity) else { continue };
      seen.insert(entity);
      let parts = Self::parts(world, shared, entity, relation);
      let was = self.known.get(&entity);
      let mut change = Change { entity, ..Default::default() };
      for part in &parts {
        let old = was.and_then(|was| was.iter().find(|old| old.component == part.component));
        let fields = &world.schema.components[part.component].fields;
        let (base_nums, base_anys) = match old {
          Some(old) => (&old.nums, &old.anys),
          None => (&shared.defaults[part.component].0, &shared.defaults[part.component].1),
        };
        let mut out = Part { component: part.component, added: old.is_none(), fields: Vec::new() };
        for (index, field) in fields.iter().enumerate() {
          if field.kind == Kind::Any {
            if part.anys[field.slot] != base_anys[field.slot] {
              out.fields.push((index, Value::Any(part.anys[field.slot].clone())));
            }
            continue;
          }
          let value = part.nums[field.slot];
          if value.to_bits() == base_nums[field.slot].to_bits() {
            continue;
          }
          if field.kind == Kind::Str && self.strings.insert(value as u32) {
            frame.strings.push((value as u32, world.strings.text(value as u32).to_string()));
          }
          out.fields.push((index, Value::Num(value)));
        }
        if out.added || !out.fields.is_empty() {
          change.parts.push(out);
        }
      }
      if let Some(was) = was {
        change.unset = was.iter().filter(|old| !parts.iter().any(|part| part.component == old.component)).map(|old| old.component).collect();
      }
      if !change.parts.is_empty() || !change.unset.is_empty() || was.is_none() {
        frame.changes.push(change);
      }
      self.known.insert(entity, parts);
    }
    let mut removed: Vec<Entity> = self.known.keys().copied().filter(|entity| !seen.contains(entity)).collect();
    removed.sort_unstable();
    for entity in &removed {
      self.known.remove(entity);
    }
    frame.removed = removed;
  }

  /// Запись памяти, какой её увидит игрок: компоненты и поля — по тем же правилам, что у живой сущности.
  fn ghost_of(&self, state: &State, shared: &Shared, record: &Remembered) -> Ghost {
    let world = &state.world;
    let rules = &shared.rules;
    let friends = shared.friends.get(&self.player).map_or(&[][..], Vec::as_slice);
    let owner = record.num("Owner", "player").filter(|&owner| owner > 0.0).map(|owner| owner as u32);
    let relation = match owner {
      None => Relation::Nobody,
      Some(owner) if owner == self.player => Relation::Mine,
      Some(owner) if friends.contains(&owner) => Relation::Ally,
      Some(_) => Relation::Foreign,
    };
    let mut parts = Map::new();
    for (name, values) in &record.parts {
      let Some(component) = world.schema.id(name) else { continue };
      let rule = &rules.rules[component];
      if !rule.to.lets(relation) && !rule.public.iter().any(|&other| record.parts.contains_key(&world.schema.components[other].name)) {
        continue;
      }
      let mut values = values.clone();
      if let Json::Object(map) = &mut values {
        for index in rules.hidden_fields(component, relation) {
          let field = &world.schema.components[component].fields[index];
          map.insert(field.name.clone(), field.default.clone());
        }
      }
      parts.insert(name.clone(), values);
    }
    Ghost { x: record.x, y: record.y, width: record.width, height: record.height, parts }
  }

  fn ghosts(&mut self, state: &State, shared: &Shared, frame: &mut Frame) {
    let now: BTreeMap<Entity, Rc<Remembered>> = state.ghosts(self.player).into_iter().collect();
    for (&entity, record) in &now {
      if !self.ghosts.get(&entity).is_some_and(|old| Rc::ptr_eq(old, record)) {
        frame.ghosts.push((entity, Some(self.ghost_of(state, shared, record))));
      }
    }
    for &entity in self.ghosts.keys() {
      if !now.contains_key(&entity) {
        frame.ghosts.push((entity, None));
      }
    }
    self.ghosts = now;
  }

  /// Чанки слоёв, которые уходят игроку: общие (у запоминаемых в тумане вместо них — память), свои и союзников.
  fn layers(&mut self, state: &State, shared: &Shared, first: bool, frame: &mut Frame) {
    let fog = fogged(state);
    let friends = shared.friends.get(&self.player).map_or(&[][..], Vec::as_slice);
    let layers = &state.layers;
    let wanted = |id: usize, owner: Owner| {
      let spec = layers.spec(id);
      spec.send
        && match (spec.scope, owner) {
          (Scope::World, _) => !(spec.remember && fog),
          (Scope::Player, Owner::Player(player)) => player == self.player || (spec.allies && friends.contains(&player)),
          _ => false,
        }
    };
    if first {
      for (id, spec) in layers.specs().enumerate() {
        let owners: Vec<Owner> = match spec.scope {
          Scope::World => vec![Owner::World],
          Scope::Player => layers.players().into_iter().map(Owner::Player).collect(),
        };
        for owner in owners.into_iter().filter(|&owner| wanted(id, owner)) {
          frame.layers.extend(layers.blocks(id, owner));
        }
      }
    } else {
      frame.layers.extend(shared.layers.iter().filter(|change| layers.id(&change.layer).is_some_and(|id| wanted(id, change.owner))).cloned());
    }
    if !fog {
      return;
    }
    for recall in &state.memory.layers {
      let (seen, sent) = self.recalls.entry(recall.layer).or_insert((u64::MAX, BTreeMap::new()));
      if *seen == recall.edits {
        continue;
      }
      *seen = recall.edits;
      let empty = BTreeMap::new();
      let known = recall.known.get(&self.player).unwrap_or(&empty);
      for (&(y, x), values) in known {
        if sent.get(&(y, x)) != Some(values) {
          frame.recalled.push(Recalled { layer: recall.layer, x, y, values: values.clone() });
        }
      }
      for &(y, x) in sent.keys() {
        if !known.contains_key(&(y, x)) {
          frame.recalled.push(Recalled { layer: recall.layer, x, y, values: Vec::new() });
        }
      }
      *sent = known.clone();
    }
  }

  /// Тайлы земли, которые игрок знает иначе, чем их рисует генератор.
  fn land(&mut self, state: &mut State, frame: &mut Frame) {
    let fog = fogged(state);
    let State { memory, land, .. } = state;
    let Some(land) = land.as_mut() else { return };
    let key = (memory.land.version.get(&self.player).copied().unwrap_or(0), if fog { 0 } else { memory.land.edits });
    if self.land_seen == Some(key) {
      return;
    }
    self.land_seen = Some(key);
    for (tile, bytes) in memory.land.known_of(land, self.player, fog) {
      if self.land.insert(tile, bytes) != Some(bytes) {
        frame.land.push((tile.0, tile.1, bytes));
      }
    }
  }

  /// Сигналы тика, которые касаются игрока: кому сказано (`to`), где он видит место (`x`, `y`) или чей (`player`);
  /// без адреса — всем.
  fn signals(&self, state: &State, shared: &Shared, frame: &mut Frame) {
    for signal in &shared.signals {
      let payload = &signal.payload;
      let number = |key: &str| payload.get(key).and_then(Json::as_f64);
      let player = number("player").map(|player| player as u32);
      let to = match payload.get("to") {
        Some(Json::Array(list)) => Some(list.iter().any(|one| one.as_f64() == Some(self.player as f64))),
        Some(one) => Some(one.as_f64() == Some(self.player as f64)),
        None => None,
      };
      let mine = match (to, number("x"), number("y")) {
        (Some(to), _, _) => to,
        (None, Some(x), Some(y)) => player == Some(self.player) || sees(state, self.player, x, y),
        (None, _, _) => player.is_none_or(|player| player == self.player),
      };
      if mine {
        frame.signals.push((signal.name.clone(), payload.clone()));
      }
    }
  }
}
