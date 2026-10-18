//! Мир столбцами. Сущность — номер (с 1, не повторяются); у каждого компонента — плотный список сущностей и столбцы
//! полей: числовые (f64, туда же флаги и номера строк) и `Any` (JSON). Системы получают столбцы буферами, а не объекты
//! на сущность (docs/content.md, §2).

use crate::schema::{ComponentId, Kind, Schema};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::rc::Rc;

pub type Entity = u32;

/// Строки полей `Str` по номерам. Номер 0 — пустая строка.
#[derive(Clone, Debug)]
pub struct Strings {
  list: Vec<String>,
  index: HashMap<String, u32>,
}

impl Default for Strings {
  fn default() -> Self {
    Self { list: vec![String::new()], index: HashMap::from([(String::new(), 0)]) }
  }
}

impl Strings {
  pub fn id(&mut self, text: &str) -> u32 {
    if let Some(&id) = self.index.get(text) {
      return id;
    }
    self.list.push(text.to_string());
    self.index.insert(text.to_string(), self.list.len() as u32 - 1);
    self.list.len() as u32 - 1
  }

  /// Номер строки, если она уже встречалась.
  pub fn find(&self, text: &str) -> Option<u32> {
    self.index.get(text).copied()
  }

  pub fn text(&self, id: u32) -> &str {
    self.list.get(id as usize).map(String::as_str).unwrap_or("")
  }
}

/// Номер сущности → строка хранилища: страницы по 1024 номера, пустая строка — `u32::MAX`. Быстрее `HashMap`
/// в разы, а память — только на страницы, где сущности есть.
#[derive(Clone, Debug, Default)]
pub struct Sparse {
  pages: Vec<Option<Box<[u32; PAGE]>>>,
}

const PAGE: usize = 1024;

impl Sparse {
  #[inline]
  pub fn get(&self, entity: Entity) -> Option<u32> {
    let (page, slot) = (entity as usize / PAGE, entity as usize % PAGE);
    match self.pages.get(page) {
      Some(Some(rows)) if rows[slot] != u32::MAX => Some(rows[slot]),
      _ => None,
    }
  }

  #[inline]
  pub fn contains_key(&self, entity: &Entity) -> bool {
    self.get(*entity).is_some()
  }

  pub fn insert(&mut self, entity: Entity, row: u32) {
    let (page, slot) = (entity as usize / PAGE, entity as usize % PAGE);
    if self.pages.len() <= page {
      self.pages.resize(page + 1, None);
    }
    self.pages[page].get_or_insert_with(|| Box::new([u32::MAX; PAGE]))[slot] = row;
  }

  pub fn remove(&mut self, entity: &Entity) -> Option<u32> {
    let row = self.get(*entity)?;
    let (page, slot) = (*entity as usize / PAGE, *entity as usize % PAGE);
    self.pages[page].as_mut().expect("страница")[slot] = u32::MAX;
    Some(row)
  }
}

/// Хранилище одного компонента.
#[derive(Clone, Debug, Default)]
pub struct Store {
  pub entities: Vec<Entity>,
  pub sparse: Sparse,
  pub nums: Vec<Vec<f64>>,
  pub anys: Vec<Vec<Value>>,
}

impl Store {
  #[inline]
  pub fn row(&self, entity: Entity) -> Option<usize> {
    self.sparse.get(entity).map(|row| row as usize)
  }

  pub fn len(&self) -> usize {
    self.entities.len()
  }

  pub fn is_empty(&self) -> bool {
    self.entities.is_empty()
  }
}

#[derive(Clone, Debug)]
pub struct World {
  pub schema: Rc<Schema>,
  pub stores: Vec<Store>,
  pub strings: Strings,
  next: Entity,
  alive: HashMap<Entity, ()>,
  /// Номер правки состава: растёт, когда сущность появилась, пропала или у неё добавился или снят компонент.
  pub revision: u64,
}

impl World {
  pub fn new(schema: Rc<Schema>) -> Self {
    let stores = schema.components.iter().map(|component| Store { nums: vec![Vec::new(); component.nums], anys: vec![Vec::new(); component.anys], ..Default::default() }).collect();
    Self { schema, stores, strings: Strings::default(), next: 1, alive: HashMap::new(), revision: 0 }
  }

