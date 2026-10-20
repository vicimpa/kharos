//! Память игроков (buildMemory.ts, recall.ts, paveMemory.ts; docs/layers.md, §2) — инструмент движка: что игрок знает
//! о мире, которого сейчас не видит.
//!
//! Сущности. Помечает мод компонентом движка `Memorable { width, height }` (здания, месторождения): чужая такая
//! сущность, ушедшая в туман войны, остаётся для игрока такой, какой он видел её последний раз, — призраком, — пока её
//! место (`width × height` тайлов вокруг Position) снова не окажется в обзоре. Снесённую на глазах игрок не помнит,
//! снесённую в тумане — помнит, пока не увидит пустое место.
//!
//! Слои. Слой мира с `remember = true` у каждого игрока свой — каким он его видел: изменения чужого он узнаёт, только
//! увидев. Своё и союзное (канал `owner` объявления) знает сразу. Помнится только расхождение с общим — пустым тайлом.
//!
//! Сверка — после пересчёта обзора, раз в `vision::TICKS`. Без тумана всё видно всегда: помнить нечего.

use crate::vision::{Vision, CELL};
use crate::world::{Entity, World};
use kharos_engine::layers::{LayerId, Layers, Owner, Shape, CHUNK};
use serde_json::{Map, Value as Json};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

pub type Tile = (i32, i32);

/// Запомненная сущность: где, какое место занимает и все её компоненты, какими были (имя → поля; вид — номер).
/// Запись не меняется, и у игроков, потерявших сущность из виду разом, она общая.
#[derive(Debug, PartialEq)]
pub struct Remembered {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub parts: Map<String, Json>,
}

impl Remembered {
  /// Снимок сущности сейчас.
  pub fn of(world: &World, entity: Entity) -> Option<Self> {
    let schema = &world.schema;
    let (position, memorable) = (schema.id("Position")?, schema.id("Memorable")?);
    let mut parts = Map::new();
    for (id, component) in schema.components.iter().enumerate() {
      if let Some(values) = world.get(entity, id) {
        parts.insert(component.name.clone(), Json::Object(values));
      }
    }
    Some(Self {
      x: world.num(entity, position, "x")?,
      y: world.num(entity, position, "y")?,
      width: world.num(entity, memorable, "width").unwrap_or(1.0),
      height: world.num(entity, memorable, "height").unwrap_or(1.0),
      parts,
    })
  }

  /// Число поля компонента.
  pub fn num(&self, component: &str, field: &str) -> Option<f64> {
    self.parts.get(component)?.get(field)?.as_f64()
  }

  /// Видит ли игрок хоть один тайл места.
  fn in_sight(&self, vision: &Vision, player: u32) -> bool {
    area_in_sight(vision, player, self.x, self.y, self.width, self.height)
  }
}

/// Видит ли игрок хоть один тайл прямоугольника width × height вокруг (x, y).
fn area_in_sight(vision: &Vision, player: u32, x: f64, y: f64, width: f64, height: f64) -> bool {
  let (left, top) = ((x - width / 2.0 + 0.5).floor(), (y - height / 2.0 + 0.5).floor());
  let (columns, rows) = (width.round().max(1.0) as i32, height.round().max(1.0) as i32);
  (0..rows).any(|dy| (0..columns).any(|dx| vision.sees(player, left + dx as f64 + 0.5, top + dy as f64 + 0.5)))
}

/// Память запоминаемого слоя.
pub struct Recall {
  pub layer: LayerId,
  /// Канал хозяина тайла.
  owner: Option<usize>,
  /// Что знает игрок иначе, чем общее: тайл по строкам — (y, x) → каналы.
  pub known: BTreeMap<u32, BTreeMap<Tile, Vec<f64>>>,
  /// Где знание игрока может расходиться со слоем — по ячейкам CELL: тайлы (x, y).
  stale: BTreeMap<u32, BTreeMap<Tile, BTreeSet<Tile>>>,
  /// Тайлы, изменившиеся с прошлой сверки.
  changed: BTreeSet<Tile>,
  /// Растёт, когда меняется знание любого игрока: сети — сверить, что знает подключение.
  pub edits: u64,
}

