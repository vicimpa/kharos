// 边界契约测试：allocator FFI 返回 null 系分配失败契约（既有约定 review.md §2）
//! VM 构造的**分配失败**路径（集成性质：需要跨 crate 直接构造 VM 并注入必然失败的
//! 分配器，故必须是独立 test binary，而不是 `src` 里的单元测试）。
//!
//! 覆盖两件事：
//! 1. `lua_newstate` 在分配失败时返回 null —— 即 [`ulua_rt::Lua`] 构造链上的 null
//!    分支（`src/state.rs::build_lua`）确实有可达路径，不是死代码。
//! 2. 该 null 检查不误伤正常构造：`Lua::new()`（openlibs = true）与
//!    `Lua::new_empty()`（openlibs = false）两条 pub 路径的可见差异。
//!
//! `build_lua` 是私有函数且 ulua-rt 不暴露分配器注入口（`lua_l_newstate` 无参数），
//! 因此「null 先于 `lua_l_openlibs`」这条顺序回归仍以 `src/state.rs` 的单元测试形式保留。

use core::{ffi::c_void, ptr::null_mut};

use ulua_rt::{Lua, Result, Value};
use ulua_vm::functions::lua_newstate::lua_newstate;

/// 一个总是分配失败的 VM 分配器（模拟 OOM）。
extern "C-unwind" fn failing_alloc(
  _ud: *mut c_void,
  ptr: *mut u8,
  _osize: usize,
  nsize: usize,
) -> *mut u8 {
  // 释放请求必须照常「成功」（返回 null 表示已释放），否则 VM 会以为泄漏。
  let _ = ptr;
  if nsize == 0 {
    return null_mut();
  }
  null_mut()
}

/// `lua_newstate` 在分配失败时确实返回 null —— `build_lua` 的 null 分支可达。
#[test]
fn newstate_returns_null_on_alloc_failure() {
  // Safety: 测试并行运行下本资源由本用例独占、无共享与并发访问；`ptr` 在本用例作用域内取得/构造（&mut 再借用、Box::into_raw 或 as_ptr 布线），至本行使用前不释放，故满足被调 unsafe 例程与 C ABI 的前置条件。
  let state = unsafe { lua_newstate(Some(failing_alloc), null_mut()) };
  assert!(state.is_null(), "failing allocator must yield a null state");
}

/// 正常的 state 不会被 null 闸门拦下：两条构造路径都能取得可用的 VM（panic 即测试
/// 失败），且 `openlibs` 标志的差别（标准库是否已打开）在构造完成后可见。
#[test]
fn construction_yields_a_live_state() -> Result<()> {
  assert_eq!(
    Lua::new()
      .load("return table.concat({'a','b'})")
      .eval::<String>()?,
    "ab",
    "`Lua::new` 必须已打开标准库"
  );

  assert!(
    matches!(
      Lua::new_empty().load("return table").eval::<Value>()?,
      Value::Nil
    ),
    "`Lua::new_empty` 不得打开标准库"
  );
  Ok(())
}
