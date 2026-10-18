//! Per-VM **application data** — a typed, borrow-checked side store keyed by
//! Rust `TypeId`. Mirrors `mlua::Lua`'s app-data surface (`set_app_data`,
//! `app_data_ref`, `app_data_mut`, `remove_app_data`, and the `try_*` variants).
//!
//! Each `Lua` instance has its own store. Values are kept behind a per-entry
//! [`RefCell`], so a `&T` ([`AppDataRef`]) and a `&mut T` ([`AppDataRefMut`])
//! of **different** types can coexist (the usual aliasing rules apply only
//! within a single type). A VM-wide borrow counter (matching mlua's `AppData`)
//! additionally makes *any* outstanding borrow block `set_app_data` /
//! `remove_app_data` of *any* type, so the container is never mutated while a
//! guard is live.
//!
//! The store lives in the crate-wide per-VM side table (see
//! [`crate::vm_store`]): a thread-local map without `send`, a process-wide one
//! with it, keyed by the VM's global-state pointer. `LuaInner` itself cannot
//! hold it because it is shared immutably behind an `XRc`.

use core::{
  fmt::{self, Debug, Display, Formatter},
  marker::PhantomData,
  mem,
};
use std::{
  any::{Any, TypeId},
  cell::{Cell, Ref, RefCell, RefMut},
  ops::{Deref, DerefMut},
};

use ulua_common::collections::HashMap;

use crate::{
  error::{Error, Result},
  state::Lua,
  sync::{MaybeSend, XRc},
  vm_store::{VmKey, define_vm_store, vm_key_of},
};

/// The type-erased payload of one entry.
///
/// dyn 保留：可存类型是任意宿主在运行期选定的 `T: 'static`（`TypeId` 键控
/// TypeMap），类型集合开放，擦除不可替代。
///
/// DELIBERATE DEVIATION（保留 `Box<dyn Any>`）：可存类型集合运行期开放（任意
/// `T: 'static`，按 `TypeId` 键控），取值依赖 `Any::downcast`，类型擦除不可替代。
/// 调用点证据：[`Lua::set_app_data`] 的 `T`、`app_data_ref`/`app_data_mut` 的
/// downcast 目标都由宿主在运行期选定（mlua app-data 语义），非有限枚举可穷举。
///
/// Under `send` the payload must be `Send`: the store itself moves between
/// threads with the VM, so its map is process-wide (see [`crate::vm_store`]) and
/// a `Mutex<VmMap<..>>` is only `Sync` if the values are `Send`. That is why
/// [`Lua::set_app_data`] additionally requires `T: MaybeSend` — mirroring
/// `mlua`'s app-data bounds — while the borrow APIs stay `T: 'static`.
#[cfg(feature = "send")]
type Payload = Box<dyn Any + Send>;

/// dyn 保留：同上方注（可存类型集合运行期开放），此处仅差 `Send` 界。
#[cfg(not(feature = "send"))]
type Payload = Box<dyn Any>;

/// One entry: a value behind a `RefCell` so per-type borrows can be tracked,
/// shared via `XRc` so a returned guard can outlive a borrow of the outer map.
/// `XRc` = `Arc` under `send`——进程级 `Mutex<VmMap<Store>>` 要求 `Store: Send`。
type Entry = XRc<EntryCell>;

/// `RefCell<Payload>` 的包装（内部结构，字段直接曝光）：`send` 下
/// `Arc<RefCell<..>>` 因 `RefCell: !Sync` 触发 `arc_with_non_send_sync`，故仿
/// `LuaInner`/`LuaRef` 手动声明 `Send + Sync`。
struct EntryCell(RefCell<Payload>);

impl EntryCell {
  fn into_inner(self) -> Payload {
    self.0.into_inner()
  }
}

