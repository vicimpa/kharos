//! [`RegistryKey`] — long-term storage of a Lua value in the registry.
//!
//! Mirrors `mlua::RegistryKey`. A registry key holds a value reachable by the
//! GC for as long as the key (or a clone of it) is alive. It is created with
//! [`Lua::create_registry_value`] and read back with [`Lua::registry_value`].
//! Dropping the key (or calling [`Lua::remove_registry_value`]) releases the
//! registry slot.
//!
//! Under the hood a `RegistryKey` is just a public wrapper around the same
//! `lua_ref`/`lua_unref` machinery the internal handles already use
//! ([`crate::state::LuaRef`]): `create_registry_value` pushes the value and
//! takes a registry ref; `registry_value` re-pushes it. Each key remembers
//! which [`Lua`] minted it so a key used with the wrong instance is rejected
//! with [`Error::MismatchedRegistryKey`].

use core::{
  fmt::{self, Debug, Formatter},
  ptr::eq,
};
use std::hash::{Hash, Hasher};

use crate::{
  error::{Error, Result},
  state::{
    Lua, LuaRef, get_field_named, pop_stack, set_field_named, unref_registry_slot,
    with_reference_pushed,
  },
  sync::{NOT_SYNC, NotSync, XRc},
  sys::LUA_REGISTRYINDEX,
  traits::{FromLua, IntoLua},
  value::Value,
};

/// An owned reference to a value stored in the Lua registry.
///
/// Mirrors `mlua::RegistryKey`. Cloning produces another handle to the **same**
/// stored value (the slot is shared via `Rc`). The value stays alive until the
/// last clone is dropped or it is explicitly removed.
///
/// Under the `send` feature it is `Send` but never `Sync` — see
/// `crate::sync::NotSync`.
#[derive(Clone)]
pub struct RegistryKey {
  pub(crate) reference: XRc<LuaRef>,
  pub(crate) _not_sync: NotSync,
}

impl RegistryKey {
  pub(crate) fn from_ref(reference: LuaRef) -> RegistryKey {
    RegistryKey {
      reference: XRc::new(reference),
      _not_sync: NOT_SYNC,
    }
  }
}

/// 注册表句柄家族的共用底座：`Table` / `Function` / `Thread` / `AnyUserData` /
/// `Buffer` / `LuaString` 六个 owning 句柄都以 `XRc<LuaRef>` 为唯一状态锚，
/// 同构的 push 样板在此单点泛型化（pure2-rt / pure3-rt 两批收口的残余）。
pub(crate) trait RegHandle {
  /// 句柄背后的注册表引用（owning VM 由 `XRc<LuaRef>` 链钉住）。
  fn reference(&self) -> &XRc<LuaRef>;

  /// Push this handle's value onto the owning state's stack.
  ///
  /// 纯逻辑层的 safe 封装：`reference.push()` 走 VM 侧 `lua_rawgeti`，其内部自带
  /// `ensure_stack(l, 1)` 保留这一层头寸（本仓库 VM 对上游"需调用方预留"的既定
  /// 偏离），调用方无须先 `ensure_stack`。owning VM 存活由句柄的 `XRc<LuaInner>`
  /// 保证；线程一致性沿用全 crate 的 move-not-share 纪律（与 `Lua::call` 等公开
  /// safe 方法同一前提），不是本函数独有的安全前提。
  fn push_to_stack(&self) {
    self.reference().push();
  }
}

impl Debug for RegistryKey {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    // Include the registry slot id so two keys referring to different slots
    // print differently (mlua's `RegistryKey` Debug exposes the slot too).
    write!(f, "RegistryKey({})", self.reference.id())
  }
}

// `RegistryKey` is usable as a hash-map key (mlua's `test_lua_registry_hash`).
// Identity is the (state, registry-slot) pair: a clone shares the same slot, so
// it hashes/compares equal; keys for distinct values use distinct slots.
impl PartialEq for RegistryKey {
  fn eq(&self, other: &Self) -> bool {
    eq(
      self.reference.state().as_ptr(),
      other.reference.state().as_ptr(),
    ) && self.reference.id() == other.reference.id()
  }
}

impl Eq for RegistryKey {}

