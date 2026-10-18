//! [`Lua::exec_raw`] and [`Lua::create_c_function`] — escape hatches to the raw
//! ulua stack machine. Mirror `mlua::Lua::exec_raw` / `create_c_function`.
//!
//! `exec_raw` runs a user closure that manipulates the raw stack **inside a
//! protected call**, so a `lua_error` raised by the closure (which ulua
//! implements as a `panic_any(lua_exception)`) is caught by the VM's own
//! `lua_pcall` and surfaced as an [`Error`], exactly like a normal Lua error.
//! Unlike the [`create_function`](crate::Lua::create_function) trampoline, the
//! `exec_raw` trampoline deliberately does **not** `catch_unwind`: the whole
//! point is to let the VM's protected-call machinery handle the unwind.

use core::ptr::drop_in_place;
use std::cell::Cell;

use crate::{
  error::{Error, Result},
  function::Function,
  multi::MultiValue,
  state::{Lua, StateView, ensure_stack, push_named_closure, run_pcall, stack_top},
  sys::*,
  traits::{FromLuaMulti, IntoLuaMulti},
  userdata::{alloc_userdata_slot, init_userdata_slot, typed_userdata},
};

/// `exec_raw_trampoline` 闭包的调试名：静态 NUL 结尾字节串，交给 `lua_pushcclosurek`
/// 的 `*const c_char` 收口点（VM 压栈时 intern 复制；收口垫片按 NUL 扫描读取，
/// 结尾 `\0` 不可省）。
const EXEC_RAW_NAME: &[u8] = b"ulua-rt-exec-raw\0";
/// `create_c_function` 闭包的调试名：同上，静态 NUL 结尾字节串。
const C_FUNCTION_NAME: &[u8] = b"ulua-rt-c-function\0";

/// The raw closure slot stored in the `exec_raw` trampoline's upvalue userdata.
/// `FnMut`-once: the trampoline takes it out and runs it exactly once.
///
/// 闭包按其**具体类型 `F`** 装箱存槽（与 `callback.rs` 的 `CallbackSlot` 同型，
/// 无 `dyn` 胖指针、无 vtable 间接调用），trampoline 随 `F` 单态化。
///
/// 闭包必须是 `'static`：这样 [`Lua::exec_raw`] 直接把它装箱存进 upvalue，
/// **没有任何 lifetime 擦除**。缘由见 [`Lua::exec_raw`] 的说明——若允许
/// 借用栈帧的闭包（`F: 'a`），一旦 `lua_pcall` 在跑 trampoline 之前失败（如内存
/// 上限触发），槽里的 box 会由 GC 经 [`raw_fn_dtor::<F>`] 在任意晚于本函数返回的
/// 时刻释放，从而析构已死栈帧上的捕获。要求 `'static` 从根上消除这一逃逸面。
struct RawFnSlot<F> {
  slot: Cell<Option<Box<F>>>,
}

/// Destructor: drop the (possibly already-taken) closure box. Monomorphized
/// over the same `F` the slot was written with.
///
/// # Safety
/// 仅由 VM 作为 `lua_newuserdatadtor` 注册的终结器调用：`ptr` 必须为 null，或
/// 指向 `exec_raw::<F>` 按同一 `F` 单态化布局写入的 userdata 载荷；VM 保证其恰
/// 被调用一次。
unsafe extern "C-unwind" fn raw_fn_dtor<F>(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: `ptr` 由 `lua_newuserdatadtor` 的载荷区提供——`Udata` 以
    // `_align: [u64; 0]` 保证数据区 ≥8 字节对齐（覆盖 `Cell<Option<Box<F>>>`
    // 的 align 要求），长度恰为 `size_of::<RawFnSlot<F>>()`（与注册本析构器的
    // `exec_raw::<F>` 同一单态化）。`F: 'static` 使槽不借外部生命周期，GC 任意
    // 时刻回调也指向存活内存；槽内 `Box` 至多被 trampoline `take` 一次，
    // `drop_in_place` 对已取走的 `None` 槽亦只析构 Cell 本身，无双释放。
    // null 已在入口判掉，满足 `drop_in_place` 的非空要求。
    unsafe { drop_in_place(ptr.cast::<RawFnSlot<F>>()) };
  }
}

