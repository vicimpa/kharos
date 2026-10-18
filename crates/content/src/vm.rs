//! Машина Luau для модов. Песочница обязательна: без неё `math.*` и `buffer.*` идут обычными вызовами, а не быстрым
//! путём встроенных функций, и системы над столбцами медленнее в 16 раз (docs/content.md, §2).

use crate::files::Files;
use mlua::{Function, Lua, Table, Value};
use std::collections::HashMap;
use std::rc::Rc;

/// Сторона, на которой работает машина. Файлы мода выполняют обе, а API у каждой своё (docs/content.md, §4а).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
  /// Правила: мир, команды, события.
  Host,
  /// Подача: облик, звук, музыка, атмосфера, камера, управление, панели.
  Client,
}

impl Side {
  pub fn name(self) -> &'static str {
    match self {
      Side::Host => "host",
      Side::Client => "client",
    }
  }
}

/// Файлы модов, доступные `require`: имя мода → его файлы.
#[derive(Default)]
pub struct Sources {
  pub mods: HashMap<String, Rc<Files>>,
}

/// Модули, уже выполненные `require`: полный путь → что вернул файл.
#[derive(Default)]
struct Loaded(HashMap<String, mlua::RegistryKey>);

/// Новая машина: оптимизация 2, машинный код для файлов с `--!native`, `require` по модам и песочница. Глобальная
/// `SIDE` — "host" или "client": общий код вида может спросить, где он.
pub fn new_vm(side: Side, sources: Sources) -> mlua::Result<Lua> {
  let lua = Lua::new();
  // Машинного кода нет: JIT ulua 0.1.7 считает неверно (парное присваивание после вызова теряет второе значение),
  // а под wasm его нет и так. Luau толкует байт-код.
  lua.set_compiler(mlua::Compiler::new().set_optimization_level(2).set_type_info_level(1));
  lua.set_app_data(sources);
  lua.set_app_data(Loaded::default());
  let globals = lua.globals();
  globals.set("require", lua.create_function(require)?)?;
  globals.set("SIDE", side.name())?;
  lua.sandbox(true)?;
  Ok(lua)
}

/// Полный путь файла в модах: `@мод/путь`. Так же называются куски Luau: ошибки показывают файл.
pub fn chunk_name(mod_name: &str, path: &str) -> String {
  format!("@{mod_name}/{path}")
}

/// Выполняет файл мода и возвращает, что он вернул.
pub fn run_file(lua: &Lua, mod_name: &str, path: &str) -> mlua::Result<Value> {
  let source = {
    let sources = lua.app_data_ref::<Sources>().expect("Sources");
    let files = sources.mods.get(mod_name).ok_or_else(|| mlua::Error::runtime(format!("нет мода {mod_name}")))?;
    files.get(path).ok_or_else(|| mlua::Error::runtime(format!("нет файла {}", chunk_name(mod_name, path))))?.to_string()
  };
  lua.load(source).set_name(chunk_name(mod_name, path)).eval()
}

/// `require("lib/widgets")` — от корня своего мода, `require("./look")` — от папки файла, `require("@base/lib/widgets")` —
/// из другого мода. Расширение `.luau` и `/init.luau` подставляются. Модуль выполняется один раз.
fn require(lua: &Lua, path: String) -> mlua::Result<Value> {
  let caller = lua.inspect_stack(1).and_then(|debug| debug.source().map(|source| source.trim_start_matches('=').to_string())).unwrap_or_default();
  let (mod_name, file) = resolve(&caller, &path).ok_or_else(|| mlua::Error::runtime(format!("require(\"{path}\"): непонятный путь из {caller}")))?;
  let candidates = [format!("{file}.luau"), format!("{file}/init.luau"), file.clone()];
  let found = {
    let sources = lua.app_data_ref::<Sources>().expect("Sources");
    let files = sources.mods.get(&mod_name).ok_or_else(|| mlua::Error::runtime(format!("require(\"{path}\"): нет мода {mod_name}")))?;
    candidates.into_iter().find(|candidate| files.get(candidate).is_some())
  };
  let found = found.ok_or_else(|| mlua::Error::runtime(format!("require(\"{path}\"): нет файла {} в {caller}", chunk_name(&mod_name, &file))))?;
  load_module(lua, &mod_name, &found)
}

