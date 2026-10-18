//! The Rust-closure-as-Lua-function trampoline.
//!
//! ## Design (see also the crate-level docs)
//!
//! A user-supplied Rust closure `F: Fn(&Lua, A) -> Result<R>` is **not** type-
//! erased: [`create_callback_function`] is generic over `(F, A, R)` and the
//! closure is boxed as `Box<F>` and stored (inside an `Option`, see below) in
//! a Lua userdata created with [`lua_newuserdatadtor`] — the (per-`F`)
//! destructor reconstitutes and drops the `Box`, so the closure's captured
//! environment is freed exactly when the GC collects the function. The
//! userdata is then captured as **upvalue 1** of a monomorphized C trampoline
//! function ([`trampoline::<F, A, R>`]) pushed via [`lua_pushcclosurek`] with
//! `nup = 1`. No `dyn` fat pointer, no vtable hop: the call is a direct call
//! on the concrete closure type.
//!
//! When Lua calls the function:
//!  1. The trampoline fetches upvalue 1 with [`lua_upvalueindex`] and recovers
//!     `&Option<Box<F>>` from the userdata pointer.
//!  2. It pops all on-stack arguments into a [`MultiValue`] and converts them
//!     to `A` via [`FromLuaMulti`].
//!  3. It runs the closure **inside [`catch_unwind`]** — so a `panic!` in user
//!     code can never become a nested panic while we are about to call
//!     [`lua_error`].
//!  4. On success it converts the `R` return via [`IntoLuaMulti`], pushes the
//!     results and returns the count.
//!  5. On a returned `Err`, or a caught panic, it pushes a message string and
//!     calls [`lua_error`]. `lua_error` raises the VM's normal longjmp-style
//!     error (a `panic_any(lua_exception)`), which unwinds this trampoline
//!     frame up to the VM's protected-call boundary — the VM's own mechanism.
//!
//! Because the user panic is caught *before* `lua_error` is called, there is
//! never a double-unwind, and a genuine Rust panic in user code surfaces as an
//! ordinary catchable Lua error, not a process abort.
//!
//! ## Why the slot is an `Option`
//!
//! [`Lua::scope`](crate::Scope) callbacks borrow non-`'static` data. Since the
//! trampoline is monomorphized over the concrete `F` (which carries the
//! borrow's lifetime), **no lifetime erasure is needed at all** — the soundness
//! of dropping the closure before its borrowed data dies rests purely on
//! [`destruct_callback::<F>`]: the scope's exit runs it, `take()`ing the box
//! out of the slot (ending the borrows). The slot then reads `None`, and any
//! later call raises a structured [`Error::CallbackDestructed`] — the Lua
//! function object itself stays fully valid, only its behavior changes.

use core::{any::Any, ptr::drop_in_place};
use std::{
  any::TypeId,
  borrow::Cow,
  panic::{AssertUnwindSafe, catch_unwind},
  thread::Result as ThreadResult,
};

use crate::{
  error::{Error, Result},
  function::Function,
  multi::MultiValue,
  registry::RegHandle,
  state::{
    Lua, StateView, ensure_stack, pop_stack, push_bytes, push_named_closure, push_upvalue,
    raise_from_top, stack_top,
  },
  sys::*,
  traits::{FromLuaMulti, IntoLuaMulti},
  userdata::{alloc_userdata_slot, init_userdata_slot, typed_userdata, typed_userdata_mut},
};

// ---------------------------------------------------------------------------
// Structured error objects (for errors that must survive the Lua boundary)
// ---------------------------------------------------------------------------
//
// Most callback errors are raised as plain Lua strings via `lua_error`, and
// `Lua::pop_error` rebuilds a flat `Error::RuntimeError`. That keeps the simple,
// message-only error path that the rest of the crate (and its tests) rely on.
//
// A small set of errors, however, carry *structured* meaning that the caller
// must be able to pattern-match after the error has travelled up through a
// `lua_pcall` boundary — specifically `CallbackDestructed` and
// `UserDataDestructed`, raised when a scope-created callback/userdata is invoked
// after its `Lua::scope` has ended. For those we push a **userdata error
// object** holding a boxed `Error` (tagged with a magic `TypeId` header), call
// `lua_error`, and recover the structured error in `pop_error`, wrapping it in
// `Error::CallbackError { cause, .. }` exactly like mlua.