  pub fn spawn(&mut self) -> Entity {
    let entity = self.next;
    self.next += 1;
    self.alive.insert(entity, ());
    self.revision += 1;
    entity
  }

  /// Следующий номер сущности: команды систем раздают номера заранее, до того как сущность появится.
  pub fn reserve(&mut self) -> Entity {
    let entity = self.next;
    self.next += 1;
    entity
  }

  /// Следующий номер сущности — для сохранения.
  pub fn next_id(&self) -> Entity {
    self.next
  }

  /// Номера дальше этого свободны — после загрузки сохранения.
  pub fn set_next(&mut self, next: Entity) {
    self.next = self.next.max(next);
  }

  /// Оживляет заранее выданный номер.
  pub fn revive(&mut self, entity: Entity) {
    self.alive.insert(entity, ());
    self.revision += 1;
  }

  pub fn alive(&self, entity: Entity) -> bool {
    self.alive.contains_key(&entity)
  }

  pub fn count(&self) -> usize {
    self.alive.len()
  }

  pub fn destroy(&mut self, entity: Entity) {
    if self.alive.remove(&entity).is_none() {
      return;
    }
    for id in 0..self.stores.len() {
      self.remove(entity, id);
    }
    self.revision += 1;
  }

  pub fn has(&self, entity: Entity, component: ComponentId) -> bool {
    self.stores[component].sparse.contains_key(&entity)
  }

  /// Добавляет компонент со значениями по умолчанию и values поверх; уже есть — значения поверх имеющихся.
  pub fn add(&mut self, entity: Entity, component: ComponentId, values: &Map<String, Value>) -> Result<(), String> {
    if !self.alive(entity) {
      return Err(format!("сущности {entity} нет"));
    }
    if !self.has(entity, component) {
      let schema = self.schema.clone();
      let def = &schema.components[component];
      let store = &mut self.stores[component];
      store.sparse.insert(entity, store.entities.len() as u32);
      store.entities.push(entity);
      for field in &def.fields {
        match field.kind {
          Kind::Any => store.anys[field.slot].push(field.default.clone()),
          kind => store.nums[field.slot].push(encode(&mut self.strings, kind, &field.default)),
        }
      }
      self.revision += 1;
    }
    self.set(entity, component, values)
  }

  /// Меняет поля компонента, который у сущности уже есть. Неизвестное поле — ошибка: опечатка не пройдёт молча.
  pub fn set(&mut self, entity: Entity, component: ComponentId, values: &Map<String, Value>) -> Result<(), String> {
    let schema = self.schema.clone();
    let def = &schema.components[component];
    let row = self.stores[component].row(entity).ok_or_else(|| format!("у сущности {entity} нет {}", def.name))?;
    for (name, value) in values {
      let field = def.field(name).ok_or_else(|| format!("у {} нет поля {name}", def.name))?;
      match field.kind {
        // Пустая таблица Luau — и список, и словарь: какой, говорит значение поля по умолчанию.
        Kind::Any if field.default.is_array() && value.as_object().is_some_and(Map::is_empty) => self.stores[component].anys[field.slot][row] = Value::Array(Vec::new()),
        Kind::Any => self.stores[component].anys[field.slot][row] = value.clone(),
        kind => {
          let number = encode_checked(&mut self.strings, kind, value).ok_or_else(|| format!("{}.{name}: {value} — не {}", def.name, kind_word(kind)))?;
          self.stores[component].nums[field.slot][row] = number;
        }
      }
    }
    Ok(())
  }

  pub fn remove(&mut self, entity: Entity, component: ComponentId) {
    let store = &mut self.stores[component];
    let Some(row) = store.sparse.remove(&entity) else { return };
    let row = row as usize;
    store.entities.swap_remove(row);
    for column in &mut store.nums {
      column.swap_remove(row);
    }
    for column in &mut store.anys {
      column.swap_remove(row);
    }
    if let Some(&moved) = store.entities.get(row) {
      store.sparse.insert(moved, row as u32);
    }
    self.revision += 1;
  }

