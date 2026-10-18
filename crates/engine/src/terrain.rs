//! Земля: генератор местности и карта мира — перенос `packages/shared/src/terrain.ts` до байта (docs/engine.md, §5).
//! Чанк — 32×32 тайла по 4 байта, в той же раскладке, что в TS и в шейдере: тип, биом, глубина в песках (у гор —
//! радиус вершины), рельеф (у гор — смещение до вершины).
//!
//! Арифметика — по правилам JS: `Math.imul`, `>>>`, `Math.round`, `Float32Array` для расстояний. Синус, косинус и
//! гипотенуза — из `libm`: так натив и wasm считают одинаково на любой платформе.

use crate::math::js_round;
use serde::Deserialize;
use std::collections::HashMap;

pub const CHUNK_SIZE: i32 = 32;
pub const TILE_BYTES: usize = 4;
pub const CHUNK_BYTES: usize = (CHUNK_SIZE * CHUNK_SIZE) as usize * TILE_BYTES;

pub const SWAMP: u8 = 0;
pub const SAND: u8 = 1;
pub const ROCK: u8 = 2;
pub const MOUNTAIN: u8 = 3;

const MAX_TIER: i32 = 3;
pub const CLIFF_BIT: u8 = 4;
pub const STEP_BIT: u8 = 8;
pub const FOOT_BIT: u8 = 16;
const DERIVED_BITS: u8 = STEP_BIT | FOOT_BIT;
const STEP_UP: i32 = 2;
const STEP_DOWN: i32 = 1;
const STEP_SIDE: i32 = 1;
const PEAK_RADIUS_LIMIT: f64 = 2.0;
const PEAK_CELL: i32 = 16;
const SATELLITE_MIN_RADIUS: f64 = 0.7;
const SATELLITE_MAX_RADIUS: f64 = 1.4;
const PEAK_MIN_SPACING: f64 = 1.5;
pub const PEAK_RADIUS_SCALE: f64 = 4.0;
const TILE_REACH: f64 = std::f64::consts::FRAC_1_SQRT_2;
const SAND_REACH: f64 = 8.0;
const DERIVE_MARGIN: i32 = 8;

/// Параметры генератора — `GeneratorConfig` из TS, те же имена полей.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorConfig {
  pub seed: f64,
  pub zone_scale: f64,
  pub zone_warp: f64,
  pub swamp_level: f64,
  pub rock_level: f64,
  pub biome_scale: f64,
  pub peak_chance: f64,
  pub peak_min_radius: f64,
  pub peak_max_radius: f64,
  pub double_chance: f64,
  pub triple_chance: f64,
  pub salt_swamp_shift: f64,
  pub salt_rock_shift: f64,
  pub salt_peak_factor: f64,
  pub red_swamp_shift: f64,
  pub red_rock_shift: f64,
  pub red_peak_factor: f64,
  pub marsh_swamp_shift: f64,
  pub marsh_rock_shift: f64,
  pub marsh_peak_factor: f64,
  pub tier_step: f64,
  pub cliff_scale: f64,
  pub cliff_share: f64,
  #[serde(default)]
  pub deposit_chance: Option<f64>,
  #[serde(default)]
  pub deposit_richness: Option<f64>,
  #[serde(default)]
  pub blank: bool,
}

/// `ToInt32` из JS для целых чисел, как их видит `Math.imul` и побитовые операции.
fn int32(value: f64) -> i32 {
  value as i64 as i32
}

/// Случайное число от 0 до 1 для координат и сида (`hash` в terrain.ts).
pub fn hash(x: f64, y: f64, seed: f64) -> f64 {
  let mut h = int32(x).wrapping_mul(0x27d4eb2d) ^ int32(y).wrapping_mul(0x165667b1) ^ int32(seed);
  h = (h ^ ((h as u32) >> 15) as i32).wrapping_mul(0x85ebca6bu32 as i32);
  h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(0xc2b2ae35u32 as i32);
  ((h ^ ((h as u32) >> 16) as i32) as u32) as f64 / 4294967296.0
}

