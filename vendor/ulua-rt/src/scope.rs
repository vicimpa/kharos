//! The [`Scope`] type: lifetime-bounded callbacks and userdata.
//!
//! Mirrors `mlua::Scope`. Constructed by [`Lua::scope`], a `Scope` lets you
//! create Lua callbacks and userdata that borrow **non-`'static`** data from the
//! enclosing stack frame. When the `scope` call returns (normally, via `?`, or
//! through a panic), every object the scope created is *invalidated*: its boxed
//! Rust closure / wrapped data is dropped (ending the borrows) and the
//! underlying Lua object is neutralised so any later use from Lua errors with
//! [`Error::CallbackDestructed`] / [`Error::UserDataDestructed`] instead of
//! touching freed memory.
//!
//! ## The soundness argument
//!
//! [`Scope::create_function`] accepts a closure `F: Fn(&Lua, A) -> Result<R> +
//! 'scope` — i.e. **not** `'static`. The callback machinery
//! ([`create_callback_function`](crate::callback)) is monomorphized over the
//! concrete `F`, so the box can be stored in the function's upvalue userdata
//! **without erasing its lifetime** — the callback path involves no `transmute`.
//!
//! Lua may nevertheless keep the resulting [`Function`] handle past the end of
//! `'scope` (e.g. stored in a global). Safety then rests entirely on the
//! **scope-exit invariant**:
//!
//! 1. On scope exit, *before* returning to the caller (and therefore before any
//!    `'scope`-borrowed data can be dropped), every registered destructor runs.
//! 2. A callback's destructor ([`destruct_callback`](crate::callback))
//!    `take()`s the boxed closure out of the function's upvalue slot and drops
//!    it — ending the borrows right there. The slot reads `None` afterwards;
//!    the Lua function object itself stays valid, but any post-scope call
//!    surfaces as `CallbackError { cause: CallbackDestructed }`, never a
//!    use-after-free.
//! 3. A userdata's destructor `take()`s the wrapped value out of its cell
//!    (dropping the borrowed data) while leaving the cell memory valid; later
//!    dispatch finds `None` and returns [`Error::UserDataDestructed`].
//!
//! Because `'scope` outlives nothing the closures borrow until *after* the
//! destructors have run, no borrow can dangle. The destructors are run by a
//! drop guard (the `destructors` field's `Drop`), so they execute even if the
//! user closure returns `Err` or panics — preserving the invariant on every
//! exit path.
//!
//! The destructor list holds only `'static` neutralisers: what
//! [`Scope::create_function`] / [`Scope::create_userdata`] register are boxed
//! closures over `'static` Lua handles (`Function` / `AnyUserData`) — the
//! bodies are generic over the non-`'static` `F`/`T`, but a body's type
//! arguments are not part of the closure's captured regions, so no lifetime
//! erasure happens anywhere in this module. The list is drained by
//! [`Destructors`]' `Drop` inside `Lua::scope`'s body, while the data the scope
//! borrowed is provably still alive (the whole call is nested within `'env`).
//!
//! The two-lifetime shape `Scope<'scope, 'env>` mirrors mlua: `'env` is the
//! lifetime of the data borrowed *into* the scope, `'scope` the (shorter)
//! lifetime of the scope itself. The returned `Function`/`AnyUserData`
//! handles are **not** `'scope`-bounded and may escape the closure — safety
//! comes from scope-exit neutralisation (the destructor list), not from the
//! type system.
//!
//! ## The `send` contract
//!
//! A scope-created callback may be dropped (neutralised) on whatever thread
//! currently owns the VM. `F: MaybeSend` therefore requires the closure to be
//! `Send` under the `send` feature — the same discipline as
//! [`Lua::create_function`](crate::Lua::create_function): only closures whose
//! captures are all `Send` may travel with the (move-only) VM across threads.
//! Unlike the previous dyn-based design, this is now checked by the type system
//! instead of being asserted through an `unsafe transmute`.

