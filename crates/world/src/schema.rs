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

/// Компоненты движка и их поля со значениями по умолчанию: место, направление, владелец, вид, глаз (обзор,
/// vision.rs), место на носителе (tools.rs), ход и путь (motion), основание здания (занятость, motion) и игрок с
/// союзниками (кто кому уступает дорогу).
pub fn builtin() -> Vec<(&'static str, Vec<(&'static str, Value)>)> {
  use serde_json::json;
  vec![
    ("Position", vec![("x", json!(0)), ("y", json!(0))]),
    ("Facing", vec![("angle", json!(0))]),
    ("Owner", vec![("player", json!(0))]),
    ("Proto", vec![("id", json!(0))]),
    ("Sight", vec![("radius", json!(0))]),
    ("Attached", vec![("parent", json!(0)), ("along", json!(0)), ("across", json!(0)), ("angle", json!(0))]),
    // Ход: скорость в тайлах в секунду, поворот в радианах в секунду, радиус тела, род (vehicle, heavy, infantry,
    // air) — по нему замедление на местности; rooted — стоит на месте (разворачивается).
    ("Mover", vec![("speed", json!(0)), ("turn", json!(0)), ("radius", json!(0)), ("class", json!("vehicle")), ("rooted", json!(false))]),
    // Путь: точки центров тайлов подряд, цель, сколько ждёт и пробовал, на сколько подойти, едет ли напрямую.
    ("Path", vec![("points", json!([])), ("goalX", json!(0)), ("goalY", json!(0)), ("wait", json!(0)), ("tries", json!(0)), ("near", json!(0)), ("roads", json!(false)), ("direct", json!(false)), ("stuck", json!(false)), ("best", json!(-1)), ("slot", json!(false))]),
    // Основание здания: тайлы вокруг центра (Position), занятые для хода; passable — проезд открыт (ворота).
    ("Footprint", vec![("width", json!(1)), ("height", json!(1)), ("passable", json!(false)), ("wall", json!(false))]),
    // Игрок: номер, союзники (им уступают дорогу, их не бьют, разведка общая) и до какого тика он под защитой новичка —
    // его нельзя атаковать, и сам он не стреляет (combat).
    ("Player", vec![("id", json!(0)), ("allies", json!([])), ("safe", json!(0))]),
    // Запоминаемое (memory.rs): чужое, ушедшее в туман, игрок помнит таким, каким видел, пока не увидит его место —
    // width × height тайлов вокруг Position.
    ("Memorable", vec![("width", json!(1)), ("height", json!(1))]),
    // Связь в сеть (networks.rs): круг зоны, группа стыка, проводник, подземный отрезок, ядро сети, основание, лист.
    ("Link", vec![("radius", json!(0)), ("group", json!("")), ("conduit", json!(false)), ("tunnel", json!(0)), ("core", json!(false)), ("width", json!(1)), ("height", json!(1)), ("leaf", json!(false))]),
    // Бой (combat): прочность — доля от hp, hit — тик последнего попадания; оружие стрелка, его поворот, откуда
    // вылетает выстрел и сколько он стоит магазину носителя; стойка юнита; выстрел и взрыв — сущности для подачи.
    ("Health", vec![("value", json!(1)), ("max", json!(1)), ("regen", json!(0)), ("hit", json!(-1)), ("hp", json!(1))]),
    ("Armed", vec![("weapon", json!("")), ("turn", json!(0)), ("radius", json!(0)), ("target", json!(-1)), ("chase", json!(false)), ("cooldown", json!(0)), ("stuck", json!(0)), ("ordered", json!(false)), ("cost", json!(0))]),
    ("Tactics", vec![("stance", json!("defensive")), ("patrol", json!([])), ("leg", json!(0)), ("away", json!(false)), ("homeX", json!(0)), ("homeY", json!(0)), ("resupply", json!(false))]),
    ("Shot", vec![("weapon", json!("")), ("player", json!(0)), ("source", json!(-1)), ("target", json!(-1)), ("fromX", json!(0)), ("fromY", json!(0)), ("toX", json!(0)), ("toY", json!(0)), ("prevX", json!(0)), ("prevY", json!(0)), ("age", json!(0)), ("life", json!(0)), ("blocked", json!(false)), ("air", json!(false))]),
    ("Blast", vec![("size", json!(1)), ("age", json!(0)), ("life", json!(0)), ("lift", json!(0))]),
    // Взрыв по площади, который бьёт всех без разбора — своих, союзных и чужих (авария, ядерный удар): в ближайшем
    // бою наносит damage в радиусе core и меньше к краю radius и пропадает. Здание с Meltdown при гибели оставляет
    // такой взрыв на своём месте.
    ("Burst", vec![("radius", json!(0)), ("damage", json!(0)), ("core", json!(0))]),
    ("Meltdown", vec![("radius", json!(0)), ("damage", json!(0))]),
    // Обречённый (combat): через left тиков боя гибнет, как от выстрела, — взрыв, остов, событие `killed`; без
    // прочности просто пропадает. scuttled — игрок уничтожил своё сам, а не сдался.
    ("Doomed", vec![("left", json!(0)), ("scuttled", json!(false))]),
    // Купол щита вокруг сущности (combat): пока есть запас charge и купол не погашен (down — до какого тика), урон по
    // своим и союзным под ним от стрелков снаружи и от летающих берёт запас; чужие снаряды рвутся на его краю. hit —
    // тик последнего погашенного удара; пробитый до нуля гаснет на recover секунд. Запас растит механика мода.
    // Магазин носителя (combat): выстрел стрелка тратит из него Armed.cost, не хватает — не стреляет; у юнита, у
    // которого меньше least, — пусто: цель он бросает и новой не ищет.
    ("Magazine", vec![("ammo", json!(0)), ("least", json!(0))]),
    ("Shield", vec![("charge", json!(0)), ("hit", json!(-1)), ("down", json!(0)), ("radius", json!(0)), ("recover", json!(10))]),
    // Доля работы носителя (0..1): его оружие перезаряжается во столько раз дольше, при нуле молчит.
    ("Throttle", vec![("share", json!(1))]),
  ]
}

impl Schema {
  pub fn new() -> Self {
    let mut schema = Self::default();
    for (name, fields) in builtin() {
      for (field, default) in fields {
        schema.declare(name, field, default).expect("поля движка");
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
