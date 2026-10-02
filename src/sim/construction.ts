import type { Entity } from '../ecs'
import { BUILDABLE, BUILDINGS, CORE, canPlace, type BuildingType } from './buildings'
import { Building, Builds, Converting, Owner, Path, Position, Site, Unit } from './components'
import { addCredits, pay, reward } from './economy'
import type { Sim } from './sim'
import { inCircles, zoneOf } from './zones'
import { UNITS, evictUnits, isWalkable, orderMove, standingUnits, tileKey } from './units'

/** С какого расстояния до основания строитель работает, в тайлах: с соседнего тайла, в том числе углового. */
const REACH = 1.2
/** Раз во сколько тиков строитель, не дошедший до площадки, пробует подъехать снова. */
const RETRY_TICKS = 20

const TURN = Math.PI * 2
const wrap = (angle: number) => angle - TURN * Math.round(angle / TURN)

/** Сколько тиков работы одного строителя нужно на здание. */
export const siteTicks = (type: BuildingType, step: number) => Math.round(BUILDINGS[type].buildTime / step)

/** Центры главных зданий игрока, x и y подряд. */
export function coreCenters(sim: Sim, player: number) {
  const centers: number[] = []
  const { width, height } = BUILDINGS[CORE]
  for (const [, position, building, owner] of sim.world.query(Position, Building, Owner)) {
    if (building.type === CORE && owner.player === player) centers.push(position.x + width / 2, position.y + height / 2)
  }
  return centers
}

/** Попадает ли центр основания здания с левым верхним углом в (x, y) в зону строительства игрока. */
export function inControl(sim: Sim, player: number, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  return inCircles(zoneOf(sim, player), x + width / 2, y + height / 2)
}

/** Может ли игрок заложить здесь здание: вид строится строителями, место годится и лежит в зоне строительства. */
export function canBuild(sim: Sim, player: number, type: BuildingType, x: number, y: number) {
  if (!BUILDABLE.includes(type)) return false
  return canPlace(sim, type, x, y) && inControl(sim, player, type, x, y)
}

/** Расстояние от точки до основания площадки в тайлах; внутри основания — ноль. */
function distanceTo(site: { x: number; y: number }, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  return Math.hypot(Math.max(site.x - x, 0, x - site.x - width), Math.max(site.y - y, 0, y - site.y - height))
}

/**
 * Отправляет строителя на свободный тайл вплотную к основанию площадки — ближайший к нему.
 * claimed — тайлы, уже розданные другим строителям этим же приказом; выбранный добавляется туда.
 */
function approach(sim: Sim, builder: Entity, site: Entity, claimed: Set<number>) {
  const { world } = sim
  const position = world.get(builder, Position)!
  const corner = world.get(site, Position)!
  const { width, height } = BUILDINGS[world.get(site, Site)!.type]
  const taken = standingUnits(sim, new Set([builder]), UNITS.builder.radius)
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  for (let y = corner.y - 1; y <= corner.y + height; y++) {
    for (let x = corner.x - 1; x <= corner.x + width; x++) {
      // Только кольцо вокруг основания: само основание займёт здание.
      if (x >= corner.x && x < corner.x + width && y >= corner.y && y < corner.y + height) continue
      const key = tileKey(x, y)
      if (claimed.has(key) || taken.has(key) || !isWalkable(sim, x, y)) continue
      const distance = Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y)
      if (distance < bestDistance) {
        best = { x, y }
        bestDistance = distance
      }
    }
  }
  if (!best) return
  claimed.add(tileKey(best.x, best.y))
  orderMove(sim, builder, best.x, best.y)
}

/** Своя стройка: площадка или недостроенное здание игрока. */
const isOwnSite = (sim: Sim, player: number, site: Entity) =>
  sim.world.has(site, Site) && sim.world.get(site, Owner)?.player === player

