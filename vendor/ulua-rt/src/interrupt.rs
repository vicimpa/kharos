//! Luau interrupt support. Mirrors `mlua::Lua::set_interrupt` / `VmState`.
//!
//! Luau's VM calls a single global `interrupt` callback at safepoints (loop
//! back-edges, calls/returns, GC). mlua exposes this as `Lua::set_interrupt`,
//! taking a Rust closure that returns a [`VmState`] telling the VM whether to
//! continue or to **yield** the current coroutine.
//!
//! ulua's `lua_callbacks().interrupt` is a plain C function pointer, so we
//! install a fixed trampoline ([`interrupt_trampoline`]) and keep the Rust
//! closure in the crate-wide per-VM table (see [`crate::vm_store`]) keyed by the
//! VM's *global* pointer (shared by all threads of one `Lua`). The trampoline
//! looks up the closure, runs it with a borrowed [`Lua`], and:
//!
//! * `Ok(VmState::Continue)`  — returns normally; the VM keeps executing.
//! * `Ok(VmState::Yield)`     — calls `lua_break`, which sets the running
//!   thread's status so the VM unwinds back to `lua_resume` (a *yield* at a
//!   yieldable point; ignored otherwise, exactly like upstream Luau).
//! * `Err(e)`                 — raises `e` as a Lua error via `lua_error`.

use std::{
  borrow::Cow,
  cell::Cell,
  panic::{AssertUnwindSafe, catch_unwind},
};

use ulua_vm::functions::lua_break::lua_break;

use crate::{
  callback::{panic_error_message, raise_lua_error},
  error::{Error, Result},
  state::{Lua, StateView, is_yieldable, raw_reserve_stack},
  sync::MaybeSend,
  sys::*,
  vm_store::{VmKey, define_vm_store, vm_key},
};

/// The action an interrupt callback asks the VM to take. Mirrors
/// `mlua::VmState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmState {
  /// Keep executing.
  Continue,
  /// Yield the currently running coroutine (no-op at a non-yieldable point).
  Yield,
}

/// The type-erased interrupt closure stored per-VM (clippy type_complexity
/// 认为内联过长，保留别名).
///
/// DELIBERATE DEVIATION（保留 `dyn`）：与 `callback.rs` 的同步回调不同，interrupt
/// 是**每 VM 一枚**的可替换槽位（[`Lua::set_interrupt`] 可随时换掉，故无法按闭包
/// 具体类型单态化），只能以 `dyn` 形式存进 per-VM 表。调用点证据：公开 API
/// [`Lua::set_interrupt`] 对 `F: Fn(&Lua) -> Result<VmState> + 'static` 泛型收口，
/// 任意宿主闭包（各 `set_interrupt(move |_| …)` 单态化出不同 `F`）汇入同一
/// [`InterruptStore`] 槽位——种类运行期开放，非有限集合可枚举。
///
/// 路径热度评估：未安装 interrupt 时槽位为空、trampoline 查表即返回，虚分派
/// 零成本；安装后每个 VM safepoint（循环回边/调用返回/GC 步进）经此一次 vtable
/// 间接调用——这是「运行期可替换 + 类型集合开放」槽位的最小不可省开销，且仅对
/// 主动安装 interrupt 的宿主生效（opt-in 超时/取消机制），有别于全量回调热路径。
///
/// Under `send` the boxed closure is `Send`: the closure is installed through
/// [`Lua::set_interrupt`], which already requires [`MaybeSend`], and the per-VM
/// table holding it is process-wide under that feature (see [`crate::vm_store`]).
#[cfg(feature = "send")]
type InterruptFn = Box<dyn Fn(&Lua) -> Result<VmState> + Send>;

/// See the `send`-gated variant above（`dyn` 保留理由同该注，此处仅差 `Send` 界）。
#[cfg(not(feature = "send"))]
type InterruptFn = Box<dyn Fn(&Lua) -> Result<VmState>>;

define_vm_store! {
  /// Per-VM interrupt closure, keyed by the `global_State` pointer (stable for
  /// the lifetime of the VM and shared by all of its threads).
  InterruptStore, InterruptFn
}

