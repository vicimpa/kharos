//! The [`Buffer`] handle (Luau `buffer` type). Mirrors `mlua::Buffer`.
//!
//! A buffer is a fixed-size, mutable, GC-managed byte array — Luau's answer to
//! a `Vec<u8>` / `ArrayBuffer`. Like the other reference-typed handles
//! ([`Table`](crate::Table), [`Function`](crate::Function)) it holds a registry
//! reference ([`LuaRef`]) that keeps the underlying object alive and lets us
//! re-push it onto the stack on demand.
//!
//! The data lives in VM-managed memory; [`Buffer::as_slice`] / [`as_slice_mut`]
//! borrow the bytes directly through ulua's `lua_tobuffer_bytes_ref` (via the
//! single derivation point [`Buffer::bytes`]), so reads and writes go straight
//! to the buffer with no copy.

use core::{
  ffi::c_void,
  fmt::{self, Debug, Formatter},
  ptr,
};
use std::io::{self, Error, ErrorKind, Read, Seek, SeekFrom, Write};

use crate::{
  error::Result,
  registry::RegHandle,
  state::{
    Lua, LuaRef, StateView, ensure_stack, ensure_stack_or_panic, pop_stack, push_named_closure,
    push_number, run_pcall, set_stack_top,
  },
  sync::{NOT_SYNC, NotSync, XRc},
  sys::*,
  table::number_at,
};

/// A Luau buffer type.
///
/// See the buffer [documentation] for more information.
///
/// Mirrors `mlua::Buffer`. Holds a registry reference keeping the buffer alive.
///
/// Under the `send` feature it is `Send` but never `Sync` — see
/// `crate::sync::NotSync`.
///
/// [documentation]: https://luau.org/library#buffer-library
#[derive(Clone)]
pub struct Buffer {
  pub(crate) reference: XRc<LuaRef>,
  pub(crate) _not_sync: NotSync,
}

impl Buffer {
  pub(crate) fn from_ref(reference: LuaRef) -> Buffer {
    Buffer {
      reference: XRc::new(reference),
      _not_sync: NOT_SYNC,
    }
  }

  /// The owning [`Lua`].
  pub(crate) fn lua(&self) -> Lua {
    self.reference.lua()
  }

  /// Copies the buffer data into a new `Vec<u8>`.
  ///
  /// Mirrors `mlua::Buffer::to_vec`.
  pub fn to_vec(&self) -> Vec<u8> {
    self.as_slice().to_vec()
  }

  /// Returns the length of the buffer.
  ///
  /// Mirrors `mlua::Buffer::len`.
  pub fn len(&self) -> usize {
    self.as_slice().len()
  }