fn cell_of((x, y): Tile) -> Tile {
  (x.div_euclid(CELL), y.div_euclid(CELL))
}

fn add_stale(stale: &mut BTreeMap<Tile, BTreeSet<Tile>>, tile: Tile) {
  stale.entry(cell_of(tile)).or_default().insert(tile);
}

fn settle(stale: &mut BTreeMap<Tile, BTreeSet<Tile>>, tile: Tile) {
  let cell = cell_of(tile);
  if let Some(tiles) = stale.get_mut(&cell) {
    tiles.remove(&tile);
    if tiles.is_empty() {
      stale.remove(&cell);
    }
  }
}

/// Каналы тайла слоя.
fn actual(layers: &Layers, id: LayerId, (x, y): Tile) -> Vec<f64> {
  let Shape::Grid { channels } = &layers.spec(id).shape else { return Vec::new() };
  (0..channels.len()).map(|channel| layers.get(id, Owner::World, x, y, channel)).collect()
}

/// Непустые тайлы слоя.
fn tiles(layers: &Layers, id: LayerId) -> Vec<Tile> {
  let mut found = Vec::new();
  for (cx, cy) in layers.cells(id, Owner::World) {
    for y in cy * CHUNK..(cy + 1) * CHUNK {
      for x in cx * CHUNK..(cx + 1) * CHUNK {
        if actual(layers, id, (x, y)).iter().any(|&value| value != 0.0) {
          found.push((x, y));
        }
      }
    }
  }
  found
}

impl Recall {
  /// Что знает игрок о тайле; None — общее: пусто.
  pub fn known(&self, player: u32, x: i32, y: i32) -> Option<&[f64]> {
    self.known.get(&player)?.get(&(y, x)).map(Vec::as_slice)
  }

  /// Заводит игроку сверку: и то, что он знает, и всё, где слой расходится с общим.
  fn track(&mut self, layers: &Layers, player: u32) {
    if self.stale.contains_key(&player) {
      return;
    }
    let mut stale = BTreeMap::new();
    for &(y, x) in self.known.entry(player).or_default().keys() {
      add_stale(&mut stale, (x, y));
    }
    for tile in tiles(layers, self.layer) {
      add_stale(&mut stale, tile);
    }
    self.stale.insert(player, stale);
  }

  fn update(&mut self, layers: &Layers, vision: &Vision, friends: &BTreeMap<u32, Vec<u32>>, look: bool) {
    let changed = std::mem::take(&mut self.changed);
    for stale in self.stale.values_mut() {
      for &tile in &changed {
        add_stale(stale, tile);
      }
    }
    for &player in vision.cells.keys() {
      self.track(layers, player);
    }
    let players: Vec<u32> = self.stale.keys().copied().collect();
    for player in players {
      if !changed.is_empty() {
        self.learn(layers, vision, friends, player, changed.iter().copied().collect(), false);
      }
      if !look {
        continue;
      }
      let Some(visible) = vision.visible.get(&player) else { continue };
      let stale = &self.stale[&player];
      let keys: Vec<Tile> = stale.iter().filter(|(cell, _)| visible.contains(cell)).flat_map(|(_, tiles)| tiles.iter().copied()).collect();
      if !keys.is_empty() {
        self.learn(layers, vision, friends, player, keys, true);
      }
    }
  }

  /// Игрок узнаёт тайлы из несверенных: свои и союзные всегда, чужие — если look и он их видит.
  fn learn(&mut self, layers: &Layers, vision: &Vision, friends: &BTreeMap<u32, Vec<u32>>, player: u32, keys: Vec<Tile>, look: bool) {
    let team = friends.get(&player);
    let owner = self.owner;
    let ours = |values: &[f64]| {
      owner.and_then(|channel| values.get(channel)).is_some_and(|&value| value > 0.0 && (value as u32 == player || team.is_some_and(|team| team.contains(&(value as u32)))))
    };
    let (Some(stale), Some(known)) = (self.stale.get_mut(&player), self.known.get_mut(&player)) else { return };
    for (x, y) in keys {
      if !stale.get(&cell_of((x, y))).is_some_and(|tiles| tiles.contains(&(x, y))) {
        continue;
      }
      let now = actual(layers, self.layer, (x, y));
      let empty = now.iter().all(|&value| value == 0.0);
      let was = known.get(&(y, x)).cloned().unwrap_or_else(|| vec![0.0; now.len()]);
      if now == was {
        settle(stale, (x, y));
        continue;
      }
      if !ours(&now) && !ours(&was) && !(look && vision.sees(player, x as f64 + 0.5, y as f64 + 0.5)) {
        continue;
      }
      if empty {
        known.remove(&(y, x));
      } else {
        known.insert((y, x), now);
      }
      self.edits += 1;
      settle(stale, (x, y));
    }
  }
}

