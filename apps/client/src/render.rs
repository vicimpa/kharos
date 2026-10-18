//! Рендер кадра (шейдеры света — из `crates/content-bench/src/bin/render.rs`, а те — из `lightingPass.ts`):
//!
//! 1. земля — `terrain.frag` из TS как есть, по окну тайлов вокруг камеры (`map/landWindow.ts`);
//! 2. тени и спрайты по слоям (наземные, их турели, здания, турели зданий, летающие, их турели) — инстансами из
//!    общего атласа, цвет стороны — палитрой, ничьё — серым;
//! 3. осадки по биомам — `weather.frag` из TS как есть: пыль в пустынях, снег на солончаках, дождь в топях;
//! 4. свет, как `lightingPass.ts`: когда темнее полудня — карта силуэтов, карта освещённости (оттенок `lightTint`,
//!    фары, лучи с тенями, огни зданий), умножение на неё; ореолы огней — всегда, днём слабее;
//! 5. слой поверх мира (выделение, частицы) и интерфейс — батчами треугольников.

use crate::gl::{Gl, Target};
use crate::ui::{Batch, FontAtlas, Paint, ATLAS_SIZE};
use glow::HasContext as _;
use kharos_engine::terrain::{Land, CHUNK_SIZE};

/// Текселей на тайл.
pub const TEXELS: f32 = 16.0;
/// Сторон в палитре: своя, чужая, союзная, ничья — по три цвета (тёмный, основной, светлый), как TEAMS в unitArt.ts.
pub const TEAMS: usize = 4;

/// Камера: центр в тайлах и логических пикселей на тайл.
#[derive(Clone, Copy, Debug)]
pub struct View {
  pub x: f32,
  pub y: f32,
  pub zoom: f32,
  /// Экран в логических пикселях и физических пикселей на логический.
  pub screen: [f32; 2],
  pub scale: f32,
}

impl View {
  pub fn to_screen(&self, x: f32, y: f32) -> [f32; 2] {
    [(x - self.x) * self.zoom + self.screen[0] / 2.0, (y - self.y) * self.zoom + self.screen[1] / 2.0]
  }

  pub fn to_world(&self, x: f32, y: f32) -> [f32; 2] {
    [(x - self.screen[0] / 2.0) / self.zoom + self.x, (y - self.screen[1] / 2.0) / self.zoom + self.y]
  }

  /// Видимая часть мира: левый верхний и правый нижний угол в тайлах.
  pub fn bounds(&self, margin: f32) -> [f32; 4] {
    let [left, top] = self.to_world(0.0, 0.0);
    let [right, bottom] = self.to_world(self.screen[0], self.screen[1]);
    [left - margin, top - margin, right + margin, bottom + margin]
  }
}

/// Слоёв спрайтов: на земле, наземные, их турели, здания, турели зданий, летающие, их турели.
pub const LAYERS: usize = 7;
/// Чисел на спрайт: левый верхний угол и размер в тайлах (от камеры), uv кадра, сторона, сдвиг и сила тени, серость,
/// оттенок r, g, b, a с предумноженной альфой — на него умножается картинка (sprites.ts): (1, 1, 1, 1) — как есть.
pub const SPRITE: usize = 16;

/// Чисел на след на земле.
pub const DECAL: usize = 16;

/// Что рисовать в кадре.
#[derive(Default)]
pub struct Frame {
  /// Спрайты по слоям, SPRITE чисел на каждый.
  pub layers: Vec<Vec<f32>>,
  /// Призраки поверх зданий (места под здание, намеченные места) — своим слоем: без теней, лучам не преграда.
  pub ghosts: Vec<f32>,
  /// Следы на земле, DECAL чисел на каждый: отрезок, ширина, кадр атласа (ширина 0 — белый), цвет и
  /// непрозрачность, сколько осталось, плотность, зерно.
  pub decals: Vec<f32>,
  /// Фары: x, y, радиус в текселях, яркость.
  pub spots: Vec<f32>,
  /// Ореолы фар, тот же формат.
  pub blooms: Vec<f32>,
  /// Лучи: x, y, длина, яркость, cos, sin, ближняя полуширина, расширение.
  pub beams: Vec<f32>,
  /// Освещение: 0 — ночь, 1 — полдень (`Weather.light` в TS).
  pub light: f32,
  /// Ветер в тайлах в секунду, путь, пройденный ветром (по модулю WINDOW), и осадки 0..1.
  pub wind: [f32; 2],
  pub drift: [f32; 2],
  pub precipitation: f32,
  /// Палитры сторон: TEAMS × 3 цвета.
  pub palette: Vec<f32>,
  /// Секунды — анимация болот.
  pub time: f32,
  /// Туман войны: левый верхний угол текстуры в тайлах (рамка в тайл за краем карты) и новая картинка, если обзор
  /// поменялся (альфа на тайл, размер). None — тумана нет.
  pub fog: Option<[f32; 2]>,
  pub fog_update: Option<(Vec<u8>, [i32; 2])>,
}

const COMMON: &str = r#"
uniform vec2 uCamera;
uniform float uZoom;
uniform vec2 uScreen;
const float TEXELS = 16.0;
vec4 clip(vec2 tile) {
  vec2 px = (tile - uCamera) * uZoom;
  return vec4(px.x / uScreen.x * 2.0, -px.y / uScreen.y * 2.0, 0.0, 1.0);
}
"#;

// Полноэкранный квадрат для terrain.frag: vUV — 0..1 от левого верхнего угла экрана.
const TERRAIN_VS: &str = r#"
out vec2 vUV;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vUV = corner;
  gl_Position = vec4(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
}
"#;

