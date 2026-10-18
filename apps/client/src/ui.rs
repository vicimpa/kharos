//! Батч треугольников интерфейса и слоя поверх мира: отрезки помнят, чем их красить — шрифтовым атласом (альфа),
//! атласом обликов (значок с палитрой стороны) или скином (рамки, монета) — и по какому прямоугольнику обрезать.

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
  pub pos: [f32; 2],
  pub uv: [f32; 2],
  pub color: [u8; 4],
}

/// Чем красить отрезок батча: шрифтовой атлас, атлас обликов с палитрой стороны team или скин интерфейса.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paint {
  Font,
  Sprite {
    team: usize,
  },
  Skin,
  Minimap,
  /// Схема карты новой игры (`ui:preview`).
  Preview,
  /// Картинка из атласа обликов — гладкая, без цвета стороны.
  Picture,
  /// Туман войны на мини-карте: альфа из картинки обзора.
  Fog,
}

#[derive(Default)]
pub struct Batch {
  pub vertices: Vec<Vertex>,
  pub indices: Vec<u32>,
  /// Отрезки индексов: с какого начинается, чем красить и по какому прямоугольнику [x, y, w, h] обрезать.
  pub segments: Vec<(usize, Paint, Option<[f32; 4]>)>,
  clip: Option<[f32; 4]>,
}

/// Белый угол шрифтового атласа — для сплошной заливки.
pub const WHITE_UV: [f32; 2] = [2.0 / ATLAS_SIZE as f32, 2.0 / ATLAS_SIZE as f32];
pub const ATLAS_SIZE: u32 = 1024;

impl Batch {
  pub fn clear(&mut self) {
    self.vertices.clear();
    self.indices.clear();
    self.segments.clear();
    self.clip = None;
  }

  fn paint(&mut self, paint: Paint) {
    let clip = self.clip;
    if self.segments.last().map(|segment| (segment.1, segment.2)) != Some((paint, clip)) {
      self.segments.push((self.indices.len(), paint, clip));
    }
  }

  /// Четырёхугольник с обрезкой.
  pub fn quad_clipped(&mut self, min: [f32; 2], max: [f32; 2], uv: [f32; 4], color: [u8; 4], paint: Paint, clip: Option<[f32; 4]>) {
    self.clip = clip;
    self.quad(min, max, uv, color, paint);
    self.clip = None;
  }

  /// Четырёхугольник по углам по часовой: a, b, c, d.
  pub fn quad_points(&mut self, points: [[f32; 2]; 4], uv: [f32; 4], color: [u8; 4], paint: Paint) {
    self.paint(paint);
    let base = self.vertices.len() as u32;
    let uvs = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
    for (pos, uv) in points.into_iter().zip(uvs) {
      self.vertices.push(Vertex { pos, uv, color });
    }
    self.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
  }

  pub fn quad(&mut self, min: [f32; 2], max: [f32; 2], uv: [f32; 4], color: [u8; 4], paint: Paint) {
    self.quad_points([[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]], uv, color, paint);
  }

  pub fn rect(&mut self, min: [f32; 2], max: [f32; 2], color: [u8; 4]) {
    self.quad(min, max, [WHITE_UV[0], WHITE_UV[1], WHITE_UV[0], WHITE_UV[1]], color, Paint::Font);
  }

  /// Отрезок толщиной width.
  pub fn line(&mut self, a: [f32; 2], b: [f32; 2], width: f32, color: [u8; 4]) {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length = (dx * dx + dy * dy).sqrt().max(1e-6);
    let (nx, ny) = (-dy / length * width / 2.0, dx / length * width / 2.0);
    let uv = [WHITE_UV[0], WHITE_UV[1], WHITE_UV[0], WHITE_UV[1]];
    self.quad_points([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], uv, color, Paint::Font);
  }

  /// Выпуклый многоугольник веером.
  pub fn fan(&mut self, points: &[[f32; 2]], color: [u8; 4]) {
    self.paint(Paint::Font);
    let base = self.vertices.len() as u32;
    for &pos in points {
      self.vertices.push(Vertex { pos, uv: WHITE_UV, color });
    }
    for i in 1..(points.len() as u32).saturating_sub(1) {
      self.indices.extend_from_slice(&[base, base + i, base + i + 1]);
    }
  }

  /// Окружность: заливка (width = None) или кольцо толщиной width.
  pub fn circle(&mut self, center: [f32; 2], radius: f32, width: Option<f32>, color: [u8; 4], segments: usize) {
    let point = |i: usize, r: f32| {
      let angle = i as f32 / segments as f32 * std::f32::consts::TAU;
      [center[0] + angle.cos() * r, center[1] + angle.sin() * r]
    };
    match width {
      None => {
        let points: Vec<[f32; 2]> = (0..segments).map(|i| point(i, radius)).collect();
        self.fan(&points, color);
      }
      Some(width) => {
        let uv = [WHITE_UV[0], WHITE_UV[1], WHITE_UV[0], WHITE_UV[1]];
        for i in 0..segments {
          let (outer, inner) = (radius + width / 2.0, (radius - width / 2.0).max(0.0));
          self.quad_points([point(i, outer), point(i + 1, outer), point(i + 1, inner), point(i, inner)], uv, color, Paint::Font);
        }
      }
    }
  }
}

/// Шрифтовой атлас R8; левый верхний угол 4 × 4 — белый, для заливки.
pub struct FontAtlas {
  pub pixels: Vec<u8>,
  /// Растёт с каждой правкой: рендер знает, когда перезалить.
  pub generation: u64,
}

impl FontAtlas {
  pub fn new() -> Self {
    let mut atlas = Self { pixels: vec![0; (ATLAS_SIZE * ATLAS_SIZE) as usize], generation: 1 };
    atlas.clear();
    atlas
  }

  pub fn clear(&mut self) {
    self.pixels.fill(0);
    for y in 0..4 {
      for x in 0..4 {
        self.pixels[(y * ATLAS_SIZE + x) as usize] = 255;
      }
    }
    self.generation += 1;
  }
}

impl Default for FontAtlas {
  fn default() -> Self {
    Self::new()
  }
}
