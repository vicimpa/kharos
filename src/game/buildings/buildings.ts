import type { Entity, World } from '../../ecs'
import { isBuildable, terrainAt } from '../../map/terrain'
import { Building, Position } from '../components'
import type { Scene } from '../scene'
import { BUILDING_ART, BUILDING_TYPES, type BuildingType } from './buildingArt'

/** Какие тайлы заняты зданиями. Обновляется сам: следит за появлением и исчезновением зданий в мире. */
export interface Occupancy {
  /** Здание, занимающее тайл, или undefined. */
  at(x: number, y: number): Entity | undefined
  destroy(): void
}

export function createOccupancy(world: World): Occupancy {
  const tiles = new Map<string, Entity>()
  const stop = world.observe([Position, Building], (entity, position, building) => {
    const { width, height } = BUILDING_ART[building.type]
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

/** Можно ли поставить здание левым верхним углом основания в тайл (x, y). gap — зазор до соседних зданий в тайлах. */
export function canPlace(scene: Scene, type: BuildingType, x: number, y: number, gap = 0) {
  const { width, height } = BUILDING_ART[type]
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      if (!isBuildable(terrainAt(scene.land, tileX, tileY))) return false
    }
  }
  for (let tileY = y - gap; tileY < y + height + gap; tileY++) {
    for (let tileX = x - gap; tileX < x + width + gap; tileX++) {
      if (scene.occupancy.at(tileX, tileY) !== undefined) return false
    }
  }
  return true
}

export function placeBuilding(world: World, type: BuildingType, x: number, y: number) {
  return world.spawn(Position({ x, y }), Building({ type, phase: world.count(Building) * 5 }))
}

/** Для пробы: разбрасывает вокруг точки несколько баз из случайных зданий, с зазорами между ними. */
export function placeDemoBuildings(scene: Scene, centerX: number, centerY: number) {
  /** Базы стоят по сетке с таким шагом в тайлах, по BASES_AROUND в каждую сторону от точки. */
  const BASE_STEP = 40
  const BASES_AROUND = 4
  /** Насколько здания разбросаны вокруг центра базы и какой зазор держат. */
  const SPREAD = 9
  const GAP = 2
  const SEARCH_RADIUS = 10

  // Свой генератор, чтобы расстановка не менялась от запуска к запуску.
  let seed = 20240
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))

  /** Ставит здание как можно ближе к точке; перебор кольцами. */
  const placeNear = (type: BuildingType, originX: number, originY: number) => {
    for (let radius = 0; radius <= SEARCH_RADIUS; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          // Только кольцо на расстоянии radius: внутренние тайлы уже проверены.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
          if (!canPlace(scene, type, originX + dx, originY + dy, GAP)) continue
          placeBuilding(scene.world, type, originX + dx, originY + dy)
          return true
        }
      }
    }
    return false
  }

  for (let row = -BASES_AROUND; row <= BASES_AROUND; row++) {
    for (let column = -BASES_AROUND; column <= BASES_AROUND; column++) {
      const baseX = Math.floor(centerX) + column * BASE_STEP + between(-8, 8)
      const baseY = Math.floor(centerY) + row * BASE_STEP + between(-8, 8)
      // База начинается со штаба; если ему негде встать, здесь не скала — пропускаем.
      if (!placeNear('command', baseX, baseY)) continue
      const count = between(5, 10)
      for (let i = 0; i < count; i++) {
        const type = BUILDING_TYPES[between(1, BUILDING_TYPES.length - 1)]
        placeNear(type, baseX + between(-SPREAD, SPREAD), baseY + between(-SPREAD, SPREAD))
      }
    }
  }
}
