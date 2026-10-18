//! Облики видов: чертёж `look.draw(canvas, угол, фаза)` растеризуется в кадры — по одному на направление и фазу, —
//! а кадры всех обликов пакуются в один атлас, как в TS (`render/atlas.ts`). Холст — тот же, что `Pixmap` в TS: фигуры
//! без сглаживания, пиксель закрашивается, если его центр попал в фигуру, начало координат — `origin`. Цвет стороны —
//! метка тона (`canvas.toned(цвет, тон)`): альфа 254 − тон, шейдер перекрашивает такой пиксель палитрой стороны.

use mlua::{Function, Lua, Table, UserData, UserDataFields, UserDataMethods, Value};

pub const TURN: f64 = std::f64::consts::PI * 2.0;
/** Пикселей спрайта на тайл. */
pub const TILE: f32 = 16.0;

/// Холст одного кадра. Цвет — 0xRRGGBB, у цвета стороны в старшем байте тон + 1.
pub struct Canvas {
  pub width: usize,
  pub height: usize,
  pub origin: [f64; 2],
  pub data: Vec<u32>,
  /// Огни кадра: x, y, радиус, яркость — в пикселях холста от начала координат.
  pub lights: Vec<[f64; 4]>,
}

impl Canvas {
  /// Закрашивает пиксели в границах, центр которых проходит проверку inside, — ровно как `Pixmap.fill` в TS:
  /// пиксель i занимает [i, i + 1).
  fn fill(&mut self, color: u32, bounds: [f64; 4], inside: impl Fn(f64, f64) -> bool) {
    let [ox, oy] = self.origin;
    let [left, top, right, bottom] = bounds;
    let from_x = ((left + ox - 0.5).ceil() as i64).max(0);
    let to_x = (((right + ox - 0.5).ceil() as i64) - 1).min(self.width as i64 - 1);
    let from_y = ((top + oy - 0.5).ceil() as i64).max(0);
    let to_y = (((bottom + oy - 0.5).ceil() as i64) - 1).min(self.height as i64 - 1);
    for py in from_y..=to_y {
      for px in from_x..=to_x {
        if inside(px as f64 + 0.5 - ox, py as f64 + 0.5 - oy) {
          self.data[py as usize * self.width + px as usize] = color;
        }
      }
    }
  }
}

fn polygon_inside(points: &[(f64, f64)], x: f64, y: f64) -> bool {
  let mut inside = false;
  let mut j = points.len() - 1;
  for i in 0..points.len() {
    let (xi, yi) = points[i];
    let (xj, yj) = points[j];
    if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
      inside = !inside;
    }
    j = i;
  }
  inside
}

