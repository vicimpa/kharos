//! Оболочка в браузере (Emscripten): холст #canvas, WebGL 2 (web/glue.c), события страницы — из web/shell.js через
//! функции `kharos_*` (их выводит наружу main.rs), кадр — по `requestAnimationFrame` (`emscripten_set_main_loop`).
//! Моды лежат в /mods (пакет tools/web/build.sh), настройки и сохранения — в IndexedDB.

use crate::input::Input;
use crate::App;
use std::cell::RefCell;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::time::Instant;

extern "C" {
  fn kharos_gl_context() -> c_int;
  fn kharos_canvas_size(width: *mut f64, height: *mut f64, scale: *mut f64);
  fn emscripten_webgl_get_proc_address(name: *const c_char) -> *mut c_void;
  fn emscripten_set_main_loop_arg(func: extern "C" fn(*mut c_void), arg: *mut c_void, fps: c_int, simulate_infinite_loop: c_int);
  fn emscripten_cancel_main_loop();
}

struct Shell {
  start: Instant,
  input: Input,
  app: App,
}

thread_local! {
  static SHELL: RefCell<Option<Shell>> = const { RefCell::new(None) };
}

pub fn run() {
  if unsafe { kharos_gl_context() } == 0 {
    eprintln!("нет WebGL 2");
    return;
  }
  let gl = unsafe { glow::Context::from_loader_function_cstr(|name| emscripten_webgl_get_proc_address(name.as_ptr()) as *const c_void) };
  let app = match App::new(gl) {
    Ok(app) => app,
    Err(error) => {
      eprintln!("{error}");
      return;
    }
  };
  SHELL.with(|shell| *shell.borrow_mut() = Some(Shell { start: Instant::now(), input: Input { focused: true, ..Default::default() }, app }));
  // Без «бесконечного цикла»: main возвращается, рантайм остаётся жить, кадры зовёт браузер.
  unsafe { emscripten_set_main_loop_arg(frame, std::ptr::null_mut(), 0, 0) };
}

extern "C" fn frame(_: *mut c_void) {
  SHELL.with(|shell| {
    let mut shell = shell.borrow_mut();
    let Some(shell) = shell.as_mut() else { return };
    let (mut width, mut height, mut scale) = (0.0, 0.0, 1.0);
    unsafe { kharos_canvas_size(&mut width, &mut height, &mut scale) };
    if width <= 0.0 || height <= 0.0 {
      return;
    }
    let size = [(width * scale).round() as u32, (height * scale).round() as u32];
    shell.input.scale = scale as f32;
    shell.input.screen = [width as f32, height as f32];
    shell.input.time = shell.start.elapsed().as_secs_f64();
    if let Err(error) = shell.app.frame(&shell.input, size) {
      eprintln!("{error}");
      unsafe { emscripten_cancel_main_loop() };
      return;
    }
    shell.input.end_frame();
  });
}

/// Ввод от страницы: что сделать с оболочкой, если она уже есть.
fn with(action: impl FnOnce(&mut Shell)) {
  SHELL.with(|shell| {
    if let Ok(mut shell) = shell.try_borrow_mut() {
      if let Some(shell) = shell.as_mut() {
        action(shell);
      }
    }
  });
}

fn text(value: *const c_char) -> String {
  if value.is_null() {
    return String::new();
  }
  unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned()
}

pub fn pointer(x: f64, y: f64, touch: c_int) {
  with(|shell| {
    shell.input.pointer = Some([x as f32, y as f32]);
    shell.input.touch = touch != 0;
  });
}

pub fn leave() {
  with(|shell| shell.input.pointer = None);
}

pub fn button(index: c_int, down: c_int) {
  with(|shell| shell.input.button((index as usize).min(2), down != 0));
}

pub fn wheel(lines: f64) {
  with(|shell| shell.input.wheel += lines as f32);
}

pub fn key(name: *const c_char, down: c_int, repeat: c_int) {
  let name = text(name);
  with(|shell| shell.input.key(&name, down != 0, repeat != 0));
}

pub fn typed(value: *const c_char) {
  let value = text(value);
  with(|shell| shell.input.text.extend(value.chars().filter(|char| !char.is_control())));
}

pub fn focus(focused: c_int) {
  with(|shell| {
    shell.input.focused = focused != 0;
    // Ушли со страницы — зажатые клавиши уже не отпустят здесь.
    if focused == 0 {
      shell.input.keys.clear();
      shell.input.down = [false; 3];
    }
  });
}

pub fn save() {
  with(|shell| shell.app.save());
}
