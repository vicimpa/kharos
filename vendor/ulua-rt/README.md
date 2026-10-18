# Ulua Rt

Safe, ergonomic, mlua-style API for ulua (pure-Rust Luau).

### Add to your project

```toml
[dependencies]
ulua-rt = "0.1.0"
```

### Features

- `serde` — Rust/Lua value (de)serialization.
- `macros` — `#[derive(UserData)]` and `#[derive(FromLua)]`.
- `async` — async function support.
- `typecheck` — static Luau type checking of host surfaces.
- `send` — makes `Lua` movable across threads.

## Links

- Docs: https://docs.rs/ulua-rt
- Repository: https://github.com/webc-site/ulua
