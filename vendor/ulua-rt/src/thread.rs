//! The [`Thread`] handle and [`ThreadStatus`]. Mirrors `mlua::Thread` /
//! `mlua::ThreadStatus`.
//!
//! A thread is a Luau coroutine. It is created from a [`Function`] via
//! [`Lua::create_thread`] (or surfaces from `coroutine.create(...)` evaluated
//! in Lua) and driven with [`Thread::resume`].
//!
//! ## Implementation
//!
//! The thread is a first-class Lua value, so the handle holds a registry
//! reference (like every other handle) keeping the coroutine alive. We also
//! cache the coroutine's state as a non-null `NonNull<LuaState>` handle
//! (type-level 非空不变量；FFI 边界处 `as_ptr` 转换) for the resume/xmove dance.
//!
//! 对协程 `LuaState` 的裸句柄操作不直接散落在各业务方法里，而是经 [`CoWindow`]
//! 这一带 `'lua` 生命周期的**栈窗口视图**收口：生命周期即「宿主 VM 与本协程对象在
//! 本次操作全程存活」的编码契约，只读探测是其 safe 方法，写栈/搬运是带 `# Safety`
//! 的最小门面（§2：裸句柄 → 带生命周期视图 + 具名访问器）。
//!
//! `resume` mirrors mlua: push the args onto the *parent* state, `lua_xmove`
//! them to the coroutine, `lua_resume(co, parent, nargs)`, then `lua_xmove` the
//! results back and convert them. Status is derived from `lua_status` +
//! `lua_costatus`, matching mlua's `Resumable`/`Running`/`Normal`/`Finished`/
//! `Error` mapping.

use core::{
  fmt::{self, Debug, Formatter},
  ptr::{NonNull, eq},
};

#[cfg(feature = "async")]
use crate::async_support::AsyncThread;
#[cfg(feature = "async")]
use crate::async_support::{PollKind, implicit_thread_owner};
#[cfg(feature = "async")]
use crate::state::has_stack_room;
use crate::{
  error::{Error, Result},
  function::Function,
  multi::MultiValue,
  registry::RegHandle,
  state::{
    Lua, LuaRef, StateView, co_status, ensure_stack, ensure_stack_or_panic, move_slots, pop_stack,
    push_globals_to_stack, push_own_thread, replace_globals_from_top, reset_co, resume_co,
    resume_co_error, set_stack_top, spawn_thread, stack_top, thread_at, thread_status,
  },
  sync::{NOT_SYNC, NotSync, XRc},
  sys::*,
  traits::{FromLuaMulti, IntoLua, IntoLuaMulti},
};

/// Status of a Lua thread (coroutine). Mirrors `mlua::ThreadStatus`.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ThreadStatus {
  /// The thread was just created or is suspended (yielded) and can be resumed.
  Resumable,
  /// The thread is currently running.
  Running,
  /// The thread is active but not running (it resumed another thread).
  Normal,
  /// The thread has finished executing.
  Finished,
  /// The thread raised a Lua error during execution.
  Error,
}

/// The raw outcome of one async resume. See [`Thread::resume_for_async`].
#[cfg(feature = "async")]
pub(crate) enum AsyncResume {
  /// The coroutine yielded the internal "future pending" marker.
  Pending,
  /// The coroutine yielded values via `coroutine.yield` (a Stream item).
  Yielded(MultiValue),
  /// The coroutine finished, returning these values.
  Returned(MultiValue),
}

/// A handle to a Lua thread (coroutine). Mirrors `mlua::Thread`.
///
/// Under the `send` feature it is `Send` but never `Sync` — see
/// `crate::sync::NotSync`.
#[derive(Clone)]
pub struct Thread {
  pub(crate) reference: XRc<LuaRef>,
  /// The coroutine state handle, cached from the referenced value.
  /// `NonNull` 把「协程 state 非空」这一构造期建立的不变量编码进字段类型，
  /// FFI 边界处经 [`CoWindow`] 的 `as_ptr` 收口点读出（§2：可空哨兵退役后，
  /// 句柄内部不再留裸指针，也不向业务方法裸传）。
  pub(crate) thread_state: NonNull<LuaState>,
  pub(crate) _not_sync: NotSync,
}

// `Thread` caches the coroutine state as a `NonNull<LuaState>` handle, whose
// pointee is `!Send` by default. Under the move-only `send` contract it is sound to move a
// `Thread` to another thread (the cached pointer stays valid; the VM is single-threaded
// in use). `!Sync` is preserved by the `NotSync` marker.
//
// Safety: 沿用 `LuaInner` 的移交契约——协程 state 与其宿主 VM 同生命周期，
// `Thread` 跨线程移动只是换驱动器，缓存指针仍有效；不并发访问由 `NotSync`
// 保证 `Thread: !Sync`（`reference` 的 `Sync` 仅服务 `Arc` 的指针复制）。
#[cfg(feature = "send")]
unsafe impl Send for Thread {}

