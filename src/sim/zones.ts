import type { Entity, World } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDINGS, type BuildingSpec } from './buildings'
import { Building, Owner, Pave, Position, Site } from './components'
import type { Sim } from './sim'

/** Радиус зоны строительства вокруг главного здания, в тайлах от его центра. */
export const CONTROL_RADIUS = BUILDINGS.command.zone
/** На сколько тайлов от своего центра расширяет зону любое другое готовое здание. */
export const EXPAND_RADIUS = 5

/** Попадает ли точка хотя бы в один круг. circles — x, y и радиус подряд. */
export function inCircles(circles: readonly number[], x: number, y: number) {
  for (let i = 0; i < circles.length; i += 3) {
    if (Math.hypot(x - circles[i], y - circles[i + 1]) <= circles[i + 2]) return true
  }
  return false
}

/** Зона строительства: здание, которое её начало (главное или другое с собственной зоной), и всё, что к нему пристроено. */
export interface Zone {
  /** Круги, из которых зона состоит: x, y и радиус подряд. */
  circles: number[]
  /** Готовые здания зоны, начиная с главного. */
  buildings: Entity[]
}

/** На сколько тайлов от своего центра расширяет зону готовый фундамент: на клетку вокруг себя. */
export const FOUNDATION_REACH = 1.5

/** Посчитанные зоны мира: пересчитываются, только когда появилось или пропало здание, площадка или покрытие. */
const caches = new WeakMap<World, { zones?: Map<number, Zone[]> }>()

function cacheOf(world: World) {
  let cache = caches.get(world)
  if (!cache) {
    const fresh: { zones?: Map<number, Zone[]> } = {}
    const reset = () => {
      fresh.zones = undefined
      return () => void (fresh.zones = undefined)
    }
    world.observe([Building], reset)
    world.observe([Site], reset)
    world.observe([Pave], reset)
    // У клиента готовность покрытия приходит изменением компонента, а не его появлением.
    world.onChange(Pave, () => void (fresh.zones = undefined))
    caches.set(world, (cache = fresh))
  }
  return cache
}

/** Забыть посчитанные зоны: так делают, когда меняется то, за чем кэш сам не следит, — например, достроено покрытие. */
export const resetZones = (sim: Sim) => void (cacheOf(sim.world).zones = undefined)

/**
 * Зоны строительства всех игроков. Зону задаёт главное здание (и любое здание с BuildingSpec.zone), а расширяют готовые здания, стоящие в ней:
 * каждое добавляет свой круг, и по цепочке зона растёт дальше. Расширяет её и готовый фундамент — на клетку вокруг
 * себя, — если его плиты сплошной полосой дотягиваются до зоны: так фундаментом соединяют зоны. Здание, до которого
 * цепочка от главного не дотягивается, ни в какую зону не входит. Нет главного здания — нет и зоны.
 * Два главных здания дают две зоны; если второе стоит внутри зоны первого, зона у них общая.
 */
export function allZones(sim: Sim): Map<number, Zone[]> {
  const cache = cacheOf(sim.world)
  return (cache.zones ??= computeZones(sim))
}

