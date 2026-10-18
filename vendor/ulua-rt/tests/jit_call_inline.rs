//! JIT call inlining 第 2 阶段守卫专项：观测路径内联的逐值一致性与守卫失败回退。
//!
//! 验证法：同一负载在「jit 开（load 即编译，观测触发暖重编译后走内联）」与
//! 「jit 关（纯解释）」两次求值逐位对照——内联语义必须与未内联完全一致。
//!
//! 负载四面：
//! 1. 带参 callee 内联：帧映射 ra+1+k 的参数/返回对位（回归阶段 1 的错位缺陷）；
//! 2. 常量操作数物化（eval_a 形态：types 未定的参数算术 + VmConst number）；
//! 3. 多 RETURN callee（刀 B：各 RETURN 点折叠到同一后继）；
//! 4. 守卫失败/通过（刀 A 语义命门）：热身同站点后换闭包——同 proto 新闭包
//!    （funid 守卫通过，内联体直接服务新闭包）、跨 proto 新闭包（守卫失败落
//!    常规 CALL）；NAMECALL 阶段加表读方法体与换方法表（`__index` 函数慢路
//!    解析出新方法闭包，CALL 守卫失败落常规 CALL）。
//!
//! 观测触发依赖 fflag `LuauJitCallInlineObs`/`LuauJitCallInline`（rt 的
//! `set_luau_bool_flags(true)` 点亮 Luau* 前缀）与负载内 ≥200 次恒定调用；
//! 循环规模 5000 跨过阈值且保持用例毫秒级。

#![cfg(feature = "jit")]

use std::fs::read_to_string;

use ulua_rt::{Lua, Result};

/// 同一负载跑 JIT/解释器两次，逐位对照。
fn assert_pair(src: &str) -> Result<()> {
  let jit = {
    let lua = Lua::new();
    lua.enable_jit(true)?;
    let v: i64 = lua.load(src).eval()?;
    v
  };
  let interp = {
    let lua = Lua::new();
    let v: i64 = lua.load(src).eval()?;
    v
  };
  assert_eq!(jit, interp, "JIT 内联结果与解释器不一致");
  Ok(())
}

/// 带参 callee + VmConst number 物化（观测站点：eval_like）。
const ARGS_AND_CONST: &str = r#"
local function eval_like(i)
  return 1.0 / (i * (i + 1) / 2.0 + i + 1.0)
end
local acc = 0
for i = 1, 5000 do
  acc = acc + eval_like(i)
end
return acc
"#;

/// 多 RETURN callee（刀 B）：早退 RETURN 与末尾 RETURN 各一。
const MULTI_RETURN: &str = r#"
local function f(n)
  if n < 2 then return n end
  return n * n
end
local acc = 0
for i = 1, 5000 do
  acc = acc + f(i)
end
return acc
"#;

/// 守卫失败→回退：热身 add1 后整站换 add2（跨 proto 新闭包）。
const GUARD_FAIL_RETIRE: &str = r#"
local function add1(x)
  return x + 1
end
local acc = 0
local f = add1
for i = 1, 5000 do
  acc = acc + f(i)
end
f = function(x)
  return x + 2
end
for i = 1, 5000 do
  acc = acc + f(i)
end
return acc
"#;

/// 守卫通过→新闭包直用：热身 mk() 的首个闭包后换同 proto 新闭包（funid 恒等，
/// proto 守卫通过，内联体直接服务新闭包——闭包指针守卫做不到的形态）。
const GUARD_PASS_REBIND: &str = r#"
local function mk()
  return function(x)
    return x + 3
  end
end
local acc = 0
local f = mk()
for i = 1, 5000 do
  acc = acc + f(i)
end
f = mk()
for i = 1, 5000 do
  acc = acc + f(i)
end
return acc
"#;

#[test]
fn jit_call_inline_args_and_const_materialize() -> Result<()> {
  assert_pair(ARGS_AND_CONST)
}

#[test]
fn jit_call_inline_multi_return() -> Result<()> {
  assert_pair(MULTI_RETURN)
}