/// 用户回调 panic 转为 Lua 错误时的消息前缀（callback / async / interrupt
/// 三处的 panic guard 共用）。
pub(crate) const PANIC_MSG_PREFIX: &str = "rust panic: ";

/// The wrapped-error userdata storage: a magic `TypeId` followed by the boxed
/// structured `Error`.
#[repr(C)]
struct WrappedError {
  type_id: TypeId,
  error: Box<Error>,
}

/// A private marker type whose `TypeId` tags our wrapped-error userdata.
struct WrappedErrorTag;

/// The magic tag identifying a ulua-rt wrapped-error userdata.
pub(crate) fn wrapped_error_tag() -> TypeId {
  TypeId::of::<WrappedErrorTag>()
}

/// Destructor for the [`WrappedError`] userdata: drops the boxed `Error`.
///
/// # Safety
/// 仅由 VM 作为 `lua_newuserdatadtor` 注册的终结器调用：`ptr` 必须为 null 或
/// 指向本模块 `raise_structured_error` 按 `WrappedError` 布局写入、且尚未被
/// drop 的 userdata 载荷；VM 保证其恰被调用一次。
unsafe extern "C-unwind" fn wrapped_error_dtor(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: `ptr` 由 VM 在终结该 wrapped-error userdata 时传入，只可能来自
    // `raise_structured_error` 的 `lua_newuserdatadtor(size_of::<WrappedError>(),
    // wrapped_error_dtor)` 配对：载荷长度恰覆盖 `#[repr(C)]` 的
    // `WrappedError`（TypeId + 薄盒指针，载荷 `alignas(8)` 足够），且写入已
    // 在 lua_error 发散前完成；终结器由 VM 保证恰调用一次。
    unsafe { drop_in_place(ptr.cast::<WrappedError>()) };
  }
}

/// Whether the given error should be raised as a *structured* userdata error
/// object (so the caller can match on it) rather than a flat string. Only the
/// scope-destruction errors qualify; everything else keeps the string path to
/// preserve backward-compatible `RuntimeError` behavior.
pub(crate) fn is_structured(err: &Error) -> bool {
  match err {
    Error::CallbackDestructed | Error::UserDataDestructed | Error::RecursiveMutCallback => true,
    // A `CallbackError` produced when a *nested* structured error crossed a
    // `pcall` boundary is itself re-raised structured, so each boundary adds
    // one `CallbackError` wrapper layer — mirroring mlua's nested
    // `CallbackError { cause: CallbackError { cause: .. } }`.
    Error::CallbackError { cause, .. } => is_structured(cause),
    _ => false,
  }
}

/// Push a structured [`Error`] as a wrapped-error userdata error object and
/// invoke [`lua_error`]. Diverges (unwinds via the VM's longjmp).
///
/// 调用序契约（正确性，非内存安全，`raise_lua_error` 同族）：`state` 必须是存活、
/// 正由当前线程在 C 边界（trampoline/hook）内驱动的 `LuaState`，且栈上至少 1 个
/// 空位——`lua_error` 沿 VM 的 longjmp 式展开逃逸本函数，只有站在受保护的 C 调用
/// 内部才可吸收。与 `Lua::from_borrowed` 同范式：契约前移到调用点，本函数是
/// safe 门面，`lua_error` 边界收在 `state::raise_from_top` 一处。
pub(crate) fn raise_structured_error(state: StateView<'_>, err: Error) -> ! {
  // 先构造载荷再分配：`Box::new(err)` 若发生在分配之后，装箱失败（或 panic）会留下
  // 「已注册 dtor 但槽位未初始化」的窗口，GC 稍后对垃圾执行 `drop_in_place`。
  // 提前构造使可失败点全部落在分配之前（review.md §2 所有权显式转手）。
  let payload = WrappedError {
    type_id: wrapped_error_tag(),
    error: Box::new(err),
  };
  // `alloc_userdata_slot`（userdata.rs 的带契约 safe 门面，含 `AlignOk` 编译期
  // 对齐闸门）：`state` 由共用前置给出存活；`wrapped_error_dtor` 与载荷
  // `WrappedError` 同一类型单态化。返回 `None` 即分配失败。
  let Some(storage) = alloc_userdata_slot::<WrappedError>(state, wrapped_error_dtor) else {
    // Fall back to a string error if we cannot allocate the userdata.
    // 未构造 payload 进槽，`payload` 在本帧正常 drop，不存在半初始化读。
    raise_lua_error(state, &payload.error.to_string())
  };
  // `init_userdata_slot`（userdata.rs 的 `ptr::write` 全 crate 收口点）：非空、恰
  // `size_of::<WrappedError>()`、对齐 ≤8（`AlignOk` 编译期断言）的未初始化载荷；
  // 首次写入即所有权移交 userdata——`lua_error` 发散前无任何可失败点，之后由
  // `wrapped_error_dtor` 唯一一次 drop；不存在双重释放或半初始化读。
  init_userdata_slot(storage, payload);
  // `raise_from_top`（state.rs 的 `lua_error` 收口门面）：函数头契约（正于 C 边界内
  // 被当前线程驱动 + 栈顶即刚写入的错误 userdata）由本函数上文逐项满足，沿 VM 的
  // longjmp 式展开逃逸到受保护边界，发散不返回。
  raise_from_top(state) // diverges (`-> !`)
}

