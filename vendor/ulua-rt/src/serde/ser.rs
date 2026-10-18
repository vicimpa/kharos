//! Serialize a Rust data structure into a Lua [`Value`].
//!
//! Mirrors `mlua::serde::ser`, written directly over ulua-rt's `Value`/`Table`.

use serde::{Serialize, ser};

use super::LuaSerdeExt;
use crate::{
  Vector,
  error::{Error, Result},
  state::Lua,
  table::Table,
  value::Value,
};

/// A struct for serializing Rust values into Lua values.
pub struct Serializer<'a> {
  lua: &'a Lua,
  options: Options,
}

/// Options controlling [`Serializer`] behavior. Mirrors
/// `mlua::serde::ser::Options`.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Options {
  /// If true, sequence serialization to a Lua table attaches the
  /// [`array_metatable`](crate::LuaSerdeExt::array_metatable). Default: true.
  pub set_array_metatable: bool,

  /// If true, serialize `None` to [`null`](crate::LuaSerdeExt::null);
  /// otherwise to [`Value::Nil`]. Default: true.
  pub serialize_none_to_null: bool,

  /// If true, serialize `()` / unit structs to [`null`](crate::LuaSerdeExt::null);
  /// otherwise to [`Value::Nil`]. Default: true.
  pub serialize_unit_to_null: bool,
}

impl Default for Options {
  fn default() -> Self {
    const { Self::new() }
  }
}

impl Options {
  /// A new [`Options`] with default parameters.
  pub const fn new() -> Self {
    Options {
      set_array_metatable: true,
      serialize_none_to_null: true,
      serialize_unit_to_null: true,
    }
  }

  /// Sets `set_array_metatable`.
  #[must_use]
  pub const fn set_array_metatable(mut self, enabled: bool) -> Self {
    self.set_array_metatable = enabled;
    self
  }

  /// Sets `serialize_none_to_null`.
  #[must_use]
  pub const fn serialize_none_to_null(mut self, enabled: bool) -> Self {
    self.serialize_none_to_null = enabled;
    self
  }

  /// Sets `serialize_unit_to_null`.
  #[must_use]
  pub const fn serialize_unit_to_null(mut self, enabled: bool) -> Self {
    self.serialize_unit_to_null = enabled;
    self
  }
}

impl<'a> Serializer<'a> {
  /// Creates a new Lua serializer with default options.
  pub fn new(lua: &'a Lua) -> Self {
    Self::new_with_options(lua, Options::default())
  }

  /// Creates a new Lua serializer with custom options.
  pub fn new_with_options(lua: &'a Lua, options: Options) -> Self {
    Serializer { lua, options }
  }

  /// `to_null` 选项族共用决策：置位则返回本 state 的 null 哨兵，否则 `Value::Nil`。
  fn null_or_nil(&self, to_null: bool) -> Value {
    if to_null { self.lua.null() } else { Value::Nil }
  }
}

macro_rules! lua_serialize_int {
  ($name:ident, $t:ty) => {
    #[inline]
    fn $name(self, value: $t) -> Result<Value> {
      Ok(Value::Integer(value as i64))
    }
  };
}

impl<'a> ser::Serializer for Serializer<'a> {
  type Ok = Value;
  type Error = Error;

  type SerializeSeq = SerializeSeq<'a>;
  type SerializeTuple = SerializeSeq<'a>;
  type SerializeTupleStruct = SerializeSeq<'a>;
  type SerializeTupleVariant = SerializeTupleVariant<'a>;
  type SerializeMap = SerializeMap<'a>;
  type SerializeStruct = SerializeStruct<'a>;
  type SerializeStructVariant = SerializeStructVariant<'a>;

  #[inline]
  fn serialize_bool(self, value: bool) -> Result<Value> {
    Ok(Value::Boolean(value))
  }

  lua_serialize_int!(serialize_i8, i8);
  lua_serialize_int!(serialize_u8, u8);
  lua_serialize_int!(serialize_i16, i16);
  lua_serialize_int!(serialize_u16, u16);
  lua_serialize_int!(serialize_i32, i32);
  lua_serialize_int!(serialize_u32, u32);
  lua_serialize_int!(serialize_i64, i64);

  #[inline]
  fn serialize_u64(self, value: u64) -> Result<Value> {
    if let Ok(i) = i64::try_from(value) {
      Ok(Value::Integer(i))
    } else {
      Ok(Value::Number(value as f64))
    }
  }

  #[inline]
  fn serialize_i128(self, value: i128) -> Result<Value> {
    // Luau numbers are `f64`; fall back to a float, matching mlua's
    // `into_lua` path for wide integers.
    Ok(Value::Number(value as f64))
  }

  #[inline]
  fn serialize_u128(self, value: u128) -> Result<Value> {
    Ok(Value::Number(value as f64))
  }

  #[inline]
  fn serialize_f32(self, value: f32) -> Result<Value> {
    Ok(Value::Number(value as f64))
  }