/// 一次协程操作对 `LuaState` 裸句柄的**栈窗口视图**（§2：裸句柄 → 带生命周期视图）。
///
/// 把原先散落在 `resume`/`resume_error`/`status`/收尾各方法里的
/// `let co = self.thread_state.as_ptr(); let parent = lua.state();` 裸指针散传，
/// 收进一个带 `'lua` 生命周期的最小门面：`'lua` 即「宿主 VM 与本协程对象在本次操作
/// 全程存活」的编码契约——`Thread` 持注册表引用钉住协程对象、`&'lua Lua` 钉住其
/// `XRc<LuaInner>`。state 经 [`co_state`](Self::co_state)/
/// [`parent_state`](Self::parent_state) 两个收口点取 [`StateView`] 驱动视图;
/// 裸指针只在视图的 `as_ptr`/`as_mut_ptr` FFI 实参位、紧贴一次 `lua_*` C-ABI
/// 调用出现,业务方法经本门面的安全方法装配（沿用 `ensure_stack`/
/// `push_value`/`pop_error`/`collect_results_above` 一族的既有「安全门面」约定）。
///
/// 栈深度/搬运量/协程挂起态是**正确性**约定（非内存安全）：违反最坏是 VM 断言/报错，
/// 而非 Rust 层的悬垂引用或数据竞争——后者已由 `'lua` 存活不变量挡在类型之外。故各方法
/// 把该约定以散文「调用序前提」写明，由同模块内的调用点维持，不升级为 `unsafe fn`
/// （本类型私有，外部安全代码无从构造非法调用序）。
struct CoWindow<'lua> {
  parent: &'lua Lua,
  co: NonNull<LuaState>,
}

impl<'lua> CoWindow<'lua> {
  /// 从 `Thread` 缓存的非空 co 句柄与宿主 `Lua` 取一个窗口。co 非空由
  /// [`Thread::from_ref`] 构造期建立，`'lua` 借用担保 parent 与本协程全程存活。
  #[inline]
  fn new(parent: &'lua Lua, co: NonNull<LuaState>) -> CoWindow<'lua> {
    CoWindow { parent, co }
  }

  /// 宿主 VM 句柄（供 `push_value`/`collect_results_above`/`pop_error` 等 safe 门面）。
  #[inline]
  fn parent(&self) -> &'lua Lua {
    self.parent
  }