impl UserData for Canvas {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("width", |_, canvas| Ok(canvas.width));
    fields.add_field_method_get("height", |_, canvas| Ok(canvas.height));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method_mut("circle", |_, canvas, (x, y, radius, color): (f64, f64, f64, u32)| {
      canvas.fill(color, [x - radius, y - radius, x + radius, y + radius], |px, py| (px - x).powi(2) + (py - y).powi(2) <= radius.powi(2));
      Ok(())
    });
    // Окружность линией толщиной width.
    methods.add_method_mut("ring", |_, canvas, (x, y, radius, width, color): (f64, f64, f64, f64, u32)| {
      let outer = radius + width / 2.0;
      canvas.fill(color, [x - outer, y - outer, x + outer, y + outer], |px, py| ((px - x).hypot(py - y) - radius).abs() <= width / 2.0);
      Ok(())
    });
    // Отрезок толщиной width с прямыми торцами.
    methods.add_method_mut("line", |_, canvas, (ax, ay, bx, by, width, color): (f64, f64, f64, f64, f64, u32)| {
      let (dx, dy) = (bx - ax, by - ay);
      let length = dx.hypot(dy);
      if length == 0.0 {
        return Ok(());
      }
      let half = width / 2.0;
      canvas.fill(color, [ax.min(bx) - half, ay.min(by) - half, ax.max(bx) + half, ay.max(by) + half], |px, py| {
        let along = ((px - ax) * dx + (py - ay) * dy) / length;
        let across = ((px - ax) * dy - (py - ay) * dx) / length;
        along >= 0.0 && along <= length && across.abs() <= half
      });
      Ok(())
    });
    // Прямоугольник: левый верхний угол (x, y), размер w × h.
    methods.add_method_mut("rect", |_, canvas, (x, y, w, h, color): (f64, f64, f64, f64, u32)| {
      canvas.fill(color, [x, y, x + w, y + h], |_, _| true);
      Ok(())
    });
    // Многоугольник: { x1, y1, x2, y2, … }, чётно-нечётное правило.
    methods.add_method_mut("poly", |_, canvas, (coords, color): (Vec<f64>, u32)| {
      let points: Vec<(f64, f64)> = coords.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect();
      if points.len() < 3 {
        return Ok(());
      }
      let left = points.iter().map(|p| p.0).fold(f64::MAX, f64::min);
      let right = points.iter().map(|p| p.0).fold(f64::MIN, f64::max);
      let top = points.iter().map(|p| p.1).fold(f64::MAX, f64::min);
      let bottom = points.iter().map(|p| p.1).fold(f64::MIN, f64::max);
      canvas.fill(color, [left, top, right, bottom], |px, py| polygon_inside(&points, px, py));
      Ok(())
    });
    methods.add_method_mut("pixel", |_, canvas, (x, y, color): (f64, f64, u32)| {
      canvas.fill(color, [x.floor(), y.floor(), x.floor() + 1.0, y.floor() + 1.0], |_, _| true);
      Ok(())
    });
    // Пиксель кадра (px, py) от левого верхнего угла, без сдвига начала координат: 0 — пусто, иначе цвет с меткой
    // тона в старшем байте. Так чертёж читает уже нарисованное — остов обгорает по яркости своих пикселей.
    methods.add_method("get", |_, canvas, (px, py): (i64, i64)| {
      let inside = px >= 0 && py >= 0 && (px as usize) < canvas.width && (py as usize) < canvas.height;
      Ok(if inside { canvas.data[py as usize * canvas.width + px as usize] } else { 0 })
    });
    // Записывает пиксель кадра (px, py) как есть; 0 — стирает.
    methods.add_method_mut("set", |_, canvas, (px, py, color): (i64, i64, u32)| {
      if px >= 0 && py >= 0 && (px as usize) < canvas.width && (py as usize) < canvas.height {
        canvas.data[py as usize * canvas.width + px as usize] = color;
      }
      Ok(())
    });
    // Сдвиг начала координат: так на портрете рисуют турели на их местах (originX += … в portraits.ts).
    methods.add_method_mut("translate", |_, canvas, (dx, dy): (f64, f64)| {
      canvas.origin[0] += dx;
      canvas.origin[1] += dy;
      Ok(())
    });
    // Огонь кадра в точке (x, y) холста: size — радиус лампы в пикселях, level — яркость 0..1 (EmitLight в TS).
    methods.add_method_mut("light", |_, canvas, (x, y, size, level): (f64, f64, f64, f64)| {
      canvas.lights.push([x, y, size, level]);
      Ok(())
    });
    // Цвет с меткой тона tone (0 — тёмный, 1 — основной, 2 — светлый): toned в TS.
    methods.add_function("toned", |_, (color, tone): (u32, u32)| Ok(color + (tone + 1) * 0x1000000));
  }
}

/// Слой рисования: что лежит на земле (руда), наземные юниты под зданиями, летающие — над всеми. Турель — слоем выше
/// своего носителя.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Layer {
  Floor = 0,
  Ground = 1,
  Building = 3,
  Air = 5,
}

/// Огни юнита: фары (вдоль, поперёк, радиус — в пикселях спрайта) и луч.
#[derive(Clone, Debug, Default)]
pub struct Lights {
  pub lamps: Vec<[f32; 3]>,
  /// along, length, near, spread, level.
  pub beam: Option<[f32; 5]>,
}

/// Облик вида.
pub struct Look {
  pub proto: u32,
  /// Кадр в пикселях.
  pub size: [usize; 2],
  /// Левый верхний угол кадра от места сущности, в тайлах.
  pub offset: [f32; 2],
  pub directions: usize,
  pub phases: usize,
  /// Кадры до упаковки (RGBA), потом — их место в атласе (u0, v0, u1, v1).
  pub images: Vec<Vec<u8>>,
  pub cells: Vec<[f32; 4]>,
  /// Огни каждого кадра: смещение от места сущности в тайлах, радиус в пикселях, яркость.
  pub frame_lights: Vec<Vec<[f32; 4]>>,
  /// Кадров в секунду анимации (у зданий и всего, что анимируется всегда); у ходовых — тайлов пути на кадр.
  pub fps: f32,
  pub step: Option<f32>,
  pub layer: Layer,
  /// Тень: сдвиг в тайлах и непрозрачность.
  pub shadow: [f32; 2],
  /// Видно, где разведано, а не только в обзоре (руда: она не уходит, и её помнят).
  pub memory: bool,
  pub lights: Lights,
  /// Таблица `look` — звук и прочее берутся из неё по ходу.
  pub table: Table,
  /// Направление кадра значка.
  pub icon: usize,
  /// Портрет для панелей: обрезанная по краям картинка (RGBA, размер) — до упаковки, потом её место в атласе.
  pub portrait: Option<(Vec<u8>, [usize; 2])>,
  pub portrait_uv: Option<[f32; 4]>,
  pub portrait_size: [f32; 2],
  /// Картинка из файла мода, а не чертёж: рисуется гладко, с прозрачностью, без цвета стороны.
  pub picture: bool,
  /// Вторая половина кадров — работа (`working`): без `c:dress(e, { working = true })` идёт первая.
  pub working: bool,
}

