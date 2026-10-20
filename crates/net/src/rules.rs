//! Кому что из мира видно по сети (PRIVATE, `wire()` и `seenBy` в wire.ts). Решает мод — полем `net` любого вида:
//!
//! ```luau
//! net = {
//!   Path = "allies",                                -- компонент: всем (all), хозяину и союзникам, хозяину, никому
//!   Inventory = { to = "owner", public = { "Drop" } }, -- у сущности с Drop — всем
//!   Armed = { fields = { target = "owner" } },      -- поле: чужим — значение по умолчанию
//!   Mark = { audience = "viewers" },                -- сущность — хозяину, союзникам и игрокам из списка, сквозь туман
//!   Missile = { owner = "player" },                 -- хозяин сущности — это поле (у неё нет Owner)
//! }
//! ```
//!
//! Хозяин сущности — `Owner.player`, у игрока — `Player.id`, иначе поле из `owner` правила. Ничьё (хозяина нет или
//! 0) видно целиком всем.

use kharos_content::Content;
use kharos_world::{ComponentId, Kind, Schema, World};
use mlua::{Table, Value};
use std::collections::BTreeMap;

/// Кому видно.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum To {
  All,
  Allies,
  Owner,
  None,
}

impl To {
  fn parse(text: &str) -> Result<Self, String> {
    match text {
      "all" => Ok(To::All),
      "allies" => Ok(To::Allies),
      "owner" => Ok(To::Owner),
      "none" => Ok(To::None),
      other => Err(format!("«{other}» — не all, allies, owner или none")),
    }
  }

  /// Видно ли тому, кто приходится сущности relation.
  pub fn lets(self, relation: Relation) -> bool {
    match self {
      To::All => true,
      To::Allies => relation != Relation::Foreign,
      To::Owner => matches!(relation, Relation::Mine | Relation::Nobody),
      To::None => false,
    }
  }
}

/// Кем сущность приходится смотрящему.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relation {
  Mine,
  Ally,
  Foreign,
  /// Ничья.
  Nobody,
}

/// Правило компонента.
#[derive(Clone, Debug)]
pub struct Rule {
  pub to: To,
  /// С этими компонентами сущность показывает компонент всем.
  pub public: Vec<ComponentId>,
  /// Поля, скрытые иначе, чем весь компонент: номер поля в компоненте и кому видно.
  pub fields: Vec<(usize, To)>,
  /// Поле `Any` со списком игроков: сущность с этим компонентом видят только они, хозяин и союзники — и сквозь туман.
  pub audience: Option<usize>,
  /// Числовое поле — хозяин сущности.
  pub owner: Option<usize>,
}

impl Default for Rule {
  fn default() -> Self {
    Self { to: To::All, public: Vec::new(), fields: Vec::new(), audience: None, owner: None }
  }
}

/// Правила всех компонентов схемы.
#[derive(Clone, Debug)]
pub struct Rules {
  pub rules: Vec<Rule>,
  /// Компоненты, у которых правило не по умолчанию: только их и смотреть при сборке.
  pub special: Vec<ComponentId>,
  owner: Option<ComponentId>,
  player: Option<ComponentId>,
  /// Компоненты с полем хозяина: компонент, номер столбца.
  owners: Vec<(ComponentId, usize)>,
  audiences: Vec<(ComponentId, usize)>,
}

fn field_index(schema: &Schema, component: ComponentId, name: &str, label: &str) -> Result<usize, String> {
  schema.components[component].fields.iter().position(|field| field.name == name).ok_or_else(|| format!("{label}: у {} нет поля {name}", schema.components[component].name))
}

impl Rules {
  /// Правила движка: путь — своим и союзникам (куда идёт враг — тайна), у игрока хозяин — `Player.id`, а кредиты,
  /// исследования и план — его.
  fn engine(schema: &Schema) -> Vec<Rule> {
    let mut rules = vec![Rule::default(); schema.components.len()];
    if let Some(path) = schema.id("Path") {
      rules[path].to = To::Allies;
    }
    if let Some(player) = schema.id("Player") {
      let component = &schema.components[player];
      rules[player].owner = component.fields.iter().position(|field| field.name == "id");
      rules[player].fields = component.fields.iter().enumerate().filter(|(_, field)| field.name != "id" && field.name != "allies").map(|(index, _)| (index, To::Owner)).collect();
    }
    rules
  }

