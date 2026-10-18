//! `FromLua` / `IntoLua` / `FromLuaMulti` / `IntoLuaMulti` impls for the common
//! Rust types. Mirrors the impls in `mlua::conversion`.

use core::result::Result as StdResult;
use std::{
  borrow::Cow,
  collections::{BTreeMap, BTreeSet, HashMap, HashSet},
  hash::{BuildHasher, Hash},
  iter::Map,
};

use ulua_vm::functions::luai_num_2_str::lua_number_to_string;

use crate::{
  buffer::Buffer,
  error::{Error, Result},
  function::Function,
  light_userdata::LightUserData,
  multi::{MultiValue, Variadic},
  state::Lua,
  string::LuaString,
  table::{Table, TablePairs, TableSequence},
  thread::Thread,
  traits::{FromLua, FromLuaMulti, IntoLua, IntoLuaMulti},
  userdata::AnyUserData,
  value::{Number, Value},
  vector::Vector,
};

// ---------------------------------------------------------------------------
// Value itself
// ---------------------------------------------------------------------------

/// `FromLuaConversionError` 的统一构造点：数字/字符串转换路径中
/// `from` / `to` / `message` 三元组反复出现，收敛到此单一位置。
fn conv_err(from: &'static str, to: &'static str, message: &str) -> Error {
  Error::FromLuaConversionError {
    from,
    to: to.to_string(),
    message: Some(message.to_string()),
  }
}

/// 「浮点无整数表示」错误的共用 `'static` 文案（三处构造点雷同）。
const NO_INT_REPR: &str = "number has no integer representation";
/// `conv_err` 的源类型名：Lua number 侧转换。
const K_FROM_NUMBER: &str = "number";
/// `conv_err` 的源类型名：Lua string 侧强转。
const K_FROM_STRING: &str = "string";
/// 数值越界错误的共用 `'static` 文案。
const K_MSG_OUT_OF_RANGE: &str = "out of range";
/// 字符串→数字强转失败的共用 `'static` 文案。
const K_MSG_NOT_A_NUMBER: &str = "not a number";

/// `FromLua::from_lua` 的 match 骨架，收口所有实现共用的两条分支：
///
/// - `Value::Error(e)` **原样透传** `Err(*e)`。错误值是可在脚本层流转的一等值
///   （`IntoLua for Error` / `IntoLuaMulti for Result` 会产出它），若让它落进
///   catch-all 就被压成一条 `FromLuaConversionError`，丢掉原变体、`cause`、
///   `ExternalError` 载荷与 `source()` 链——`MemoryError`（`set_memory_limit`
///   的判定依据）、`UserDataDestructed` 等都会失去可判别性。
/// - 其余未被列出的类型折叠为 `FromLuaConversionError`（`from` 取实际类型名）。
///
/// 第二个分支形式用于 catch-all 需要额外说明的场景（如 `char`）。
macro_rules! from_lua_match {
  ($to:expr, $value:expr, { $($pat:pat $(if $guard:expr)? => $arm:expr),+ $(,)? }) => {
    from_lua_match!($to, None, $value, { $($pat $(if $guard)? => $arm),+ })
  };
  ($to:expr, $msg:expr, $value:expr, { $($pat:pat $(if $guard:expr)? => $arm:expr),+ $(,)? }) => {
    match $value {
      Value::Error(e) => Err(*e),
      $($pat $(if $guard)? => $arm,)+
      other => Err(Error::FromLuaConversionError {
        from: other.type_name(),
        to: $to.to_string(),
        message: $msg,
      }),
    }
  };
}

impl IntoLua for Value {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(self)
  }
}

impl FromLua for Value {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    Ok(value)
  }
}

// ---------------------------------------------------------------------------
// Unit / nil
// ---------------------------------------------------------------------------
//
// NOTE: `()` is deliberately NOT a single-value (`IntoLua`/`FromLua`) type.
// In Lua, `()` means *zero* values, not one nil — so it implements only the
// multi-value traits below (producing/consuming no stack values). This also
// avoids a coherence clash with the blanket `impl<T: IntoLua> IntoLuaMulti`.