  /// parent（调用方驱动的）state 驱动视图：经 [`Lua::state`] 收口点取得。
  #[inline]
  fn parent_state(&self) -> StateView<'_> {
    self.parent.state()
  }

  /// 本协程 state 的驱动视图（[`StateView`]:协程对象由 `Thread` 的注册表引用
  /// 锚定存活，驱动契约由视图类型承载）。纯指针拷贝,无 `unsafe`。
  #[inline]
  fn co_state(&self) -> StateView<'_> {
    StateView::from_handle(self.co)
  }

  // -------------------------------------------------------------------------
  // safe 只读探测：唯一前提是 `'lua` 编码的存活不变量。
  // -------------------------------------------------------------------------

  /// 协程的 raw `lua_status` 码（只读，不触栈、不抛错）。
  #[inline]
  fn status(&self) -> i32 {
    // `thread_status` 是 `crate::state` 的 safe 只读门面：`co` 随 `'lua` 关联的
    // `Lua` 的 `XRc<LuaInner>` 与 `Thread` 注册表引用共同锚定存活，解引用与只读
    // 字段访问的 `// Safety` 论证收在其函数头一处。
    thread_status(self.co_state())
  }

  /// `lua_costatus(parent, co)`：co 相对 parent 的角色码（只读）。
  #[inline]
  fn costatus(&self) -> i32 {
    // `co_status` 是 safe 只读门面：`parent`/`co` 同属一存活 VM（`'lua` 与
    // `Thread` 句柄共享同一 `XRc<LuaInner>`），只读查询的存活论证收在函数头一处。
    co_status(self.parent_state(), self.co_state())
  }

  /// co 当前栈深（只读）。
  #[inline]
  fn top(&self) -> i32 {
    // `stack_top` 是 `crate::state` 的 safe 只读门面（存活论证在其函数头）。
    stack_top(self.co_state())
  }

  /// parent 当前栈深（只读）。
  #[inline]
  fn parent_top(&self) -> i32 {
    stack_top(self.parent_state())
  }

  /// co 侧能否再容纳 `slots` 层（只报告头寸，不实际读写越界）。
  #[cfg(feature = "async")]
  #[inline]
  fn check_stack(&self, slots: i32) -> bool {
    // `has_stack_room` 是 safe 门面：`co` 存活论证收在函数头一处，本身只报告头寸。
    has_stack_room(self.co_state(), slots)
  }

  /// parent 侧能否再容纳 `slots` 层（只报告头寸）。
  #[cfg(feature = "async")]
  #[inline]
  fn parent_check_stack(&self, slots: i32) -> bool {
    // `has_stack_room` 是 safe 门面；`parent` 存活（`'lua` 的 `XRc<LuaInner>`）。
    has_stack_room(self.parent_state(), slots)
  }

  // -------------------------------------------------------------------------
  // 写栈/搬运/恢复门面：安全方法，`unsafe` 只在内部紧贴一次 C-ABI 调用。
  // 各方法的「调用序前提」是正确性约定，由同模块调用点维持（见类型文档）。
  // -------------------------------------------------------------------------

  /// 把 co 栈顶 `n` 个值搬到 parent。
  /// 调用序前提：co 已挂起（其栈顶 `n` 值非活寄存器；对运行中协程 `xmove` 会剥走
  /// 活寄存器 = VM UB），parent 侧头寸已由调用方 `ensure_stack` 预留。
  #[inline]
  fn xmove_to_parent(&self, n: i32) {
    // `move_slots` 是 safe 搬运门面：两侧同存活 VM（`'lua` 与 `Thread` 注册表引用共
    // 锚定），调用序前提（co 挂起、parent 头寸预留、`n` 在预留内）由文档所列调用点维持，
    // 其内部一次 `lua_xmove` 的 `// Safety` 论证收在函数头一处。
    move_slots(self.co_state(), self.parent_state(), n)
  }

  /// 把 parent 栈顶 `n` 个值搬到 co。
  /// 调用序前提：parent 栈顶恰有 `n` 个待搬值；co 侧头寸已由调用方预留。
  #[inline]
  fn xmove_from_parent(&self, n: i32) {
    // `move_slots` 门面，前提（parent 顶有 n 值、co 头寸预留）由文档所列调用点维持。
    move_slots(self.parent_state(), self.co_state(), n)
  }

  /// 把 co 栈截断到深度 `top`。
  /// 调用序前提：`top` 是合法栈深度且不剥走活寄存器窗口（co 挂起、`top` 为搬运前记录
  /// 值、或 `0` 丢弃已挂起协程的残值）。
  #[cfg(feature = "async")]
  #[inline]
  fn set_top(&self, top: i32) {
    // `set_stack_top` 是 safe 门面；调用序前提（co 挂起、`top` 合法）由 async 收尾路径维持。
    set_stack_top(self.co_state(), top)
  }

  /// 把 parent 栈截断到深度 `top`。
  /// 调用序前提：`top` 是调用方先前记录的合法 parent 深度（纯截回丢弃残值）。
  #[inline]
  fn set_parent_top(&self, top: i32) {
    // `set_stack_top` 是 safe 门面；`top` 为搬运前记录的合法深度。
    set_stack_top(self.parent_state(), top)
  }

  /// 对 co 跑 `lua_resume(co, parent, nargs)`，返回 raw 状态码。
  /// 调用序前提：co 处于可 resume 状态（挂起/新建，调用方已预检 status）、其实参恰在
  /// 栈顶、两侧头寸已预留；panic 展开只经 `C-unwind` 边界。
  #[inline]
  fn resume(&self, nargs: i32) -> i32 {
    // `resume_co` 是 safe 门面：调用序前提（status 预检、实参就位、头寸预留）由
    // `resume_inner`/`resume_for_async`/`terminate_async` 三处维持；解引用存活 co、
    // `from` 同 VM 的 `// Safety` 收在其函数头一处。
    resume_co(self.co_state(), self.parent_state(), nargs)
  }

  /// 以「立即 raise 栈顶错误」的方式 resume（上游 `auxresume` 的 `lua_resumeerror`）。
  /// 调用序前提：同 [`resume`](Self::resume)，且错误对象已 `xmove` 到 co 栈顶。
  #[inline]
  fn resumeerror(&self) -> i32 {
    // `resume_co_error` 是 safe 门面，前提由 `resume_error` 维持（status 预检 + 栈顶
    // 即错误对象 + 头寸预留），其内部 C-ABI 边界的 `// Safety` 收在函数头一处。
    resume_co_error(self.co_state(), self.parent_state())
  }

  /// `lua_resetthread(co)`：清空 co 栈并回到可复用状态。
  /// 调用序前提：co 非运行态（挂起/完成/错误）；由 `reset` 入口的 status 分派保证。
  #[inline]
  fn reset_thread(&self) {
    // `reset_co` 是 safe 门面：`co` 由句柄锚定存活、调用方已挡 Running/Normal，
    // 其内部 `lua_resetthread` 的 `// Safety` 收在函数头一处。
    reset_co(self.co_state())
  }

  /// 把 parent 的全局表（`LUA_GLOBALSINDEX` 伪索引）净压一层到 parent 栈顶。
  /// 调用序前提：parent 栈有 1 层余量（`reset` 已 `ensure_stack(parent, 1)`）。
  #[inline]
  fn push_parent_globals(&self) {
    // 与 `Lua::globals` 共用同一收口点（`LUA_GLOBALSINDEX` 伪索引 → 净压一层）。
    push_globals_to_stack(self.parent_state())
  }

  /// 把 co 栈顶值消费并落到 co 的 `LUA_GLOBALSINDEX` 伪索引。
  /// 调用序前提：co 栈顶恰有 1 个待落值（刚 `xmove` 进来的全局表）。
  #[inline]
  fn replace_co_globals(&self) {
    // co 栈顶即刚搬入的全局表；收口点消费该层并落 `LUA_GLOBALSINDEX` 伪索引。
    replace_globals_from_top(self.co_state())
  }

  // -------------------------------------------------------------------------
  // resume/cross/error 装配：把上述门面编成 mlua 的 resume 语义（全程安全）。
  // -------------------------------------------------------------------------

  /// 把 `args` push 到 parent 上再 `lua_xmove` 进 co（顺序同上游
  /// `lcorolib.cpp` `auxresume`），返回参数个数。
  ///
  /// 两侧都要先预留：parent 是真正被写入的帧窗口（只预留 co 会在参数多于
  /// ~`LUA_MINSTACK` 个时越过 parent 的 `ci->top`/`stack_last` 写栈）；co 侧
  /// 提前 `lua_checkstack` 则避免 `lua_xmove` 内部扩容失败时在 co 上
  /// `lua_error`，panic 穿过这个安全 Rust 边界。
  ///
  /// 调用序前提：本窗口取自与 `args` 同一存活 VM 的 `Thread`，co 是可 resume 的协程。
  fn move_args_to_co(&self, args: &MultiValue) -> Result<i32> {
    let nargs = args.len() as i32;
    ensure_stack(self.parent_state(), nargs.saturating_add(2))?;
    ensure_stack(self.co_state(), nargs)?;
    for v in args.iter() {
      self.parent().push_value(v)?;
    }
    // 上方两条 `ensure_stack` 落实预留契约（parent/co 同存活 VM、两侧头寸覆盖 push
    // 循环 + xmove 搬运量）；`push_value` 每次净压一层，循环后 parent 顶部恰有 `nargs`
    // 个值，`xmove_from_parent` 从 from 顶 pop 等额个数压入 to——两侧计数一致，无越栈读写。
    if nargs > 0 {
      self.xmove_from_parent(nargs);
    }
    Ok(nargs)
  }

  /// 把 co 栈上的全部值搬到 parent，返回搬运前 parent 的深度（用作截断点）。
  ///
  /// 预留落在 **parent**（真正被写入的帧窗口），且先探测再搬：`lua_xmove` 内部虽也会
  /// 给 to 侧扩容，但扩不出来时是在 `from`（co）上 `lua_error`，会 panic 穿过这个安全
  /// Rust 边界；提前 `ensure_stack` 把它变成可捕获的 [`Error`]。`+1` 是
  /// [`Lua::collect_results_above`] 里 `value_from_stack` 复制引用型结果所需的头寸。
  ///
  /// 调用序前提：co 处于挂起态、其栈上只有 resume 产出的结果值（活寄存器窗口已不存活）。
  fn move_results_to_parent(&self) -> Result<i32> {
    let nres = self.top();
    ensure_stack(self.parent_state(), nres.saturating_add(1))?;
    let base = self.parent_top();
    if nres > 0 {
      self.xmove_to_parent(nres);
    }
    Ok(base)
  }

  /// resume 错误路径的共用收尾（`finish_resume` 与 `resume_for_async` 同型）：
  /// 错误对象压在 co 栈顶、其下可能还有*其它*残留值，故先把全部残值搬到 parent，
  /// 从新栈顶读出错误（`pop_error` 只弹错误对象本身），再把 parent 截回搬运深度
  /// `base`——不截断的话残留值会泄漏到 parent 栈上。
  ///
  /// 调用序前提：`status` 是刚在本协程上结束的 `lua_resume`/`lua_resumeerror` 返回的
  /// **错误**状态码（错误对象因此正压在 co 栈顶；`Break` 不算——其寄存器窗口仍存活）。
  fn take_error_after_resume(&self, status: i32) -> Result<Error> {
    let base = self.move_results_to_parent()?;
    let err = self.parent().pop_error(status);
    self.set_parent_top(base);
    Ok(err)
  }

  /// `resume`/`resume_error` 的共用收尾：分派状态码，把结果搬回 parent 并转换。
  ///
  /// 调用序前提：`status` 是刚刚以 parent 为 from-state 恢复本协程所返回的状态码，两侧
  /// 属于同一存活 VM——非 `Break` 时协程已挂起、栈上的值只可能是产出/残留值。
  fn finish_resume<R: FromLuaMulti>(&self, status: i32) -> Result<R> {
    // 状态码真相在 `LuaStatus`，比较处只做 `as i32` 边界转换。非 Ok/Yield/Break 即错误态。
    if status != LuaStatus::Ok as i32
      && status != LuaStatus::Yield as i32
      && status != LuaStatus::Break as i32
    {
      return Err(self.take_error_after_resume(status)?);
    }
    // `LUA_BREAK` is an interrupt-driven yield: the coroutine produced
    // no values and its entire register window is still *live* (it must
    // continue from the break point on the next resume). We must NOT
    // touch its stack — moving any values off would strip live
    // registers and corrupt the re-entry. Return an empty result.
    if status == LuaStatus::Break as i32 {
      return R::from_lua_multi(MultiValue::with_capacity(0), self.parent());
    }
    // Success/yield: the produced values sit on the coroutine stack.
    let base = self.move_results_to_parent()?;
    let results = self.parent().collect_results_above(base)?;
    R::from_lua_multi(results, self.parent())
  }

  /// Run `lua_resume` and collect/convert the results. Expects `nargs` already
  /// moved onto the coroutine stack.
  ///
  /// 调用序前提：co 处于可 resume 状态（调用方已如 `resume` 先行检查 status）；co 栈顶
  /// 已恰有 `nargs` 个实参（`move_args_to_co` 的产物），两侧栈头寸也已预留。
  fn resume_inner<R: FromLuaMulti>(&self, nargs: i32) -> Result<R> {
    let status = self.resume(nargs);
    self.finish_resume::<R>(status)
  }
}