/// Память правок земли (landMemory.ts): карта у всех одна, но её правки (снесли гору, сгладили обрыв) игрок узнаёт,
/// только увидев. Общее — каким был тайл до первой правки (original); правки ничьи. Тайл — хранимые байты (`stored`).
#[derive(Default)]
pub struct LandRecall {
  /// Каким был изменённый тайл до первой правки.
  pub original: BTreeMap<Tile, [u8; 4]>,
  /// Что знает игрок иначе, чем общее.
  pub known: BTreeMap<u32, BTreeMap<Tile, [u8; 4]>>,
  stale: BTreeMap<u32, BTreeMap<Tile, BTreeSet<Tile>>>,
  changed: BTreeSet<Tile>,
  /// Растёт, когда игрок узнал правку: клиенту — переложить землю.
  pub version: BTreeMap<u32, u64>,
  /// Растёт с каждой правкой: без тумана клиент кладёт правки сразу.
  pub edits: u64,
}

impl LandRecall {
  /// Правит тайл земли: помнит, каким он был до первой правки, и отмечает его к сверке.
  pub fn edit(&mut self, land: &mut kharos_engine::terrain::Land, x: i32, y: i32, bytes: [u8; 4]) {
    let old = land.stored(x, y);
    if old == bytes {
      return;
    }
    self.original.entry((x, y)).or_insert(old);
    land.write_tile(x, y, bytes);
    self.changed.insert((x, y));
    self.edits += 1;
  }

  /// Правка редактора — правда для всех: новое становится тем, что знают все, ничего не видев; знание игроков о тайле
  /// ни к чему.
  pub fn forget(&mut self, x: i32, y: i32, bytes: [u8; 4]) {
    self.original.insert((x, y), bytes);
    for known in self.known.values_mut() {
      known.remove(&(x, y));
    }
    for stale in self.stale.values_mut() {
      settle(stale, (x, y));
    }
    self.edits += 1;
  }

  /// Каким тайл видит игрок: для каждого изменённого тайла — что он о нём знает (fog) или каков он сейчас.
  pub fn known_of(&self, land: &mut kharos_engine::terrain::Land, player: u32, fog: bool) -> Vec<(Tile, [u8; 4])> {
    let known = self.known.get(&player);
    self.original.iter().map(|(&tile, &original)| (tile, if fog { known.and_then(|known| known.get(&tile)).copied().unwrap_or(original) } else { land.stored(tile.0, tile.1) })).collect()
  }

  fn update(&mut self, land: &mut kharos_engine::terrain::Land, vision: &Vision) {
    let changed = std::mem::take(&mut self.changed);
    for stale in self.stale.values_mut() {
      for &tile in &changed {
        add_stale(stale, tile);
      }
    }
    for &player in vision.cells.keys() {
      if !self.stale.contains_key(&player) {
        let mut stale = BTreeMap::new();
        for &tile in self.known.entry(player).or_default().keys().chain(self.original.keys()) {
          add_stale(&mut stale, tile);
        }
        self.stale.insert(player, stale);
      }
    }
    for (&player, stale) in &mut self.stale {
      let Some(visible) = vision.visible.get(&player) else { continue };
      let keys: Vec<Tile> = stale.iter().filter(|(cell, _)| visible.contains(cell)).flat_map(|(_, tiles)| tiles.iter().copied()).collect();
      let known = self.known.entry(player).or_default();
      for (x, y) in keys {
        let now = land.stored(x, y);
        let common = self.original.get(&(x, y)).copied().unwrap_or(now);
        let was = known.get(&(x, y)).copied().unwrap_or(common);
        if now != was {
          if !vision.sees(player, x as f64 + 0.5, y as f64 + 0.5) {
            continue;
          }
          if now == common {
            known.remove(&(x, y));
          } else {
            known.insert((x, y), now);
          }
          *self.version.entry(player).or_default() += 1;
        }
        settle(stale, (x, y));
      }
    }
  }

