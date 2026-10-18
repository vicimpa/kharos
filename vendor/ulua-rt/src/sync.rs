//! Send-portability primitives, gated on the `send` feature.
//!
//! This module mirrors mlua's `XRc` / `MaybeSend` / `MaybeSync` machinery
//! ([`mlua-ref/src/types.rs`] + `types/sync.rs`) but in the simpler shape that
//! ulua-rt needs: ulua-rt is **never** `Sync`. Under the `send` feature a
//! [`Lua`](crate::Lua) and all of its handles become `Send` so the whole VM can
//! be **moved** to another thread; they are *not* usable concurrently. The user
//! guarantees serialized access (exactly mlua's documented `send` contract).
//!
//! ## What `send` changes
//!
//! - [`XRc<T>`] aliases `Arc<T>` (atomically reference-counted, `Send`) instead
//!   of `Rc<T>`. The shared `LuaInner` / `LuaRef` handles use it, so cloning a
//!   handle across the `Send` boundary keeps the refcount sound.
//! - [`MaybeSend`] gains a `Send` super-bound, so every type-erased callback /
//!   userdata closure box stored inside the VM is `Send`, and the captured
//!   environment can hold `Send` data moved in from another thread.
//! - The raw `*mut LuaState` pointers held by `LuaInner` (and, transitively,
//!   every handle) are made `Send` with a documented `unsafe impl Send` (the
//!   move-not-share contract). We deliberately do **not** impl `Sync`.
//!
//! Without the feature everything is byte-for-byte identical to the original
//! single-threaded build: `XRc` = `Rc`, and `MaybeSend` / `MaybeSync` are empty
//! marker traits blanket-implemented for every type (zero bound, zero cost).

#[cfg(feature = "send")]
use core::{cell::Cell, marker::PhantomData};
#[cfg(not(feature = "send"))]
use std::rc::{Rc, Weak};
#[cfg(feature = "send")]
use std::sync::{Arc, Weak};

/// Reference-counted shared pointer used for the VM's shared interior
/// (`LuaInner`) and the registry references (`LuaRef`) every handle clones.
///
/// `Arc` under the `send` feature (so handles can cross a thread boundary),
/// `Rc` otherwise (single-threaded, the default — byte-identical to before).
#[cfg(feature = "send")]
pub(crate) type XRc<T> = Arc<T>;

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub(crate) type XRc<T> = Rc<T>;

/// The weak counterpart of [`XRc`]: `Weak` from `Arc`/`Rc` depending on `send`.
/// Used by [`WeakLua`](crate::state::WeakLua) to hold a non-owning reference to
/// the VM's shared interior. Mirrors mlua's `XWeak`.
#[cfg(feature = "send")]
pub(crate) type XWeak<T> = Weak<T>;

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub(crate) type XWeak<T> = Weak<T>;

/// A trait that adds a `Send` requirement **iff** the `send` feature is enabled.
///
/// Mirrors `mlua::MaybeSend`. It is applied to every Rust closure that gets
/// type-erased and stored inside the VM (the `create_function` closure, every
/// userdata method/field/function closure, and — under `async` — the async
/// callback) and to the userdata payload type `T`. Under `send` that forces the
/// stored boxes (and their captured environment) to be `Send`; without the
/// feature it is an empty marker implemented for all types, so the extra bound
/// is a no-op and the default build is unchanged.
#[cfg(feature = "send")]
pub trait MaybeSend: Send {}
#[cfg(feature = "send")]
impl<T: Send> MaybeSend for T {}

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub trait MaybeSend {}
#[cfg(not(feature = "send"))]
impl<T> MaybeSend for T {}

/// A trait that adds a `Sync` requirement **iff** the `send` feature is enabled.
///
/// Mirrors `mlua::MaybeSync`. Provided for signature parity with mlua's
/// userdata bounds (`T: UserData + MaybeSend + MaybeSync`). Because ulua-rt's
/// `Lua` is itself never `Sync`, this only constrains the *payload* type, again
/// matching mlua.
#[cfg(feature = "send")]
pub trait MaybeSync: Sync {}
#[cfg(feature = "send")]
impl<T: Sync> MaybeSync for T {}

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub trait MaybeSync {}
#[cfg(not(feature = "send"))]
impl<T> MaybeSync for T {}

/// A zero-sized phantom marker that makes the public `Lua` handle (and every
/// other handle that embeds it) **`Send` but not `Sync`** under the `send`
/// feature.
///
/// We need `LuaInner` to be `Sync` internally so that `XRc<LuaInner>`
/// (`Arc<LuaInner>`) is `Send`. But the public contract is move-only, never
/// shared: a handle must not be `Sync`. Embedding a `NotSync` field re-imposes
/// `!Sync` on the wrapper (`PhantomData<std::cell::Cell<()>>` is `Send` but
/// `!Sync`) without affecting `Send`.
///
/// Under the default (no `send`) build it is the unit type `()`, so the handle
/// structs are byte-for-byte identical to before (the field is a zero-sized
/// `()`; the whole `Lua` is already `!Send`/`!Sync` via `Rc`).
#[cfg(feature = "send")]
pub(crate) type NotSync = PhantomData<Cell<()>>;

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub(crate) type NotSync = ();

/// The value of a [`NotSync`] field, written once at each handle construction
/// site so the same source compiles under both feature settings.
#[cfg(feature = "send")]
pub(crate) const NOT_SYNC: NotSync = PhantomData;

/// See the `send`-gated variant above.
#[cfg(not(feature = "send"))]
pub(crate) const NOT_SYNC: NotSync = ();
