export const Terrain = {
  /** Болото: проходимо, но сильно замедляет наземных, см. Rules. */
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
/**
 * Четыре байта на тайл: [тип местности, биом (2 бита основной, 2 бита соседний, 4 бита доля соседнего), глубина в
 * песках 0..255, рельеф]; у гор третий байт — радиус вершины, четвёртый — смещение до её центра. Рельеф у остальных:
 * 2 младших бита — ярус (0 — пески и болота, 1..3 — ярусы плато), бит CLIFF_BIT — кромка тайла к нижним соседям
 * обрывистая, а не пологая, бит STEP_BIT — рядом перепад ярусов, FOOT_BIT — тайл на кромке обрыва. В таком же виде данные уходят в шейдер.
 */
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
  /** На сколько высота должна подняться над уровнем скал, чтобы плато поднялось на следующий ярус. */
  tierStep: number
  /** Характерная длина участков кромки, обрывистых или пологих, в тайлах. */
  cliffScale: number
  /** Доля обрывистой кромки: 0 — все кромки пологие, 1 — все обрывы. */
  cliffShare: number
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
  tierStep: 0.065,
  cliffScale: 20,
  cliffShare: 0.35,
}

/** Ярусов плато над песками. */
export const MAX_TIER = 3
/** Бит обрывистой кромки в байте рельефа. Совпадает с CLIFF_BIT в terrain.frag. */
export const CLIFF_BIT = 4
/**
 * Бит «рядом перепад ярусов» в байте рельефа: в соседях тайла от двух выше до одного ниже (и по одному вбок) есть
 * другой ярус. Без него шейдер не ищет обрывы — это дорого, а почти вся карта ровная. Совпадает с STEP_BIT в terrain.frag.
 */
export const STEP_BIT = 8
/**
 * Бит подножия обрыва: хотя бы один из восьми соседей выше яруса тайла, и кромка у того обрывистая. Стенку обрыва
 * шейдер рисует на нижнем тайле, поэтому закрыто подножие, а не верх: сверху к краю подъехать можно, снизу на стенку
 * не заехать. Технике сюда нельзя, пехота лезет медленно (см. isWalkable и terrainSpeed в units.ts). Выводится из
 * соседей, как STEP_BIT.
 */
export const FOOT_BIT = 16
/** Что в байте рельефа выводится из соседей и не хранится. */
const DERIVED_BITS = STEP_BIT | FOOT_BIT
/** Окно соседей для STEP_BIT: сверху больше — туда смотрит стенка обрыва. */
const STEP_UP = 2
const STEP_DOWN = 1
const STEP_SIDE = 1

/** Больше нельзя: шейдер ищет вершины только в соседних тайлах (PEAK_SEARCH в terrain.frag). */
export const PEAK_RADIUS_LIMIT = 2

