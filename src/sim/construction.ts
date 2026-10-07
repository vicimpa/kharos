import type { Entity } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDABLE, BUILDINGS, BUILD_RATE, CORE, buildingSpec, canPlace, durabilityOf, equip, newBuilding, siteAt, type BuildingSpec, type BuildingType } from './buildings'
import { NONE, isOwn, onTurn, ownerOf, rectDistance, turnToward, wrap } from './common'
import { Building, Builds, Converting, Health, Inventory, Owner, Path, Pave, Position, Producer, Repair, Site, Unit } from './components'
import { reserveLeft } from './deposits'
import { amountOf } from './inventory'
import { entriesOf, totalOf } from './resources'
import { addCredits, creditsOf, pay, reward, spend } from './economy'
import { overbuiltPlants } from './income'
import type { Sim } from './sim'
import { buildSpeed, onFoundation, paveCost } from './paving'
import { inCircles, inForeignZone, zoneOf } from './zones'
import { carrierOf, turnerOf } from './turrets'
import { UNITS, clearGround, isWalkable, orderMove, standingUnits, unitsIn } from './units'

/** С какого расстояния до основания свободный строитель сам берётся за стройку или разбор, в тайлах. */
export const WORK_RADIUS = 10
/** Раз во сколько тиков юнит, не дошедший до здания, пробует подъехать снова. */
export const RETRY_TICKS = 20

/** Сколько тиков работы одного строителя нужно на то, что стоит cost кредитов. */
const workTicks = (cost: number, step: number) => Math.round(cost / BUILD_RATE / step)

/** Сколько тиков работы одного строителя нужно на здание. */
export const siteTicks = (type: BuildingType, step: number) => workTicks(BUILDINGS[type].cost, step)

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
 * Нужна ли зданию своя зона строительства: здание с собственной зоной её не требует — оно начинает новую,
 * а оборонительные постройки ставят и вовсе где угодно, лишь бы не в чужой зоне.
 */
function needsZone(type: BuildingType) {
  const { zone, defense } = buildingSpec(type)
  return zone === undefined && !defense
}

/** Стоит ли стройка здесь без зоны: здание её требует, а основание не лежит целиком на готовом фундаменте. */
const outOfControl = (sim: Sim, player: number, type: BuildingType, x: number, y: number) =>
  needsZone(type) && !inControl(sim, player, type, x, y) && !onFoundation(sim, type, x, y)

/**
 * Может ли игрок заложить здесь здание: вид строится строителями, место годится, лежит в своей зоне строительства
 * и не задевает чужую. Своей зоны не требуют здание с собственной зоной (оно начинает новую), оборонительные
 * постройки и здание на сплошном готовом фундаменте: их ставят и вне своих зон, но по-прежнему не в чужих.
 */
export function canBuild(sim: Sim, player: number, type: BuildingType, x: number, y: number) {
  if (!BUILDABLE.includes(type) || !canPlace(sim, type, x, y)) return false
  const { width, height }: BuildingSpec = BUILDINGS[type]
  if (inForeignZone(sim, player, x, y, width, height)) return false
  // Шахта встаёт ровно на месторождение, в котором ещё что-то есть.
  if (buildingSpec(type).extract && reserveLeft(sim, x, y) <= 0) return false
  return !outOfControl(sim, player, type, x, y)
}

/** Во сколько раз чинить быстрее, чем строить, по умолчанию: полностью разбитое чинится за половину времени стройки. См. Sim.rules. */
export const REPAIR_SPEED = 2
/** Какую долю цены здания или юнита стоит починить его с нуля до целого, по умолчанию. Платят по мере починки. См. Sim.rules. */
export const REPAIR_COST = 0.5
/**
 * Сколько секунд после попадания цель не чинится, по умолчанию. Иначе один строитель за стеной отменяет осаду:
 * он возвращает больше прочности в секунду, чем бьёт отряд. Ремонт — между боями, а не под огнём. См. Sim.rules.
 */
export const REPAIR_PAUSE = 3

/** Попадали ли по этому в последние repairPause секунд: по такому не работают и к нему не едут. */
function underFire(sim: Sim, entity: Entity) {
  const health = sim.world.get(entity, Health)
  if (!health || health.hit < 0) return false
  return sim.time.tick - health.hit < sim.rules.repairPause / sim.time.step
}

