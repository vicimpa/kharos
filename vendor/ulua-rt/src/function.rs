//! The [`Function`] handle. Mirrors `mlua::Function`.

#[cfg(feature = "async")]
use core::future::Future;
use core::{
  fmt::{self, Formatter},
  marker::PhantomData,
  result::Result as StdResult,
};

#[cfg(feature = "jit")]
use ulua_code_gen::functions::luau_codegen_compile::luau_codegen_warm_recompile;

#[cfg(feature = "async")]
use crate::async_support::{
  AsyncThread, LuaNativeAsyncFn, WrappedAsync, register_implicit_thread, unregister_implicit_thread,
};
#[cfg(feature = "async")]
use crate::state::StateView;
use crate::{
  debug::{debug_string, get_info},
  error::{ExternalError, Result},
  multi::MultiValue,
  registry::RegHandle,
  state::{Lua, LuaRef, ensure_stack, is_table_at, pop_stack, run_pcall, set_stack_top, stack_top},
  sync::{MaybeSend, NOT_SYNC, NotSync, XRc},
  sys::*,
  table::Table,
  traits::{FromLuaMulti, IntoLua, IntoLuaMulti},
  value::Value,
};

/// `lua_getinfo` 选项模板：仅 `s`（函数类型），供 `is_lua_closure` 判定用。
/// 静态字节切片，直传切片形 `what` 形参（§10：不经 C 指针契约位）。
const GETINFO_S: &[u8] = b"s";
/// `lua_getinfo` 选项模板：`n`（名字）+ `s`（源/类型）+ `a`（参数）+ `u`（upvalue）。
/// 供 `Function::info` 用，静态字节切片。
const GETINFO_NSAU: &[u8] = b"nsau";

/// A handle to a callable Lua value (a Lua closure or a Rust function).
///
/// Mirrors `mlua::Function`. Under the `send` feature it is `Send` but never
/// `Sync` — see `crate::sync::NotSync`.
#[derive(Clone)]
pub struct Function {
  pub(crate) reference: XRc<LuaRef>,
  pub(crate) _not_sync: NotSync,
}

impl Function {
  pub(crate) fn from_ref(reference: LuaRef) -> Function {
    Function {
      reference: XRc::new(reference),
      _not_sync: NOT_SYNC,
    }
  }

  /// The owning [`Lua`].
  pub fn lua(&self) -> Lua {
    self.reference.lua()
  }

  /// Call the function with `args`, converting the results to `R`.
  ///
  /// Mirrors `mlua::Function::call`. Runs under `lua_pcall`, so a Lua runtime
  /// error (or a Rust callback returning `Err`) becomes `Err(Error)` rather
  /// than unwinding.
  pub fn call<R: FromLuaMulti>(&self, args: impl IntoLuaMulti) -> Result<R> {
    let lua = self.lua();
    let state = lua.state();
    let args: MultiValue = args.into_lua_multi(&lua)?;
    let nargs = args.len() as i32;
    // Guard against pushing more values than the Lua stack can hold:
    // an unprotected overflow would abort the VM. We need room for the
    // function + all arguments (+1 slack for the call machinery).
    // `ensure_stack`（safe fn，只报告头寸）预留函数 1 层 + 参数 nargs 层 + 1 层
    // 调用机构余量；它只可能扩容栈、不改变当前栈深，故随后记录的 `base` 仍是
    // 压入前的合法深度。
    ensure_stack(state, nargs.saturating_add(2))?;
    // `stack_top`（safe 门面）只读当前栈深。
    let base = stack_top(state);
    // `reference.push()`（safe fn）的注册表 id 在 `Drop::lua_unref` 前恒指实槽位，
    // VM 侧 `lua_rawgeti` 自带栈预留；逐层 `push_value` 满栈时以 `?` 提前返回。
    self.reference.push();
    for v in &args {
      lua.push_value(v)?;
    }
    // `run_pcall`（safe 门面）：`state` 存活且栈布局为 [.., func, args..]，
    // `nargs` 与实际压入的参数数一致（同一次迭代）。pcall 在受保护帧内执行：
    // 脚本错误/回调 Err 一律折成非零 status 并把错误对象留在栈顶（正是
    // `pop_error` 的前提），不会裸展开到本帧；-1 即 LUA_MULTRET，保留全部结果。
    let status = run_pcall(state, nargs, -1, 0);
    if status != 0 {
      return Err(lua.pop_error(status));
    }
    // Collect every value pushed above `base` as the results. The multi-ret
    // 复制头寸检查与不足时的截断由 `collect_results_above` 统一负责；
    // `from_lua_multi` 只做转换。
    let results = lua.collect_results_above(base)?;
    R::from_lua_multi(results, &lua)
  }