use std::{cell::RefCell, marker::PhantomData, mem};

use crate::{
  callback::{create_callback_function, destruct_callback, wrap_mut_closure},
  error::Result,
  function::Function,
  state::Lua,
  sync::{MaybeSend, MaybeSync},
  traits::{FromLuaMulti, IntoLuaMulti},
  userdata::{AnyUserData, UserData, create_scoped_userdata},
};

/// A scope for creating lifetime-bounded Lua callbacks and userdata.
///
/// Mirrors `mlua::Scope`. See the module docs and [`Lua::scope`] for the
/// full picture, including the soundness argument for scope-exit destruction.
pub struct Scope<'scope, 'env: 'scope> {
  lua: Lua,
  /// 退出作用域时倒序运行的析构器，由本字段的 `Drop` 实现触发；独立成类型，
  /// 确保无论 `scope` 闭包如何退出都会执行（见 [`Destructors`]）。
  destructors: Destructors,
  /// Invariance over `'scope` and `'env`, exactly as mlua, so created objects
  /// cannot outlive the scope and the borrowed data cannot be shortened.
  _scope_invariant: PhantomData<&'scope mut &'scope ()>,
  _env_invariant: PhantomData<&'env mut &'env ()>,
}

/// The registered destructors. Wrapped in its own struct so the `Drop` impl
/// runs the destructors even if the user's `scope` closure panics or returns
/// `Err`. Each box is `pop`ped and called exactly once when the `Scope` drops
/// — inside `Lua::scope`, while the scope-borrowed data is still alive.
///
/// dyn 保留：析构器列表元素类型集**运行期开放**——每个用户闭包类型 `F` /
/// userdata 类型 `T` 各自单态化出不同闭包，异构列表无法用静态可穷举的 enum
/// 或泛型收敛。
///
/// DELIBERATE DEVIATION（保留 `Vec<Box<dyn FnOnce()>>`）：列表元素是异构闭包集合，
/// 无法单态化或枚举化；仅在 scope 退出时遍历调用一次，非热路径。调用点证据：
/// [`Scope::create_function`] push `move || destruct_callback::<F>(&f)`（每个不同
/// `F` 单态化出不同闭包类型），[`Scope::create_userdata`] push
/// `create_scoped_userdata` 返回的按 `T` 单态化中和闭包——两类、且各自随用户类型
/// 增长，运行期种类开放。
struct Destructors {
  list: RefCell<Vec<Box<dyn FnOnce()>>>,
}

impl Drop for Destructors {
  fn drop(&mut self) {
    // Run destructors in reverse registration order (LIFO), so objects are
    // torn down opposite to how they were built — matching mlua. Each
    // destructor only drops Rust state / neutralises a Lua object and never
    // panics, so a `pop` loop is fine even mid-unwind.
    let mut list = mem::take(&mut *self.list.borrow_mut());
    while let Some(destructor) = list.pop() {
      destructor();
    }
  }
}