impl Look {
  /// Кадр направления angle (радианы) в фазе phase.
  pub fn cell(&self, angle: f64, phase: usize) -> usize {
    let direction = if self.directions <= 1 { 0 } else { (angle / TURN * self.directions as f64).round().rem_euclid(self.directions as f64) as usize };
    (phase % self.phases.max(1)) * self.directions + direction
  }

  /// Размер кадра в тайлах.
  pub fn tiles(&self) -> [f32; 2] {
    [self.size[0] as f32 / TILE, self.size[1] as f32 / TILE]
  }
}

fn numbers<const N: usize>(table: &Table) -> mlua::Result<[f32; N]> {
  let mut out = [0.0; N];
  for (i, slot) in out.iter_mut().enumerate() {
    *slot = table.get::<f32>(i + 1)?;
  }
  Ok(out)
}

fn pair(table: &Table, key: &str, default: [f64; 2]) -> mlua::Result<[f64; 2]> {
  Ok(match table.get::<Value>(key)? {
    Value::Table(pair) => [pair.get(1)?, pair.get(2)?],
    Value::Integer(n) => [n as f64; 2],
    Value::Number(n) => [n; 2],
    _ => default,
  })
}

/// Растеризует облик вида proto (таблица `look`):
///
/// - `size` — кадр в пикселях: число (квадрат) или `{ w, h }`, по умолчанию 32;
/// - `origin` — начало координат чертежа в кадре, по умолчанию центр;
/// - `anchor` — точка чертежа, которая стоит на месте сущности, по умолчанию начало координат;
/// - `directions`, `phases`, `fps`, `step` (тайлов пути на кадр хода), `layer` ("ground", "building", "air"),
///   `shadow = { сдвиг в пикселях, непрозрачность }`, `lights`, `icon`.
pub fn build(lua: &Lua, proto: u32, look: Table) -> mlua::Result<Look> {
  let draw: Function = look.get("draw")?;
  let [width, height] = pair(&look, "size", [32.0, 32.0])?.map(|value| value as usize);
  let origin = pair(&look, "origin", [width as f64 / 2.0, height as f64 / 2.0])?;
  let anchor = pair(&look, "anchor", [0.0, 0.0])?;
  let directions: usize = look.get::<Option<usize>>("directions")?.unwrap_or(1).max(1);
  let phases: usize = look.get::<Option<usize>>("phases")?.unwrap_or(1).max(1);
  let mut images = Vec::new();
  let mut frame_lights = Vec::new();
  for phase in 0..phases {
    for direction in 0..directions {
      let canvas = lua.create_userdata(Canvas { width, height, origin, data: vec![0; width * height], lights: Vec::new() })?;
      draw.call::<()>((&canvas, direction as f64 / directions as f64 * TURN, phase))?;
      let canvas = canvas.borrow::<Canvas>()?;
      let mut pixels = vec![0u8; width * height * 4];
      for (at, &color) in canvas.data.iter().enumerate() {
        if color == 0 {
          continue;
        }
        let alpha = 255 - (color >> 24) as u8;
        pixels[at * 4..at * 4 + 4].copy_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, color as u8, alpha]);
      }
      images.push(pixels);
      frame_lights.push(canvas.lights.iter().map(|&[x, y, size, level]| [((x - anchor[0]) / 16.0) as f32, ((y - anchor[1]) / 16.0) as f32, size as f32, level as f32]).collect());
    }
  }
  let mut lights = Lights::default();
  if let Some(table) = look.get::<Option<Table>>("lights")? {
    if let Some(lamps) = table.get::<Option<Vec<Table>>>("lamps")? {
      lights.lamps = lamps.iter().map(numbers::<3>).collect::<mlua::Result<_>>()?;
    }
    if let Some(beam) = table.get::<Option<Table>>("beam")? {
      let get = |key: &str, default: f32| beam.get::<Option<f32>>(key).map(|value| value.unwrap_or(default));
      lights.beam = Some([get("along", 8.0)?, get("length", 60.0)?, get("near", 4.0)?, get("spread", 0.28)?, get("level", 1.0)?]);
    }
  }
  let layer = match look.get::<Option<String>>("layer")?.as_deref() {
    Some("floor") => Layer::Floor,
    Some("building") => Layer::Building,
    Some("air") => Layer::Air,
    _ => Layer::Ground,
  };
  let shadow = match look.get::<Value>("shadow")? {
    Value::Table(table) => [table.get::<f32>(1)? / TILE, table.get::<f32>(2)?],
    Value::Boolean(false) => [0.0, 0.0],
    _ => [2.0 / TILE, 0.4],
  };
  let memory = look.get::<Option<bool>>("memory")?.unwrap_or(false);
  let icon = match look.get::<Value>("icon")? {
    Value::Table(table) => table.get::<Option<usize>>("direction")?.unwrap_or(0),
    _ => 0,
  };
  let offset = [(-(origin[0] + anchor[0]) / 16.0) as f32, (-(origin[1] + anchor[1]) / 16.0) as f32];
  let portrait = match look.get::<Option<Table>>("portrait")? {
    Some(spec) => Some(portrait(lua, &spec)?),
    None => None,
  };
  let portrait_size = portrait.as_ref().map_or([width as f32, height as f32], |(_, [w, h])| [*w as f32, *h as f32]);
  let working = look.get::<Option<bool>>("working")?.unwrap_or(false) && phases > 1;
  Ok(Look { proto, size: [width, height], offset, directions, phases, images, cells: Vec::new(), frame_lights, fps: look.get::<Option<f32>>("fps")?.unwrap_or(8.0), step: look.get::<Option<f32>>("step")?, layer, shadow, memory, lights, table: look, icon, portrait, portrait_uv: None, portrait_size, picture: false, working })
}

