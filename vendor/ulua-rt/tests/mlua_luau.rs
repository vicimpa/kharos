// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// The Luau-relevant subset of mlua's `tests/luau.rs`.
//
// Phase 2 added the Luau-specific runtime types: the **vector** tests below,
// and **buffer** coverage in its own file (`tests/mlua_buffer.rs`).
//
// Phase 5a (this pass) added the `Compiler` builder, `Chunk::set_compiler` /
// `Lua::set_compiler`, `Lua::set_type_metatable`, `Lua::sandbox` /
// `Lua::set_safeenv` / `Thread::sandbox`, `Lua::set_interrupt` /
// `remove_interrupt` + `VmState`, `Lua::set_fflag`, the memory-category API,
// and `Chunk::call`. The now-implementable tests below are ported (the vector
// *fastcall* + metatable halves, sandbox, interrupts, fflags, memory category,
// and i64 round-tripping).
//
// Still DEFERRED (each hits something Luau-as-ulua genuinely lacks, noted at
// the matching test below):
//   - `test_sandbox`'s `collectgarbage` section -> ulua's base library does
//     not register `collectgarbage` (upstream Luau registers it only in the
//     CLI/REPL, not `luaL_openlibs`); the sandbox readonly/safeenv/thread
//     parts ARE ported (see `test_sandbox`).
//   - `test_heap_dump`            -> ulua's VM tracks only bytes-per-category
//     (`memcatbytes[256]`); it does not enumerate live objects by Lua type or
//     by Rust userdata-type within a category, which `HeapDump::size_by_type`
//     / `size_by_userdata` require. Deferred (`test_heap_dump_deferred`).
//   - `test_integer64_type`'s native `42i` literal + `integer` library
//     -> ulua registers the i64 lib as `int64` (not `integer`) and the
//     `LuauIntegerType2` native i64 VM type is not wired through `Value`; the
//     plain i64 round-trip IS covered (`test_integer_type`).
//   - `test_typeof_error`         -> ulua-rt carries `Value::Error` as a
//     string (it has no tagged error userdata), so `typeof(err)` reports
//     "string", not "error". Deferred (`test_typeof_error_deferred`).
//   - `test_loadstring`           -> `loadstring` is not registered by ulua's
//     base library (same reason as `collectgarbage`); the analog is
//     `Lua::load(...).into_function()` (see `test_load_from_rust`).
//   - `mod require`               -> the `require` submodule (path resolution).

use std::{
  fmt::Debug,
  sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
  },
};

use ulua_rt::{Compiler, Error, Lua, Result, Table, Value, Vector, VmState};

#[test]
fn test_version() -> Result<()> {
  let lua = Lua::new();
  // DEVIATION: ulua's VM reports `_VERSION` as the bare string `"Luau"` (no
  // trailing ` 0.<minor>` like upstream/mlua's bundled Luau), so this checks
  // the `"Luau"` prefix rather than `"Luau 0."`. The API surface exercised
  // (`globals().get::<String>`) is unchanged.
  assert!(lua.globals().get::<String>("_VERSION")?.starts_with("Luau"));
  Ok(())
}

#[test]
fn test_vectors() -> Result<()> {
  let lua = Lua::new();

  let v: Vector = lua
    .load("vector.create(1, 2, 3) + vector.create(3, 2, 1)")
    .eval()?;
  assert_eq!(v, [4.0, 4.0, 4.0]);

  // Test conversion into Rust array
  let v: [f64; 3] = lua.load("vector.create(1, 2, 3)").eval()?;
  assert!(v == [1.0, 2.0, 3.0]);

  // Test vector methods
  lua
    .load(
      r#"
        local v = vector.create(1, 2, 3)
        assert(v.x == 1)
        assert(v.y == 2)
        assert(v.z == 3)
    "#,
    )
    .exec()?;

  // Test vector methods (fastcall) — drives the `set_vector_ctor` compile path.
  lua
    .load(
      r#"
        local v = vector.create(1, 2, 3)
        assert(v.x == 1)
        assert(v.y == 2)
        assert(v.z == 3)
    "#,
    )
    .set_compiler(Compiler::new().set_vector_ctor("vector"))
    .exec()?;

  Ok(())
}

