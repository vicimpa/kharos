//! Оболочка в браузере (wasm32, web-sys): холст `#canvas`, WebGL 2 через glow, события страницы в `Input`, кадр по
//! `requestAnimationFrame`. Сборка — trunk (apps/client/web/index.html), моды зашиты в неё (build.rs).

use crate::input::Input;
use crate::App;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast as _;
use web_sys::{EventTarget, HtmlCanvasElement, KeyboardEvent, PointerEvent, WebGl2RenderingContext, WheelEvent};

struct Shell {
  canvas: HtmlCanvasElement,
  input: Input,
  app: App,
}

pub fn run() {
  if let Err(error) = start() {
    show(&format!("Kharos не запустился: {error}"));
    web_sys::console::error_1(&error.into());
  }
}

/// Параметр адреса страницы: `?game=skirmish`.
pub fn query(name: &str) -> Option<String> {
  let search = web_sys::window()?.location().search().ok()?;
  web_sys::UrlSearchParams::new_with_str(&search).ok()?.get(name)
}

/// Сообщение вместо «Загрузка…» на странице.
fn show(text: &str) {
  if let Some(status) = web_sys::window().and_then(|window| window.document()).and_then(|document| document.get_element_by_id("status")) {
    status.set_text_content(Some(text));
  }
}

fn start() -> Result<(), String> {
  let window = web_sys::window().ok_or("нет окна")?;
  let document = window.document().ok_or("нет документа")?;
  let canvas: HtmlCanvasElement = document.get_element_by_id("canvas").ok_or("нет <canvas id=\"canvas\">")?.dyn_into().map_err(|_| "#canvas — не холст")?;
  let options = js_sys::Object::new();
  for (key, value) in [("alpha", true), ("antialias", false), ("depth", false), ("premultipliedAlpha", true), ("preserveDrawingBuffer", true)] {
    let _ = js_sys::Reflect::set(&options, &key.into(), &value.into());
  }
  let gl: WebGl2RenderingContext = canvas.get_context_with_context_options("webgl2", &options).map_err(|error| format!("{error:?}"))?.ok_or("нет WebGL 2")?.dyn_into().map_err(|_| "не WebGL 2")?;
  let app = App::new(glow::Context::from_webgl2_context(gl))?;
  let shell = Rc::new(RefCell::new(Shell { canvas: canvas.clone(), input: Input { focused: true, ..Default::default() }, app }));
  listen_pointer(&shell, &canvas);
  listen_keys(&shell, &canvas);
  listen_window(&shell, &window);
  if let Some(status) = document.get_element_by_id("status") {
    status.remove();
  }
  let _ = canvas.focus();
  animate(shell);
  Ok(())
}

/// Подписка на событие на всё время страницы.
fn listen<E: wasm_bindgen::convert::FromWasmAbi + 'static>(target: &EventTarget, event: &str, handler: impl FnMut(E) + 'static) {
  let closure = Closure::<dyn FnMut(E)>::new(handler);
  let _ = target.add_event_listener_with_callback(event, closure.as_ref().unchecked_ref());
  closure.forget();
}

/// Указатель в пикселях CSS от угла холста.
fn point(canvas: &HtmlCanvasElement, event: &PointerEvent) -> [f32; 2] {
  let rect = canvas.get_bounding_client_rect();
  [(event.client_x() as f64 - rect.left()) as f32, (event.client_y() as f64 - rect.top()) as f32]
}

/// Кнопка указателя: левая, правая, средняя — как BUTTONS в input.rs.
fn button(event: &PointerEvent) -> Option<usize> {
  match event.button() {
    0 => Some(0),
    2 => Some(1),
    1 => Some(2),
    _ => None,
  }
}

fn listen_pointer(shell: &Rc<RefCell<Shell>>, canvas: &HtmlCanvasElement) {
  let target: &EventTarget = canvas.as_ref();
  let moved = |shell: &mut Shell, event: &PointerEvent| {
    shell.input.pointer = Some(point(&shell.canvas, event));
    shell.input.touch = event.pointer_type() == "touch";
  };
  let s = shell.clone();
  listen(target, "pointermove", move |event: PointerEvent| moved(&mut s.borrow_mut(), &event));
  let s = shell.clone();
  listen(target, "pointerdown", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    let _ = shell.canvas.focus();
    shell.app.wake_sound();
    // Тянут за край холста — события всё равно ему.
    let _ = shell.canvas.set_pointer_capture(event.pointer_id());
    moved(&mut shell, &event);
    if let Some(index) = button(&event) {
      shell.input.button(index, true);
    }
    event.prevent_default();
  });
  let s = shell.clone();
  listen(target, "pointerup", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    moved(&mut shell, &event);
    if let Some(index) = button(&event) {
      shell.input.button(index, false);
    }
  });
  let s = shell.clone();
  listen(target, "pointercancel", move |_: PointerEvent| s.borrow_mut().input.button(0, false));
  let s = shell.clone();
  listen(target, "pointerleave", move |event: PointerEvent| {
    // У касания нет наведения: палец убрали — указателя нет.
    if event.pointer_type() != "touch" || !s.borrow().input.down[0] {
      s.borrow_mut().input.pointer = None;
    }
  });
  // Колесо — в строках, вверх больше нуля; щелчок колеса — 40 пикселей, как у нативной оболочки.
  let s = shell.clone();
  listen(target, "wheel", move |event: WheelEvent| {
    event.prevent_default();
    let lines = match event.delta_mode() {
      WheelEvent::DOM_DELTA_LINE => -event.delta_y(),
      WheelEvent::DOM_DELTA_PAGE => -event.delta_y() * 20.0,
      _ => -event.delta_y() / 40.0,
    };
    s.borrow_mut().input.wheel += lines as f32;
  });
  listen(target, "contextmenu", move |event: web_sys::Event| event.prevent_default());
}

