//! Error type and `Result` alias, mirroring mlua's [`Error`] / [`Result`].
//!
//! We expose the common, developer-facing subset of mlua's `Error` variants
//! (`RuntimeError`, `SyntaxError`, the two conversion errors, etc.) plus the
//! `Error::external` / `Error::runtime` constructors. Variants specific to
//! features we have not implemented (async, serde, scopes, registry keys) are
//! intentionally omitted.

use core::result::Result as StdResult;
use std::{error::Error as StdError, fmt, io::Error as IoError, sync::Arc};

#[cfg(feature = "serde")]
use serde::{de::Error as DeError, ser::Error as SerError};
use thiserror::Error as ThisError;

#[cfg(feature = "typecheck")]
use crate::typecheck::TypeDiagnostic;

// `Result` is defined below; `Arc<Error>` is used by `Error::CallbackError`.

/// A boxed standard error, used by [`Error::ExternalError`].
///
/// dyn 保留：外部错误类型集合**运行期开放**——[`Error::external`] 与
/// [`ExternalError`] 的界 `T: Into<Box<DynStdError>>` 收纳任意三方 / 宿主自定义
/// 错误（`io::Error`、serde/sonic 错误、回调里用户返回的任意 `Error`），不存在
/// 可静态穷举的类型集合；downcast 回读见 [`Error::downcast_ref`]。泛型化该变体
/// 需给整个公开枚举参数化，代价不合理。
type DynStdError = dyn StdError + Send + Sync;

/// `From*ConversionError::message` 的 Display 适配器。
///
/// `Some` 时输出 `" (说明)"`，`None` 时输出空串 —— 与原手写 `Display` 逐字一致，
/// 且零分配（不为可选尾注拼临时 `String`）。
struct OptMessage<'a>(&'a Option<String>);

impl fmt::Display for OptMessage<'_> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self.0 {
      Some(message) => write!(f, " ({message})"),
      None => Ok(()),
    }
  }
}

/// [`Error::CallbackError`] 的 Display 前缀适配器。
///
/// 正常路径下 [`Error::CallbackError::traceback`] 由 `Lua::pop_error` 用
/// `luaL_traceback` 填好（首行即 `"stack traceback:"`），此时只输出 cause，
/// 回溯由后面的字段原样接上；仅在取不到回溯（空串）时补一个 `": "` 分隔，
/// 保持与旧输出 `runtime error: xxx` 逐字一致。
struct CallbackCause<'a>(&'a Error);

impl fmt::Display for CallbackCause<'_> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self.0 {
      // 内层也是 CallbackError 时，它的 Display 已经带了自己的 traceback，
      // 逐字沿用（等价于 mlua 的「向下钻到根 cause」写法）。
      Error::CallbackError { .. } => write!(f, "{}", self.0),
      Error::RuntimeError(message) => writeln!(f, "runtime error: {message}"),
      other => write!(f, "{other}"),
    }
  }
}

/// [`Error::TypeError`] 诊断列表的 Display 适配器：逐条以 `"\n  "` 缩进。
#[cfg(feature = "typecheck")]
struct DiagList<'a>(&'a [TypeDiagnostic]);

#[cfg(feature = "typecheck")]
impl fmt::Display for DiagList<'_> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    for diagnostic in self.0 {
      write!(f, "\n  {diagnostic}")?;
    }
    Ok(())
  }
}

/// The result type used throughout `ulua-rt`, mirroring `mlua::Result`.
pub type Result<T> = StdResult<T, Error>;

