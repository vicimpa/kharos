//! Замер рендера на стеке клиента rwgpu (docs/content.md, §6): окно winit, контекст glutin (GL 3.3 core), рисование
//! glow. Юниты — багги из `base/units/buggy.luau`: его чертёж растеризуется в атлас (64 направления × 2 фазы), ходовая
//! `base/moves/wheels.luau` двигает всех каждый кадр. Вертикальной синхронизации нет: кадр идёт сразу за кадром. Через
//! SECONDS секунд печатает время кадра по частям и закрывается.
//!
//!   cargo run -p content-bench --release --bin render [юнитов] [plain|day|night|night-old] [качество теней]
//!
//! plain — только спрайты одним вызовом с инстансингом. day и night — кадр, как в Kharos сейчас
//! (packages/client/src/weather/lightingPass.ts, game/units/unitsPass.ts): земля, тени юнитов, спрайты с палитрой
//! стороны; ночью ещё карта силуэтов, карта освещённости в сетке местности (16 текселей на тайл) с фарами и лучами —
//! тень луча ищется проверками по силуэтам (10, 20 или 40, как настройка графики), — умножение на неё и ореолы.

use content_bench::{bytes, load, new_lua, Pixmap, TURN};
use glow::HasContext as _;
use glutin::config::ConfigTemplateBuilder;
use glutin::context::{ContextApi, ContextAttributesBuilder, GlProfile, NotCurrentGlContext as _, PossiblyCurrentContext, Version};
use glutin::display::{GetGlDisplay as _, GlDisplay as _};
use glutin::surface::{GlSurface as _, Surface, SwapInterval, WindowSurface};
use glutin_winit::{DisplayBuilder, GlWindow as _};
use mlua::{Buffer, Function, Lua, Table};
use raw_window_handle::HasWindowHandle as _;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

/// Поле в тайлах: всё целиком на экране, юнит — два тайла, как в игре; 16 текселей местности на тайл.
const WIDTH: f64 = 160.0;
const HEIGHT: f64 = 100.0;
const TEXELS: f32 = 16.0;
const DIRECTIONS: usize = 64;
const PHASES: usize = 2;
/// Атлас: кадры 32×32 сеткой 16 × 8.
const COLUMNS: usize = 16;
const SECONDS: f64 = 10.0;
const WARMUP: f64 = 2.0;
/// На каком тике снимать кадр для RENDER_SHOT.
const SHOT_TICK: u64 = 60;

// Огни багги — как UNIT_LIGHTS.buggy в unitArt.ts: две фары (along, across, glow) и луч.
const LAMPS: [(f32, f32, f32); 2] = [(7.0, -2.0, 2.0), (7.0, 2.0, 2.0)];
// Луч стоит за корпусом: капсула багги из buggy.luau доходит до 11,5 текселя от центра, а в Kharos источник ставят так,
// чтобы свой юнит его не загораживал (along 10 там — у меньшего корпуса).
const BEAM: (f32, f32, f32, f32, f32) = (13.0, 60.0, 4.0, 0.28, 1.0); // along, length, near, spread, level
const LIGHT_COLOR: [f32; 3] = [0xa8 as f32 / 255.0, 0xd0 as f32 / 255.0, 1.0];
const BLOOM_COLOR: [f32; 3] = [0x5a as f32 / 255.0, 0xa9 as f32 / 255.0, 1.0];
/// Ночь: цвет карты освещённости без огней (lightTint(0)) и ореолы в полную силу.
const NIGHT: [f32; 3] = [0.16, 0.2, 0.42];
const SHADOW_SHIFT: f32 = 2.0 / 16.0;
const SHADOW_ALPHA: f32 = 0.4;
/// Цвета стороны, как TEAMS.own в unitArt.ts: тёмный, основной, светлый.
const PALETTE: [f32; 9] = [0x1f as f32 / 255.0, 0x63 as f32 / 255.0, 0xd8 as f32 / 255.0, 0x5a as f32 / 255.0, 0xa9 as f32 / 255.0, 1.0, 0xe4 as f32 / 255.0, 0xf4 as f32 / 255.0, 1.0];

/// Тайлы — от середины поля, как координаты от камеры в Kharos; uScale переводит их в NDC.
const COMMON: &str = r#"#version 330 core
uniform vec2 uScale;
const float TEXELS_PER_TILE = 16.0;
"#;

const LAND_VS: &str = r#"
out vec2 vTile;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0;
  vTile = corner / uScale;
  vTile.y = -vTile.y;
  gl_Position = vec4(corner, 0.0, 1.0);
}
"#;

