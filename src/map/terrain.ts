export const Terrain = {
  /** Болото: непроходимо для наземной техники. */
  Swamp: 0,
  /** Пустыня. */
  Sand: 1,
  /** Скальное плато: только здесь можно строить основные здания. */
  Rock: 2,
  /** Горы: непроходимые вершины посреди плато, одиночные или сросшиеся по две-три. */
  Mountain: 3,
} as const

export type Terrain = (typeof Terrain)[keyof typeof Terrain]

/** Биомы — большие области со своим соотношением зон, палитрой и деталями. Номера совпадают с константами в terrain.frag. */
export const Biome = {
  /** Эрг: классическая пустыня с полями барханов. */
  Erg: 0,
  /** Солончаки: светлая растрескавшаяся корка, мало болот и скал, вместо болот — рассол. */
  SaltFlats: 1,
  /** Красные пустоши: много скал и гор, камни на песке, почти нет болот. */
  RedWastes: 2,
  /** Топи: много болот, кочки с растительностью, мало скал. */
  Marsh: 3,
} as const

export type Biome = (typeof Biome)[keyof typeof Biome]

export const CHUNK_SIZE = 32
/** Четыре байта на тайл: [тип местности, биом (2 бита основной, 2 бита соседний, 4 бита доля соседнего), глубина в песках 0..255, 0]; у гор третий байт — радиус вершины, четвёртый — смещение до её центра. В таком же виде данные уходят в шейдер. */
export const TILE_BYTES = 4

const MAX_CACHED_CHUNKS = 4096

/** Параметры генератора. Один и тот же набор всегда даёт один и тот же мир. */
export interface GeneratorConfig {
  seed: number
  /** Характерный размер зон в тайлах: чем больше, тем крупнее плато, пустыни и болота. */
  zoneScale: number
  /** На сколько тайлов искажаются границы зон: 0 — округлые пятна, больше — изрезанные. */
  zoneWarp: number
  /** Высота, ниже которой болото. */
  swampLevel: number
  /** Высота, выше которой скалы. Между уровнями — песок. */
  rockLevel: number
  /** Характерный размер биомов в тайлах. */
  biomeScale: number
  /** Доля клеток 16×16 с горами (если место целиком на плато). */
  peakChance: number
  /** Радиус главной вершины группы, в тайлах. */
  peakMinRadius: number
  peakMaxRadius: number
  /** Доли двойных и тройных гор; остальные одиночные. */
  doubleChance: number
  tripleChance: number
  /**
   * Поправки биомов относительно эрга: сдвиг уровня болот и уровня скал (плюс к уровню болот — воды больше,
   * плюс к уровню скал — скал меньше) и множитель частоты гор.
   */
  saltSwampShift: number
  saltRockShift: number
  saltPeakFactor: number
  redSwampShift: number
  redRockShift: number
  redPeakFactor: number
  marshSwampShift: number
  marshRockShift: number
  marshPeakFactor: number
}

export const DEFAULT_CONFIG: GeneratorConfig = {
  seed: 1337,
  zoneScale: 56,
  zoneWarp: 30,
  swampLevel: 0.37,
  rockLevel: 0.59,
  biomeScale: 240,
  peakChance: 0.3,
  peakMinRadius: 1,
  peakMaxRadius: 2,
  doubleChance: 0.35,
  tripleChance: 0.15,
  saltSwampShift: -0.05,
  saltRockShift: 0.05,
  saltPeakFactor: 1,
  redSwampShift: -0.06,
  redRockShift: -0.07,
  redPeakFactor: 2.5,
  marshSwampShift: 0.09,
  marshRockShift: 0.04,
  marshPeakFactor: 0.5,
}

/** Больше нельзя: шейдер ищет вершины только в соседних тайлах (PEAK_SEARCH в terrain.frag). */
export const PEAK_RADIUS_LIMIT = 2

/** Местность: параметры генератора и уже посчитанные чанки. Не путать с миром ECS, где живут сущности. */
export interface Land {
  config: GeneratorConfig
  /** Ключ — координаты чанка одним числом, см. tileKey. */
  chunks: Map<number, Uint8Array>
  /** Чанк, к которому обращались последним: соседние тайлы спрашивают подряд. */
  last: Uint8Array | null
  lastKey: number
}