// `()` as a *multi* value means "no values" in both directions.
impl IntoLuaMulti for () {
  fn into_lua_multi(self, _lua: &Lua) -> Result<MultiValue> {
    Ok(MultiValue::new())
  }
}

impl FromLuaMulti for () {
  fn from_lua_multi(_values: MultiValue, _lua: &Lua) -> Result<Self> {
    Ok(())
  }
}

// ---------------------------------------------------------------------------
// bool
// ---------------------------------------------------------------------------

impl IntoLua for bool {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::Boolean(self))
  }
}

impl FromLua for bool {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    match value {
      // 错误值不参与「真值性」判定：透传原始错误，别让一次转换失败伪装成 `true`。
      Value::Error(e) => Err(*e),
      // Lua truthiness: nil and false are false, everything else is true.
      Value::Nil => Ok(false),
      Value::Boolean(b) => Ok(b),
      _ => Ok(true),
    }
  }
}

// ---------------------------------------------------------------------------
// Integers (range-checked)
// ---------------------------------------------------------------------------

fn float_to_int<T: TryFrom<i128>>(f: f64, to: &'static str) -> Result<T> {
  let t = f.trunc();
  if t < (i128::MIN as f64) || t > (i128::MAX as f64) {
    return Err(conv_err(K_FROM_NUMBER, to, K_MSG_OUT_OF_RANGE));
  }
  let wide = t as i128;
  T::try_from(wide).map_err(|_| conv_err(K_FROM_NUMBER, to, K_MSG_OUT_OF_RANGE))
}

fn coerce_to_int<T: TryFrom<i64> + TryFrom<i128>>(
  value: Value,
  lua: &Lua,
  to: &'static str,
) -> Result<T> {
  from_lua_match!(to, value, {
    Value::Integer(i) => {
      T::try_from(i).map_err(|_| conv_err(K_FROM_NUMBER, to, K_MSG_OUT_OF_RANGE))
    },
    Value::Number(f) => {
      if !f.is_finite() {
        return Err(conv_err(K_FROM_NUMBER, to, NO_INT_REPR));
      }
      float_to_int(f, to)
    },
    Value::String(ref s) => {
      let f = lua
        .coerce_number(Value::String(s.clone()))?
        .ok_or_else(|| conv_err(K_FROM_STRING, to, K_MSG_NOT_A_NUMBER))?;
      if !f.is_finite() {
        return Err(conv_err(K_FROM_STRING, to, NO_INT_REPR));
      }
      float_to_int(f, to)
    },
  })
}

macro_rules! impl_integer {
  ($($ty:ty),*) => {$(
    impl IntoLua for $ty {
      fn into_lua(self, _lua: &Lua) -> Result<Value> {
        let as_i64 = i64::try_from(self).map_err(|_| Error::ToLuaConversionError {
          from: stringify!($ty),
          to: "integer",
          message: Some("value out of i64 range".to_string()),
        })?;
        Ok(Value::Integer(as_i64))
      }
    }

    impl FromLua for $ty {
      fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
        coerce_to_int(value, lua, stringify!($ty))
      }
    }
  )*};
}

impl_integer!(i8, u8, i16, u16, i32, u32, i64, u64, isize, usize);

