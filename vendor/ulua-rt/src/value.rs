//! The [`Value`] enum and the stack <-> `Value` bridges.
//!
//! Mirrors `mlua::Value`. Luau has **two** number tags, and unlike Lua 5.x
//! without the integer subtype it really does keep them distinct at the VM
//! level:
//!
//! - `LUA_TNUMBER` — an `f64`.
//! - `LUA_TINTEGER` — the integer subtype, an exact `i64` held in the `TValue`
//!   (produced by `Integer.*`, `buffer.readlong`, int64 bytecode constants,
//!   `userdata::setinteger`, ...). Integer and number keys even hash into
//!   different table slots, so the distinction is observable.
//!
//! [`value_from_stack`] therefore reads the two separately: an
//! `LUA_TINTEGER` slot goes through `lua_l_checkinteger_64` to recover the
//! exact `i64` (`lua_tonumberx` deliberately does *not* accept that tag and
//! would report `0`, and `lua_tointegerx` truncates to `i32`), while a
//! `LUA_TNUMBER` slot is split into [`Value::Integer`] vs [`Value::Number`] by
//! testing whether the `f64` is an exact, in-range integer — matching mlua's
//! observable behavior for the high-level API.

use core::{ffi::c_void, ptr::null, slice::from_raw_parts};

use ulua_vm::functions::luai_num_2_str::lua_number_to_string;

use crate::{
  buffer::Buffer,
  error::{Error, Result},
  function::Function,
  light_userdata::LightUserData,
  registry::RegHandle,
  state::{
    Lua, LuaRef, StateView, boolean_at, check_int64_at, clone_slot_to_top, lightuserdata_at,
    push_boolean, push_bytes, push_int64, push_lightuserdata_tagged, push_nil, push_number,
    push_vector, type_at,
  },
  string::LuaString,
  sys::*,
  table::{Table, number_at},
  thread::Thread,
  userdata::AnyUserData,
  vector::Vector,
};

/// The integer type exposed by the API. Mirrors `mlua::Integer` (`i64`).
pub type Integer = i64;
/// The float type exposed by the API. Mirrors `mlua::Number` (`f64`).
pub type Number = f64;

/// A dynamically typed Lua value.
///
/// Mirrors `mlua::Value`. Reference-typed variants ([`Value::String`],
/// [`Value::Table`], [`Value::Function`]) carry handles that keep both the
/// value and the VM alive.
#[derive(Clone, Debug)]
pub enum Value {
  /// `nil`.
  Nil,
  /// A boolean.
  Boolean(bool),
  /// An integer (either a `LUA_TINTEGER` slot's exact `i64`, or an `f64` that
  /// is an exact, in-range whole number). Pushing is loss-free either way:
  /// f64-exact values go through `lua_pushnumber`, the rest keep the
  /// `LUA_TINTEGER` tag via `lua_pushinteger_64` (see `push_value`).
  Integer(Integer),
  /// A floating-point number.
  Number(Number),
  /// A string.
  String(LuaString),
  /// A table.
  Table(Table),
  /// A function (Lua or Rust).
  Function(Function),
  /// A raw-pointer light userdata. Mirrors `mlua::Value::LightUserData`.
  LightUserData(LightUserData),
  /// A userdata value with typed Rust-side borrowing.
  UserData(AnyUserData),
  /// A thread (coroutine).
  Thread(Thread),
  /// A Luau vector (3 `f32` components). Mirrors `mlua::Value::Vector`.
  Vector(Vector),
  /// A Luau buffer (mutable, fixed-size byte array). Mirrors
  /// `mlua::Value::Buffer`.
  Buffer(Buffer),
  /// A boxed Lua/Rust error carried as a first-class value (mirrors
  /// `mlua::Value::Error`). Produced when a Rust error is returned to Lua.
  Error(Box<Error>),
}

impl Value {
  /// `Value::Nil`. Mirrors `mlua::Nil`.
  /// 镜像 `mlua::Value::NIL` 的 API parity 常量（当前仓内零消费，保留为
  /// 公开面对齐，勿按孤儿清理）
  pub const NIL: Value = Value::Nil;