/// If the value at stack index `idx` is a ulua-rt wrapped-error userdata,
/// return a clone of the contained [`Error`]. Does not pop.
///
/// 调用序契约（正确性，非内存安全）：`state` 存活且由当前线程驱动、`idx` 为有效
/// （绝对）栈索引。与 `stack_top`/`number_at` 同族的 safe 门面：闸门与下转边界
/// 全收口在 `userdata.rs` 的 [`typed_userdata`]，调用点不再重复 `// Safety` 论证。
pub(crate) fn recover_wrapped_error(state: StateView<'_>, idx: i32) -> Option<Error> {
  // `typed_userdata`（userdata.rs 的类型化下转 safe 门面）内聚三道闸门
  // （userdata 类型/载荷非空/长度覆盖 `WrappedError`，脚本可 `error(newproxy())`
  // 抛出 0 字节载荷，必须先过长度闸门）与唯一的 `cast`/`as_ref` 边界；
  // `type_id` 字段比对垃圾位值只是整数比较，命中魔数标记才读 `error` 盒。
  // 返回克隆出的 owned 值，出函数后无栈/对象依赖。
  let wrapped = typed_userdata::<WrappedError>(state, idx)?;
  // Only our wrapped errors carry the magic tag.
  if wrapped.type_id != wrapped_error_tag() {
    return None;
  }
  Some((*wrapped.error).clone())
}

/// The closure slot stored in the callback userdata: `Some(box)` while live,
/// `None` after [`destruct_callback`] neutralised a scope-created callback.
/// A thin pointer (`Option<Box<F>>` is niche-optimised to one word) — the
/// closure body itself lives on the heap box, so the userdata payload has no
/// alignment requirement beyond the 8 bytes the VM guarantees.
type CallbackSlot<F> = Option<Box<F>>;

/// The destructor installed on the callback userdata: reconstruct the
/// `CallbackSlot<F>` inside the userdata storage and drop it (running `Drop`
/// on the closure's captures).
///
/// `lua_newuserdatadtor` stores the data inline; `lua_touserdata` returns a
/// pointer to that storage, which is exactly where we wrote the slot. We drop
/// it in place.
///
/// # Safety
/// 仅由 VM 作为终结器调用：`ptr` 必须为 null，或指向
/// `create_callback_function` 以同一 `F` 的 `CallbackSlot<F>` 布局写入、
/// 尚未 drop 的 userdata 载荷；VM 保证其恰被调用一次。
unsafe extern "C-unwind" fn callback_dtor<F>(_l: *mut LuaState, ptr: *mut c_void) {
  if !ptr.is_null() {
    // Safety: `ptr` 由 VM 终结回调 userdata 时传入，只可能配对
    // `create_callback_function` 的 `lua_newuserdatadtor(
    // size_of::<CallbackSlot<F>>(), callback_dtor::<F>)`——同一 `F` 的
    // 单态化写死布局；`CallbackSlot<F>` 是薄盒指针的 niche 枚举，8 字节
    // 载荷即可安全读写。VM 保证终结器恰一次调用且在 GC 回收路径上，
    // 此时不会再有 trampoline 持 `&slot`（同线程、调用栈内借用已退出）。
    unsafe { drop_in_place(ptr.cast::<CallbackSlot<F>>()) };
  }
}

