//! Интерфейс в немедленном режиме — перенос `packages/client/src/gui/ui.ts`: панели описываются вызовами каждый кадр
//! (`ui:box`, `ui:text`, `ui:button` из Luau), из них собирается дерево, в конце кадра оно раскладывается (ряды и
//! столбцы с промежутками, отступами, выравниванием и растяжением — как flex у страницы) и рисуется. Состояние у
//! панелей — в их скриптах, а интерфейс помнит места узлов прошлого кадра: по ним видно, что под указателем и что
//! нажали. Вид — тот же: рамки скина (`ui/skin.ts`) девятью частями, Ark Pixel с порогом альфы, тени текста.

use crate::input::Input;
use crate::ui::{Batch, FontAtlas, Paint, ATLAS_SIZE, WHITE_UV};
use std::collections::{HashMap, HashSet};

/// Через сколько секунд наведения появляется подсказка.
const TIP_DELAY: f64 = 0.35;
/// Сколько держать палец, чтобы нажатие стало долгим (правым щелчком), и насколько можно сдвинуть его.
const HOLD: f64 = 0.5;
const HOLD_SLOP: f32 = 8.0;
/// Толщина обводки в пикселях.
const OUTLINE: f32 = 3.0;
/// Рамка скина: углы в CORNER пикселей скина, пиксель скина — SKIN_SCALE пикселей экрана.
const CORNER: f32 = 4.0;
const SKIN_SCALE: f32 = 2.0;
const BORDER: f32 = CORNER * SKIN_SCALE;
/// Ширина подсказки, дальше строки переносятся.
const TIP_WIDTH: f32 = 320.0;
/// Шаг прокрутки колесом.
const WHEEL_LINE: f32 = 40.0;

pub type Color = [u8; 4];

// ------------------------------------------------------------------ шрифты

/// Шрифты интерфейса, как FONTS в text.ts: лицо, размер, высота строки и верх букв.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FontName {
  Body,
  Small,
  Title,
  Logo,
}

impl FontName {
  pub fn parse(name: &str) -> Self {
    match name {
      "small" => Self::Small,
      "title" => Self::Title,
      "logo" => Self::Logo,
      _ => Self::Body,
    }
  }

  /// Лицо (0 — Ark Pixel 12, 1 — Ark Pixel 10), размер, строка, верх.
  fn spec(self) -> (usize, f32, f32, f32) {
    match self {
      Self::Body => (0, 12.0, 16.0, 13.0),
      Self::Small => (1, 10.0, 14.0, 11.0),
      Self::Title => (1, 20.0, 28.0, 22.0),
      Self::Logo => (1, 40.0, 56.0, 44.0),
    }
  }

  pub fn line(self) -> f32 {
    self.spec().2
  }
}

/// Свои знаки на 12 пикселей, которых нет в пиксельном шрифте: молния энергии, крестик «закрыть», минус (убавить
/// в сделке космопорта) — черта на высоте дефиса, галочка пройденного шага («Первые шаги») и узбекский апостроф
/// (ʼ в «Oʼzbekcha»): у букв он — наверху, как запятая над строкой.
pub const FALLBACK: [(char, &[&str]); 5] = [
  ('ʼ', &[".#", ".#", "#.", "..", "..", "..", "..", "..", ".."]),
  ('⚡', &["....##", "...##.", "..##..", ".#####", "....#.", "...#..", "..#...", ".#....", "#....."]),
  ('✕', &["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"]),
  ('−', &[".....", ".....", ".....", ".....", "#####", ".....", ".....", ".....", ".....", "....."]),
  ('✓', &["......#", ".....##", "#...##.", "##.##..", ".###...", "..#...."]),
];

#[derive(Clone, Copy)]
struct Glyph {
  uv: [f32; 4],
  size: [f32; 2],
  offset: [f32; 2],
}

/// Текст: глифы — в физических пикселях, по порогу альфы (буквы пиксельного шрифта без ореола, как у TS).
pub struct Fonts {
  faces: Vec<fontdue::Font>,
  pub atlas: FontAtlas,
  glyphs: HashMap<(usize, u16, char), Glyph>,
  widths: HashMap<(FontName, String), f32>,
  cursor: [u32; 2],
  row: u32,
  scale: f32,
}

impl Fonts {
  pub fn new(faces: &[&[u8]]) -> Result<Self, String> {
    let faces = faces.iter().map(|bytes| fontdue::Font::from_bytes(*bytes, fontdue::FontSettings::default()).map_err(|error| format!("шрифт: {error}"))).collect::<Result<_, _>>()?;
    Ok(Self { faces, atlas: FontAtlas::new(), glyphs: HashMap::new(), widths: HashMap::new(), cursor: [6, 0], row: 4, scale: 1.0 })
  }

  pub fn set_scale(&mut self, scale: f32) {
    if (scale - self.scale).abs() > 0.001 {
      self.scale = scale;
      self.glyphs.clear();
      self.atlas.clear();
      self.cursor = [6, 0];
      self.row = 4;
    }
  }

  fn glyph(&mut self, face: usize, px: u16, char: char) -> Glyph {
    if let Some(glyph) = self.glyphs.get(&(face, px, char)) {
      return *glyph;
    }
    let (w, h, xmin, ymin, bitmap) = self.raster(face, char, px);
    if self.cursor[0] + w + 1 > ATLAS_SIZE {
      self.cursor = [0, self.cursor[1] + self.row + 1];
      self.row = 0;
    }
    if self.cursor[1] + h + 1 > ATLAS_SIZE {
      self.glyphs.clear();
      self.atlas.clear();
      self.cursor = [0, 5];
      self.row = 0;
    }
    let [x, y] = self.cursor;
    for row in 0..h {
      for column in 0..w {
        let value = bitmap[(row * w + column) as usize];
        self.atlas.pixels[((y + row) * ATLAS_SIZE + x + column) as usize] = if value >= 128 { 255 } else { 0 };
      }
    }
    self.atlas.generation += 1;
    self.cursor[0] += w + 1;
    self.row = self.row.max(h);
    let size = ATLAS_SIZE as f32;
    let glyph = Glyph { uv: [x as f32 / size, y as f32 / size, (x + w) as f32 / size, (y + h) as f32 / size], size: [w as f32, h as f32], offset: [xmin as f32, -(ymin as f32 + h as f32)] };
    self.glyphs.insert((face, px, char), glyph);
    glyph
  }