#[test]
fn test_vector_metatable() -> Result<()> {
  let lua = Lua::new();

  let vector_mt = lua
    .load(
      r#"
            {
                __index = {
                    new = vector.create,

                    product = function(a, b)
                        return vector.create(a.x * b.x, a.y * b.y, a.z * b.z)
                    end
                }
            }
    "#,
    )
    .eval::<Table>()?;
  vector_mt.set_metatable(Some(vector_mt.clone()))?;
  lua.set_type_metatable::<Vector>(Some(vector_mt.clone()));
  lua.globals().set("Vector3", vector_mt)?;

  let compiler = Compiler::new()
    .set_vector_ctor("Vector3.new")
    .set_vector_type("Vector3");

  // Test vector methods (fastcall)
  lua
    .load(
      r#"
        local v = Vector3.new(1, 2, 3)
        local v2 = v:product(Vector3.new(2, 3, 4))
        assert(v2.x == 2 and v2.y == 6 and v2.z == 12)
    "#,
    )
    .set_compiler(compiler)
    .exec()?;

  Ok(())
}

#[test]
fn test_vector_roundtrip() -> Result<()> {
  // Additional Luau-vector coverage (not in mlua's luau.rs): round-trip a
  // `Vector` built on the Rust side through Lua and back, exercising
  // `Lua::create_vector`, the component accessors, `IntoLua`/`FromLua`, and
  // `Value::Vector` equality in both directions.
  let lua = Lua::new();

  let v = lua.create_vector(1.5, -2.0, 3.25);
  assert_eq!(v.x(), 1.5);
  assert_eq!(v.y(), -2.0);
  assert_eq!(v.z(), 3.25);

  let echo = lua.create_function(|_, v: Vector| Ok(v))?;
  let back: Vector = echo.call(v)?;
  assert_eq!(back, v);
  assert_eq!(back, [1.5, -2.0, 3.25]);

  // A vector passed in from Rust is observable as the Luau `vector` type.
  let described: String = lua
    .create_function(|_, v: Vector| Ok(format!("{},{},{}", v.x(), v.y(), v.z())))?
    .call(lua.create_vector(4.0, 5.0, 6.0))?;
  assert_eq!(described, "4,5,6");

  Ok(())
}

#[test]
fn test_load_from_rust() -> Result<()> {
  // DEVIATION: mlua's `test_loadstring` exercises the Lua-level `loadstring`
  // builtin, which ulua's base library does not register. The ulua-rt
  // analog is `Lua::load(...).into_function()`, which compiles a string into a
  // callable function — exercised here with the same observable result.
  let lua = Lua::new();

  let f = lua.load("return 123").into_function()?;
  assert_eq!(f.call::<i32>(())?, 123);

  Ok(())
}

#[test]
fn test_readonly_table() -> Result<()> {
  let lua = Lua::new();

  let t = lua.create_sequence_from([1])?;
  assert!(!t.is_readonly());
  t.set_readonly(true);
  assert!(t.is_readonly());

  fn check_readonly_error<T: Debug>(res: Result<T>) {
    match res {
      Err(Error::RuntimeError(e)) if e.contains("attempt to modify a readonly table") => {}
      r => panic!("expected readonly RuntimeError, got {r:?}"),
    }
  }

  check_readonly_error(t.set("key", "value"));
  check_readonly_error(t.raw_set("key", "value"));
  check_readonly_error(t.raw_insert(1, "value"));
  check_readonly_error(t.raw_remove(1));
  check_readonly_error(t.push("value"));
  check_readonly_error(t.pop::<Value>());
  check_readonly_error(t.raw_push("value"));
  check_readonly_error(t.raw_pop::<Value>());

  // Special case: cannot change the metatable of a readonly table.
  check_readonly_error(t.set_metatable(None));

  // Flipping back to writable restores mutation.
  t.set_readonly(false);
  t.set("key", "value")?;
  assert_eq!(t.get::<String>("key")?, "value");

  Ok(())
}

