//! `serde::Serialize` implementations for [`Value`] and [`Table`], plus the
//! [`SerializableValue`] / [`SerializableTable`] wrappers that let callers tune
//! serialization options (`sort_keys`, `deny_recursive_tables`, ...).
//!
//! Mirrors the `#[cfg(feature = "serde")]` blocks in mlua's `value.rs`/
//! `table.rs`. Kept in the serde module so the base `value.rs`/`table.rs` are
//! unchanged.

use std::result::Result as StdResult;

use serde::ser::{self, Error as SerError, Serialize, SerializeMap, SerializeSeq, Serializer};

use super::{
  Visited,
  de::{MapPairs, Options, RecursionGuard, check_value_for_skip, encode_as_array},
};
use crate::{Vector, table::Table, value::Value};

/// A wrapped [`Value`] with customized serialization behavior. Mirrors
/// `mlua::SerializableValue`.
pub struct SerializableValue<'a> {
  value: &'a Value,
  options: Options,
  // Only needed for tables; left `None` otherwise to avoid an allocation.
  visited: Option<Visited>,
}

impl Value {
  /// Wraps a reference to this [`Value`] into a [`SerializableValue`], allowing
  /// serialization behavior to be customized via serde. Mirrors
  /// `mlua::Value::to_serializable`.
  pub fn to_serializable(&self) -> SerializableValue<'_> {
    SerializableValue::new(self, Options::default(), None)
  }
}

impl Serialize for Value {
  #[inline]
  fn serialize<S: Serializer>(&self, serializer: S) -> StdResult<S::Ok, S::Error> {
    SerializableValue::new(self, Options::default(), None).serialize(serializer)
  }
}

impl<'a> SerializableValue<'a> {
  #[inline]
  pub(crate) fn new(value: &'a Value, options: Options, visited: Option<&Visited>) -> Self {
    if let Value::Table(_) = value {
      return Self {
        value,
        options,
        visited: visited.cloned().or_else(|| Some(Default::default())),
      };
    }
    Self {
      value,
      options,
      visited: None,
    }
  }

  /// See [`DeserializeOptions::deny_unsupported_types`](super::DeserializeOptions).
  #[must_use]
  pub fn deny_unsupported_types(mut self, enabled: bool) -> Self {
    self.options.deny_unsupported_types = enabled;
    self
  }

  /// See [`DeserializeOptions::deny_recursive_tables`](super::DeserializeOptions).
  #[must_use]
  pub fn deny_recursive_tables(mut self, enabled: bool) -> Self {
    self.options.deny_recursive_tables = enabled;
    self
  }

  /// See [`DeserializeOptions::sort_keys`](super::DeserializeOptions).
  #[must_use]
  pub fn sort_keys(mut self, enabled: bool) -> Self {
    self.options.sort_keys = enabled;
    self
  }

  /// See [`DeserializeOptions::encode_empty_tables_as_array`](super::DeserializeOptions).
  #[must_use]
  pub fn encode_empty_tables_as_array(mut self, enabled: bool) -> Self {
    self.options.encode_empty_tables_as_array = enabled;
    self
  }

  /// See [`DeserializeOptions::detect_mixed_tables`](super::DeserializeOptions).
  #[must_use]
  pub fn detect_mixed_tables(mut self, enabled: bool) -> Self {
    self.options.detect_mixed_tables = enabled;
    self
  }
}