/** Пара целых координат одним числом: ключ для словарей и множеств тайлов, чанков, ячеек. */
export const tileKey = (x: number, y: number) => (y + 32768) * 65536 + x + 32768

export function createLand(config: GeneratorConfig): Land {
  return { config, chunks: new Map(), last: null, lastKey: 0 }
}

export function isBuildable(terrain: Terrain): boolean {
  return terrain === Terrain.Rock
}

export function isPassable(terrain: Terrain): boolean {
  return terrain === Terrain.Sand || terrain === Terrain.Rock
}

/** Случайное число от 0 до 1, одно и то же для одних и тех же координат и сида. */
export function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Шум без таблиц: значение в любой точке считается из координат и сида, поэтому мир не повторяется и не имеет краёв.
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let fx = x - ix
  let fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy, seed)
  const b = hash(ix + 1, iy, seed)
  const c = hash(ix, iy + 1, seed)
  const d = hash(ix + 1, iy + 1, seed)
  const top = a + (b - a) * fx
  return top + (c + (d - c) * fx - top) * fy
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0
  let amplitude = 0.5
  let total = 0
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * noise(x, y, seed + octave * 1013)
    total += amplitude
    amplitude *= 0.5
    x *= 2
    y *= 2
  }
  return sum / total
}

function elevationAt(x: number, y: number, config: GeneratorConfig): number {
  const { seed, zoneScale, zoneWarp } = config
  // Искажаем координаты, чтобы плато и болота были неправильной формы.
  const warpX = (fbm(x / zoneScale, y / zoneScale, seed + 7001, 2) - 0.5) * zoneWarp
  const warpY = (fbm(x / zoneScale, y / zoneScale, seed + 9001, 2) - 0.5) * zoneWarp
  return fbm((x + warpX) / zoneScale, (y + warpY) / zoneScale, seed, 4)
}

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Доли биомов в точке, по номерам из Biome; в сумме дают 1. Внутри биома одна из долей равна 1, на стыках они плавно перетекают. */
function biomeWeights(x: number, y: number, config: GeneratorConfig): number[] {
  const { seed, biomeScale } = config
  const heat = fbm(x / biomeScale, y / biomeScale, seed + 11003, 2)
  const wetness = fbm(x / biomeScale, y / biomeScale, seed + 13007, 2)
  const marsh = smoothstep(0.56, 0.64, wetness)
  const red = (1 - marsh) * smoothstep(0.56, 0.64, heat)
  const salt = (1 - marsh) * smoothstep(0.44, 0.36, heat)
  return [1 - marsh - red - salt, salt, red, marsh]
}

/** Уровни болот и скал с поправкой на биом: так в топях больше воды, а в красных пустошах больше скал. */
function zoneLevels(weights: number[], config: GeneratorConfig) {
  const salt = weights[Biome.SaltFlats]
  const red = weights[Biome.RedWastes]
  const marsh = weights[Biome.Marsh]
  return {
    swamp: config.swampLevel + salt * config.saltSwampShift + red * config.redSwampShift + marsh * config.marshSwampShift,
    rock: config.rockLevel + salt * config.saltRockShift + red * config.redRockShift + marsh * config.marshRockShift,
  }
}

function peakChance(weights: number[], config: GeneratorConfig): number {
  const factor =
    weights[Biome.Erg] +
    weights[Biome.SaltFlats] * config.saltPeakFactor +
    weights[Biome.RedWastes] * config.redPeakFactor +
    weights[Biome.Marsh] * config.marshPeakFactor
  return config.peakChance * factor
}

/** Упаковывает доли биомов в байт: основной биом, соседний и доля соседнего (0..15 — это 0..50%). */
function packBiome(weights: number[]): number {
  let primary = 0
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[primary]) primary = i
  let secondary = primary === 0 ? 1 : 0
  for (let i = 0; i < weights.length; i++) if (i !== primary && weights[i] > weights[secondary]) secondary = i
  const share = weights[secondary] / (weights[primary] + weights[secondary])
  return (primary << 6) | (secondary << 4) | Math.min(15, Math.round(share * 30))
}