/// Шейдер земли из TS — тот же файл, без строки версии: её подставляет `Gl::program`.
const TERRAIN_FS: &str = include_str!("../../../packages/client/src/map/terrain.frag");
/// Шейдер осадок из TS, так же.
const WEATHER_FS: &str = include_str!("../../../packages/client/src/weather/weather.frag");

/// Оттенки освещения, как в lightingPass.ts: ночь, сумерки (добавка в середине шкалы) и полдень — белый.
const NIGHT: [f32; 3] = [0.16, 0.2, 0.42];
const DUSK: [f32; 3] = [0.1, 0.0, -0.1];
/// Яркость ореолов огней днём; к ночи растёт до 1. Огни слабее MIN_LEVEL не рисуются.
const DAY_BLOOM: f32 = 0.35;
pub const MIN_LEVEL: f32 = 0.02;

/// Цвет, на который умножается картинка при уровне освещения light (`lightTint`).
fn light_tint(light: f32) -> [f32; 3] {
  let dusk = 1.0 - (light * 2.0 - 1.0).abs();
  std::array::from_fn(|i| (NIGHT[i] + (1.0 - NIGHT[i]) * light + DUSK[i] * dusk).clamp(0.0, 1.0))
}

/// Окно земли вокруг камеры, как `map/landWindow.ts`: текстура WINDOW × WINDOW тайлов, тайл (x, y) — в текселе
/// (x mod WINDOW, y mod WINDOW), чанки дописываются по мере движения камеры.
const WINDOW: i32 = 512;
const WINDOW_CHUNKS: i32 = WINDOW / CHUNK_SIZE;

const SPRITE_VS: &str = r#"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aFrame;
layout(location = 3) in vec4 aMore;
layout(location = 4) in vec4 aTint;
uniform int uMode;
out vec2 vUv;
flat out int vTeam;
flat out float vShadow;
flat out float vGrey;
flat out vec4 vTint;
void main() {
  vec2 shift = uMode == 1 ? vec2(aMore.y) : vec2(0.0);
  vec2 px = (aRect.xy + aCorner * aRect.zw + shift) * uZoom;
  gl_Position = vec4(px.x / uScreen.x * 2.0, -px.y / uScreen.y * 2.0, 0.0, 1.0);
  vUv = mix(aFrame.xy, aFrame.zw, aCorner);
  vTeam = int(aMore.x + 0.5);
  vShadow = aMore.z;
  vGrey = aMore.w;
  vTint = aTint;
}
"#;

// uMode: 0 — спрайт (метка тона в альфе — цвет стороны из палитры, как sprites.ts; умножен на оттенок, альфа
// предумножена), 1 — тень, 2 — силуэт.
const SPRITE_FS: &str = r#"
in vec2 vUv;
flat in int vTeam;
flat in float vShadow;
flat in float vGrey;
flat in vec4 vTint;
uniform sampler2D uAtlas;
uniform vec3 uPalette[12];
uniform int uMode;
out vec4 color;
void main() {
  vec4 texel = texture(uAtlas, vUv);
  if (texel.a < 0.5) discard;
  if (uMode == 1) { color = vec4(0.0, 0.0, 0.0, vShadow); return; }
  if (uMode == 2) { color = vec4(1.0); return; }
  float tone = floor((1.0 - texel.a) * 255.0 + 0.5);
  vec3 rgb = tone >= 1.0 && tone <= 3.0 ? uPalette[vTeam * 3 + int(tone) - 1] : texel.rgb;
  if (vGrey > 0.5) rgb = vec3(dot(rgb, vec3(0.3, 0.59, 0.11)));
  color = vec4(rgb, 1.0) * vTint;
}
"#;

// Следы на земле — decalsPass.ts: отрезок шириной aWidth, всё решается для пикселя мира целиком, по его центру.
const DECAL_VS: &str = r#"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aLine;
layout(location = 2) in float aWidth;
layout(location = 3) in vec4 aFrame;
layout(location = 4) in vec4 aTint;
layout(location = 5) in vec3 aFade;
out vec2 vLocal;
out vec2 vWorld;
out vec4 vFrame;
out vec4 vTint;
out vec3 vFade;
void main() {
  vec2 span = aLine.zw - aLine.xy;
  float size = max(length(span), 1e-4);
  vec2 along = span / size;
  vec2 across = vec2(-along.y, along.x);
  // Четырёхугольник шире на пиксель мира с каждой стороны: пиксель, чей центр внутри, закрашивается целиком.
  float pad = 1.0 / TEXELS;
  vec2 local = vec2(mix(-pad / size, 1.0 + pad / size, aCorner.x), mix(-pad / aWidth, 1.0 + pad / aWidth, aCorner.y));
  vec2 tile = aLine.xy + span * local.x + across * (local.y - 0.5) * aWidth;
  vLocal = local;
  vWorld = tile * TEXELS;
  vFrame = aFrame;
  vTint = aTint;
  vFade = aFade;
  gl_Position = clip(tile);
}
"#;

const DECAL_FS: &str = r#"
in vec2 vLocal;
in vec2 vWorld;
in vec4 vFrame;
in vec4 vTint;
in vec3 vFade;
uniform sampler2D uAtlas;
out vec4 finalColor;

