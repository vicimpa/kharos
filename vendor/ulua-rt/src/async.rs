//! The Rust-`Future` ⟷ Lua-coroutine bridge (the `async` feature).
//!
//! This module mirrors mlua's async design: a Rust async function is exposed to
//! Lua as an ordinary Lua **closure** that, when called, drives a boxed
//! `Future` to completion by repeatedly polling it and **yielding** the
//! coroutine while the future is `Pending`. A Rust-side driver
//! ([`AsyncThread`](crate::thread::AsyncThread)) resumes that coroutine and,
//! when it yields the internal "pending" marker, returns `Poll::Pending` to the
//! caller's executor (after registering the executor's `Waker`).
//!
//! ## The poller closure
//!
//! [`create_async_callback`] builds, for each async function, a small Lua
//! closure loaded with a private environment exposing four helpers:
//!
//! * `get_future(...)` — a C closure that, given the call arguments, invokes the
//!   user's Rust async fn, boxes the returned `Future`, stashes it in a userdata
//!   and returns that userdata. (One future per call.)
//! * `poll(future, ...)` — a C closure that polls the stashed future once with
//!   the current [`Waker`] and reports the outcome to the Lua loop.
//! * `yield` — `coroutine.yield`.
//! * `unpack` — spreads a results table back onto the stack.
//!
//! The loop body is byte-for-byte the same control flow as mlua's poller (see
//! the embedded source in [`POLLER_SOURCE`]): poll once; on `Ready` return the
//! results; on `Pending` `yield` the pending marker and poll again on the next
//! resume. Intermediate values produced by [`Lua::yield_with`](crate::Lua) ride
//! through the `yield`/`poll` exchange.
//!
//! ## Markers
//!
//! Three process-unique light-userdata sentinels distinguish poll outcomes
//! across the Lua boundary (mirroring `mlua::Lua::poll_pending` etc.); they are
//! named by [`PollKind`], whose addresses are only ever a transport token:
//!
//! * **pending** — yielded by the loop when the future is `Pending`; the driver
//!   recognises it and returns `Poll::Pending`.
//! * **yield** — pushed by [`Lua::yield_with`] to mark a value-carrying yield.
//! * **terminate** — passed *into* the loop by the driver when it is dropped
//!   while the coroutine is suspended, so the loop drops the future and parks.
//!
//! ## Soundness
//!
//! * The boxed future lives inside a Lua **userdata** with a destructor, so it
//!   is owned by the coroutine for exactly as long as the coroutine is alive;
//!   when the coroutine (or the whole `Lua`) is collected, the userdata
//!   destructor drops the future, ending its borrows. It is never polled after
//!   the coroutine is dead because polling only happens from inside a live
//!   resume of that coroutine.
//! * The [`Waker`] is borrowed for the duration of a single resume only, via a
//!   thread-local guard ([`WakerGuard`]) that restores the previous waker on
//!   drop — so a future polled during a resume always sees a valid waker, and no
//!   waker reference outlives the `&Context` it came from.
//! * The waker slot is keyed per VM and never raced: without `send` it is a
//!   thread-local (`Lua` is `Rc`-based and cannot leave its thread), and under
//!   `send` the whole VM may be *moved* to another thread — so the table is
//!   process-wide behind a `Mutex` there, and only one thread drives a given VM
//!   at a time by contract. See [`crate::vm_store`].
//! * The three C closures living in the poller's private environment are
//!   reachable from a script (`getfenv` is in the base library), so each of them
//!   gates its arguments — [`checked_upvalue`] for the future/callback cells,
//!   explicit `luaL`-style type checks in `unpack_c` — before touching any
//!   memory. A script-supplied `newproxy()` (zero-length payload) is an error,
//!   never an out-of-bounds access.

#![cfg(feature = "async")]

use core::ptr::{NonNull, drop_in_place};
use std::{
  any::TypeId,
  future,
  future::{Future, poll_fn},
  marker::PhantomData,
  panic::{AssertUnwindSafe, catch_unwind},
  pin::Pin,
  task::{Context, Poll, Waker},
};

use futures_util::stream::Stream;

use crate::{
  callback::{collect_stack_args, panic_error_message, raise_lua_error, raise_structured_error},
  error::{Error, Result},
  function::Function,
  multi::MultiValue,
  registry::RegHandle,
  state::{
    Lua, StateView, ensure_stack, is_table_at, lightuserdata_at, push_int,
    push_lightuserdata_tagged, push_named_closure, push_nil, raw_geti, replace_slot, stack_top,
  },
  sync::MaybeSend,
  sys::*,
  table::Table,
  thread::{AsyncResume, Thread},
  traits,
  traits::{FromLuaMulti, IntoLua, IntoLuaMulti},
  userdata::{alloc_userdata_slot, init_userdata_slot, typed_userdata_mut},
  value::Value,
};

// ---------------------------------------------------------------------------
// Poll markers (process-unique light-userdata sentinels)
// ---------------------------------------------------------------------------

// We use the address of a `static` byte as a process-unique pointer value. The
// pointer is only ever *compared*, never dereferenced, so it is always sound.

static PENDING_MARK: u8 = 0;
static YIELD_MARK: u8 = 0;
static TERMINATE_MARK: u8 = 0;

/// 跨 Lua 边界传递的 poll 信号。Lua 栈上只能携带指针，故每种信号以一枚 `static`
/// 的**地址**作身份 token（只比较、从不解引用）。信号本身是具名枚举，指针只在
/// [`PollKind::token`] 这一处产生。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PollKind {
  /// future 仍 `Pending`：poller 循环 yield 它，驱动方据此返回 `Poll::Pending`。
  Pending,
  /// 携带值的 yield（[`Lua::yield_with`](crate::Lua) 推入）。
  Yield,
  /// 驱动方被丢弃时传入的终止信号：循环丢弃 future 并永久 park。
  Terminate,
}

impl PollKind {
  /// 本信号的地址 token（light-userdata 的载荷）。三枚 `static` 字节的地址即身份，
  /// 只作指针值比较、从不解引用；`static` 地址恒非空，故以 `NonNull` 编码该不变式，
  /// 比较/压栈点在 ABI 参数位一次性 `.as_ptr()` 还原。
  fn token(self) -> NonNull<c_void> {
    match self {
      PollKind::Pending => NonNull::from(&PENDING_MARK),
      PollKind::Yield => NonNull::from(&YIELD_MARK),
      PollKind::Terminate => NonNull::from(&TERMINATE_MARK),
    }
    .cast::<c_void>()
  }

  /// 把本信号压到 `state` 栈顶（tag 恒 0：身份只由地址决定）。
  ///
  /// `push_lightuserdata_tagged` 是带契约的 safe 门面：token 是 static 地址（只比较、
  /// 从不解引用），state 存活 + 压栈只写新栈槽的 `// Safety` 收在其函数头一处。
  pub(crate) fn push(self, state: StateView<'_>) {
    push_lightuserdata_tagged(state, self.token().as_ptr(), 0);
  }

  /// `idx` 处是否正是本信号（其它 light-userdata、非 light-userdata 都为 false）。
  ///
  /// `lightuserdata_at` 返回 `Option`：`None`（非 lud）不等于任何 `Some(_)`；
  /// token 恒非 null，故 null 载荷的 lud（`Some(null)`）也不等于 `Some(token)`，
  /// 与旧「读裸指针后 `== token`」逐位一致。state 存活契约同 [`Self::push`]。
  pub(crate) fn is_at(self, state: StateView<'_>, idx: i32) -> bool {
    lightuserdata_at(state, idx) == Some(self.token().as_ptr())
  }
}

