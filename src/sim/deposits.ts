import type { Entity } from '../ecs'
import { hash, isBuildable, terrainAt, type Land } from '../map/terrain'
import { Deposit, Position } from './components'
import type { Sim } from './sim'

/** Сторона клетки в тайлах: в каждой клетке мира не больше одного месторождения. */
export const DEPOSIT_CELL = 40
/** Сторона месторождения в тайлах. Шахта встаёт ровно на него. */
export const DEPOSIT_SIZE = 2
/** В какой доле клеток месторождение есть. */
const DEPOSIT_CHANCE = 0.6
/** Запас руды в месторождении: от и до. */
const MIN_ORE = 4000
const MAX_ORE = 8000
/** Сколько мест в клетке пробуется, прежде чем решить, что скалы под месторождение в ней нет. */
const ATTEMPTS = 6
/** Сдвиг сида, чтобы месторождения не повторяли узор местности. */
const SALT = 17011

/** Месторождение: левый верхний тайл и запас руды, с которым оно появилось. */
export interface DepositSpot {
  x: number
  y: number
  ore: number
}

const cache = new WeakMap<Land, Map<string, DepositSpot | null>>()

/**
 * Месторождение клетки (cellX, cellY) или null. Как и местность, оно не хранится, а считается из сида:
 * в любой клетке мира ответ всегда один и тот же. Месторождение лежит на скале — там, где можно строить.
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
      spot = { x, y, ore: Math.round(MIN_ORE + hash(cellX, cellY, seed + 97) * (MAX_ORE - MIN_ORE)) }
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
 * Сущность, которая помнит, сколько руды из месторождения уже добыто. Появляется, только когда на месторождении
 * закладывают шахту: нетронутые месторождения в мире не хранятся.
 */
export function depositEntity(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position] of sim.world.query(Position, Deposit)) {
    if (position.x === x && position.y === y) return entity
  }
  return undefined
}

/** Сколько руды осталось в месторождении с левым верхним тайлом в (x, y). Где месторождения нет — ноль. */
export function oreLeft(sim: Sim, x: number, y: number) {
  const spot = depositAt(sim, x, y)
  if (!spot) return 0
  const entity = depositEntity(sim, x, y)
  return Math.max(0, spot.ore - (entity === undefined ? 0 : sim.world.get(entity, Deposit)!.mined))
}

/** Забирает из месторождения до amount руды. Возвращает, сколько удалось забрать. */
export function takeOre(sim: Sim, x: number, y: number, amount: number) {
  const taken = Math.min(amount, oreLeft(sim, x, y))
  if (taken <= 0) return 0
  let entity = depositEntity(sim, x, y)
  if (entity === undefined) entity = sim.world.spawn(Position({ x, y }), Deposit())
  sim.world.get(entity, Deposit)!.mined += taken
  return taken
}
