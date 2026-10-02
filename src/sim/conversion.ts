import type { Entity } from '../ecs'
import { BUILDINGS, CORE, canPlace, placeBuilding } from './buildings'
import { Building, Converting, Owner, Path, Position, Producer, Unit } from './components'
import type { Sim } from './sim'
import { evictUnits, spawnUnit } from './units'

/** Сколько секунд MCV разворачивается в главное здание и сколько здание сворачивается обратно. */
export const DEPLOY_SECONDS = 3
export const PACK_SECONDS = 10

/** Где встанет главное здание, если MCV развернётся на месте: левый верхний тайл основания. */
export function deploySite(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const { width, height } = BUILDINGS[CORE]
  return { x: Math.floor(position.x) - Math.floor(width / 2), y: Math.floor(position.y) - Math.floor(height / 2) }
}

/** Может ли игрок развернуть этот юнит прямо сейчас: это его MCV, он не занят, и под ним свободная скала. */
export function canDeploy(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  if (world.get(entity, Unit)?.type !== 'mcv' || world.get(entity, Owner)?.player !== player) return false
  if (world.has(entity, Converting)) return false
  const site = deploySite(sim, entity)
  return canPlace(sim, CORE, site.x, site.y)
}

/** Может ли игрок свернуть это здание: это его главное здание, и оно не сворачивается уже. */
export function canPack(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  if (world.get(entity, Building)?.type !== CORE || world.get(entity, Owner)?.player !== player) return false
  return !world.has(entity, Converting)
}

/** Начинает превращение: оно закончится через seconds. */
export function startConverting(sim: Sim, entity: Entity, seconds: number) {
  const ticks = Math.round(seconds / sim.time.step)
  sim.world.remove(entity, Path)
  sim.world.add(entity, Converting({ left: ticks, total: ticks }))
}

/** Раз в тик: продвигает превращения и завершает те, чьё время вышло. */
export function convert(sim: Sim) {
  const { world } = sim
  const done: Entity[] = []
  for (const [entity, converting] of world.query(Converting)) {
    if (--converting.left <= 0) done.push(entity)
  }

  // Сущности заменяются после обхода: во время него состав мира менять нельзя.
  for (const entity of done) {
    world.remove(entity, Converting)
    const player = world.get(entity, Owner)?.player ?? 0
    // Очередь производства переезжает вместе с игроком: заказы не теряются.
    const production = world.get(entity, Producer)

    if (world.has(entity, Unit)) {
      const site = deploySite(sim, entity)
      // За время разворачивания место могли занять. Тогда MCV остаётся машиной.
      if (!canPlace(sim, CORE, site.x, site.y)) continue
      world.destroy(entity)
      const core = placeBuilding(world, CORE, site.x, site.y, player)
      if (production) world.set(core, Producer, production)
      evictUnits(sim, site.x, site.y, BUILDINGS[CORE].width, BUILDINGS[CORE].height)
    } else {
      const position = world.get(entity, Position)!
      const { width, height } = BUILDINGS[CORE]
      world.destroy(entity)
      const mcv = spawnUnit(sim, 'mcv', player, position.x + Math.floor(width / 2), position.y + Math.floor(height / 2))
      if (production) world.set(mcv, Producer, production)
    }
  }
}
