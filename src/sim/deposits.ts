import type { Entity } from '../ecs'
import { Biome, biomeAt, hash, isBuildable, isCliffFoot, terrainAt, tileKey } from '../map/terrain'
import { Deposit, Position } from './components'
import type { Resource } from './resources'
import type { Sim } from './sim'

/** Сторона клетки в тайлах: в каждой клетке мира не больше одного месторождения. */
export const DEPOSIT_CELL = 40
/** Сторона месторождения в тайлах. Шахта встаёт ровно на него. */
export const DEPOSIT_SIZE = 2
/** В какой доле клеток месторождение есть. Выше — плотнее карта: в круге 150 тайлов хватает месторождений на все виды. */
const DEPOSIT_CHANCE = 0.85

/**
 * Виды месторождений: запас (от min до max) и сколько в секунду из него добывает шахта.
 * Одна шахта с одним грузовиком должна приносить заметный доход, поэтому копают быстро.
 * Запас конечный (§4.3 шаг 4): металла хватает на 20–40 минут работы шахты, поэтому за новыми месторождениями
 * приходится идти на чужую землю, а не сидеть на одном. Харит редок и дорог: запас мал, добыча медленная.
 */
export const DEPOSIT_KINDS = {
  metal: { min: 1200, max: 2500, rate: 1 },
  silicon: { min: 1200, max: 2500, rate: 1 },
  fuel: { min: 800, max: 1600, rate: 0.8 },
  kharite: { min: 200, max: 400, rate: 0.3 },
} satisfies Partial<Record<Resource, { min: number; max: number; rate: number }>>

export type DepositKind = keyof typeof DEPOSIT_KINDS
export const DEPOSIT_TYPES = Object.keys(DEPOSIT_KINDS) as DepositKind[]

/**
 * Что чаще лежит в каком биоме: доли видов месторождений. Все четыре вида есть в каждом биоме — биомы
 * регулируют только количество, иначе случайный спавн оставил бы базу без топлива или харита (вопрос 14 §6).
 * Металл — самый частый вид везде: техника, стройблоки и патроны просят его втрое больше, чем кремния.
 * Пустоши богаче всех металлом и харитом, топи — топливом, солончаки — кремнием, но и там металла не меньше.
 * Харит редок запасом и скоростью добычи, а не отсутствием: спорный приз — богатое месторождение, а не сам вид.
 */
const BIOME_KINDS: Record<Biome, Record<DepositKind, number>> = {
  [Biome.Erg]: { metal: 0.41, silicon: 0.24, fuel: 0.2, kharite: 0.15 },
  [Biome.SaltFlats]: { metal: 0.35, silicon: 0.34, fuel: 0.16, kharite: 0.15 },
  [Biome.RedWastes]: { metal: 0.46, silicon: 0.18, fuel: 0.15, kharite: 0.21 },
  [Biome.Marsh]: { metal: 0.34, silicon: 0.18, fuel: 0.32, kharite: 0.16 },
}

/** Вид месторождения по биому и случайному числу от 0 до 1. */
function kindIn(biome: Biome, pick: number): DepositKind {
  const shares = BIOME_KINDS[biome] ?? BIOME_KINDS[Biome.Erg]
  for (const kind of DEPOSIT_TYPES) {
    pick -= shares[kind]
    if (pick < 0) return kind
  }
  return 'metal'
}
/** Сколько мест в клетке пробуется, прежде чем решить, что скалы под месторождение в ней нет. */
const ATTEMPTS = 6
/** Сдвиг сида, чтобы месторождения не повторяли узор местности. */
const SALT = 17011

/** Месторождение: левый верхний тайл, что в нём лежит и какой запас был изначально. */
export interface DepositSpot {
  x: number
  y: number
  kind: DepositKind
  reserve: number
}

/**
 * Слой месторождений карты. Клетку генератор считает один раз — при первом обращении к ней или перед первой правкой
 * земли рядом (см. prepareDeposits), — и дальше она хранится: правки карты месторождения не создают и не двигают, а
 * правки редактора меняют сам слой. В сохранение слой ложится целиком, см. saveDeposits.
 */
export interface DepositLayer {
  /** Месторождения взятых клеток по ключу клетки tileKey(cellX, cellY), левым верхним тайлом в клетке. */
  cells: Map<number, DepositSpot[]>
  /** Слой полный: клетки, которой в нём нет, генератор не считает — она пуста. Так у клиента: слой шлёт хост. */
  complete: boolean
  /** Номер правки: растёт с каждой. По нему хост узнаёт, что слой пора разослать заново. */
  revision: number
}

/** Слой в сохранении: взятые клетки — cellX, cellY подряд; месторождения — x, y, номер вида в DEPOSIT_TYPES и запас подряд. */
export interface DepositsSave {
  cells: number[]
  spots: number[]
}

export function createDeposits(save?: DepositsSave, complete = false): DepositLayer {
  const layer: DepositLayer = { cells: new Map(), complete, revision: 0 }
  if (save) loadDeposits(layer, save)
  return layer
}

