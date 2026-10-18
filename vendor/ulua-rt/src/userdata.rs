//! [`UserData`] / [`UserDataMethods`] / [`UserDataFields`] and the
//! [`AnyUserData`] handle. Mirrors `mlua::UserData` / `mlua::UserDataMethods` /
//! `mlua::UserDataFields` / `mlua::AnyUserData`.
//!
//! ## Implementation
//!
//! A `T: UserData` value is boxed into a Lua userdata as a typed wrapper
//! [`DataCell<T>`] = `{ key: CellKey, RefCell<Option<T>> }` (via
//! [`lua_newuserdatadtor`], whose destructor drops the cell). The leading
//! `CellKey` (a `TypeId` for ordinary userdata, a unique marker for scope-
//! created userdata) makes Rust-side typed read-back **sound**: every accessor
//! ([`AnyUserData::borrow`], [`borrow_mut`](AnyUserData::borrow_mut),
//! [`take`](AnyUserData::take), [`is`](AnyUserData::is)) first checks the
//! payload **length** (a script can hand us a zero-length `newproxy()`
//! userdata — see `checked_payload`) and then reads the stored `TypeId` from
//! the userdata pointer and compares it with `TypeId::of::<T>()` before
//! downcasting — either failure is an [`Error::UserDataTypeMismatch`].
//! `take` replaces the `Option<T>` with `None`; subsequent access reports
//! [`Error::UserDataDestructed`].
//!
//! Each registered method/field is compiled into a Rust closure wired into a
//! per-instance metatable:
//!   - ordinary methods go into a method table,
//!   - field getters/setters are dispatched by an `__index`/`__newindex`
//!     function (only when fields are registered),
//!   - meta-methods (e.g. `__add`) go directly on the metatable.

use core::{
  fmt::{self, Debug, Display, Formatter},
  mem::{align_of, size_of},
  ops::{Deref, DerefMut},
  ptr::{NonNull, drop_in_place},
};
use std::{
  any::TypeId,
  cell::{Ref, RefCell, RefMut},
  marker::PhantomData,
  sync::atomic::{AtomicU64, Ordering},
};

use crate::{
  error::{Error, Result},
  function::Function,
  multi::MultiValue,
  registry::RegHandle,
  state::{
    Lua, LuaRef, StateView, allocate_userdata, is_userdata_at, pop_stack, set_metatable_at,
    slot_length, slots_equal, userdata_at, with_reference_pushed,
  },
  sync::{MaybeSend, MaybeSync, NOT_SYNC, NotSync, XRc},
  sys::*,
  table::Table,
  traits::{FromLua, FromLuaMulti, IntoLua, IntoLuaMulti},
  value::Value,
};

/// A Rust type that can be exposed to Lua as userdata.
///
/// Mirrors `mlua::UserData`. Implement [`UserData::add_methods`] and/or
/// [`UserData::add_fields`] to register the surface visible from Lua.
///
/// **对齐约束**：值被原地写进 Luau userdata 的载荷，而载荷只保证 8 字节对齐
/// （上游 cpp/VM/src/lobject.h 的 `Udata::data` 是 `alignas(8)`），因此 `Self`
/// 的对齐不得超过 8。含 `u128` 或 `#[repr(align(16))]` 的类型在 SysV
/// x86_64/aarch64 上会违反它——由 `alloc_cell` 里的编译期断言拦下。
pub trait UserData: Sized {
  /// Register fields (getters/setters). Default: none.
  fn add_fields<F: UserDataFields<Self>>(_fields: &mut F) {}

  /// Register methods and meta-methods. Default: none.
  fn add_methods<M: UserDataMethods<Self>>(_methods: &mut M) {}
}

/// Registrar passed to [`UserData::add_methods`].
///
/// Mirrors `mlua::UserDataMethods`.
pub trait UserDataMethods<T> {
  /// Register a method callable as `obj:name(...)`; receives `&T`.
  fn add_method<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti;

  /// Register a method callable as `obj:name(...)`; receives `&mut T`.
  fn add_method_mut<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti;

  /// Register a plain function in the userdata namespace (no `self`).
  fn add_function<F, A, R>(&mut self, name: impl Into<String>, function: F)
  where
    F: Fn(&Lua, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti;

  /// Register a meta-method (e.g. `MetaMethod::Add`, `"__tostring"`);
  /// receives `&T`.
  fn add_meta_method<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti;

  /// Register a meta-method receiving `&mut T`.
  fn add_meta_method_mut<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti;
}

/// Registrar passed to [`UserData::add_fields`].
///
/// Mirrors `mlua::UserDataFields`. Field getters/setters are dispatched by the
/// userdata's `__index`/`__newindex`.
pub trait UserDataFields<T> {
  /// Register a constant field value (read-only).
  fn add_field<V>(&mut self, name: impl Into<String>, value: V)
  where
    V: IntoLua + Clone + MaybeSend + 'static;

  /// Register a field whose getter receives `&T`.
  fn add_field_method_get<M, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T) -> Result<R> + MaybeSend + 'static,
    R: IntoLua;

  /// Register a field whose setter receives `&mut T` and the assigned value.
  fn add_field_method_set<M, A>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<()> + MaybeSend + 'static,
    A: FromLua;

  /// Register a field whose getter receives the [`AnyUserData`] handle.
  fn add_field_function_get<F, R>(&mut self, name: impl Into<String>, function: F)
  where
    F: Fn(&Lua, AnyUserData) -> Result<R> + MaybeSend + 'static,
    R: IntoLua;
}

/// A handle to an arbitrary Lua userdata value.
///
/// Mirrors `mlua::AnyUserData`. Supports construction, use-from-Lua, and typed
/// Rust-side borrowing ([`borrow`](AnyUserData::borrow) /
/// [`borrow_mut`](AnyUserData::borrow_mut) / [`take`](AnyUserData::take) /
/// [`is`](AnyUserData::is)).
#[derive(Clone)]
pub struct AnyUserData {
  pub(crate) reference: XRc<LuaRef>,
  pub(crate) _not_sync: NotSync,
}

impl AnyUserData {
  pub(crate) fn from_ref(reference: LuaRef) -> AnyUserData {
    AnyUserData {
      reference: XRc::new(reference),
      _not_sync: NOT_SYNC,
    }
  }

  /// The owning [`Lua`].
  pub fn lua(&self) -> Lua {
    self.reference.lua()
  }

