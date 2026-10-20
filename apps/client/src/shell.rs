//! Оболочка на нативе: окно winit, контекст GL 3.3 core (или GLES 3) от glutin, события в `Input`, кадр за кадром с
//! вертикальной синхронизацией.
//!
//! KHAROS_SHOT=кадр.png — снять кадр после KHAROS_SHOT_FRAMES кадров (по умолчанию 120) и выйти: так картинку
//! проверяют без человека у окна. KHAROS_SHOT_POINTER=x,y — указатель там, в логических пикселях (подсказки,
//! наведение), пока снимается кадр. KHAROS_SHOT_CLICKS=кадр:x,y;кадр:x,y — щелчки левой кнопкой на этих кадрах; после
//! «кадр:текст» вместо места — набор текста (`20:t=Карта`), «кадр:k=enter» — нажатие клавиши.
//!
//! `--scenario путь.luau` — режим сценария (scenario.rs): окно невидимо, время — по кадрам, ввод — от сценария.

use crate::input::Input;
use crate::scenario::{self, Scenario};
use crate::{App, AppOptions};
use glutin::config::{Config, ConfigTemplateBuilder};
use glutin::context::{ContextApi, ContextAttributesBuilder, GlProfile, NotCurrentGlContext as _, PossiblyCurrentContext, Version};
use glutin::display::{GetGlDisplay as _, GlDisplay as _};
use glutin::surface::{GlSurface as _, Surface, SwapInterval, WindowSurface};
use glutin_winit::{DisplayBuilder, GlWindow as _};
use raw_window_handle::HasWindowHandle as _;
use std::num::NonZeroU32;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};
use winit::window::{Window, WindowId};

struct Gl {
  window: Window,
  surface: Surface<WindowSurface>,
  context: PossiblyCurrentContext,
}

struct Shell {
  input: Input,
  gl: Option<Gl>,
  app: Option<App>,
  /// Снимок кадра: куда и через сколько кадров.
  shot: Option<(String, u32)>,
  frames: u32,
  /// Когда рисовали прошлый кадр: предел кадров (graphics.fps) ждёт до следующего срока.
  drawn: Option<std::time::Instant>,
  /// Режим сценария и видно ли окно.
  scenario: Option<Scenario>,
  visible: bool,
  /// Код выхода процесса: итог сценария.
  code: i32,
}

pub fn run() {
  let shot = std::env::var("KHAROS_SHOT").ok().map(|path| (path, std::env::var("KHAROS_SHOT_FRAMES").ok().and_then(|frames| frames.parse().ok()).unwrap_or(120)));
  let options = scenario::options();
  let mut visible = true;
  let scenario = match &options {
    Some(options) => {
      visible = options.show;
      // Настройки и сохранения сценария — не игрока: во временной папке, если не задано иное.
      if std::env::var_os("KHAROS_CONFIG").is_none() {
        let dir = std::env::temp_dir().join(format!("kharos-scenario-{}", std::process::id()));
        // SAFETY: потоков ещё нет — окружение меняется до запуска чего-либо.
        unsafe { std::env::set_var("KHAROS_CONFIG", &dir) };
      }
      match Scenario::new(options) {
        Ok(scenario) => Some(scenario),
        Err(error) => {
          eprintln!("сценарий: {error}");
          std::process::exit(1);
        }
      }
    }
    None => None,
  };
  let mut shell = Shell { input: Input { focused: true, ..Default::default() }, gl: None, app: None, shot, frames: 0, drawn: None, scenario, visible, code: 0 };
  let event_loop = EventLoop::new().expect("цикл событий");
  if let Err(error) = event_loop.run_app(&mut shell) {
    eprintln!("цикл событий: {error}");
  }
  if shell.scenario.is_some() {
    std::process::exit(shell.code);
  }
}