// ---------------------------------------------------------------------------
// Per-VM async state: the active waker + the implicit-thread ownership map
// ---------------------------------------------------------------------------
//
// mlua keeps both the current `Waker` and the `thread_ownership_map` in the
// per-`Lua` `extra` block, so they are reachable from any coroutine state of the
// VM and travel with the VM when it is moved across threads under `send`.
// ulua-rt's `Lua` has no such block, so we keep them in a per-VM table keyed by
// the VM's **global-state pointer** — see [`crate::vm_store`] for why the key is
// the global state and why the table is process-wide under `send` and
// thread-local without it. Coroutine-state pointers are stored as `usize`
// (compared only, and cast back to `*mut LuaState` solely to push the owner
// thread).

use ulua_common::collections::HashMap;

use crate::vm_store::{VmKey, define_vm_store, vm_key};

/// Per-VM async state: the waker installed for the current resume and the
/// implicit-thread ownership map (`co_state addr -> owner_state addr`).
#[derive(Default)]
pub(crate) struct AsyncVmState {
  waker: Option<Waker>,
  /// `LuaState` addresses (compared only), not [`VmKey`]s.
  ownership: HashMap<usize, usize>,
}

define_vm_store! {
  /// The per-VM async-state table.
  AsyncStore, AsyncVmState
}

/// Install `waker` as the current waker for the duration of a resume, restoring
/// the previous one on drop. Returned by [`set_current_waker`]. Nested async
/// calls push/pop via the guard.
pub(crate) struct WakerGuard {
  key: VmKey,
  prev: Option<Waker>,
}

impl Drop for WakerGuard {
  fn drop(&mut self) {
    let key = self.key;
    let prev = self.prev.take();
    AsyncStore::with(|m| {
      if let Some(s) = m.get_mut(&key) {
        s.waker = prev;
      }
    });
  }
}

/// Set the current waker for `state`'s VM, returning a guard that restores the
/// previous one. Keyed by the VM global state, so it is found again from any
/// coroutine state during the resume.
pub(crate) fn set_current_waker(state: StateView<'_>, waker: Waker) -> WakerGuard {
  // 存活前提见 `vm_key`（safe 门面）：调用点是正被驱动的 poll trampoline。
  let key = vm_key(state);
  let prev = AsyncStore::with(|m| m.entry(key).or_default().waker.replace(waker));
  WakerGuard { key, prev }
}

/// Register `co_state` as an implicit thread owned (transitively) by `owner`.
pub(crate) fn register_implicit_thread(co_state: StateView<'_>, owner: StateView<'_>) {
  // 存活前提见 `vm_key`（safe 门面）：co_state 是刚创建、调用方持有的协程 state。
  let key = vm_key(co_state);
  let owner = owner.as_ptr() as usize;
  AsyncStore::with(|m| {
    let s = m.entry(key).or_default();
    // Chain to the root owner if `owner` is itself implicit.
    let root = s.ownership.get(&owner).copied().unwrap_or(owner);
    s.ownership.insert(co_state.as_ptr() as usize, root);
  });
}

/// Forget the implicit-thread registration for `co_state` (on driver drop).
pub(crate) fn unregister_implicit_thread(co_state: StateView<'_>) {
  // 存活前提见 `vm_key`（safe 门面）：driver drop 时 co_state 仍存活（close 前）。
  let key = vm_key(co_state);
  AsyncStore::with(|m| {
    if let Some(s) = m.get_mut(&key) {
      s.ownership.remove(&(co_state.as_ptr() as usize));
    }
  });
}

/// The owner state for `state`, if `state` is a registered implicit thread.
pub(crate) fn implicit_thread_owner(state: StateView<'_>) -> Option<NonNull<LuaState>> {
  // 存活前提见 `vm_key`（safe 门面）：调用点在受保护 C 边界内持存活 state。
  let key = vm_key(state);
  AsyncStore::with(|m| {
    m.get(&key)
      .and_then(|s| s.ownership.get(&(state.as_ptr() as usize)).copied())
      // 地址→指针转换只能 `as`（from_exposed_addr 未稳定），刻意保留;
      // null(未登记)与非空都归一进 `NonNull` 的 `Option`。
      .and_then(|p| NonNull::new(p as *mut LuaState))
  })
}

/// Drop this VM's entire async-state entry. Called from `LuaInner::drop` (the
/// global state is still valid there), mirroring `app_data::clear_app_data`.
pub(crate) fn clear_async_state(key: VmKey) {
  // 唯一调用点在 `LuaInner::drop` 的 clear 序列、`lua_close` 之前,key 已在彼处
  // 由存活 state 算出。
  let _ = AsyncStore::try_with(|m| {
    m.remove(&key);
  });
}

/// A clone of the current waker for `state`'s VM, or a no-op waker if none is
/// installed (e.g. the async function was resumed synchronously via
/// `Thread::resume`, matching mlua's "noop waker outside an executor" behavior).
fn current_waker(state: StateView<'_>) -> Waker {
  // 存活前提见 `vm_key`（safe 门面）：调用点在受保护 C 边界内持存活 state。
  let key = vm_key(state);
  AsyncStore::with(|m| m.get(&key).and_then(|s| s.waker.clone())).unwrap_or_else(noop_waker)
}

/// A waker that does nothing when woken（std 的 `Waker::noop` 即此语义，
/// 无需自建 RawWaker 空 vtable）。
fn noop_waker() -> Waker {
  Waker::noop().clone()
}

// ---------------------------------------------------------------------------
// The boxed-future userdata stashed by `get_future` and polled by `poll`
// ---------------------------------------------------------------------------

/// 两类 async upvalue 载荷各自的私标签载体（按泛型参数区分）。其 `TypeId` 只在
/// 本 crate 内出现，故可作为「这块载荷是我们分配的、且是这个具体类型」的进程内
/// 唯一凭据。
///
/// 单态化之后 `AsyncPollUpvalue<FR>` 的布局随 `FR` 变化（不再是统一的 fat
/// pointer），所以标签必须按 `FR`（回调侧按 `F`）区分：脚本若能拿到**另一个** async
/// 函数产生的 future 喂进本函数的 `poll`，用统一标签会通过闸门却按错误的 `FR`
/// 解读内存（UB）；按类型取标签则跨类型即被 `checked_upvalue` 挡下。
struct AsyncPollMarker<FR>(PhantomData<fn(FR)>);
struct AsyncCallbackMarker<F>(PhantomData<fn(F)>);

/// 载荷标签字段（必须排在 `#[repr(C)]` 结构体偏移 0 处，见 [`checked_upvalue`]）。
type UpvalueTag = TypeId;

/// `poll` 参数 1 应携带的标签（按 future 具体类型 `FR` 区分，`FR: 'static`）。
fn poll_tag<FR: 'static>() -> UpvalueTag {
  TypeId::of::<AsyncPollMarker<FR>>()
}

/// `get_future` upvalue 1 携带的标签（按回调具体类型 `F` 区分，`F: 'static`）。
fn callback_tag<F: 'static>() -> UpvalueTag {
  TypeId::of::<AsyncCallbackMarker<F>>()
}

/// The in-flight future for one async call, or a deferred argument-conversion
/// error that must surface on the first `poll` (matching the previous design,
/// where the conversion ran inside the boxed future).
enum PollSlot<FR> {
  /// The user future, boxed so it lives at a stable, correctly-aligned heap
  /// address (the VM guarantees only 8-byte userdata alignment).
  Future(Pin<Box<FR>>),
  /// A conversion error produced while building the future, raised on first poll.
  Failed(Error),
}