  /// The Lua type name of this value (e.g. `"nil"`, `"number"`, `"table"`).
  pub fn type_name(&self) -> &'static str {
    match self {
      Value::Nil => "nil",
      Value::Boolean(_) => "boolean",
      Value::Integer(_) | Value::Number(_) => "number",
      Value::String(_) => "string",
      Value::Table(_) => "table",
      Value::Function(_) => "function",
      Value::LightUserData(_) | Value::UserData(_) => "userdata",
      Value::Thread(_) => "thread",
      Value::Vector(_) => "vector",
      Value::Buffer(_) => "buffer",
      Value::Error(_) => "error",
    }
  }

  /// Whether this is an error value.
  pub fn is_error(&self) -> bool {
    matches!(self, Value::Error(_))
  }

  /// View as a reference to the contained error, if any.
  pub fn as_error(&self) -> Option<&Error> {
    match self {
      Value::Error(e) => Some(e),
      _ => None,
    }
  }

  /// Whether this is `nil`.
  pub fn is_nil(&self) -> bool {
    matches!(self, Value::Nil)
  }
  /// Whether this is a boolean.
  pub fn is_boolean(&self) -> bool {
    matches!(self, Value::Boolean(_))
  }
  /// Whether this is a number of either subtype.
  pub fn is_number(&self) -> bool {
    matches!(self, Value::Number(_) | Value::Integer(_))
  }
  /// Whether this is the integer subtype.
  pub fn is_integer(&self) -> bool {
    matches!(self, Value::Integer(_))
  }
  /// Whether this is a string.
  pub fn is_string(&self) -> bool {
    matches!(self, Value::String(_))
  }
  /// Whether this is a table.
  pub fn is_table(&self) -> bool {
    matches!(self, Value::Table(_))
  }
  /// Whether this is a function.
  pub fn is_function(&self) -> bool {
    matches!(self, Value::Function(_))
  }

  /// Lua truthiness: everything except `nil` and `false` is truthy.
  pub fn as_boolean(&self) -> Option<bool> {
    match self {
      Value::Boolean(b) => Some(*b),
      _ => None,
    }
  }
  /// View as an integer if it is one.
  pub fn as_integer(&self) -> Option<Integer> {
    match self {
      Value::Integer(i) => Some(*i),
      _ => None,
    }
  }
  /// View as an `f64` if it is a number of either subtype.
  pub fn as_number(&self) -> Option<Number> {
    match self {
      Value::Number(n) => Some(*n),
      Value::Integer(i) => Some(*i as f64),
      _ => None,
    }
  }
  /// View as a string handle.
  pub fn as_string(&self) -> Option<&LuaString> {
    match self {
      Value::String(s) => Some(s),
      _ => None,
    }
  }
  /// View as a table handle.
  pub fn as_table(&self) -> Option<&Table> {
    match self {
      Value::Table(t) => Some(t),
      _ => None,
    }
  }
  /// View as a function handle.
  pub fn as_function(&self) -> Option<&Function> {
    match self {
      Value::Function(f) => Some(f),
      _ => None,
    }
  }

  /// View as a userdata handle.
  pub fn as_userdata(&self) -> Option<&AnyUserData> {
    match self {
      Value::UserData(u) => Some(u),
      _ => None,
    }
  }

  /// Whether this is a thread (coroutine) value.
  pub fn is_thread(&self) -> bool {
    matches!(self, Value::Thread(_))
  }

  /// View as a thread handle.
  pub fn as_thread(&self) -> Option<&Thread> {
    match self {
      Value::Thread(t) => Some(t),
      _ => None,
    }
  }

  /// Whether this is a Luau vector value. Mirrors `mlua::Value::is_vector`.
  pub fn is_vector(&self) -> bool {
    matches!(self, Value::Vector(_))
  }

  /// View as a vector. Mirrors `mlua::Value::as_vector`.
  pub fn as_vector(&self) -> Option<&Vector> {
    match self {
      Value::Vector(v) => Some(v),
      _ => None,
    }
  }

  /// Whether this is a Luau buffer value. Mirrors `mlua::Value::is_buffer`.
  pub fn is_buffer(&self) -> bool {
    matches!(self, Value::Buffer(_))
  }

  /// View as a buffer handle. Mirrors `mlua::Value::as_buffer`.
  pub fn as_buffer(&self) -> Option<&Buffer> {
    match self {
      Value::Buffer(b) => Some(b),
      _ => None,
    }
  }

  /// 整数系访问器的共用体：读出 [`Value::Integer`] 后用 `TryFrom` 值域收窄，
  /// 超域返回 `None`。单态化零成本，各窄类型访问器只差目标类型。
  fn try_as_int<T: TryFrom<Integer>>(&self) -> Option<T> {
    self.as_integer().and_then(|i| T::try_from(i).ok())
  }
  /// View as an `i32` if it is an in-range integer.
  pub fn as_i32(&self) -> Option<i32> {
    self.try_as_int()
  }
  /// View as a `u32` if it is an in-range integer.
  pub fn as_u32(&self) -> Option<u32> {
    self.try_as_int()
  }
  /// View as an `i64` if it is an integer.
  pub fn as_i64(&self) -> Option<i64> {
    self.as_integer()
  }
  /// View as a `u64` if it is an in-range integer.
  pub fn as_u64(&self) -> Option<u64> {
    self.try_as_int()
  }
  /// View as an `isize` if it is an in-range integer.
  pub fn as_isize(&self) -> Option<isize> {
    self.try_as_int()
  }
  /// View as a `usize` if it is an in-range integer.
  pub fn as_usize(&self) -> Option<usize> {
    self.try_as_int()
  }
  /// View as an `f32`.
  pub fn as_f32(&self) -> Option<f32> {
    self.as_number().map(|n| n as f32)
  }
  /// View as an `f64`.
  pub fn as_f64(&self) -> Option<f64> {
    self.as_number()
  }

  /// A raw pointer identifying reference-typed values (tables, functions,
  /// strings, userdata). Returns null for value-typed (nil/bool/number)
  /// values. Mirrors `mlua::Value::to_pointer`.
  pub fn to_pointer(&self) -> *const c_void {
    match self {
      Value::LightUserData(lud) => lud.0.cast_const(),
      Value::String(s) => s.to_pointer(),
      Value::Table(t) => t.to_pointer(),
      Value::Function(f) => f.to_pointer(),
      Value::UserData(u) => u.to_pointer(),
      Value::Thread(t) => t.to_pointer(),
      // Buffers are GC objects (reference-typed); vectors are inline
      // value types (no pointer identity), matching mlua.
      Value::Buffer(b) => b.to_pointer(),
      _ => null(),
    }
  }

  /// Compare two values for equality honoring `__eq` metamethods.
  /// Mirrors `mlua::Value::equals`.
  pub fn equals(&self, other: &Value) -> Result<bool> {
    // For reference types, route through the VM's `lua_equal` (which runs
    // `__eq`). For value types, structural equality matches Lua semantics.
    match (self, other) {
      (Value::Table(a), Value::Table(b)) => a.equals(b),
      (Value::UserData(a), Value::UserData(b)) => a.equals(b),
      _ => Ok(self == other),
    }
  }

  /// The metatable-aware string form of this value (honors `__tostring`).
  /// Mirrors `mlua::Value::to_string`.
  pub fn to_string(&self) -> Result<String> {
    match self {
      Value::Nil => Ok("nil".to_string()),
      Value::Boolean(b) => Ok(b.to_string()),
      Value::Integer(i) => Ok(i.to_string()),
      Value::Number(n) => Ok(lua_number_to_string(*n)),
      Value::Error(e) => Ok(e.to_string()),
      // Vector is an inline value type: format it directly (mlua does the
      // same, via `Vector`'s `Display`).
      Value::Vector(v) => Ok(v.to_string()),
      // Light userdata: format the pointer, matching Lua's `tostring`
      // (`userdata: 0x...`).
      Value::LightUserData(lud) => Ok(format!("userdata: {:p}", lud.0)),
      Value::String(s) => s.to_str(),
      // Reference types: find the owning Lua via the handle and use
      // luaL_tolstring (honors `__tostring`).
      Value::Table(t) => t.lua().value_to_string(self),
      Value::Function(f) => f.lua().value_to_string(self),
      Value::UserData(u) => u.lua().value_to_string(self),
      Value::Thread(t) => t.lua().value_to_string(self),
      Value::Buffer(b) => b.lua().value_to_string(self),
    }
  }
}

