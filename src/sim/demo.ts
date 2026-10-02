import { BUILDING_TYPES, canPlace, placeBuilding, type BuildingType } from './buildings'
import type { Sim } from './sim'

/** Для пробы: разбрасывает вокруг точки несколько баз из случайных зданий, с зазорами между ними. */
export function placeDemoBuildings(sim: Sim, centerX: number, centerY: number) {
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
          if (!canPlace(sim, type, originX + dx, originY + dy, GAP)) continue
          placeBuilding(sim.world, type, originX + dx, originY + dy)
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