/// The userdata holding the in-flight future for one async call. `data` is
/// `None` once the future has completed or been terminated.
#[repr(C)]
struct AsyncPollUpvalue<FR> {
  tag: UpvalueTag,
  data: Option<PollSlot<FR>>,
}

/// Destructor for the [`AsyncPollUpvalue`] userdata: drops the boxed future
/// (ending any borrows its captured environment holds).
///
/// # Safety
/// 仅由 VM 作为 `lua_newuserdatadtor` 注册的终结器调用：`ptr` 必须为 null，或
/// 指向本模块按同一 `FR` 单态化布局写入、尚未 drop 的 userdata 载荷；VM 保证
/// 其恰被调用一次。
unsafe extern "C-unwind" fn poll_upvalue_dtor<FR>(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: 满足本 dtor `# Safety` 契约——null 已判；载荷由本模块按同一 FR
    // 单态化布局写入，VM 保证恰调用一次。
    unsafe { drop_in_place(ptr.cast::<AsyncPollUpvalue<FR>>()) };
  }
}

/// The userdata holding the user's async closure `F` (upvalue of the
/// `get_future` C closure). Stored at its concrete type — no type erasure.
#[repr(C)]
struct AsyncCallbackUpvalue<F> {
  tag: UpvalueTag,
  func: Box<F>,
}

/// Destructor for the [`AsyncCallbackUpvalue`] userdata.
///
/// # Safety
/// 仅由 VM 作为 `lua_newuserdatadtor` 注册的终结器调用：`ptr` 必须为 null，或
/// 指向本模块按同一 `F` 单态化布局写入、尚未 drop 的 userdata 载荷；VM 保证其
/// 恰被调用一次。
unsafe extern "C-unwind" fn callback_upvalue_dtor<F>(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: 满足本 dtor `# Safety` 契约——null 已判；载荷由本模块按同一 F
    // 单态化布局写入，VM 保证恰调用一次。
    unsafe { drop_in_place(ptr.cast::<AsyncCallbackUpvalue<F>>()) };
  }
}

/// 偏移 0 处携带 [`UpvalueTag`] 标签字段的载荷结构体（两个 async upvalue
/// 结构体皆是 `#[repr(C)]` 且 `tag` 为首字段）。有了类型化标签读取，
/// [`checked_upvalue`] 的闸门与调用点都不再需要手工 `size_of` 实参和裸指针
/// cast。
trait UpvalueTagged {
  fn tag(&self) -> &UpvalueTag;
}

impl<FR> UpvalueTagged for AsyncPollUpvalue<FR> {
  fn tag(&self) -> &UpvalueTag {
    &self.tag
  }
}

impl<F> UpvalueTagged for AsyncCallbackUpvalue<F> {
  fn tag(&self) -> &UpvalueTag {
    &self.tag
  }
}

/// 校验 `idx` 处的栈值是本模块分配的、标签为 `tag` 且载荷容纳得下 `T` 的
/// userdata，直接交还 `T` 的可变引用；任一不合格返回 `None`。
///
/// 这道闸门是**必需**的：`poll`/`get_future`/`unpack` 三枚 C 闭被放进 async
/// 函数的私有环境表（见 [`create_async_callback`]），而 `getfenv` 在 base 库
/// 中可用（cpp/VM/src/lbaselib.cpp:437），所以
/// `local e = getfenv(asyncFn); e.poll(newproxy())` 是脚本可达的路径；
/// `newproxy()` 的载荷是 0 字节（cpp/VM/src/lbaselib.cpp:407-420），
/// 没有闸门就是对它做越界的标签读写。与 `callback.rs` 里 wrapped-error 的
/// 既有闸门同构。
///
/// 调用序契约（正确性，非内存安全）：`state` 存活且正由当前线程驱动，`idx` 是其上
/// 有效栈索引；`T` 必须是本模块的 [`UpvalueTagged`] 载荷结构体（`#[repr(C)]`、
/// `tag` 居偏移 0），且返回引用的生存期不得越过该栈槽上对应 userdata 的存活期。
/// 三道闸门（类型 / 长度 / 载荷非空）与「按 `T` 解读已过闸门的载荷」的裸指针
/// 边界全部收口在 `userdata.rs` 的 safe 门面 [`typed_userdata_mut`] 一处，
/// 本函数只剩纯 Rust 的标签比对。
fn checked_upvalue<'a, T: UpvalueTagged>(
  state: StateView<'_>,
  idx: i32,
  tag: UpvalueTag,
) -> Option<&'a mut T> {
  // `typed_userdata_mut` 内聚 userdata 类型 + 载荷长度覆盖 `T` + 非空三道闸门
  // （其 `// Safety` 收在其函数体一处）；不合格一律 `None`。
  let payload = typed_userdata_mut::<T>(state, idx)?;
  // 纯 Rust：标签比对只是整数比较，不合标签即 `None`，不解引用载荷其余字段。
  (*payload.tag() == tag).then_some(payload)
}

// ---------------------------------------------------------------------------
// The C closures: get_future + poll
// ---------------------------------------------------------------------------

