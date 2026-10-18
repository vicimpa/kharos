//! The [`Chunk`] builder returned by [`Lua::load`]. Mirrors `mlua::Chunk`.
//!
//! Compilation reuses the same machinery as the umbrella `ulua` crate's
//! `compile`/`eval` helpers: source -> `ulua_compiler::compile` -> bytecode ->
//! `luau_load` -> a Lua function on the stack -> `lua_pcall`.

use ulua_ast::records::parse_options::ParseOptions;
use ulua_bytecode::records::bytecode_encoder::NoopEncoder;
#[cfg(feature = "jit")]
use ulua_code_gen::functions::luau_codegen_compile::luau_codegen_compile;
#[cfg(feature = "jit")]
use ulua_common::fflag::LuauJitFornTrace;
use ulua_compiler::{
  functions::compile::compile as compiler_compile, records::compile_options::CompileOptions,
};

use crate::{
  compiler::Compiler,
  error::{Error, Result},
  function::Function,
  state::Lua,
  sys::*,
  table::Table,
  traits::{FromLuaMulti, IntoLuaMulti},
};

pub(crate) const DEFAULT_CHUNK_NAME: &str = "chunk";

#[derive(Debug)]
pub(crate) enum ChunkSource {
  Text(String),
  Bytecode(Vec<u8>),
}

/// A not-yet-executed piece of Lua source or precompiled bytecode.
///
/// Mirrors `mlua::Chunk`. Produced by [`Lua::load`] or [`Lua::load_bytecode`]; finalized with
/// [`Chunk::exec`], [`Chunk::eval`], or [`Chunk::into_function`].
pub struct Chunk {
  pub(crate) lua: Lua,
  pub(crate) source: ChunkSource,
  pub(crate) name: String,
  /// Optional environment table applied to the loaded function. Mirrors the
  /// per-chunk environment set by `mlua::Chunk::set_environment`.
  pub(crate) environment: Option<Table>,
  /// Optional per-chunk compiler. Mirrors `mlua::Chunk::set_compiler`. When
  /// `None`, the VM-default compiler (`Lua::set_compiler`) is used, falling
  /// back to ulua's default options.
  pub(crate) compiler: Option<Compiler>,
  pub(crate) mode: ChunkMode,
}

impl Chunk {
  /// Override the chunk name shown in error messages / tracebacks.
  ///
  /// Mirrors `mlua::Chunk::set_name`.
  pub fn set_name(mut self, name: impl Into<String>) -> Self {
    self.name = name.into();
    self
  }

  /// Set the environment (globals table) the loaded chunk runs in.
  ///
  /// Mirrors `mlua::Chunk::set_environment`. Applied to the function produced
  /// by [`Chunk::into_function`] / [`Chunk::exec`] / [`Chunk::eval`].
  pub fn set_environment(mut self, env: Table) -> Self {
    self.environment = Some(env);
    self
  }

  /// Set the [`Compiler`](crate::Compiler) used to compile this chunk.
  /// Mirrors `mlua::Chunk::set_compiler`.
  pub fn set_compiler(mut self, compiler: Compiler) -> Self {
    self.compiler = Some(compiler);
    self
  }

  /// Compile the chunk and call it with `args`, converting the result to `R`.
  /// Mirrors `mlua::Chunk::call`.
  pub fn call<R: FromLuaMulti>(self, args: impl IntoLuaMulti) -> Result<R> {
    self.into_function()?.call::<R>(args)
  }

  /// Set the interpretation mode for this chunk.
  /// Mirrors `mlua::Chunk::set_mode`.
  pub fn set_mode(mut self, mode: ChunkMode) -> Self {
    self.mode = mode;
    self
  }

  /// Return the interpretation mode for this chunk.
  pub fn mode(&self) -> ChunkMode {
    self.mode
  }

  /// The chunk name used for error messages / tracebacks.
  ///
  /// Mirrors `mlua::Chunk::name`.
  pub fn name(&self) -> &str {
    &self.name
  }

