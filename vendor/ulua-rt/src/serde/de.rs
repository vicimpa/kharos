//! Deserialize a Lua [`Value`] into a Rust data structure.
//!
//! Mirrors `mlua::serde::de`, written directly over ulua-rt's `Value`/`Table`.

use std::{cmp::Ordering, ffi::c_void, rc::Rc, result::Result as StdResult};

use serde::{
  Deserializer as SerdeDeserializer,
  de::{self, IntoDeserializer},
};

use super::{Visited, VisitedSet};
use crate::{
  Vector,
  error::{Error, Result},
  table::{Table, TablePairs},
  value::Value,
};

/// A struct for deserializing Lua values into Rust values.
pub struct Deserializer {
  value: Value,
  options: Options,
  visited: Visited,
  len: Option<usize>, // length hint for sequences
}

/// Options controlling [`Deserializer`] behavior. Mirrors
/// `mlua::serde::de::Options`.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Options {
  /// If true, an attempt to deserialize unsupported types ([`Function`],
  /// [`Thread`], [`Error`], ...) is an error; otherwise they are skipped when
  /// iterating or deserialized as the unit type. Default: true.
  ///
  /// [`Function`]: crate::Function
  /// [`Thread`]: crate::Thread
  /// [`Error`]: crate::Error
  pub deny_unsupported_types: bool,

  /// If true, deserializing a recursive table (one that refers to itself) is
  /// an error; otherwise subsequent visits to the same table are ignored.
  /// Default: true.
  pub deny_recursive_tables: bool,

  /// If true, keys in tables are iterated in sorted order. Default: false.
  pub sort_keys: bool,

  /// If true, empty Lua tables are encoded as an array instead of a map.
  /// Default: false.
  pub encode_empty_tables_as_array: bool,

  /// If true, enable detection of mixed tables (both array-like and map-like
  /// entries, or several borders). Default: false.
  pub detect_mixed_tables: bool,
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
      deny_unsupported_types: true,
      deny_recursive_tables: true,
      sort_keys: false,
      encode_empty_tables_as_array: false,
      detect_mixed_tables: false,
    }
  }

  /// Sets `deny_unsupported_types`.
  #[must_use]
  pub const fn deny_unsupported_types(mut self, enabled: bool) -> Self {
    self.deny_unsupported_types = enabled;
    self
  }

  /// Sets `deny_recursive_tables`.
  #[must_use]
  pub const fn deny_recursive_tables(mut self, enabled: bool) -> Self {
    self.deny_recursive_tables = enabled;
    self
  }

  /// Sets `sort_keys`.
  #[must_use]
  pub const fn sort_keys(mut self, enabled: bool) -> Self {
    self.sort_keys = enabled;
    self
  }

  /// Sets `encode_empty_tables_as_array`.
  #[must_use]
  pub const fn encode_empty_tables_as_array(mut self, enabled: bool) -> Self {
    self.encode_empty_tables_as_array = enabled;
    self
  }

  /// Sets `detect_mixed_tables`.
  #[must_use]
  pub const fn detect_mixed_tables(mut self, enable: bool) -> Self {
    self.detect_mixed_tables = enable;
    self
  }
}

impl Deserializer {
  /// Creates a new Lua deserializer for `value`.
  pub fn new(value: Value) -> Self {
    Self::new_with_options(value, Options::default())
  }

  /// Creates a new Lua deserializer for `value` with custom options.
  pub fn new_with_options(value: Value, options: Options) -> Self {
    Deserializer {
      value,
      options,
      visited: Visited::default(),
      len: None,
    }
  }

  fn from_parts(value: Value, options: Options, visited: Visited) -> Self {
    Deserializer {
      value,
      options,
      visited,
      len: None,
    }
  }

  fn with_len(mut self, len: usize) -> Self {
    self.len = Some(len);
    self
  }
}

impl<'de> serde::Deserializer<'de> for Deserializer {
  type Error = Error;

