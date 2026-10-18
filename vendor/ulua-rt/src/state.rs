//! The [`Lua`] handle and the shared inner state.
//!
//! ## Lifetime model (mirrors mlua's `Rc<inner> + registry-key` design)
//!
//! [`Lua`] owns the VM state as a `NonNull<LuaState>` handle (type-level
//! non-null; the FFI boundary converts). The state is wrapped in an
//! [`std::rc::Rc`] (`LuaInner`) so that long-lived handles ([`Table`], [`Function`],
//! [`LuaString`], the corresponding [`Value`] variants, userdata) can hold a
//! clone of that `Rc` and keep the state alive for as long as they exist.
//!
//! Each such handle additionally holds a **registry reference** obtained via
//! [`lua_ref`] (ulua's `lua_ref`/`lua_unref`). That keeps the underlying Lua
//! value reachable by the GC, and lets the handle re-push the value onto the
//! stack on demand. On `Drop` the handle releases its registry slot with
//! [`lua_unref`] — but only if the state is still alive (the `Rc` keeps it so).
//!
//! `Lua` is single-threaded (`Rc`, so `!Send`/`!Sync`), matching mlua's
//! non-`Send` default.
//!
//! ## The `send` feature
//!
//! Under the `send` feature (mirroring mlua) the shared interior uses
//! `XRc` = `Arc` instead of `Rc`, and `LuaInner` / `LuaRef` carry a
//! documented `unsafe impl Send`. That makes [`Lua`] and every handle `Send` so
//! the whole VM can be **moved** to another thread. It is *not* made `Sync`: the
//! VM is still single-threaded, the user must serialize all access, and only the
//! ownership *transfer* crosses threads (exactly mlua's `send` contract).

#[cfg(feature = "typecheck")]
use core::cell::RefCell;
#[cfg(feature = "async")]
use core::future::Future;
use core::{
  ffi::c_void,
  marker::PhantomData,
  ops::{Deref, DerefMut},
  ptr::{NonNull, null, null_mut},
};
use std::{cell::Cell, sync::Arc};

#[cfg(feature = "jit")]
use ulua_code_gen::functions::{
  is_supported::is_supported, luau_codegen_create::luau_codegen_create,
  luau_codegen_create::luau_codegen_create_forn_trace_only,
};
use ulua_common::records::f_value::set_luau_bool_flags;

#[cfg(feature = "async")]
use crate::async_support::{clear_async_state, create_async_callback};
// Re-export the GC-control types here so they live at `ulua_rt::state::{..}`,
// matching mlua's `mlua::state::{GcMode, GcIncParams, GcGenParams}` path.
pub use crate::gc::{GcGenParams, GcIncParams, GcMode};
#[cfg(feature = "serde")]
use crate::serde::clear_sentinels;
#[cfg(feature = "typecheck")]
use crate::{TypeDiagnostic, typecheck, typecheck::check_with_definitions};
use crate::{
  app_data::clear_app_data,
  buffer::{self, Buffer},
  callback::{create_callback_function, recover_wrapped_error, wrap_mut_closure},
  chunk::{Chunk, ChunkMode, ChunkSource, DEFAULT_CHUNK_NAME},
  error::{Error, Result},
  function::Function,
  interrupt::clear_interrupt,
  luau_ext::clear_vm_state,
  memory::{MemoryControls, clear_memory, clear_memory_categories},
  multi::MultiValue,
  options::{LuaOptions, StdLib},
  registry::RegHandle,
  string::{self, LuaString},
  sync::{MaybeSend, MaybeSync, NOT_SYNC, NotSync, XRc, XWeak},
  sys::{LuaDestructor, *},
  table::{self, Table, number_at},
  traits::{FromLua, FromLuaMulti, IntoLua, IntoLuaMulti},
  userdata::{self, AnyUserData, UserData},
  value::{self, Integer, Number, Value},
  vector::Vector,
  vm_store::vm_key,
};

/// 内存类别 0：VM 隐式的 "main" 类别（`LuaInner` 关闭前重置用）。
/// 与 `memory.rs` 的类别 id 同域（u8），`as i32` 留给 `lua_setmemcat` 调用点。
const MEMCAT_MAIN: u8 = 0;

/// VM state 的**驱动视图**:对自引用 VM 图一次借用的 newtype 封装(§2:裸句柄
/// → 带生命周期视图)。
///
/// 之所以不是 `&mut LuaState`:`Lua`/`LuaRef`/`Thread` 等句柄都以共享方式克隆、
/// 持有同一 VM,「共享输入导出 `&mut`」既触发 `clippy::mut_from_ref`(正确性
/// lint,`UnsafeCell` 也不豁免),也虚假声明了编译器验证的排他。本类型以
/// `NonNull` 编码非空、以 `PhantomData` 锚定生命周期,携带的语义是**驱动契约**
/// 而非借用排他:同一 state 的多个视图只在单线程串行驱动(move-not-share)中
/// **顺序**使用,从不重叠解引用;每个视图在其 VM 边界(`as_ptr`/`as_mut_ptr`
/// 的 FFI 实参位)立即还原裸指针,不跨 `lua_pcall`/`lua_resume` 等 VM 重入点
/// 寄存 Rust 引用语义。
///
/// `Deref/DerefMut` 让视图直达 `LuaState` 的固有安全方法(ulua-vm 已收口的
/// `get_top`/`pop`/`push_*` 等,具名字段/方法调用,无 `unsafe`);视图只能经
/// 两类带契约的收口点产生——句柄的 [`Lua::state`]/[`LuaRef::state`]/
/// [`Thread::co_state`](纯指针拷贝,存活由句柄锚定)与 [`StateView::from_raw`]
/// (C-ABI trampoline 入口的一次转换)。
#[derive(Clone, Copy)]
pub(crate) struct StateView<'a> {
  ptr: NonNull<LuaState>,
  _lt: PhantomData<&'a mut LuaState>,
}

impl<'a> StateView<'a> {
  /// C-ABI 边界收口点:把 VM 实时传入的裸 state 指针转成视图(trampoline 入口
  /// 与 `LuaInner::drop` 共用)。
  ///
  /// # Safety
  /// `raw` 必须非空、存活,且正由当前线程驱动(trampoline 为受保护 C 边界内的
  /// 实参,Drop 为 `Rc`/`Arc` 计数归零后的独占);返回视图(及其全部拷贝)只在
  /// 当前驱动序列内使用。null 输入是调用方违约,当场 panic(比后续空指针解引用
  /// UB 更响亮的等价失败)。
  #[inline]
  pub(crate) unsafe fn from_raw(raw: *mut LuaState) -> StateView<'a> {
    StateView {
      ptr: NonNull::new(raw).expect("LuaState must not be null"),
      _lt: PhantomData,
    }
  }

  /// 从句柄缓存的非空指针构造视图([`Lua::state`]/[`LuaRef::state`]/
  /// [`Thread::co_state`](crate::thread::Thread::co_state) 共用;存活由句柄
  /// 锚定,驱动契约见类型文档)。纯指针拷贝,无 `unsafe`。
  #[inline]
  pub(crate) fn from_handle(ptr: NonNull<LuaState>) -> StateView<'a> {
    StateView {
      ptr,
      _lt: PhantomData,
    }
  }

  /// FFI 实参位:只读裸指针(供 `lua_*` 自由函数按其 `# Safety` 契约消费)。
  #[inline]
  pub(crate) fn as_ptr(self) -> *const LuaState {
    self.ptr.as_ptr()
  }

  /// FFI 实参位:可变裸指针(同上)。
  #[inline]
  pub(crate) fn as_mut_ptr(self) -> *mut LuaState {
    self.ptr.as_ptr()
  }
}

impl Deref for StateView<'_> {
  type Target = LuaState;
  #[inline]
  fn deref(&self) -> &LuaState {
    // Safety: 视图的产生收口点已论证 state 存活(句柄锚定或 C 边界实参);
    // 共享解引用只在单次方法调用内。
    unsafe { self.ptr.as_ref() }
  }
}

impl DerefMut for StateView<'_> {
  #[inline]
  fn deref_mut(&mut self) -> &mut LuaState {
    // Safety: 驱动契约(见类型文档):本 `&mut` 只覆盖一次方法调用的瞬时,
    // 同一 state 的视图从不重叠解引用。
    unsafe { &mut *self.ptr.as_ptr() }
  }
}

// 本文件 safe 门面族的统一形参形态:`state` 一律以 [`StateView`] 传入
// (非空+生命周期由类型表达);族内只剩两类边界:其一,`LuaState` 的固有安全
// 方法(`get_top`/`pop`/`push_*` 等,ulua-vm 已收口)直接以具名字段/方法调用,
// 无 `unsafe`;其二,仍为 `pub unsafe fn` 的 `lua_*` 自由函数,在其调用处保留
// 一行 `// Safety`(族级契约,见各处)。族级调用序契约(正确性,非内存安全):
// `state` 正由当前线程驱动(VM 单线程串行纪律),`idx` 是合法栈索引(正/负或
// `LUA_GLOBALSINDEX`/`LUA_REGISTRYINDEX - n`/`lua_upvalueindex(n)` 伪索引)。

/// 为一次栈操作预留 `slots` 个空位；不足时返回可捕获的 `RuntimeError`
/// （而不是让后续 push 触发 VM 断言 abort）。
/// `Table` 系列原始访问、`Function::call`、`Thread::resume`、`exec_raw` 共用。
pub(crate) fn ensure_stack(mut state: StateView<'_>, slots: i32) -> Result<()> {
  if lua_checkstack(&mut state, slots) == 0 {
    return Err(Error::runtime("stack overflow: not enough Lua stack space"));
  }
  Ok(())
}

/// [`ensure_stack`] 的 infallible 版：供签名固定、无法向上抛错的公开安全入口
/// （如 [`Table::raw_len`]、[`LuaString::as_bytes`]、[`Buffer::as_slice`]、
/// [`Thread::from_ref`]）使用。这些入口若栈头寸不足，其内部句柄 push 在裁剪
/// 断言后会越栈写（UB）；相比静默返回错误数据或跳过写操作，panic 是仓库既有
/// 约定（`Buffer::bytes`/`write_bytes` 即以 `assert!`/`expect` 收口）下唯一可观察的失败
/// 方式，故与可抛错入口共用同一道 `lua_checkstack` 闸门，只是把 `Err` 转成
/// panic。`#[track_caller]` 让 panic 定位到调用点而非本函数。
#[track_caller]
pub(crate) fn ensure_stack_or_panic(state: StateView<'_>, slots: i32) {
  if let Err(e) = ensure_stack(state, slots) {
    panic!("{e}");
  }
}

/// 在 VM safepoint 这类「`l->top` 可能恰抵 `ci->top`」的位置直接为栈预留 `slots`
/// 层头寸（`lua_rawcheckstack` 收口点）。
///
/// 与 [`ensure_stack`] 的区别：走 VM 的 raw 变体，不经会于 safepoint 失败的 api 断言。
/// interrupt trampoline 在 `raise_lua_error` 前用它——该 facade 自身的 `push_bytes`
/// 需要一个已就位的空位才能维持 `api_incr_top` 不变式。
#[inline]
pub(crate) fn raw_reserve_stack(mut state: StateView<'_>, slots: i32) {
  lua_rawcheckstack(&mut state, slots)
}

/// `idx` 处当前是否处于可让出点（`lua_isyieldable` 收口点，返回布尔）。
///
/// 只读该 state 的执行上下文，不触指针、不动栈深；调用点（interrupt trampoline）
/// 保证 state 正由当前线程驱动。
#[inline]
pub(crate) fn is_yieldable(state: StateView<'_>) -> bool {
  lua_isyieldable(&state) != 0
}

/// 读栈深（`lua_gettop`）的 safe 门面：`LuaState::get_top` 是 ulua-vm 已收口的
/// 安全方法,引用进来即纯 Rust 读数。
#[inline]
pub(crate) fn stack_top(state: StateView<'_>) -> i32 {
  state.get_top()
}

/// 把栈截断/填充到绝对深度 `top`（`lua_settop` 的收口点，等价 `lua_pop` 的通用形态）。
///
/// 调用序契约（正确性，非内存安全）：`top` 是合法深度——截回不剥活寄存器、
/// 填充时目标深度在已预留头寸内。由 `collect_results_above` 等调用点维持（各自刚记录/预留
/// 对应深度）。
#[inline]
pub(crate) fn set_stack_top(mut state: StateView<'_>, top: i32) {
  state.set_top(top)
}

/// 弹出栈顶 `n` 个值（`lua_pop` 的收口点，即 [`set_stack_top`] 的 `top = gettop - n` 特化）。
///
/// 调用序契约（正确性，非内存安全）：`n` ≤ 当前栈深——各调用点都是刚压入
/// 对应层数随即弹回，配平栈。
#[inline]
pub(crate) fn pop_stack(mut state: StateView<'_>, n: i32) {
  state.pop(n)
}

