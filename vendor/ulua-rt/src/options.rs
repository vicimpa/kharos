//! [`StdLib`] and [`LuaOptions`] — the standard-library selection and the
//! per-VM behavioral options accepted by [`Lua::new_with`](crate::Lua::new_with).
//!
//! ulua opens the Luau standard library wholesale (`luaL_openlibs`), so the
//! only meaningful distinction for [`StdLib`] is [`StdLib::NONE`] (open
//! nothing) vs. any non-empty selection (open the full Luau base libraries).
//! The Lua-5.x-specific libraries that mlua's per-library flags name (`debug`,
//! `package`, `ffi`, ...) are not separable in Luau, so no per-library bits
//! exist here.

/// Whether to open the Luau standard libraries.
///
/// **DEVIATION:** ulua opens the Luau base libraries as a single unit
/// (`luaL_openlibs`); the individual libraries cannot be toggled
/// independently. [`StdLib::NONE`] opens nothing; any non-empty selection opens
/// the full Luau standard library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StdLib(u32);

impl StdLib {
  /// Open no standard libraries.
  pub const NONE: StdLib = StdLib(0);
  /// The default Luau set opened by `luaL_openlibs`.
  pub const ALL_SAFE: StdLib = StdLib(1);

  /// Whether this selection is empty (opens nothing).
  pub(crate) const fn is_none(self) -> bool {
    self.0 == 0
  }
}

/// Per-VM behavioral options. Mirrors `mlua::LuaOptions`.
#[derive(Debug, Clone, Copy)]
pub struct LuaOptions {
  /// Whether a Rust panic raised inside a callback should be **caught** and
  /// converted into a catchable Lua error (the default, `true`), or allowed to
  /// propagate across the VM boundary as a Rust unwind (`false`). Mirrors
  /// `mlua::LuaOptions::catch_rust_panics`.
  pub(crate) catch_rust_panics: bool,
}

impl LuaOptions {
  /// The default options (`catch_rust_panics = true`). Mirrors
  /// `mlua::LuaOptions::new`.
  pub const fn new() -> LuaOptions {
    LuaOptions {
      catch_rust_panics: true,
    }
  }

  /// Set whether Rust panics in callbacks are caught and converted to Lua
  /// errors. Mirrors `mlua::LuaOptions::catch_rust_panics`.
  pub const fn catch_rust_panics(mut self, enabled: bool) -> LuaOptions {
    self.catch_rust_panics = enabled;
    self
  }
}

impl Default for LuaOptions {
  fn default() -> Self {
    LuaOptions::new()
  }
}
