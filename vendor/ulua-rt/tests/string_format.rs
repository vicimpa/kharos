//! End-to-end `string.format` coverage through the runtime.
//!
//! The numeric specifiers (`%d`, `%x`, `%f`, …) used to be forwarded to the
//! platform's C `snprintf`; on `wasm32-unknown-unknown` no libc exists, the
//! import was an unresolved stub, and any script touching them trapped with
//! `unreachable` in the browser while native builds sailed through. The
//! directive formatter is now pure Rust, so the same assertions hold on every
//! target — these tests pin the observable C-printf behaviour in-engine.

mod common;

use common::{check, eval};
use ulua_rt::{Error, Lua};

#[test]
fn decimal() {
  check(r#"string.format("%d", 42)"#, "42");
  check(r#"string.format("%d", -42)"#, "-42");
  check(r#"string.format("%i", 7)"#, "7");
  check(r#"string.format("%d", 3.0)"#, "3"); // integral float coerces
  check(r#"string.format("%5d", 42)"#, "   42");
  check(r#"string.format("%-5d", 42)"#, "42   ");
  check(r#"string.format("%05d", 42)"#, "00042");
  check(r#"string.format("%05d", -42)"#, "-0042");
  check(r#"string.format("%+d", 42)"#, "+42");
  check(r#"string.format("% d", 42)"#, " 42");
  check(r#"string.format("%.5d", 42)"#, "00042");
  check(r#"string.format("%8.5d", 42)"#, "   00042");
  check(r#"string.format("%.0d", 0)"#, "");
  check(r#"string.format("%%%d %010d", 10, 23)"#, "%10 0000000023");
  check(
    r#"string.format("%d", -9007199254740991)"#,
    "-9007199254740991",
  );
}

#[test]
fn unsigned_octal_hex() {
  check(r#"string.format("%u", 42)"#, "42");
  check(r#"string.format("%x", 255)"#, "ff");
  check(r#"string.format("%X", 255)"#, "FF");
  check(r#"string.format("%o", 8)"#, "10");
  check(r#"string.format("%#x", 255)"#, "0xff");
  check(r#"string.format("%#X", 255)"#, "0XFF");
  check(r#"string.format("%#o", 8)"#, "010");
  check(r#"string.format("%#010x", 255)"#, "0x000000ff");
  check(r#"string.format("%08x", 255)"#, "000000ff");
  // negative values wrap to the full 64-bit range (Luau semantics)
  check(
    r#"string.format("%o %u %x %X", -1, -1, -1, -1)"#,
    "1777777777777777777777 18446744073709551615 ffffffffffffffff FFFFFFFFFFFFFFFF",
  );
}

/// `%d/%i/%u/%o/%x/%X` 的宽度/精度/flag 组合输出（cpp `lstrlib.cpp:1006-1031`
/// 把参数交给 `snprintf("%lld"/"%llu"/"%llx"...)`，期望值即 C 标准语义）：
/// `-` 左对齐、`0` 零填充（给定精度时失效）、`#` 前缀（0 值不加 0x）、
/// 宽度含符号/前缀、精度先行补零（0 精度 0 值输出空）。
#[test]
fn int_specifier_width_precision_flags() {
  // 宽度：右对齐空格填充 / '-' 左对齐 / 宽度含 '+' 号与前缀
  check(r#"string.format("%8x", 255)"#, "      ff");
  check(r#"string.format("%-8x|", 255)"#, "ff      |");
  check(r#"string.format("%08X", 255)"#, "000000FF");
  check(r#"string.format("%#10x", 255)"#, "      0xff");
  check(r#"string.format("%#-10x|", 255)"#, "0xff      |");
  check(r#"string.format("%+5d|", -42)"#, "  -42|");
  // 精度：先补零；给定精度时 '0' flag 被忽略（C99 7.19.6.1）
  check(r#"string.format("%.4x", 255)"#, "00ff");
  check(r#"string.format("%.4o", 8)"#, "0010");
  check(r#"string.format("%8.4x", 255)"#, "    00ff");
  check(r#"string.format("%#10.4x", 255)"#, "    0x00ff");
  check(r#"string.format("%5.3d", 42)"#, "  042");
  // '#'：零值不加 0x 前缀（C 标准）；零值 + 精度 0 输出空
  check(r#"string.format("%#6x", 0)"#, "     0");
  check(r#"string.format("%.0x", 0)"#, "");
  check(r#"string.format("%3.0d", 0)"#, "   ");
  // 符号 flag：负号优先，'+'/' ' 只对非负生效（%x 无符号域回绕）
  check(r#"string.format("%+d", -42)"#, "-42");
  check(r#"string.format("% d", -42)"#, "-42");
  check(r#"string.format("%x", -2.5)"#, "fffffffffffffffe");
  // 浮点实参截断取整（cpp:1009 (int64_t) / cpp:1026-1027 (ull)）
  check(r#"string.format("%d", 3.7)"#, "3");
  check(r#"string.format("%d", -3.7)"#, "-3");
  check(r#"string.format("%x", 255.7)"#, "ff");
  // integer64 路径（cpp:1009/1020 lua_isinteger64 → %lld 直传）
  check(r#"string.format("%d %x", -1i, 255i)"#, "-1 ff");
}

#[test]
fn fixed_floats() {
  check(r#"string.format("%f", 0)"#, "0.000000");
  check(r#"string.format("%f", 10.3)"#, "10.300000");
  check(r#"string.format("%.2f", 1.5)"#, "1.50");
  check(r#"string.format("%.0f", 2.5)"#, "2"); // round-half-even
  check(r#"string.format("%.0f", 3.5)"#, "4");
  check(r#"string.format("%#.0f", 5)"#, "5.");
  check(r#"string.format("%010.2f", -1.5)"#, "-000001.50");
  check(r#"string.format("%-8.2f|", 1.5)"#, "1.50    |");
  check(r#"string.format("%f", -0.0)"#, "-0.000000");
  // the longest number that can be formatted
  assert!(
    eval(r#"return string.format("%99.99f", -1e308)"#)
      .unwrap()
      .len()
      >= 100
  );
}

#[test]
fn scientific_floats() {
  check(r#"string.format("%e", 1.5)"#, "1.500000e+00");
  check(r#"string.format("%E", -1.5)"#, "-1.500000E+00");
  check(r#"string.format("%.0e", 12345)"#, "1e+04");
  check(r#"string.format("%e", 0)"#, "0.000000e+00");
  check(r#"string.format("%.2e", 1e308)"#, "1.00e+308");
  check(r#"string.format("%.2e", 0.000123)"#, "1.23e-04");
}

#[test]
fn general_floats() {
  check(r#"string.format("%g", 100000)"#, "100000");
  check(r#"string.format("%g", 1000000)"#, "1e+06");
  check(r#"string.format("%g", 0.0001)"#, "0.0001");
  check(r#"string.format("%g", 0.00001)"#, "1e-05");
  check(r#"string.format("%g", 0)"#, "0");
  check(r#"string.format("%g", 0.5)"#, "0.5");
  check(r#"string.format("%.3g", 1234.5)"#, "1.23e+03");
  check(r#"string.format("%#g", 1)"#, "1.00000");
  check(r#"string.format("%G", 1e-10)"#, "1E-10");
}

#[test]
fn nonfinite_floats() {
  check(r#"string.format("%f", 1/0)"#, "inf");
  check(r#"string.format("%f", -1/0)"#, "-inf");
  check(r#"string.format("%+f", 1/0)"#, "+inf");
  check(r#"string.format("%E", 1/0)"#, "INF");
  check(r#"string.format("%8f", 1/0)"#, "     inf");
  // NaN formats without a sign on every target (hardware NaN sign bits
  // differ between x86, ARM and wasm).
  check(r#"string.format("%f", 0/0)"#, "nan");
  check(r#"string.format("%G", 0/0)"#, "NAN");
}

#[test]
fn chars_and_strings() {
  check(r#"string.format("%c", 65)"#, "A");
  check(r#"string.format("%5c", 65)"#, "    A");
  check(r#"string.format("%-5c|", 65)"#, "A    |");
  check(r#"string.format("%5s", "ab")"#, "   ab");
  check(r#"string.format("%-5s|", "ab")"#, "ab   |");
  check(r#"string.format("%.2s", "abc")"#, "ab");
  check(r#"string.format("%5.2s", "abc")"#, "   ab");
  // %c of zero and embedded NULs survive
  assert_eq!(
    eval(r#"return string.format("%c%c%c%c", 1, 0, 2, 3)"#)
      .unwrap()
      .as_bytes(),
    b"\x01\x00\x02\x03"
  );
}

#[test]
fn quoted() {
  check(
    r#"string.format("%q", 'he said "hi"')"#,
    r#""he said \"hi\"""#,
  );
  check(r#"string.format("%q", "a\nb")"#, "\"a\\\nb\"");
  check(r#"string.format("%q", "a\rb")"#, r#""a\rb""#);
  check(r#"string.format("%q", "a\0b")"#, r#""a\000b""#);
  check(r#"string.format("%q", "back\\slash")"#, r#""back\\slash""#);
}

/// 求值 `src` 并取出 `Error::RuntimeError` 的完整文本（含 `luaL_where` 前缀），
/// 其它结果一律视为契约违背直接 panic——错误文案是 oracle 锁定的对象，
/// 不允许「只要报错就算过」的弱断言。
fn runtime_msg(src: &str) -> String {
  match Lua::new().load(src).eval::<String>() {
    Err(Error::RuntimeError(msg)) => msg,
    Err(other) => panic!("{src}: 期望 RuntimeError，实际 {other:?}"),
    Ok(value) => panic!("{src}: 期望报错，实际成功返回 {value:?}"),
  }
}

/// 尺寸/标志类格式串的**精确**错误文案（逐条对账 cpp lstrlib.cpp）。
/// oracle 出处：
/// - `invalid format (repeated flags)` → lstrlib.cpp:931（scanformat，标志数
///   ≥ `sizeof(FLAGS)`=6 时触发，与转换字母无关）；
/// - `invalid format (width or precision too long)` → lstrlib.cpp:945（宽度/精度
///   各封顶 2 位数字）；
/// - `missing argument #%d` → lstrlib.cpp:994（%d/%u/%x/%o 缺实参，arg 为 1-based）；
/// - `invalid option '%%%c' to 'format'` → lstrlib.cpp:1070（未知转换字母）；
/// - `'%*' does not take a form` → lstrlib.cpp:1066（`%` 后带 flag 的裸 `*`）。
///
/// 运行期文本由 `luaL_error` 先经 `luaL_where(L,1)` 拼调用行前缀 `chunk:1: `。
#[test]
fn invalid_formats_error() {
  // 转换字母未知（cpp:1070）：'%?' → "invalid option '%?' to 'format'"
  assert_eq!(
    runtime_msg(r#"return string.format("%?", 1)"#),
    "chunk:1: invalid option '%?' to 'format'"
  );
  // 尺寸字母 p/n/L/h 亦属未支持项（cpp default 分支 :1070 一并处理）
  assert_eq!(
    runtime_msg(r#"return string.format("%p", 1)"#),
    "chunk:1: invalid option '%p' to 'format'"
  );
  // `l` 同属 cpp default 分支注释点名的 `pnLlh'` 一族
  assert_eq!(
    runtime_msg(r#"return string.format("%l", 1)"#),
    "chunk:1: invalid option '%l' to 'format'"
  );
  // 精度 3 位数字 > 2 位上限（cpp:945）
  assert_eq!(
    runtime_msg(r#"return string.format("%.123d", 1)"#),
    "chunk:1: invalid format (width or precision too long)"
  );
  // 宽度 3 位数字同样越界（cpp:945）
  assert_eq!(
    runtime_msg(r#"return string.format("%123u", 1)"#),
    "chunk:1: invalid format (width or precision too long)"
  );
  // 6 个及以上标志触发「重复标志」（cpp:931，sizeof(FLAGS)=='-+ #0\0'=6）
  assert_eq!(
    runtime_msg(r#"return string.format("%------d", 1)"#),
    "chunk:1: invalid format (repeated flags)"
  );
  assert_eq!(
    runtime_msg(r#"return string.format("%##################x", 1)"#),
    "chunk:1: invalid format (repeated flags)"
  );
  // 缺实参（cpp:994）：格式串仅一个指示符，arg 递增到 2 → "missing argument #2"
  assert_eq!(
    runtime_msg(r#"return string.format("%d")"#),
    "chunk:1: missing argument #2"
  );
  assert_eq!(
    runtime_msg(r#"return string.format("%o %x", 8)"#),
    "chunk:1: missing argument #3"
  );
  // `%*` 不接受形式（cpp:1066）：先扫描 flags/width/prec 后指示符仍是 '*'
  assert_eq!(
    runtime_msg(r#"return string.format("%.2*", 1)"#),
    "chunk:1: '%*' does not take a form"
  );
}

/// 尺寸 specifier 收到非数值实参时的精确文案（cpp laux.cpp ` luaL_typeerrorL`，
/// oracle 出处同 wrong_argument_types_error：number expected）。%d/%u/%x/%o 共用
/// `lua_l_checknumber`/`checkinteger` 通道，故文案一致。
#[test]
fn size_specifier_type_errors() {
  for conv in ['d', 'u', 'x', 'X', 'o'] {
    let src = format!(r#"return string.format("%{conv}", "abc")"#);
    assert_eq!(
      runtime_msg(&src),
      "chunk:1: invalid argument #2 to 'format' (number expected, got string)",
      "%{conv} 非数值实参文案"
    );
  }
}

/// 格式串以单个 `%` 收尾：指示符读到的就是 NUL 终止符，cpp `lstrlib.cpp` default
/// 分支的 `"invalid option '%%%c' to 'format'"` 经 vsnprintf 在嵌入的 NUL 处截断，
/// 闭合引号连同后半句一并丢失，只剩 `invalid option '%`。
#[test]
fn trailing_percent_error() {
  assert_eq!(
    runtime_msg(r#"return string.format("%", 1)"#),
    "chunk:1: invalid option '%"
  );
}

/// 尺寸 specifier 的宽度/精度/flag 组合精确输出（补 cpp lstrlib.cpp:1006-1032
/// 的 %lld/%llu/%llo/%llx 语义）：锁 zero/space/plus/left-justify/#/precision
/// 在 %d/%u/%x/%X/%o 上的交互。
#[test]
fn size_specifier_width_precision_flags() {
  // %d：`+`/空格强制符号；`0` 补零位于符号之后；精度存在时 `0` 被忽略（C 语义）
  check(r#"string.format("%+05d", 42)"#, "+0042");
  check(r#"string.format("% 05d", 42)"#, " 0042");
  check(r#"string.format("%05.8d", 42)"#, "00000042"); // 精度 8 位主导，`0` 标志让位
  check(r#"string.format("%-+05d", 42)"#, "+42  "); // `-` 令 `0` 失效且左对齐
  check(r#"string.format("%d", 0)"#, "0");
  check(r#"string.format("%.3d", 0)"#, "000");
  // %u：`+`/空格对无符号转换被忽略（glibc/musl 一致，见 format_directive 头注）
  check(r#"string.format("%+u", 42)"#, "42");
  check(r#"string.format("% u", 42)"#, "42");
  check(r#"string.format("%06u", 42)"#, "000042");
  check(r#"string.format("%.4u", 42)"#, "0042");
  // %x/%X：`#` 前缀只在值非 0 时出现；`#0` 前缀后补零；大写转换字母保持
  check(r#"string.format("%#x", 0)"#, "0");
  check(r#"string.format("%#010X", 255)"#, "0X000000FF");
  check(r#"string.format("%#8x", 255)"#, "    0xff");
  check(r#"string.format("%-#8x|", 255)"#, "0xff    |");
  check(r#"string.format("%.6x", 255)"#, "0000ff");
  // %o：`#` 强制前导 0；精度已含前导 0 时不重复；`#o` 对 0 恰好保留单字符
  check(r#"string.format("%#o", 0)"#, "0");
  check(r#"string.format("%#.0o", 0)"#, "0"); // alt 把空串补回一个 0
  check(r#"string.format("%#o", 511)"#, "0777");
  check(r#"string.format("%#08o", 8)"#, "00000010");
  check(r#"string.format("%.5o", 8)"#, "00010");
}

#[test]
fn wrong_argument_types_error() {
  // 参数类型校验路径（区别于上一测的格式串校验）。oracle：cpp laux.cpp:53
  // luaL_typeerrorL 的正文全等；luaL_errorL 先 luaL_where(L,1) 拼调用方位置
  // 前缀（"chunk:1: "，C 函数帧无自身行号，取的是调用它的 Lua 代码行）。
  let lua = Lua::new();
  for (src, want) in [
    (
      r#"string.format("%d", "abc")"#,
      "invalid argument #2 to 'format' (number expected, got string)",
    ),
    (
      r#"string.format("%.2s", {})"#,
      "invalid argument #2 to 'format' (string expected, got table)",
    ),
  ] {
    match lua.load(src).eval::<String>() {
      Err(Error::RuntimeError(ref msg)) => assert!(
        msg.starts_with("chunk:") && msg.ends_with(want),
        "{src}: {msg}"
      ),
      r => panic!("{src}: expected RuntimeError, got {r:?}"),
    }
  }
}

/// The production repro: a game-cart-style tick function whose HUD text is
/// composed with numeric specifiers. This used to trap `unreachable` on
/// wasm32-unknown-unknown while passing every native check.
#[test]
fn cart_tick_repro() {
  let out = eval(
        r#"
        local score, health, t = 12345, 0.75, 61.5
        local function hud()
            return string.format("SCORE %08d  HP %3d%%  T %.1fs  0x%04X", score, health * 100, t, 48879)
        end
        return hud()
        "#,
    )
    .unwrap();
  assert_eq!(out, "SCORE 00012345  HP  75%  T 61.5s  0xBEEF");
}