// Safety: 与下方 `Store` 的理由相同——所有对条目的借用都发生在进程级
// `Mutex` 临界区内、由当前驱动该 VM 的线程串行执行（`send` 契约为
// 移动而非并发共享）；活着的 `Ref`/`RefMut` 守卫本身 `!Send`，
// 不可能被带到其他线程并发触碰内部 `RefCell`。
unsafe impl Send for EntryCell {}
// Safety: `Sync` 与上方 `Send` 同理且要求更强（跨线程共享引用）——仍然成立，
// 因为 `EntryCell` 只经 `XRc`（`send` 下为 `Arc`）被共享，而所有解引用点
// （`try_borrow`/`try_borrow_mut`/守卫 drop）都先取进程级 `Mutex<VmMap<Store>>`
// 或由 `!Send` 守卫钉在原线程，不存在两个线程同时触碰同一 `RefCell` 的
// 可构造执行序；`send` 契约只允许 VM 所有权移动，移动时随句柄一起带走
// 全部 `Ref`/`RefMut`（它们本就 `!Send`，不会滞留旧线程）。
unsafe impl Sync for EntryCell {}

/// Per-VM store: the entries plus a VM-wide outstanding-borrow counter (shared
/// via `XRc<Cell<usize>>` so a live guard can decrement it on drop).
#[derive(Default)]
pub(crate) struct Store {
  entries: HashMap<TypeId, Entry>,
  borrow: XRc<Cell<usize>>,
}

// The `Mutex<VmMap<Store>>` under `send` demands `Store: Send`, but
// `Arc<RefCell<..>>` is not `Send` transitively (`RefCell` is never `Sync`).
//
// Safety: every map mutation runs inside the process-wide `Mutex` critical
// section, so entries and the borrow counter are only touched from the thread
// currently driving the VM — exactly what the `send` contract serialises. The
// refcount fields are `XRc` (=`Arc`, atomically counted) under `send`, so a
// guard's `_owner` clone/drop on any thread cannot race the map; the borrow
// guards themselves (`Ref`/`RefMut`) are `!Send`, so a live borrow can never
// be *moved* to another thread to touch the `RefCell`/`Cell` concurrently.
#[cfg(feature = "send")]
unsafe impl Send for Store {}

define_vm_store! {
  /// Per-VM application-data store, keyed by global-state pointer.
  AppDataStore, Store
}

/// 任何未结清的 app-data 借用都会阻塞容器的 insert/remove（mlua 语义）；
/// 三处（set / try_set / remove）共用此文案。
const BORROW_CONFLICT_MSG: &str = "cannot mutably borrow app data container";

/// 把 `RefCell` 的借用守卫提升到 `'static`（签名固定输入/输出类型对，杜绝
/// 无关类型的 `transmute` 误用）。
///
/// 已知保留的最小 choke point（review.md §2「把 `unsafe` 关进有契约的最小边界」）。
/// 为何安全形态不可能：守卫是**自引用**结构体——它把持有 `RefCell` 的
/// `XRc<EntryCell>` 移进自身的 `_owner` 字段，同时字段里还存着一个借用该
/// `RefCell` 的 `Ref`。没有任何外部生命周期能表达「`Ref` 借用的目标由同结构体
/// 的兄弟字段拥有」这条不变式，`Deref` 又必须在守卫整个存续期内交出 `&T`（而非
/// 临时借用），故无法用 `&'a self` 重取。给 [`AppDataRef`] 挂一个 `'a` 绑定到
/// `&'a Lua` 也不解决问题：`RefCell` 活在 crate 级按 VM 键控的 side table
/// （[`crate::vm_store`]）里、不在 `Lua` 的借用内存中，`&'a Lua` 无法佐证其存活。
/// mlua 的 `AppDataRef`/`AppDataRefMut` 语义要求守卫**能活过 `&self` 借用**（自
/// 持 `XRc` 让 `RefCell` 保活），这正是必须 `'static` 拓宽的根因。收窄至此单一
/// 转调点，前提由调用点结构体逐条担保（见两处调用点 Safety 与字段顺序注）。
///
/// # Safety
/// 调用方必须同时保有一个让底层 `RefCell` 活到 `'static` 的强引用（`Entry`
/// `XRc`），且守卫结构体的字段顺序保证 `Ref::drop` 先于该 `XRc` 的 drop。
unsafe fn leak_ref<'a, T: ?Sized + 'static>(r: Ref<'a, T>) -> Ref<'static, T> {
  // Safety: `Ref<'a,T>` 与 `Ref<'static,T>` 布局逐字节相同（仅 PhantomData
  // 生命周期标记不同，无指针位差），transmute 不产生任何运行时操作；
  // `'a: 'static` 的实质提升由本 `unsafe fn` 契约交给调用方——见两处
  // 调用点证成（`XRc<EntryCell>` 强引用 + 守卫结构体字段顺序）。
  unsafe { mem::transmute(r) }
}

/// [`leak_ref`] 的可变版本；安全前提相同。
///
/// # Safety
/// 同 [`leak_ref`]。
unsafe fn leak_ref_mut<'a, T: ?Sized + 'static>(r: RefMut<'a, T>) -> RefMut<'static, T> {
  // Safety: 同 `leak_ref`——`RefMut` 两生命周期形态布局相同（NonNull +
  // `&Cell` 借用标记），transmute 无运行时效果，实质前提由调用点承担。
  unsafe { mem::transmute(r) }
}

/// An immutable borrow of an application-data value of type `T`. Mirrors
/// `mlua::AppDataRef`.
pub struct AppDataRef<T: 'static> {
  // Hold the `XRc<RefCell>` alive and the `Ref` borrow open for as long as the
  // guard lives. The `'static` `Ref` is sound because the `_owner` `XRc` below
  // keeps the `RefCell` alive. 字段顺序是 soundness 的一部分：`guard` 必须先于
  // `_owner` drop——若 VM 在 guard 存活期间被 drop（`clear_app_data` 无条件移除
  // store，不检查 borrow 计数），`_owner` 会成为 `RefCell` 的最后一个强引用，
  // 先 drop 它即释放 `RefCell`，随后 `Ref::drop` 触碰已释放内存（UB）。
  guard: Ref<'static, Payload>,
  _owner: Entry,
  borrow: XRc<Cell<usize>>,
  _marker: PhantomData<T>,
}

impl<T: 'static> Drop for AppDataRef<T> {
  fn drop(&mut self) {
    self.borrow.set(self.borrow.get().saturating_sub(1));
  }
}