  /// 编译 Lua 源码为 Luau 字节码。
  fn compile_str(&self, src: &str) -> Result<Vec<u8>> {
    // Pick the effective compiler: a per-chunk one wins over the VM-default
    // one (`Lua::set_compiler`); otherwise use ulua's default options.
    // 借用分支直取，chunk 自带 compiler 时不再克隆整份选项。
    let options = match self.compiler.as_ref() {
      Some(c) => c.to_options(),
      // VM 默认编译器存于进程级 side-store，取回必经一次克隆。
      None => match self.lua.vm_compiler() {
        Some(c) => c.to_options(),
        None => CompileOptions::default(),
      },
    };
    let parse_options = ParseOptions::default();
    let bytes = compiler_compile(src, &options, &parse_options, NoopEncoder);
    // A leading 0 byte is the compiler's error marker.
    if bytes.first() == Some(&0u8) {
      let message = String::from_utf8_lossy(&bytes[1..]).into_owned();
      // Luau reports a syntax error caused by hitting end-of-input (an
      // unterminated block/expression) with a "got <eof>" suffix; mlua
      // surfaces that as `incomplete_input: true` so a REPL can keep
      // reading. Detect it the same way.
      let incomplete_input = message.contains("<eof>");
      return Err(Error::SyntaxError {
        message,
        incomplete_input,
      });
    }
    Ok(bytes)
  }

  /// Load the compiled chunk and leave the resulting function on top of the
  /// stack, returning a [`Function`] handle.
  ///
  /// Mirrors `mlua::Chunk::into_function`.
  pub fn into_function(self) -> Result<Function> {
    match &self.source {
      ChunkSource::Bytecode(bytecode) => self.load_bytecode(bytecode),
      ChunkSource::Text(src) => {
        let bytecode = self.compile_str(src)?;
        self.load_bytecode(&bytecode)
      }
    }
  }

  /// 加载已编译字节码：`luau_load` → 栈顶函数 → 环境挂接 → [`Function`] 句柄。
  /// [`Chunk::into_function`] 与 [`Chunk::eval`] / [`Chunk::eval_async`] 的
  /// 表达式优先路径共用（后者已持有字节码，避免二次编译）。
  fn load_bytecode(&self, bytecode: &[u8]) -> Result<Function> {
    let state = self.lua.state();
    // 默认名走零分配的静态串；其余名字前置 `=` 后直传（cpp 同款前缀约定）。
    let owned_chunkname;
    let chunkname: &str = if self.name == DEFAULT_CHUNK_NAME {
      "=chunk"
    } else {
      owned_chunkname = format!("={}", self.name);
      &owned_chunkname
    };
    // Safety: `state` 为存活 VM 状态。`chunkname` 是本帧持有的 `&str`（默认名是
    // 静态串；自定义名借 `owned_chunkname` 这个 `String`），在 `luau_load` 调用
    // 期间存活；名字含内部 NUL 时由 `luau_load` 按 cpp `strlen` 规则截断，与上游
    // 传 `c_str()` 的取长度方式一致。`bytecode` 是有效 `&[u8]`，`luau_load` 只读
    // 该切片、在返回前完整消费。成功时把一个函数留在栈顶（rc==0 才继续），失败时
    // 留错误消息（走 `pop_error`），两条路径栈平衡都由 rc 唯一决定。
    let rc = unsafe { luau_load(state.as_mut_ptr(), chunkname, bytecode, 0) };
    if rc != 0 {
      // luau_load failure leaves an error message on the stack; `pop_error` 消费之。
      return Err(self.lua.pop_error(rc));
    }
    #[cfg(feature = "jit")]
    if self.lua.is_jit_enabled() {
      // Safety: `state` 存活且由当前线程驱动（self 的 `XRc<LuaInner>` + `NotSync`
      // 纪律）；-1 正指上一句 `luau_load` 刚压到栈顶的闭包，`luau_codegen_compile`
      // 只为该闭包原型生成 native 代码，不改栈深、不抛错。
      unsafe {
        luau_codegen_compile(state.as_mut_ptr(), -1);
      }
    } else if LuauJitFornTrace.get() {
      // FORN trace 层形态（阶段二 PoC）：jit 关 + 旗标开 → 懒装配 trace 上下文
      // （safeenv 保持 0，装载期零编译——trace 在运行期热度达标后由 ecb 槽
      // 录制/生成/承接，解释器逐环入口问询）。
      self.lua.ensure_forn_trace_context();
    }
    // 栈顶即 luau_load 留下的函数；`pop_ref`（safe fn）弹走并登记注册表引用。
    let func = Function::from_ref(self.lua.pop_ref());
    if let Some(env) = &self.environment {
      func.set_environment(env.clone())?;
    }
    Ok(func)
  }