// Земля: тайл берётся из карты, у каждого текселя — своя крупинка.
const LAND_FS: &str = r#"
in vec2 vTile;
uniform sampler2D uLand;
uniform vec2 uField;
out vec4 color;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 tile = vTile + uField * 0.5;
  vec4 land = texture(uLand, tile / uField);
  float grain = hash(floor(tile * TEXELS_PER_TILE));
  color = vec4(land.rgb * (0.9 + 0.12 * grain), 1.0);
}
"#;

const SPRITE_VS: &str = r#"
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 unit;
uniform vec2 uShift;
out vec2 vUv;
void main() {
  vec2 at = unit.xy + (corner - 0.5) * 2.0 + uShift;
  gl_Position = vec4(at.x * uScale.x, -at.y * uScale.y, 0.0, 1.0);
  vec2 cell = vec2(mod(unit.z, 16.0), floor(unit.z / 16.0));
  vUv = (cell + corner) / vec2(16.0, 8.0);
}
"#;

// uMode 0 — спрайт: метка тона в альфе (254 − тон) — цвет стороны из палитры; 1 — тень; 2 — силуэт.
const SPRITE_FS: &str = r#"
in vec2 vUv;
uniform sampler2D uAtlas;
uniform vec3 uPalette[3];
uniform int uMode;
uniform float uShadow;
out vec4 color;
void main() {
  vec4 texel = texture(uAtlas, vUv);
  if (texel.a < 0.5) discard;
  if (uMode == 1) { color = vec4(0.0, 0.0, 0.0, uShadow); return; }
  if (uMode == 2) { color = vec4(1.0); return; }
  float mark = floor(texel.a * 255.0 + 0.5);
  vec3 rgb = mark < 254.5 ? uPalette[int(254.0 - mark)] : texel.rgb;
  color = vec4(rgb, 1.0);
}
"#;

