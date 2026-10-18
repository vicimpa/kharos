//! Ввод за кадр, не зависящий от платформы: оболочка заполняет его событиями окна.

use std::collections::BTreeSet;

/// Кнопки указателя: левая, правая, средняя.
pub const BUTTONS: [&str; 3] = ["left", "right", "middle"];

#[derive(Default, Clone)]
pub struct Input {
  /// Секунды с запуска.
  pub time: f64,
  /// Экран в логических пикселях.
  pub screen: [f32; 2],
  /// Физических пикселей на логический.
  pub scale: f32,
  /// Указатель (мышь или первое касание) в логических пикселях.
  pub pointer: Option<[f32; 2]>,
  pub down: [bool; 3],
  /// Нажаты и отпущены с прошлого кадра.
  pub pressed: [bool; 3],
  pub released: [bool; 3],
  /// Колесо с прошлого кадра: строк, вверх — больше нуля.
  pub wheel: f32,
  /// Зажатые клавиши — по именам: "a", "1", "shift", "left", "escape", "f1".
  pub keys: BTreeSet<String>,
  /// Нажатые с прошлого кадра.
  pub hits: Vec<String>,
  /// Нажатия с прошлого кадра вместе с повторами зажатой клавиши — для правки текста.
  pub presses: Vec<String>,
  pub text: String,
  /// Окно в фокусе: без него края экрана камеру не двигают.
  pub focused: bool,
  /// Последним указателем было касание, а не мышь.
  pub touch: bool,
}

impl Input {
  pub fn button(&mut self, index: usize, down: bool) {
    if down && !self.down[index] {
      self.pressed[index] = true;
    }
    if !down && self.down[index] {
      self.released[index] = true;
    }
    self.down[index] = down;
  }

  pub fn key(&mut self, name: &str, down: bool, repeat: bool) {
    if down {
      self.presses.push(name.to_string());
      if !repeat {
        self.hits.push(name.to_string());
      }
      self.keys.insert(name.to_string());
    } else {
      self.keys.remove(name);
    }
  }

  /// Конец кадра: события сбрасываются, состояния остаются.
  pub fn end_frame(&mut self) {
    self.pressed = [false; 3];
    self.released = [false; 3];
    self.wheel = 0.0;
    self.hits.clear();
    self.presses.clear();
    self.text.clear();
  }
}