/** Посылает строителей игрока на его стройку. Не строители и чужие юниты из списка выбрасываются. */
export function assignBuilders(sim: Sim, player: number, site: Entity, units: Entity[]) {
  const { world } = sim
  if (!isOwnSite(sim, player, site)) return false
  const builders = [...new Set(units)].filter((entity) => {
    return world.get(entity, Unit)?.type === 'builder' && world.get(entity, Owner)?.player === player && !world.has(entity, Converting)
  })
  const claimed = new Set<number>()
  for (const builder of builders) {
    world.add(builder, Builds({ site }))
    approach(sim, builder, site, claimed)
  }
  return builders.length > 0
}

/**
 * Закладывает площадку под здание и посылает к ней строителей. Кредиты списываются сразу.
 * Возвращает площадку или undefined, если заложить не вышло.
 */
export function orderBuild(sim: Sim, player: number, type: BuildingType, x: number, y: number, builders: Entity[]) {
  if (!canBuild(sim, player, type, x, y) || !pay(sim, player, BUILDINGS[type].cost)) return undefined
  const site = sim.world.spawn(Position({ x, y }), Site({ type }), Owner({ player }))
  assignBuilders(sim, player, site, builders)
  return site
}

/** Отменяет стройку: площадка или недостроенное здание исчезает, кредиты возвращаются целиком. */
export function cancelBuild(sim: Sim, player: number, site: Entity) {
  if (!isOwnSite(sim, player, site)) return false
  addCredits(sim, player, BUILDINGS[sim.world.get(site, Site)!.type].cost)
  sim.world.destroy(site)
  return true
}

/**
 * Раз в тик: строители, стоящие вплотную к своей площадке, вкладывают в неё работу — чем их больше, тем быстрее.
 * С первым тиком работы площадка становится недостроенным зданием и занимает тайлы; юниты с неё уходят.
 * Стройка вне радиуса контроля (главное здание свернули) стоит, пока контроль не вернётся.
 */
export function construct(sim: Sim) {
  const { world, time } = sim
  const workers = new Map<Entity, number>()
  // Состав мира меняется после обхода.
  const free: Entity[] = []
  const late: { builder: Entity; site: Entity }[] = []

  for (const [entity, position, unit, builds] of world.query(Position, Unit, Builds)) {
    const site = builds.site as Entity
    const corner = world.get(site, Position)
    const type = world.get(site, Site)?.type
    if (!corner || !type) {
      free.push(entity)
      continue
    }
    if (world.has(entity, Path)) continue
    const distance = distanceTo(corner, type, position.x, position.y)
    if (distance === 0 || distance > REACH) {
      // Не доехал или его оттеснили. Пробует снова не каждый тик: поиск пути недёшев.
      if ((time.tick + entity) % RETRY_TICKS === 0) late.push({ builder: entity, site })
      continue
    }
    workers.set(site, (workers.get(site) ?? 0) + 1)
    // За работой строитель поворачивается к зданию — и светит на него фарами.
    const { width, height } = BUILDINGS[type]
    const wanted = Math.atan2(corner.y + height / 2 - position.y, corner.x + width / 2 - position.x)
    const off = wrap(wanted - unit.facing)
    const maxTurn = UNITS[unit.type].turn * time.step
    unit.facing = Math.abs(off) <= maxTurn ? wanted : wrap(unit.facing + Math.sign(off) * maxTurn)
  }

  for (const entity of free) world.remove(entity, Builds)
  for (const { builder, site } of late) approach(sim, builder, site, new Set())

  for (const [entity, count] of workers) {
    const site = world.get(entity, Site)!
    const position = world.get(entity, Position)!
    if (!inControl(sim, world.get(entity, Owner)?.player ?? 0, site.type, position.x, position.y)) continue
    if (!world.has(entity, Building)) {
      world.add(entity, Building({ type: site.type, phase: world.count(Building) * 5 }))
      evictUnits(sim, position.x, position.y, BUILDINGS[site.type].width, BUILDINGS[site.type].height)
    }
    site.progress += count
    if (site.progress < siteTicks(site.type, time.step)) continue
    world.remove(entity, Site)
    reward(sim, world.get(entity, Owner)?.player ?? 0, site.type)
  }
}
