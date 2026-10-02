import type { Entity } from '../ecs'
import { BUILDINGS, CORE, canPlace, placeBuilding } from './buildings'
import { Building, Converting, Owner, Path, Position, Producer, Unit } from './components'
import { reward } from './economy'
import type { Sim } from './sim'
import { evictUnits, spawnUnit, unitsIn } from './units'
import { inForeignZone } from './zones'

/** Сколько секунд MCV разворачивается в главное здание и сколько здание сворачивается обратно. */
export const DEPLOY_SECONDS = 3
export const PACK_SECONDS = 10

/** Где встанет главное здание, если MCV развернётся на месте: левый верхний тайл основания. */
export function deploySite(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const { width, height } = BUILDINGS[CORE]
  return { x: Math.floor(position.x) - Math.floor(width / 2), y: Math.floor(position.y) - Math.floor(height / 2) }
}

/** Может ли игрок развернуть этот юнит прямо сейчас: это его MCV, он не занят, под ним свободная скала и не чужая зона. */
export function canDeploy(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  if (world.get(entity, Unit)?.type !== 'mcv' || world.get(entity, Owner)?.player !== player) return false
  if (world.has(entity, Converting)) return false
  const site = deploySite(sim, entity)
  if (!canPlace(sim, CORE, site.x, site.y)) return false
  return !inForeignZone(sim, player, site.x, site.y, BUILDINGS[CORE].width, BUILDINGS[CORE].height)
}

/** Может ли игрок свернуть это здание: это его главное здание, и оно не сворачивается уже. */
export function canPack(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  if (world.get(entity, Building)?.type !== CORE || world.get(entity, Owner)?.player !== player) return false
  return !world.has(entity, Converting)
}

/** Раз во сколько тиков разворачивающийся MCV просит своих юнитов уйти из-под будущего здания. */
const EVICT_TICKS = 20

/** Отменяет разворачивание: MCV остаётся машиной и снова слушается приказов. */
export function cancelDeploy(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  if (!world.has(entity, Unit) || !world.has(entity, Converting) || world.get(entity, Owner)?.player !== player) return false
  world.remove(entity, Converting)
  return true
}

/** Ждёт ли MCV, пока из-под будущего здания уйдут юниты: время разворачивания вышло, а место занято. */
export function isDeployBlocked(sim: Sim, entity: Entity) {
  const converting = sim.world.get(entity, Converting)
  return converting !== undefined && sim.world.has(entity, Unit) && converting.left <= 0
}

/**
 * Освобождает место под главное здание и говорит, свободно ли оно — правило то же, что у стройки.
 * Свои стоящие юниты с evict уходят сами; тех, кто едет, не трогают; чужих остаётся только ждать.
 */
function clearDeploySite(sim: Sim, mcv: Entity, evict: boolean) {
  const { world } = sim
  const site = deploySite(sim, mcv)
  const { width, height } = BUILDINGS[CORE]
  const inside = unitsIn(sim, site.x, site.y, width, height).filter((entity) => entity !== mcv)
  if (!inside.length) return true
  if (evict) {
    const player = world.get(mcv, Owner)?.player
    const own = inside.filter((entity) => world.get(entity, Owner)?.player === player && !world.has(entity, Path))
    evictUnits(sim, site.x, site.y, width, height, own)
  }
  return false
}

/** Начинает превращение: оно закончится через seconds. */
export function startConverting(sim: Sim, entity: Entity, seconds: number) {
  const ticks = Math.round(seconds / sim.time.step)
  sim.world.remove(entity, Path)
  sim.world.add(entity, Converting({ left: ticks, total: ticks }))
}

/**
 * Раз в тик: продвигает превращения и завершает те, чьё время вышло. MCV, под которым стоят юниты,
 * зданием не становится: свои из-под него уходят, пока он разворачивается, а чужих он ждёт.
 */
export function convert(sim: Sim) {
  const { world, time } = sim
  const ready: Entity[] = []
  const deploying: Entity[] = []
  for (const [entity, converting] of world.query(Converting)) {
    converting.left = Math.max(0, converting.left - 1)
    if (world.has(entity, Unit)) deploying.push(entity)
    if (converting.left <= 0) ready.push(entity)
  }
  // Состав мира и приказы меняются после обхода. Выгонять пробуют не каждый тик: поиск пути недёшев.
  const blocked = new Set<Entity>()
  for (const entity of deploying) {
    if (!clearDeploySite(sim, entity, (time.tick + entity) % EVICT_TICKS === 0)) blocked.add(entity)
  }
  const done = ready.filter((entity) => !blocked.has(entity))

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
      reward(sim, player, 'deploy')
    } else {
      const position = world.get(entity, Position)!
      const { width, height } = BUILDINGS[CORE]
      world.destroy(entity)
      const mcv = spawnUnit(sim, 'mcv', player, position.x + Math.floor(width / 2), position.y + Math.floor(height / 2))
      if (production) world.set(mcv, Producer, production)
    }
  }
}