fn create_gl(event_loop: &ActiveEventLoop, visible: bool) -> Result<(Gl, glow::Context), String> {
  let attributes = Window::default_attributes().with_visible(visible).with_title("Kharos").with_inner_size(LogicalSize::new(1280.0, 800.0)).with_min_inner_size(LogicalSize::new(480.0, 360.0));
  let template = ConfigTemplateBuilder::new().with_alpha_size(8);
  let (window, config) = DisplayBuilder::new().with_window_attributes(Some(attributes)).build(event_loop, template, |mut configs| configs.next().expect("настройка GL")).map_err(|error| error.to_string())?;
  let window = window.ok_or("нет окна")?;
  let context = create_context(&window, &config)?;
  let surface_attributes = window.build_surface_attributes(Default::default()).map_err(|error| error.to_string())?;
  let display = config.display();
  let surface = unsafe { display.create_window_surface(&config, &surface_attributes) }.map_err(|error| error.to_string())?;
  let context = context.make_current(&surface).map_err(|error| error.to_string())?;
  if let Err(error) = surface.set_swap_interval(&context, SwapInterval::Wait(NonZeroU32::MIN)) {
    eprintln!("вертикальной синхронизации нет: {error}");
  }
  let gl = unsafe { glow::Context::from_loader_function_cstr(|name| display.get_proc_address(name)) };
  Ok((Gl { window, surface, context }, gl))
}

fn create_context(window: &Window, config: &Config) -> Result<glutin::context::NotCurrentContext, String> {
  let handle = window.window_handle().ok().map(|handle| handle.as_raw());
  let display = config.display();
  let desktop = ContextAttributesBuilder::new().with_profile(GlProfile::Core).with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3)))).build(handle);
  let gles = ContextAttributesBuilder::new().with_context_api(ContextApi::Gles(Some(Version::new(3, 0)))).build(handle);
  unsafe { display.create_context(config, &desktop).or_else(|_| display.create_context(config, &gles)).map_err(|error| format!("нет контекста GL 3.3 или GLES 3: {error}")) }
}

impl ApplicationHandler for Shell {
  fn resumed(&mut self, event_loop: &ActiveEventLoop) {
    if self.gl.is_some() {
      return;
    }
    let (gl, context) = match create_gl(event_loop, self.visible) {
      Ok(pair) => pair,
      Err(error) => {
        eprintln!("GL: {error}");
        event_loop.exit();
        return;
      }
    };
    let options = match &self.scenario {
      Some(scenario) => AppOptions { sound: scenario.sound(), patient: true, seed: Some(1) },
      None => AppOptions::default(),
    };
    match App::with(context, options) {
      Ok(app) => self.app = Some(app),
      Err(error) => {
        eprintln!("{error}");
        event_loop.exit();
        return;
      }
    }
    gl.window.request_redraw();
    self.gl = Some(gl);
  }

  fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
    let Some(gl) = &self.gl else { return };
    let scale = gl.window.scale_factor() as f32;
    let input = &mut self.input;
    // Снимок со сценарием указателя: настоящая мышь и клавиатура не вмешиваются — окно открыто на чужом экране.
    let scripted = self.scenario.is_some() || (self.shot.is_some() && (std::env::var_os("KHAROS_SHOT_CLICKS").is_some() || std::env::var_os("KHAROS_SHOT_POINTER").is_some()));
    if scripted && matches!(event, WindowEvent::CursorMoved { .. } | WindowEvent::CursorLeft { .. } | WindowEvent::MouseInput { .. } | WindowEvent::MouseWheel { .. } | WindowEvent::Touch(_) | WindowEvent::KeyboardInput { .. } | WindowEvent::ModifiersChanged(_)) {
      return;
    }
    match event {
      WindowEvent::CloseRequested => {
        // Закрыли окно — партия слота успевает записаться.
        if let Some(app) = &mut self.app {
          app.save();
        }
        event_loop.exit();
      }
      WindowEvent::Resized(size) => {
        if let (Some(width), Some(height)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) {
          gl.surface.resize(&gl.context, width, height);
        }
      }
      WindowEvent::Focused(focused) => input.focused = focused,
      WindowEvent::CursorMoved { position, .. } => {
        input.pointer = Some([position.x as f32 / scale, position.y as f32 / scale]);
        input.touch = false;
      }
      WindowEvent::CursorLeft { .. } => input.pointer = None,
      WindowEvent::MouseInput { state, button, .. } => {
        let index = match button {
          MouseButton::Left => 0,
          MouseButton::Right => 1,
          MouseButton::Middle => 2,
          _ => return,
        };
        input.button(index, state == ElementState::Pressed);
      }
      WindowEvent::MouseWheel { delta, .. } => {
        input.wheel += match delta {
          MouseScrollDelta::LineDelta(_, lines) => lines,
          MouseScrollDelta::PixelDelta(pixels) => pixels.y as f32 / 40.0,
        };
      }
      // Касание — левая кнопка; щипок и долгое нажатие решает управление из мода.
      WindowEvent::Touch(touch) => {
        input.pointer = Some([touch.location.x as f32 / scale, touch.location.y as f32 / scale]);
        input.touch = true;
        match touch.phase {
          TouchPhase::Started => input.button(0, true),
          TouchPhase::Ended | TouchPhase::Cancelled => input.button(0, false),
          TouchPhase::Moved => {}
        }
      }
      WindowEvent::ModifiersChanged(modifiers) => {
        let state = modifiers.state();
        for (name, down) in [("shift", state.shift_key()), ("ctrl", state.control_key()), ("alt", state.alt_key()), ("meta", state.super_key())] {
          if down != input.keys.contains(name) {
            input.key(name, down, false);
          }
        }
      }
      WindowEvent::KeyboardInput { event, .. } => {
        let down = event.state == ElementState::Pressed;
        if let Some(name) = key_name(&event.physical_key, &event.logical_key) {
          input.key(&name, down, event.repeat);
        }
        if down {
          if let Some(text) = &event.text {
            input.text.extend(text.chars().filter(|char| !char.is_control()));
          }
        }
      }
      WindowEvent::RedrawRequested => self.redraw(event_loop),
      _ => {}
    }
  }

  fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
    let Some(gl) = &self.gl else { return };
    // Предел кадров: кадр не раньше своего срока; снимок кадра идёт без предела.
    let limit = if self.shot.is_some() || self.scenario.is_some() { None } else { self.app.as_ref().and_then(App::fps_limit) };
    if let (Some(fps), Some(drawn)) = (limit, self.drawn) {
      let due = drawn + std::time::Duration::from_secs_f64(1.0 / fps);
      if std::time::Instant::now() < due {
        event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(due));
        return;
      }
    }
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    gl.window.request_redraw();
  }
}

