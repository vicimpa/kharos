// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua's `tests/memory.rs`. ulua-rt implements the Luau-feasible
// GC + memory-limit surface: `Lua::used_memory`, `set_memory_limit`,
// `gc_collect` / `gc_stop` / `gc_restart` / `gc_is_running` / `gc_count` /
// `gc_step` / `gc_inc` / `gc_set_mode`, and the `state::{GcMode, GcIncParams,
// GcGenParams}` types.
//
// DEVIATION: Luau has a single **incremental** GC — it has no generational mode.
// The `GcMode::Generational` arms of mlua's `test_gc_control` are
// `#[cfg(any(feature = "lua55", feature = "lua54"))]` (i.e. not run under Luau
// anyway), so the Luau-active subset is ported verbatim. `test_gc_error`
// (`__gc` metamethod raising during collection) is `#[cfg(lua52/lua53)]` only —
// not applicable to Luau — and is omitted.

use std::sync::Arc;

use ulua_rt::{
  Error, Lua, Result, UserData, Value,
  state::{GcIncParams, GcMode},
};

#[test]
fn test_memory_limit() -> Result<()> {
  let lua = Lua::new();

  let initial_memory = lua.used_memory();
  assert!(
    initial_memory > 0,
    "used_memory reporting is wrong, lua uses memory for stdlib"
  );

  let f = lua
    .load("local t = {}; for i = 1,10000 do t[i] = i end")
    .into_function()?;
  f.call::<()>(()).expect("should trigger no memory limit");

  lua.set_memory_limit(initial_memory + 10000)?;
  match f.call::<()>(()) {
    Err(Error::MemoryError(_)) => {}
    something_else => panic!("did not trigger memory error: {:?}", something_else),
  };

  lua.set_memory_limit(0)?;
  f.call::<()>(()).expect("should trigger no memory limit");

  // Test memory limit during chunk loading
  lua.set_memory_limit(1024)?;
  match lua
    .load("local t = {}; for i = 1,10000 do t[i] = i end")
    .into_function()
  {
    Err(Error::MemoryError(_)) => {}
    _ => panic!("did not trigger memory error"),
  };

  Ok(())
}

#[test]
fn test_memory_limit_thread() -> Result<()> {
  let lua = Lua::new();

  let f = lua
    .load("local t = {}; for i = 1,10000 do t[i] = i end")
    .into_function()?;

  let thread = lua.create_thread(f)?;
  lua.set_memory_limit(lua.used_memory() + 10000)?;
  match thread.resume::<()>(()) {
    Err(Error::MemoryError(_)) => {}
    something_else => panic!("did not trigger memory error: {:?}", something_else),
  };

  Ok(())
}

#[test]
fn test_gc_control() -> Result<()> {
  let lua = Lua::new();
  let globals = lua.globals();

  // Luau is always running an incremental GC.
  assert!(lua.gc_is_running());
  lua.gc_stop();
  assert!(!lua.gc_is_running());
  lua.gc_restart();
  assert!(lua.gc_is_running());

  // `gc_set_mode(Incremental(..))` applies the params and reports the previous
  // (incremental) mode. (mlua's `Generational` arms are gated off for Luau.)
  assert!(matches!(
    lua.gc_set_mode(GcMode::Incremental({
      let p = GcIncParams::default().step_multiplier(100);
      // DEVIATION: mlua's non-luau path uses `.pause(200)`; on Luau the
      // analogous tunable is `.goal(200)`.
      p.goal(200)
    })),
    GcMode::Incremental(_)
  ));

  struct MyUserdata(Arc<()>);
  impl UserData for MyUserdata {}
  impl Drop for MyUserdata {
    fn drop(&mut self) {
      let _ = &self.0;
    }
  }

  let rc = Arc::new(());
  globals.set("userdata", lua.create_userdata(MyUserdata(rc.clone()))?)?;
  // DEVIATION: mlua's `Table::raw_remove(key)` accepts a string key; ulua-rt's
  // `raw_remove` is the array-index (`table.remove`) form, so we clear the
  // string slot with the equivalent `raw_set(key, nil)`.
  globals.raw_set("userdata", Value::Nil)?;

  assert_eq!(Arc::strong_count(&rc), 2);
  lua.gc_collect()?;
  lua.gc_collect()?;
  assert_eq!(Arc::strong_count(&rc), 1);

  Ok(())
}

/// S3 兑现文档承诺：`gc_inc` / `gc_set_mode` 返回**旧值**（cpp lapi.cpp
/// LUA_GCSET* 三臂均以旧值为返回值；未写穿的字段从 global_State 回读补齐）。
#[test]
fn gc_inc_and_set_mode_return_previous_params() {
  let lua = Lua::new();

  // 全零参数：一个 Set* 都不写穿，只回读现值（LUAI_GCGOAL 族默认值非零）
  let GcMode::Incremental(cur) = lua.gc_inc(0, 0, 0) else {
    unreachable!("Luau 恒为增量模式")
  };
  assert!(cur.get_goal().unwrap() > 0);
  assert!(cur.get_step_multiplier().unwrap() > 0);
  assert!(cur.get_step_size().unwrap() > 0);

  // 写穿 Set* 三参数：返回的旧值必须等于此前回读到的现值
  let next_goal = cur.get_goal().unwrap() + 1;
  let GcMode::Incremental(prev) = lua.gc_set_mode(GcMode::Incremental(
    GcIncParams::default()
      .goal(next_goal)
      .step_multiplier(150)
      .step_size(64),
  )) else {
    unreachable!("Luau 恒为增量模式")
  };
  assert_eq!(prev.get_goal(), cur.get_goal());
  assert_eq!(prev.get_step_multiplier(), cur.get_step_multiplier());
  assert_eq!(prev.get_step_size(), cur.get_step_size());

  // 再回读：看到刚写入的值（旧值链路自洽）
  let GcMode::Incremental(now) = lua.gc_set_mode(GcMode::Generational(Default::default())) else {
    unreachable!("生成式入参也必须回报增量模式")
  };
  assert_eq!(now.get_goal(), Some(next_goal));
  assert_eq!(now.get_step_multiplier(), Some(150));
  assert_eq!(now.get_step_size(), Some(64));

  // 部分写穿（gc_inc 只改 step_multiplier）：其余字段仍是回读旧值
  let GcMode::Incremental(prev2) = lua.gc_inc(-1, 200, -1) else {
    unreachable!("Luau 恒为增量模式")
  };
  assert_eq!(prev2.get_goal(), Some(next_goal));
  assert_eq!(prev2.get_step_multiplier(), Some(150));
  assert_eq!(prev2.get_step_size(), Some(64));
}

#[test]
fn test_gc_step_and_count() -> Result<()> {
  // Extra ulua-rt coverage (the `gc_count`/`gc_step` ops mlua exposes that
  // its `tests/memory.rs` doesn't directly exercise).
  let lua = Lua::new();

  assert!(lua.gc_count() > 0, "gc_count reports KB in use");

  // Allocate some garbage then run a few incremental steps; this should not
  // error and eventually a step completes a cycle.
  lua
    .load("local t = {}; for i = 1,1000 do t[i] = {} end")
    .exec()?;
  for _ in 0..100 {
    if lua.gc_step()? {
      break;
    }
  }
  lua.gc_collect()?;

  Ok(())
}