/// The trampoline for one `(F, A, R)` instantiation of `create_function`-style
/// closures. Monomorphized: the call into user code is a direct static call.
///
/// # Safety
/// 仅由 VM 作为 `LuaCFunction` 调用：`state` 必须是正在受保护 C 边界内驱动的
/// 存活 `LuaState`，且 upvalue 1 是该闭包注册的 `CallbackSlot<F>` userdata
/// （布局由同一 `F` 单态化确定，脚本不可替换）。
unsafe extern "C-unwind" fn trampoline<F, A, R>(raw: *mut LuaState) -> i32
where
  F: Fn(&Lua, A) -> Result<R>,
  A: FromLuaMulti,
  R: IntoLuaMulti,
{
  // Safety: C-ABI 边界点(`lua_CFunction` 实参):VM 实时传入存活 state,本帧
  // 一次转视图,视图只在本次 trampoline 调用内使用、不跨帧存放。
  let state = unsafe { StateView::from_raw(raw) };
  // 本函数的共用前置（下面每个 `raise_*` 调用点都引它）：VM 按 `lua_CFunction`
  // 约定实时传入 `state`，故其存活且正由当前线程在受保护 C 边界内驱动；CI 帧
  // 建立时预留的 LUA_MINSTACK 头寸满足错误对象的 push。用户闭包连同 `A`/`R`
  // 转换都在 `catch_unwind` 内，panic 不会裸跨 C-unwind 边界；结果路径先
  // `lua_checkstack` 再逐层 `push_value`，失败全部以发散收敛；返回计数与实际
  // 压入层数一致。
  //
  // 1. Recover the closure slot from upvalue 1.
  // `typed_userdata`（userdata.rs 的类型化下转 safe 门面）：闸门（userdata 类型 /
  // 载荷非空 / 长度覆盖）与 `cast`/`as_ref` 边界全收口在其函数体一处；解读的布局
  // 即写入布局——同一 `(F, A, R)` 单态化、脚本不可替换，块内只读、无并存别名。
  // 缺失仍经 `raise_lua_error` 发散收敛（let-else 的发散臂）。
  let Some(slot) = typed_userdata::<CallbackSlot<F>>(state, lua_upvalueindex(1)) else {
    raise_lua_error(state, "ulua-rt: missing callback upvalue")
  };
  // 2. A destructed scope callback reports the structured
  //    `CallbackDestructed` (identical externally to the previous design's
  //    sentinel box). `slot.as_ref()` 把 `&Option<Box<F>>` 收成
  //    `Option<&Box<F>>`，纯 Rust。
  let Some(callback) = slot.as_ref() else {
    // 共用前置成立；`err` 按值移入，错误 userdata 由被调方自行分配写入。
    raise_structured_error(state, Error::CallbackDestructed)
  };

  // 3. Build a borrowed Lua handle for the calling thread (must NOT close it).
  // `Lua::from_borrowed` 是带契约的 safe fn（只复制视图指针位、不解引用）：
  // `state` 由 VM 实时传入并经上一收口点转视图，即满足「存活期覆盖句柄及其克隆」。
  let lua = Lua::from_borrowed(state);

  // 4. Pull the arguments off the stack into a MultiValue. They occupy
  //    stack indices 1..=nargs.
  // `stack_top` 是带契约的 safe 门面（`state` 存活，只读当前栈深）——`1..=nargs`
  // 因而是有效槽位，正是 `collect_stack_args` 的头注释前提；收集本身是 safe fn，
  // 只有转换失败的发散点需要 `unsafe`（共用前置成立，消息当场拷贝）。
  let nargs = stack_top(state);
  let args = match collect_stack_args(&lua, nargs) {
    Ok(a) => a,
    // 共用前置成立（`state` 正于受保护 C 边界内被当前线程驱动）；消息
    // 在本帧存活且被当场拷贝。
    Err(e) => raise_lua_error(state, &e.to_string()),
  };

  // 5. Run the user closure inside catch_unwind so a user `panic!` never
  //    becomes a nested panic when we then call lua_error. The `A`/`R`
  //    conversion is part of the guarded region (same as before, when it
  //    lived inside the boxed wrapper). 纯 Rust 区：无 C 边界，故无 unsafe。
  let outcome: ThreadResult<Result<MultiValue>> = catch_unwind(AssertUnwindSafe(|| {
    let a = A::from_lua_multi(args, &lua)?;
    callback(&lua, a)?.into_lua_multi(&lua)
  }));

  match outcome {
    Ok(Ok(results)) => {
      // 6a. Push every result and return its count. Reserve stack space
      //     first: an unchecked push of a very large result list would
      //     overflow the Lua stack and trip a fatal VM assertion
      //     (SIGTRAP) instead of erroring. Guard it and raise a
      //     catchable error if the results cannot fit (mirroring mlua).
      let n = results.len() as i32;
      // `ensure_stack`（safe 门面族）只报告头寸（`Err` 表示扩不动）；放不下即发散。
      if ensure_stack(state, n.max(1)).is_err() {
        // 共用前置成立（消息当场被 `push_bytes` 门面拷贝，不寄存指针）。
        raise_lua_error(state, "too many results to return to Lua")
      }
      for v in &results {
        // `push_value` 是带契约的 safe 门面；n 层头寸已由上一行 `ensure_stack`
        // 保证，满栈时它返回 `Err` 而非越栈写。
        if let Err(e) = lua.push_value(v) {
          // 共用前置成立。
          raise_lua_error(state, &e.to_string())
        }
      }
      n
    }
    Ok(Err(err)) => {
      // 6b. The closure returned Err -> raise it as a Lua error.
      //     Structured errors (scope destruction) travel as a userdata
      //     error object so the caller can pattern-match on them; all
      //     others keep the flat string path.
      if is_structured(&err) {
        // 共用前置成立；`err` 按值移入，错误 userdata 由被调方自行分配写入。
        raise_structured_error(state, err)
      }
      // 非结构化错误走扁平字符串路径（两个分支都是发散）
      // 共用前置成立；`err.to_string()` 在本帧存活且被当场拷贝。
      raise_lua_error(state, &err.to_string())
    }
    Err(panic_payload) => {
      // 6c. The closure panicked -> turn it into a catchable Lua error.
      // 共用前置成立；格式化出的消息在本帧存活且被当场拷贝。
      raise_lua_error(state, &panic_error_message(&*panic_payload))
    }
  }
}

