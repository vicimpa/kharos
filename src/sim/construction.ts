import type { Entity } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDABLE, BUILDINGS, BUILD_RATE, CORE, buildingSpec, canPlace, docksClear, newBuilding, siteAt, type BuildingSpec, type BuildingType } from './buildings'
import { isOwn, onTurn, ownerOf, rectDistance, turnToward } from './common'
import { Building, Builds, Converting, Owner, Path, Position, Producer, Site, Unit } from './components'
import { oreLeft } from './deposits'
import { addCredits, pay, reward, spend } from './economy'
import { overbuiltPlants } from './income'
import type { Sim } from './sim'
import { inCircles, inForeignZone, zoneOf } from './zones'
import { UNITS, clearGround, isWalkable, orderMove, standingUnits, unitsIn } from './units'

/** С какого расстояния до основания юнит работает со зданием, в тайлах: с соседнего тайла, в том числе углового. */
export const REACH = 1.2
/** С какого расстояния до основания свободный строитель сам берётся за стройку или разбор, в тайлах. */
export const WORK_RADIUS = 10
/** Раз во сколько тиков юнит, не дошедший до здания, пробует подъехать снова. */
export const RETRY_TICKS = 20

/** Сколько тиков работы одного строителя нужно на здание. */
export const siteTicks = (type: BuildingType, step: number) => Math.round(BUILDINGS[type].cost / BUILD_RATE / step)

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

/**
 * Может ли игрок заложить здесь здание: вид строится строителями, место годится, лежит в своей зоне строительства
 * и не задевает чужую. Здание с собственной зоной своей зоны не требует — оно начинает новую.
 * Коннекторы зданий застраивать нельзя, а свой должен прийтись на проходимый тайл.
 */
export function canBuild(sim: Sim, player: number, type: BuildingType, x: number, y: number) {
  if (!BUILDABLE.includes(type) || !canPlace(sim, type, x, y) || !docksClear(sim, type, x, y)) return false
  const { width, height, zone }: BuildingSpec = BUILDINGS[type]
  if (inForeignZone(sim, player, x, y, width, height)) return false
  // Шахта встаёт ровно на месторождение, в котором ещё есть руда.
  if (buildingSpec(type).extract && oreLeft(sim, x, y) <= 0) return false
  return zone !== undefined || inControl(sim, player, type, x, y)
}

/** Во сколько раз чинить быстрее, чем строить: полностью разбитое здание чинится за половину времени стройки. */
export const REPAIR_SPEED = 2
/** Какую долю цены здания стоит починить его с нуля до целого. Платят по мере починки. */
export const REPAIR_COST = 0.5

/** Сколько кредитов стоит дочинить здание этого вида с прочностью health. */
export const repairCostOf = (type: BuildingType, health: number) => Math.ceil(BUILDINGS[type].cost * REPAIR_COST * (1 - health))

/** Можно ли чинить здание: оно готовое и повреждено. */
function isRepairable(sim: Sim, building: Entity) {
  const { world } = sim
  const health = world.get(building, Building)?.health
  return health !== undefined && health < 1 && !world.has(building, Site) && !world.has(building, Converting)
}

/** Может ли игрок послать строителей чинить это здание. */
export const canRepair = (sim: Sim, player: number, building: Entity) =>
  isOwn(sim, player, building) && isRepairable(sim, building)

/** Над чем здесь работают строители: вид строящегося, разбираемого или чинимого здания; undefined — работы нет. */
function workType(sim: Sim, entity: Entity): BuildingType | undefined {
  const site = sim.world.get(entity, Site)
  if (site) return site.type
  return isRepairable(sim, entity) ? sim.world.get(entity, Building)!.type : undefined
}

/** Расстояние от точки до основания площадки в тайлах; внутри основания — ноль. */
export function distanceTo(site: { x: number; y: number }, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  return rectDistance(site.x, site.y, width, height, x, y)
}

/**
 * Отправляет юнит на свободный тайл вплотную к основанию площадки или здания — ближайший к нему.
 * claimed — тайлы, уже розданные другим юнитам этим же приказом; выбранный добавляется туда.
 */