  /// Return a new function that, when called, prepends `args` to its own
  /// arguments and forwards to `self`.
  ///
  /// Mirrors `mlua::Function::bind`. Implemented as a Rust closure that
  /// captures the bound prefix and the target function.
  #[cfg(not(feature = "async"))]
  pub fn bind(&self, args: impl IntoLuaMulti) -> Result<Function> {
    let lua = self.lua();
    let bound: MultiValue = args.into_lua_multi(&lua)?;
    let target = self.clone();
    let bound_vec: Vec<Value> = bound.into_vec();
    lua.create_function(move |_, extra: MultiValue| {
      target.call::<MultiValue>(concat_bound(&bound_vec, extra))
    })
  }

  /// Return a new function that, when called, prepends `args` to its own
  /// arguments and forwards to `self`.
  ///
  /// Mirrors `mlua::Function::bind`. Under the `async` feature this is built as
  /// a **pure-Lua closure** (`function(...) return func(prepend(...)) end`)
  /// rather than a Rust trampoline, so the forwarded call is a Lua-level call
  /// and remains **yield-transparent**: a bound async function can still yield
  /// while its future is pending. (The `prepend` helper only rearranges
  /// arguments and returns, so it never yields across a C boundary.) Behavior
  /// is identical to the non-async implementation for ordinary functions.
  #[cfg(feature = "async")]
  pub fn bind(&self, args: impl IntoLuaMulti) -> Result<Function> {
    let lua = self.lua();
    let bound: MultiValue = args.into_lua_multi(&lua)?;
    let bound_vec: Vec<Value> = bound.into_vec();

    // `prepend(...)` returns the bound prefix followed by the call args.
    let prepend =
      lua.create_function(move |_, extra: MultiValue| Ok(concat_bound(&bound_vec, extra)))?;

    // Build the wrapper closure in Lua so the inner `func(...)` is a Lua
    // call (yield-transparent), capturing `func` and `prepend` as upvalues.
    let builder: Function = lua
      .load(
        r#"
                local func, prepend = ...
                return function(...)
                    return func(prepend(...))
                end
                "#,
      )
      .set_name("__ulua_bind")
      .into_function()?;
    builder.call::<Function>((self.clone(), prepend))
  }

  /// Call the function asynchronously: run it on a fresh coroutine and drive
  /// that coroutine to completion as a Rust [`Future`](std::future::Future).
  ///
  /// Mirrors `mlua::Function::call_async`. Works for both async functions
  /// (created via [`Lua::create_async_function`](crate::Lua::create_async_function))
  /// — which yield while their inner future is pending — and ordinary
  /// functions (which simply run to completion). Calling an async function
  /// with the *synchronous* [`Function::call`] instead raises a runtime error,
  /// matching mlua.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn call_async<R>(&self, args: impl IntoLuaMulti) -> impl Future<Output = Result<R>>
  where
    R: FromLuaMulti,
  {
    let lua = self.lua();
    // Build the driver eagerly so argument-conversion / thread-creation
    // errors surface when awaited (wrapped in a ready future).
    let setup: Result<AsyncThread<R>> = (|| {
      let thread = lua.create_thread(self.clone())?;
      // The coroutine is *implicit* (created by `call_async`): register it
      // so `Lua::current_thread` running on it resolves to the owner (the
      // thread that issued this call). Mirrors mlua's thread-ownership map.
      register_implicit_thread(thread.co_state(), lua.state());
      // 注册后任何失败都必须撤销登记：否则 ownership 表项泄漏到
      // `LuaInner::drop`，期间同地址新协程会被 `current_thread` 误判。
      // `thread_state` 是 `NonNull`（Copy、不借用 `thread`），先取出句柄再
      // `into_async` 消费 `thread`；撤销时经 safe 收口 `from_handle` 重建视图，
      // 无 `unsafe`、无 `*mut` 裸形（协程对象由 `thread` 注册表引用锚定存活）。
      let co_state = thread.thread_state;
      let setup_result = thread.into_async(args);
      match setup_result {
        Ok(mut th) => {
          th.set_implicit(true);
          Ok(th)
        }
        Err(e) => {
          // co_state 是刚 spawn、由 `thread` 注册表引用锚定存活的协程 state 句柄；
          // 视图只在本撤销调用内。
          unregister_implicit_thread(StateView::from_handle(co_state));
          Err(e)
        }
      }
    })();
    async move { setup?.await }
  }

