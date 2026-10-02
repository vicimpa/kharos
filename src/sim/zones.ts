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

/**
 * Зоны строительства всех игроков: у каждого — круги (x, y и радиус подряд). Зону задаёт главное здание,
 * а расширяют готовые здания, стоящие в ней: каждое добавляет свой круг, и по цепочке зона растёт дальше.
 * Здание, до которого цепочка от главного не дотягивается, зону не даёт. Нет главного здания — нет и зоны.
 */
export function allZones(sim: Sim): Map<number, number[]> {
  const zones = new Map<number, number[]>()
  const rest = new Map<number, number[]>()
  for (const [entity, position, building, owner] of sim.world.query(Position, Building, Owner)) {
    if (sim.world.has(entity, Site)) continue
    const { width, height } = BUILDINGS[building.type]
    const x = position.x + width / 2
    const y = position.y + height / 2
    const target = building.type === CORE ? zones : rest
    let list = target.get(owner.player)
    if (!list) target.set(owner.player, (list = []))
    if (building.type === CORE) list.push(x, y, CONTROL_RADIUS)
    else list.push(x, y)
  }

  for (const [player, circles] of zones) {
    let waiting = rest.get(player) ?? []
    // Каждый проход присоединяет здания, до которых зона уже дотянулась; так цепочка растёт на звено за проход.
    for (let grown = true; grown && waiting.length; ) {
      grown = false
      const still: number[] = []
      for (let i = 0; i < waiting.length; i += 2) {
        if (inCircles(circles, waiting[i], waiting[i + 1])) {
          circles.push(waiting[i], waiting[i + 1], EXPAND_RADIUS)
          grown = true
        } else {
          still.push(waiting[i], waiting[i + 1])
        }
      }
      waiting = still
    }
  }
  return zones
}

const NONE: number[] = []

/** Зона строительства одного игрока: круги, x, y и радиус подряд. */
export const zoneOf = (sim: Sim, player: number): readonly number[] => allZones(sim).get(player) ?? NONE