  /// Знака нет в начертании, но он есть среди своих (FALLBACK): у TS его брал системный шрифт браузера.
  fn fallback(&self, face: usize, char: char) -> Option<&'static [&'static str]> {
    if self.faces[face].lookup_glyph_index(char) != 0 {
      return None;
    }
    FALLBACK.iter().find(|(code, _)| *code == char).map(|(_, rows)| *rows)
  }

  /// Глиф: ширина, высота, сдвиг от пера и от базовой линии, покрытие по пикселям.
  fn raster(&self, face: usize, char: char, px: u16) -> (u32, u32, i32, i32, Vec<u8>) {
    if let Some(rows) = self.fallback(face, char) {
      let k = (px as f32 / 12.0).round().max(1.0) as u32;
      let (w, h) = (rows[0].len() as u32 * k, rows.len() as u32 * k);
      let bitmap = (0..h).flat_map(|y| (0..w).map(move |x| (y, x))).map(|(y, x)| if rows[(y / k) as usize].as_bytes()[(x / k) as usize] == b'#' { 255 } else { 0 }).collect();
      return (w, h, 0, -(k as i32), bitmap);
    }
    let (metrics, bitmap) = self.faces[face].rasterize(char, px as f32);
    (metrics.width as u32, metrics.height as u32, metrics.xmin, metrics.ymin, bitmap)
  }

  /// Шаг пера после знака.
  fn advance(&self, face: usize, char: char, px: f32) -> f32 {
    match self.fallback(face, char) {
      Some(rows) => (rows[0].len() as f32 + 1.0) * (px / 12.0).round().max(1.0),
      None => self.faces[face].metrics(char, px).advance_width,
    }
  }

  /// Ширина строки в пикселях, с округлением вверх, как measureText в TS.
  pub fn width(&mut self, font: FontName, text: &str) -> f32 {
    if let Some(&width) = self.widths.get(&(font, text.to_string())) {
      return width;
    }
    let (face, size, ..) = font.spec();
    let width = text.chars().map(|char| self.advance(face, char, size)).sum::<f32>().ceil();
    if self.widths.len() > 4000 {
      self.widths.clear();
    }
    self.widths.insert((font, text.to_string()), width);
    width
  }

  /// Строка с левым верхним углом в pos.
  fn draw(&mut self, batch: &mut Batch, pos: [f32; 2], font: FontName, color: Color, text: &str, clip: Option<[f32; 4]>) {
    let (face, size, _, ascent) = font.spec();
    let scale = self.scale;
    let px = (size * scale).round() as u16;
    let origin = (pos[0] * scale).round();
    let baseline = ((pos[1] + ascent) * scale).round();
    let mut pen = 0.0f32;
    for char in text.chars() {
      let advance = self.advance(face, char, px as f32);
      let glyph = self.glyph(face, px, char);
      if glyph.size[0] > 0.0 {
        let x = origin + pen.round() + glyph.offset[0];
        let y = baseline + glyph.offset[1];
        batch.quad_clipped([x / scale, y / scale], [(x + glyph.size[0]) / scale, (y + glyph.size[1]) / scale], glyph.uv, color, Paint::Font, clip);
      }
      pen += advance;
    }
  }

  /// По словам в строки не шире width; длинное слово — по буквам (wrapText).
  fn wrap(&mut self, font: FontName, text: &str, width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split(' ') {
      let next = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
      if self.width(font, &next) <= width {
        line = next;
        continue;
      }
      if !line.is_empty() {
        lines.push(std::mem::take(&mut line));
      }
      for letter in word.chars() {
        let candidate = format!("{line}{letter}");
        if !line.is_empty() && self.width(font, &candidate) > width {
          lines.push(std::mem::take(&mut line));
        }
        line.push(letter);
      }
    }
    lines.push(line);
    lines
  }

  /// Сокращение многоточием до width (clipText).
  fn clip(&mut self, font: FontName, text: &str, width: f32) -> String {
    if self.width(font, text) <= width {
      return text.to_string();
    }
    let letters: Vec<char> = text.chars().collect();
    let (mut low, mut high) = (0, letters.len());
    while low < high {
      let middle = (low + high).div_ceil(2);
      let candidate: String = letters[..middle].iter().collect::<String>().trim_end().to_string() + "…";
      if self.width(font, &candidate) <= width {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    letters[..low].iter().collect::<String>().trim_end().to_string() + "…"
  }
}

// ------------------------------------------------------------------ скин

/// Рамки скина, как paintSkins в skin.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skin {
  Panel,
  Well,
  Button,
  ButtonHover,
  ButtonActive,
  ButtonDisabled,
  ButtonPrimary,
  ButtonPrimaryHover,
  Gold,
  Danger,
}

impl Skin {
  pub const ALL: [Skin; 10] = [Skin::Panel, Skin::Well, Skin::Button, Skin::ButtonHover, Skin::ButtonActive, Skin::ButtonDisabled, Skin::ButtonPrimary, Skin::ButtonPrimaryHover, Skin::Gold, Skin::Danger];

  fn parse(name: &str) -> Option<Self> {
    Some(match name {
      "panel" => Self::Panel,
      "well" => Self::Well,
      "button" => Self::Button,
      "button-hover" => Self::ButtonHover,
      "button-active" => Self::ButtonActive,
      "button-disabled" => Self::ButtonDisabled,
      "button-primary" => Self::ButtonPrimary,
      "button-primary-hover" => Self::ButtonPrimaryHover,
      "gold" => Self::Gold,
      "danger" => Self::Danger,
      _ => return None,
    })
  }

  fn index(self) -> usize {
    Self::ALL.iter().position(|&skin| skin == self).expect("скин")
  }
}

const fn hex(value: u32) -> Color {
  [(value >> 16) as u8, (value >> 8) as u8, value as u8, 255]
}

pub const INK: Color = hex(0x0b111b);
const STEEL: [Color; 5] = [hex(0x1c2b3e), hex(0x2d4560), hex(0x41617f), hex(0x6184a3), hex(0x9bb9d1)];
const DEEP: Color = hex(0x0e1825);
const WELL: Color = hex(0x070d15);
const TEAM: [Color; 4] = [hex(0x10358f), hex(0x1f63d8), hex(0x5aa9ff), hex(0xe4f4ff)];
const GOLD: [Color; 4] = [hex(0x5a3d0c), hex(0xc9962b), hex(0xf0c95a), hex(0xfff1b8)];
const RED: [Color; 3] = [hex(0x4a1410), hex(0xa8382a), hex(0xff6b5a)];

/// Картинки скина: десять рамок 12 × 12 подряд и монета 8 × 8 — RGBA 128 × 12.
pub const SKIN_SIZE: [usize; 2] = [128, 12];

pub fn skin_pixels() -> Vec<u8> {
  let [width, height] = SKIN_SIZE;
  let mut pixels = vec![0u8; width * height * 4];
  let mut paint = |left: usize, x: usize, y: usize, w: usize, h: usize, color: Color| {
    for py in y..y + h {
      for px in left + x..left + x + w {
        pixels[(py * width + px) * 4..(py * width + px) * 4 + 4].copy_from_slice(&color);
      }
    }
  };
  // Рамка со срезанными углами: обводка, фаска (светлая сверху и слева, тёмная снизу и справа) и заливка.
  let frames: [(Color, Color, Color, Color, Option<Color>); 10] = [(DEEP, STEEL[2], INK, INK, Some(STEEL[3])), (WELL, INK, STEEL[1], STEEL[0], None), (STEEL[1], STEEL[3], STEEL[0], INK, None), (STEEL[2], STEEL[4], STEEL[0], INK, None), (TEAM[0], INK, TEAM[2], TEAM[2], None), (STEEL[0], STEEL[1], INK, INK, None), (TEAM[1], TEAM[2], TEAM[0], INK, None), (hex(0x3a7fe8), TEAM[3], TEAM[0], INK, None), (DEEP, GOLD[2], GOLD[0], GOLD[0], Some(GOLD[3])), (RED[0], RED[2], INK, INK, Some(RED[2]))];
  for (index, (fill, light, dark, edge, rivets)) in frames.into_iter().enumerate() {
    let left = index * 12;
    let last = 11;
    paint(left, 1, 0, 10, 1, edge);
    paint(left, 1, last, 10, 1, edge);
    paint(left, 0, 1, 1, 10, edge);
    paint(left, last, 1, 1, 10, edge);
    paint(left, 1, 1, 10, 10, fill);
    paint(left, 1, 1, 10, 1, light);
    paint(left, 1, 2, 1, 9, light);
    paint(left, 1, last - 1, 10, 1, dark);
    paint(left, last - 1, 1, 1, 10, dark);
    if let Some(rivets) = rivets {
      for (x, y) in [(2, 2), (last - 2, 2), (2, last - 2), (last - 2, last - 2)] {
        paint(left, x, y, 1, 1, rivets);
      }
    }
  }
  // Монета кредитов: золотой кружок с бликом и тенью.
  let coin = 120;
  for (x, y, w, h, color) in [(2, 0, 4, 1, GOLD[0]), (2, 7, 4, 1, GOLD[0]), (0, 2, 1, 4, GOLD[0]), (7, 2, 1, 4, GOLD[0]), (1, 1, 1, 1, GOLD[0]), (6, 1, 1, 1, GOLD[0]), (1, 6, 1, 1, GOLD[0]), (6, 6, 1, 1, GOLD[0]), (1, 2, 6, 4, GOLD[2]), (2, 1, 4, 6, GOLD[2]), (5, 2, 1, 4, GOLD[1]), (2, 5, 4, 1, GOLD[1]), (2, 2, 2, 1, GOLD[3]), (2, 3, 1, 1, GOLD[3])] {
    paint(coin, x, y, w, h, color);
  }
  pixels
}