impl<T: 'static> Deref for AppDataRef<T> {
  type Target = T;
  fn deref(&self) -> &T {
    // 构造期不变式：store 以 TypeId::of::<T>() 为键、插入侧总是装箱 T 本体，
    // 守卫只能经 lookup_entry::<T> 取到同型条目，downcast 必命中；panic 不可达，保留作纵深防御。
    self
      .guard
      .downcast_ref::<T>()
      .expect("app data type mismatch")
  }
}

impl<T: Debug + 'static> Debug for AppDataRef<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    (**self).fmt(f)
  }
}

impl<T: Display + 'static> Display for AppDataRef<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    (**self).fmt(f)
  }
}

impl<T: PartialEq + 'static> PartialEq<T> for AppDataRef<T> {
  fn eq(&self, other: &T) -> bool {
    (**self) == *other
  }
}

/// A mutable borrow of an application-data value of type `T`. Mirrors
/// `mlua::AppDataRefMut`.
pub struct AppDataRefMut<T: 'static> {
  // 同 [`AppDataRef`]：`guard` 必须先于 `_owner` drop（字段顺序即析构顺序），
  // 保证 `RefMut::drop` 时 `RefCell` 经 `_owner` 仍存活。
  guard: RefMut<'static, Payload>,
  _owner: Entry,
  borrow: XRc<Cell<usize>>,
  _marker: PhantomData<T>,
}

impl<T: 'static> Drop for AppDataRefMut<T> {
  fn drop(&mut self) {
    self.borrow.set(self.borrow.get().saturating_sub(1));
  }
}

impl<T: 'static> Deref for AppDataRefMut<T> {
  type Target = T;
  fn deref(&self) -> &T {
    // 同 AppDataRef::deref：TypeId 键与装箱类型同源，downcast 必命中（构造期不变式）。
    self
      .guard
      .downcast_ref::<T>()
      .expect("app data type mismatch")
  }
}

impl<T: 'static> DerefMut for AppDataRefMut<T> {
  fn deref_mut(&mut self) -> &mut T {
    // 同上：TypeId 键保证同型，panic 不可达。
    self
      .guard
      .downcast_mut::<T>()
      .expect("app data type mismatch")
  }
}

impl<T: Debug + 'static> Debug for AppDataRefMut<T> {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    (**self).fmt(f)
  }
}

impl<T: PartialEq + 'static> PartialEq<T> for AppDataRefMut<T> {
  fn eq(&self, other: &T) -> bool {
    (**self) == *other
  }
}

