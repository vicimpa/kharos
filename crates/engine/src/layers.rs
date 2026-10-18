//! Слои: всё, что лежит на карте и не является сущностью (docs/layers.md). Слой объявляется (`LayerSpec`), а
//! хранение, изменения и их формат у всех слоёв общие.
//!
//! Слой мира — один на всех; слой игрока — свой у каждого и живёт вместе с игроком. Сетка — чанки 32×32 тайла с
//! каналами фиксированного типа; чанк заводится при первой записи. Предметы — записи с местом (x, y) и полями,
//! разложенные по ячейкам. Изменение — чанк или ячейка целиком: им же сохраняется слой, синхронизируется зеркало TS и
//! (потом) уходит клиенту.

use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Сторона чанка сетки в тайлах — как у земли (`CHUNK_SIZE` в terrain.ts).
pub const CHUNK: i32 = 32;
const CHUNK_TILES: usize = (CHUNK * CHUNK) as usize;

/// Тип канала сетки или поля предмета. Числа пишутся little-endian; целые при записи обрезаются до своего диапазона.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
  U8,
  U16,
  U32,
  F32,
  F64,
}

impl Channel {
  pub fn size(self) -> usize {
    match self {
      Channel::U8 => 1,
      Channel::U16 => 2,
      Channel::U32 | Channel::F32 => 4,
      Channel::F64 => 8,
    }
  }

  fn read(self, bytes: &[u8]) -> f64 {
    match self {
      Channel::U8 => bytes[0] as f64,
      Channel::U16 => u16::from_le_bytes([bytes[0], bytes[1]]) as f64,
      Channel::U32 => u32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
      Channel::F32 => f32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
      Channel::F64 => f64::from_le_bytes(bytes[..8].try_into().unwrap()),
    }
  }

  fn write(self, bytes: &mut [u8], value: f64) {
    match self {
      Channel::U8 => bytes[0] = value as u8,
      Channel::U16 => bytes[..2].copy_from_slice(&(value as u16).to_le_bytes()),
      Channel::U32 => bytes[..4].copy_from_slice(&(value as u32).to_le_bytes()),
      Channel::F32 => bytes[..4].copy_from_slice(&(value as f32).to_le_bytes()),
      Channel::F64 => bytes[..8].copy_from_slice(&value.to_le_bytes()),
    }
  }
}

/// Чей слой.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
  World,
  Player,
}

/// Форма слоя.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
  /// Сетка: каналы на тайл.
  Grid { channels: Vec<Channel> },
  /// Предметы: ячейка стороной cell тайлов, поля записи по порядку (кроме места — x и y, они есть всегда, f64).
  Items { cell: i32, fields: Vec<(String, Channel)> },
}

/// Объявление слоя: строка layers.json.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerSpec {
  pub name: String,
  pub scope: Scope,
  pub shape: Shape,
  /// Сохраняется ли слой. Выводимый (занятость, видимое сейчас) — нет: его пересчитывают.
  pub save: bool,
  /// Уходит ли слой клиентам.
  pub send: bool,
  /// Слой мира, который игроки запоминают: у каждого — версия, какой он её видел (docs/layers.md, §2).
  pub remember: bool,
  /// Слой игрока, который читают и союзники.
  pub allies: bool,
  /// Запоминаемого слоя: канал, где хозяин тайла, — своё и союзное игрок знает, не видя.
  pub owner: Option<usize>,
}

/// Строка layers.json как она записана.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSpec {
  scope: Scope,
  shape: String,
  #[serde(default)]
  channels: Vec<Channel>,
  #[serde(default)]
  cell: i32,
  #[serde(default)]
  fields: serde_json::Map<String, serde_json::Value>,
  #[serde(default)]
  save: bool,
  #[serde(default = "yes")]
  send: bool,
  #[serde(default)]
  remember: bool,
  #[serde(default)]
  allies: bool,
  #[serde(default)]
  owner: Option<usize>,
  #[serde(default)]
  #[allow(dead_code)]
  about: String,
}

fn yes() -> bool {
  true
}