  #[inline]
  fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    match self.value {
      Value::Nil => visitor.visit_unit(),
      Value::Boolean(b) => visitor.visit_bool(b),
      Value::Integer(i) => visitor.visit_i64(i),
      Value::Number(n) => visitor.visit_f64(n),
      Value::Vector(_) => self.deserialize_seq(visitor),
      Value::String(ref s) => match s.to_str() {
        Ok(s) => visitor.visit_str(&s),
        Err(_) => visitor.visit_bytes(s.as_bytes()),
      },
      Value::Table(_) if super::is_null(&self.value) => visitor.visit_none(),
      Value::Table(ref t) => {
        if let Some(len) = encode_as_array(t, self.options) {
          self.with_len(len).deserialize_seq(visitor)
        } else {
          self.deserialize_map(visitor)
        }
      }
      Value::Buffer(ref buf) => {
        // 先拷贝：`buf.as_slice()` 借出的是 VM 内存，而 Visitor 是外部代码，
        // 它可以在被调用期间写同一个 buffer（克隆句柄），那会让借用失效。
        let data = buf.to_vec();
        visitor.visit_bytes(&data)
      }
      Value::Function(_)
      | Value::Thread(_)
      | Value::LightUserData(_)
      | Value::UserData(_)
      | Value::Error(_) => {
        if self.options.deny_unsupported_types {
          let msg = format!("unsupported value type `{}`", self.value.type_name());
          Err(de::Error::custom(msg))
        } else {
          visitor.visit_unit()
        }
      }
    }
  }

  #[inline]
  fn deserialize_option<V>(self, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    match self.value {
      Value::Nil => visitor.visit_none(),
      _ if super::is_null(&self.value) => visitor.visit_none(),
      _ => visitor.visit_some(self),
    }
  }

  #[inline]
  fn deserialize_enum<V>(
    self,
    _name: &'static str,
    _variants: &'static [&'static str],
    visitor: V,
  ) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    let (variant, value, _guard) = match self.value {
      Value::Table(table) => {
        let _guard = RecursionGuard::new(&table, &self.visited);

        let mut iter = table.pairs::<String, Value>();
        let (variant, value) = match iter.next() {
          Some(v) => v?,
          None => {
            return Err(de::Error::invalid_value(
              de::Unexpected::Map,
              &"map with a single key",
            ));
          }
        };

        if iter.next().is_some() {
          return Err(de::Error::invalid_value(
            de::Unexpected::Map,
            &"map with a single key",
          ));
        }
        let skip = check_value_for_skip(&value, self.options, &self.visited)
          .map_err(|err| Error::DeserializeError(err.to_string()))?;
        if skip {
          return Err(de::Error::custom("bad enum value"));
        }

        (variant, Some(value), Some(_guard))
      }
      Value::String(variant) => (variant.to_str()?, None, None),
      _ => return Err(de::Error::custom("bad enum value")),
    };

    visitor.visit_enum(EnumDeserializer {
      variant,
      value,
      options: self.options,
      visited: self.visited,
    })
  }

  #[inline]
  fn deserialize_seq<V>(self, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    match self.value {
      Value::Vector(vec) => {
        let mut deserializer = VecDeserializer {
          vec,
          next: 0,
          options: self.options,
          visited: self.visited,
        };
        visitor.visit_seq(&mut deserializer)
      }
      Value::Table(t) => {
        let _guard = RecursionGuard::new(&t, &self.visited);

        let len = self.len.unwrap_or_else(|| t.raw_len());
        let mut deserializer = SeqDeserializer {
          table: t,
          index: 1,
          len,
          options: self.options,
          visited: self.visited,
        };
        let seq = visitor.visit_seq(&mut deserializer)?;
        if deserializer.index > deserializer.len {
          Ok(seq)
        } else {
          Err(de::Error::invalid_length(
            len,
            &"fewer elements in the table",
          ))
        }
      }
      value => Err(de::Error::invalid_type(
        de::Unexpected::Other(value.type_name()),
        &"table",
      )),
    }
  }

  #[inline]
  fn deserialize_tuple<V>(self, _len: usize, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    self.deserialize_seq(visitor)
  }

  #[inline]
  fn deserialize_tuple_struct<V>(
    self,
    _name: &'static str,
    _len: usize,
    visitor: V,
  ) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    self.deserialize_seq(visitor)
  }

  #[inline]
  fn deserialize_map<V>(self, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    match self.value {
      Value::Table(t) => {
        let _guard = RecursionGuard::new(&t, &self.visited);

        let mut deserializer = MapDeserializer {
          pairs: MapPairs::new(&t, self.options.sort_keys)?,
          value: None,
          options: self.options,
          visited: self.visited,
          processed: 0,
        };
        let map = visitor.visit_map(&mut deserializer)?;
        let count = deserializer.pairs.count();
        if count == 0 {
          Ok(map)
        } else {
          Err(de::Error::invalid_length(
            deserializer.processed + count,
            &"fewer elements in the table",
          ))
        }
      }
      value => Err(de::Error::invalid_type(
        de::Unexpected::Other(value.type_name()),
        &"table",
      )),
    }
  }

  #[inline]
  fn deserialize_struct<V>(
    self,
    _name: &'static str,
    _fields: &'static [&'static str],
    visitor: V,
  ) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    self.deserialize_map(visitor)
  }

  #[inline]
  fn deserialize_newtype_struct<V>(self, _name: &'static str, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    visitor.visit_newtype_struct(self)
  }

  #[inline]
  fn deserialize_unit<V>(self, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    if super::is_null(&self.value) {
      visitor.visit_unit()
    } else {
      self.deserialize_any(visitor)
    }
  }

  #[inline]
  fn deserialize_unit_struct<V>(self, _name: &'static str, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    if super::is_null(&self.value) {
      visitor.visit_unit()
    } else {
      self.deserialize_any(visitor)
    }
  }

  serde::forward_to_deserialize_any! {
      bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes
      byte_buf identifier ignored_any
  }
}

