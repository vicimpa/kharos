// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Port of mlua's `tests/send.rs`, gated on the `send` feature.
//
// mlua's `send` feature makes `Lua` and every handle `Send` so the whole VM can
// be **moved** across threads (the user guarantees serialized access). ulua-rt
// mirrors that with `XRc` (= `Arc` under `send`) + a `MaybeSend` marker on the
// stored callbacks/userdata + a documented `unsafe impl Send` over the raw
// `*mut LuaState`. See `crates/ulua-rt/src/sync.rs` and `state.rs`.
//
// DEVIATION from mlua: ulua-rt is `Send` but deliberately **`!Sync`** (mlua's
// `Lua` happens to be `Send + Sync` because its interior is an
// `Arc<ReentrantMutex<RawLua>>`). The VM is single-threaded in *use*; only the
// ownership *transfer* crosses threads. Consequently mlua's single
// `tests/send.rs` test — `test_userdata_multithread_access_sync`, which shares
// one `&Lua` across a `std::thread::scope` and acquires a second
// `UserDataRef` on another thread — cannot be ported verbatim: it requires
// `Lua: Sync` and the `ObjectLike` trait (`call_method`), neither of which
// ulua-rt provides. It is reproduced below in spirit as a **single-threaded**
// nested-userdata-method-call test (`test_userdata_nested_method_call`), plus
// the `Send` property is locked down with compile-time `assert_*_send`
// assertions and a real `move`-the-VM-to-another-thread runtime test that mlua's
// `send` feature exists to enable.

#![cfg(feature = "send")]

use std::{marker::PhantomData, thread};

use ulua_rt::{
  AnyUserData, Buffer, Function, Lua, LuaString, RegistryKey, Result, Table, Thread, UserData,
  UserDataMethods, UserDataRef, Value, Vector,
};

// ---------------------------------------------------------------------------
// Compile-time assertions: under the `send` feature `Lua` and every handle is
// `Send`. (`static_assertions::assert_impl_all!` in mlua; written by hand here
// to avoid a new dev-dependency.)
// ---------------------------------------------------------------------------

fn assert_send<T: Send>() {}

// Autoref-specialization probe: `is_sync()` resolves to the `IsSync` inherent
// method (returning `true`) only for `Sync` types; otherwise it falls back to
// the `NotSync` blanket trait method (returning `false`). Lets us assert at
// runtime that `Lua` is `Send` but **not** `Sync` (ulua-rt's documented
// move-only, never-shared contract).
struct Probe<T>(PhantomData<T>);

trait NotSyncProbe {
  fn is_sync(&self) -> bool {
    false
  }
}
impl<T> NotSyncProbe for Probe<T> {}

impl<T: Sync> Probe<T> {
  fn is_sync(&self) -> bool {
    true
  }
}

#[test]
fn test_lua_is_send_but_not_sync() {
  assert_send::<Lua>();
  // The inherent `is_sync` is only callable when `Lua: Sync`; method
  // resolution here picks the trait fallback, proving `Lua` is `!Sync`.
  let probe = Probe::<Lua>(PhantomData);
  assert!(
    !probe.is_sync(),
    "Lua must remain !Sync under the `send` feature (move-only contract)"
  );
  assert!(
    Probe::<i32>(PhantomData).is_sync(),
    "i32 must resolve to inherent is_sync (Sync)"
  );
}

#[test]
fn test_lua_and_handles_are_send() {
  assert_send::<Lua>();
  assert_send::<Table>();
  assert_send::<Function>();
  assert_send::<LuaString>();
  assert_send::<AnyUserData>();
  assert_send::<Thread>();
  assert_send::<Buffer>();
  assert_send::<Vector>();
  assert_send::<Value>();
  assert_send::<RegistryKey>();
  assert_send::<ulua_rt::MultiValue>();
  assert_send::<ulua_rt::Error>();
  // NOTE: `UserDataRef<'_, T>` is intentionally **not** asserted `Send`. It
  // wraps a `std::cell::Ref` borrow guard (which is `!Send`), and it is a
  // short-lived RAII borrow that must not outlive — let alone cross threads
  // away from — the VM it borrows. Only the long-lived *handles* above are
  // `Send`. (mlua's `UserDataRef` is `Send` because it uses a `parking_lot`
  // arc-guard; ulua-rt deliberately keeps the simpler `RefCell` borrow.)
}