// Пятно света — SPOT_VERTEX и SPOT_FRAGMENT из lightingPass.ts.
const SPOT_VS: &str = r#"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSpot;
out vec2 vTexel;
flat out float vRadius;
flat out float vLevel;
void main() {
  vRadius = aSpot.z;
  vLevel = aSpot.w;
  vTexel = aCorner * vRadius * 2.0;
  vec2 tile = aSpot.xy + (vTexel - vRadius) / TEXELS_PER_TILE;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
"#;

const SPOT_FS: &str = r#"
in vec2 vTexel;
flat in float vRadius;
flat in float vLevel;
uniform vec3 uColor;
uniform float uStrength;
out vec4 finalColor;
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 texel = ivec2(floor(vTexel));
  float falloff = length(vec2(texel) + 0.5 - vRadius) / vRadius;
  float value = pow(max(0.0, 1.0 - falloff), 2.0);
  float dither = (BAYER[(texel.y & 3) * 4 + (texel.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vLevel * uStrength;
  finalColor = vec4(uColor * alpha, alpha);
}
"#;

// Луч — BEAM_VERTEX и beamFragment из lightingPass.ts.
const BEAM_VS: &str = r#"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aBeam;
layout(location = 2) in vec4 aCone;
out vec2 vTexel;
flat out vec4 vBeam;
flat out vec4 vCone;
void main() {
  vBeam = aBeam;
  vCone = aCone;
  vTexel = (aCorner * 2.0 - 1.0) * aBeam.z;
  vec2 tile = aBeam.xy + vTexel / TEXELS_PER_TILE;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
"#;

fn beam_fs(steps: u32) -> String {
  format!(
    r#"
in vec2 vTexel;
flat in vec4 vBeam;
flat in vec4 vCone;
uniform vec3 uColor;
uniform sampler2D uOccluders;
out vec4 finalColor;
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
const int STEPS = {steps};
const float SKIP = 1.5;
void main() {{
  ivec2 cell = ivec2(floor(vTexel));
  vec2 texel = vec2(cell) + 0.5;
  vec2 direction = vCone.xy;
  float along = dot(texel, direction);
  float across = abs(dot(texel, vec2(-direction.y, direction.x)));
  float side = across / (vCone.z + max(along, 0.0) * vCone.w);
  float value = pow(max(0.0, 1.0 - length(texel) / vBeam.z), 1.5) * max(0.0, 1.0 - side * side);
  if (along <= 0.0 || value <= 0.0) discard;
  vec2 from = vBeam.xy + texel / TEXELS_PER_TILE;
  vec2 to = vBeam.xy + direction * SKIP / TEXELS_PER_TILE;
  bool outside = false;
  bool shaded = false;
  for (int i = 0; i < STEPS; i++) {{
    vec2 tile = mix(from, to, (float(i) + 0.5) / float(STEPS));
    vec2 uv = vec2(tile.x * uScale.x, -tile.y * uScale.y) * 0.5 + 0.5;
    bool solid = textureLod(uOccluders, uv, 0.0).a > 0.5;
    if (!solid) outside = true;
    else if (outside) shaded = true;
  }}
  if (shaded) discard;
  float dither = (BAYER[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vBeam.w;
  finalColor = vec4(uColor * alpha, alpha);
}}
"#
  )
}

// Быстрый луч. Квадрат — трапеция ровно по конусу луча с запасом в тексель: вне конуса шейдер всё равно ничего не
// рисует, а фрагментов так в несколько раз меньше; vTexel тот же, что у квадрата вокруг источника.
const BEAM_FAST_VS: &str = r#"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aBeam;
layout(location = 2) in vec4 aCone;
out vec2 vTexel;
flat out vec4 vBeam;
flat out vec4 vCone;
void main() {
  vBeam = aBeam;
  vCone = aCone;
  float along = mix(-1.0, aBeam.z + 1.0, aCorner.x);
  float width = aCone.z + max(along, 0.0) * aCone.w + 1.0;
  float across = (aCorner.y * 2.0 - 1.0) * width;
  vTexel = aCone.xy * along + vec2(-aCone.y, aCone.x) * across;
  vec2 tile = aBeam.xy + vTexel / TEXELS_PER_TILE;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
"#;

/// Быстрый луч: тень проверяется раз в spacing текселей пути до источника (ближним — меньше проверок, а не 40 на
/// каждый), и поиск кончается, как только тень найдена.
fn beam_fast_fs(spacing: f32) -> String {
  format!(
    r#"
in vec2 vTexel;
flat in vec4 vBeam;
flat in vec4 vCone;
uniform vec3 uColor;
uniform sampler2D uOccluders;
out vec4 finalColor;
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
const float SPACING = {spacing:.3};
const int MAX_STEPS = 64;
const float SKIP = 1.5;
void main() {{
  ivec2 cell = ivec2(floor(vTexel));
  vec2 texel = vec2(cell) + 0.5;
  vec2 direction = vCone.xy;
  float along = dot(texel, direction);
  float across = abs(dot(texel, vec2(-direction.y, direction.x)));
  float side = across / (vCone.z + max(along, 0.0) * vCone.w);
  float value = pow(max(0.0, 1.0 - length(texel) / vBeam.z), 1.5) * max(0.0, 1.0 - side * side);
  if (along <= 0.0 || value <= 0.0) discard;
  vec2 from = vBeam.xy + texel / TEXELS_PER_TILE;
  vec2 to = vBeam.xy + direction * SKIP / TEXELS_PER_TILE;
  int steps = max(1, int(ceil(max(length(texel) - SKIP, 0.0) / SPACING)));
  bool outside = false;
  for (int i = 0; i < MAX_STEPS; i++) {{
    if (i >= steps) break;
    // Последняя проверка — ровно у источника: фара, закопанная в соседа, гаснет при любом шаге.
    vec2 tile = mix(from, to, float(i + 1) / float(steps));
    vec2 uv = vec2(tile.x * uScale.x, -tile.y * uScale.y) * 0.5 + 0.5;
    bool solid = textureLod(uOccluders, uv, 0.0).r > 0.5;
    if (!solid) outside = true;
    else if (outside) discard;
  }}
  float dither = (BAYER[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vBeam.w;
  finalColor = vec4(uColor * alpha, alpha);
}}
"#
  )
}

const BLIT_VS: &str = r#"
out vec2 vUv;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vUv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
"#;

const BLIT_FS: &str = r#"
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 color;
void main() { color = texture(uTexture, vUv); }
"#;

/// Чертёж вида на все направления и фазы — атлас RGBA. Цвет стороны (метка тона в старшем байте) — альфой 254 − тон,
/// как в Kharos: перекрашивает шейдер палитрой.
fn atlas(lua: &Lua, look: &Table) -> mlua::Result<(Vec<u8>, usize, usize)> {
  let draw: Function = look.get("draw")?;
  let frame: usize = look.get("frame")?;
  let rows = DIRECTIONS * PHASES / COLUMNS;
  let (width, height) = (COLUMNS * frame, rows * frame);
  let mut pixels = vec![0u8; width * height * 4];
  for phase in 0..PHASES {
    for direction in 0..DIRECTIONS {
      let canvas = lua.create_userdata(Pixmap { size: frame, data: vec![0; frame * frame] })?;
      draw.call::<()>((&canvas, direction as f64 / DIRECTIONS as f64 * TURN, phase))?;
      let index = phase * DIRECTIONS + direction;
      let (left, top) = (index % COLUMNS * frame, index / COLUMNS * frame);
      for (at, &color) in canvas.borrow::<Pixmap>()?.data.iter().enumerate() {
        if color == 0 {
          continue;
        }
        let mark = color >> 24;
        let alpha = if mark == 0 { 255 } else { 255 - mark as u8 };
        let offset = ((top + at / frame) * width + left + at % frame) * 4;
        pixels[offset..offset + 4].copy_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, color as u8, alpha]);
      }
    }
  }
  Ok((pixels, width, height))
}

/// Мир замера: машина Luau, ходовая и столбцы юнитов буферами.
struct Sim {
  _lua: Lua,
  system: Function,
  ctx: Table,
  x: Buffer,
  y: Buffer,
  facing: Buffer,
  units: usize,
  tick: u64,
}

impl Sim {
  fn new(units: usize) -> mlua::Result<(Self, (Vec<u8>, usize, usize))> {
    let lua = new_lua(true)?;
    let wheels = load(&lua, "moves/wheels.luau")?;
    let buggy = load(&lua, "units/buggy.luau")?;
    let data: Table = buggy.get("data")?;
    let art = atlas(&lua, &buggy.get("look")?)?;
    let spread = |i: usize, salt: usize, size: f64| ((i * 2654435761 + salt) % size as usize) as f64 + 0.5;
    let column = |salt: usize, size: f64| lua.create_buffer(bytes(&(0..units).map(|i| spread(i, salt, size)).collect::<Vec<_>>()));
    let (x, y, tx, ty) = (column(1, WIDTH)?, column(7, HEIGHT)?, column(13, WIDTH)?, column(29, HEIGHT)?);
    let facing = lua.create_buffer(vec![0u8; units * 8])?;
    let ctx = lua.create_table();
    for (name, buffer) in [("x", &x), ("y", &y), ("facing", &facing), ("tx", &tx), ("ty", &ty)] {
      ctx.set(name, buffer.clone())?;
    }
    ctx.set("n", units)?;
    ctx.set("speed", data.get::<f64>("speed")?)?;
    ctx.set("turn", data.get::<f64>("turn")?)?;
    ctx.set("dt", 0.05)?;
    ctx.set("width", WIDTH)?;
    ctx.set("height", HEIGHT)?;
    let system: Function = wheels.get::<Table>("systems")?.get("move")?;
    Ok((Self { _lua: lua, system, ctx, x, y, facing, units, tick: 0 }, art))
  }

  fn step(&mut self) {
    self.ctx.set("tick", self.tick).unwrap();
    self.system.call::<()>(&self.ctx).unwrap();
    self.tick += 1;
  }

  /// Что рисовать: спрайты (место от середины поля, кадр атласа), а ночью ещё фары (x, y, радиус, яркость — пятно на
  /// земле и ореол вдвое меньше) и лучи (x, y, длина, яркость, cos, sin, ближняя полуширина, расширение), как в unitsPass.
  fn instances(&self, sprites: &mut Vec<f32>, spots: &mut Vec<f32>, blooms: &mut Vec<f32>, beams: &mut Vec<f32>, lights: bool) {
    let (x, y, facing) = (self.x.to_vec(), self.y.to_vec(), self.facing.to_vec());
    let read = |column: &[u8], i: usize| f64::from_le_bytes(column[i * 8..i * 8 + 8].try_into().unwrap()) as f32;
    let snap = |value: f32| (value * TEXELS).round() / TEXELS;
    for list in [&mut *sprites, &mut *spots, &mut *blooms, &mut *beams] {
      list.clear();
    }
    let phase = (self.tick / 4 % PHASES as u64) as usize;
    let (half_x, half_y) = (WIDTH as f32 / 2.0, HEIGHT as f32 / 2.0);
    for i in 0..self.units {
      let (ux, uy, face) = (read(&x, i) - half_x, read(&y, i) - half_y, read(&facing, i));
      let direction = (face as f64 / TURN * DIRECTIONS as f64).round().rem_euclid(DIRECTIONS as f64) as usize;
      sprites.extend_from_slice(&[ux, uy, (phase * DIRECTIONS + direction) as f32]);
      if !lights {
        continue;
      }
      let (forward_x, forward_y) = (face.cos() / TEXELS, face.sin() / TEXELS);
      for (along, across, glow) in LAMPS {
        let (lx, ly) = (snap(ux + along * forward_x - across * forward_y), snap(uy + along * forward_y + across * forward_x));
        spots.extend_from_slice(&[lx, ly, glow * 2.0, 1.0]);
        blooms.extend_from_slice(&[lx, ly, glow, 1.0]);
      }
      let (along, length, near, spread, level) = BEAM;
      beams.extend_from_slice(&[snap(ux + along * forward_x), snap(uy + along * forward_y), length, level, face.cos(), face.sin(), near, spread]);
    }
  }
}

/// Цель отрисовки: текстура и её кадровый буфер.
struct Target {
  framebuffer: glow::Framebuffer,
  texture: glow::Texture,
}

struct Programs {
  land: glow::Program,
  sprite: glow::Program,
  spot: glow::Program,
  beam: glow::Program,
  blit: glow::Program,
}

struct Gpu {
  window: Window,
  surface: Surface<WindowSurface>,
  context: PossiblyCurrentContext,
  gl: glow::Context,
  programs: Programs,
  /// Вершинные массивы спрайтов, пятен и лучей, у каждого свой буфер инстансов.
  sprite_vao: glow::VertexArray,
  sprite_data: glow::Buffer,
  spot_vao: glow::VertexArray,
  spot_data: glow::Buffer,
  beam_vao: glow::VertexArray,
  beam_data: glow::Buffer,
  empty_vao: glow::VertexArray,
  atlas: glow::Texture,
  land: glow::Texture,
  occluders: Target,
  occluder_size: (i32, i32),
  lightmap: Target,
  size: (i32, i32),
}

#[derive(Default)]
struct Times {
  frames: u32,
  sim: f64,
  build: f64,
  draw: f64,
  swap: f64,
  total: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
  Plain,
  Day,
  /// Быстрые лучи: param — через сколько текселей пути проверка тени.
  Night,
  /// Лучи, как в Kharos сейчас: param — проверок тени на тексель.
  NightOld,
}

struct Frame {
  sprites: Vec<f32>,
  spots: Vec<f32>,
  blooms: Vec<f32>,
  beams: Vec<f32>,
}

struct Bench {
  units: usize,
  mode: Mode,
  param: f32,
  gpu: Option<Gpu>,
  sim: Option<Sim>,
  frame: Frame,
  started: Option<Instant>,
  last: Option<Instant>,
  times: Times,
  /// Замер кончился: выход попрошен, а кадры ещё могут прийти.
  done: bool,
}

unsafe fn program(gl: &glow::Context, vertex: &str, fragment: &str) -> glow::Program {
  let program = gl.create_program().unwrap();
  for (kind, source) in [(glow::VERTEX_SHADER, vertex), (glow::FRAGMENT_SHADER, fragment)] {
    let shader = gl.create_shader(kind).unwrap();
    gl.shader_source(shader, &format!("{COMMON}{source}"));
    gl.compile_shader(shader);
    assert!(gl.get_shader_compile_status(shader), "{}", gl.get_shader_info_log(shader));
    gl.attach_shader(program, shader);
  }
  gl.link_program(program);
  assert!(gl.get_program_link_status(program), "{}", gl.get_program_info_log(program));
  program
}

unsafe fn texture(gl: &glow::Context, width: i32, height: i32, pixels: Option<&[u8]>) -> glow::Texture {
  texture_as(gl, width, height, pixels, glow::RGBA8, glow::RGBA)
}

unsafe fn texture_as(gl: &glow::Context, width: i32, height: i32, pixels: Option<&[u8]>, internal: u32, format: u32) -> glow::Texture {
  let texture = gl.create_texture().unwrap();
  gl.bind_texture(glow::TEXTURE_2D, Some(texture));
  gl.tex_image_2d(glow::TEXTURE_2D, 0, internal as i32, width, height, 0, format, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(pixels));
  for (name, value) in [(glow::TEXTURE_MIN_FILTER, glow::NEAREST), (glow::TEXTURE_MAG_FILTER, glow::NEAREST), (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE), (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE)] {
    gl.tex_parameter_i32(glow::TEXTURE_2D, name, value as i32);
  }
  texture
}

unsafe fn target(gl: &glow::Context, width: i32, height: i32) -> Target {
  target_as(gl, width, height, glow::RGBA8, glow::RGBA)
}

unsafe fn target_as(gl: &glow::Context, width: i32, height: i32, internal: u32, format: u32) -> Target {
  let texture = texture_as(gl, width, height, None, internal, format);
  let framebuffer = gl.create_framebuffer().unwrap();
  gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
  gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(texture), 0);
  gl.bind_framebuffer(glow::FRAMEBUFFER, None);
  Target { framebuffer, texture }
}

/// Вершинный массив с общим квадратом (атрибут 0) и буфером инстансов: атрибуты 1.. по widths чисел.
unsafe fn instanced(gl: &glow::Context, corners: glow::Buffer, widths: &[i32]) -> (glow::VertexArray, glow::Buffer) {
  let vao = gl.create_vertex_array().unwrap();
  gl.bind_vertex_array(Some(vao));
  gl.bind_buffer(glow::ARRAY_BUFFER, Some(corners));
  gl.enable_vertex_attrib_array(0);
  gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);
  let data = gl.create_buffer().unwrap();
  gl.bind_buffer(glow::ARRAY_BUFFER, Some(data));
  let stride: i32 = widths.iter().sum::<i32>() * 4;
  let mut offset = 0;
  for (i, &width) in widths.iter().enumerate() {
    let location = i as u32 + 1;
    gl.enable_vertex_attrib_array(location);
    gl.vertex_attrib_pointer_f32(location, width, glow::FLOAT, false, stride, offset);
    gl.vertex_attrib_divisor(location, 1);
    offset += width * 4;
  }
  (vao, data)
}

impl Gpu {
  unsafe fn uniform(&self, program: glow::Program, name: &str) -> Option<glow::UniformLocation> {
    self.gl.get_uniform_location(program, name)
  }

  unsafe fn upload(&self, buffer: glow::Buffer, data: &[f32]) {
    self.gl.bind_buffer(glow::ARRAY_BUFFER, Some(buffer));
    self.gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 4), glow::STREAM_DRAW);
  }

  unsafe fn use_program(&self, program: glow::Program) {
    self.gl.use_program(Some(program));
    self.gl.uniform_2_f32(self.uniform(program, "uScale").as_ref(), 2.0 / WIDTH as f32, 2.0 / HEIGHT as f32);
  }

  unsafe fn sprites(&self, count: usize, mode: i32, shift: f32) {
    let (gl, program) = (&self.gl, self.programs.sprite);
    self.use_program(program);
    gl.uniform_1_i32(self.uniform(program, "uMode").as_ref(), mode);
    gl.uniform_2_f32(self.uniform(program, "uShift").as_ref(), shift, shift);
    gl.uniform_1_f32(self.uniform(program, "uShadow").as_ref(), SHADOW_ALPHA);
    gl.uniform_3_f32_slice(self.uniform(program, "uPalette").as_ref(), &PALETTE);
    gl.bind_texture(glow::TEXTURE_2D, Some(self.atlas));
    gl.bind_vertex_array(Some(self.sprite_vao));
    gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, count as i32);
  }

  unsafe fn spots(&self, data: &[f32], color: [f32; 3]) {
    let (gl, program) = (&self.gl, self.programs.spot);
    self.upload(self.spot_data, data);
    self.use_program(program);
    gl.uniform_3_f32(self.uniform(program, "uColor").as_ref(), color[0], color[1], color[2]);
    gl.uniform_1_f32(self.uniform(program, "uStrength").as_ref(), 1.0);
    gl.bind_vertex_array(Some(self.spot_vao));
    gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (data.len() / 4) as i32);
  }

  /// Кадр, как в Kharos: земля, тени, спрайты; ночью — силуэты, карта освещённости, умножение и ореолы.
  unsafe fn draw(&self, mode: Mode, frame: &Frame) {
    let gl = &self.gl;
    let count = frame.sprites.len() / 3;
    gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    gl.viewport(0, 0, self.size.0, self.size.1);
    gl.active_texture(glow::TEXTURE0);
    self.upload(self.sprite_data, &frame.sprites);
    if mode == Mode::Plain {
      gl.clear_color(0.16, 0.13, 0.10, 1.0);
      gl.clear(glow::COLOR_BUFFER_BIT);
      self.sprites(count, 0, 0.0);
      return;
    }
    gl.disable(glow::BLEND);
    self.use_program(self.programs.land);
    gl.uniform_2_f32(self.uniform(self.programs.land, "uField").as_ref(), WIDTH as f32, HEIGHT as f32);
    gl.bind_texture(glow::TEXTURE_2D, Some(self.land));
    gl.bind_vertex_array(Some(self.empty_vao));
    gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);

    gl.enable(glow::BLEND);
    gl.blend_func(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA);
    self.sprites(count, 1, SHADOW_SHIFT);
    gl.disable(glow::BLEND);
    self.sprites(count, 0, 0.0);
    if mode == Mode::Day {
      return;
    }

    // Карта освещённости — в сетке местности: 16 текселей на тайл; карта силуэтов — своего размера.
    let (map_width, map_height) = ((WIDTH as f32 * TEXELS) as i32, (HEIGHT as f32 * TEXELS) as i32);
    gl.viewport(0, 0, self.occluder_size.0, self.occluder_size.1);
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.occluders.framebuffer));
    gl.clear_color(0.0, 0.0, 0.0, 0.0);
    gl.clear(glow::COLOR_BUFFER_BIT);
    self.sprites(count, 2, 0.0);

    gl.enable(glow::BLEND);
    gl.blend_func(glow::ONE, glow::ONE);
    gl.viewport(0, 0, map_width, map_height);
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.lightmap.framebuffer));
    gl.clear_color(NIGHT[0], NIGHT[1], NIGHT[2], 1.0);
    gl.clear(glow::COLOR_BUFFER_BIT);
    self.spots(&frame.spots, LIGHT_COLOR);
    self.upload(self.beam_data, &frame.beams);
    self.use_program(self.programs.beam);
    gl.uniform_3_f32(self.uniform(self.programs.beam, "uColor").as_ref(), LIGHT_COLOR[0], LIGHT_COLOR[1], LIGHT_COLOR[2]);
    gl.bind_texture(glow::TEXTURE_2D, Some(self.occluders.texture));
    gl.bind_vertex_array(Some(self.beam_vao));
    gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (frame.beams.len() / 8) as i32);

    gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    gl.viewport(0, 0, self.size.0, self.size.1);
    gl.blend_func(glow::DST_COLOR, glow::ZERO);
    self.use_program(self.programs.blit);
    gl.bind_texture(glow::TEXTURE_2D, Some(self.lightmap.texture));
    gl.bind_vertex_array(Some(self.empty_vao));
    gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    gl.blend_func(glow::ONE, glow::ONE);
    self.spots(&frame.blooms, BLOOM_COLOR);
  }
}