/// 复制栈槽 `idx` 到栈顶（`lua_pushvalue` 的收口点），与 [`pop_stack`] 同族。
///
/// 调用序契约（正确性，非内存安全）：`idx` 是有效栈索引（正数、负数或
/// `LUA_GLOBALSINDEX`/`LUA_REGISTRYINDEX - n`/`lua_upvalueindex(n)` 伪索引）。
/// VM 侧 `lua_pushvalue` 自带 `ensure_stack(l, 1)`，净压一层，由调用点维持栈配平。
#[inline]
pub(crate) fn clone_slot_to_top(mut state: StateView<'_>, idx: i32) {
  state.push_value(idx)
}

/// 把主线程的全局表净压一层到给定 state 的栈顶（[`clone_slot_to_top`] 在
/// `LUA_GLOBALSINDEX` 伪索引上的定特）。
///
/// 调用序契约（正确性，非内存安全）：顶部留有 1 层空位——VM 侧
/// `lua_pushvalue` 自带 `ensure_stack(l, 1)`，但调用方的帧头寸约定仍须由调用点维持。
#[inline]
pub(crate) fn push_globals_to_stack(state: StateView<'_>) {
  // `LUA_GLOBALSINDEX` 是合法伪索引，`clone_slot_to_top` 的收口契约即此。
  clone_slot_to_top(state, LUA_GLOBALSINDEX);
}

/// 向栈压入 `nil`（`lua_pushnil` 的收口点），与 [`pop_stack`] 同族。
///
/// 调用序契约（正确性，非内存安全）：净压一层，由调用点维持栈配平
/// （VM 侧 `lua_pushnil` 自带 `ensure_stack(l, 1)`）。
#[inline]
pub(crate) fn push_nil(mut state: StateView<'_>) {
  state.push_nil()
}

/// 向栈压出一个 `f64`（`lua_pushnumber` 的收口点），与 [`push_nil`] 同族。
///
/// 调用序契约（正确性，非内存安全）：净压一层；`n` 是任意 `f64`
/// （NaN 亦按 VM 的数值表示写入，不做值域校验）。
#[inline]
pub(crate) fn push_number(mut state: StateView<'_>, n: f64) {
  state.push_number(n)
}

/// 消费栈顶值并写入 `LUA_GLOBALSINDEX` 伪索引（"换全局表"三步曲的落点，
/// `lua_replace` 的收口点）。
///
/// 调用序契约（正确性，非内存安全）：栈顶恰有 1 个待落的新全局表
/// ——各调用点都是刚 `push`/`xmove` 完全局表随即调用。`replace` 消费该层并落合法
/// 伪索引，净弹一层。
#[inline]
pub(crate) fn replace_globals_from_top(mut state: StateView<'_>) {
  state.replace(LUA_GLOBALSINDEX)
}

/// 读栈槽 `idx` 处值的长度（`lua_objlen`/`#t` 的只读收口点）。
///
/// 调用序契约（正确性，非内存安全）：`idx` 处是 string/table/userdata/
/// buffer 之一（各调用点先用 `LuaType` 判定再读）；其它类型按 VM 约定返回 0。
#[inline]
pub(crate) fn slot_length(state: StateView<'_>, idx: i32) -> usize {
  state.obj_len(idx)
}

/// 向栈压入一个整数（`lua_pushinteger` 的收口点），与 [`ensure_stack`] 同族。
///
/// 调用序契约（正确性，非内存安全）：压栈净增一层，由调用点维持栈配平。
#[cfg(feature = "async")]
#[inline]
pub(crate) fn push_int(mut state: StateView<'_>, n: i32) {
  state.push_integer(n)
}

/// 把栈索引 `idx` 处的值在注册表登记，返回其正槽位 id（`lua_ref` 的收口点）。
///
/// 调用序契约（正确性，非内存安全）：`idx` 是有效栈槽。`lua_ref` 只读栈槽、
/// 在注册表落一份引用并返回正 id，**不弹栈**（弹出由调用方 [`pop_stack`] 或值本身生命周期决定）。
#[inline]
pub(crate) fn register_slot(mut state: StateView<'_>, idx: i32) -> i32 {
  lua_ref(&mut state, idx)
}

/// `LUA_MULTRET` 收集路径（`Function::call`、`Lua::exec_raw`、协程 resume）
/// 栈头寸不足时的统一错误文案。
pub(crate) const TOO_MANY_RESULTS_MSG: &str = "stack overflow: too many return values";

// ===========================================================================
// 栈槽查询 / 压栈 / 原语 safe 门面族。
//
// 本族契约统一在本文件头部「safe 门面族的统一形参形态」处论证一次:`state`
// 以 [`StateView`] 驱动视图传入(非空+存活由类型表达),正由当前线程驱动;
// `idx` 是合法栈索引(正、负或 `LUA_GLOBALSINDEX`/`LUA_REGISTRYINDEX - n`/
// `lua_upvalueindex(n)` 伪索引)。`LuaState` 的固有方法是 ulua-vm 已收口的
// 安全方法,直接调用无 `unsafe`;仍为 `pub unsafe fn` 的 `lua_*` 自由函数在
// 各调用处保留一行族级 `// Safety`。
// ===========================================================================

/// 读栈槽 `idx` 处值的类型标签（`lua_type` 的收口点）。
#[inline]
pub(crate) fn type_at(state: StateView<'_>, idx: i32) -> LuaType {
  state.type_of(idx)
}

/// `idx` 处是否为 string（[`type_at`] 同族收口点，以下 `is_*` / `*_at` 诸门面
/// 均共享同一契约，注释只标注行为差异）。
#[inline]
pub(crate) fn is_string_at(state: StateView<'_>, idx: i32) -> bool {
  state.is_string(idx)
}

/// `idx` 处是否为 table。
#[inline]
pub(crate) fn is_table_at(state: StateView<'_>, idx: i32) -> bool {
  state.is_table(idx)
}

/// `idx` 处是否为 full userdata。
#[inline]
pub(crate) fn is_userdata_at(state: StateView<'_>, idx: i32) -> bool {
  state.is_userdata(idx)
}

/// `idx` 处是否为 `LUA_TINTEGER` 子类型（i64 tag，区别于 f64 number）。
#[inline]
pub(crate) fn is_integer64_at(state: StateView<'_>, idx: i32) -> bool {
  state.is_integer_64(idx)
}

/// 读 `idx` 处布尔值（`lua_toboolean` 语义：nil/false 为 false，其余 true）。
#[inline]
pub(crate) fn boolean_at(state: StateView<'_>, idx: i32) -> bool {
  state.to_boolean(idx)
}

/// 读 `idx` 处 i64 整数值。
///
/// 调用序契约：`idx` 处必须是 `LUA_TINTEGER`（各调用点在 [`type_at`] /
/// [`is_integer64_at`] 判定后才走此入口），否则 VM 侧 `tag_error` abort。
#[inline]
pub(crate) fn check_int64_at(mut state: StateView<'_>, idx: i32) -> i64 {
  state.check_integer_64(idx)
}

/// 向栈压出布尔值（`lua_pushboolean` 的收口点，净压一层）。
#[inline]
pub(crate) fn push_boolean(mut state: StateView<'_>, b: bool) {
  state.push_boolean(b)
}

/// 向栈压出 i64 整数（`lua_pushinteger_64` 的收口点，保留 LUA_TINTEGER tag）。
#[inline]
pub(crate) fn push_int64(mut state: StateView<'_>, n: i64) {
  state.push_integer_64(n)
}

/// 向栈压出 vector（`lua_pushvector_lua_state_f32_f32_f32_f32` 收口点）。
///
/// 本构建为 3-wide：第 4 分量按 VM 约定忽略（各调用点传 0.0）。
#[inline]
pub(crate) fn push_vector(state: StateView<'_>, x: f32, y: f32, z: f32) {
  // Safety: 族级契约;四个分量均为普通 f32 标量,无借用/对齐前提。
  unsafe { lua_pushvector_lua_state_f32_f32_f32_f32(state.as_mut_ptr(), x, y, z, 0.0) }
}

/// 向栈压出字节串（`lua_pushlstring_bytes` 的收口点，拷贝语义，净压一层）。
#[inline]
pub(crate) fn push_bytes(state: StateView<'_>, s: &[u8]) {
  // Safety: 族级契约;`&mut *` 重借由 `StateView` 的存活指针位给出，`s` 是普通 Rust
  // 切片,VM 侧拷入堆上字符串,无存续期耦合。
  unsafe { lua_pushlstring_bytes(&mut *state.as_mut_ptr(), s) }
}

/// 读 `idx` 处字符串字节（`lua_tolstring_ref` 的收口点；非 string 返回 `None`）。
///
/// 存续期契约升格为 `# Safety` 屏障（r16-v26 判例）：`'a` 只出现在返回位、不锚
/// `state`——锚定路线在 rt 句柄面不成立：`StateView<'a>` 的 `PhantomData<&'a mut
/// LuaState>` 排他语义只是驱动契约、非编译器背书（构造点 [`Lua::state`]/
/// [`LuaRef::state`]/`Thread::co_state` 全取自 `&self`），持有窗口期间照样能经
/// 另一枚视图驱动分配/GC 踩碎切片。故此处不伪装可验证的借用，恢复 `unsafe fn`
/// 屏障，把窗口前提显式交给调用方：
///
/// # Safety
/// 调用方须保证返回切片指向的字节在 `'a` 实例化期间持续可读且不被改写。合法
/// 形态二选一：
/// 1. 在返回后、下一次 VM 重入点（分配 / GC step / 栈读写）之前当场完成拷贝或
///    消费——现有调用点均在此间把切片拷入 `Vec`/`Cow`/`String`；
/// 2. 该槽值是存活注册表引用钉住的 TString，且 `'a` 不超过该引用的存续期
///    （Luau GC 不搬移对象、串不可变，`as_bytes` 形，见 `string.rs`）。
///
/// 存活 state 与合法 `idx` 的前提见本函数收口的 `lua_tolstring_ref` 自身
/// `# Safety`。
#[inline]
pub(crate) unsafe fn bytes_at<'a>(state: StateView<'_>, idx: i32) -> Option<&'a [u8]> {
  // Safety: `state` 指针位存活由句柄锚定、由 [`StateView`] 驱动契约承载；`idx`
  // 合法性与本门面的窗口前提由本函数 `# Safety` 交给调用方。只读该槽字符串体，
  // 不写不抛。
  unsafe { lua_tolstring_ref(state.as_ptr().cast_mut(), idx) }
}

/// 把栈顶值与索引 `idx` 处槽位互换（`lua_insert` 收口点，净压一层并下沉原值）。
#[inline]
pub(crate) fn insert_at(mut state: StateView<'_>, idx: i32) {
  state.insert(idx)
}

/// 表遍历一步：`idx` 表的 `栈顶key` 之后取下一对 key/value，返回是否还有项。
#[inline]
pub(crate) fn next_pair(mut state: StateView<'_>, idx: i32) -> bool {
  // 调用序契约:`idx` 处须是 table(调用点判型后使用)。
  state.next(idx)
}

/// 弹栈顶 table 作 `idx` 处表的元表（`lua_setmetatable` 语义收口点，净弹一层）。
#[inline]
pub(crate) fn set_metatable_at(mut state: StateView<'_>, idx: i32) -> bool {
  // 调用序契约:栈顶是 table/nil 由调用点保证;`idx` 处须是 table。
  state.set_metatable(idx) != 0
}

/// 把 `idx` 处表的元表净压栈顶；无元表返回 `false` 且不压栈。
#[inline]
pub(crate) fn get_metatable_at(mut state: StateView<'_>, idx: i32) -> bool {
  // 调用序契约:`idx` 处须是 table。
  state.get_metatable(idx)
}

/// 设置 `idx` 处 table 的只读标志。
#[inline]
pub(crate) fn set_readonly_at(mut state: StateView<'_>, idx: i32, enabled: bool) {
  // 调用序契约:`idx` 处须是 table。
  state.set_readonly(idx, enabled)
}

/// 在受保护帧里调用栈上的函数（`lua_pcall` 收口点）：栈布局
/// `f, args…`，成功留 `nresults` 个结果，失败留错误对象并返回非零状态码。
#[inline]
pub(crate) fn run_pcall(mut state: StateView<'_>, nargs: i32, nresults: i32, msgh: i32) -> i32 {
  // 调用序契约:`f` + `nargs` 个实参已由调用点压栈,pcall 自带帧头寸。
  state.pcall(nargs, nresults, msgh)
}

/// 向 VM 发一条 GC 指令（`lua_gc` 收口点），返回该 op 的整数值（信息类 op）
/// 或 0（动作类 op）。
///
/// 调用序契约（正确性，非内存安全）：`what` 为 [`LuaGcOp`] 的合法
/// `as i32` 编码、`data` 满足该 op 的取值约定（动作类恒 0）。GC 只回收不可达
/// 对象——所有存活句柄都持注册表引用（GC 可达），信息/动作 op 均不产生悬垂读。
#[inline]
pub(crate) fn run_gc(mut state: StateView<'_>, what: i32, data: i32) -> i32 {
  lua_gc(&mut state, what, data)
}

/// 打开标准库（`lua_l_openlibs` 收口点）：只在 [`build_lua`] 的构造路径调用。
///
/// 调用序契约：`state` 是刚通过非空收口、尚未交给任何其它 `lua_*` 入口的新 state。
#[inline]
fn open_std_libs(mut state: StateView<'_>) {
  lua_l_openlibs(&mut state)
}

