//! Stack inspection. Mirrors the Luau-feasible subset of `mlua::Lua::inspect_stack`
//! and `mlua::debug::Debug`.
//!
//! ## What Luau can back
//!
//! Luau's debug model is **not** the Lua 5.x line/count hook. It exposes
//! `lua_getinfo(l, level, what, ar)` for activation records, plus
//! `lua_singlestep` and the interrupt callback for stepping. We surface the *informational* part —
//! resolving a stack level into a [`Debug`] record (current line, source, name,
//! what kind of function) — which maps cleanly onto `lua_getinfo`.
//!
//! ## What is deferred (and why)
//!
//! The full `mlua::Lua::set_hook(HookTriggers, ...)` API (per-line / per-N-
//! instruction / on-call / on-return hooks with a `Debug` event) is a Lua 5.x
//! construct. Luau has no equivalent multiplexed hook: it has a *single* global
//! interrupt callback (see [`Lua::set_interrupt`](crate::Lua::set_interrupt))
//! and `lua_singlestep`. mlua itself gates `tests/hooks.rs` and `tests/debug.rs`
//! behind `#![cfg(not(feature = "luau"))]` for exactly this reason. We therefore
//! do **not** fake a 5.x hook surface; the interrupt API is the Luau-native
//! analog and is implemented separately.

use crate::{
  state::{Lua, StateView},
  sys::*,
};

/// `lua_getinfo` 的选项模板：`n`（名字）+ `s`（源/类型）+ `l`（当前行）。
/// 静态字节切片，直传切片形 `what` 形参（§10：不经 C 指针契约位）。
const GETINFO_NSL: &[u8] = b"nsl";

/// 把 `LuaDebug` 回填的 owned 字节转成 Rust 字符串（`None` 原样透传）。
/// [`Lua::inspect_stack`] 与 `Function::info` 共用。
pub(crate) fn debug_string(bytes: Option<Vec<u8>>) -> Option<String> {
  bytes.map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `lua_getinfo` 的 safe 门面（本 crate 唯一 getinfo 边界）：以默认 `LuaDebug`
/// 作 out 参数按 `options` 模板回填，解析不到（VM 返回 ok==0）时给 `None`。
///
/// 调用序契约（正确性，非内存安全）：`state` 存活且由当前线程驱动；`level` 有效
/// （>=0 计帧数、-1 指栈顶——本仓库 Luau 的 `lua_getinfo` 无 5.x 的 `">"` 弹栈
/// 约定）；`options` 为不含 NUL 的 `'static` 模板串且不含 `f` 选项（含 `f` 会
/// 向栈压值，本门面不做栈配平）。
pub(crate) fn get_info(
  state: StateView<'_>,
  level: i32,
  options: &'static [u8],
) -> Option<LuaDebug> {
  debug_assert!(
    !options.contains(&0),
    "getinfo template must not contain NUL"
  );
  // `LuaDebug` 现是 Rust 原生记录（owned `Vec<u8>`/枚举/整数字段），`default()`
  // 即「未填写」的合法初值，不再需要 `mem::zeroed()`。
  let mut ar: LuaDebug = LuaDebug::default();
  // Safety: `state` 存活且由当前线程驱动（调用点句柄契约）；`&mut ar` 指向本帧
  // 对齐存活的局部；`options` 为上面 debug_assert 兜底的静态选项模板切片，
  // 满足 `what` 切片形参契约；VM 只向该 out 参数写 owned 字段。
  let ok = unsafe { lua_getinfo(state.as_ptr().cast_mut(), level, options, &mut ar) };
  (ok != 0).then_some(ar)
}

/// What kind of function an activation record refers to. Mirrors the relevant
/// part of `mlua::debug::DebugSource::what`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugWhat {
  /// A Lua function.
  Lua,
  /// The main chunk.
  Main,
  /// A C / Rust (native) function.
  C,
  /// Unknown / unavailable.
  Unknown,
}

/// A snapshot of one activation record, resolved from a stack level via
/// `lua_getinfo`. Mirrors the informational subset of `mlua::debug::Debug`.
#[derive(Debug, Clone)]
pub struct Debug {
  name: Option<String>,
  what: DebugWhat,
  source: Option<String>,
  short_src: Option<String>,
  current_line: Option<i64>,
  line_defined: Option<i64>,
}

impl Debug {
  /// The function's name, if known (`(n)`).
  pub fn name(&self) -> Option<&str> {
    self.name.as_deref()
  }

  /// What kind of function this record refers to (`(s)`).
  pub fn what(&self) -> DebugWhat {
    self.what
  }

  /// The chunk source (`(s)`).
  pub fn source(&self) -> Option<&str> {
    self.source.as_deref()
  }

  /// A short, human-readable source description (`(s)`).
  pub fn short_src(&self) -> Option<&str> {
    self.short_src.as_deref()
  }

  /// The currently executing line (`(l)`), if available.
  pub fn current_line(&self) -> Option<i64> {
    self.current_line
  }

  /// The line where the function was defined (`(s)`).
  pub fn line_defined(&self) -> Option<i64> {
    self.line_defined
  }
}

impl Lua {
  /// Inspect the activation record `level` frames up the call stack (0 = the
  /// currently running function). Returns `None` if there is no function at
  /// that level. Mirrors the Luau-feasible part of `mlua::Lua::inspect_stack`.
  pub fn inspect_stack(&self, level: usize) -> Option<Debug> {
    let state = self.state();
    // `get_info`（safe 门面）收口零初始化 + `lua_getinfo` out 参数两步；
    // `GETINFO_NSL` 是静态 NUL 结尾模板串，满足其形参契约。ok==0 时不读 `ar`。
    let ar = get_info(state, level as i32, GETINFO_NSL)?;
    // 仅按 Rust 原生字段读 `ar`（owned 字节经 `debug_string` 转 `String`，`what`
    // 是 `LuaWhat` 枚举），不再触任何 C 边界，故无 unsafe。
    let what = match ar.what {
      LuaWhat::Lua => DebugWhat::Lua,
      LuaWhat::Main => DebugWhat::Main,
      LuaWhat::C => DebugWhat::C,
      LuaWhat::Tail | LuaWhat::Unknown => DebugWhat::Unknown,
    };
    let current_line = (ar.currentline >= 0).then_some(ar.currentline as i64);
    let line_defined = (ar.linedefined > 0).then_some(ar.linedefined as i64);
    Some(Debug {
      name: debug_string(ar.name),
      what,
      source: debug_string(ar.source),
      short_src: debug_string(ar.short_src),
      current_line,
      line_defined,
    })
  }
}