// Случайное число от 0 до 1 для пикселя мира и зерна: у каждого следа пиксели гаснут в свой черёд.
float grain(vec2 cell, float seed) {
  vec3 p = fract(vec3(cell.xyx + seed) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 cell = floor(vWorld);
  mat2 toLocal = mat2(dFdx(vLocal), dFdy(vLocal)) * inverse(mat2(dFdx(vWorld), dFdy(vWorld)));
  vec2 local = vLocal + toLocal * (cell + 0.5 - vWorld);
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) discard;
  vec4 texel = vFrame.z > 0.0 ? texture(uAtlas, vFrame.xy + local * vFrame.zw) : vec4(1.0);
  if (texel.a < 0.5) discard;
  // Дизеринг шумом: доля закрашенных пикселей — плотность, умноженная на то, сколько осталось до исчезновения.
  if (vFade.x * vFade.y <= grain(cell, vFade.z)) discard;
  finalColor = vec4(texel.rgb * vTint.rgb, 1.0) * vTint.a;
}
"#;

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
  vec2 tile = aSpot.xy + (vTexel - vRadius) / TEXELS;
  gl_Position = clip(tile);
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

// Быстрый луч: трапеция по конусу, тень — раз в SPACING текселей пути до источника, с ранним выходом.
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
  float along = mix(-1.0, aBeam.z + 1.0, aCorner.x);
  float width = aCone.z + max(along, 0.0) * aCone.w + 1.0;
  float across = (aCorner.y * 2.0 - 1.0) * width;
  vTexel = aCone.xy * along + vec2(-aCone.y, aCone.x) * across;
  gl_Position = clip(aBeam.xy + vTexel / TEXELS);
}
"#;

const BEAM_FS: &str = r#"
in vec2 vTexel;
flat in vec4 vBeam;
flat in vec4 vCone;
uniform vec3 uColor;
uniform float uStrength;
uniform sampler2D uOccluders;
out vec4 finalColor;
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
const float SPACING = 3.0;
const int MAX_STEPS = 64;
const float SKIP = 1.5;
void main() {
  ivec2 cell = ivec2(floor(vTexel));
  vec2 texel = vec2(cell) + 0.5;
  vec2 direction = vCone.xy;
  float along = dot(texel, direction);
  float across = abs(dot(texel, vec2(-direction.y, direction.x)));
  float side = across / (vCone.z + max(along, 0.0) * vCone.w);
  float value = pow(max(0.0, 1.0 - length(texel) / vBeam.z), 1.5) * max(0.0, 1.0 - side * side);
  if (along <= 0.0 || value <= 0.0) discard;
  vec2 from = vBeam.xy + texel / TEXELS;
  vec2 to = vBeam.xy + direction * SKIP / TEXELS;
  int steps = max(1, int(ceil(max(length(texel) - SKIP, 0.0) / SPACING)));
  bool outside = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= steps) break;
    vec4 at = clip(mix(from, to, float(i + 1) / float(steps)));
    bool solid = textureLod(uOccluders, at.xy * 0.5 + 0.5, 0.0).r > 0.5;
    if (!solid) outside = true;
    else if (outside) discard;
  }
  float dither = (BAYER[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vBeam.w * uStrength;
  finalColor = vec4(uColor * alpha, alpha);
}
"#;

// Туман: тайл — тексель, сглаживание между ними даёт мягкий край обзора; за рамкой — растянутая рамка (CLAMP_TO_EDGE).
const FOG_FS: &str = r#"
in vec2 vUV;
uniform vec2 uCamera;
uniform float uZoom;
uniform vec2 uScreenSize;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform sampler2D uFog;
out vec4 color;
void main() {
  vec2 tile = uCamera + (vUV - 0.5) * uScreenSize / uZoom;
  float alpha = texture(uFog, (tile - uOrigin) / uSize).r;
  color = vec4(0.0, 0.0, 0.0, alpha);
}
"#;

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

// Батч: интерфейс (uWorld = 0, логические пиксели) или слой мира (uWorld = 1, тайлы через камеру). uKind 0 —
// шрифтовой атлас (альфа), 1 — атлас вида с палитрой стороны.
const BATCH_VS: &str = r#"
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
uniform int uWorld;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  vec2 px = uWorld == 1 ? (aPos - uCamera) * uZoom + uScreen / 2.0 : aPos;
  gl_Position = vec4(px.x / uScreen.x * 2.0 - 1.0, 1.0 - px.y / uScreen.y * 2.0, 0.0, 1.0);
}
"#;

const BATCH_FS: &str = r#"
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
uniform int uKind;
uniform int uTeam;
uniform vec3 uPalette[12];
uniform vec2 uInset;
out vec4 color;
void main() {
  if (uKind == 2) {
    color = vec4(0.0, 0.0, 0.0, texture(uAtlas, uInset + vUv * (1.0 - 2.0 * uInset)).r * vColor.a);
    return;
  }
  if (uKind == 0) {
    color = vec4(vColor.rgb, vColor.a * texture(uAtlas, vUv).r);
    return;
  }
  if (uKind == 3) {
    color = texture(uAtlas, vUv) * vColor;
    return;
  }
  vec4 texel = texture(uAtlas, vUv);
  if (texel.a < 0.5) discard;
  float tone = floor((1.0 - texel.a) * 255.0 + 0.5);
  vec3 rgb = tone >= 1.0 && tone <= 3.0 ? uPalette[uTeam * 3 + int(tone) - 1] : texel.rgb;
  color = vec4(rgb, 1.0) * vColor;
}
"#;

struct Programs {
  terrain: glow::Program,
  weather: glow::Program,
  fog: glow::Program,
  sprite: glow::Program,
  spot: glow::Program,
  beam: glow::Program,
  decal: glow::Program,
  blit: glow::Program,
  batch: glow::Program,
}

/// Окно земли: текстура тайлов и какой чанк лежит в каждом слоте.
struct LandWindow {
  land: Land,
  texture: glow::Texture,
  slots: Vec<Option<(i32, i32)>>,
}