/// 为 `state` 的调用栈构建回溯字符串并净压一层（`lua_l_traceback` 收口点，
/// `from == to` 的自回溯特化——本 crate 全部调用点都是回溯自己）。
///
/// 调用序契约：顶部留有 1 层空位（调用点先过 [`ensure_stack`]）；
/// `msg` 的字节当场被格式进结果串，不寄存指针。
#[inline]
fn push_traceback(state: StateView<'_>, msg: Option<&str>, level: i32) {
  // Safety: 族级契约;两个 state 实参同属一个存活 VM(自回溯),`msg` 是普通
  // Rust `Option<&str>`,调用当场拷成内部字符串、不跨帧存续借用。
  unsafe { lua_l_traceback(&mut *state.as_mut_ptr(), state.as_mut_ptr(), msg, level) }
}

/// 读 `idx` 处值的 metatable-aware `tostring` 结果字节（`lua_l_tolstring_ref` 的
/// 收口点；转换成功时结果串已净压一层，非字符串载荷等 VM 约定失败返回 `None`）。
///
/// # Safety
/// 存续期窗口契约同 [`bytes_at`]（r16-v26 判例），另加一层转换重入前提：转换
/// 可在 VM 内回跑 `__tostring`（可分配、可触发 GC）并压入结果串，返回切片指向
/// 栈顶结果串内部——调用方须保证 `'a` 期间其不被回收且不被改写；现有调用点均
/// 在返回后、无其间 VM 调用的紧邻表达式里当场 lossy 拷成 owned `String`（形态
/// 1）。存活 state、合法 `idx` 与转换发散（`'__tostring' must return a string`
/// 经错误展开逃逸帧，返回即成功）见收口的 `lua_l_tolstring_ref` 自身 `# Safety`。
#[inline]
unsafe fn tolstring_at<'a>(state: StateView<'_>, idx: i32) -> Option<&'a [u8]> {
  // Safety: `state` 指针位存活由句柄锚定（[`StateView`] 驱动契约）；`idx` 合法
  // 性与窗口前提由本函数 `# Safety` 交给调用方；转换在 VM 内完成（可触发
  // `__tostring` 并压入结果串）。w6e 收形消费点：`lua_l_tolstring_ref` 首参已折
  // `&mut LuaState`，借用窗止于当句，经句柄裸形就地重建。
  unsafe { lua_l_tolstring_ref(&mut *state.as_mut_ptr(), idx) }
}

/// 读 `idx` 处值的对象地址（`lua_topointer` 收口点；仅作身份比较、从不解引用，
/// 与 [`LightUserData`](crate::LightUserData) 的 token 同语义）。
#[inline]
pub(crate) fn pointer_at(mut state: StateView<'_>, idx: i32) -> *const c_void {
  // r16-v8：`lua_topointer` 已收口引用形 safe 签名，`&mut state` 经 DerefMut 协变
  // 仅覆盖本调用语句（同 `push_own_thread` 形制）；返回 GC 对象地址或 null，
  // 不移动值、不改栈深。
  lua_topointer(&mut state, idx)
}

/// 以栈顶值为错误对象沿 VM 的错误展开发散（`lua_error` 收口点，不返回）。
///
/// 调用序契约：state **正由当前线程在受保护 C 边界（trampoline/hook）
/// 内驱动**，且栈顶恰有 1 个已压入的错误对象。这是全 crate「向 VM 抛错」的
/// 唯一 `lua_error` 边界；发散经 VM 自身的 longjmp 式展开逃逸调用帧。
#[inline]
pub(crate) fn raise_from_top(mut state: StateView<'_>) -> ! {
  lua_error(&mut state)
}

/// 裸取 `idx` 表键值（栈顶为 key，成功后弹 key 压 value；返回值的类型标签）。
#[inline]
pub(crate) fn raw_get_at(mut state: StateView<'_>, idx: i32) -> i32 {
  lua_rawget(&mut state, idx)
}

/// 裸存 `idx` 表键值（栈布局 `key, value`，成功后弹出两者）。
#[inline]
pub(crate) fn raw_set_at(mut state: StateView<'_>, idx: i32) {
  lua_rawset(&mut state, idx)
}

/// 把 `idx` 表的整数键 `n` 对应值净压栈顶（`lua_rawgeti` 收口点，VM 侧自带 1 层头寸）。
///
/// 调用序契约：`idx` 处须是 table（越界键读出 nil 仍占一层）。注册表引用重取
/// （[`LuaRef::push`]）与 `async::unpack_c` 的循环读键共用此收口点。
#[inline]
pub(crate) fn raw_geti(mut state: StateView<'_>, idx: i32, n: i32) {
  lua_rawgeti(&mut state, idx, n);
}

/// 比较两栈槽是否 VM 等值（`lua_equal` 收口点，对 nil/数字/字符串按 Lua 语义）。
#[inline]
pub(crate) fn slots_equal(mut state: StateView<'_>, a: i32, b: i32) -> bool {
  lua_equal(&mut state, a, b) != 0
}

/// 读 `idx` 处 table 的只读标志（`lua_getreadonly` 收口点）。
#[inline]
pub(crate) fn readonly_at(state: StateView<'_>, idx: i32) -> bool {
  lua_getreadonly(&state, idx) != 0
}

/// 压出 tagged light userdata（poll/回调分派用的不透明标记指针）。
///
/// 调用序契约：`p` 指向 `PollKind` 等 `'static`-语义（或调用点保证存活到消费点）
/// 的静态枚举的 token，tag 与 VM 侧约定一致。
#[inline]
pub(crate) fn push_lightuserdata_tagged(state: StateView<'_>, p: *mut c_void, tag: i32) {
  // Safety: 族级契约;light userdata 不入堆、无 GC 耦合,只写 top。
  unsafe { lua_pushlightuserdatatagged(state.as_mut_ptr(), p, tag) }
}

/// 读 light userdata 指针（`lua_tolightuserdata_ref` 收口点）。
///
/// 忠实返回被调 safe 门面的 `Option`：`Some(p)` 表示该槽确是 light userdata
/// （其载荷本身可为 null），`None` 严格表示「非 light userdata」。不再把 `Option`
/// 折算回 null 哨兵（review.md §2：可空 → `Option`，判空哨兵就此消失）。
#[inline]
pub(crate) fn lightuserdata_at(state: StateView<'_>, idx: i32) -> Option<*mut c_void> {
  // r16-v4b：被调方已转 `&LuaState` 引用形 safe fn——`&state` 经 `StateView::deref`
  // 既有安全读数门面短借（存活论证收口于视图产生点），原 `read_ptr().cast_mut()`
  // 裸转发与 unsafe 块随消亡；返回的是 VM 存的裸 token 或 None，本层不解引用。
  lua_tolightuserdata_ref(&state, idx)
}

/// 读 full userdata 的数据区指针（`lua_touserdata` 收口点；非 userdata 或空载荷
/// 归一为 `None`，判空哨兵就此消失）。
#[inline]
pub(crate) fn userdata_at(state: StateView<'_>, idx: i32) -> Option<NonNull<c_void>> {
  // Safety: 族级契约;返回 VM 拥有的堆块地址,存续期由 GC 与该槽决定,
  // 解引用(转 `&mut T`)仍是调用点的带契约边界。
  unsafe { lua_touserdata(state.as_mut_ptr(), idx) }.map(|r| NonNull::from(r).cast())
}

/// 新建带析构器的 full userdata 并净压栈顶，返回数据区指针；分配失败归一 `None`
/// （判空哨兵就此消失——VM 只在 OOM 时交还 null）。
///
/// 调用序契约：`dtor` 须为符合 VM `UserdataDtor` 约定的 `unsafe extern "C-unwind"`
/// 析构器（`None` 走无析构路径故此处收 `Option`），且能在其参数（数据区指针）上
/// 安全 drop 本对象内嵌类型。
#[inline]
pub(crate) fn allocate_userdata(
  state: StateView<'_>,
  size: usize,
  dtor: LuaDestructor,
) -> Option<NonNull<c_void>> {
  // Safety: 族级契约;分配走 VM 堆与 GC 记账,null(失败)经 `NonNull::new`
  // 归一为 `None`,非空性由类型表达。
  NonNull::new(unsafe { lua_newuserdatadtor(state.as_mut_ptr(), size, dtor) })
}

/// 压出带调试名、无 continuation 的 C 闭包（`lua_pushcclosurek` 收口点）。
///
/// 调用序契约：`f` 为符合 `lua_CFunction` 约定的本 crate trampoline；`nup` 个
/// 上值已由调用点压在栈顶（`nup` 为 0 时无此要求）。
///
/// 名契约：`name` 须以 NUL 结尾——C 形收口垫片按 NUL 扫描读取载荷（VM 随后经
/// intern 复制为 TString 锚，指针仅需调用期有效）；本门面保留 `&'static` 形态，
/// 调用点一律静态 `b"…\0"` 字面量。
#[inline]
pub(crate) fn push_named_closure(
  state: StateView<'_>,
  f: LuaCFunction,
  name: &'static [u8],
  nup: i32,
) {
  debug_assert!(
    name.last() == Some(&0),
    "closure debug name must be NUL-terminated"
  );
  // Safety: 族级契约;`name` 是 'static NUL 串(上面 debug_assert 兜底开发期,
  // release 下由调用点的 `b"…\\0"` 静态字面量构造性满足),满足 `debugname`
  // 存续期契约;`cont` 传 `None` 表示不可 yield 路径无续体。
  unsafe { lua_pushcclosurek(state.as_mut_ptr(), f, name.as_ptr().cast(), nup, None) }
}

/// 把 `fidx` 处闭包的第 `n` 个 upvalue **值**压栈（`lua_getupvalue` 收口点，
/// 名字就地丢弃）；返回 `false` 表示无该 upvalue 且**未压栈**。
///
/// 调用点语义：真值即净压一层，随后按层数 `pop_stack` 配平。
#[inline]
pub(crate) fn push_upvalue(state: StateView<'_>, fidx: i32, n: i32) -> bool {
  // Safety: 族级契约;非闭包 `fidx` 或越界 `n` 时 VM 返回 null 且不触栈。
  !unsafe { lua_getupvalue(state.as_mut_ptr(), fidx, n) }.is_null()
}

// --- 栈换位 / 裸调用 / 命名字段 safe 门面（族内统一契约同上）---

/// 把栈顶值落到索引 `idx` 处槽位（`lua_replace` 收口点，净弹一层）。
///
/// 与 [`replace_globals_from_top`] 同族，只是落在任意有效索引；
/// `async::report_pending` 用它把值携带 yield 的 marker（-4）原位换成 nil。
#[cfg(feature = "async")]
#[inline]
pub(crate) fn replace_slot(mut state: StateView<'_>, idx: i32) {
  // 调用序契约:栈顶恰有 1 个待落值由调用点保证,`idx` 是合法索引,
  // `replace` 消费该层并覆盖 `idx` 槽,净弹一层、界内读写。
  state.replace(idx)
}

/// 写 `idx` 表的字符串字段（栈顶值为 value，成功后弹出；`lua_setfield` 收口点）。
#[inline]
pub(crate) fn set_field_named(mut state: StateView<'_>, idx: i32, name: &str) {
  // 调用序契约:`idx` 处须是可寻址表(注册表伪索引),栈顶 value 由调用点压入,
  // 写后弹层栈平衡。
  state.set_field_str(idx, name)
}

/// 读 `idx` 表的字符串字段并净压值到栈顶（`lua_getfield` 收口点；缺字段压 nil）。
#[inline]
pub(crate) fn get_field_named(mut state: StateView<'_>, idx: i32, name: &str) {
  // 调用序契约:`idx` 处须是可寻址表,压出该字段值(无则 nil)恰一层。
  state.get_field_str(idx, name);
}

/// 释放一个已登记的注册表槽位（`lua_unref` 收口点；不触碰栈）。
///
/// 调用序契约：`id` 须是 `lua_ref` 在本 `state` 上登记、尚未释放的真实槽位
/// （调用点各自把守：`LuaRef::Drop` 判 `id > 0`，`set_registry_value` 判归属）。
#[inline]
pub(crate) fn unref_registry_slot(mut state: StateView<'_>, id: i32) {
  lua_unref(&mut state, id)
}

/// 探测 `state` 栈能否再容纳 `slots` 层（只报告头寸，不实际越界读写）。
///
/// 与 [`ensure_stack`] 同族，只是返回布尔而非 `Result`（best-effort 路径与
/// `LUA_MULTRET` 结果收集用）。
#[inline]
pub(crate) fn has_stack_room(mut state: StateView<'_>, slots: i32) -> bool {
  state.check_stack(slots)
}

// --- 协程 / 跨状态搬运 safe 门面族（`thread.rs` 专用，契约同上族）---

/// 读协程/线程当前 raw `lua_status` 码（只读，不触栈、不抛错）。
#[inline]
pub(crate) fn thread_status(state: StateView<'_>) -> i32 {
  // `lua_status` 本就收 `&LuaState`(ulua-vm 安全签名);`&state` 经 Deref 协变
  // 到 `&LuaState`,纯 Rust 读数。
  lua_status(&state)
}

