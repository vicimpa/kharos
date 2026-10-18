// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ports mlua's `tests/scope.rs`. ulua-rt's `Lua::scope` supports:
//   - `Scope::create_function` / `create_function_mut` (non-`'static` closures),
//   - `Scope::create_userdata` (non-`'static`, `UserData`-driven userdata),
// with the scope-exit invalidation that surfaces post-scope use as
// `Error::CallbackError { cause: CallbackDestructed }` /
// `Error::CallbackError { cause: UserDataDestructed }`.
//
// DEVIATION (API shape): mlua's newer tests register userdata via a single
// `register(reg: &mut UserDataRegistry<Self>)` method. ulua-rt uses the
// established split `add_fields`/`add_methods` shape (as the rest of this test
// suite does); the registrations are otherwise identical.
//
// DEFERRED (features ulua-rt has not implemented; not part of `Scope` itself):
//   - test_scope_userdata_values   — needs `AnyUserData::call_method`,
//     `set_user_value`/`user_value`.
//   - test_scope_userdata_mismatch — needs the structured `Error::BadArgument`
//     error from userdata-method `self` conversion (ulua-rt method dispatch
//     reports `UserDataTypeMismatch` directly, not wrapped in `BadArgument`).
//   - test_scope_userdata_ref / _ref_mut — need `Scope::create_userdata_ref`
//     `_mut` and `AnyUserData::borrow_scoped`/`borrow_mut_scoped`. ulua-rt's
//     scoped userdata carries no `TypeId`, so the borrowing read-back variants
//     are not yet expressible soundly; deferred.
//   - test_scope_any_userdata / _ref / _ref_mut — need `create_any_userdata`,
//     `Scope::create_any_userdata*`, and `register_userdata_type`.
//   - test_scope_destructors — needs `lua.create_any_userdata`,
//     `AnyUserData::destroy`, and `borrow_scoped`; ulua-rt 不提供任意析构器注册
//     （mlua 的 `Scope::add_destructor` 属 signature-parity 遗留，已删除）。
//
// `send` 特性说明：ulua-rt 的 `Lua`/句柄是 `Send` 但 **`!Sync`**（move-only，非
// mlua 那种 `Arc<ReentrantMutex>` 共享锁），且 `Scope` 因持有 `RefCell` 析构列表而
// `!Send`。因此 `Scope::create_function` 与非 scope 版一样要求 `F: MaybeSend`——
// 作用域回调可随句柄跨线程**移动**（mlua `send` 契约：可移动、绝不并发），故闭包
// 捕获必须全为 `Send`。本文件据此把所有捕获数据改用 `Arc` + 原子量 / `Send`+`Sync`
// 载荷，使 8 个用例在默认与 `send` 两种编译下都成立；唯一无法 `send` 化的是
// `test_scope_capture_scope`（回调内再捕获 `&Scope` 现场建函数，而 `Scope: !Send`），
// 它被 `#[cfg(not(feature = "send"))]` 收敛，理由与 mlua 的锁式作用域模型不同。

#[cfg(not(feature = "send"))]
use std::cell::Cell;
use std::sync::{
  Arc,
  atomic::{AtomicI32, AtomicI64, Ordering},
};

use ulua_rt::{
  Error, Function, Lua, MetaMethod, Result, UserData, UserDataFields, UserDataMethods,
};

#[test]
fn test_scope_func() -> Result<()> {
  let lua = Lua::new();

  // 与非 scope 版 `create_function` 同纪律：`send` 下捕获须 `Send`，故用
  // `Arc<AtomicI32>`（`Rc<Cell>` 在 `send` 下不满足 `MaybeSend`）。计数仍精确
  // 复现「作用域内引用数为 2、退出后回落到 1」的中和语义。
  let rc = Arc::new(AtomicI32::new(0));
  lua.scope(|scope| {
    let rc2 = rc.clone();
    let f = scope.create_function(move |_, ()| {
      rc2.store(42, Ordering::Relaxed);
      Ok(())
    })?;
    lua.globals().set("f", &f)?;
    f.call::<()>(())?;
    assert_eq!(Arc::strong_count(&rc), 2);
    Ok(())
  })?;
  assert_eq!(rc.load(Ordering::Relaxed), 42);
  assert_eq!(Arc::strong_count(&rc), 1);

  match lua.globals().get::<Function>("f")?.call::<()>(()) {
    Err(Error::CallbackError { ref cause, .. }) => match *cause.as_ref() {
      Error::CallbackDestructed => {}
      ref err => panic!("wrong error type {:?}", err),
    },
    r => panic!("improper return for destructed function: {:?}", r),
  };

  Ok(())
}

#[test]
fn test_scope_capture() -> Result<()> {
  let lua = Lua::new();

  let mut i = 0;
  lua.scope(|scope| {
    scope
      .create_function_mut(|_, ()| {
        i = 42;
        Ok(())
      })?
      .call::<()>(())
  })?;
  assert_eq!(i, 42);

  Ok(())
}

#[test]
fn test_scope_outer_lua_access() -> Result<()> {
  let lua = Lua::new();

  // DEVIATION: ulua-rt's `create_table` is infallible (no `?`); mlua 的
  // `Result`-returning 形态未保留（无向下兼容需求）。
  let table = lua.create_table();
  // `send` 下句柄 `!Sync`，`&Table` 非 `Send`，故按 `move` 捕获克隆句柄而非借用。
  let table2 = table.clone();
  lua.scope(|scope| {
    scope
      .create_function(move |_, ()| table2.set("a", "b"))?
      .call::<()>(())
  })?;
  assert_eq!(table.get::<String>("a")?, "b");

  Ok(())
}

