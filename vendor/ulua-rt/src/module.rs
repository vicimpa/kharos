//! Module registration: [`Lua::register_module`] / [`Lua::unload_module`] and a
//! minimal `require` builtin that resolves registered `@`-prefixed aliases.
//!
//! ## Why ulua-rt ships its own `require`
//!
//! Luau's full `require` (path resolution, file system navigation) lives in a
//! separate `ulua-require` crate and is **not** registered by
//! `luaL_openlibs` — ulua's base library has no `require` global at all (the
//! same reason `loadstring`/`collectgarbage` are absent). mlua's
//! `register_module` populates the require *cache* with a named module so that
//! `require("@alias")` returns it.
//!
//! To make the registered-alias half of that surface work (which is all mlua's
//! `test_register_module` exercises), ulua-rt keeps its own cache table in the
//! registry and installs a small Rust `require` function that, given an
//! `@`-prefixed alias, returns the cached module (and errors otherwise). This is
//! an original implementation over ulua's C API — it does **not** attempt the
//! filesystem path resolution of the upstream `require`.

use crate::{
  error::{Error, Result},
  state::Lua,
  table::Table,
  traits::IntoLua,
  value::Value,
};

/// The registry key under which the alias -> module cache table is stored.
const MODULE_CACHE_KEY: &str = "__ulua_rt_modules";

impl Lua {
  /// Fetch (creating if absent) the registry-stored module cache table, and
  /// ensure a `require` global is installed that consults it.
  fn module_cache(&self) -> Result<Table> {
    // Look up the cache table in the named registry; create it on first use.
    if let Ok(t) = self.named_registry_value::<Table>(MODULE_CACHE_KEY) {
      self.ensure_require_installed(&t)?;
      return Ok(t);
    }
    let t = self.create_table();
    self.set_named_registry_value(MODULE_CACHE_KEY, &t)?;
    self.ensure_require_installed(&t)?;
    Ok(t)
  }

  /// Install the `require` global if it is not already present.
  fn ensure_require_installed(&self, cache: &Table) -> Result<()> {
    let globals = self.globals();
    if globals.contains_key("require")? {
      return Ok(());
    }
    let cache = cache.clone();
    let require = self.create_function(move |_lua, name: String| {
      // Try the exact alias first, then a case-insensitive fallback.
      let exact = cache.get::<Value>(name.as_str())?;
      let resolved = match exact {
        Value::Nil => cache.get::<Value>(name.to_ascii_lowercase())?,
        v => v,
      };
      match resolved {
        Value::Nil => Err(Error::runtime(format!(
          "module '{name}' not found: module was not registered"
        ))),
        v => Ok(v),
      }
    })?;
    globals.set("require", require)?;
    Ok(())
  }

  /// Register `module` under the alias `name` so `require(name)` returns it.
  /// Mirrors `mlua::Lua::register_module`.
  ///
  /// As in Luau, a registered module alias must begin with `'@'`; a name
  /// without the prefix is rejected with a runtime error. Lookups are
  /// case-insensitive on the alias (matching Luau's registered-alias rules).
  pub fn register_module(&self, name: &str, module: impl IntoLua) -> Result<()> {
    if !name.starts_with('@') {
      return Err(Error::runtime("module name must begin with '@'"));
    }
    let value = module.into_lua(self)?;
    let cache = self.module_cache()?;
    // Store under both the exact alias and a lower-cased form so a
    // case-insensitive `require` resolves either.
    cache.set(name, value.clone())?;
    cache.set(name.to_ascii_lowercase(), value)?;
    Ok(())
  }

  /// Remove a previously registered module alias. Mirrors
  /// `mlua::Lua::unload_module`.
  pub fn unload_module(&self, name: &str) -> Result<()> {
    let cache = self.module_cache()?;
    cache.set(name, Value::Nil)?;
    cache.set(name.to_ascii_lowercase(), Value::Nil)?;
    Ok(())
  }
}