/// `get_future(...)`: convert the call args, invoke the user's async closure, and
/// stash the resulting `Future` in an [`AsyncPollUpvalue`] userdata (returned).
/// A deferred conversion error is stashed instead and raised on the first poll.
///
/// # Safety
/// 仅由 VM 作为 `lua_CFunction` 在受保护边界内调用：`state` 存活且正由当前线程
/// 驱动，upvalue 1 是 `create_async_function` 注册的 `AsyncCallbackUpvalue<F>`
/// userdata（类型标签 + 长度双重校验后才解引用）。
unsafe extern "C-unwind" fn get_future_c<F, A, FR>(raw: *mut LuaState) -> i32
where
  F: Fn(Lua, A) -> FR + 'static,
  A: FromLuaMulti,
  FR: Future + 'static,
{
  // Safety: C-ABI 边界点(`lua_CFunction` 实参):VM 实时传入存活 state,本帧
  // 一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // 本函数的共用前置（下面每个边界块都引它）：VM 按 `lua_CFunction` 约定在受保护
  // 边界内实时传入 `state`，故其存活且正由当前线程驱动，错误路径的 push 由 CI 帧的
  // LUA_MINSTACK 头寸覆盖；upvalue/实参一律经 `checked_upvalue` 的类型标签 + 长度
  // 闸门后才解引用；发散点全部走 `raise_lua_error`（不返回）。
  //
  // 1. Recover the callback from upvalue 1 (length + type-tag gated).
  // `checked_upvalue` 现为带调用序契约的 safe 门面：共用前置逐项满足其函数头
  // （存活 state、有效索引 lua_upvalueindex(1)、`T` 为本模块 `UpvalueTagged` 载荷）。
  let callback =
    checked_upvalue::<AsyncCallbackUpvalue<F>>(state, lua_upvalueindex(1), callback_tag::<F>());
  let Some(upvalue) = callback else {
    raise(state, "ulua-rt: missing async callback upvalue")
  };
  // 纯 Rust：闸门已过，按共享引用取出闭包（本函数只 `&F` 调用，不取走载荷）。
  let func = &*upvalue.func;

  // `Lua::from_borrowed` 是带契约的 safe 门面（只复制视图指针位、不解引用）：本
  // trampoline 的运行区间即「state 存活期覆盖句柄及其克隆」。
  let lua = Lua::from_borrowed(state);
  // `stack_top` 是带契约的 safe 门面：只读当前栈深（存活 state），故 `1..=nargs`
  // 是有效槽位，正是 `collect_stack_args` 的头注释前提；收集本身是 safe fn，无
  // 边界块，转换失败经 `raise`（safe 门面）发散。
  let args = match collect_stack_args(&lua, stack_top(state)) {
    Ok(a) => a,
    Err(e) => raise(state, &e.to_string()),
  };

  // Build the future. This runs `A::from_lua_multi` and constructs the user
  // future state machine (an `async fn` body itself stays lazy until polled).
  // A panic in that synchronous prologue must not unwind through the VM
  // frames — convert it to a catchable Lua error. A returned `Err` (conversion
  // failure) is *deferred* into the poll slot so it surfaces uniformly on the
  // first poll, exactly as the previous boxed-future design did.
  // 纯 Rust 区：`catch_unwind` 自带守卫，无 C 边界。
  let built = catch_unwind(AssertUnwindSafe(|| {
    let a = A::from_lua_multi(args, &lua)?;
    Ok::<_, Error>(func(lua.clone(), a))
  }));
  let slot = match built {
    Ok(Ok(fut)) => PollSlot::Future(Box::pin(fut)),
    Ok(Err(e)) => PollSlot::Failed(e),
    Err(payload) => raise(state, &panic_error_message(&*payload)),
  };

  // Stash it in a fresh userdata with a dtor and return it. 分配 → 判空 → 首次初始化
  // 是一段不可分割的载荷所有权移交，故合为一个边界块。
  // 共用前置给出存活 state；`poll_upvalue_dtor::<FR>` 与载荷
  // `AsyncPollUpvalue<FR>` 同一 `FR` 单态化。返回 `None` 即分配失败（OOM），此时
  // **不写载荷**而由 `raise` 发散（判空哨兵就此消失）。
  let Some(future_slot) =
    alloc_userdata_slot::<AsyncPollUpvalue<FR>>(state, poll_upvalue_dtor::<FR>)
  else {
    raise(state, "ulua-rt: failed to allocate async future userdata")
  };
  // `init_userdata_slot`（userdata.rs 的 `ptr::write` 全 crate 收口点）：非空、覆盖
  // `size_of::<AsyncPollUpvalue<FR>>()`、对齐 ≤8（`AlignOk` 编译期断言）的未初始化
  // 载荷，首次写入即所有权移交该 userdata，由同单态化的 `poll_upvalue_dtor::<FR>`
  // 恰好 drop 一次。
  init_userdata_slot(
    future_slot,
    AsyncPollUpvalue {
      tag: poll_tag::<FR>(),
      data: Some(slot),
    },
  );
  1
}

/// `poll(future, ...)`: poll the stashed future once and report the outcome.
///
/// Return convention (matches mlua's poller loop):
/// * `Ready(n)` results: returns `nres = n` followed by up to 2 result values,
///   or `nres, table` for `n >= 3` (the loop `unpack`s the table).
/// * `Pending` (plain): returns `nil, <pending light-userdata>`.
/// * `Pending` (value-carrying, via `yield_with`): returns
///   `nil, <values-table>, <count>` for the loop to forward through `yield`.
/// * terminate signal received: returns `-1` so the loop parks forever.
///
/// # Safety
/// 仅由 VM 作为 `lua_CFunction` 在受保护边界内调用：`state` 存活且正由当前线程
/// 驱动；实参 1 必须是 `get_future_c` 产出的 `AsyncPollUpvalue<FR>` userdata
/// （类型标签 + 长度校验后才解引用），其余实参按 poller 循环约定压栈。
unsafe extern "C-unwind" fn poll_c<FR, R>(raw: *mut LuaState) -> i32
where
  FR: Future<Output = Result<R>> + 'static,
  R: IntoLuaMulti,
{
  // Safety: C-ABI 边界点(`lua_CFunction` 实参):VM 实时传入存活 state,本帧
  // 一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // 本函数的共用前置（下面每个边界块都引它）：VM 按 `lua_CFunction` 约定在受保护
  // 边界内实时传入 `state`，故其存活且正由当前线程驱动；栈头寸由 poller 的 C 帧
  // （LUA_MINSTACK）覆盖；实参一律过类型/长度/标签闸门后才触碰；发散点全走
  // `raise` / `raise_destructed`（不返回）。
  //
  // The future userdata is always argument 1 (length + type-tag gated: a
  // script can reach `poll` through the poller's environment via `getfenv`;
  // the per-`FR` tag also rejects a foreign async function's future).
  // `checked_upvalue` 现为带调用序契约的 safe 门面：共用前置逐项满足其函数头
  // （存活 state、有效索引 1、`T` 为本模块 `UpvalueTagged` 载荷）。
  let Some(future) = checked_upvalue::<AsyncPollUpvalue<FR>>(state, 1, poll_tag::<FR>()) else {
    raise(state, "ulua-rt: poll() expects an async future")
  };

  // `stack_top` 是带契约的 safe 门面：只读当前栈深（存活 state）。
  let nargs = stack_top(state);

  // Terminate signal: `poll(future, <terminate light-userdata>)`.
  if nargs == 2 && PollKind::Terminate.is_at(state, -1) {
    future.data.take(); // drop the future
    // `-1` 是本函数文档约定的 park 信号，`push_int` 门面压栈净一层。
    push_int(state, -1);
    return 1;
  }

  // A deferred argument-conversion error (stashed by `get_future_c`) surfaces
  // on the first poll, raising a plain string error exactly as the previous
  // boxed-future design returned it from `Poll::Ready(Err(..))`.
  if let Some(PollSlot::Failed(e)) = &future.data {
    raise(state, &e.to_string())
  }

  // 纯 Rust：`from_borrowed`/`current_waker` 都是带契约的 safe 门面（前者只复制
  // 视图指针位，后者内部按 `vm_key` 契约读 per-VM waker 槽）。
  let lua = Lua::from_borrowed(state);
  let waker = current_waker(state);
  let mut cx = Context::from_waker(&waker);

  // Polling runs user futures: a panic must not unwind through the VM
  // frames. The panicked future is dropped (a polled-then-panicked future
  // must never be polled again) and the panic surfaces as a Lua error.
  let poll = match future.data.as_mut() {
    Some(PollSlot::Future(f)) => {
      match catch_unwind(AssertUnwindSafe(|| f.as_mut().poll(&mut cx))) {
        Ok(poll) => poll,
        Err(payload) => {
          future.data.take();
          raise(state, &panic_error_message(&*payload))
        }
      }
    }
    // 载荷已被取走（future 完成/终止后再被 poll）：`raise_destructed` 是 safe 门面，
    // 其「受保护边界内 + ≥1 空位」前提由本函数的共用前置给出。
    _ => raise_destructed(&lua),
  };

  match poll {
    // `report_pending` 现为 safe fn：`lua` 是 `poll_c` 刚在受保护 C 边界内由该 state
    // `from_borrowed` 出的借用句柄（future 实参仍在槽 1、由当前线程驱动、C 帧留有
    // LUA_MINSTACK 头寸），栈操作全部经带契约的 safe 门面，最多净压两层，落在头寸内。
    Poll::Pending => report_pending(&lua),
    Poll::Ready(result) => report_ready(&lua, result),
  }
}

