import type { Entity, World } from '../ecs'
import { isBuildable, terrainAt } from '../map/terrain'
import { Building, Owner, Position, Producer, Site } from './components'
import type { Sim } from './sim'

/** Что симуляция знает о виде здания. Как оно выглядит, знает клиент: см. game/buildings/buildingArt.ts. */
export interface BuildingSpec {
  /** Сколько тайлов здание занимает на земле. */
  width: number
  height: number
  /** Цена в кредитах и время стройки в секундах, если строит один строитель. */
  cost: number
  buildTime: number
  /** Энергия: больше нуля — вырабатывает, меньше — потребляет. */
  power?: number
  /** Доход в кредитах в секунду. У потребителя энергии он падает вместе с её нехваткой. */
  income?: number
  /**
   * Таким зданиям тесно в одной зоне: каждое следующее просит на одну норму энергии больше предыдущего.
   * Поэтому отдача от них падает, и ставить их без счёта невыгодно.
   */
  crowding?: boolean
}

export const BUILDINGS = {
  // Доход главного здания не даёт остаться без кредитов совсем: на генератор он копит долго, но копит.
  command: { width: 3, height: 3, cost: 2000, buildTime: 30, income: 0.2 },
  refinery: { width: 3, height: 2, cost: 600, buildTime: 25 },
  factory: { width: 2, height: 2, cost: 500, buildTime: 20 },
  // Электростанция.
  generator: { width: 2, height: 2, cost: 300, buildTime: 15, power: 10 },
  // Генератор материи — базовый доход: превращает энергию в кредиты.
  matter: { width: 2, height: 3, cost: 400, buildTime: 20, power: -5, income: 1, crowding: true },
  radar: { width: 2, height: 2, cost: 400, buildTime: 15 },
  windtrap: { width: 2, height: 2, cost: 300, buildTime: 15 },
  barracks: { width: 2, height: 2, cost: 300, buildTime: 15 },
  silo: { width: 2, height: 1, cost: 150, buildTime: 8 },
  turret: { width: 1, height: 1, cost: 250, buildTime: 10 },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
/** Главное здание — Settlement Core: в него разворачивается MCV. */
export const CORE: BuildingType = 'command'
export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[]
/** Что возводят строители. Остальные здания появятся вместе с тем, для чего они нужны. */
export const BUILDABLE: BuildingType[] = ['generator', 'matter', 'silo']

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

/** Площадка, основание которой накрывает тайл (x, y), или undefined. Площадок мало, поэтому простой перебор. */
export function siteAt(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position, site] of sim.world.query(Position, Site)) {
    const { width, height } = BUILDINGS[site.type]
    if (x >= position.x && x < position.x + width && y >= position.y && y < position.y + height) return entity
  }
  return undefined
}

/**
 * Можно ли поставить здание левым верхним углом основания в тайл (x, y): основание целиком на скале,
 * внутри границ карты и не задевает другие здания и площадки. gap — зазор до соседних зданий в тайлах.
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
  // Площадка, которую ещё не начали строить, тайлов не занимает, но место за ней уже закреплено.
  for (const [, position, site] of sim.world.query(Position, Site)) {
    const other = BUILDINGS[site.type]
    if (x - gap < position.x + other.width && x + width + gap > position.x) {
      if (y - gap < position.y + other.height && y + height + gap > position.y) return false
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