/// `lua_costatus(from, co)`：`co` 相对 `from` 的角色码（只读，两侧须同属一 VM）。
#[inline]
pub(crate) fn co_status(from: StateView<'_>, co: StateView<'_>) -> i32 {
  // `lua_costatus` 本就收 `&LuaState`(ulua-vm 安全签名);`&from`/`&co` 经 Deref
  // 协变到 `&LuaState`,只读查询(调用序契约:两侧同属一 VM,见函数头)。
  lua_costatus(&from, &co)
}

/// 把 `from` 栈顶 `n` 个值搬到 `to`（`lua_xmove` 收口点，两侧同 VM）。
///
/// 调用序契约：两侧属于同一 `global_State` 且**为不同 state**（Rust 引用别名
/// 前提;`lua_xmove` 自身亦如此约定）；`n` 在 `to` 侧已预留头寸内；`from` 顶恰有
/// `n` 个待搬值且不剥走活寄存器（协程须挂起）。
#[inline]
pub(crate) fn move_slots(mut from: StateView<'_>, mut to: StateView<'_>, n: i32) {
  // 同态退化守卫（cpp `lua_xmove` 体内 `from == to` 短路的同形前移）：两枚 `&mut`
  // 实参在求值期即构造，若两侧同 state 则先于任何落笔即违 noalias——指针相等判在
  // 引用构造**之前**，语义与体内短路逐字一致（净行为=不动作）。
  if from.as_ptr() == to.as_ptr() {
    return;
  }
  lua_xmove(&mut from, &mut to, n)
}

/// 对协程 `co` 跑 `lua_resume(co, from, nargs)`，返回 raw 状态码。
///
/// 调用序契约：`co` 处于可 resume 态（挂起/新建，调用方已预检 status）、其实参恰在栈顶、
/// 两侧头寸已预留；panic 展开只经 `C-unwind` 边界。
#[inline]
pub(crate) fn resume_co(mut co: StateView<'_>, from: StateView<'_>, nargs: i32) -> i32 {
  // Safety: 调用序前提由 thread.rs 的 `resume_inner`/`resume_for_async`/
  // `terminate_async` 维持;`resume` 在受保护边界内进行。
  unsafe { co.resume(from.as_mut_ptr(), nargs) }
}

/// 以「立即 raise 栈顶错误」的方式 resume（上游 `auxresume` 的 `lua_resumeerror`）。
///
/// 调用序契约：同 [`resume_co`]，另错误对象已 `xmove` 到 `co` 栈顶。
#[inline]
pub(crate) fn resume_co_error(co: StateView<'_>, from: StateView<'_>) -> i32 {
  // Safety: 调用序前提由 `resume_error` 维持(status 预检 + 栈顶即错误对象 +
  // 头寸预留)。
  unsafe { lua_resumeerror(co.as_mut_ptr(), from.as_mut_ptr()) }
}

/// `lua_resetthread(co)`：清空 `co` 栈并回到可复用状态。
///
/// 调用序契约：`co` 非运行态（挂起/完成/错误），由调用方 status 分派保证。
#[inline]
pub(crate) fn reset_co(mut co: StateView<'_>) {
  lua_resetthread(&mut co)
}

/// 读 `idx` 处 thread 值的协程 `LuaState`（`lua_tothread` 收口点；非 thread / 空归一 `None`）。
#[inline]
pub(crate) fn thread_at(state: StateView<'_>, idx: i32) -> Option<NonNull<LuaState>> {
  // r19-w2：`lua_tothread` 首参已收窄为 `&LuaState`（本体只读一个槽），故此处经
  // Deref 只读协变即可，原 `&mut state` 与该形参的 `mut` 同为过度授权；只读该槽、
  // 不动栈深；返回 state 与该 thread 对象同生命周期（对象被注册表引用钉住 ⇒ 缓存指
  // 针随句柄存活）。
  lua_tothread(&state, idx).and_then(NonNull::new)
}

/// 新建协程并把其线程值净压 `state` 栈顶，返回协程 state（分配失败归一 `None`）。
#[inline]
pub(crate) fn spawn_thread(state: StateView<'_>) -> Option<NonNull<LuaState>> {
  // Safety: 族级契约;调用点已 `ensure_stack` 预留 1 层;`lua_newthread` 的新线程
  // 值压入有头寸,返回 null 即分配失败(经 `NonNull::new` 归一为 `None`)。
  unsafe { NonNull::new(lua_newthread(state.as_mut_ptr())) }
}

/// 把 `state` 自身线程值净压其栈顶（`lua_pushthread` 收口点，返回主/协程判定码）。
#[inline]
pub(crate) fn push_own_thread(mut state: StateView<'_>) -> i32 {
  // `lua_pushthread` 已前移为 ulua-vm 安全签名(`&mut LuaState`),`&mut state`
  // 经 DerefMut 协变;把自身线程值压到栈顶一层,无别名问题。
  lua_pushthread(&mut state)
}

// --- Luau 沙箱 / safeenv / 匿名闭包 / null light-ud safe 门面 ---

/// 对 main state 施加 Luau 沙箱（把库表与基元 metatable 设只读、置 safeenv；
/// `lua_l_sandbox` 收口点）。
#[inline]
pub(crate) fn sandbox_main(mut state: StateView<'_>) {
  // Safety: 族级契约;`lua_l_sandbox` 内部压弹的临时值全自平衡,不跨入任何
  // Rust 借用指针；`&mut state` 经 `StateView` 的 DerefMut 只覆盖本次调用。
  unsafe { lua_l_sandbox(&mut state) }
}

/// 对 `state` 的 `LUA_GLOBALSINDEX` 安装代理全局表，使全局写入留在本线程
/// （`lua_l_sandboxthread` 收口点，main state 与协程通用）。
#[inline]
pub(crate) fn sandbox_thread(mut state: StateView<'_>) {
  lua_l_sandboxthread(&mut state)
}

/// 设置 `idx` 处表的 `safeenv` 标志（`lua_setsafeenv` 收口点）。
///
/// 调用序契约：`idx` 处须是 table（globals 或 env 表），否则 VM 内部断言失败。
#[inline]
pub(crate) fn set_safeenv_flag(state: StateView<'_>, idx: i32, enabled: bool) {
  // Safety: 族级契约;`idx` 处是 table 由调用点保证,该调用只翻表对象 safeenv
  // 标志位,不压弹栈。
  unsafe { lua_setsafeenv(state.as_mut_ptr(), idx, enabled as i32) }
}

/// 压出无调试名的 C 闭包（`lua_pushcclosurek` 的 null-name 特化，供类型代表值使用）。
///
/// 调用序契约：`f` 为合法 `lua_CFunction`，`nup` 个 upvalue 已按序压在栈顶（0 时无此要求）。
#[inline]
pub(crate) fn push_anonymous_closure(state: StateView<'_>, f: LuaCFunction, nup: i32) {
  // Safety: 同 [`push_named_closure`];`name` 传 `null` 表示无调试名(VM 容忍空
  // debugname),`cont` `None` = 无续体,`nup` 个 upvalue 由调用点按契约压在栈顶。
  unsafe { lua_pushcclosurek(state.as_mut_ptr(), f, null(), nup, None) }
}

/// 压出 null 载荷、tag 0 的 tagged light userdata（类型代表值；VM 从不解引用该 token）。
#[inline]
pub(crate) fn push_null_lightuserdata(state: StateView<'_>) {
  // Safety: 同 [`push_lightuserdata_tagged`];light userdata 只按值存指针本身,
  // null + tag 0 合法且不表达任何所有权,压恰一层。
  unsafe { lua_pushlightuserdatatagged(state.as_mut_ptr(), null_mut(), 0) }
}

/// VM OOM 时错误对象的固定文案：`lua_pcall` 的 `LUA_ERRMEM` 与 `luau_load`
/// 的 OOM 均以它作错误对象，[`Lua::pop_error`] 据此识别内存错误。
const OOM_MSG: &str = "not enough memory";

/// 错误对象无法转成字符串时 [`Lua::pop_error`] 的退化文案（mlua 同字面量）。
const NON_STRING_ERROR_MSG: &str = "<non-string error>";

/// The reference-counted, shared interior of a [`Lua`] instance.
///
/// Held by [`Lua`] and cloned into every long-lived handle. When the last
/// `XRc<LuaInner>` is dropped, [`Drop`] closes the `LuaState`.
/// Kharos: жива ли машина — общий флаг владеющей и «заёмных» `Lua` одного состояния и всех их значений. Машину
/// можно закрыть сразу ([`Lua::close`]), не дожидаясь, пока отпустят последнее значение: значения, пережившие её,
/// слот реестра уже не освобождают и к состоянию не обращаются.
type Alive = XRc<core::sync::atomic::AtomicBool>;

