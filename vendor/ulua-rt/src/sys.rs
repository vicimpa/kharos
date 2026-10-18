//! 本层之上（内部管线）。
//!
//! `ulua-rt` 用到的每个裸 `lua_*` 函数/类型/常量都在此集中转出，让 crate
//! 其余部分只有一个可查的来源，同时把（冗长的）import 路径收敛到一个模块。
//! 这里没有任何东西属于公开 API —— 我们确实暴露的少量裸接口在 [`crate::api`]。
//!
//! C ABI 类型退役：VM 已是纯 Rust，栈索引/返回计数/错误码形参一律是 `i32`，
//! 故不再转出 `c_int`（历史上 128 处全是噪声）；`CompileOptions` 的 `c_char`
//! 链亦已 Rust 化（punch #15）。`LuaDebug` 的 `name/what/source/short_src` 字段
//! 现是 Rust 原生类型（owned `Vec<u8>` + `LuaWhat` 枚举），不再经本层借 C 串门面
//! 解码。`c_char`/`c_void` 只在真 C ABI 镜像处保留，豁免台账（review.md §10，
//! 逐项一行）：
//!
//! - `lua_pushcclosurek` 的 debugname（`*const c_char`，C 形收口垫片；VM 压栈时经
//!   intern 复制为 TString 锚，指针仅需调用期有效）：消费者只持 `*_NAME` 静态 NUL
//!   `&[u8]` 模板，在契约参数位一次 `.cast()`。
//!   （`lua_getinfo` 的 `what` 模板已切片化，不再占契约位。）
//! - `c_void`：LightUserData 值、`lua_newuserdatadtor` 析构器与 VM 分配器回调
//!   的 `extern "C-unwind"` ABI 形参（lua.h `void*` 面镜像）。

pub(crate) use core::ffi::c_void;

// ---- garbage collection --------------------------------------------------
pub(crate) use ulua_vm::enums::lua_gc_op::LuaGcOp;
// ---- 状态/类型标签（唯一真相在 ulua-vm 的枚举里，边界处 `as c_int`）------
pub(crate) use ulua_vm::enums::{
  lua_co_status::LuaCoStatus, lua_status::LuaStatus, lua_type::LuaType,
};
// ---- 栈索引 → 槽位地址（受保护 `#t` trampoline 用）-----------------------
pub(crate) use ulua_vm::functions::index_2_addr::index_2_addr;
// ---- interrupts / sandbox / memory categories (Luau) ---------------------
pub(crate) use ulua_vm::functions::lua_callbacks::lua_callbacks;
// ---- refs / call / load --------------------------------------------------
pub(crate) use ulua_vm::functions::lua_checkstack::lua_checkstack;
// ---- state ---------------------------------------------------------------
pub(crate) use ulua_vm::functions::lua_close::lua_close;
// ---- threads / coroutines ------------------------------------------------
pub(crate) use ulua_vm::functions::lua_costatus::lua_costatus;
// ---- tables --------------------------------------------------------------
pub(crate) use ulua_vm::functions::lua_createtable::lua_createtable;
// ---- raw table access + metatables + stack juggling ----------------------
pub(crate) use ulua_vm::functions::lua_equal::lua_equal;
// ---- function environment + debug info -----------------------------------
pub(crate) use ulua_vm::functions::lua_getfenv::lua_getfenv;
// ---- metatable-aware tostring（Rust 原生切片核心）--------------------------
pub(crate) use ulua_vm::functions::lua_l_tolstring::lua_l_tolstring_ref;
// ---- traceback -----------------------------------------------------------
pub(crate) use ulua_vm::functions::lua_l_traceback::lua_l_traceback;
// ---- buffers / vectors (Luau) --------------------------------------------
// r12-w8buf：buffer 族只转出 ref-core 门面（无裸 (ptr,len) C-ABI 形转入）。
// 消费面实测：`lua_newbuffer_push_ref` → `buffer.rs:333`（trampoline 本体）；
// `lua_tobuffer_bytes_ref` → `buffer.rs:209`（`Buffer::bytes` 唯一窗口派生点）。
pub(crate) use ulua_vm::functions::lua_newbuffer::lua_newbuffer_push_ref;
// ---- closures / userdata -------------------------------------------------
pub(crate) use ulua_vm::functions::lua_newuserdatadtor::lua_newuserdatadtor;
// ---- async bridge (Future <-> coroutine) ---------------------------------

// ---- 整数子类型（LUA_TINTEGER）精确压栈 i64（保 tag，不经 f64）------------
// ---- light userdata ------------------------------------------------------
pub(crate) use ulua_vm::functions::lua_pushlightuserdatatagged::lua_pushlightuserdatatagged;
// ---- named registry + integer-keyed raw table access ---------------------
pub(crate) use ulua_vm::functions::lua_rawgeti::lua_rawgeti;
#[cfg(feature = "async")]
pub(crate) use ulua_vm::functions::lua_tointegerx::lua_tointegerx;
// ---- VM `#t` 核心（luaV_objlen，受保护 Table::len 用）--------------------
pub(crate) use ulua_vm::functions::lua_v_dolen::lua_v_dolen_export;
// ---- macro-defined helpers (exposed as plain fns) ------------------------
pub(crate) use ulua_vm::macros::lua_globalsindex::LUA_GLOBALSINDEX;
pub(crate) use ulua_vm::{
  functions::{
    lua_error::lua_error, lua_gc::lua_gc, lua_getinfo::lua_getinfo,
    lua_getreadonly::lua_getreadonly, lua_gettable::lua_gettable, lua_getupvalue::lua_getupvalue,
    lua_isyieldable::lua_isyieldable, lua_l_newstate::lua_l_newstate,
    lua_l_openlibs::lua_l_openlibs, lua_l_sandbox::lua_l_sandbox,
    lua_l_sandboxthread::lua_l_sandboxthread, lua_newthread::lua_newthread,
    lua_pushcclosurek::lua_pushcclosurek, lua_pushlstring::lua_pushlstring_bytes,
    lua_pushthread::lua_pushthread, lua_pushvector_lapi::lua_pushvector_lua_state_f32_f32_f32_f32,
    lua_rawcheckstack::lua_rawcheckstack, lua_rawget::lua_rawget, lua_rawset::lua_rawset,
    lua_ref::lua_ref, lua_resetthread::lua_resetthread, lua_resumeerror::lua_resumeerror,
    lua_setfenv::lua_setfenv, lua_setmemcat::lua_setmemcat, lua_setsafeenv::lua_setsafeenv,
    lua_settable::lua_settable, lua_status::lua_status, lua_tobuffer::lua_tobuffer_bytes_ref,
    lua_tolightuserdata::lua_tolightuserdata_ref, lua_tolstring::lua_tolstring_ref,
    lua_tonumberx::lua_tonumberx, lua_topointer::lua_topointer, lua_tothread::lua_tothread,
    lua_touserdata::lua_touserdata, lua_tovector::lua_tovector, lua_unref::lua_unref,
    lua_xmove::lua_xmove, luau_load::luau_load,
  },
  macros::{lua_registryindex::LUA_REGISTRYINDEX, lua_upvalueindex::lua_upvalueindex},
  records::{
    lua_debug::{LuaDebug, LuaWhat},
    lua_state::LuaState,
  },
  type_aliases::{lua_c_function::LuaCFunction, lua_destructor::LuaDestructor},
};
