// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua `tests/thread.rs`. ulua-rt implements the core coroutine
// surface: `Lua::create_thread`, `Thread::{resume, resume_error, status,
// is_*, reset, to_pointer}`, `ThreadStatus`, `Value::Thread`, and
// `Lua::current_thread`.
//
// Dropped (deferred to later phases — needs subsystems ulua-rt does not yet
// expose):
//   - Thread event callbacks (`ThreadEvent` / `ThreadTriggers` /
//     `set_thread_event_callback` / `remove_thread_event_callback`):
//     `test_thread_event_*`.
//   - `test_thread_reset` in full: it relies on userdata user-values and the
//     `Error::CallbackError` variant; a trimmed reset exercise is kept below.

use std::panic::catch_unwind;

use ulua_rt::{Error, Function, IntoLua, Lua, Result, Thread, Value};

#[test]
fn test_thread() -> Result<()> {
  let lua = Lua::new();

  let thread = lua.create_thread(
    lua
      .load(
        r#"
            function (s)
                local sum = s
                for i = 1,4 do
                    sum = sum + coroutine.yield(sum)
                end
                return sum
            end
            "#,
      )
      .eval()?,
  )?;

  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(0)?, 0);
  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(1)?, 1);
  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(2)?, 3);
  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(3)?, 6);
  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(4)?, 10);
  assert!(thread.is_finished());

  let accumulate = lua.create_thread(
    lua
      .load(
        r#"
            function (sum)
                while true do
                    sum = sum + coroutine.yield(sum)
                end
            end
            "#,
      )
      .eval::<Function>()?,
  )?;

  for i in 0..4 {
    accumulate.resume::<()>(i)?;
  }
  assert_eq!(accumulate.resume::<i64>(4)?, 10);
  assert!(accumulate.is_resumable());
  // 用字符串唤醒做 `sum + yield(...)` 的协程：Luau 在 resume 内抛
  // "attempt to perform arithmetic (add) on number and string"，
  // 必须以 RuntimeError 浮出（mlua 原版仅 is_err，此处锁错误形态）。
  match accumulate.resume::<()>("error") {
    Err(Error::RuntimeError(_)) => {}
    r => panic!("unexpected result: {r:?}"),
  }
  assert!(accumulate.is_error());

  let thread = lua
    .load(
      r#"
            coroutine.create(function ()
                while true do
                    coroutine.yield(42)
                end
            end)
        "#,
    )
    .eval::<Thread>()?;
  assert!(thread.is_resumable());
  assert_eq!(thread.resume::<i64>(())?, 42);

  let thread: Thread = lua
    .load(
      r#"
            coroutine.create(function(arg)
                assert(arg == 42)
                local yieldarg = coroutine.yield(123)
                assert(yieldarg == 43)
                return 987
            end)
        "#,
    )
    .eval()?;

  assert_eq!(thread.resume::<u32>(42)?, 123);
  assert_eq!(thread.resume::<u32>(43)?, 987);

  match thread.resume::<u32>(()) {
    Err(Error::CoroutineUnresumable) => {}
    Err(_) => panic!("resuming dead coroutine error is not CoroutineUnresumable kind"),
    _ => panic!("resuming dead coroutine did not return error"),
  }

  Ok(())
}

#[test]
fn test_thread_running() -> Result<()> {
  // The thread that is currently executing a Rust callback is "running" and
  // therefore unresumable. (mlua's `test_thread` checks this with
  // `lua.current_thread()`.)
  let lua = Lua::new();

  let thread = lua.create_thread(lua.create_function(|lua, ()| {
    assert!(lua.current_thread().is_running());
    let result = lua.current_thread().resume::<()>(());
    assert!(
      matches!(result, Err(Error::CoroutineUnresumable)),
      "unexpected result: {result:?}",
    );
    Ok(())
  })?)?;
  let result = thread.resume::<()>(());
  assert!(result.is_ok(), "unexpected result: {result:?}");

  Ok(())
}

#[test]
fn test_thread_normal() -> Result<()> {
  // A thread that has resumed another (still-running) thread is "normal" and
  // cannot itself be resumed. (mlua's `test_thread`.)
  let lua = Lua::new();

  let check_outer = lua.create_function(|lua, ()| {
    let outer: Thread = lua.globals().get("outer")?;
    assert!(outer.is_normal());
    assert!(
      matches!(outer.resume::<()>(()), Err(Error::CoroutineUnresumable)),
      "resuming a `normal` thread must be unresumable",
    );
    Ok(())
  })?;
  lua.globals().set("check_outer", check_outer)?;
  let outer = lua.create_thread(
    lua
      .load(
        r#"
            function()
                local inner = coroutine.create(function() check_outer() end)
                assert(coroutine.resume(inner))
            end
            "#,
      )
      .eval()?,
  )?;
  lua.globals().set("outer", &outer)?;
  outer.resume::<()>(())?;
  assert!(outer.is_finished());

  Ok(())
}