// Reads the sequence part `1..=len` via raw access, yielding *every* slot up to
// `len` (including `nil` holes). This mirrors mlua's `TableSequence::with_len`,
// which iterates `raw_geti(i)` over a fixed length rather than stopping at the
// first border — so a sparse array like `{1,2,3,nil,5}` (raw length 5)
// round-trips identically through `from_value` and the `Serialize` impl.
struct SeqDeserializer {
  table: Table,
  index: usize,
  len: usize,
  options: Options,
  visited: Visited,
}

impl<'de> de::SeqAccess<'de> for SeqDeserializer {
  type Error = Error;

  fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>>
  where
    T: de::DeserializeSeed<'de>,
  {
    loop {
      if self.index > self.len {
        return Ok(None);
      }
      let value: Value = self.table.raw_get(self.index as i64)?;
      self.index += 1;
      let skip = check_value_for_skip(&value, self.options, &self.visited)
        .map_err(|err| Error::DeserializeError(err.to_string()))?;
      if skip {
        continue;
      }
      let visited = Rc::clone(&self.visited);
      let deserializer = Deserializer::from_parts(value, self.options, visited);
      return seed.deserialize(deserializer).map(Some);
    }
  }

  fn size_hint(&self) -> Option<usize> {
    Some(self.len + 1 - self.index)
  }
}

struct VecDeserializer {
  vec: crate::Vector,
  next: usize,
  options: Options,
  visited: Visited,
}

impl<'de> de::SeqAccess<'de> for VecDeserializer {
  type Error = Error;

  fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>>
  where
    T: de::DeserializeSeed<'de>,
  {
    if self.next >= Vector::SIZE {
      return Ok(None);
    }
    let n = self.vec.0[self.next];
    self.next += 1;
    let visited = Rc::clone(&self.visited);
    let deserializer = Deserializer::from_parts(Value::Number(n as f64), self.options, visited);
    seed.deserialize(deserializer).map(Some)
  }