/// Имя клавиши — как у нативной оболочки (shell.rs, key_name): буквы и цифры по месту на клавиатуре, остальное — по
/// смыслу.
fn key_name(event: &KeyboardEvent) -> Option<String> {
  let code = event.code();
  if let Some(letter) = code.strip_prefix("Key") {
    return Some(letter.to_lowercase());
  }
  // Цифры и над буквами, и на цифровом блоке.
  if let Some(digit) = code.strip_prefix("Digit").or_else(|| code.strip_prefix("Numpad").filter(|rest| rest.len() == 1 && rest.chars().all(|ch| ch.is_ascii_digit()))) {
    return Some(digit.to_string());
  }
  let named = match code.as_str() {
    "ArrowLeft" => "left",
    "ArrowRight" => "right",
    "ArrowUp" => "up",
    "ArrowDown" => "down",
    "Space" => "space",
    "Escape" => "escape",
    "Enter" | "NumpadEnter" => "enter",
    "Tab" => "tab",
    "Backspace" => "backspace",
    "Delete" => "delete",
    "Home" => "home",
    "End" => "end",
    "ShiftLeft" | "ShiftRight" => "shift",
    "ControlLeft" | "ControlRight" => "ctrl",
    "AltLeft" | "AltRight" => "alt",
    "MetaLeft" | "MetaRight" => "meta",
    "Minus" => "-",
    "Equal" => "=",
    "Slash" | "NumpadDivide" => "/",
    _ => "",
  };
  if !named.is_empty() {
    return Some(named.to_string());
  }
  if let Some(number) = code.strip_prefix('F').and_then(|rest| rest.parse::<u8>().ok()) {
    return Some(format!("f{number}"));
  }
  let key = event.key();
  (!key.is_empty()).then(|| key.to_lowercase())
}

fn listen_keys(shell: &Rc<RefCell<Shell>>, canvas: &HtmlCanvasElement) {
  let target: &EventTarget = canvas.as_ref();
  for (name, down) in [("keydown", true), ("keyup", false)] {
    let s = shell.clone();
    listen(target, name, move |event: KeyboardEvent| {
      let mut shell = s.borrow_mut();
      shell.app.wake_sound();
      if let Some(key) = key_name(&event) {
        shell.input.key(&key, down, event.repeat());
      }
      let typed = event.key();
      if down && typed.chars().count() == 1 && !event.ctrl_key() && !event.meta_key() {
        shell.input.text.extend(typed.chars().filter(|char| !char.is_control()));
      }
      // Клавиши игры странице не нужны (прокрутка пробелом и стрелками, Tab), а сочетания браузера — его.
      if !event.ctrl_key() && !event.meta_key() {
        event.prevent_default();
      }
    });
  }
}

fn listen_window(shell: &Rc<RefCell<Shell>>, window: &web_sys::Window) {
  let target: &EventTarget = window.as_ref();
  let s = shell.clone();
  listen(target, "focus", move |_: web_sys::FocusEvent| s.borrow_mut().input.focused = true);
  let s = shell.clone();
  listen(target, "blur", move |_: web_sys::FocusEvent| {
    // Ушли со страницы — зажатые клавиши и кнопки здесь уже не отпустят.
    let mut shell = s.borrow_mut();
    shell.input.focused = false;
    shell.input.keys.clear();
    shell.input.down = [false; 3];
  });
  // Уходят со страницы — партия слота записывается.
  let s = shell.clone();
  listen(target, "pagehide", move |_: web_sys::Event| s.borrow_mut().app.save());
}

/// Кадр за кадром по `requestAnimationFrame`.
fn animate(shell: Rc<RefCell<Shell>>) {
  type Frame = Rc<RefCell<Option<Closure<dyn FnMut(f64)>>>>;
  let frame: Frame = Rc::new(RefCell::new(None));
  let next = frame.clone();
  *frame.borrow_mut() = Some(Closure::new(move |_: f64| {
    if let Err(error) = shell.borrow_mut().frame() {
      show(&format!("Kharos остановился: {error}"));
      web_sys::console::error_1(&error.into());
      return;
    }
    if let (Some(window), Some(callback)) = (web_sys::window(), next.borrow().as_ref()) {
      let _ = window.request_animation_frame(callback.as_ref().unchecked_ref());
    }
  }));
  let first = frame.borrow();
  if let (Some(window), Some(callback)) = (web_sys::window(), first.as_ref()) {
    let _ = window.request_animation_frame(callback.as_ref().unchecked_ref());
  }
}

impl Shell {
  fn frame(&mut self) -> Result<(), String> {
    let window = web_sys::window().ok_or("нет окна")?;
    let scale = window.device_pixel_ratio() as f32;
    // Буфер холста — в пикселях экрана: размер на странице на их число в пикселе CSS.
    let (width, height) = (self.canvas.client_width().max(1) as f32, self.canvas.client_height().max(1) as f32);
    let size = [(width * scale).round() as u32, (height * scale).round() as u32];
    if self.canvas.width() != size[0] || self.canvas.height() != size[1] {
      self.canvas.set_width(size[0]);
      self.canvas.set_height(size[1]);
    }
    self.input.scale = scale;
    self.input.screen = [width, height];
    self.input.time = crate::clock::seconds();
    self.app.frame(&self.input, size)?;
    self.input.end_frame();
    Ok(())
  }
}
