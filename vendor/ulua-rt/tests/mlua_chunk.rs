// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Dropped (deferred / out-of-scope ulua-rt features):
//   - test_chunk_path  (loading a chunk from a filesystem Path)
//   - test_chunk_macro (the `mlua::chunk!` proc-macro)
//   - test_compiler / test_compiler_library_constants (mlua::Compiler)
//   - test_chunk_wrap  (Chunk::wrap detached constructor)
//   - chunk environment + ChunkMode (set_environment / mode): deferred.
// ulua-rt's `Lua::load` accepts `impl AsRef<str>` (text source), so the
// bytes-source arms of `test_chunk_impls` are expressed as `&str`/`String`.

use ulua_rt::{Error, Lua, Result};

#[test]
fn test_chunk_methods() -> Result<()> {
  let lua = Lua::new();

  // Default name, then override via set_name.
  let default_chunk = lua.load("return 123");
  assert_eq!(default_chunk.name(), "chunk");

  let chunk2 = lua.load("return 123").set_name("@new_name");
  assert_eq!(chunk2.name(), "@new_name");
  assert_eq!(chunk2.eval::<i32>()?, 123);

  Ok(())
}

#[test]
fn test_chunk_eval_exec() -> Result<()> {
  let lua = Lua::new();

  // eval returns the value
  assert_eq!(lua.load("return 1 + 1").eval::<i32>()?, 2);
  // exec runs for side effects
  lua.load("result = 5 * 5").exec()?;
  assert_eq!(lua.globals().get::<i32>("result")?, 25);
  // into_function compiles to a reusable function
  let f = lua.load("return ...").into_function()?;
  assert_eq!(f.call::<i32>(42)?, 42);

  Ok(())
}

#[test]
fn test_chunk_impls() -> Result<()> {
  let lua = Lua::new();

  // StdString
  assert_eq!(lua.load(String::from("return 1")).eval::<i32>()?, 1);
  assert_eq!(lua.load(String::from("return 2")).eval::<i32>()?, 2);

  // &str
  assert_eq!(lua.load("return 3").eval::<i32>()?, 3);

  Ok(())
}

#[test]
fn test_chunk_syntax_error() -> Result<()> {
  let lua = Lua::new();

  let err = lua.load("this is not + valid lua %").exec().unwrap_err();
  assert!(
    matches!(err, Error::SyntaxError { .. }),
    "expected SyntaxError, got {err:?}"
  );

  Ok(())
}

#[test]
fn test_chunk_runtime_error() -> Result<()> {
  let lua = Lua::new();

  let err = lua.load(r#"error("boom")"#).exec().unwrap_err();
  assert!(err.to_string().contains("boom"), "got: {err}");

  Ok(())
}

#[test]
fn test_chunk_load_bytecode() -> Result<()> {
  use ulua_ast::records::parse_options::ParseOptions;
  use ulua_bytecode::records::bytecode_encoder::NoopEncoder;
  use ulua_compiler::{functions::compile::compile, records::compile_options::CompileOptions};

  let lua = Lua::new();

  let bytecode = compile(
    "return 10 * 20",
    &CompileOptions::default(),
    &ParseOptions::default(),
    NoopEncoder,
  );
  assert!(!bytecode.is_empty());

  // eval with load_bytecode
  let res: i32 = lua.load_bytecode(&bytecode).eval()?;
  assert_eq!(res, 200);

  // exec with load_bytecode
  let bytecode_exec = compile(
    "bytecode_result = 42",
    &CompileOptions::default(),
    &ParseOptions::default(),
    NoopEncoder,
  );
  lua.load_bytecode(&bytecode_exec).exec()?;
  assert_eq!(lua.globals().get::<i32>("bytecode_result")?, 42);

  // into_function with load_bytecode
  let bytecode_fn = compile(
    "local a, b = ...; return a + b",
    &CompileOptions::default(),
    &ParseOptions::default(),
    NoopEncoder,
  );
  let f = lua.load_bytecode(&bytecode_fn).into_function()?;
  assert_eq!(f.call::<i32>((15, 27))?, 42);

  // mode() and set_mode() checks
  use ulua_rt::ChunkMode;
  let text_chunk = lua.load("return 1");
  assert_eq!(text_chunk.mode(), ChunkMode::Text);

  let bc_chunk = lua.load_bytecode(&bytecode);
  assert_eq!(bc_chunk.mode(), ChunkMode::Binary);
  let modified_chunk = bc_chunk.set_mode(ChunkMode::Text);
  assert_eq!(modified_chunk.mode(), ChunkMode::Text);

  // custom name with load_bytecode
  let named_chunk = lua.load_bytecode(&bytecode).set_name("@custom_bc");
  assert_eq!(named_chunk.name(), "@custom_bc");
  assert_eq!(named_chunk.eval::<i32>()?, 200);

  // environment with load_bytecode
  let env = lua.create_table();
  env.set("env_val", 100)?;
  let bytecode_env = compile(
    "return env_val + 23",
    &CompileOptions::default(),
    &ParseOptions::default(),
    NoopEncoder,
  );
  let res_env: i32 = lua
    .load_bytecode(&bytecode_env)
    .set_environment(env)
    .eval()?;
  assert_eq!(res_env, 123);

  Ok(())
}
