//! [`MultiValue`] and [`Variadic`]. Mirrors `mlua::MultiValue` / `mlua::Variadic`.

use std::{
  collections::{
    VecDeque,
    vec_deque::{IntoIter as VecDequeIntoIter, Iter as VecDequeIter},
  },
  ops::{Deref, DerefMut},
  vec::IntoIter as VecIntoIter,
};

use crate::value::Value;

/// An ordered, growable sequence of Lua values, used to represent the multiple
/// arguments / multiple return values that Lua functions can take and produce.
///
/// Mirrors `mlua::MultiValue`. Backed by a `VecDeque<Value>` so values can be
/// efficiently popped from the front (argument order) and pushed at the back.
#[derive(Default, Debug, Clone)]
pub struct MultiValue(VecDeque<Value>);

impl MultiValue {
  /// An empty [`MultiValue`].
  pub const fn new() -> MultiValue {
    MultiValue(VecDeque::new())
  }

  /// An empty [`MultiValue`] with capacity preallocated.
  pub fn with_capacity(capacity: usize) -> MultiValue {
    MultiValue(VecDeque::with_capacity(capacity))
  }

  /// Build from a `Vec<Value>` (front = first value).
  pub fn from_vec(vec: Vec<Value>) -> MultiValue {
    MultiValue(vec.into())
  }

  /// Consume into a `Vec<Value>`.
  pub fn into_vec(self) -> Vec<Value> {
    self.0.into()
  }
}

impl Deref for MultiValue {
  type Target = VecDeque<Value>;
  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

impl DerefMut for MultiValue {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.0
  }
}

impl From<Vec<Value>> for MultiValue {
  fn from(vec: Vec<Value>) -> Self {
    MultiValue(vec.into())
  }
}

impl From<MultiValue> for Vec<Value> {
  fn from(m: MultiValue) -> Self {
    m.0.into()
  }
}

impl FromIterator<Value> for MultiValue {
  fn from_iter<I: IntoIterator<Item = Value>>(iter: I) -> Self {
    MultiValue(VecDeque::from_iter(iter))
  }
}

impl IntoIterator for MultiValue {
  type Item = Value;
  type IntoIter = VecDequeIntoIter<Value>;
  fn into_iter(self) -> Self::IntoIter {
    self.0.into_iter()
  }
}

impl<'a> IntoIterator for &'a MultiValue {
  type Item = &'a Value;
  type IntoIter = VecDequeIter<'a, Value>;
  fn into_iter(self) -> Self::IntoIter {
    self.0.iter()
  }
}

/// A wrapper collecting "the rest of" a Lua argument list (or producing a
/// variable number of return values).
///
/// Mirrors `mlua::Variadic`. As an argument type it consumes every remaining
/// value; as a return type it spreads its elements onto the stack.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Variadic<T>(Vec<T>);

impl<T> Variadic<T> {
  /// An empty [`Variadic`].
  pub const fn new() -> Variadic<T> {
    Variadic(Vec::new())
  }

  /// An empty [`Variadic`] with capacity preallocated.
  pub fn with_capacity(capacity: usize) -> Variadic<T> {
    Variadic(Vec::with_capacity(capacity))
  }
}

impl<T> Deref for Variadic<T> {
  type Target = Vec<T>;
  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

impl<T> DerefMut for Variadic<T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.0
  }
}

impl<T> From<Vec<T>> for Variadic<T> {
  fn from(vec: Vec<T>) -> Self {
    Variadic(vec)
  }
}

impl<T> From<Variadic<T>> for Vec<T> {
  fn from(v: Variadic<T>) -> Self {
    v.0
  }
}

impl<T> FromIterator<T> for Variadic<T> {
  fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
    Variadic(Vec::from_iter(iter))
  }
}

impl<T> IntoIterator for Variadic<T> {
  type Item = T;
  type IntoIter = VecIntoIter<T>;
  fn into_iter(self) -> Self::IntoIter {
    self.0.into_iter()
  }
}