  /// Wrap a Rust async function/closure as a value convertible into a Lua
  /// function.
  ///
  /// Mirrors `mlua::Function::wrap_async`. Unlike
  /// [`Lua::create_async_function`](crate::Lua::create_async_function) the
  /// closure does not receive the [`Lua`] and its arity is free (0, 1, … args
  /// mapped from the Lua call arguments). The returned value is
  /// [`IntoLua`](crate::IntoLua) so it can be stored directly (e.g.
  /// `globals().set("f", Function::wrap_async(..))`). A returned `Err` is
  /// raised as a Lua error.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn wrap_async<F, A, R, E>(func: F) -> impl IntoLua
  where
    F: LuaNativeAsyncFn<A, Output = StdResult<R, E>> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti + 'static,
    E: ExternalError + 'static,
  {
    WrappedAsync::new(move |_lua: Lua, a: A| {
      let fut = func.call(a);
      async move { fut.await.map_err(ExternalError::into_lua_err) }
    })
  }

  /// Like [`Function::wrap_async`] but the closure's output is passed through
  /// to Lua as-is (a returned `Result` becomes an `(ok, err)`-style multi
  /// value rather than being raised).
  ///
  /// Mirrors `mlua::Function::wrap_raw_async`.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub fn wrap_raw_async<F, A>(func: F) -> impl IntoLua
  where
    F: LuaNativeAsyncFn<A> + MaybeSend + 'static,
    F::Output: IntoLuaMulti + 'static,
    A: FromLuaMulti,
  {
    WrappedAsync::new(move |_lua: Lua, a: A| {
      let fut = func.call(a);
      async move { Ok(fut.await) }
    })
  }

  /// Wrap a plain Rust closure as a value convertible into a Lua function.
  ///
  /// Mirrors `mlua::Function::wrap`. Unlike
  /// [`Lua::create_function`](crate::Lua::create_function), the closure does
  /// **not** receive the [`Lua`] and its arity is free (`||`, `|a|`, `|a, b|`,
  /// … mapped from the Lua call arguments). The returned value is
  /// [`IntoLua`](crate::IntoLua) so it can be stored directly (e.g.
  /// `table.set("f", Function::wrap(|a, b| Ok::<_, Error>(a + b)))`). A
  /// returned `Err` is raised as a Lua error.
  pub fn wrap<F, A, R, E>(func: F) -> impl IntoLua
  where
    F: LuaNativeFn<A, Output = StdResult<R, E>> + MaybeSend + 'static,
    A: FromLuaMulti,
    R: IntoLuaMulti,
    E: ExternalError,
  {
    WrappedFunction {
      func,
      _marker: PhantomData,
    }
  }

  /// J1 Phase 2b：对本函数的闭包树强制暖重编译（须已 `enable_jit`；
  /// 安全点约束：本函数不得有在途 native 帧——在解释器环/VM 出口投递）。
  ///
  /// Mirrors chunk 装载期的 `luau_codegen_compile` 钩子，走 `force_recompile`
  /// 路径重编译并重绑定 execdata（旧 module 释放策略见 CompilationOptions 注）。
  #[cfg(feature = "jit")]
  pub fn warm_recompile(&self) -> Result<()> {
    let lua = self.lua();
    let state = lua.state();
    let base = stack_top(state);
    self.reference.push();
    // Safety: `state` 存活、由当前线程驱动；-1 即刚压入的本函数（chunk.rs jit 钩子同口径）。
    unsafe {
      luau_codegen_warm_recompile(&mut *state.as_mut_ptr(), -1);
    }
    set_stack_top(state, base);
    Ok(())
  }