  fn size_hint(&self) -> Option<usize> {
    // 剩余未访问的分量数。
    Some(Vector::SIZE - self.next)
  }
}

pub(crate) enum MapPairs {
  Iter(TablePairs<Value, Value>),
  Vec(Vec<(Value, Value)>),
}

impl MapPairs {
  pub(crate) fn new(t: &Table, sort_keys: bool) -> Result<Self> {
    if sort_keys {
      let mut pairs = t.pairs::<Value, Value>().collect::<Result<Vec<_>>>()?;
      // Reverse order as we pop values from the end.
      pairs.sort_by(|(a, _), (b, _)| sort_cmp(b, a));
      Ok(MapPairs::Vec(pairs))
    } else {
      Ok(MapPairs::Iter(t.pairs::<Value, Value>()))
    }
  }

  pub(crate) fn count(self) -> usize {
    match self {
      MapPairs::Iter(iter) => iter.count(),
      MapPairs::Vec(vec) => vec.len(),
    }
  }
}

impl Iterator for MapPairs {
  type Item = Result<(Value, Value)>;

  fn next(&mut self) -> Option<Self::Item> {
    match self {
      MapPairs::Iter(iter) => iter.next(),
      MapPairs::Vec(vec) => vec.pop().map(Ok),
    }
  }
}

struct MapDeserializer {
  pairs: MapPairs,
  value: Option<Value>,
  options: Options,
  visited: Visited,
  processed: usize,
}

impl MapDeserializer {
  fn next_key_deserializer(&mut self) -> Result<Option<Deserializer>> {
    loop {
      match self.pairs.next() {
        Some(item) => {
          let (key, value) = item?;
          let skip_key = check_value_for_skip(&key, self.options, &self.visited)
            .map_err(|err| Error::DeserializeError(err.to_string()))?;
          let skip_value = check_value_for_skip(&value, self.options, &self.visited)
            .map_err(|err| Error::DeserializeError(err.to_string()))?;
          if skip_key || skip_value {
            continue;
          }
          self.processed += 1;
          self.value = Some(value);
          let visited = Rc::clone(&self.visited);
          let key_de = Deserializer::from_parts(key, self.options, visited);
          return Ok(Some(key_de));
        }
        None => return Ok(None),
      }
    }
  }

  fn next_value_deserializer(&mut self) -> Result<Deserializer> {
    match self.value.take() {
      Some(value) => {
        let visited = Rc::clone(&self.visited);
        Ok(Deserializer::from_parts(value, self.options, visited))
      }
      None => Err(de::Error::custom("value is missing")),
    }
  }
}

impl<'de> de::MapAccess<'de> for MapDeserializer {
  type Error = Error;

  fn next_key_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>>
  where
    T: de::DeserializeSeed<'de>,
  {
    match self.next_key_deserializer() {
      Ok(Some(key_de)) => seed.deserialize(key_de).map(Some),
      Ok(None) => Ok(None),
      Err(error) => Err(error),
    }
  }

  fn next_value_seed<T>(&mut self, seed: T) -> Result<T::Value>
  where
    T: de::DeserializeSeed<'de>,
  {
    match self.next_value_deserializer() {
      Ok(value_de) => seed.deserialize(value_de),
      Err(error) => Err(error),
    }
  }
}

struct EnumDeserializer {
  variant: String,
  value: Option<Value>,
  options: Options,
  visited: Visited,
}

impl<'de> de::EnumAccess<'de> for EnumDeserializer {
  type Error = Error;
  type Variant = VariantDeserializer;

  fn variant_seed<T>(self, seed: T) -> Result<(T::Value, Self::Variant)>
  where
    T: de::DeserializeSeed<'de>,
  {
    let variant = self.variant.into_deserializer();
    let variant_access = VariantDeserializer {
      value: self.value,
      options: self.options,
      visited: self.visited,
    };
    seed.deserialize(variant).map(|v| (v, variant_access))
  }
}

