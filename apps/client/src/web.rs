//! Оболочка в браузере (wasm32, web-sys): холст `#canvas`, WebGL 2 через glow, события страницы в `Input`, кадр по
//! `requestAnimationFrame`. Невидимый `#keyboard` связывает поля интерфейса с экранной клавиатурой, IME и буфером.
//! Сборка — trunk (apps/client/web/index.html), моды зашиты в неё (build.rs).

use crate::input::{Input, TextEdit, TouchInput};
use crate::App;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast as _;
use web_sys::{EventTarget, HtmlCanvasElement, HtmlInputElement, KeyboardEvent, PointerEvent, WebGl2RenderingContext, WheelEvent};

struct Shell {
  canvas: HtmlCanvasElement,
  keyboard: HtmlInputElement,
  keyboard_id: Option<String>,
  composing: bool,
  input: Input,
  touches: TouchInput,
  app: App,
  /// Палец убрали: указатель снимается после кадра — иначе касание, отпущенное до кадра, не попадёт в кнопку.
  lifted: bool,
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
  let keyboard: HtmlInputElement = document.get_element_by_id("keyboard").ok_or("нет <input id=\"keyboard\">")?.dyn_into().map_err(|_| "#keyboard — не поле ввода")?;
  let options = js_sys::Object::new();
  for (key, value) in [("alpha", true), ("antialias", false), ("depth", false), ("premultipliedAlpha", true), ("preserveDrawingBuffer", true)] {
    let _ = js_sys::Reflect::set(&options, &key.into(), &value.into());
  }
  let gl: WebGl2RenderingContext = canvas.get_context_with_context_options("webgl2", &options).map_err(|error| format!("{error:?}"))?.ok_or("нет WebGL 2")?.dyn_into().map_err(|_| "не WebGL 2")?;
  let app = App::new(glow::Context::from_webgl2_context(gl))?;
  let shell = Rc::new(RefCell::new(Shell { canvas: canvas.clone(), keyboard: keyboard.clone(), keyboard_id: None, composing: false, input: Input { focused: true, ..Default::default() }, touches: TouchInput::default(), app, lifted: false }));
  listen_pointer(&shell, &canvas);
  listen_keys(&shell, &canvas);
  listen_keyboard(&shell, &keyboard);
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
  let s = shell.clone();
  listen(target, "pointermove", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    let at = point(&shell.canvas, &event);
    if event.pointer_type() == "touch" {
      let (touches, input) = {
        let shell = &mut *shell;
        (&mut shell.touches, &mut shell.input)
      };
      touches.moved(input, event.pointer_id(), at);
      event.prevent_default();
    } else {
      shell.input.pointer = Some(at);
      shell.input.touch = false;
    }
  });
  let s = shell.clone();
  listen(target, "pointerdown", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    shell.app.wake_sound();
    // Тянут за край холста — события всё равно ему.
    let _ = shell.canvas.set_pointer_capture(event.pointer_id());
    shell.lifted = false;
    let at = point(&shell.canvas, &event);
    // На iOS клавиатура открывается только при фокусе непосредственно в событии касания, не в следующем кадре.
    if event.button() == 0 && shell.touches.is_empty() && shell.app.text_input_at(at) {
      let _ = shell.keyboard.focus();
    } else {
      let _ = shell.canvas.focus();
    }
    if event.pointer_type() == "touch" {
      let (touches, input) = {
        let shell = &mut *shell;
        (&mut shell.touches, &mut shell.input)
      };
      touches.down(input, event.pointer_id(), at);
    } else {
      shell.input.pointer = Some(at);
      shell.input.touch = false;
      if let Some(index) = button(&event) {
        shell.input.button(index, true);
      }
    }
    event.prevent_default();
  });
  let s = shell.clone();
  listen(target, "pointerup", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    let at = point(&shell.canvas, &event);
    if event.pointer_type() == "touch" {
      let (touches, input) = {
        let shell = &mut *shell;
        (&mut shell.touches, &mut shell.input)
      };
      touches.up(input, event.pointer_id(), at);
      shell.lifted = shell.touches.is_empty();
    } else {
      shell.input.pointer = Some(at);
      shell.input.touch = false;
      if let Some(index) = button(&event) {
        shell.input.button(index, false);
      }
    }
    event.prevent_default();
  });
  let s = shell.clone();
  listen(target, "pointercancel", move |event: PointerEvent| {
    let mut shell = s.borrow_mut();
    let at = point(&shell.canvas, &event);
    if event.pointer_type() == "touch" {
      let (touches, input) = {
        let shell = &mut *shell;
        (&mut shell.touches, &mut shell.input)
      };
      touches.up(input, event.pointer_id(), at);
      shell.lifted = shell.touches.is_empty();
    } else {
      shell.input.button(0, false);
    }
    event.prevent_default();
  });
  let s = shell.clone();
  listen(target, "pointerleave", move |event: PointerEvent| {
    // У касания нет наведения: палец убрали — указателя нет, но уже после кадра (pointerleave идёт сразу за pointerup).
    let mut shell = s.borrow_mut();
    if event.pointer_type() != "touch" {
      shell.input.pointer = None;
    } else if shell.touches.is_empty() {
      shell.lifted = true;
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
  for name in ["contextmenu", "selectstart", "dragstart", "gesturestart", "gesturechange"] {
    listen(target, name, move |event: web_sys::Event| event.prevent_default());
  }
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

/// DOM возвращает позиции выделения в единицах UTF-16, а редактор интерфейса считает знаки Unicode.
fn character_index(text: &str, units: u32) -> usize {
  let mut used = 0;
  for (index, char) in text.chars().enumerate() {
    if used >= units {
      return index;
    }
    used += char.len_utf16() as u32;
  }
  text.chars().count()
}

fn read_keyboard(shell: &mut Shell) {
  let Some(id) = shell.keyboard_id.clone() else { return };
  let value = shell.keyboard.value();
  let start = shell.keyboard.selection_start().ok().flatten().unwrap_or(u32::MAX);
  let end = shell.keyboard.selection_end().ok().flatten().unwrap_or(u32::MAX);
  shell.input.edit = Some(TextEdit { id, caret: character_index(&value, end), anchor: character_index(&value, start), value });
}

fn listen_keyboard(shell: &Rc<RefCell<Shell>>, keyboard: &HtmlInputElement) {
  let target: &EventTarget = keyboard.as_ref();
  for name in ["input", "selectionchange"] {
    let s = shell.clone();
    listen(target, name, move |_: web_sys::Event| read_keyboard(&mut s.borrow_mut()));
  }
  let s = shell.clone();
  listen(target, "compositionstart", move |_: web_sys::Event| s.borrow_mut().composing = true);
  let s = shell.clone();
  listen(target, "compositionend", move |_: web_sys::Event| {
    let mut shell = s.borrow_mut();
    shell.composing = false;
    read_keyboard(&mut shell);
  });
  for (name, down) in [("keydown", true), ("keyup", false)] {
    let s = shell.clone();
    listen(target, name, move |event: KeyboardEvent| {
      let mut shell = s.borrow_mut();
      shell.app.wake_sound();
      let Some(key) = key_name(&event).filter(|key| matches!(key.as_str(), "enter" | "escape" | "tab" | "up" | "down")) else { return };
      shell.input.key(&key, down, event.repeat());
      event.prevent_default();
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
    let (touches, input) = {
      let shell = &mut *shell;
      (&mut shell.touches, &mut shell.input)
    };
    touches.clear(input);
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
  fn sync_keyboard(&mut self) {
    if self.composing {
      return;
    }
    let Some(state) = self.app.text_input() else {
      if self.keyboard_id.take().is_some() {
        let _ = self.keyboard.blur();
        self.keyboard.set_value("");
      }
      return;
    };
    let changed = self.keyboard_id.as_deref() != Some(&state.id);
    if changed {
      self.keyboard_id = Some(state.id.clone());
      let _ = self.keyboard.set_type(if state.password { "password" } else { "text" });
      let _ = self.keyboard.set_attribute("inputmode", if state.digits { "numeric" } else { "text" });
      let _ = self.keyboard.set_attribute("enterkeyhint", "done");
      // Обычно поле уже в фокусе после pointerdown; это также нужно полям, открытым скриптом панели.
      let _ = self.keyboard.focus();
    }
    if self.keyboard.value() != state.value {
      self.keyboard.set_value(&state.value);
    }
    let units = |caret: usize| state.value.chars().take(caret).map(|char| char.len_utf16() as u32).sum::<u32>();
    let (anchor, caret) = (units(state.anchor), units(state.caret));
    let current = (self.keyboard.selection_start().ok().flatten(), self.keyboard.selection_end().ok().flatten());
    if changed || current != (Some(anchor), Some(caret)) {
      let _ = self.keyboard.set_selection_range(anchor, caret);
    }
  }

  fn frame(&mut self) -> Result<(), String> {
    let window = web_sys::window().ok_or("нет окна")?;
    let ratio = window.device_pixel_ratio() as f32;
    // На телефоне полный DPR 3× стоит девять пикселей на один CSS-пиксель. 1,5× сохраняет чёткость и вчетверо
    // уменьшает работу GPU по площади; логический размер интерфейса не меняется.
    let scale = if window.navigator().max_touch_points() > 0 { ratio.min(1.5) } else { ratio };
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
    self.sync_keyboard();
    self.touches.end_frame(&mut self.input);
    self.input.end_frame();
    if std::mem::take(&mut self.lifted) {
      self.input.pointer = None;
    }
    Ok(())
  }
}
