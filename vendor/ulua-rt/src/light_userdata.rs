//! [`LightUserData`] — a raw pointer carried as a first-class Lua value.
//!
//! Mirrors `mlua::LightUserData`. A light userdata is just a `void *` stored
//! directly in a Lua value (no GC, no metatable storage of its own beyond the
//! per-type metatable). ulua's VM represents it as the `LUA_TLIGHTUSERDATA`
//! tag; we push it via `lua_pushlightuserdatatagged` (tag 0) and read it back
//! with `lua_tolightuserdata`.

use core::ffi::c_void;

/// A Lua light userdata: an opaque raw pointer value. Mirrors
/// `mlua::LightUserData`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LightUserData(pub *mut c_void);

// Under the `send` feature the whole VM (and every `Value` it can hold) is
// `Send` so it can be *moved* across threads. A light userdata is an opaque
// pointer value with no thread affinity of its own — moving it with the VM is
// sound under ulua-rt's move-not-share contract (see `crate::sync`). mlua makes
// the same documented `unsafe impl Send` for its `LightUserData`.
#[cfg(feature = "send")]
// Safety: 本类型只**携带**指针值、不持有任何指向 pointee 的引用；跨线程移动它仅搬动
// 数值本身，不复制别名。真正的解引用发生在 VM 内的 `unsafe` 代码里，由 `crate::sync`
// 的"移动而非共享、访问串行化"契约约束，与本 marker 无关。
unsafe impl Send for LightUserData {}
#[cfg(feature = "send")]
// Safety: 本类型是纯指针**值**（`Copy`，不持有指向 pointee 的引用），`&LightUserData`
// 跨线程共享只复制这个数值，不会给 VM 状态制造别名——这与 `crate::sync` 刻意不给
// 句柄 / `Lua` 实现 `Sync` 并不冲突。并发解引用同一 pointee 属于调用方 `unsafe` 代码
// 的责任，不由本 marker 背书。
unsafe impl Sync for LightUserData {}
