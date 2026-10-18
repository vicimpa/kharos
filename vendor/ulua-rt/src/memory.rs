//! Memory limit + memory-category control. `set_memory_limit` mirrors
//! mlua's `Lua::set_memory_limit`; the memory-category API is a
//! ulua-specific extension (mlua 0.12.1 has no `set_memory_category`).
//!
//! ## Memory limit
//!
//! Luau routes every allocation through `global_State::frealloc(ud, ...)`. We
//! install a limit-enforcing allocator ([`limited_alloc`]) over the default one
//! by overwriting `frealloc`/`ud` on the global state, keyed by a heap-boxed
//! [`MemoryControl`] that holds the cap and a pointer back to the global state
//! (so the allocator can compare the would-be `totalbytes` to the cap). When a
//! growing allocation would exceed the cap the allocator returns null, which the
//! VM turns into a `LUA_ERRMEM` longjmp — surfaced by ulua-rt as
//! [`Error::MemoryError`](crate::Error::MemoryError).
//!
//! A limit of `0` means "unlimited" (mlua's convention).
//!
//! ## Memory categories
//!
//! Luau tags allocations with an 8-bit *category* (`global_State::activememcat`,
//! `memcatbytes[256]`). mlua exposes named categories; we keep a per-VM
//! name→id table (id 0 is reserved for `"main"`, so up to **254 user**
//! categories — 255 total including "main"), validate names
//! (`[A-Za-z0-9_]+`), and call `lua_setmemcat`.

use core::{
  ffi::c_void,
  ptr::{from_mut, from_ref, null_mut},
  sync::atomic::{AtomicU64, Ordering},
};

use ulua_common::collections::HashMap;
use ulua_vm::records::global_state::global_State;

use crate::{
  error::{Error, Result},
  state::Lua,
  sys::*,
  vm_store::{VmKey, define_vm_store, vm_key},
};

/// Luau 有 256 个类别槽（id 0..=255）；id 0 是隐式 "main"，最高槽（255）保留，
/// 因此最多 255 个不同类别（"main" 加 254 个用户类别）。
const MAX_USER_CATEGORIES: usize = 255;

/// 进程级 `MemoryControl` 身份号发放器（0 保留为"未安装"）。
static NEXT_MEMORY_TOKEN: AtomicU64 = AtomicU64::new(1);

fn next_memory_token() -> u64 {
  NEXT_MEMORY_TOKEN.fetch_add(1, Ordering::Relaxed)
}

/// The per-VM allocator control block, pointed to by `global_State::ud` once a
/// memory limit is installed.
pub(crate) struct MemoryControl {
  /// The byte cap (`0` = unlimited).
  limit: usize,
  /// Process-unique identity of the installing VM. `MemoryControls` is keyed
  /// by the `global_State` address, which malloc may hand to a *new* VM right
  /// after an old one closes — the token tells [`clear_memory`] whether the
  /// entry is still ours or already the new VM's.
  pub(crate) token: u64,
  /// The global state, so the allocator can read the live `totalbytes`.
  /// 纯 Rust 侧句柄：只在 `set_memory_limit` 写入、`limited_alloc` 内读回
  /// `global_State`，从不跨 `lua_*` C API 转手，故直接类型化为 `*mut global_State`
  /// 而非 `*mut c_void` 匿名指针。
  global: *mut global_State,
  /// The original allocator we delegate to (libc realloc/free).
  base: unsafe extern "C-unwind" fn(*mut c_void, *mut u8, usize, usize) -> *mut u8,
  /// The original allocator's userdata.
  base_ud: *mut c_void,
}

// The control block lives in a per-VM table that is process-wide under `send`,
// so it has to be `Send`: the VM (and this block with it) can move to another
// thread.
//
// Safety: every field is either a plain integer or an address of memory owned
// by the VM's own `global_State` (plus the C allocator function Luau was opened
// with, which is a pure function pointer). Moving the block between threads
// moves none of that memory; it is only ever *read* from the thread currently
// driving the VM, which is exactly what the `send` contract serialises.
#[cfg(feature = "send")]
unsafe impl Send for MemoryControl {}

define_vm_store! {
  /// One `MemoryControl` per VM, keyed by the global-state pointer. Boxed so
  /// its address (handed to the VM as `ud`) is stable.
  MemoryControls, Box<MemoryControl>
}

define_vm_store! {
  /// Per-VM memory-category name→id table (id 0 is reserved for `"main"`).
  MemoryCategories, HashMap<String, u8>
}

/// Drop this VM's category table so it doesn't leak one slot per state
/// created. Unlike [`clear_memory`] this has **no** lifetime tie to `lua_close`
/// (the VM never holds a pointer into the table), so it runs *before* close
/// like every other `vm_store` — at that point the address is still ours, so
/// a same-address successor cannot race the removal. Called from
/// `LuaInner::drop` with the key captured while the state is valid.
pub(crate) fn clear_memory_categories(key: VmKey) {
  let _ = MemoryCategories::try_with(|m| {
    m.remove(&key);
  });
}