std::thread_local! {
  static ALIVE: std::cell::RefCell<std::collections::HashMap<usize, Alive>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

fn alive_of(state: NonNull<LuaState>, owned: bool) -> Alive {
  let key = vm_key(StateView::from_handle(state));
  ALIVE
    .try_with(|map| {
      let mut map = map.borrow_mut();
      if owned {
        let flag: Alive = XRc::new(core::sync::atomic::AtomicBool::new(true));
        map.insert(key, flag.clone());
        flag
      } else {
        map.entry(key).or_insert_with(|| XRc::new(core::sync::atomic::AtomicBool::new(true))).clone()
      }
    })
    .unwrap_or_else(|_| XRc::new(core::sync::atomic::AtomicBool::new(true)))
}

pub(crate) struct LuaInner {
  /// Kharos: жива ли машина (см. [`Alive`]).
  alive: Alive,
  /// The owned VM state handle. Non-null by construction (`NonNull` encodes the
  /// invariant; the null check happens once where `lua_*` hands the pointer over).
  pub(crate) state: NonNull<LuaState>,
  /// Whether this `LuaInner` is responsible for closing the state. The
  /// trampoline builds a *borrowed* [`Lua`] around the calling thread's
  /// state and must not close it.
  owned: bool,
  /// Host type definitions accumulated via [`Lua::add_definitions`] (the
  /// `typecheck` feature), in Luau definition-file syntax. Each registration
  /// is appended separated by a newline; the whole buffer is fed to the
  /// type-checker by [`Lua::check`] / [`Chunk::check`]. Uses the crate's
  /// `RefCell` interior-mutability idiom (the VM is single-threaded).
  #[cfg(feature = "typecheck")]
  typecheck_defs: RefCell<String>,
  #[cfg(feature = "jit")]
  pub(crate) jit_enabled: Cell<bool>,
  /// FORN trace 层形态（阶段二 PoC）：trace 上下文装配护栏（每 state 至多一次
  /// ——`luau_codegen_create*` 重复调用会覆盖 `ecb.context`，旧上下文失配成死账）。
  #[cfg(feature = "jit")]
  pub(crate) forn_trace_ctx: Cell<bool>,
}

impl LuaInner {
  /// Build a fresh `LuaInner`, initializing every field (including the
  /// feature-gated `typecheck_defs` store). Used by all `Lua` constructors so
  /// the field set stays in one place.
  fn new(state: NonNull<LuaState>, owned: bool) -> LuaInner {
    LuaInner {
      alive: alive_of(state, owned),
      state,
      owned,
      #[cfg(feature = "typecheck")]
      typecheck_defs: RefCell::new(String::new()),
      #[cfg(feature = "jit")]
      jit_enabled: Cell::new(false),
      #[cfg(feature = "jit")]
      forn_trace_ctx: Cell::new(false),
    }
  }
}

impl Drop for LuaInner {
  fn drop(&mut self) {
    self.shut();
  }
}

impl LuaInner {
  /// Kharos: закрывает машину, если это её владелец и она ещё жива: флаг гаснет до `lua_close`, так что значения,
  /// которые отпускают деструкторы userdata во время закрытия, слоты уже не трогают.
  fn shut(&self) {
    if self.owned && self.alive.swap(false, core::sync::atomic::Ordering::Relaxed) {
      let _ = ALIVE.try_with(|map| map.borrow_mut().remove(&vm_key(StateView::from_handle(self.state))));
      // 存活前提：`state` 此刻仍存活（`lua_close` 尚未运行，下方 clear_* 序列
      // 也都以存活 state 为前提），`global` 非空，满足 `vm_key` 的调用序契约。
      // 本 Drop 持有该 VM 的唯一强引用（`owned:true` 且计数归零才进到这里），
      // 独占且无并发访问；视图只在 `lua_close` 之前使用。`self.state` 已是
      // `NonNull`（构造期非空），经 safe 收口 `from_handle` 取视图，无需 `from_raw`。
      let state = StateView::from_handle(self.state);
      // Evict every per-VM side-table entry keyed by this state before closing
      // it, so none of them leaks one slot per state created — and so the next
      // VM that reuses this `global_State` address does not inherit them. All
      // are keyed by the still-valid state/global pointer here. (The sandbox
      // saved-globals live in the state's REGISTRY, freed by `lua_close` below;
      // here we only drop their pointer/flag bookkeeping.) These maps hold no
      // Lua handles, so the state actually reaches this Drop — that is the whole
      // point of not caching handles. See [`crate::vm_store`].
      let mem_key = vm_key(state);
      clear_app_data(mem_key);
      #[cfg(feature = "async")]
      clear_async_state(mem_key);
      #[cfg(feature = "serde")]
      clear_sentinels(mem_key);
      clear_interrupt(mem_key);
      clear_vm_state(mem_key);
      // The memory map is keyed by the global-state pointer and must be
      // dropped AFTER `lua_close` (the allocator `MemoryControl` handed to
      // the VM as `ud` is used throughout close to free every object), so
      // capture the key — and our control block's identity token, while the
      // entry is provably still ours — now, while the state is still valid.
      // The category table has no such tie to close, so it goes with the
      // other pre-close stores.
      let mem_token =
        MemoryControls::try_with(|m| m.get(&mem_key).map_or(0, |ctrl| ctrl.token)).unwrap_or(0);
      clear_memory_categories(mem_key);
      let ptr = self.state.as_ptr();
      // Safety: `state` 存活且本 `LuaInner` 是其唯一拥有者（`owned:true`
      // 且 `Rc` 强计数归零才进到这里）——`lua_setmemcat` 只写 `activememcat`
      // 一字段，`lua_close` 释放整个 VM 并把 state 变为 dangling；此后本帧
      // 不再触碰该指针（`clear_memory` 只用已捕获的整型 key）。二者是
      // `lua_*` C ABI 对主状态的合法调用点序（close 前重置类别，close 收口），
      // 不存在并发借用——`Rc` 归零即独占。
      unsafe {
        // Reset the active memory category to "main" before closing.
        // `Lua::set_memory_category` may have left a non-main category
        // active; allocations made during teardown would otherwise be
        // accounted to it, tripping `close_state`'s debug invariant that
        // only category 0 is non-empty at shutdown.
        lua_setmemcat(&mut *ptr, MEMCAT_MAIN as i32);
        // Safety: `lua_close` 释放整个 VM 并把 state 变为 dangling;此后本帧
        // 不再触碰该指针(`clear_memory` 只用已捕获的整型 key)。
        lua_close(ptr)
      }
      // Now the allocator is no longer needed: drop its control block (only
      // if the token still identifies ours — see `clear_memory`).
      clear_memory(mem_key, mem_token);
    }
  }
}

// Under the `send` feature, allow a `Lua` (and every handle, transitively) to be
// **moved** across threads. The raw `*mut LuaState` is `!Send`/`!Sync` by
// default; these impls encode ulua-rt's documented contract — single-threaded
// *use*, only *ownership transfer* across threads, never concurrent access.
//
// `Send` is the property we actually expose. `Sync` is needed only as an
// internal obligation: `XRc<LuaInner>` is `Arc<LuaInner>` under the feature, and
// `Arc<T>: Send` requires `T: Send + Sync`. We therefore mark `LuaInner` (the
// non-public interior) `Sync`, and then keep the *public* `Lua`/handle types
// `!Sync` with a `NotSync` phantom marker (see [`NotSync`]). Net effect: the VM
// can be moved across threads but never shared/accessed concurrently — exactly
// mlua's `send` contract, minus mlua's extra `Sync` (ulua-rt stays `!Sync`).
//
// Safety: `LuaInner` 内所有可变状态（`NonNull<LuaState>` 句柄、`Registry`、`AppData`）
// 只允许随句柄 *整体移交* 线程，不允许并发访问； public 的 `Lua` 由 `NotSync`
// 标记保持 `!Sync`，故下面的 `Sync` 只为满足 `Arc<T>: Send` 的内部义务而存在，
// 不构成任何并发读写许可——违反该移交契约即数据竞争，责任在调用方。
#[cfg(feature = "send")]
unsafe impl Send for LuaInner {}
#[cfg(feature = "send")]
unsafe impl Sync for LuaInner {}

/// A handle to a Lua interpreter.
///
/// Mirrors `mlua::Lua`. Cloning produces another handle to the **same** VM
/// (the inner state is shared via `Rc`), exactly like mlua.
#[derive(Clone)]
pub struct Lua {
  pub(crate) inner: XRc<LuaInner>,
  /// Keeps `Lua` `!Sync` under the `send` feature (the VM is move-only, never
  /// shareable). A zero-sized `()` under the default build. See [`NotSync`].
  pub(crate) _not_sync: NotSync,
}

/// 创建一个 VM 并按需打开标准库，**分配失败时返回 `None`**。
///
/// `create` 是 state 的产生者（生产路径为 [`lua_l_newstate`]，测试可注入恒返回
/// `None` 的工厂以覆盖 OOM 分支）；可空性由 `Option<NonNull<LuaState>>` 表达，
/// 而非 `null_mut()` 哨兵。
///
/// 关键顺序：`create` 返回 `None` 时经 `?` 提前返回，**之后**才允许 state 被任何
/// `lua_*` 入口使用（含 [`lua_l_openlibs`]）——对空 state 调用任何 `lua_*` 入口都是
/// 空指针解引用，检查必须在使用之前。
fn build_lua(create: impl FnOnce() -> Option<NonNull<LuaState>>, openlibs: bool) -> Option<Lua> {
  let state = create()?;
  if openlibs {
    // `open_std_libs` 是带契约的 safe 门面：`state` 刚过上一行的非空收口，
    // 是完整可用的新 state。`state` 已是 `NonNull`，经 safe 收口 `from_handle`
    // 取视图（纯指针拷贝，无 `unsafe`），视图只在 openlibs 调用内、不跨帧存放。
    open_std_libs(StateView::from_handle(state));
  }
  Some(Lua::from_inner(XRc::new(LuaInner::new(state, true))))
}

/// OOM 创建 VM 时的统一错误文案（[`Lua::new_with`]）。
const STATE_ALLOC_MSG: &str = "failed to create Lua state: memory allocation failure";

impl Lua {
  /// Create a new Lua state with the standard library opened.
  ///
  /// Mirrors `mlua::Lua::new`.
  ///
  /// # Panics
  /// Panics with `"lua_l_newstate returned null"` if the VM cannot be allocated
  /// (the state is checked for null **before** the libraries are opened, so a
  /// failed allocation panics instead of dereferencing a null state).
  pub fn new() -> Lua {
    // ulua's v11+ bytecode needs the default Luau flags on (see the
    // umbrella crate's `eval`).
    set_luau_bool_flags(true);
    build_lua(|| NonNull::new(lua_l_newstate()), true).expect("lua_l_newstate returned null")
  }

  /// Create a new Lua state **without** opening the standard library.
  ///
  /// A deliberate deviation from mlua (which exposes `StdLib` flags); a
  /// minimal convenience for embedders who want a clean global table.
  ///
  /// # Panics
  /// Panics (before any use of the state) if the VM cannot be allocated; see
  /// [`Lua::new`].
  pub fn new_empty() -> Lua {
    set_luau_bool_flags(true);
    build_lua(|| NonNull::new(lua_l_newstate()), false).expect("lua_l_newstate returned null")
  }

  /// Create a new Lua state with the standard library opened, **without** the
  /// extra safety restrictions a safe `Lua::new` would impose.
  ///
  /// Mirrors `mlua::Lua::unsafe_new`. In Luau there is no separate set of
  /// "unsafe" base libraries (the `debug`/`ffi`/`package` distinction is a
  /// Lua-5.x concept), so this is equivalent to [`Lua::new`]; the name is
  /// kept for mlua signature parity. mlua's counterpart is `unsafe fn`
  /// because its default libraries can load native code; ulua's cannot, so
  /// this entry point needs no preconditions and is fully safe.
  pub fn unsafe_new() -> Lua {
    Lua::new()
  }

  /// Create a new Lua state opening the libraries selected by `libs`, with the
  /// behavioral `options`. Mirrors `mlua::Lua::new_with`.
  ///
  /// **DEVIATION:** ulua opens the Luau base libraries as a unit, so any
  /// non-empty `libs` opens the full standard library and [`StdLib::NONE`]
  /// opens nothing (see [`StdLib`]). `options` is recorded on the VM (currently
  /// only `catch_rust_panics` is observable).
  ///
  /// # Errors
  /// [`Error::MemoryError`] if the state itself cannot be allocated — the null
  /// return of `lua_newstate` is detected **before** `lua_l_openlibs` runs.
  pub fn new_with(libs: StdLib, options: LuaOptions) -> Result<Lua> {
    set_luau_bool_flags(true);
    let lua = build_lua(|| NonNull::new(lua_l_newstate()), !libs.is_none())
      .ok_or_else(|| Error::MemoryError(STATE_ALLOC_MSG.to_string()))?;
    lua.set_catch_rust_panics(options.catch_rust_panics);
    Ok(lua)
  }

  /// Enables or disables Luau native code generation (JIT).
  ///
  /// Mirrors `mlua::Lua::enable_jit`.
  #[cfg(feature = "jit")]
  pub fn enable_jit(&self, enabled: bool) -> Result<()> {
    if enabled {
      if !is_supported() {
        return Err(Error::runtime(
          "Luau native CodeGen is not supported on this platform",
        ));
      }
      // Safety: 族级契约(state 正由当前线程驱动);`luau_codegen_create` 只为该
      // state 创建 native code generator(失败在 VM 侧以错误收敛,不触碰栈上值)。
      unsafe {
        luau_codegen_create(self.state().as_mut_ptr());
      }
      self.inner.jit_enabled.set(true);
    } else {
      self.inner.jit_enabled.set(false);
    }
    Ok(())
  }

  /// Enables or disables Luau native code generation (JIT).
  ///
  /// Returns an error if the crate is built without the `jit` feature.
  #[cfg(not(feature = "jit"))]
  pub fn enable_jit(&self, _enabled: bool) -> Result<()> {
    Err(Error::runtime(
      "Luau JIT support is not enabled in this build (requires feature 'jit')",
    ))
  }

  /// Returns whether Luau native code generation (JIT) is currently enabled.
  pub fn is_jit_enabled(&self) -> bool {
    #[cfg(feature = "jit")]
    {
      self.inner.jit_enabled.get()
    }
    #[cfg(not(feature = "jit"))]
    {
      false
    }
  }

  /// FORN trace 层形态（阶段二 PoC）：jit 关 + `LuauJitFornTrace` 开时，为本
  /// state 懒装配 trace 上下文（safeenv 保持 0，装载期零编译；运行期热环达标
  /// 后由 ecb 槽承接整环原生执行）。幂等：已装配即 no-op。平台不支持时静默
  /// 跳过（后续编译自然空转）。
  #[cfg(feature = "jit")]
  pub(crate) fn ensure_forn_trace_context(&self) {
    if self.inner.forn_trace_ctx.get() || !is_supported() {
      return;
    }
    // Safety: 族级契约(state 正由当前线程驱动)；`luau_codegen_create_forn_trace_only`
    // 只为该 state 装配上下文与 ecb 回调（safeenv 保持 0），不触碰栈上值。
    unsafe {
      luau_codegen_create_forn_trace_only(self.state().as_mut_ptr());
    }
    self.inner.forn_trace_ctx.set(true);
  }

  /// 本句柄背后的 VM state 驱动视图([`StateView`])。内部使用——wrapper 句柄
  /// 都以 `XRc<LuaInner>` 持同一 state,只有即将调用 state.rs 门面族的代码经此
  /// 取视图。纯指针拷贝(无 `unsafe`):存活由句柄锚定,驱动契约由 [`StateView`]
  /// 的类型文档承载(单线程串行、视图不重叠解引用、不跨 VM 重入点寄存)。
  #[inline]
  pub(crate) fn state(&self) -> StateView<'_> {
    StateView::from_handle(self.inner.state)
  }

  /// Wrap an *already-existing* state (e.g. the thread passed into a C
  /// trampoline) in a borrowed [`Lua`] that will **not** close it on drop.
  ///
  /// 内部边界封装（原 `pub(crate) unsafe fn`，去 unsafe 化后契约前移到调用点）：
  /// 形参已是 [`StateView`]——非空与存活的论证收口在视图唯一产生点
  /// [`StateView::from_raw`]（C-ABI trampoline 入口），可空裸指针不再在业务
  /// 逻辑层流转（§2）。本函数只把视图的指针位复制进 `LuaInner`（不解引用），
  /// `owned:false` 使句柄 drop 不关 VM。全部调用点都在 VM 驱动的 C trampoline 内
  /// （`callback.rs`/`async.rs`/`interrupt.rs`）：那里的视图由 VM 在受保护边界
  /// 实时传入的 state 一次转出，天然满足「存活期覆盖返回句柄及其克隆」；
  /// 同纪律要求句柄及其克隆不得寄存到该 trampoline 帧之外。
  /// Kharos: закрыть машину сейчас, не дожидаясь, пока отпустят последнее значение (у mlua машина закрывается, когда
  /// отпускают `Lua`). Значения, которые держит сама машина — в userdata и данных приложения, — освобождаются вместе с
  /// ней; пережившие её больше не годятся. Заёмная `Lua` (внутри обратного вызова) машину не закрывает.
  pub fn close(&self) {
    self.inner.shut();
  }

  pub(crate) fn from_borrowed(state: StateView<'_>) -> Lua {
    Lua::from_inner(XRc::new(LuaInner::new(state.ptr, false)))
  }

  /// Register a value sitting at stack index `idx` in the registry and return
  /// a [`LuaRef`] that owns the slot. Does not pop the value.
  pub(crate) fn register_ref(&self, idx: i32) -> LuaRef {
    // `register_slot` 是 safe 门面：`idx` 的合法性由调用方承担——`pop_ref` 传 -1 且
    // 调用点栈顶必有值（先 push 后登记），其余经 `Lua::register_ref` 的句柄构造点同样
    // 刚压入对象；owning VM 由本 `Lua` 的 `XRc<LuaInner>` 保活。
    let id = register_slot(self.state(), idx);
    LuaRef {
      inner: self.inner.clone(),
      alive: self.inner.alive.clone(),
      id: Cell::new(id),
    }
  }

  /// Pop the top stack value and register it, returning a [`LuaRef`].
  pub(crate) fn pop_ref(&self) -> LuaRef {
    let r = self.register_ref(-1);
    // `pop_stack` 是 safe 门面：上一行 `register_ref(-1)` 登记时不弹栈（ref 保留栈顶
    // 值），故弹的正是刚登记的槽位，栈顶非空、`state` 存活。
    pop_stack(self.state(), 1);
    r
  }
}