// 128-bit integers exceed Luau's f64-backed number range, so they round-trip
// **lossily** through `f64` (matching mlua, which has no 128-bit Lua number).
// Values within f64's exactly-representable range survive the round trip.
macro_rules! impl_integer_128 {
  ($($ty:ty),*) => {$(
    impl IntoLua for $ty {
      fn into_lua(self, _lua: &Lua) -> Result<Value> {
        Ok(Value::Number(self as f64))
      }
    }

    impl FromLua for $ty {
      fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
        let n: f64 = from_lua_match!(stringify!($ty), value, {
          Value::Integer(i) => Ok(i as f64),
          Value::Number(f) => Ok(f),
          // 与上面 `impl_integer` 的字符串分支同源：VM 语义（cpp `luaO_str2d`，
          // lobject.cpp:86）而非 Rust `str::parse`——`"0x10"` 得 16、空白容忍。
          Value::String(ref s) => lua
            .coerce_number(Value::String(s.clone()))?
            .ok_or_else(|| conv_err(K_FROM_STRING, stringify!($ty), K_MSG_NOT_A_NUMBER)),
        })?;
        if n.fract() != 0.0 || !n.is_finite() {
          return Err(conv_err(K_FROM_NUMBER, stringify!($ty), NO_INT_REPR));
        }
        // 编译期判别有无符号：u128::MAX 转 u128 后仍是 u128::MAX，
        // i128::MAX 转 u128 后变小。
        const IS_UNSIGNED: bool = (<$ty>::MAX as u128) == u128::MAX;
        // Range-check in f64 space before the `as` cast: a float beyond
        // the target's range (e.g. `1e300` for `i128`, or any negative
        // for `u128`) must be rejected rather than silently saturating.
        // `MAX as f64` may round up past the representable range, so the
        // upper bound is exclusive (`n >= max` rejects).
        let min = if IS_UNSIGNED { 0.0 } else { i128::MIN as f64 };
        let max = <$ty>::MAX as f64;
        if n < min || n >= max {
          return Err(conv_err(K_FROM_NUMBER, stringify!($ty), K_MSG_OUT_OF_RANGE));
        }
        Ok(n as $ty)
      }
    }
  )*};
}

impl_integer_128!(i128, u128);

// ---------------------------------------------------------------------------
// Floats
// ---------------------------------------------------------------------------

impl IntoLua for f64 {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::Number(self))
  }
}

impl FromLua for f64 {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    from_lua_match!("f64", value, {
      Value::Number(n) => Ok(n),
      Value::Integer(i) => Ok(i as f64),
      // Lua coerces numeric strings to numbers (mirrors mlua). 与
      // `Lua::coerce_number` 同一条 VM 路径（`lua_tonumberx` → cpp
      // `luaO_str2d`，lobject.cpp:86）：`"0x10"` → 16、前导/尾随空白按
      // strtod 语义容忍、`"nan"`/`"inf"` 是合法形态。删掉 Rust `str::parse`
      // 回退，消除 crate 内两套字符串数值语义。
      Value::String(ref s) => lua
        .coerce_number(Value::String(s.clone()))?
        .ok_or_else(|| conv_err(K_FROM_STRING, "f64", K_MSG_NOT_A_NUMBER)),
    })
  }
}

impl IntoLua for f32 {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::Number(self as Number))
  }
}

impl FromLua for f32 {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    Ok(f64::from_lua(value, lua)? as f32)
  }
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

impl IntoLua for String {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::String(lua.create_string(&self)))
  }
}

impl IntoLua for &str {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::String(lua.create_string(self)))
  }
}

impl IntoLua for &String {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::String(lua.create_string(self)))
  }
}

impl FromLua for String {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    from_lua_match!("String", value, {
      Value::String(s) => s.to_str(),
      // Lua coerces numbers to strings in many contexts; mirror that.
      Value::Integer(i) => Ok(i.to_string()),
      // 数字→字符串只有 VM 的 `luai_num2str` 一条路径（Schubfach 最短往返表示，
      // `1e22` → "1e+22"、`NaN` → "nan"），不能用 Rust `Display`，否则宿主与脚本
      // 对同一值的字符串化不一致（`Value::to_string` 已走同一条路径）。
      Value::Number(n) => Ok(lua_number_to_string(n)),
    })
  }
}

impl IntoLua for LuaString {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::String(self))
  }
}

impl IntoLua for &LuaString {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::String(self.clone()))
  }
}

impl FromLua for LuaString {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    from_lua_match!("String", value, {
      Value::String(s) => Ok(s),
      Value::Integer(i) => Ok(lua.create_string(i.to_string())),
      // 与 `FromLua for String` 同源：走 VM 的 `luai_num2str`。
      Value::Number(n) => Ok(lua.create_string(lua_number_to_string(n))),
    })
  }
}

// ---------------------------------------------------------------------------
// Handles (Table, Function, Buffer, Vector, LightUserData, AnyUserData, Thread)
// ---------------------------------------------------------------------------