impl LayerSpec {
  /// Объявления из layers.json: объект «имя → слой», порядок — как в файле.
  pub fn parse_all(json: &str) -> Result<Vec<LayerSpec>, String> {
    let table: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let mut specs = Vec::new();
    for (name, value) in table {
      let raw: RawSpec = serde_json::from_value(value).map_err(|error| format!("{name}: {error}"))?;
      let shape = match raw.shape.as_str() {
        "grid" if !raw.channels.is_empty() => Shape::Grid { channels: raw.channels },
        "items" if raw.cell > 0 => {
          let mut fields = Vec::new();
          for (field, kind) in raw.fields {
            let kind: Channel = serde_json::from_value(kind).map_err(|error| format!("{name}.{field}: {error}"))?;
            fields.push((field, kind));
          }
          Shape::Items { cell: raw.cell, fields }
        }
        other => return Err(format!("{name}: форма {other} без каналов или ячейки")),
      };
      if raw.remember && raw.scope != Scope::World {
        return Err(format!("{name}: запоминают только слои мира"));
      }
      if raw.allies && raw.scope != Scope::Player {
        return Err(format!("{name}: союзникам открывают только слой игрока"));
      }
      if raw.owner.is_some() && !raw.remember {
        return Err(format!("{name}: хозяин тайла — только у запоминаемого слоя"));
      }
      specs.push(LayerSpec { name, scope: raw.scope, shape, save: raw.save, send: raw.send, remember: raw.remember, allies: raw.allies, owner: raw.owner });
    }
    Ok(specs)
  }

  /// Байт на тайл сетки или на запись предмета (с местом).
  pub fn stride(&self) -> usize {
    match &self.shape {
      Shape::Grid { channels } => channels.iter().map(|channel| channel.size()).sum(),
      Shape::Items { fields, .. } => 16 + fields.iter().map(|(_, channel)| channel.size()).sum::<usize>(),
    }
  }
}

/// Чей экземпляр слоя: мира или игрока.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Owner {
  World,
  Player(u32),
}

impl Owner {
  pub fn code(self) -> i64 {
    match self {
      Owner::World => -1,
      Owner::Player(player) => player as i64,
    }
  }

  /// Владелец по коду формата изменений: -1 (любое отрицательное) — мир, иначе — игрок.
  pub fn from_code(code: i64) -> Owner {
    if code < 0 {
      Owner::World
    } else {
      Owner::Player(code as u32)
    }
  }
}

/// Изменение слоя: чанк сетки или ячейка предметов целиком. Пустые байты — чанка или ячейки больше нет.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
  pub layer: String,
  pub owner: Owner,
  pub x: i32,
  pub y: i32,
  pub bytes: Vec<u8>,
}

/// Номер слоя в объявлении.
pub type LayerId = usize;

/// Данные одного экземпляра слоя: блоки (чанки или ячейки) по координатам блока.
type Blocks = HashMap<(i32, i32), Vec<u8>>;

struct Layer {
  spec: LayerSpec,
  stride: usize,
  /// Смещения каналов или полей предмета в байтах.
  offsets: Vec<usize>,
  world: Blocks,
  players: BTreeMap<u32, Blocks>,
  /// Изменённые блоки с прошлого take_changes: по порядку — так изменения детерминированы.
  dirty: BTreeSet<(Owner, i32, i32)>,
}

impl Layer {
  fn blocks(&self, owner: Owner) -> Option<&Blocks> {
    match owner {
      Owner::World => Some(&self.world),
      Owner::Player(player) => self.players.get(&player),
    }
  }

  fn blocks_mut(&mut self, owner: Owner) -> Option<&mut Blocks> {
    match owner {
      Owner::World => Some(&mut self.world),
      Owner::Player(player) => self.players.get_mut(&player),
    }
  }

  fn channel(&self, at: usize) -> Channel {
    match &self.spec.shape {
      Shape::Grid { channels } => channels[at],
      Shape::Items { fields, .. } => fields[at].1,
    }
  }
}

/// Блок и место в нём для тайла сетки.
fn chunk_of(x: i32, y: i32) -> ((i32, i32), usize) {
  let (cx, cy) = (x.div_euclid(CHUNK), y.div_euclid(CHUNK));
  ((cx, cy), (y.rem_euclid(CHUNK) * CHUNK + x.rem_euclid(CHUNK)) as usize)
}

/// Предмет слоя: место и поля.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
  pub x: f64,
  pub y: f64,
  pub fields: Vec<f64>,
}

/// Все слои симуляции.
pub struct Layers {
  layers: Vec<Layer>,
  by_name: HashMap<String, LayerId>,
}