/** Заменяет слой сохранённым. */
export function loadDeposits(layer: DepositLayer, save: DepositsSave) {
  layer.cells.clear()
  for (let i = 0; i + 1 < save.cells.length; i += 2) layer.cells.set(tileKey(save.cells[i], save.cells[i + 1]), [])
  for (let i = 0; i + 3 < save.spots.length; i += 4) {
    const [x, y, kind, reserve] = save.spots.slice(i, i + 4)
    const key = cellOf(x, y)
    if (!layer.cells.has(key)) layer.cells.set(key, [])
    layer.cells.get(key)!.push({ x, y, kind: DEPOSIT_TYPES[kind] ?? 'metal', reserve })
  }
  layer.revision++
}

export function saveDeposits(layer: DepositLayer): DepositsSave {
  const cells: number[] = []
  const spots: number[] = []
  for (const [key, list] of layer.cells) {
    const { x, y } = keyCell(key)
    cells.push(x, y)
    for (const spot of list) spots.push(spot.x, spot.y, DEPOSIT_TYPES.indexOf(spot.kind), spot.reserve)
  }
  return { cells, spots }
}

/** Ключ клетки, в которой лежит тайл (x, y). */
const cellOf = (x: number, y: number) => tileKey(Math.floor(x / DEPOSIT_CELL), Math.floor(y / DEPOSIT_CELL))
/** Клетка по ключу tileKey. */
const keyCell = (key: number) => ({ x: (key % 65536) - 32768, y: Math.floor(key / 65536) - 32768 })

/**
 * Месторождение клетки (cellX, cellY) или null: первое из её месторождений — то, что положил генератор, если его не
 * убрали. Все месторождения клетки — depositsIn.
 */
export function depositIn(sim: Sim, cellX: number, cellY: number): DepositSpot | null {
  return depositsIn(sim, cellX, cellY)[0] ?? null
}

/**
 * Месторождения клетки (cellX, cellY), левым верхним тайлом в ней. Генератор кладёт в клетку не больше одного, на
 * скалу — туда, где можно строить; что в нём, решает биом. Редактор может убрать, поменять и положить ещё.
 */
export function depositsIn(sim: Sim, cellX: number, cellY: number): DepositSpot[] {
  const layer = sim.deposits
  const key = tileKey(cellX, cellY)
  let spots = layer.cells.get(key)
  if (spots) return spots
  if (layer.complete) return []
  const generated = generatedIn(sim, cellX, cellY)
  spots = generated ? [generated] : []
  layer.cells.set(key, spots)
  return spots
}

/**
 * Берёт у генератора клетки с месторождениями, которые зависят от тайлов прямоугольника: перед правкой земли в нём,
 * чтобы генератор считал их по прежней карте. С запасом в тайл: подножие обрыва зависит от соседей.
 */
export function prepareDeposits(sim: Sim, left: number, top: number, right: number, bottom: number) {
  for (let cellY = Math.floor((top - 1) / DEPOSIT_CELL); cellY <= Math.floor((bottom + 1) / DEPOSIT_CELL); cellY++) {
    for (let cellX = Math.floor((left - 1) / DEPOSIT_CELL); cellX <= Math.floor((right + 1) / DEPOSIT_CELL); cellX++) depositsIn(sim, cellX, cellY)
  }
}

/** Берёт у генератора все клетки карты: слой становится полным, и его можно отдать клиенту. */
export function fillDeposits(sim: Sim) {
  const { left, top, right, bottom } = sim.bounds
  prepareDeposits(sim, left + 1, top + 1, right - 2, bottom - 2)
}

/** Кладёт месторождение в слой. */
export function addDeposit(sim: Sim, spot: DepositSpot) {
  depositsIn(sim, Math.floor(spot.x / DEPOSIT_CELL), Math.floor(spot.y / DEPOSIT_CELL)).push({ ...spot })
  sim.deposits.revision++
}

/** Убирает из слоя месторождение с левым верхним тайлом (x, y) и забывает, сколько из него добыли. */
export function dropDeposit(sim: Sim, x: number, y: number) {
  const spots = depositsIn(sim, Math.floor(x / DEPOSIT_CELL), Math.floor(y / DEPOSIT_CELL))
  const at = spots.findIndex((spot) => spot.x === x && spot.y === y)
  if (at < 0) return
  spots.splice(at, 1)
  const mined = depositEntity(sim, x, y)
  if (mined !== undefined) sim.world.destroy(mined)
  sim.deposits.revision++
}

/**
 * Правки месторождений из прежних сохранений: тогда они лежали в сущностях Deposit (kind, reserve, gone). Переносит их
 * в слой; сущности остаются со своим mined.
 */
