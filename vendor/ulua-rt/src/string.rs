//! The [`LuaString`] handle. Mirrors `mlua::String`.

use core::{
  char::REPLACEMENT_CHARACTER,
  cmp::Ordering,
  ffi::c_void,
  fmt::{self, Debug, Display, Formatter},
  hash::{Hash, Hasher},
  slice::from_raw_parts,
  str::{from_utf8, from_utf8_unchecked},
};
use std::{borrow::Cow, fmt::Write as _};

use crate::{
  error::{Error, Result},
  registry::RegHandle,
  state::{Lua, LuaRef, bytes_at, is_string_at, pop_stack, push_bytes},
  sync::{NOT_SYNC, NotSync, XRc},
};

/// A garbage-collected Lua string.
///
/// Mirrors `mlua::String`. Holds a registry reference to the underlying Lua
/// string so the bytes stay alive for the handle's lifetime.
///
/// Under the `send` feature it is `Send` but never `Sync` — see
/// `crate::sync::NotSync`.
#[derive(Clone)]
pub struct LuaString {
  pub(crate) reference: XRc<LuaRef>,
  pub(crate) _not_sync: NotSync,
}

impl LuaString {
  pub(crate) fn from_ref(reference: LuaRef) -> LuaString {
    LuaString {
      reference: XRc::new(reference),
      _not_sync: NOT_SYNC,
    }
  }

  /// Borrow the raw bytes of the string (zero-copy).
  ///
  /// Mirrors `mlua::String::as_bytes`, but returns a borrowed slice: the
  /// string object is pinned by the registry ref, Luau's GC never moves
  /// objects, and the `XRc<LuaRef>` chain keeps the whole VM alive — so the
  /// pointer stays valid for as long as `&self` does.
  pub fn as_bytes(&self) -> &[u8] {
    let state = self.reference.state();
    // `reference.push()`（safe fn）走 `lua_rawgeti`，其内部 `ensure_stack(1)` 自保
    // 这一层头寸；注册表槽 id 由 `lua_ref` 登记且 `Drop` 时释放，取回必为登记时的
    // 原串，故压入后 -1 恒为有效索引。
    self.reference.push();
    // `is_string_at`（safe 门面）只读该槽类型标记，不动栈、不触发 GC。
    let is_string = is_string_at(state, -1);
    // `lua_tolstring` 会把数字就地转成字符串，而转换产物不受注册表引用保护；
    // `LuaString` 只从真实字符串构造，上面那道类型闸门保证指针指向的必是注册表
    // 钉住的原对象。
    let bytes = if is_string {
      // 闸门命中即 -1 处为 TString，`bytes_at`（unsafe 门面）走纯字符串分支——只
      // 以切片带出内容字节，不转换、不压栈（数字转换分支不可达），故栈深不变。
      // Safety: 窗口实例化为 `&self` 生命周期，属 `bytes_at` 存续期契约的形态
      // 2——串体是注册表槽钉住的 GC 对象（本句柄的 `XRc<LuaRef>` 链在 `&self`
      // 存续期内持续钉住它，Luau GC 不回收可达对象、也不搬移对象），TString
      // 不可变，故借用指向对象本体而非栈槽，紧随的弹出该层不使其失效（见本方
      // 法文档）。
      unsafe { bytes_at(state, -1) }.unwrap_or_default()
    } else {
      &[]
    };
    // 前面各步都不改变栈深，栈顶仍是 push 压入的串值；`pop_stack`（safe 门面）
    // 弹回这一层恢复平衡（`state` 存活且 top>base）。返回的借用不依赖栈槽位，
    // 只依赖注册表引用钉住的对象（见上）。
    pop_stack(state, 1);
    bytes
  }

  /// Get the string as a UTF-8 `&str`, erroring if it is not valid UTF-8.
  ///
  /// Mirrors `mlua::String::to_str` (returns an owned `String` here).
  pub fn to_str(&self) -> Result<String> {
    str::from_utf8(self.as_bytes())
      .map(str::to_owned)
      .map_err(|e| Error::FromLuaConversionError {
        from: "string",
        to: "String".to_string(),
        message: Some(format!("invalid utf-8: {e}")),
      })
  }

  /// Get the string lossily as a Rust `String` (invalid UTF-8 replaced).
  ///
  /// Mirrors `mlua::String::to_string_lossy`.
  pub fn to_string_lossy(&self) -> String {
    String::from_utf8_lossy(self.as_bytes()).into_owned()
  }

