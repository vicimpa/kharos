// Окно без консоли в выпускной сборке Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  kharos_client::run();
}

// Браузер: события страницы (web/shell.js) — в оболочку (src/web.rs). Объявлены здесь, в самой программе, чтобы
// компоновщик вывел их наружу.
#[cfg(target_os = "emscripten")]
mod page {
  use kharos_client::web;
  use std::ffi::{c_char, c_int};

  #[no_mangle]
  pub extern "C" fn kharos_pointer(x: f64, y: f64, touch: c_int) {
    web::pointer(x, y, touch);
  }

  #[no_mangle]
  pub extern "C" fn kharos_leave() {
    web::leave();
  }

  #[no_mangle]
  pub extern "C" fn kharos_button(index: c_int, down: c_int) {
    web::button(index, down);
  }

  #[no_mangle]
  pub extern "C" fn kharos_wheel(lines: f64) {
    web::wheel(lines);
  }

  #[no_mangle]
  pub extern "C" fn kharos_key(name: *const c_char, down: c_int, repeat: c_int) {
    web::key(name, down, repeat);
  }

  #[no_mangle]
  pub extern "C" fn kharos_text(text: *const c_char) {
    web::typed(text);
  }

  #[no_mangle]
  pub extern "C" fn kharos_focus(focused: c_int) {
    web::focus(focused);
  }

  #[no_mangle]
  pub extern "C" fn kharos_save() {
    web::save();
  }
}
