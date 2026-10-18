//! (De)serialization support using [`serde`].
//!
//! This module mirrors `mlua`'s `serde` feature: it adds the [`LuaSerdeExt`]
//! trait to [`Lua`], a serde [`Serializer`] that builds Lua [`Value`]s, and a
//! [`Deserializer`] that reads them. It is gated behind the `serde` cargo
//! feature; with the feature off the rest of the crate is byte-for-byte
//! unchanged.
//!
//! ## Luau deviations from mlua's Lua-version-specific behavior
//!
//! - **Numbers are `f64`.** Luau has no distinct integer subtype at the VM
//!   level; ulua-rt reconstructs [`Value::Integer`] vs [`Value::Number`] from
//!   whether an `f64` is an exact, in-range whole number (see
//!   [`crate::Value`]). Serialization therefore treats an integral `f64` the
//!   same as an integer — matching mlua's *observable* JSON output for the
//!   values under test.
//! - **`null` sentinel.** mlua encodes a serde "none"/JSON `null` using a
//!   `LightUserData(NULL)` value. ulua-rt's [`Value`] has no `LightUserData`
//!   variant, so [`LuaSerdeExt::null`] instead returns a dedicated, per-`Lua`
//!   **sentinel table** (a unique empty table cached in the state). Serde
//!   recognizes this exact table by pointer identity and treats it as
//!   `null`/`None`, reproducing mlua's behavior at the API level.

use core::ffi::c_void;
use std::{cell::RefCell, rc::Rc};

use serde::{de::DeserializeOwned, ser::Serialize};
use ulua_common::collections::HashSet;

use crate::{
  error::Result,
  state::Lua,
  table::Table,
  value::Value,
  vm_store::{VmKey, define_vm_store, vm_key_of},
};
pub mod de;
pub mod ser;
mod value_serialize;

pub use de::Options as DeserializeOptions;
pub use ser::Options as SerializeOptions;
pub use value_serialize::{SerializableTable, SerializableValue};

/// 递归表检测的共享指针集（ser/de 同用一套）：元素是表对象地址，只作身份
/// 比较、从不解引用——与下方 `SentinelStore` 哨兵缓存同一手法（C 类论证：
/// 身份 token 即指针值，无更优 Rust 形态）。
pub(crate) type VisitedSet = RefCell<HashSet<*const c_void>>;
/// 一次遍历链共享的 [`VisitedSet`]：嵌套 Deserializer/Serializer 经 `Rc`
/// 传递同一集合，Drop 守卫进出成对。
pub(crate) type Visited = Rc<VisitedSet>;

// ---------------------------------------------------------------------------
// Per-state sentinels (the `null` table and the array metatable).
//
// mlua keeps these in the Lua registry. ulua-rt's `Value` has no
// `LightUserData`, so the `null` value is modelled as a dedicated, unique empty
// table per `Lua`; the array metatable is likewise a unique table per `Lua`.
//
// The tables are ROOTED IN THE LUA REGISTRY (named registry keys) — part of the
// state, freed when it closes. A per-VM side table keyed by the VM's
// `global_State` address (see [`crate::vm_store`]) caches only their raw
// POINTERS for the identity check; it holds no `Table` or registry HANDLE. That
// is deliberate: a handle owns an `XRc<LuaInner>`, so caching one here would
// keep the whole VM alive forever (the state could never drop) and, at
// thread/process exit, dropping the cached handle into an already-freed state
// aborts ("thread local panicked on drop"). Caching only raw pointers breaks
// that cycle — the user's `Lua` closes normally, and `clear_sentinels` (from
// `LuaInner::drop`) evicts the pointer entry, so the next VM reusing the
// address cannot inherit it.
//
// The store uses the crate-wide [`crate::vm_store::define_vm_store`] skeleton:
// a `thread_local!` map without `send`, a process-wide `Mutex` map with it.
// That switch is load-bearing here exactly as for every other side table:
// under `send` the VM may be created on one thread and driven (and dropped) on
// another, so a plain thread-local would strand the cached pointers — the
// moved VM would miss the lookup and rebuild its sentinels (overwriting the
// registry rooting) while `is_null`/`has_array_metatable` failed against
// values created on the origin thread, and a drop on the target thread would
// leave a stale entry behind. Compiled only under the `serde` feature.
// ---------------------------------------------------------------------------