/// Collect stack arguments `1..=nargs` into a [`MultiValue`] (stopping at the
/// first conversion error). Shared by the sync trampoline and the async
/// `get_future` closure.
///
/// `1..=nargs` 应为 `lua` 栈上的有效槽位（调用方传刚取的 `lua_gettop`）；
/// 越界索引由 `value_from_stack` 读取门面归为转换错误，不致 UB，故本函数
/// 无前置条件、是 safe fn。
pub(crate) fn collect_stack_args(lua: &Lua, nargs: i32) -> Result<MultiValue> {
  (1..=nargs).map(|i| lua.value_from_stack(i)).collect()
}

/// Push `msg` as the error object and invoke [`lua_error`]. Diverges (unwinds
/// via the VM's longjmp-style error). Shared with `async.rs` / `interrupt.rs`.
///
/// 调用序契约（正确性，非内存安全，与 [`raise_structured_error`] 同族）：
/// `state` 必须是存活、正由当前线程在 C 边界（trampoline/hook）内驱动的
/// `LuaState`——`lua_error` 沿 VM 的 longjmp 式展开逃逸本函数，只有站在受保护
/// 的 C 调用内部才可吸收；且栈上须有至少 1 个空位供 push 错误对象。与
/// `Lua::from_borrowed` 同范式：契约前移到调用点，本函数是 safe 门面，
/// `lua_error` 边界收在 `state::raise_from_top` 一处。
pub(crate) fn raise_lua_error(state: StateView<'_>, msg: &str) -> ! {
  // 函数头契约即本函数全部前提。`msg` 的字节切片合法可读（空串长度为 0，
  // VM 按长度读、不触碰指针），`push_bytes`（safe 门面）把内容拷成内部 TString、
  // 不寄存借用指针；`raise_from_top`（`lua_error` 的收口门面）按契约以 VM 的
  // longjmp 式展开逃逸到受保护边界，发散不返回。
  push_bytes(state, msg.as_bytes());
  raise_from_top(state)
}