macro_rules! impl_lua_handle {
  ($($ty:ident ($name:literal) => $variant:ident),* $(,)?) => {$(
    impl IntoLua for $ty {
      fn into_lua(self, _lua: &Lua) -> Result<Value> {
        Ok(Value::$variant(self))
      }
    }

    impl IntoLua for &$ty {
      fn into_lua(self, _lua: &Lua) -> Result<Value> {
        Ok(Value::$variant(self.clone()))
      }
    }

    impl FromLua for $ty {
      fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
        from_lua_match!($name, value, {
          Value::$variant(v) => Ok(v),
        })
      }
    }
  )*};
}

impl_lua_handle! {
  Table("Table") => Table,
  Function("Function") => Function,
  Buffer("buffer") => Buffer,
  Vector("vector") => Vector,
  LightUserData("LightUserData") => LightUserData,
  AnyUserData("AnyUserData") => UserData,
  Thread("Thread") => Thread,
}

// ---------------------------------------------------------------------------
// Option<T>
// ---------------------------------------------------------------------------

impl<T: IntoLua> IntoLua for Option<T> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    match self {
      Some(v) => v.into_lua(lua),
      None => Ok(Value::Nil),
    }
  }
}

impl<T: FromLua> FromLua for Option<T> {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    match value {
      Value::Nil => Ok(None),
      other => Ok(Some(T::from_lua(other, lua)?)),
    }
  }
}

// ---------------------------------------------------------------------------
// Vec<T> <-> sequence table
// ---------------------------------------------------------------------------

impl<T: IntoLua> IntoLua for Vec<T> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let table = lua.create_table();
    table.fill_sequence(self)?;
    Ok(Value::Table(table))
  }
}

impl<T: IntoLua + Clone> IntoLua for &[T] {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let table = lua.create_table();
    table.fill_sequence(self.iter().cloned())?;
    Ok(Value::Table(table))
  }
}

impl<T: FromLua> FromLua for Vec<T> {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    from_lua_match!("Vec", value, {
      // 首个 nil 截断（mirrors mlua sequence_values，语义见 table.rs），
      // 与 from_lua_set 等序列消费方统一
      Value::Table(t) => t.sequence_values::<T>().collect(),
    })
  }
}

// ---------------------------------------------------------------------------
// Fixed-size arrays [T; N] <-> sequence table
// ---------------------------------------------------------------------------

impl<T: IntoLua, const N: usize> IntoLua for [T; N] {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let table = lua.create_table();
    table.fill_sequence(self)?;
    Ok(Value::Table(table))
  }
}

impl<T: FromLua, const N: usize> FromLua for [T; N] {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    // A Luau vector converts to an array of its components (matching mlua:
    // `let v: [f64; 3] = lua.load("vector.create(1,2,3)").eval()?`).
    if let Value::Vector(v) = value {
      if N == Vector::SIZE {
        let x = T::from_lua(Value::Number(v.x() as f64), lua)?;
        let y = T::from_lua(Value::Number(v.y() as f64), lua)?;
        let z = T::from_lua(Value::Number(v.z() as f64), lua)?;
        let comps = vec![x, y, z];
        return <[T; N]>::try_from(comps).map_err(|_| Error::FromLuaConversionError {
          from: "vector",
          to: format!("[T; {N}]"),
          message: None,
        });
      }
      return Err(Error::FromLuaConversionError {
        from: "vector",
        to: format!("[T; {N}]"),
        message: Some(format!(
          "expected array of length {}, got {N}",
          Vector::SIZE
        )),
      });
    }
    let vec: Vec<T> = Vec::from_lua(value, lua)?;
    let len = vec.len();
    <[T; N]>::try_from(vec).map_err(|_| Error::FromLuaConversionError {
      from: "table",
      to: format!("[T; {N}]"),
      message: Some(format!("expected table of length {N}, got {len}")),
    })
  }
}

// ---------------------------------------------------------------------------
// HashMap / BTreeMap <-> table
// ---------------------------------------------------------------------------