impl Serialize for SerializableValue<'_> {
  fn serialize<S>(&self, serializer: S) -> StdResult<S::Ok, S::Error>
  where
    S: Serializer,
  {
    // The `null` sentinel serializes as `none`.
    if super::is_null(self.value) {
      return serializer.serialize_none();
    }
    match self.value {
      Value::Nil => serializer.serialize_unit(),
      Value::Boolean(b) => serializer.serialize_bool(*b),
      Value::Integer(i) => serializer.serialize_i64(*i),
      Value::Number(n) => serializer.serialize_f64(*n),
      Value::Vector(v) => {
        use ser::SerializeTupleStruct;
        let mut ts = serializer.serialize_tuple_struct("Vector", Vector::SIZE)?;
        ts.serialize_field(&v.x())?;
        ts.serialize_field(&v.y())?;
        ts.serialize_field(&v.z())?;
        ts.end()
      }
      Value::String(s) => serialize_lua_string(s, serializer),
      Value::Table(t) => {
        // 构造期不变式：SerializableValue::new 对 Table 值恒置 visited=Some
        // （缺省则现造），走到本分支 visited 必为 Some，unwrap 不可达。
        let visited = self.visited.as_ref().unwrap().clone();
        SerializableTable::new(t, self.options, visited).serialize(serializer)
      }
      Value::Buffer(buf) => {
        // 先拷贝：`as_slice()` 借出的是 VM 内存，Serializer 是外部代码，可能在
        // 调用期间写同一个 buffer。
        let data = buf.to_vec();
        serializer.serialize_bytes(&data)
      }
      Value::Function(_)
      | Value::Thread(_)
      | Value::LightUserData(_)
      | Value::UserData(_)
      | Value::Error(_) => {
        if self.options.deny_unsupported_types {
          let msg = format!("cannot serialize <{}>", self.value.type_name());
          Err(ser::Error::custom(msg))
        } else {
          serializer.serialize_unit()
        }
      }
    }
  }
}

fn serialize_lua_string<S>(s: &crate::LuaString, serializer: S) -> StdResult<S::Ok, S::Error>
where
  S: Serializer,
{
  match s.to_str() {
    Ok(s) => serializer.serialize_str(&s),
    Err(_) => serializer.serialize_bytes(s.as_bytes()),
  }
}

/// A wrapped [`Table`] with customized serialization behavior. Mirrors mlua's
/// `SerializableTable`.
pub struct SerializableTable<'a> {
  table: &'a Table,
  options: Options,
  visited: Visited,
}

impl Serialize for Table {
  #[inline]
  fn serialize<S: Serializer>(&self, serializer: S) -> StdResult<S::Ok, S::Error> {
    SerializableTable::new(self, Options::default(), Default::default()).serialize(serializer)
  }
}

impl<'a> SerializableTable<'a> {
  #[inline]
  pub(crate) fn new(table: &'a Table, options: Options, visited: Visited) -> Self {
    Self {
      table,
      options,
      visited,
    }
  }
}

impl Serialize for SerializableTable<'_> {
  fn serialize<S>(&self, serializer: S) -> StdResult<S::Ok, S::Error>
  where
    S: Serializer,
  {
    let options = self.options;
    let visited = &self.visited;
    let _guard = RecursionGuard::new(self.table, visited);

    // Array
    if let Some(len) = encode_as_array(self.table, self.options) {
      let mut seq = serializer.serialize_seq(Some(len))?;
      for idx in 1..=len {
        let value: Value = self.table.raw_get(idx as i64).map_err(SerError::custom)?;
        let skip = check_value_for_skip(&value, options, visited).map_err(SerError::custom)?;
        if !skip {
          seq.serialize_element(&SerializableValue::new(&value, options, Some(visited)))?;
        }
      }
      return seq.end();
    }

    // Map
    let mut map = serializer.serialize_map(None)?;
    let pairs = MapPairs::new(self.table, options.sort_keys).map_err(SerError::custom)?;
    for kv in pairs {
      let (key, value) = kv.map_err(SerError::custom)?;
      let skip_key = check_value_for_skip(&key, options, visited).map_err(SerError::custom)?;
      let skip_value = check_value_for_skip(&value, options, visited).map_err(SerError::custom)?;
      if skip_key || skip_value {
        continue;
      }
      map.serialize_entry(
        &SerializableValue::new(&key, options, Some(visited)),
        &SerializableValue::new(&value, options, Some(visited)),
      )?;
    }
    map.end()
  }
}