impl Gpu {
  /// Кадр картинкой PNG: кадр рисуется заново и читается из кадрового буфера.
  fn shot(&self, path: &str) {
    let (width, height) = self.size;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    unsafe {
      self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
      self.gl.read_pixels(0, 0, width, height, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut pixels)));
    }
    // GL читает снизу вверх.
    let rows: Vec<u8> = pixels.chunks_exact((width * 4) as usize).rev().flatten().copied().collect();
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(path).unwrap()), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.write_header().unwrap().write_image_data(&rows).unwrap();
  }
}

impl Bench {
  fn tick(&mut self, event_loop: &ActiveEventLoop) {
    if self.done {
      return;
    }
    let (Some(gpu), Some(sim)) = (&self.gpu, &mut self.sim) else { return };
    let start = Instant::now();
    sim.step();
    let simulated = Instant::now();
    let frame = &mut self.frame;
    sim.instances(&mut frame.sprites, &mut frame.spots, &mut frame.blooms, &mut frame.beams, matches!(self.mode, Mode::Night | Mode::NightOld));
    let built = Instant::now();
    unsafe { gpu.draw(self.mode, frame) };
    let drawn = Instant::now();
    // RENDER_SHOT=файл.png — кадр на тике SHOT_TICK картинкой, без замера: сравнить, что рисуют разные варианты.
    if let Ok(path) = std::env::var("RENDER_SHOT") {
      if sim.tick == SHOT_TICK {
        gpu.shot(&path);
        self.done = true;
        event_loop.exit();
        return;
      }
    }
    gpu.surface.swap_buffers(&gpu.context).unwrap();
    let swapped = Instant::now();

    let started = *self.started.get_or_insert(start);
    let elapsed = start.duration_since(started).as_secs_f64();
    if elapsed > WARMUP {
      let ms = |from: Instant, to: Instant| to.duration_since(from).as_secs_f64() * 1000.0;
      let t = &mut self.times;
      t.frames += 1;
      t.sim += ms(start, simulated);
      t.build += ms(simulated, built);
      t.draw += ms(built, drawn);
      t.swap += ms(drawn, swapped);
      if let Some(last) = self.last {
        t.total += ms(last, start);
      }
    }
    self.last = Some(start);
    if elapsed > WARMUP + SECONDS {
      let t = &self.times;
      let n = t.frames as f64;
      let frame = t.total / (n - 1.0);
      let mode = match self.mode {
        Mode::Plain => "только спрайты".to_owned(),
        Mode::Day => "день: земля, тени, палитра".to_owned(),
        Mode::Night => format!("ночь: быстрые лучи, проверка тени раз в {} текселя", self.param),
        Mode::NightOld => format!("ночь: лучи, как сейчас, {} проверок тени", self.param),
      };
      println!("{} юнитов, {mode}, окно {}×{} пикселей, {} кадров за {SECONDS} с", self.units, gpu.size.0, gpu.size.1, t.frames);
      println!("  кадр: {frame:.3} мс — {:.0} кадров в секунду", 1000.0 / frame);
      println!("  ход на Luau: {:.3} мс, сборка инстансов: {:.3} мс, отправка в GL: {:.3} мс, swap (ждёт видеокарту): {:.3} мс", t.sim / n, t.build / n, t.draw / n, t.swap / n);
      self.done = true;
      event_loop.exit();
    }
  }
}