  /// 非 jit 构建变体：恒错误（镜像 [`Lua::enable_jit`] 的双变体写法）。
  #[cfg(not(feature = "jit"))]
  pub fn warm_recompile(&self) -> Result<()> {
    let _ = self;
    Err(crate::Error::runtime(
      "Luau JIT support is not enabled in this build (requires feature 'jit')",
    ))
  }

  /// A raw pointer identifying this function (for identity comparison).
  /// Mirrors `mlua::Function::to_pointer`.
  pub fn to_pointer(&self) -> *const c_void {
    self.reference.to_pointer()
  }

  /// The function's environment table (its globals), or `None` for a Rust
  /// (C) function. Mirrors `mlua::Function::environment`.
  pub fn environment(&self) -> Option<Table> {
    let lua = self.lua();
    let mut state = lua.state();
    // `stack_top`（safe 门面）只读当前栈深；此刻记录的 `base` 是本函数压入前的
    // 深度，末尾据此截回，净栈变化为零。
    let base = stack_top(state);
    // `reference.push()`（safe fn）落 VM 侧 `lua_rawgeti` 自带栈预留、注册表 id 指
    // 实槽位；压入后 -1 即本函数值。
    self.reference.push();
    // `lua_getfenv` only applies to Lua closures; a C function has no accessible
    // environment. [`Function::is_lua_closure`] 自行压/弹一层，返回后栈顶仍是本函数。
    let env = if self.is_lua_closure() {
      lua_getfenv(&mut state, -1);
      // 栈顶是刚压入的环境值，`is_table_at`（safe 门面）只读其类型标记、不动栈。
      let is_table = is_table_at(state, -1);
      // 命中表时 `pop_ref`（safe fn）登记引用并弹掉这一层；否则留待下面 settop 收口。
      if is_table {
        Some(Table::from_ref(lua.pop_ref()))
      } else {
        None
      }
    } else {
      None
    };
    // 统一收口——本函数自己压的一切（含未被 `pop_ref` 消费的 `lua_getfenv` 结果）
    // 都在这里截回；`base` 是压入前的合法栈深（`set_stack_top` safe 门面）。
    set_stack_top(state, base);
    env
  }

  /// Set the function's environment table. Returns `Ok(false)` for a Rust
  /// (C) function (which has no settable environment) and `Ok(true)` for a
  /// Lua closure. Mirrors `mlua::Function::set_environment`.
  pub fn set_environment(&self, env: Table) -> Result<bool> {
    let lua = self.lua();
    let mut state = lua.state();
    // 需要 [func, env] 两个槽位：`ensure_stack`（safe fn）只报告头寸，
    // 下面 `push_to_stack` 与 `is_lua_closure` 的临时压栈都以它为前提。
    ensure_stack(state, 2)?;
    // `stack_top`（safe 门面）只读栈深，`base` 是压入前深度。
    let base = stack_top(state);
    // `reference.push()`（safe fn）：注册表引用锚定函数值在世，VM 侧自保栈位。
    self.reference.push();
    // lua_setfenv 会弹掉环境表；本函数压的函数层由末尾 settop 收口。
    // `is_lua_closure` 在函数刚压栈顶后调用，自行压/弹一层复用上面预留的头寸。
    let ok = if self.is_lua_closure() {
      // `env.push_to_stack()` 是 safe 封装（`lua_rawgeti` 自带栈预留）；`env` 与本
      // 句柄同 VM 由 move-not-share 句柄纪律约束（无运行时校验，同 `set_globals`）。
      env.push_to_stack();
      lua_setfenv(&mut state, -2) != 0
    } else {
      false
    };
    // `base` 合法，`set_stack_top`（safe 门面）把本函数压的层（含任何中间压入）截回，
    // 净栈变化为零。
    set_stack_top(state, base);
    Ok(ok)
  }

