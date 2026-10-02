import type { Entity, World } from '../ecs'
import { isBuildable, terrainAt } from '../map/terrain'
import { Building, Owner, Position, Producer } from './components'
import type { Sim } from './sim'

/** Что симуляция знает о виде здания. Как оно выглядит, знает клиент: см. game/buildings/buildingArt.ts. */
export interface BuildingSpec {
  /** Сколько тайлов здание занимает на земле. */
  width: number
  height: number
}

export const BUILDINGS = {
  command: { width: 3, height: 3 },
  refinery: { width: 3, height: 2 },
  factory: { width: 2, height: 2 },
  generator: { width: 2, height: 2 },
  starport: { width: 2, height: 3 },
  radar: { width: 2, height: 2 },
  windtrap: { width: 2, height: 2 },
  barracks: { width: 2, height: 2 },
  silo: { width: 2, height: 1 },
  turret: { width: 1, height: 1 },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
/** Главное здание — Settlement Core: в него разворачивается MCV. */
export const CORE: BuildingType = 'command'
export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[]

/** Какие тайлы заняты зданиями. Обновляется сам: следит за появлением и исчезновением зданий в мире. */
export interface Occupancy {
  /** Здание, занимающее тайл, или undefined. */
  at(x: number, y: number): Entity | undefined
  destroy(): void
}

export function createOccupancy(world: World): Occupancy {
  const tiles = new Map<string, Entity>()
  const stop = world.observe([Position, Building], (entity, position, building) => {
    const { width, height } = BUILDINGS[building.type]
    const keys: string[] = []
    for (let y = position.y; y < position.y + height; y++) {
      for (let x = position.x; x < position.x + width; x++) keys.push(`${x},${y}`)
    }
    for (const key of keys) tiles.set(key, entity)
    return () => {
      for (const key of keys) if (tiles.get(key) === entity) tiles.delete(key)
    }
  })
  return {
    at: (x, y) => tiles.get(`${x},${y}`),
    destroy: stop,
  }
}

/**
 * Можно ли поставить здание левым верхним углом основания в тайл (x, y): основание целиком на скале,
 * внутри границ карты и не задевает другие здания. gap — зазор до соседних зданий в тайлах.
 */
export function canPlace(sim: Sim, type: BuildingType, x: number, y: number, gap = 0) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  const { width, height } = BUILDINGS[type]
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) return false
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      if (!isBuildable(terrainAt(sim.land, tileX, tileY))) return false
    }
  }
  for (let tileY = y - gap; tileY < y + height + gap; tileY++) {
    for (let tileX = x - gap; tileX < x + width + gap; tileX++) {
      if (sim.occupancy.at(tileX, tileY) !== undefined) return false
    }
  }
  return true
}

/** Ставит здание без проверок. player — владелец; 0 — ничьё. */
export function placeBuilding(world: World, type: BuildingType, x: number, y: number, player = 0) {
  const entity = world.spawn(Position({ x, y }), Building({ type, phase: world.count(Building) * 5 }), Owner({ player }))
  if (type === CORE && player) world.add(entity, Producer)
  return entity
}
