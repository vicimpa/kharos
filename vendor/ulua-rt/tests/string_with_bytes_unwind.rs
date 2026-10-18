//! `LuaString` 借出字节时的栈复原：借用的切片指向 VM 堆内存，unwind 发生时栈顶必须
//! 已回到借用前的高度。
//!
//! `src/string.rs` 里的 `with_bytes` 只是 pub `LuaString::as_bytes` 的内部别名，
//! 故本文件按 pub 路径观测同一性质（不为了测试放宽内部可见性）。

use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

use ulua_rt::Lua;

#[test]
fn bytes_callback_restores_stack_before_unwind() {
  let lua = Lua::new();
  let string = lua.create_string(b"a\0\xff");
  let state = lua.current_thread().state();
  let top = unsafe { (*state).get_top() };
  let result = catch_unwind(AssertUnwindSafe(|| {
    let bytes = string.as_bytes();
    assert_eq!(bytes, b"a\0\xff");
    assert_eq!(unsafe { (*state).get_top() }, top);
    resume_unwind(Box::new(()));
  }));
  assert!(result.is_err());
  assert_eq!(unsafe { (*state).get_top() }, top);
  assert_eq!(string.as_bytes(), b"a\0\xff");
}
