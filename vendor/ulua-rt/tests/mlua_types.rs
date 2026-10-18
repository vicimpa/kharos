// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua `tests/types.rs`. Covers the light-userdata value type
// (`Value::LightUserData` / `LightUserData`) and the per-type metatable surface
// (`Lua::set_type_metatable` / `Lua::type_metatable`) for the Luau built-in
// types: `bool`, `LightUserData`, `Number`, `LuaString`, `Function`, `Thread`.
//
// Every test here ports VERBATIM (import-swap only): ulua-rt grew the
// `LightUserData` value variant, the `Function::wrap` adapter, and the extended
// `TypeMetatable` impls to make them compile and pass against ulua's Luau VM.

use std::os::raw::c_void;

use ulua_rt::{Error, Function, LightUserData, Lua, LuaString, Number, Result, Thread};

#[test]
fn test_lightuserdata() -> Result<()> {
  let lua = Lua::new();

  let globals = lua.globals();
  lua
    .load(
      r#"
        function id(a)
            return a
        end
    "#,
    )
    .exec()?;

  let res = globals
    .get::<Function>("id")?
    .call::<LightUserData>(LightUserData(42 as *mut c_void))?;

  assert_eq!(res, LightUserData(42 as *mut c_void));

  Ok(())
}

#[test]
fn test_boolean_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set("__add", Function::wrap(|a, b| Ok::<_, Error>(a || b)))?;
  assert_eq!(lua.type_metatable::<bool>(), None);
  lua.set_type_metatable::<bool>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<bool>().unwrap(), mt);

  lua.load(r#"assert(true + true == true)"#).exec().unwrap();
  lua.load(r#"assert(true + false == true)"#).exec().unwrap();
  lua.load(r#"assert(false + true == true)"#).exec().unwrap();
  lua
    .load(r#"assert(false + false == false)"#)
    .exec()
    .unwrap();

  Ok(())
}

#[test]
fn test_lightuserdata_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set(
    "__add",
    Function::wrap(|a: LightUserData, b: LightUserData| {
      Ok::<_, Error>(LightUserData((a.0 as usize + b.0 as usize) as *mut c_void))
    }),
  )?;
  lua.set_type_metatable::<LightUserData>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<LightUserData>().unwrap(), mt);

  let res = lua
    .load(
      r#"
        local a, b = ...
        return a + b
    "#,
    )
    .call::<LightUserData>((
      LightUserData(42 as *mut c_void),
      LightUserData(100 as *mut c_void),
    ))
    .unwrap();
  assert_eq!(res, LightUserData(142 as *mut c_void));

  Ok(())
}

#[test]
fn test_number_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set(
    "__call",
    Function::wrap(|n1: f64, n2: f64| Ok::<_, Error>(n1 * n2)),
  )?;
  lua.set_type_metatable::<Number>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<Number>().unwrap(), mt);

  lua.load(r#"assert((1.5)(3.0) == 4.5)"#).exec().unwrap();
  lua.load(r#"assert((5)(5) == 25)"#).exec().unwrap();

  Ok(())
}

#[test]
fn test_string_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set(
    "__add",
    Function::wrap(|a: String, b: String| Ok::<_, Error>(format!("{a}{b}"))),
  )?;
  lua.set_type_metatable::<LuaString>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<LuaString>().unwrap(), mt);

  lua
    .load(r#"assert(("foo" + "bar") == "foobar")"#)
    .exec()
    .unwrap();

  Ok(())
}

#[test]
fn test_function_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set(
    "__index",
    Function::wrap(|_: Function, key: String| Ok::<_, Error>(format!("function.{key}"))),
  )?;
  lua.set_type_metatable::<Function>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<Function>(), Some(mt));

  lua
    .load(r#"assert((function() end).foo == "function.foo")"#)
    .exec()
    .unwrap();

  Ok(())
}

#[test]
fn test_thread_type_metatable() -> Result<()> {
  let lua = Lua::new();

  let mt = lua.create_table();
  mt.set(
    "__index",
    Function::wrap(|_: Thread, key: String| Ok::<_, Error>(format!("thread.{key}"))),
  )?;
  lua.set_type_metatable::<Thread>(Some(mt.clone()));
  assert_eq!(lua.type_metatable::<Thread>(), Some(mt));

  lua
    .load(r#"assert((coroutine.create(function() end)).foo == "thread.foo")"#)
    .exec()
    .unwrap();

  Ok(())
}
