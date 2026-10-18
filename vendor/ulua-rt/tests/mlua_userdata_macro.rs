// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua's `tests/userdata_macro.rs`, exercising the `macros`
// feature: the `#[derive(UserData)]` and `#[derive(FromLua)]` procedural
// derives (`crates/ulua-rt-derive`).
//
// SCOPE / DEFERRED.
//   mlua's `userdata_macro.rs` is built almost entirely on the
//   `#[mlua::userdata_impl]` *attribute* macro, which turns a whole `impl`
//   block into method/meta/field registrations through an `inventory`-based
//   `UserDataRegistry` plus `Lua::create_proxy`. ulua-rt has neither the
//   registry, the inventory collection, nor `create_proxy`, and its `UserData`
//   trait uses the `add_fields` / `add_methods` shape (mirroring mlua 0.9). So
//   only the part of mlua's derive *system* that ulua-rt-derive actually
//   implements is ported here: the `#[derive(UserData)]` **field** surface
//   (getters/setters from struct fields, with the `#[lua(skip|get|set|name)]`
//   attributes) and `#[derive(FromLua)]`. The following are intentionally NOT
//   ported (no equivalent ulua-rt API surface to swap to):
//     * `#[mlua::userdata_impl]` methods / meta-methods / static fields
//       (`area`, `scale`, `__tostring`, `__call`, `__add`, `description`,
//       `default_size`, the consuming/`&mut`-param methods, …);
//     * `Lua::create_proxy::<T>()` (the `Rectangle.new(...)` constructor proxy);
//     * `#[lua(meta, field)]` meta fields and `add_meta_field`;
//     * the `async` userdata block (the `async` feature is deferred).
//   These are noted, not silently skipped, per the porting rule.
//
// What is proven here: `#[derive(UserData)]` produces a `UserData` impl whose
// field getters/setters behave exactly like mlua's derived ones — default
// get+set, `#[lua(skip)]` hides a field, `#[lua(get, name = "...")]` makes a
// renamed read-only field — and `#[derive(FromLua)]` recovers a `Clone` value
// out of its userdata.

#![cfg(feature = "macros")]

use ulua_rt::{Error, FromLua as _, IntoLua as _, Lua, Result, UserData, Value};

// `#[derive(UserData)]` over named fields. Mirrors the *field* portion of
// mlua's `Rectangle`: `length`/`width` are default get+set, `version` is a
// renamed read-only getter, and `_internal` is skipped.
#[derive(Default, Clone, Debug, UserData)]
struct Rectangle {
  length: u32,

  // bare `#[lua]` == default (get + set), same as no attribute.
  #[lua]
  width: u32,

  // read-only, renamed field.
  #[lua(get, name = "version")]
  version_ro: u32,

  // not exposed to Lua at all.
  #[lua(skip)]
  _internal: u64,
}

#[derive(UserData)]
struct NamedFields {
  r#type: u32,
  #[lua(name = "renamed field")]
  value: u32,
}