  /// Значение компонента объектом: поля по схеме, строки — строками.
  pub fn get(&self, entity: Entity, component: ComponentId) -> Option<Map<String, Value>> {
    let store = &self.stores[component];
    let row = store.row(entity)?;
    let mut map = Map::new();
    for field in &self.schema.components[component].fields {
      let value = match field.kind {
        Kind::Any => store.anys[field.slot][row].clone(),
        kind => decode(&self.strings, kind, store.nums[field.slot][row]),
      };
      map.insert(field.name.clone(), value);
    }
    Some(map)
  }

  /// Число из столбца.
  pub fn num(&self, entity: Entity, component: ComponentId, field: &str) -> Option<f64> {
    let store = &self.stores[component];
    let field = self.schema.components[component].field(field).filter(|field| field.kind.columnar())?;
    Some(store.nums[field.slot][store.row(entity)?])
  }

  /// Сущности со всеми компонентами списка: в порядке хранилища самого короткого из них.
  pub fn query(&self, components: &[ComponentId]) -> Vec<Entity> {
    let Some(&shortest) = components.iter().min_by_key(|&&id| self.stores[id].len()) else { return Vec::new() };
    self.stores[shortest].entities.iter().copied().filter(|&entity| components.iter().all(|&id| id == shortest || self.has(entity, id))).collect()
  }

  /// Все живые сущности по возрастанию номеров.
  pub fn entities(&self) -> Vec<Entity> {
    let mut list: Vec<Entity> = self.alive.keys().copied().collect();
    list.sort_unstable();
    list
  }
}

fn kind_word(kind: Kind) -> &'static str {
  match kind {
    Kind::Num => "число",
    Kind::Bool => "флаг",
    Kind::Str => "строка",
    Kind::Any => "значение",
  }
}

fn encode(strings: &mut Strings, kind: Kind, value: &Value) -> f64 {
  encode_checked(strings, kind, value).unwrap_or(0.0)
}

/// Значение поля в столбец f64; не того вида — None.
pub fn encode_checked(strings: &mut Strings, kind: Kind, value: &Value) -> Option<f64> {
  match (kind, value) {
    (Kind::Num, Value::Number(number)) => number.as_f64(),
    (Kind::Bool, Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
    (Kind::Str, Value::String(text)) => Some(strings.id(text) as f64),
    _ => None,
  }
}

/// Значение из столбца f64 в JSON.
pub fn decode(strings: &Strings, kind: Kind, number: f64) -> Value {
  match kind {
    Kind::Num => serde_json::Number::from_f64(number).map(Value::Number).unwrap_or(Value::Null),
    Kind::Bool => Value::Bool(number != 0.0),
    Kind::Str => Value::String(strings.text(number as u32).to_string()),
    Kind::Any => Value::Null,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
  }

  #[test]
  fn columns_follow_adds_and_removes() {
    let mut schema = Schema::new();
    schema.declare("Drive", "speed", json!(1)).unwrap();
    schema.declare("Drive", "move", json!("wheels")).unwrap();
    schema.declare("Drive", "queue", json!([])).unwrap();
    let mut world = World::new(Rc::new(schema));
    let drive = world.schema.id("Drive").unwrap();
    let a = world.spawn();
    let b = world.spawn();
    world.add(a, drive, &object(json!({ "speed": 4 }))).unwrap();
    world.add(b, drive, &object(json!({ "move": "legs", "queue": [1] }))).unwrap();
    assert_eq!(world.get(a, drive).unwrap(), object(json!({ "speed": 4.0, "move": "wheels", "queue": [] })));
    assert_eq!(world.get(b, drive).unwrap(), object(json!({ "speed": 1.0, "move": "legs", "queue": [1] })));
    assert!(world.set(a, drive, &object(json!({ "sped": 1 }))).is_err());
    assert!(world.set(a, drive, &object(json!({ "speed": "fast" }))).is_err());
    world.destroy(a);
    assert_eq!(world.query(&[drive]), [b]);
    assert_eq!(world.num(b, drive, "speed"), Some(1.0));
    assert_eq!(world.num(a, drive, "speed"), None);
  }
}