impl Thread {
  /// Build a [`Thread`] from a registry ref to a thread value. Caches the
  /// coroutine's state via `lua_tothread`.
  pub(crate) fn from_ref(reference: LuaRef) -> Thread {
    let state = reference.state();
    // `push` 不自动扩容：预留重压 thread 值的一层（读毕即弹）。
    ensure_stack_or_panic(state, 1);
    // `reference.push()`（safe fn）把 thread 值压到栈顶（注册表引用锚定其在世）。
    reference.push();
    // `thread_at` 是 safe 门面：`state` 存活（`LuaRef` 的 `XRc<LuaInner>`）；
    // `reference` 按构造纪律只从 thread 值登记（`value_from_stack` 的 `LuaType::Thread`
    // 闸门、`create_thread`/`current_thread` 的自压路径），读 -1 处 thread 值的协程
    // state 的 `// Safety` 收在其函数头一处（只读该槽、不动栈深；state 与 thread 对象
    // 同生命周期，注册表引用钉住对象 ⇒ 缓存指针随句柄存活）。
    let ts = thread_at(state, -1);
    // 前面各步不动栈深，栈顶仍是 push 压入的 thread 值；`pop_stack`（safe 门面）
    // 弹回这一层恢复平衡。
    pop_stack(state, 1);
    // 纯 Rust：「非 thread 值」与理论上的空 state 统一收敛为同一处响亮 panic
    // （`thread_at` 已把二者归一为 `None`；旧实现里前者 panic、后者静默缓存 null 留待日后再解引用）。
    let thread_state = ts.expect("registry ref 指向 thread 值");
    Thread {
      reference: XRc::new(reference),
      thread_state,
      _not_sync: NOT_SYNC,
    }
  }

