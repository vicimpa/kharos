// 边界契约测试：null/指针 id 位系指针值语义正面测试（既有约定 review.md §2）
// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License.
//
//   Copyright (c) 2019-2021 A. Orlenko
//   Copyright (c) 2017 rlua
//
// Ported to the `ulua-rt` API (the mlua-style, pure-Rust ergonomic surface over
// `ulua`/Luau) as a behavioral-compatibility proof for the `serde` feature.
// Where a test passes unchanged (import swap only) against `ulua-rt`, it
// demonstrates that `ulua-rt`'s serde integration matches mlua's observable
// behavior. See `tests/ATTRIBUTION.md` for the full MIT license text.
//
// DEVIATIONS from mlua's `tests/serde.rs`:
//
// * Luau numbers are `f64`; ulua-rt reconstructs the Integer/Number split from
//   whether the float is an exact in-range whole number. JSON output is
//   unaffected for the values under test.
//
// * `null`: mlua encodes serde `None`/JSON `null` as a `LightUserData(NULL)`
//   value. ulua-rt's `Value` has no `LightUserData` variant, so `lua.null()`
//   returns a dedicated per-`Lua` *sentinel table* recognized by serde. The
//   observable behavior (round-trips to/from `None`/`null`, compares equal to
//   itself in Lua) is identical.
//
// * sonic-rs's `Value` implements `Deserialize` via a private-token newtype
//   protocol (`deserialize_newtype_struct("$sonic_rs::private::Value", _)`)
//   and its `ValueVisitor` intentionally lacks `visit_newtype_struct`, so
//   `from_value::<sonic_rs::Value>` cannot work against ANY protocol-correct
//   serde `Deserializer` (mlua's tests used `serde_json::Value`, whose
//   `Deserialize` enters through `deserialize_any`). The "to-from loop" legs
//   therefore go through `to_string` + `from_str` (the same ulua serialize
//   event stream, consumed by sonic's own parser); option-tuned legs use
//   `Value::to_serializable()` chains.

// * Serializable userdata (`create_ser_userdata` / `create_ser_any_userdata` /
//   `AnyUserData::wrap_ser` / `Serialize for AnyUserData`) is a separate,
//   not-yet-implemented feature in ulua-rt. Tests that require it
//   (`test_serialize_any_userdata`, `test_serialize_wrapped_any_userdata`,
//   `test_from_value_userdata`) are omitted, and the userdata-specific
//   portions of `test_serialize` / `test_serialize_failure` are dropped with a
//   note. The `serde_value`-based buffer tests are likewise omitted (no
//   `serde_value` dependency).

#![cfg(feature = "serde")]

use core::ptr::null_mut;
use std::collections::HashMap;

use bstr::BString;
use serde::{Deserialize, Serialize};
use ulua_rt::{Error, LightUserData, Lua, LuaSerdeExt, Result as LuaResult, Value};

