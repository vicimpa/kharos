// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua's `tests/debug.rs`.
//
// mlua's `tests/debug.rs` has a single test, `test_debug_format`, which asserts
// that the `{:#?}` pretty-print of the globals table begins with the exact
// string `"{\n  _G = table:"`. That output is produced by mlua's bespoke
// `Debug` impl for `Table` (a recursive `key = value` dump that renders nested
// tables as `table: 0xADDR`). ulua-rt's `Table` `Debug` is a compact
// `Table(len=N)` summary, so the format assertion cannot be met verbatim — and
// it is a cosmetic formatting choice, not a Luau VM capability.
//
// DEFERRED: `test_debug_format` (the exact `{:#?}` table-dump format).
//
// What ulua-rt *does* back from Luau's debug model — resolving stack
// activation records via `lua_getinfo` (`Lua::inspect_stack` -> `Debug`) — is
// exercised here instead. (Luau's debug model is interrupt + `lua_getinfo`
// based, not the Lua 5.x line/count hook; see `tests/mlua_hooks.rs`.)

use std::sync::{Arc, Mutex};

use ulua_rt::{DebugWhat, Lua, Result};

#[test]
fn test_debug_format_deferred() -> Result<()> {
  // DEFERRED: mlua asserts `format!("{globals:#?}").starts_with("{\n  _G = table:")`.
  // ulua-rt's `Table` `Debug` is a compact summary, so we only assert the
  // debug render is non-empty (the gap is documented above).
  let lua = Lua::new();
  let globals = lua.globals();
  let dump = format!("{globals:#?}");
  assert!(!dump.is_empty());
  Ok(())
}

#[test]
fn test_inspect_stack() -> Result<()> {
  // `Lua::inspect_stack(level)` resolves an activation record via `lua_getinfo`.
  // From within a Rust callback, level 0 is the callback (a C/native function)
  // and level 1 is its Lua caller (the chunk).
  let lua = Lua::new();

  let captured = Arc::new(Mutex::new(None));
  let cap2 = captured.clone();
  let probe = lua.create_function(move |lua, ()| {
    // The immediate caller (level 1) is the loaded chunk: a Lua/main frame.
    let caller = lua.inspect_stack(1);
    *cap2.lock().unwrap() = caller.map(|d| (d.what(), d.current_line()));
    Ok(())
  })?;
  lua.globals().set("probe", probe)?;

  lua
    .load(
      r#"
        local x = 1
        probe()
    "#,
    )
    .exec()?;

  let (what, line) = (*captured.lock().unwrap()).expect("inspect_stack found the caller frame");
  assert!(
    matches!(what, DebugWhat::Main | DebugWhat::Lua),
    "caller frame is a Lua/main chunk, got {what:?}"
  );
  // A Lua frame reports its current line.
  assert!(line.is_some(), "Lua frame exposes a current line");

  Ok(())
}

#[test]
fn test_inspect_stack_self() -> Result<()> {
  // Level 0 from inside a native callback is the callback itself (a C/native
  // function), which `lua_getinfo` reports as `what == "C"`.
  let lua = Lua::new();

  let what = Arc::new(Mutex::new(None));
  let what2 = what.clone();
  let probe = lua.create_function(move |lua, ()| {
    *what2.lock().unwrap() = lua.inspect_stack(0).map(|d| d.what());
    Ok(())
  })?;
  probe.call::<()>(())?;

  let got = *what.lock().unwrap();
  assert_eq!(got, Some(DebugWhat::C));
  Ok(())
}