/// The trampoline for `exec_raw`: recover the boxed closure from upvalue 1 and
/// run it on the calling state. Does NOT `catch_unwind` — a `lua_error` from the
/// closure must propagate to the enclosing `lua_pcall`.
///
/// # Safety
/// 仅由 VM 作为 `lua_CFunction` 在受保护边界内调用：`state` 存活且正由当前线程
/// 驱动，upvalue 1 是 `exec_raw::<F>` 注册的 `RawFnSlot<F>` userdata（同一 `F`
/// 单态化，创建方保证恰有 1 个 upvalue）。
unsafe extern "C-unwind" fn exec_raw_trampoline<F>(raw: *mut LuaState) -> i32
where
  F: FnOnce(*mut LuaState),
{
  // Safety: C-ABI 边界点(`lua_CFunction` 实参):VM 实时传入存活 state,本帧
  // 一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // `typed_userdata`（userdata.rs 的类型化下转 safe 门面）：闸门（userdata 类型 /
  // 载荷非空 / 长度覆盖 `RawFnSlot<F>`）与 `cast`/`as_ref` 边界全收口在其函数体
  // 一处。解读的布局即写入布局——同一 `F` 单态化配对、脚本不可替换该 upvalue；
  // 块内只读、无并存别名（该 userdata 只被这一个 closure 持有）。
  let slot: Option<&RawFnSlot<F>> = typed_userdata::<RawFnSlot<F>>(state, lua_upvalueindex(1));
  let Some(slot) = slot else {
    // 缺 upvalue 槽（创建方契约下不可能）：不跑闭包，报告 0 个结果。
    return 0;
  };
  // 槽位取还回裸指针→借用只存在于本行；`Cell::take` 是纯 Rust 安全操作。
  let f = slot.slot.take();
  // `stack_top` 是带契约的 safe 门面：只读当前栈深（`state` 存活）。
  let base = stack_top(state);
  // `f(raw)` 的栈操作合法性由 `exec_raw` 的 `unsafe fn` 契约约束（调用方闭包
  // 自负栈一致）；取出的 `Box` 在本帧末 drop，捕获随栈帧回收。闭包契约形参即
  // 裸指针(公开 FFI 形态),此处经 `as_mut_ptr` 还原。
  if let Some(f) = f {
    f(raw);
  }
  // `stack_top`（safe 门面）只读栈深。
  let top = stack_top(state);
  // Everything the closure left above the stack base is a result.
  (top - base).max(0)
}

