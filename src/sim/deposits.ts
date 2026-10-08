import type { Entity } from '../ecs'
import { Biome, biomeAt, hash, isBuildable, isCliffFoot, terrainAt, type Land } from '../map/terrain'
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

/** Посчитанные месторождения клеток. count — сколько было сущностей Deposit: появилась новая — правки могли измениться. */
const cache = new WeakMap<Land, { count: number; cells: Map<string, DepositSpot[]> }>()

/** Забывает посчитанные месторождения: после правки карты или месторождений в редакторе. */
export function forgetDeposits(sim: Sim) {
  cache.delete(sim.land)
}

/**
 * Месторождение клетки (cellX, cellY) или null: то, что положил генератор, а если его нет — первое положенное
 * редактором. Все месторождения клетки — depositsIn.
 */
export function depositIn(sim: Sim, cellX: number, cellY: number): DepositSpot | null {
  return depositsIn(sim, cellX, cellY)[0] ?? null
}

/**
 * Месторождения клетки (cellX, cellY), левым верхним тайлом в ней. Как и местность, они не хранятся, а считаются из
 * сида: генератор кладёт в клетку не больше одного, на скалу — туда, где можно строить; что в нём, решает биом.
 * Поверх — правки редактора, см. компонент Deposit: он может убрать и поменять это месторождение и положить ещё.
 * Месторождение генератора — первым.
 */
export function depositsIn(sim: Sim, cellX: number, cellY: number): DepositSpot[] {
  const { land, world } = sim
  const count = world.count(Deposit)
  let cached = cache.get(land)
  if (!cached || cached.count !== count) cache.set(land, (cached = { count, cells: new Map() }))
  const { cells } = cached
  const key = `${cellX},${cellY}`
  const known = cells.get(key)
  if (known !== undefined) return known
  const spots = withEdits(sim, cellX, cellY, generatedIn(sim, cellX, cellY))
  cells.set(key, spots)
  return spots
}

/** Правки редактора в клетке поверх месторождения генератора: см. компонент Deposit. */
function withEdits(sim: Sim, cellX: number, cellY: number, generated: DepositSpot | null): DepositSpot[] {
  let spot = generated
  const added: DepositSpot[] = []
  for (const [, position, deposit] of sim.world.query(Position, Deposit)) {
    if (Math.floor(position.x / DEPOSIT_CELL) !== cellX || Math.floor(position.y / DEPOSIT_CELL) !== cellY) continue
    if (generated && position.x === generated.x && position.y === generated.y) {
      if (deposit.gone) spot = null
      else spot = { ...generated, ...(deposit.kind && { kind: deposit.kind }), ...(deposit.reserve >= 0 && { reserve: deposit.reserve }) }
    } else if (deposit.kind && !deposit.gone) added.push({ x: position.x, y: position.y, kind: deposit.kind, reserve: Math.max(0, deposit.reserve) })
  }
  // Порядок положенных — по месту: не зависит от порядка сущностей.
  added.sort((a, b) => a.y - b.y || a.x - b.x)
  return spot ? [spot, ...added] : added
}

/** Месторождение, которое генератор кладёт в клетку, без правок. */
function generatedIn(sim: Sim, cellX: number, cellY: number): DepositSpot | null {
  const { land, bounds } = sim

  const seed = land.config.seed + SALT
  let spot: DepositSpot | null = null
  if (hash(cellX, cellY, seed) < DEPOSIT_CHANCE) {
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
      spot = { x, y, kind, reserve: Math.round(min + hash(cellX, cellY, seed + 97) * (max - min)) }
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
