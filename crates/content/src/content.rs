//! Загрузка модов в машину Luau (docs/mods.md, «Загрузка»):
//!
//! 1. Манифесты `mod.luau` — имя, зависимости — и порядок модов.
//! 2. Виды: каждый файл раздела выполняется и отдаёт таблицу; вид с тем же именем из более позднего мода заменяет
//!    прежний.
//! 3. Правки: `patch(protos)` из манифестов, в порядке модов, — мод меняет, добавляет и убирает чужие виды.
//!
//! Итог — таблица `protos[раздел][имя]`. Хост и клиент загружают одно и то же каждый в своей машине и сверяют суммы
//! данных видов.

use crate::files::Fnv;
use crate::mods::{order, Mod};
use crate::vm::{function, load_module, new_vm, run_file, Side, Sources};
use mlua::{Lua, Table, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Вид после загрузки и правок.
#[derive(Clone, Debug)]
pub struct Proto {
  pub section: String,
  pub name: String,
  /// Номер вида: по разделам и именам, одинаковый у всех, у кого те же моды.
  pub id: u32,
  /// Из какого мода и файла (у добавленного правкой — мод правки и пустой путь).
  pub source: String,
}

/// Загруженные моды: машина Luau, таблица видов и их список.
pub struct Content {
  pub lua: Lua,
  pub side: Side,
  /// Моды в порядке загрузки.
  pub mods: Vec<String>,
  /// Манифесты модов в порядке загрузки.
  pub manifests: Vec<Table>,
  /// `protos[раздел][имя]` — таблицы видов, то же, что видят скрипты.
  pub protos: Table,
  /// Виды по номерам.
  pub list: Vec<Proto>,
  index: BTreeMap<(String, String), u32>,
  /// Файлы модов в порядке загрузки — за картинками.
  files: Vec<std::rc::Rc<crate::files::Files>>,
}

/// Ошибка загрузки с тем, где она случилась.
#[derive(Debug)]
pub struct LoadError(pub String);

impl std::fmt::Display for LoadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for LoadError {}

fn fail(what: impl std::fmt::Display) -> impl FnOnce(mlua::Error) -> LoadError {
  move |error| LoadError(format!("{what}: {error}"))
}

impl Content {
  /// Загружает моды на стороне side.
  pub fn load(side: Side, mods: Vec<Mod>) -> Result<Self, LoadError> {
    let files_of: HashMap<String, std::rc::Rc<crate::files::Files>> = mods.iter().map(|one| (one.name.clone(), one.files.clone())).collect();
    let mut sources = Sources::default();
    for one in &mods {
      if sources.mods.insert(one.name.clone(), one.files.clone()).is_some() {
        return Err(LoadError(format!("два мода с именем {}", one.name)));
      }
    }
    let lua = new_vm(side, sources).map_err(fail("машина Luau"))?;

    // Манифесты и порядок.
    let mut manifests = BTreeMap::new();
    let mut requires = BTreeMap::new();
    for one in &mods {
      let manifest: Table = match run_file(&lua, &one.name, "mod.luau").map_err(fail(format!("мод {}", one.name)))? {
        Value::Table(table) => table,
        other => return Err(LoadError(format!("@{}/mod.luau вернул {}, а нужна таблица", one.name, other.type_name()))),
      };
      let needs: Vec<String> = manifest.get::<Option<Vec<String>>>("requires").map_err(fail(format!("@{}/mod.luau, requires", one.name)))?.unwrap_or_default();
      requires.insert(one.name.clone(), needs);
      manifests.insert(one.name.clone(), manifest);
    }
    let names = order(&requires).map_err(LoadError)?;
    let by_name: BTreeMap<&str, &Mod> = mods.iter().map(|one| (one.name.as_str(), one)).collect();

    // Виды по разделам.
    let protos = lua.create_table();
    for name in &names {
      let files = &by_name[name.as_str()].files;
      for section in files.sections() {
        let kinds = files.kinds(&section);
        if kinds.is_empty() {
          continue;
        }
        let table = section_table(&lua, &protos, &section).map_err(fail(&section))?;
        for (kind, path) in kinds {
          let value = load_module(&lua, name, &path).map_err(fail(format!("вид {section}/{kind}")))?;
          let Value::Table(proto) = value else {
            return Err(LoadError(format!("@{name}/{path} вернул {}, а нужна таблица вида", value.type_name())));
          };
          proto.raw_set("name", kind.as_str()).map_err(fail(&path))?;
          proto.raw_set("section", section.as_str()).map_err(fail(&path))?;
          proto.raw_set("source", format!("@{name}/{path}")).map_err(fail(&path))?;
          table.raw_set(kind, proto).map_err(fail(&path))?;
        }
      }
    }

    // Правки чужих видов.
    let ordered: Vec<Table> = names.iter().map(|name| manifests[name].clone()).collect();
    for (name, manifest) in names.iter().zip(&ordered) {
      if let Some(patch) = function(manifest, "patch").map_err(fail(format!("@{name}/mod.luau")))? {
        patch.call::<()>(&protos).map_err(fail(format!("@{name}/mod.luau, patch")))?;
      }
    }

    // Номера видов: по разделам и именам.
    let mut list = Vec::new();
    let mut index = BTreeMap::new();
    let mut sections: Vec<(String, Table)> = protos.pairs::<String, Table>().collect::<mlua::Result<_>>().map_err(fail("protos: раздел — таблица видов по именам"))?;
    sections.sort_by(|a, b| a.0.cmp(&b.0));
    for (section, table) in sections {
      let mut kinds: Vec<(String, Table)> = table.pairs::<String, Table>().collect::<mlua::Result<_>>().map_err(fail(format!("protos.{section}: вид — таблица")))?;
      kinds.sort_by(|a, b| a.0.cmp(&b.0));
      for (name, proto) in kinds {
        // Добавленный правкой мог не назвать себя.
        proto.raw_set("name", name.as_str()).map_err(fail(&name))?;
        proto.raw_set("section", section.as_str()).map_err(fail(&name))?;
        let source = proto.raw_get::<Option<String>>("source").ok().flatten().unwrap_or_default();
        let id = list.len() as u32;
        proto.raw_set("id", id).map_err(fail(&name))?;
        index.insert((section.clone(), name.clone()), id);
        list.push(Proto { section: section.clone(), name, id, source });
      }
    }

    let files = names.iter().filter_map(|name| files_of.get(name).cloned()).collect();
    Ok(Self { lua, side, mods: names, manifests: ordered, protos, list, index, files })
  }

  /// Партия по умолчанию: `game` из манифестов, последний по порядку мод главнее.
  pub fn default_game(&self) -> Option<String> {
    self.manifests.iter().rev().find_map(|manifest| manifest.get::<Option<String>>("game").ok().flatten())
  }

  /// Настройки партии из меню (сид, размер карты, местность, погода): ключи ложатся в `data` вида `games/<game>`
  /// поверх его значений. Хост и клиент кладут одно и то же, поэтому и правила, и подача видят одну партию.
  pub fn apply_options(&self, game: &str, options: &serde_json::Value) -> Result<(), String> {
    let serde_json::Value::Object(options) = options else { return Ok(()) };
    if options.is_empty() {
      return Ok(());
    }
    let table = self.get("games", game).ok_or_else(|| format!("нет партии games/{game}"))?;
    let data = match table.get::<Option<Table>>("data").map_err(|error| error.to_string())? {
      Some(data) => data,
      None => {
        let data = self.lua.create_table();
        table.set("data", &data).map_err(|error| error.to_string())?;
        data
      }
    };
    for (key, value) in options {
      data.set(key.as_str(), crate::vm::to_lua(&self.lua, value).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    }
    Ok(())
  }

  /// Картинка из модов по пути от корня мода (`images/logo.png`); последний по порядку мод главнее.
  pub fn asset(&self, path: &str) -> Option<&[u8]> {
    self.files.iter().rev().find_map(|files| files.assets.get(path).map(Vec::as_slice))
  }

  /// Номер вида по разделу и имени.
  pub fn id(&self, section: &str, name: &str) -> Option<u32> {
    self.index.get(&(section.to_string(), name.to_string())).copied()
  }

  /// Таблица вида.
  pub fn get(&self, section: &str, name: &str) -> Option<Table> {
    self.protos.get::<Option<Table>>(section).ok().flatten()?.get::<Option<Table>>(name).ok().flatten()
  }

  /// Таблица вида по номеру.
  pub fn by_id(&self, id: u32) -> Option<Table> {
    let proto = self.list.get(id as usize)?;
    self.get(&proto.section, &proto.name)
  }

  /// Виды раздела по именам.
  pub fn section<'a>(&'a self, section: &'a str) -> impl Iterator<Item = &'a Proto> {
    self.list.iter().filter(move |proto| proto.section == section)
  }

  /// Сумма данных всех видов — всего, кроме функций: совпала у хоста и клиента — правки дали одно и то же.
  pub fn checksum(&self) -> u64 {
    let mut hash = Fnv::default();
    for proto in &self.list {
      hash.write(proto.section.as_bytes());
      hash.write(proto.name.as_bytes());
      if let Some(table) = self.by_id(proto.id) {
        canonical(&Value::Table(table), &mut hash, &mut HashSet::new());
      }
    }
    hash.0
  }
}

fn section_table(lua: &Lua, protos: &Table, section: &str) -> mlua::Result<Table> {
  if let Some(table) = protos.raw_get::<Option<Table>>(section)? {
    return Ok(table);
  }
  let table = lua.create_table();
  protos.raw_set(section, &table)?;
  Ok(table)
}

/// Значение в сумму: ключи по порядку, функции пропускаются, таблица, уже встреченная на пути, — меткой.
fn canonical(value: &Value, hash: &mut Fnv, path: &mut HashSet<usize>) {
  match value {
    Value::Nil => hash.write(b"n"),
    Value::Boolean(flag) => hash.write(if *flag { b"t" } else { b"f" }),
    Value::Integer(number) => {
      hash.write(b"#");
      hash.write(&(*number as f64).to_le_bytes());
    }
    Value::Number(number) => {
      hash.write(b"#");
      hash.write(&number.to_le_bytes());
    }
    Value::String(text) => {
      hash.write(b"s");
      hash.write(&text.as_bytes());
    }
    Value::Table(table) => {
      let pointer = table.to_pointer() as usize;
      if !path.insert(pointer) {
        hash.write(b"@");
        return;
      }
      let mut pairs: Vec<(String, Value)> = table.pairs::<Value, Value>().filter_map(Result::ok).filter(|(_, value)| !matches!(value, Value::Function(_))).map(|(key, value)| (key_text(&key), value)).collect();
      pairs.sort_by(|a, b| a.0.cmp(&b.0));
      hash.write(b"{");
      for (key, value) in pairs {
        hash.write(key.as_bytes());
        hash.write(b"=");
        canonical(&value, hash, path);
      }
      hash.write(b"}");
      path.remove(&pointer);
    }
    other => hash.write(other.type_name().as_bytes()),
  }
}

fn key_text(key: &Value) -> String {
  match key {
    Value::String(text) => format!("s{}", text.to_string_lossy()),
    Value::Integer(number) => format!("#{number:020}"),
    Value::Number(number) => format!("#{number}"),
    other => other.type_name().to_string(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::files::Files;
  use std::rc::Rc;

  fn make(name: &str, files: &[(&str, &str)]) -> Mod {
    let mut all = Files::default();
    for (path, text) in files {
      all.files.insert(path.to_string(), text.to_string());
    }
    Mod { name: name.into(), files: Rc::new(all), dir: None }
  }

  #[test]
  fn later_mods_replace_and_patch_others() {
    let base = make("base", &[("mod.luau", "return { name = 'base' }"), ("units/buggy.luau", "return { data = { speed = 4 } }"), ("units/tank/init.luau", "local look = require('./look') return { data = { speed = 2 }, look = look }"), ("units/tank/look.luau", "return { frame = 32 }"), ("moves/wheels.luau", "return { data = { grip = 1 } }")]);
    let extra = make("extra", &[("mod.luau", "return { requires = { 'base' }, patch = function(protos) protos.units.buggy.data.speed = 6 protos.units.hover = { data = { speed = 9 } } protos.moves.wheels = nil end }"), ("units/tank.luau", "return { data = { speed = 3 } }")]);
    // Порядок в списке не важен: extra зависит от base.
    let content = Content::load(Side::Host, vec![extra, base]).unwrap();
    assert_eq!(content.mods, ["base", "extra"]);
    let names: Vec<_> = content.list.iter().map(|proto| format!("{}/{} {}", proto.section, proto.name, proto.id)).collect();
    assert_eq!(names, ["units/buggy 0", "units/hover 1", "units/tank 2"]);
    let speed = |name: &str| content.get("units", name).unwrap().get::<Table>("data").unwrap().get::<f64>("speed").unwrap();
    assert_eq!((speed("buggy"), speed("tank"), speed("hover")), (6.0, 3.0, 9.0));
    assert_eq!(content.get("units", "tank").unwrap().get::<String>("source").unwrap(), "@extra/units/tank.luau");
    assert_eq!(content.get("units", "hover").unwrap().get::<String>("name").unwrap(), "hover");
  }

  #[test]
  fn checksum_sees_data_not_functions() {
    let load = |speed: &str, draw: &str| {
      let base = make("base", &[("mod.luau", "return {}"), ("units/buggy.luau", &format!("return {{ data = {{ speed = {speed} }}, draw = function() return {draw} end }}"))]);
      Content::load(Side::Client, vec![base]).unwrap().checksum()
    };
    assert_eq!(load("4", "1"), load("4", "2"));
    assert_ne!(load("4", "1"), load("5", "1"));
  }

  #[test]
  fn errors_name_the_file() {
    let base = make("base", &[("mod.luau", "return {}"), ("units/bad.luau", "return {")]);
    let error = Content::load(Side::Host, vec![base]).err().unwrap().to_string();
    assert!(error.contains("units/bad"), "{error}");
  }
}