  /// A raw pointer identifying this userdata. Mirrors
  /// `mlua::AnyUserData::to_pointer`.
  pub fn to_pointer(&self) -> *const c_void {
    self.reference.to_pointer()
  }

  /// Compare for equality honoring an `__eq` metamethod.
  /// Mirrors `mlua::AnyUserData::equals`.
  pub fn equals(&self, other: &AnyUserData) -> Result<bool> {
    let lua = self.lua();
    let state = lua.state();
    // 两句柄同属该 VM 由 move-not-share 的句柄纪律约束（跨 VM 混用无运行时校验，
    // 同 `set_globals`）；`reference.push()`（safe fn）落到 `lua_rawgeti`，其 VM 侧
    // 先自预留栈位（预留失败走 VM 错误路径，不产生越栈写），注册表 id 在
    // `Drop::lua_unref` 前恒指实槽位。
    self.reference.push();
    other.reference.push();
    // `slots_equal`（state.rs 的 safe 门面族成员）：`state` 存活（self 的
    // `XRc<LuaInner>` 保活）；上两行各压一层，故 -2/-1 正指两值；比较只做
    // 只读（可触发 `__eq`，但那是 VM 内部受保护路径）、不写栈。
    let eq = slots_equal(state, -2, -1);
    // 栈上有两行 push 的两层，`pop_stack`（safe 门面）弹回，净栈变化为零。
    pop_stack(state, 2);
    Ok(eq)
  }

  /// Recover a `&DataCell<T>` from the userdata storage, checking the
  /// embedded `CellKey`. Returns `UserDataTypeMismatch` if the concrete type
  /// differs.
  fn cell<T: 'static>(&self) -> Result<&DataCell<T>> {
    // `with_reference_pushed` 是安全门面：引用存活由句柄链的 `XRc<LuaInner>` 保证。
    with_reference_pushed(&self.reference, |lua, idx| {
      // `data_cell` 是带契约的 safe 门面：槽内是 userdata 值，先过「userdata
      // 类型 + 载荷长度 ≥ `DataCell<T>` + `CellKey` 相等」三道闸门才下转；key
      // 正是 `TypeId::of::<T>()`。返回引用指向 userdata 内联载荷，由注册表引用
      // 钉住、GC 不移动，弹出栈槽后仍在 `&self` 借用期内有效。
      data_cell(lua.state(), idx, CellKey::Typed(TypeId::of::<T>()))
    })
  }

  /// Whether the stored value is of concrete type `T`. Mirrors
  /// `mlua::AnyUserData::is`. Returns `false` after the value has been taken.
  pub fn is<T: 'static>(&self) -> bool {
    match self.cell::<T>() {
      Ok(cell) => cell.cell.borrow().is_some(),
      Err(_) => false,
    }
  }

  /// The [`TypeId`] of the stored value, if it is an ordinary ulua-rt
  /// userdata. Mirrors `mlua::AnyUserData::type_id` (returns the concrete
  /// `TypeId` whenever the userdata carries a ulua-rt typed header; scope-
  /// created userdata carry only a unique marker, so this returns `None`).
  pub fn type_id(&self) -> Option<TypeId> {
    // `with_reference_pushed` 是安全门面：引用存活由句柄链的 `XRc<LuaInner>` 保证。
    with_reference_pushed(&self.reference, |lua, idx| {
      // `data_header` 是带契约的 safe 门面：只有过长度闸门才按 `#[repr(C)]`
      // 头（offset 0 的 key）读标记；比对垃圾位值只在出块后做整数比较。槽由
      // 上一行的门面压入、由注册表引用锚定 userdata 在世，读取期间该槽稳定。
      data_header(lua.state(), idx)
        // 只有本 crate 分配的 userdata 带 header；未过闸门的载荷一律按
        // 「不是 ulua-rt userdata」处理（`None`），与 `is()` 的判定一致。
        // 纯 Rust：按值拷出 `TypeId`，出块后无栈/对象依赖。
        .and_then(|header| match header.key {
          CellKey::Typed(id) => Some(id),
          CellKey::Scoped(_) => None,
        })
    })
  }

  /// Immutably borrow the stored value as `T`. Mirrors
  /// `mlua::AnyUserData::borrow`. Errors with [`Error::UserDataTypeMismatch`]
  /// on a type mismatch, [`Error::UserDataDestructed`] if it was taken, or
  /// [`Error::UserDataBorrowError`] if already mutably borrowed.
  pub fn borrow<T: 'static>(&self) -> Result<UserDataRef<'_, T>> {
    let cell = self.cell::<T>()?;
    let guard = cell
      .cell
      .try_borrow()
      .map_err(|_| Error::UserDataBorrowError)?;
    if guard.is_none() {
      return Err(Error::UserDataDestructed);
    }
    Ok(UserDataRef {
      guard,
      _marker: PhantomData,
    })
  }

  /// Mutably borrow the stored value as `T`. Mirrors
  /// `mlua::AnyUserData::borrow_mut`.
  pub fn borrow_mut<T: 'static>(&self) -> Result<UserDataRefMut<'_, T>> {
    let cell = self.cell::<T>()?;
    let guard = cell
      .cell
      .try_borrow_mut()
      .map_err(|_| Error::UserDataBorrowMutError)?;
    if guard.is_none() {
      return Err(Error::UserDataDestructed);
    }
    Ok(UserDataRefMut {
      guard,
      _marker: PhantomData,
    })
  }

  /// Take the stored value out of the userdata, leaving it destructed.
  /// Mirrors `mlua::AnyUserData::take`. Errors with
  /// [`Error::UserDataBorrowMutError`] if currently borrowed, or
  /// [`Error::UserDataDestructed`] if already taken.
  pub fn take<T: 'static>(&self) -> Result<T> {
    let cell = self.cell::<T>()?;
    let mut guard = cell
      .cell
      .try_borrow_mut()
      .map_err(|_| Error::UserDataBorrowMutError)?;
    guard.take().ok_or(Error::UserDataDestructed)
  }
}

/// A RAII guard for an immutable userdata borrow ([`AnyUserData::borrow`]).
/// Mirrors `mlua::UserDataRef`.
pub struct UserDataRef<'a, T> {
  guard: Ref<'a, Option<T>>,
  _marker: PhantomData<T>,
}

impl<T> Deref for UserDataRef<'_, T> {
  type Target = T;
  fn deref(&self) -> &T {
    // 构造期不变式：`borrow` 仅在 option 为 Some 时返回守卫，panic 不可达。
    self.guard.as_ref().expect("userdata destructed")
  }
}

