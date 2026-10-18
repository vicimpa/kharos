# Test Attribution

The integration tests in this directory are **adapted from
[mlua](https://github.com/mlua-rs/mlua)**, which is distributed under the MIT
License.

They have been ported to the `ulua-rt` API (the mlua-style, pure-Rust ergonomic
surface over `ulua`/Luau) as a _behavioral compatibility proof_: where a test
passes unchanged against `ulua-rt`, it demonstrates that `ulua-rt` matches
mlua's observable behavior. Tests that exercise mlua features `ulua-rt` has
intentionally deferred were dropped, and tests that hit a documented `ulua-rt`
deviation were adapted with a `// DEVIATION:` note.

Phase 1 added behavioral coverage for threads/coroutines (`tests/mlua_thread.rs`),
`RegistryKey`, `UserDataFields`, typed `AnyUserData` read-back
(`borrow`/`borrow_mut`/`take`/`is`/`type_id`), the `MetaMethod` enum, and
`Function::info`/`environment`.

Phase 2 added the Luau-specific runtime types: `Buffer` (the `buffer` type) and
`Vector` (the `vector` type), with their `Value::Buffer`/`Value::Vector` variants
and `FromLua`/`IntoLua` impls. Coverage: `tests/mlua_buffer.rs` (ported verbatim
from mlua's `tests/buffer.rs`), the vector tests in `tests/mlua_luau.rs`, and the
re-enabled `Value::Vector`/`Value::Buffer` cases in `tests/mlua_value.rs`.

Phase 3 added `Lua::scope` / `Scope` — lifetime-bounded callbacks and userdata —
together with the structured `Error::CallbackError`/`Error::CallbackDestructed`
variants needed to observe post-scope use. Coverage: `tests/mlua_scope.rs`
(ported from mlua's `tests/scope.rs`). The scope tests that depend on features
ulua-rt has not yet implemented (`create_userdata_ref`/`_mut` +
`borrow_scoped`/`borrow_mut_scoped`, `create_any_userdata*` +
`register_userdata_type`, `call_method`/user-values, the structured
`Error::BadArgument` from userdata-`self` conversion, and `AnyUserData::destroy`)
are deferred with an inline note at the top of that file. The Phase-3 error
change also let `tests/mlua_userdata.rs::test_userdata_take` adopt mlua's exact
`CallbackError { cause: UserDataDestructed }` assertion (previously approximated
as `RuntimeError`).

Phase 4a added the `serde` feature (behind the `serde` cargo feature): the
`LuaSerdeExt` trait on `Lua` (`null`/`array_metatable`/`to_value`/`to_value_with`/
`from_value`/`from_value_with`), a serde `Serializer` that builds Lua `Value`s, a
`Deserializer` that reads them, `SerializeOptions`/`DeserializeOptions`, and
`Serialize for Value`/`Table` with the `Value::to_serializable()`
(`SerializableValue`) wrapper. Coverage: `tests/mlua_serde.rs` (ported from
mlua's `tests/serde.rs`, gated `#![cfg(feature = "serde")]`). Documented
deviations are noted at the top of that file: Luau numbers are `f64`; `lua.null()`
is a dedicated per-`Lua` sentinel **table** (ulua-rt's `Value` has no
`LightUserData` variant); and serializable-userdata (`create_ser_userdata` /
`create_ser_any_userdata` / `wrap_ser`) is a separate not-yet-implemented
feature, so the userdata-only tests and the userdata portions of `test_serialize`
/ `test_serialize_failure` are dropped (with notes), as are the `serde_value`
buffer tests.

Phase 4b added the `macros` feature (behind the `macros` cargo feature): the
`#[derive(UserData)]` and `#[derive(FromLua)]` procedural derives, provided by
the new `ulua-rt-derive` crate and re-exported from `ulua-rt` so users write
`#[derive(ulua_rt::UserData)]` / `#[derive(ulua_rt::FromLua)]`. The derive
mirrors mlua's `#[derive(UserData)]` **field** surface — `add_field_method_get`
/ `_set` per named struct field, with the `#[lua(skip|get|set|name = "...")]`
field attributes — and mlua's `from_lua` derive. Coverage:
`tests/mlua_userdata_macro.rs` (ported from mlua's `tests/userdata_macro.rs`,
gated `#![cfg(feature = "macros")]`). mlua's method/meta side of that test
comes from its `#[userdata_impl]` attribute macro + an `inventory`-based
`UserDataRegistry` + `Lua::create_proxy`, none of which ulua-rt has, so only
the field-deriving + `FromLua` parts are ported (with an inline note).

Phase 4c added the `async` feature (behind the `async` cargo feature): the
Rust-`Future` ⟷ Lua-coroutine bridge. `Lua::create_async_function` exposes a
Rust async fn as a Lua closure that runs on a coroutine and **yields** while its
boxed future is pending; a Rust driver (`AsyncThread`, implementing `Future` +
`futures_util::Stream`) resumes the coroutine, polls the future with the
executor's `Waker`, and resumes with the result when ready. Surface:
`Lua::create_async_function` / `Lua::yield_with`, `Function::{call_async,
wrap_async, wrap_raw_async}`, `Chunk::{call_async, exec_async, eval_async}`,
`Thread::into_async` + `AsyncThread`. Executor-agnostic (the caller drives the
futures; the tests use tokio). The default build, public API, and `Error` enum
are byte-for-byte unchanged (everything is `#[cfg(feature = "async")]`).
Coverage: `tests/mlua_async.rs` (ported from mlua's `tests/async.rs`, gated
`#![cfg(feature = "async")]`). Deferred tests are noted inline at the top of that
file: `test_async_userdata` (needs `UserDataMethods::add_async_method*` /
`add_async_function` / `add_async_meta_method`), `test_async_table_object_like`
and `test_async_thread_pool` (need the `ObjectLike` trait `call_async_method` and
`LuaOptions::thread_pool_size`), and the userdata-ref half of
`test_async_terminate` (needs `create_any_userdata` + `UserDataRef`). The
Luau-gated-out mlua tests (`test_async_lua54_to_be_closed`, `test_async_hook`)
are skipped as not applicable. Documented DEVIATIONs (inline): an error raised
inside an async coroutine surfaces as `RuntimeError` (so `test_async_thread_error`
raises a plain string instead of a `__tostring` userdata), and the strong-count
GC assertion in `test_async_thread` is omitted (the captured future lives in a
collectible Lua userdata).

Phase 4d added the `send` feature (behind the `send` cargo feature): under it
`Lua` and all of its handles (`Table`/`Function`/`String`/`AnyUserData`/`Thread`/
`Buffer`/`Value`/`RegistryKey`/`MultiValue`/`Error`) become `Send`, so the whole
VM can be **moved** to another thread (the user guarantees serialized access).
Implementation (mirroring mlua, `src/sync.rs`): `XRc<T>` = `Arc<T>` under the
feature (`Rc<T>` otherwise) for the shared `LuaInner` / `LuaRef`; a `MaybeSend`
(and `MaybeSync`) marker trait applied to the `create_function` closure, every
userdata method/field/function closure, and the userdata payload `T`, so the
stored callback boxes and their captured environment are `Send`; and documented
`unsafe impl Send` over the raw `*mut lua_State` (in `LuaInner` and `Thread`),
with `LuaInner`/`LuaRef` also `unsafe impl Sync` purely so `Arc<…>` is `Send`.
DEVIATION from mlua: ulua-rt is `Send` but deliberately **`!Sync`** (mlua's
`Lua` is `Send + Sync` via its `Arc<ReentrantMutex<RawLua>>` interior); each
public handle carries a zero-sized `NotSync` marker to re-impose `!Sync`. The
default build is byte-for-byte unchanged (`XRc` = `Rc`, the markers are empty /
unit types). DEVIATION: `send` and `async` are mutually exclusive for now (a
`compile_error!` fires if both are enabled) — the async bridge's thread-local
wakers + non-`Send` futures are not yet made `Send`; deferred. Coverage:
`tests/mlua_send.rs` (gated `#![cfg(feature = "send")]`). mlua's single
`tests/send.rs` test (`test_userdata_multithread_access_sync`) cannot be ported
verbatim: it shares one `&Lua` across a `std::thread::scope` and calls
`ObjectLike::call_method` on a second thread, requiring `Lua: Sync` + the
`ObjectLike` trait, neither of which ulua-rt provides. It is reproduced in
spirit as a single-threaded nested-method test plus compile-time `Send`
assertions, a `!Sync` probe, and a real _move-the-VM-across-threads_ test.

Phase 5a (the completeness pass) added the Luau-specific runtime surface:

- **`Compiler`** builder (`set_optimization_level` / `set_debug_level` /
  `set_coverage_level` / `set_type_info_level` /
  `set_vector_ctor` / `set_vector_type`) over
  `ulua_compiler::CompileOptions`, plus `Lua::set_compiler` and
  `Chunk::set_compiler` / `Chunk::call`.
- **Sandboxing**: `Lua::sandbox(bool)` (over `luaL_sandbox` + `luaL_sandboxthread`,
  restoring the original globals on exit), `Lua::set_safeenv(bool)`, and
  `Thread::sandbox()`. `Thread::reset` now re-inherits the main globals (so a
  reset sandboxed thread sees the main env, matching mlua's Luau `reset`).
- **Interrupts**: `Lua::set_interrupt` / `Lua::remove_interrupt` + `VmState`
  (over `lua_callbacks().interrupt` with a fixed trampoline + per-VM closure
  store). Yielding from an interrupt (`lua_break`) is honored at yieldable points
  and silently ignored at C-call boundaries (matching upstream); errors raised in
  an interrupt propagate as `RuntimeError`. The `Thread` resume/`status` paths
  learned the `LUA_BREAK` state (resumable, no values moved off the live frame).
- **Memory**: `Lua::used_memory`, `Lua::set_memory_limit` (a limit-enforcing
  allocator installed over the VM's `frealloc`/`ud`), the GC control ops
  (`gc_collect` / `gc_stop` / `gc_restart` / `gc_is_running` / `gc_count` /
  `gc_step` / `gc_inc` / `gc_set_mode`), the `state::{GcMode, GcIncParams,
GcGenParams}` types, and `Lua::set_memory_category` (over `lua_setmemcat`). The
  `Error::MemoryError` variant is now produced on OOM (status `LUA_ERRMEM` / the
  "not enough memory" message).
- **Debug**: `Lua::inspect_stack` -> `Debug` / `DebugWhat` (over `lua_getinfo`).
- **Type metatables**: `Lua::set_type_metatable::<Vector>` (over the global
  per-type metatable slot) + the sealed `TypeMetatable` trait.
- **`Lua::set_fflag`** (reports unknown — ulua's FFlags are a compile-time enum,
  not a string-keyed registry; see the inline note in `tests/mlua_luau.rs`).

Coverage: the extended `tests/mlua_luau.rs` (vectors-fastcall, vector_metatable,
sandbox, sandbox_safeenv, sandbox_threads, interrupts, fflags, memory_category,
integer round-trip, chunk_call) plus the new `tests/mlua_memory.rs`,
`tests/mlua_hooks.rs`, `tests/mlua_debug.rs`, and `tests/mlua_byte_string.rs`.

Genuinely DEFERRED in Phase 5a, each because Luau-as-ulua lacks the capability
(noted inline at the matching test):

- **`collectgarbage`/`loadstring` sandbox + loadstring tests** — ulua's base
  library does not register `collectgarbage` or `loadstring` (upstream Luau adds
  them only in the CLI/REPL, not `luaL_openlibs`). The sandbox read-only /
  safeenv / thread parts ARE ported.
- **`heap_dump`** — ulua's VM tracks only bytes-per-category
  (`global_State::memcatbytes[256]`); it has no public API to enumerate live
  objects by Lua type or by Rust userdata-type within a category, which
  `HeapDump::size_by_type` / `size_by_userdata` require. (Per-category bytes ARE
  exposed via the `Lua::memory_category_bytes` extension.)
- **`integer64`'s native `42i` literal + `integer` library** — ulua registers
  the i64 lib as `int64` (not `integer`) and does not surface the native i64 VM
  type through `Value` (numbers are `f64`-backed). The plain i64 round-trip IS
  covered.
- **`typeof(error)` == "error"** — ulua-rt carries `Value::Error` as its message
  _string_ (no tagged error userdata), so `typeof` reports "string". The actual
  (deviating) behavior is pinned in `test_typeof_error_deferred`.
- **The Lua 5.x hook API** (`set_hook` / `HookTriggers` / `DebugEvent`) — does
  not exist in Luau; mlua's whole `tests/hooks.rs` and `tests/debug.rs` are
  themselves `#![cfg(not(feature = "luau"))]`. The Luau-native interrupt analog is
  ported instead.
- **`bstr` `BString` / `&BStr` conversions** — ulua-rt has no `bstr` feature; the
  byte-string round-trip is ported through native `LuaString` raw bytes.

Still deferred (later phases): the proc-macro `chunk!`, and the
`#[userdata_impl]` attribute macro / userdata registry / `create_proxy`
(including its `add_async_method*` surface). From `Scope`: the userdata-ref
borrowing variants and `create_any_userdata*`. From `serde`: serializable
userdata (`create_ser_userdata*` / `wrap_ser` / `Serialize for AnyUserData`).

## Adapted files

| ulua-rt test file              | adapted from mlua                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `tests/mlua_function.rs`       | `tests/function.rs`                                                                     |
| `tests/mlua_table.rs`          | `tests/table.rs`                                                                        |
| `tests/mlua_value.rs`          | `tests/value.rs`                                                                        |
| `tests/mlua_conversion.rs`     | `tests/conversion.rs`                                                                   |
| `tests/mlua_userdata.rs`       | `tests/userdata.rs`                                                                     |
| `tests/mlua_thread.rs`         | `tests/thread.rs`                                                                       |
| `tests/mlua_string.rs`         | `tests/string.rs`                                                                       |
| `tests/mlua_error.rs`          | `tests/error.rs`                                                                        |
| `tests/mlua_multi.rs`          | `tests/multi.rs`                                                                        |
| `tests/mlua_chunk.rs`          | `tests/chunk.rs`                                                                        |
| `tests/mlua_luau.rs`           | `tests/luau.rs` (Luau-relevant subset)                                                  |
| `tests/mlua_memory.rs`         | `tests/memory.rs` (Luau-active subset)                                                  |
| `tests/mlua_hooks.rs`          | `tests/hooks.rs` (Luau-native interrupt analog; the 5.x hook API is N/A under Luau)     |
| `tests/mlua_debug.rs`          | `tests/debug.rs` (`inspect_stack` analog; the `{:#?}` format test is deferred)          |
| `tests/mlua_byte_string.rs`    | `tests/byte_string.rs` (native `LuaString` raw bytes; `bstr` conversions deferred)      |
| `tests/mlua_buffer.rs`         | `tests/buffer.rs`                                                                       |
| `tests/mlua_scope.rs`          | `tests/scope.rs` (portable subset)                                                      |
| `tests/mlua_serde.rs`          | `tests/serde.rs` (non-userdata subset, gated `feature = "serde"`)                       |
| `tests/mlua_userdata_macro.rs` | `tests/userdata_macro.rs` (derive field + `FromLua` subset, gated `feature = "macros"`) |
| `tests/mlua_async.rs`          | `tests/async.rs` (portable subset, gated `feature = "async"`)                           |
| `tests/mlua_send.rs`           | `tests/send.rs` (spirit-port + `Send`/`!Sync` assertions, gated `feature = "send"`)     |
| `tests/mlua_core.rs`           | `tests/tests.rs` (the big core integration file)                                        |
| `tests/mlua_types.rs`          | `tests/types.rs` (light-userdata + per-type metatables)                                 |
| `tests/mlua_compile.rs`        | `tests/compile.rs` (trybuild UI test; deferred — see below)                             |

## Phase 5b — the `tests.rs` / `types.rs` / `compile.rs` port

Phase 5b ported mlua's three remaining top-level test files that had no ulua-rt
counterpart. To keep the "% of mlua tests passing **unmodified**" figure honest,
each test was copied verbatim (import-swap only); where a test exercised a
ulua-rt API that did not yet exist, that API was **implemented** (original code
over ulua's C API) rather than the test being skipped. New ulua-rt API added in
this pass: `WeakLua` / `Lua::weak`; `StdLib` / `LuaOptions` / `Lua::new_with` /
`Lua::unsafe_new`; the named-registry API (`set_named_registry_value` /
`named_registry_value` / `unset_named_registry_value`) and
`expire_registry_values`; the typed, borrow-checked application-data API
(`set_app_data` / `try_set_app_data` / `app_data_ref` / `app_data_mut` /
`try_app_data_ref` / `try_app_data_mut` / `remove_app_data`, with `AppDataRef` /
`AppDataRefMut`); module registration (`register_module` / `unload_module` plus a
minimal alias-resolving `require`); `Lua::traceback`; `Lua::set_globals`;
`Lua::coerce_integer` / `coerce_number` / `unpack`;
`Lua::create_function_mut`; `Lua::exec_raw` / `create_c_function`; the public
`ulua_rt::api` raw-API surface and `ulua_rt::lua_State`; `Function::wrap` (with
the `LuaNativeFn` trait); the `LightUserData` value type and `Value::LightUserData`
variant; the extended per-type metatable surface (`set_type_metatable` /
`type_metatable` for `bool` / `Number` / `LuaString` / `Function` / `Thread` /
`LightUserData`, alongside the existing `Vector`); `i128` / `u128` conversions;
a `T: UserData` → `IntoLua` blanket; the `Nil` re-export; and the
`Error::RecursiveMutCallback` / `Error::PreviouslyResumedPanic` variants.

Two genuine ulua-rt soundness/robustness fixes were found by these verbatim
tests and are pinned as regression coverage: (1) a Rust callback returning a very
large result list overflowed the Lua stack and tripped a fatal VM assertion
(SIGTRAP) — the callback trampoline now reserves stack space first and raises a
catchable error instead (`test_too_many_returns`); (2) float→integer conversion
saturated through `i64`, so a value beyond `i64` range (e.g. `2^64` for `u64`)
was silently accepted — it is now range-checked in `i128` space and correctly
rejected (`test_num_conversion`). Integer `FromLua` was also aligned to Luau's
f64-backed `tointeger`, which **truncates** a fractional float rather than
rejecting it.

Per-file disposition (ported = verbatim, import-swap only; deferred = kept as a
`*_deferred` pin asserting the actual ulua behavior with a `// DEVIATION` note;
omitted = a test mlua itself gates off the `luau` feature, or that is otherwise
inapplicable to a Luau backend):

- `tests/mlua_core.rs` (from `tests/tests.rs`): **36 ported**, **6 deferred**,
  **7 omitted**.
  - Deferred: `test_load_mode` (ulua auto-loads text; no binary `ChunkMode`),
    `test_panic` (ulua catches a callback panic into a catchable Lua error
    rather than re-propagating it), `test_c_function` (ulua's `lua_CFunction`
    is a pure-Rust `unsafe fn`, not `extern "C-unwind"`), `test_inspect_stack`
    (ulua's `inspect_stack(level) -> Option<Debug>` is non-closure with a
    smaller `Debug`), `test_traceback` (ulua's `luaL_traceback` emits a
    different text format — no "stack traceback:" header), and
    `test_registry_value_reuse` (ulua transiently consumes a registry slot to
    build the stored value, shifting the exact slot-reuse pattern). Under the
    `send` feature, `test_multi_thread` is likewise deferred because it requires
    `Lua: Sync`, which ulua-rt deliberately lacks (move-only, not shared); the
    move-the-VM equivalent is pinned instead.
  - Omitted (mlua gates these off the `luau` feature, or they are LuaJIT/Lua-5.x
    only): `test_safety`, `test_preload_module`, `test_get_or_init_from_ptr`
    (all `#[cfg(not(feature = "luau"))]` in mlua); `test_context_thread_51`
    (Lua 5.1 / LuaJIT only); `test_jit_version`, `test_luajit_cdata` (LuaJIT
    only); `test_warnings` (Lua 5.4/5.5 `warn` only — Luau has no `warn`).
  - One verbatim test keeps a single `// DEVIATION`-noted line:
    `test_num_conversion` pins ulua's `-0.0 -> +0.0` normalization;
    `test_drop_registry_value` swaps the unregistered `collectgarbage("collect")`
    Lua call for the `Lua::gc_collect` analog (same gap as `collectgarbage` /
    `loadstring` noted in `tests/mlua_luau.rs`).
- `tests/mlua_types.rs` (from `tests/types.rs`): **7 ported, 0 deferred,
  0 omitted** — all light-userdata and per-type-metatable tests pass verbatim.
- `tests/mlua_compile.rs` (from `tests/compile.rs`): **0 ported, 1 deferred,
  0 omitted** — mlua's single `test_compilation` is an `#[ignore]`d `trybuild`
  UI test bound to mlua-internal `tests/compile/*.rs` fixtures and committed
  `.stderr` snapshots; it is kept `#[ignore]`d with a header explaining that the
  compile-time guarantees are instead asserted by the `send`/`scope` behavioral
  tests.

## mlua MIT License

```
MIT License

Copyright (c) 2019-2021 A. Orlenko
Copyright (c) 2017 rlua

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
