//! Vector 原生序列化通道的契约测试（§8：由 `src/serde/ser.rs` 的 `#[cfg(test)]` 迁入）。
//!
//! 迁入判据：四条断言只驱动公开面 —— `Lua::new`、`LuaSerdeExt::to_value`、
//! `Value::Vector`、`Error::SerializeError`；夹具 `FedVector` 手写的是外部 crate
//! `serde` 的公开 trait `Serialize`（不是 crate 私有项）。故非「需要访问
//! 私有/`pub(crate)` 实现的单元测试」，按 §8 归 `tests/`。
//! 迁移未泄漏任何可见性：分量数由公开类型 `Vector` 的布局推导（见下
//! `VECTOR_ARITY`），未把被测端的 `pub(crate) const Vector::SIZE` 提为 `pub`。
//!
//! 行为基准：`src/serde/ser.rs` 的超发/欠发裁定（旧实现分别为裸索引越界 panic
//! 与静默零填充捏造分量，现按 serde 契约报 `Error::SerializeError`）。本套用例
//! 只钉该裁定，不改判定语义。

#![cfg(feature = "serde")]

use core::mem::size_of;
use std::result;

use serde::{
  Serialize,
  ser::{SerializeTupleStruct as _, Serializer},
};
use ulua_rt::{Error, Lua, LuaSerdeExt, Value, Vector};

/// Luau 原生向量的分量数，只经公开类型推导：`Vector` 是 `[f32; N]` 的 inline 值
/// 类型（`src/vector.rs`，单字段故无填充），所以 `size_of` 之比即 N。
/// 若该布局假设被破坏（例如切到 4 分量构建），下面的 `exact` 用例会因
/// `Vector::new(x, y, z)` 与边界不匹配而直接失败，不会静默漂移。
const VECTOR_ARITY: usize = size_of::<Vector>() / size_of::<f32>();

/// 手动驱动 `serialize_tuple_struct(name, VECTOR_ARITY)` 通道的夹具：
/// 按 `fields` 指定的个数喂 f64 分量后 end，用于钉死超发/欠发行为。
struct FedVector {
  name: &'static str,
  fields: usize,
}

impl Serialize for FedVector {
  fn serialize<S: Serializer>(&self, s: S) -> result::Result<S::Ok, S::Error> {
    let mut ts = s.serialize_tuple_struct(self.name, VECTOR_ARITY)?;
    for i in 0..self.fields {
      ts.serialize_field(&(i as f64 + 1.0))?;
    }
    ts.end()
  }
}

#[test]
fn vector_channel_exact_three_fields_roundtrip() {
  let lua = Lua::new();
  let v = lua
    .to_value(&FedVector {
      name: "Vector",
      fields: VECTOR_ARITY,
    })
    .unwrap();
  assert_eq!(v, Value::Vector(Vector::new(1.0, 2.0, 3.0)));
}

#[test]
fn vector_channel_overfeed_is_ser_error_not_panic() {
  // 超发（> 分量数）：旧实现在第 4 次 serialize_field 裸索引越界 panic；
  // 裁定为 serde 契约违约，必须返回 Err(ser::Error) 而非 panic/静默截断。
  let lua = Lua::new();
  let err = lua
    .to_value(&FedVector {
      name: "Vector",
      fields: VECTOR_ARITY + 1,
    })
    .unwrap_err();
  assert!(
    matches!(&err, Error::SerializeError(msg) if msg.contains("超发")),
    "超发应报 SerializeError，实际：{err}"
  );
}

#[test]
fn vector_channel_underfeed_is_ser_error_not_zero_pad() {
  // 欠发（分量不足即 end）：旧实现静默零填充捏造分量；裁定为契约违约，
  // 必须返回 Err(ser::Error) 而非伪数据。
  let lua = Lua::new();
  let err = lua
    .to_value(&FedVector {
      name: "Vector",
      fields: VECTOR_ARITY - 1,
    })
    .unwrap_err();
  assert!(
    matches!(&err, Error::SerializeError(msg) if msg.contains("欠发")),
    "欠发应报 SerializeError，实际：{err}"
  );
}

#[test]
fn non_vector_tuple_struct_keeps_lenient_seq_semantics() {
  // 判定收窄确认：错误通道仅属 "Vector" 原生向量模式；异名 tuple struct
  // 走表模式，字段数与 len 不符仍按序列宽松处理（不报错、不弱化）。
  let lua = Lua::new();
  for fields in [0usize, 2, 5] {
    let v = lua
      .to_value(&FedVector {
        name: "Triple",
        fields,
      })
      .unwrap();
    let table = v.as_table().expect("表模式应产出 table");
    assert_eq!(table.raw_len(), fields, "fields={fields}");
  }
}