impl PartialEq for Value {
  fn eq(&self, other: &Self) -> bool {
    match (self, other) {
      (Value::Nil, Value::Nil) => true,
      (Value::Boolean(a), Value::Boolean(b)) => a == b,
      (Value::LightUserData(a), Value::LightUserData(b)) => a == b,
      // Numbers compare by value across the integer/float subtypes,
      // matching Lua's `==` (1 == 1.0).
      (Value::Integer(a), Value::Integer(b)) => a == b,
      (Value::Number(a), Value::Number(b)) => a == b,
      (Value::Integer(a), Value::Number(b)) | (Value::Number(b), Value::Integer(a)) => {
        // 精确跨型比较（Lua 5.3+ 语义）：仅当浮点可无损表为 i64 时按整值
        // 比较——经 `as f64` 回绕比较会把 i64::MAX == 2^63 误判相等（与 VM
        // 槽 tag 严格比较相悖）。NaN/非整值/超域一律不等
        b.fract() == 0.0 && *b >= i64::MIN as f64 && *b < i64::MAX as f64 && *a == *b as i64
      }
      (Value::String(a), Value::String(b)) => a == b,
      // Reference types: identity (NOT `__eq`); use `equals` for `__eq`.
      (Value::Table(a), Value::Table(b)) => a.to_pointer() == b.to_pointer(),
      (Value::Function(a), Value::Function(b)) => a.to_pointer() == b.to_pointer(),
      (Value::UserData(a), Value::UserData(b)) => a.to_pointer() == b.to_pointer(),
      (Value::Thread(a), Value::Thread(b)) => a.to_pointer() == b.to_pointer(),
      // Vectors compare component-wise (value type); buffers by object
      // identity (reference type), matching mlua/Luau `==`.
      (Value::Vector(a), Value::Vector(b)) => a == b,
      (Value::Buffer(a), Value::Buffer(b)) => a.to_pointer() == b.to_pointer(),
      (Value::Error(a), Value::Error(b)) => a.to_string() == b.to_string(), // DELIBERATE DEVIATION：Error 无 PartialEq，按 Display 串判等（粗于 mlua 结构化比较，已裁定）
      _ => false,
    }
  }
}