#[test]
fn jit_call_inline_guard_fail_falls_back() -> Result<()> {
  assert_pair(GUARD_FAIL_RETIRE)
}

#[test]
fn jit_call_inline_guard_pass_same_proto() -> Result<()> {
  assert_pair(GUARD_PASS_REBIND)
}

/// 构造器 + setmetatable 形态（oop 骨架）：new 调用站点观测触发暖重编译，
/// 后续 new 的表构造/setmetatable 链必须逐值一致。
const CTOR_META: &str = r#"
local Base = {}
Base.__index = Base
function Base.new(x, y)
  return setmetatable({ x = x, y = y }, Base)
end
local acc = 0
for i = 1, 5000 do
  local o = Base.new(i, i + 1)
  acc = acc + o.x + o.y
end
return acc
"#;

#[test]
fn jit_call_inline_ctor_metatable() -> Result<()> {
  assert_pair(CTOR_META)
}

/// runner 的 oop.lua 全量负载（多级继承 + NAMECALL 热环）同源对照。
#[test]
fn jit_call_inline_oop_full() -> Result<()> {
  let manifest = env!("CARGO_MANIFEST_DIR");
  let src =
    read_to_string(format!("{manifest}/../../benchmarks/cases/oop.lua")).expect("oop.lua 可读");
  let jit = {
    let lua = Lua::new();
    lua.enable_jit(true)?;
    let v: i64 = lua.load(&src).eval()?;
    v
  };
  let interp = {
    let lua = Lua::new();
    let v: i64 = lua.load(&src).eval()?;
    v
  };
  assert_eq!(jit, interp, "oop 全量负载 JIT 与解释器不一致");
  Ok(())
}

/// NAMECALL 虚调用内联：GETTABLEKS 方法体 + 多站热环（inherit3/oop 主形态）。
const NAMECALL_TABLEKS: &str = r#"
local t = {}
t.__index = t
function t:get()
  return self.x + 1
end
function t:dot(other)
  return self.x * other.x + self.y * other.y
end
local o = setmetatable({ x = 1, y = 2 }, t)
local b = setmetatable({ x = 3, y = 4 }, t)
local a = 0
for i = 1, 5000 do
  a = a + o:get() + o:dot(b)
end
return a
"#;

/// 守卫失败（NAMECALL 形态）：热身 t:get 后把实例换到另一套方法表（跨 proto
/// 新方法闭包）——proto 守卫失败必须落常规 NAMECALL+CALL 路径，逐值一致。
const NAMECALL_GUARD_FAIL_RETABLE: &str = r#"
local t = {}
t.__index = t
function t:get()
  return self.x + 1
end
local u = { __index = function(_, k)
  if k == "get" then
    return function(self)
      return self.x + 100
    end
  end
  return nil
end }
local a = 0
local o = setmetatable({ x = 1 }, t)
for i = 1, 5000 do
  a = a + o:get()
end
o = setmetatable({ x = 2 }, u)
for i = 1, 5000 do
  a = a + o:get()
end
return a
"#;

/// 守卫通过（NAMECALL 形态）：热身后换同方法表的新实例（同 proto 新闭包，
/// funid 恒等）——内联体直接服务新闭包。
const NAMECALL_GUARD_PASS_REBIND: &str = r#"
local t = {}
t.__index = t
function t:get()
  return self.x + 1
end
local a = 0
local o = setmetatable({ x = 1 }, t)
for i = 1, 5000 do
  a = a + o:get()
end
o = setmetatable({ x = 7 }, t)
for i = 1, 5000 do
  a = a + o:get()
end
return a
"#;

#[test]
fn jit_call_inline_namecall_tableks() -> Result<()> {
  assert_pair(NAMECALL_TABLEKS)
}

#[test]
fn jit_call_inline_namecall_guard_fail_retable() -> Result<()> {
  assert_pair(NAMECALL_GUARD_FAIL_RETABLE)
}

#[test]
fn jit_call_inline_namecall_guard_pass_rebind() -> Result<()> {
  assert_pair(NAMECALL_GUARD_PASS_REBIND)
}