/// Drop the VM's allocator control block **after** `lua_close` (the
/// `MemoryControl` whose address was handed to the VM as the allocator `ud`
/// must stay live for the entire close, which frees every object through it).
///
/// `token` is the identity captured *before* close: `global_State` addresses
/// are recycled by malloc, so between our close and this removal a new VM may
/// have installed its own control block under the same key. Removing that one
/// would leave the new VM's `ud` dangling — so we only remove when the token
/// still matches; our superseded block was already dropped by the successor's
/// `insert`. `token == 0` means this VM never installed a limit and there is
/// nothing of ours to remove.
pub(crate) fn clear_memory(key: VmKey, token: u64) {
  if token != 0 {
    let _ = MemoryControls::try_with(|m| {
      if m.get(&key).is_some_and(|ctrl| ctrl.token == token) {
        m.remove(&key);
      }
    });
  }
}

/// The limit-enforcing allocator. Reads the live `totalbytes` from the global
/// state and refuses any growing allocation that would push it past the cap.
///
/// # Safety
/// 仅作为 `lua_newstate`/`lua_setallocf` 安装的 `lua_Alloc`：`ud` 必须是
/// `set_memory_limit` 写入的 `*mut MemoryControl` 堆块地址（地址稳定，直到
/// `clear_memory` 在 `lua_close` 之后才移除）；`ptr` 为 null 或指向此前由本
/// 分配器返回、大小 `osize` 的块；`newrealloc` 遵守 C 分配器语义（`nsize == 0`
/// 即释放并返回 null）。
unsafe extern "C-unwind" fn limited_alloc(
  ud: *mut c_void,
  ptr: *mut u8,
  osize: usize,
  nsize: usize,
) -> *mut u8 {
  // Safety: `ud` 是 `set_memory_limit` 安装的 `ctrl_ptr`——指向
  // `MemoryControls` 表中 `Box<MemoryControl>` 的堆块。Box 地址稳定；表项
  // 直到 `clear_memory`（`LuaInner::drop` 中、`lua_close` **之后**）才移除，
  // 故 VM 生命周期内每次分配回调（含 close 期间的逐个 free）该块都存活且
  // 从未被移动。对齐即 `MemoryControl` 自然对齐（分配器本身给的）。
  // 读 `&*` 无别名冲突：分配回调只发生在驱动 VM 的线程上，回调期间无人
  // 可变该表项（`set_memory_limit` 写 `limit` 与 VM 分配不同时发生——
  // 单线程串行驱动；`send` 下由跨线程移交给当前驱动线程独占）。
  let ctrl = unsafe { &*ud.cast::<MemoryControl>() };
  if ctrl.limit != 0 && nsize > osize {
    // Safety: `ctrl.global` 由安装时的 `from_mut(&mut global_State)` 取得，
    // `global_State` 地址在整个 VM 内不变（分配一次、close 末才释放），且
    // 这里只在**增长**分配路径读 `totalbytes`——close 阶段只有 nsize==0 的
    // free（条件短路），不会读已释放的块。
    let g = unsafe { &*ctrl.global };
    let used = g.totalbytes;
    // The would-be new total once this (re)allocation is accounted for.
    let projected = used.saturating_sub(osize).saturating_add(nsize);
    if projected > ctrl.limit {
      // 超内存上限：分配器 FFI 返回 null 系分配失败契约，既有约定（review.md §2）。
      return null_mut();
    }
  }
  // Safety: `ctrl.base` 是安装瞬间从 `g.frealloc` 捕获的原分配器（libc
  // realloc 包装），类型即 `unsafe extern "C-unwind" fn(*mut c_void, *mut u8,
  // usize, usize) -> *mut u8`，`ud/ptr/osize/nsize` 原样透传 VM 给本回调的
  // 参数，与 C 分配器约定一致（ptr 为 NULL 或此前由该分配器返回的块）。
  unsafe { (ctrl.base)(ctrl.base_ud, ptr, osize, nsize) }
}