thread_local! {
    /// `set_interrupt` / `remove_interrupt` 的累计变更次数。trampoline 用它
    /// 检测"用户回调内部改动了 interrupt"（含 remove），从而决定是否把取出的
    /// 闭包放回槽位。
    ///
    /// 与 [`InterruptStore`] 不同，这个计数器**必须**留在 thread-local：它只在
    /// 单次 safepoint 内被读—改—比较，全程发生在驱动 VM 的那个线程上，跨 VM 移动
    /// 也不影响其正确性（下标只与同一次 trampoline 调用里的读数比较）。
    static INTERRUPT_REVISION: Cell<usize> = const { Cell::new(0) };
}

/// 记一次 interrupt 槽位的外部变更（install / remove）。
#[inline]
fn bump_revision() {
  INTERRUPT_REVISION.with(|r| r.set(r.get() + 1));
}

/// 若自 `revision` 读数后无人改动本 VM 的 interrupt 槽位（既没 `set_interrupt`
/// 换掉、也没 `remove_interrupt` 摘掉），就把 safepoint 期间取出的闭包 `cb`
/// 放回槽内；否则尊重那次变更、丢弃 `cb`。trampoline 的 panic 分支与正常分支
/// 共用此收口（原两处 `if … == revision { insert }` 逐字同形）。
#[inline]
fn restore_if_untouched(key: VmKey, cb: InterruptFn, revision: usize) {
  if INTERRUPT_REVISION.with(Cell::get) == revision {
    InterruptStore::with(|m| {
      m.insert(key, cb);
    });
  }
}

/// `lua_callbacks().interrupt` 槽的类型（VM 回调函数指针，安装 [`interrupt_trampoline`]
/// 或 `None` 摘除）。
type InterruptHook = Option<unsafe extern "C-unwind" fn(state: *mut LuaState, gc: i32)>;

/// 写/清本 VM 的 interrupt 钩子槽（`&mut *lua_callbacks(state)` 的唯一收口点）。
///
/// 调用序契约（正确性，非内存安全）：state 正由当前线程驱动（`&self` 的
/// `XRc<LuaInner>` 保证），`global` 构造期接线非空。`install`/`remove` 分别传
/// `Some(interrupt_trampoline)` / `None`；表项先于钩子就位（调用方维持）。
#[inline]
fn set_interrupt_hook(state: StateView<'_>, hook: InterruptHook) {
  // Safety: `lua_callbacks(state)` 返回 `&mut global_State.cb`——`global` 非空且比
  // 持有者长寿，字段内嵌于 `global_State`，地址稳定。写 `interrupt` 槽与读它的
  // safepoint 都发生在当前驱动 VM 的线程上（`send` 契约为移动而非并发），无并发写。
  unsafe { (*lua_callbacks(state.as_mut_ptr())).interrupt = hook };
}

/// 请求在当前可让出点让出协程（`lua_break` 收口点）。
///
/// 调用序契约：仅由 [`interrupt_trampoline`] 在 [`is_yieldable`] 为真后调用——越过非
/// 让出点本会 raise「attempt to break across metamethod/C-call boundary」，该错误已被
/// 调用侧的让出闸门挡下。
fn break_thread(state: StateView<'_>) {
  // Safety: `state` 为 safepoint 上正在执行的线程（VM 回调参数），且调用侧已确认可
  // 让出点；`lua_break` 只在该点设状态标记令 VM 展开回 `lua_resume`，不触指针。
  let _ = unsafe { lua_break(state.as_mut_ptr()) };
}

impl Lua {
  /// Install an interrupt callback. Mirrors `mlua::Lua::set_interrupt`.
  ///
  /// The callback runs at VM safepoints; returning [`VmState::Yield`] yields the
  /// running coroutine, and returning `Err` raises a Lua error.
  pub fn set_interrupt<F>(&self, callback: F)
  where
    F: Fn(&Lua) -> Result<VmState> + MaybeSend + 'static,
  {
    let state = self.state();
    // `state` 引用即「存活且由当前线程驱动」(见 [`Lua::state`] 契约),`global`
    // 构造期接线非空——满足 `vm_key`(safe 门面)的前提。
    let key = vm_key(state);
    InterruptStore::with(|m| {
      m.insert(key, Box::new(callback));
    });
    bump_revision();
    // `set_interrupt_hook` 是带调用序契约的 safe 门面（`&mut *lua_callbacks` 收口点）：
    // 表项先于钩子就位（上方 insert），装 `Some(interrupt_trampoline)`。
    set_interrupt_hook(state, Some(interrupt_trampoline));
  }

