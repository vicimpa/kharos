// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// `send` + `serde` together: the serde sentinel side table (the per-VM `null`
// table and array metatable cached for identity checks) must follow the VM
// across a thread move. It is a `define_vm_store!` table — thread-local
// without `send`, process-wide with it — precisely so that a VM created on one
// thread and driven (and dropped) on another finds its cached sentinel
// pointers again, instead of rebuilding sentinels that overwrite the registry
// rooting while values created on the origin thread stop matching. See
// `crates/ulua-rt/src/vm_store.rs` (rule 2) and `src/serde/mod.rs`.
//
// Gated on BOTH features; run with `--features send,serde`.

#![cfg(all(feature = "send", feature = "serde"))]

use std::thread;

use serde::{Deserialize, Serialize};
use ulua_rt::{Lua, LuaSerdeExt, Value};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct RoundTrip {
  a: Option<i32>,
  b: Option<String>,
}

/// Regression test (review R23): prime the sentinels on the origin thread,
/// move the VM to another thread, and check that `null`/array-metatable
/// identity and serde round-trips still hold there — including for values
/// created *before* the move — with the VM dropped on the target thread, and a
/// fresh VM on the origin thread not inheriting stale entries.
#[test]
fn test_serde_sentinels_survive_vm_move() {
  let lua = Lua::new();

  // Prime both sentinels on the ORIGIN thread; `null_before` outlives the move.
  let null_before: Value = lua.null();
  assert_eq!(
    lua.from_value::<Option<i32>>(null_before.clone()).unwrap(),
    None
  );
  let empty_array = lua.create_table();
  empty_array
    .set_metatable(Some(lua.array_metatable()))
    .unwrap();

  let moved = thread::spawn(move || {
    // `null` fetched on the TARGET thread and the pre-move one must both be
    // recognized (same sentinel — no re-rooting happened).
    let null_after: Value = lua.null();
    assert_eq!(lua.from_value::<Option<i32>>(null_after).unwrap(), None);
    assert_eq!(lua.from_value::<Option<i32>>(null_before).unwrap(), None);

    // A serde round-trip through Option None/Some, both directions.
    let v = lua
      .to_value(&RoundTrip {
        a: None,
        b: Some("x".to_string()),
      })
      .unwrap();
    assert_eq!(
      lua.from_value::<RoundTrip>(v).unwrap(),
      RoundTrip {
        a: None,
        b: Some("x".to_string())
      }
    );

    // The array metatable primed before the move still marks a table as an
    // array (identity check on the target thread).
    let json = sonic_rs::to_value(&Value::Table(empty_array)).unwrap();
    assert_eq!(json, sonic_rs::json!([]));

    // The VM (and `null_after`'s handle) drop HERE, on the target thread.
  });
  moved.join().unwrap();

  // A fresh VM on the ORIGIN thread must not inherit the dropped VM's sentinel
  // entry even if its state reuses the same address (this used to hit
  // `null_table`'s "sentinel is rooted" panic).
  let lua2 = Lua::new();
  let null2: Value = lua2.null();
  assert_eq!(lua2.from_value::<Option<i32>>(null2).unwrap(), None);
  assert_ne!(
    sonic_rs::to_value(&lua2.null()).unwrap(),
    sonic_rs::json!([])
  );
}