impl<T: Debug> Debug for UserDataRef<'_, T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Debug::fmt(&**self, f)
  }
}

impl<T: Display> Display for UserDataRef<'_, T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Display::fmt(&**self, f)
  }
}

/// A RAII guard for a mutable userdata borrow ([`AnyUserData::borrow_mut`]).
/// Mirrors `mlua::UserDataRefMut`.
pub struct UserDataRefMut<'a, T> {
  guard: RefMut<'a, Option<T>>,
  _marker: PhantomData<T>,
}

impl<T> Deref for UserDataRefMut<'_, T> {
  type Target = T;
  fn deref(&self) -> &T {
    // 构造期不变式：borrow_mut 仅在槽位为 Some 时才产出守卫（同 UserDataRef::deref），panic 不可达。
    self.guard.as_ref().expect("userdata destructed")
  }
}

impl<T> DerefMut for UserDataRefMut<'_, T> {
  fn deref_mut(&mut self) -> &mut T {
    // 同上：守卫存活期内 Some 不变（take 需先结束借用），不可达。
    self.guard.as_mut().expect("userdata destructed")
  }
}

impl<T: Debug> Debug for UserDataRefMut<'_, T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Debug::fmt(&**self, f)
  }
}

impl<T: Display> Display for UserDataRefMut<'_, T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    Display::fmt(&**self, f)
  }
}

impl RegHandle for AnyUserData {
  fn reference(&self) -> &XRc<LuaRef> {
    &self.reference
  }
}

impl Debug for AnyUserData {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "UserData")
  }
}

impl PartialEq for AnyUserData {
  fn eq(&self, other: &Self) -> bool {
    // Pointer identity (matches mlua): same underlying userdata object.
    self.to_pointer() == other.to_pointer()
  }
}

// Any `T: UserData` value converts into Lua by wrapping it in a fresh userdata.
// Mirrors mlua's `impl<T: UserData + MaybeSend + MaybeSync + 'static> IntoLua`.
// This is what lets `create_registry_value(MyUserdata(..))`,
// `table.set("k", MyUserdata(..))`, etc. accept a userdata value directly. It
// coexists with the concrete handle impls produced by
// `conversion.rs::impl_lua_handle!` because none of those (local) types
// implement `UserData`.
impl<T: UserData + MaybeSend + MaybeSync + 'static> IntoLua for T {
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    Ok(Value::UserData(lua.create_userdata(self)?))
  }
}

// ---------------------------------------------------------------------------
// Typed userdata storage
// ---------------------------------------------------------------------------

/// The key tagging a ulua-rt userdata cell:
/// - `Typed(TypeId)` — ordinary userdata; supports sound typed read-back
///   ([`AnyUserData::borrow`] / [`borrow_mut`](AnyUserData::borrow_mut) /
///   [`take`](AnyUserData::take) / [`is`](AnyUserData::is)), requires
///   `T: 'static`.
/// - `Scoped(u64)` — scope-created userdata wrapping a non-`'static` `T`;
///   carries a process-unique marker instead (markers are never reused, so a
///   key match proves the userdata is a `DataCell<T>` for exactly one `T`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum CellKey {
  Typed(TypeId),
  Scoped(u64),
}

/// The fixed leading layout of every ulua-rt userdata wrapper. Reading the
/// `CellKey` through this header (a prefix of [`DataCell<T>`]) lets us verify
/// the concrete type before downcasting. Both share `#[repr(C)]` so the `key`
/// field is at offset 0 for any `T`.
#[repr(C)]
struct DataHeader {
  key: CellKey,
}

/// The userdata storage: a [`CellKey`] followed by the `RefCell<Option<T>>`.
#[repr(C)]
struct DataCell<T> {
  key: CellKey,
  cell: RefCell<Option<T>>,
}

/// `idx` 处栈值必须是 userdata、且其载荷长度至少覆盖 `size`，此时返回裸载荷
/// 指针；否则返回 `None`。
///
/// 这道闸门是**必需**的：脚本可以造出载荷长度为 0 的 userdata
/// （`newproxy()` → `lua_newuserdatatagged(L, 0, UTAG_PROXY)`，
/// cpp/VM/src/lbaselib.cpp:407-420，本仓库移植
/// `crates/ulua-vm/src/functions/lua_b_newproxy.rs`），并把它传给任何接收
/// `AnyUserData` 的回调；未过闸门就按 `DataHeader`/`DataCell<T>` 解读裸指针
/// 即越界读（`take` 路径还会越界写）。与 `callback.rs` 里 wrapped-error 的
/// 既有闸门同构。
///
/// 返回值用 `Option<NonNull<c_void>>` 而非「`*mut` + null 哨兵」：非空性由类型
/// 表达，下游无需再判空。
///
/// 调用序契约（正确性，非内存安全）：`state` 存活且由当前线程驱动、`idx` 是其上
/// 有效栈索引。与 `state.rs` 门面族同范式：三道闸门全是 `idx` 槽上的只读查询，
/// `unsafe` 已内聚在 `is_userdata_at`/`slot_length`/`userdata_at` 门面体内，本
/// 函数与调用点均无需再论证。
fn checked_payload(state: StateView<'_>, idx: i32, size: usize) -> Option<NonNull<c_void>> {
  // `LuaState::obj_len` 对 userdata 返回存储长度（`lua_newuserdatadtor` 会在其后
  // 附加 dtor 指针，所以本 crate 自己的 userdata 总是比 `DataCell<T>` 更宽）；
  // 长度不足直接拒。
  let ok = is_userdata_at(state, idx) && slot_length(state, idx) >= size;
  if !ok {
    return None;
  }
  // 缺失（非 userdata）或 null 载荷由 `Option` 归一为 `None`（判空哨兵就此消失）。
  // 本函数只返回裸指针，解引用一律发生在下游按 `size` 覆盖校验之后。
  userdata_at(state, idx)
}

/// 首次初始化一枚 [`alloc_userdata_slot`] 交还的未写载荷槽（`ptr::write` 的全 crate
/// 唯一收口点：async / callback / exec_raw / `alloc_cell` 四类载荷共用）。
///
/// `// Safety` 只在此论证一次：`slot` 由 `alloc_userdata_slot::<T>` 交出，非空且
/// 覆盖恰 `size_of::<T>()` 字节、对齐 ≤8（其 `AlignOk` 编译期断言把住）、尚未
/// 初始化；`write` 是首次初始化（不泄漏旧值），之后所有权移交该 userdata，由同
/// 单态化 dtor 恰 drop 一次。写入本身是纯移动、不可失败，故本函数是 safe。
#[inline]
pub(crate) fn init_userdata_slot<T>(slot: NonNull<T>, value: T) {
  // Safety: 见函数头——非空、覆盖 `size_of::<T>()`、未初始化、对齐由 `AlignOk` 闸门保证。
  unsafe { slot.as_ptr().write(value) };
}