impl Lua {
  /// Set the VM's memory limit in bytes (`0` = unlimited). Mirrors
  /// `mlua::Lua::set_memory_limit`.
  ///
  /// Once installed, an allocation that would exceed the cap fails with
  /// [`Error::MemoryError`], both during execution
  /// and during chunk loading.
  pub fn set_memory_limit(&self, limit: usize) -> Result<usize> {
    let state = self.state();
    // `state` 为存活 VM 状态（`self.state()` 经 `Rc<LuaInner>` 持有），
    // `(*state).global` 构造期接线非空——满足 `vm_key`（safe 门面）的调用序契约。
    let key = vm_key(state);
    // Already installed: just update the cap (pure Rust table op, no boundary).
    let prev = MemoryControls::with(|map| {
      map.get_mut(&key).map(|ctrl| {
        let prev = ctrl.limit;
        ctrl.limit = limit;
        prev
      })
    });
    if let Some(prev) = prev {
      return Ok(prev);
    }
    // First install: capture the existing allocator and wrap it.
    // 构造期不变式：state 只能经 lua_newstate/lua_l_newstate 族诞生，
    // 创建即恒传入非空 frealloc（Luau falloc 契约），本函数只在存活 state
    // 上首次安装限额；frealloc 为 null 仅出现在未初始化/已销毁内存，
    // 借用生命周期已挡——expect 不可达。
    // Safety: `state.global` 构造期接线非空。`global_State` 地址全程稳定，`&mut`
    // 重建无别名冲突——`g` 只被当前驱动线程经本方法可变访问，其后的哈希表写入
    // 不触碰 `g`，且 Rust 侧哈希表的分配走全局 Rust allocator、不经 VM `frealloc`
    // 钩子，回调不可能在持有 `&mut g` 期间重入本帧。
    let global_ptr = state.global;
    let g = unsafe { &mut *global_ptr };
    // 以下字段读、`Box` 构造、`from_mut`/`from_ref` 取址皆是纯 Rust 操作（`base`
    // 仅是拷贝一个 fn 指针值，`expect` 由构造期不变式挡下 null：state 只能经
    // lua_newstate/lua_l_newstate 族诞生、创建即恒传入非空 frealloc）。
    let base = g.frealloc.expect("VM allocator must be set");
    let base_ud = g.ud;
    let ctrl = Box::new(MemoryControl {
      limit,
      token: next_memory_token(),
      global: from_mut(g),
      base,
      base_ud,
    });
    let ctrl_ptr = from_ref(&*ctrl).cast_mut().cast();
    // `ctrl` 移入进程级 `MemoryControls` 表（Box 地址稳定，其 `global`/`ud` 指针
    // 在表项存活期内有效）。
    MemoryControls::with(|map| {
      map.insert(key, ctrl);
    });
    // 经 `g`（安全 `&mut` 借用，其非空/存活/无别名前提已在上一处
    // `&mut *(*state).global` 证成）写两个字段：`ctrl_ptr` 指向刚 insert 进表的
    // Box，地址稳定且经 `clear_memory`（`lua_close` 之后）才释放，满足新 `frealloc`
    // 解引用 `ud` 的存活前提；`base/base_ud` 捕获旧钩子保证委托链不断裂。两字段
    // 写入之间无分配、单线程串行，不存在半安装窗口被观测。写入本身是安全操作。
    g.ud = ctrl_ptr;
    g.frealloc = Some(limited_alloc);
    Ok(0)
  }

  /// Set the active memory category by name. Mirrors
  /// `mlua::Lua::set_memory_category`.
  ///
  /// Category names must be non-empty and consist only of `[A-Za-z0-9_]`.
  /// At most 254 distinct user categories can be created (id 0 is reserved for
  /// the implicit `"main"` category — 255 total); creating one more fails.
  pub fn set_memory_category(&self, name: &str) -> Result<()> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
      return Err(Error::runtime(format!(
        "invalid memory category name: {name:?}"
      )));
    }
    let mut state = self.state();
    // `state` 为存活 VM 状态（`self.state()` 经 `Rc<LuaInner>` 持有），满足
    // `vm_key`（safe 门面）的调用序契约。
    let key = vm_key(state);
    let id = MemoryCategories::with(|map| -> Result<u8> {
      let cats = map.entry(key).or_insert_with(|| {
        let mut h = HashMap::default();
        // id 0 is the implicit "main" category.
        h.insert("main".to_string(), 0u8);
        h
      });
      if let Some(&id) = cats.get(name) {
        return Ok(id);
      }
      // Assign the next free id. At most [`MAX_USER_CATEGORIES`] distinct
      // categories exist (see the const).
      let next = cats.len();
      if next >= MAX_USER_CATEGORIES {
        return Err(Error::runtime(
          "too many memory categories (limit 254 user categories)".to_string(),
        ));
      }
      let id = next as u8;
      cats.insert(name.to_string(), id);
      Ok(id)
    })?;
    // `id < MAX_USER_CATEGORIES (255)` 由上方分配逻辑保证，是 `lua_setmemcat`
    // 接受的 8-bit 类别域内值；该调用只写 `global_State::activememcat` 一个字段，
    // 不触碰栈（ulua-vm 已前移为安全签名，`&mut state` 经 DerefMut 协变）。
    lua_setmemcat(&mut state, id as i32);
    Ok(())
  }

  /// The number of bytes accounted to the named memory category, or `None` if
  /// the category was never set on this VM. A ulua-rt extension (mlua tracks
  /// this only via `heap_dump`, which ulua cannot back — see the module).
  pub fn memory_category_bytes(&self, name: &str) -> Option<usize> {
    let state = self.state();
    // 前提同 `set_memory_category`。
    let key = vm_key(state);
    let id = MemoryCategories::with(|map| map.get(&key).and_then(|c| c.get(name).copied()))?;
    // Safety: `global` 非空且长寿;`id` 由类别表分配,恒
    // `< 255 < 256 = memcatbytes` 数组长度,索引在界内;纯读数无别名要求。
    let g = unsafe { &*state.global };
    Some(g.memcatbytes[id as usize])
  }
}