function classify(elevation: number, levels: { swamp: number; rock: number }): Terrain {
  if (elevation < levels.swamp) return Terrain.Swamp
  if (elevation > levels.rock) return Terrain.Rock
  return Terrain.Sand
}

/** Мир поделён на клетки такого размера (в тайлах); в каждой может стоять не больше одной группы вершин. Делит CHUNK_SIZE нацело. */
const PEAK_CELL = 16
/** Вершины-спутники в группе меньше главной. */
const SATELLITE_MIN_RADIUS = 0.7
const SATELLITE_MAX_RADIUS = 1.4
/** Центры вершин одной группы не ближе этого расстояния, иначе они сольются в одну. */
const PEAK_MIN_SPACING = 1.5
/** Радиус хранится в байте как доля от этого значения. Совпадает с PEAK_RADIUS_SCALE в terrain.frag. */
const PEAK_RADIUS_SCALE = 4
/** Тайл считается горой, если вершина задевает его хотя бы краем: половина диагонали тайла. */
const TILE_REACH = Math.SQRT1_2

interface Peak {
  /** Центр в тайлах, кратен 0.5. */
  x: number
  y: number
  radius: number
}

/** Вершина должна целиком стоять на плато и не подходить к его краю. */
function fitsOnRock(peak: Peak, config: GeneratorConfig): boolean {
  const reach = peak.radius + 1.5
  for (const [dx, dy] of [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]]) {
    const x = peak.x + dx
    const y = peak.y + dy
    if (elevationAt(x, y, config) <= zoneLevels(biomeWeights(x, y, config), config).rock) return false
  }
  return true
}

function peaksInCell(cellX: number, cellY: number, config: GeneratorConfig): Peak[] {
  const random = (salt: number) => hash(cellX, cellY, config.seed + 5003 + salt * 131)
  const cellCenterX = (cellX + 0.5) * PEAK_CELL
  const cellCenterY = (cellY + 0.5) * PEAK_CELL
  if (random(0) >= peakChance(biomeWeights(cellCenterX, cellCenterY, config), config)) return []

  const maxRadius = Math.min(config.peakMaxRadius, PEAK_RADIUS_LIMIT)
  const minRadius = Math.min(config.peakMinRadius, maxRadius)

  // Главная вершина стоит в середине клетки, чтобы вся группа с запасом не вылезала в соседнюю.
  const main: Peak = {
    x: cellX * PEAK_CELL + 5 + Math.round(random(1) * 12) / 2,
    y: cellY * PEAK_CELL + 5 + Math.round(random(2) * 12) / 2,
    radius: minRadius + random(3) * (maxRadius - minRadius),
  }
  if (!fitsOnRock(main, config)) return []
  const peaks = [main]

  const sizeRoll = random(4)
  const count = sizeRoll < config.tripleChance ? 3 : sizeRoll < config.tripleChance + config.doubleChance ? 2 : 1
  for (let i = 1; i < count; i++) {
    const radius = SATELLITE_MIN_RADIUS + random(i * 10 + 5) * (SATELLITE_MAX_RADIUS - SATELLITE_MIN_RADIUS)
    const angle = random(i * 10 + 6) * Math.PI * 2
    // Спутник наполовину утоплен в главную вершину.
    const distance = (main.radius + radius) * 0.6
    const satellite: Peak = {
      x: Math.round((main.x + Math.cos(angle) * distance) * 2) / 2,
      y: Math.round((main.y + Math.sin(angle) * distance) * 2) / 2,
      radius,
    }
    const crowded = peaks.some((other) => Math.hypot(other.x - satellite.x, other.y - satellite.y) < PEAK_MIN_SPACING)
    if (!crowded && fitsOnRock(satellite, config)) peaks.push(satellite)
  }
  return peaks
}

/** Насколько тайл далеко от скал и болот: 0 у границы песков, 1 в их середине. Шейдер по этому значению отодвигает барханы от других зон. */
function sandDepth(elevation: number, levels: { swamp: number; rock: number }): number {
  if (levels.rock <= levels.swamp) return 0
  const margin = Math.min(elevation - levels.swamp, levels.rock - elevation)
  return Math.max(0, Math.min(1, margin / ((levels.rock - levels.swamp) / 2)))
}