  /// Returns `true` if the buffer is empty.
  ///
  /// Mirrors `mlua::Buffer::is_empty`.
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }

  /// Reads given number of bytes from the buffer at the given offset.
  ///
  /// Offset is 0-based.
  ///
  /// Mirrors `mlua::Buffer::read_bytes`.
  #[track_caller]
  pub fn read_bytes<const N: usize>(&self, offset: usize) -> [u8; N] {
    let data = self.as_slice();
    let mut bytes = [0u8; N];
    bytes.copy_from_slice(&data[offset..offset + N]);
    bytes
  }

  /// Writes given bytes to the buffer at the given offset.
  ///
  /// Offset is 0-based.
  ///
  /// Mirrors `mlua::Buffer::write_bytes`. 与 mlua 的 `&self` + 内部可变性不同，
  /// 这里按 `&mut` 纪律收口（与 `Buffer::as_slice_mut` 一致）：`Buffer` 是
  /// `Clone` 的句柄，克隆体共享同一块 VM 内存，从 `&self` 造 `&mut` 会让别的
  /// 句柄正在使用的 `&[u8]` 失效；`b.write_bytes(off, b.as_slice())` 这种自别名
  /// 写法在借用检查器处即被拒。
  ///
  /// # Panics
  ///
  /// Panics if `offset + bytes.len()` is greater than the buffer length.
  #[track_caller]
  pub fn write_bytes(&mut self, offset: usize, bytes: &[u8]) {
    // `as_slice_mut`（safe 门面）自带 push/pop 头寸预留与借用纪律论证。
    let data = self.as_slice_mut();
    let len = bytes.len();
    assert!(
      offset <= data.len() && len <= data.len() - offset,
      "range end index {} out of range for slice of length {}",
      offset + len,
      data.len()
    );
    let dst = &mut data[offset..offset + len];
    // 源区间可能就是同一块 VM 内存（另一枚克隆句柄借出的 `&[u8]`），
    // 重叠时 `copy_from_slice`（memcpy 语义）是 UB，改用 `copy`（memmove 语义）。
    let (src_int, dst_int) = (bytes.as_ptr() as usize, dst.as_mut_ptr() as usize);
    let overlaps = src_int < dst_int + len && dst_int < src_int + len;
    if overlaps {
      // Safety: 两操作数都是各自 `&[u8]`/`&mut [u8]` 的完整区间（assert 已保证
      // 界内），u8 对齐平凡；重叠分支用 `copy`（memmove 语义）合法，len==0 时
      // 对空区间亦合法。非重叠分支交给 `copy_from_slice`。
      // r12-w8buf 保留面：`core::ptr::copy` 即 Rust 惯用法要求的单点裸形
      // （标准库无 safe 的重叠搬移门面），非 FFI/句柄面，不收编。
      unsafe { ptr::copy(bytes.as_ptr(), dst.as_mut_ptr(), len) };
    } else {
      dst.copy_from_slice(bytes);
    }
  }

  /// Returns an adaptor implementing [`Read`], [`Write`] and
  /// [`Seek`] over the buffer.
  ///
  /// Buffer operations are infallible, none of the read/write functions will
  /// return an `Err`.
  ///
  /// Mirrors `mlua::Buffer::cursor`.
  pub fn cursor(self) -> impl Read + Write + Seek {
    BufferCursor(self, 0)
  }

  /// A raw pointer identifying this buffer (for identity comparison).
  /// Mirrors `Value::Buffer(_).to_pointer()`.
  ///
  /// r12-w8buf 保留面（w6d 口径钉死定性）：只作对象地址身份、全程不解引用，
  /// 裸形系 mlua 对齐的公开判据所需；委托 `LuaRef::to_pointer`（safe 门面族，
  /// 内部仅 `pointer_at` 一次读数）。消费面实测：本文件 `PartialEq::eq`、
  /// `value.rs:296`（`Value::to_pointer` 的 Buffer 臂）、`value.rs:365`
  /// （`Value` 判等的 Buffer 臂）。
  pub(crate) fn to_pointer(&self) -> *const c_void {
    self.reference.to_pointer()
  }

  /// Borrow the buffer's bytes directly (no copy).
  ///
  /// 只在 crate 内可见，且有一条纪律：借出的 `&[u8]` 指向 **VM 堆内存**，任何
  /// 可能写同一 buffer 的代码（用户回调、另一枚克隆句柄的
  /// [`Buffer::write_bytes`]）都不得在该引用活跃期间运行——需要跨回调交付字节
  /// 的调用点（serde）必须先 [`Buffer::to_vec`] 拷贝。
  pub(crate) fn as_slice(&self) -> &[u8] {
    ensure_stack_or_panic(self.reference.state(), 1);
    &Self::bytes(&self.reference)[..]
  }

  /// Mutably borrow the buffer's bytes directly (no copy).
  pub(crate) fn as_slice_mut(&mut self) -> &mut [u8] {
    ensure_stack_or_panic(self.reference.state(), 1);
    Self::bytes(&self.reference)
  }

  /// The single borrow-window derivation point for this handle — the only
  /// `lua_tobuffer_bytes_ref` call site in the crate (r12 T11：裸
  /// `(ptr, len)` 形 `as_raw_parts` 由切片核心取代，全 crate 无裸窗构造)。
  /// Pushes the buffer, borrows the window, then pops — the slice remains
  /// valid because the registry ref keeps the object alive.
  ///
  /// 形为关联函数（r12 主控收口 clippy::mut_from_ref）：返回切片的寿命 `'a`
  /// 不经接收者传导，与 vm 侧 `buffer_data_ref` 的栈窗口契约同族—— `'a` 由
  /// 调用点选定，真实有效期以注册表引用钉住的对象为界，非借用系统可表达。
  ///
  /// 调用序契约（正确性，非内存安全）：owning VM 必须存活且由当前线程驱动，
  /// 且 main state 上已预留至少 1 个栈空位（内部 push/pop 一层，即门面
  /// [`Buffer::as_slice`] / [`as_slice_mut`] 紧邻的 `ensure_stack_or_panic`）。
  /// 返回切片未编码生命周期：仅当 `reference` 的注册表引用仍然钉住该 buffer
  /// 对象时有效（文档纪律：借出期间不得有并发写，见 [`Buffer::as_slice`]）。
  ///
  /// # Safety
  /// `state` 存活（调用点契约）；注册表引用指向登记时的 buffer 对象，
  /// `reference.push()`（`lua_rawgeti`）取回原对象压到已预留的空位上；
  /// `lua_tobuffer_bytes_ref(-1)` 对刚压入的 buffer 值借出其内联数据块切片
  /// （非 buffer 才返回 `None`，`expect` 收口为 panic 而非 UB）；`pop_stack`
  /// 后切片仍有效——对象由注册表引用钉住、Luau GC 不移动对象且 buffer 定长
  /// 不 resize（契约三要素见 `lua_tobuffer_bytes_ref`），栈槽只是视图。
  ///
  /// r12-w8buf 收编：门面形参已是 `&mut LuaState`（ulua-vm 安全签名族），实参
  /// `&mut state` 经 StateView DerefMut 协变直达（`memory.rs` `lua_setmemcat`
  /// 同款惯用形），本调用点不再自建裸解引用；`unsafe` 仅剩对 `pub unsafe fn`
  /// 门面的调用本身，契约如上。
  /// 有效期只由注册表引用钉住的对象决定，故寿命交调用点选定（`'a`），不在类型上
  /// 伪造 `'static`：`'static mut` 会把这一借窗谎报成全程序期独占，可被写入
  /// global/静态槽而绕过本契约（review.md §2：不造 `'static` 借用）。
  fn bytes<'a>(reference: &XRc<LuaRef>) -> &'a mut [u8] {
    let mut state = reference.state();
    reference.push();
    // Safety: 见上方 # Safety 契约（栈槽 -1 即刚 push 回的 buffer 对象）。
    let bytes = unsafe { lua_tobuffer_bytes_ref(&mut state, -1) };
    pop_stack(state, 1);
    bytes.expect("invalid Luau buffer")
  }
}