#[test]
fn test_readonly_table_reads_still_work() -> Result<()> {
  let lua = Lua::new();

  let t = lua.create_sequence_from([10, 20, 30])?;
  t.set_readonly(true);
  // Reads must remain available on a readonly table.
  assert_eq!(t.get::<i64>(1)?, 10);
  assert_eq!(t.raw_get::<i64>(2)?, 20);
  assert_eq!(t.raw_len(), 3);
  assert_eq!(
    t.sequence_values::<i64>().collect::<Result<Vec<_>>>()?,
    vec![10, 20, 30]
  );

  Ok(())
}

#[test]
fn test_metatable_via_lua() -> Result<()> {
  // A small Luau metatable round-trip (set_metatable + __index function),
  // mirroring the spirit of mlua's vector-metatable test without vectors.
  let lua = Lua::new();

  let base = lua
    .load(
      r#"
            return {
                __index = {
                    greet = function() return "hi" end,
                }
            }
        "#,
    )
    .eval::<Table>()?;

  let t = lua.create_table();
  t.set_metatable(Some(base))?;
  let greeting: String = lua
    .load("local t = ...; return t.greet()")
    .into_function()?
    .call(t)?;
  assert_eq!(greeting, "hi");

  Ok(())
}

#[test]
fn test_sandbox() -> Result<()> {
  let lua = Lua::new();

  lua.sandbox(true)?;

  lua.load("global = 123").exec()?;
  let n: i32 = lua.load("return global").eval()?;
  assert_eq!(n, 123);
  assert_eq!(lua.globals().get::<Option<i32>>("global")?, Some(123));

  // Threads should inherit "main" globals
  let f = lua.create_function(|lua, ()| lua.globals().get::<i32>("global"))?;
  let co = lua.create_thread(f.clone())?;
  assert_eq!(co.resume::<Option<i32>>(())?, Some(123));

  // Sandboxed threads should also inherit "main" globals
  let co = lua.create_thread(f)?;
  co.sandbox()?;
  assert_eq!(co.resume::<Option<i32>>(())?, Some(123));

  // DEVIATION: mlua's `test_sandbox` additionally checks that
  // `collectgarbage` is restricted in sandbox mode. ulua's base library does
  // not register `collectgarbage` at all (upstream Luau only adds it in the
  // CLI/REPL, not `luaL_openlibs`), so that section is not exercisable here.
  // The sandbox read-only / safeenv / thread-inheritance semantics — the part
  // backed by the VM — are covered above and below.

  lua.sandbox(false)?;

  // Previously set variable `global` should be cleared now (the proxy global
  // table installed by sandboxing was dropped on the way out).
  assert_eq!(lua.globals().get::<Option<i32>>("global")?, None);

  // Readonly flags should be cleared as well: the library tables are writable.
  let table = lua.globals().get::<Table>("table")?;
  table.set("test", "test")?;

  Ok(())
}

#[test]
fn test_sandbox_safeenv() -> Result<()> {
  let lua = Lua::new();

  lua.sandbox(true)?;
  lua.globals().set("state", lua.create_table())?;
  // DEVIATION: mlua calls `lua.globals().set_safeenv(false)`; ulua-rt exposes
  // the same operation as `Lua::set_safeenv(false)` applied to the main
  // globals (ulua-rt has no separate `Globals` handle type). Observable
  // behavior is identical: clearing safeenv lets a fresh global write to
  // `state.a` take effect within the same chunk.
  lua.set_safeenv(false);
  lua.load("state.a = 123").exec()?;
  let a: i32 = lua.load("state.a = 321; return state.a").eval()?;
  assert_eq!(a, 321);

  Ok(())
}

#[test]
fn test_sandbox_threads() -> Result<()> {
  let lua = Lua::new();

  let f = lua.create_function(|lua, v: Value| lua.globals().set("global", v))?;

  let co = lua.create_thread(f.clone())?;
  co.resume::<()>(321)?;
  // The main state should see the `global` variable (as the thread is not sandboxed)
  assert_eq!(lua.globals().get::<Option<i32>>("global")?, Some(321));

  let co = lua.create_thread(f.clone())?;
  co.sandbox()?;
  co.resume::<()>(123)?;
  // The main state should see the previous `global` value (as the thread is sandboxed)
  assert_eq!(lua.globals().get::<Option<i32>>("global")?, Some(321));

  // Try to reset the (sandboxed) thread
  co.reset(f)?;
  co.resume::<()>(111)?;
  assert_eq!(lua.globals().get::<Option<i32>>("global")?, Some(111));

  Ok(())
}