  /// В сохранение: изменённые тайлы — x, y, исходные и нынешние байты подряд; знание игроков — x, y и байты подряд.
  pub fn save(&self, land: &mut kharos_engine::terrain::Land) -> Json {
    let tiles: Vec<Json> = self.original.iter().flat_map(|(&(x, y), original)| {
      let now = land.stored(x, y);
      [x, y].into_iter().map(Json::from).chain(original.iter().chain(now.iter()).map(|&byte| Json::from(byte))).collect::<Vec<_>>()
    }).collect();
    let mut known = Map::new();
    for (player, tiles) in &self.known {
      let flat: Vec<Json> = tiles.iter().flat_map(|(&(x, y), bytes)| [x, y].into_iter().map(Json::from).chain(bytes.iter().map(|&byte| Json::from(byte))).collect::<Vec<_>>()).collect();
      if !flat.is_empty() {
        known.insert(player.to_string(), Json::Array(flat));
      }
    }
    serde_json::json!({ "tiles": tiles, "known": known })
  }

  /// Из сохранения (`save`): нынешние байты ложатся на землю одним пакетом.
  pub fn load(&mut self, land: &mut kharos_engine::terrain::Land, saved: &Json) {
    let bytes = |values: &[Json]| -> [u8; 4] { std::array::from_fn(|i| values.get(i).and_then(Json::as_u64).unwrap_or(0) as u8) };
    land.begin_batch();
    for tile in saved.get("tiles").and_then(Json::as_array).map_or(&[][..], Vec::as_slice).chunks(10).filter(|tile| tile.len() == 10) {
      let (Some(x), Some(y)) = (tile[0].as_i64(), tile[1].as_i64()) else { continue };
      self.original.insert((x as i32, y as i32), bytes(&tile[2..6]));
      land.write_tile(x as i32, y as i32, bytes(&tile[6..10]));
    }
    land.end_batch();
    for (player, flat) in saved.get("known").and_then(Json::as_object).into_iter().flatten() {
      let (Ok(player), Some(flat)) = (player.parse::<u32>(), flat.as_array()) else { continue };
      let known = self.known.entry(player).or_default();
      for tile in flat.chunks(6).filter(|tile| tile.len() == 6) {
        let (Some(x), Some(y)) = (tile[0].as_i64(), tile[1].as_i64()) else { continue };
        known.insert((x as i32, y as i32), bytes(&tile[2..6]));
      }
      *self.version.entry(player).or_default() += 1;
    }
    self.edits += 1;
  }
}

#[derive(Default)]
pub struct Memory {
  /// Что помнит игрок: сущность → какой она была, когда ушла из его обзора.
  pub known: BTreeMap<u32, BTreeMap<Entity, Rc<Remembered>>>,
  /// Чужие запоминаемые, которые игрок видел при прошлой сверке. В сохранение не идёт.
  pub watched: BTreeMap<u32, BTreeSet<Entity>>,
  /// Запоминаемые слои.
  pub layers: Vec<Recall>,
  /// Правки земли.
  pub land: LandRecall,
}

impl Memory {
  /// Память под запоминаемые слои партии.
  pub fn new(layers: &Layers) -> Self {
    let recalls = layers.specs().enumerate().filter(|(_, spec)| spec.remember && matches!(spec.shape, Shape::Grid { .. })).map(|(layer, spec)| Recall { layer, owner: spec.owner, known: BTreeMap::new(), stale: BTreeMap::new(), changed: BTreeSet::new(), edits: 0 }).collect();
    Self { layers: recalls, ..Default::default() }
  }

  /// Память слоя; None — слой не запоминается.
  pub fn recall(&self, layer: LayerId) -> Option<&Recall> {
    self.layers.iter().find(|recall| recall.layer == layer)
  }