impl Default for Lua {
  fn default() -> Self {
    Lua::new()
  }
}

impl Lua {
  /// 从共享内部状态封装 [`Lua`]（补上 `!Sync` 标记）。全部构造点共用，
  /// 保证字段集只有这一处。
  fn from_inner(inner: XRc<LuaInner>) -> Lua {
    Lua {
      inner,
      _not_sync: NOT_SYNC,
    }
  }

  /// A non-owning, weak handle to this VM. Mirrors `mlua::Lua::weak`.
  ///
  /// The [`WeakLua`] does not keep the VM alive; it can be upgraded back to a
  /// strong [`Lua`] only while at least one strong handle still exists.
  pub fn weak(&self) -> WeakLua {
    WeakLua(XRc::downgrade(&self.inner))
  }
}

/// A weak handle to a [`Lua`] instance. Mirrors `mlua::WeakLua`.
///
/// Holds a non-owning reference to the shared VM interior; upgrade it to a
/// strong [`Lua`] with [`WeakLua::try_upgrade`] / [`WeakLua::upgrade`].
#[derive(Clone)]
pub struct WeakLua(pub(crate) XWeak<LuaInner>);

impl WeakLua {
  /// Try to obtain a strong [`Lua`] handle. Returns `None` if the VM has
  /// already been destroyed. Mirrors `mlua::WeakLua::try_upgrade`.
  pub fn try_upgrade(&self) -> Option<Lua> {
    self.0.upgrade().map(Lua::from_inner)
  }

  /// Obtain a strong [`Lua`] handle, panicking if the VM has been destroyed.
  /// Mirrors `mlua::WeakLua::upgrade`.
  pub fn upgrade(&self) -> Lua {
    // mlua 对等的文档化 panic：upgrade 失败仅代表 VM 已销毁，属公开契约（try_upgrade 为可抛错版）。
    self.try_upgrade().expect("Lua instance is destroyed")
  }
}

// ---------------------------------------------------------------------------
// Public, mlua-style construction API.
// ---------------------------------------------------------------------------

impl Lua {
  /// The globals table.
  ///
  /// Mirrors `mlua::Lua::globals`. Returns a [`Table`] handle to the global
  /// environment (the table reachable at `LUA_GLOBALSINDEX`).
  pub fn globals(&self) -> Table {
    let state = self.state();
    // 压入全局表一层（`pop_ref` 随即弹掉）：先预留头寸。
    ensure_stack_or_panic(state, 1);
    // 收口点：`LUA_GLOBALSINDEX` 伪索引的值净压一层（存活论证在门面函数头）。
    push_globals_to_stack(state);
    // `pop_ref` 消费刚压入的一层登记引用，净栈变化为零。
    Table::from_ref(self.pop_ref())
  }

  /// Create a new, empty table.
  ///
  /// Mirrors `mlua::Lua::create_table` (infallible in ulua-rt).
  pub fn create_table(&self) -> Table {
    table::create_table(self)
  }

  /// Create a new, empty table with preallocated array (`narr`) and record (`nrec`) capacities.
  pub fn create_table_with_capacity(&self, narr: usize, nrec: usize) -> Table {
    table::create_table_with_capacity(self, narr, nrec)
  }

  /// Create a Lua string from bytes/str.
  ///
  /// Mirrors `mlua::Lua::create_string`.
  pub fn create_string(&self, s: impl AsRef<[u8]>) -> LuaString {
    string::create_string(self, s.as_ref())
  }

  /// Create a table and populate it from an iterator of key/value pairs.
  ///
  /// Mirrors `mlua::Lua::create_table_from`.
  pub fn create_table_from<K, V, I>(&self, iter: I) -> Result<Table>
  where
    K: IntoLua,
    V: IntoLua,
    I: IntoIterator<Item = (K, V)>,
  {
    let t = self.create_table();
    for (k, v) in iter {
      t.raw_set(k, v)?;
    }
    Ok(t)
  }

  /// Create a sequence (1-based array) table from an iterator of values.
  ///
  /// Mirrors `mlua::Lua::create_sequence_from`.
  pub fn create_sequence_from<V, I>(&self, iter: I) -> Result<Table>
  where
    V: IntoLua,
    I: IntoIterator<Item = V>,
  {
    let t = self.create_table();
    t.fill_sequence(iter)?;
    Ok(t)
  }

  /// Run a full garbage-collection cycle.
  ///
  /// Mirrors `mlua::Lua::gc_collect` (infallible here — ulua's `lua_gc`
  /// cannot fail for `collect`).
  pub fn gc_collect(&self) -> Result<()> {
    // `run_gc` 是带契约的 safe 门面（族内统一存活论证）：`Collect as i32` 是 VM
    // 认识的完整周期 op；宿主调用点不在 GC 步进中途，收集只回收不可达对象——
    // 所有存活句柄都持注册表引用（GC 可达），不会被误收。
    run_gc(self.state(), LuaGcOp::Collect as i32, 0);
    Ok(())
  }

  /// Create a Lua function from a Rust closure.
  ///
  /// Mirrors `mlua::Lua::create_function`. The closure receives `&Lua` and
  /// the arguments converted via [`FromLuaMulti`]; its `Ok` return is
  /// converted via [`IntoLuaMulti`]. Returning `Err` (or panicking) surfaces
  /// as a catchable Lua error.
  pub fn create_function<F, A, R>(&self, func: F) -> Result<Function>
  where
    F: Fn(&Lua, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    create_callback_function(self, func)
  }

  /// Create a Lua function from a Rust **mutable** closure.
  ///
  /// Mirrors `mlua::Lua::create_function_mut`. The closure is guarded by a
  /// [`std::cell::RefCell`]; a re-entrant call (the callback running
  /// Lua that calls the same callback again) surfaces as
  /// [`Error::RecursiveMutCallback`]
  /// rather than allowing mutable aliasing.
  pub fn create_function_mut<F, A, R>(&self, func: F) -> Result<Function>
  where
    F: FnMut(&Lua, A) -> Result<R> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.create_function(wrap_mut_closure!(func))
  }

  /// Create userdata wrapping a `T: UserData` value.
  ///
  /// Mirrors `mlua::Lua::create_userdata`.
  pub fn create_userdata<T: UserData + MaybeSend + MaybeSync + 'static>(
    &self,
    data: T,
  ) -> Result<AnyUserData> {
    userdata::create_userdata(self, data)
  }

  /// Create a Lua function from a Rust **async** closure (the `async`
  /// feature).
  ///
  /// Mirrors `mlua::Lua::create_async_function`. The closure receives an owned
  /// [`Lua`] and the converted arguments, and returns a `Future`. When the
  /// resulting Lua function is called, it runs on a coroutine that **yields**
  /// while the future is pending; a driver such as
  /// [`Function::call_async`](crate::Function::call_async) /
  /// [`Chunk::eval_async`](crate::Chunk::eval_async) resumes the coroutine,
  /// polls the future, and resumes it with the result when ready.
  ///
  /// The executor is provided by the caller (ulua-rt is executor-agnostic,
  /// exactly like mlua): the returned futures must be `.await`ed / polled on
  /// the caller's runtime (e.g. tokio).
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn create_async_function<F, A, FR, R>(&self, func: F) -> Result<Function>
  where
    F: Fn(Lua, A) -> FR + MaybeSend + 'static,
    A: FromLuaMulti,
    FR: Future<Output = Result<R>> + MaybeSend + 'static,
    R: IntoLuaMulti,
  {
    // The closure and its future stay at their concrete types; the poller's
    // `get_future`/`poll` C closures are monomorphized over `(F, A, FR, R)`.
    // Argument conversion (`A::from_lua_multi`) and the `R -> MultiValue`
    // conversion are performed inside those closures, with a conversion error
    // deferred to the first poll (see `async_support`), preserving the previous
    // boxed-future behavior.
    create_async_callback(self, func)
  }

  /// Creates and returns a Luau [buffer] object from a byte slice of data.
  ///
  /// Mirrors `mlua::Lua::create_buffer`.
  ///
  /// [buffer]: https://luau.org/library#buffer-library
  pub fn create_buffer(&self, data: impl AsRef<[u8]>) -> Result<Buffer> {
    let data = data.as_ref();
    let mut buffer = self.create_buffer_with_capacity(data.len())?;
    if !data.is_empty() {
      buffer.write_bytes(0, data);
    }
    Ok(buffer)
  }

  /// Creates and returns a Luau [buffer] object with the specified size.
  ///
  /// Size limit is 1GB. All bytes are initialized to zero. Exceeding the
  /// limit returns a `RuntimeError` carrying a `"memory allocation error"`
  /// message (matching mlua).
  ///
  /// Mirrors `mlua::Lua::create_buffer_with_capacity`.
  ///
  /// [buffer]: https://luau.org/library#buffer-library
  pub fn create_buffer_with_capacity(&self, size: usize) -> Result<Buffer> {
    buffer::create_buffer_with_capacity(self, size)
  }

  /// Creates and returns a Luau [`Vector`] value.
  ///
  /// Mirrors `mlua::Lua::create_vector`. ulua is a 3-wide vector build.
  pub fn create_vector(&self, x: f32, y: f32, z: f32) -> Vector {
    Vector::new(x, y, z)
  }

  /// Load a chunk of Lua source for execution.
  ///
  /// Mirrors `mlua::Lua::load`. Returns a [`Chunk`]; finalize with
  /// [`Chunk::exec`] / [`Chunk::eval`] / [`Chunk::into_function`].
  pub fn load(&self, source: impl AsRef<str>) -> Chunk {
    Chunk {
      lua: self.clone(),
      source: ChunkSource::Text(source.as_ref().to_string()),
      name: DEFAULT_CHUNK_NAME.to_string(),
      environment: None,
      compiler: None,
      mode: ChunkMode::Text,
    }
  }

  /// Load precompiled Luau bytecode for execution.
  ///
  /// Returns a [`Chunk`] configured to load and execute the precompiled bytecode
  /// directly without re-invoking the compiler.
  pub fn load_bytecode(&self, bytecode: impl AsRef<[u8]>) -> Chunk {
    Chunk {
      lua: self.clone(),
      source: ChunkSource::Bytecode(bytecode.as_ref().to_vec()),
      name: DEFAULT_CHUNK_NAME.to_string(),
      environment: None,
      compiler: None,
      mode: ChunkMode::Binary,
    }
  }

  /// Convert a Rust value into a single Lua [`Value`].
  ///
  /// Mirrors `mlua::Lua::pack`-ish convenience. Provided so callers can build
  /// `Value`s without importing the trait.
  pub fn pack(&self, value: impl IntoLua) -> Result<Value> {
    value.into_lua(self)
  }

  /// Convert a single Lua [`Value`] to a Rust value. Mirrors `mlua::Lua::unpack`.
  pub fn unpack<T: FromLua>(&self, value: Value) -> Result<T> {
    T::from_lua(value, self)
  }

  /// Coerce a [`Value`] to an integer the way Lua's `tonumber`+integer check
  /// would (`"1"` -> `Some(1)`, `"1.5"` -> `None`, a non-numeric value ->
  /// `None`). Mirrors `mlua::Lua::coerce_integer`.
  pub fn coerce_integer(&self, value: Value) -> Result<Option<Integer>> {
    // An integral, in-range float coerces to an integer; otherwise None.
    Ok(
      self
        .coerce_number_value(&value)?
        .filter(|n| value::is_exact_integer(*n))
        .map(|n| n as i64),
    )
  }

  /// Coerce a [`Value`] to a float the way Lua's `tonumber` would. Mirrors
  /// `mlua::Lua::coerce_number`.
  pub fn coerce_number(&self, value: Value) -> Result<Option<Number>> {
    self.coerce_number_value(&value)
  }

  /// Shared core of `coerce_integer` / `coerce_number`: push the value, run
  /// the VM's `tonumber`, and report whether the coercion succeeded.
  fn coerce_number_value(&self, value: &Value) -> Result<Option<Number>> {
    let state = self.state();
    // 预留 `push_value` 压入的一层（读毕弹掉）。
    ensure_stack(state, 1)?;
    // Safety: 上一行闸门保证 `push_value` 的一层头寸；其各分支要么不压、
    // 要么恰压一层后返回 `Ok`（该函数唯一 `Err` 面是嵌套句柄 push 的 VM
    // 断言路径，正常返回即栈顶有值），故压入后 -1 恒为有效索引。
    self.push_value(value)?;
    // isnum 出参经 `table::number_at`（safe 门面）收口为 `Option`（rt 既定统一形态）。
    // `state` 存活且 -1 是刚压入值的有效索引（见上），`number_at` 只读该槽、不动栈深。
    let coerced = number_at(state, -1);
    // `pop_stack` 弹掉刚压入的值（`number_at` 不动栈）恢复平衡。
    pop_stack(state, 1);
    Ok(coerced)
  }

  /// Replace the global environment with `globals`. Mirrors
  /// `mlua::Lua::set_globals`.
  ///
  /// In a sandboxed Lua state the globals table is read-only and cannot be
  /// replaced; this returns a [`Error::RuntimeError`] in that case (matching
  /// mlua / Luau).
  pub fn set_globals(&self, globals: Table) -> Result<()> {
    if self.is_sandboxed() {
      return Err(Error::runtime(
        "cannot change globals in a sandboxed Lua state",
      ));
    }
    let state = self.state();
    // 预留 globals 压入的一层（随后 `lua_replace` 弹掉）：`push_to_stack` 落
    // `lua_rawgeti` 自带栈预留，这里的 `ensure_stack` 只是把接近栈上限时的
    // 越界收敛成一个可返回的 `Err` 而非 VM abort。
    ensure_stack(state, 1)?;
    // `globals.push_to_stack()` 是 safe 封装；owning VM 存活由本句柄的
    // `XRc<LuaInner>` 保证，线程一致性沿用 move-not-share 纪律（沙箱态已在入口挡住）。
    globals.push_to_stack();
    // `replace_globals_from_top`（safe 门面）按 C API 约定消费栈顶值（上一行刚压入的
    // globals 表）写入全局表伪索引，压/消配平；它搬运的是已压入本栈的 GC 值，不产生
    // 悬垂读。
    replace_globals_from_top(state);
    Ok(())
  }

  /// Build a stack traceback string for this VM. Mirrors `mlua::Lua::traceback`.
  ///
  /// `msg`, if present, is prepended to the traceback; `level` selects the
  /// starting stack level. The returned [`LuaString`] holds the traceback as
  /// produced by `luaL_traceback`.
  pub fn traceback(&self, msg: Option<&str>, level: usize) -> Result<LuaString> {
    let state = self.state();
    // 预留 `push_traceback` 压入结果字符串的一层（`pop_ref` 随即弹掉）。
    ensure_stack(state, 1)?;
    // `push_traceback` 是带契约的 safe 门面（族内统一存活论证 + 自回溯 `from == to`）：
    // `msg` 是 `Option<&str>`，Some 时字节切片当场格式化成字符串（不寄存指针），
    // None 走跳过分支；该调用恒压一个字符串结果。
    push_traceback(state, msg, level as i32);
    // `pop_ref` 消费 traceback 压出的结果字符串。
    Ok(LuaString::from_ref(self.pop_ref()))
  }

  /// [`Lua::traceback`] 的内部错误路径版本：返回 `String`，且**任何失败都退化成
  /// 空串**（错误处理路径上不能再抛出「取回溯失败」这种次生错误；结果串的
  /// 栈位由 [`Lua::traceback`] 内建的 [`ensure_stack`] 预留）。
  fn traceback_at_level(&self, level: usize) -> String {
    match self.traceback(None, level) {
      Ok(text) => text.to_string_lossy(),
      Err(_) => String::new(),
    }
  }
}

