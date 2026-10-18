//! Арифметика с правилами JS: движок и системы на Rust обязаны считать так же, как TS, до последнего знака.

/// Полный оборот в радианах.
pub const TURN: f64 = std::f64::consts::PI * 2.0;

/// `Math.round` из JS: половина — вверх (к +∞), а не от нуля, как `f64::round`.
pub fn js_round(x: f64) -> f64 {
  let floor = x.floor();
  if x - floor >= 0.5 {
    floor + 1.0
  } else {
    floor
  }
}

/// `Math.sign` из JS: у нуля — ноль, а не единица, как у `f64::signum`.
pub fn js_sign(x: f64) -> f64 {
  if x > 0.0 {
    1.0
  } else if x < 0.0 {
    -1.0
  } else {
    x
  }
}

/// Угол, приведённый к промежутку от -π до π (`wrap` в common.ts).
pub fn wrap(angle: f64) -> f64 {
  angle - TURN * js_round(angle / TURN)
}

/// Куда будет смотреть тот, кто поворачивается от facing к wanted не больше чем на max_turn радиан (`turnToward`).
pub fn turn_toward(facing: f64, wanted: f64, max_turn: f64) -> f64 {
  let off = wrap(wanted - facing);
  if off.abs() <= max_turn {
    wanted
  } else {
    wrap(facing + js_sign(off) * max_turn)
  }
}

// Синус, косинус, арктангенс, гипотенуза и степень в JS не одинаковы между движками и платформами: JavaScriptCore (Bun) берёт
// их у системы, V8 — у своей fdlibm и своего `hypot`. Поэтому в wasm они приходят от хоста — импортом `math` (его
// даёт `loadSimWasm` в packages/sim-rust), и Rust считает ровно как TS рядом; в нативе и в клиенте под Emscripten —
// системные, как у Bun.
#[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
mod host {
  #[link(wasm_import_module = "math")]
  extern "C" {
    pub fn hypot(a: f64, b: f64) -> f64;
    pub fn sin(x: f64) -> f64;
    pub fn cos(x: f64) -> f64;
    pub fn atan2(y: f64, x: f64) -> f64;
    pub fn pow(x: f64, y: f64) -> f64;
  }
}

/// `Math.hypot` двух чисел.
pub fn js_hypot(a: f64, b: f64) -> f64 {
  #[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
  return unsafe { host::hypot(a, b) };
  #[cfg(not(all(target_arch = "wasm32", not(target_os = "emscripten"))))]
  a.hypot(b)
}

/// `Math.sin`.
pub fn js_sin(x: f64) -> f64 {
  #[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
  return unsafe { host::sin(x) };
  #[cfg(not(all(target_arch = "wasm32", not(target_os = "emscripten"))))]
  x.sin()
}

/// `Math.cos`.
pub fn js_cos(x: f64) -> f64 {
  #[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
  return unsafe { host::cos(x) };
  #[cfg(not(all(target_arch = "wasm32", not(target_os = "emscripten"))))]
  x.cos()
}

/// `Math.atan2`.
pub fn js_atan2(y: f64, x: f64) -> f64 {
  #[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
  return unsafe { host::atan2(y, x) };
  #[cfg(not(all(target_arch = "wasm32", not(target_os = "emscripten"))))]
  y.atan2(x)
}

/// Угол от b до a, от -π до π (`angleBetween`).
pub fn angle_between(a: f64, b: f64) -> f64 {
  js_atan2(js_sin(a - b), js_cos(a - b))
}

/// `x ** y` из JS.
pub fn js_pow(x: f64, y: f64) -> f64 {
  #[cfg(all(target_arch = "wasm32", not(target_os = "emscripten")))]
  return unsafe { host::pow(x, y) };
  #[cfg(not(all(target_arch = "wasm32", not(target_os = "emscripten"))))]
  x.powf(y)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rounding_and_sign_follow_js() {
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(0.49999999999999994), 0.0);
    assert_eq!(js_sign(0.0), 0.0);
    assert_eq!(js_sign(-3.0), -1.0);
  }

  #[test]
  fn angles_wrap_to_the_short_side() {
    assert_eq!(js_hypot(3.0, -4.0), 5.0);
    assert!((angle_between(0.1, -0.1) - 0.2).abs() < 1e-12);
    assert!((angle_between(3.0, -3.0) - (6.0 - std::f64::consts::TAU)).abs() < 1e-12);
  }

  #[test]
  fn turning_takes_the_short_way() {
    assert_eq!(turn_toward(0.0, 1.0, 2.0), 1.0);
    assert_eq!(turn_toward(0.0, 1.0, 0.25), 0.25);
    assert!((turn_toward(3.0, -3.0, 0.1) - 3.1).abs() < 1e-12);
  }
}