#[test]
fn test_raw_and_renamed_fields() -> Result<()> {
  let lua = Lua::new();
  let data = lua.create_userdata(NamedFields {
    r#type: 3,
    value: 7,
  })?;
  lua.globals().set("data", data.clone())?;
  lua
    .load(
      r#"
    assert(data.type == 3)
    assert(data["r#type"] == nil)
    assert(data["renamed field"] == 7)
    data.type = 11
    data["renamed field"] = 13
  "#,
    )
    .exec()?;
  let fields = data.borrow::<NamedFields>()?;
  assert_eq!(fields.r#type, 11);
  assert_eq!(fields.value, 13);
  Ok(())
}

#[test]
fn test_rectangle_fields() -> Result<()> {
  let lua = Lua::new();

  let rect = Rectangle {
    length: 5,
    width: 10,
    version_ro: 1,
    _internal: 99,
  };
  lua.globals().set("rect", lua.create_userdata(rect)?)?;

  lua.load(
        r#"
        -- default get + set fields
        assert(rect.length == 5, "length should be 5")
        assert(rect.width == 10, "width should be 10")

        -- read-only renamed field
        assert(rect.version == 1, "version should be 1")
        local ok = pcall(function() rect.version = 2 end)
        assert(not ok, "version should be read-only")

        -- skipped field is invisible
        assert(rect._internal == nil, "_internal should be nil")
        assert(rect.version_ro == nil, "the original ident is not exposed; only the renamed 'version' is")

        -- setters work and are observable
        rect.length = 15
        rect.width = 20
        assert(rect.length == 15, "length should be updated to 15")
        assert(rect.width == 20, "width should be updated to 20")
    "#,
    )
    .exec()?;

  // Rust-side: the setters mutated the stored value.
  let ud = lua.globals().get::<ulua_rt::AnyUserData>("rect")?;
  let stored = ud.borrow::<Rectangle>()?;
  assert_eq!(stored.length, 15);
  assert_eq!(stored.width, 20);
  // The skipped field keeps its original value (never touched by Lua).
  assert_eq!(stored._internal, 99);

  Ok(())
}

// A tuple struct / enum still gets a valid (no-field) `UserData` impl from the
// derive — exactly like mlua, where field exposure only applies to named-field
// structs. (mlua's `Point(i32, i32)` / `enum Color` derive their `UserData`
// here too; their *methods* come from `#[userdata_impl]`, which is deferred.)
#[derive(Clone, Debug, UserData)]
struct Point(i32, i32);

#[derive(Clone, Debug, UserData)]
enum Color {
  Red,
  Green,
  Blue,
}

#[test]
fn test_fieldless_userdata_derive() -> Result<()> {
  let lua = Lua::new();
  let pt = Point(3, 4);
  assert_eq!(pt.0 + pt.1, 7);
  let _ = (Color::Red, Color::Blue);
  // A no-field userdata is still constructible and usable as a value; it
  // simply exposes no fields/methods.
  lua.globals().set("p", lua.create_userdata(pt)?)?;
  lua.globals().set("c", lua.create_userdata(Color::Green)?)?;
  lua
    .load(
      r#"
        assert(type(p) == "userdata", "Point should be userdata")
        assert(type(c) == "userdata", "Color should be userdata")
        assert(p.x == nil, "Point exposes no fields")
    "#,
    )
    .exec()?;
  Ok(())
}

// `#[derive(FromLua)]` — faithful port of mlua's `from_lua` derive: a `Clone`
// userdata type can be recovered from a Lua `Value::UserData` of that type.
// (Mirrors the `#[derive(mlua::FromLua)]` usage in mlua's `tests/userdata.rs`.)
#[derive(Clone, Copy, Debug, PartialEq, ulua_rt::FromLua)]
struct MyValue(i32);

impl UserData for MyValue {}

#[test]
fn test_from_lua_derive() -> Result<()> {
  let lua = Lua::new();

  // Round-trip a value through Lua via userdata and recover it by FromLua.
  let ud = lua.create_userdata(MyValue(123))?;
  lua.globals().set("v", &ud)?;

  // A Rust function that takes `MyValue` by value relies on the derived
  // `FromLua` to extract it from the userdata argument.
  let f = lua.create_function(|_, v: MyValue| Ok(v.0 * 2))?;
  lua.globals().set("double", f)?;
  let doubled: i32 = lua.load("return double(v)").eval()?;
  assert_eq!(doubled, 246);

  // The derived `FromLua` also works directly off a `Value`.
  let value: ulua_rt::Value = ud.into_lua(&lua)?;
  let recovered = MyValue::from_lua(value, &lua)?;
  assert_eq!(recovered, MyValue(123));

  // Wrong-type conversion produces a `FromLuaConversionError`.
  let err = MyValue::from_lua(Value::Integer(7), &lua).unwrap_err();
  assert!(
    matches!(&err, Error::FromLuaConversionError { to, .. } if to == "MyValue"),
    "expected FromLuaConversionError to MyValue, got {err:?}"
  );

  Ok(())
}