/// uv куска текстуры скина в пикселях [x, y, w, h].
fn skin_uv(x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
  let [width, height] = [SKIN_SIZE[0] as f32, SKIN_SIZE[1] as f32];
  [x / width, y / height, (x + w) / width, (y + h) / height]
}

// ------------------------------------------------------------------ узлы

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
  pub x: f32,
  pub y: f32,
  pub w: f32,
  pub h: f32,
}

impl Rect {
  fn contains(&self, x: f32, y: f32) -> bool {
    x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
  }

  fn intersect(&self, other: &Rect) -> Rect {
    let x = self.x.max(other.x);
    let y = self.y.max(other.y);
    Rect { x, y, w: ((self.x + self.w).min(other.x + other.w) - x).max(0.0), h: ((self.y + self.h).min(other.y + other.h) - y).max(0.0) }
  }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Direction {
  Row,
  #[default]
  Column,
  Stack,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Align {
  #[default]
  Start,
  Center,
  End,
  Stretch,
  Between,
}

impl Align {
  fn parse(name: &str) -> Self {
    match name {
      "center" => Self::Center,
      "end" => Self::End,
      "stretch" => Self::Stretch,
      "between" => Self::Between,
      _ => Self::Start,
    }
  }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Anchor {
  pub left: Option<f32>,
  pub right: Option<f32>,
  pub top: Option<f32>,
  pub bottom: Option<f32>,
  pub center_x: Option<f32>,
  pub center_y: Option<f32>,
}

#[derive(Clone, Debug, Default)]
pub struct Style {
  pub id: Option<String>,
  pub direction: Direction,
  pub self_align: Option<(Align, Align)>,
  pub gap: f32,
  /// Сверху, справа, снизу, слева.
  pub padding: [f32; 4],
  pub align: Align,
  pub justify: Align,
  pub width: Option<f32>,
  pub height: Option<f32>,
  pub min_width: f32,
  pub max_width: Option<f32>,
  pub min_height: f32,
  pub max_height: Option<f32>,
  pub grow: f32,
  pub shrink: bool,
  pub wrap: bool,
  pub skin: Option<Skin>,
  pub background: Option<Color>,
  pub outline: Option<Color>,
  pub alpha: Option<f32>,
  pub clip: bool,
  /// Прокрутка колесом (нужен id): содержимое выше узла ездит внутри него.
  pub scroll: bool,
  pub anchor: Option<Anchor>,
  pub passive: bool,
}

/// Картинка в интерфейсе: кадр атласа обликов (сторона team) или кусок скина (монета).
#[derive(Clone, Copy, Debug)]
pub enum Image {
  Sprite {
    uv: [f32; 4],
    team: usize,
  },
  Coin,
  Minimap,
  Preview,
  /// Картинка из файла мода — гладкая, с прозрачностью.
  Picture {
    uv: [f32; 4],
  },
}

#[derive(Clone, Debug)]
pub enum Leaf {
  Text { text: String, font: FontName, color: Color, shadow: Option<Color>, lift: f32, wrap: Option<f32>, ellipsis: bool, lines: Vec<String> },
  Image { image: Image, width: f32, height: f32 },
  Space,
}

#[derive(Clone, Debug, Default)]
pub struct Node {
  pub style: Style,
  pub leaf: Option<Leaf>,
  pub children: Vec<Node>,
  want: (f32, f32),
  pub rect: Rect,
  content: f32,
  lines: Option<Vec<Vec<usize>>>,
}

/// Щелчок: какой кнопкой (0 — левая, 1 — средняя, 2 — правая, как у страницы), с какими клавишами, долгое ли касание.
#[derive(Clone, Copy, Debug, Default)]
pub struct Click {
  pub button: u8,
  pub shift: bool,
  pub ctrl: bool,
  pub alt: bool,
  pub long: bool,
}

/// Правка поля ввода: текст знаками, место курсора и начало выделения (anchor == caret — выделения нет).
#[derive(Clone, Debug, Default)]
struct Edit {
  value: Vec<char>,
  caret: usize,
  anchor: usize,
}

/// Поле ввода (`input` в ui.ts): ширина (без неё — растёт), подсказка в пустом, предел длины, только цифры, звёздочки
/// вместо букв, фокус сразу, цвет текста, своя заливка и обводка вместо утопленного окна.
#[derive(Clone, Debug, Default)]
pub struct FieldOptions {
  pub width: Option<f32>,
  pub placeholder: Option<String>,
  pub max_length: Option<usize>,
  pub digits: bool,
  pub password: bool,
  pub focus: bool,
  pub color: Option<Color>,
  pub background: Option<Color>,
  pub outline: Option<Color>,
}

/// Что поле отдаёт панели: набранное, в фокусе ли и клавиши, которые оно не взяло себе (Enter, Escape, Tab, стрелки
/// вверх и вниз, Blur — фокус ушёл).
pub struct Field {
  pub value: String,
  pub focused: bool,
  pub keys: Vec<String>,
}

struct Press {
  id: Option<String>,
  button: u8,
  x: f32,
  y: f32,
  time: f64,
  long: bool,
}

/// Состояние интерфейса между кадрами и дерево текущего кадра.
pub struct Gui {
  pub fonts: Fonts,
  pub batch: Batch,
  pub width: f32,
  pub height: f32,
  pointer: Option<[f32; 2]>,
  press: Option<Press>,
  clicks: HashMap<String, Click>,
  /// Щелчки этого кадра — их забирают панели.
  pub frame_clicks: HashMap<String, Click>,
  /// Места узлов с номерами по прошлому кадру — в порядке рисования, и номера предков.
  hits: Vec<(String, Rect, Vec<String>)>,
  roots: Vec<Rect>,
  scrolls: HashMap<String, f32>,
  over: Option<String>,
  since: f64,
  now: f64,
  /// Дерево кадра: корневые панели и открытые узлы.
  top: Vec<Node>,
  stack: Vec<Node>,
  /// Подсказки кадра — готовыми узлами; показывается последняя.
  tips: Vec<Node>,
  /// Указатель над интерфейсом по прошлому кадру.
  pub covered: bool,
  /// Кнопку нажали за кадр (Some(недоступна ли она)) и навели на доступную — для звука интерфейса (GUI_PRESS).
  pub pressed_button: Option<bool>,
  pub hovered_button: bool,
  buttons: HashMap<String, bool>,
  /// Поле ввода в фокусе, правки полей, клавиши полей до кадра и за кадр, поля, описанные в этом кадре.
  focused: Option<String>,
  edits: HashMap<String, Edit>,
  field_keys: HashMap<String, Vec<String>>,
  frame_keys: HashMap<String, Vec<String>>,
  seen_fields: HashSet<String>,
  /// Буфер обмена — свой, в памяти, как у оболочки TS.
  clipboard: String,
}

impl Gui {
  pub fn new(fonts: Fonts) -> Self {
    Self { fonts, batch: Batch::default(), width: 0.0, height: 0.0, pointer: None, press: None, clicks: HashMap::new(), frame_clicks: HashMap::new(), hits: Vec::new(), roots: Vec::new(), scrolls: HashMap::new(), over: None, since: 0.0, now: 0.0, top: Vec::new(), stack: Vec::new(), tips: Vec::new(), covered: false, pressed_button: None, hovered_button: false, buttons: HashMap::new(), focused: None, edits: HashMap::new(), field_keys: HashMap::new(), frame_keys: HashMap::new(), seen_fields: HashSet::new(), clipboard: String::new() }
  }

  fn topmost(&self, x: f32, y: f32) -> Option<&(String, Rect, Vec<String>)> {
    self.hits.iter().rev().find(|(_, rect, _)| rect.contains(x, y))
  }

  /// Лежит ли в точке панель или узел с номером.
  pub fn covers(&self, x: f32, y: f32) -> bool {
    self.roots.iter().any(|rect| rect.contains(x, y)) || self.hits.iter().any(|(_, rect, _)| rect.contains(x, y))
  }

  /// Начало кадра: ввод против мест прошлого кадра — нажатия, щелчки, долгое касание, колесо.
  pub fn begin(&mut self, input: &Input) {
    self.fonts.set_scale(input.scale);
    self.width = input.screen[0];
    self.height = input.screen[1];
    self.now = input.time;
    self.pointer = input.pointer;
    self.batch.clear();
    self.top.clear();
    self.stack.clear();
    self.tips.clear();
    self.pressed_button = None;
    self.hovered_button = false;
    let modifiers = |button: u8, long: bool| Click { button, shift: input.keys.contains("shift"), ctrl: input.keys.contains("ctrl") || input.keys.contains("meta"), alt: input.keys.contains("alt"), long };
    let [px, py] = input.pointer.unwrap_or([-1.0, -1.0]);
    self.covered = input.pointer.is_some() && self.covers(px, py);
    // Кнопки указателя: левая — 0, правая — 2, средняя — 1, как у страницы.
    for (index, button) in [(0usize, 0u8), (1, 2), (2, 1)] {
      if input.pressed[index] {
        let id = self.topmost(px, py).map(|hit| hit.0.clone());
        // Нажатие мимо поля ввода снимает с него фокус; по полю — ставит.
        if self.focused.is_some() && id != self.focused {
          self.blur();
        }
        if let Some(id) = id.as_ref().filter(|id| self.edits.contains_key(*id)) {
          self.focused = Some(id.clone());
        }
        if let Some(disabled) = id.as_ref().and_then(|id| self.buttons.get(id)) {
          if button == 0 {
            self.pressed_button = Some(*disabled);
          }
        }
        self.press = Some(Press { id, button, x: px, y: py, time: input.time, long: false });
      }
      if input.released[index] {
        if let Some(press) = self.press.take() {
          if !press.long && press.button == button {
            if let Some(hit) = self.topmost(px, py) {
              if Some(&hit.0) == press.id.as_ref() {
                self.clicks.insert(hit.0.clone(), modifiers(button, false));
              }
            }
          }
        }
      }
    }
    // Долгое касание — правый щелчок: у сенсорного экрана правой кнопки нет.
    if let Some(press) = &mut self.press {
      if input.touch && press.button == 0 && !press.long && press.id.is_some() {
        if (px - press.x).hypot(py - press.y) > HOLD_SLOP {
          press.time = f64::INFINITY;
        } else if input.time - press.time >= HOLD {
          press.long = true;
          let id = press.id.clone().expect("номер");
          self.clicks.insert(id, modifiers(2, true));
        }
      }
    }
    // Колесо — ближайшему прокручиваемому списку под указателем.
    if input.wheel != 0.0 && input.pointer.is_some() {
      if let Some((id, _, path)) = self.topmost(px, py).cloned() {
        if let Some(list) = std::iter::once(&id).chain(path.iter().rev()).find(|id| self.scrolls.contains_key(*id)).cloned() {
          *self.scrolls.get_mut(&list).expect("список") -= input.wheel * WHEEL_LINE;
        }
      }
    }
    self.type_keys(input);
    self.frame_keys = std::mem::take(&mut self.field_keys);
    self.seen_fields.clear();
    self.frame_clicks = std::mem::take(&mut self.clicks);
    let over = if input.pointer.is_some() { self.topmost(px, py).map(|hit| hit.0.clone()) } else { None };
    if over != self.over {
      if over.as_ref().is_some_and(|id| self.buttons.get(id) == Some(&false)) {
        self.hovered_button = true;
      }
      self.over = over;
      self.since = self.now;
    }
  }

  /// Поле в фокусе есть: клавиши достаются ему, а не игре.
  pub fn typing(&self) -> bool {
    self.focused.is_some()
  }

  fn blur(&mut self) {
    if let Some(id) = self.focused.take() {
      self.field_keys.entry(id).or_default().push("Blur".into());
    }
  }

  /// Клавиши поля в фокусе: буквы, стирание, стрелки, выделение и буфер обмена. Enter, Escape, Tab, стрелки вверх и
  /// вниз поле отдаёт панели.
  fn type_keys(&mut self, input: &Input) {
    let Some(id) = self.focused.clone() else { return };
    let Some(edit) = self.edits.get_mut(&id) else { return };
    let shift = input.keys.contains("shift");
    let command = input.keys.contains("ctrl") || input.keys.contains("meta");
    let mut passed = Vec::new();
    for key in &input.presses {
      let (from, to) = (edit.caret.min(edit.anchor), edit.caret.max(edit.anchor));
      let replace = |edit: &mut Edit, text: &[char]| {
        edit.value.splice(from..to, text.iter().copied());
        edit.caret = from + text.len();
        edit.anchor = edit.caret;
      };
      let moved = |edit: &mut Edit, caret: usize| {
        edit.caret = caret.min(edit.value.len());
        if !shift {
          edit.anchor = edit.caret;
        }
      };
      match key.as_str() {
        "enter" => passed.push("Enter".to_string()),
        "escape" => passed.push("Escape".to_string()),
        "tab" => passed.push("Tab".to_string()),
        "up" => passed.push("ArrowUp".to_string()),
        "down" => passed.push("ArrowDown".to_string()),
        "backspace" => {
          if from != to {
            replace(edit, &[]);
          } else if from > 0 {
            edit.value.remove(from - 1);
            edit.caret = from - 1;
            edit.anchor = edit.caret;
          }
        }
        "delete" => {
          if from != to {
            replace(edit, &[]);
          } else if from < edit.value.len() {
            edit.value.remove(from);
          }
        }
        "left" => moved(edit, if !shift && from != to { from } else { edit.caret.saturating_sub(1) }),
        "right" => moved(edit, if !shift && from != to { to } else { edit.caret + 1 }),
        "home" => moved(edit, 0),
        "end" => moved(edit, edit.value.len()),
        "a" if command => {
          edit.anchor = 0;
          edit.caret = edit.value.len();
        }
        "c" | "x" if command => {
          if from != to {
            self.clipboard = edit.value[from..to].iter().collect();
          }
          if key == "x" {
            replace(edit, &[]);
          }
        }
        "v" if command => {
          let text: Vec<char> = self.clipboard.chars().map(|char| if char == '\n' || char == '\r' { ' ' } else { char }).collect();
          replace(edit, &text);
        }
        _ => {}
      }
    }
    if !command && !input.text.is_empty() {
      let (from, to) = (edit.caret.min(edit.anchor), edit.caret.max(edit.anchor));
      let text: Vec<char> = input.text.chars().collect();
      edit.value.splice(from..to, text.iter().copied());
      edit.caret = from + text.len();
      edit.anchor = edit.caret;
    }
    if !passed.is_empty() {
      self.field_keys.entry(id).or_default().extend(passed);
    }
  }

  /// Поле ввода: правка живёт в интерфейсе, панель каждый кадр отдаёт своё значение и получает набранное. Длинный
  /// текст сдвигается так, чтобы курсор был виден; без фокуса поле показывает начало.
  pub fn input(&mut self, id: &str, value: &str, options: &FieldOptions) -> Field {
    self.seen_fields.insert(id.to_string());
    let focused_here = self.focused.as_deref() == Some(id);
    let edit = self.edits.entry(id.to_string()).or_insert_with(|| {
      let value: Vec<char> = value.chars().collect();
      Edit { caret: value.len(), anchor: value.len(), value }
    });
    // Текст поменяли снаружи (отправили, подставили подсказку) — курсор в конец.
    if !focused_here && edit.value.iter().collect::<String>() != value {
      edit.value = value.chars().collect();
      edit.caret = edit.value.len();
      edit.anchor = edit.caret;
    }
    if options.digits {
      edit.value.retain(|char| char.is_ascii_digit());
    }
    if let Some(limit) = options.max_length {
      edit.value.truncate(limit);
    }
    edit.caret = edit.caret.min(edit.value.len());
    edit.anchor = edit.anchor.min(edit.value.len());
    let edit = edit.clone();
    if options.focus && !focused_here {
      self.focused = Some(id.to_string());
    }
    let focused = self.focused.as_deref() == Some(id);
    let shown: Vec<char> = if options.password { vec!['•'; edit.value.len()] } else { edit.value.clone() };
    let text = |range: std::ops::Range<usize>| -> String { shown[range].iter().collect() };
    let room = options.width.or_else(|| self.rect(id).map(|rect| rect.w)).unwrap_or(120.0);
    let shift = if focused { (self.fonts.width(FontName::Body, &text(0..edit.caret)) - (room - 18.0)).max(0.0) } else { 0.0 };
    let color = options.color.unwrap_or(hex(0xd6e6f5));
    let leaf = |text: String, color: Color| Leaf::Text { text, font: FontName::Body, color, shadow: None, lift: 1.0, wrap: None, ellipsis: false, lines: Vec::new() };
    let (skin, background) = if options.background.is_some() { (None, options.background) } else { (Some(Skin::Well), None) };
    self.open(Style { id: Some(id.to_string()), width: options.width, grow: if options.width.is_none() { 1.0 } else { 0.0 }, min_width: 40.0, height: Some(28.0), skin, background, outline: options.outline, padding: [6.0, 8.0, 6.0, 8.0], clip: true, ..Default::default() }, None);
    // Отступ слева отрицательный: строка уезжает влево, и курсор остаётся в поле.
    self.open(Style { direction: Direction::Row, align: Align::Center, padding: [0.0, 0.0, 0.0, -shift], ..Default::default() }, None);
    if shown.is_empty() && !focused {
      if let Some(placeholder) = &options.placeholder {
        self.leaf(Default::default(), leaf(placeholder.clone(), hex(0x8a8a8a)));
      }
    }
    let (from, to) = (edit.caret.min(edit.anchor), edit.caret.max(edit.anchor));
    if focused && from != to {
      if from > 0 {
        self.leaf(Default::default(), leaf(text(0..from), color));
      }
      self.open(Style { background: Some(hex(0x1f63d8)), ..Default::default() }, None);
      self.leaf(Default::default(), leaf(text(from..to), hex(0xeef6ff)));
      self.close();
      if to < shown.len() {
        self.leaf(Default::default(), leaf(text(to..shown.len()), color));
      }
    } else {
      if edit.caret > 0 {
        self.leaf(Default::default(), leaf(text(0..edit.caret), color));
      }
      // Курсор мигает дважды в секунду, пока поле в фокусе.
      if focused {
        let line = FontName::Body.line();
        if (self.now * 2.0).floor() as i64 % 2 == 0 {
          self.leaf(Style { width: Some(1.0), height: Some(line), background: Some(hex(0xeef6ff)), ..Default::default() }, Leaf::Space);
        } else {
          self.leaf(Style { width: Some(1.0), height: Some(line), ..Default::default() }, Leaf::Space);
        }
      }
      if edit.caret < shown.len() {
        self.leaf(Default::default(), leaf(text(edit.caret..shown.len()), color));
      }
    }
    self.close();
    self.close();
    Field { value: edit.value.iter().collect(), focused, keys: self.frame_keys.get(id).cloned().unwrap_or_default() }
  }

  // -------------------------------------------------------------- описание кадра

  pub fn open(&mut self, style: Style, leaf: Option<Leaf>) {
    self.stack.push(Node { style, leaf, ..Default::default() });
  }

  pub fn close(&mut self) {
    let node = self.stack.pop().expect("открытый узел");
    match self.stack.last_mut() {
      Some(parent) => parent.children.push(node),
      None => self.top.push(node),
    }
  }

  pub fn leaf(&mut self, style: Style, leaf: Leaf) {
    self.open(style, Some(leaf));
    self.close();
  }

  pub fn hovered(&self, id: &str) -> bool {
    self.over.as_deref() == Some(id)
  }

  pub fn within(&self, id: &str) -> bool {
    let Some(over) = &self.over else { return false };
    over == id || self.hits.iter().any(|(hit, _, path)| hit == over && path.iter().any(|one| one == id))
  }

  /// Зажата ли левая кнопка на узле id: где указатель в нём (доли ширины и высоты).
  pub fn held(&self, id: &str) -> Option<(f32, f32)> {
    let press = self.press.as_ref()?;
    if press.id.as_deref() != Some(id) || press.button != 0 {
      return None;
    }
    let (_, rect, _) = self.hits.iter().find(|(hit, ..)| hit == id)?;
    let [x, y] = self.pointer?;
    Some((((x - rect.x) / rect.w).clamp(0.0, 1.0), ((y - rect.y) / rect.h).clamp(0.0, 1.0)))
  }

  pub fn pressing(&self, id: &str) -> bool {
    self.press.as_ref().is_some_and(|press| press.id.as_deref() == Some(id) && press.button == 0)
  }

  /// Кнопка: рамка по состоянию (недоступна, нажата, наведена), как button в ui.ts.
  pub fn button_skin(&mut self, id: &str, base: Option<Skin>, active: bool, disabled: bool) -> Skin {
    self.buttons.insert(id.to_string(), disabled);
    let hover = !disabled && self.hovered(id);
    let held = hover && self.pressing(id);
    let primary = base == Some(Skin::ButtonPrimary);
    if disabled {
      Skin::ButtonDisabled
    } else if active || held {
      Skin::ButtonActive
    } else if hover {
      if primary {
        Skin::ButtonPrimaryHover
      } else {
        Skin::ButtonHover
      }
    } else {
      base.unwrap_or(Skin::Button)
    }
  }

  /// Пора ли показать подсказку узла id: указатель на нём дольше TIP_DELAY и ничего не нажато.
  pub fn tip_due(&self, id: &str) -> bool {
    self.hovered(id) && self.press.is_none() && self.now - self.since >= TIP_DELAY
  }

  /// Начало подсказки: дальше узлы кладутся в её панель. Возвращает открытые узлы кадра — их вернёт end_tip.
  pub fn begin_tip(&mut self) -> Vec<Node> {
    let saved = std::mem::take(&mut self.stack);
    self.open(Style { direction: Direction::Column, gap: 2.0, padding: [6.0, 10.0, 6.0, 10.0], skin: Some(Skin::Panel), passive: true, ..Default::default() }, None);
    saved
  }

  /// Конец подсказки: панель — в подсказки кадра; anchor — где она на экране, без него — у указателя.
  pub fn end_tip(&mut self, saved: Vec<Node>, anchor: Option<Anchor>) {
    while self.stack.len() > 1 {
      let node = self.stack.pop().expect("узел");
      self.stack.last_mut().expect("панель").children.push(node);
    }
    if let Some(mut node) = self.stack.pop() {
      node.style.anchor = anchor;
      self.tips.push(node);
    }
    self.stack = saved;
  }

  /// Подсказка строкой, с переносом по TIP_WIDTH.
  pub fn tip(&mut self, id: &str, text: String) {
    if text.is_empty() || !self.tip_due(id) {
      return;
    }
    let saved = self.begin_tip();
    self.leaf(Default::default(), Leaf::Text { text, font: FontName::Body, color: hex(0xd6e6f5), shadow: None, lift: 1.0, wrap: Some(TIP_WIDTH), ellipsis: false, lines: Vec::new() });
    self.end_tip(saved, None);
  }

  pub fn rect(&self, id: &str) -> Option<Rect> {
    self.hits.iter().find(|(hit, ..)| hit == id).map(|hit| hit.1)
  }

  /// Тексты разложенного кадра по порядку рисования: строка, место и номер ближайшего узла с номером — так сценарий
  /// читает интерфейс и щёлкает по надписи.
  pub fn texts(&self) -> Vec<(String, Rect, Option<String>)> {
    fn walk(node: &Node, id: Option<&String>, out: &mut Vec<(String, Rect, Option<String>)>) {
      let id = node.style.id.as_ref().or(id);
      if let Some(Leaf::Text { text, .. }) = &node.leaf {
        out.push((text.clone(), node.rect, id.cloned()));
      }
      for child in &node.children {
        walk(child, id, out);
      }
    }
    let mut out = Vec::new();
    for node in &self.top {
      walk(node, None, &mut out);
    }
    out
  }

  pub fn now(&self) -> f64 {
    self.now
  }

  // -------------------------------------------------------------- раскладка и рисование

  /// Конец кадра: подсказка, раскладка, места для ввода, рисование в батч.
  pub fn finish(&mut self) {
    while !self.stack.is_empty() {
      self.close();
    }
    // Поле, которого больше не описывают, теряет и фокус, и правку.
    let seen = &self.seen_fields;
    self.edits.retain(|id, _| seen.contains(id));
    if self.focused.as_ref().is_some_and(|id| !seen.contains(id)) {
      self.focused = None;
    }
    // Подсказка — своей корневой панелью у указателя (или где ей велено), поверх всего; нажатия сквозь неё идут.
    if let Some(mut node) = self.tips.pop() {
      let (width, height) = (self.width, self.height);
      measure(&mut self.fonts, &mut node, width - 16.0, false);
      if node.style.anchor.is_some() {
        self.top.push(node);
      } else {
        let [px, py] = self.pointer.unwrap_or([0.0, 0.0]);
        let mut x = px + 14.0;
        if x + node.want.0 > width - 8.0 {
          x = px - 14.0 - node.want.0;
        }
        let mut y = py - node.want.1 - 12.0;
        if y < 8.0 {
          y = py + 20.0;
        }
        node.style.anchor = Some(Anchor { left: Some(x.clamp(8.0, (width - 8.0 - node.want.0).max(8.0))), top: Some(y.clamp(8.0, (height - 8.0 - node.want.1).max(8.0))), ..Default::default() });
        self.top.push(node);
      }
    }
    let (width, height) = (self.width, self.height);
    let mut top = std::mem::take(&mut self.top);
    for root in &mut top {
      let anchor = root.style.anchor.unwrap_or_default();
      measure(&mut self.fonts, root, width - anchor.left.unwrap_or(0.0) - anchor.right.unwrap_or(0.0), false);
      let rect = anchored(root, width, height);
      place(root, rect, &mut self.scrolls);
    }
    let mut hits = Vec::new();
    let mut roots = Vec::new();
    let screen = Rect { x: 0.0, y: 0.0, w: width, h: height };
    fn walk(node: &Node, clip: Rect, path: &mut Vec<String>, hits: &mut Vec<(String, Rect, Vec<String>)>) {
      let visible = node.rect.intersect(&clip);
      if let Some(id) = &node.style.id {
        hits.push((id.clone(), visible, path.clone()));
      }
      let inner = if node.style.clip { visible } else { clip };
      if let Some(id) = &node.style.id {
        path.push(id.clone());
      }
      for child in &node.children {
        walk(child, inner, path, hits);
      }
      if node.style.id.is_some() {
        path.pop();
      }
    }
    for root in &top {
      walk(root, screen, &mut Vec::new(), &mut hits);
      if !root.style.passive {
        roots.push(root.rect);
      }
    }
    self.hits = hits;
    self.roots = roots;
    let mut batch = std::mem::take(&mut self.batch);
    for root in &top {
      paint(&mut self.fonts, &mut batch, root, None, 1.0);
    }
    self.batch = batch;
    self.top = top;
  }
}

fn yields(node: &Node) -> bool {
  node.style.width.is_none() && (node.style.grow > 0.0 || node.style.shrink || matches!(&node.leaf, Some(Leaf::Text { wrap, ellipsis, .. }) if wrap.is_some() || *ellipsis))
}

/// Желаемый размер узла (measure в ui.ts).
fn measure(fonts: &mut Fonts, node: &mut Node, room: f32, column: bool) -> (f32, f32) {
  let [top, right, bottom, left] = node.style.padding;
  let inner = (node.style.width.unwrap_or(room).min(node.style.max_width.unwrap_or(f32::INFINITY)) - left - right).max(0.0);
  let (mut width, mut height);
  match &mut node.leaf {
    Some(Leaf::Text { text, font, shadow, lift, wrap, ellipsis, lines, .. }) => {
      let lift = if shadow.is_some() { *lift } else { 0.0 };
      let space = (wrap.map_or(inner, |wrap| wrap.min(inner)) - lift).max(1.0);
      *lines = text.split('\n').flat_map(|line| if wrap.is_some() { fonts.wrap(*font, line, space) } else { vec![line.to_string()] }).collect();
      if *ellipsis {
        *lines = lines.iter().map(|line| fonts.clip(*font, line, (inner - lift).max(1.0))).collect();
      }
      width = lines.iter().map(|line| fonts.width(*font, line)).fold(0.0, f32::max) + lift;
      height = font.line() * lines.len() as f32;
    }
    Some(Leaf::Image { width: w, height: h, .. }) => {
      width = *w;
      height = *h;
    }
    Some(Leaf::Space) => {
      width = 0.0;
      height = 0.0;
    }
    None if node.style.direction == Direction::Stack => {
      width = 0.0;
      height = 0.0;
      for child in &mut node.children {
        let size = measure(fonts, child, inner, false);
        width = width.max(size.0);
        height = height.max(size.1);
      }
    }
    None => {
      let row = node.style.direction == Direction::Row;
      let gap = node.style.gap;
      let gaps = gap * node.children.len().saturating_sub(1) as f32;
      let mut sizes: Vec<(f32, f32)> = node.children.iter_mut().map(|child| measure(fonts, child, inner, !row)).collect();
      node.lines = None;
      if row && node.style.wrap && sizes.iter().map(|size| size.0).sum::<f32>() + gaps > inner {
        let mut lines: Vec<Vec<usize>> = vec![Vec::new()];
        let mut used = 0.0;
        for (index, child) in node.children.iter().enumerate() {
          let line = lines.last_mut().expect("строка");
          if !line.is_empty() && used + gap + child.want.0 > inner {
            lines.push(vec![index]);
            used = child.want.0;
          } else {
            used += if line.is_empty() { 0.0 } else { gap } + child.want.0;
            line.push(index);
          }
        }
        let width_of = |line: &Vec<usize>| line.iter().map(|&i| node.children[i].want.0).sum::<f32>() + gap * line.len().saturating_sub(1) as f32;
        let height_of = |line: &Vec<usize>| line.iter().map(|&i| node.children[i].want.1).fold(0.0, f32::max);
        width = lines.iter().map(width_of).fold(0.0, f32::max);
        height = lines.iter().map(height_of).sum::<f32>() + gap * lines.len().saturating_sub(1) as f32;
        node.lines = Some(lines);
        sizes.clear();
      } else {
        width = 0.0;
        height = 0.0;
      }
      let total = sizes.iter().map(|size| size.0).sum::<f32>() + gaps;
      if row && total > inner && node.lines.is_none() {
        let mut flexible: Vec<usize> = (0..node.children.len()).filter(|&i| yields(&node.children[i])).collect();
        flexible.sort_by(|&a, &b| node.children[a].want.0.total_cmp(&node.children[b].want.0));
        let mut free = inner - total + flexible.iter().map(|&i| node.children[i].want.0).sum::<f32>();
        let count = flexible.len();
        for (index, &child) in flexible.iter().enumerate() {
          let share = (free / (count - index) as f32).max(0.0);
          if node.children[child].want.0 > share {
            measure(fonts, &mut node.children[child], share, false);
          }
          free -= node.children[child].want.0;
        }
        if count > 0 {
          sizes = node.children.iter().map(|child| child.want).collect();
        }
      }
      if node.lines.is_none() {
        let along = sizes.iter().map(|size| if row { size.0 } else { size.1 }).sum::<f32>() + gaps;
        let across = sizes.iter().map(|size| if row { size.1 } else { size.0 }).fold(0.0, f32::max);
        width = if row { along } else { across };
        height = if row { across } else { along };
      }
    }
  }
  node.content = height + top + bottom;
  let style = &node.style;
  let width = style.width.unwrap_or(width + left + right).min(style.max_width.unwrap_or(f32::INFINITY)).max(style.min_width);
  let _ = column;
  let height = style.height.unwrap_or(height + top + bottom).min(style.max_height.unwrap_or(f32::INFINITY)).max(style.min_height);
  node.want = (width, height);
  node.want
}

/// Ставит детей узла на места (place в ui.ts).
fn place(node: &mut Node, rect: Rect, scrolls: &mut HashMap<String, f32>) {
  node.rect = Rect { x: rect.x.round(), y: rect.y.round(), w: rect.w.round(), h: rect.h.round() };
  if node.children.is_empty() {
    return;
  }
  let style = node.style.clone();
  let row = style.direction == Direction::Row;
  let [top, right, bottom, left] = style.padding;
  let mut inner = Rect { x: node.rect.x + left, y: node.rect.y + top, w: node.rect.w - left - right, h: node.rect.h - top - bottom };
  if style.scroll {
    if let Some(id) = &style.id {
      let room = (node.content - node.rect.h).max(0.0);
      let offset = scrolls.entry(id.clone()).or_insert(0.0);
      *offset = offset.clamp(0.0, room);
      inner.y -= *offset;
      inner.h = node.content - top - bottom;
    }
  }
  if style.direction == Direction::Stack {
    let at = |align: Align, room: f32, want: f32| match align {
      Align::Center => (room - want) / 2.0,
      Align::End => room - want,
      _ => 0.0,
    };
    for child in &mut node.children {
      let (horizontal, vertical) = child.style.self_align.unwrap_or((Align::Start, Align::Start));
      let w = if child.style.grow > 0.0 { inner.w } else { child.want.0 };
      let h = if child.style.grow > 0.0 { inner.h } else { child.want.1 };
      place(child, Rect { x: inner.x + at(horizontal, inner.w, w), y: inner.y + at(vertical, inner.h, h), w, h }, scrolls);
    }
    return;
  }
  let gap = style.gap;
  if let Some(lines) = node.lines.clone() {
    let mut y = inner.y;
    for line in lines {
      let height = line.iter().map(|&i| node.children[i].want.1).fold(0.0, f32::max);
      let mut x = inner.x;
      for &i in &line {
        let child = &mut node.children[i];
        let w = child.want.0;
        let cross = match style.align {
          Align::Center => (height - child.want.1) / 2.0,
          Align::End => height - child.want.1,
          _ => 0.0,
        };
        let h = if style.align == Align::Stretch { height } else { child.want.1 };
        place(child, Rect { x, y: y + cross, w, h }, scrolls);
        x += w + gap;
      }
      y += height + gap;
    }
    return;
  }
  let room = if row { inner.w } else { inner.h };
  let count = node.children.len();
  let mut sizes: Vec<f32> = node.children.iter().map(|child| if row { child.want.0 } else { child.want.1 }).collect();
  let mut short = sizes.iter().sum::<f32>() + gap * count.saturating_sub(1) as f32 - room;
  // Столбцу не хватает высоты — прокручиваемые дети отдают свою сверх minHeight.
  if !row {
    for (index, child) in node.children.iter().enumerate() {
      if short <= 0.0 || !child.style.scroll {
        continue;
      }
      let cut = short.min((sizes[index] - child.style.min_height).max(0.0));
      sizes[index] -= cut;
      short -= cut;
    }
  }
  let slack = -short;
  let free = slack.max(0.0);
  let grows: f32 = node.children.iter().map(|child| child.style.grow).sum();
  let mut offset = 0.0;
  let mut spacing = gap;
  if grows == 0.0 {
    match style.justify {
      Align::Center => offset = free / 2.0,
      Align::End => offset = slack,
      Align::Between if count > 1 => spacing = gap + free / (count - 1) as f32,
      _ => {}
    }
  }
  let mut along = if row { inner.x } else { inner.y } + offset;
  for (index, child) in node.children.iter_mut().enumerate() {
    let extra = if grows > 0.0 { free * child.style.grow / grows } else { 0.0 };
    let size = sizes[index] + extra;
    let cross_room = if row { inner.h } else { inner.w };
    let cross_want = if style.align == Align::Stretch {
      cross_room
    } else if row {
      child.want.1
    } else {
      child.want.0
    };
    let cross_offset = match style.align {
      Align::Center => (cross_room - cross_want) / 2.0,
      Align::End => cross_room - cross_want,
      _ => 0.0,
    };
    let cross = if row { inner.y } else { inner.x } + cross_offset;
    let rect = if row { Rect { x: along, y: cross, w: size, h: cross_want } } else { Rect { x: cross, y: along, w: cross_want, h: size } };
    place(child, rect, scrolls);
    along += size + spacing;
  }
}

/// Место корневой панели по привязке.
fn anchored(node: &Node, width: f32, height: f32) -> Rect {
  let anchor = node.style.anchor.unwrap_or_default();
  let (want_w, want_h) = node.want;
  let w = match (anchor.left, anchor.right) {
    (Some(left), Some(right)) => width - left - right,
    _ => want_w,
  };
  let h = match (anchor.top, anchor.bottom) {
    (Some(top), Some(bottom)) => height - top - bottom,
    _ => want_h,
  };
  let x = anchor.left.unwrap_or_else(|| anchor.right.map(|right| width - right - w).unwrap_or_else(|| anchor.center_x.map_or(0.0, |shift| (width - w) / 2.0 + shift)));
  let y = anchor.top.unwrap_or_else(|| anchor.bottom.map(|bottom| height - bottom - h).unwrap_or_else(|| anchor.center_y.map_or(0.0, |shift| (height - h) / 2.0 + shift)));
  Rect { x, y, w, h }
}

fn faded(color: Color, alpha: f32) -> Color {
  [color[0], color[1], color[2], (color[3] as f32 * alpha).round() as u8]
}

/// Рамка скина девятью частями: углы по BORDER, полосы тянутся, середина разливается.
fn paint_skin(batch: &mut Batch, skin: Skin, rect: Rect, alpha: f32, clip: Option<[f32; 4]>) {
  let base = skin.index() as f32 * 12.0;
  let cuts = [0.0, CORNER, 12.0 - CORNER];
  let sizes = [CORNER, 12.0 - CORNER * 2.0, CORNER];
  for row in 0..3 {
    for column in 0..3 {
      let w = if column == 1 { (rect.w - BORDER * 2.0).max(0.0) } else { BORDER.min(rect.w / 2.0) };
      let h = if row == 1 { (rect.h - BORDER * 2.0).max(0.0) } else { BORDER.min(rect.h / 2.0) };
      let x = match column {
        0 => rect.x,
        1 => rect.x + BORDER,
        _ => rect.x + rect.w - w,
      };
      let y = match row {
        0 => rect.y,
        1 => rect.y + BORDER,
        _ => rect.y + rect.h - h,
      };
      if w > 0.0 && h > 0.0 {
        batch.quad_clipped([x, y], [x + w, y + h], skin_uv(base + cuts[column], cuts[row], sizes[column], sizes[row]), faded([255; 4], alpha), Paint::Skin, clip);
      }
    }
  }
}

fn paint(fonts: &mut Fonts, batch: &mut Batch, node: &Node, clip: Option<[f32; 4]>, alpha: f32) {
  let rect = node.rect;
  if rect.w <= 0.0 || rect.h <= 0.0 {
    return;
  }
  let alpha = alpha * node.style.alpha.unwrap_or(1.0).max(0.0);
  let white = [WHITE_UV[0], WHITE_UV[1], WHITE_UV[0], WHITE_UV[1]];
  if let Some(background) = node.style.background {
    batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], white, faded(background, alpha), Paint::Font, clip);
  }
  if let Some(skin) = node.style.skin {
    paint_skin(batch, skin, rect, alpha, clip);
  }
  if let Some(outline) = node.style.outline {
    let color = faded(outline, alpha);
    let (x, y, w, h) = (rect.x, rect.y, rect.w, rect.h);
    for (min, max) in [([x, y], [x + w, y + OUTLINE]), ([x, y + h - OUTLINE], [x + w, y + h]), ([x, y + OUTLINE], [x + OUTLINE, y + h - OUTLINE]), ([x + w - OUTLINE, y + OUTLINE], [x + w, y + h - OUTLINE])] {
      batch.quad_clipped(min, max, white, color, Paint::Font, clip);
    }
  }
  match &node.leaf {
    Some(Leaf::Text { font, color, shadow, lift, lines, .. }) => {
      for (index, text) in lines.iter().enumerate() {
        let y = rect.y + index as f32 * font.line();
        if let Some(shadow) = shadow {
          fonts.draw(batch, [rect.x + lift, y + lift], *font, faded(*shadow, alpha), text, clip);
        }
        fonts.draw(batch, [rect.x, y], *font, faded(*color, alpha), text, clip);
      }
    }
    Some(Leaf::Image { image, .. }) => match *image {
      Image::Sprite { uv, team } => batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], uv, faded([255; 4], alpha), Paint::Sprite { team }, clip),
      Image::Coin => batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], skin_uv(120.0, 0.0, 8.0, 8.0), faded([255; 4], alpha), Paint::Skin, clip),
      Image::Picture { uv } => {
        batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], uv, faded([255; 4], alpha), Paint::Picture, clip);
      }
      Image::Preview => {
        batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], [0.0, 0.0, 1.0, 1.0], faded([255; 4], alpha), Paint::Preview, clip);
      }
      Image::Minimap => {
        batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], [0.0, 0.0, 1.0, 1.0], faded([255; 4], alpha), Paint::Minimap, clip);
        // Туман поверх: та же картинка обзора, что у карты, без её рамки.
        batch.quad_clipped([rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h], [0.0, 0.0, 1.0, 1.0], faded([255; 4], alpha), Paint::Fog, clip);
      }
    },
    _ => {}
  }
  let inner = if node.style.clip {
    let own = [rect.x, rect.y, rect.w, rect.h];
    Some(match clip {
      Some(outer) => {
        let a = Rect { x: own[0], y: own[1], w: own[2], h: own[3] }.intersect(&Rect { x: outer[0], y: outer[1], w: outer[2], h: outer[3] });
        [a.x, a.y, a.w, a.h]
      }
      None => own,
    })
  } else {
    clip
  };
  for child in &node.children {
    paint(fonts, batch, child, inner, alpha);
  }
}