fn noise(x: f64, y: f64, seed: f64) -> f64 {
  let ix = x.floor();
  let iy = y.floor();
  let mut fx = x - ix;
  let mut fy = y - iy;
  fx = fx * fx * (3.0 - 2.0 * fx);
  fy = fy * fy * (3.0 - 2.0 * fy);
  let a = hash(ix, iy, seed);
  let b = hash(ix + 1.0, iy, seed);
  let c = hash(ix, iy + 1.0, seed);
  let d = hash(ix + 1.0, iy + 1.0, seed);
  let top = a + (b - a) * fx;
  top + (c + (d - c) * fx - top) * fy
}

fn fbm(mut x: f64, mut y: f64, seed: f64, octaves: i32) -> f64 {
  let mut sum = 0.0;
  let mut amplitude = 0.5;
  let mut total = 0.0;
  for octave in 0..octaves {
    sum += amplitude * noise(x, y, seed + octave as f64 * 1013.0);
    total += amplitude;
    amplitude *= 0.5;
    x *= 2.0;
    y *= 2.0;
  }
  sum / total
}

fn elevation_at(x: f64, y: f64, config: &GeneratorConfig) -> f64 {
  let scale = config.zone_scale;
  let warp_x = (fbm(x / scale, y / scale, config.seed + 7001.0, 2) - 0.5) * config.zone_warp;
  let warp_y = (fbm(x / scale, y / scale, config.seed + 9001.0, 2) - 0.5) * config.zone_warp;
  fbm((x + warp_x) / scale, (y + warp_y) / scale, config.seed, 4)
}

fn smoothstep(from: f64, to: f64, value: f64) -> f64 {
  let t = 0f64.max(1f64.min((value - from) / (to - from)));
  t * t * (3.0 - 2.0 * t)
}

/// Доли биомов: эрг, солончаки, красные пустоши, топи.
fn biome_weights(x: f64, y: f64, config: &GeneratorConfig) -> [f64; 4] {
  let scale = config.biome_scale;
  let heat = fbm(x / scale, y / scale, config.seed + 11003.0, 2);
  let wetness = fbm(x / scale, y / scale, config.seed + 13007.0, 2);
  let marsh = smoothstep(0.56, 0.64, wetness);
  let red = (1.0 - marsh) * smoothstep(0.56, 0.64, heat);
  let salt = (1.0 - marsh) * smoothstep(0.44, 0.36, heat);
  [1.0 - marsh - red - salt, salt, red, marsh]
}

/// Уровни болот и скал с поправкой на биом.
fn zone_levels(weights: &[f64; 4], config: &GeneratorConfig) -> (f64, f64) {
  let [_, salt, red, marsh] = *weights;
  (config.swamp_level + salt * config.salt_swamp_shift + red * config.red_swamp_shift + marsh * config.marsh_swamp_shift, config.rock_level + salt * config.salt_rock_shift + red * config.red_rock_shift + marsh * config.marsh_rock_shift)
}

fn peak_chance(weights: &[f64; 4], config: &GeneratorConfig) -> f64 {
  let factor = weights[0] + weights[1] * config.salt_peak_factor + weights[2] * config.red_peak_factor + weights[3] * config.marsh_peak_factor;
  config.peak_chance * factor
}

fn pack_biome(weights: &[f64; 4]) -> u8 {
  let mut primary = 0;
  for i in 1..4 {
    if weights[i] > weights[primary] {
      primary = i;
    }
  }
  let mut secondary = if primary == 0 { 1 } else { 0 };
  for i in 0..4 {
    if i != primary && weights[i] > weights[secondary] {
      secondary = i;
    }
  }
  let share = weights[secondary] / (weights[primary] + weights[secondary]);
  ((primary << 6) | (secondary << 4)) as u8 | 15f64.min(js_round(share * 30.0)) as u8
}

fn classify(elevation: f64, (swamp, rock): (f64, f64)) -> u8 {
  if elevation < swamp {
    SWAMP
  } else if elevation > rock {
    ROCK
  } else {
    SAND
  }
}