/// 把 `idx` 处栈槽的 userdata 载荷**类型化下转**为 `&'a T`（safe 门面）：
/// [`checked_payload`] 三道闸门（userdata 类型 / 载荷非空 / 长度覆盖 `T`）+
/// `AlignOk::<T>` 编译期对齐闸门，全 crate「按 `T` 解读已过闸门载荷」这一处
/// 裸指针边界的两个收口点之一（另一个是 [`typed_userdata_mut`]）。
///
/// 调用序契约（正确性，非内存安全）：`state` 存活且由当前线程驱动、`idx` 是其上
/// 有效栈索引；返回引用的生命周期由调用方保证——该 userdata 在期内被栈槽/注册表
/// 引用钉住、GC 不移动 userdata（与 [`data_header`] 同范式）；`T` 必须是该槽
/// 实际写入的载荷类型（各 trampoline 与写入方同单态化配对）。
pub(crate) fn typed_userdata<'a, T>(state: StateView<'_>, idx: i32) -> Option<&'a T> {
  let _: () = AlignOk::<T>::CHECK;
  let payload = checked_payload(state, idx, size_of::<T>())?;
  // Safety: 闸门保证载荷非空且覆盖整个 `T`；`AlignOk` 编译期排除对齐 >8 的类型，
  // 与 userdata 载荷 `alignas(8)` 相容；类型配对与引用存活由函数头契约限定。
  Some(unsafe { payload.cast::<T>().as_ref() })
}

/// [`typed_userdata`] 的可变版本（`as_mut` 收口点）。
///
/// 调用序契约额外要求：`T` 内含 `Cell`/`RefCell` 或调用方保证无并存别名
/// （现用点：async upvalue 的 tag 校验、`destruct_callback` 的 scope 退出单线程
/// 取盒，均满足）。
pub(crate) fn typed_userdata_mut<'a, T>(state: StateView<'_>, idx: i32) -> Option<&'a mut T> {
  let _: () = AlignOk::<T>::CHECK;
  let payload = checked_payload(state, idx, size_of::<T>())?;
  // Safety: 同 [`typed_userdata`]；无并存别名前提由函数头契约限定。
  Some(unsafe { payload.cast::<T>().as_mut() })
}

/// 读取 `idx` 处 userdata 的 [`DataHeader`]（只过长度闸门）。
///
/// 调用序契约（正确性，非内存安全）：除 [`checked_payload`] 的前提外，返回引用
/// 的生命周期必须由调用方保证——该 userdata 在期内被 registry 引用钉住、且 GC
/// 不会移动 userdata。
fn data_header<'a>(state: StateView<'_>, idx: i32) -> Option<&'a DataHeader> {
  // `typed_userdata` 收口全部闸门 + 裸指针边界；`DataHeader` 是任意
  // `DataCell<T>` 的 `#[repr(C)]` 公共前缀，比对垃圾位值只做整数比较。
  typed_userdata::<DataHeader>(state, idx)
}

/// 把 `idx` 处栈值的 userdata 载荷下转成 `&DataCell<T>`，先过长度闸门、再比对
/// 期望的 [`CellKey`]；任一不合格都是 [`Error::UserDataTypeMismatch`]。
///
/// 调用序契约（正确性，非内存安全）：同 [`data_header`]；`key` 必须是对应 `T`
/// 的真实键（`Typed(TypeId::of::<T>())` 或该 `T` 被分配时发放的 `Scoped` 标记）。
fn data_cell<'a, T>(state: StateView<'_>, idx: i32, key: CellKey) -> Result<&'a DataCell<T>> {
  // `typed_userdata` 收口三道闸门 + `AlignOk` + 唯一的 `cast`/`as_ref` 边界；
  // 键不等即拒绝，杜绝把 A 类型载荷按 `DataCell<B>` 读出。`RefCell` 守卫生命周期
  // 内的可变别名；存活前提同 [`data_header`]。
  let cell = typed_userdata::<DataCell<T>>(state, idx).ok_or(Error::UserDataTypeMismatch)?;
  if cell.key != key {
    return Err(Error::UserDataTypeMismatch);
  }
  Ok(cell)
}

/// Recover `&DataCell<T>` from a `self` userdata [`Value`] (Lua argument 1),
/// verifying the embedded `CellKey`.
///
/// For `CellKey::Typed` the stored `TypeId` must equal `TypeId::of::<T>()`; for
/// `CellKey::Scoped` the caller guarantees the marker was minted for exactly
/// this `T` (which holds because each marker is handed out to exactly one
/// `create_scoped_userdata::<T>` call). A mismatch is an
/// [`Error::UserDataTypeMismatch`].
fn recover_cell<T>(value: &Value, key: CellKey) -> Result<&DataCell<T>> {
  let Value::UserData(ud) = value else {
    return Err(Error::UserDataTypeMismatch);
  };
  // `with_reference_pushed` 是安全门面：`ud` 来自本回调的 `Value::UserData`，其
  // `LuaRef` 持注册表引用、内 `XRc<LuaInner>` 保 `state` 存活。
  with_reference_pushed(&ud.reference, |lua, idx| {
    // `data_cell`（带契约的 safe 门面）的三道闸门与 `key` 真实性前提由函数头
    // 与调用链（`cell_function` 以分配时同一 marker/TypeId 传入）凑齐；返回引用
    // 指向被注册表引用钉住、GC 不移动的 userdata 内联载荷。
    data_cell(lua.state(), idx, key)
  })
}

/// 「弹出 self → 校验 CellKey 取 cell → 调 `invoke`」的公共回调壳。
/// 方法/meta-method（共享与可变借用）与字段 getter/setter 共用，
/// 收敛原先四处重复的样板。直接产出 [`Function`]（单态化 trampoline，无 dyn
/// 类型擦除）；创建失败（仅可能是回调 userdata 分配失败）由调用方
/// [`Collector::record`] 记录、在建元表前统一上报。
fn cell_function<T, I>(lua: &Lua, key: CellKey, invoke: I) -> Result<Function>
where
  I: Fn(&Lua, &DataCell<T>, MultiValue) -> Result<MultiValue> + MaybeSend + 'static,
{
  lua.create_function(move |lua, mut args: MultiValue| {
    let this = args.pop_front().unwrap_or(Value::Nil);
    let cell = recover_cell::<T>(&this, key)?;
    invoke(lua, cell, args)
  })
}