  #[inline]
  fn serialize_f64(self, value: f64) -> Result<Value> {
    Ok(Value::Number(value))
  }

  #[inline]
  fn serialize_char(self, value: char) -> Result<Value> {
    let mut buf = [0u8; 4];
    self.serialize_str(value.encode_utf8(&mut buf))
  }

  #[inline]
  fn serialize_str(self, value: &str) -> Result<Value> {
    Ok(Value::String(self.lua.create_string(value)))
  }

  #[inline]
  fn serialize_bytes(self, value: &[u8]) -> Result<Value> {
    Ok(Value::String(self.lua.create_string(value)))
  }

  #[inline]
  fn serialize_none(self) -> Result<Value> {
    Ok(self.null_or_nil(self.options.serialize_none_to_null))
  }

  #[inline]
  fn serialize_some<T>(self, value: &T) -> Result<Value>
  where
    T: Serialize + ?Sized,
  {
    value.serialize(self)
  }

  #[inline]
  fn serialize_unit(self) -> Result<Value> {
    Ok(self.null_or_nil(self.options.serialize_unit_to_null))
  }

  #[inline]
  fn serialize_unit_struct(self, _name: &'static str) -> Result<Value> {
    Ok(self.null_or_nil(self.options.serialize_unit_to_null))
  }

  #[inline]
  fn serialize_unit_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
  ) -> Result<Value> {
    self.serialize_str(variant)
  }

  #[inline]
  fn serialize_newtype_struct<T>(self, _name: &'static str, value: &T) -> Result<Value>
  where
    T: Serialize + ?Sized,
  {
    value.serialize(self)
  }

  #[inline]
  fn serialize_newtype_variant<T>(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    value: &T,
  ) -> Result<Value>
  where
    T: Serialize + ?Sized,
  {
    let table = self.lua.create_table();
    let value = self.lua.to_value_with(value, self.options)?;
    table.raw_set(variant, value)?;
    Ok(Value::Table(table))
  }

  #[inline]
  fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq> {
    let table = self.lua.create_table_with_capacity(len.unwrap_or(0), 0);
    if self.options.set_array_metatable {
      table.set_metatable(Some(self.lua.array_metatable()))?;
    }
    Ok(SerializeSeq::new(self.lua, table, self.options))
  }

  #[inline]
  fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple> {
    self.serialize_seq(Some(len))
  }

  #[inline]
  fn serialize_tuple_struct(
    self,
    name: &'static str,
    len: usize,
  ) -> Result<Self::SerializeTupleStruct> {
    // Luau `Vector` (3 components) round-trips as a native vector value.
    if name == "Vector" && len == Vector::SIZE {
      return Ok(SerializeSeq::new_vector(self.lua, self.options));
    }
    self.serialize_seq(Some(len))
  }

  #[inline]
  fn serialize_tuple_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    len: usize,
  ) -> Result<Self::SerializeTupleVariant> {
    Ok(SerializeTupleVariant {
      lua: self.lua,
      variant,
      table: self.lua.create_table_with_capacity(len, 0),
      options: self.options,
    })
  }

  #[inline]
  fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap> {
    Ok(SerializeMap {
      lua: self.lua,
      key: None,
      table: self.lua.create_table_with_capacity(0, len.unwrap_or(0)),
      options: self.options,
    })
  }

  #[inline]
  fn serialize_struct(self, _name: &'static str, len: usize) -> Result<Self::SerializeStruct> {
    Ok(SerializeStruct {
      lua: self.lua,
      table: self.lua.create_table_with_capacity(0, len),
      options: self.options,
    })
  }

  #[inline]
  fn serialize_struct_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    len: usize,
  ) -> Result<Self::SerializeStructVariant> {
    Ok(SerializeStructVariant {
      lua: self.lua,
      variant,
      table: self.lua.create_table_with_capacity(0, len),
      options: self.options,
    })
  }
}

#[doc(hidden)]
pub struct SerializeSeq<'a> {
  lua: &'a Lua,
  vector: Option<crate::Vector>,
  table: Option<Table>,
  next: usize,
  options: Options,
}

impl<'a> SerializeSeq<'a> {
  fn new(lua: &'a Lua, table: Table, options: Options) -> Self {
    Self {
      lua,
      vector: None,
      table: Some(table),
      next: 0,
      options,
    }
  }

  fn new_vector(lua: &'a Lua, options: Options) -> Self {
    Self {
      lua,
      vector: Some(Vector::zero()),
      table: None,
      next: 0,
      options,
    }
  }
}

impl ser::SerializeSeq for SerializeSeq<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_element<T>(&mut self, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    let value = self.lua.to_value_with(value, self.options)?;
    // 构造期不变式：本路径仅表模式可达（new 恒置 table=Some）；向量模式
    // （new_vector，table=None）只被 SerializeTupleStruct 使用，其 serialize_field
    // 先判 vector.as_mut() 命中即短路，不会落到这里——unwrap 不可达。
    let table = self.table.as_ref().unwrap();
    table.raw_set((self.next + 1) as i64, value)?;
    self.next += 1;
    Ok(())
  }

  fn end(self) -> Result<Value> {
    // 同上：end 经 SerializeSeq/SerializeTuple 契约只在表模式调用，table 恒 Some。
    Ok(Value::Table(self.table.unwrap()))
  }
}