  /// Тайл слоя изменился: его сверят все игроки.
  pub fn touch(&mut self, layer: LayerId, x: i32, y: i32) {
    if let Some(recall) = self.layers.iter_mut().find(|recall| recall.layer == layer) {
      recall.changed.insert((x, y));
    }
  }

  /// Видит ли игрок сущность — по последней сверке: тогда она перед ним живой, иначе — какой он её помнит.
  pub fn sees(&self, player: u32, entity: Entity) -> bool {
    self.watched.get(&player).is_some_and(|seen| seen.contains(&entity))
  }

  /// Что игрок помнит о сущности, которую сейчас не видит.
  pub fn remembered(&self, player: u32, entity: Entity) -> Option<&Rc<Remembered>> {
    self.known.get(&player)?.get(&entity)
  }

  /// Игрок начинает заново: что он помнил, больше ничего не значит (`forgetBuildings`).
  pub fn forget_player(&mut self, player: u32) {
    self.known.remove(&player);
    self.watched.remove(&player);
    for recall in &mut self.layers {
      recall.known.remove(&player);
      recall.stale.remove(&player);
      recall.edits += 1;
    }
    self.land.known.remove(&player);
    self.land.stale.remove(&player);
    *self.land.version.entry(player).or_default() += 1;
  }

  /// Сверка после обзора (`updateBuildMemory`, `updateRecall`): look — обзор пересчитан в этот тик.
  pub fn update(&mut self, world: &World, vision: &Vision, layers: &Layers, land: Option<&mut kharos_engine::terrain::Land>, look: bool) {
    if !vision.fog {
      for recall in &mut self.layers {
        recall.changed.clear();
      }
      self.land.changed.clear();
      return;
    }
    if let (true, Some(land)) = (look, land) {
      self.land.update(land, vision);
    }
    let friends = friends(world);
    for recall in &mut self.layers {
      recall.update(layers, vision, &friends, look);
    }
    if look {
      self.update_entities(world, vision);
    }
  }

  fn update_entities(&mut self, world: &World, vision: &Vision) {
    let (Some(memorable), Some(position), Some(owner)) = (world.schema.id("Memorable"), world.schema.id("Position"), world.schema.id("Owner")) else { return };
    let store = &world.stores[memorable];
    // Снятое в этой сверке: игрокам, потерявшим сущность из виду разом, — одна запись.
    let mut taken: BTreeMap<Entity, Rc<Remembered>> = BTreeMap::new();
    for &player in vision.cells.keys() {
      let mut seen = BTreeSet::new();
      for (row, &entity) in store.entities.iter().enumerate() {
        if world.num(entity, owner, "player").is_some_and(|owner| owner as u32 == player) {
          continue;
        }
        let (Some(x), Some(y)) = (world.num(entity, position, "x"), world.num(entity, position, "y")) else { continue };
        if area_in_sight(vision, player, x, y, store.nums[0][row], store.nums[1][row]) {
          seen.insert(entity);
        }
      }
      let known = self.known.entry(player).or_default();
      // Снесённое на глазах не запоминается.
      for &entity in self.watched.get(&player).into_iter().flatten() {
        if seen.contains(&entity) || !world.has(entity, memorable) {
          continue;
        }
        let record = match taken.get(&entity) {
          Some(record) => record.clone(),
          None => {
            let Some(record) = Remembered::of(world, entity) else { continue };
            let record = Rc::new(record);
            taken.insert(entity, record.clone());
            record
          }
        };
        known.insert(entity, record);
      }
      // Запоминаемые не двигаются: живое в обзоре — в seen, место проверяется только у тех, которых больше нет.
      known.retain(|&entity, record| !seen.contains(&entity) && (world.has(entity, memorable) || !record.in_sight(vision, player)));
      self.watched.insert(player, seen);
    }
  }

