// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Re-enabled in Phase 1: test_function_environment (Function environment
// get/set + Chunk::set_environment) and test_function_info (Function::info).
//
// Still dropped (deferred ulua-rt features): the Luau-only
// test_function_coverage / test_function_deep_clone (compiler coverage + deep
// clone), test_function_dump (non-luau bytecode dump), and the Function::wrap /
// wrap_raw family (no `wrap` constructor — ulua-rt builds callbacks via
// `Lua::create_function`).

use ulua_rt::{Error, Function, Lua, Result, Table, Variadic};

#[test]
fn test_function_call() -> Result<()> {
  let lua = Lua::new();

  let concat = lua
    .load(r#"return function(arg1, arg2) return arg1 .. arg2 end"#)
    .eval::<Function>()?;
  assert_eq!(concat.call::<String>(("foo", "bar"))?, "foobar");

  Ok(())
}

#[test]
fn test_function_call_error() -> Result<()> {
  let lua = Lua::new();

  let concat_err = lua
    .load(r#"return function(arg1, arg2) error("concat error") end"#)
    .eval::<Function>()?;
  match concat_err.call::<String>(("foo", "bar")) {
    Err(Error::RuntimeError(msg)) if msg.contains("concat error") => {}
    other => panic!("unexpected result: {other:?}"),
  }

  Ok(())
}

#[test]
fn test_function_bind() -> Result<()> {
  let lua = Lua::new();

  let globals = lua.globals();
  lua
    .load(
      r#"
        function concat(...)
            local res = ""
            for _, s in pairs({...}) do
                res = res..s
            end
            return res
        end
    "#,
    )
    .exec()?;

  let mut concat = globals.get::<Function>("concat")?;
  concat = concat.bind("foo")?;
  concat = concat.bind("bar")?;
  concat = concat.bind(("baz", "baf"))?;
  assert_eq!(concat.call::<String>(())?, "foobarbazbaf");
  assert_eq!(concat.call::<String>(("hi", "wut"))?, "foobarbazbafhiwut");

  let mut concat2 = globals.get::<Function>("concat")?;
  concat2 = concat2.bind(())?;
  assert_eq!(concat2.call::<String>(())?, "");
  assert_eq!(concat2.call::<String>(("ab", "cd"))?, "abcd");

  Ok(())
}

#[test]
fn test_function_bind_error() -> Result<()> {
  let lua = Lua::new();

  // A function that ignores all of its arguments.
  let func = lua.load(r#"return function(...) end"#).eval::<Function>()?;
  // Calling with an enormous variadic should overflow the Lua stack.
  assert!(func.call::<()>(Variadic::from_iter(1..1000000)).is_err());

  Ok(())
}

#[test]
fn test_function_pointer() -> Result<()> {
  let lua = Lua::new();

  let func1 = lua.load("return function() end").into_function()?;
  let func2 = func1.call::<Function>(())?;

  assert_eq!(func1.to_pointer(), func1.clone().to_pointer());
  assert_ne!(func1.to_pointer(), func2.to_pointer());

  Ok(())
}

#[test]
fn test_create_function_basic() -> Result<()> {
  // Adapted to exercise the ulua-rt callback path (mlua's `Function::wrap`
  // counterpart): a Rust closure exposed to Lua, including error return.
  let lua = Lua::new();

  let f = lua.create_function(|_, (s, n): (String, usize)| Ok(s.repeat(n)))?;
  lua.globals().set("f", f)?;
  lua
    .load(r#"assert(f("hello", 2) == "hellohello")"#)
    .exec()?;

  let ferr = lua.create_function(|_, ()| -> Result<()> { Err(Error::runtime("some error")) })?;
  lua.globals().set("ferr", ferr)?;
  lua
    .load(
      r#"
        local ok, err = pcall(ferr)
        assert(not ok and tostring(err):find("some error"))
    "#,
    )
    .exec()?;

  Ok(())
}

#[test]
fn test_function_environment() -> Result<()> {
  let lua = Lua::new();
  let globals = lua.globals();

  // We must not get or set environment for C (Rust) functions.
  let rust_func = lua.create_function(|_, ()| Ok("hello"))?;
  assert_eq!(rust_func.environment(), None);
  assert_eq!(rust_func.set_environment(globals.clone()).ok(), Some(false));

  // Test getting a Lua function's environment.
  globals.set("hello", "global")?;
  let lua_func = lua
    .load(
      r#"
        local t = ""
        return function()
            -- two upvalues
            return t .. hello
        end
    "#,
    )
    .eval::<Function>()?;
  let lua_func2 = lua.load("return hello").into_function()?;
  assert_eq!(lua_func.call::<String>(())?, "global");
  assert_eq!(lua_func.environment().as_ref(), Some(&globals));

  // Test changing the environment.
  let env = lua.create_table_from([("hello", "local")])?;
  assert!(lua_func.set_environment(env.clone())?);
  assert_eq!(lua_func.call::<String>(())?, "local");
  assert_eq!(lua_func2.call::<String>(())?, "global");

  // More complex case.
  lua
    .load(
      r#"
        local number = 15
        function lucky() return tostring("number is "..number) end
        new_env = {
            tostring = function() return tostring(number) end,
        }
    "#,
    )
    .exec()?;
  let lucky = globals.get::<Function>("lucky")?;
  assert_eq!(lucky.call::<String>(())?, "number is 15");
  let new_env = globals.get::<Table>("new_env")?;
  lucky.set_environment(new_env)?;
  assert_eq!(lucky.call::<String>(())?, "15");

  // Test getting the environment set by the chunk loader.
  let chunk = lua
    .load("return hello")
    .set_environment(lua.create_table_from([("hello", "chunk")])?)
    .into_function()?;
  assert_eq!(
    chunk.environment().unwrap().get::<String>("hello")?,
    "chunk"
  );

  Ok(())
}

#[test]
fn test_function_info() -> Result<()> {
  let lua = Lua::new();

  let globals = lua.globals();
  lua
    .load(
      r#"
        function function1()
            return function() end
        end
    "#,
    )
    .set_name("source1")
    .exec()?;

  let function1 = globals.get::<Function>("function1")?;
  let function2 = function1.call::<Function>(())?;
  let function3 = lua.create_function(|_, ()| Ok(()))?;

  let function1_info = function1.info();
  assert_eq!(function1_info.name.as_deref(), Some("function1"));
  assert_eq!(function1_info.source.as_deref(), Some("source1"));
  assert_eq!(function1_info.line_defined, Some(2));
  // Luau does not report `last_line_defined`.
  assert_eq!(function1_info.last_line_defined, None);
  assert_eq!(function1_info.what, "Lua");

  let function2_info = function2.info();
  assert_eq!(function2_info.name, None);
  assert_eq!(function2_info.source.as_deref(), Some("source1"));
  assert_eq!(function2_info.line_defined, Some(3));
  assert_eq!(function2_info.last_line_defined, None);
  assert_eq!(function2_info.what, "Lua");

  let function3_info = function3.info();
  // DEVIATION: ulua-rt tags its callback closures with an internal debug
  // name, so `name` is `Some("ulua-rt-callback")` rather than mlua's `None`.
  assert_eq!(function3_info.source.as_deref(), Some("=[C]"));
  assert_eq!(function3_info.line_defined, None);
  assert_eq!(function3_info.last_line_defined, None);
  assert_eq!(function3_info.what, "C");

  let print_info = globals.get::<Function>("print")?.info();
  assert_eq!(print_info.name.as_deref(), Some("print"));
  assert_eq!(print_info.source.as_deref(), Some("=[C]"));
  assert_eq!(print_info.what, "C");
  assert_eq!(print_info.line_defined, None);

  // Function with upvalues and params.
  let func_with_upvalues = lua
    .load(
      r#"
        local x, y = ...
        return function(a, ...)
            return a*x + y
        end
    "#,
    )
    .into_function()?
    .call::<Function>((10, 20))?;
  let func_with_upvalues_info = func_with_upvalues.info();
  assert_eq!(func_with_upvalues_info.num_upvalues, 2);
  assert_eq!(func_with_upvalues_info.num_params, 1);
  assert!(func_with_upvalues_info.is_vararg);

  Ok(())
}