  /// Whether this function is a Lua closure (vs a C function). Determined via
  /// the debug `what` field.
  ///
  /// 自行把句柄值压栈、读完即弹，**调用方栈深不变**：因此不要求「栈顶必须是本
  /// 函数」这类脆弱前置条件，调用点也无需 `unsafe`。
  ///
  /// **不改变栈**：本仓库/上游 Luau 的 `lua_getinfo(L, level, what, ar)` 没有
  /// PUC-Rio Lua 5.x 的 `">"`（「读信息并弹栈」）约定——`>` 落到 `auxgetinfo`
  /// 的 `default:;` 被忽略，只有 `f` 选项会压栈（cpp/VM/src/ldebug.cpp:190-247
  /// 的 `lua_getinfo`/`auxgetinfo`，移植见
  /// `crates/ulua-vm/src/functions/{lua_getinfo,auxgetinfo}.rs`）。所以这里用
  /// `level = -1` 直接指栈顶，弹栈由本函数末尾负责。
  fn is_lua_closure(&self) -> bool {
    let state = self.reference.state();
    // `reference.push()`（safe fn）落 VM 侧 `lua_rawgeti` 自带栈预留，压入后 -1
    // 即本函数值——正满足下一行 `level = -1` 的解读。
    self.reference.push();
    // `get_info`（safe 门面）收口零初始化 + `lua_getinfo` out 参数两步：`state`
    // 存活、栈顶是刚压入的本函数值（`level = -1` 解到它）、`GETINFO_S` 为静态
    // 选项模板切片且不含 `f`，不压值。
    let closure = get_info(state, -1, GETINFO_S)
      .is_some_and(|ar| matches!(ar.what, LuaWhat::Lua | LuaWhat::Main));
    // `getinfo` 不压不弹，栈顶仍是 push 压入的本函数值；`pop_stack`（safe 门面）
    // 弹回这一层，恢复调用方栈深。
    pop_stack(state, 1);
    closure
  }

  /// Debug information about this function. Mirrors `mlua::Function::info`.
  pub fn info(&self) -> FunctionInfo {
    let lua = self.lua();
    let state = lua.state();
    // `stack_top`（safe 门面）只读当前栈深；此刻记录的 `base` 是本函数压入前的
    // 深度，末尾据此截回，净栈变化为零。
    let base = stack_top(state);
    // `reference.push()`（safe fn）的栈头寸与 id 有效性论证同 `environment`，
    // 压入后 `level = -1` 解到刚压入的本函数。
    self.reference.push();
    // `get_info`（safe 门面）收口默认初值 + `lua_getinfo` out 参数：`state` 存活、
    // 栈顶是本函数值；选项模板 `GETINFO_NSAU` 是静态切片且不含 `f`，不额外压栈。
    // 回填的 `what` 是 `LuaWhat` 枚举，`source`/`name`/`short_src` 是 VM 在填写时
    // 拷成的 owned `Vec<u8>`——下面的构造把它们 lossy 转成 owned `String`。
    let info = match get_info(state, -1, GETINFO_NSAU) {
      None => FunctionInfo::default(),
      Some(ar) => {
        let is_lua = matches!(ar.what, LuaWhat::Lua | LuaWhat::Main);
        let what = ar.what.as_str().to_string();
        let line_defined = (ar.linedefined > 0).then_some(ar.linedefined as i64);
        // Lua chunks are loaded with a `=<name>` chunkname marker; mlua
        // reports the bare name in `source`, so strip a single leading
        // `=`/`@` for Lua/main functions. C functions keep their VM-reported
        // source verbatim (e.g. `=[C]`), matching mlua.
        let source = debug_string(ar.source).map(|s| {
          if is_lua && (s.starts_with('=') || s.starts_with('@')) {
            s[1..].to_string()
          } else {
            s
          }
        });
        FunctionInfo {
          name: debug_string(ar.name),
          source,
          short_src: debug_string(ar.short_src),
          line_defined,
          last_line_defined: None, // Luau does not report it.
          what,
          num_upvalues: ar.nupvals,
          num_params: ar.nparams,
          is_vararg: ar.isvararg,
        }
      }
    };
    // `base` 是压入前深度，`set_stack_top`（safe 门面）弹回 push 的一层（含任何
    // 中间压入），截至压入前深度，净栈变化为零。
    set_stack_top(state, base);
    info
  }
}