  /// В сохранение: parts — запомненное без повторов (одно и то же обычно помнят одинаково), entities — по игроку
  /// номер сущности и место её записи подряд; layers — по слою и игроку x, y и каналы подряд. name — вид числом в
  /// имя «раздел/имя», чтобы сохранение пережило правку модов.
  pub fn save(&self, layers: &Layers, name: impl Fn(&mut Map<String, Json>)) -> Json {
    let mut parts: Vec<Json> = Vec::new();
    let mut places: BTreeMap<*const Remembered, usize> = BTreeMap::new();
    let mut entities = Map::new();
    for (player, known) in &self.known {
      if known.is_empty() {
        continue;
      }
      let mut flat = Vec::new();
      for (&entity, record) in known {
        let place = *places.entry(Rc::as_ptr(record)).or_insert_with(|| {
          let mut saved = record.parts.clone();
          name(&mut saved);
          parts.push(Json::Object(saved));
          parts.len() - 1
        });
        flat.extend([Json::from(entity), Json::from(place)]);
      }
      entities.insert(player.to_string(), Json::Array(flat));
    }
    let mut saved_layers = Map::new();
    for recall in &self.layers {
      let mut players = Map::new();
      for (player, known) in &recall.known {
        let flat: Vec<Json> = known.iter().flat_map(|(&(y, x), values)| [Json::from(x), Json::from(y)].into_iter().chain(values.iter().map(|&value| Json::from(value)))).collect();
        if !flat.is_empty() {
          players.insert(player.to_string(), Json::Array(flat));
        }
      }
      saved_layers.insert(layers.spec(recall.layer).name.clone(), Json::Object(players));
    }
    serde_json::json!({ "parts": parts, "entities": entities, "layers": saved_layers })
  }

  /// Из сохранения (`save`) — поверх пустой. number — вид из имени в номер; вида больше нет — None, запись теряется.
  pub fn load(&mut self, layers: &Layers, saved: &Json, number: impl Fn(&mut Map<String, Json>) -> bool) {
    let parts: Vec<Option<Rc<Remembered>>> = saved.get("parts").and_then(Json::as_array).map_or_else(Vec::new, |list| {
      list
        .iter()
        .map(|part| {
          let mut parts = part.as_object()?.clone();
          if !number(&mut parts) {
            return None;
          }
          let field = |component: &str, name: &str, default: f64| parts.get(component).and_then(|values| values.get(name)).and_then(Json::as_f64).unwrap_or(default);
          let (x, y, width, height) = (field("Position", "x", 0.0), field("Position", "y", 0.0), field("Memorable", "width", 1.0), field("Memorable", "height", 1.0));
          Some(Rc::new(Remembered { x, y, width, height, parts }))
        })
        .collect()
    });
    for (player, flat) in saved.get("entities").and_then(Json::as_object).into_iter().flatten() {
      let (Ok(player), Some(flat)) = (player.parse::<u32>(), flat.as_array()) else { continue };
      let known = self.known.entry(player).or_default();
      for pair in flat.chunks(2) {
        let (Some(entity), Some(place)) = (pair[0].as_u64(), pair.get(1).and_then(Json::as_u64)) else { continue };
        if let Some(Some(record)) = parts.get(place as usize) {
          known.insert(entity as Entity, record.clone());
        }
      }
    }
    for (name, players) in saved.get("layers").and_then(Json::as_object).into_iter().flatten() {
      let Some(id) = layers.id(name) else { continue };
      let Some(recall) = self.layers.iter_mut().find(|recall| recall.layer == id) else { continue };
      let Shape::Grid { channels } = &layers.spec(id).shape else { continue };
      let count = channels.len();
      for (player, flat) in players.as_object().into_iter().flatten() {
        let (Ok(player), Some(flat)) = (player.parse::<u32>(), flat.as_array()) else { continue };
        let known = recall.known.entry(player).or_default();
        for tile in flat.chunks(count + 2).filter(|tile| tile.len() == count + 2) {
          let (Some(x), Some(y)) = (tile[0].as_i64(), tile[1].as_i64()) else { continue };
          known.insert((y as i32, x as i32), tile[2..].iter().map(|value| value.as_f64().unwrap_or(0.0)).collect());
        }
      }
      recall.edits += 1;
    }
  }
}

impl crate::host::State {
  /// Есть ли туман: без него все знают всё.
  fn fogged(&self) -> bool {
    self.vision.as_ref().is_some_and(|vision| vision.fog)
  }