/// Best-effort extraction of a panic payload's message. `&str`/`String` 载荷零拷贝
/// 借用返回，类型化错误载荷见 [`analysis_error_message`]（需渲染故为 owned）。
/// 无前缀的裸消息——`typecheck.rs` 把 panic 折成合成诊断时用的就是这一形态；
/// 「panic → Lua 错误」的五处收口点请改用 [`panic_error_message`]。
///
/// DELIBERATE DEVIATION（保留 `dyn Any`）：形参类型即 `std::panic::catch_unwind`
/// 返回的 `Box<dyn Any + Send>` 载荷形态——载荷类型集合由展开点决定、运行期开放，
/// 不存在擦除替代。调用点证据：`interrupt.rs::interrupt_trampoline`、本文件同步回调
/// trampoline、`async.rs` 的 get_future/poll/unpack 各自 `catch_unwind` 出不同的
/// `&*payload`（`&str`/`String`/`panic_any(X)` 类型化错误）汇入此函数。
///
/// 调用方务必写 `&*payload`（先解引用 `Box`）而非 `&payload`：`Box<dyn Any + Send>`
/// 自身也是 `'static`，因而实现了 `Any + Send`；若直接传 `&payload`，会触发 unsizing
/// 强转（`&Box<dyn Any+Send>` → `&dyn Any+Send`），得到的 trait object 具体类型是外层
/// `Box<dyn Any+Send>` 而非内部真正载荷（`&str`/`String`/错误类型），令下面的
/// `downcast_ref` 全部落空、退化成 `unknown panic`。`&*payload` 才能让 `dyn Any`
/// 指向实际载荷。
pub(crate) fn panic_message(payload: &(dyn Any + Send)) -> Cow<'_, str> {
  if let Some(s) = payload.downcast_ref::<&'static str>() {
    Cow::Borrowed(*s)
  } else if let Some(s) = payload.downcast_ref::<String>() {
    Cow::Borrowed(s)
  } else if let Some(s) = analysis_error_message(payload) {
    // 类型化载荷（`panic_any(X)`）：按该错误类型的 `Display` 渲染，文案与其
    // 早期「`panic!("{}", X)`」降级形态逐字一致，不再退化成 `unknown panic`。
    Cow::Owned(s)
  } else {
    Cow::Borrowed("unknown panic")
  }
}

/// [`panic_message`] 的类型化载荷分支：`ulua-analysis` 以 `panic_any` 抛出的
/// ICE/超时/取消三族错误，其消息各自由 `thiserror` derive 的 `Display` 单源产生。
/// 未启用 `typecheck` 时这些类型不在依赖图内，恒返回 `None`（走原兜底文案）。
///
/// 保留 `dyn Any`：同 [`panic_message`]，形参类型即 `catch_unwind` 的错误形态。
#[cfg(feature = "typecheck")]
fn analysis_error_message(payload: &(dyn Any + Send)) -> Option<String> {
  use ulua_analysis::records::{
    internal_compiler_error::InternalCompilerError, time_limit_error::TimeLimitError,
    user_cancel_error::UserCancelError,
  };

  if let Some(e) = payload.downcast_ref::<InternalCompilerError>() {
    Some(e.to_string())
  } else if let Some(e) = payload.downcast_ref::<TimeLimitError>() {
    Some(e.to_string())
  } else {
    payload
      .downcast_ref::<UserCancelError>()
      .map(|e| e.to_string())
  }
}

/// `typecheck` 关闭时的空分支：analysis 的错误类型不存在，无载荷可渲染。
/// 保留 `dyn Any`：形参须与 [`panic_message`] 同一枚 `catch_unwind` 擦除载荷
/// 形态对接（§4：载荷类型集合由展开点决定、运行期开放）。
#[cfg(not(feature = "typecheck"))]
fn analysis_error_message(_payload: &(dyn Any + Send)) -> Option<String> {
  None
}