/// i64 的 f64 上界：`i64::MAX as f64` 会向上取整到 2^63（超出 i64 可表示范围），
/// 因此严格用 `<`，避免 `2^63` 误判为可精确表示的整数。
const I64_MAX_EXACT: f64 = i64::MAX as f64;

/// True if the `f64` is an exact integer within `i64` range (so it can be
/// presented as [`Value::Integer`]).
pub(crate) fn is_exact_integer(n: f64) -> bool {
  n.fract() == 0.0 && n.is_finite() && n >= i64::MIN as f64 && n < I64_MAX_EXACT
}

/// True if `i` round-trips exactly through `f64` (i.e. the `f64` nearest to
/// `i` casts back to the same `i64`).
///
/// 饱和转换唯一的假阳性是 `i64::MAX`：它上浮为 `2^63`，回读饱和后又等于
/// `i64::MAX`，故显式排除（`i64::MIN` 即 `-2^63` 可精确表示，不受影响）。
fn roundtrips_via_f64(i: Integer) -> bool {
  let n = i as f64;
  i != i64::MAX && n as i64 == i
}

/// Push a [`Value`] onto the top of the Lua stack.
pub(crate) fn push_value(lua: &Lua, value: &Value) -> Result<()> {
  let state = lua.state();
  // 共用前置（每个分支的 push 门面/`push_to_stack` 都只依赖它）：栈头寸由 VM 的
  // `lua_push*` 各自内置的 `ensure_stack(l, 1)` 自保（本仓库 VM 对上游的既定偏离，
  // 上游需调用方预留），本函数逐分支至多净压一层；`state` 存活；各入口只收状态指针
  // 与标量（bool/i64/f64 经 `as` 转换均全值域合法），tag 参数 0 是 VM 认可的
  // light-userdata 标签。唯一的借用指针是错误消息 `msg`：`&[u8]` 切片非空对齐
  // （len 可为 0，指针仍有效），且 push_bytes 在返回前把字节完整拷进新串对象，
  // `msg` 活过整个调用。句柄分支的 `*_to_stack` 是各自已证成的安全封装（owning VM
  // 与本 VM 一致由 move-not-share 句柄纪律保证）。
  match value {
    Value::Nil => push_nil(state),
    Value::Boolean(b) => push_boolean(state, *b),
    // Light userdata: push the raw pointer with tag 0.
    Value::LightUserData(lud) => push_lightuserdata_tagged(state, lud.0, 0),
    // 整数推栈两型（对齐 cpp `lapi.cpp:697-710` 的 pushinteger/pushinteger64
    // 分工，兼顾 mlua 兼容）：f64 能精确往返的 i64 走 `lua_pushnumber`（与
    // 脚本字面量同为 NUMBER 键链，`#t`/`t[1]` 等数组语义可见）；超出 f64
    // 精确表示（|i| > 2^53 一类）的走 `push_int64` 保 LUA_TINTEGER
    // tag，杜绝静默舍入损坏。读取侧 `is_exact_integer` 折叠保证两者都能
    // 无损还原为同一个 `Value::Integer`。
    Value::Integer(i) if roundtrips_via_f64(*i) => push_number(state, *i as f64),
    Value::Integer(i) => push_int64(state, *i),
    Value::Number(n) => push_number(state, *n),
    Value::String(s) => s.push_to_stack(),
    Value::Table(t) => t.push_to_stack(),
    Value::Function(f) => f.push_to_stack(),
    Value::UserData(u) => u.push_to_stack(),
    Value::Thread(t) => t.push_to_stack(),
    Value::Buffer(b) => b.push_to_stack(),
    // ulua is a 3-wide vector build; the 4th component is ignored by
    // the VM (push_vector 固定传 w = 0)。
    Value::Vector(v) => push_vector(state, v.x(), v.y(), v.z()),
    // An error value pushes as its message string (so Lua code that
    // receives it can `tostring(err)` it). This matches how a Rust
    // callback's `Err` surfaces to Lua as a string error object.
    Value::Error(e) => {
      let msg = e.to_string();
      push_bytes(state, msg.as_bytes());
    }
  }
  Ok(())
}