/// `Poll::Pending` 的收尾：按 poller 循环的约定回报「仍未就绪」。
///
/// 两种形态：
/// * 值携带 yield（`yield_with` 刚在栈尾留下 `[yield_marker, values_table, count]`）：
///   把 marker（-3）换成 nil，交回 `[nil, table, count]` 三值供循环转发。
/// * 裸 pending：交回 `[nil, pending_marker]` 两值。
///
/// `lua` 须为 `poll_c` 刚在受保护 C 边界内由该 state `from_borrowed` 出的借用句柄
/// （栈顶仍留有该 future 实参、槽 1），由当前线程驱动；poller 的 C 帧留有 LUA_MINSTACK
/// 头寸，本函数最多净压两层。栈操作全部经带契约的 safe 门面（[`push_nil`] /
/// [`replace_slot`] / [`PollKind::push`]），上述调用序前提是使用约定而非内存安全前置
/// 条件，故本函数自身是 safe fn、无 unsafe 操作。
fn report_pending(lua: &Lua) -> i32 {
  let state = lua.state();
  // `stack_top` 是带契约的 safe 门面：只读栈深（存活 state）。减去 future 自身的
  // 槽位，即本次 poll 见到的实参数（`yield_with` 的值携带形态会多留 3 层）。
  let nvals = stack_top(state) - 1;
  if nvals >= 3 && PollKind::Yield.is_at(state, -3) {
    // A value-carrying yield from `yield_with`: stack tail is
    // [yield_marker, values_table, count]. Replace the marker
    // (at -3) with nil so the loop forwards [nil, table, count].
    // `push_nil` + `replace_slot(-4)` 均为带契约的 safe 门面：pushnil 净压一层，
    // `replace` 原位覆盖 -4（本函数已确认其为 marker 的槽位）并弹掉它，栈深回到进入时。
    push_nil(state);
    replace_slot(state, -4);
    return 3;
  }
  // Plain pending: return [nil, pending_marker]. 两次压栈各净一层（`push_nil` /
  // `PollKind::push` 均 safe 门面），均在 C 帧头寸内；marker 压的是 static 地址 token。
  push_nil(state);
  PollKind::Pending.push(state);
  2
}

/// `Poll::Ready` 的收尾：把结果压栈并按 poller 循环的约定回报计数。
///
/// `nres < 3` 走快路径（计数 + 至多两个结果，循环读作 `res`/`res2`）；否则把结果
/// 打包成序列表，由循环 `unpack` 展开。
///
/// `lua` 须为 `poll_c` 在受保护 C 边界内由该 state `from_borrowed` 出的借用句柄
/// （受保护边界内、由当前线程驱动）；poller 的 C 帧留有 LUA_MINSTACK 头寸，本
/// 函数最多净压两层。结果的 `IntoLua` 转换在 `catch_unwind` 内进行，任何失败都以
/// `raise_lua_error` 发散，不留半压的结果。栈操作全部经带契约的 safe 门面，
/// 本函数自身无 unsafe 操作、是 safe fn（上述调用序前提是使用约定而非
/// 内存安全前置条件）。
fn report_ready<R: IntoLuaMulti>(lua: &Lua, result: Result<R>) -> i32 {
  let state = lua.state();
  let results = match result {
    Ok(r) => {
      // `R -> MultiValue` runs the user's `IntoLua` impls; like the old
      // in-future conversion it is guarded so a panic becomes a catchable
      // Lua error, not a unwind through the VM frames.
      match catch_unwind(AssertUnwindSafe(|| r.into_lua_multi(lua))) {
        Ok(Ok(results)) => results,
        Ok(Err(e)) => raise(state, &e.to_string()),
        Err(payload) => raise(state, &panic_error_message(&*payload)),
      }
    }
    // The future returned `Err` -> raise it as a Lua error so
    // it propagates through the coroutine like any other.
    Err(e) => raise(state, &e.to_string()),
  };
  let nres = results.len() as i32;
  // 计数压栈净一层（`push_int` 门面，state 存活由函数头契约给出）。
  push_int(state, nres);
  if nres < 3 {
    // Fast path: count then up to 2 results (the loop reads them as
    // `res`, `res2`). `push_value` 是带契约的 safe 门面（内部逐类型自保栈头寸）。
    for v in results.iter() {
      if let Err(e) = lua.push_value(v) {
        raise(state, &e.to_string())
      }
    }
    return 1 + nres;
  }
  // Many results: pack into a sequence table; loop `unpack`s it.
  let seq = match lua.create_sequence_from(results) {
    Ok(t) => t,
    Err(e) => raise(state, &e.to_string()),
  };
  // 序列表由上一行刚创建、句柄存活；`seq.push_to_stack()` 是 safe 封装（`lua_rawgeti`
  // 自带栈预留），计数已在栈顶，本句净压一层。
  seq.push_to_stack();
  2
}

/// 读 `idx` 槽位为整数（VM 原生强转 + 截断为 `i32`，同 `table::number_at` 的
/// 手法，cpp `isnum` 出参已由 `lua_tointegerx` 收口为 `Option` 返回值）。
///
/// 前提是 `state` 存活、`idx` 为其上的栈索引；`lua_tointegerx` 对该前提下的任意
/// 索引都有定义（非数字、越界索引一律 `None`，不越栈读写），故 C 边界读取收在
/// 本函数体这一处，调用点是安全读值。
fn integer_at(state: StateView<'_>, idx: i32) -> Option<i32> {
  lua_tointegerx(&state, idx)
}

/// `unpack(t, n)`: push `t[1]..t[n]` onto the stack and return `n`.
///
/// 参数同样要校验：`unpack` 也在 poller 的私有环境表里，脚本可以用任意值调它
/// （`lua_rawgeti` 对非表值做 `hvalue!` 解读，见
/// `crates/ulua-vm/src/functions/lua_rawgeti.rs`）。
///
/// # Safety
/// 仅由 VM 作为 `lua_CFunction` 在受保护边界内调用：`state` 存活且正由当前线程
/// 驱动；实参类型（表 + 非负整数）在解引用前已逐项校验，不合规则由 `raise` 发散。
unsafe extern "C-unwind" fn unpack_c(raw: *mut LuaState) -> i32 {
  // Safety: C-ABI 边界点(`lua_CFunction` 实参):VM 实时传入存活 state,本帧
  // 一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // 共用前置（下面每个边界块都引它）：VM 按 `lua_CFunction` 约定在受保护边界内实时
  // 传入存活 `state`；实参逐项过闸门后才 rawgeti；不合规一律由 `raise` 发散。
  // `is_table_at` 是带契约的 safe 只读门面：槽 1 的类型查询，不动栈、不触发 GC，
  // `// Safety` 收在函数头一处。
  if !is_table_at(state, 1) {
    raise(state, "ulua-rt: unpack() expects a table")
  }
  // 计数读取是 safe 门面 `integer_at`（只读槽 2），非负性在纯 Rust 侧过滤。
  let Some(n) = integer_at(state, 2).filter(|v| *v >= 0) else {
    raise(
      state,
      "ulua-rt: unpack() expects a non-negative integer count",
    )
  };
  // 栈头寸走 crate 的统一 safe 闸门 `ensure_stack`（内部即 `lua_checkstack`）：不足时
  // 与旧实现同样以字符串错误发散，而不是让后面的 rawgeti 越栈写。
  if ensure_stack(state, n.saturating_add(1)).is_err() {
    raise(state, "ulua-rt: stack overflow unpacking async results")
  }
  // 表型 / 非负计数 / `n + 1` 层头寸三道闸门刚过；`raw_geti` 是带契约的 safe 收口点
  // （`lua_rawgeti` 对表槽 1 的 1-based 整数键只做读-压，越界键读出 nil 仍占一层），
  // 每轮净压一层，总量在头寸内。`i` 是 Lua 表键（数据，非数组下标），保留整数区间迭代。
  for i in 1..=n {
    raw_geti(state, 1, i);
  }
  n
}