impl Layers {
  pub fn new(specs: Vec<LayerSpec>) -> Self {
    let layers: Vec<Layer> = specs
      .into_iter()
      .map(|spec| {
        let sizes: Vec<usize> = match &spec.shape {
          Shape::Grid { channels } => channels.iter().map(|channel| channel.size()).collect(),
          Shape::Items { fields, .. } => fields.iter().map(|(_, channel)| channel.size()).collect(),
        };
        // У предмета первые 16 байт — место.
        let mut at = if matches!(spec.shape, Shape::Items { .. }) { 16 } else { 0 };
        let offsets = sizes
          .iter()
          .map(|size| {
            let offset = at;
            at += size;
            offset
          })
          .collect();
        Layer { stride: spec.stride(), offsets, spec, world: HashMap::new(), players: BTreeMap::new(), dirty: BTreeSet::new() }
      })
      .collect();
    let by_name = layers.iter().enumerate().map(|(id, layer)| (layer.spec.name.clone(), id)).collect();
    Self { layers, by_name }
  }

  pub fn id(&self, name: &str) -> Option<LayerId> {
    self.by_name.get(name).copied()
  }

  pub fn spec(&self, id: LayerId) -> &LayerSpec {
    &self.layers[id].spec
  }

  pub fn specs(&self) -> impl Iterator<Item = &LayerSpec> {
    self.layers.iter().map(|layer| &layer.spec)
  }

  // Игроки.

  /// Заводит игроку его слои (пустые). Уже заведённые не трогает.
  pub fn add_player(&mut self, player: u32) {
    for layer in &mut self.layers {
      if layer.spec.scope == Scope::Player {
        layer.players.entry(player).or_default();
      }
    }
  }

  /// Забывает все слои игрока разом: он начинает заново. Клиенту уходит, что чанков больше нет.
  pub fn forget_player(&mut self, player: u32) {
    for layer in &mut self.layers {
      if let Some(blocks) = layer.players.remove(&player) {
        for &(x, y) in blocks.keys() {
          layer.dirty.insert((Owner::Player(player), x, y));
        }
      }
    }
  }

  /// Игроки, у которых заведены слои.
  pub fn players(&self) -> BTreeSet<u32> {
    self.layers.iter().flat_map(|layer| layer.players.keys().copied()).collect()
  }

  // Сетка.

  /// Байты чанка сетки (cx, cy в чанках): тайлы построчно, у тайла — каналы подряд; None — чанка нет (одни нули).
  /// Для чтения подряд: поиск чанка — один на 32 тайла строки, а не на каждый.
  pub fn chunk(&self, id: LayerId, owner: Owner, cx: i32, cy: i32) -> Option<&[u8]> {
    self.layers[id].blocks(owner)?.get(&(cx, cy)).map(Vec::as_slice)
  }

  /// Значение канала channel тайла (x, y); нет чанка — ноль.
  pub fn get(&self, id: LayerId, owner: Owner, x: i32, y: i32, channel: usize) -> f64 {
    let layer = &self.layers[id];
    let (chunk, tile) = chunk_of(x, y);
    match layer.blocks(owner).and_then(|blocks| blocks.get(&chunk)) {
      Some(bytes) => layer.channel(channel).read(&bytes[tile * layer.stride + layer.offsets[channel]..]),
      None => 0.0,
    }
  }

  /// Пишет канал тайла. Чанк заводится при первой записи ненулевого; то же значение — не изменение.
  pub fn set(&mut self, id: LayerId, owner: Owner, x: i32, y: i32, channel: usize, value: f64) {
    let layer = &mut self.layers[id];
    let (chunk, tile) = chunk_of(x, y);
    let (stride, offset, kind) = (layer.stride, layer.offsets[channel], layer.channel(channel));
    let Some(blocks) = layer.blocks_mut(owner) else { return };
    if !blocks.contains_key(&chunk) && value == 0.0 {
      return;
    }
    let bytes = blocks.entry(chunk).or_insert_with(|| vec![0; CHUNK_TILES * stride]);
    let place = &mut bytes[tile * stride + offset..];
    let before = kind.read(place);
    kind.write(place, value);
    if kind.read(place) != before {
      layer.dirty.insert((owner, chunk.0, chunk.1));
    }
  }

  // Предметы.

  /// Ячейка предмета в месте (x, y).
  pub fn cell_of(&self, id: LayerId, x: f64, y: f64) -> (i32, i32) {
    let Shape::Items { cell, .. } = self.layers[id].spec.shape else { panic!("{}: не предметы", self.layers[id].spec.name) };
    ((x / cell as f64).floor() as i32, (y / cell as f64).floor() as i32)
  }