  /// Правила из модов поверх правил движка: поле `net` всех видов по порядку загрузки.
  pub fn of(content: &Content, schema: &Schema) -> Result<Self, String> {
    let mut rules = Self::engine(schema);
    for proto in &content.list {
      let Some(table) = content.by_id(proto.id) else { continue };
      let label = format!("{}/{}.net", proto.section, proto.name);
      let Some(net) = table.get::<Option<Table>>("net").map_err(|error| format!("{label}: {error}"))? else { continue };
      for pair in net.pairs::<String, Value>() {
        let (name, value) = pair.map_err(|error| format!("{label}: {error}"))?;
        let component = schema.id(&name).ok_or_else(|| format!("{label}: нет компонента {name}"))?;
        let label = format!("{label}.{name}");
        let rule = &mut rules[component];
        match value {
          Value::String(text) => rule.to = To::parse(&text.to_string_lossy()).map_err(|error| format!("{label}: {error}"))?,
          Value::Table(spec) => {
            if let Some(to) = spec.get::<Option<String>>("to").map_err(|error| format!("{label}.to: {error}"))? {
              rule.to = To::parse(&to).map_err(|error| format!("{label}.to: {error}"))?;
            }
            for other in spec.get::<Option<Vec<String>>>("public").map_err(|error| format!("{label}.public: {error}"))?.unwrap_or_default() {
              rule.public.push(schema.id(&other).ok_or_else(|| format!("{label}.public: нет компонента {other}"))?);
            }
            if let Some(fields) = spec.get::<Option<Table>>("fields").map_err(|error| format!("{label}.fields: {error}"))? {
              for pair in fields.pairs::<String, String>() {
                let (field, to) = pair.map_err(|error| format!("{label}.fields: {error}"))?;
                let index = field_index(schema, component, &field, &label)?;
                let to = To::parse(&to).map_err(|error| format!("{label}.fields.{field}: {error}"))?;
                rule.fields.retain(|(other, _)| *other != index);
                rule.fields.push((index, to));
              }
            }
            if let Some(field) = spec.get::<Option<String>>("audience").map_err(|error| format!("{label}.audience: {error}"))? {
              let index = field_index(schema, component, &field, &label)?;
              if schema.components[component].fields[index].kind != Kind::Any {
                return Err(format!("{label}.audience: {field} — не список"));
              }
              rule.audience = Some(index);
            }
            if let Some(field) = spec.get::<Option<String>>("owner").map_err(|error| format!("{label}.owner: {error}"))? {
              let index = field_index(schema, component, &field, &label)?;
              if schema.components[component].fields[index].kind != Kind::Num {
                return Err(format!("{label}.owner: {field} — не число"));
              }
              rule.owner = Some(index);
            }
          }
          _ => return Err(format!("{label}: правило — строка или таблица")),
        }
      }
    }
    Ok(Self::from_rules(schema, rules))
  }

  fn from_rules(schema: &Schema, rules: Vec<Rule>) -> Self {
    let special = (0..rules.len()).filter(|&id| rules[id].to != To::All || !rules[id].fields.is_empty()).collect();
    let slot = |component: ComponentId, index: usize| schema.components[component].fields[index].slot;
    let owners = (0..rules.len()).filter_map(|id| rules[id].owner.map(|index| (id, slot(id, index)))).collect();
    let audiences = (0..rules.len()).filter_map(|id| rules[id].audience.map(|index| (id, slot(id, index)))).collect();
    Self { rules, special, owner: schema.id("Owner"), player: schema.id("Player"), owners, audiences }
  }

  /// Правила движка без модов — для тестов.
  pub fn engine_only(schema: &Schema) -> Self {
    Self::from_rules(schema, Self::engine(schema))
  }

  /// Хозяин сущности; None — ничья.
  pub fn owner_of(&self, world: &World, entity: kharos_world::Entity) -> Option<u32> {
    let read = |component: ComponentId, slot: usize| world.stores[component].row(entity).map(|row| world.stores[component].nums[slot][row]);
    let owner = self.owner.and_then(|owner| read(owner, 0)).or_else(|| self.owners.iter().find_map(|&(component, slot)| read(component, slot)));
    owner.filter(|&owner| owner > 0.0).map(|owner| owner as u32)
  }

  /// Кем сущность приходится игроку viewer, у которого союзники friends.
  pub fn relation(&self, world: &World, entity: kharos_world::Entity, viewer: u32, friends: &[u32]) -> Relation {
    match self.owner_of(world, entity) {
      None => Relation::Nobody,
      Some(owner) if owner == viewer => Relation::Mine,
      Some(owner) if friends.contains(&owner) => Relation::Ally,
      Some(_) => Relation::Foreign,
    }
  }

  /// Список зрителей (`audience`): None — у сущности его нет; Some(true) — viewer в нём, хозяин или союзник: сущность
  /// уходит ему и сквозь туман; Some(false) — не уходит.
  pub fn audience(&self, world: &World, entity: kharos_world::Entity, viewer: u32, relation: Relation) -> Option<bool> {
    let mut found = None;
    for &(component, slot) in &self.audiences {
      let Some(row) = world.stores[component].row(entity) else { continue };
      let listed = matches!(relation, Relation::Mine | Relation::Ally) || world.stores[component].anys[slot][row].as_array().is_some_and(|list| list.iter().any(|player| player.as_f64() == Some(viewer as f64)));
      found = Some(found.unwrap_or(true) && listed);
    }
    found
  }

  /// Видит ли viewer компонент сущности.
  pub fn shows_component(&self, world: &World, entity: kharos_world::Entity, component: ComponentId, relation: Relation) -> bool {
    let rule = &self.rules[component];
    rule.to.lets(relation) || rule.public.iter().any(|&other| world.has(entity, other))
  }

  /// Скрытые от того, кто приходится сущности relation, поля компонента: номера полей.
  pub fn hidden_fields(&self, component: ComponentId, relation: Relation) -> impl Iterator<Item = usize> + '_ {
    self.rules[component].fields.iter().filter(move |(_, to)| !to.lets(relation)).map(|(index, _)| *index)
  }

  /// Игрок → его союзники (компонент движка `Player`).
  pub fn friends(&self, world: &World) -> BTreeMap<u32, Vec<u32>> {
    let mut all = BTreeMap::new();
    let Some(player) = self.player else { return all };
    let store = &world.stores[player];
    let (Some(id), Some(allies)) = (world.schema.components[player].field("id"), world.schema.components[player].field("allies")) else { return all };
    for row in 0..store.len() {
      let list = store.anys[allies.slot][row].as_array().map(|list| list.iter().filter_map(serde_json::Value::as_f64).map(|ally| ally as u32).collect()).unwrap_or_default();
      all.insert(store.nums[id.slot][row] as u32, list);
    }
    all
  }

  /// Есть ли у сущности компонент игрока: такие видны всем (кто играет, с кем в союзе).
  pub fn is_player(&self, world: &World, entity: kharos_world::Entity) -> bool {
    self.player.is_some_and(|player| world.has(entity, player))
  }
}