fn map_into_lua<I: IntoIterator<Item = (K, V)>, K: IntoLua, V: IntoLua>(
  items: I,
  lua: &Lua,
) -> Result<Value> {
  let table = lua.create_table();
  for (k, v) in items {
    table.raw_set(k, v)?;
  }
  Ok(Value::Table(table))
}

fn table_to_map<K: FromLua, V: FromLua, C: Default>(
  value: Value,
  to: &'static str,
  mut insert: impl FnMut(&mut C, K, V),
) -> Result<C> {
  from_lua_match!(to, value, {
    Value::Table(t) => {
      let mut out = C::default();
      for pair in t.pairs::<K, V>() {
        let (k, v) = pair?;
        insert(&mut out, k, v);
      }
      Ok(out)
    },
  })
}

impl<K: IntoLua + Eq + Hash, V: IntoLua, S: BuildHasher> IntoLua for HashMap<K, V, S> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    map_into_lua(self, lua)
  }
}

impl<K: FromLua + Eq + Hash, V: FromLua, S: BuildHasher + Default> FromLua for HashMap<K, V, S> {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    table_to_map(value, "HashMap", |out: &mut Self, k, v| {
      out.insert(k, v);
    })
  }
}

impl<K: IntoLua + Ord, V: IntoLua> IntoLua for BTreeMap<K, V> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    map_into_lua(self, lua)
  }
}

impl<K: FromLua + Ord, V: FromLua> FromLua for BTreeMap<K, V> {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    table_to_map(value, "BTreeMap", |out: &mut Self, k, v| {
      out.insert(k, v);
    })
  }
}

// ---------------------------------------------------------------------------
// HashSet / BTreeSet <-> table (values become keys mapped to `true`)
// ---------------------------------------------------------------------------

fn set_into_lua<I: IntoIterator<Item = T>, T: IntoLua>(items: I, lua: &Lua) -> Result<Value> {
  let table = lua.create_table();
  for item in items {
    table.raw_set(item, true)?;
  }
  Ok(Value::Table(table))
}

impl<T: IntoLua + Eq + Hash, S: BuildHasher> IntoLua for HashSet<T, S> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    set_into_lua(self, lua)
  }
}

impl<T: FromLua + Eq + Hash, S: BuildHasher + Default> FromLua for HashSet<T, S> {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    from_lua_set(value, lua, "HashSet", |it| {
      let mut out = HashSet::with_hasher(S::default());
      for v in it {
        out.insert(v?);
      }
      Ok(out)
    })
  }
}

impl<T: IntoLua + Ord> IntoLua for BTreeSet<T> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    set_into_lua(self, lua)
  }
}

impl<T: FromLua + Ord> FromLua for BTreeSet<T> {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    from_lua_set(value, lua, "BTreeSet", |it| {
      let mut out = BTreeSet::new();
      for v in it {
        out.insert(v?);
      }
      Ok(out)
    })
  }
}

/// A Lua table can represent a set in two ways (matching mlua): as a sequence
/// of values `{a, b, c}`, or as a map of keys `{[a] = true, ...}`. We support
/// both: if the table has a non-empty sequence part, take its values;
/// otherwise take its keys.
fn from_lua_set<T: FromLua, C>(
  value: Value,
  _lua: &Lua,
  to: &'static str,
  build: impl FnOnce(SetIter<T>) -> Result<C>,
) -> Result<C> {
  from_lua_match!(to, value, {
    Value::Table(t) => {
      if t.raw_len() > 0 {
        build(SetIter::Seq(t.sequence_values::<T>()))
      } else {
        // 惰性取 key：首个错误即短路，不预收集整个 key 列表。
        build(SetIter::Keys(
          t.pairs::<T, Value>().map(|p| p.map(|(k, _)| k)),
        ))
      }
    }
  })
}

/// 从 `pairs()` 取 key 的惰性迭代器（非捕获闭包折叠为函数指针）。
type KeyIter<T> = Map<TablePairs<T, Value>, fn(Result<(T, Value)>) -> Result<T>>;