/// [`panic_message`] 拼上 [`PANIC_MSG_PREFIX`]：五处「panic 转 Lua 错误」收口点
/// （同步 trampoline、interrupt trampoline、async 的 get_future/poll/unpack）共用，
/// 前缀文案就此单点定义。`dyn` 保留理由同 [`panic_message`]（同一枚擦除载荷）。
pub(crate) fn panic_error_message(payload: &(dyn Any + Send)) -> String {
  format!("{PANIC_MSG_PREFIX}{}", panic_message(payload))
}

/// 把任意 `Fn(&Lua, A) -> Result<R>` 具体闭包包装成 Lua [`Function`]：
/// 闭包装箱后存进 upvalue 1 的 userdata 槽位，trampoline 按 `(F, A, R)`
/// 单态化，参数经 [`FromLuaMulti`] 解包、返回值经 [`IntoLuaMulti`] 打包。
/// [`Lua::create_function`](crate::Lua::create_function) 与 userdata 方法
///  machinery 共用。
///
/// `F` 只需是 `Sized` 闭包——**不要求 `'static`**：`'static` 约束由公开 API
/// （[`Lua::create_function`](crate::Lua::create_function)）自己加，而
/// [`Scope::create_function`](crate::Scope::create_function) 借此把借 `'scope`
/// 数据的闭包直接存进槽位（无任何生命周期 transmute）。
/// `FnMut` 闭包的 `RefCell` 守卫适配：包成可共享的 `Fn`，重入（回调在途时
/// 经 Lua 再次调用自身）报 [`Error::RecursiveMutCallback`] 而非借用 panic。
/// `Lua::create_function_mut` 与 `Scope::create_function_mut` 共用。
///
/// 是宏而非泛型函数：泛型版须经 RPIT 返回闭包，会强加 `A/R: 'opaque`
/// outlive 约束，收紧调用方（尤其 scope 版）的 lifetime 语义；宏在各调用点
/// 内联展开，类型即局部闭包，无额外约束。
macro_rules! wrap_mut_closure {
  ($func:expr) => {{
    let func = ::std::cell::RefCell::new($func);
    move |lua, args| {
      let mut borrow = func
        .try_borrow_mut()
        .map_err(|_| $crate::error::Error::RecursiveMutCallback)?;
      (borrow)(lua, args)
    }
  }};
}
pub(crate) use wrap_mut_closure;

/// `trampoline` 闭包的调试名：静态 NUL 结尾字节串，交给 `lua_pushcclosurek` 的
/// `*const c_char` 收口点。VM 压栈时经 intern 复制为 TString 锚（调用期指针即可），
/// 本 crate 保留 `'static` NUL 字面量形态——收口垫片按 NUL 扫描读载荷，`\0` 不可省。
const CALLBACK_NAME: &[u8] = b"ulua-rt-callback\0";