/// Вид местности и биом точки по генератору, без гор (`sampleTerrain` в TS): для схемы карты, где горы мельче пикселя.
pub fn sample_terrain(config: &GeneratorConfig, x: f64, y: f64) -> (u8, u8) {
  if config.blank {
    return (1, 0);
  }
  let weights = biome_weights(x, y, config);
  (classify(elevation_at(x, y, config), zone_levels(&weights, config)), pack_biome(&weights) >> 6)
}

fn tier_of(elevation: f64, rock: f64, config: &GeneratorConfig) -> i32 {
  if elevation <= rock {
    return 0;
  }
  MAX_TIER.min(1 + ((elevation - rock) / config.tier_step).floor() as i32)
}

fn is_cliff(x: f64, y: f64, config: &GeneratorConfig) -> bool {
  fbm(x / config.cliff_scale, y / config.cliff_scale, config.seed + 17011.0, 2) < config.cliff_share * 0.5 + 0.25
}

#[derive(Clone, Copy, Debug)]
struct Peak {
  x: f64,
  y: f64,
  radius: f64,
}

fn fits_on_rock(peak: &Peak, config: &GeneratorConfig) -> bool {
  let reach = peak.radius + 1.5;
  for (dx, dy) in [(0.0, 0.0), (reach, 0.0), (-reach, 0.0), (0.0, reach), (0.0, -reach)] {
    let x = peak.x + dx;
    let y = peak.y + dy;
    if elevation_at(x, y, config) <= zone_levels(&biome_weights(x, y, config), config).1 {
      return false;
    }
  }
  true
}

fn peaks_in_cell(cell_x: i32, cell_y: i32, config: &GeneratorConfig) -> Vec<Peak> {
  let random = |salt: f64| hash(cell_x as f64, cell_y as f64, config.seed + 5003.0 + salt * 131.0);
  let center_x = (cell_x as f64 + 0.5) * PEAK_CELL as f64;
  let center_y = (cell_y as f64 + 0.5) * PEAK_CELL as f64;
  if random(0.0) >= peak_chance(&biome_weights(center_x, center_y, config), config) {
    return Vec::new();
  }
  let max_radius = config.peak_max_radius.min(PEAK_RADIUS_LIMIT);
  let min_radius = config.peak_min_radius.min(max_radius);
  let main = Peak { x: (cell_x * PEAK_CELL) as f64 + 5.0 + js_round(random(1.0) * 12.0) / 2.0, y: (cell_y * PEAK_CELL) as f64 + 5.0 + js_round(random(2.0) * 12.0) / 2.0, radius: min_radius + random(3.0) * (max_radius - min_radius) };
  if !fits_on_rock(&main, config) {
    return Vec::new();
  }
  let mut peaks = vec![main];
  let size_roll = random(4.0);
  let count = if size_roll < config.triple_chance {
    3
  } else if size_roll < config.triple_chance + config.double_chance {
    2
  } else {
    1
  };
  for i in 1..count {
    let i = i as f64;
    let radius = SATELLITE_MIN_RADIUS + random(i * 10.0 + 5.0) * (SATELLITE_MAX_RADIUS - SATELLITE_MIN_RADIUS);
    let angle = random(i * 10.0 + 6.0) * std::f64::consts::PI * 2.0;
    let distance = (main.radius + radius) * 0.6;
    let satellite = Peak { x: js_round((main.x + libm::cos(angle) * distance) * 2.0) / 2.0, y: js_round((main.y + libm::sin(angle) * distance) * 2.0) / 2.0, radius };
    let crowded = peaks.iter().any(|other| libm::hypot(other.x - satellite.x, other.y - satellite.y) < PEAK_MIN_SPACING);
    if !crowded && fits_on_rock(&satellite, config) {
      peaks.push(satellite);
    }
  }
  peaks
}

/// Тип и ярус тайла по генератору, без гор.
fn base_tile(config: &GeneratorConfig, x: f64, y: f64) -> (u8, i32) {
  if config.blank {
    return (SAND, 0);
  }
  let elevation = elevation_at(x, y, config);
  let levels = zone_levels(&biome_weights(x, y, config), config);
  (classify(elevation, levels), tier_of(elevation, levels.1, config))
}

