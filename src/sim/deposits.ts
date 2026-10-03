import type { Entity } from '../ecs'
import { Biome, biomeAt, hash, isBuildable, terrainAt, type Land } from '../map/terrain'
import { Deposit, Position } from './components'
import type { Resource } from './resources'
import type { Sim } from './sim'

/** Сторона клетки в тайлах: в каждой клетке мира не больше одного месторождения. */
export const DEPOSIT_CELL = 40
/** Сторона месторождения в тайлах. Шахта встаёт ровно на него. */
export const DEPOSIT_SIZE = 2
/** В какой доле клеток месторождение есть. */
const DEPOSIT_CHANCE = 0.6

/**
 * Виды месторождений: запас (от min до max) и сколько в секунду из него добывает шахта.
 * Харит редок и дорог: запас мал, а добыча медленная.
 */
export const DEPOSIT_KINDS = {
  metal: { min: 4000, max: 8000, rate: 0.5 },
  silicon: { min: 4000, max: 8000, rate: 0.5 },
  fuel: { min: 3000, max: 6000, rate: 0.4 },
  kharite: { min: 600, max: 1200, rate: 0.15 },
} satisfies Partial<Record<Resource, { min: number; max: number; rate: number }>>

export type DepositKind = keyof typeof DEPOSIT_KINDS
export const DEPOSIT_TYPES = Object.keys(DEPOSIT_KINDS) as DepositKind[]

/**
 * Что чаще лежит в каком биоме: доли видов месторождений. География решает, чего игроку не хватает: в красных
 * пустошах много металла и харита, в эрге и солончаках — кремния, топливо — в топях.
 */
const BIOME_KINDS: Record<Biome, Record<DepositKind, number>> = {
  [Biome.Erg]: { metal: 0.35, silicon: 0.4, fuel: 0.15, kharite: 0.1 },
  [Biome.SaltFlats]: { metal: 0.3, silicon: 0.45, fuel: 0.15, kharite: 0.1 },
  [Biome.RedWastes]: { metal: 0.6, silicon: 0.1, fuel: 0.1, kharite: 0.2 },
  [Biome.Marsh]: { metal: 0.25, silicon: 0.1, fuel: 0.6, kharite: 0.05 },
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

const cache = new WeakMap<Land, Map<string, DepositSpot | null>>()

/**
 * Месторождение клетки (cellX, cellY) или null. Как и местность, оно не хранится, а считается из сида:
 * в любой клетке мира ответ всегда один и тот же. Месторождение лежит на скале — там, где можно строить; что в нём, решает биом.
 */
export function depositIn(sim: Sim, cellX: number, cellY: number): DepositSpot | null {
  const { land, bounds } = sim
  let cells = cache.get(land)
  if (!cells) cache.set(land, (cells = new Map()))
  const key = `${cellX},${cellY}`
  const known = cells.get(key)
  if (known !== undefined) return known

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
          if (!isBuildable(terrainAt(land, tileX, tileY))) continue search
        }
      }
      const kind = kindIn(biomeAt(land, x, y), hash(cellX, cellY, seed + 53))
      const { min, max } = DEPOSIT_KINDS[kind]
      spot = { x, y, kind, reserve: Math.round(min + hash(cellX, cellY, seed + 97) * (max - min)) }
      break
    }
  }
  cells.set(key, spot)
  return spot
}

/** Месторождение с левым верхним тайлом ровно в (x, y) или null. */
export function depositAt(sim: Sim, x: number, y: number): DepositSpot | null {
  const spot = depositIn(sim, Math.floor(x / DEPOSIT_CELL), Math.floor(y / DEPOSIT_CELL))
  return spot && spot.x === x && spot.y === y ? spot : null
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
      const spot = depositIn(sim, cellX, cellY)
      if (!spot) continue
      const distance = Math.hypot(spot.x + DEPOSIT_SIZE / 2 - x, spot.y + DEPOSIT_SIZE / 2 - y)
      if (distance <= bestDistance) {
        best = spot
        bestDistance = distance
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
