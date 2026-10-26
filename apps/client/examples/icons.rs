//! Значки страницы и PWA (apps/client/web/icons): логотип Kharos — красное перекрестие с кольцом, как
//! mods/base/images/logo.png, но нарисованный заново под каждый размер, а не растянутый:
//!
//!   cargo run -p kharos-client --release --example icons
//!
//! Геометрия — в долях стороны логотипа 256: полосы толщиной 24, кольцо радиусами 66,5 и 93,5, вертикальные полосы
//! идут сквозь кольцо, и кольцо вокруг них вырезано на ±15°, горизонтальные — только снаружи кольца.

use std::path::Path;

const RED: [u8; 3] = [217, 68, 47];
/// Фон игры (#08111c): у значков, которые система показывает квадратом или кругом целиком.
const NIGHT: [u8; 3] = [8, 17, 28];
/// Сколько подвыборок на сторону пикселя: края гладкие, как у логотипа.
const SAMPLES: usize = 4;

/// Закрашена ли точка логотипа (x, y в долях 0…256).
fn inside(x: f32, y: f32) -> bool {
  let (dx, dy) = (x - 128.0, y - 128.0);
  let half = 12.0;
  let (inner, outer) = (66.5, 93.5);
  let edge = 8.0;
  let radius = (dx * dx + dy * dy).sqrt();
  // Вертикальные полосы: от края до 20 от середины, сквозь кольцо.
  if dx.abs() <= half && dy.abs() >= 20.0 && dy.abs() <= 128.0 - edge {
    return true;
  }
  // Горизонтальные — снаружи кольца.
  if dy.abs() <= half && dx.abs() >= inner && dx.abs() <= 128.0 - edge {
    return true;
  }
  // Кольцо, вырезанное вокруг вертикальных полос.
  radius >= inner && radius <= outer && dx.abs().atan2(dy.abs()).to_degrees() > 15.0
}

/// Значок side × side: логотип долей scale стороны посередине, фон — background или прозрачный.
fn icon(side: usize, scale: f32, background: Option<[u8; 3]>) -> Vec<u8> {
  let mut pixels = vec![0u8; side * side * 4];
  let logo = side as f32 * scale;
  let offset = (side as f32 - logo) / 2.0;
  for y in 0..side {
    for x in 0..side {
      let mut hits = 0;
      for sy in 0..SAMPLES {
        for sx in 0..SAMPLES {
          let px = (x as f32 + (sx as f32 + 0.5) / SAMPLES as f32 - offset) / logo * 256.0;
          let py = (y as f32 + (sy as f32 + 0.5) / SAMPLES as f32 - offset) / logo * 256.0;
          hits += usize::from(inside(px, py));
        }
      }
      let cover = hits as f32 / (SAMPLES * SAMPLES) as f32;
      let pixel = &mut pixels[(y * side + x) * 4..][..4];
      match background {
        Some(back) => {
          for channel in 0..3 {
            pixel[channel] = (back[channel] as f32 + (RED[channel] as f32 - back[channel] as f32) * cover).round() as u8;
          }
          pixel[3] = 255;
        }
        None => {
          pixel[..3].copy_from_slice(&RED);
          pixel[3] = (cover * 255.0).round() as u8;
        }
      }
    }
  }
  pixels
}

fn save(dir: &Path, name: &str, side: usize, pixels: &[u8]) {
  let file = std::fs::File::create(dir.join(name)).expect("файл значка");
  let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), side as u32, side as u32);
  encoder.set_color(png::ColorType::Rgba);
  encoder.set_depth(png::BitDepth::Eight);
  encoder.write_header().expect("PNG").write_image_data(pixels).expect("PNG");
}

fn main() {
  let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("web/icons");
  std::fs::create_dir_all(&dir).expect("папка значков");
  // Вкладка и закладки: логотип во весь значок.
  for side in [32, 64] {
    save(&dir, &format!("favicon-{side}.png"), side, &icon(side, 1.0, None));
  }
  // PWA «any»: прозрачные, логотип во весь значок.
  for side in [192, 512] {
    save(&dir, &format!("icon-{side}.png"), side, &icon(side, 1.0, None));
  }
  // PWA «maskable»: система обрезает до круга или скруглённого квадрата — логотип в безопасной середине (80%).
  save(&dir, "icon-maskable-512.png", 512, &icon(512, 0.7, Some(NIGHT)));
  // iOS: квадрат без прозрачности, углы скругляет сама система.
  save(&dir, "apple-touch-icon.png", 180, &icon(180, 0.75, Some(NIGHT)));
}