/// Облик-картинка: PNG из мода (`image = "images/logo.png"`), уменьшенный до size усреднением — как картинка на холсте
/// у TS. Для интерфейса: логотип, значки.
pub fn picture(proto: u32, look: Table, png: &[u8]) -> Result<Look, String> {
  let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
  decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
  let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
  let mut buffer = vec![0; reader.output_buffer_size()];
  let info = reader.next_frame(&mut buffer).map_err(|error| error.to_string())?;
  let (width, height) = (info.width as usize, info.height as usize);
  let channels = match info.color_type {
    png::ColorType::Rgba => 4,
    png::ColorType::Rgb => 3,
    png::ColorType::GrayscaleAlpha => 2,
    _ => 1,
  };
  let source = |x: usize, y: usize| -> [f32; 4] {
    let at = (y * width + x) * channels;
    let pixel = &buffer[at..at + channels];
    let [r, g, b, a] = match channels {
      4 => [pixel[0], pixel[1], pixel[2], pixel[3]],
      3 => [pixel[0], pixel[1], pixel[2], 255],
      2 => [pixel[0], pixel[0], pixel[0], pixel[1]],
      _ => [pixel[0], pixel[0], pixel[0], 255],
    };
    [r as f32, g as f32, b as f32, a as f32]
  };
  let [w, h] = pair(&look, "size", [width as f64, height as f64]).map_err(|error| error.to_string())?.map(|value| (value as usize).max(1));
  // Усреднение по площади, с весом прозрачности: края не темнеют.
  let mut pixels = vec![0u8; w * h * 4];
  for y in 0..h {
    for x in 0..w {
      let (x0, x1) = (x * width / w, ((x + 1) * width / w).max(x * width / w + 1));
      let (y0, y1) = (y * height / h, ((y + 1) * height / h).max(y * height / h + 1));
      let mut sum = [0.0f32; 4];
      for sy in y0..y1.min(height) {
        for sx in x0..x1.min(width) {
          let [r, g, b, a] = source(sx, sy);
          sum[0] += r * a;
          sum[1] += g * a;
          sum[2] += b * a;
          sum[3] += a;
        }
      }
      let count = ((x1 - x0) * (y1 - y0)) as f32;
      let at = (y * w + x) * 4;
      if sum[3] > 0.0 {
        pixels[at..at + 4].copy_from_slice(&[(sum[0] / sum[3]).round() as u8, (sum[1] / sum[3]).round() as u8, (sum[2] / sum[3]).round() as u8, (sum[3] / count).round() as u8]);
      }
    }
  }
  Ok(Look { proto, size: [w, h], offset: [-(w as f32) / 32.0, -(h as f32) / 32.0], directions: 1, phases: 1, images: vec![pixels.clone()], cells: Vec::new(), frame_lights: vec![Vec::new()], fps: 8.0, step: None, layer: Layer::Ground, shadow: [0.0, 0.0], memory: false, lights: Lights::default(), table: look, icon: 0, portrait: Some((pixels, [w, h])), portrait_uv: None, portrait_size: [w as f32, h as f32], picture: true, working: false })
}