export function approach(sim: Sim, builder: Entity, site: Entity, claimed: Set<number>) {
  const { world } = sim
  const position = world.get(builder, Position)!
  const corner = world.get(site, Position)!
  const { width, height } = BUILDINGS[(world.get(site, Site) ?? world.get(site, Building))!.type]
  const taken = standingUnits(sim, new Set([builder]), UNITS[world.get(builder, Unit)!.type].radius)
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  for (let y = corner.y - 1; y <= corner.y + height; y++) {
    for (let x = corner.x - 1; x <= corner.x + width; x++) {
      // Только кольцо вокруг основания: само основание займёт здание.
      if (x >= corner.x && x < corner.x + width && y >= corner.y && y < corner.y + height) continue
      const key = tileKey(x, y)
      if (claimed.has(key) || taken.has(key) || !isWalkable(sim, x, y)) continue
      // На соседней площадке не встают: оттуда строителя попросят, как только там начнут строить.
      if (siteAt(sim, x, y) !== undefined) continue
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

/** Стоят ли на основании ещё не начатой площадки юниты: пока они там, стройка не начнётся. */
export function isSiteBlocked(sim: Sim, site: Entity) {
  const { world } = sim
  const position = world.get(site, Position)
  const work = world.get(site, Site)
  if (!position || !work || world.has(site, Building)) return false
  return unitsIn(sim, position.x, position.y, BUILDINGS[work.type].width, BUILDINGS[work.type].height).length > 0
}

/**
 * Освобождает основание площадки перед началом стройки и говорит, свободно ли оно. Свои стоящие юниты
 * с evict уходят сами — и строители тоже; тех, кто едет, не трогают: проедут. Чужих остаётся только ждать.
 */
function clearSite(sim: Sim, site: Entity, evict: boolean) {
  const { world } = sim
  const { x, y } = world.get(site, Position)!
  const { width, height } = BUILDINGS[world.get(site, Site)!.type]
  // Строителя этой же площадки на её край ведёт approach.
  return clearGround(sim, ownerOf(sim, site), x, y, width, height, evict, undefined, (entity) => world.get(entity, Builds)?.site === site)
}

/** Своя стройка: площадка или недостроенное здание игрока. */
const isOwnSite = (sim: Sim, player: number, site: Entity) =>
  sim.world.has(site, Site) && isOwn(sim, player, site)

/**
 * Посылает строителей игрока на его стройку, разбор или к повреждённому зданию — чинить.
 * Не строители и чужие юниты из списка выбрасываются.
 */
export function assignBuilders(sim: Sim, player: number, site: Entity, units: Entity[]) {
  const { world } = sim
  if (!isOwn(sim, player, site) || workType(sim, site) === undefined) return false
  const builders = [...new Set(units)].filter((entity) => {
    return world.get(entity, Unit)?.type === 'builder' && isOwn(sim, player, entity) && !world.has(entity, Converting)
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
  // Свои юниты уходят с площадки сразу, не дожидаясь строителя.
  clearSite(sim, site, true)
  assignBuilders(sim, player, site, builders)
  return site
}

/**
 * Отменяет стройку: площадка или недостроенное здание исчезает, кредиты возвращаются целиком.
 * Отмена разбора оставляет здание целым: денег за него ещё не выдавали.
 */
export function cancelBuild(sim: Sim, player: number, site: Entity) {
  if (!isOwnSite(sim, player, site)) return false
  const { type, demolish } = sim.world.get(site, Site)!
  if (demolish) {
    sim.world.remove(site, Site)
    return true
  }
  addCredits(sim, player, BUILDINGS[type].cost)
  sim.world.destroy(site)
  return true
}

/** Какую долю цены возвращает разбор готового здания. */
export const DEMOLISH_REFUND = 0.5
/** Во сколько раз разбирать быстрее, чем строить. */
export const DEMOLISH_SPEED = 1.5

/** Сколько кредитов вернёт разбор здания этого вида. */
export const refundOf = (type: BuildingType) => Math.floor(BUILDINGS[type].cost * DEMOLISH_REFUND)

/** Может ли игрок разобрать здание: оно своё, готовое и не главное — главное сворачивают в MCV. */
export function canDemolish(sim: Sim, player: number, building: Entity) {
  const { world } = sim
  const type = world.get(building, Building)?.type
  if (type === undefined || type === CORE) return false
  return isOwn(sim, player, building) && !world.has(building, Site) && !world.has(building, Converting)
}

/**
 * Назначает готовое здание под разбор и посылает к нему строителей. Разбирают его строители — так же, как строят,
 * только быстрее; часть цены возвращается, когда здание разобрано до конца. С этого момента здание не работает
 * и зону не расширяет. Зона строительства для разбора не нужна — так можно забрать хоть что-то за здание,
 * оставшееся без главного.
 */
export function demolish(sim: Sim, player: number, building: Entity, builders: Entity[]) {
  if (!canDemolish(sim, player, building)) return false
  const { type } = sim.world.get(building, Building)!
  sim.world.add(building, Site({ type, progress: siteTicks(type, sim.time.step), demolish: true }))
  assignBuilders(sim, player, building, builders)
  return true
}

/**
 * Свободные строители сами берутся за работу поблизости: каждый идёт на ближайшую свою стройку, разбор
 * или к повреждённому зданию не дальше WORK_RADIUS. Электростанцию зоны, где потребителей больше,
 * чем потянули бы и целые станции, сами не чинят: починка только жгла бы кредиты; по приказу игрока — чинят. Стройку вне зоны не берут — она всё равно стоит. Строитель проверяет окрестности
 * не каждый тик, а раз в RETRY_TICKS, причём каждый в свой тик.
 */
function volunteer(sim: Sim) {
  const { world, time } = sim
  const idle: Entity[] = []
  for (const [entity, unit] of world.query(Unit, Owner)) {
    if (unit.type !== 'builder' || !onTurn(time, entity, RETRY_TICKS)) continue
    if (world.has(entity, Builds) || world.has(entity, Path) || world.has(entity, Converting)) continue
    idle.push(entity)
  }
  if (!idle.length) return

  /** free — работе не нужна зона строительства: это разбор или починка. */
  const sites: { entity: Entity; x: number; y: number; type: BuildingType; player: number; free: boolean }[] = []
  for (const [entity, position, site, owner] of world.query(Position, Site, Owner)) {
    sites.push({ entity, x: position.x, y: position.y, type: site.type, player: owner.player, free: site.demolish })
  }
  // Считается недёшево, поэтому только если есть что чинить, и один раз.
  let overbuilt: Set<Entity> | undefined
  const damaged: Entity[] = []
  for (const [entity, , building] of world.query(Position, Building, Owner)) if (building.health < 1) damaged.push(entity)
  for (const entity of damaged) {
    if (!isRepairable(sim, entity) || (overbuilt ??= overbuiltPlants(sim)).has(entity)) continue
    const position = world.get(entity, Position)!
    const building = world.get(entity, Building)!
    sites.push({ entity, x: position.x, y: position.y, type: building.type, player: ownerOf(sim, entity), free: true })
  }
  /** Зона нужна только стройке; считается раз на игрока и только если до неё дошло дело. */
  const open = new Map<Entity, boolean>()
  for (const builder of idle) {
    const position = world.get(builder, Position)!
    const player = ownerOf(sim, builder)
    let best: Entity | undefined
    let bestDistance = WORK_RADIUS
    for (const site of sites) {
      if (site.player !== player) continue
      const distance = distanceTo(site, site.type, position.x, position.y)
      if (distance > bestDistance) continue
      let workable = open.get(site.entity)
      if (workable === undefined) {
        workable = site.free || buildingSpec(site.type).zone !== undefined || inControl(sim, player, site.type, site.x, site.y)
        open.set(site.entity, workable)
      }
      if (!workable) continue
      best = site.entity
      bestDistance = distance
    }
    if (best !== undefined) assignBuilders(sim, player, best, [builder])
  }
}

/**
 * Раз в тик: строители, стоящие вплотную к своей площадке, вкладывают в неё работу — чем их больше, тем быстрее.
 * Здание под разбор они так же разбирают, а повреждённое — чинят.
 * С первым тиком работы площадка становится недостроенным зданием и занимает тайлы. Пока на ней стоят юниты,
 * работа не начинается: свои с неё уходят, чужих ждут.
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
    const type = workType(sim, site)
    if (!corner || !type) {
      free.push(entity)
      continue
    }
    if (world.has(entity, Path)) continue
    const distance = distanceTo(corner, type, position.x, position.y)
    if (distance === 0 || distance > REACH) {
      // Не доехал или его оттеснили. Пробует снова не каждый тик: поиск пути недёшев.
      if (onTurn(time, entity, RETRY_TICKS)) late.push({ builder: entity, site })
      continue
    }
    workers.set(site, (workers.get(site) ?? 0) + 1)
    // За работой строитель поворачивается к зданию — и светит на него фарами.
    const { width, height } = BUILDINGS[type]
    const wanted = Math.atan2(corner.y + height / 2 - position.y, corner.x + width / 2 - position.x)
    unit.facing = turnToward(unit.facing, wanted, UNITS[unit.type].turn * time.step)
  }

  for (const entity of free) world.remove(entity, Builds)
  for (const { builder, site } of late) approach(sim, builder, site, new Set())
  volunteer(sim)

  for (const [entity, count] of workers) {
    const site = world.get(entity, Site)
    if (!site) {
      // Починка идёт быстрее стройки и оплачивается по мере работы; кончились кредиты — стоит.
      const building = world.get(entity, Building)!
      const gain = Math.min(1 - building.health, (count * REPAIR_SPEED) / siteTicks(building.type, time.step))
      const owner = ownerOf(sim, entity)
      if (spend(sim, owner, gain * BUILDINGS[building.type].cost * REPAIR_COST)) building.health += gain
      continue
    }
    const position = world.get(entity, Position)!
    const player = ownerOf(sim, entity)
    if (site.demolish) {
      site.progress -= count * DEMOLISH_SPEED
      if (site.progress > 0) continue
      addCredits(sim, player, refundOf(site.type))
      world.destroy(entity)
      continue
    }
    if (buildingSpec(site.type).zone === undefined && !inControl(sim, player, site.type, position.x, position.y)) continue
    if (!world.has(entity, Building)) {
      // Выгонять пробуют не каждый тик: поиск пути недёшев.
      if (!clearSite(sim, entity, onTurn(time, entity, RETRY_TICKS))) continue
      world.add(entity, newBuilding(world, site.type))
    }
    site.progress += count
    if (site.progress < siteTicks(site.type, time.step)) continue
    world.remove(entity, Site)
    if (buildingSpec(site.type).produces) world.add(entity, Producer)
    reward(sim, player, site.type)
  }
}