struct VariantDeserializer {
  value: Option<Value>,
  options: Options,
  visited: Visited,
}

impl VariantDeserializer {
  /// 变体载荷存在时构造内层 [`Deserializer`] 并交棒 `f`；载荷缺失（unit 变体被
  /// 当作非 unit 使用）则报 `invalid_type(UnitVariant, kind)`。三处 VariantAccess
  /// 方法共用。
  fn with_value<R>(
    self,
    kind: &'static str,
    f: impl FnOnce(Deserializer) -> Result<R>,
  ) -> Result<R> {
    match self.value {
      Some(value) => f(Deserializer::from_parts(value, self.options, self.visited)),
      None => Err(de::Error::invalid_type(de::Unexpected::UnitVariant, &kind)),
    }
  }
}

impl<'de> de::VariantAccess<'de> for VariantDeserializer {
  type Error = Error;

  fn unit_variant(self) -> Result<()> {
    match self.value {
      Some(_) => Err(de::Error::invalid_type(
        de::Unexpected::NewtypeVariant,
        &"unit variant",
      )),
      None => Ok(()),
    }
  }

  fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value>
  where
    T: de::DeserializeSeed<'de>,
  {
    self.with_value("newtype variant", |de| seed.deserialize(de))
  }

  fn tuple_variant<V>(self, _len: usize, visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    self.with_value("tuple variant", |de| {
      SerdeDeserializer::deserialize_seq(de, visitor)
    })
  }

  fn struct_variant<V>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value>
  where
    V: de::Visitor<'de>,
  {
    self.with_value("struct variant", |de| {
      SerdeDeserializer::deserialize_map(de, visitor)
    })
  }
}

// Adds a table pointer to the `visited` set and removes it on drop. Used to
// track recursive tables while still allowing the same table to be traversed
// multiple times at different points.
pub(crate) struct RecursionGuard {
  ptr: *const c_void,
  visited: Visited,
}

impl RecursionGuard {
  #[inline]
  pub(crate) fn new(table: &Table, visited: &Visited) -> Self {
    let visited = Rc::clone(visited);
    let ptr = table.to_pointer();
    visited.borrow_mut().insert(ptr);
    RecursionGuard { ptr, visited }
  }
}

impl Drop for RecursionGuard {
  fn drop(&mut self) {
    self.visited.borrow_mut().remove(&self.ptr);
  }
}

// Checks `options` and decides whether to emit an error or skip the value.
#[inline]
pub(crate) fn check_value_for_skip(
  value: &Value,
  options: Options,
  visited: &VisitedSet,
) -> StdResult<bool, &'static str> {
  match value {
    Value::Table(table) => {
      let visited_ref = visited.borrow();
      if !visited_ref.is_empty() {
        if super::is_null(value) {
          return Ok(false);
        }
        let ptr = table.to_pointer();
        if visited_ref.contains(&ptr) {
          if options.deny_recursive_tables {
            return Err("recursive table detected");
          }
          return Ok(true); // skip
        }
      }
    }
    Value::Function(_)
    | Value::Thread(_)
    | Value::UserData(_)
    | Value::LightUserData(_)
    | Value::Error(_)
      if !options.deny_unsupported_types =>
    {
      return Ok(true); // skip
    }
    _ => {}
  }
  Ok(false) // do not skip
}

// ---------------------------------------------------------------------------
// Table -> array detection and value ordering (serde-only helpers).
//
// Implemented as free functions over `Table`/`Value` so the base `table.rs` /
// `value.rs` stay unchanged. Mirrors mlua's `Table::encode_as_array` and
// `Value::sort_cmp`.
// ---------------------------------------------------------------------------