/// Портрет: `{ size, origin, draw = function(canvas) }` — рисуется один раз и обрезается по закрашенному (toCanvas).
fn portrait(lua: &Lua, spec: &Table) -> mlua::Result<(Vec<u8>, [usize; 2])> {
  let [width, height] = pair(spec, "size", [32.0, 32.0])?.map(|value| value as usize);
  let origin = pair(spec, "origin", [width as f64 / 2.0, height as f64 / 2.0])?;
  let canvas = lua.create_userdata(Canvas { width, height, origin, data: vec![0; width * height], lights: Vec::new() })?;
  spec.get::<Function>("draw")?.call::<()>(&canvas)?;
  let canvas = canvas.borrow::<Canvas>()?;
  let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
  for y in 0..height {
    for x in 0..width {
      if canvas.data[y * width + x] != 0 {
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + 1);
        bottom = bottom.max(y + 1);
      }
    }
  }
  if right <= left {
    return Ok((vec![0; 4], [1, 1]));
  }
  let (w, h) = (right - left, bottom - top);
  let mut pixels = vec![0u8; w * h * 4];
  for y in 0..h {
    for x in 0..w {
      let color = canvas.data[(top + y) * width + left + x];
      if color != 0 {
        let at = (y * w + x) * 4;
        pixels[at..at + 4].copy_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, color as u8, 255 - (color >> 24) as u8]);
      }
    }
  }
  Ok((pixels, [w, h]))
}

/// Общий атлас: кадры всех обликов полками по строкам. Возвращает пиксели RGBA и размер; места кадров — в `cells`.
pub fn pack(looks: &mut [Look]) -> (Vec<u8>, [usize; 2]) {
  const WIDTH: usize = 4096;
  let mut order: Vec<usize> = (0..looks.len()).collect();
  order.sort_by_key(|&index| std::cmp::Reverse(looks[index].size[1]));
  let mut places: Vec<Vec<[usize; 2]>> = looks.iter().map(|_| Vec::new()).collect();
  let (mut x, mut y, mut row) = (0, 0, 0);
  for &index in &order {
    let [w, h] = looks[index].size;
    for _ in 0..looks[index].images.len() {
      if x + w > WIDTH {
        x = 0;
        y += row;
        row = 0;
      }
      places[index].push([x, y]);
      x += w;
      row = row.max(h);
    }
  }
  // Портреты — отдельной полкой снизу.
  y += row;
  x = 0;
  row = 0;
  let mut portraits: Vec<Option<[usize; 2]>> = vec![None; looks.len()];
  for (index, look) in looks.iter().enumerate() {
    let Some((_, [w, h])) = &look.portrait else { continue };
    if x + w > WIDTH {
      x = 0;
      y += row;
      row = 0;
    }
    portraits[index] = Some([x, y]);
    x += w;
    row = row.max(*h);
  }
  let height = (y + row).max(1);
  let mut pixels = vec![0u8; WIDTH * height * 4];
  for (index, look) in looks.iter_mut().enumerate() {
    let [w, h] = look.size;
    look.cells = places[index].iter().map(|&[px, py]| [px as f32 / WIDTH as f32, py as f32 / height as f32, (px + w) as f32 / WIDTH as f32, (py + h) as f32 / height as f32]).collect();
    for (image, &[px, py]) in look.images.iter().zip(&places[index]) {
      for row in 0..h {
        let to = ((py + row) * WIDTH + px) * 4;
        pixels[to..to + w * 4].copy_from_slice(&image[row * w * 4..(row + 1) * w * 4]);
      }
    }
    look.images.clear();
    if let (Some((image, [w, h])), Some([px, py])) = (look.portrait.take(), portraits[index]) {
      for row in 0..h {
        let to = ((py + row) * WIDTH + px) * 4;
        pixels[to..to + w * 4].copy_from_slice(&image[row * w * 4..(row + 1) * w * 4]);
      }
      look.portrait_uv = Some([px as f32 / WIDTH as f32, py as f32 / height as f32, (px + w) as f32 / WIDTH as f32, (py + h) as f32 / height as f32]);
    }
  }
  (pixels, [WIDTH, height])
}