// ---------------------------------------------------------------------------
// Raise 收口门面（复用 `callback::raise_lua_error`，本模块只留一处 C 边界契约）
// ---------------------------------------------------------------------------

/// 把 `msg` 作为错误对象压栈并沿 VM 的错误展开发散（不返回）。
///
/// 本模块所有 trampoline 的错误出口都走这里，于是 [`raise_lua_error`] 的调用序
/// 契约只需在每个受保护 C 边界（trampoline/hook）的入口处论证一次，调用点全部
/// 是安全函数（同 `state::Lua::from_borrowed` 的「契约前移到调用点」范式）。
///
/// 前提（由全部调用点满足，越界调用即为违约）：`state` 存活、正由当前线程在
/// `lua_CFunction`/hook 的**受保护**边界内驱动，且栈上留有至少 1 个空位供压入错误
/// 对象。cpp 侧对应 `luaB_error`/`lua_error` 的同一用法。
fn raise(state: StateView<'_>, msg: &str) -> ! {
  // `raise_lua_error` 是带契约的 safe 门面：上述前提即其函数头契约的全部内容；
  // `msg` 是被调方当场拷贝的合法字节切片（空串的指针亦非 null）。
  raise_lua_error(state, msg)
}

/// Raise the structured `CallbackDestructed` error (future polled after drop).
///
/// 前提同 [`raise`]：`lua` 必须是 `poll_c` 在受保护 C 边界内由正被驱动的存活 state
/// `from_borrowed` 出的借用句柄，且栈上有至少 1 个空位；本函数不返回（沿 VM 错误
/// 展开发散）。
fn raise_destructed(lua: &Lua) -> ! {
  // `lua` 按上述前提是受保护边界内存活 state 的借用句柄，`state()` 只是该
  // 不变量的边界形态还原；[`raise_structured_error`] 的函数头契约由此逐项满足。
  raise_structured_error(lua.state(), Error::CallbackDestructed)
}

// ---------------------------------------------------------------------------
// The Lua poller loop source (identical control flow to mlua's)
// ---------------------------------------------------------------------------

const POLLER_SOURCE: &str = r#"
local poll, yield = poll, yield
local future = get_future(...)
local nres, res, res2 = poll(future)
while true do
    if nres ~= nil then
        if nres == 0 then
            return
        elseif nres == 1 then
            return res
        elseif nres == 2 then
            return res, res2
        elseif nres < 0 then
            yield()
        else
            return unpack(res, nres)
        end
    end

    if res2 == nil then
        nres, res, res2 = poll(future, yield(res))
    elseif res2 == 0 then
        nres, res, res2 = poll(future, yield())
    elseif res2 == 1 then
        nres, res, res2 = poll(future, yield(res))
    else
        nres, res, res2 = poll(future, yield(unpack(res, res2)))
    end
end
"#;

// ---------------------------------------------------------------------------
// Building the async function
// ---------------------------------------------------------------------------

/// 以栈顶的 `nupvals` 个 upvalue 造一枚 C 闭包，并立刻登记为 [`Function`] 句柄
/// （闭包压栈 → `pop_ref` 弹栈登记，净栈变化为零）。本模块三枚 poller 闭包
/// （`get_future` / `poll` / `unpack`）共用这段同构的「压栈→登记」序列。
///
/// 调用序契约（由全部调用点满足，越界即违约）：`lua` 指向正由当前线程驱动的存活 VM，
/// 其栈上有 1 层登记头寸；那 `nupvals` 个 upvalue 已按顺序压在该 VM 栈顶
/// （`lua_pushcclosurek` 会消费它们；`nupvals` 为 0 时无此要求）；`f` 是符合
/// `lua_CFunction` 契约的本模块 trampoline；`name` 是以 NUL 结尾的 `'static` 调试名
/// （VM 在闭包整个存活期内按 C 串读取）。上述内存/ABI 前置全部收在
/// [`push_named_closure`]（`lua_pushcclosurek` 的带契约 safe 门面）一处，故本函数
/// 自身是 safe fn、无边界块；`pop_ref` 同为带契约 safe 门面。
fn take_c_closure(
  lua: &Lua,
  f: unsafe extern "C-unwind" fn(*mut LuaState) -> i32,
  // NUL 结尾静态名字字节串（调用点 `b"..\0"` 字面量；消费侧按 NUL 扫描读取）。
  name: &'static [u8],
  nupvals: i32,
) -> Function {
  // `push_named_closure` 落实函数头契约：state 存活且有头寸（`lua` 句柄）；`Some(f)`
  // 是本模块单态化的合法 `lua_CFunction` trampoline；`name` 是 `'static` NUL 调试名；
  // `nupvals` 个 upvalue 已按调用方说明压在栈顶。
  push_named_closure(lua.state(), Some(f), name, nupvals);
  // `pop_ref` 是带契约的 safe 门面：弹出栈顶值并在注册表登记引用。
  Function::from_ref(lua.pop_ref())
}

/// Build a [`Function`] that, when called from Lua, drives the given async
/// closure to completion (yielding while pending). This is the core of
/// [`Lua::create_async_function`].
///
/// The closure `F` and its future `FR` are kept at their concrete types: the
/// `get_future` / `poll` C closures are monomorphized over `(F, A, FR, R)` (no
/// `dyn` boxes). Under the `send` feature, `F`/`FR: MaybeSend` keep both the
/// callback cell and the boxed future `Send`, so the whole VM stays `Send` —
/// the same type-system guarantee the sync callback trampoline now uses, in
/// place of the previous erased `Box<dyn ... + Send>`.
pub(crate) fn create_async_callback<F, A, FR, R>(lua: &Lua, func: F) -> Result<Function>
where
  F: Fn(Lua, A) -> FR + MaybeSend + 'static,
  A: FromLuaMulti,
  FR: Future<Output = Result<R>> + MaybeSend + 'static,
  R: IntoLuaMulti,
{
  let state = lua.state();

  // 1. 回调闭包存进带 dtor 的 userdata，它随即成为 `get_future` 的唯一 upvalue。
  // 先装箱再分配：`Box::new` 若发生在分配之后，其潜在的分配失败会留下「已注册
  // dtor 但槽位未初始化」的窗口（review.md §2 所有权显式转手）。
  let boxed = Box::new(func);
  // `lua`/`state` 是本函数入参（句柄的 `XRc<LuaInner>` 保活、由当前线程驱动）；
  // `callback_upvalue_dtor::<F>` 与载荷 `AsyncCallbackUpvalue<F>` 同一 `F` 单态化。
  // 返回 `None` 即分配失败（OOM），此时**不写载荷**而直接 `Err` 返回（判空哨兵就此消失）。
  let storage = alloc_userdata_slot::<AsyncCallbackUpvalue<F>>(state, callback_upvalue_dtor::<F>);
  let Some(storage) = storage else {
    // 未写槽，`boxed` 在本帧正常 drop——一次性所有权，无双放。
    return Err(Error::runtime(
      "ulua-rt: failed to allocate async callback userdata",
    ));
  };
  // `init_userdata_slot`（userdata.rs 的 `ptr::write` 全 crate 收口点）：非空、恰
  // `size_of::<AsyncCallbackUpvalue<F>>()` 字节、对齐 ≤8（`AlignOk` 编译期断言）的
  // 未初始化载荷；首次写入即所有权移交该 userdata，由同单态化的
  // `callback_upvalue_dtor::<F>` 恰好 drop 一次。
  init_userdata_slot(
    storage,
    AsyncCallbackUpvalue {
      tag: callback_tag::<F>(),
      func: boxed,
    },
  );
  // 上一句压入的回调 userdata 正处在栈顶，即本闭包唯一的 upvalue（`nupvals = 1`
  // 会消费它）；`take_c_closure` 现为带调用序契约的 safe fn：state 存活 + 一层登记
  // 头寸由 `lua` 句柄给出，`name` 是 `'static` NUL 串，边界收在其内部的
  // `push_named_closure` 一处。
  let get_future = take_c_closure(lua, get_future_c::<F, A, FR>, b"ulua-rt-get-future\0", 1);

  // 2. Build the `poll` and `unpack` C closures (no upvalues).
  // 栈顶无待消费 upvalue（`nupvals = 0`）；trampoline 为本模块单态化的 `poll_c::<FR, R>`；
  // `lua` 同上且有登记闭包的一层头寸——契约同上一句。
  let poll = take_c_closure(lua, poll_c::<FR, R>, b"ulua-rt-poll\0", 0);
  // 同上——`unpack_c` 是自带实参闸门的合法 trampoline，`nupvals = 0`。
  let unpack = take_c_closure(lua, unpack_c, b"ulua-rt-unpack\0", 0);

  // 3. Fetch `coroutine.yield`.
  let coroutine: Table = lua.globals().get("coroutine")?;
  let yield_fn: Function = coroutine.get("yield")?;

  // 4. Assemble the poller's private environment.
  let env = lua.create_table();
  env.set("get_future", get_future)?;
  env.set("poll", poll)?;
  env.set("yield", yield_fn)?;
  env.set("unpack", unpack)?;

  // 5. Load the poller loop with that environment and return it as the async
  //    function.
  lua
    .load(POLLER_SOURCE)
    .set_name("__ulua_async_poll")
    .set_environment(env)
    .into_function()
}

