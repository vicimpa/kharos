//! The [`Compiler`] builder. Mirrors `mlua::Compiler`.
//!
//! Luau compiles *source* to bytecode through a set of compile-time options
//! (optimization level, debug level, the `vector` constructor/type names used
//! to enable vector fastcalls, etc.). mlua exposes these as a fluent `Compiler`
//! builder; this is the ulua-rt equivalent, built directly on `ulua_compiler`'s
//! [`CompileOptions`].
//!
//! A [`Compiler`] owns the option names (`String`) that [`CompileOptions`]
//! embeds by value at [`Compiler::to_options`], so a chunk compiled through it
//! needs no further lifetime coupling. [`Chunk::set_compiler`] /
//! [`Lua::set_compiler`] store it for exactly that scope.

use core::str::from_utf8;

use ulua_compiler::records::compile_options::CompileOptions;

/// 把编译选项名（vector 构造器/类型名）收成为惯用 Rust `String`。这些名字
/// 理论上是合法标识符、绝不含 NUL，含 NUL 或非 UTF-8 属调用方 bug：
/// `debug_assert!` 在 debug 构建当场暴露；release 下安全降级为 `None`
/// （跳过该选项），与旧的 `.ok()` 行为一致，绝不 panic、不吞下后续路径。
fn option_name(name: impl AsRef<[u8]>) -> Option<String> {
  let text = from_utf8(name.as_ref()).ok()?;
  debug_assert!(
    !text.contains('\0'),
    "compiler option name must not contain a NUL byte"
  );
  (!text.contains('\0')).then(|| text.to_owned())
}

/// Luau bytecode compiler options, mirroring `mlua::Compiler`.
///
/// Construct with [`Compiler::new`], tune with the `set_*` builder methods, and
/// attach to a chunk with [`Chunk::set_compiler`](crate::Chunk::set_compiler)
/// (or to the whole VM with [`Lua::set_compiler`](crate::Lua::set_compiler)).
///
/// ```
/// use ulua_rt::Compiler;
/// let _c = Compiler::new()
///     .set_optimization_level(2)
///     .set_debug_level(1)
///     .set_vector_ctor("vector");
/// ```
#[derive(Debug, Clone)]
pub struct Compiler {
  optimization_level: u8,
  debug_level: u8,
  type_info_level: u8,
  coverage_level: u8,
  vector_ctor: Option<String>,
  vector_type: Option<String>,
}

impl Default for Compiler {
  fn default() -> Self {
    Self::new()
  }
}

impl Compiler {
  /// Create a `Compiler` with Luau's default options (optimization level 1,
  /// debug level 1). Mirrors `mlua::Compiler::new`.
  pub fn new() -> Self {
    let defaults = CompileOptions::default();
    Compiler {
      optimization_level: defaults.optimization_level as u8,
      debug_level: defaults.debug_level as u8,
      type_info_level: defaults.type_info_level as u8,
      coverage_level: defaults.coverage_level as u8,
      vector_ctor: None,
      vector_type: None,
    }
  }

  /// Set the optimization level (0..=2). Mirrors
  /// `mlua::Compiler::set_optimization_level`.
  pub fn set_optimization_level(mut self, level: u8) -> Self {
    self.optimization_level = level;
    self
  }

  /// Set the debug level (0..=2). Mirrors `mlua::Compiler::set_debug_level`.
  pub fn set_debug_level(mut self, level: u8) -> Self {
    self.debug_level = level;
    self
  }

  /// Set the type-info level. Mirrors `mlua::Compiler::set_type_info_level`.
  pub fn set_type_info_level(mut self, level: u8) -> Self {
    self.type_info_level = level;
    self
  }

  /// Set the coverage level (0..=2). Mirrors
  /// `mlua::Compiler::set_coverage_level`.
  pub fn set_coverage_level(mut self, level: u8) -> Self {
    self.coverage_level = level;
    self
  }

  /// Set the constructor name used to build vectors (enables compiling
  /// `vector(...)` calls to the `vector` type). Mirrors
  /// `mlua::Compiler::set_vector_ctor`.
  pub fn set_vector_ctor(mut self, ctor: impl AsRef<[u8]>) -> Self {
    self.vector_ctor = option_name(ctor.as_ref());
    self
  }

  /// Set the user vector *type* name used for field/method fastcalls.
  /// Mirrors `mlua::Compiler::set_vector_type`.
  pub fn set_vector_type(mut self, ty: impl AsRef<[u8]>) -> Self {
    self.vector_type = option_name(ty.as_ref());
    self
  }

  /// Build a [`CompileOptions`] snapshot of `self`; names are embedded by
  /// value, so the returned options need no borrowed state from `self`.
  pub(crate) fn to_options(&self) -> CompileOptions {
    CompileOptions {
      optimization_level: self.optimization_level as i32,
      debug_level: self.debug_level as i32,
      type_info_level: self.type_info_level as i32,
      coverage_level: self.coverage_level as i32,
      vector_ctor: self.vector_ctor.clone(),
      vector_type: self.vector_type.clone(),
      ..Default::default()
    }
  }
}