pub struct Renderer {
  pub gl: Gl,
  programs: Programs,
  sprite_vao: glow::VertexArray,
  sprite_data: glow::Buffer,
  spot_vao: glow::VertexArray,
  spot_data: glow::Buffer,
  decal_vao: glow::VertexArray,
  decal_data: glow::Buffer,
  beam_vao: glow::VertexArray,
  beam_data: glow::Buffer,
  empty_vao: glow::VertexArray,
  batch_vao: glow::VertexArray,
  batch_vertices: glow::Buffer,
  batch_indices: glow::Buffer,
  font: glow::Texture,
  font_generation: u64,
  /// Общий атлас обликов и скин интерфейса.
  atlas: Option<glow::Texture>,
  skin: Option<glow::Texture>,
  fog: Option<(glow::Texture, [i32; 2])>,
  minimap: Option<glow::Texture>,
  preview: Option<glow::Texture>,
  land: Option<LandWindow>,
  occluders: Option<Target>,
  lightmap: Option<Target>,
  size: [i32; 2],
}

const LIGHT_COLOR: [f32; 3] = [0xa8 as f32 / 255.0, 0xd0 as f32 / 255.0, 1.0];
const BLOOM_COLOR: [f32; 3] = [0x5a as f32 / 255.0, 0xa9 as f32 / 255.0, 1.0];
/// Барханы, как настройки по умолчанию в TS (`settings.ts`): эрг 0,6, красные пустоши и отступ.
const DUNES: [f32; 3] = [0.9 - 0.6 * 0.6, 0.9 - 0.35 * 0.6, 0.15];

/// Сколько раз в секунду шагает анимация болот (`SWAMP_FPS` в terrainPass.ts).
const SWAMP_FPS: f32 = 5.0;

