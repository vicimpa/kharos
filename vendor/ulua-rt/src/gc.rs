//! Garbage-collector control. Mirrors `mlua::Lua`'s `gc_*` surface and the
//! `mlua::state::{GcMode, GcIncParams, GcGenParams}` types.
//!
//! Luau ships a single **incremental** GC (no generational mode). The control
//! ops map onto ulua's `lua_gc`:
//!
//! | mlua                | `lua_gc` op         |
//! |---------------------|---------------------|
//! | `gc_collect`        | `LUA_GCCOLLECT`     |
//! | `gc_stop`           | `LUA_GCSTOP`        |
//! | `gc_restart`        | `LUA_GCRESTART`     |
//! | `gc_is_running`     | `LUA_GCISRUNNING`   |
//! | `gc_count`          | `LUA_GCCOUNT`/`..B` |
//! | `gc_step`           | `LUA_GCSTEP`        |
//! | `gc_inc(goal,mul,sz)`| `LUA_GCSETGOAL/..` |
//!
//! **DEVIATION:** Luau has no generational GC, so `gc_gen` and
//! `GcMode::Generational` are not backed by the VM. `gc_set_mode` accepts the
//! incremental mode (applying its params) and *reports* the previous mode as
//! incremental **with its VM 现值参数**（Set* 写穿回读的旧值 + global_State
//! 回读）; passing `Generational` is a no-op that returns the current
//! (incremental) mode, matching the only behavior Luau can honor.

use crate::{
  error::Result,
  state::{Lua, run_gc},
  sys::*,
};

/// Parameters for Luau's incremental GC, mirroring `mlua::state::GcIncParams`.
///
/// On Luau the tunables are the **goal** (heap-growth target percentage),
/// the **step multiplier**, and the **step size** (KB). (Lua 5.x's `pause` is
/// replaced by `goal` here — see [`GcIncParams::goal`].)
#[derive(Debug, Clone, Copy, Default)]
pub struct GcIncParams {
  pub(crate) goal: Option<u32>,
  pub(crate) step_multiplier: Option<u32>,
  pub(crate) step_size: Option<u32>,
}

impl GcIncParams {
  /// The heap-growth goal (percentage). Luau's analog of Lua's `pause`.
  /// Mirrors `mlua::state::GcIncParams::goal`.
  pub fn goal(mut self, goal: u32) -> Self {
    self.goal = Some(goal);
    self
  }

  /// The GC step multiplier (percentage of allocation to collect per step).
  /// Mirrors `mlua::state::GcIncParams::step_multiplier`.
  pub fn step_multiplier(mut self, mul: u32) -> Self {
    self.step_multiplier = Some(mul);
    self
  }

  /// The GC step size in KB. Mirrors `mlua::state::GcIncParams::step_size`.
  pub fn step_size(mut self, size: u32) -> Self {
    self.step_size = Some(size);
    self
  }

  /// The current goal value, if set. Mirrors `mlua::state::GcIncParams::goal`.
  pub fn get_goal(&self) -> Option<u32> {
    self.goal
  }

  /// The current step multiplier value, if set.
  /// Mirrors `mlua::state::GcIncParams::step_multiplier`.
  pub fn get_step_multiplier(&self) -> Option<u32> {
    self.step_multiplier
  }

  /// The current step size value (KB), if set.
  /// Mirrors `mlua::state::GcIncParams::step_size`.
  pub fn get_step_size(&self) -> Option<u32> {
    self.step_size
  }
}

/// Parameters for a generational GC, mirroring `mlua::state::GcGenParams`.
///
/// **DEVIATION:** Luau has no generational GC; this exists only for signature
/// parity with mlua's Lua 5.4/5.5 surface and is never honored by the VM.
#[derive(Debug, Clone, Copy, Default)]
pub struct GcGenParams {
  pub minor_multiplier: u32,
  pub major_multiplier: u32,
}