/// Тайл ровно таким, каким его соберёт generate_chunk, вместе с горами (`generatedTile`).
fn generated_tile(config: &GeneratorConfig, x: i32, y: i32, peaks: &mut HashMap<(i32, i32), Vec<Peak>>) -> (u8, i32, bool) {
  let (terrain, tier) = base_tile(config, x as f64, y as f64);
  if !config.blank {
    let cell = (x.div_euclid(PEAK_CELL), y.div_euclid(PEAK_CELL));
    let list = peaks.entry(cell).or_insert_with(|| peaks_in_cell(cell.0, cell.1, config));
    if list.iter().any(|peak| libm::hypot(peak.x - (x as f64 + 0.5), peak.y - (y as f64 + 0.5)) < peak.radius + TILE_REACH) {
      return (MOUNTAIN, -1, false);
    }
  }
  (terrain, tier, tier > 0 && is_cliff(x as f64, y as f64, config))
}

/// Чанк по генератору без выводимого (`generateChunk`).
fn generate_chunk(config: &GeneratorConfig, chunk_x: i32, chunk_y: i32) -> Vec<u8> {
  let mut tiles = vec![0u8; CHUNK_BYTES];
  if config.blank {
    for tile in tiles.chunks_exact_mut(TILE_BYTES) {
      tile[0] = SAND;
    }
    return tiles;
  }
  let per_chunk = CHUNK_SIZE / PEAK_CELL;
  let mut cells = Vec::new();
  for cell_y in 0..per_chunk {
    for cell_x in 0..per_chunk {
      cells.push(peaks_in_cell(chunk_x * per_chunk + cell_x, chunk_y * per_chunk + cell_y, config));
    }
  }
  for y in 0..CHUNK_SIZE {
    for x in 0..CHUNK_SIZE {
      let world_x = (chunk_x * CHUNK_SIZE + x) as f64;
      let world_y = (chunk_y * CHUNK_SIZE + y) as f64;
      let elevation = elevation_at(world_x, world_y, config);
      let index = (y * CHUNK_SIZE + x) as usize * TILE_BYTES;
      let weights = biome_weights(world_x, world_y, config);
      let levels = zone_levels(&weights, config);
      tiles[index] = classify(elevation, levels);
      tiles[index + 1] = pack_biome(&weights);
      let tier = tier_of(elevation, levels.1, config);
      tiles[index + 3] = tier as u8 | if tier != 0 && is_cliff(world_x, world_y, config) { CLIFF_BIT } else { 0 };
      let mut nearest: Option<Peak> = None;
      let mut nearest_distance = f64::INFINITY;
      for peak in &cells[((y / PEAK_CELL) * per_chunk + x / PEAK_CELL) as usize] {
        let distance = libm::hypot(peak.x - (world_x + 0.5), peak.y - (world_y + 0.5));
        if distance < peak.radius + TILE_REACH && distance < nearest_distance {
          nearest = Some(*peak);
          nearest_distance = distance;
        }
      }
      if let Some(peak) = nearest {
        tiles[index] = MOUNTAIN;
        tiles[index + 2] = js_round((peak.radius / PEAK_RADIUS_SCALE) * 255.0) as u8;
        let dx = ((peak.x - (world_x + 0.5)) * 2.0 + 8.0) as i32;
        let dy = ((peak.y - (world_y + 0.5)) * 2.0 + 8.0) as i32;
        tiles[index + 3] = ((dx << 4) | dy) as u8;
      }
    }
  }
  tiles
}

/// Прямоугольник чанков карты мира: левый верхний чанк и размер (`LandArea`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LandArea {
  pub left: i32,
  pub top: i32,
  pub width: i32,
  pub height: i32,
}