  /// Remove a previously installed interrupt callback. Mirrors
  /// `mlua::Lua::remove_interrupt`.
  pub fn remove_interrupt(&self) {
    let state = self.state();
    // 前提同 `set_interrupt`。
    let key = vm_key(state);
    InterruptStore::with(|m| {
      m.remove(&key);
    });
    bump_revision();
    // `set_interrupt_hook` 同上：先摘闭包再置 `None`，反序也安全（trampoline 对表
    // 缺失直接 return），只写字段为 fn 指针槽。
    set_interrupt_hook(state, None);
  }
}

/// Drop this VM's interrupt closure. Called from `LuaInner::drop` so the closure
/// (and anything it captured) is released and the per-VM map entry does not leak
/// one slot per state created. (If a closure captured Lua handles it would pin
/// the VM and this never runs — but the common case captures non-Lua state.)
pub(crate) fn clear_interrupt(key: VmKey) {
  // 唯一调用点是 `LuaInner::drop` 中 `lua_close` **之前**的 clear 序列,key 已在
  // 彼处由存活 state 算出。
  let _ = InterruptStore::try_with(|m| {
    m.remove(&key);
  });
}

/// The fixed C trampoline installed as `lua_callbacks().interrupt`.
///
/// `gc` is non-negative only for GC interrupts; mlua ignores GC interrupts in
/// the user callback path, and so do we (return immediately) so the user
/// closure only sees real instruction safepoints.
///
/// # Safety
/// 仅由 VM 在 safepoint 回调：`state` 存活且正由当前线程驱动，其 `global` 即本
/// VM 的 `vm_key`；安装/摘除 trampoline 与查表都走同一 key，表项生命周期由
/// `InterruptStore` 同 per-VM 表保证。
unsafe extern "C-unwind" fn interrupt_trampoline(raw: *mut LuaState, gc: i32) {
  if gc >= 0 {
    // GC step interrupt — not surfaced to the user callback.
    return;
  }
  // Safety: C-ABI 边界点(safepoint 回调实参):VM 实时传入存活且正由当前线程
  // 驱动的 state;本帧一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // 其 `global` 即本 VM 的表 key,满足 `vm_key` 的前提;trampoline 装表与摘表
  // （`remove_interrupt`/`clear_interrupt`）同 key。
  let key = vm_key(state);
  // Take the closure out of the map for the duration of the call so a
  // re-entrant `set_interrupt` from inside the callback can't alias the
  // borrow. The revision counter tells us afterwards whether the callback
  // itself installed a new one or removed it (both must win over the taken
  // closure — a `remove_interrupt` inside the callback must stay removed).
  let revision = INTERRUPT_REVISION.with(Cell::get);
  let cb = InterruptStore::with(|m| m.remove(&key));
  let Some(cb) = cb else { return };

  // `from_borrowed` 现为带契约的安全封装（契约见 state.rs 文档，形参收口为
  // [`StateView`]）：`state` 在本次调用全程存活（VM 正驱动到 safepoint），覆盖
  // 返回句柄及其克隆——借用语义（`owned:false`）保证该句柄 drop 时不会关 VM；
  // 与 `callback.rs` trampoline 同纪律：闭包不得把克隆出的句柄寄存到超出本次回调。
  let lua = Lua::from_borrowed(state);
  // The callback is user code: a panic must not unwind through the VM's
  // frames (it would corrupt the interpreter state mid-safepoint). Convert it
  // into a catchable Lua error instead, like the callback trampoline does.
  let result = catch_unwind(AssertUnwindSafe(|| cb(&lua)));

  let outcome = match result {
    Ok(r) => r,
    Err(payload) => {
      // Surface the panic as a catchable Lua error. mlua 语义：回调 panic 后
      // 中断回调保持安装——先按 revision 把取出的闭包放回槽内再 diverge，
      // 否则 cb.interrupt trampoline 仍挂着而槽内无闭包，后续 safepoint
      // 会静默 no-op（中断被永久禁用）。
      restore_if_untouched(key, cb, revision);
      // `raise_error` 现为带调用序契约的 safe 门面：此刻正处 interrupt trampoline 的
      // C 边界 safepoint——其契约要求的「可吸收 lua_error 展开的执行点」；panic 已被
      // `catch_unwind` 拦下，展开从此刻重新以 Lua 错误形式走受保护路径。取出的闭包有意
      // 留在槽外（错误后 VM 不再回到本 safepoint 序列的恢复代码，`raise_error` diverges）。
      raise_error(state, &Error::runtime(panic_error_message(&*payload)));
    }
  };

  // Restore the taken closure only if the callback left the slot untouched.
  restore_if_untouched(key, cb, revision);

  match outcome {
    Ok(VmState::Continue) => {}
    Ok(VmState::Yield) => {
      // Request a yield — but only at a yieldable point. Inside a
      // metamethod / C-call boundary Luau's `lua_break` would raise
      // "attempt to break across metamethod/C-call boundary"; upstream
      // (and mlua) silently ignore the yield request there, so we gate it
      // on `lua_isyieldable` and otherwise just continue.
      // `is_yieldable` 是带契约的 safe 门面（`lua_isyieldable` 收口点）：`state` 为
      // safepoint 上正在执行的线程（VM 回调参数），查询只读、不触指针、不动栈。
      if is_yieldable(state) {
        // `break_thread` 是带调用序契约的 safe 门面（`lua_break` 收口点）：上一行已
        // 探测到可让出点，越界 raise 已被上面的闸门挡下。
        break_thread(state);
      }
    }
    Err(e) => {
      // Raise the error as a Lua error. Push the message and longjmp.
      // `raise_error` 同 panic 分支——此刻仍在 trampoline 的 C 边界内，是其契约要求的
      // 位置；用户闭包已正常返回 `Err`，无借用悬存，展开经外层受保护调用转成可捕获的
      // Lua 错误。
      raise_error(state, &e)
    }
  }
}