// ------------------------------------------------------------------ стили из Luau

/// Цвет: число 0xRRGGBB (0xAARRGGBB — с альфой) или строка CSS: "#rrggbb", "#rrggbbaa", "rgb(r g b / a)".
pub fn color(value: &mlua::Value) -> Option<Color> {
  match value {
    mlua::Value::Integer(number) => Some(crate::script::color(*number as u32, None)),
    mlua::Value::Number(number) => Some(crate::script::color(*number as u32, None)),
    mlua::Value::String(text) => {
      let text = text.to_str().ok()?.trim().to_string();
      if let Some(hex) = text.strip_prefix('#') {
        let value = u32::from_str_radix(hex, 16).ok()?;
        return Some(match hex.len() {
          6 => [(value >> 16) as u8, (value >> 8) as u8, value as u8, 255],
          8 => [(value >> 24) as u8, (value >> 16) as u8, (value >> 8) as u8, value as u8],
          _ => return None,
        });
      }
      let inside = text.strip_prefix("rgb(").or_else(|| text.strip_prefix("rgba("))?.strip_suffix(')')?;
      let parts: Vec<f32> = inside.replace(['/', ','], " ").split_whitespace().filter_map(|part| part.parse().ok()).collect();
      let alpha = parts.get(3).copied().unwrap_or(1.0);
      Some([*parts.first()? as u8, *parts.get(1)? as u8, *parts.get(2)? as u8, (alpha * 255.0).round() as u8])
    }
    _ => None,
  }
}