enum SetIter<T: FromLua> {
  Seq(TableSequence<T>),
  Keys(KeyIter<T>),
}

impl<T: FromLua> Iterator for SetIter<T> {
  type Item = Result<T>;
  fn next(&mut self) -> Option<Self::Item> {
    match self {
      SetIter::Seq(s) => s.next(),
      SetIter::Keys(k) => k.next(),
    }
  }
}

// ---------------------------------------------------------------------------
// char
// ---------------------------------------------------------------------------

impl IntoLua for char {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let mut bytes = [0; 4];
    Ok(Value::String(
      lua.create_string(self.encode_utf8(&mut bytes)),
    ))
  }
}

impl FromLua for char {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    from_lua_match!(
      "char",
      Some("expected string or integer".to_string()),
      value,
      {
        // 数值：转 i64 后按 Unicode 码点解释。
        Value::Integer(_) | Value::Number(_) => {
          let i = i64::from_lua(value, lua)?;
          let cp = u32::try_from(i).ok().and_then(char::from_u32);
          cp.ok_or(Error::FromLuaConversionError {
            from: "number",
            to: "char".to_string(),
            message: Some("integer out of range for a unicode char".to_string()),
          })
        },
        // 字符串：必须恰好一个字符。
        Value::String(_) => {
          let s = String::from_lua(value, lua)?;
          let mut chars = s.chars();
          match (chars.next(), chars.next()) {
            (Some(c), None) => Ok(c),
            _ => Err(Error::FromLuaConversionError {
              from: "string",
              to: "char".to_string(),
              message: Some("expected string to have exactly one char".to_string()),
            }),
          }
        },
      }
    )
  }
}

// ---------------------------------------------------------------------------
// Cow<str>, Box<str>
// ---------------------------------------------------------------------------

impl IntoLua for Cow<'_, str> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::String(lua.create_string(self.as_ref())))
  }
}

impl IntoLua for Box<str> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::String(lua.create_string(&*self)))
  }
}

impl FromLua for Box<str> {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    Ok(String::from_lua(value, lua)?.into_boxed_str())
  }
}

impl<T: IntoLua> IntoLua for Box<[T]> {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    self.into_vec().into_lua(lua)
  }
}

impl<T: FromLua> FromLua for Box<[T]> {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    Ok(Vec::<T>::from_lua(value, lua)?.into_boxed_slice())
  }
}

// ---------------------------------------------------------------------------
// Variadic<T>
// ---------------------------------------------------------------------------

impl<T: IntoLua> IntoLuaMulti for Variadic<T> {
  fn into_lua_multi(self, lua: &Lua) -> Result<MultiValue> {
    let vec: Vec<T> = self.into();
    let mut m = MultiValue::with_capacity(vec.len());
    for item in vec {
      m.push_back(item.into_lua(lua)?);
    }
    Ok(m)
  }
}

impl<T: FromLua> FromLuaMulti for Variadic<T> {
  fn from_lua_multi(values: MultiValue, lua: &Lua) -> Result<Self> {
    let mut out = Vec::with_capacity(values.len());
    for v in values {
      out.push(T::from_lua(v, lua)?);
    }
    Ok(Variadic::from(out))
  }
}

// ---------------------------------------------------------------------------
// Error <-> Value::Error  +  Result<T, E> : IntoLuaMulti
// ---------------------------------------------------------------------------

impl IntoLua for Error {
  fn into_lua(self, _lua: &Lua) -> Result<Value> {
    Ok(Value::Error(Box::new(self)))
  }
}

impl FromLua for Error {
  fn from_lua(value: Value, _lua: &Lua) -> Result<Self> {
    Ok(match value {
      Value::Error(e) => *e,
      // Any other Lua value converts to a runtime error carrying its
      // string form (mirrors mlua's `convert::<Error>`).
      Value::String(s) => Error::RuntimeError(s.to_string_lossy()),
      other => Error::RuntimeError(other.to_string()?),
    })
  }
}