/// Errors that can occur when interacting with the Lua engine.
///
/// The variant set mirrors the commonly used part of mlua's `Error`. It is
/// marked `#[non_exhaustive]` (like mlua's) so new variants can be added
/// without a breaking change.
///
/// `Display` 与 `Error::source` 由 `thiserror` derive 生成：文案逐字对齐 mlua
/// （见每个变体上的 `#[error(...)]`），`source` 只在确实携带内层错误的
/// [`Error::ExternalError`] / [`Error::CallbackError`] 上转发。
#[derive(Debug, Clone, ThisError)]
#[non_exhaustive]
pub enum Error {
  /// A Lua syntax (compile/parse) error.
  #[error("syntax error: {message}")]
  SyntaxError {
    /// The human-readable message produced by the compiler.
    message: String,
    /// Whether the input looked like it was merely incomplete (e.g. an
    /// unterminated block). Always `false` for now; reserved for REPL use.
    incomplete_input: bool,
  },
  /// A Lua runtime error (`error(..)`, a failed `assert`, a type error, or a
  /// Rust callback returning `Err`).
  #[error("runtime error: {0}")]
  RuntimeError(String),
  /// A memory allocation error reported by the VM.
  #[error("memory error: {0}")]
  MemoryError(String),
  /// A value could not be converted **from** a Lua value into the requested
  /// Rust type.
  #[error("error converting Lua {from} to {to}{}", OptMessage(.message))]
  FromLuaConversionError {
    /// The Lua type name of the source value.
    from: &'static str,
    /// The name of the target Rust type.
    to: String,
    /// Optional extra detail.
    message: Option<String>,
  },
  /// A Rust value could not be converted **into** a Lua value.
  #[error("error converting {from} to Lua {to}{}", OptMessage(.message))]
  ToLuaConversionError {
    /// The name of the source Rust type.
    from: &'static str,
    /// The Lua type name being targeted.
    to: &'static str,
    /// Optional extra detail.
    message: Option<String>,
  },
  /// A `UserData` value was accessed as the wrong concrete type.
  #[error("userdata type mismatch")]
  UserDataTypeMismatch,
  /// A `UserData` value was used after it had been destructed (dropped).
  #[error("userdata used after being destructed")]
  UserDataDestructed,
  /// Either a callback or a userdata method was called, but the callback or
  /// userdata had been destructed.
  ///
  /// This happens when a function/userdata created via [`Lua::scope`] is used
  /// after the scope has ended (so the scope has already dropped the boxed
  /// closure / invalidated the Lua object). Mirrors
  /// `mlua::Error::CallbackDestructed`.
  ///
  /// [`Lua::scope`]: crate::Lua::scope
  #[error("a destructed callback or destructed userdata method was called")]
  CallbackDestructed,
  /// A Rust callback returned `Err`, which was raised as a Lua error and then
  /// caught at a protected-call boundary (e.g. [`Function::call`]). The
  /// original error is preserved in `cause`. Mirrors
  /// `mlua::Error::CallbackError`.
  ///
  /// ulua-rt only produces this variant for callback errors that carry
  /// structured meaning across the Lua boundary (currently
  /// [`Error::CallbackDestructed`] and [`Error::UserDataDestructed`]); plain
  /// string callback errors continue to surface as [`Error::RuntimeError`] for
  /// backward compatibility.
  ///
  /// [`Function::call`]: crate::Function::call
  #[error("{}{traceback}", CallbackCause(.cause))]
  CallbackError {
    /// A Lua call-stack traceback captured at the protected-call boundary by
    /// `Lua::pop_error` (empty only when the traceback
    /// itself could not be produced, e.g. the VM ran out of stack).
    traceback: String,
    /// The original error returned by the Rust callback.
    #[source]
    cause: Arc<Error>,
  },
  /// A `UserData` could not be immutably borrowed because it is already
  /// mutably borrowed.
  #[error("userdata already mutably borrowed")]
  UserDataBorrowError,
  /// A `UserData` could not be mutably borrowed because it is already
  /// borrowed.
  #[error("userdata already borrowed")]
  UserDataBorrowMutError,
  /// A coroutine ([`crate::Thread`]) could not be resumed because it has
  /// finished, errored, or is currently running. Mirrors
  /// `mlua::Error::CoroutineUnresumable`.
  #[error("cannot resume this coroutine")]
  CoroutineUnresumable,
  /// A [`crate::RegistryKey`] was used with a [`crate::Lua`] that does not
  /// own it. Mirrors `mlua::Error::MismatchedRegistryKey`.
  #[error("registry key used with the wrong Lua instance")]
  MismatchedRegistryKey,
  /// A `create_function_mut` / `create_userdata` mutable callback was invoked
  /// re-entrantly while a previous invocation still held the `&mut`. The inner
  /// `RefCell` borrow failed, which we surface as this variant rather than
  /// allowing mutable aliasing. Mirrors `mlua::Error::RecursiveMutCallback`.
  #[error("mutable callback called recursively")]
  RecursiveMutCallback,
  /// An error originating outside Lua, wrapped via [`Error::external`].
  #[error("{0}")]
  ExternalError(#[source] Arc<DynStdError>),
  /// A serialization (Rust -> Lua) error produced by the `serde` feature.
  /// Mirrors `mlua::Error::SerializeError`.
  #[cfg(feature = "serde")]
  #[error("serialize error: {0}")]
  SerializeError(String),
  /// A deserialization (Lua -> Rust) error produced by the `serde` feature.
  /// Mirrors `mlua::Error::DeserializeError`.
  #[cfg(feature = "serde")]
  #[error("deserialize error: {0}")]
  DeserializeError(String),
  /// One or more static type-checker diagnostics produced by the `typecheck`
  /// feature (e.g. [`Lua::check`](crate::Lua::check) /
  /// [`Chunk::check`](crate::Chunk::check)). Each
  /// [`TypeDiagnostic`](crate::TypeDiagnostic) carries its 1-based source
  /// location.
  ///
  /// There is no mlua equivalent: Lua has no static types, so mlua cannot
  /// type-check a script before running it.
  #[cfg(feature = "typecheck")]
  #[error("type error(s):{}", DiagList(.0))]
  TypeError(Vec<TypeDiagnostic>),
}

#[cfg(feature = "serde")]
impl SerError for Error {
  fn custom<T: fmt::Display>(msg: T) -> Self {
    Error::SerializeError(msg.to_string())
  }
}

#[cfg(feature = "serde")]
impl DeError for Error {
  fn custom<T: fmt::Display>(msg: T) -> Self {
    Error::DeserializeError(msg.to_string())
  }
}

impl Error {
  /// Create a [`Error::RuntimeError`] from any displayable message.
  ///
  /// Mirrors `mlua::Error::runtime`.
  pub fn runtime<S: fmt::Display>(message: S) -> Self {
    Error::RuntimeError(message.to_string())
  }