/// 本文件测试体实际产出的**具体**错误并集：ulua-rt 的 `Error` 与 sonic-rs 的
/// 序列化/反序列化错误（全部 `?` 传播点的两类来源，无其他）。
#[derive(Debug, thiserror::Error)]
enum TestError {
  #[error(transparent)]
  Rt(#[from] Error),
  #[error(transparent)]
  Sonic(#[from] sonic_rs::Error),
}

/// array metatable 优先于 mixed-table 密度分析（mlua 0.12.1
/// `Table::encode_as_array` 把 mt 判定放在一切分支之前）：带 mt 的混合表在
/// `detect_mixed_tables(true)` 下仍按 `raw_len()` 编码为数组，"k" 条目被截断
/// 丢弃——不得落 map 形态。
#[test]
fn array_metatable_wins_over_mixed_table_detection() -> Result<(), TestError> {
  let lua = Lua::new();
  let t = lua.create_table();
  t.raw_set(1, 10)?;
  t.raw_set(2, 20)?;
  t.raw_set("k", "v")?;
  t.set_metatable(Some(lua.array_metatable()))?;

  let json =
    sonic_rs::to_string(&Value::Table(t).to_serializable().detect_mixed_tables(true)).unwrap();
  assert_eq!(json, "[10,20]");

  Ok(())
}

/// `deny_unsupported_types(false)` 时 LightUserData 条目与 mlua 同款整对跳过
/// （旧 skip 臂漏掉该变体，会把 null 哨兵外的 light userdata 序列化成 null）。
/// 判别力要点：须显式 `deny_unsupported_types(false)`（默认 true 时 skip 臂
/// 不生效，LUD 只会命中 Err 路径），且 LUD 须落在数组下标上——hash 部分条目
/// 会被数组编码截断，`check_value_for_skip` 对它根本不会被调用；回退修复后
/// 本测试产出 `["kept",null]` 必挂。
#[test]
fn light_userdata_pair_skipped_when_unsupported_types_allowed() -> Result<(), TestError> {
  let lua = Lua::new();
  let t = lua.create_table();
  t.raw_set(1, "kept")?;
  t.raw_set(2, Value::LightUserData(LightUserData(null_mut())))?;

  let json = sonic_rs::to_string(
    &Value::Table(t)
      .to_serializable()
      .deny_unsupported_types(false),
  )
  .unwrap();
  assert_eq!(json, r#"["kept"]"#);

  Ok(())
}

#[test]
fn test_serialize() -> Result<(), TestError> {
  // DEVIATION: the `_userdata = ud` field and its `"_userdata": [...]`
  // assertion are dropped here because serializable userdata is not yet
  // implemented in ulua-rt (see the file header). Everything else is verbatim.
  let lua = Lua::new();
  let globals = lua.globals();

  globals.set("null", lua.null())?;

  let empty_array = lua.create_table();
  empty_array.set_metatable(Some(lua.array_metatable()))?;
  globals.set("empty_array", empty_array)?;

  let val = lua
    .load(
      r#"
        {
            _bool = true,
            _integer = 123,
            _number = 321.99,
            _string = "test string serialization",
            _table_arr = {null, "value 1", 2, "value 3", {}},
            _table_map = {["table"] = "map", ["null"] = null},
            _bytes = "\240\040\140\040",
            _null = null,
            _empty_map = {},
            _empty_array = empty_array,
        }
    "#,
    )
    .eval::<Value>()?;

  let json = sonic_rs::json!({
      "_bool": true,
      "_integer": 123,
      "_number": 321.99,
      "_string": "test string serialization",
      "_table_arr": [null, "value 1", 2, "value 3", {}],
      "_table_map": {"table": "map", "null": null},
      "_bytes": [240, 40, 140, 40],
      "_null": null,
      "_empty_map": {},
      "_empty_array": [],
  });

  assert_eq!(sonic_rs::to_value(&val)?, json);

  // Test to-from loop
  let val = lua.to_value(&json)?;
  let expected_json: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(&val)?)?;
  assert_eq!(expected_json, json);

  Ok(())
}

#[test]
fn test_serialize_failure() -> Result<(), TestError> {
  // DEVIATION: the userdata case from mlua's test is dropped (serializable
  // userdata unimplemented). The Function and Thread cases are verbatim and
  // exercise the same "cannot serialize <type>" path.
  let lua = Lua::new();

  let func = lua.create_function(|_, _: ()| Ok(()))?;
  if let Ok(v) = sonic_rs::to_value(&Value::Function(func.clone())) {
    panic!("expected serialization error, got {}", v)
  }

  let thr = lua.create_thread(func)?;
  if let Ok(v) = sonic_rs::to_value(&Value::Thread(thr)) {
    panic!("expected serialization error, got {}", v)
  }

  Ok(())
}

// Luau is a 3-wide vector build (no `luau-vector4`), matching mlua's
// `#[cfg(all(feature = "luau", not(feature = "luau-vector4")))]` variant.
#[test]
fn test_serialize_vector() -> Result<(), TestError> {
  let lua = Lua::new();

  let val = lua
    .load("{_vector = vector.create(1, 2, 3)}")
    .eval::<Value>()?;
  let json = sonic_rs::json!({
      "_vector": [1.0, 2.0, 3.0],
  });
  assert_eq!(sonic_rs::to_value(&val)?, json);

  let expected_json: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(&val)?)?;
  assert_eq!(expected_json, json);

  Ok(())
}

#[test]
fn test_serialize_sorted() -> LuaResult<()> {
  let lua = Lua::new();

  let globals = lua.globals();
  globals.set("null", lua.null())?;

  let empty_array = lua.create_table();
  empty_array.set_metatable(Some(lua.array_metatable()))?;
  globals.set("empty_array", empty_array)?;

  let value = lua
    .load(
      r#"
        {
            _bool = true,
            _integer = 123,
            _number = 321.99,
            _string = "test string serialization",
            _table_arr = {null, "value 1", 2, "value 3", {}},
            _table_map = {["table"] = "map", ["null"] = null},
            _bytes = "\240\040\140\040",
            _null = null,
            _empty_map = {},
            _empty_array = empty_array,
        }
    "#,
    )
    .eval::<Value>()?;

  let json = sonic_rs::to_string(&value.to_serializable().sort_keys(true)).unwrap();
  assert_eq!(
    json,
    r#"{"_bool":true,"_bytes":[240,40,140,40],"_empty_array":[],"_empty_map":{},"_integer":123,"_null":null,"_number":321.99,"_string":"test string serialization","_table_arr":[null,"value 1",2,"value 3",{}],"_table_map":{"null":null,"table":"map"}}"#
  );

  Ok(())
}

#[test]
fn test_serialize_globals() -> LuaResult<()> {
  let lua = Lua::new();

  let globals = Value::Table(lua.globals());

  // By default it should not work
  if let Ok(v) = sonic_rs::to_value(&globals) {
    panic!("expected serialization error, got {v:?}");
  }

  // It should work with `deny_recursive_tables` and `deny_unsupported_types` disabled
  if let Err(err) = sonic_rs::to_value(&{
    globals
      .to_serializable()
      .deny_recursive_tables(false)
      .deny_unsupported_types(false)
  }) {
    panic!("expected no errors, got {err:?}");
  }

  Ok(())
}

#[test]
fn test_serialize_same_table_twice() -> LuaResult<()> {
  let lua = Lua::new();

  let value = lua
    .load(
      r#"
        local foo = {}
        return {
            a = foo,
            b = foo,
        }
    "#,
    )
    .eval::<Value>()?;
  let json = sonic_rs::to_string(&value.to_serializable().sort_keys(true)).unwrap();
  assert_eq!(json, r#"{"a":{},"b":{}}"#);

  Ok(())
}

#[test]
fn test_serialize_empty_table() -> LuaResult<()> {
  let lua = Lua::new();

  let table = Value::Table(lua.create_table());
  let json = sonic_rs::to_string(&table.to_serializable()).unwrap();
  assert_eq!(json, "{}");

  // Set the option to encode empty tables as array
  let json =
    sonic_rs::to_string(&table.to_serializable().encode_empty_tables_as_array(true)).unwrap();
  assert_eq!(json, "[]");

  // Check hashmap table with this option
  table.as_table().unwrap().set("hello", "world")?;
  let json =
    sonic_rs::to_string(&table.to_serializable().encode_empty_tables_as_array(true)).unwrap();
  assert_eq!(json, r#"{"hello":"world"}"#);

  Ok(())
}

#[test]
fn test_serialize_mixed_table() -> LuaResult<()> {
  use ulua_rt::ExternalResult;

  let lua = Lua::new();

  // Check that sparse array is serialized similarly when using direct serialization
  // and via `Lua::from_value`
  let table = lua.load("{1,2,3,nil,5}").eval::<Value>()?;
  let json1 = sonic_rs::to_string(&table).unwrap();
  let json2: sonic_rs::Value =
    sonic_rs::from_str(&sonic_rs::to_string(&table).into_lua_err()?).into_lua_err()?;
  assert_eq!(json1, json2.to_string());

  // A table with several borders should be correctly encoded when `detect_mixed_tables` is enabled
  let table = lua
    .load(
      r#"
        local t = {1,2,3,nil,5,6}
        t[10] = 10
        return t
    "#,
    )
    .eval::<Value>()?;
  let json = sonic_rs::to_string(&table.to_serializable().detect_mixed_tables(true)).unwrap();
  assert_eq!(json, r#"[1,2,3,null,5,6,null,null,null,10]"#);

  // A mixed table with both array-like and map-like entries
  let table = lua.load(r#"{1,2,3, key="value"}"#).eval::<Value>()?;
  let json = sonic_rs::to_string(&table).unwrap();
  assert_eq!(json, r#"[1,2,3]"#);
  let json = sonic_rs::to_string(&table.to_serializable().detect_mixed_tables(true)).unwrap();
  assert_eq!(json, r#"{"1":1,"2":2,"3":3,"key":"value"}"#);

  // A mixed table with duplicate keys of different types
  let table = lua.load(r#"{1,2,3, ["1"]="value"}"#).eval::<Value>()?;
  let json = sonic_rs::to_string(&table.to_serializable().detect_mixed_tables(true)).unwrap();
  assert_eq!(json, r#"{"1":1,"2":2,"3":3,"1":"value"}"#);

  Ok(())
}

#[test]
fn test_to_value_struct() -> LuaResult<()> {
  let lua = Lua::new();
  let globals = lua.globals();
  globals.set("null", lua.null())?;

  #[derive(Serialize)]
  struct Test {
    name: String,
    key: i64,
    data: Option<bool>,
  }

  let test = Test {
    name: "alex".to_string(),
    key: -16,
    data: None,
  };

  globals.set("value", lua.to_value(&test)?)?;
  lua
    .load(
      r#"
            assert(value["name"] == "alex")
            assert(value["key"] == -16)
            assert(value["data"] == null)
        "#,
    )
    .exec()
}

#[test]
fn test_to_value_enum() -> LuaResult<()> {
  let lua = Lua::new();
  let globals = lua.globals();

  #[derive(Serialize)]
  enum E {
    Unit,
    Integer(u32),
    Tuple(u32, u32),
    Struct { a: u32 },
  }

  let u = E::Unit;
  globals.set("value", lua.to_value(&u)?)?;
  lua.load(r#"assert(value == "Unit")"#).exec()?;

  let n = E::Integer(1);
  globals.set("value", lua.to_value(&n)?)?;
  lua.load(r#"assert(value["Integer"] == 1)"#).exec()?;

  let t = E::Tuple(1, 2);
  globals.set("value", lua.to_value(&t)?)?;
  lua
    .load(
      r#"
            assert(value["Tuple"][1] == 1)
            assert(value["Tuple"][2] == 2)
        "#,
    )
    .exec()?;

  let s = E::Struct { a: 1 };
  globals.set("value", lua.to_value(&s)?)?;
  lua.load(r#"assert(value["Struct"]["a"] == 1)"#).exec()?;
  Ok(())
}

#[test]
fn test_to_value_with_options() -> Result<(), TestError> {
  use ulua_rt::SerializeOptions;

  let lua = Lua::new();
  let globals = lua.globals();
  globals.set("null", lua.null())?;

  // set_array_metatable
  let data = lua.to_value_with(
    &Vec::<i32>::new(),
    SerializeOptions::new().set_array_metatable(false),
  )?;
  globals.set("data", data)?;
  lua
    .load(
      r#"
        assert(type(data) == "table" and #data == 0)
        assert(getmetatable(data) == nil)
    "#,
    )
    .exec()?;

  #[derive(Serialize)]
  struct UnitStruct;

  #[derive(Serialize)]
  struct MyData {
    map: HashMap<&'static str, Option<i32>>,
    unit: (),
    unitstruct: UnitStruct,
  }

  // serialize_none_to_null
  let mut map = HashMap::new();
  map.insert("key", None);
  let mydata = MyData {
    map,
    unit: (),
    unitstruct: UnitStruct,
  };
  let data2 = lua.to_value_with(
    &mydata,
    SerializeOptions::new().serialize_none_to_null(false),
  )?;
  globals.set("data2", data2)?;
  lua
    .load(
      r#"
        assert(data2.map.key == nil)
        assert(data2.unit == null)
        assert(data2.unitstruct == null)
    "#,
    )
    .exec()?;

  // serialize_unit_to_null
  let data3 = lua.to_value_with(
    &mydata,
    SerializeOptions::new().serialize_unit_to_null(false),
  )?;
  globals.set("data3", data3)?;
  lua
    .load(
      r#"
        assert(data3.map.key == null)
        assert(data3.unit == nil)
        assert(data3.unitstruct == nil)
    "#,
    )
    .exec()?;

  Ok(())
}

#[test]
fn test_from_value_nested_tables() -> Result<(), TestError> {
  let lua = Lua::new();

  let value = lua
    .load(
      r#"
            local table_a = {a = "a"}
            local table_b = {"b"}
            return {
                a = table_a,
                b = {table_b, table_b},
                ab = {a = table_a, b = table_b}
            }
        "#,
    )
    .eval::<Value>()?;
  let got: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(&value)?)?;
  assert_eq!(
    got,
    sonic_rs::json!({
        "a": {"a": "a"},
        "b": [["b"], ["b"]],
        "ab": {"a": {"a": "a"}, "b": ["b"]},
    })
  );

  Ok(())
}

#[test]
fn test_from_value_struct() -> Result<(), TestError> {
  let lua = Lua::new();

  #[derive(Deserialize, PartialEq, Debug)]
  struct Test {
    int: u32,
    seq: Vec<String>,
    map: HashMap<i32, i32>,
    empty: Vec<()>,
    tuple: (u8, u8, u8),
    bytes: BString,
  }

  let value = lua
    .load(
      r#"
            {
                int = 1,
                seq = {"a", "b"},
                map = {2, [4] = 1},
                empty = {},
                tuple = {10, 20, 30},
                bytes = "\240\040\140\040",
            }
        "#,
    )
    .eval::<Value>()?;
  let got = lua.from_value(value)?;
  assert_eq!(
    Test {
      int: 1,
      seq: vec!["a".into(), "b".into()],
      map: vec![(1, 2), (4, 1)].into_iter().collect(),
      empty: vec![],
      tuple: (10, 20, 30),
      bytes: BString::from([240, 40, 140, 40]),
    },
    got
  );

  Ok(())
}

#[test]
fn test_from_value_newtype_struct() -> Result<(), TestError> {
  let lua = Lua::new();

  #[derive(Deserialize, PartialEq, Debug)]
  struct Test(f64);

  let got = lua.from_value(Value::Number(123.456))?;
  assert_eq!(Test(123.456), got);

  Ok(())
}

#[test]
fn test_from_value_enum() -> Result<(), TestError> {
  let lua = Lua::new();
  lua.globals().set("null", lua.null())?;

  #[derive(Deserialize, PartialEq, Debug)]
  struct UnitStruct;

  #[derive(Deserialize, PartialEq, Debug)]
  enum E<T = ()> {
    Unit,
    Integer(u32),
    Tuple(u32, u32),
    Struct { a: u32 },
    Wrap(T),
  }

  let value = lua.load(r#""Unit""#).eval()?;
  let got: E = lua.from_value(value)?;
  assert_eq!(E::Unit, got);

  let value = lua.load(r#"{Integer = 1}"#).eval()?;
  let got: E = lua.from_value(value)?;
  assert_eq!(E::Integer(1), got);

  let value = lua.load(r#"{Tuple = {1, 2}}"#).eval()?;
  let got: E = lua.from_value(value)?;
  assert_eq!(E::Tuple(1, 2), got);

  let value = lua.load(r#"{Struct = {a = 3}}"#).eval()?;
  let got: E = lua.from_value(value)?;
  assert_eq!(E::Struct { a: 3 }, got);

  let value = lua.load(r#"{Wrap = null}"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(E::Wrap(UnitStruct), got);

  let value = lua.load(r#"{Wrap = null}"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(E::Wrap(()), got);

  Ok(())
}

#[test]
fn test_from_value_enum_untagged() -> Result<(), TestError> {
  let lua = Lua::new();
  lua.globals().set("null", lua.null())?;

  #[derive(Deserialize, PartialEq, Debug)]
  #[serde(untagged)]
  enum Eut {
    Unit,
    Integer(u64),
    Tuple(u32, u32),
    Struct { a: u32 },
  }

  let value = lua.load(r#"null"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(Eut::Unit, got);

  let value = lua.load(r#"1"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(Eut::Integer(1), got);

  let value = lua.load(r#"{3, 1}"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(Eut::Tuple(3, 1), got);

  let value = lua.load(r#"{a = 10}"#).eval()?;
  let got = lua.from_value(value)?;
  assert_eq!(Eut::Struct { a: 10 }, got);

  let value = lua.load(r#"{b = 12}"#).eval()?;
  match lua.from_value::<Eut>(value) {
    Ok(v) => panic!("expected Error::DeserializeError, got {:?}", v),
    Err(Error::DeserializeError(_)) => {}
    Err(e) => panic!("expected Error::DeserializeError, got {}", e),
  }

  Ok(())
}

#[test]
fn test_from_value_with_options() -> Result<(), TestError> {
  use ulua_rt::DeserializeOptions;

  let lua = Lua::new();

  // Deny unsupported types by default
  let value = Value::Function(lua.create_function(|_, ()| Ok(()))?);
  match lua.from_value::<Option<String>>(value) {
    Ok(v) => panic!("expected deserialization error, got {:?}", v),
    Err(Error::DeserializeError(err)) => {
      assert!(err.contains("unsupported value type"))
    }
    Err(err) => panic!("expected `DeserializeError` error, got {:?}", err),
  };

  // Allow unsupported types
  let value = Value::Function(lua.create_function(|_, ()| Ok(()))?);
  let options = DeserializeOptions::new().deny_unsupported_types(false);
  assert_eq!(lua.from_value_with::<()>(value, options)?, ());

  // Allow unsupported types (in a table seq)
  let value = lua.load(r#"{"a", "b", function() end, "c"}"#).eval()?;
  let options = DeserializeOptions::new().deny_unsupported_types(false);
  assert_eq!(
    lua.from_value_with::<Vec<String>>(value, options)?,
    vec!["a".to_string(), "b".to_string(), "c".to_string()]
  );

  // Deny recursive tables by default
  let value = lua.load(r#"local t = {}; t.t = t; return t"#).eval()?;
  match lua.from_value::<HashMap<String, Option<String>>>(value) {
    Ok(v) => panic!("expected deserialization error, got {:?}", v),
    Err(Error::DeserializeError(err)) => {
      assert!(err.contains("recursive table detected"))
    }
    Err(err) => panic!("expected `DeserializeError` error, got {:?}", err),
  };

  // Check recursion when using `Serialize` impl
  let t = lua.create_table();
  t.set("t", &t)?;
  assert!(sonic_rs::to_string(&t).is_err());

  // Serialize Lua globals table
  #[derive(Debug, Deserialize)]
  struct Globals {
    hello: String,
  }
  let options = DeserializeOptions::new()
    .deny_unsupported_types(false)
    .deny_recursive_tables(false);
  lua.load(r#"hello = "world""#).exec()?;
  let globals: Globals = lua.from_value_with(Value::Table(lua.globals()), options)?;
  assert_eq!(globals.hello, "world");

  Ok(())
}

#[test]
fn test_from_value_empty_table() -> Result<(), TestError> {
  let lua = Lua::new();

  // By default we encode empty tables as objects
  let t = lua.create_table();
  let got: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(&Value::Table(t.clone()))?)?;
  assert_eq!(got, sonic_rs::json!({}));

  // Set the option to encode empty tables as array
  let got: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(
    &Value::Table(t.clone())
      .to_serializable()
      .encode_empty_tables_as_array(true),
  )?)?;
  assert_eq!(got, sonic_rs::json!([]));

  // Check hashmap table with this option
  t.raw_set("hello", "world")?;
  let got: sonic_rs::Value = sonic_rs::from_str(&sonic_rs::to_string(
    &Value::Table(t)
      .to_serializable()
      .encode_empty_tables_as_array(true),
  )?)?;
  assert_eq!(got, sonic_rs::json!({"hello": "world"}));

  Ok(())
}

#[test]
fn test_from_value_sorted() -> Result<(), TestError> {
  use ulua_rt::ExternalResult;

  let lua = Lua::new();

  let to_json = lua.create_function(|_, value: Value| {
    sonic_rs::to_string(&value.to_serializable().sort_keys(true)).into_lua_err()
  })?;
  lua.globals().set("to_json", to_json)?;

  lua.load(
        r#"
        local json = to_json({c = 3, b = 2, hello = "world", x = {1}, ["0a"] = {z = "z", d = "d"}})
        assert(json == '{"0a":{"d":"d","z":"z"},"b":2,"c":3,"hello":"world","x":[1]}', "invalid json")
    "#,
    )
    .exec()
    .unwrap();

  Ok(())
}