impl Lua {
  /// Run a closure that manipulates the raw ulua stack, under a protected
  /// call. Mirrors `mlua::Lua::exec_raw`.
  ///
  /// `args` are pushed first (as the function arguments); then `f` runs with
  /// the raw `*mut LuaState`, pushing any results it wants returned. A
  /// `lua_error` raised inside `f` is caught and returned as an [`Error`].
  ///
  /// # Safety
  /// `f` operates on the raw stack with no safety net beyond the protected
  /// call; it must leave the stack in a consistent state (push results, not
  /// underflow). This mirrors `mlua::Lua::exec_raw`'s `unsafe` contract.
  ///
  /// `f` 必须是 `'static`：闭包会被存进 upvalue userdata，其释放时机由 VM 的 GC
  /// 决定，可能晚于本函数返回（`lua_pcall` 在跑 trampoline 前失败时）。若允许借用
  /// 栈帧数据的非 `'static` 闭包，那条路径上就会析构已失效的捕获。要求 `'static`
  /// 后无需任何 lifetime 擦除，从根上封死这一逃逸。
  pub unsafe fn exec_raw<R, F>(&self, args: impl IntoLuaMulti, f: F) -> Result<R>
  where
    R: FromLuaMulti,
    F: FnOnce(*mut LuaState) + 'static,
  {
    // Safety: 本函数体内各 C-API 步的契约在对应调用点注释逐处闭合；`f` 的调用
    // 运行在 `lua_pcall` 保护帧内（见下方 pcall 处的 Safety 注释），栈不一致时
    // 以 VM 错误收敛而非 Rust panic。
    let state = self.state();
    let args: MultiValue = args.into_lua_multi(self)?;
    let nargs = args.len() as i32;
    // `ensure_stack`（safe fn，只报告头寸）先保证 nargs+2 个空位，其后 push
    // 序列（userdata、closure、args）在容量内。
    ensure_stack(state, nargs.saturating_add(2))?;
    // `F: 'static`，直接按具体类型装箱进槽位——无 dyn、无 lifetime 擦除。
    // 先装箱再分配：`Box::new` 若发生在分配之后，其潜在的分配失败会留下「已注册
    // dtor 但槽位未初始化」的窗口（review.md §2 所有权显式转手）。
    let boxed = Some(Box::new(f));
    // `state` 存活且上一步已预留头寸；`raw_fn_dtor::<F>` 与载荷
    // `RawFnSlot<F>` 同一 `F` 单态化。返回 `None` 即分配失败（`lua_newuserdatadtor`
    // 的 null 经 `NonNull::new` 归一），转错误返回。
    let slot = alloc_userdata_slot::<RawFnSlot<F>>(state, raw_fn_dtor::<F>);
    let Some(slot) = slot else {
      // 未写槽，`boxed` 在本帧正常 drop——一次性所有权，无双放。
      return Err(Error::runtime(
        "exec_raw: failed to allocate closure userdata",
      ));
    };
    // `init_userdata_slot`（userdata.rs 的 `ptr::write` 全 crate 收口点）：非空、恰
    // `size_of::<RawFnSlot<F>>()`（`Cell<Option<Box<F>>>` 是薄盒指针，`AlignOk`
    // 编译期闸门）、未初始化的载荷；首次写入即所有权移交该 userdata，Box 的 drop
    // 责任随之移交同 `F` 单态化的 `raw_fn_dtor`。
    init_userdata_slot(
      slot,
      RawFnSlot {
        slot: Cell::new(boxed),
      },
    );
    // `push_named_closure`（state.rs safe 门面族，`lua_pushcclosurek` 收口点）：
    // `nup=1` 消费栈顶刚写入的 slot userdata 作 upvalue 1，绑定的
    // `exec_raw_trampoline::<F>` 与载荷同一 `F` 单态化；`EXEC_RAW_NAME` 是
    // `'static` NUL 结尾字节串（消费侧按 NUL 扫描读取）。
    push_named_closure(state, Some(exec_raw_trampoline::<F>), EXEC_RAW_NAME, 1);
    // Push the arguments after the function, then protected-call.
    // `stack_top`（safe 门面）只读栈深；`base` 是压入参数前记录的真实栈深
    // （函数值在 base 槽）。
    let base = stack_top(state) - 1; // index just below the function
    for v in &args {
      self.push_value(v)?;
    }
    // `run_pcall`（state.rs safe 门面族，`lua_pcall` 收口点）：`state` 存活且栈
    // 布局为 [.., func, args..]；`nargs` 与实际压入的 args 数一致（同一次迭代），
    // -1 即 LUA_MULTRET。`lua_pcall` 在受保护帧内执行：trampoline 不 catch_unwind
    // 是有意的，`lua_error` panic 由这层受保护调用接住（见模块文档），错误对象
    // 留在栈顶正是 `pop_error` 的前提。
    let status = run_pcall(state, nargs, -1, 0);
    if status != 0 {
      return Err(self.pop_error(status));
    }
    // Collect results left above `base`; the multi-ret 复制头寸检查由
    // `collect_results_above` 统一负责（同 `function.rs::call`）。
    let results = self.collect_results_above(base)?;
    R::from_lua_multi(results, self)
  }

  /// Wrap a raw ulua `lua_CFunction` as a [`Function`]. Mirrors
  /// `mlua::Lua::create_c_function`.
  ///
  /// **DEVIATION:** ulua is a pure-Rust VM — the `lua_*` entry points are
  /// ordinary Rust `pub unsafe fn`s, not C ABI imports — so only the callback
  /// pointer type keeps an `extern "C-unwind"` signature (VM parity with mlua).
  /// The function value is otherwise identical; callers pass a ulua-shaped
  /// `unsafe fn` (see [`api::LuaCFunction`](crate::api::LuaCFunction)).
  ///
  /// # Safety
  /// The supplied function runs with raw access to the `LuaState`; it must
  /// honor the ulua calling convention (consume its arguments, push its
  /// results, return the result count). Mirrors mlua's `unsafe` contract.
  pub unsafe fn create_c_function(&self, func: LuaCFunction) -> Result<Function> {
    let state = self.state();
    // `push_named_closure`（state.rs safe 门面族，`lua_pushcclosurek` 收口点）：
    // `state` 存活；`func` 的合法性（遵守 ulua 调用约定）由本 `unsafe fn` 契约
    // 交给调用方（见其 `# Safety` 段），此处仅把它原样交给门面；`C_FUNCTION_NAME`
    // 为 `'static` NUL 结尾字节串、nupvalue=0 与栈上无 upvalue 一致。该调用总把
    // 一个函数压到栈顶，`pop_ref` 随即消费这唯一栈槽取注册引用，索引有效。
    push_named_closure(state, func, C_FUNCTION_NAME, 0);
    // `pop_ref`（safe fn）消费上一步压到栈顶的唯一函数值并登记注册表引用。
    Ok(Function::from_ref(self.pop_ref()))
  }
}