/** Сколько кредитов стоит дочинить объект до его max; share — доля цены за починку от нуля до обычной единицы. */
export const repairCostOf = (cost: number, health: number, share = REPAIR_COST, max = 1) => Math.ceil(cost * share * (max - health))

/**
 * Можно ли это чинить: готовое повреждённое здание или повреждённый юнит, чья прочность чинится
 * (Health.repairable). Пехоту, например, не чинят — она поправляется сама, см. recover в combat.ts.
 */
function isRepairable(sim: Sim, entity: Entity) {
  const { world } = sim
  // Нулевая скорость ремонта — ремонта нет вовсе: строители не едут чинить и не стоят без дела у разбитого.
  if (sim.rules.repairSpeed <= 0) return false
  const health = world.get(entity, Health)
  return !!health?.repairable && health.value < health.max && !world.has(entity, Site) && !world.has(entity, Converting)
}

/** Может ли игрок послать строителей чинить это здание или юнит. */
export const canRepair = (sim: Sim, player: number, entity: Entity) => isOwn(sim, player, entity) && isRepairable(sim, entity)

/** То, над чем работают строители: стройка, разбор или починка. */
interface Work {
  /** Прямоугольник основания в тайлах; у юнита — точка в его центре. */
  x: number
  y: number
  width: number
  height: number
  /** Радиус юнита; у здания ноль. */
  radius: number
  /** Цена того, что строят или чинят: из неё считаются время и цена работы. */
  cost: number
}

/** Над чем здесь работают строители; undefined — работы нет. */
function workAt(sim: Sim, entity: Entity): Work | undefined {
  const { world } = sim
  const position = world.get(entity, Position)
  if (!position) return undefined
  const pave = world.get(entity, Pave)
  if (pave) return pave.done && !pave.remove ? undefined : { x: position.x, y: position.y, width: 1, height: 1, radius: 0, cost: paveCost(sim, pave.kind, position.x, position.y) }
  const type = world.get(entity, Site)?.type
  const repair = type === undefined && isRepairable(sim, entity)
  const unit = repair ? world.get(entity, Unit) : undefined
  if (unit) {
    const { radius, cost } = UNITS[unit.type]
    return { x: position.x, y: position.y, width: 0, height: 0, radius, cost }
  }
  const built = type ?? (repair ? world.get(entity, Building)!.type : undefined)
  if (built === undefined) return undefined
  const { width, height, cost } = BUILDINGS[built]
  return { x: position.x, y: position.y, width, height, radius: 0, cost }
}

/** Расстояние от точки до края того, над чем работают, в тайлах; внутри основания — ноль. */
const distanceTo = (work: Work, x: number, y: number) =>
  Math.max(0, rectDistance(work.x, work.y, work.width, work.height, x, y) - work.radius)

/** На сколько тайлов ближе своего радиуса встаёт ремонтник: с запасом на то, что юнит, которого он чинит, может сдвинуться. */
const APPROACH_MARGIN = 0.5

/**
 * Подводит ремонтника к работе ровно настолько, чтобы она попала в его радиус: на ближайший к нему свободный тайл,
 * откуда он до неё дотягивается. Вплотную ему не нужно. Если уже дотягивается — остаётся где стоит.
 * claimed — тайлы, уже розданные другим этим же приказом: иначе все поехали бы в один и толкались бы там.
 */