// ---------------------------------------------------------------------------
// `Lua::yield_with` (cooperative value-carrying yield from inside an async fn)
// ---------------------------------------------------------------------------

impl Lua {
  /// Yield the current async coroutine, returning `args` to the resumer, and
  /// resolve to the values the coroutine is next resumed with.
  ///
  /// Mirrors `mlua::Lua::yield_with`. Only valid inside a function created
  /// with [`Lua::create_async_function`] that is being driven on a coroutine.
  ///
  /// Returns an owning `'static` future (rather than being an `async fn`): the
  /// only step that borrows `self` is the eager argument conversion, so the
  /// future itself owns just a `Lua` clone and borrows nothing. That keeps it
  /// `Send` under the `send` feature — which is required because the future is
  /// stored inside the (movable) VM. An `async fn(&self)` would instead capture
  /// `&self` across the await and demand `Lua: Sync`, which ulua-rt
  /// deliberately is **not** (its move-only, never-shared contract).
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn yield_with<R: traits::FromLuaMulti + 'static>(
    &self,
    args: impl IntoLuaMulti,
  ) -> impl future::Future<Output = Result<R>> + 'static {
    let lua = self.clone();
    let args = args.into_lua_multi(self);
    async move {
      let mut args = Some(args?);
      poll_fn(move |_cx| {
        match args.take() {
          // First poll: push the yield marker + the values + the count so
          // `poll_c` recognises a value-carrying yield, then report Pending.
          Some(values) => {
            let state = lua.state();
            // 本 poll 运行于 `poll_c` 的受保护边界内，`lua` 句柄保 VM 存活；下面的
            // 压栈（marker / 值 / 计数）只写新栈槽，poller 循环约定预留头寸。
            PollKind::Yield.push(state);
            let count = values.len() as i32;
            if count <= 1 {
              // 单个值走 safe 门面 `push_value`（内部逐类型自保栈头寸）；无值时以
              // `Value::Nil` 占位——它的 push 分支就是 `lua_pushnil`，与旧实现逐指令
              // 同构，于是这里的裸边界压栈消失。
              let nil = Value::Nil;
              if lua.push_value(values.front().unwrap_or(&nil)).is_err() {
                return Poll::Ready(Err(Error::runtime("ulua-rt: failed to push yield value")));
              }
            } else {
              // Multiple: pack into a sequence table.
              match lua.create_sequence_from(values) {
                // 序列表由上一行刚创建、句柄存活；`t.push_to_stack()` 是 safe 封装
                // （`lua_rawgeti` 自带栈预留），owning VM 一致由 move-not-share 保证。
                Ok(t) => t.push_to_stack(),
                Err(e) => return Poll::Ready(Err(e)),
              }
            }
            // 计数净压一层（`push_int` 门面），是 `poll_c` 识别的 `[marker, values, count]`
            // 尾形。
            push_int(state, count);
            Poll::Pending
          }
          // Second poll (after resume): collect the resume values.
          None => {
            // We are running inside `poll(future, <resume values>)`, so the
            // coroutine stack is `[future, resume1, resume2, ...]`: the resume
            // values sit above index 1 (the future). Collect with `base = 1`,
            // which truncates back to the future — index 1 is *not* a result
            // and must stay in place for `poll_c`. multi-ret 的复制头寸（原先
            // 这里是一句结果被忽略的 `lua_checkstack`）现由
            // `collect_results_above` 统一检查，不足时截回并返回 Err。
            let result = lua
              .collect_results_above(1)
              .and_then(|results| R::from_lua_multi(results, &lua));
            Poll::Ready(result)
          }
        }
      })
      .await
    }
  }
}

// ---------------------------------------------------------------------------
// LuaNativeAsyncFn: arity-abstracting async closure trait (mirrors mlua)
// ---------------------------------------------------------------------------

/// An async function/closure callable with a tuple of `FromLuaMulti` arguments,
/// abstracting over arity. Mirrors `mlua::LuaNativeAsyncFn`. Lets
/// [`Function::wrap_async`](crate::Function::wrap_async) accept `||`, `|a|`,
/// `|a, b|`, … closures uniformly.
///
/// 与 mlua 的 `BoxedAsyncFnFuture`（`Pin<Box<dyn Future>>`）不同：返回的 future
/// 以关联类型 [`LuaNativeAsyncFn::Fut`] 承载各 arity impl 的闭包返回类型 `Fut`。
/// 本 crate 内 `call` 的调用点（`Function::wrap_async` / `wrap_raw_async`）全为
/// 泛型单态化，无需擦除成统一 dyn 形态——每次调用省一次堆装箱，且逐次 `poll`
/// 是静态调用、无 vtable 间接。
pub trait LuaNativeAsyncFn<A: FromLuaMulti> {
  /// The (non-`Future`) output type produced by the returned future.
  type Output;

  /// `call` 返回的具体 future：即闭包 `Fn(..) -> Fut` 的返回类型，按
  /// `(FN, 参数元组)` 单态化。`Send` 要求由 [`MaybeSend`] 按 `send` feature
  /// 门控（非 send 构建下为空约束）。
  type Fut: Future<Output = Self::Output> + MaybeSend + 'static;

  /// Invoke the closure with the converted args, returning its future.
  fn call(&self, args: A) -> Self::Fut;
}

macro_rules! impl_lua_native_async_fn {
    ($($T:ident: $v:ident),*) => {
        impl<FN, $($T,)* Fut, R> LuaNativeAsyncFn<($($T,)*)> for FN
        where
            FN: Fn($($T,)*) -> Fut + MaybeSend + 'static,
            ($($T,)*): FromLuaMulti,
            Fut: Future<Output = R> + MaybeSend + 'static,
        {
            type Output = R;
            type Fut = Fut;

            fn call(&self, args: ($($T,)*)) -> Fut {
                let ($($v,)*) = args;
                self($($v,)*)
            }
        }
    };
}