// ---------------------------------------------------------------------------
// Method collection
// ---------------------------------------------------------------------------

/// recover 后的 cell 上不可变借用并跑 `f`。`f` 返回时借用即释放（与内联写法
/// 的 NLL 作用域一致：`into_lua_multi` 等后处理不在借用期内）。
fn with_borrowed<T, R>(cell: &DataCell<T>, f: impl FnOnce(&T) -> Result<R>) -> Result<R> {
  let borrowed = cell
    .cell
    .try_borrow()
    .map_err(|_| Error::UserDataBorrowError)?;
  let data = borrowed.as_ref().ok_or(Error::UserDataDestructed)?;
  f(data)
}

/// [`with_borrowed`] 的可变版。
fn with_borrowed_mut<T, R>(cell: &DataCell<T>, f: impl FnOnce(&mut T) -> Result<R>) -> Result<R> {
  let mut borrowed = cell
    .cell
    .try_borrow_mut()
    .map_err(|_| Error::UserDataBorrowMutError)?;
  let data = borrowed.as_mut().ok_or(Error::UserDataDestructed)?;
  f(data)
}

impl<T> Collector<'_, T> {
  /// 注册一个方法/meta-method（`&T` 借用版）：`add_method` /
  /// `add_meta_method` 共用。
  fn push_method<M, A, R>(&mut self, name: impl Into<String>, is_meta: bool, method: M)
  where
    M: Fn(&Lua, &T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    let res = cell_function(self.lua, self.key, move |lua, cell, args| {
      let a = A::from_lua_multi(args, lua)?;
      with_borrowed(cell, |data| method(lua, data, a))?.into_lua_multi(lua)
    });
    self.push_registered(name, is_meta, res);
  }

  /// [`push_method`] 的 `&mut T` 版：`add_method_mut` / `add_meta_method_mut`
  /// 共用。
  fn push_method_mut<M, A, R>(&mut self, name: impl Into<String>, is_meta: bool, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    let res = cell_function(self.lua, self.key, move |lua, cell, args| {
      let a = A::from_lua_multi(args, lua)?;
      with_borrowed_mut(cell, |data| method(lua, data, a))?.into_lua_multi(lua)
    });
    self.push_registered(name, is_meta, res);
  }

  /// 注册一个已建好的字段访问 [`Function`]（字段系 add_* 共用样板）。
  fn push_field(&mut self, name: impl Into<String>, is_get: bool, res: Result<Function>) {
    match res {
      Ok(func) => self.fields.push(FieldEntry {
        name: name.into(),
        is_get,
        func,
      }),
      Err(e) => self.record(e),
    }
  }

  /// 记录首个创建错误（分配失败才可能触发）；建元表前由 [`Collector::check`] 统一上报。
  fn record(&mut self, err: Error) {
    if self.err.is_none() {
      self.err = Some(err);
    }
  }

  /// 把已建好的方法 [`Function`] 收入注册表（push_method / push_method_mut /
  /// add_function 三处共用样板）。
  fn push_registered(&mut self, name: impl Into<String>, is_meta: bool, res: Result<Function>) {
    match res {
      Ok(func) => self.methods.push(Registered {
        name: name.into(),
        is_meta,
        func,
      }),
      Err(e) => self.record(e),
    }
  }

  /// 取出记录的错误；注册器 API 返回 `()`，无法逐调用传播，故延后到此。
  fn check(&mut self) -> Result<()> {
    match self.err.take() {
      Some(e) => Err(e),
      None => Ok(()),
    }
  }
}

/// A registered method or meta-method, paired with its name and whether it is a
/// meta-method.
struct Registered {
  name: String,
  is_meta: bool,
  func: Function,
}

/// A registered field getter or setter.
struct FieldEntry {
  name: String,
  /// `true` if a getter, `false` if a setter.
  is_get: bool,
  func: Function,
}

/// Concrete [`UserDataMethods`] / [`UserDataFields`] implementation that
/// compiles each registration into a [`Function`] on the spot (the callback
/// trampoline is monomorphized per closure type — no type-erased boxes are
/// stored). The metatable is built from the collected handles. The [`CellKey`]
/// decides typed (TypeId) vs scoped (marker) cell recovery, so one impl set
/// serves both ordinary and scope-created userdata.
struct Collector<'lua, T> {
  lua: &'lua Lua,
  key: CellKey,
  methods: Vec<Registered>,
  fields: Vec<FieldEntry>,
  /// 首个 Function 创建错误（trampoline 注册器 API 无 Result，只能延后上报）。
  err: Option<Error>,
  _phantom: PhantomData<T>,
}

impl<'lua, T> Collector<'lua, T> {
  fn new(lua: &'lua Lua, key: CellKey) -> Self {
    Collector {
      lua,
      key,
      methods: Vec::new(),
      fields: Vec::new(),
      err: None,
      _phantom: PhantomData,
    }
  }
}

impl<T> UserDataMethods<T> for Collector<'_, T> {
  fn add_method<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.push_method(name, false, method);
  }

  fn add_method_mut<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.push_method_mut(name, false, method);
  }

  fn add_function<F, A, R>(&mut self, name: impl Into<String>, function: F)
  where
    F: Fn(&Lua, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.push_registered(name, false, self.lua.create_function(function));
  }

  fn add_meta_method<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.push_method(name, true, method);
  }

  fn add_meta_method_mut<M, A, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.push_method_mut(name, true, method);
  }
}