  /// The owning [`Lua`].
  pub fn lua(&self) -> Lua {
    self.reference.lua()
  }

  /// The raw coroutine state pointer. Mirrors `mlua::Thread::state`.
  /// （公开面维持 mlua 同型的裸指针返回——那是调用方侧的 FFI 形态；句柄
  /// 内部字段是 `NonNull`，此 accessor 即本类型的边界转换点。内部代码一律走
  /// [`Self::co_state`] 的 safe 视图，此 `pub` 面仅供外部/测试裸访问 VM 状态。）
  pub fn state(&self) -> *mut LuaState {
    self.thread_state.as_ptr()
  }

  /// 协程 state 的 crate 内驱动视图（[`StateView`]:协程对象由本句柄的注册表
  /// 引用锚定存活、值可达期间不被 GC，驱动契约由视图类型承载）。纯指针拷贝。
  pub(crate) fn co_state(&self) -> StateView<'_> {
    StateView::from_handle(self.thread_state)
  }

  /// Resume the coroutine, passing `args` and converting its yielded/returned
  /// values to `R`. Mirrors `mlua::Thread::resume`.
  ///
  /// Returns [`Error::CoroutineUnresumable`] if the thread has finished,
  /// errored, or is otherwise not resumable.
  pub fn resume<R: FromLuaMulti>(&self, args: impl IntoLuaMulti) -> Result<R> {
    let lua = self.lua();
    // Convert the args first so a failing `IntoLua` (e.g. a bad argument)
    // surfaces *before* we touch any Lua stack — matching mlua.
    let args: MultiValue = args.into_lua_multi(&lua)?;

    if !matches!(self.status(), ThreadStatus::Resumable) {
      return Err(Error::CoroutineUnresumable);
    }

    let win = CoWindow::new(&lua, self.thread_state);
    // `move_args_to_co` 是带调用序契约的安全门面：`status()==Resumable` 刚判定（co 可
    // resume）、`lua`/`self` 同 VM（句柄 `self.lua()` 取自同一 `LuaRef`）；其内部 `?`
    // 失败即返回，成功时 co 栈顶恰有 `nargs` 个实参、两侧头寸就位。
    let nargs = win.move_args_to_co(&args)?;
    // `resume_inner` 的前提由上一行产出逐条成立（见其「调用序前提」文档）。
    win.resume_inner::<R>(nargs)
  }

  /// Resume the coroutine, immediately raising `error` inside it.
  /// Mirrors `mlua::Thread::resume_error` (a Luau extension).
  pub fn resume_error<R: FromLuaMulti>(&self, error: impl IntoLua) -> Result<R> {
    let lua = self.lua();
    let err_value = error.into_lua(&lua)?;

    if !matches!(self.status(), ThreadStatus::Resumable) {
      return Err(Error::CoroutineUnresumable);
    }

    let win = CoWindow::new(&lua, self.thread_state);
    // 同 `resume`：错误对象落在 parent 上，co 侧提前探测以免 xmove 内部扩容
    // 失败在本安全边界上抛错。
    ensure_stack(win.parent_state(), 2)?;
    ensure_stack(win.co_state(), 1)?;
    lua.push_value(&err_value)?;
    // 上面两条 `ensure_stack` 先行（失败经 `?` 转 `Err`，门面不会见到缺头寸的一侧），
    // push 1 + xmove 1 的搬运量与预留一致；`resumeerror` 是上游 `auxresume` 错误注入的
    // 既定形态，返回码刚出即交给 `finish_resume`（其「调用序前提」要求的"刚在本协程上
    // 结束"成立）。status 预检保证 co 可 resume、`err_value` 存活于本帧。
    win.xmove_from_parent(1);
    let status = win.resumeerror();
    win.finish_resume::<R>(status)
  }

  /// Low-level resume used by the async driver. Pushes `args` to the
  /// coroutine, resumes it once, and returns the raw outcome:
  ///
  /// * `Err(e)` — the coroutine raised an error.
  /// * `Ok(AsyncResume::Pending)` — the coroutine yielded the internal
  ///   "future pending" marker (a single light-userdata == `PollKind::Pending`);
  ///   the stack is left cleared.
  /// * `Ok(AsyncResume::Yielded(vals))` — the coroutine yielded `vals`
  ///   (a `coroutine.yield`, i.e. a Stream item).
  /// * `Ok(AsyncResume::Returned(vals))` — the coroutine finished, returning
  ///   `vals`.
  ///
  /// The coroutine stack is fully consumed/cleared on every path.
  #[cfg(feature = "async")]
  pub(crate) fn resume_for_async(&self, args: MultiValue) -> Result<AsyncResume> {
    let lua = self.lua();
    let win = CoWindow::new(&lua, self.thread_state);
    let nargs = args.len() as i32;
    // push 循环写的是 **parent**（`lua.push_value` 落 parent 栈）：只预留 co
    // 会在参数多于 ~`LUA_MINSTACK` 个时越过 parent 的 `ci->top`/`stack_last`
    // 写栈，超 `LUAI_MAXSTACK` 时 panic 穿透 `Future::poll` 而非 `Err`。对齐
    // `move_args_to_co` 的双侧预留纪律（parent 侧 nargs+2、co 侧同理）。
    ensure_stack(win.parent_state(), nargs.saturating_add(2))?;
    ensure_stack(win.co_state(), nargs.saturating_add(2))?;
    for v in &args {
      lua.push_value(v)?;
    }
    // 上方两条 `ensure_stack` 覆盖 push 循环与 xmove 搬运量；co/parent 同存活 VM；
    // `resume` 在受保护边界内进行，返回码原样交给下方按 status 分派的收尾。
    if nargs > 0 {
      win.xmove_from_parent(nargs);
    }
    let status = win.resume(nargs);

    // An interrupt-driven `lua_break` yield leaves the coroutine's whole
    // register window *live* (it continues from the break point on the next
    // resume). Treat it like a value-less `coroutine.yield` and do NOT touch
    // its stack — moving anything off would corrupt the re-entry (same
    // contract as `finish_resume`).
    if status == LuaStatus::Break as i32 {
      return Ok(AsyncResume::Yielded(MultiValue::new()));
    }

    if status != LuaStatus::Ok as i32 && status != LuaStatus::Yield as i32 {
      // 错误路径与 `finish_resume` 共用收尾 `take_error_after_resume`：先把全部
      // 残值搬到 parent（搬运前经 `move_results_to_parent` 预留，和下面的
      // 成功/yield 路径一致），再取错误并截回搬运深度。调用序前提（错误码刚在本
      // 协程上结束）由上面的 status 分派保证。
      return Err(win.take_error_after_resume(status)?);
    }

    let yielded = status == LuaStatus::Yield as i32;
    // 非 Break 状态已在上面分流返回——co 此刻挂起，`top` 是 safe 只读门面。
    let nres = win.top();

    // Detect the single-light-userdata pending marker (top of the
    // coroutine stack) on a yield.
    if yielded && nres == 1 && PollKind::Pending.is_at(win.co_state(), -1) {
      // co 挂起且栈顶即 pending 标记（寄存器窗口不存活），截空丢弃它。
      win.set_top(0);
      return Ok(AsyncResume::Pending);
    }

    // Otherwise move the produced values to the parent and convert.
    let base = win.move_results_to_parent()?;
    let results = lua.collect_results_above(base)?;
    // 结果已全部搬到 parent，co 侧清空残留（co 挂起，无活寄存器）。
    win.set_top(0);

    if yielded {
      Ok(AsyncResume::Yielded(results))
    } else {
      Ok(AsyncResume::Returned(results))
    }
  }

  /// Resume a yielded async coroutine with the "terminate" signal so it drops
  /// its in-flight future and parks. Best-effort; ignores errors. Used when an
  /// [`AsyncThread`](crate::async_support::AsyncThread) is dropped mid-flight.
  #[cfg(feature = "async")]
  pub(crate) fn terminate_async(&self) {
    // BREAK（中断挂起）的协程不投递 terminate：其寄存器窗口存活，resume 会
    // 从断点继续执行，把 terminate 标记当成断点求值结果注入脚本；且 resume
    // 可能再次 BREAK，此时截栈会毁掉活寄存器。
    if self.is_interrupt_suspended() || !self.is_resumable() {
      return;
    }
    let lua = self.lua();
    let win = CoWindow::new(&lua, self.thread_state);
    // 短路顺序与旧实现一致：parent 侧不足时连 co 侧都不探。best-effort——任一侧
    // 不足即整体返回（Drop 路径不得 panic），与本函数的尽力语义一致。
    if !(win.parent_check_stack(1) && win.check_stack(2)) {
      return;
    }
    // terminate 标记先落在 parent 再 xmove 到 co（`PollKind::push` 是带契约的 safe
    // 门面：压的是 static 地址 token，只比较、从不解引用）。
    PollKind::Terminate.push(win.parent_state());
    // 上一行的头寸探测覆盖本句——parent 栈顶正是刚压入的标记，co 侧留 2 层；搬运量 1
    // 与预留一致（parent -1 / co +1，两侧同 VM）。
    win.xmove_from_parent(1);
    // co 可 resume 由入口的 `is_resumable` + 非中断挂起判定保证；实参恰 1 个，即刚搬入
    // 的 terminate 标记；两侧头寸就位。返回码原样交给下面的 status 分派。
    let status = win.resume(1);
    // resume 期间再次触发中断则整窗存活，绝不能截断。
    if status != LuaStatus::Break as i32 {
      // 非 Break 即 co 已挂起或终止，寄存器窗口不再存活，截空丢弃残值。
      win.set_top(0);
    }
  }

  /// Whether the coroutine is suspended by an interrupt (`lua_break`), i.e. its
  /// whole register window is live and it continues from the break point on the
  /// next resume.
  #[cfg(feature = "async")]
  fn is_interrupt_suspended(&self) -> bool {
    let lua = self.lua();
    // `status` 是 safe 只读门面（`co` 由本句柄的注册表引用锚定存活，`'lua` 编码）。
    CoWindow::new(&lua, self.thread_state).status() == LuaStatus::Break as i32
  }

  /// The thread's status. Mirrors `mlua::Thread::status`.
  pub fn status(&self) -> ThreadStatus {
    let lua = self.lua();
    let win = CoWindow::new(&lua, self.thread_state);
    // A thread whose state is the currently-running state is "Running".
    if eq(win.co_state().as_ptr(), win.parent_state().as_ptr()) {
      return ThreadStatus::Running;
    }
    // `parent`、`co` 都是存活的 `LuaState`——前者由 lua 的 `XRc<LuaInner>` 持有，
    // 后者由 self 的注册表引用锚定（thread 值可达则其协程对象不被 GC，内嵌状态指针
    // 不悬垂，`Thread::from_ref` 构造期即如此接线）。`CoWindow` 的 status/costatus/top
    // 均为 safe 只读门面：不压弹栈、不触发 GC、不抛 Lua 错误；同 VM 满足 costatus 要求。
    // A coroutine yielded by an interrupt (`lua_break`) has raw status
    // `LUA_BREAK`; `lua_costatus` reports that as "normal", but the
    // coroutine is in fact resumable (it continues from the break point
    // on the next resume). Detect it directly.
    if win.status() == LuaStatus::Break as i32 {
      return ThreadStatus::Resumable;
    }
    // 协程状态真相在 `LuaCoStatus`；未知码退回 lua_status 判定
    match LuaCoStatus::from_c_int(win.costatus()) {
      Some(LuaCoStatus::CoSus) => ThreadStatus::Resumable,
      Some(LuaCoStatus::CoRun) => ThreadStatus::Running,
      Some(LuaCoStatus::CoNor) => ThreadStatus::Normal,
      Some(LuaCoStatus::CoFin) => ThreadStatus::Finished,
      Some(LuaCoStatus::CoErr) => ThreadStatus::Error,
      _ => {
        // Fall back to lua_status for any unexpected code.
        let s = win.status();
        if s == LuaStatus::Yield as i32 {
          ThreadStatus::Resumable
        } else if s == LuaStatus::Ok as i32 {
          // New (function on stack) vs finished (empty stack).
          if win.top() > 0 {
            ThreadStatus::Resumable
          } else {
            ThreadStatus::Finished
          }
        } else {
          ThreadStatus::Error
        }
      }
    }
  }

  /// Whether the thread can be resumed. Mirrors `mlua::Thread::is_resumable`.
  pub fn is_resumable(&self) -> bool {
    self.status() == ThreadStatus::Resumable
  }

  /// Whether the thread is currently running. Mirrors `mlua::Thread::is_running`.
  pub fn is_running(&self) -> bool {
    self.status() == ThreadStatus::Running
  }

  /// Whether the thread is active but not running. Mirrors
  /// `mlua::Thread::is_normal`.
  pub fn is_normal(&self) -> bool {
    self.status() == ThreadStatus::Normal
  }

  /// Whether the thread has finished executing. Mirrors
  /// `mlua::Thread::is_finished`.
  pub fn is_finished(&self) -> bool {
    self.status() == ThreadStatus::Finished
  }

  /// Whether the thread raised an error. Mirrors `mlua::Thread::is_error`.
  pub fn is_error(&self) -> bool {
    self.status() == ThreadStatus::Error
  }

  /// Reset the thread to a fresh state and install `func` as its body.
  /// Mirrors `mlua::Thread::reset` (Luau semantics: any non-running thread can
  /// be reset).
  pub fn reset(&self, func: Function) -> Result<()> {
    match self.status() {
      ThreadStatus::Running => {
        return Err(Error::runtime("cannot reset a running thread"));
      }
      ThreadStatus::Normal => {
        return Err(Error::runtime("cannot reset a normal thread"));
      }
      _ => {}
    }
    let lua = self.lua();
    let win = CoWindow::new(&lua, self.thread_state);
    // 逐步 push/xmove：parent 栈峰值 1 层（函数/全局表各压一次随即 xmove 到 co）。
    ensure_stack(win.parent_state(), 1)?;
    // 每步 parent 峰值 1 层、净变化为零（紧邻的 `ensure_stack(parent, 1)` 即该余量），
    // 重置后的新函数体最终留在 co 栈上使线程可 resume。
    //
    // `reset_thread`/`xmove_from_parent`/`push_parent_globals`/`replace_co_globals` 是带
    // 调用序契约的安全门面：入口已挡 Running/Normal（co 处于挂起/完成/错误态，reset 合法），
    // co 由本句柄的注册表引用锚定存活；每步搬运量 1 均在预留内，栈顶恰为待搬/待落的值。
    win.reset_thread();
    // Push the new body function onto the coroutine stack.
    // `func.push_to_stack()` 是 safe 封装（`lua_rawgeti` 自带栈预留）；owning VM 与
    // 本 VM 一致由 move-not-share 句柄纪律保证，`XRc<LuaInner>` 保活。
    func.push_to_stack();
    win.xmove_from_parent(1);
    // Re-inherit the *main* globals table into the coroutine, dropping
    // any sandbox proxy global a prior `Thread::sandbox` had installed
    // (matches mlua's Luau `reset`: a reset thread sees the main env).
    win.push_parent_globals();
    win.xmove_from_parent(1);
    win.replace_co_globals();
    Ok(())
  }

  /// A raw pointer identifying this thread. Mirrors `mlua::Thread::to_pointer`.
  pub fn to_pointer(&self) -> *const c_void {
    self.reference.to_pointer()
  }
}