impl RegHandle for Buffer {
  fn reference(&self) -> &XRc<LuaRef> {
    &self.reference
  }
}

impl Debug for Buffer {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    // Mirror mlua: a buffer renders as its byte contents (a byte slice).
    write!(f, "Buffer({:?})", self.as_slice())
  }
}

impl PartialEq for Buffer {
  fn eq(&self, other: &Self) -> bool {
    // Reference (pointer) identity, matching mlua: two handles are equal iff
    // they point at the *same* buffer object (NOT byte-wise content).
    self.to_pointer() == other.to_pointer()
  }
}

/// Cursor adapter returned by [`Buffer::cursor`]. The `usize` is the current
/// 0-based offset into the buffer. Mirrors mlua's `BufferCursor`.
struct BufferCursor(Buffer, usize);

impl Read for BufferCursor {
  fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
    let data = self.0.as_slice();
    if self.1 == data.len() {
      return Ok(0);
    }
    let len = buf.len().min(data.len() - self.1);
    buf[..len].copy_from_slice(&data[self.1..self.1 + len]);
    self.1 += len;
    Ok(len)
  }
}

impl Write for BufferCursor {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    let data = self.0.as_slice_mut();
    if self.1 == data.len() {
      return Ok(0);
    }
    let len = buf.len().min(data.len() - self.1);
    data[self.1..self.1 + len].copy_from_slice(&buf[..len]);
    self.1 += len;
    Ok(len)
  }

  fn flush(&mut self) -> io::Result<()> {
    Ok(())
  }
}

impl Seek for BufferCursor {
  fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
    let data = self.0.as_slice();
    let new_offset = match pos {
      SeekFrom::Start(offset) => offset as i64,
      SeekFrom::End(offset) => data.len() as i64 + offset,
      SeekFrom::Current(offset) => self.1 as i64 + offset,
    };
    if new_offset < 0 {
      return Err(Error::new(
        ErrorKind::InvalidInput,
        "invalid seek to a negative position",
      ));
    }
    if new_offset as usize > data.len() {
      return Err(Error::new(
        ErrorKind::InvalidInput,
        "invalid seek to a position beyond the end of the buffer",
      ));
    }
    self.1 = new_offset as usize;
    Ok(self.1 as u64)
  }
}

// ---------------------------------------------------------------------------
// Buffer creation
//
// `lua_newbuffer_push_ref` allocates a GC buffer and pushes it. When `size`
// exceeds the VM's `MAX_BUFFER_SIZE` (1GB) the underlying `luaM_toobig`
// *raises* a Lua error (longjmp) rather than returning. Unwinding that across
// Rust frames is UB, so we run `lua_newbuffer_push_ref` inside `lua_pcall` via a
// small C trampoline: the requested size is passed as a number argument, and a
// raising allocation is reported as an ordinary non-zero status with the error
// on the stack.
// ---------------------------------------------------------------------------

/// `c_newbuffer` 闭包的调试名：静态 NUL 结尾字节串，交给 `lua_pushcclosurek` 的
/// `*const c_char` 收口点（VM 压栈时 intern 复制为 TString 锚；收口垫片按 NUL
/// 扫描读取，结尾 `\0` 不可省）。
const NEWBUFFER_NAME: &[u8] = b"ulua-rt-newbuffer\0";