impl<T> UserDataFields<T> for Collector<'_, T> {
  fn add_field<V>(&mut self, name: impl Into<String>, value: V)
  where
    V: IntoLua + Clone + MaybeSend + 'static,
  {
    let res = self.lua.create_function(move |lua, _args: MultiValue| {
      let v = value.clone().into_lua(lua)?;
      v.into_lua_multi(lua)
    });
    self.push_field(name, true, res);
  }

  fn add_field_method_get<M, R>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &T) -> Result<R> + MaybeSend + 'static,
    R: IntoLua,
  {
    let res = cell_function(self.lua, self.key, move |lua, cell, _args| {
      with_borrowed(cell, |data| method(lua, data))?.into_lua_multi(lua)
    });
    self.push_field(name, true, res);
  }

  fn add_field_method_set<M, A>(&mut self, name: impl Into<String>, method: M)
  where
    M: Fn(&Lua, &mut T, A) -> Result<()> + MaybeSend + 'static,
    A: FromLua,
  {
    let res = cell_function(self.lua, self.key, move |lua, cell, mut args| {
      let val = A::from_lua(args.pop_front().unwrap_or(Value::Nil), lua)?;
      with_borrowed_mut(cell, |data| method(lua, data, val))?;
      ().into_lua_multi(lua)
    });
    self.push_field(name, false, res);
  }

  fn add_field_function_get<F, R>(&mut self, name: impl Into<String>, function: F)
  where
    F: Fn(&Lua, AnyUserData) -> Result<R> + MaybeSend + 'static,
    R: IntoLua,
  {
    let res = self.lua.create_function(move |lua, mut args: MultiValue| {
      let this = args.pop_front().unwrap_or(Value::Nil);
      let ud = AnyUserData::from_lua(this, lua)?;
      let r = function(lua, ud)?;
      r.into_lua_multi(lua)
    });
    self.push_field(name, true, res);
  }
}

/// Destructor for the [`DataCell<T>`] stored inside the userdata (both ordinary
/// and scope-created userdata share the same layout).
///
/// # Safety
/// 仅由 VM 作为 `lua_newuserdatadtor` 注册的终结器调用：`ptr` 必须为 null，或
/// 指向 `alloc_cell::<T>` 按同一 `T` 单态化写入、尚未 drop 的载荷（长度覆盖
/// `DataCell<T>`，`AlignOk` 编译期已断言对齐）；VM 保证其恰被调用一次。
unsafe extern "C-unwind" fn data_dtor<T>(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: `ptr` 由 VM 在终结此 userdata 时传入，只能是
    // `lua_newuserdatadtor(size_of::<DataCell<T>>(), data_dtor::<T>)` 配对的
    // 载荷地址（`alloc_cell` 单态化写死同一 `T`，装箱与析构共享单态化）：
    // 长度覆盖 `DataCell<T>`、载荷 `alignas(8)` 且 `AlignOk` 编译期已断言
    // 对齐；`drop_in_place` 与 `alloc_cell` 的 `write` 一一配对，VM 保证
    // 终结器恰调用一次且此时无 Rust 侧 `&DataCell` 存活（借用只在回调
    // 栈内，终结发生在 GC 回收路径）。
    unsafe { drop_in_place(ptr.cast::<DataCell<T>>()) };
  }
}

// ---------------------------------------------------------------------------
// Scoped (non-'static) userdata — used by `Lua::scope`
// ---------------------------------------------------------------------------
//
// Ordinary userdata stores a `TypeId` so values can be soundly read back out by
// concrete type (`borrow`/`take`/`is`). That requires `T: 'static`.
//
// A scope can create userdata wrapping a **non-`'static`** `T` (e.g. one that
// borrows from the enclosing stack frame). For these there is no `TypeId`, so
// instead each scoped userdata is tagged with a process-unique `u64` **marker**
// ([`CellKey::Scoped`]). Every method/field/meta closure for that userdata
// captures the *same* marker, so on dispatch it can confirm the `self` it
// received is exactly the userdata it belongs to (recovering `&DataCell<T>` is
// sound only after the marker matches — markers are never reused, so no other
// userdata can collide).
//
// Soundness over the scope lifetime: while the scope is active the wrapped `T`
// is `Some` and methods may form a transient `&T`/`&mut T`. On scope exit the
// scope's destructor `take()`s the value to `None` (dropping the borrowed `T`,
// ending its borrows) but leaves the cell memory valid; any later dispatch finds
// `None` and returns `Error::UserDataDestructed`. The cell itself is freed only
// when the GC collects the userdata, never while a `&DataCell<T>` could exist.

/// Source of process-unique scoped-userdata markers.
static SCOPED_MARKER: AtomicU64 = AtomicU64::new(1);

fn next_scoped_marker() -> u64 {
  SCOPED_MARKER.fetch_add(1, Ordering::Relaxed)
}

/// Install the userdata metatable's `__index`.
///
/// Mirrors mlua's generated `__index` (`mlua::userdata::util`): a lookup falls
/// through **field getters → the method table → a user-registered `__index`
/// meta-method**. A custom `__index` set by [`UserDataMethods::add_meta_method`]
/// therefore stays reachable instead of being overwritten by the method table
/// or the field dispatcher.
///
/// The cheap case — no fields and no custom `__index` — keeps `__index` as the
/// method table itself, so ordinary method lookup stays a plain table access.
///
/// DEVIATION from mlua: an unresolved key yields `nil` rather than raising
/// "attempt to get an unknown field", matching ulua-rt's existing behavior.
/// 元表索引 metamethod 名（Lua 拼写固定）。
const K_METAMETHOD_INDEX: &str = "__index";

fn install_index_dispatcher(
  lua: &Lua,
  metatable: &Table,
  method_table: Table,
  getters: Table,
  has_fields: bool,
) -> Result<()> {
  // A custom `__index` was written onto the metatable by the meta-method loop
  // above; capture it here so the dispatcher can fall back to it. Only
  // functions can land there (`add_meta_method`/`add_meta_method_mut` are the
  // only ways in), so a non-function `__index` is not representable.
  let user_index: Option<Function> = metatable.raw_get(K_METAMETHOD_INDEX)?;

  if !has_fields && user_index.is_none() {
    metatable.set(K_METAMETHOD_INDEX, method_table)?;
    return Ok(());
  }

  let index_fn = lua.create_function(move |_, (ud, key): (Value, Value)| {
    if has_fields {
      // getters/method_table 是本模块私建的无元表内部表，raw_get 语义等同
      // 且免去 Table::get 的 pcall 蹦床（属性访问热路径）
      let getter: Value = getters.raw_get(key.clone())?;
      if let Value::Function(f) = getter {
        return f.call::<Value>(ud);
      }
    }
    let method: Value = method_table.raw_get(key.clone())?;
    // is_nil 免去 Value::Function 参与的 PartialEq（会 push/pop 走 to_pointer）
    if !method.is_nil() {
      return Ok(method);
    }
    match &user_index {
      Some(f) => f.call::<Value>((ud, key)),
      None => Ok(Value::Nil),
    }
  })?;
  metatable.set(K_METAMETHOD_INDEX, index_fn)?;
  Ok(())
}