impl RegHandle for Thread {
  fn reference(&self) -> &XRc<LuaRef> {
    &self.reference
  }
}

impl Debug for Thread {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "Thread")
  }
}

// ---------------------------------------------------------------------------
// Async: drive a coroutine as a Rust `Future` / `Stream` (the `async` feature)
// ---------------------------------------------------------------------------

#[cfg(feature = "async")]
impl Thread {
  /// Convert this (resumable) thread into an
  /// [`AsyncThread`](crate::AsyncThread) that implements
  /// [`Future`](std::future::Future) and
  /// [`Stream`](futures_util::stream::Stream).
  ///
  /// Mirrors `mlua::Thread::into_async`. `args` are passed to the coroutine on
  /// its first resume. As a `Future` the thread is driven to completion and
  /// resolves to its final return value(s); as a `Stream` each
  /// `coroutine.yield` produces an item.
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn into_async<R: FromLuaMulti>(self, args: impl IntoLuaMulti) -> Result<AsyncThread<R>> {
    if !self.is_resumable() {
      return Err(Error::CoroutineUnresumable);
    }
    let lua = self.lua();
    let args = args.into_lua_multi(&lua)?;
    Ok(AsyncThread::new(self, args))
  }
}

impl PartialEq for Thread {
  fn eq(&self, other: &Self) -> bool {
    self.to_pointer() == other.to_pointer()
  }
}

