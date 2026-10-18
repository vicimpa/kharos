// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported (in spirit) from mlua's `tests/hooks.rs`.
//
// IMPORTANT: mlua's entire `tests/hooks.rs` is gated `#![cfg(not(feature = "luau"))]`
// — i.e. mlua itself does **not** run any of these tests under Luau. The reason
// is fundamental: the Lua 5.x debug-hook API (`Lua::set_hook(HookTriggers, ..)`
// with per-line / per-N-instruction / on-call / on-return events and a `Debug`
// event passed to the hook) does not exist in Luau. Luau replaces it with a
// single global **interrupt** callback (`Lua::set_interrupt`) plus
// `lua_singlestep`. There is no `HookTriggers`, no `DebugEvent`, and no
// per-line / per-instruction multiplexing. Faking a 5.x hook surface that the
// Luau VM cannot back would be dishonest, so it is **DEFERRED** as
// not-applicable.
//
// Deferred mlua hook tests (each needs the Lua 5.x `HookTriggers` hook API):
//   - test_hook_triggers, test_line_counts, test_function_calls,
//     test_limit_execution_instructions, test_hook_removal,
//     test_hook_swap_within_hook, test_hook_threads, test_hook_yield,
//     test_global_hook  -> all need `set_hook(HookTriggers, ..)` / `DebugEvent`.
//   - test_error_within_hook -> the "error raised from a hook propagates"
//     behavior; the Luau-native analog (error from an *interrupt*) is covered
//     below (`test_error_within_interrupt`) and in `tests/mlua_luau.rs`.
//
// The tests below exercise the Luau-native equivalents of what the deferred
// hook tests prove — observe execution, limit execution, and propagate an error
// raised mid-execution — using the interrupt callback Luau actually provides.

use std::sync::{
  Arc,
  atomic::{AtomicI64, AtomicU64, Ordering},
};

use ulua_rt::{Error, Lua, Result, VmState};

#[test]
fn test_interrupt_observes_execution() -> Result<()> {
  // Luau analog of mlua's `test_line_counts` / `test_function_calls`: the
  // interrupt fires repeatedly while code runs, letting us observe execution
  // progress (the closest Luau gives to a per-line/per-call hook).
  let lua = Lua::new();

  let count = Arc::new(AtomicU64::new(0));
  let count2 = count.clone();
  lua.set_interrupt(move |_| {
    count2.fetch_add(1, Ordering::Relaxed);
    Ok(VmState::Continue)
  });

  lua
    .load(
      r#"
            local x = 2 + 3
            local y = x * 63
            local z = string.len(x..", "..y)
        "#,
    )
    .exec()?;

  lua.remove_interrupt();
  assert!(
    count.load(Ordering::Relaxed) > 0,
    "interrupt observed execution"
  );

  Ok(())
}

#[test]
fn test_limit_execution_via_interrupt() -> Result<()> {
  // Luau analog of mlua's `test_limit_execution_instructions`: use the
  // interrupt to enforce an execution budget and abort with an error once it
  // is exhausted.
  let lua = Lua::new();

  let budget = Arc::new(AtomicI64::new(1000));
  let budget2 = budget.clone();
  lua.set_interrupt(move |_| {
    if budget2.fetch_sub(1, Ordering::Relaxed) <= 1 {
      Err(Error::runtime("time's up"))
    } else {
      Ok(VmState::Continue)
    }
  });

  lua.globals().set("x", 0i64)?;
  let err = lua
    .load(
      r#"
                for i = 1, 1000000 do
                    x = x + 1
                end
            "#,
    )
    .exec()
    .expect_err("execution budget should be exhausted");
  match err {
    Error::RuntimeError(msg) => assert_eq!(msg, "time's up"),
    other => panic!("expected RuntimeError(\"time's up\"), got {other:?}"),
  }

  lua.remove_interrupt();
  Ok(())
}

#[test]
fn test_error_within_interrupt() -> Result<()> {
  // Luau analog of mlua's `test_error_within_hook`: an error raised inside the
  // interrupt propagates out through the code that was executing.
  let lua = Lua::new();

  lua.set_interrupt(|_| Err(Error::runtime("Something happened in there!")));

  let err = lua
    .load("local x = 1; x = x + 1")
    .exec()
    .expect_err("error in interrupt didn't propagate");
  match err {
    Error::RuntimeError(msg) => assert_eq!(msg, "Something happened in there!"),
    err => panic!("expected `RuntimeError` with a specific message, got {err:?}"),
  }

  lua.remove_interrupt();
  Ok(())
}

#[test]
fn test_interrupt_removal() -> Result<()> {
  // Luau analog of mlua's `test_hook_removal`: once removed, the interrupt no
  // longer fires (so an erroring interrupt stops affecting execution).
  let lua = Lua::new();

  lua.set_interrupt(|_| Err(Error::runtime("this interrupt should've been removed")));
  assert!(lua.load("local x = 1; x = x + 1").exec().is_err());

  lua.remove_interrupt();
  assert!(lua.load("local x = 1; x = x + 1").exec().is_ok());

  Ok(())
}