/// Build the userdata metatable from collected methods and fields: meta-methods
/// go onto the metatable, methods into the method table, field getters/setters
/// into their tables, and the `__index`/`__newindex` dispatchers are installed.
/// Shared by [`create_userdata`] and [`create_scoped_userdata`].
fn build_userdata_metatable(
  lua: &Lua,
  methods: Vec<Registered>,
  fields: Vec<FieldEntry>,
) -> Result<Table> {
  let method_table = lua.create_table();
  let metatable = lua.create_table();
  for item in methods {
    if item.is_meta {
      metatable.set(item.name, item.func)?;
    } else {
      method_table.set(item.name, item.func)?;
    }
  }

  let has_fields = !fields.is_empty();
  let getters = lua.create_table();
  let setters = lua.create_table();
  for field in fields {
    if field.is_get {
      getters.set(field.name, field.func)?;
    } else {
      setters.set(field.name, field.func)?;
    }
  }

  if has_fields {
    // __newindex dispatcher: field setter first, then a user-registered
    // `__newindex` meta-method, else raise — mirroring the `__index` chain
    // (field setters take priority; the user metamethod stays reachable).
    // Only functions can land there (`add_meta_method`/`add_meta_method_mut`
    // are the only ways in), so a non-function `__newindex` is not
    // representable.
    let setters_c = setters.clone();
    let user_newindex: Option<Function> = metatable.raw_get("__newindex")?;
    let newindex_fn = lua.create_function(move |_, (ud, key, val): (Value, Value, Value)| {
      // 私建内部表无元表，raw_get 免 pcall 蹦床（字段写入热路径）
      let setter: Value = setters_c.raw_get(key.clone())?;
      if let Value::Function(f) = setter {
        f.call::<()>((ud, val))?;
        return Ok(());
      }
      if let Some(f) = &user_newindex {
        return f.call::<()>((ud, key, val));
      }
      let name = key.to_string()?;
      Err(Error::runtime(format!(
        "attempt to set unknown field '{name}' on userdata"
      )))
    })?;
    metatable.set("__newindex", newindex_fn)?;
  }
  // __index: field getters -> method table -> a custom `__index` meta-method.
  install_index_dispatcher(lua, &metatable, method_table, getters, has_fields)?;
  Ok(metatable)
}

/// Luau userdata 载荷只保证 **8 字节**对齐：cpp/VM/src/lobject.h:306-322 的
/// `Udata` 用 `alignas(8) char data[1]`，注释写明「while the alignment is only 8
/// here, for sizes starting at 16 bytes, 16 byte alignment is provided」——
/// 即 ≥16 字节的分配能拿到 16 字节对齐，但这是分配器的顺带行为，不是契约。
/// 本仓库移植同此（`crates/ulua-vm/src/records/udata.rs` 的 `_align: [u64; 0]`）。
const USERDATA_ALIGN: usize = 8;

/// 编译期闸门载体：`AlignOk::<T>::CHECK` 只在 `T` 的对齐 ≤ [`USERDATA_ALIGN`]
/// 时可求值，否则单态化即编译失败（不对齐的 `write`/`drop_in_place`/读取都是
/// UB，SIMD 或原子指令会直接崩）。用关联 const 而非函数体内的 `const _`，
/// 是因为函数体内的 const item 不能引用该函数的泛型参数。
struct AlignOk<T>(PhantomData<T>);

impl<T> AlignOk<T> {
  const CHECK: () = assert!(
    align_of::<T>() <= USERDATA_ALIGN,
    "UserData payload must not require alignment greater than 8 (Luau userdata constraint)"
  );
}

/// `lua_newuserdatadtor` 的「分配 + 判空 + 定型」单点：返回覆盖载荷类型 `T` 的
/// 可写槽位（userdata 同时已挂到 `state` 栈顶），分配失败返回 `None`。
///
/// 首次 `write` 留在调用点：各处的失败收敛方式不同（Rust 侧 `Err` / C 边界
/// `raise` / 结构化错误的字符串回退），且回退分支要复用仍被调用点持有的错误值，
/// 把写入并进来了就会提前移交它的所有权。
///
/// 对齐的编译期闸门也收口到此：`T` 要求 > [`USERDATA_ALIGN`] 的对齐时单态化即
/// 编译失败，一次性覆盖全部载荷类型（原先只有 `DataCell<T>` 走这道闸门，其余
/// 各处只在注释里逐点自证 8 字节对齐）。
///
/// 调用序契约（正确性，非内存安全）：`state` 必须存活且正由当前线程驱动
/// （`allocate_userdata` 会把 userdata 挂到其栈顶，并把 `dtor` 记进对象头）；
/// `dtor` 必须与 `T` 同单态化配对：调用点写入成功后，`T` 的 drop 责任恰好移交
/// 给它（VM 保证恰调用一次）。`unsafe` 已内聚在 `allocate_userdata` 门面体内。
pub(crate) fn alloc_userdata_slot<T>(
  state: StateView<'_>,
  dtor: unsafe extern "C-unwind" fn(*mut LuaState, *mut c_void),
) -> Option<NonNull<T>> {
  let _: () = AlignOk::<T>::CHECK;
  // `allocate_userdata` 已把「分配 + 判空」收口为 `Option<NonNull>`（判空哨兵就此
  // 消失）；`cast` 只是类型标注，不改变地址。
  allocate_userdata(state, size_of::<T>(), Some(dtor)).map(|storage| storage.cast::<T>())
}