impl Lua {
  /// Create a new coroutine from a [`Function`]. Mirrors
  /// `mlua::Lua::create_thread`.
  pub fn create_thread(&self, func: Function) -> Result<Thread> {
    let state = self.state();
    // 逐步 push/pop：parent 栈峰值 1 层（新线程值 / 函数体各压一次随即弹走）。
    ensure_stack(state, 1)?;
    // `spawn_thread` 是 safe 门面：`state` 存活（self 的 `XRc<LuaInner>`）且刚预留 1 层，
    // 新线程值压入有头寸；返回 null 即分配失败，`// Safety`（含判空哨兵经 `NonNull` 归一为
    // `None`）收在其函数头一处。
    let Some(co) = spawn_thread(state) else {
      return Err(Error::runtime("ulua-rt: failed to create thread"));
    };
    // 非空时线程值正压 `state` 栈顶；`pop_ref` 是带契约的 safe 门面——弹层并在注册表
    // 登记引用，引用可达则线程对象不被 GC，其内嵌 `LuaState`（`co`）在 Thread 全程存活。
    let thread = Thread::from_ref(self.pop_ref());
    // Move the body function onto the coroutine's stack so the first
    // resume invokes it.
    // `func.push_to_stack()` 是 safe 封装（`lua_rawgeti` 自带栈预留）；owning VM
    // 一致性由 move-not-share 的句柄纪律保证（无运行时校验——见批次报告）。
    func.push_to_stack(); // pushes onto parent stack
    // `move_slots(state, co, 1)` 是 safe 搬运门面：两侧同 VM（co 是刚创建的空栈新协程，
    // 非空已由 `NonNull` 确认），写入一层即函数体，无越界或覆盖，`// Safety` 收在函数头一处。
    // `co` 已是 `NonNull`，经 safe 收口 `from_handle` 取视图（纯指针拷贝，无 `unsafe`）：
    // co 与 state 是同 VM 的不同对象（刚 spawn 的空栈协程），视图只在本次搬运内。
    move_slots(state, StateView::from_handle(co), 1);
    Ok(thread)
  }