/// 引用型栈值的公共尾部：复制 `idx` 到栈顶 → 注册表引用 → 弹出包装。
/// STRING/TABLE/FUNCTION/USERDATA/THREAD/BUFFER 六个分支共用。
///
/// 调用序契约（正确性，非内存安全）：栈上须有空位容纳 `lua_pushvalue` 的一层
/// 压入（`value_from_stack` 头部以 VM 帧 `LUA_MINSTACK` 头寸论证）；`idx` 处值
/// 的 Lua 类型须与 `wrap` 期望的引用类型一致（`value_from_stack` 的各 `LuaType`
/// 分支保证）——错型会把注册表引用包成错误变体。`lua` 存活由 `&Lua` 借用保证，
/// unsafe 内聚在本函数体内一次。
fn ref_value(lua: &Lua, idx: i32, wrap: fn(LuaRef) -> Value) -> Value {
  // `clone_slot_to_top`/`pop_ref` 都是带契约的 safe 门面：前者把 `idx` 处（有效栈
  // 索引）的值复制到栈顶，后者按 `lua_ref` 约定消费这个刚压入的栈槽取注册引用，
  // 净栈变化为零。`wrap` 只把整数 id 包进对应引用类型，不解任何裸指针。
  clone_slot_to_top(lua.state(), idx);
  wrap(lua.pop_ref())
}

