//! [`ulua_rt::Function`] 元信息 / 环境读写不得泄漏 VM 栈槽。
//!
//! 回归于 `src/function.rs` 的 `lua_getinfo` 5.1 写法误用：每次调用留下一槽，
//! 反复调用会把栈一路推大直至 `lua_error`。栈顶只能从裸 `LuaState` 观测，
//! 而拿到主线程 state 的 pub 路径是 [`Lua::current_thread`]（`lua_pushthread` +
//! `lua_tothread` 的往返即主线程自身），故本文件是独立 test binary 而非 src 单测。

use ulua_rt::{Function, Lua, Result};

/// R3 回归：`info` / `environment` / `set_environment`（含 C 函数路径下的
/// `is_lua_closure`）不得净泄漏栈槽。
///
/// Luau 的 `lua_getinfo(l, level, what, ar)` 用显式 level 取函数，既不弹栈
/// 也不认 Lua 5.1 的 `">"` 选项；按 5.1 写法调用时每次都会留下一槽，反复调用
/// 会把栈一路推大（每次 `ensure_stack` 触发 realloc）直至 `lua_error`。
#[test]
fn debug_info_and_environment_keep_stack_balanced() -> Result<()> {
  let lua = Lua::new();
  let function: Function = lua
    .load("local upvalue = 7 return function(x) return x + upvalue end")
    .eval()?;
  let native = lua.create_function(|_, ()| Ok(()))?;
  let env = lua.create_table();

  // 主线程的裸 state：安全包装层用的就是它，栈顶差才能反映真实泄漏。
  let state = lua.current_thread().state();
  // 探针锚定：`exec_raw` 闭包收到的 state 即安全包装层所用者（`self.state()`），
  // 与探针相同才说明下面的量法不是空转。
  unsafe {
    lua.exec_raw::<(), _>((), move |inner| assert_eq!(inner as usize, state as usize))?;
  }
  let base = unsafe { (*state).get_top() };
  for _ in 0..500 {
    assert_eq!(function.info().what, "Lua");
    assert_eq!(native.info().what, "C");
    assert!(function.environment().is_some());
    assert!(native.environment().is_none());
    assert!(function.set_environment(env.clone())?);
    assert!(!native.set_environment(env.clone())?);
  }
  assert_eq!(
    unsafe { (*state).get_top() },
    base,
    "debug info / environment 泄漏了栈槽"
  );
  // 前置 sanity check：泄漏时栈会真的增长，故上面的断言不是空转。
  unsafe { (*state).set_top(base + 4) };
  assert_eq!(unsafe { (*state).get_top() }, base + 4);
  unsafe { (*state).set_top(base) };
  Ok(())
}