impl LandArea {
  /// Чанки, покрывающие прямоугольник тайлов [left, right) × [top, bottom) (`areaOf`).
  pub fn of(left: i32, top: i32, right: i32, bottom: i32) -> Self {
    let from_x = left.div_euclid(CHUNK_SIZE);
    let from_y = top.div_euclid(CHUNK_SIZE);
    let to_x = (right as f64 / CHUNK_SIZE as f64).ceil() as i32;
    let to_y = (bottom as f64 / CHUNK_SIZE as f64).ceil() as i32;
    Self { left: from_x, top: from_y, width: to_x - from_x, height: to_y - from_y }
  }

  fn index(&self, chunk_x: i32, chunk_y: i32) -> Option<usize> {
    let (x, y) = (chunk_x - self.left, chunk_y - self.top);
    (x >= 0 && y >= 0 && x < self.width && y < self.height).then(|| (y * self.width + x) as usize)
  }
}

/// Сколько чанков края мира держит кэш (`MAX_CACHED_CHUNKS`): край детерминирован, выброшенный соберётся заново.
const MAX_CACHED_CHUNKS: usize = 4096;

/// Местность: карта мира (чанки собираются лениво — выводимое от порядка сборки не зависит) и край из генератора.
pub struct Land {
  pub config: GeneratorConfig,
  pub area: LandArea,
  owned: Vec<Option<Vec<u8>>>,
  /// Кэш чанков края мира, вне карты.
  outside: HashMap<(i32, i32), Vec<u8>>,
  /// Растёт с каждой правкой тайла.
  pub revision: u64,
  /// Номер правки, с которой чанк пересчитан (`chunkRevision`): окно на видеокарте сравнивает его с загруженным.
  revisions: HashMap<(i32, i32), u64>,
  /// Чанки, чьё выводимое пересчитать в конце пакета правок (`batchLand`); None — пакета нет.
  pending: Option<std::collections::BTreeSet<(i32, i32)>>,
}

impl Land {
  pub fn new(config: GeneratorConfig, area: LandArea) -> Self {
    Self { owned: vec![None; (area.width * area.height) as usize], config, area, outside: HashMap::new(), revision: 0, revisions: HashMap::new(), pending: None }
  }

  /// Чанк по координатам, собранный при первом обращении (`getChunk`). Вне карты — из генератора, без кэша.
  pub fn chunk(&mut self, chunk_x: i32, chunk_y: i32) -> &[u8] {
    match self.area.index(chunk_x, chunk_y) {
      Some(at) => {
        if self.owned[at].is_none() {
          let mut chunk = generate_chunk(&self.config, chunk_x, chunk_y);
          self.derive(&mut chunk, chunk_x, chunk_y);
          self.owned[at] = Some(chunk);
        }
        self.owned[at].as_deref().unwrap()
      }
      None => {
        if !self.outside.contains_key(&(chunk_x, chunk_y)) {
          if self.outside.len() >= MAX_CACHED_CHUNKS {
            self.outside.clear();
          }
          let mut chunk = generate_chunk(&self.config, chunk_x, chunk_y);
          self.derive(&mut chunk, chunk_x, chunk_y);
          self.outside.insert((chunk_x, chunk_y), chunk);
        }
        &self.outside[&(chunk_x, chunk_y)]
      }
    }
  }

  /// Кладёт чанк карты целиком — байты вместе с выводимым, как их отдаёт `getChunk`: так зеркало TS досылает правки
  /// карты и загруженный мир. Выводимое соседей не пересчитывает: изменившихся соседей шлют тоже.
  pub fn set_chunk(&mut self, chunk_x: i32, chunk_y: i32, bytes: &[u8]) -> Result<(), String> {
    let at = self.area.index(chunk_x, chunk_y).ok_or_else(|| format!("чанк ({chunk_x}, {chunk_y}) вне карты"))?;
    if bytes.len() != CHUNK_BYTES {
      return Err(format!("чанк ({chunk_x}, {chunk_y}): {} байт", bytes.len()));
    }
    self.owned[at] = Some(bytes.to_vec());
    Ok(())
  }