  /// Канал тайла слоя, как его знает игрок: у запоминаемого в тумане — его память, иначе — слой.
  pub fn known_layer(&self, player: u32, id: LayerId, x: i32, y: i32, channel: usize) -> f64 {
    match self.memory.recall(id).filter(|_| self.fogged()) {
      Some(recall) => recall.known(player, x, y).and_then(|values| values.get(channel).copied()).unwrap_or(0.0),
      None => self.layers.get(id, Owner::World, x, y, channel),
    }
  }

  /// Непустые тайлы канала в [left, right) × [top, bottom), как их знает игрок: x, y, значение подряд, по строкам.
  pub fn known_layer_within(&self, player: u32, id: LayerId, channel: usize, left: i32, top: i32, right: i32, bottom: i32) -> Vec<f64> {
    let Some(recall) = self.memory.recall(id).filter(|_| self.fogged()) else { return crate::tiles::within(&self.layers, id, channel, left, top, right, bottom) };
    let mut found = Vec::new();
    let Some(known) = recall.known.get(&player) else { return found };
    for y in top..bottom {
      for (&(_, x), values) in known.range((y, left)..(y, right)) {
        let value = values.get(channel).copied().unwrap_or(0.0);
        if value != 0.0 {
          found.extend([x as f64, y as f64, value]);
        }
      }
    }
    found
  }

  /// Видит ли игрок сущность живой: своё — всегда, запоминаемое чужое — по сверке памяти, остальное — если видит
  /// тайл под ней.
  pub fn shows(&self, player: u32, entity: Entity) -> bool {
    let world = &self.world;
    // В реплике (клиент по сети) только то, что игроку прислали: оно всё перед ним.
    if self.replica {
      return world.alive(entity);
    }
    let Some(vision) = self.vision.as_ref().filter(|vision| vision.fog) else { return true };
    if world.schema.id("Owner").and_then(|owner| world.num(entity, owner, "player")).is_some_and(|owner| owner as u32 == player) {
      return true;
    }
    if world.schema.id("Memorable").is_some_and(|memorable| world.has(entity, memorable)) {
      return self.memory.sees(player, entity);
    }
    let Some(position) = world.schema.id("Position") else { return false };
    match (world.num(entity, position, "x"), world.num(entity, position, "y")) {
      (Some(x), Some(y)) => vision.sees(player, x, y),
      _ => false,
    }
  }

  /// Что игрок помнит, не видя: сущность и запись.
  pub fn ghosts(&self, player: u32) -> Vec<(Entity, Rc<Remembered>)> {
    if !self.fogged() {
      return Vec::new();
    }
    self.memory.known.get(&player).map_or_else(Vec::new, |known| known.iter().map(|(&entity, record)| (entity, record.clone())).collect())
  }
}