/// C trampoline: stack is `[size]` (a number). Allocates a buffer of that many
/// bytes via `lua_newbuffer_push_ref`, leaving the buffer object on top.
///
/// # Safety
/// 仅由 `lua_pcall` 在被调闭包帧内调用：`state` 存活且带 `LUA_MINSTACK` 头寸，
/// 栈槽 1 是 `create_buffer_with_capacity` 压入的 number 实参。
unsafe extern "C-unwind" fn c_newbuffer(raw: *mut LuaState) -> i32 {
  // Safety: C-ABI 边界点(pcall 被调闭包帧实参):`raw` 由 `lua_pcall` 在被调
  // 闭包内提供（存活，且帧带 `LUA_MINSTACK` 头寸）;一次转视图,只在本次调用内。
  let mut state = unsafe { StateView::from_raw(raw) };
  // 调用序契约（r12-w8buf 收编：本函数体零 `unsafe`——`number_at`/`set_stack_top`
  // 为 safe 门面，`lua_newbuffer_push_ref` 已是 `&mut LuaState` 安全签名，实参
  // `&mut state` 经 DerefMut 协变直达，w6b trampoline 形不动）：栈槽 1 由创建方
  // `create_buffer_with_capacity` 压入的 number 实参占据（契约"栈为 [size]"），
  // 经 `number_at` 只读消费；理论上的非数值形态回落到 0，与旧形
  // `lua_tonumberx(.., NULL)` 对非数值返 0.0 的取值逐位一致，
  // `f64 as usize` 饱和转换是 Rust 定义行为。`lua_settop(state, 0)` 丢弃实参后
  // `lua_newbuffer_push_ref` 在空帧上分配并压回恰好一个值（其 toobig 错误经外层受保护
  // 调用转成非零 status，不跨帧 unwind），返回 1 与之相符。
  let size = number_at(state, 1).unwrap_or(0.0) as usize;
  set_stack_top(state, 0);
  lua_newbuffer_push_ref(&mut state, size);
  1
}

/// Create a buffer of `size` zero-initialized bytes, catching an over-limit
/// allocation as an `Err` rather than letting the VM longjmp.
pub(crate) fn create_buffer_with_capacity(lua: &Lua, size: usize) -> Result<Buffer> {
  let state = lua.state();
  // 栈峰值：trampoline 闭包 + size 实参两层（pcall 弹出并压回结果）。
  ensure_stack(state, 2)?;
  // `push_named_closure`/`push_number`（safe 门面）：`state` 存活且上一行已预留
  // 2 层头寸，恰覆盖 push closure + push number；`NEWBUFFER_NAME` 满足其 NUL
  // 结尾 'static 名契约；`c_newbuffer` 是与 `LuaCFunction` C-ABI 兼容的
  // `unsafe extern "C-unwind"` 入口，`nupvalue=0` 与栈上无 upvalue 一致；
  // `size as f64` 的饱和转换在 VM 侧再还原。
  push_named_closure(state, Some(c_newbuffer), NEWBUFFER_NAME, 0);
  push_number(state, size as f64);
  // `run_pcall`（safe 门面）：闭包与 size 实参已压栈，pcall(1 实参, 1 返回值)
  // 与 `c_newbuffer` 的栈约定严格配对；超上限分配在 `c_newbuffer` 内 raise，
  // 经此受保护调用转成非零 status（不跨帧 unwind），栈头寸由预留的 2 层覆盖。
  let status = run_pcall(state, 1, 1, 0);
  if status != 0 {
    // 失败路径 `pop_error`（safe fn）消费 VM 留下的错误消息，栈平衡唯一。
    return Err(lua.pop_error(status));
  }
  // 成功路径栈顶恒为新 buffer 对象，`pop_ref`（safe fn）消费之并登记注册表引用。
  Ok(Buffer::from_ref(lua.pop_ref()))
}

// §8：测 `pub(crate) Buffer::as_slice` 借出的重叠区间写（memmove 语义）；
// pub API 只给 `to_vec` 堆拷贝，无从构造重叠，迁 tests/ 需泄 pub，保留 src。
#[cfg(test)]
mod tests {
  use crate::state::Lua;

  /// 源区间落在同一块 VM 内存里（另一枚克隆句柄借出的切片）时必须走 memmove
  /// 语义：旧实现用 `copy_from_slice`（→ `copy_nonoverlapping`），区间重叠即 UB。
  #[test]
  fn overlapping_write_moves_within_buffer() {
    let lua = Lua::new();
    let source = lua.create_buffer(b"abcdefg").unwrap();
    let mut sink = source.clone();
    let window = source.as_slice();
    // 目标 [2..5) 与源 [0..3) 重叠：memmove 语义下等价「先读出 abc 再写入」，
    // 得到 a b a b c f g；memcpy 前向拷贝会在读到 'c' 之前就把它覆盖成 'a'。
    sink.write_bytes(2, &window[..3]);
    assert_eq!(sink.to_vec(), b"ababcfg");
  }
}