/// 分配装载 `DataCell<T>` 的 userdata、写入 `data` 并挂 `metatable`，
/// 返回句柄。`create_userdata` / `create_scoped_userdata` 共用的分配尾部。
///
/// 只需 `&Lua`：VM 存活且由当前线程驱动由句柄本身保证（`XRc<LuaInner>` +
/// `NotSync` 纪律），故无需 `unsafe fn` 前置条件——C 边界契约随下面的窄块逐点给出。
fn alloc_cell<T>(
  lua: &Lua,
  key: CellKey,
  data: T,
  metatable: &Table,
  fail_msg: &'static str,
) -> Result<AnyUserData> {
  let state = lua.state();
  // `alloc_userdata_slot`（带契约的 safe 门面）：`state` 存活（`lua` 的
  // `XRc<LuaInner>`）且由当前线程驱动；`data_dtor::<T>` 与载荷 `DataCell<T>`
  // 同一单态化。返回 `None` 即分配失败，转错误返回。
  let cell = alloc_userdata_slot::<DataCell<T>>(state, data_dtor::<T>);
  let Some(cell) = cell else {
    return Err(Error::runtime(fail_msg));
  };
  // `init_userdata_slot`（本文件 `ptr::write` 唯一收口点）：非空、恰
  // `size_of::<DataCell<T>>()` 字节、对齐 ≤8（`AlignOk` 编译期断言）的未初始化
  // 载荷，首次写入即所有权移交该 userdata，由 `data_dtor::<T>` 恰 drop 一次；
  // 失败时不残留半构造值（分配失败在上一句已归为 `Err`）。
  init_userdata_slot(
    cell,
    DataCell {
      key,
      cell: RefCell::new(Some(data)),
    },
  );
  // 元表挂到刚分配的 userdata（栈顶），然后登记句柄。
  // `metatable.push_to_stack()` 是 safe 封装（`lua_rawgeti` 自带栈预留）；owning VM
  // 与 `state` 一致由本调用链以同一 `lua` 建出（`build_userdata_metatable`）。
  metatable.push_to_stack();
  // `set_metatable_at`（state.rs safe 门面族）：栈此刻自顶向下是 [metatable,
  // 新 userdata]，-2 正指该 userdata；恰好消费栈顶的元表写入它。
  set_metatable_at(state, -2);
  // `pop_ref`（safe fn）弹走 userdata 并登记注册表引用，句柄存活即对象存活。
  Ok(AnyUserData::from_ref(lua.pop_ref()))
}

/// 取出 cell 载荷并结束借用（纯 Rust 侧 `RefCell` 操作，无裸指针）。
/// 若正被借用（某方法在途）则 `try_borrow_mut` 失败即跳过，不与在途借用竞争——
/// scope 退出只发生在 `f` 返回之后，届时不会有在途方法。
fn take_scoped_data<T>(cell: &DataCell<T>) {
  if let Ok(mut guard) = cell.cell.try_borrow_mut() {
    let _ = guard.take();
  }
}

/// Build a scoped (non-`'static`) userdata wrapping `data`, with a metatable
/// assembled from `T::add_fields` + `T::add_methods`. Returns the
/// [`AnyUserData`] handle plus a closure that, when called, neutralises the
/// userdata (drops `data`, leaving later access to error with
/// [`Error::UserDataDestructed`]). The neutraliser is what `Lua::scope`
/// registers as a destructor.
///
/// dyn 保留：中和闭包按用户 userdata 类型 `T` 单态化，`T` 集合运行期开放，
/// 且须进入 `Scope` 的异构析构列表——此处不是可静态穷举的类型集合。
///
/// DELIBERATE DEVIATION（返回 `Box<dyn FnOnce()>`）：中和闭包按 `T` 单态化，最终要
/// 进 `Scope` 的异构析构列表（见 `scope.rs` 的 `Destructors`，其 `dyn` 保留理由已
/// 就地锚定），此处签名与之对齐；仅在 scope 退出时调用一次，非热路径。
///
/// 调用序契约（正确性，非内存安全）：返回的 [`AnyUserData`] 不得被用于按类型
/// 读回 `data`（scoped userdata 无 `TypeId`）；只支持元表驱动的方法/字段/
/// meta 派发。scope 必须在 `data` 的借用生命周期结束前调用返回的中和闭包。
pub(crate) fn create_scoped_userdata<T: UserData>(
  lua: &Lua,
  data: T,
) -> Result<(AnyUserData, Box<dyn FnOnce()>)> {
  let marker = next_scoped_marker();

  // 1. Collect fields, methods, and meta-methods (marker-keyed recovery).
  let mut collector = Collector::new(lua, CellKey::Scoped(marker));
  T::add_fields(&mut collector);
  T::add_methods(&mut collector);
  collector.check()?;
  let metatable = build_userdata_metatable(lua, collector.methods, collector.fields)?;

  // 2. Allocate the scoped userdata holding DataCell<T> and move `data` in.
  // `alloc_cell` 是带契约的安全封装：`CellKey::Scoped(marker)` 是本次调用刚发放的
  // 进程独占标记，与随后派发用的 `recover_cell` 键一致，`T`/键/dtor 同一单态化。
  let ud = alloc_cell(
    lua,
    CellKey::Scoped(marker),
    data,
    &metatable,
    "ulua-rt: failed to allocate scoped userdata",
  )?;

  // 3. Build the neutraliser: on scope exit, take the data out of the cell,
  //    dropping the (possibly borrowing) `T` while the cell memory stays valid.
  let ud_for_dtor = ud.clone();
  let neutralise: Box<dyn FnOnce()> = Box::new(move || {
    // `with_reference_pushed` 是安全门面：闭包捕获 `ud_for_dtor`（内含
    // `XRc<LuaInner>` 与注册表引用），运行期间 VM 与该 userdata 均存活。
    with_reference_pushed(&ud_for_dtor.reference, |lua, idx| {
      // `data_cell`（带契约的 safe 门面）以本 scope 独占的 marker 过键闸门
      // （与 `cell`/`recover_cell` 同一道）；槽由门面压入、由注册表引用锚定
      // userdata 在世，返回引用指向被钉住、GC 不移动的载荷。
      if let Ok(cell) = data_cell::<T>(lua.state(), idx, CellKey::Scoped(marker)) {
        // 取放动作收敛在 safe fn `take_scoped_data` 内（纯 Rust `RefCell` 操作）。
        take_scoped_data(cell);
      }
    });
  });

  Ok((ud, neutralise))
}

/// Build a userdata value wrapping `data`, with a metatable assembled from the
/// type's [`UserData::add_fields`] + [`UserData::add_methods`].
pub(crate) fn create_userdata<T: UserData + MaybeSend + MaybeSync + 'static>(
  lua: &Lua,
  data: T,
) -> Result<AnyUserData> {
  // 1. Collect fields, methods, and meta-methods.
  let mut collector = Collector::new(lua, CellKey::Typed(TypeId::of::<T>()));
  T::add_fields(&mut collector);
  T::add_methods(&mut collector);
  collector.check()?;
  let metatable = build_userdata_metatable(lua, collector.methods, collector.fields)?;

  // 2. Allocate the userdata holding DataCell<T>, install the metatable,
  //    and take the handle. `alloc_cell` 是带契约的安全封装；`T: 'static`，键
  //    `TypeId::of::<T>()` 与本泛型单态化的 `data_dtor::<T>` 及 `AnyUserData::cell`
  //    读回使用同一 `T`。
  alloc_cell(
    lua,
    CellKey::Typed(TypeId::of::<T>()),
    data,
    &metatable,
    "ulua-rt: failed to allocate userdata",
  )
}
