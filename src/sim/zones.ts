import type { Entity } from '../ecs'
import { BUILDINGS, CORE } from './buildings'
import { Building, Owner, Position, Site } from './components'
import type { Sim } from './sim'

/** Радиус зоны строительства вокруг главного здания, в тайлах от его центра. */
export const CONTROL_RADIUS = 12
/** На сколько тайлов от своего центра расширяет зону любое другое готовое здание. */
export const EXPAND_RADIUS = 5

/** Попадает ли точка хотя бы в один круг. circles — x, y и радиус подряд. */
export function inCircles(circles: readonly number[], x: number, y: number) {
  for (let i = 0; i < circles.length; i += 3) {
    if (Math.hypot(x - circles[i], y - circles[i + 1]) <= circles[i + 2]) return true
  }
  return false
}

/** Зона строительства: главное здание и всё, что к нему пристроено. */
export interface Zone {
  /** Круги, из которых зона состоит: x, y и радиус подряд. */
  circles: number[]
  /** Готовые здания зоны, начиная с главного. */
  buildings: Entity[]
}

/**
 * Зоны строительства всех игроков. Зону задаёт главное здание, а расширяют готовые здания, стоящие в ней:
 * каждое добавляет свой круг, и по цепочке зона растёт дальше. Здание, до которого цепочка от главного
 * не дотягивается, ни в какую зону не входит. Нет главного здания — нет и зоны.
 * Два главных здания дают две зоны; если второе стоит внутри зоны первого, зона у них общая.
 */
export function allZones(sim: Sim): Map<number, Zone[]> {
  /** Готовые здания игрока, ещё не попавшие в зону: сущность, x, y центра и радиус круга подряд. */
  const waiting = new Map<number, number[]>()
  const cores = new Map<number, number[]>()
  for (const [entity, position, building, owner] of sim.world.query(Position, Building, Owner)) {
    if (sim.world.has(entity, Site)) continue
    const { width, height } = BUILDINGS[building.type]
    const core = building.type === CORE
    const target = core ? cores : waiting
    let list = target.get(owner.player)
    if (!list) target.set(owner.player, (list = []))
    list.push(entity, position.x + width / 2, position.y + height / 2, core ? CONTROL_RADIUS : EXPAND_RADIUS)
  }

  const result = new Map<number, Zone[]>()
  for (const [player, roots] of cores) {
    const zones: Zone[] = []
    // Главные здания тоже ждут очереди: то, что стоит внутри уже выросшей зоны, свою не начинает.
    let rest = [...roots, ...(waiting.get(player) ?? [])]
    for (let root = 0; root < roots.length; root += 4) {
      const at = rest.indexOf(roots[root])
      if (at < 0 || at % 4) continue
      const zone: Zone = { circles: rest.slice(at + 1, at + 4), buildings: [rest[at] as Entity] }
      rest.splice(at, 4)
      // Каждый проход присоединяет здания, до которых зона уже дотянулась; так цепочка растёт на звено за проход.
      for (let grown = true; grown && rest.length; ) {
        grown = false
        const still: number[] = []
        for (let i = 0; i < rest.length; i += 4) {
          if (inCircles(zone.circles, rest[i + 1], rest[i + 2])) {
            zone.circles.push(rest[i + 1], rest[i + 2], rest[i + 3])
            zone.buildings.push(rest[i] as Entity)
            grown = true
          } else {
            still.push(rest[i], rest[i + 1], rest[i + 2], rest[i + 3])
          }
        }
        rest = still
      }
      zones.push(zone)
    }
    result.set(player, zones)
  }
  return result
}

const NONE: Zone[] = []

/** Зоны строительства одного игрока. */
export const zonesOf = (sim: Sim, player: number): readonly Zone[] => allZones(sim).get(player) ?? NONE

/** Все зоны игрока одним списком кругов: x, y и радиус подряд. */
export const zoneOf = (sim: Sim, player: number): readonly number[] => zonesOf(sim, player).flatMap((zone) => zone.circles)
