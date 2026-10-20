//! Кадр мира для одного подключения (сообщение `delta` и соседние в protocol.ts, одним кадром): что поменялось в том,
//! что игрок видит и знает, за тик. Номера компонентов и полей — по схеме, она у сервера и клиента одна (те же моды).

use crate::codec::{Error, Reader, Writer};
use kharos_world::{ComponentId, Entity, Kind, Schema};
use serde_json::{Map, Value as Json};

/// Значение поля: число столбца (флаг, номер строки сервера) или таблица.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
  Num(f64),
  Any(Json),
}

/// Компонент сущности в кадре: новый — поля, отличные от значений по умолчанию, иначе — поменявшиеся.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
  pub component: ComponentId,
  pub added: bool,
  /// Номер поля в компоненте и значение.
  pub fields: Vec<(usize, Value)>,
}

/// Сущность в кадре: новые и поменявшиеся компоненты, снятые.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Change {
  pub entity: Entity,
  pub parts: Vec<Part>,
  pub unset: Vec<ComponentId>,
}

/// Призрак: чужое в тумане, каким игрок его видел (memory.rs, `Remembered`).
#[derive(Clone, Debug, PartialEq)]
pub struct Ghost {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub parts: Map<String, Json>,
}

/// Тайл запоминаемого слоя, как его знает игрок: пустые каналы — не знает ничего (общее — пусто).
#[derive(Clone, Debug, PartialEq)]
pub struct Recalled {
  pub layer: usize,
  pub x: i32,
  pub y: i32,
  pub values: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Frame {
  pub tick: u64,
  /// Строки сервера, которых подключение ещё не знает: номер и текст.
  pub strings: Vec<(u32, String)>,
  pub changes: Vec<Change>,
  /// Сущности, которых игрок больше не видит или которых не стало.
  pub removed: Vec<Entity>,
  /// Призраки: новый или другой — запись, None — забыт.
  pub ghosts: Vec<(Entity, Option<Ghost>)>,
  /// Чанки общих слоёв и слоёв игрока.
  pub layers: Vec<kharos_engine::layers::Change>,
  pub recalled: Vec<Recalled>,
  /// Тайлы земли, как их знает игрок: x, y и хранимые байты.
  pub land: Vec<(i32, i32, [u8; 4])>,
  pub signals: Vec<(String, Json)>,
  /// Разведанное раньше — только в первом кадре: длины чередующихся отрезков «не разведан», «разведан» по строкам
  /// карты, начиная с неразведанного.
  pub explored: Option<Vec<u32>>,
}

impl Frame {
  pub fn is_empty(&self) -> bool {
    self.strings.is_empty() && self.changes.is_empty() && self.removed.is_empty() && self.ghosts.is_empty() && self.layers.is_empty() && self.recalled.is_empty() && self.land.is_empty() && self.signals.is_empty() && self.explored.is_none()
  }

  pub fn encode(&self, schema: &Schema) -> Vec<u8> {
    let mut out = Writer::default();
    out.uint(self.tick);
    out.uint(self.strings.len() as u64);
    for (id, text) in &self.strings {
      out.uint(*id as u64);
      out.text(text);
    }
    out.uint(self.changes.len() as u64);
    for change in &self.changes {
      out.uint(change.entity as u64);
      out.uint(change.parts.len() as u64);
      for part in &change.parts {
        out.uint(((part.component as u64) << 1) | part.added as u64);
        out.uint(part.fields.len() as u64);
        let fields = &schema.components[part.component].fields;
        for (index, value) in &part.fields {
          out.uint(*index as u64);
          match (fields[*index].kind, value) {
            (Kind::Any, Value::Any(json)) => out.json(json),
            (Kind::Any, Value::Num(_)) => out.json(&Json::Null),
            (_, Value::Num(number)) => out.num(*number),
            (_, Value::Any(_)) => out.num(0.0),
          }
        }
      }
      out.uint(change.unset.len() as u64);
      for &component in &change.unset {
        out.uint(component as u64);
      }
    }
    out.uint(self.removed.len() as u64);
    for &entity in &self.removed {
      out.uint(entity as u64);
    }
    out.uint(self.ghosts.len() as u64);
    for (entity, ghost) in &self.ghosts {
      out.uint(*entity as u64);
      match ghost {
        None => out.u8(0),
        Some(ghost) => {
          out.u8(1);
          for value in [ghost.x, ghost.y, ghost.width, ghost.height] {
            out.num(value);
          }
          out.json(&Json::Object(ghost.parts.clone()));
        }
      }
    }
    out.uint(self.layers.len() as u64);
    for change in &self.layers {
      out.text(&change.layer);
      out.int(change.owner.code());
      out.int(change.x as i64);
      out.int(change.y as i64);
      out.blob(&change.bytes);
    }
    out.uint(self.recalled.len() as u64);
    for tile in &self.recalled {
      out.uint(tile.layer as u64);
      out.int(tile.x as i64);
      out.int(tile.y as i64);
      out.uint(tile.values.len() as u64);
      for &value in &tile.values {
        out.num(value);
      }
    }
    out.uint(self.land.len() as u64);
    for (x, y, bytes) in &self.land {
      out.int(*x as i64);
      out.int(*y as i64);
      out.bytes.extend_from_slice(bytes);
    }
    out.uint(self.signals.len() as u64);
    for (name, payload) in &self.signals {
      out.text(name);
      out.json(payload);
    }
    match &self.explored {
      None => out.u8(0),
      Some(runs) => {
        out.u8(1);
        out.uint(runs.len() as u64);
        for &run in runs {
          out.uint(run as u64);
        }
      }
    }
    out.bytes
  }