impl Hash for RegistryKey {
  fn hash<H: Hasher>(&self, state: &mut H) {
    (self.reference.state().as_ptr() as usize).hash(state);
    self.reference.id().hash(state);
  }
}

/// 注册表名里出现 NUL 时的统一错误文案（`set`/`get` 两个入口共用）。
const REGISTRY_NAME_HAS_NUL_MSG: &str = "name contains a NUL byte";

/// 注册表名必须是 NUL 安全的单段键：`set_field_str`/`get_field_str` 走 VM 的
/// 长度感知写入，但一旦混入 NUL，同一名字会与上游以 NUL 截断的 C 字符串键
/// 语义混淆。两个入口共用本检查，避免同一约束写两遍。
fn check_registry_name(name: &str) -> Result<()> {
  if name.as_bytes().contains(&0) {
    return Err(Error::runtime(REGISTRY_NAME_HAS_NUL_MSG));
  }
  Ok(())
}

impl Lua {
  /// Store a value in the registry and return a [`RegistryKey`] that keeps it
  /// alive. Mirrors `mlua::Lua::create_registry_value`.
  pub fn create_registry_value(&self, value: impl IntoLua) -> Result<RegistryKey> {
    let v = value.into_lua(self)?;
    self.push_value(&v)?;
    Ok(RegistryKey::from_ref(self.pop_ref()))
  }

  /// Read back a value previously stored with [`Lua::create_registry_value`],
  /// converting it to `T`. Mirrors `mlua::Lua::registry_value`.
  pub fn registry_value<T: FromLua>(&self, key: &RegistryKey) -> Result<T> {
    if !self.owns_registry_value(key) {
      return Err(Error::MismatchedRegistryKey);
    }
    // 复用 `with_reference_pushed` 单源门面：压回登记引用 → 以绝对索引读值 → 弹回，
    // 「push/pop 栈配对」契约只在该门面书写一次，此处不再是手写 unsafe。
    let value = with_reference_pushed(&key.reference, |lua, idx| lua.value_from_stack(idx))?;
    T::from_lua(value, self)
  }

  /// Remove a value from the registry, releasing its slot. Mirrors
  /// `mlua::Lua::remove_registry_value`.
  pub fn remove_registry_value(&self, key: RegistryKey) -> Result<()> {
    if !self.owns_registry_value(&key) {
      return Err(Error::MismatchedRegistryKey);
    }
    // Dropping the key releases the underlying `lua_ref` slot.
    drop(key);
    Ok(())
  }

  /// Replace the value stored under an existing key. Mirrors
  /// `mlua::Lua::replace_registry_value`.
  ///
  /// 原地写回同一 `LuaRef` 槽位（unref 旧 id、ref 新值写回 `Cell`）而非
  /// 铸新句柄覆盖：`XRc<LuaRef>` 的全部克隆句柄即刻同见新值，且
  /// `state + slot id` 的键身份不变——`HashMap<RegistryKey, _>` 场景下
  /// 替换前后查找一致（旧实现铸新槽会令克隆句柄仍读旧值、键失配）。
  pub fn replace_registry_value(&self, key: &mut RegistryKey, value: impl IntoLua) -> Result<()> {
    if !self.owns_registry_value(key) {
      return Err(Error::MismatchedRegistryKey);
    }
    let v = value.into_lua(self)?;
    self.push_value(&v)?;
    let new_ref = self.pop_ref();
    let state = self.state();
    let new_id = new_ref.id();
    // 所有权转移：新槽 id 归 `key`。`new_ref` drop 的 unref 守卫（id > 0）
    // 在 id 置 0 后跳过，不会误释放新槽；`inner` 的引用计数照常释放。
    new_ref.set_id(0);
    let old_id = key.reference.id();
    key.reference.set_id(new_id);
    // `unref_registry_slot` 是带契约的 safe 门面（`lua_unref` 收口点）：`old_id` 是
    // `lua_ref` 登记且未释放的本 VM 注册表槽位（`owns_registry_value` 已确认归属），
    // `state` 存活——只释放该槽、不触碰栈。
    unref_registry_slot(state, old_id);
    Ok(())
  }

