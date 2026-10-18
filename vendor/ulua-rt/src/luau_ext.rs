//! Luau-specific `Lua` extensions: sandboxing, safeenv, fflags, and the
//! per-VM compiler. Mirrors the Luau-only parts of mlua's `Lua` surface.

use crate::{
  compiler::Compiler,
  error::{Error, Result},
  function::Function,
  light_userdata::LightUserData,
  registry::RegHandle,
  state::{
    Lua, ensure_stack, ensure_stack_or_panic, get_metatable_at, pop_stack, push_anonymous_closure,
    push_boolean, push_bytes, push_nil, push_null_lightuserdata, push_number, push_vector,
    replace_globals_from_top, sandbox_main, sandbox_thread, set_metatable_at, set_readonly_at,
    set_safeenv_flag, spawn_thread,
  },
  string::LuaString,
  sys::*,
  table::Table,
  thread::Thread,
  value::Value,
  vector::Vector,
  vm_store::{VmKey, define_vm_store, vm_key_of},
};

define_vm_store! {
    /// Per-VM compiler installed via `Lua::set_compiler`, keyed by global state.
    VmCompilers, Compiler
}

define_vm_store! {
    /// Per-VM `catch_rust_panics` option (recorded from `LuaOptions`), keyed by
    /// global state. Currently recorded for parity; see `set_catch_rust_panics`.
    VmCatchPanics, bool
}

define_vm_store! {
    /// Per-VM "is sandboxed" flag, keyed by global state. Mirrors mlua's
    /// `extra.sandboxed`; consulted by `Lua::set_globals`.
    VmSandboxed, bool
}

/// Registry name under which `sandbox(true)` saves the ORIGINAL globals table so
/// `sandbox(false)` can restore it. Kept in the state's registry (freed on
/// `lua_close`), NOT in a thread-local `Table` handle: a handle owns an
/// `XRc<LuaInner>`, so a thread-local holding it would pin the VM alive forever
/// (the state could never drop) if the caller dropped a still-sandboxed `Lua`.
const SANDBOX_SAVED_GLOBALS_NAME: &str = "__ulua_sandbox_saved_globals";

/// Drop this VM's compiler / catch-panics / sandboxed-flag entries so they don't
/// leak one slot per state created. Called from `LuaInner::drop`. (These hold no
/// Lua handle, so the state drops normally and this runs; the saved-globals table
/// lives in the registry and is freed with the state on `lua_close`.)
pub(crate) fn clear_vm_state(key: VmKey) {
  // 唯一调用点在 `LuaInner::drop` 的 clear 序列、`lua_close` 之前,key 已在彼处
  // 由存活 state 算出。
  let _ = VmCompilers::try_with(|m| {
    m.remove(&key);
  });
  let _ = VmCatchPanics::try_with(|m| {
    m.remove(&key);
  });
  let _ = VmSandboxed::try_with(|m| {
    m.remove(&key);
  });
}

