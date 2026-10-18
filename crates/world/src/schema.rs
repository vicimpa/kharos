//! Схема компонентов. Компоненты объявляет контент — поле `components` любого вида:
//!
//! ```luau
//! components = {
//!   Drive = { move = "", speed = 0, turn = 0, moving = false },
//!   Producer = { progress = 0, queue = {} },
//! }
//! ```
//!
//! Вид поля — по значению по умолчанию: число → `Num`, `true`/`false` → `Bool`, строка → `Str` (в столбце — номер
//! строки), таблица → `Any` (значение целиком, JSON). Числа, флаги и строки лежат столбцами f64 и уходят системам
//! буферами; `Any` — по сущности, через `ctx:get` и `ctx:set`. Один компонент могут объявлять несколько видов: поля
//! складываются, одно поле с разными видами — ошибка.
//!
//! Компоненты движка — `Position`, `Facing`, `Owner`, `Proto`, `Sight`, `Attached` — объявлены всегда: по ним клиент
//! рисует и сглаживает, обзор считает, кто что видит, а носители ведут то, что на них закреплено.

use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  Num,
  Bool,
  Str,
  Any,
}

impl Kind {
  /// Лежит ли поле в столбце f64.
  pub fn columnar(self) -> bool {
    self != Kind::Any
  }

  fn name(self) -> &'static str {
    match self {
      Kind::Num => "число",
      Kind::Bool => "флаг",
      Kind::Str => "строка",
      Kind::Any => "таблица",
    }
  }
}

#[derive(Clone, Debug)]
pub struct Field {
  pub name: String,
  pub kind: Kind,
  pub default: Value,
  /// Номер столбца: среди числовых полей компонента или среди `Any`.
  pub slot: usize,
}

#[derive(Clone, Debug)]
pub struct Component {
  pub name: String,
  pub fields: Vec<Field>,
  /// Числовых столбцов и полей `Any`.
  pub nums: usize,
  pub anys: usize,
}

impl Component {
  pub fn field(&self, name: &str) -> Option<&Field> {
    self.fields.iter().find(|field| field.name == name)
  }
}

/// Номер компонента в схеме.
pub type ComponentId = usize;

#[derive(Clone, Debug, Default)]
pub struct Schema {
  pub components: Vec<Component>,
  by_name: HashMap<String, ComponentId>,
}

/// Компоненты движка: место, направление, владелец, вид, глаз (обзор, vision.rs) и место на носителе (tools.rs:
/// носитель, вперёд и вправо от его центра в тайлах, свой поворот).
pub const BUILTIN: &[(&str, &[(&str, f64)])] = &[
  ("Position", &[("x", 0.0), ("y", 0.0)]),
  ("Facing", &[("angle", 0.0)]),
  ("Owner", &[("player", 0.0)]),
  ("Proto", &[("id", 0.0)]),
  ("Sight", &[("radius", 0.0)]),
  ("Attached", &[("parent", 0.0), ("along", 0.0), ("across", 0.0), ("angle", 0.0)]),
];

impl Schema {
  pub fn new() -> Self {
    let mut schema = Self::default();
    for (name, fields) in BUILTIN {
      for (field, default) in *fields {
        schema.declare(name, field, Value::from(*default)).expect("поля движка");
      }
    }
    schema
  }

  pub fn id(&self, name: &str) -> Option<ComponentId> {
    self.by_name.get(name).copied()
  }

  pub fn get(&self, name: &str) -> Option<&Component> {
    self.id(name).map(|id| &self.components[id])
  }

  /// Объявляет компонент, если его ещё нет: без полей он — метка (`Turret = {}`).
  pub fn component(&mut self, component: &str) -> ComponentId {
    match self.by_name.get(component) {
      Some(&id) => id,
      None => {
        self.components.push(Component { name: component.to_string(), fields: Vec::new(), nums: 0, anys: 0 });
        self.by_name.insert(component.to_string(), self.components.len() - 1);
        self.components.len() - 1
      }
    }
  }

  /// Объявляет поле компонента (и компонент, если его ещё нет).
  pub fn declare(&mut self, component: &str, field: &str, default: Value) -> Result<(), String> {
    let kind = match &default {
      Value::Number(_) => Kind::Num,
      Value::Bool(_) => Kind::Bool,
      Value::String(_) => Kind::Str,
      Value::Array(_) | Value::Object(_) | Value::Null => Kind::Any,
    };
    let id = self.component(component);
    let entry = &mut self.components[id];
    if let Some(existing) = entry.field(field) {
      return if existing.kind == kind { Ok(()) } else { Err(format!("{component}.{field}: объявлено и как {}, и как {}", existing.kind.name(), kind.name())) };
    }
    let slot = if kind.columnar() {
      entry.nums += 1;
      entry.nums - 1
    } else {
      entry.anys += 1;
      entry.anys - 1
    };
    entry.fields.push(Field { name: field.to_string(), kind, default, slot });
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn kinds_come_from_defaults_and_merge() {
    let mut schema = Schema::new();
    schema.declare("Drive", "speed", json!(0)).unwrap();
    schema.declare("Drive", "move", json!("")).unwrap();
    schema.declare("Drive", "queue", json!({})).unwrap();
    schema.declare("Drive", "speed", json!(4)).unwrap();
    assert!(schema.declare("Drive", "speed", json!("fast")).is_err());
    let drive = schema.get("Drive").unwrap();
    assert_eq!(drive.fields.iter().map(|field| (field.name.as_str(), field.kind, field.slot)).collect::<Vec<_>>(), [("speed", Kind::Num, 0), ("move", Kind::Str, 1), ("queue", Kind::Any, 0)]);
    assert_eq!((drive.nums, drive.anys), (2, 1));
    assert!(schema.get("Position").is_some());
  }
}
