//! 求值类端到端测试（`string_format` / `os_date`）共用的同构样板：把源码经
//! runtime 求值为 `String`，以及 `check(expr, expected)` 断言包装。
//! 各 `tests/*.rs` 以 `mod common;` 引入；导出面按实际消费收敛，不以
//! allow 属性豁免 dead_code（沿用 `ulua-vm/tests/common/mod.rs` 的纪律）。

use ulua_rt::{Lua, Result};

/// 新建 VM，加载并求值 `src`，取回 `String` 结果。
pub fn eval(src: &str) -> Result<String> {
  Lua::new().load(src).eval::<String>()
}

/// 断言表达式 `expr`（自动包 `return`）求值结果与 `expected` 逐字节一致。
pub fn check(expr: &str, expected: &str) {
  assert_eq!(eval(&format!("return {expr}")).unwrap(), expected, "{expr}");
}