// ---------------------------------------------------------------------------
// Static type-checking (the `typecheck` feature).
//
// ulua ships Luau's static type checker, so — unlike mlua — a script can be
// type-checked against the host surface *before* it runs. The host surface is
// described in Luau definition-file syntax and accumulated on the `Lua` via
// `add_definitions`; `check` / `Chunk::check` then validate source against it.
// ---------------------------------------------------------------------------
#[cfg(feature = "typecheck")]
#[cfg_attr(docsrs, doc(cfg(feature = "typecheck")))]
impl Lua {
  /// Register host type `definitions` (Luau definition-file syntax) so later
  /// [`Lua::check`] / [`Chunk::check`] calls type-check against them.
  ///
  /// `definitions` describes the host-provided globals — the Rust functions,
  /// values, and userdata you expose to the runtime (e.g. via
  /// [`Lua::create_function`] / [`UserData`]):
  ///
  /// ```text
  /// declare function add(a: number, b: number): number
  /// declare config: { name: string, retries: number }
  /// ```
  ///
  /// The definitions are validated before being recorded: if they are
  /// malformed, this returns [`Error::TypeError`]
  /// carrying the (`in_definitions`) diagnostics and records nothing. On
  /// success they are appended to this VM's accumulated definitions.
  pub fn add_definitions(&self, defs: &str) -> Result<()> {
    // Validate the new definitions in isolation by checking a trivial body.
    if let Err(diagnostics) = check_with_definitions("return nil", defs) {
      // Only the definition-side diagnostics are this call's fault; a
      // type error in the trivial body would be ours, not the caller's.
      let def_errors: Vec<TypeDiagnostic> = diagnostics
        .into_iter()
        .filter(|d| d.in_definitions)
        .collect();
      if !def_errors.is_empty() {
        return Err(Error::TypeError(def_errors));
      }
    }
    // Append, newline-separated, to the accumulated definitions.
    let mut store = self.inner.typecheck_defs.borrow_mut();
    if !store.is_empty() {
      store.push('\n');
    }
    store.push_str(defs);
    Ok(())
  }

  /// Type-check `source` against this VM's accumulated host definitions.
  ///
  /// Returns `Ok(())` if the source type-checks clean, or
  /// [`Error::TypeError`] carrying the structured
  /// diagnostics otherwise.
  ///
  /// The Luau VM is dynamically typed, so this is **advisory**: a script that
  /// fails the check can still be run (`exec`/`eval`). The value is catching
  /// host-API misuse statically, before running untrusted or generated code.
  pub fn check(&self, source: &str) -> Result<()> {
    let defs = self.inner.typecheck_defs.borrow();
    let result = if defs.is_empty() {
      typecheck::check(source)
    } else {
      typecheck::check_with_definitions(source, &defs)
    };
    result.map_err(Error::TypeError)
  }

  /// Type-check `source` against this VM's accumulated host definitions **plus**
  /// the extra `defs` (for a one-off check that does not persist `defs`).
  ///
  /// Same mapping as [`Lua::check`]: `Ok(())` when clean, otherwise
  /// [`Error::TypeError`].
  pub fn check_with_definitions(&self, source: &str, defs: &str) -> Result<()> {
    let accumulated = self.inner.typecheck_defs.borrow();
    let combined = if accumulated.is_empty() {
      defs.to_string()
    } else {
      format!("{accumulated}\n{defs}")
    };
    typecheck::check_with_definitions(source, &combined).map_err(Error::TypeError)
  }
}

/// An owned registry reference to a Lua value.
///
/// Keeps both the value reachable (registry slot) and the VM alive (the cloned
/// `XRc<LuaInner>`). On drop it releases the slot via [`lua_unref`].
pub(crate) struct LuaRef {
  inner: XRc<LuaInner>,
  /// Kharos: жива ли машина — после [`Lua::close`] слот не освобождается.
  alive: Alive,
  id: Cell<i32>,
}

// `LuaRef` is shared behind `XRc<LuaRef>` (`Arc<LuaRef>` under the feature) by
// every handle, so it must be `Send + Sync` for the handles to be `Send`. The
// `Cell<i32>` slot is only ever mutated on the owning thread (the move-only
// contract); marking `LuaRef` `Sync` is sound under that contract. Handles stay
// `!Sync` via their own `NotSync` markers.
//
// Safety: 沿用 `LuaInner` 的同一条移交契约——`id` 只在持有者线程上变更，
// `XRc<LuaRef>` 的跨线程共享仅为指针复制，不构成对同一 `LuaRef` 的并发读写。
#[cfg(feature = "send")]
unsafe impl Send for LuaRef {}
#[cfg(feature = "send")]
unsafe impl Sync for LuaRef {}

impl LuaRef {
  /// The owning [`Lua`] handle (a fresh borrow sharing the same inner state).
  pub(crate) fn lua(&self) -> Lua {
    Lua::from_inner(self.inner.clone())
  }

  /// The raw state view this ref belongs to.
  ///
  /// 与 [`Lua::state`] 同一收口点、同一驱动契约(见 [`StateView`])。
  #[inline]
  pub(crate) fn state(&self) -> StateView<'_> {
    StateView::from_handle(self.inner.state)
  }

  /// Push the referenced value, read `lua_topointer`, pop. Shared by every
  /// handle's `to_pointer` (`Table` / `Function` / `LuaString` / `Buffer` /
  /// `Thread` / `AnyUserData`).
  pub(crate) fn to_pointer(&self) -> *const c_void {
    // `push` 不自动扩容：先预留本函数压入的一层（读毕即弹）。
    ensure_stack_or_panic(self.state(), 1);
    // `with_reference_pushed` 是 safe 门面；`pointer_at`（state.rs safe 门面族）对
    // 任意值槽返回对象地址或 null，只作身份比较、不移动值、不改栈深、不解引用
    // Rust 侧内存；`idx` 是门面刚压入登记值的绝对索引。
    with_reference_pushed(self, |lua, idx| pointer_at(lua.state(), idx))
  }

  /// The registry id. (Retained for internal diagnostics; handle identity is
  /// established via `lua_topointer`, not the registry slot id.)
  #[inline]
  pub(crate) fn id(&self) -> i32 {
    self.id.get()
  }

  /// 写回槽位 id（`replace_registry_value` 原地换槽用；`Cell` 保证共享
  /// 句柄同见新值）。
  #[inline]
  pub(crate) fn set_id(&self, id: i32) {
    self.id.set(id);
  }

  /// Push the referenced value back onto the stack.
  pub(crate) fn push(&self) {
    assert!(self.alive.load(core::sync::atomic::Ordering::Relaxed), "значение Luau пережило свою машину (Lua::close)");
    // The registry table lives at LUA_REGISTRYINDEX; `lua_ref` stores
    // values keyed by their integer id, so a `rawgeti` on the registry
    // recovers them. ulua exposes this through getfield on the registry
    // via the same mechanism `lua_getref` uses in upstream Luau:
    // `lua_rawgeti(l, LUA_REGISTRYINDEX, id)`.
    // `raw_geti` 是带契约的 safe 收口点：`self.inner` 的 `XRc<LuaInner>` 保证调用时
    // state 存活（本方法只能在 `&self` 期间运行，而 `LuaRef::drop` 先于 inner 关闭）；
    // id 是 `lua_ref` 登记的正槽位（`Drop` 才 unref），LUA_REGISTRYINDEX 为 VM 伪索引
    // 常量；VM 侧 `lua_rawgeti` 自带 `ensure_stack(l, 1)` 自保，无需调用方预留。
    raw_geti(self.state(), LUA_REGISTRYINDEX, self.id.get());
  }
}

/// 把 `reference` 锚定的注册表引用值压栈，以**存活 VM 句柄 + 该值的绝对索引**跑
/// `f`，随后弹回这一层。
///
/// 「push 登记引用 → 以绝对索引读 → pop」同构样板的公共门面，使栈配对契约只在此处
/// 出现一次。[`LuaRef::to_pointer`] 及 `userdata.rs` 的 `AnyUserData::cell`/
/// `type_id`/`recover_cell`/scope 中和闭包皆直接引本门面；`table.rs` 的
/// [`crate::table::Table::with_pushed`] 是本门面的安全薄适配（分工见其文档注释）。
///
/// 闭包拿到的上下文是带 `&self` 生命周期的 [`Lua`] 句柄（§2：上下文裸指针 →
/// 带生命周期引用）——句柄背后即 `reference` 的 `XRc<LuaInner>`，VM 存活由类型
/// 系统担保；闭包只在即将调用 `lua_*` C ABI 入口的瞬间经 [`Lua::state`] 收口点
/// 读出裸指针，各自用带 `// Safety` 注释的最小 `unsafe` 块完成调用。
///
/// 栈配对是**正确性**约定（非内存安全）：`f` 不得改变栈深（只读该槽、最多经绝对
/// 索引 `idx` 消费），否则收尾的 `lua_pop` 弹错槽位。`f` 若返回指向被引用对象
/// 内联数据的引用，其有效性由注册表引用钉住对象 + Luau GC 不移动对象保证，与弹出
/// 后的栈槽位无关（同 [`LuaRef::push`] 各 safe 门面的既有论证）。
pub(crate) fn with_reference_pushed<R>(reference: &LuaRef, f: impl FnOnce(&Lua, i32) -> R) -> R {
  let state = reference.state();
  // `reference.push()`（safe fn）落 VM 侧 `lua_rawgeti`：自带一层栈位预留，注册表
  // id 在 `Drop::lua_unref` 前恒指实槽位，压入的必是登记时的原值。
  reference.push();
  // `stack_top`/`pop_stack` 是 safe 门面：`reference.push()` 净压登记值一层，`stack_top`
  // 读回的正是该值的绝对索引；`f` 按约定不动栈深，收尾 `pop_stack(state, 1)` 弹回这一层，
  // 净栈变化为零。`state` 全程存活（`&reference` 借用期）。
  let idx = stack_top(state);
  let out = f(&reference.lua(), idx);
  pop_stack(state, 1);
  out
}