#[test]
fn test_interrupts() -> Result<()> {
  let lua = Lua::new();

  let interrupts_count = Arc::new(AtomicU64::new(0));
  let interrupts_count2 = interrupts_count.clone();

  lua.set_interrupt(move |_| {
    interrupts_count2.fetch_add(1, Ordering::Relaxed);
    Ok(VmState::Continue)
  });
  let f = lua
    .load(
      r#"
        local x = 2 + 3
        local y = x * 63
        local z = string.len(x..", "..y)
    "#,
    )
    .into_function()?;
  f.call::<()>(())?;

  assert!(interrupts_count.load(Ordering::Relaxed) > 0);

  //
  // Test yields from interrupt
  //
  let yield_count = Arc::new(AtomicU64::new(0));
  let yield_count2 = yield_count.clone();
  lua.set_interrupt(move |_| {
    if yield_count2.fetch_add(1, Ordering::Relaxed) == 1 {
      return Ok(VmState::Yield);
    }
    Ok(VmState::Continue)
  });
  let co = lua.create_thread(
    lua
      .load(
        r#"
            local a = {1, 2, 3}
            local b = 0
            for _, x in ipairs(a) do b += x end
            return b
        "#,
      )
      .into_function()?,
  )?;
  co.resume::<()>(())?;
  assert!(co.is_resumable());
  let result: i32 = co.resume(())?;
  assert_eq!(result, 6);
  assert_eq!(yield_count.load(Ordering::Relaxed), 7);
  assert!(co.is_finished());

  // Test no yielding at non-yieldable points
  yield_count.store(0, Ordering::Relaxed);
  let co = lua.create_thread(lua.create_function(|lua, arg: Value| {
    (lua.load("return (function(x) return x end)(...)")).call::<Value>(arg)
  })?)?;
  let res = co.resume::<String>("abc")?;
  assert_eq!(res, "abc".to_string());
  assert_eq!(yield_count.load(Ordering::Relaxed), 3);

  //
  // Test errors in interrupts
  //
  lua.set_interrupt(|_| Err(Error::runtime("error from interrupt")));
  match f.call::<()>(()) {
    Err(Error::RuntimeError(ref msg)) => assert_eq!(msg, "error from interrupt"),
    res => panic!("expected `RuntimeError` with a specific message, got {res:?}"),
  }

  lua.remove_interrupt();

  Ok(())
}

#[test]
fn test_fflags() {
  // We cannot rely on any particular feature flag to be present.
  //
  // DEVIATION: ulua's FastFlags are a fixed, compile-time `FFlag` enum
  // (configured at VM creation via `ulua_common::records::f_value::set_luau_bool_flags`), not a
  // string-keyed registry, so an arbitrary name is always unknown — exactly
  // mlua's contract for an unrecognized flag, which is all this test asserts.
  assert!(Lua::set_fflag("UnknownFlag", true).is_err());
}

#[test]
fn test_memory_category() -> Result<()> {
  let lua = Lua::new();

  lua.set_memory_category("main").unwrap();

  // Invalid category names should be rejected
  let err = lua.set_memory_category("invalid$");
  assert!(err.is_err());

  for i in 0..254 {
    let name = format!("category_{}", i);
    lua.set_memory_category(&name).unwrap();
  }
  // 255th category should fail
  let err = lua.set_memory_category("category_254");
  assert!(err.is_err());

  Ok(())
}