impl ser::SerializeTuple for SerializeSeq<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_element<T>(&mut self, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    ser::SerializeSeq::serialize_element(self, value)
  }

  fn end(self) -> Result<Value> {
    ser::SerializeSeq::end(self)
  }
}

// §8：本通道（"Vector" 名 + tuple struct）的超发/欠发契约只经公开面
// `LuaSerdeExt::to_value` 即可驱动，其测试已迁 `tests/serde_vector_channel.rs`。
impl ser::SerializeTupleStruct for SerializeSeq<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    // Safety: `vector` 可变借用仅触及 self.vector 字段，后续对 self.lua/
    // self.options 的读写为不相交字段借用，借用检查器放行。
    if let Some(vector) = self.vector.as_mut() {
      // 超发裁定（旧账"ser.rs:412 Vector 超发越界待裁"）：旧实现在
      // next>=SIZE 时裸数组索引越界 panic——内存安全但违反 serde 契约
      // （违约须以 ser::Error 报 Err，而非裸 panic），改为显式序列化错误。
      if self.next >= Vector::SIZE {
        return Err(Error::SerializeError(format!(
          "Vector 序列化超发：最多 {} 个分量，收到第 {} 个",
          Vector::SIZE,
          self.next + 1
        )));
      }
      let value = self.lua.to_value_with(value, self.options)?;
      let comp = value
        .as_f32()
        .ok_or_else(|| Error::SerializeError("vector component is not a number".to_string()))?;
      vector.0[self.next] = comp;
      self.next += 1;
      return Ok(());
    }
    ser::SerializeSeq::serialize_element(self, value)
  }

  fn end(self) -> Result<Value> {
    if let Some(vector) = self.vector {
      // 欠发裁定：分量不足 SIZE 即 end 同样违约，旧实现静默零填充会捏造
      // 分量数据，改为显式 Err 以钉死 Vector 往返语义。
      if self.next < Vector::SIZE {
        return Err(Error::SerializeError(format!(
          "Vector 序列化欠发：仅提供 {}/{} 个分量",
          self.next,
          Vector::SIZE
        )));
      }
      return Ok(Value::Vector(vector));
    }
    ser::SerializeSeq::end(self)
  }
}

#[doc(hidden)]
pub struct SerializeTupleVariant<'a> {
  lua: &'a Lua,
  variant: &'static str,
  table: Table,
  options: Options,
}

impl ser::SerializeTupleVariant for SerializeTupleVariant<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    self
      .table
      .raw_push(self.lua.to_value_with(value, self.options)?)
  }

  fn end(self) -> Result<Value> {
    let table = self.lua.create_table();
    table.raw_set(self.variant, self.table)?;
    Ok(Value::Table(table))
  }
}

#[doc(hidden)]
pub struct SerializeMap<'a> {
  lua: &'a Lua,
  table: Table,
  key: Option<Value>,
  options: Options,
}

impl ser::SerializeMap for SerializeMap<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_key<T>(&mut self, key: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    self.key = Some(self.lua.to_value_with(key, self.options)?);
    Ok(())
  }

  fn serialize_value<T>(&mut self, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    // serde 契约：SerializeMap 要求 serialize_key 先于 serialize_value；
    // 违例只可能是外部 Serializer 的 bug，expect 带上下文属 (b) 类纵深防御。
    let key = self
      .key
      .take()
      .expect("serialize_value called before serialize_key");
    let value = self.lua.to_value_with(value, self.options)?;
    self.table.raw_set(key, value)
  }

  fn end(self) -> Result<Value> {
    Ok(Value::Table(self.table))
  }
}

#[doc(hidden)]
pub struct SerializeStruct<'a> {
  lua: &'a Lua,
  table: Table,
  options: Options,
}

impl ser::SerializeStruct for SerializeStruct<'_> {
  type Ok = Value;
  type Error = Error;

  #[inline]
  fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    self
      .table
      .raw_set(key, self.lua.to_value_with(value, self.options)?)
  }

  #[inline]
  fn end(self) -> Result<Value> {
    Ok(Value::Table(self.table))
  }
}

#[doc(hidden)]
pub struct SerializeStructVariant<'a> {
  lua: &'a Lua,
  variant: &'static str,
  table: Table,
  options: Options,
}

impl ser::SerializeStructVariant for SerializeStructVariant<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> Result<()>
  where
    T: Serialize + ?Sized,
  {
    self
      .table
      .raw_set(key, self.lua.to_value_with(value, self.options)?)?;
    Ok(())
  }

  fn end(self) -> Result<Value> {
    let table = self.lua.create_table();
    table.raw_set(self.variant, self.table)?;
    Ok(Value::Table(table))
  }
}