  /// The raw bytes with a trailing NUL appended (Lua strings are NUL
  /// terminated). Mirrors `mlua::String::as_bytes_with_nul`, borrowing like
  /// [`LuaString::as_bytes`]: Luau stores the terminator inline at
  /// `data[len]` (VM `lstring.cpp` "ending 0"), so it can be included
  /// without copying.
  pub fn as_bytes_with_nul(&self) -> &[u8] {
    let bytes = self.as_bytes();
    if bytes.is_empty() {
      // 类型闸门未命中的空切片无 NUL 可读；真实空串的终止符内容同为 0，
      // 回退到等价的常量切片（含 NUL，与 `data[0] == '\0'` 语义一致）。
      b"\0"
    } else {
      // Safety: `bytes` 来自类型闸门命中的真实 Lua 串，Luau TString 在
      // `data[len]` 处内联存放终止符 0（cpp `lstring.cpp:83` "ending 0"），
      // 所以 `len + 1` 个字节仍落在同一 GC 对象的分配内；对象被注册表引用
      // 钉住（同 `as_bytes`），u8 对齐平凡。空串走上面的常量回退分支。
      unsafe { from_raw_parts(bytes.as_ptr(), bytes.len() + 1) }
    }
  }

  /// A raw pointer identifying the interned string (for identity
  /// comparison). Mirrors `mlua::String::to_pointer`.
  pub fn to_pointer(&self) -> *const c_void {
    self.reference.to_pointer()
  }

  /// A `Display`-able view that renders the bytes lossily as UTF-8.
  /// Mirrors `mlua::String::display`.
  pub fn display(&self) -> LuaStringDisplay<'_> {
    LuaStringDisplay { s: self }
  }
}

/// `Display` adapter returned by [`LuaString::display`]。
///
/// 只持有字符串句柄，`fmt` 时才流式做 lossy UTF-8 输出——避免为整份字节
/// 预先分配 + 重编码（Display 可能只被格式化一小部分甚至不调用）。
pub struct LuaStringDisplay<'a> {
  s: &'a LuaString,
}

impl Display for LuaStringDisplay<'_> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    use core::fmt::Write as _;

    // 与 `String::from_utf8_lossy` 逐字节一致的语义：合法段直写，每个
    // 无效字节写一个 U+FFFD（截断的序列只算一个）。
    let mut rest = self.s.as_bytes();
    loop {
      match from_utf8(rest) {
        Ok(valid) => {
          f.write_str(valid)?;
          return Ok(());
        }
        Err(e) => {
          let (valid, after) = rest.split_at(e.valid_up_to());
          // Safety: `valid_up_to` 之前的段经 ` Utf8Error` 定义必为合法 UTF-8。
          f.write_str(unsafe { from_utf8_unchecked(valid) })?;
          f.write_char(REPLACEMENT_CHARACTER)?;
          let skip = e.error_len().unwrap_or(after.len());
          rest = &after[skip..];
        }
      }
    }
  }
}

impl RegHandle for LuaString {
  fn reference(&self) -> &XRc<LuaRef> {
    &self.reference
  }
}

impl Debug for LuaString {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    // Mirror mlua: valid utf-8 prints as a normal Rust string literal,
    // otherwise as a byte-string literal `b"..."`.
    if let Ok(s) = from_utf8(self.as_bytes()) {
      return write!(f, "{s:?}");
    }
    f.write_str("b\"")?;
    for &b in self.as_bytes() {
      match b {
        b'\0' => f.write_str("\\0")?,
        b'\r' => f.write_str("\\r")?,
        b'\n' => f.write_str("\\n")?,
        b'\t' => f.write_str("\\t")?,
        b'\\' => f.write_str("\\\\")?,
        b'"' => f.write_str("\\\"")?,
        0x20..=0x7e => f.write_char(b as char)?,
        _ => write!(f, "\\x{b:02x}")?,
      }
    }
    f.write_str("\"")
  }
}

impl PartialEq for LuaString {
  fn eq(&self, other: &Self) -> bool {
    self.as_bytes() == other.as_bytes()
  }
}

impl Eq for LuaString {}

impl PartialOrd for LuaString {
  fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
    Some(self.cmp(other))
  }
}

impl Ord for LuaString {
  fn cmp(&self, other: &Self) -> Ordering {
    self.as_bytes().cmp(other.as_bytes())
  }
}

impl Hash for LuaString {
  fn hash<H: Hasher>(&self, state: &mut H) {
    self.as_bytes().hash(state);
  }
}

// --- Comparisons against common Rust byte/str types ------------------------