export function adoptLegacyDeposits(sim: Sim) {
  type Legacy = { mined: number; kind?: DepositKind | ''; reserve?: number; gone?: boolean }
  const edits: (Legacy & { x: number; y: number })[] = []
  for (const [, position, deposit] of sim.world.query(Position, Deposit)) {
    const old = deposit as Legacy
    if (old.kind || old.gone || (old.reserve ?? -1) >= 0) edits.push({ x: position.x, y: position.y, ...old })
    delete old.kind
    delete old.reserve
    delete old.gone
  }
  for (const { x, y, kind, reserve = -1, gone } of edits) {
    const spots = depositsIn(sim, Math.floor(x / DEPOSIT_CELL), Math.floor(y / DEPOSIT_CELL))
    const at = spots.findIndex((spot) => spot.x === x && spot.y === y)
    if (gone) {
      if (at >= 0) spots.splice(at, 1)
    } else if (at >= 0) {
      if (kind) spots[at].kind = kind
      if (reserve >= 0) spots[at].reserve = reserve
    } else if (kind) spots.push({ x, y, kind, reserve: Math.max(0, reserve) })
  }
}

/** Месторождение, которое генератор кладёт в клетку, без правок. */
function generatedIn(sim: Sim, cellX: number, cellY: number): DepositSpot | null {
  const { land, bounds } = sim

  const seed = land.config.seed + SALT
  let spot: DepositSpot | null = null
  if (hash(cellX, cellY, seed) < (land.config.depositChance ?? DEPOSIT_CHANCE)) {
    const room = DEPOSIT_CELL - DEPOSIT_SIZE
    search: for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const x = cellX * DEPOSIT_CELL + Math.floor(hash(cellX, cellY, seed + 1 + attempt * 2) * room)
      const y = cellY * DEPOSIT_CELL + Math.floor(hash(cellX, cellY, seed + 2 + attempt * 2) * room)
      if (x < bounds.left || y < bounds.top || x + DEPOSIT_SIZE > bounds.right || y + DEPOSIT_SIZE > bounds.bottom) continue
      for (let tileY = y; tileY < y + DEPOSIT_SIZE; tileY++) {
        for (let tileX = x; tileX < x + DEPOSIT_SIZE; tileX++) {
          // Шахта встаёт на месторождение: тайлы те же, что годятся под здание, — скала не у подножия обрыва.
          if (!isBuildable(terrainAt(land, tileX, tileY)) || isCliffFoot(land, tileX, tileY)) continue search
        }
      }
      const kind = kindIn(biomeAt(land, x, y), hash(cellX, cellY, seed + 53))
      const { min, max } = DEPOSIT_KINDS[kind]
      const richness = land.config.depositRichness ?? 1
      spot = { x, y, kind, reserve: Math.round((min + hash(cellX, cellY, seed + 97) * (max - min)) * richness) }
      break
    }
  }
  return spot
}

/** Месторождение с левым верхним тайлом ровно в (x, y) или null. */
export function depositAt(sim: Sim, x: number, y: number): DepositSpot | null {
  return depositsIn(sim, Math.floor(x / DEPOSIT_CELL), Math.floor(y / DEPOSIT_CELL)).find((spot) => spot.x === x && spot.y === y) ?? null
}

/** Ближайшее к точке месторождение не дальше reach тайлов (от точки до его центра) или null. */
export function depositNear(sim: Sim, x: number, y: number, reach: number): DepositSpot | null {
  let best: DepositSpot | null = null
  let bestDistance = reach
  const from = Math.floor((x - reach - DEPOSIT_SIZE) / DEPOSIT_CELL)
  const to = Math.floor((x + reach) / DEPOSIT_CELL)
  const top = Math.floor((y - reach - DEPOSIT_SIZE) / DEPOSIT_CELL)
  const bottom = Math.floor((y + reach) / DEPOSIT_CELL)
  for (let cellY = top; cellY <= bottom; cellY++) {
    for (let cellX = from; cellX <= to; cellX++) {
      for (const spot of depositsIn(sim, cellX, cellY)) {
        const distance = Math.hypot(spot.x + DEPOSIT_SIZE / 2 - x, spot.y + DEPOSIT_SIZE / 2 - y)
        if (distance <= bestDistance) {
          best = spot
          bestDistance = distance
        }
      }
    }
  }
  return best
}

/**
 * Сущность, которая помнит, сколько из месторождения уже добыто. Появляется, только когда на месторождении
 * закладывают шахту: нетронутые месторождения в мире не хранятся.
 */
export function depositEntity(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position] of sim.world.query(Position, Deposit)) {
    if (position.x === x && position.y === y) return entity
  }
  return undefined
}

/** Сколько осталось в месторождении с левым верхним тайлом в (x, y). Где месторождения нет — ноль. */
export function reserveLeft(sim: Sim, x: number, y: number) {
  const spot = depositAt(sim, x, y)
  if (!spot) return 0
  const entity = depositEntity(sim, x, y)
  return Math.max(0, spot.reserve - (entity === undefined ? 0 : sim.world.get(entity, Deposit)!.mined))
}

/** Забирает из месторождения до amount. Возвращает, сколько удалось забрать. */
export function takeReserve(sim: Sim, x: number, y: number, amount: number) {
  const taken = Math.min(amount, reserveLeft(sim, x, y))
  if (taken <= 0) return 0
  let entity = depositEntity(sim, x, y)
  if (entity === undefined) entity = sim.world.spawn(Position({ x, y }), Deposit())
  sim.world.get(entity, Deposit)!.mined += taken
  return taken
}