  pub fn decode(bytes: &[u8], schema: &Schema) -> Result<Self, Error> {
    let mut input = Reader::new(bytes);
    let mut frame = Frame { tick: input.uint()?, ..Default::default() };
    for _ in 0..input.count()? {
      frame.strings.push((input.u32()?, input.text()?));
    }
    for _ in 0..input.count()? {
      let mut change = Change { entity: input.u32()?, ..Default::default() };
      for _ in 0..input.count()? {
        let head = input.uint()?;
        let component = (head >> 1) as usize;
        let fields = &schema.components.get(component).ok_or_else(|| format!("нет компонента {component}"))?.fields;
        let mut part = Part { component, added: head & 1 == 1, fields: Vec::new() };
        for _ in 0..input.count()? {
          let index = input.uint()? as usize;
          let field = fields.get(index).ok_or_else(|| format!("у {} нет поля {index}", schema.components[component].name))?;
          let value = if field.kind == Kind::Any { Value::Any(input.json()?) } else { Value::Num(input.num()?) };
          part.fields.push((index, value));
        }
        change.parts.push(part);
      }
      for _ in 0..input.count()? {
        let component = input.uint()? as usize;
        if component >= schema.components.len() {
          return Err(format!("нет компонента {component}"));
        }
        change.unset.push(component);
      }
      frame.changes.push(change);
    }
    for _ in 0..input.count()? {
      frame.removed.push(input.u32()?);
    }
    for _ in 0..input.count()? {
      let entity = input.u32()?;
      let ghost = match input.u8()? {
        0 => None,
        _ => {
          let (x, y, width, height) = (input.num()?, input.num()?, input.num()?, input.num()?);
          let Json::Object(parts) = input.json()? else { return Err("призрак — не объект".into()) };
          Some(Ghost { x, y, width, height, parts })
        }
      };
      frame.ghosts.push((entity, ghost));
    }
    for _ in 0..input.count()? {
      let layer = input.text()?;
      let owner = kharos_engine::layers::Owner::from_code(input.int()?);
      let (x, y) = (input.int()? as i32, input.int()? as i32);
      frame.layers.push(kharos_engine::layers::Change { layer, owner, x, y, bytes: input.blob()?.to_vec() });
    }
    for _ in 0..input.count()? {
      let (layer, x, y) = (input.uint()? as usize, input.int()? as i32, input.int()? as i32);
      let mut values = Vec::new();
      for _ in 0..input.count()? {
        values.push(input.num()?);
      }
      frame.recalled.push(Recalled { layer, x, y, values });
    }
    for _ in 0..input.count()? {
      let (x, y) = (input.int()? as i32, input.int()? as i32);
      frame.land.push((x, y, [input.u8()?, input.u8()?, input.u8()?, input.u8()?]));
    }
    for _ in 0..input.count()? {
      frame.signals.push((input.text()?, input.json()?));
    }
    if input.u8()? == 1 {
      let mut runs = Vec::new();
      for _ in 0..input.count()? {
        runs.push(input.u32()?);
      }
      frame.explored = Some(runs);
    }
    if !input.done() {
      return Err("лишние байты в конце кадра".into());
    }
    Ok(frame)
  }
}

/// Разведанное (клетки обзора: 0 — нет, иначе да) отрезками для кадра.
pub fn runs_of(cells: &[u8]) -> Vec<u32> {
  let mut runs = Vec::new();
  let (mut current, mut length) = (false, 0u32);
  for &cell in cells {
    if (cell > 0) != current {
      runs.push(length);
      current = !current;
      length = 0;
    }
    length += 1;
  }
  runs.push(length);
  runs
}

/// Отрезки — обратно в клетки: разведанное — 1.
pub fn cells_of(runs: &[u32], size: usize) -> Vec<u8> {
  let mut cells = Vec::with_capacity(size);
  for (index, &run) in runs.iter().enumerate() {
    let value = (index % 2) as u8;
    let room = size - cells.len();
    cells.extend(std::iter::repeat_n(value, (run as usize).min(room)));
  }
  cells.resize(size, 0);
  cells
}
