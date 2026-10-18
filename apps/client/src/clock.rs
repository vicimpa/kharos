//! Часы клиента: на нативе — `std::time`, в браузере — `performance.now()` и `Date.now()` (`std::time` там паникует).

/// Секунды от запуска — для кадров и замеров.
pub fn seconds() -> f64 {
  #[cfg(not(target_arch = "wasm32"))]
  {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
  }
  #[cfg(target_arch = "wasm32")]
  {
    web_sys::window().and_then(|window| window.performance()).map_or(0.0, |performance| performance.now() / 1000.0)
  }
}

/// Миллисекунды от 1970 года — для дат сохранений и зерна случайностей.
pub fn epoch_millis() -> f64 {
  #[cfg(not(target_arch = "wasm32"))]
  {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |time| time.as_secs_f64() * 1000.0)
  }
  #[cfg(target_arch = "wasm32")]
  {
    js_sys::Date::now()
  }
}