/// `Result<T, E>` spreads as the success values on `Ok`, or as `(nil, error)`
/// on `Err` — mirroring mlua's `IntoLuaMulti for Result`.
impl<T: IntoLuaMulti, E: IntoLua> IntoLuaMulti for StdResult<T, E> {
  fn into_lua_multi(self, lua: &Lua) -> Result<MultiValue> {
    match self {
      Ok(v) => v.into_lua_multi(lua),
      Err(e) => {
        let mut m = MultiValue::with_capacity(2);
        m.push_back(Value::Nil);
        m.push_back(e.into_lua(lua)?);
        Ok(m)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MultiValue passthrough
// ---------------------------------------------------------------------------

impl IntoLuaMulti for MultiValue {
  fn into_lua_multi(self, _lua: &Lua) -> Result<MultiValue> {
    Ok(self)
  }
}

impl FromLuaMulti for MultiValue {
  fn from_lua_multi(values: MultiValue, _lua: &Lua) -> Result<Self> {
    Ok(values)
  }
}

// ---------------------------------------------------------------------------
// Tuples (IntoLuaMulti / FromLuaMulti) up to 12
// ---------------------------------------------------------------------------

// `IntoLuaMulti` for tuples: each element may itself spread to multiple values
// (e.g. a trailing `Variadic<T>`), so concatenate their `MultiValue`s.
macro_rules! impl_tuple_into {
    ($($t:ident : $T:ident),+) => {
        impl<$($T: IntoLuaMulti,)*> IntoLuaMulti for ($($T,)*) {
            fn into_lua_multi(self, lua: &Lua) -> Result<MultiValue> {
                let ($($t,)*) = self;
                let mut m = MultiValue::new();
                $( for v in $t.into_lua_multi(lua)? { m.push_back(v); } )*
                Ok(m)
            }
        }
    };
}

impl_tuple_into!(a: A);
impl_tuple_into!(a: A, b: B);
impl_tuple_into!(a: A, b: B, c: C);
impl_tuple_into!(a: A, b: B, c: C, d: D);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I, j: J);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I, j: J, k: K);
impl_tuple_into!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I, j: J, k: K, l: L);

// `FromLuaMulti` for tuples. The **last** element is parsed as a `FromLuaMulti`
// (so it may be a trailing `Variadic<T>` that consumes every remaining value);
// the preceding elements each consume exactly one value via `FromLua`.
//
// Because every `FromLua` type is also `FromLuaMulti` (the blanket impl), a
// single impl per arity with the last slot bound `FromLuaMulti` subsumes the
// all-`FromLua` case as well — no overlapping impls. Mirrors mlua's tuple
// `FromLuaMulti`, which lets the final slot soak up the rest.
macro_rules! impl_tuple_from {
    (; $last:ident : $Last:ident) => {
        impl<$Last: FromLuaMulti> FromLuaMulti for ($Last,) {
            fn from_lua_multi(values: MultiValue, lua: &Lua) -> Result<Self> {
                let $last = $Last::from_lua_multi(values, lua)?;
                Ok(($last,))
            }
        }
    };
    ($($head:ident : $Head:ident),+ ; $last:ident : $Last:ident) => {
        impl<$($Head: FromLua,)+ $Last: FromLuaMulti> FromLuaMulti for ($($Head,)+ $Last,) {
            fn from_lua_multi(mut values: MultiValue, lua: &Lua) -> Result<Self> {
                $( let $head = $Head::from_lua(values.pop_front().unwrap_or(Value::Nil), lua)?; )+
                let $last = $Last::from_lua_multi(values, lua)?;
                Ok(($($head,)+ $last,))
            }
        }
    };
}

// Arities 1..=12 (last element `FromLuaMulti`, the rest `FromLua`).
impl_tuple_from!(; a: A);
impl_tuple_from!(a: A ; b: B);
impl_tuple_from!(a: A, b: B ; c: C);
impl_tuple_from!(a: A, b: B, c: C ; d: D);
impl_tuple_from!(a: A, b: B, c: C, d: D ; e: E);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E ; f: F);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F ; g: G);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F, g: G ; h: H);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H ; i: I);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I ; j: J);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I, j: J ; k: K);
impl_tuple_from!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I, j: J, k: K ; l: L);