#[test]
fn test_integer_type() -> Result<()> {
  // DEVIATION: mlua's `test_integer64_type` exercises Luau's *native* i64 VM
  // type (the `LuauIntegerType2` fast-flag, the `integer` library, and `42i`
  // integer literals). ulua registers its i64 library as `int64` (not
  // `integer`) and does not surface the native i64 VM type through `Value`
  // (numbers are `f64`-backed), so that test is deferred. What ulua-rt *does*
  // back — round-tripping a Rust `i64` through Lua as an exact integer value —
  // is exercised here with the same observable result.
  let lua = Lua::new();

  let echo = lua.create_function(|_, n: i64| Ok(n))?;
  assert_eq!(echo.call::<i64>(42i64)?, 42);
  assert_eq!(echo.call::<i64>(-42i64)?, -42);

  // An integer-valued literal evaluated by the VM round-trips as `i64`.
  let n: i64 = lua.load("return 42").eval()?;
  assert_eq!(n, 42);
  let n: i64 = lua.load("return -42").eval()?;
  assert_eq!(n, -42);

  Ok(())
}

#[test]
fn test_chunk_call() -> Result<()> {
  // `Chunk::call` compiles + calls in one step (mlua's `Chunk::call`).
  let lua = Lua::new();

  let sum: i64 = lua.load("local a, b = ...; return a + b").call((2, 3))?;
  assert_eq!(sum, 5);

  // Side-effecting call discarding the result.
  lua.load("_G.touched = true").call::<()>(())?;
  assert!(lua.globals().get::<bool>("touched")?);

  Ok(())
}

// ---------------------------------------------------------------------------
// DEFERRED tests — each documents a capability Luau-as-ulua genuinely lacks.
// They are kept (not silently dropped) so the compatibility figure is honest.
// ---------------------------------------------------------------------------

#[test]
fn test_typeof_error_deferred() -> Result<()> {
  // DEFERRED / DEVIATION: mlua's `test_typeof_error` asserts that an
  // `Error` passed into Lua reports `typeof(err) == "error"`. mlua's Luau
  // backend pushes a Rust error as a tagged *error userdata* that Luau's
  // `typeof` recognizes. ulua-rt has no such tagged error value: `Value::Error`
  // is pushed as its **message string**, so `typeof` reports "string". We pin
  // the actual (deviating) behavior here so the gap is visible and tested.
  let lua = Lua::new();
  let err = Error::runtime("just a test error");
  let res = lua.load("return typeof(...)").call::<String>(err)?;
  assert_eq!(res, "string"); // would be "error" on mlua/Luau-CLI
  Ok(())
}

#[test]
fn test_heap_dump_deferred() {
  // DEFERRED: mlua's `test_heap_dump` needs `Lua::heap_dump()` returning a
  // `HeapDump` with `size_by_category` / `size_by_type` / `size_by_userdata`.
  // ulua's VM tracks only bytes-per-category (`global_State::memcatbytes[256]`);
  // it has no public API to enumerate live objects by Lua type or by Rust
  // userdata-type within a category, which `size_by_type`/`size_by_userdata`
  // require. The byte-per-category half *is* exposed (a ulua-rt extension):
  let lua = Lua::new();
  lua.set_memory_category("test_category").unwrap();
  let _t = lua.create_table();
  // The "main" category accounts for the stdlib allocations made before the
  // category switch, so it is non-empty.
  assert!(lua.memory_category_bytes("main").unwrap_or(0) > 0);
  // A freshly-named category exists (id assigned) even if nothing was
  // allocated into it yet.
  assert!(lua.memory_category_bytes("test_category").is_some());
}

#[test]
fn test_enable_jit() -> Result<()> {
  let lua = Lua::new();
  #[cfg(feature = "jit")]
  {
    lua.enable_jit(true)?;
    assert!(lua.is_jit_enabled());
    let res: i64 = lua
      .load(
        r#"
      local function fib(n)
        if n < 2 then return n end
        return fib(n - 1) + fib(n - 2)
      end
      return fib(20)
    "#,
      )
      .eval()?;
    assert_eq!(res, 6765);

    lua.enable_jit(false)?;
    assert!(!lua.is_jit_enabled());
    let res_interp: i64 = lua.load("return 2 + 3").eval()?;
    assert_eq!(res_interp, 5);
  }
  #[cfg(not(feature = "jit"))]
  {
    assert!(lua.enable_jit(true).is_err());
    assert!(!lua.is_jit_enabled());
  }
  Ok(())
}