  /// Statically type-check this chunk's source against the owning [`Lua`]'s
  /// accumulated host definitions (the `typecheck` feature).
  ///
  /// Returns `Ok(())` when the source type-checks clean, or
  /// [`Error::TypeError`](crate::Error::TypeError) carrying the structured
  /// diagnostics otherwise. Because Luau is dynamically typed, the check is
  /// advisory — it composes with `?` ahead of [`Chunk::exec`] / [`Chunk::eval`]
  /// without changing what running the chunk does:
  ///
  /// ```
  /// # #[cfg(feature = "typecheck")] {
  /// # use ulua_rt::Lua;
  /// let lua = Lua::new();
  /// let c = lua.load("local x: number = 1\nreturn x");
  /// c.check().unwrap();
  /// # }
  /// ```
  #[cfg(feature = "typecheck")]
  #[cfg_attr(docsrs, doc(cfg(feature = "typecheck")))]
  pub fn check(&self) -> Result<()> {
    match &self.source {
      ChunkSource::Text(src) => self.lua.check(src),
      ChunkSource::Bytecode(_) => Ok(()),
    }
  }

  /// Run the chunk for its side effects, discarding return values.
  ///
  /// Mirrors `mlua::Chunk::exec`.
  pub fn exec(self) -> Result<()> {
    let f = self.into_function()?;
    f.call::<()>(())
  }

  /// 表达式优先加载（[`Chunk::eval`] / [`Chunk::eval_async`] 共用）：先把源码改写
  /// 为 `return <src>` 试编译一次，命中直接加载该字节码；失败则走普通语句块路径。
  fn into_function_expr_first(self) -> Result<Function> {
    match &self.source {
      ChunkSource::Bytecode(bytecode) => self.load_bytecode(bytecode),
      ChunkSource::Text(text) => {
        let expr = format!("return {text}");
        if let Ok(bytecode) = self.compile_str(&expr) {
          self.load_bytecode(&bytecode)
        } else {
          self.into_function()
        }
      }
    }
  }

  /// Run the chunk and convert its return value(s) to `R`.
  ///
  /// Mirrors `mlua::Chunk::eval`. Like the Lua REPL (and mlua), the source is
  /// first tried as an *expression* (by prepending `return `); if that
  /// compiles it is used, otherwise the chunk is run as a statement block.
  /// This is what lets `lua.load("coroutine.create(f)").eval::<Thread>()` and
  /// `lua.load("function() ... end").eval::<Function>()` work.
  pub fn eval<R: FromLuaMulti>(self) -> Result<R> {
    self.into_function_expr_first()?.call::<R>(())
  }

  /// Asynchronously load the chunk and call it with `args` (the `async`
  /// feature). Mirrors `mlua::Chunk::call_async`.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub async fn call_async<R>(self, args: impl IntoLuaMulti) -> Result<R>
  where
    R: FromLuaMulti,
  {
    self.into_function()?.call_async(args).await
  }

  /// Asynchronously run the chunk for its side effects (the `async` feature).
  /// Mirrors `mlua::Chunk::exec_async`.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub async fn exec_async(self) -> Result<()> {
    self.call_async(()).await
  }

  /// Asynchronously evaluate the chunk as an expression (or block) and convert
  /// the result to `R` (the `async` feature). Mirrors `mlua::Chunk::eval_async`.
  ///
  /// Like [`Chunk::eval`], the source is first tried as an expression (by
  /// prepending `return `); if that compiles it is driven, otherwise the chunk
  /// runs as a statement block.
  #[cfg(feature = "async")]
  #[cfg_attr(docsrs, doc(cfg(feature = "async")))]
  pub async fn eval_async<R: FromLuaMulti>(self) -> Result<R> {
    self.into_function_expr_first()?.call_async::<R>(()).await
  }
}

/// How a chunk's bytes are interpreted. Mirrors `mlua::ChunkMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkMode {
  /// Text source.
  Text,
  /// Precompiled bytecode.
  Binary,
}

// r7-tlossy1 让位台账（本文件票面 1 枚：让 1）——:121 `String::from_utf8_lossy(&bytes[1..]).into_owned()`
// 编译失败错误臂：`bytes[1..]` 是编译器错误消息，内嵌源码片段可为任意字节（词法/
// 语法错误引用原文），lossy 系 Rust String 表示面所需；汇为 `Error::SyntaxError.
// message: String`（mlua 冻结面），owned 下限 1 malloc 且每次语法错误至多走一次，
// 非热路径。合法 UTF-8 现实全形态走 Borrowed Cow，into_owned 即下限物化，剥壳无账。
