//! The conversion traits. Mirror `mlua::{IntoLua, FromLua, IntoLuaMulti,
//! FromLuaMulti}`.
//!
//! These are simplified relative to mlua: mlua's traits carry extra
//! stack-oriented methods (`push_into_stack`, `from_stack`, ...) for its FFI
//! fast paths. Since ulua is a pure-Rust engine we route everything through
//! the safe [`Value`] / [`MultiValue`] representation, so our traits only need
//! the value-level methods. The public method *names and shapes*
//! (`into_lua(self, &Lua)`, `from_lua(value, &Lua)`,
//! `into_lua_multi`, `from_lua_multi`) match mlua exactly.

use crate::{error::Result, multi::MultiValue, state::Lua, value::Value};

/// Convert a Rust value into a single Lua [`Value`].
///
/// Mirrors `mlua::IntoLua`.
pub trait IntoLua: Sized {
  /// Perform the conversion.
  fn into_lua(self, lua: &Lua) -> Result<Value>;
}

/// Convert a single Lua [`Value`] into a Rust value.
///
/// Mirrors `mlua::FromLua`.
pub trait FromLua: Sized {
  /// Perform the conversion.
  fn from_lua(value: Value, lua: &Lua) -> Result<Self>;
}

/// Convert a Rust value into a sequence of Lua values (multiple returns / args).
///
/// Mirrors `mlua::IntoLuaMulti`.
pub trait IntoLuaMulti: Sized {
  /// Perform the conversion.
  fn into_lua_multi(self, lua: &Lua) -> Result<MultiValue>;
}

/// Convert a sequence of Lua values into a Rust value.
///
/// Mirrors `mlua::FromLuaMulti`.
pub trait FromLuaMulti: Sized {
  /// Perform the conversion.
  fn from_lua_multi(values: MultiValue, lua: &Lua) -> Result<Self>;
}

// Any single-value type is trivially a multi-value of length one.
impl<T: IntoLua> IntoLuaMulti for T {
  fn into_lua_multi(self, lua: &Lua) -> Result<MultiValue> {
    let mut m = MultiValue::with_capacity(1);
    m.push_back(self.into_lua(lua)?);
    Ok(m)
  }
}

// And any single-value type can be parsed from the first of a multi-value
// (extra values are ignored, matching Lua's "take what you need" calling
// convention).
impl<T: FromLua> FromLuaMulti for T {
  fn from_lua_multi(mut values: MultiValue, lua: &Lua) -> Result<Self> {
    let v = values.pop_front().unwrap_or(Value::Nil);
    T::from_lua(v, lua)
  }
}