/**
 * Зона и биом тайла (x, y) без чанков и гор: дёшево для схемы всей карты, например для предпросмотра в меню.
 * Совпадает с местностью мира везде, кроме самих гор — они слишком малы для схемы.
 */
export function sampleTerrain(config: GeneratorConfig, x: number, y: number): { terrain: Terrain; biome: Biome } {
  const weights = biomeWeights(x, y, config)
  return { terrain: classify(elevationAt(x, y, config), zoneLevels(weights, config)), biome: (packBiome(weights) >> 6) as Biome }
}

function generateChunk(config: GeneratorConfig, chunkX: number, chunkY: number): Uint8Array {
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * TILE_BYTES)

  const cellsPerChunk = CHUNK_SIZE / PEAK_CELL
  const cells: Peak[][] = []
  for (let cellY = 0; cellY < cellsPerChunk; cellY++) {
    for (let cellX = 0; cellX < cellsPerChunk; cellX++) {
      cells.push(peaksInCell(chunkX * cellsPerChunk + cellX, chunkY * cellsPerChunk + cellY, config))
    }
  }

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = chunkX * CHUNK_SIZE + x
      const worldY = chunkY * CHUNK_SIZE + y
      const elevation = elevationAt(worldX, worldY, config)
      const index = (y * CHUNK_SIZE + x) * TILE_BYTES
      const weights = biomeWeights(worldX, worldY, config)
      const levels = zoneLevels(weights, config)
      tiles[index] = classify(elevation, levels)
      tiles[index + 1] = packBiome(weights)
      tiles[index + 2] = Math.round(sandDepth(elevation, levels) * 255)

      // В тайл записывается ближайшая из задевающих его вершин; остальные шейдер найдёт в соседних тайлах.
      let nearest: Peak | null = null
      let nearestDistance = Infinity
      for (const peak of cells[Math.floor(y / PEAK_CELL) * cellsPerChunk + Math.floor(x / PEAK_CELL)]) {
        const distance = Math.hypot(peak.x - (worldX + 0.5), peak.y - (worldY + 0.5))
        if (distance < peak.radius + TILE_REACH && distance < nearestDistance) {
          nearest = peak
          nearestDistance = distance
        }
      }
      if (nearest) {
        tiles[index] = Terrain.Mountain
        tiles[index + 2] = Math.round((nearest.radius / PEAK_RADIUS_SCALE) * 255)
        // Смещение до центра вершины в половинках тайла, по 4 бита на ось.
        const dx = (nearest.x - (worldX + 0.5)) * 2 + 8
        const dy = (nearest.y - (worldY + 0.5)) * 2 + 8
        tiles[index + 3] = (dx << 4) | dy
      }
    }
  }
  return tiles
}

/** Возвращает чанк по его координатам (в чанках), генерируя при первом обращении. */
export function getChunk(land: Land, chunkX: number, chunkY: number): Uint8Array {
  const key = tileKey(chunkX, chunkY)
  if (land.last && land.lastKey === key) return land.last
  let chunk = land.chunks.get(key)
  if (!chunk) {
    chunk = generateChunk(land.config, chunkX, chunkY)
    land.chunks.set(key, chunk)
    if (land.chunks.size > MAX_CACHED_CHUNKS) {
      // Самый старый чанк можно выбросить: он детерминированно сгенерируется заново.
      land.chunks.delete(land.chunks.keys().next().value!)
    }
  }
  land.last = chunk
  land.lastKey = key
  return chunk
}

/** Основной биом в точке. */
export function biomeAt(land: Land, x: number, y: number): Biome {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  const chunk = getChunk(land, chunkX, chunkY)
  const localX = Math.floor(x) - chunkX * CHUNK_SIZE
  const localY = Math.floor(y) - chunkY * CHUNK_SIZE
  return (chunk[(localY * CHUNK_SIZE + localX) * TILE_BYTES + 1] >> 6) as Biome
}

export function terrainAt(land: Land, x: number, y: number): Terrain {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  const chunk = getChunk(land, chunkX, chunkY)
  const localX = Math.floor(x) - chunkX * CHUNK_SIZE
  const localY = Math.floor(y) - chunkY * CHUNK_SIZE
  return chunk[(localY * CHUNK_SIZE + localX) * TILE_BYTES] as Terrain
}