impl Lua {
  /// Enable or disable sandbox mode. Mirrors `mlua::Lua::sandbox`.
  ///
  /// Enabling sets every library table (and the globals table) read-only and
  /// activates `safeenv`, then installs a fresh proxy global table (via
  /// `luaL_sandboxthread`) so that script-level global writes go to a
  /// throwaway table whose `__index` is the original environment. Disabling
  /// restores the original globals table and clears the read-only/safeenv
  /// flags.
  ///
  /// **DEVIATION:** Luau's standard library (as bundled in ulua) does not
  /// register `collectgarbage`; mlua's sandbox test additionally checks that
  /// `collectgarbage` is restricted under the sandbox. That part is not
  /// exercisable here (see `tests/mlua_luau.rs`).
  pub fn sandbox(&self, enabled: bool) -> Result<()> {
    let state = self.state();
    let key = vm_key_of(self);
    VmSandboxed::with(|m| {
      m.insert(key, enabled);
    });
    if enabled {
      // Save the ORIGINAL globals table (once) in the registry so we can
      // restore it later. Registry-rooted, not a thread-local handle —
      // see SANDBOX_SAVED_GLOBALS_NAME. `or_insert` semantics: only save
      // if not already saved (a second sandbox(true) keeps the first)。
      if self
        .named_registry_value::<Table>(SANDBOX_SAVED_GLOBALS_NAME)
        .is_err()
      {
        let original = self.globals();
        let _ = self.set_named_registry_value(SANDBOX_SAVED_GLOBALS_NAME, original);
      }
      // Make libraries + base metatables read-only and set safeenv.
      // `sandbox_main` 是带契约的 safe 门面（`lua_l_sandbox` 收口点）：`state` 由
      // self 的 `XRc<LuaInner>` 锚定存活且由当前线程驱动，内部压弹的临时值全自平衡。
      sandbox_main(state);
      // Install the proxy global table for script-level writes.
      // `sandbox_thread` 是带契约的 safe 门面（`lua_l_sandboxthread` 收口点）：只对该
      // main state 自身的 `LUA_GLOBALSINDEX` 安装代理表，push/replace 自平衡。
      sandbox_thread(state);
    } else {
      // Restore the original globals table (dropping the proxy and any
      // globals written into it), then clear the saved slot。
      if let Ok(orig) = self.named_registry_value::<Table>(SANDBOX_SAVED_GLOBALS_NAME) {
        // 预留 `orig` 压入的一层（`lua_replace` 随即弹掉）。
        ensure_stack(state, 1)?;
        // `orig.push_to_stack()` 是 safe 封装（`lua_rawgeti` 自带栈预留）；owning VM
        // 与本 VM 一致由 move-not-share 句柄纪律保证，同 `set_globals`。
        orig.push_to_stack();
        // Safety: 栈顶即刚压入的 `orig`，`replace` 把它写到合法伪索引
        // `LUA_GLOBALSINDEX`，净弹一层，头寸由上面的 `ensure_stack` 覆盖。
        replace_globals_from_top(state);
        // Clear read-only + safeenv on the restored globals so it is
        // writable again.
        // `set_readonly_at` 是带契约的 safe 门面（`(*state).set_readonly` 收口点）：
        // 对同一伪索引 `LUA_GLOBALSINDEX` 的表写只读标志位，不压弹栈。
        set_readonly_at(state, LUA_GLOBALSINDEX, false);
        // safeenv 的清除复用 `Self::set_safeenv`（safe fn，其契约在自身调用点）。
        self.set_safeenv(false);
        // Also clear read-only on the library tables.
        self.clear_library_readonly();
        // Clear the saved slot so a later sandbox(true) re-saves.
        let _ = self.set_named_registry_value(SANDBOX_SAVED_GLOBALS_NAME, Value::Nil);
      }
    }
    Ok(())
  }

  /// Clear the read-only flag on every library table reachable from the
  /// (restored) globals. Used when leaving sandbox mode.
  fn clear_library_readonly(&self) {
    let globals = self.globals();
    for pair in globals.pairs::<Value, Value>() {
      if let Ok((_, Value::Table(t))) = pair {
        t.set_readonly(false);
      }
    }
  }

  /// Set or clear the `safeenv` flag on the globals table. Mirrors
  /// `mlua::Globals::set_safeenv` applied to the main globals.
  ///
  /// `safeenv` lets the VM fast-path global reads; clearing it forces the slow
  /// path (needed when globals/`__index` may change at runtime).
  pub fn set_safeenv(&self, enabled: bool) {
    let state = self.state();
    // `set_safeenv_flag` 是带契约的 safe 门面（`lua_setsafeenv` 收口点）：`state` 存活
    // （self 的 `XRc<LuaInner>`）；运行 VM 中 `LUA_GLOBALSINDEX` 恒指向 globals 表，满足
    // 其对 objindex 解出表的内部断言；只翻表对象 safeenv 标志位，不压弹栈。
    set_safeenv_flag(state, LUA_GLOBALSINDEX, enabled);
  }