  /// The currently-running thread. Mirrors `mlua::Lua::current_thread`.
  ///
  /// Inside a Rust callback this is the coroutine (or main thread) that
  /// invoked it. Under the `async` feature, a coroutine created implicitly by
  /// `call_async` is transparent: this returns its *owner* thread instead, so
  /// `current_thread()` is stable across the implicit-coroutine boundary
  /// (matching mlua).
  pub fn current_thread(&self) -> Thread {
    let state = self.state();
    // 预留当前线程值落到 `state` 上的一层（xmove 目标 / pushthread + from_ref）。
    ensure_stack_or_panic(state, 1);
    // If we are running on an implicit `call_async` coroutine, report the
    // owner thread that issued the call.
    #[cfg(feature = "async")]
    if let Some(owner) = implicit_thread_owner(state) {
      // owner 是 per-VM 表登记的存活协程 state(创建点登记、随其驱动方存活),
      // 非空由 `NonNull` 表达。经 safe 收口 `from_handle` 取视图（纯指针拷贝，无
      // `unsafe`），VM 自引用图的既定驱动契约见 [`StateView`]；视图只在本分支内。
      let owner_state = StateView::from_handle(owner);
      // `push_own_thread(owner)` + `move_slots` 是 safe 门面，同存活 VM 的 `// Safety`
      // 各收在其函数头一处：上方 `ensure_stack_or_panic` 已为落到 state 的一层预留头寸；
      // `push_own_thread` 净压 owner 自身线程值一层，`move` 把该层搬到 state
      // （owner==state 时为同对象搬运，此处显式跳过）。
      push_own_thread(owner_state);
      // The owner-thread value is on the owner's stack; move it to this
      // state so we can take a ref to it from here.
      if !eq(owner_state.as_ptr(), state.as_ptr()) {
        move_slots(owner_state, state, 1);
      }
      // `pop_ref`（safe 门面）弹走压入/搬入的线程值并登记注册表引用，净栈变化为零。
      return Thread::from_ref(self.pop_ref());
    }
    // `push_own_thread` 是 safe 门面：`state` 存活（self 的 `XRc<LuaInner>`），紧邻上方
    // `ensure_stack_or_panic(state, 1)` 已为压入预留 1 层（预留失败按 panic 语义收敛，
    // 不发生越栈写）；对任意运行中的 state 把其自身线程值压到该栈顶，`// Safety` 收在函数头一处。
    push_own_thread(state);
    // `pop_ref` 弹走这一层并在注册表登记引用，净栈变化为零，引用可达期间
    // 线程对象不被 GC。
    Thread::from_ref(self.pop_ref())
  }
}