/// Registry names under which a state's sentinel tables are rooted. Each Lua
/// state has its own registry, so these do not collide across states.
const NULL_REGISTRY_NAME: &str = "__ulua_serde_null_sentinel";
const ARRAY_MT_REGISTRY_NAME: &str = "__ulua_serde_array_metatable";

/// Raw POINTER VALUES of a state's sentinel tables, cached for the identity
/// check. Not `Table` handles: a handle owns an `XRc<LuaInner>`, so caching one
/// here would pin the whole VM alive forever and abort at thread-local teardown
/// (see the module note). Stored as `usize` addresses — not raw pointers — so
/// the store's value type is `Send`, the same rationale as
/// [`crate::vm_store::VmKey`]; compared for identity only, never dereferenced.
#[derive(Clone, Copy)]
pub(crate) struct SentinelPtrs {
  null: usize,
  array_metatable: usize,
}

define_vm_store! {
  /// Per-VM serde sentinel pointers, keyed by the `global_State` pointer —
  /// thread-local without `send`, process-wide `Mutex` with it (see
  /// [`crate::vm_store`] rule 2 for why the switch is the whole point).
  SentinelStore, SentinelPtrs
}

/// Ensure both sentinel tables exist for `lua`: create them, root them in the
/// registry (so they outlive the local handles without pinning the VM), and
/// cache their pointers. Idempotent.
fn ensure_sentinels(lua: &Lua) {
  // `lua` 持有 `XRc<LuaInner>`（state 存活），满足 `vm_key` 调用序契约。
  let key = vm_key_of(lua);
  if SentinelStore::with(|m| m.contains_key(&key)) {
    return;
  }
  let null = lua.create_table();
  let array_metatable = build_array_metatable(lua);
  let ptrs = SentinelPtrs {
    null: null.to_pointer() as usize,
    array_metatable: array_metatable.to_pointer() as usize,
  };
  // Root the tables in the registry (freed with the state on `lua_close`); the
  // side table keeps only their pointers.
  let _ = lua.set_named_registry_value(NULL_REGISTRY_NAME, null);
  let _ = lua.set_named_registry_value(ARRAY_MT_REGISTRY_NAME, array_metatable);
  SentinelStore::with(|m| {
    m.insert(key, ptrs);
  });
}

/// Returns the per-`Lua` `null` sentinel table, creating it on first use. The
/// returned handle is transient (fetched from the registry); it drops after the
/// caller, so nothing permanent pins the VM.
pub(crate) fn null_table(lua: &Lua) -> Table {
  ensure_sentinels(lua);
  // 构造期不变式：ensure_sentinels 刚把该键以 Table 写入 registry 并 rooting，
  // 键名为私有常量、公开 API 不泄露，取回必为 Table——expect 不可达。
  lua
    .named_registry_value::<Table>(NULL_REGISTRY_NAME)
    .expect("serde null sentinel is rooted in the registry")
}

/// Returns the per-`Lua` array metatable, creating it on first use.
pub(crate) fn array_metatable_table(lua: &Lua) -> Table {
  ensure_sentinels(lua);
  // 同 null_table：ensure_sentinels 刚写入并 rooting，registry 取回必为 Table，不可达。
  lua
    .named_registry_value::<Table>(ARRAY_MT_REGISTRY_NAME)
    .expect("serde array metatable is rooted in the registry")
}

/// Build the array metatable: a fresh table with `__metatable = false` so Lua
/// code cannot read or replace it (mirrors mlua, which protects the metatable
/// the same way).
fn build_array_metatable(lua: &Lua) -> Table {
  let mt = lua.create_table();
  // Best-effort: if this ever failed we'd still have a usable (if
  // unprotected) metatable, so ignore the (impossible here) error.
  let _ = mt.raw_set("__metatable", false);
  mt
}