  /// Install a default [`Compiler`] used to compile every chunk loaded by this
  /// VM (unless a chunk overrides it via
  /// [`Chunk::set_compiler`](crate::Chunk::set_compiler)). Mirrors
  /// `mlua::Lua::set_compiler`.
  pub fn set_compiler(&self, compiler: Compiler) {
    let key = vm_key_of(self);
    VmCompilers::with(|m| {
      m.insert(key, compiler);
    });
  }

  /// Record the `catch_rust_panics` behavioral option for this VM.
  ///
  /// **DEVIATION:** ulua-rt's callback trampoline always catches a Rust panic
  /// and converts it into a catchable Lua error (so the VM is never left
  /// half-unwound). The mlua option that lets a panic propagate as a Rust
  /// unwind across the VM boundary is therefore recorded here but not enforced
  /// — see the deferred `test_panic` in `tests/mlua_core.rs`.
  pub(crate) fn set_catch_rust_panics(&self, enabled: bool) {
    let key = vm_key_of(self);
    VmCatchPanics::with(|m| {
      m.insert(key, enabled);
    });
  }

  /// Whether this VM is currently sandboxed (set by [`Lua::sandbox`]). Mirrors
  /// mlua's `extra.sandboxed` flag; consulted by [`Lua::set_globals`].
  pub(crate) fn is_sandboxed(&self) -> bool {
    let key = vm_key_of(self);
    VmSandboxed::with(|m| m.get(&key).copied().unwrap_or(false))
  }

  /// The VM-default compiler installed via [`Lua::set_compiler`], if any.
  pub(crate) fn vm_compiler(&self) -> Option<Compiler> {
    let key = vm_key_of(self);
    VmCompilers::with(|m| m.get(&key).cloned())
  }

  /// Set (or clear) the metatable shared by all values of a Luau built-in
  /// type `T`. Mirrors `mlua::Lua::set_type_metatable`.
  ///
  /// Implemented for [`Vector`], `bool`, [`Number`](f64),
  /// [`LuaString`], [`Function`],
  /// [`Thread`], and
  /// [`LightUserData`]. Setting it installs a metatable
  /// in the VM's global per-type metatable slot, so e.g. `v.x`/`v:method`
  /// dispatch through it.
  pub fn set_type_metatable<T: TypeMetatable>(&self, metatable: Option<Table>) {
    T::set_type_metatable(self, metatable);
  }

  /// The metatable shared by all values of a Luau built-in type `T`, if one
  /// has been installed. Mirrors `mlua::Lua::type_metatable`.
  pub fn type_metatable<T: TypeMetatable>(&self) -> Option<Table> {
    T::type_metatable(self)
  }

  /// Set a Luau fast-flag (FFlag) by name. Mirrors `mlua::Lua::set_fflag`.
  ///
  /// **DEVIATION:** ulua's FastFlags are a fixed, compile-time `FFlag` enum
  /// rather than a string-keyed registry, so there is no way to look a flag up
  /// by an arbitrary name. This therefore always reports the name as unknown
  /// (`Err`) — which matches mlua's contract for an unrecognized flag (the
  /// only behavior its `test_fflags` asserts). Known flags are configured at
  /// VM-construction time via `ulua_common::records::f_value::set_luau_bool_flags`.
  pub fn set_fflag(name: &str, _enabled: bool) -> Result<()> {
    Err(Error::runtime(format!("fflag '{name}' is not supported")))
  }
}