/// Союзы: игрок → его союзники (компонент движка `Player`).
fn friends(world: &World) -> BTreeMap<u32, Vec<u32>> {
  let mut all = BTreeMap::new();
  let Some(player) = world.schema.id("Player") else { return all };
  for &entity in &world.stores[player].entities {
    let Some(Json::Array(list)) = world.get(entity, player).and_then(|values| values.get("allies").cloned()) else { continue };
    let Some(id) = world.num(entity, player, "id") else { continue };
    all.insert(id as u32, list.iter().filter_map(Json::as_f64).map(|ally| ally as u32).collect());
  }
  all
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::schema::Schema;
  use crate::vision::Bounds;
  use kharos_engine::layers::LayerSpec;
  use serde_json::json;

  fn object(value: Json) -> Map<String, Json> {
    value.as_object().unwrap().clone()
  }

  #[test]
  fn foreign_building_stays_a_ghost_until_its_place_is_seen() {
    let mut world = World::new(Rc::new(Schema::new()));
    let id = |name| world.schema.id(name).unwrap();
    let (sight, owner, position, memorable) = (id("Sight"), id("Owner"), id("Position"), id("Memorable"));
    let eye = world.spawn();
    world.add(eye, owner, &object(json!({ "player": 1 }))).unwrap();
    world.add(eye, position, &object(json!({ "x": 0.5, "y": 0.5 }))).unwrap();
    world.add(eye, sight, &object(json!({ "radius": 3 }))).unwrap();
    let house = world.spawn();
    world.add(house, owner, &object(json!({ "player": 2 }))).unwrap();
    world.add(house, position, &object(json!({ "x": 3.0, "y": 1.0 }))).unwrap();
    world.add(house, memorable, &object(json!({ "width": 2, "height": 2 }))).unwrap();
    let mut vision = Vision::new(Bounds { left: -16, top: -16, right: 16, bottom: 16 }, true);
    let layers = Layers::new(Vec::new());
    let mut memory = Memory::new(&layers);
    vision.update(&world);
    memory.update(&world, &vision, &layers, None, true);
    assert!(memory.sees(1, house) && memory.remembered(1, house).is_none());
    // Глаз ушёл: дом — призраком.
    world.set(eye, position, &object(json!({ "x": -10.5 }))).unwrap();
    vision.update(&world);
    memory.update(&world, &vision, &layers, None, true);
    assert!(!memory.sees(1, house) && memory.remembered(1, house).is_some_and(|record| record.x == 3.0));
    // Снесли в тумане — помнит, пока не увидит место.
    world.destroy(house);
    vision.update(&world);
    memory.update(&world, &vision, &layers, None, true);
    assert!(memory.remembered(1, house).is_some());
    world.set(eye, position, &object(json!({ "x": 0.5 }))).unwrap();
    vision.update(&world);
    memory.update(&world, &vision, &layers, None, true);
    assert!(memory.remembered(1, house).is_none());
  }

  #[test]
  fn foreign_tile_is_learned_on_sight_own_at_once() {
    let mut world = World::new(Rc::new(Schema::new()));
    let id = |name| world.schema.id(name).unwrap();
    let (sight, owner, position) = (id("Sight"), id("Owner"), id("Position"));
    let eye = world.spawn();
    world.add(eye, owner, &object(json!({ "player": 1 }))).unwrap();
    world.add(eye, position, &object(json!({ "x": 0.5, "y": 0.5 }))).unwrap();
    world.add(eye, sight, &object(json!({ "radius": 2 }))).unwrap();
    let specs = LayerSpec::parse_all(r#"{ "paving": { "scope": "world", "shape": "grid", "channels": ["u8", "u8"], "remember": true, "owner": 1 } }"#).unwrap();
    let mut layers = Layers::new(specs);
    let paving = layers.id("paving").unwrap();
    let mut memory = Memory::new(&layers);
    let mut vision = Vision::new(Bounds { left: -64, top: -64, right: 64, bottom: 64 }, true);
    vision.update(&world);
    // Чужая дорога вдали и своя — тоже вдали.
    for (x, player) in [(40, 2.0), (41, 1.0)] {
      layers.set(paving, Owner::World, x, 0, 0, 2.0);
      layers.set(paving, Owner::World, x, 0, 1, player);
      memory.touch(paving, x, 0);
    }
    memory.update(&world, &vision, &layers, None, true);
    let recall = memory.recall(paving).unwrap();
    assert_eq!(recall.known(1, 40, 0), None);
    assert_eq!(recall.known(1, 41, 0), Some(&[2.0, 1.0][..]));
    // Подошёл — узнал чужую.
    world.set(eye, position, &object(json!({ "x": 40.5 }))).unwrap();
    vision.update(&world);
    memory.update(&world, &vision, &layers, None, true);
    assert_eq!(memory.recall(paving).unwrap().known(1, 40, 0), Some(&[2.0, 2.0][..]));
    // Ушёл, её сняли — помнит.
    world.set(eye, position, &object(json!({ "x": 0.5 }))).unwrap();
    vision.update(&world);
    layers.set(paving, Owner::World, 40, 0, 0, 0.0);
    layers.set(paving, Owner::World, 40, 0, 1, 0.0);
    memory.touch(paving, 40, 0);
    memory.update(&world, &vision, &layers, None, true);
    assert_eq!(memory.recall(paving).unwrap().known(1, 40, 0), Some(&[2.0, 2.0][..]));
    // Сохранение.
    let saved = memory.save(&layers, |_| {});
    let mut loaded = Memory::new(&layers);
    loaded.load(&layers, &saved, |_| true);
    assert_eq!(loaded.recall(paving).unwrap().known(1, 40, 0), Some(&[2.0, 2.0][..]));
  }
}
