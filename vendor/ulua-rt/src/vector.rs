//! The [`Vector`] type (Luau `vector`). Mirrors `mlua::Vector`.
//!
//! Unlike the reference-typed handles, a Luau vector is a small *value* type
//! (its components live inline in the VM `TValue`, not on the GC heap), so
//! [`Vector`] is a plain `Copy` struct of its components — no registry ref
//! needed. ulua is built with `LUA_VECTOR_SIZE == 3`, so [`Vector`] is
//! 3-dimensional here (mlua's `luau-vector4` path is N/A — see
//! `tests/ATTRIBUTION.md`).

use std::fmt;

/// A Luau vector type.
///
/// Mirrors `mlua::Vector`. ulua is a 3-dimensional-vector build
/// (`LUA_VECTOR_SIZE == 3`), so this is always a 3-component vector.
#[derive(Debug, Default, Clone, Copy, PartialEq, PartialOrd)]
pub struct Vector(pub(crate) [f32; Self::SIZE]);

impl fmt::Display for Vector {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "vector({}, {}, {})", self.x(), self.y(), self.z())
  }
}

impl Vector {
  /// The number of components. ulua is a 3-wide build.
  pub(crate) const SIZE: usize = 3;

  /// Creates a new vector.
  ///
  /// Mirrors `mlua::Vector::new`.
  pub const fn new(x: f32, y: f32, z: f32) -> Self {
    Self([x, y, z])
  }

  /// Creates a new vector with all components set to `0.0`.
  ///
  /// Mirrors `mlua::Vector::zero`.
  pub const fn zero() -> Self {
    Self([0.0; Self::SIZE])
  }

  /// Returns 1st component of the vector.
  pub const fn x(&self) -> f32 {
    self.0[0]
  }

  /// Returns 2nd component of the vector.
  pub const fn y(&self) -> f32 {
    self.0[1]
  }

  /// Returns 3rd component of the vector.
  pub const fn z(&self) -> f32 {
    self.0[2]
  }
}

impl PartialEq<[f32; Self::SIZE]> for Vector {
  #[inline]
  fn eq(&self, other: &[f32; Self::SIZE]) -> bool {
    self.0 == *other
  }
}