  /// Байты тайла (x, y).
  pub fn tile(&mut self, x: i32, y: i32) -> [u8; 4] {
    let chunk = self.chunk(x.div_euclid(CHUNK_SIZE), y.div_euclid(CHUNK_SIZE));
    let index = (y.rem_euclid(CHUNK_SIZE) * CHUNK_SIZE + x.rem_euclid(CHUNK_SIZE)) as usize * TILE_BYTES;
    chunk[index..index + 4].try_into().unwrap()
  }

  /// Хранимые байты тайла — без выводимого (`tileBytes`): у не-гор третий байт и биты STEP_BIT, FOOT_BIT — нули. Так
  /// тайл лежит в сохранении и ходит в правках.
  pub fn stored(&mut self, x: i32, y: i32) -> [u8; 4] {
    let [terrain, biome, peak, relief] = self.tile(x, y);
    if terrain == MOUNTAIN {
      [terrain, biome, peak, relief]
    } else {
      [terrain, biome, 0, relief & !DERIVED_BITS]
    }
  }

  /// Номер правки чанка (`chunkRevision`): 0 — чанк не правили.
  pub fn chunk_revision(&self, chunk_x: i32, chunk_y: i32) -> u64 {
    self.revisions.get(&(chunk_x, chunk_y)).copied().unwrap_or(0)
  }

  /// Вершина горы, частью которой стоит тайл (`peakOf`): центр и радиус в тайлах; None — тайл не гора.
  pub fn peak_of(&mut self, x: i32, y: i32) -> Option<(f64, f64, f64)> {
    let [terrain, _, radius, offset] = self.tile(x, y);
    if terrain != MOUNTAIN {
      return None;
    }
    Some((x as f64 + 0.5 + ((offset >> 4) as f64 - 8.0) / 2.0, y as f64 + 0.5 + ((offset & 15) as f64 - 8.0) / 2.0, radius as f64 / 255.0 * PEAK_RADIUS_SCALE))
  }

  /// Записывает хранимые байты тайла (`writeTile`, см. `stored`). Вне карты ничего не делает: край мира — из генератора.
  /// Пересчитывает выводимое соседних чанков — сразу или в конце пакета (`begin_batch`).
  pub fn write_tile(&mut self, x: i32, y: i32, bytes: [u8; 4]) {
    let (chunk_x, chunk_y) = (x.div_euclid(CHUNK_SIZE), y.div_euclid(CHUNK_SIZE));
    let Some(at) = self.area.index(chunk_x, chunk_y) else { return };
    // Соседи, которые выводят что-то из этого тайла, собираются до правки: несобранный посчитал бы его по генератору.
    let reach = (DERIVE_MARGIN + CHUNK_SIZE - 1) / CHUNK_SIZE;
    let mut touched = Vec::new();
    for cy in (y - DERIVE_MARGIN).div_euclid(CHUNK_SIZE)..=(y + DERIVE_MARGIN).div_euclid(CHUNK_SIZE) {
      for cx in (x - DERIVE_MARGIN).div_euclid(CHUNK_SIZE)..=(x + DERIVE_MARGIN).div_euclid(CHUNK_SIZE) {
        if (cx - chunk_x).abs() > reach || (cy - chunk_y).abs() > reach || self.area.index(cx, cy).is_none() {
          continue;
        }
        self.chunk(cx, cy);
        touched.push((cx, cy));
      }
    }
    let index = (y.rem_euclid(CHUNK_SIZE) * CHUNK_SIZE + x.rem_euclid(CHUNK_SIZE)) as usize * TILE_BYTES;
    self.owned[at].as_mut().expect("собран")[index..index + TILE_BYTES].copy_from_slice(&bytes);
    self.revision += 1;
    match &mut self.pending {
      Some(pending) => pending.extend(touched),
      None => self.rederive(touched),
    }
  }

  /// Начинает пакет правок (`batchLand`): выводимое соседних чанков пересчитается один раз, в `end_batch`.
  pub fn begin_batch(&mut self) {
    self.pending.get_or_insert_with(Default::default);
  }

  /// Кончает пакет правок: пересчитывает выводимое у тронутых чанков.
  pub fn end_batch(&mut self) {
    if let Some(pending) = self.pending.take() {
      self.rederive(pending);
    }
  }