#[test]
fn test_thread_reset() -> Result<()> {
  // Trimmed from mlua's `test_thread_reset` (the full version uses userdata
  // user-values and `Error::CallbackError`). Luau allows resetting a thread
  // in any non-running state and re-binding its body function.
  let lua = Lua::new();

  let func: Function = lua
    .load(r#"function(x) coroutine.yield(x + 1) end"#)
    .eval()?;
  let thread = lua.create_thread(lua.load("return 0").into_function()?)?;
  thread.reset(func.clone())?;

  for _ in 0..2 {
    assert!(thread.is_resumable());
    let yielded = thread.resume::<i64>(10)?;
    assert_eq!(yielded, 11);
    assert!(thread.is_resumable());
    thread.resume::<()>(())?;
    assert!(thread.is_finished());
    thread.reset(func.clone())?;
  }

  // Resetting an errored thread is allowed in Luau.
  let func: Function = lua.load(r#"function() error("test error") end"#).eval()?;
  let thread = lua.create_thread(func.clone())?;
  // 出错体的错误必须经 resume 浮出为 RuntimeError 且保留消息（原版 `let _ =`
  // 弃置结果，未证错误真的传播；is_error 只是旁证）。
  match thread.resume::<()>(()) {
    Err(Error::RuntimeError(ref msg)) => assert!(msg.contains("test error"), "{msg}"),
    r => panic!("errored body must surface its error, got {r:?}"),
  }
  assert!(thread.is_error());
  thread.reset(func.clone())?;
  assert!(thread.is_resumable());

  Ok(())
}

#[test]
fn test_coroutine_from_closure() -> Result<()> {
  let lua = Lua::new();

  let thrd_main = lua.create_function(|_, ()| Ok(()))?;
  lua.globals().set("main", thrd_main)?;

  let thrd: Thread = lua.load("coroutine.create(main)").eval()?;
  thrd.resume::<()>(())?;

  Ok(())
}

#[test]
#[cfg(not(panic = "abort"))]
fn test_coroutine_panic() {
  match catch_unwind(|| -> Result<()> {
    // check that coroutines propagate panics correctly
    let lua = Lua::new();
    let thrd_main = lua.create_function(|_, ()| -> Result<()> {
      panic!("test_panic");
    })?;
    lua.globals().set("main", &thrd_main)?;
    let thrd: Thread = lua.create_thread(thrd_main)?;
    thrd.resume::<()>(())
  }) {
    // DEVIATION: ulua-rt catches a Rust panic inside a callback and turns
    // it into a catchable Lua error (so the VM is never left in a
    // half-unwound state), rather than re-propagating the panic across the
    // coroutine boundary. We therefore assert the resume surfaces the panic
    // message as an error instead of unwinding.
    Ok(Err(Error::RuntimeError(msg))) => assert!(msg.contains("test_panic")),
    Ok(other) => panic!("unexpected coroutine result: {other:?}"),
    Err(p) => assert!(*p.downcast::<&str>().unwrap() == "test_panic"),
  }
}

#[test]
fn test_thread_pointer() -> Result<()> {
  let lua = Lua::new();

  let func = lua.load("return 123").into_function()?;
  let thread = lua.create_thread(func.clone())?;

  assert_eq!(thread.to_pointer(), thread.clone().to_pointer());
  assert_ne!(thread.to_pointer(), lua.current_thread().to_pointer());

  Ok(())
}

#[test]
fn test_thread_resume_error() -> Result<()> {
  // Luau-specific `resume_error`: resume a coroutine while raising an error at
  // its current yield point.
  let lua = Lua::new();

  let thread = lua
    .load(
      r#"
        coroutine.create(function()
            local ok, err = pcall(coroutine.yield, 123)
            assert(not ok, "yield should fail")
            assert(err == "myerror", "unexpected error: " .. tostring(err))
            return "success"
        end)
    "#,
    )
    .eval::<Thread>()?;

  assert_eq!(thread.resume::<i64>(())?, 123);
  let status = thread.resume_error::<String>("myerror")?;
  assert_eq!(status, "success");

  Ok(())
}

#[test]
fn test_thread_resume_bad_arg() -> Result<()> {
  let lua = Lua::new();

  struct BadArg;

  impl IntoLua for BadArg {
    fn into_lua(self, _lua: &Lua) -> Result<Value> {
      Err(Error::runtime("bad arg"))
    }
  }

  let f = lua.create_thread(lua.create_function(|_, ()| Ok("okay"))?)?;
  let res = f.resume::<()>((123, BadArg));
  assert!(matches!(res, Err(Error::RuntimeError(msg)) if msg == "bad arg"));
  let res = f.resume::<String>(()).unwrap();
  assert_eq!(res, "okay");

  Ok(())
}