/// Build a [`Value`] from the value at stack index `idx` (does not pop). For
/// reference types this registers a registry reference.
pub(crate) fn value_from_stack(lua: &Lua, idx: i32) -> Result<Value> {
  let state = lua.state();
  // 共用前置：`state` 存活，`idx` 由调用方保证为栈上有效索引（`index_2_addr` 的
  // 越界只会发生在无效索引上，各入口先经 `type_at`/栈检查）。各只读查询门面
  // 对有效索引不触发 GC、不移动值；分支与标签严格对应：`type_at` 报 Integer 才走
  // `check_int64_at`（其内部 tag_check 因此不触发），报 Number 才走
  // `number_at`（`lua_tonumberx` 的安全封装）。`ref_value` 分支各需一个空 push
  // 位：由 VM 帧约定保证——每个 CI 建立时 `ci->top` 预留 `LUA_MINSTACK` 头寸，
  // api 层的单次 push 一直依赖此下限，且 pushvalue+pop_ref 净栈变化为零。
  // 类型标签唯一真相是 `LuaType`；未知 tag 与其余 exotic 标签同样折叠为 Nil。
  let ty = type_at(state, idx);

  let value = match ty {
    LuaType::Nil | LuaType::None => Value::Nil,
    LuaType::Boolean => Value::Boolean(boolean_at(state, idx)),
    // tag 已由上面 `type_at` 判为 LightUserData；同一槽的 `lightuserdata_at` 因此
    // 必返回 `Some`（载荷本身可为 null，`Some(null)` 照常带出）——`unwrap` 的
    // None 分支不可达（两次读数间栈未动，构造期不变式，见门面 `# Safety`）。
    LuaType::LightUserData => {
      Value::LightUserData(LightUserData(lightuserdata_at(state, idx).unwrap()))
    }
    LuaType::Number => {
      // `number_at` 为 safe 门面（契约见 table.rs）；共用前置成立且 tag 已由
      // `type_at` 判为数，故必命中；`unwrap_or(0.0)` 兜底与旧「null 出参、非常
      // 数槽读 0」路径逐位一致（0.0 经 `is_exact_integer` 折叠为 Integer(0)）。
      let n = number_at(state, idx).unwrap_or(0.0);
      if is_exact_integer(n) {
        Value::Integer(n as i64)
      } else {
        Value::Number(n)
      }
    }
    // 整数子类型：i64 原样存在 TValue 里，`lua_tonumberx` 不认这个 tag（会报
    // 0）、`lua_tointegerx` 又截断成 i32，只能走 64 位读取。tag 已由上面的
    // `type_at` 判明，故 `check_int64_at` 内的 `tag_error` 不会触发。
    LuaType::Integer => Value::Integer(check_int64_at(state, idx)),
    // 共用前置成立——`idx` 槽类型即为对应引用类型；`ref_value`（safe 门面）的
    // 栈头寸契约由函数头 LUA_MINSTACK 论证满足。
    LuaType::String => ref_value(lua, idx, |r| Value::String(LuaString::from_ref(r))),
    LuaType::Table => ref_value(lua, idx, |r| Value::Table(Table::from_ref(r))),
    LuaType::Function => ref_value(lua, idx, |r| Value::Function(Function::from_ref(r))),
    LuaType::UserData => ref_value(lua, idx, |r| Value::UserData(AnyUserData::from_ref(r))),
    LuaType::Thread => ref_value(lua, idx, |r| Value::Thread(Thread::from_ref(r))),
    LuaType::Vector => vector_at(state, idx),
    LuaType::Buffer => ref_value(lua, idx, |r| Value::Buffer(Buffer::from_ref(r))),
    // Any other exotic tags collapse to Nil.
    _ => Value::Nil,
  };
  Ok(value)
}

/// 读 `idx` 槽的内联 vector 分量（本 crate 唯一保留的 vector 裸读边界）。
///
/// ulua is a 3-wide vector build：`lua_tovector` 要么 null，要么指向 TValue
/// 内联的 `Vector::SIZE` 个 f32 分量；f32 按 TValue 存储自然对齐，栈值在 GC 前
/// 不移动，切片在函数体内即时消费、不外泄。
fn vector_at(state: StateView<'_>, idx: i32) -> Value {
  // Safety: `idx` 有效（`value_from_stack` 共用前置）且 tag 已判为 Vector，
  // `lua_tovector` 返回的分量数组指针非空即活过本次读取（不外借）。
  let comps = unsafe {
    let p = lua_tovector(&*state.as_ptr(), idx);
    if p.is_null() {
      return Value::Nil;
    }
    from_raw_parts(p, Vector::SIZE)
  };
  Value::Vector(Vector::new(comps[0], comps[1], comps[2]))
}