impl ApplicationHandler for Bench {
  fn resumed(&mut self, event_loop: &ActiveEventLoop) {
    if self.gpu.is_some() {
      return;
    }
    let attributes = Window::default_attributes().with_title("Kharos: замер рендера").with_inner_size(LogicalSize::new(1280.0, 800.0)).with_resizable(false);
    let (window, config) = DisplayBuilder::new().with_window_attributes(Some(attributes)).build(event_loop, ConfigTemplateBuilder::new(), |mut configs| configs.next().unwrap()).unwrap();
    let window = window.unwrap();
    let handle = window.window_handle().ok().map(|handle| handle.as_raw());
    let context_attributes = ContextAttributesBuilder::new().with_profile(GlProfile::Core).with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3)))).build(handle);
    let display = config.display();
    let context = unsafe { display.create_context(&config, &context_attributes) }.unwrap();
    let surface_attributes = window.build_surface_attributes(Default::default()).unwrap();
    let surface = unsafe { display.create_window_surface(&config, &surface_attributes) }.unwrap();
    let context = context.make_current(&surface).unwrap();
    if let Err(error) = surface.set_swap_interval(&context, SwapInterval::DontWait) {
      eprintln!("вертикальную синхронизацию не выключить: {error}");
    }
    let gl = unsafe { glow::Context::from_loader_function_cstr(|name| display.get_proc_address(name)) };
    let size = (window.inner_size().width as i32, window.inner_size().height as i32);

    let (sim, (pixels, atlas_width, atlas_height)) = Sim::new(self.units).unwrap();
    let gpu = unsafe {
      let programs = Programs {
        land: program(&gl, LAND_VS, LAND_FS),
        sprite: program(&gl, SPRITE_VS, SPRITE_FS),
        spot: program(&gl, SPOT_VS, SPOT_FS),
        beam: if self.mode == Mode::NightOld { program(&gl, BEAM_VS, &beam_fs(self.param as u32)) } else { program(&gl, BEAM_FAST_VS, &beam_fast_fs(self.param)) },
        blit: program(&gl, BLIT_VS, BLIT_FS),
      };
      let atlas = texture(&gl, atlas_width as i32, atlas_height as i32, Some(&pixels));
      // Земля: тайл — тексель карты, скала и песок пятнами.
      let land: Vec<u8> = (0..WIDTH as usize * HEIGHT as usize).flat_map(|i| if (i * 2654435761) % 7 < 2 { [0x6b, 0x60, 0x58, 255] } else { [0xb0, 0x8a, 0x5c, 255] }).collect();
      let land = texture(&gl, WIDTH as i32, HEIGHT as i32, Some(&land));
      let corners = gl.create_buffer().unwrap();
      gl.bind_buffer(glow::ARRAY_BUFFER, Some(corners));
      let quad: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
      gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, std::slice::from_raw_parts(quad.as_ptr() as *const u8, 32), glow::STATIC_DRAW);
      let (sprite_vao, sprite_data) = instanced(&gl, corners, &[3]);
      let (spot_vao, spot_data) = instanced(&gl, corners, &[4]);
      let (beam_vao, beam_data) = instanced(&gl, corners, &[4, 4]);
      let empty_vao = gl.create_vertex_array().unwrap();
      let (map_width, map_height) = ((WIDTH as f32 * TEXELS) as i32, (HEIGHT as f32 * TEXELS) as i32);
      // Быстрым лучам карта силуэтов — один канал: лучу нужен только бит «есть преграда». Вполовину по сторонам она
      // давала около 10%, но грубые силуэты дотягивались до самого источника и гасили лучи.
      let occluder_size = (map_width, map_height);
      let occluders = if self.mode == Mode::NightOld { target(&gl, map_width, map_height) } else { target_as(&gl, map_width, map_height, glow::R8, glow::RED) };
      let lightmap = target(&gl, map_width, map_height);
      Gpu { window, surface, context, gl, programs, sprite_vao, sprite_data, spot_vao, spot_data, beam_vao, beam_data, empty_vao, atlas, land, occluders, occluder_size, lightmap, size }
    };
    self.sim = Some(sim);
    self.gpu = Some(gpu);
  }

  fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
    match event {
      WindowEvent::CloseRequested => event_loop.exit(),
      WindowEvent::RedrawRequested => self.tick(event_loop),
      _ => {}
    }
  }

  fn about_to_wait(&mut self, _: &ActiveEventLoop) {
    if let Some(gpu) = &self.gpu {
      gpu.window.request_redraw();
    }
  }
}

fn main() {
  let mut args = std::env::args().skip(1);
  let units = args.next().and_then(|count| count.parse().ok()).unwrap_or(10_000);
  let mode = match args.next().as_deref() {
    Some("plain") => Mode::Plain,
    Some("day") => Mode::Day,
    Some("night-old") => Mode::NightOld,
    _ => Mode::Night,
  };
  let param = args.next().and_then(|param| param.parse().ok()).unwrap_or(if mode == Mode::NightOld { 40.0 } else { 3.0 });
  let event_loop = EventLoop::new().unwrap();
  let frame = Frame { sprites: Vec::new(), spots: Vec::new(), blooms: Vec::new(), beams: Vec::new() };
  let mut bench = Bench { units, mode, param, gpu: None, sim: None, frame, started: None, last: None, times: Times::default(), done: false };
  event_loop.run_app(&mut bench).unwrap();
}