pub(crate) fn create_callback_function<F, A, R>(lua: &Lua, func: F) -> Result<Function>
where
  F: Fn(&Lua, A) -> Result<R>,
  A: FromLuaMulti,
  R: IntoLuaMulti,
{
  let state = lua.state();
  // 先装箱再分配：`Box::new` 若发生在 `alloc_userdata_slot` 之后，其潜在的分配失败
  // 会留下「已注册 dtor 但槽位未初始化」的窗口，GC 稍后对垃圾执行 `drop_in_place`
  // （review.md §2 所有权显式转手）。提前装箱使可失败点全部落在分配之前。
  let boxed = Box::new(func);
  // Allocate userdata sized for the slot, with our dtor.
  // `alloc_userdata_slot`（userdata.rs 的带契约 safe 门面，含 `AlignOk` 编译期
  // 闸门）：`state` 存活（lua 的 `XRc<LuaInner>`）且由当前线程驱动；
  // `callback_dtor::<F>` 与载荷 `CallbackSlot<F>` 同一 `F` 单态化。返回 `None`
  // 即分配失败（判空在门面内归一），转错误返回。
  let slot = alloc_userdata_slot::<CallbackSlot<F>>(state, callback_dtor::<F>);
  let Some(slot) = slot else {
    // 未写槽，`boxed` 在本帧正常 drop——一次性所有权，无双放。
    return Err(Error::runtime(
      "ulua-rt: failed to allocate callback userdata",
    ));
  };
  // `init_userdata_slot`（userdata.rs 的 `ptr::write` 全 crate 收口点）：非空、恰
  // `size_of::<CallbackSlot<F>>()`（niche 薄盒指针，`AlignOk` 编译期闸门）、未初始化
  // 的载荷，首次写入即所有权移交 userdata。盒的 Drop 责任移交同 `F` 单态化配对的
  // `callback_dtor::<F>`，不双放不泄漏。
  init_userdata_slot(slot, Some(boxed));
  // The userdata is now on top of the stack; capture it as upvalue 1 of
  // the trampoline closure. `push_named_closure`（state.rs safe 门面族）：
  // `nup=1` 消费栈顶刚压的 userdata；绑定的 `trampoline::<F, A, R>` 与载荷布局
  // 同一 `(F, A, R)` 单态化；debugname 是被闭包长期持有的 `'static` NUL 结尾
  // 静态字节串；`cont=None`（不可 yield 路径无续体）。
  push_named_closure(state, Some(trampoline::<F, A, R>), CALLBACK_NAME, 1);
  // The closure is now on top; take a registry ref. `pop_ref`（safe fn）弹走闭包并
  // 登记注册表引用，净栈变化为零。
  Ok(Function::from_ref(lua.pop_ref()))
}

/// Neutralise a scope-created callback: `take()` the boxed closure out of the
/// function's upvalue-1 userdata slot, dropping it (and thereby ending any
/// borrows it held). The slot is left `None`; the Lua function object itself is
/// left fully valid — only its behavior changes to "destructed" — so a
/// post-scope call from Lua hits [`Error::CallbackDestructed`] instead of
/// touching freed memory.
///
/// This is the **invalidation half** of `Lua::scope`'s soundness guarantee: the
/// original closure (which may borrow non-`'static` data) is dropped here, on
/// scope exit, *before* the borrowed data's lifetime can end.
///
/// `F` must be the exact closure type the function was created with — the
/// scope registers this via the same `(F, A, R)` instantiation it used to
/// build the function, so the slot layout always matches.
///
/// Must be called while the scope (and hence the VM) is still alive.
pub(crate) fn destruct_callback<F>(func: &Function) {
  let lua = func.lua();
  let state = lua.state();
  // `func.push_to_stack()` 是 safe 封装：`reference.push` 落 VM 侧 `lua_rawgeti` 自带
  // 栈预留，注册表 id 在 unref 前指实槽位（`state` 经 func 句柄链的 `XRc<LuaInner>` 保活）。
  func.push_to_stack();
  // `push_upvalue`（state.rs safe 门面族，`lua_getupvalue` 收口点）：只把
  // upvalue **值**再压一层（name 就地丢弃），返回 `false` 即无该 upvalue 且不压栈。
  let has_upvalue = push_upvalue(state, -1, 1);
  if !has_upvalue {
    // No upvalue (should not happen for our callbacks); just pop the fn.
    // 栈顶即 push 压入的函数值，`pop_stack`（safe 门面）弹回这一层恢复栈配平。
    pop_stack(state, 1);
    return;
  }
  // stack: [func, upvalue-userdata]
  // `typed_userdata_mut`（userdata.rs 的类型化下转 safe 门面）收口闸门 + `as_mut`
  // 边界：栈顶是刚压入的 upvalue 值，非 userdata/长度不足返回 `None`（判空哨兵就此
  // 消失）；无并存可写别名的前提——destruct 只在 scope 退出、本函数回调帧不在途时
  // 于同线程运行，trampoline 的 `&slot` 借用只存在于其调用栈内。
  let slot = typed_userdata_mut::<CallbackSlot<F>>(state, -1);
  if let Some(slot) = slot {
    // Empty the slot; the taken box is dropped here, running Drop on the
    // original closure's captures. `Option::take` 与盒的 drop 都是纯 Rust 操作。
    drop(slot.take());
  }
  // 弹回 push 与 getupvalue 各压入的一层，净栈变化为零；`pop_stack`（safe 门面）收口。
  pop_stack(state, 2);
}