/// The GC operating mode, mirroring `mlua::state::GcMode`.
///
/// Luau only supports [`GcMode::Incremental`]; [`GcMode::Generational`] is
/// provided for signature parity and is treated as a no-op by [`Lua::gc_set_mode`].
#[derive(Debug, Clone, Copy)]
pub enum GcMode {
  /// Incremental GC (the only mode Luau supports).
  Incremental(GcIncParams),
  /// Generational GC — **not supported by Luau** (see the module note).
  Generational(GcGenParams),
}

impl Lua {
  /// The number of bytes currently used by the VM. Mirrors
  /// `mlua::Lua::used_memory` (ulua's `totalbytes`).
  pub fn used_memory(&self) -> usize {
    // Safety: `self.state()` 是存活 VM 的主状态;其 `global` 字段在
    // `lua_newstate` 初始化时接线、`lua_close` 前不移除,且 `global_State`
    // 生命周期覆盖整个 VM(含所有协程),比 `&self` 借用长。`totalbytes`
    // 是纯 usize 计数字段,任意时刻读数都有定义。
    let g = unsafe { &*self.state().global };
    g.totalbytes
  }

  /// Whether the GC is currently running. Mirrors `mlua::Lua::gc_is_running`.
  pub fn gc_is_running(&self) -> bool {
    // `run_gc`(state.rs safe 门面,`lua_gc` 收口点):`Isrunning` 查询只读
    // GC 阶段标志、不触发收集,也不压栈。
    run_gc(self.state(), LuaGcOp::Isrunning as i32, 0) != 0
  }

  /// Stop the GC. Mirrors `mlua::Lua::gc_stop`.
  pub fn gc_stop(&self) {
    // `run_gc` 门面:`Stop` 只翻转暂停标志,无栈/堆副作用。
    run_gc(self.state(), LuaGcOp::Stop as i32, 0);
  }

  /// Restart the GC. Mirrors `mlua::Lua::gc_restart`.
  pub fn gc_restart(&self) {
    // `run_gc` 门面:`Restart` 只恢复暂停标志,无栈/堆副作用。
    run_gc(self.state(), LuaGcOp::Restart as i32, 0);
  }

  /// The total memory in use, in KB (the `LUA_GCCOUNT` op). mlua 0.12.1 has
  /// no `gc_count`; the name follows mlua's historical API.
  pub fn gc_count(&self) -> usize {
    // `run_gc` 门面:`Count` 为纯读数 op(totalbytes>>10,不压栈不改状态);
    // 返回值非负,`.max(0)` 只是与 mlua 一致的对 i32 防御。
    run_gc(self.state(), LuaGcOp::Count as i32, 0).max(0) as usize
  }

  /// Run a default-size incremental GC step. Mirrors `mlua::Lua::gc_step`.
  pub fn gc_step(&self) -> Result<bool> {
    // `run_gc` 门面:`Step` 在宿主驱动点推进增量收集一小段;此处不持有栈上裸
    // 引用,Luau GC 不移动对象,返回值仅表示是否完成一轮。
    Ok(run_gc(self.state(), LuaGcOp::Step as i32, 0) != 0)
  }

  /// Apply incremental-GC parameters (goal / step multiplier / step size).
  /// mlua 0.12.1 has no `gc_inc`; the naming follows mlua's historical API
  /// while the semantics map onto `LUA_GCSETGOAL/SETSTEPMUL/SETSTEPSIZE`.
  /// Returns the previous [`GcMode`] (always incremental on Luau).
  pub fn gc_inc(&self, pause: i32, step_multiplier: i32, step_size: i32) -> GcMode {
    // mlua maps `pause` -> goal on the Luau backend; non-positive values are
    // left untouched.
    GcMode::Incremental(self.apply_inc_params(&GcIncParams {
      goal: (pause > 0).then_some(pause as u32),
      step_multiplier: (step_multiplier > 0).then_some(step_multiplier as u32),
      step_size: (step_size > 0).then_some(step_size as u32),
    }))
  }

