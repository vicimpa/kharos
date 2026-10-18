// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua's `tests/byte_string.rs`. That test round-trips non-UTF-8
// Lua strings through `bstr::BString` / `&bstr::BStr`, which require mlua's
// `bstr` cargo feature (a `FromLua`/`IntoLua` impl over the `bstr` types).
//
// DEVIATION: ulua-rt does not (yet) ship a `bstr` feature, so the `BString` /
// `&BStr` conversions are deferred. The *capability the test proves* — that
// ulua-rt's `LuaString` faithfully stores and round-trips arbitrary raw bytes,
// including invalid UTF-8 — is exercised here directly through `LuaString`
// (`as_bytes`, byte comparisons, `Debug`) and `Lua::create_string(bytes)`. This
// is the honest, native-types form of the same round-trip.

use ulua_rt::{Lua, LuaString, Result};

#[test]
fn test_byte_string_round_trip() -> Result<()> {
  let lua = Lua::new();

  lua
    .load(
      r#"
        invalid_sequence_identifier = "\160\161"
        invalid_2_octet_sequence_2nd = "\195\040"
        invalid_3_octet_sequence_2nd = "\226\040\161"
        invalid_3_octet_sequence_3rd = "\226\130\040"
        invalid_4_octet_sequence_2nd = "\240\040\140\188"
        invalid_4_octet_sequence_3rd = "\240\144\040\188"
        invalid_4_octet_sequence_4th = "\240\040\140\040"

        an_actual_string = "Hello, world!"
    "#,
    )
    .exec()?;

  let globals = lua.globals();

  // Read each invalid-UTF-8 string back as raw bytes and verify them.
  let isi = globals.get::<LuaString>("invalid_sequence_identifier")?;
  assert_eq!(isi.as_bytes(), [0xa0, 0xa1]);

  let i2os2 = globals.get::<LuaString>("invalid_2_octet_sequence_2nd")?;
  assert_eq!(i2os2.as_bytes(), [0xc3, 0x28]);

  let i3os2 = globals.get::<LuaString>("invalid_3_octet_sequence_2nd")?;
  assert_eq!(i3os2.as_bytes(), [0xe2, 0x28, 0xa1]);

  let i3os3 = globals.get::<LuaString>("invalid_3_octet_sequence_3rd")?;
  assert_eq!(i3os3.as_bytes(), [0xe2, 0x82, 0x28]);

  let i4os2 = globals.get::<LuaString>("invalid_4_octet_sequence_2nd")?;
  assert_eq!(i4os2.as_bytes(), [0xf0, 0x28, 0x8c, 0xbc]);

  let i4os3 = globals.get::<LuaString>("invalid_4_octet_sequence_3rd")?;
  assert_eq!(i4os3.as_bytes(), [0xf0, 0x90, 0x28, 0xbc]);

  let i4os4 = globals.get::<LuaString>("invalid_4_octet_sequence_4th")?;
  assert_eq!(i4os4.as_bytes(), [0xf0, 0x28, 0x8c, 0x28]);

  let aas = globals.get::<LuaString>("an_actual_string")?;
  assert_eq!(aas.as_bytes(), b"Hello, world!");

  // Set the raw bytes back into Lua under new names and assert (in Lua) that
  // they compare equal to the originals — the round-trip is byte-exact.
  globals.set("rt_isi", lua.create_string(isi.as_bytes()))?;
  globals.set("rt_i2os2", lua.create_string(i2os2.as_bytes()))?;
  globals.set("rt_i3os2", lua.create_string(i3os2.as_bytes()))?;
  globals.set("rt_i3os3", lua.create_string(i3os3.as_bytes()))?;
  globals.set("rt_i4os2", lua.create_string(i4os2.as_bytes()))?;
  globals.set("rt_i4os3", lua.create_string(i4os3.as_bytes()))?;
  globals.set("rt_i4os4", lua.create_string(i4os4.as_bytes()))?;
  globals.set("rt_aas", lua.create_string(aas.as_bytes()))?;

  lua
    .load(
      r#"
        assert(rt_isi == invalid_sequence_identifier)
        assert(rt_i2os2 == invalid_2_octet_sequence_2nd)
        assert(rt_i3os2 == invalid_3_octet_sequence_2nd)
        assert(rt_i3os3 == invalid_3_octet_sequence_3rd)
        assert(rt_i4os2 == invalid_4_octet_sequence_2nd)
        assert(rt_i4os3 == invalid_4_octet_sequence_3rd)
        assert(rt_i4os4 == invalid_4_octet_sequence_4th)
        assert(rt_aas == an_actual_string)
    "#,
    )
    .exec()?;

  Ok(())
}

#[test]
fn test_byte_string_comparisons_and_debug() -> Result<()> {
  // `LuaString` raw-byte comparisons (`PartialEq` against `&[u8]`/`Vec<u8>`)
  // and a non-panicking lossy `Debug` over invalid UTF-8.
  let lua = Lua::new();

  let s = lua.create_string([0xff, 0x00, 0xfe, b'a']);
  assert_eq!(s.as_bytes(), [0xff, 0x00, 0xfe, b'a']);
  assert_eq!(s.as_bytes(), vec![0xff, 0x00, 0xfe, b'a']);
  assert_ne!(s.as_bytes(), b"abc");

  // `Debug` must not panic on invalid UTF-8.
  let dbg = format!("{s:?}");
  assert!(!dbg.is_empty());

  // A valid-UTF-8 string also exposes `to_str`.
  let valid = lua.create_string("héllo");
  assert_eq!(valid.to_str()?, "héllo");

  Ok(())
}