impl Thread {
  /// Sandbox this coroutine: install a fresh proxy global table on its own
  /// state so global writes inside the coroutine stay local to it. Mirrors
  /// `mlua::Thread::sandbox`.
  pub fn sandbox(&self) -> Result<()> {
    // `co_state` 是 `Thread` 内 `NonNull → &mut` 的带契约收口点;`sandbox_thread`
    // 是带契约的 safe 门面（`lua_l_sandboxthread` 收口点）：Thread 的注册表引用
    // 锚定其线程值，值可达期间协程对象不被 GC；只对该协程自身的
    // `LUA_GLOBALSINDEX` 安装代理表，push/replace 自平衡。
    sandbox_thread(self.co_state());
    Ok(())
  }
}

/// Luau built-in types that have a shared, per-type metatable settable via
/// [`Lua::set_type_metatable`]. Mirrors mlua's sealed `LuauType` trait.
pub trait TypeMetatable: private::Sealed {
  /// Push a representative value of this type onto the stack (so the VM's
  /// `lua_setmetatable`/`lua_getmetatable` operate on the type's global slot).
  ///
  /// safe 门面（非 `unsafe fn`）：`&Lua` 借用静态蕴含「state 存活且由当前线程
  /// 驱动」，实现体所用的各 `lua_push*`/`lua_newthread` 内部自保 1 层栈头寸，
  /// 故本方法无任何未检证前提；各实现只包一次 C-ABI 调用。
  ///
  /// 约定：实现必须且只能压入一个本 Lua 类型的值（默认方法按恰好一层弹回）。
  #[doc(hidden)]
  fn push_representative(lua: &Lua);

  /// Install (or clear) the shared metatable for this type.
  fn set_type_metatable(lua: &Lua, metatable: Option<Table>) {
    let state = lua.state();
    // 栈峰值：代表值 + 元表/nil 两层（`lua_setmetatable` 弹元表、结尾弹代表值）。
    ensure_stack_or_panic(state, 2);
    // `push_representative` 为 safe 门面（见其文档），压恰一个代表值。
    Self::push_representative(lua);
    // 栈上已有一层代表值，剩余头寸覆盖本步再压一层。None 分支
    // `push_nil` safe 门面压恰一层；Some 分支 `mt.push_to_stack` 是 safe
    // 封装（owning VM 一致由 move-not-share 句柄纪律保证，同 `set_globals`）。
    match metatable {
      Some(mt) => mt.push_to_stack(),
      None => push_nil(state),
    }
    // For a non-table/non-userdata value, `lua_setmetatable` stores the
    // metatable in the VM's global per-type slot (`g->mt[type]`).
    // `set_metatable_at` 是带契约的 safe 门面（`(*state).set_metatable` 收口点）：此刻
    // 栈深≥2，`-2` 正指刚压入前的代表值（元表/nil 已被本调用弹走）；返回的写槽判定
    // 对本用途无意义，就地丢弃。
    set_metatable_at(state, -2);
    // Pop the representative value left on the stack.
    // `pop_stack` 弹走栈顶代表值（safe 门面），净栈变化为零。
    pop_stack(state, 1);
  }

  /// The shared metatable for this type, if installed.
  fn type_metatable(lua: &Lua) -> Option<Table> {
    let state = lua.state();
    // 栈峰值：代表值 + `lua_getmetatable` 结果两层。
    ensure_stack_or_panic(state, 2);
    // `push_representative` 为 safe 门面，压恰一个代表值。
    Self::push_representative(lua);
    // `get_metatable_at` 是带契约的 safe 门面（`(*state).get_metatable` 收口点）：栈顶即
    // 刚压入的代表值，`-1` 指它；命中时恰再压一层（元表），返回真。
    let has = get_metatable_at(state, -1);
    if !has {
      // No metatable: pop the representative value（`pop_stack` safe 门面，净栈变化为零）。
      pop_stack(state, 1);
      return None;
    }
    // stack: [value, metatable]
    // `pop_ref`（safe fn）弹走栈顶元表并登记注册表引用（引用可达即元表存活）。
    let mt = Table::from_ref(lua.pop_ref());
    // 栈顶现为代表值，`pop_stack` 弹走它，净栈变化为零。
    pop_stack(state, 1);
    Some(mt)
  }
}