/** Прямоугольник чанков: левый верхний чанк и размер, в чанках. */
export interface LandArea {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Местность. Не путать с миром ECS, где живут сущности.
 *
 * Внутри области карты (area) чанки — данные мира: собранные однажды, они больше не берутся из генератора, могут
 * меняться (setTile) и целиком уходят в сохранение (saveLand). Поэтому смена генератора не трогает уже начатые миры.
 * Собираются они лениво, при первом обращении: генератор детерминирован, так что это то же самое, что собрать все
 * сразу. Вне области — декоративный край мира: он всегда из генератора и только кэшируется.
 *
 * Глубина в песках и биты STEP_BIT и FOOT_BIT в данных не хранятся: они выводятся из типов и ярусов соседей, см. deriveChunk.
 */
export interface Land {
  config: GeneratorConfig
  /** Область карты мира; null — карты нет, вся местность из генератора (предпросмотр, отладка). */
  area: LandArea | null
  /** Чанки карты по номеру (y * width + x) в области; undefined — ещё не собран. */
  owned: (Uint8Array | undefined)[]
  /** Кэш чанков вне области. Ключ — координаты чанка одним числом, см. tileKey. */
  chunks: Map<number, Uint8Array>
  /** Чанк, к которому обращались последним: соседние тайлы спрашивают подряд. */
  last: Uint8Array | null
  lastKey: number
  /** Растёт с каждой правкой карты; по revisions — у каких чанков: окно на видеокарте перечитывает только их. */
  revision: number
  revisions: Map<number, number>
}

/** Пара целых координат одним числом: ключ для словарей и множеств тайлов, чанков, ячеек. */
export const tileKey = (x: number, y: number) => (y + 32768) * 65536 + x + 32768

/** Местность; area — область карты мира, см. Land. */
export function createLand(config: GeneratorConfig, area: LandArea | null = null): Land {
  const owned: (Uint8Array | undefined)[] = area ? new Array(area.width * area.height) : []
  return { config, area, owned, chunks: new Map(), last: null, lastKey: 0, revision: 0, revisions: new Map() }
}

/** Чанки, покрывающие прямоугольник тайлов [left, right) × [top, bottom). */
export function areaOf({ left, top, right, bottom }: { left: number; top: number; right: number; bottom: number }): LandArea {
  const fromX = Math.floor(left / CHUNK_SIZE)
  const fromY = Math.floor(top / CHUNK_SIZE)
  return { left: fromX, top: fromY, width: Math.ceil(right / CHUNK_SIZE) - fromX, height: Math.ceil(bottom / CHUNK_SIZE) - fromY }
}

/** Номер чанка в области или -1, если чанк вне её. */
function ownedIndex(land: Land, chunkX: number, chunkY: number) {
  const area = land.area
  if (!area) return -1
  const x = chunkX - area.left
  const y = chunkY - area.top
  return x >= 0 && y >= 0 && x < area.width && y < area.height ? y * area.width + x : -1
}

export function isBuildable(terrain: Terrain): boolean {
  return terrain === Terrain.Rock
}

/** Пройти по тайлу может наземный юнит: всюду, кроме гор. Болото и песок замедляют, см. Rules. */
export function isPassable(terrain: Terrain): boolean {
  return terrain !== Terrain.Mountain
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

/** Ярус тайла: пески и болота — 0, плато поднимается ступенями по мере роста высоты над уровнем скал. */
function tierOf(elevation: number, levels: { rock: number }, config: GeneratorConfig): number {
  if (elevation <= levels.rock) return 0
  return Math.min(MAX_TIER, 1 + Math.floor((elevation - levels.rock) / config.tierStep))
}

/** Обрывиста ли кромка тайла: обрывы и пологие въезды чередуются участками длиной около cliffScale. */
function isCliff(x: number, y: number, config: GeneratorConfig): boolean {
  return fbm(x / config.cliffScale, y / config.cliffScale, config.seed + 17011, 2) < config.cliffShare * 0.5 + 0.25
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

/**
 * Зона и биом тайла (x, y) без чанков и гор: дёшево для схемы всей карты, например для предпросмотра в меню.
 * Совпадает с местностью мира везде, кроме самих гор — они слишком малы для схемы.
 */
export function sampleTerrain(config: GeneratorConfig, x: number, y: number): { terrain: Terrain; biome: Biome } {
  const weights = biomeWeights(x, y, config)
  return { terrain: classify(elevationAt(x, y, config), zoneLevels(weights, config)), biome: (packBiome(weights) >> 6) as Biome }
}

/** Тип и ярус тайла по генератору, без гор: дёшево, для соседей ещё не собранных чанков. */
function baseTile(config: GeneratorConfig, x: number, y: number): [Terrain, number] {
  const elevation = elevationAt(x, y, config)
  const levels = zoneLevels(biomeWeights(x, y, config), config)
  return [classify(elevation, levels), tierOf(elevation, levels, config)]
}

/**
 * Чанк по генератору: тип, биом, рельеф и вершины гор. Глубину в песках и STEP_BIT досчитывает deriveChunk:
 * они зависят от соседей, а соседи карты могли поменяться.
 */
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
      const tier = tierOf(elevation, levels, config)
      tiles[index + 3] = tier | (tier && isCliff(worldX, worldY, config) ? CLIFF_BIT : 0)

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

/** На сколько тайлов от края песков барханы сходят на нет: дальше глубина в песках равна 1. */
const SAND_REACH = 8
/** Поле вокруг чанка, которое смотрит deriveChunk: хватает и глубине песков, и STEP_BIT. */
const DERIVE_MARGIN = Math.max(SAND_REACH, STEP_UP, STEP_DOWN, STEP_SIDE)

/**
 * Тип, ярус и обрывистость кромки соседа (у гор ярус -1: их байт рельефа занят вершиной). Из карты, если его чанк собран, из chunk —
 * если сосед в самом досчитываемом чанке, иначе из генератора: несобранный чанк карты ещё совпадает с ним.
 * За краем карты для её чанков — ближайший тайл карты: так из сохранения выходит то же при любом генераторе.
 */
function neighbor(land: Land, x: number, y: number, chunk: Uint8Array, chunkX: number, chunkY: number): [Terrain, number, boolean] {
  // Карта мира самодостаточна: за её краем для неё продолжается крайний тайл, а не генератор.
  const area = land.area
  if (area && ownedIndex(land, chunkX, chunkY) >= 0) {
    x = Math.max(area.left * CHUNK_SIZE, Math.min((area.left + area.width) * CHUNK_SIZE - 1, x))
    y = Math.max(area.top * CHUNK_SIZE, Math.min((area.top + area.height) * CHUNK_SIZE - 1, y))
  }
  const cx = Math.floor(x / CHUNK_SIZE)
  const cy = Math.floor(y / CHUNK_SIZE)
  const tiles = cx === chunkX && cy === chunkY ? chunk : land.owned[ownedIndex(land, cx, cy)]
  if (!tiles) {
    const [terrain, tier] = baseTile(land.config, x, y)
    return [terrain, tier, tier > 0 && isCliff(x, y, land.config)]
  }
  const index = ((y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE) * TILE_BYTES
  const terrain = tiles[index] as Terrain
  if (terrain === Terrain.Mountain) return [terrain, -1, false]
  return [terrain, tiles[index + 3] & 3, (tiles[index + 3] & CLIFF_BIT) !== 0]
}

/**
 * Досчитывает то, что выводится из соседей: глубину в песках (расстояние до скал и болот, см. SAND_REACH) и
 * STEP_BIT. Горы не трогает: их байты заняты вершиной.
 */
function deriveChunk(land: Land, chunk: Uint8Array, chunkX: number, chunkY: number) {
  const span = CHUNK_SIZE + DERIVE_MARGIN * 2
  const types = new Uint8Array(span * span)
  const tiers = new Int8Array(span * span)
  const cliffs = new Uint8Array(span * span)
  for (let y = 0; y < span; y++) {
    for (let x = 0; x < span; x++) {
      const [terrain, tier, cliff] = neighbor(land, chunkX * CHUNK_SIZE + x - DERIVE_MARGIN, chunkY * CHUNK_SIZE + y - DERIVE_MARGIN, chunk, chunkX, chunkY)
      types[y * span + x] = terrain
      tiers[y * span + x] = tier
      cliffs[y * span + x] = cliff ? 1 : 0
    }
  }

  // Расстояние до ближайшего не-песка: два прохода по сетке с шагами 1 и √2.
  const distance = new Float32Array(span * span)
  for (let i = 0; i < span * span; i++) distance[i] = types[i] === Terrain.Sand ? Infinity : 0
  const relax = (i: number, j: number, cost: number) => {
    if (distance[j] + cost < distance[i]) distance[i] = distance[j] + cost
  }
  for (let y = 0; y < span; y++) {
    for (let x = 0; x < span; x++) {
      const i = y * span + x
      if (x > 0) relax(i, i - 1, 1)
      if (y > 0) {
        relax(i, i - span, 1)
        if (x > 0) relax(i, i - span - 1, Math.SQRT2)
        if (x < span - 1) relax(i, i - span + 1, Math.SQRT2)
      }
    }
  }
  for (let y = span - 1; y >= 0; y--) {
    for (let x = span - 1; x >= 0; x--) {
      const i = y * span + x
      if (x < span - 1) relax(i, i + 1, 1)
      if (y < span - 1) {
        relax(i, i + span, 1)
        if (x < span - 1) relax(i, i + span + 1, Math.SQRT2)
        if (x > 0) relax(i, i + span - 1, Math.SQRT2)
      }
    }
  }

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const index = (y * CHUNK_SIZE + x) * TILE_BYTES
      if (chunk[index] === Terrain.Mountain) continue
      const at = (y + DERIVE_MARGIN) * span + x + DERIVE_MARGIN
      // Тайл у самой кромки — 0, на SAND_REACH тайлов вглубь — 1.
      chunk[index + 2] = Math.round(Math.max(0, Math.min(1, (distance[at] - 0.5) / SAND_REACH)) * 255)
      const tier = tiers[at]
      let step = false
      for (let dy = -STEP_UP; dy <= STEP_DOWN && !step; dy++) {
        for (let dx = -STEP_SIDE; dx <= STEP_SIDE; dx++) {
          const other = tiers[at + dy * span + dx]
          if (other >= 0 && other !== tier) {
            step = true
            break
          }
        }
      }
      let foot = false
      for (let dy = -1; dy <= 1 && !foot; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const near = at + dy * span + dx
          if (tiers[near] > tier && cliffs[near]) {
            foot = true
            break
          }
        }
      }
      chunk[index + 3] = (chunk[index + 3] & ~DERIVED_BITS) | (step ? STEP_BIT : 0) | (foot ? FOOT_BIT : 0)
    }
  }
}

/** Возвращает чанк по его координатам (в чанках), собирая при первом обращении. */
export function getChunk(land: Land, chunkX: number, chunkY: number): Uint8Array {
  const key = tileKey(chunkX, chunkY)
  if (land.last && land.lastKey === key) return land.last
  const owned = ownedIndex(land, chunkX, chunkY)
  let chunk = owned >= 0 ? land.owned[owned] : land.chunks.get(key)
  if (!chunk) {
    chunk = generateChunk(land.config, chunkX, chunkY)
    if (owned >= 0) land.owned[owned] = chunk
    deriveChunk(land, chunk, chunkX, chunkY)
    if (owned < 0) {
      land.chunks.set(key, chunk)
      if (land.chunks.size > MAX_CACHED_CHUNKS) {
        // Самый старый чанк можно выбросить: он детерминированно сгенерируется заново.
        land.chunks.delete(land.chunks.keys().next().value!)
      }
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

/** Тайл у подножия обрыва, см. FOOT_BIT. */
export function isCliffFoot(land: Land, x: number, y: number): boolean {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  const chunk = getChunk(land, chunkX, chunkY)
  const index = ((Math.floor(y) - chunkY * CHUNK_SIZE) * CHUNK_SIZE + Math.floor(x) - chunkX * CHUNK_SIZE) * TILE_BYTES
  return chunk[index] !== Terrain.Mountain && (chunk[index + 3] & FOOT_BIT) !== 0
}

export function terrainAt(land: Land, x: number, y: number): Terrain {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  const chunk = getChunk(land, chunkX, chunkY)
  const localX = Math.floor(x) - chunkX * CHUNK_SIZE
  const localY = Math.floor(y) - chunkY * CHUNK_SIZE
  return chunk[(localY * CHUNK_SIZE + localX) * TILE_BYTES] as Terrain
}

/** Номер правки чанка: окно на видеокарте сравнивает его с тем, что уже загрузило. 0 — чанк не правили. */
export const chunkRevision = (land: Land, chunkX: number, chunkY: number) => land.revisions.get(tileKey(chunkX, chunkY)) ?? 0

/** Каким становится тайл: тип (кроме гор), биом в упаковке packBiome, ярус и обрывистость кромки. */
export interface TileEdit {
  terrain: Terrain
  biome: number
  tier: number
  cliff: boolean
}

/**
 * Меняет тайл карты. Вне области карты ничего не делает: край мира — из генератора. Пересчитывает глубину в песках
 * и STEP_BIT соседей. Правки мира идут через editTile (landMemory.ts): он помнит, кто из игроков что знает.
 */
export function setTile(land: Land, x: number, y: number, edit: TileEdit) {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  if (ownedIndex(land, chunkX, chunkY) < 0 || edit.terrain === Terrain.Mountain) return
  // Соседи, которые выводят что-то из этого тайла, собираются до правки: несобранный посчитал бы его по генератору.
  const reach = Math.ceil(DERIVE_MARGIN / CHUNK_SIZE)
  const touched: [number, number][] = []
  for (let cy = Math.floor((y - DERIVE_MARGIN) / CHUNK_SIZE); cy <= Math.floor((y + DERIVE_MARGIN) / CHUNK_SIZE); cy++) {
    for (let cx = Math.floor((x - DERIVE_MARGIN) / CHUNK_SIZE); cx <= Math.floor((x + DERIVE_MARGIN) / CHUNK_SIZE); cx++) {
      if (Math.abs(cx - chunkX) > reach || Math.abs(cy - chunkY) > reach || ownedIndex(land, cx, cy) < 0) continue
      getChunk(land, cx, cy)
      touched.push([cx, cy])
    }
  }
  const chunk = getChunk(land, chunkX, chunkY)
  const index = ((y - chunkY * CHUNK_SIZE) * CHUNK_SIZE + x - chunkX * CHUNK_SIZE) * TILE_BYTES
  chunk[index] = edit.terrain
  chunk[index + 1] = edit.biome
  chunk[index + 2] = 0
  chunk[index + 3] = (edit.tier & 3) | (edit.cliff ? CLIFF_BIT : 0)
  land.revision++
  for (const [cx, cy] of touched) {
    deriveChunk(land, land.owned[ownedIndex(land, cx, cy)]!, cx, cy)
    land.revisions.set(tileKey(cx, cy), land.revision)
  }
}

/**
 * Хранимые байты тайла: тип, биом, байт вершины и рельеф без выводимого (у не-гор третий байт и STEP_BIT — 0).
 * Так тайл лежит в saveLand и ходит в правках.
 */
export function tileBytes(land: Land, x: number, y: number): number[] {
  const chunkX = Math.floor(x / CHUNK_SIZE)
  const chunkY = Math.floor(y / CHUNK_SIZE)
  const chunk = getChunk(land, chunkX, chunkY)
  const index = ((y - chunkY * CHUNK_SIZE) * CHUNK_SIZE + x - chunkX * CHUNK_SIZE) * TILE_BYTES
  const mountain = chunk[index] === Terrain.Mountain
  return [chunk[index], chunk[index + 1], mountain ? chunk[index + 2] : 0, mountain ? chunk[index + 3] : chunk[index + 3] & ~DERIVED_BITS]
}

/** Накладывает правки: x, y и хранимые байты тайла (см. tileBytes) подряд. */
export function applyEdits(land: Land, edits: number[]) {
  for (let i = 0; i + 5 < edits.length; i += 6) {
    const relief = edits[i + 5]
    setTile(land, edits[i], edits[i + 1], { terrain: edits[i + 2] as Terrain, biome: edits[i + 3], tier: relief & 3, cliff: (relief & CLIFF_BIT) !== 0 })
  }
}

/** Подменяет тайл (x, y) в байтах saveLand хранимыми байтами tile. Тайл вне карты пропускает. */
export function patchSavedTile(bytes: Uint8Array, x: number, y: number, tile: number[]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const left = view.getInt32(1, true)
  const top = view.getInt32(5, true)
  const width = view.getInt32(9, true)
  const height = view.getInt32(13, true)
  const cx = Math.floor(x / CHUNK_SIZE) - left
  const cy = Math.floor(y / CHUNK_SIZE) - top
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return
  const tiles = width * height * CHUNK_SIZE * CHUNK_SIZE
  const at = (cy * width + cx) * CHUNK_SIZE * CHUNK_SIZE + (y - Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE) * CHUNK_SIZE + x - Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE
  for (let plane = 0; plane < TILE_BYTES; plane++) bytes[LAND_HEADER + tiles * plane + at] = tile[plane]
}

/** Версия упаковки карты в saveLand. */
const LAND_FORMAT = 1
const LAND_HEADER = 1 + 4 * 4

/**
 * Карта мира в байты. Тайлы лежат плоскостями — сначала все типы, потом все биомы и т. д.: однородное подряд
 * сжимается в разы лучше. То, что выводится из соседей (глубина в песках, STEP_BIT), не хранится. Несобранные
 * чанки собираются. Заголовок: формат (1 байт), область в чанках (left, top, width, height — int32).
 */
export function saveLand(land: Land): Uint8Array {
  const area = land.area
  if (!area) throw new Error('У местности нет карты мира')
  // Сначала все несобранные чанки, потом их производные: тогда соседи берутся из карты, а не считаются генератором заново.
  const fresh: number[] = []
  for (let n = 0; n < area.width * area.height; n++) {
    if (land.owned[n]) continue
    land.owned[n] = generateChunk(land.config, area.left + (n % area.width), area.top + Math.floor(n / area.width))
    fresh.push(n)
  }
  for (const n of fresh) deriveChunk(land, land.owned[n]!, area.left + (n % area.width), area.top + Math.floor(n / area.width))
  const tiles = area.width * area.height * CHUNK_SIZE * CHUNK_SIZE
  const bytes = new Uint8Array(LAND_HEADER + tiles * TILE_BYTES)
  const view = new DataView(bytes.buffer)
  bytes[0] = LAND_FORMAT
  view.setInt32(1, area.left, true)
  view.setInt32(5, area.top, true)
  view.setInt32(9, area.width, true)
  view.setInt32(13, area.height, true)
  let at = 0
  for (let cy = 0; cy < area.height; cy++) {
    for (let cx = 0; cx < area.width; cx++) {
      const chunk = getChunk(land, area.left + cx, area.top + cy)
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++, at++) {
        const index = i * TILE_BYTES
        const mountain = chunk[index] === Terrain.Mountain
        bytes[LAND_HEADER + at] = chunk[index]
        bytes[LAND_HEADER + tiles + at] = chunk[index + 1]
        bytes[LAND_HEADER + tiles * 2 + at] = mountain ? chunk[index + 2] : 0
        bytes[LAND_HEADER + tiles * 3 + at] = mountain ? chunk[index + 3] : chunk[index + 3] & ~DERIVED_BITS
      }
    }
  }
  return bytes
}

/** Местность из saveLand. Бросает ошибку, если байты не карта. */
export function loadLand(config: GeneratorConfig, bytes: Uint8Array): Land {
  if (bytes.length < LAND_HEADER || bytes[0] !== LAND_FORMAT) throw new Error('Карта мира не читается')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const area: LandArea = { left: view.getInt32(1, true), top: view.getInt32(5, true), width: view.getInt32(9, true), height: view.getInt32(13, true) }
  const tiles = area.width * area.height * CHUNK_SIZE * CHUNK_SIZE
  if (area.width <= 0 || area.height <= 0 || bytes.length !== LAND_HEADER + tiles * TILE_BYTES) throw new Error('Карта мира не читается')
  const land = createLand(config, area)
  let at = 0
  for (let n = 0; n < area.width * area.height; n++) {
    const chunk = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * TILE_BYTES)
    for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++, at++) {
      const index = i * TILE_BYTES
      chunk[index] = bytes[LAND_HEADER + at]
      chunk[index + 1] = bytes[LAND_HEADER + tiles + at]
      chunk[index + 2] = bytes[LAND_HEADER + tiles * 2 + at]
      chunk[index + 3] = bytes[LAND_HEADER + tiles * 3 + at]
    }
    land.owned[n] = chunk
  }
  for (let n = 0; n < area.width * area.height; n++) {
    deriveChunk(land, land.owned[n]!, area.left + (n % area.width), area.top + Math.floor(n / area.width))
  }
  return land
}
