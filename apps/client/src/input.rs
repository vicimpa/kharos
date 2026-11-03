//! Ввод за кадр, не зависящий от платформы: оболочка заполняет его событиями окна.

use std::collections::{BTreeMap, BTreeSet};

/// Кнопки указателя: левая, правая, средняя.
pub const BUTTONS: [&str; 3] = ["left", "right", "middle"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pinch {
  /// Во сколько раз разошлись или сошлись пальцы с прошлого кадра.
  pub scale: f32,
  /// Середина между пальцами и её сдвиг с прошлого кадра, в логических пикселях.
  pub center: [f32; 2],
  pub delta: [f32; 2],
}

/// Полная правка из браузерного поля: текст и выделение в знаках Unicode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
  pub id: String,
  pub value: String,
  pub caret: usize,
  pub anchor: usize,
}

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
  /// Жест двух первых пальцев с прошлого кадра.
  pub pinch: Option<Pinch>,
  /// Два пальца или конец такого жеста: одиночные клики подавлены, пока все пальцы не убрали.
  pub multitouch: bool,
  /// Зажатые клавиши — по именам: "a", "1", "shift", "left", "escape", "f1".
  pub keys: BTreeSet<String>,
  /// Нажатые с прошлого кадра.
  pub hits: Vec<String>,
  /// Нажатия с прошлого кадра вместе с повторами зажатой клавиши — для правки текста.
  pub presses: Vec<String>,
  pub text: String,
  pub edit: Option<TextEdit>,
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
    self.pinch = None;
    self.hits.clear();
    self.presses.clear();
    self.text.clear();
    self.edit = None;
  }
}

/// Раскладывает касания по пальцам. Первый остаётся обычной левой кнопкой; второй отменяет её и начинает жест камеры.
#[derive(Default)]
pub struct TouchInput {
  points: BTreeMap<i32, [f32; 2]>,
  primary: Option<i32>,
  pair: Option<([f32; 2], f32)>,
  multi: bool,
}

impl TouchInput {
  fn measure(&self) -> Option<([f32; 2], f32)> {
    let mut points = self.points.values();
    let a = *points.next()?;
    let b = *points.next()?;
    Some(([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0], (a[0] - b[0]).hypot(a[1] - b[1])))
  }

  pub fn down(&mut self, input: &mut Input, id: i32, point: [f32; 2]) {
    if self.points.is_empty() {
      self.multi = false;
      input.multitouch = false;
    }
    self.points.insert(id, point);
    input.touch = true;
    input.pointer = Some(point);
    if self.multi || self.points.len() > 1 {
      if !self.multi {
        input.button(0, false);
      }
      self.multi = true;
      input.multitouch = true;
      self.primary = None;
      self.pair = self.measure();
      if let Some((center, _)) = self.pair {
        input.pointer = Some(center);
      }
    } else {
      self.primary = Some(id);
      input.button(0, true);
    }
  }

  pub fn moved(&mut self, input: &mut Input, id: i32, point: [f32; 2]) {
    if !self.points.contains_key(&id) {
      return;
    }
    self.points.insert(id, point);
    input.touch = true;
    if self.multi {
      let next = self.measure();
      if let (Some((previous, old_distance)), Some((center, distance))) = (self.pair, next) {
        let pinch = input.pinch.get_or_insert(Pinch { scale: 1.0, center, delta: [0.0, 0.0] });
        if old_distance > 0.0 && distance > 0.0 {
          pinch.scale *= distance / old_distance;
        }
        pinch.center = center;
        pinch.delta[0] += center[0] - previous[0];
        pinch.delta[1] += center[1] - previous[1];
        input.pointer = Some(center);
      }
      self.pair = next;
    } else if self.primary == Some(id) {
      input.pointer = Some(point);
    }
  }

  pub fn up(&mut self, input: &mut Input, id: i32, point: [f32; 2]) {
    if !self.points.contains_key(&id) {
      return;
    }
    self.points.remove(&id);
    input.touch = true;
    input.pointer = Some(point);
    if self.multi {
      self.pair = self.measure();
      if let Some((center, _)) = self.pair {
        input.pointer = Some(center);
      } else if let Some(point) = self.points.values().next() {
        input.pointer = Some(*point);
      }
    } else if self.primary == Some(id) {
      self.primary = None;
      input.button(0, false);
    }
  }

  /// Конец кадра: после последнего пальца следующий жест снова может быть одиночным.
  pub fn end_frame(&mut self, input: &mut Input) {
    if self.points.is_empty() {
      self.multi = false;
      self.primary = None;
      self.pair = None;
    }
    input.multitouch = self.multi;
  }

  /// Потеря фокуса: отпустить всё, не дожидаясь событий ушедших пальцев.
  pub fn clear(&mut self, input: &mut Input) {
    self.points.clear();
    self.primary = None;
    self.pair = None;
    self.multi = false;
    input.multitouch = false;
    input.button(0, false);
  }

  #[cfg(target_arch = "wasm32")]
  pub fn is_empty(&self) -> bool {
    self.points.is_empty()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn one_finger_is_a_click() {
    let mut input = Input::default();
    let mut touches = TouchInput::default();
    touches.down(&mut input, 7, [10.0, 20.0]);
    assert!(input.pressed[0]);
    touches.moved(&mut input, 7, [12.0, 24.0]);
    touches.up(&mut input, 7, [12.0, 24.0]);
    assert!(input.released[0]);
    assert_eq!(input.pointer, Some([12.0, 24.0]));
  }

  #[test]
  fn second_finger_cancels_click_and_measures_pinch() {
    let mut input = Input::default();
    let mut touches = TouchInput::default();
    touches.down(&mut input, 1, [100.0, 100.0]);
    touches.down(&mut input, 2, [200.0, 100.0]);
    assert!(input.multitouch);
    assert!(input.released[0]);
    assert!(!input.down[0]);
    input.end_frame();
    touches.moved(&mut input, 1, [70.0, 90.0]);
    touches.moved(&mut input, 2, [230.0, 110.0]);
    let pinch = input.pinch.expect("щипок");
    assert!((pinch.scale - 160.0f32.hypot(20.0) / 100.0).abs() < 0.001);
    assert_eq!(pinch.center, [150.0, 100.0]);
    assert_eq!(pinch.delta, [0.0, 0.0]);
    touches.up(&mut input, 1, [70.0, 90.0]);
    touches.up(&mut input, 2, [230.0, 110.0]);
    assert!(input.multitouch);
    touches.end_frame(&mut input);
    assert!(!input.multitouch);
    assert!(!input.released[0]);
  }
}