  /// Try to view the wrapped external error as a concrete type `T`.
  ///
  /// Mirrors the common `mlua::Error::downcast_ref` use: only
  /// [`Error::ExternalError`] carries a wrapped error to downcast.
  pub fn downcast_ref<T: StdError + 'static>(&self) -> Option<&T> {
    match self {
      Error::ExternalError(e) => e.downcast_ref::<T>(),
      _ => None,
    }
  }

  /// Wrap an arbitrary `std::error::Error` as an [`Error::ExternalError`].
  ///
  /// Mirrors `mlua::Error::external`: if the input is already a ulua
  /// [`Error`], it is preserved as-is rather than re-wrapped.
  pub fn external<T: Into<Box<DynStdError>>>(err: T) -> Self {
    let boxed: Box<DynStdError> = err.into();
    // Preserve an already-`Error` value instead of nesting it.
    match boxed.downcast::<Error>() {
      Ok(e) => *e,
      Err(other) => Error::ExternalError(other.into()),
    }
  }
}

// 下面 3 个 `From` 保持手写而不用 `#[from]` derive：`#[from]` 会把字段同时记为
// `source`，而 `String`/`&str` 并未实现 `std::error::Error`（derive 直接编译
// 失败）；`io::Error` 还必须走 `Error::external` 的「已是 `Error` 就不套壳」
// downcast 语义，同样不是 derive 能表达的纯包装。

impl From<IoError> for Error {
  fn from(err: IoError) -> Self {
    Error::external(err)
  }
}

impl From<&str> for Error {
  fn from(msg: &str) -> Self {
    Error::RuntimeError(msg.to_string())
  }
}

impl From<String> for Error {
  fn from(msg: String) -> Self {
    Error::RuntimeError(msg)
  }
}

/// Convenience for turning an arbitrary error/displayable into an [`Error`].
///
/// Mirrors `mlua::ExternalError`. `&str`/`String` become a [`Error::RuntimeError`]
/// (matching mlua's runtime-error semantics for string errors); other
/// `std::error::Error` types become an [`Error::ExternalError`].
pub trait ExternalError {
  /// Convert `self` into an [`Error`].
  fn into_lua_err(self) -> Error;
}

impl<E: Into<Box<DynStdError>>> ExternalError for E {
  fn into_lua_err(self) -> Error {
    // `&str`/`String`/`io::Error`/... all implement `Into<Box<dyn Error>>`.
    // Plain string errors become runtime errors (matching mlua); a wrapped
    // `mlua::Error` is preserved by `Error::external`.
    Error::external(self)
  }
}

/// `Result` extension mirroring `mlua::ExternalResult`: lift any
/// `Result<T, E>` into a `ulua` [`Result`] by converting the error.
pub trait ExternalResult<T> {
  /// Convert the error side via [`ExternalError::into_lua_err`].
  fn into_lua_err(self) -> Result<T>;
}

impl<T, E: ExternalError> ExternalResult<T> for StdResult<T, E> {
  fn into_lua_err(self) -> Result<T> {
    self.map_err(ExternalError::into_lua_err)
  }
}