impl Renderer {
  pub fn new(gl: glow::Context) -> Result<Self, String> {
    let gl = Gl::new(gl);
    let with = |source: &str| format!("{COMMON}{source}");
    let terrain = TERRAIN_FS.split_once('\n').map_or(TERRAIN_FS, |(_, rest)| rest);
    let weather = WEATHER_FS.split_once('\n').map_or(WEATHER_FS, |(_, rest)| rest);
    let programs = Programs { terrain: gl.program(TERRAIN_VS, terrain)?, weather: gl.program(TERRAIN_VS, weather)?, fog: gl.program(TERRAIN_VS, FOG_FS)?, sprite: gl.program(&with(SPRITE_VS), &with(SPRITE_FS))?, spot: gl.program(&with(SPOT_VS), &with(SPOT_FS))?, beam: gl.program(&with(BEAM_VS), &with(BEAM_FS))?, decal: gl.program(&with(DECAL_VS), &with(DECAL_FS))?, blit: gl.program(BLIT_VS, BLIT_FS)?, batch: gl.program(&with(BATCH_VS), &with(BATCH_FS))? };
    unsafe {
      let raw = &gl.gl;
      let corners = raw.create_buffer()?;
      raw.bind_buffer(glow::ARRAY_BUFFER, Some(corners));
      let quad: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
      raw.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytemuck::cast_slice(&quad), glow::STATIC_DRAW);
      let (sprite_vao, sprite_data) = gl.instanced(corners, &[4, 4, 4, 4]);
      let (spot_vao, spot_data) = gl.instanced(corners, &[4]);
      let (beam_vao, beam_data) = gl.instanced(corners, &[4, 4]);
      let (decal_vao, decal_data) = gl.instanced(corners, &[4, 1, 4, 4, 3]);
      let empty_vao = raw.create_vertex_array()?;
      let batch_vao = raw.create_vertex_array()?;
      let batch_vertices = raw.create_buffer()?;
      let batch_indices = raw.create_buffer()?;
      raw.bind_vertex_array(Some(batch_vao));
      raw.bind_buffer(glow::ARRAY_BUFFER, Some(batch_vertices));
      raw.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(batch_indices));
      let stride = std::mem::size_of::<crate::ui::Vertex>() as i32;
      raw.enable_vertex_attrib_array(0);
      raw.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, stride, 0);
      raw.enable_vertex_attrib_array(1);
      raw.vertex_attrib_pointer_f32(1, 2, glow::FLOAT, false, stride, 8);
      raw.enable_vertex_attrib_array(2);
      raw.vertex_attrib_pointer_f32(2, 4, glow::UNSIGNED_BYTE, true, stride, 16);
      raw.bind_vertex_array(None);
      let font = gl.texture([ATLAS_SIZE as i32; 2], glow::R8, glow::RED, None);
      raw.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
      raw.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
      Ok(Self { gl, programs, sprite_vao, sprite_data, spot_vao, spot_data, decal_vao, decal_data, beam_vao, beam_data, empty_vao, batch_vao, batch_vertices, batch_indices, font, font_generation: 0, atlas: None, skin: None, fog: None, minimap: None, preview: None, land: None, occluders: None, lightmap: None, size: [0, 0] })
    }
  }

  /// Общий атлас обликов (`atlas::pack`).
  pub fn load_atlas(&mut self, pixels: &[u8], size: [usize; 2]) {
    if let Some(texture) = self.atlas.take() {
      unsafe { self.gl.gl.delete_texture(texture) };
    }
    self.atlas = Some(self.gl.texture([size[0] as i32, size[1] as i32], glow::RGBA8, glow::RGBA, Some(pixels)));
  }

  /// Шрифт новой партии: её атлас букв заливается заново, даже если его номер совпал с прежним.
  pub fn reset_font(&mut self) {
    self.font_generation = u64::MAX;
  }

  /// Партия без земли.
  pub fn clear_land(&mut self) {
    if let Some(window) = self.land.take() {
      unsafe { self.gl.gl.delete_texture(window.texture) };
    }
  }

  /// Земля, по которой рисовать.
  pub fn set_land(&mut self, land: Land) {
    self.clear_land();
    let texture = self.gl.texture([WINDOW, WINDOW], glow::RGBA8, glow::RGBA, None);
    self.land = Some(LandWindow { land, texture, slots: vec![None; (WINDOW_CHUNKS * WINDOW_CHUNKS) as usize] });
  }

  /// Чанки вокруг камеры — в окно, если их там ещё нет.
  fn update_land(&mut self, view: &View) {
    let Some(window) = &mut self.land else { return };
    let margin = 2.0;
    let half = [view.screen[0] / 2.0 / view.zoom + margin, view.screen[1] / 2.0 / view.zoom + margin];
    let chunk = CHUNK_SIZE as f32;
    let (from_x, to_x) = (((view.x - half[0]) / chunk).floor() as i32, ((view.x + half[0]) / chunk).floor() as i32);
    let (from_y, to_y) = (((view.y - half[1]) / chunk).floor() as i32, ((view.y + half[1]) / chunk).floor() as i32);
    let gl = &self.gl.gl;
    for chunk_y in from_y..=to_y {
      for chunk_x in from_x..=to_x {
        let (slot_x, slot_y) = (chunk_x.rem_euclid(WINDOW_CHUNKS), chunk_y.rem_euclid(WINDOW_CHUNKS));
        let slot = (slot_y * WINDOW_CHUNKS + slot_x) as usize;
        if window.slots[slot] == Some((chunk_x, chunk_y)) {
          continue;
        }
        let bytes = window.land.chunk(chunk_x, chunk_y);
        unsafe {
          gl.bind_texture(glow::TEXTURE_2D, Some(window.texture));
          gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
          gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, slot_x * CHUNK_SIZE, slot_y * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(bytes)));
        }
        window.slots[slot] = Some((chunk_x, chunk_y));
      }
    }
  }

  unsafe fn camera(&self, program: glow::Program, view: &View) {
    let gl = &self.gl.gl;
    gl.use_program(Some(program));
    gl.uniform_2_f32(gl.get_uniform_location(program, "uCamera").as_ref(), view.x, view.y);
    gl.uniform_1_f32(gl.get_uniform_location(program, "uZoom").as_ref(), view.zoom);
    gl.uniform_2_f32(gl.get_uniform_location(program, "uScreen").as_ref(), view.screen[0], view.screen[1]);
  }

  /// Спрайты слоёв layers: mode 0 — сами, 1 — тени, 2 — силуэты.
  unsafe fn sprites(&self, view: &View, frame: &Frame, layers: std::ops::Range<usize>, mode: i32) {
    let Some(atlas) = self.atlas else { return };
    let gl = &self.gl.gl;
    let program = self.programs.sprite;
    self.camera(program, view);
    let uniform = |name: &str| gl.get_uniform_location(program, name);
    gl.uniform_1_i32(uniform("uMode").as_ref(), mode);
    gl.uniform_3_f32_slice(uniform("uPalette").as_ref(), &frame.palette);
    gl.bind_texture(glow::TEXTURE_2D, Some(atlas));
    gl.bind_vertex_array(Some(self.sprite_vao));
    for layer in layers {
      let Some(instances) = frame.layers.get(layer).filter(|list| !list.is_empty()) else { continue };
      self.gl.upload(self.sprite_data, instances);
      gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (instances.len() / SPRITE) as i32);
    }
  }

  /// Призраки поверх зданий.
  unsafe fn ghosts(&self, view: &View, frame: &Frame) {
    let Some(atlas) = self.atlas.filter(|_| !frame.ghosts.is_empty()) else { return };
    let gl = &self.gl.gl;
    let program = self.programs.sprite;
    self.camera(program, view);
    gl.uniform_1_i32(gl.get_uniform_location(program, "uMode").as_ref(), 0);
    gl.uniform_3_f32_slice(gl.get_uniform_location(program, "uPalette").as_ref(), &frame.palette);
    gl.bind_texture(glow::TEXTURE_2D, Some(atlas));
    gl.bind_vertex_array(Some(self.sprite_vao));
    self.gl.upload(self.sprite_data, &frame.ghosts);
    gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (frame.ghosts.len() / SPRITE) as i32);
  }

  unsafe fn spots(&self, view: &View, data: &[f32], color: [f32; 3], strength: f32) {
    if data.is_empty() {
      return;
    }
    let gl = &self.gl.gl;
    let program = self.programs.spot;
    self.gl.upload(self.spot_data, data);
    self.camera(program, view);
    gl.uniform_3_f32(gl.get_uniform_location(program, "uColor").as_ref(), color[0], color[1], color[2]);
    gl.uniform_1_f32(gl.get_uniform_location(program, "uStrength").as_ref(), strength);
    gl.bind_vertex_array(Some(self.spot_vao));
    gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (data.len() / 4) as i32);
  }

  /// Цели ночи — в размер экрана в физических пикселях.
  fn targets(&mut self, size: [i32; 2]) {
    if self.lightmap.as_ref().is_some_and(|target| target.size == size) {
      return;
    }
    for target in [self.lightmap.take(), self.occluders.take()].into_iter().flatten() {
      self.gl.drop_target(&target);
    }
    self.lightmap = Some(self.gl.target(size, glow::RGBA8, glow::RGBA));
    self.occluders = Some(self.gl.target(size, glow::R8, glow::RED));
  }

  /// Земля шейдером из TS — прямо в экран: uZoom и uScreenSize в физических пикселях.
  unsafe fn terrain(&self, view: &View, frame: &Frame, size: [i32; 2]) {
    let Some(window) = &self.land else {
      self.gl.gl.clear_color(0.16, 0.13, 0.1, 1.0);
      self.gl.gl.clear(glow::COLOR_BUFFER_BIT);
      return;
    };
    let gl = &self.gl.gl;
    let program = self.programs.terrain;
    gl.use_program(Some(program));
    let uniform = |name: &str| gl.get_uniform_location(program, name);
    let zoom = view.zoom * view.scale;
    gl.uniform_1_i32(uniform("uMap").as_ref(), 0);
    gl.uniform_2_f32(uniform("uScreenSize").as_ref(), size[0] as f32, size[1] as f32);
    gl.uniform_2_f32(uniform("uCamera").as_ref(), view.x.rem_euclid(WINDOW as f32), view.y.rem_euclid(WINDOW as f32));
    gl.uniform_1_f32(uniform("uZoom").as_ref(), zoom);
    gl.uniform_1_f32(uniform("uPixel").as_ref(), 1.0 / zoom);
    gl.uniform_1_f32(uniform("uTime").as_ref(), (frame.time * SWAMP_FPS).floor() / SWAMP_FPS);
    gl.uniform_1_f32(uniform("uSamples").as_ref(), 4.0);
    gl.uniform_3_f32(uniform("uDunes").as_ref(), DUNES[0], DUNES[1], DUNES[2]);
    gl.bind_texture(glow::TEXTURE_2D, Some(window.texture));
    gl.bind_vertex_array(Some(self.empty_vao));
    gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
  }

  /// Осадки: тот же полноэкранный ход, что у земли, и альфа-смешение.
  unsafe fn weather(&self, view: &View, frame: &Frame, size: [i32; 2]) {
    let Some(window) = &self.land else { return };
    if frame.precipitation <= 0.0 {
      return;
    }
    let gl = &self.gl.gl;
    let program = self.programs.weather;
    gl.use_program(Some(program));
    let uniform = |name: &str| gl.get_uniform_location(program, name);
    let zoom = view.zoom * view.scale;
    gl.uniform_1_i32(uniform("uMap").as_ref(), 0);
    gl.uniform_2_f32(uniform("uScreenSize").as_ref(), size[0] as f32, size[1] as f32);
    gl.uniform_2_f32(uniform("uCamera").as_ref(), view.x.rem_euclid(WINDOW as f32), view.y.rem_euclid(WINDOW as f32));
    gl.uniform_1_f32(uniform("uZoom").as_ref(), zoom);
    gl.uniform_1_f32(uniform("uPixel").as_ref(), 1.0 / zoom);
    gl.uniform_1_f32(uniform("uTime").as_ref(), frame.time);
    gl.uniform_2_f32(uniform("uWind").as_ref(), frame.wind[0], frame.wind[1]);
    gl.uniform_2_f32(uniform("uDrift").as_ref(), frame.drift[0], frame.drift[1]);
    gl.uniform_1_f32(uniform("uPrecipitation").as_ref(), frame.precipitation);
    gl.uniform_1_i32(uniform("uDetail").as_ref(), 2);
    gl.bind_texture(glow::TEXTURE_2D, Some(window.texture));
    gl.enable(glow::BLEND);
    gl.blend_func(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA);
    gl.bind_vertex_array(Some(self.empty_vao));
    gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    gl.disable(glow::BLEND);
  }

  /// Туман войны поверх освещённого мира (fogPass.ts).
  unsafe fn fog(&mut self, view: &View, frame: &Frame, size: [i32; 2]) {
    if let Some((pixels, fog_size)) = &frame.fog_update {
      match &self.fog {
        Some((texture, old)) if old == fog_size => {
          self.gl.gl.bind_texture(glow::TEXTURE_2D, Some(*texture));
          self.gl.gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
          self.gl.gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, fog_size[0], fog_size[1], glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(pixels)));
        }
        _ => {
          if let Some((texture, _)) = self.fog.take() {
            self.gl.gl.delete_texture(texture);
          }
          let texture = self.gl.texture(*fog_size, glow::R8, glow::RED, Some(pixels));
          self.gl.gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
          self.gl.gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
          self.fog = Some((texture, *fog_size));
        }
      }
    }
    let (Some(origin), Some((texture, fog_size))) = (frame.fog, &self.fog) else { return };
    let gl = &self.gl.gl;
    let program = self.programs.fog;
    gl.use_program(Some(program));
    let uniform = |name: &str| gl.get_uniform_location(program, name);
    let zoom = view.zoom * view.scale;
    gl.uniform_2_f32(uniform("uCamera").as_ref(), view.x, view.y);
    gl.uniform_1_f32(uniform("uZoom").as_ref(), zoom);
    gl.uniform_2_f32(uniform("uScreenSize").as_ref(), size[0] as f32, size[1] as f32);
    gl.uniform_2_f32(uniform("uOrigin").as_ref(), origin[0], origin[1]);
    gl.uniform_2_f32(uniform("uSize").as_ref(), fog_size[0] as f32, fog_size[1] as f32);
    gl.uniform_1_i32(uniform("uFog").as_ref(), 0);
    gl.active_texture(glow::TEXTURE0);
    gl.bind_texture(glow::TEXTURE_2D, Some(*texture));
    gl.enable(glow::BLEND);
    gl.blend_func(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA);
    gl.bind_vertex_array(Some(self.empty_vao));
    gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    gl.disable(glow::BLEND);
  }

  /// Кадр мира: земля, тени и спрайты по слоям, свет.
  pub fn draw_world(&mut self, view: &View, frame: &Frame, size: [i32; 2]) {
    self.size = size;
    let night = frame.light < 1.0;
    if night {
      self.targets(size);
    }
    self.update_land(view);
    let gl = &self.gl.gl;
    unsafe {
      gl.bind_framebuffer(glow::FRAMEBUFFER, None);
      gl.viewport(0, 0, size[0], size[1]);
      gl.active_texture(glow::TEXTURE0);
      gl.disable(glow::BLEND);
      self.terrain(view, frame, size);
      // Следы — над землёй и под юнитами, до освещения: ночью темнеют вместе с землёй.
      if !frame.decals.is_empty() {
        gl.enable(glow::BLEND);
        gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
        let program = self.programs.decal;
        self.camera(program, view);
        if let Some(atlas) = self.atlas {
          gl.bind_texture(glow::TEXTURE_2D, Some(atlas));
        }
        self.gl.upload(self.decal_data, &frame.decals);
        gl.bind_vertex_array(Some(self.decal_vao));
        gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (frame.decals.len() / DECAL) as i32);
      }

      // По слою: сначала тени слоя, потом он сам — тень соседа не ляжет на кабину. Альфа предумножена (setBlend
      // 'alpha' в TS): так чертёж и призраки просвечивают, как в buildingsPass.ts.
      gl.enable(glow::BLEND);
      gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
      for layer in 0..LAYERS {
        if layer > 0 {
          self.sprites(view, frame, layer..layer + 1, 1);
        }
        self.sprites(view, frame, layer..layer + 1, 0);
        if layer == crate::atlas::Layer::Building as usize {
          self.ghosts(view, frame);
        }
      }
      gl.disable(glow::BLEND);
      self.weather(view, frame, size);
      let bloom = DAY_BLOOM + (1.0 - DAY_BLOOM) * (1.0 - frame.light);
      if !night {
        gl.enable(glow::BLEND);
        gl.blend_func(glow::ONE, glow::ONE);
        self.spots(view, &frame.blooms, BLOOM_COLOR, bloom);
        gl.disable(glow::BLEND);
        self.fog(view, frame, size);
        return;
      }
      let (occluders, lightmap) = (self.occluders.as_ref().expect("силуэты"), self.lightmap.as_ref().expect("свет"));
      gl.bind_framebuffer(glow::FRAMEBUFFER, Some(occluders.framebuffer));
      gl.clear_color(0.0, 0.0, 0.0, 0.0);
      gl.clear(glow::COLOR_BUFFER_BIT);
      // Лучам фар мешают наземные и здания; лежащее на земле и летающие — нет.
      self.sprites(view, frame, 1..5, 2);

      gl.enable(glow::BLEND);
      gl.blend_func(glow::ONE, glow::ONE);
      gl.bind_framebuffer(glow::FRAMEBUFFER, Some(lightmap.framebuffer));
      let tint = light_tint(frame.light);
      gl.clear_color(tint[0], tint[1], tint[2], 1.0);
      gl.clear(glow::COLOR_BUFFER_BIT);
      {
        self.spots(view, &frame.spots, LIGHT_COLOR, 1.0);
        if !frame.beams.is_empty() {
          self.gl.upload(self.beam_data, &frame.beams);
          let beam = self.programs.beam;
          self.camera(beam, view);
          gl.uniform_3_f32(gl.get_uniform_location(beam, "uColor").as_ref(), LIGHT_COLOR[0], LIGHT_COLOR[1], LIGHT_COLOR[2]);
          gl.uniform_1_f32(gl.get_uniform_location(beam, "uStrength").as_ref(), 1.0);
          gl.bind_texture(glow::TEXTURE_2D, Some(occluders.texture));
          gl.bind_vertex_array(Some(self.beam_vao));
          gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, (frame.beams.len() / 8) as i32);
        }
      }
      gl.bind_framebuffer(glow::FRAMEBUFFER, None);
      gl.blend_func(glow::DST_COLOR, glow::ZERO);
      gl.use_program(Some(self.programs.blit));
      gl.bind_texture(glow::TEXTURE_2D, Some(lightmap.texture));
      gl.bind_vertex_array(Some(self.empty_vao));
      gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
      gl.blend_func(glow::ONE, glow::ONE);
      self.spots(view, &frame.blooms, BLOOM_COLOR, bloom);
      gl.disable(glow::BLEND);
      self.fog(view, frame, size);
    }
  }

  /// Батч поверх: world — в тайлах через камеру, иначе — в логических пикселях экрана.
  pub fn draw_batch(&mut self, batch: &Batch, font: &FontAtlas, view: &View, world: bool, palette: &[f32]) {
    self.paint_batch(batch, font, view, world, palette, false);
  }

  /// Светящийся слой поверх мира: цвета складываются с картинкой (setBlend 'add').
  pub fn draw_glow(&mut self, batch: &Batch, font: &FontAtlas, view: &View, palette: &[f32]) {
    self.paint_batch(batch, font, view, true, palette, true);
  }

  fn paint_batch(&mut self, batch: &Batch, font: &FontAtlas, view: &View, world: bool, palette: &[f32], add: bool) {
    if batch.indices.is_empty() {
      return;
    }
    let gl = &self.gl.gl;
    unsafe {
      gl.bind_framebuffer(glow::FRAMEBUFFER, None);
      gl.viewport(0, 0, self.size[0], self.size[1]);
      gl.enable(glow::BLEND);
      if add {
        gl.blend_func_separate(glow::SRC_ALPHA, glow::ONE, glow::ZERO, glow::ONE);
      } else {
        gl.blend_func_separate(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA, glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
      }
      gl.active_texture(glow::TEXTURE0);
      gl.bind_texture(glow::TEXTURE_2D, Some(self.font));
      if self.font_generation != font.generation {
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, ATLAS_SIZE as i32, ATLAS_SIZE as i32, 0, glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&font.pixels)));
        self.font_generation = font.generation;
      }
      let program = self.programs.batch;
      self.camera(program, view);
      let uniform = |name: &str| gl.get_uniform_location(program, name);
      gl.uniform_1_i32(uniform("uWorld").as_ref(), world as i32);
      gl.uniform_3_f32_slice(uniform("uPalette").as_ref(), palette);
      gl.bind_vertex_array(Some(self.batch_vao));
      gl.bind_buffer(glow::ARRAY_BUFFER, Some(self.batch_vertices));
      gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytemuck::cast_slice(&batch.vertices), glow::STREAM_DRAW);
      gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(self.batch_indices));
      gl.buffer_data_u8_slice(glow::ELEMENT_ARRAY_BUFFER, bytemuck::cast_slice(&batch.indices), glow::STREAM_DRAW);
      for (index, &(start, paint, clip)) in batch.segments.iter().enumerate() {
        let end = batch.segments.get(index + 1).map_or(batch.indices.len(), |next| next.0);
        // Обрезка — ножницами в физических пикселях, снизу вверх.
        match clip {
          Some([x, y, w, h]) => {
            let scale = view.scale;
            gl.enable(glow::SCISSOR_TEST);
            gl.scissor((x * scale).round() as i32, (self.size[1] as f32 - ((y + h) * scale).round()) as i32, (w * scale).round().max(0.0) as i32, (h * scale).round().max(0.0) as i32);
          }
          None => gl.disable(glow::SCISSOR_TEST),
        }
        match paint {
          Paint::Fog => {
            let Some((fog, size)) = &self.fog else { continue };
            // uKind 2 — чёрный с альфой из красного канала; рамка картинки срезана uv-сдвигом в шейдере.
            gl.uniform_1_i32(uniform("uKind").as_ref(), 2);
            gl.uniform_2_f32(uniform("uInset").as_ref(), 1.0 / size[0] as f32, 1.0 / size[1] as f32);
            gl.bind_texture(glow::TEXTURE_2D, Some(*fog));
          }
          Paint::Picture => {
            let Some(atlas) = self.atlas else { continue };
            gl.uniform_1_i32(uniform("uKind").as_ref(), 3);
            gl.bind_texture(glow::TEXTURE_2D, Some(atlas));
          }
          Paint::Preview => {
            let Some(preview) = self.preview else { continue };
            gl.uniform_1_i32(uniform("uKind").as_ref(), 1);
            gl.uniform_1_i32(uniform("uTeam").as_ref(), 0);
            gl.bind_texture(glow::TEXTURE_2D, Some(preview));
          }
          Paint::Minimap => {
            let Some(minimap) = self.minimap else { continue };
            gl.uniform_1_i32(uniform("uKind").as_ref(), 1);
            gl.uniform_1_i32(uniform("uTeam").as_ref(), 0);
            gl.bind_texture(glow::TEXTURE_2D, Some(minimap));
          }
          Paint::Skin => {
            let Some(skin) = self.skin else { continue };
            gl.uniform_1_i32(uniform("uKind").as_ref(), 1);
            gl.uniform_1_i32(uniform("uTeam").as_ref(), 0);
            gl.bind_texture(glow::TEXTURE_2D, Some(skin));
          }
          Paint::Font => {
            gl.uniform_1_i32(uniform("uKind").as_ref(), 0);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.font));
          }
          Paint::Sprite { team } => {
            let Some(atlas) = self.atlas else { continue };
            gl.uniform_1_i32(uniform("uKind").as_ref(), 1);
            gl.uniform_1_i32(uniform("uTeam").as_ref(), team as i32);
            gl.bind_texture(glow::TEXTURE_2D, Some(atlas));
          }
        }
        gl.draw_elements(glow::TRIANGLES, (end - start) as i32, glow::UNSIGNED_INT, (start * 4) as i32);
      }
      gl.disable(glow::SCISSOR_TEST);
      gl.bind_vertex_array(None);
      gl.disable(glow::BLEND);
    }
  }

  /// Картинка мини-карты: уменьшается сглаженно, как картинка на холсте у TS.
  pub fn load_minimap(&mut self, pixels: &[u8], size: [usize; 2]) {
    let texture = self.gl.texture([size[0] as i32, size[1] as i32], glow::RGBA8, glow::RGBA, Some(pixels));
    unsafe {
      self.gl.gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
    }
    self.minimap = Some(texture);
  }

  /// Схема карты новой игры: та же текстура, перезаливается по мере счёта.
  pub fn load_preview(&mut self, pixels: &[u8], side: usize) {
    let gl = &self.gl.gl;
    match self.preview {
      Some(texture) => unsafe {
        gl.bind_texture(glow::TEXTURE_2D, Some(texture));
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
        gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, side as i32, side as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(pixels)));
      },
      None => {
        let texture = self.gl.texture([side as i32, side as i32], glow::RGBA8, glow::RGBA, Some(pixels));
        unsafe { gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32) };
        self.preview = Some(texture);
      }
    }
  }

  /// Скин интерфейса (`gui::skin_pixels`).
  pub fn load_skin(&mut self, pixels: &[u8], size: [usize; 2]) {
    self.skin = Some(self.gl.texture([size[0] as i32, size[1] as i32], glow::RGBA8, glow::RGBA, Some(pixels)));
  }

  /// Кадр в PNG.
  pub fn shot(&self, path: &str, size: [u32; 2]) {
    let [width, height] = size;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    unsafe {
      self.gl.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
      self.gl.gl.read_pixels(0, 0, width as i32, height as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut pixels)));
    }
    let rows: Vec<u8> = pixels.chunks_exact((width * 4) as usize).rev().flatten().copied().collect();
    let file = match std::fs::File::create(path) {
      Ok(file) => file,
      Err(error) => return eprintln!("{path}: {error}"),
    };
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    if let Err(error) = encoder.write_header().and_then(|mut writer| writer.write_image_data(&rows)) {
      eprintln!("{path}: {error}");
    }
  }
}