  /// Whether this `Lua` instance owns `key` (i.e. `key` was minted by this VM,
  /// not a different one). Mirrors `mlua::Lua::owns_registry_value`.
  pub fn owns_registry_value(&self, key: &RegistryKey) -> bool {
    // Two `Lua` handles share the same VM iff their inner state pointers are
    // equal (cloning a `Lua` shares the `Rc<LuaInner>`; a separate
    // `Lua::new()` has a distinct state).
    eq(key.reference.state().as_ptr(), self.state().as_ptr())
  }

  /// Expire any [`RegistryKey`]s whose strong handles have all been dropped.
  ///
  /// Mirrors `mlua::Lua::expire_registry_values`. ulua-rt releases a
  /// registry slot eagerly when the last clone of its `RegistryKey` is dropped
  /// (via `crate::state::LuaRef`'s `Drop` calling `lua_unref`), so there is
  /// no deferred-expiry queue to drain; this is a no-op kept for parity.
  pub fn expire_registry_values(&self) {}

  /// Store a value in the registry under the string `name`. Mirrors
  /// `mlua::Lua::set_named_registry_value`.
  pub fn set_named_registry_value(&self, name: &str, value: impl IntoLua) -> Result<()> {
    check_registry_name(name)?;
    let v = value.into_lua(self)?;
    let state = self.state();
    // `push_value` 成功后栈顶多一个值（失败时 `?` 先返回，VM 不会见到缺参的栈）。
    self.push_value(&v)?;
    // `set_field_named` 是带契约的 safe 门面（`(*state).set_field_str` 收口点）：`state`
    // 存活；按约定 pop 掉刚压入的栈顶值（写 registry[name]=value），一压一消栈平衡。
    set_field_named(state, LUA_REGISTRYINDEX, name);
    Ok(())
  }

  /// Read back a value previously stored with
  /// [`Lua::set_named_registry_value`], converting it to `T`. A name that was
  /// never set (or was unset) reads back as `nil`. Mirrors
  /// `mlua::Lua::named_registry_value`.
  pub fn named_registry_value<T: FromLua>(&self, name: &str) -> Result<T> {
    check_registry_name(name)?;
    let state = self.state();
    // `get_field_named` 是带契约的 safe 门面（`(*state).get_field_str` 收口点）：`state`
    // 存活；总把一个值（未设置时为 nil）压到栈顶，边界只此一处。
    get_field_named(state, LUA_REGISTRYINDEX, name);
    // 栈顶即该值：`value_from_stack`（safe 门面）读取它，其后 `pop_stack`（safe 门面）
    // 弹回平衡栈。读回即使返回 `Err` 也先弹栈再经 `?` 传播，栈恒平衡（与原块内顺序一致）。
    let read = self.value_from_stack(-1);
    pop_stack(state, 1);
    let value = read?;
    T::from_lua(value, self)
  }

  /// Remove a value stored under the string `name`. Mirrors
  /// `mlua::Lua::unset_named_registry_value`.
  pub fn unset_named_registry_value(&self, name: &str) -> Result<()> {
    self.set_named_registry_value(name, Value::Nil)
  }
}

// ---------------------------------------------------------------------------
// Conversions: a RegistryKey behaves like the value it stores when packed, and
// `Chunk::eval::<RegistryKey>()` stores the chunk's result.
// ---------------------------------------------------------------------------

impl IntoLua for RegistryKey {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    (&self).into_lua(lua)
  }
}

impl IntoLua for &RegistryKey {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    if !eq(self.reference.state().as_ptr(), lua.state().as_ptr()) {
      return Err(Error::MismatchedRegistryKey);
    }
    // 同 `registry_value`：走 `with_reference_pushed` 门面，成功/失败皆弹回压入层，
    // 消旧实现手写 push/pop 且读值报错时把值漏在栈上的不平衡（wrong-Lua 已在上方
    // 早返回，不经过此路径）。
    with_reference_pushed(&self.reference, |lua, idx| lua.value_from_stack(idx))
  }
}

impl FromLua for RegistryKey {
  fn from_lua(value: Value, lua: &Lua) -> Result<Self> {
    lua.create_registry_value(value)
  }
}