  /// Пересчитывает выводимое у чанков карты и отмечает их правку.
  fn rederive(&mut self, chunks: impl IntoIterator<Item = (i32, i32)>) {
    for (cx, cy) in chunks {
      let Some(at) = self.area.index(cx, cy) else { continue };
      let Some(mut chunk) = self.owned[at].take() else { continue };
      self.derive(&mut chunk, cx, cy);
      self.owned[at] = Some(chunk);
      self.revisions.insert((cx, cy), self.revision);
    }
  }

  /// Тип, ярус и обрывистость соседа для выводимого (`neighbor`).
  fn neighbor(&self, mut x: i32, mut y: i32, chunk: &[u8], chunk_x: i32, chunk_y: i32, peaks: &mut HashMap<(i32, i32), Vec<Peak>>) -> (u8, i32, bool) {
    let area = self.area;
    if area.index(chunk_x, chunk_y).is_some() {
      x = (area.left * CHUNK_SIZE).max(((area.left + area.width) * CHUNK_SIZE - 1).min(x));
      y = (area.top * CHUNK_SIZE).max(((area.top + area.height) * CHUNK_SIZE - 1).min(y));
    }
    let (cx, cy) = (x.div_euclid(CHUNK_SIZE), y.div_euclid(CHUNK_SIZE));
    let tiles = if cx == chunk_x && cy == chunk_y { Some(chunk) } else { area.index(cx, cy).and_then(|at| self.owned[at].as_deref()) };
    let Some(tiles) = tiles else { return generated_tile(&self.config, x, y, peaks) };
    let index = ((y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE) as usize * TILE_BYTES;
    if tiles[index] == MOUNTAIN {
      return (MOUNTAIN, -1, false);
    }
    (tiles[index], (tiles[index + 3] & 3) as i32, tiles[index + 3] & CLIFF_BIT != 0)
  }

  /// Досчитывает выводимое из соседей: глубину в песках, перепад ярусов и подножие обрыва (`deriveChunk`).
  fn derive(&self, chunk: &mut [u8], chunk_x: i32, chunk_y: i32) {
    let span = (CHUNK_SIZE + DERIVE_MARGIN * 2) as usize;
    let mut types = vec![0u8; span * span];
    let mut tiers = vec![0i8; span * span];
    let mut cliffs = vec![false; span * span];
    let mut peaks = HashMap::new();
    for y in 0..span {
      for x in 0..span {
        let (terrain, tier, cliff) = self.neighbor(chunk_x * CHUNK_SIZE + x as i32 - DERIVE_MARGIN, chunk_y * CHUNK_SIZE + y as i32 - DERIVE_MARGIN, chunk, chunk_x, chunk_y, &mut peaks);
        types[y * span + x] = terrain;
        tiers[y * span + x] = tier as i8;
        cliffs[y * span + x] = cliff;
      }
    }
    // Расстояние до ближайшего не-песка — в f32, как Float32Array в TS: сумма считается в f64 и округляется при записи.
    let mut distance: Vec<f32> = types.iter().map(|&terrain| if terrain == SAND { f32::INFINITY } else { 0.0 }).collect();
    let relax = |distance: &mut Vec<f32>, i: usize, j: usize, cost: f64| {
      let value = distance[j] as f64 + cost;
      if value < distance[i] as f64 {
        distance[i] = value as f32;
      }
    };
    let sqrt2 = std::f64::consts::SQRT_2;
    for y in 0..span {
      for x in 0..span {
        let i = y * span + x;
        if x > 0 {
          relax(&mut distance, i, i - 1, 1.0);
        }
        if y > 0 {
          relax(&mut distance, i, i - span, 1.0);
          if x > 0 {
            relax(&mut distance, i, i - span - 1, sqrt2);
          }
          if x < span - 1 {
            relax(&mut distance, i, i - span + 1, sqrt2);
          }
        }
      }
    }
    for y in (0..span).rev() {
      for x in (0..span).rev() {
        let i = y * span + x;
        if x < span - 1 {
          relax(&mut distance, i, i + 1, 1.0);
        }
        if y < span - 1 {
          relax(&mut distance, i, i + span, 1.0);
          if x < span - 1 {
            relax(&mut distance, i, i + span + 1, sqrt2);
          }
          if x > 0 {
            relax(&mut distance, i, i + span - 1, sqrt2);
          }
        }
      }
    }
    let margin = DERIVE_MARGIN as usize;
    for y in 0..CHUNK_SIZE as usize {
      for x in 0..CHUNK_SIZE as usize {
        let index = (y * CHUNK_SIZE as usize + x) * TILE_BYTES;
        if chunk[index] == MOUNTAIN {
          continue;
        }
        let at = (y + margin) * span + x + margin;
        chunk[index + 2] = js_round(0f64.max(1f64.min((distance[at] as f64 - 0.5) / SAND_REACH)) * 255.0) as u8;
        let tier = tiers[at];
        let near = |dx: i32, dy: i32| (at as i64 + dy as i64 * span as i64 + dx as i64) as usize;
        let mut step = false;
        'step: for dy in -STEP_UP..=STEP_DOWN {
          for dx in -STEP_SIDE..=STEP_SIDE {
            let other = tiers[near(dx, dy)];
            if other >= 0 && other != tier {
              step = true;
              break 'step;
            }
          }
        }
        let mut foot = false;
        'foot: for dy in -1..=1 {
          for dx in -1..=1 {
            let n = near(dx, dy);
            if tiers[n] > tier && cliffs[n] {
              foot = true;
              break 'foot;
            }
          }
        }
        chunk[index + 3] = (chunk[index + 3] & !DERIVED_BITS) | if step { STEP_BIT } else { 0 } | if foot { FOOT_BIT } else { 0 };
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn written_tile_rederives_its_neighbours() {
    let config: GeneratorConfig = serde_json::from_str("{ \"seed\": 1, \"zoneScale\": 1, \"zoneWarp\": 1, \"swampLevel\": 1, \"rockLevel\": 1, \"biomeScale\": 1, \"peakChance\": 1, \"peakMinRadius\": 1, \"peakMaxRadius\": 1, \"doubleChance\": 1, \"tripleChance\": 1, \"saltSwampShift\": 1, \"saltRockShift\": 1, \"saltPeakFactor\": 1, \"redSwampShift\": 1, \"redRockShift\": 1, \"redPeakFactor\": 1, \"marshSwampShift\": 1, \"marshRockShift\": 1, \"marshPeakFactor\": 1, \"tierStep\": 1, \"cliffScale\": 1, \"cliffShare\": 1, \"blank\": true }").unwrap();
    let mut land = Land::new(config, LandArea::of(-64, -64, 64, 64));
    assert_eq!(land.tile(3, 3)[0], SAND);
    // Скала посреди песков: глубина песков у соседа падает, чанк отмечен правкой.
    let before = land.tile(4, 3)[2];
    land.write_tile(3, 3, [ROCK, 0, 0, 1 | CLIFF_BIT]);
    assert_eq!(land.stored(3, 3), [ROCK, 0, 0, 1 | CLIFF_BIT]);
    assert!(land.tile(4, 3)[2] < before);
    assert!(land.tile(4, 3)[3] & FOOT_BIT != 0, "подножие у обрывистой скалы выше");
    assert!(land.chunk_revision(0, 0) > 0);
    // Вне карты — ничего.
    land.write_tile(500, 500, [ROCK, 0, 0, 0]);
    assert_eq!(land.tile(500, 500)[0], SAND);
  }

  #[test]
  fn hash_follows_js_imul() {
    // Значения сняты в Bun: hash(0, 0, 1337), hash(-5, 7, 1337 + 5003), hash(123456, -654321, 4294967296 + 9).
    assert_eq!(hash(0.0, 0.0, 1337.0), 0.3876720452681184);
    assert_eq!(hash(-5.0, 7.0, 6340.0), 0.8669962820131332);
    assert_eq!(hash(123456.0, -654321.0, 4294967305.0), 0.9288620941806585);
  }
}