fn number(table: &mlua::Table, key: &str) -> mlua::Result<Option<f32>> {
  table.get::<Option<f32>>(key)
}

/// Стиль узла из таблицы Luau — те же поля, что BoxStyle в ui.ts.
pub fn style(table: Option<&mlua::Table>) -> mlua::Result<Style> {
  let Some(table) = table else { return Ok(Style::default()) };
  let mut style = Style { id: table.get("id")?, ..Default::default() };
  style.direction = match table.get::<Option<String>>("direction")?.as_deref() {
    Some("row") => Direction::Row,
    Some("stack") => Direction::Stack,
    _ => Direction::Column,
  };
  if let Some(pair) = table.get::<Option<Vec<String>>>("self")? {
    style.self_align = Some((Align::parse(pair.first().map_or("start", String::as_str)), Align::parse(pair.get(1).map_or("start", String::as_str))));
  }
  style.gap = number(table, "gap")?.unwrap_or(0.0);
  style.padding = match table.get::<mlua::Value>("padding")? {
    mlua::Value::Table(list) => {
      let values: Vec<f32> = list.sequence_values::<f32>().collect::<mlua::Result<_>>()?;
      match values.as_slice() {
        [vertical, horizontal] => [*vertical, *horizontal, *vertical, *horizontal],
        [top, right, bottom, left] => [*top, *right, *bottom, *left],
        [all] => [*all; 4],
        _ => [0.0; 4],
      }
    }
    mlua::Value::Integer(all) => [all as f32; 4],
    mlua::Value::Number(all) => [all as f32; 4],
    _ => [0.0; 4],
  };
  style.align = Align::parse(table.get::<Option<String>>("align")?.as_deref().unwrap_or("start"));
  style.justify = Align::parse(table.get::<Option<String>>("justify")?.as_deref().unwrap_or("start"));
  style.width = number(table, "width")?;
  style.height = number(table, "height")?;
  style.min_width = number(table, "minWidth")?.unwrap_or(0.0);
  style.max_width = number(table, "maxWidth")?;
  style.min_height = number(table, "minHeight")?.unwrap_or(0.0);
  style.max_height = number(table, "maxHeight")?;
  style.grow = number(table, "grow")?.unwrap_or(0.0);
  style.shrink = table.get::<Option<bool>>("shrink")?.unwrap_or(false);
  style.wrap = table.get::<Option<bool>>("wrap")?.unwrap_or(false);
  style.skin = table.get::<Option<String>>("skin")?.as_deref().and_then(Skin::parse);
  style.background = color(&table.get::<mlua::Value>("background")?);
  style.outline = color(&table.get::<mlua::Value>("outline")?);
  style.alpha = number(table, "alpha")?;
  style.scroll = table.get::<Option<bool>>("scroll")?.unwrap_or(false);
  style.clip = table.get::<Option<bool>>("clip")?.unwrap_or(false) || style.scroll;
  style.passive = table.get::<Option<bool>>("passive")?.unwrap_or(false);
  if let Some(table) = table.get::<Option<mlua::Table>>("anchor")? {
    style.anchor = Some(anchor(&table)?);
  }
  Ok(style)
}