mod private {
  use super::*;

  pub trait Sealed {}
  impl Sealed for Vector {}
  impl Sealed for bool {}
  impl Sealed for f64 {}
  impl Sealed for LuaString {}
  impl Sealed for Function {}
  impl Sealed for Thread {}
  impl Sealed for LightUserData {}
}

impl TypeMetatable for Vector {
  fn push_representative(lua: &Lua) {
    // `push_vector` 是带契约的 safe 门面（`lua_pushvector_...` 收口点）：`&Lua` 保证
    // state 存活且由当前线程驱动；压恰一个 vector 值，四分量常量 0.0（本构建 3-wide，
    // 第四分量按门面约定忽略），不涉及任何借用指针。
    push_vector(lua.state(), 0.0, 0.0, 0.0);
  }
}

impl TypeMetatable for bool {
  fn push_representative(lua: &Lua) {
    // `push_boolean` 是带契约的 safe 门面（`lua_pushboolean` 收口点）：`&Lua` 保证 state
    // 存活；内部自保 1 槽，压恰一个布尔常量值。
    push_boolean(lua.state(), false);
  }
}

impl TypeMetatable for f64 {
  fn push_representative(lua: &Lua) {
    // `push_number` 是带契约的 safe 门面（`lua_pushnumber` 收口点）：`&Lua` 保证 state
    // 存活；内部自保 1 槽，压恰一个数值常量。
    push_number(lua.state(), 0.0)
  }
}

impl TypeMetatable for LuaString {
  fn push_representative(lua: &Lua) {
    // `push_bytes` 是带契约的 safe 门面（`lua_pushlstring_bytes` 收口点）：`&Lua` 保证
    // state 存活；内部自保 1 槽，把空切片拷成内部驻留 TString 后压恰一个字符串值。
    push_bytes(lua.state(), b"");
  }
}

impl TypeMetatable for Function {
  fn push_representative(lua: &Lua) {
    // Push a throwaway C function so `lua_setmetatable` targets the global
    // function-type slot.
    // `push_anonymous_closure` 是带契约的 safe 门面（`lua_pushcclosurek` 的 null-name
    // 特化）：`noop_cfn` 是恒返回 0 的 `extern "C-unwind"` 全函数，与 `LuaCFunction`
    // C-ABI 兼容；`nup=0` 不消费栈，`cont=None` 为合法空续体。
    push_anonymous_closure(lua.state(), Some(noop_cfn), 0);
  }
}

impl TypeMetatable for Thread {
  fn push_representative(lua: &Lua) {
    // A fresh thread targets the global thread-type slot.
    // `spawn_thread` 是带契约的 safe 门面（`lua_newthread` 收口点）：`&Lua` 保证 state
    // 存活；成功时压恰一个线程值（新协程由栈槽可达，直到默认方法按契约弹走），其返回的
    // 协程指针对本用途无意义，就地丢弃；分配失败在 VM 侧以错误路径收敛。
    let _ = spawn_thread(lua.state());
  }
}

impl TypeMetatable for LightUserData {
  fn push_representative(lua: &Lua) {
    // `push_null_lightuserdata` 是带契约的 safe 门面（`lua_pushlightuserdatatagged` 的
    // null 特化）：`&Lua` 保证 state 存活；light userdata 只按值存指针本身（`setpvalue`），
    // VM 从不解引用，null + tag 0 合法且不表达任何所有权，压恰一层。
    push_null_lightuserdata(lua.state());
  }
}

/// A do-nothing C function used as the representative value for the
/// function-type metatable slot. 仅作为 `lua_CFunction` 句柄使用（比较身份，
/// 不实际执行）；即便被调用也只返回 0，不触碰 `state`，无前置条件。
extern "C-unwind" fn noop_cfn(_state: *mut LuaState) -> i32 {
  0
}