// ---------------------------------------------------------------------------
// The reason `send` exists: a `Lua` (with everything reachable from it) can be
// constructed on one thread and *moved* to another to be driven there.
// ---------------------------------------------------------------------------

#[test]
fn test_move_lua_to_another_thread() -> Result<()> {
  let lua = Lua::new();

  // A Rust callback capturing `Send` data, registered before the move.
  let captured = String::from("from the spawning thread");
  let f = lua.create_function(move |_, ()| Ok(captured.clone()))?;
  lua.globals().set("greet", f)?;
  lua.globals().set("n", 41i64)?;

  // Move the whole VM (and its handles) into a fresh thread and run there.
  let handle = thread::spawn(move || -> Result<(i64, String)> {
    let n: i64 = lua.load("return n + 1").eval()?;
    let g: String = lua.load("return greet()").eval()?;
    Ok((n, g))
  });

  let (n, g) = handle.join().expect("worker thread panicked")?;
  assert_eq!(n, 42);
  assert_eq!(g, "from the spawning thread");
  Ok(())
}

// ---------------------------------------------------------------------------
// A callback can capture data moved across a thread boundary into the closure
// environment (the `MaybeSend` bound makes the stored box `Send`).
// ---------------------------------------------------------------------------

#[test]
fn test_callback_captures_send_data() -> Result<()> {
  // Build the captured value on a worker thread, then move it into the VM
  // (which lives on the main thread) — proving the closure env is `Send`.
  let payload: Vec<i64> = thread::spawn(|| vec![1, 2, 3, 4])
    .join()
    .expect("worker panicked");

  let lua = Lua::new();
  let sum_fn = lua.create_function(move |_, ()| Ok(payload.iter().sum::<i64>()))?;
  lua.globals().set("sum", sum_fn)?;

  let total: i64 = lua.load("return sum()").eval()?;
  assert_eq!(total, 10);
  Ok(())
}

// ---------------------------------------------------------------------------
// Spirit-port of mlua's `test_userdata_multithread_access_sync`, adapted to
// ulua-rt's single-threaded (`!Sync`) model: a userdata method that, while
// borrowing `this`, reaches back into globals to call a *second* userdata
// method — the nested re-entrant access that the mlua test exercises (minus the
// cross-thread `Sync` sharing, which ulua-rt does not support).
// ---------------------------------------------------------------------------

struct MyUserData(String);

// This type is `Send + Sync`, exactly like mlua's `MyUserData`.
fn _assert_my_userdata_send_sync()
where
  MyUserData: Send + Sync,
{
}

impl UserData for MyUserData {
  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("method", |lua, this, ()| {
      // Reach back into globals and invoke another method, while `this`
      // is borrowed — the re-entrant pattern from the mlua test.
      let ud = lua.globals().get::<AnyUserData>("ud")?;
      let method2 = lua
        .load("return function(u) return u:method2() end")
        .eval::<Function>()?;
      method2.call::<()>(ud)?;
      Ok(this.0.clone())
    });

    methods.add_method("method2", |_, _, ()| Ok(()));
  }
}

#[test]
fn test_userdata_nested_method_call() -> Result<()> {
  let lua = Lua::new();

  let ud = lua.create_userdata(MyUserData("hello".to_string()))?;
  lua.globals().set("ud", ud)?;

  // Acquire a shared Rust-side reference (mirrors the mlua test's
  // `UserDataRef` acquisition before driving the VM).
  {
    let any = lua.globals().get::<AnyUserData>("ud")?;
    let r: UserDataRef<'_, MyUserData> = any.borrow::<MyUserData>()?;
    assert_eq!(r.0, "hello");
  }

  // Drive the re-entrant method from Lua.
  let out: String = lua.load("return ud:method()").eval()?;
  assert_eq!(out, "hello");
  Ok(())
}