/// Concatenate the bound prefix with `extra` (both `bind` variants share it).
fn concat_bound(bound: &[Value], extra: MultiValue) -> MultiValue {
  bound.iter().cloned().chain(extra).collect::<MultiValue>()
}

/// Debug information about a [`Function`]. Mirrors `mlua::debug::FunctionInfo`
/// (the subset Luau reports).
#[derive(Clone, Debug, Default)]
pub struct FunctionInfo {
  /// The function's name, if known (Luau records the call-site name).
  pub name: Option<String>,
  /// The chunk source name (e.g. `"=[C]"` for native functions).
  pub source: Option<String>,
  /// A short, human-readable source description.
  pub short_src: Option<String>,
  /// The line where the function was defined, if it is a Lua function.
  pub line_defined: Option<i64>,
  /// The last line of the function's definition. Always `None` in Luau.
  pub last_line_defined: Option<i64>,
  /// `"Lua"`, `"C"`, or `"main"`.
  pub what: String,
  /// The number of upvalues.
  pub num_upvalues: u8,
  /// The number of fixed parameters.
  pub num_params: u8,
  /// Whether the function is variadic.
  pub is_vararg: bool,
}

impl RegHandle for Function {
  fn reference(&self) -> &XRc<LuaRef> {
    &self.reference
  }
}

impl fmt::Debug for Function {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    write!(f, "Function")
  }
}

impl PartialEq for Function {
  fn eq(&self, other: &Self) -> bool {
    // Pointer identity (matches mlua): same underlying function object.
    self.to_pointer() == other.to_pointer()
  }
}

// ---------------------------------------------------------------------------
// LuaNativeFn: arity-abstracting sync closure trait (mirrors mlua)
// ---------------------------------------------------------------------------

/// A function/closure callable with a tuple of `FromLuaMulti` arguments,
/// abstracting over arity. Mirrors `mlua::LuaNativeFn`. Lets
/// [`Function::wrap`] accept `||`, `|a|`, `|a, b|`, … closures uniformly (the
/// closure receives the converted args directly, not the [`Lua`]).
pub trait LuaNativeFn<A: FromLuaMulti> {
  /// The closure's return type (typically `Result<R, E>`).
  type Output;

  /// Invoke the closure with the converted arguments.
  fn call(&self, args: A) -> Self::Output;
}

macro_rules! impl_lua_native_fn {
    ($($a:ident : $A:ident),*) => {
        impl<FN, $($A,)* R> LuaNativeFn<($($A,)*)> for FN
        where
            FN: Fn($($A,)*) -> R,
            ($($A,)*): FromLuaMulti,
        {
            type Output = R;

            fn call(&self, args: ($($A,)*)) -> R {
                let ($($a,)*) = args;
                self($($a,)*)
            }
        }
    };
}

impl_lua_native_fn!();
impl_lua_native_fn!(a: A);
impl_lua_native_fn!(a: A, b: B);
impl_lua_native_fn!(a: A, b: B, c: C);
impl_lua_native_fn!(a: A, b: B, c: C, d: D);
impl_lua_native_fn!(a: A, b: B, c: C, d: D, e: E);
impl_lua_native_fn!(a: A, b: B, c: C, d: D, e: E, f: F);
impl_lua_native_fn!(a: A, b: B, c: C, d: D, e: E, f: F, g: G);
impl_lua_native_fn!(a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H);

/// A plain closure not yet bound to a [`Lua`]. Becomes a Lua function (via
/// [`Lua::create_function`]) when converted with [`IntoLua`]. Backs
/// [`Function::wrap`].
struct WrappedFunction<F, A, R, E> {
  func: F,
  _marker: PhantomData<fn(A) -> (R, E)>,
}

impl<F, A, R, E> IntoLua for WrappedFunction<F, A, R, E>
where
  F: LuaNativeFn<A, Output = StdResult<R, E>> + MaybeSend + 'static,
  A: FromLuaMulti,
  R: IntoLuaMulti,
  E: ExternalError,
{
  fn into_lua(self, lua: &Lua) -> Result<Value> {
    let func = self.func;
    let f = lua
      .create_function(move |_lua, args: A| func.call(args).map_err(ExternalError::into_lua_err))?;
    Ok(Value::Function(f))
  }
}
