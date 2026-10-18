//! Общее для замеров (docs/content.md): холст чертежа, машина Luau и загрузка видов из `base/`.

use mlua::{Lua, Table, UserData, UserDataMethods};

/// Полный оборот в радианах.
pub const TURN: f64 = std::f64::consts::PI * 2.0;

/// Машина Luau для контента: уровень оптимизации 2, песочница — глобальные таблицы только для чтения, тогда `math` и
/// `buffer` идут быстрым путём встроенных функций (без неё — в 16 раз медленнее). native — машинный код Luau.
pub fn new_lua(native: bool) -> mlua::Result<Lua> {
  let lua = Lua::new();
  lua.enable_jit(native)?;
  lua.set_compiler(mlua::Compiler::new().set_optimization_level(2));
  lua.sandbox(true)?;
  Ok(lua)
}

/// Вид из папки мода `base`.
pub fn load(lua: &Lua, path: &str) -> mlua::Result<Table> {
  let source = std::fs::read_to_string(format!("{}/base/{path}", env!("CARGO_MANIFEST_DIR"))).expect(path);
  lua.load(source).set_name(path).eval()
}


pub fn bytes(column: &[f64]) -> Vec<u8> {
  column.iter().flat_map(|value| value.to_le_bytes()).collect()
}

pub fn floats(bytes: &[u8]) -> Vec<f64> {
  bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect()
}

/// Холст чертежа: векторные фигуры, пиксель закрашивается, если в фигуру попал его центр (как Pixmap в клиенте).
pub struct Pixmap {
  pub size: usize,
  pub data: Vec<u32>,
}

impl Pixmap {
  fn fill(&mut self, color: u32, inside: impl Fn(f64, f64) -> bool) {
    let half = self.size as f64 / 2.0;
    for py in 0..self.size {
      for px in 0..self.size {
        if inside(px as f64 + 0.5 - half, py as f64 + 0.5 - half) {
          self.data[py * self.size + px] = color;
        }
      }
    }
  }
}

impl UserData for Pixmap {
  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method_mut("circle", |_, image, (x, y, radius, color): (f64, f64, f64, u32)| {
      image.fill(color, |px, py| (px - x).powi(2) + (py - y).powi(2) <= radius * radius);
      Ok(())
    });
    methods.add_method_mut("line", |_, image, (ax, ay, bx, by, width, color): (f64, f64, f64, f64, f64, u32)| {
      let (dx, dy) = (bx - ax, by - ay);
      let length = dx * dx + dy * dy;
      image.fill(color, |px, py| {
        let t = if length > 0.0 { (((px - ax) * dx + (py - ay) * dy) / length).clamp(0.0, 1.0) } else { 0.0 };
        (px - ax - dx * t).powi(2) + (py - ay - dy * t).powi(2) <= (width / 2.0).powi(2)
      });
      Ok(())
    });
    // Цвет стороны с меткой тона: шейдер перекрасит его палитрой.
    methods.add_method("team", |_, _, tone: u32| Ok(0x5aa9ff + (tone + 1) * 0x1000000));
  }
}