impl Clone for LuaRef {
  fn clone(&self) -> Self {
    // 重压值并在当前栈顶登记新注册表槽位：每个克隆持有独立槽位。
    // 直接登记（而非借道临时 Lua 句柄）省去两次引用计数跳变。
    let state = self.state();
    // `push` 不自动扩容：先预留重压的一层（登记后即弹）。
    ensure_stack_or_panic(state, 1);
    self.push();
    // 直接经 `register_slot` 登记（而非借道临时 `Lua`/`pop_ref` 句柄）省去两次引用计数
    // 跳变：上两行刚把有效值压到栈顶，登记该槽位返回新正 id，紧随 `pop_stack` 弹掉这一层
    // （净栈变化为零）。`Drop` 对新 id 做 unref，克隆句柄各持独立槽位互不干扰。
    let id = register_slot(state, -1);
    pop_stack(state, 1);
    LuaRef {
      inner: self.inner.clone(),
      alive: self.alive.clone(),
      id: Cell::new(id),
    }
  }
}

impl Drop for LuaRef {
  fn drop(&mut self) {
    let id = self.id.get();
    // Only unref live, real slots. (`LuaInner::state` is `NonNull` — the
    // never-null guard it used to need is now encoded in the field type.)
    // Kharos: закрытую машину не трогаем — её реестра уже нет.
    if id > 0 && self.alive.load(core::sync::atomic::Ordering::Relaxed) {
      // `unref_registry_slot` 是带契约的 safe 门面（`lua_unref` 收口点）：此刻
      // `LuaInner` 尚未 drop（本 `Drop` 持着它唯一的 `XRc<LuaInner>` 强引用，
      // `lua_close` 在 inner 的 drop 里、之后才发生），故 state 存活；守卫已把
      // `id > 0` 挡在门外，进入分支的 id 必是 `lua_ref` 返回且尚未释放的本句柄槽位。
      unref_registry_slot(self.state(), id);
    }
  }
}

impl Lua {
  /// Convenience: convert a top-of-stack value (at `idx`) into a [`Value`],
  /// taking a registry ref for reference types. Does not pop.
  pub(crate) fn value_from_stack(&self, idx: i32) -> Result<Value> {
    value::value_from_stack(self, idx)
  }

  /// Push a [`Value`] onto the stack.
  pub(crate) fn push_value(&self, value: &Value) -> Result<()> {
    value::push_value(self, value)
  }

  /// Metatable-aware `tostring` of a [`Value`] (honors `__tostring`),
  /// mirroring Lua's `tostring`/`luaL_tolstring`.
  pub(crate) fn value_to_string(&self, value: &Value) -> Result<String> {
    let state = self.state();
    // 预留值一层 + `luaL_tolstring` 结果一层（`lua_pop(state, 2)` 收口）。
    ensure_stack(state, 2)?;
    self.push_value(value)?;
    // Safety: `tolstring_at`（`lua_l_tolstring_ref` 收口的 unsafe 门面）：上一行
    // `push_value` 成功即栈顶有值，-1 是有效索引；对有效索引恒转换并按
    // `__tostring` 语义压结果串、以切片带出全字节（长度即切片长，内嵌 NUL 不截
    // 断）。返回切片在紧随的 `.map` 表达式内当场被 `from_utf8_lossy` 拷成
    // owned `String`，其间无任何 VM 调用，满足其 `# Safety` 窗口形态 1。
    let out = unsafe { tolstring_at(state, -1) }
      .map(|s| String::from_utf8_lossy(s).into_owned())
      .unwrap_or_default();
    // `pop_stack` 精确弹回值 + luaL_tolstring 结果两层（luaL_tolstring 会把结果串压栈）。
    pop_stack(state, 2);
    Ok(out)
  }

  /// Map a `lua_pcall`/`luau_load` status code plus the error object on the
  /// stack into an [`Error`]. Assumes a non-zero status and that the error
  /// object is on top of the stack; pops it.
  pub(crate) fn pop_error(&self, status: i32) -> Error {
    let state = self.state();
    // 栈前提即函数文档——非零 status 的 `lua_pcall`/`luau_load` 失败后错误对象
    // 必在栈顶，故 -1 是有效索引；`recover_wrapped_error`（safe 门面）只读栈
    // 不越界；`state` 全程存活（&self 的 XRc 链）。
    // First, see if the error object is one of our *structured* error
    // userdata (raised for scope-destruction errors). If so, recover the
    // original `Error` and wrap it in `CallbackError`, mirroring mlua.
    let wrapped = recover_wrapped_error(state, -1);
    if let Some(cause) = wrapped {
      // 栈回溯要在 `lua_pop` **之前**取：`luaL_traceback` 走的就是此刻
      // 这份调用栈（mlua 的 `pop_error` 同样在弹出错误对象前取）。
      // 取不到（栈位不足等）时退化成空串，与旧行为一致。
      let traceback = self.traceback_at_level(1);
      // `pop_stack` 弹回栈顶错误对象（`traceback_at_level` 净栈变化为零）这一层。
      pop_stack(state, 1);
      return Error::CallbackError {
        traceback,
        cause: Arc::new(cause),
      };
    }
    // Otherwise, fall back to the flat string error path.
    // Safety: `bytes_at`（unsafe 门面族）：`state` 存活（&self 的 XRc 链）；-1 仍是
    // 有效索引（上一分支未弹栈）；切片带出的栈顶串字节在紧随的 `.map` 表达式内
    // 当场拷成 owned `String`，其间无 VM 调用，窗口契约形态 1 成立。
    let msg = unsafe { bytes_at(state, -1) }
      .map(|s| String::from_utf8_lossy(s).into_owned())
      // `None`（非字符串错误对象，旧 null 指针）退化为 [`NON_STRING_ERROR_MSG`]。
      .unwrap_or_else(|| NON_STRING_ERROR_MSG.to_string());
    // 弹掉的正是栈顶错误对象（`lua_tolstring` 若做了转换，替换后的字符串仍在
    // -1），栈平衡不变；`pop_stack`（safe 门面）收口。
    pop_stack(state, 1);
    // `LUA_ERRMEM` (status 4) is an out-of-memory error (the VM set the
    // error object to "not enough memory"); surface it as `MemoryError`
    // so `set_memory_limit` callers can match it, mirroring mlua.
    // `luau_load` reports OOM with a generic non-zero rc but the same
    // "not enough memory" message, so we also detect it by message.
    if status == LuaStatus::ErrMem as i32 || msg == OOM_MSG {
      return Error::MemoryError(msg);
    }
    Error::RuntimeError(msg)
  }

  /// Collect every stack value above `base` into a [`MultiValue`], then
  /// truncate the stack back to `base`. Shared by `Function::call`,
  /// `Lua::exec_raw`, and the coroutine-resume paths — all of which collect on
  /// **this** handle's state (协程路径先把结果 xmove 回 parent 再收集)，故栈
  /// 句柄不再作为参数散传，统一取自 `self.state()`。
  ///
  /// 收集前统一预留头寸：`value_from_stack` 会先把引用型结果复制（`lua_pushvalue`）
  /// 到栈顶再弹出收进注册表引用，而 `LUA_MULTRET` 调用后结果可能已把 C 帧正好填到
  /// `ci->top`（LUA_MINSTACK），那次复制 push 会越出帧界——即 `lua_pushvalue` 的
  /// `api_incr_top` 断言（fuzzer 发现：`local t={a=1}; return <约 20 个含 t 的值>`）。
  /// 预留失败时截回 `base` 并报 [`TOO_MANY_RESULTS_MSG`]。
  pub(crate) fn collect_results_above(&self, base: i32) -> Result<MultiValue> {
    let state = self.state();
    // `has_stack_room` 是带契约的 safe 门面（只报告头寸，false = 扩不动，
    // 本身不越界读写；`state` 存活由调用方传自己驱动的 state 给出）。
    if !has_stack_room(state, 2) {
      // 头寸不足：`set_stack_top` 把 MULTRET 结果区截回调用方记录的 `base`，不留残值。
      set_stack_top(state, base);
      return Err(Error::runtime(TOO_MANY_RESULTS_MSG));
    }
    // `stack_top` 是 safe 只读门面（`state` 存活，只读栈深）。成功路径上
    // `value_from_stack` 每次 pushvalue+pop_ref 净零、恒有两层余量覆盖最坏引用登记；
    // `base+1..=top` 即本次 MULTRET 结果区，索引全部有效。
    let top = stack_top(state);
    let nresults = top - base;
    let mut results = MultiValue::with_capacity(nresults.max(0) as usize);
    // 栈位区间 base+1..=top 迭代，等价原 `for i in 0..nresults`
    for index in base + 1..=top {
      match self.value_from_stack(index) {
        Ok(v) => results.push_back(v),
        // 失败路径同样把栈截断回 base，避免泄漏中间值。
        Err(e) => {
          set_stack_top(state, base);
          return Err(e);
        }
      }
    }
    // 三条出口（正常/收集失败/头寸不足）都以 `set_stack_top(state, base)` 收口，栈平衡不变。
    set_stack_top(state, base);
    Ok(results)
  }
}

// §8：测私有函数 `build_lua` 的 null-state 前置检查；ulua-rt 不暴露分配器注入口
// （`luaL_newstate` 无参数），pub API 无从构造 null state，迁 tests/ 需泄 pub，保留 src。
// 可观测的前提（失败分配器 → null）与两条 pub 构造路径见 `tests/state_alloc_failure.rs`。
#[cfg(test)]
mod tests {
  use core::{
    ffi::c_void,
    ptr::{NonNull, null_mut},
  };
  use std::panic::catch_unwind;

  use ulua_vm::functions::lua_newstate::lua_newstate;

  use super::build_lua;

  /// 一个总是分配失败的 VM 分配器（模拟 OOM）：任何请求都返回 null（VM 把
  /// null 同时当作「释放完成」与「分配失败」，故无需区分 `nsize == 0`）。
  /// 仅作 `lua_newstate` 的 `lua_Alloc` 回调：签名与 C 侧一致，忽略全部入参
  /// （含 `ud`）且无内部状态，恒返回 null——VM 契约允许分配器返回 null 表示
  /// 失败，因此任何调用都安全，无前置条件。
  extern "C-unwind" fn failing_alloc(
    _ud: *mut c_void,
    _ptr: *mut u8,
    _osize: usize,
    _nsize: usize,
  ) -> *mut u8 {
    null_mut()
  }

  /// R5：null 检查必须先于 `lua_l_openlibs`——注入 null 时只得到 `None`/panic，
  /// 不会把空 state 交给 openlibs（那是空指针解引用）。
  #[test]
  fn build_lua_rejects_null_state_before_openlibs() {
    // 1) 恒返回 `None` 的工厂：走 openlibs 分支也只得到 None。
    assert!(build_lua(|| None, true).is_none());
    assert!(build_lua(|| None, false).is_none());

    // 2) 真实 OOM 路径（failing allocator）同样返回 None。
    // Safety: `lua_newstate` 对分配器无前置要求（首个请求即分配 global_State，
    // `failing_alloc` 恒 null → 函数返回 null state，不解引用）；`null_mut()`
    // 作 ud 与 C 参考一致（该分配器忽略 ud，属既有约定·review.md §2 的 allocator FFI
    // 契约返回，非本处可空形参）。返回值经 `NonNull::new` 收口为 `None`（null 时）
    // 再交给 `build_lua`，任何 `lua_*` 入口都不会拿到空 state。
    assert!(
      build_lua(
        || NonNull::new(unsafe { lua_newstate(Some(failing_alloc), null_mut()) }),
        true
      )
      .is_none()
    );

    // 3) `Lua::new` 的失败形态是「state 为空」panic，而不是 openlibs 崩溃。
    let err = match catch_unwind(|| build_lua(|| None, true).expect("lua_l_newstate returned null"))
    {
      Err(err) => err,
      Ok(_) => panic!("a null state must panic instead of being opened"),
    };
    let msg = err
      .downcast_ref::<String>()
      .cloned()
      .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_string()))
      .unwrap_or_default();
    assert!(
      msg.contains("null"),
      "panic must report the null state, got {msg:?}"
    );
  }
}

// r7-tlossy1 让位台账（本文件票面 2 枚：让 2）——:1107/:1142 `String::from_utf8_lossy(s).into_owned()`
// 两处源均为 VM 栈上 LuaString 字节（`lua_l_tolstring_ref`/`lua_tolstring_ref` 切片
// 带出全字节）：`__tostring` 返回值与错误对象均可为任意二进制（`b"a\0\xff"` 级），
// lossy 系语义所需而非过度防御（对照 string.rs `to_str` 严格臂为另一出口）。汇为
// mlua 冻结面 `Result<String>`/`Error` 文案，owned 下限各 1 malloc；:1142 仅
// pcall/luau_load 失败臂可达，:1107 每次显式 tostring 调用一次、非 VM 热面。