/// Push `e`'s message as a string error object and `lua_error` it (diverges).
/// push + `lua_error` 样板复用 [`raise_lua_error`]。
///
/// 调用序契约（正确性，非内存安全，同 [`raise_lua_error`]）：`state` 必须正处在可
/// 吸收 `lua_error` 展开的执行点（VM 中断/回调的 C 边界内）且由当前线程驱动。
/// 栈空位由本函数经 [`raw_reserve_stack`] 自行预留，调用方无需额外保证。收口的 C
/// 边界（`lua_error` 的 longjmp 展开）在 [`raise_lua_error`]（safe 门面）一处，
/// 故本函数自身是 safe fn、无边界块。
fn raise_error(state: StateView<'_>, e: &Error) -> ! {
  // Use the bare message for a runtime error (so it round-trips back through
  // `pop_error` as `RuntimeError(msg)` without a doubled "runtime error: "
  // prefix); fall back to the full Display for other error kinds.
  let msg: Cow<'_, str> = match e {
    Error::RuntimeError(m) => Cow::Borrowed(m.as_str()),
    other => Cow::Owned(other.to_string()),
  };
  // The interrupt fires at an arbitrary VM safepoint where `l->top` may be
  // flush against the call-info top; `raw_reserve_stack`（带契约 safe 门面，
  // `lua_rawcheckstack` 收口点）先留出这一层，使随后 `raise_lua_error` 内
  // `push_bytes` 的 `api_incr_top` 栈不变式成立。
  raw_reserve_stack(state, 1);
  // `raise_lua_error` 是带契约的 safe 门面：`msg` 为存活 `Cow<str>` 的字节切片
  // （len 可为 0，指针仍有效；push 前完整拷贝字节），上述让出/错误边界前提即其函数头契约。
  raise_lua_error(state, &msg)
}