/// If `table` is an array, returns `(non-nil count, max integer index)`;
/// `None` if any key is not a positive integer.
fn find_array_len(table: &Table) -> Option<(usize, usize)> {
  let (mut count, mut max_index) = (0usize, 0usize);
  for pair in table.pairs::<Value, Value>() {
    let (k, _) = pair.ok()?;
    let n = match k {
      Value::Integer(i) if i >= 1 => i as usize,
      Value::Number(f) if f.fract() == 0.0 && f >= 1.0 => f as usize,
      _ => return None,
    };
    max_index = max_index.max(n);
    count += 1;
  }
  Some((count, max_index))
}

/// 稠密数组判定阈值（mirrors mlua）：非 nil 元素少于该数的小表直接视为数组；
/// 更大的表要求 `len * DENSITY_RATIO >= max_idx`，过稀疏表编码为 map。
const MIN_DENSE_ARRAY_LEN: usize = 10;
/// 非 nil 元素数相对最大下标的密度比阈值，见 [`MIN_DENSE_ARRAY_LEN`]。
const DENSITY_RATIO: usize = 2;

/// Determines whether `table` should be encoded as an array; returns the array
/// length if so. Mirrors `mlua::Table::encode_as_array`.
pub(crate) fn encode_as_array(table: &Table, options: Options) -> Option<usize> {
  // 带 array metatable 的表无条件按 `raw_len()` 编码为数组（mlua 0.12.1
  // `Table::encode_as_array` 把该判定放在一切分支之前），不参与 mixed-table
  // 密度分析——否则 detect_mixed_tables(true) 下带 mt 的混合表会被误判成 map
  if super::has_array_metatable(table) {
    return Some(table.raw_len());
  }
  if options.detect_mixed_tables {
    if let Some((len, max_idx)) = find_array_len(table)
      && (len < MIN_DENSE_ARRAY_LEN || len * DENSITY_RATIO >= max_idx)
    {
      return Some(max_idx);
    }
  } else {
    let len = table.raw_len();
    if len > 0 {
      return Some(len);
    }
    if options.encode_empty_tables_as_array && table.is_empty() {
      return Some(0);
    }
  }
  None
}

/// Total order over [`Value`]s used for `sort_keys`. Mirrors
/// `mlua::Value::sort_cmp`, with the `null` sentinel ordered like mlua's
/// `LightUserData(NULL)` (just after `Nil`).
fn sort_cmp(a: &Value, b: &Value) -> Ordering {
  let a_null = super::is_null(a);
  let b_null = super::is_null(b);
  match (a, b) {
    (Value::Nil, Value::Nil) => Ordering::Equal,
    (Value::Nil, _) => Ordering::Less,
    (_, Value::Nil) => Ordering::Greater,
    // `null` sentinel (special case)
    _ if a_null && b_null => Ordering::Equal,
    _ if a_null => Ordering::Less,
    _ if b_null => Ordering::Greater,
    (Value::Boolean(x), Value::Boolean(y)) => x.cmp(y),
    (Value::Boolean(_), _) => Ordering::Less,
    (_, Value::Boolean(_)) => Ordering::Greater,
    (Value::Integer(x), Value::Integer(y)) => x.cmp(y),
    (Value::Integer(x), Value::Number(y)) => (*x as f64).partial_cmp(y).unwrap_or(Ordering::Equal),
    (Value::Number(x), Value::Integer(y)) => x.partial_cmp(&(*y as f64)).unwrap_or(Ordering::Equal),
    (Value::Number(x), Value::Number(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
    (Value::Integer(_) | Value::Number(_), _) => Ordering::Less,
    (_, Value::Integer(_) | Value::Number(_)) => Ordering::Greater,
    (Value::Vector(x), Value::Vector(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
    (Value::String(x), Value::String(y)) => x.as_bytes().cmp(y.as_bytes()),
    (Value::String(_), _) => Ordering::Less,
    (_, Value::String(_)) => Ordering::Greater,
    // Other variants are ordered by pointer identity.
    (x, y) => x.to_pointer().cmp(&y.to_pointer()),
  }
}