  /// Set the GC mode, returning the previous mode. Mirrors
  /// `mlua::Lua::gc_set_mode`.
  ///
  /// **DEVIATION:** Luau is always incremental. Passing
  /// [`GcMode::Incremental`] applies its params and returns the prior
  /// (incremental) mode; passing [`GcMode::Generational`] is a no-op that
  /// returns the current incremental mode (params read back from the VM).
  pub fn gc_set_mode(&self, mode: GcMode) -> GcMode {
    match &mode {
      GcMode::Incremental(p) => GcMode::Incremental(self.apply_inc_params(p)),
      // 生成式模式不写穿任何参数：直接回读现值（与 Set* 写穿返回的旧值同源）。
      GcMode::Generational(_) => GcMode::Incremental(self.current_inc_params()),
    }
  }

  /// 回读 VM 当前增量 GC 参数；step size 按 KB 计，与 `lua_gc` Setstepsize
  /// 的字节↔KB 换算（`>> 10`，cpp lapi.cpp 同款字面量）一致。
  fn current_inc_params(&self) -> GcIncParams {
    // Safety: `state.global` 的解引用前提同 `used_memory`(构造期接线、比持有者
    // 长寿)。`gcgoal/gcstepmul/gcstepsize` 是 `global_State` 的整型调参字段,
    // 任意位模式读取都有定义;`max(0)` 吸收 u32 域外值,`>> 10` 与 `lua_gc`
    // Setstepsize 的字节↔KB 换算(cpp lapi.cpp)保持一致。
    let g = unsafe { &*self.state().global };
    GcIncParams {
      goal: Some(g.gcgoal.max(0) as u32),
      step_multiplier: Some(g.gcstepmul.max(0) as u32),
      step_size: Some((g.gcstepsize >> 10).max(0) as u32),
    }
  }

  /// Apply the set incremental-GC parameters to the VM (`lua_gc` set-ops) and
  /// return the parameters as they were **before** applying. Shared by
  /// [`Lua::gc_inc`] and [`Lua::gc_set_mode`]。字段是 u32 域值，
  /// `as i32` 只出现在这里——`lua_gc` 的 vararg 形参边界。
  fn apply_inc_params(&self, p: &GcIncParams) -> GcIncParams {
    // cpp lapi.cpp 的 LUA_GCSETGOAL/SETSTEPMUL/SETSTEPSIZE 均以旧值为返回值，
    // 这里照单收集；未被本次设置的字段以 global_State 回读补齐。
    let state = self.state();
    let mut prev = self.current_inc_params();
    // `run_gc` 门面:`Setgoal/Setstepmul/Setstepsize` 是 VM 认识的写参 op,
    // 各只改一个 `global_State` 整型字段并返回旧值,无栈/GC 副作用。`u32 as i32`
    // 传参在 ABI 层恒合法(超大值由 VM 侧钳位处理,是行为而非内存问题);各调用
    // 之间无中间态解引用,`prev` 的收集顺序不影响正确性。
    if let Some(goal) = p.goal {
      // `Setgoal` 写 `gcgoal` 字段并返回旧值。
      let old = run_gc(state, LuaGcOp::Setgoal as i32, goal as i32);
      prev.goal = Some(old.max(0) as u32);
    }
    if let Some(mul) = p.step_multiplier {
      // `Setstepmul` 写 `gcstepmul` 字段并返回旧值。
      let old = run_gc(state, LuaGcOp::Setstepmul as i32, mul as i32);
      prev.step_multiplier = Some(old.max(0) as u32);
    }
    if let Some(sz) = p.step_size {
      // `Setstepsize` 写 `gcstepsize` 字段并返回旧值;返回旧值已按 KB 计(>>10),
      // 与本字段单位一致。
      let old = run_gc(state, LuaGcOp::Setstepsize as i32, sz as i32);
      prev.step_size = Some(old.max(0) as u32);
    }
    prev
  }
}