macro_rules! impl_str_eq {
  ($($ty:ty => $conv:expr),* $(,)?) => {$(
    impl PartialEq<$ty> for LuaString {
      fn eq(&self, other: &$ty) -> bool {
        let f: fn(&$ty) -> &[u8] = $conv;
        self.as_bytes() == f(other)
      }
    }
    impl PartialOrd<$ty> for LuaString {
      fn partial_cmp(&self, other: &$ty) -> Option<Ordering> {
        let f: fn(&$ty) -> &[u8] = $conv;
        Some(self.as_bytes().cmp(f(other)))
      }
    }
  )*};
}

impl_str_eq! {
    str => |s| s.as_bytes(),
    String => |s| s.as_bytes(),
    [u8] => |s| s,
    Vec<u8> => |s| s.as_slice(),
}

// `&str`（引用套引用）与 `Cow`（带生命周期参数）无法进入上面的宏：宏体内的
// `fn(&$ty) -> &[u8]` 函数指针类型对二者会产生匿名生命周期歧义，故保持手写。
impl PartialEq<&str> for LuaString {
  fn eq(&self, other: &&str) -> bool {
    self.as_bytes() == other.as_bytes()
  }
}
impl PartialOrd<&str> for LuaString {
  fn partial_cmp(&self, other: &&str) -> Option<Ordering> {
    Some(self.as_bytes().cmp(other.as_bytes()))
  }
}

impl PartialEq<Cow<'_, [u8]>> for LuaString {
  fn eq(&self, other: &Cow<'_, [u8]>) -> bool {
    self.as_bytes() == other.as_ref()
  }
}

impl<const N: usize> PartialEq<&[u8; N]> for LuaString {
  fn eq(&self, other: &&[u8; N]) -> bool {
    self.as_bytes() == other.as_slice()
  }
}
impl<const N: usize> PartialOrd<&[u8; N]> for LuaString {
  fn partial_cmp(&self, other: &&[u8; N]) -> Option<Ordering> {
    Some(self.as_bytes().cmp(other.as_slice()))
  }
}

/// Helper to create a fresh Lua string from bytes on a given state, returning a
/// handle. Used by [`Lua::create_string`].
pub(crate) fn create_string(lua: &Lua, bytes: &[u8]) -> LuaString {
  let state = lua.state();
  // `push_bytes`（safe 门面）：`bytes` 为有效 `&[u8]`（len==0 时 VM 按长度读，
  // 不触碰指针），在返回前把字节完整拷入新 interned 串，且其 VM 入口自带
  // `ensure_stack(1)` 保这一层头寸，栈顶恒有该串。
  push_bytes(state, bytes);
  // `pop_ref`（safe fn）消费上一步压入的唯一栈槽登记注册表引用，净栈变化为零。
  LuaString::from_ref(lua.pop_ref())
}

// §8 留证：断言要读 `Lua::state()`（pub(crate)）并经 crate 内 `stack_top`
// 安全门面观察栈深；公开 API 无从观察 `as_bytes` 借用前后、panic 穿越时的
// 栈平衡，迁 tests/ 需暴露 state 指针与栈深观察面，保留 src。
#[cfg(test)]
mod tests {
  use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

  use crate::state::{Lua, stack_top};

  /// `as_bytes` 先弹栈再返回借用：panic 穿过借用方时栈不残留（回归：
  /// 曾有实现把用户回调包在 push/pop 之间，panic 会泄漏栈槽）。
  #[test]
  fn as_bytes_restores_stack_before_borrow() {
    let lua = Lua::new();
    let string = lua.create_string(b"a\0\xff");
    // `stack_top` 是 crate 内的安全门面：只读当前栈深，不触栈。
    let top = stack_top(lua.state());
    let bytes = string.as_bytes();
    // 借用已返回：栈已恢复、内容完整。
    assert_eq!(stack_top(lua.state()), top);
    assert_eq!(bytes, b"a\0\xff");
    let result = catch_unwind(AssertUnwindSafe(|| {
      // 借用存在期间 panic 也不改变栈（pop 已发生在借用之前）。
      let _borrow = string.as_bytes();
      assert_eq!(stack_top(lua.state()), top);
      resume_unwind(Box::new(()));
    }));
    assert!(result.is_err());
    assert_eq!(stack_top(lua.state()), top);
    assert_eq!(string.as_bytes(), b"a\0\xff");
  }
}

// r7-tlossy1 让位台账（本文件票面 1 枚：让 1）——:93 `String::from_utf8_lossy(self.as_bytes()).into_owned()`
// `to_string_lossy` 即 mlua 冻结 API 面，契约就是「非法 UTF-8 替换」（LuaString 携
// 任意 VM 字节，同文件测试 `b"a\0\xff"` 实证），lossy 语义确需、非过度防御；返回
// String 出口 owned 下限 1 malloc，本文件 :141 手写替换段实现与之逐字节同语义。