impl Shell {
  fn redraw(&mut self, event_loop: &ActiveEventLoop) {
    self.drawn = Some(std::time::Instant::now());
    let (Some(gl), Some(app)) = (&self.gl, &mut self.app) else { return };
    let mut size = gl.window.inner_size();
    let mut scale = gl.window.scale_factor() as f32;
    // Сценарий с --size рисует кадр в своём буфере такого размера, а не в окне.
    if let Some(scenario) = self.scenario.as_ref().filter(|scenario| scenario.size.is_some()) {
      let [width, height] = scenario.size.expect("размер");
      scale = scenario.scale;
      size = winit::dpi::PhysicalSize::new((width as f32 * scale).round() as u32, (height as f32 * scale).round() as u32);
      app.offscreen([size.width, size.height]);
    }
    if size.width == 0 || size.height == 0 {
      return;
    }
    self.input.scale = scale;
    self.input.screen = [size.width as f32 / scale, size.height as f32 / scale];
    self.input.time = match &self.scenario {
      Some(scenario) => scenario.time(),
      None => crate::clock::seconds(),
    };
    if let Some(scenario) = &mut self.scenario {
      scenario.audio_begin();
      scenario.before(app, &mut self.input);
    }
    if self.shot.is_some() {
      if let Some([x, y]) = std::env::var("KHAROS_SHOT_POINTER").ok().and_then(|value| value.split_once(',').and_then(|(x, y)| Some([x.trim().parse().ok()?, y.trim().parse().ok()?]))) {
        self.input.pointer = Some([x, y]);
      }
      // Щелчки и набор по кадрам: нажатие в своём кадре, отпускание — в следующем.
      let frame = self.frames;
      for step in std::env::var("KHAROS_SHOT_CLICKS").unwrap_or_default().split(';') {
        let Some((at, what)) = step.split_once(':') else { continue };
        let Ok(at) = at.trim().parse::<u32>() else { continue };
        if let Some(text) = what.strip_prefix("t=") {
          if at == frame {
            self.input.text.push_str(text);
          }
        } else if let Some(key) = what.strip_prefix("k=") {
          if at == frame {
            self.input.key(key, true, false);
          } else if at + 1 == frame {
            self.input.key(key, false, false);
          }
        } else if let Some((x, y)) = what.split_once(',') {
          let (Ok(x), Ok(y)) = (x.trim().parse::<f32>(), y.trim().parse::<f32>()) else { continue };
          if at == frame {
            self.input.pointer = Some([x, y]);
            self.input.button(0, true);
          } else if at + 1 == frame {
            self.input.button(0, false);
          }
        }
      }
    }
    if let Err(error) = app.frame(&self.input, [size.width, size.height]) {
      eprintln!("{error}");
      if self.scenario.is_some() {
        self.code = 1;
      }
      event_loop.exit();
      return;
    }
    self.frames += 1;
    if let Some(scenario) = &mut self.scenario {
      scenario.audio_end();
      scenario.after(app, [size.width, size.height]);
      if let Some(done) = scenario.report() {
        match done {
          Ok(()) => eprintln!("сценарий: дошёл до конца за {} кадров ({:.1} с игры)", scenario.frame, scenario.time()),
          Err(error) => {
            eprintln!("сценарий упал на кадре {}: {error}", scenario.frame);
            self.code = 1;
          }
        }
        event_loop.exit();
        return;
      }
    }
    if app.quit {
      event_loop.exit();
      return;
    }
    if let Some((path, frames)) = &self.shot {
      if self.frames >= *frames {
        app.shot(path, [size.width, size.height]);
        event_loop.exit();
        return;
      }
    }
    // Невидимому окну показывать нечего: кадр готов в буфере, а ожидание синхронизации только тормозит прогон.
    if self.visible {
      if let Err(error) = gl.surface.swap_buffers(&gl.context) {
        eprintln!("swap_buffers: {error}");
      }
    }
    self.input.end_frame();
  }
}

/// Имя клавиши: буквы и цифры — по месту на клавиатуре (не зависят от раскладки), остальное — по смыслу.
fn key_name(physical: &PhysicalKey, logical: &Key) -> Option<String> {
  if let PhysicalKey::Code(code) = physical {
    let text = format!("{code:?}");
    if let Some(letter) = text.strip_prefix("Key") {
      return Some(letter.to_lowercase());
    }
    // Цифры и над буквами, и на цифровом блоке.
    if let Some(digit) = text.strip_prefix("Digit").or_else(|| text.strip_prefix("Numpad").filter(|rest| rest.len() == 1 && rest.chars().all(|ch| ch.is_ascii_digit()))) {
      return Some(digit.to_string());
    }
    let named = match code {
      KeyCode::ArrowLeft => "left",
      KeyCode::ArrowRight => "right",
      KeyCode::ArrowUp => "up",
      KeyCode::ArrowDown => "down",
      KeyCode::Space => "space",
      KeyCode::Escape => "escape",
      KeyCode::Enter | KeyCode::NumpadEnter => "enter",
      KeyCode::Tab => "tab",
      KeyCode::Backspace => "backspace",
      KeyCode::Delete => "delete",
      KeyCode::Home => "home",
      KeyCode::End => "end",
      KeyCode::ShiftLeft | KeyCode::ShiftRight => "shift",
      KeyCode::ControlLeft | KeyCode::ControlRight => "ctrl",
      KeyCode::AltLeft | KeyCode::AltRight => "alt",
      KeyCode::SuperLeft | KeyCode::SuperRight => "meta",
      KeyCode::Minus => "-",
      KeyCode::Equal => "=",
      KeyCode::Slash | KeyCode::NumpadDivide => "/",
      _ => "",
    };
    if !named.is_empty() {
      return Some(named.to_string());
    }
    if let Some(number) = text.strip_prefix('F').and_then(|rest| rest.parse::<u8>().ok()) {
      return Some(format!("f{number}"));
    }
  }
  match logical {
    Key::Named(NamedKey::Escape) => Some("escape".into()),
    Key::Character(text) => Some(text.to_lowercase()),
    _ => None,
  }
}