/// Whether `value` is the `null` sentinel for its owning `Lua` (compared by
/// table pointer identity).
pub(crate) fn is_null(value: &Value) -> bool {
  if let Value::Table(t) = value {
    // `t` 持有 `XRc<LuaInner>`（state 存活），满足 `vm_key` 调用序契约。
    let key = vm_key_of(&t.lua());
    return SentinelStore::with(|m| {
      m.get(&key)
        .map(|s| s.null == t.to_pointer() as usize)
        .unwrap_or(false)
    });
  }
  false
}

/// Whether `table` carries the array metatable (compared by pointer identity).
pub(crate) fn has_array_metatable(table: &Table) -> bool {
  // `table` 持有 `XRc<LuaInner>`（state 存活），满足 `vm_key` 调用序契约。
  let key = vm_key_of(&table.lua());
  let array_ptr = SentinelStore::with(|m| m.get(&key).map(|s| s.array_metatable));
  match array_ptr {
    Some(ptr) => table
      .metatable()
      .map(|mt| mt.to_pointer() as usize == ptr)
      .unwrap_or(false),
    None => false,
  }
}

/// Evict this state's cached sentinel POINTERS. Called from `LuaInner::drop`; the
/// sentinel tables themselves are freed with the state's registry on `lua_close`.
/// Without this the (now stale) pointer entry would leak one slot per state.
pub(crate) fn clear_sentinels(key: VmKey) {
  // 唯一调用点在 `LuaInner::drop` 的 clear 序列、`lua_close` 之前,key 已在彼处
  // 由存活 state 算出。
  let _ = SentinelStore::try_with(|m| {
    m.remove(&key);
  });
}

/// Trait for serializing/deserializing Lua values using Serde. Mirrors
/// `mlua::LuaSerdeExt`.
pub trait LuaSerdeExt {
  /// A special value used to encode/decode optional (none) values.
  ///
  /// In ulua-rt this is a dedicated, per-`Lua` sentinel [`Table`] (see the
  /// module docs); mlua uses a `LightUserData(NULL)`. The observable behavior
  /// — `null` round-trips to/from serde `None`/JSON `null` — is the same.
  fn null(&self) -> Value;

  /// A metatable attachable to a Lua table to systematically encode it as an
  /// array (instead of a map). The encoded array contains only the sequence
  /// part of the table, with the same length as the `#` operator.
  fn array_metatable(&self) -> Table;

  /// Converts `T` into a [`Value`] instance.
  fn to_value<T: Serialize + ?Sized>(&self, t: &T) -> Result<Value>;

  /// Converts `T` into a [`Value`] instance with options.
  fn to_value_with<T>(&self, t: &T, options: ser::Options) -> Result<Value>
  where
    T: Serialize + ?Sized;
}

impl LuaSerdeExt for Lua {
  fn null(&self) -> Value {
    Value::Table(null_table(self))
  }

  fn array_metatable(&self) -> Table {
    array_metatable_table(self)
  }

  fn to_value<T>(&self, t: &T) -> Result<Value>
  where
    T: Serialize + ?Sized,
  {
    t.serialize(ser::Serializer::new(self))
  }

  fn to_value_with<T>(&self, t: &T, options: ser::Options) -> Result<Value>
  where
    T: Serialize + ?Sized,
  {
    t.serialize(ser::Serializer::new_with_options(self, options))
  }
}

impl Lua {
  /// Deserializes a [`Value`] into any serde-deserializable object.
  pub fn from_value<T: DeserializeOwned>(&self, value: Value) -> Result<T> {
    T::deserialize(de::Deserializer::new(value))
  }

  /// Deserializes a [`Value`] into any serde-deserializable object with
  /// options.
  pub fn from_value_with<T: DeserializeOwned>(
    &self,
    value: Value,
    options: de::Options,
  ) -> Result<T> {
    T::deserialize(de::Deserializer::new_with_options(value, options))
  }
}