impl<'scope, 'env: 'scope> Scope<'scope, 'env> {
  pub(crate) fn new(lua: Lua) -> Self {
    Scope {
      lua,
      destructors: Destructors {
        list: RefCell::new(Vec::new()),
      },
      _scope_invariant: PhantomData,
      _env_invariant: PhantomData,
    }
  }

  /// Wrap a non-`'static` Rust closure into a callable Lua [`Function`] that is
  /// invalidated when the scope ends.
  ///
  /// This is the scoped version of [`Lua::create_function`]: the closure may
  /// borrow data living for `'scope`. The closure is stored at its concrete
  /// type (no lifetime erasure); see the module docs for why the
  /// scope-exit neutralisation makes that sound.
  pub fn create_function<F, A, R>(&'scope self, func: F) -> Result<Function>
  where
    F: Fn(&Lua, A) -> Result<R> + MaybeSend + 'scope,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    let f = create_callback_function(&self.lua, func)?;

    // Register the neutraliser: on scope exit, take the boxed closure out of
    // the upvalue slot and drop it. `F` here is the very type the trampoline
    // was monomorphized with, so the slot layout matches by construction.
    let f_for_dtor = f.clone();
    self
      .destructors
      .list
      .borrow_mut()
      .push(Box::new(move || destruct_callback::<F>(&f_for_dtor)));

    Ok(f)
  }

  /// Wrap a non-`'static` mutable Rust closure into a callable Lua [`Function`]
  /// that is invalidated when the scope ends.
  ///
  /// This is the scoped version of `create_function_mut`. The closure is
  /// guarded by a [`RefCell`]; re-entrant calls (the callback triggering Lua
  /// that calls the same callback) surface as
  /// [`Error::RecursiveMutCallback`](crate::Error::RecursiveMutCallback)
  /// rather than a borrow panic — same variant as
  /// [`Lua::create_function_mut`](crate::Lua::create_function_mut), mirroring mlua.
  pub fn create_function_mut<F, A, R>(&'scope self, func: F) -> Result<Function>
  where
    F: FnMut(&Lua, A) -> Result<R> + MaybeSend + 'scope,
    A: FromLuaMulti,
    R: IntoLuaMulti,
  {
    self.create_function(wrap_mut_closure!(func))
  }

  /// Create a Lua userdata wrapping a non-`'static` `T: UserData`, invalidated
  /// when the scope ends.
  ///
  /// This is the scoped version of [`Lua::create_userdata`]: `T` need not be
  /// `'static`, so it may borrow `'env` data. The trade-off (matching mlua) is
  /// that the userdata carries no `TypeId`, so the value cannot be read back
  /// out by concrete type from an [`AnyUserData`] handle — only metatable
  /// method/field/meta dispatch is supported. After the scope ends, any access
  /// from Lua errors with [`crate::Error::UserDataDestructed`].
  pub fn create_userdata<T>(&'scope self, data: T) -> Result<AnyUserData>
  where
    T: UserData + MaybeSend + MaybeSync + 'env,
  {
    // The neutraliser drops `data` on scope exit (see module docs); the
    // userdata never exposes the value back to Rust by type.
    let (ud, neutralise) = create_scoped_userdata(&self.lua, data)?;
    self.destructors.list.borrow_mut().push(neutralise);
    Ok(ud)
  }
}

impl Lua {
  /// Create a [`Scope`] in which non-`'static` callbacks and userdata can be
  /// created, borrowing data from the enclosing stack frame.
  ///
  /// Mirrors `mlua::Lua::scope`. Everything the scope creates is invalidated
  /// when this method returns (on every exit path), so the borrows it held are
  /// guaranteed to end before the borrowed data can. See [`Scope`] and the
  /// [`scope` module docs](crate::Scope) for the soundness argument.
  ///
  /// ```
  /// use ulua_rt::prelude::*;
  /// use std::sync::atomic::{AtomicUsize, Ordering};
  ///
  /// let lua = Lua::new();
  /// // 用原子计数而非 Cell：`send` feature 下 scope 回调须 MaybeSend。
  /// let counter = AtomicUsize::new(0);
  /// lua.scope(|scope| {
  ///     let f = scope.create_function(|_, ()| {
  ///         counter.fetch_add(1, Ordering::Relaxed);
  ///         Ok(())
  ///     })?;
  ///     f.call::<()>(())?;
  ///     Ok(())
  /// })
  /// .unwrap();
  /// assert_eq!(counter.load(Ordering::Relaxed), 1);
  /// ```
  pub fn scope<'env, R>(
    &self,
    f: impl for<'scope> FnOnce(&'scope Scope<'scope, 'env>) -> Result<R>,
  ) -> Result<R> {
    let scope = Scope::new(self.clone());
    // `f` runs; on return (or unwind) `scope` drops, running all destructors
    // via `Destructors::drop` — the invariant that keeps the non-`'static`
    // closures sound. We materialise the result before `scope` is dropped.
    f(&scope)
  }
}