function approach(sim: Sim, builder: Entity, site: Entity, claimed = new Set<number>()) {
  const { world } = sim
  const position = world.get(builder, Position)!
  const repair = world.get(builder, Repair)
  const work = workAt(sim, site)
  if (!work || !repair || distanceTo(work, position.x, position.y) <= repair.radius) return
  const reach = Math.max(0, repair.radius - APPROACH_MARGIN)
  const taken = standingUnits(sim, new Set([builder]), UNITS[world.get(builder, Unit)!.type].radius)
  const span = Math.ceil(reach + work.radius)
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  for (let y = Math.floor(work.y) - span; y <= Math.floor(work.y + work.height) + span; y++) {
    for (let x = Math.floor(work.x) - span; x <= Math.floor(work.x + work.width) + span; x++) {
      const distance = Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y)
      if (distance >= bestDistance) continue
      // Само основание займёт здание.
      const edge = distanceTo(work, x + 0.5, y + 0.5)
      if (edge > reach || (work.width > 0 && edge === 0)) continue
      const key = tileKey(x, y)
      if (claimed.has(key) || taken.has(key) || !isWalkable(sim, x, y)) continue
      // На площадке не встают: оттуда строителя попросят, как только там начнут строить.
      if (siteAt(sim, x, y) !== undefined) continue
      best = { x, y }
      bestDistance = distance
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
  return clearGround(sim, ownerOf(sim, site), x, y, width, height, evict)
}

/** Своя стройка: площадка или недостроенное здание игрока. */
const isOwnSite = (sim: Sim, player: number, site: Entity) =>
  sim.world.has(site, Site) && isOwn(sim, player, site)

/**
 * Посылает строителей игрока на его стройку, разбор или к повреждённому зданию или юниту — чинить.
 * Юниты без Repair и чужие из списка выбрасываются; сам себя ремонтник не чинит.
 */
export function assignBuilders(sim: Sim, player: number, site: Entity, units: Entity[]) {
  const { world } = sim
  if (!isOwn(sim, player, site) || !workAt(sim, site)) return false
  const builders = [...new Set(units)].filter((entity) => {
    return entity !== site && world.has(entity, Unit) && world.has(entity, Repair) && isOwn(sim, player, entity) && !world.has(entity, Converting)
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
  // Материалы привезут грузовики: площадка заказывает их у своей зоны, см. logistics.ts.
  const materials = buildingSpec(type).materials
  if (materials) {
    sim.world.add(site, Inventory({ capacity: totalOf(materials), accepts: entriesOf(materials).map(([resource]) => resource), limits: { ...materials } }))
  }
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
 * или к повреждённому зданию или стоящему юниту не дальше WORK_RADIUS. Электростанцию зоны, где потребителей больше,
 * чем потянули бы и целые станции, сами не чинят: починка только жгла бы кредиты; по приказу игрока — чинят. Стройку вне зоны не берут — она всё равно стоит. Строитель проверяет окрестности
 * не каждый тик, а раз в RETRY_TICKS, причём каждый в свой тик.
 */
function volunteer(sim: Sim) {
  const { world, time } = sim
  const idle: Entity[] = []
  for (const [entity] of world.query(Repair, Unit, Owner)) {
    if (!onTurn(time, entity, RETRY_TICKS)) continue
    if (world.has(entity, Builds) || world.has(entity, Path) || world.has(entity, Converting)) continue
    idle.push(entity)
  }
  if (!idle.length) return

  /** type — вид здания, которое строят: такой работе нужна зона строительства. Разбору и починке она не нужна. */
  const sites: { entity: Entity; work: Work; player: number; type?: BuildingType }[] = []
  for (const [entity, , site, owner] of world.query(Position, Site, Owner)) {
    sites.push({ entity, work: workAt(sim, entity)!, player: owner.player, type: site.demolish ? undefined : site.type })
  }
  for (const [entity, , pave, owner] of world.query(Position, Pave, Owner)) {
    if (!pave.done || pave.remove) sites.push({ entity, work: workAt(sim, entity)!, player: owner.player })
  }
  // Считается недёшево, поэтому только если есть что чинить, и один раз.
  let overbuilt: Set<Entity> | undefined
  const damaged: Entity[] = []
  for (const [entity, health] of world.query(Health, Position, Owner)) if (health.value < health.max) damaged.push(entity)
  for (const entity of damaged) {
    // За едущим юнитом сами не гоняются: встанет — починят. К тому, по кому бьют, тоже не едут: переждут бой.
    if (!isRepairable(sim, entity) || world.has(entity, Path) || underFire(sim, entity)) continue
    if (world.has(entity, Building) && (overbuilt ??= overbuiltPlants(sim)).has(entity)) continue
    sites.push({ entity, work: workAt(sim, entity)!, player: ownerOf(sim, entity) })
  }
  /** Зона нужна только стройке; считается раз на игрока и только если до неё дошло дело. */
  const open = new Map<Entity, boolean>()
  for (const builder of idle) {
    const position = world.get(builder, Position)!
    const player = ownerOf(sim, builder)
    let best: Entity | undefined
    let bestDistance = WORK_RADIUS
    for (const site of sites) {
      if (site.player !== player || site.entity === builder) continue
      const distance = distanceTo(site.work, position.x, position.y)
      if (distance > bestDistance) continue
      let workable = open.get(site.entity)
      if (workable === undefined) {
        const { type, work } = site
        workable = type === undefined || !outOfControl(sim, player, type, work.x, work.y)
        open.set(site.entity, workable)
      }
      if (!workable) continue
      best = site.entity
      bestDistance = distance
    }
    if (best !== undefined) assignBuilders(sim, player, best, [builder])
  }
}

/** Ремонтник from работает над to: строит, чинит или, если demolish, разбирает. */
export interface RepairLink {
  from: Entity
  to: Entity
  /** Сколько работы за тик он вкладывает. */
  rate: number
  demolish: boolean
  /** Откуда и куда тянется работа, в тайлах: центр ремонтника и ближняя к нему точка цели. */
  fromX: number
  fromY: number
  toX: number
  toY: number
  /** Смотрит ли ремонтник на цель: работает он, только глядя на неё. Здание смотрит во все стороны. */
  aimed: boolean
}

/** На сколько тайлов вглубь основания здания приходится точка, над которой работает ремонтник. */
const WORK_INSET = 0.4
/** Насколько точно юнит-ремонтник должен смотреть на цель, чтобы работать, в радианах. */
const REPAIR_AIM = 0.2

/** Смотрит ли ремонтник на то, над чем работает. */
function isAimed(sim: Sim, link: RepairLink) {
  const turner = turnerOf(sim, link.from)
  if (!turner) return true
  return Math.abs(wrap(Math.atan2(link.toY - link.fromY, link.toX - link.fromX) - turner.body.facing)) <= REPAIR_AIM
}

/**
 * Над чем сейчас работает каждый ремонтник. Работа у него одна: та, к которой его послали, если он до неё дотягивается,
 * а иначе — ближайшая из тех, до которых дотягивается и которые не стоят.
 */
export function repairLinks(sim: Sim): RepairLink[] {
  const { world } = sim
  const links: RepairLink[] = []
  const repairers: { entity: Entity; player: number; x: number; y: number; radius: number; rate: number; site?: number; carrier: Entity }[] = []
  for (const [entity, repair, position, owner] of world.query(Repair, Position, Owner)) {
    // На ходу, разворачиваясь и недостроенным не работают; турель — работает и на ходу носителя.
    if (world.has(entity, Path) || world.has(carrierOf(sim, entity), Converting) || world.has(entity, Site)) continue
    const building = world.get(entity, Building)
    const { width, height } = building ? BUILDINGS[building.type] : { width: 0, height: 0 }
    repairers.push({ entity, player: owner.player, x: position.x + width / 2, y: position.y + height / 2, radius: repair.radius, rate: repair.rate, site: world.get(entity, Builds)?.site, carrier: carrierOf(sim, entity) })
  }
  if (!repairers.length) return links

  const targets: { entity: Entity; work: Work; player: number; demolish: boolean; ordered: boolean }[] = []
  for (const [entity] of world.query(Site, Position, Owner)) targets.push({ entity, work: workAt(sim, entity)!, player: 0, demolish: false, ordered: false })
  for (const [entity, pave] of world.query(Pave, Position, Owner)) {
    if (!pave.done || pave.remove) targets.push({ entity, work: workAt(sim, entity)!, player: 0, demolish: false, ordered: false })
  }
  for (const [entity, health] of world.query(Health, Position, Owner)) {
    // По кому сейчас бьют, не чинят: посланный строитель постоит рядом и возьмётся, когда бой стихнет.
    if (health.value < health.max && isRepairable(sim, entity) && !underFire(sim, entity)) targets.push({ entity, work: workAt(sim, entity)!, player: 0, demolish: false, ordered: false })
  }
  // Считается недёшево, поэтому только если есть повреждённое здание, и один раз.
  let overbuilt: Set<Entity> | undefined
  for (const target of targets) {
    const site = world.get(target.entity, Site)
    target.player = ownerOf(sim, target.entity)
    target.demolish = !!site?.demolish || !!world.get(target.entity, Pave)?.remove
    // Электростанцию, которой не хватило бы и целой, чинят только посланные к ней: иначе починка зря жгла бы кредиты.
    target.ordered = !site && world.has(target.entity, Building) && (overbuilt ??= overbuiltPlants(sim)).has(target.entity)
  }
  const stalled = new Map<Entity, boolean>()
  const stands = (entity: Entity) => {
    let value = stalled.get(entity)
    if (value === undefined) stalled.set(entity, (value = isStalled(sim, entity)))
    return value
  }

  for (const repairer of repairers) {
    let best: (typeof targets)[number] | undefined
    let bestDistance = Infinity
    for (const target of targets) {
      // Себя и свой носитель ремонтник не чинит.
      if (target.player !== repairer.player || target.entity === repairer.carrier) continue
      if (target.ordered && repairer.site !== target.entity) continue
      const distance = distanceTo(target.work, repairer.x, repairer.y)
      if (distance > repairer.radius) continue
      // Посланный к работе занят ею, остальное подождёт.
      if (repairer.site === target.entity) {
        best = target
        break
      }
      if (distance < bestDistance && !stands(target.entity)) {
        best = target
        bestDistance = distance
      }
    }
    if (!best) continue
    const { work } = best
    const insetX = Math.min(WORK_INSET, work.width / 2)
    const insetY = Math.min(WORK_INSET, work.height / 2)
    const link: RepairLink = {
      from: repairer.entity, to: best.entity, rate: repairer.rate, demolish: best.demolish, fromX: repairer.x, fromY: repairer.y,
      toX: Math.min(work.x + work.width - insetX, Math.max(work.x + insetX, repairer.x)),
      toY: Math.min(work.y + work.height - insetY, Math.max(work.y + insetY, repairer.y)),
      aimed: false,
    }
    link.aimed = isAimed(sim, link)
    links.push(link)
  }
  return links
}

/**
 * Какую долю стройки позволяют привезённые материалы, от 0 до 1: строить дальше привезённого нельзя.
 * Здание без материалов строится целиком.
 */
export function materialShare(sim: Sim, site: Entity) {
  const { world } = sim
  const type = world.get(site, Site)?.type
  const materials = type === undefined ? undefined : buildingSpec(type).materials
  const inventory = world.get(site, Inventory)
  if (!materials || !inventory) return 1
  return Math.min(1, ...entriesOf(materials).map(([resource, amount]) => amountOf(inventory, resource) / amount))
}

/** Стройка дошла до того, что позволяют привезённые материалы, и ждёт подвоза. */
export function awaitsMaterials(sim: Sim, site: Entity) {
  const work = sim.world.get(site, Site)
  if (!work || work.demolish) return false
  return work.progress >= siteTicks(work.type, sim.time.step) * materialShare(sim, site) - 1e-9
}

/**
 * Стоит ли работа, хотя ремонтник до неё дотянулся: стройка вне зоны строительства, с юнитами на ещё пустой
 * площадке или без материалов, а починка — без кредитов.
 */
function isStalled(sim: Sim, entity: Entity) {
  const { world } = sim
  // Покрытие оплачено сразу и ничего не ждёт.
  if (world.has(entity, Pave)) return false
  const site = world.get(entity, Site)
  // Бесплатная починка не стоит и без кредитов.
  if (!site) return sim.rules.repairCost > 0 && creditsOf(sim, ownerOf(sim, entity)) <= 0
  if (site.demolish) return false
  const { x, y } = world.get(entity, Position)!
  if (outOfControl(sim, ownerOf(sim, entity), site.type, x, y)) return true
  return isSiteBlocked(sim, entity) || awaitsMaterials(sim, entity)
}

/** Работы, которые идут прямо сейчас: их клиент показывает лучом от ремонтника к цели. */
export function activeRepairs(sim: Sim): RepairLink[] {
  return repairLinks(sim).filter((link) => link.aimed && !isStalled(sim, link.to))
}

/**
 * Работа за этот тик: ремонтник поворачивается к своей цели и, если уже смотрит на неё, вкладывает в неё работу.
 * Возвращает, сколько работы досталось каждой стройке и каждому повреждённому зданию или юниту.
 */
function workDone(sim: Sim) {
  const { world, time } = sim
  const done = new Map<Entity, number>()
  for (const [, repair] of world.query(Repair)) repair.target = NONE
  for (const link of repairLinks(sim)) {
    world.get(link.from, Repair)!.target = link.to
    const turner = turnerOf(sim, link.from)
    // За работой юнит или турель поворачивается к ней — и юнит светит на неё фарами.
    if (turner) turner.body.facing = turnToward(turner.body.facing, Math.atan2(link.toY - link.fromY, link.toX - link.fromX), turner.turn * time.step)
    if (isAimed(sim, link)) done.set(link.to, (done.get(link.to) ?? 0) + link.rate)
  }
  return done
}

/**
 * Раз в тик: ремонтники (Repair) вкладывают работу во всё своё, до чего дотягиваются, — чем их больше, тем быстрее.
 * Стройку строят, здание под разбор разбирают, повреждённое здание или юнит — чинят; им может быть и юнит,
 * и здание. Строитель сам подъезжает к своей работе (Builds), а дальше работает как любой ремонтник.
 * С первым тиком работы площадка становится недостроенным зданием и занимает тайлы. Пока на ней стоят юниты,
 * работа не начинается: свои с неё уходят, чужих ждут.
 * Стройка вне радиуса контроля (главное здание свернули) стоит, пока контроль не вернётся; оборонительным
 * постройкам контроль не нужен, их стройка не встаёт.
 */
export function construct(sim: Sim) {
  const { world, time } = sim
  // Состав мира меняется после обхода.
  const free: Entity[] = []
  const late: { builder: Entity; site: Entity }[] = []

  for (const [entity, position, , builds, repair] of world.query(Position, Unit, Builds, Repair)) {
    const site = builds.site as Entity
    const work = workAt(sim, site)
    if (!work) {
      free.push(entity)
      continue
    }
    if (world.has(entity, Path)) continue
    const distance = distanceTo(work, position.x, position.y)
    if (distance > repair.radius) {
      // Не доехал или его оттеснили. Пробует снова не каждый тик: поиск пути недёшев.
      if (onTurn(time, entity, RETRY_TICKS)) late.push({ builder: entity, site })
    }
  }

  for (const entity of free) world.remove(entity, Builds)
  for (const { builder, site } of late) approach(sim, builder, site)
  volunteer(sim)

  const workers = workDone(sim)
  for (const [entity, count] of workers) {
    const pave = world.get(entity, Pave)
    if (pave?.remove) {
      pave.work -= count * DEMOLISH_SPEED
      if (pave.work <= 0) world.destroy(entity)
      continue
    }
    if (pave) {
      const { x, y } = world.get(entity, Position)!
      pave.work += count
      if (pave.work >= workTicks(paveCost(sim, pave.kind, x, y), time.step)) pave.done = true
      continue
    }
    const site = world.get(entity, Site)
    if (!site) {
      // Починка идёт быстрее стройки и оплачивается по мере работы; кончились кредиты — стоит.
      const health = world.get(entity, Health)
      const work = workAt(sim, entity)
      if (!health || !work || underFire(sim, entity)) continue
      const gain = Math.min(health.max - health.value, (count * sim.rules.repairSpeed) / workTicks(work.cost, time.step))
      const price = gain * work.cost * sim.rules.repairCost
      if (price <= 0 || spend(sim, ownerOf(sim, entity), price)) health.value += gain
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
    if (outOfControl(sim, player, site.type, position.x, position.y)) continue
    if (!world.has(entity, Building)) {
      // Выгонять пробуют не каждый тик: поиск пути недёшев.
      if (!clearSite(sim, entity, onTurn(time, entity, RETRY_TICKS))) continue
      world.add(entity, newBuilding(world, site.type))
      const durability = durabilityOf(sim, site.type, position.x, position.y)
      world.add(entity, Health({ value: durability, max: durability }))
    }
    // Дальше привезённых материалов стройка не идёт. Фундамент под основанием меняет скорость стройки.
    const speed = buildSpeed(sim, site.type, position.x, position.y)
    site.progress = Math.max(site.progress, Math.min(site.progress + count * speed, siteTicks(site.type, time.step) * materialShare(sim, entity)))
    if (site.progress < siteTicks(site.type, time.step)) continue
    world.remove(entity, Site)
    // Материалы ушли в здание; склад у готового здания свой.
    world.remove(entity, Inventory)
    if (buildingSpec(site.type).produces) world.add(entity, Producer)
    equip(world, entity, site.type)
    reward(sim, player, site.type)
  }
}