/// Fetch the entry of type `T` from the per-VM store (shared guard included),
/// or `None` if absent. Shared by `try_app_data_ref` / `try_app_data_mut`.
fn lookup_entry<T: 'static>(lua: &Lua) -> Option<(Entry, XRc<Cell<usize>>)> {
  let key = vm_key_of(lua);
  AppDataStore::with(|outer| {
    outer.get(&key).and_then(|store| {
      store
        .entries
        .get(&TypeId::of::<T>())
        .map(|e| (e.clone(), store.borrow.clone()))
    })
  })
}

/// 独占取回 `XRc<EntryCell>` 并 downcast 成 `T`：仍有其他 `XRc` 克隆（借用守卫
/// 持有着）或类型不符则返回 `None`。`try_set_app_data` 取回旧值与
/// `remove_app_data` 取回值两处逐字同形，收口于此。
fn take_entry_value<T: 'static>(entry: Entry) -> Option<T> {
  XRc::try_unwrap(entry)
    .ok()
    .and_then(|cell| cell.into_inner().downcast::<T>().ok().map(|b| *b))
}

impl Lua {
  /// Insert (or replace) a value of type `T` in this VM's application-data
  /// store. Mirrors `mlua::Lua::set_app_data`.
  ///
  /// Under the `send` feature `T` must be `Send` (see `Payload`), because the
  /// VM — and with it the store — can be moved to another thread.
  ///
  /// # Panics
  /// Panics if **any** app-data value is currently borrowed.
  pub fn set_app_data<T: MaybeSend + 'static>(&self, data: T) {
    // mlua 对等的文档化 panic（见上方 `# Panics`）：try_ 版仅在存在未结 borrow 时
    // 返回 Err，公开契约就是把该 Err 转 panic，非隐藏错误路径。
    self.try_set_app_data(data).expect(BORROW_CONFLICT_MSG);
  }

  /// Try to insert (or replace) a value of type `T`. Returns the previous
  /// value, or an error if any app-data value is currently borrowed. Mirrors
  /// `mlua::Lua::try_set_app_data`.
  ///
  /// Under the `send` feature `T` must be `Send`; see [`Lua::set_app_data`].
  pub fn try_set_app_data<T: MaybeSend + 'static>(&self, data: T) -> Result<Option<T>> {
    let key = vm_key_of(self);
    AppDataStore::with(|outer| {
      let store = outer.entry(key).or_default();
      // Any outstanding borrow blocks mutation of the container (mlua).
      if store.borrow.get() != 0 {
        return Err(Error::runtime(BORROW_CONFLICT_MSG));
      }
      let old = store.entries.insert(
        TypeId::of::<T>(),
        XRc::new(EntryCell(RefCell::new(Box::new(data)))),
      );
      Ok(old.and_then(take_entry_value::<T>))
    })
  }

  /// Borrow the application-data value of type `T` immutably, if present.
  /// Mirrors `mlua::Lua::app_data_ref`.
  ///
  /// # Panics
  /// Panics if the value is currently mutably borrowed.
  pub fn app_data_ref<T: 'static>(&self) -> Option<AppDataRef<T>> {
    // mlua 对等的文档化 panic（`# Panics`）：Err 仅代表当前有未结可变借用，
    // 契约要求转为 panic，错误路径已由 try_app_data_ref 提供。
    self
      .try_app_data_ref::<T>()
      .unwrap_or_else(|_| panic!("already mutably borrowed"))
  }

  /// Try to borrow the application-data value of type `T` immutably. Returns
  /// `Ok(None)` if absent, `Err` if it is currently mutably borrowed. Mirrors
  /// `mlua::Lua::try_app_data_ref`.
  pub fn try_app_data_ref<T: 'static>(&self) -> Result<Option<AppDataRef<T>>> {
    let Some((entry, borrow)) = lookup_entry::<T>(self) else {
      return Ok(None);
    };
    let guard = entry
      .0
      .try_borrow()
      .map_err(|_| Error::runtime("app data is currently mutably borrowed"))?;
    // Extend the borrow lifetime to `'static`; the `_owner` `Rc` we keep
    // alongside keeps the `RefCell` alive for as long as the guard lives, and
    // the guard struct's field order (guard 先于 `_owner` drop) 保证
    // `Ref::drop` 时 `RefCell` 仍然存活——即使 VM 已被 drop、`_owner` 已是
    // 最后一个 `Rc`（此时释放 `RefCell` 的是 `_owner` 的 drop，晚于本 drop）。
    // Safety: 满足 `leak_ref` 契约——`entry`（`XRc<EntryCell>`）被移进守卫的
    // `_owner` 字段，其强引用把 `RefCell` 保到 `'static` 需求为止；字段顺序
    // （`guard` 声明在 `_owner` 前）保证析构时 `Ref::drop` 先跑。借用互斥由
    // `try_borrow` 运行时检查 + VM 级 `borrow` 计数（insert/remove 被任何
    // 未结借用挡下）共同保证。
    let guard: Ref<'static, Payload> = unsafe { leak_ref(guard) };
    borrow.set(borrow.get() + 1);
    Ok(Some(AppDataRef {
      _owner: entry,
      guard,
      borrow,
      _marker: PhantomData,
    }))
  }

  /// Borrow the application-data value of type `T` mutably, if present.
  /// Mirrors `mlua::Lua::app_data_mut`.
  ///
  /// # Panics
  /// Panics if the value is currently borrowed (immutably or mutably).
  pub fn app_data_mut<T: 'static>(&self) -> Option<AppDataRefMut<T>> {
    // mlua 对等的文档化 panic（`# Panics`）：Err 仅代表当前有未结借用，
    // 契约要求转为 panic，错误路径已由 try_app_data_mut 提供。
    self
      .try_app_data_mut::<T>()
      .unwrap_or_else(|_| panic!("already borrowed"))
  }

  /// Try to borrow the application-data value of type `T` mutably. Returns
  /// `Ok(None)` if absent, `Err` if it is currently borrowed. Mirrors
  /// `mlua::Lua::try_app_data_mut`.
  pub fn try_app_data_mut<T: 'static>(&self) -> Result<Option<AppDataRefMut<T>>> {
    let Some((entry, borrow)) = lookup_entry::<T>(self) else {
      return Ok(None);
    };
    let guard = entry
      .0
      .try_borrow_mut()
      .map_err(|_| Error::runtime("app data is currently borrowed"))?;
    // 同 [`Lua::try_app_data_ref`]：`'static` 生命周期提升 + guard 结构体字段
    // 顺序保证 `RefMut::drop` 时 `RefCell` 仍存活。
    // Safety: 满足 `leak_ref_mut` 契约，论证同 `try_app_data_ref` 的 `leak_ref`
    // 调用点——唯一强化处是这里拿的是 `RefMut`：`try_borrow_mut` 运行时闸门
    // 保证此刻 `RefCell` 无任何其他借用，且 borrow 计数挡住并发 insert/remove；
    // 跨线程竞争不可能出现——句柄 `!Sync`，`send` 契约下同 VM 恒单线程驱动。
    let guard: RefMut<'static, Payload> = unsafe { leak_ref_mut(guard) };
    borrow.set(borrow.get() + 1);
    Ok(Some(AppDataRefMut {
      _owner: entry,
      guard,
      borrow,
      _marker: PhantomData,
    }))
  }

  /// Remove and return the application-data value of type `T`, if present.
  /// Mirrors `mlua::Lua::remove_app_data`.
  ///
  /// # Panics
  /// Panics if **any** app-data value is currently borrowed.
  pub fn remove_app_data<T: 'static>(&self) -> Option<T> {
    let key = vm_key_of(self);
    AppDataStore::with(|outer| {
      let store = outer.get_mut(&key)?;
      assert!(store.borrow.get() == 0, "{BORROW_CONFLICT_MSG}");
      let entry = store.entries.remove(&TypeId::of::<T>())?;
      take_entry_value::<T>(entry)
    })
  }
}

/// Drop this VM's entire application-data store. Called from `LuaInner::drop`.
pub(crate) fn clear_app_data(key: VmKey) {
  // 唯一调用点在 `LuaInner::drop` 的 clear 序列、`lua_close` 之前（见 `state.rs`）,
  // key 已在彼处由存活 state 算出。
  let _ = AppDataStore::try_with(|outer| {
    outer.remove(&key);
  });
}
