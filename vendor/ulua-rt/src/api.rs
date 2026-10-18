//! A deliberately minimal slice of the raw, `unsafe` ulua `lua_*` surface
//! (`ulua_rt::api`). This is **not** a mirror of, or stand-in for, any C FFI
//! layer and makes no such claim — it exposes only the two items that belong in
//! ulua's public low-level interface: the error entry point
//! [`lua_error`](crate::api::lua_error) and the VM's native-callback pointer
//! type [`LuaCFunction`](crate::api::LuaCFunction). They let callers drop to the
//! stack-machine level inside [`Lua::exec_raw`](crate::Lua::exec_raw) or pass a
//! raw callback to [`Lua::create_c_function`](crate::Lua::create_c_function).
//!
//! Everything here is `unsafe` to use and offers no safety guarantees beyond the
//! underlying VM — it is the same low-level interface the safe wrappers sit on
//! top of. The complete raw `lua_*` API lives in the `ulua-vm` crate (ulua-rt's
//! own wrappers draw on it via the crate-private `crate::sys`, not this module).
//! ulua is a pure-Rust VM, so these are ordinary Rust `pub unsafe fn`s
//! re-exported from `ulua-vm`, not declarations behind a C ABI boundary; the one
//! C-ABI-shaped item is [`LuaCFunction`](crate::api::LuaCFunction)
//! (`unsafe extern "C-unwind" fn`), kept for the calling convention it encodes.

pub use ulua_vm::{functions::lua_error::lua_error, type_aliases::lua_c_function::LuaCFunction};