/// Файл мода как модуль: выполняется один раз, дальше — то же значение. Через это идут и `require`, и виды: вид,
/// взятый `require`, — та же таблица, что в `protos`.
pub fn load_module(lua: &Lua, mod_name: &str, path: &str) -> mlua::Result<Value> {
  let key = chunk_name(mod_name, path);
  if let Some(registry) = lua.app_data_ref::<Loaded>().expect("Loaded").0.get(&key) {
    return lua.registry_value(registry);
  }
  let value = run_file(lua, mod_name, path)?;
  let registry = lua.create_registry_value(value.clone())?;
  lua.app_data_mut::<Loaded>().expect("Loaded").0.insert(key, registry);
  Ok(value)
}

/// Мод и путь без расширения для `require(path)` из куска caller (`@мод/папка/файл.luau`).
fn resolve(caller: &str, path: &str) -> Option<(String, String)> {
  if let Some(rest) = path.strip_prefix('@') {
    let (mod_name, file) = rest.split_once('/')?;
    return Some((mod_name.to_string(), normalize(file)?));
  }
  let (mod_name, caller_path) = caller.strip_prefix('@')?.split_once('/')?;
  if path.starts_with("./") || path.starts_with("../") {
    let dir = caller_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    return Some((mod_name.to_string(), normalize(&format!("{dir}/{path}"))?));
  }
  Some((mod_name.to_string(), normalize(path)?))
}

/// Убирает `.` и `..`; выход за корень мода — None.
fn normalize(path: &str) -> Option<String> {
  let mut parts: Vec<&str> = Vec::new();
  for part in path.split('/') {
    match part {
      "" | "." => {}
      ".." => {
        parts.pop()?;
      }
      part => parts.push(part),
    }
  }
  let joined = parts.join("/");
  Some(joined.strip_suffix(".luau").map(str::to_string).unwrap_or(joined))
}

/// JSON в значение Luau: `null` — nil (по умолчанию mlua даёт вместо него особое значение, и `if x then` его пропускает).
pub fn to_lua<T: serde::Serialize + ?Sized>(lua: &Lua, value: &T) -> mlua::Result<Value> {
  use mlua::LuaSerdeExt;
  lua.to_value_with(value, mlua::SerializeOptions::new().serialize_none_to_null(false).serialize_unit_to_null(false))
}

/// Функция из таблицы, если она там есть.
pub fn function(table: &Table, key: &str) -> mlua::Result<Option<Function>> {
  match table.get::<Value>(key)? {
    Value::Function(function) => Ok(Some(function)),
    Value::Nil => Ok(None),
    other => Err(mlua::Error::runtime(format!("{key} — {}, а нужна функция", other.type_name()))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn paths_resolve_from_mod_root_folder_and_other_mods() {
    assert_eq!(resolve("@base/units/tank/init.luau", "./look"), Some(("base".into(), "units/tank/look".into())));
    assert_eq!(resolve("@base/units/tank/init.luau", "../../lib/geom"), Some(("base".into(), "lib/geom".into())));
    assert_eq!(resolve("@base/units/buggy.luau", "lib/geom"), Some(("base".into(), "lib/geom".into())));
    assert_eq!(resolve("@extra/units/a.luau", "@base/lib/geom.luau"), Some(("base".into(), "lib/geom".into())));
    assert_eq!(resolve("@base/units/a.luau", "../../../x"), None);
  }

  #[test]
  fn require_runs_module_once_and_globals_stay_read_only() {
    let mut files = Files::default();
    files.files.insert("lib/counter.luau".into(), "local n = { value = 0 } n.value += 1 return n".into());
    files.files.insert("units/a.luau".into(), "local c = require('lib/counter') local d = require('../lib/counter') return c.value + d.value".into());
    let mut sources = Sources::default();
    sources.mods.insert("base".into(), Rc::new(files));
    let lua = new_vm(Side::Host, sources).unwrap();
    assert_eq!(run_file(&lua, "base", "units/a.luau").unwrap().as_i32(), Some(2));
    // Встроенные таблицы менять нельзя: иначе пропал бы быстрый путь встроенных функций.
    assert!(lua.load("math.floor = nil").exec().is_err());
    assert_eq!(lua.load("return SIDE").eval::<String>().unwrap(), "host");
  }
}