  /// Кладёт предмет в его ячейку.
  pub fn push(&mut self, id: LayerId, owner: Owner, item: &Item) {
    let cell = self.cell_of(id, item.x, item.y);
    let layer = &mut self.layers[id];
    let (stride, offsets) = (layer.stride, layer.offsets.clone());
    let kinds: Vec<Channel> = (0..offsets.len()).map(|at| layer.channel(at)).collect();
    let Some(blocks) = layer.blocks_mut(owner) else { return };
    let bytes = blocks.entry(cell).or_default();
    let start = bytes.len();
    bytes.resize(start + stride, 0);
    Channel::F64.write(&mut bytes[start..], item.x);
    Channel::F64.write(&mut bytes[start + 8..], item.y);
    for (at, kind) in kinds.iter().enumerate() {
      kind.write(&mut bytes[start + offsets[at]..], item.fields.get(at).copied().unwrap_or(0.0));
    }
    layer.dirty.insert((owner, cell.0, cell.1));
  }

  /// Предметы ячейки по порядку.
  pub fn items(&self, id: LayerId, owner: Owner, cell: (i32, i32)) -> Vec<Item> {
    let layer = &self.layers[id];
    let Some(bytes) = layer.blocks(owner).and_then(|blocks| blocks.get(&cell)) else { return Vec::new() };
    bytes.chunks_exact(layer.stride).map(|record| Item { x: Channel::F64.read(record), y: Channel::F64.read(&record[8..]), fields: (0..layer.offsets.len()).map(|at| layer.channel(at).read(&record[layer.offsets[at]..])).collect() }).collect()
  }

  /// Оставляет в ячейке предметы, для которых keep — true, в прежнем порядке.
  pub fn retain(&mut self, id: LayerId, owner: Owner, cell: (i32, i32), mut keep: impl FnMut(&Item) -> bool) {
    let items = self.items(id, owner, cell);
    let kept: Vec<Item> = items.iter().filter(|item| keep(item)).cloned().collect();
    if kept.len() == items.len() {
      return;
    }
    let layer = &mut self.layers[id];
    if let Some(blocks) = layer.blocks_mut(owner) {
      blocks.remove(&cell);
    }
    layer.dirty.insert((owner, cell.0, cell.1));
    for item in &kept {
      self.push(id, owner, item);
    }
  }

  // Изменения.

  /// Блоки, изменённые с прошлого раза, — по слоям в порядке объявления.
  pub fn take_changes(&mut self) -> Vec<Change> {
    let mut changes = Vec::new();
    for layer in &mut self.layers {
      for (owner, x, y) in std::mem::take(&mut layer.dirty) {
        let bytes = layer.blocks(owner).and_then(|blocks| blocks.get(&(x, y))).cloned().unwrap_or_default();
        changes.push(Change { layer: layer.spec.name.clone(), owner, x, y, bytes });
      }
    }
    changes
  }

  /// Все блоки сохраняемых слоёв владельца: мира или одного игрока. Тот же формат, что у изменений.
  pub fn save(&self, owner: Owner) -> Vec<Change> {
    let mut changes = Vec::new();
    for (id, layer) in self.layers.iter().enumerate() {
      if layer.spec.save && (owner == Owner::World) == (layer.spec.scope == Scope::World) {
        changes.extend(self.blocks(id, owner));
      }
    }
    changes
  }

  /// Все блоки экземпляра слоя по порядку координат — изменениями, как их применил бы `apply`. Для сохранения и сверки.
  pub fn blocks(&self, id: LayerId, owner: Owner) -> Vec<Change> {
    let layer = &self.layers[id];
    let Some(blocks) = layer.blocks(owner) else { return Vec::new() };
    let mut keys: Vec<_> = blocks.keys().copied().collect();
    keys.sort();
    keys.into_iter().map(|(x, y)| Change { layer: layer.spec.name.clone(), owner, x, y, bytes: blocks[&(x, y)].clone() }).collect()
  }

  /// Непустые блоки экземпляра слоя (чанки сетки или ячейки предметов) по порядку координат.
  pub fn cells(&self, id: LayerId, owner: Owner) -> Vec<(i32, i32)> {
    let Some(blocks) = self.layers[id].blocks(owner) else { return Vec::new() };
    let mut keys: Vec<_> = blocks.keys().copied().collect();
    keys.sort();
    keys
  }

