// Adapted from mlua (https://github.com/mlua-rs/mlua), MIT License,
// © 2019 Aleksandr Orlenko / mlua authors. See tests/ATTRIBUTION.md.
//
// Ported from mlua `tests/compile.rs`.
//
// mlua's single `test_compilation` is a `trybuild` UI test (`#[ignore]`d, so it
// does not run in the normal suite) that asserts a fixed set of `tests/compile/
// *.rs` fixtures fail to compile with mlua's exact `.stderr` snapshots — e.g.
// that a non-`'static` `Function` borrow is rejected, that `Lua` is
// `!RefUnwindSafe`, that a `send`-gated type is `!Send` without the feature, and
// that the `userdata`/`chunk` proc-macros reject malformed inputs.
//
// DEFERRED: those guarantees are real, but the *test* is inseparable from
// mlua's own compile fixtures and their committed `.stderr` snapshots, which are
// mlua-internal and message-for-message specific to mlua's type signatures.
// Reproducing it for ulua-rt means authoring a parallel `tests/compile/`
// fixture tree plus snapshots against ulua-rt's (different) error messages — a
// separate effort from the behavioral port this file belongs to. The underlying
// compile-time properties ulua-rt *does* uphold are exercised at the type level
// elsewhere: `tests/mlua_send.rs` proves the `send` handles are `Send`, and the
// default build proves the non-`send` handles are `!Send`; `tests/mlua_scope.rs`
// proves scope-bound callbacks/userdata are invalidated on scope exit.
//
// We keep the test (matching mlua, it is `#[ignore]`d so the suite stays green)
// to document the gap honestly rather than silently dropping the file.
#[test]
#[ignore = "trybuild UI fixtures are mlua-internal; see the file header for the ulua-rt rationale"]
fn test_compilation() {
  // No-op: the trybuild fixture tree and its `.stderr` snapshots are not
  // ported (see header). The compile-time properties are asserted by the
  // `send`/`scope` behavioral tests instead.
}