#[cfg(not(feature = "send"))]
#[test]
fn test_scope_capture_scope() -> Result<()> {
  let lua = Lua::new();

  // 在回调内以 `&Scope` 现场再建函数：`send` 下 `Scope: !Send`，闭包无法携带
  // `&Scope`，故此嵌套用例仅适用单线程契约（见文件头说明）。
  let i = Cell::new(0);
  lua.scope(|scope| {
    let f = scope.create_function(|_, ()| {
      scope.create_function(|_, n: u32| {
        i.set(i.get() + n);
        Ok(())
      })
    })?;
    f.call::<Function>(())?.call::<()>(10)?;
    Ok(())
  })?;

  assert_eq!(i.get(), 10);

  Ok(())
}

#[test]
fn test_scope_userdata_fields() -> Result<()> {
  // 载荷以 `&AtomicI64`（`Send + Sync`）承载，使 `send` 下
  // `create_userdata` 的 `MaybeSend + MaybeSync` 约束成立；默认编译同样有效。
  struct MyUserData<'a>(&'a AtomicI64);

  impl UserData for MyUserData<'_> {
    // DEVIATION: split `add_fields` instead of mlua's unified `register`.
    fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
      fields.add_field("field", "hello");
      fields.add_field_method_get("val", |_, data| Ok(data.0.load(Ordering::Relaxed)));
      fields.add_field_method_set("val", |_, data, val| {
        data.0.store(val, Ordering::Relaxed);
        Ok(())
      });
    }
  }

  let lua = Lua::new();

  let i = AtomicI64::new(42);
  let f: Function = lua
    .load(
      r#"
            function(u)
                assert(u.field == "hello")
                assert(u.val == 42)
                u.val = 44
            end
        "#,
    )
    .eval()?;

  lua.scope(|scope| f.call::<()>(scope.create_userdata(MyUserData(&i))?))?;

  assert_eq!(i.load(Ordering::Relaxed), 44);

  Ok(())
}

#[test]
fn test_scope_userdata_methods() -> Result<()> {
  struct MyUserData<'a>(&'a AtomicI64);

  impl UserData for MyUserData<'_> {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
      methods.add_method("inc", |_, data, ()| {
        data.0.fetch_add(1, Ordering::Relaxed);
        Ok(())
      });

      methods.add_method("dec", |_, data, ()| {
        data.0.fetch_sub(1, Ordering::Relaxed);
        Ok(())
      });
    }
  }

  let lua = Lua::new();

  let i = AtomicI64::new(42);
  let f: Function = lua
    .load(
      r#"
            function(u)
                u:inc()
                u:inc()
                u:inc()
                u:dec()
            end
        "#,
    )
    .eval()?;

  lua.scope(|scope| f.call::<()>(scope.create_userdata(MyUserData(&i))?))?;

  assert_eq!(i.load(Ordering::Relaxed), 44);

  Ok(())
}

#[test]
fn test_scope_userdata_ops() -> Result<()> {
  struct MyUserData<'a>(&'a i64);

  impl UserData for MyUserData<'_> {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
      methods.add_meta_method(MetaMethod::Add, |lua, this, ()| {
        let globals = lua.globals();
        globals.set("i", globals.get::<i64>("i")? + this.0)?;
        Ok(())
      });
      methods.add_meta_method(MetaMethod::Sub, |lua, this, ()| {
        let globals = lua.globals();
        globals.set("i", globals.get::<i64>("i")? + this.0)?;
        Ok(())
      });
    }
  }

  let lua = Lua::new();

  let dummy = 1;
  let f = lua
    .load(
      r#"
            i = 0
            return function(u)
                _ = u + u
                _ = u - 1
                _ = u + 1
            end
        "#,
    )
    .eval::<Function>()?;

  lua.scope(|scope| f.call::<()>(scope.create_userdata(MyUserData(&dummy))?))?;

  assert_eq!(lua.globals().get::<i64>("i")?, 3);

  Ok(())
}

#[test]
fn test_scope_userdata_drop() -> Result<()> {
  let lua = Lua::new();

  // 载荷改为 `&AtomicI64 + Arc<()>`（均 `Send + Sync`），`send` 下满足
  // `create_userdata` 的约束；默认编译同样复现「作用域退出中和后引用数回落」。
  struct MyUserData<'a>(&'a AtomicI64, Arc<()>);

  impl UserData for MyUserData<'_> {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
      methods.add_method("inc", |_, data, ()| {
        data.0.fetch_add(1, Ordering::Relaxed);
        let _ = &data.1;
        Ok(())
      });
    }
  }

  let (i, rc) = (AtomicI64::new(1), Arc::new(()));
  lua.scope(|scope| {
    let ud = scope.create_userdata(MyUserData(&i, rc.clone()))?;
    lua.globals().set("ud", ud)?;
    lua.load("ud:inc()").exec()?;
    assert_eq!(Arc::strong_count(&rc), 2);
    Ok(())
  })?;
  assert_eq!(Arc::strong_count(&rc), 1);
  assert_eq!(i.load(Ordering::Relaxed), 2);

  match lua.load("ud:inc()").exec() {
    Err(Error::CallbackError { ref cause, .. }) => match cause.as_ref() {
      Error::UserDataDestructed => {}
      err => panic!("expected UserDataDestructed, got {err:?}"),
    },
    r => panic!("improper return for destructed userdata: {r:?}"),
  };

  Ok(())
}