  /// Применяет чужое изменение (зеркало, загрузка). В свои изменения оно не идёт: та сторона о нём уже знает.
  /// Незнакомый слой и блок не того размера пропускаются.
  pub fn apply(&mut self, change: &Change) -> Result<(), String> {
    let id = self.id(&change.layer).ok_or_else(|| format!("нет слоя {}", change.layer))?;
    let layer = &mut self.layers[id];
    let grid = matches!(layer.spec.shape, Shape::Grid { .. });
    let fits = if grid { change.bytes.len() == CHUNK_TILES * layer.stride } else { change.bytes.len() % layer.stride == 0 };
    if !change.bytes.is_empty() && !fits {
      return Err(format!("{}: блок {} байт", change.layer, change.bytes.len()));
    }
    if let Owner::Player(player) = change.owner {
      if layer.spec.scope == Scope::Player {
        layer.players.entry(player).or_default();
      }
    }
    let blocks = layer.blocks_mut(change.owner).ok_or_else(|| format!("{}: не слой игрока", change.layer))?;
    if change.bytes.is_empty() {
      blocks.remove(&(change.x, change.y));
    } else {
      blocks.insert((change.x, change.y), change.bytes.clone());
    }
    Ok(())
  }
}

/// Изменения одним буфером: число, затем на каждое — имя слоя (u8 длина, байты), владелец (i32: -1 — мир), x, y
/// блока (i32), длина (u32) и байты. Всё little-endian. Так их пишет и сохранение, и зеркало, и сеть.
pub fn encode(changes: &[Change]) -> Vec<u8> {
  let mut out = Vec::new();
  out.extend_from_slice(&(changes.len() as u32).to_le_bytes());
  for change in changes {
    out.push(change.layer.len() as u8);
    out.extend_from_slice(change.layer.as_bytes());
    out.extend_from_slice(&(change.owner.code() as i32).to_le_bytes());
    out.extend_from_slice(&change.x.to_le_bytes());
    out.extend_from_slice(&change.y.to_le_bytes());
    out.extend_from_slice(&(change.bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&change.bytes);
  }
  out
}

pub fn decode(bytes: &[u8]) -> Result<Vec<Change>, String> {
  let mut at = 0;
  let mut take = |len: usize| -> Result<&[u8], String> {
    let part = bytes.get(at..at + len).ok_or("изменения обрываются")?;
    at += len;
    Ok(part)
  };
  let int = |part: &[u8]| i32::from_le_bytes(part.try_into().unwrap());
  let count = u32::from_le_bytes(take(4)?.try_into().unwrap());
  let mut changes = Vec::with_capacity(count as usize);
  for _ in 0..count {
    let len = take(1)?[0] as usize;
    let layer = String::from_utf8(take(len)?.to_vec()).map_err(|error| error.to_string())?;
    let owner = Owner::from_code(int(take(4)?) as i64);
    let x = int(take(4)?);
    let y = int(take(4)?);
    let size = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
    changes.push(Change { layer, owner, x, y, bytes: take(size)?.to_vec() });
  }
  Ok(changes)
}

#[cfg(test)]
mod tests {
  use super::*;

  const SPECS: &str = r#"{
    "land": { "scope": "world", "shape": "grid", "channels": ["u8", "u8", "u8", "u8"], "save": true, "remember": true },
    "paving": { "scope": "world", "shape": "grid", "channels": ["u16"], "save": true },
    "sight": { "scope": "player", "shape": "grid", "channels": ["u8"], "allies": true },
    "explored": { "scope": "player", "shape": "grid", "channels": ["u8"], "save": true },
    "traces": { "scope": "world", "shape": "items", "cell": 16, "fields": { "kind": "u8", "tick": "u32" } }
  }"#;

  fn layers() -> Layers {
    Layers::new(LayerSpec::parse_all(SPECS).unwrap())
  }

  #[test]
  fn declarations_parse_and_check() {
    let specs = LayerSpec::parse_all(SPECS).unwrap();
    assert_eq!(specs.iter().map(|spec| spec.name.as_str()).collect::<Vec<_>>(), ["land", "paving", "sight", "explored", "traces"]);
    assert_eq!(specs[0].stride(), 4);
    assert_eq!(specs[4].stride(), 16 + 1 + 4);
    assert!(LayerSpec::parse_all(r#"{ "a": { "scope": "player", "shape": "grid", "channels": ["u8"], "remember": true } }"#).is_err());
    assert!(LayerSpec::parse_all(r#"{ "a": { "scope": "world", "shape": "grid", "channels": ["u8"], "typo": 1 } }"#).is_err());
  }

  #[test]
  fn grid_keeps_typed_channels_and_allocates_lazily() {
    let mut layers = layers();
    let (land, paving) = (layers.id("land").unwrap(), layers.id("paving").unwrap());
    layers.set(paving, Owner::World, 5, 5, 0, 0.0);
    assert!(layers.take_changes().is_empty(), "ноль в пустой чанк — не изменение");
    layers.set(land, Owner::World, -1, -33, 2, 7.0);
    layers.set(paving, Owner::World, 40, 3, 0, 1000.0);
    assert_eq!(layers.get(land, Owner::World, -1, -33, 2), 7.0);
    assert_eq!(layers.get(land, Owner::World, -1, -33, 1), 0.0);
    assert_eq!(layers.get(paving, Owner::World, 40, 3, 0), 1000.0);
    let changes = layers.take_changes();
    assert_eq!(changes.iter().map(|change| (change.layer.as_str(), change.x, change.y)).collect::<Vec<_>>(), [("land", -1, -2), ("paving", 1, 0)]);
    layers.set(land, Owner::World, -1, -33, 2, 7.0);
    assert!(layers.take_changes().is_empty(), "то же значение — не изменение");
  }

  #[test]
  fn player_layers_live_and_die_with_the_player() {
    let mut layers = layers();
    let explored = layers.id("explored").unwrap();
    layers.set(explored, Owner::Player(1), 0, 0, 0, 1.0);
    assert_eq!(layers.get(explored, Owner::Player(1), 0, 0, 0), 0.0, "незаведённому игроку писать некуда");
    layers.add_player(1);
    layers.add_player(2);
    layers.set(explored, Owner::Player(1), 0, 0, 0, 1.0);
    assert_eq!(layers.get(explored, Owner::Player(1), 0, 0, 0), 1.0);
    assert_eq!(layers.get(explored, Owner::Player(2), 0, 0, 0), 0.0);
    assert_eq!(layers.save(Owner::Player(1)).len(), 1);
    layers.take_changes();
    layers.forget_player(1);
    assert_eq!(layers.players(), BTreeSet::from([2]));
    let gone = layers.take_changes();
    assert_eq!(gone.len(), 1);
    assert!(gone[0].bytes.is_empty());
  }

  #[test]
  fn items_sit_in_cells() {
    let mut layers = layers();
    let traces = layers.id("traces").unwrap();
    layers.push(traces, Owner::World, &Item { x: 3.5, y: -0.25, fields: vec![2.0, 90.0] });
    layers.push(traces, Owner::World, &Item { x: 4.0, y: -1.0, fields: vec![1.0, 100.0] });
    let cell = layers.cell_of(traces, 3.5, -0.25);
    assert_eq!(cell, (0, -1));
    assert_eq!(layers.items(traces, Owner::World, cell).len(), 2);
    layers.retain(traces, Owner::World, cell, |item| item.fields[1] > 95.0);
    assert_eq!(layers.items(traces, Owner::World, cell), vec![Item { x: 4.0, y: -1.0, fields: vec![1.0, 100.0] }]);
  }

  #[test]
  fn changes_rebuild_the_same_layers_through_bytes() {
    let mut layers = layers();
    layers.add_player(3);
    let (land, explored, traces) = (layers.id("land").unwrap(), layers.id("explored").unwrap(), layers.id("traces").unwrap());
    for i in 0..50 {
      layers.set(land, Owner::World, i * 7 - 100, i * 3, i as usize % 4, i as f64);
      layers.set(explored, Owner::Player(3), i, -i, 0, 1.0);
    }
    layers.push(traces, Owner::World, &Item { x: 1.0, y: 2.0, fields: vec![3.0, 4.0] });
    let mut copy = Layers::new(LayerSpec::parse_all(SPECS).unwrap());
    for change in decode(&encode(&layers.take_changes())).unwrap() {
      copy.apply(&change).unwrap();
    }
    assert!(copy.take_changes().is_empty(), "применённое — не своё изменение");
    for i in 0..50 {
      assert_eq!(copy.get(land, Owner::World, i * 7 - 100, i * 3, i as usize % 4), i as f64);
      assert_eq!(copy.get(explored, Owner::Player(3), i, -i, 0), 1.0);
    }
    assert_eq!(copy.save(Owner::World), layers.save(Owner::World));
    assert_eq!(copy.save(Owner::Player(3)), layers.save(Owner::Player(3)));
  }
}