/// Привязка корневой панели: left, right, top, bottom, centerX, centerY в пикселях.
pub fn anchor(table: &mlua::Table) -> mlua::Result<Anchor> {
  Ok(Anchor { left: number(table, "left")?, right: number(table, "right")?, top: number(table, "top")?, bottom: number(table, "bottom")?, center_x: number(table, "centerX")?, center_y: number(table, "centerY")? })
}

/// Текст из Luau: стиль — font, color, shadow, lift, wrap (true или число), ellipsis.
pub fn text_leaf(text: String, table: Option<&mlua::Table>) -> mlua::Result<Leaf> {
  let get = |key: &str| table.map_or(Ok(mlua::Value::Nil), |table| table.get::<mlua::Value>(key));
  let font = FontName::parse(&table.map_or(Ok(None), |table| table.get::<Option<String>>("font"))?.unwrap_or_default());
  let color = color(&get("color")?).unwrap_or(hex(0xd6e6f5));
  let shadow = color_opt(&get("shadow")?);
  let lift = table.map_or(Ok(None), |table| table.get::<Option<f32>>("lift"))?.unwrap_or(1.0);
  let wrap = match get("wrap")? {
    mlua::Value::Boolean(true) => Some(f32::INFINITY),
    mlua::Value::Integer(width) => Some(width as f32),
    mlua::Value::Number(width) => Some(width as f32),
    _ => None,
  };
  let ellipsis = matches!(get("ellipsis")?, mlua::Value::Boolean(true));
  Ok(Leaf::Text { text, font, color, shadow, lift, wrap, ellipsis, lines: Vec::new() })
}

fn color_opt(value: &mlua::Value) -> Option<Color> {
  color(value)
}
