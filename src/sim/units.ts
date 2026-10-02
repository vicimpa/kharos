import type { Entity } from '../ecs'
import { isPassable, terrainAt } from '../map/terrain'
import { Owner, Path, Position, Unit } from './components'
import { findPath, smoothPath } from './path'
import type { Sim } from './sim'

/** Что симуляция знает о виде юнита. Как он выглядит, знает клиент: см. game/units/unitArt.ts. */
export interface UnitSpec {
  /** Скорость в тайлах в секунду. */
  speed: number
  /** Радиус в тайлах: по нему юнит выбирается мышью. */
  radius: number
}

export const UNITS = {
  mcv: { speed: 2.5, radius: 0.8 },
  builder: { speed: 4, radius: 0.45 },
  infantry: { speed: 3, radius: 0.3 },
} satisfies Record<string, UnitSpec>

export type UnitType = keyof typeof UNITS
export const UNIT_TYPES = Object.keys(UNITS) as UnitType[]

/** С чем игрок появляется в мире. */
const STARTING_UNITS: UnitType[] = ['mcv', 'builder', 'builder', 'infantry', 'infantry', 'infantry']

/** Может ли наземный юнит находиться в тайле: внутри карты, на песке или скале, не в здании. */
export function isWalkable(sim: Sim, x: number, y: number) {
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom) return false
  return isPassable(terrainAt(sim.land, x, y)) && sim.occupancy.at(x, y) === undefined
}

/** Шаг между местами юнитов в группе, в тайлах: крупные машины не помещаются в один тайл. */
const GROUP_SPACING = 2

/**
 * Проходимые тайлы вокруг точки, от ближних к дальним: места для группы юнитов, через GROUP_SPACING тайлов.
 * Возвращает не больше count тайлов (x, y подряд); если рядом их меньше — сколько нашлось.
 */
export function freeTilesNear(sim: Sim, x: number, y: number, count: number) {
  const SEARCH_RADIUS = 8
  const tiles: number[] = []
  for (let radius = 0; radius <= SEARCH_RADIUS && tiles.length < count * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Только кольцо на расстоянии radius: внутренние тайлы уже проверены.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const tileX = x + dx * GROUP_SPACING
        const tileY = y + dy * GROUP_SPACING
        if (tiles.length < count * 2 && isWalkable(sim, tileX, tileY)) tiles.push(tileX, tileY)
      }
    }
  }
  return tiles
}

/** Создаёт юнит в центре тайла (x, y). */
export function spawnUnit(sim: Sim, type: UnitType, player: number, x: number, y: number) {
  const position = { x: x + 0.5, y: y + 0.5 }
  return sim.world.spawn(Position(position), Unit({ type, prevX: position.x, prevY: position.y }), Owner({ player }))
}

/** Стартовый набор игрока вокруг тайла (x, y). Возвращает созданных юнитов; их меньше, если места не хватило. */
export function spawnStartingUnits(sim: Sim, player: number, x: number, y: number) {
  const tiles = freeTilesNear(sim, x, y, STARTING_UNITS.length)
  const units: Entity[] = []
  for (let i = 0; i < STARTING_UNITS.length && i * 2 < tiles.length; i++) {
    units.push(spawnUnit(sim, STARTING_UNITS[i], player, tiles[i * 2], tiles[i * 2 + 1]))
  }
  return units
}

/**
 * Отправляет юнит в тайл (x, y): прокладывает путь и кладёт его в компонент Path.
 * Если идти некуда, юнит остаётся на месте.
 */
export function orderMove(sim: Sim, entity: Entity, x: number, y: number) {
  const position = sim.world.get(entity, Position)
  if (!position) return
  const walkable = (tileX: number, tileY: number) => isWalkable(sim, tileX, tileY)
  const tiles = findPath(walkable, Math.floor(position.x), Math.floor(position.y), x, y)
  // Юнит идёт по центрам тайлов.
  const points = smoothPath(
    walkable,
    position.x,
    position.y,
    tiles.map((value) => value + 0.5),
  )
  if (points.length) sim.world.add(entity, Path({ points, goalX: x, goalY: y }))
  else sim.world.remove(entity, Path)
}

/** Отправляет группу к тайлу (x, y): каждому юниту достаётся свой тайл рядом с целью. */
export function orderGroupMove(sim: Sim, units: Entity[], x: number, y: number) {
  const tiles = freeTilesNear(sim, x, y, units.length)
  if (!tiles.length) return
  units.forEach((entity, i) => {
    // Мест может оказаться меньше, чем юнитов; тогда лишние идут в последнее.
    const at = Math.min(i * 2, tiles.length - 2)
    orderMove(sim, entity, tiles[at], tiles[at + 1])
  })
}