impl_lua_native_async_fn!();
impl_lua_native_async_fn!(A: a);
impl_lua_native_async_fn!(A: a, B: b);
impl_lua_native_async_fn!(A: a, B: b, C: c);
impl_lua_native_async_fn!(A: a, B: b, C: c, D: d);
impl_lua_native_async_fn!(A: a, B: b, C: c, D: d, E: e);
impl_lua_native_async_fn!(A: a, B: b, C: c, D: d, E: e, F: f);
impl_lua_native_async_fn!(A: a, B: b, C: c, D: d, E: e, F: f, G: g);
impl_lua_native_async_fn!(A: a, B: b, C: c, D: d, E: e, F: f, G: g, H: h);

// ---------------------------------------------------------------------------
// WrappedAsync: an `IntoLua` adapter for `Function::wrap_async{_raw}`
// ---------------------------------------------------------------------------

/// An async closure not yet bound to a [`Lua`]. Becomes a Lua async function
/// (via [`Lua::create_async_function`]) when converted with [`IntoLua`].
///
/// Used to implement [`Function::wrap_async`](crate::Function::wrap_async) /
/// [`Function::wrap_raw_async`](crate::Function::wrap_raw_async), which can be
/// constructed without a `Lua` in hand.
pub(crate) struct WrappedAsync<F, A, FR, R> {
  func: F,
  _marker: PhantomData<fn(A) -> (FR, R)>,
}

impl<F, A, FR, R> WrappedAsync<F, A, FR, R>
where
  F: Fn(Lua, A) -> FR + MaybeSend + 'static,
  A: FromLuaMulti,
  FR: Future<Output = Result<R>> + MaybeSend + 'static,
  R: traits::IntoLuaMulti,
{
  pub(crate) fn new(func: F) -> Self {
    WrappedAsync {
      func,
      _marker: PhantomData,
    }
  }
}

impl<F, A, FR, R> IntoLua for WrappedAsync<F, A, FR, R>
where
  F: Fn(Lua, A) -> FR + MaybeSend + 'static,
  A: FromLuaMulti,
  FR: Future<Output = Result<R>> + MaybeSend + 'static,
  R: traits::IntoLuaMulti,
{
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let func = self.func;
    let f = lua.create_async_function(move |lua, a: A| func(lua, a))?;
    Ok(Value::Function(f))
  }
}

// ---------------------------------------------------------------------------
// AsyncThread: drives a coroutine as a Rust Future / Stream
// ---------------------------------------------------------------------------

/// A coroutine being driven to completion by a Rust executor.
///
/// Mirrors `mlua::AsyncThread`. Created by
/// [`Thread::into_async`](crate::Thread::into_async),
/// [`Function::call_async`](crate::Function::call_async), and the `*_async`
/// chunk helpers.
///
/// * As a [`Future`] it resumes the coroutine until it finishes, discarding any
///   intermediate `coroutine.yield` values, and resolves to the final return
///   value(s) converted to `R`.
/// * As a [`Stream`](futures_util::stream::Stream) it yields one item per
///   `coroutine.yield`, then ends when the coroutine returns.
///
/// While the underlying async function's future is pending, the coroutine
/// yields the internal pending marker and this `AsyncThread` returns
/// `Poll::Pending`, registering the executor's waker for the next poll.
#[must_use = "futures do nothing unless you `.await` or poll them"]
pub struct AsyncThread<R> {
  thread: Thread,
  /// The args for the *next* resume. `Some` until consumed by the first
  /// resume; subsequent resumes pass an empty `MultiValue`.
  args: Option<MultiValue>,
  /// Set once the coroutine has finished (or errored), so a second poll
  /// returns `CoroutineUnresumable` like mlua.
  done: bool,
  /// Whether the underlying coroutine was created implicitly by `call_async`
  /// (and hence registered in the thread-ownership map / to be unregistered
  /// on drop).
  implicit: bool,
  _ret: PhantomData<fn() -> R>,
}

impl<R> AsyncThread<R> {
  pub(crate) fn new(thread: Thread, args: MultiValue) -> AsyncThread<R> {
    AsyncThread {
      thread,
      args: Some(args),
      done: false,
      implicit: false,
      _ret: PhantomData,
    }
  }

  /// Mark this as an implicit (`call_async`-created) thread, so its
  /// ownership-map entry is cleaned up on drop.
  pub(crate) fn set_implicit(&mut self, implicit: bool) {
    self.implicit = implicit;
  }

  /// Take the resume args (first resume gets the real args, later ones empty).
  fn take_args(&mut self) -> MultiValue {
    self.args.take().unwrap_or_default()
  }
}

impl<R> Drop for AsyncThread<R> {
  fn drop(&mut self) {
    // If the coroutine is still suspended (e.g. the executor dropped us mid
    // future, as in `tokio::time::timeout`), resume it once with the
    // terminate signal so it drops its in-flight future and ends its
    // borrows. Best-effort.
    if !self.done {
      self.thread.terminate_async();
    }
    if self.implicit {
      // `co_state` 是 `Thread` 内 `NonNull → &mut` 的带契约收口点;此刻协程
      // 对象仍由 `thread` 的注册表引用锚定存活(driver drop 在 VM close 前)。
      unregister_implicit_thread(self.thread.co_state());
    }
  }
}

impl<R: FromLuaMulti> Future for AsyncThread<R> {
  type Output = Result<R>;

  fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    let this = self.get_mut();
    if this.done {
      return Poll::Ready(Err(Error::CoroutineUnresumable));
    }
    let lua = this.thread.lua();
    let _wg = set_current_waker(lua.state(), cx.waker().clone());

    let args = this.take_args();
    match this.thread.resume_for_async(args) {
      Err(e) => {
        this.done = true;
        Poll::Ready(Err(e))
      }
      Ok(AsyncResume::Pending) => {
        // Future is pending; park until the executor re-polls.
        Poll::Pending
      }
      Ok(AsyncResume::Yielded(_vals)) => {
        // As a Future we discard plain `coroutine.yield` values and keep
        // driving: wake immediately so the executor re-polls and resumes.
        cx.waker().wake_by_ref();
        Poll::Pending
      }
      Ok(AsyncResume::Returned(vals)) => {
        this.done = true;
        Poll::Ready(R::from_lua_multi(vals, &lua))
      }
    }
  }
}

impl<R: FromLuaMulti> Stream for AsyncThread<R> {
  type Item = Result<R>;

  fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    let this = self.get_mut();
    if this.done {
      return Poll::Ready(None);
    }
    let lua = this.thread.lua();
    let _wg = set_current_waker(lua.state(), cx.waker().clone());

    let args = this.take_args();
    match this.thread.resume_for_async(args) {
      Err(e) => {
        this.done = true;
        Poll::Ready(Some(Err(e)))
      }
      Ok(AsyncResume::Pending) => Poll::Pending,
      Ok(AsyncResume::Yielded(vals)) => {
        // A `coroutine.yield` produces a Stream item.
        Poll::Ready(Some(R::from_lua_multi(vals, &lua)))
      }
      Ok(AsyncResume::Returned(vals)) => {
        // Final return is the last Stream item.
        this.done = true;
        Poll::Ready(Some(R::from_lua_multi(vals, &lua)))
      }
    }
  }
}