function computeZones(sim: Sim): Map<number, Zone[]> {
  const { world } = sim
  /** Готовые здания игрока, ещё не попавшие в зону: сущность, x, y центра и радиус круга подряд. */
  const waiting = new Map<number, number[]>()
  const cores = new Map<number, number[]>()
  for (const [entity, position, building, owner] of world.query(Position, Building, Owner)) {
    if (world.has(entity, Site)) continue
    const { width, height, zone, expand }: BuildingSpec = BUILDINGS[building.type]
    const core = zone !== undefined
    const target = core ? cores : waiting
    let list = target.get(owner.player)
    if (!list) target.set(owner.player, (list = []))
    list.push(entity, position.x + width / 2, position.y + height / 2, zone ?? expand ?? EXPAND_RADIUS)
  }
  /** Готовые фундаменты игрока: x и y тайла подряд. */
  const slabs = new Map<number, number[]>()
  for (const [, position, pave, owner] of world.query(Position, Pave, Owner)) {
    if (!pave.done || pave.kind !== 'foundation') continue
    let list = slabs.get(owner.player)
    if (!list) slabs.set(owner.player, (list = []))
    list.push(position.x, position.y)
  }

  const result = new Map<number, Zone[]>()
  for (const [player, roots] of cores) {
    const zones: Zone[] = []
    // Главные здания тоже ждут очереди: то, что стоит внутри уже выросшей зоны, свою не начинает.
    let rest = [...roots, ...(waiting.get(player) ?? [])]
    const own = slabs.get(player) ?? []
    /** Фундаменты, уже вошедшие в какую-то зону игрока, по tileKey. */
    const used = new Set<number>()
    const isSlab = (x: number, y: number) => {
      const entity = sim.paving.at(x, y)
      const pave = entity === undefined ? undefined : world.get(entity, Pave)
      return !!pave && pave.done && pave.kind === 'foundation' && world.get(entity!, Owner)?.player === player
    }
    for (let root = 0; root < roots.length; root += 4) {
      const at = rest.indexOf(roots[root])
      if (at < 0 || at % 4) continue
      const zone: Zone = { circles: rest.slice(at + 1, at + 4), buildings: [rest[at] as Entity] }
      rest.splice(at, 4)
      /** Присоединяет здания, до которых зона уже дотянулась; так цепочка растёт на звено за проход. */
      const growBuildings = () => {
        let any = false
        for (let grown = true; grown && rest.length; ) {
          grown = false
          const still: number[] = []
          for (let i = 0; i < rest.length; i += 4) {
            if (inCircles(zone.circles, rest[i + 1], rest[i + 2])) {
              zone.circles.push(rest[i + 1], rest[i + 2], rest[i + 3])
              zone.buildings.push(rest[i] as Entity)
              grown = any = true
            } else {
              still.push(rest[i], rest[i + 1], rest[i + 2], rest[i + 3])
            }
          }
          rest = still
        }
        return any
      }
      /** Присоединяет фундаменты, лежащие в зоне, и всё, что сплошь примыкает к ним. */
      const growSlabs = () => {
        const queue: number[] = []
        for (let i = 0; i < own.length; i += 2) {
          const key = tileKey(own[i], own[i + 1])
          if (used.has(key) || !inCircles(zone.circles, own[i] + 0.5, own[i + 1] + 0.5)) continue
          used.add(key)
          queue.push(own[i], own[i + 1])
        }
        const any = queue.length > 0
        while (queue.length) {
          const y = queue.pop()!
          const x = queue.pop()!
          zone.circles.push(x + 0.5, y + 0.5, FOUNDATION_REACH)
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const key = tileKey(x + dx, y + dy)
              if ((dx || dy) && !used.has(key) && isSlab(x + dx, y + dy)) {
                used.add(key)
                queue.push(x + dx, y + dy)
              }
            }
          }
        }
        return any
      }
      // Здания и фундамент тянут зону по очереди, пока она растёт.
      growBuildings()
      while (growSlabs() && growBuildings());
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

/**
 * Задевает ли основание здания чужую зону строительства: в чужих зонах строить нельзя.
 * Проверяются центр и углы основания. Там, где зоны двух игроков перекрываются, не строит ни один.
 */
export function inForeignZone(sim: Sim, player: number, x: number, y: number, width: number, height: number) {
  for (const [other, zones] of allZones(sim)) {
    if (other === player) continue
    for (const { circles } of zones) {
      if (inCircles(circles, x + width / 2, y + height / 2)) return true
      if (inCircles(circles, x, y) || inCircles(circles, x + width, y)) return true
      if (inCircles(circles, x, y + height) || inCircles(circles, x + width, y + height)) return true
    }
  }
  return false
}
