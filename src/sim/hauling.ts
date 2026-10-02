import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, isReady, type BuildingSpec } from './buildings'
import { NONE, isOwn, nearest, onTurn, ownerOf } from './common'
import { Beam, Building, Converting, Hauler, Inventory, Owner, Path, Position, Site, Trade } from './components'
import { oreLeft, takeOre } from './deposits'
import { amountOf, approach, beamFor, put, reaches, resetBeams, roomFor, transfer } from './inventory'
import type { Sim } from './sim'
import { neededBy, zoneWith } from './trade'
import { UNITS } from './units'

/** Сколько руды помещается в грузовик. */
export const TRUCK_CAPACITY = UNITS.truck.inventory
/** Раз во сколько тиков грузовик, не дотянувшийся до луча, пробует подъехать снова. */
const RETRY_TICKS = 20
const EPSILON = 1e-9

const specOf = (sim: Sim, building: Entity): BuildingSpec | undefined => {
  const type = sim.world.get(building, Building)?.type
  return type === undefined ? undefined : BUILDINGS[type]
}

/** Может ли игрок привязать грузовики к этому зданию: это его готовая шахта. */
export const canHaul = (sim: Sim, player: number, mine: Entity) => isReady(sim, player, mine) && !!specOf(sim, mine)?.extract

/**
 * Привязывает грузовики игрока к его шахте: с этого момента они сами возят руду из неё в хранилища.
 * Не грузовики и чужие юниты из списка выбрасываются.
 */
export function assignHaulers(sim: Sim, player: number, mine: Entity, units: Entity[]) {
  const { world } = sim
  if (!canHaul(sim, player, mine)) return false
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && isOwn(sim, player, entity))
  for (const truck of trucks) {
    releaseHauler(sim, truck)
    world.get(truck, Hauler)!.mine = mine
    // Тронется сам в ближайший тик: гружёный — в хранилище, пустой — к шахте.
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/** Сколько руды в кузове грузовика. */
const cargoOf = (sim: Sim, truck: Entity) => {
  const inventory = sim.world.get(truck, Inventory)
  return inventory ? amountOf(inventory, 'ore') : 0
}

/**
 * Снимает грузовик с работы: дальше он стоит, где стоит, пока игрок не привяжет его к шахте или его не позовёт
 * космопорт. Груз остаётся в кузове; руда, которую он вёз в космопорт, заявкой больше не считается.
 */
export function releaseHauler(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)
  if (!hauler) return
  const order = sim.world.get(hauler.port as Entity, Trade)
  if (order) order.claimed = Math.max(0, order.claimed - cargoOf(sim, truck))
  hauler.mine = hauler.base = hauler.port = hauler.source = NONE
  hauler.loading = hauler.waiting = false
  // Гружёный останется гружёным: привязанный к шахте, он сначала отвезёт груз в хранилище.
  hauler.full = cargoOf(sim, truck) > 0
}

/** Ближайшее к грузовику здание из списка; NONE — список пуст. */
function closest(sim: Sim, truck: Entity, buildings: Iterable<Entity>): Entity {
  const { world } = sim
  const from = world.get(truck, Position)!
  const distance = (entity: Entity) => {
    const position = world.get(entity, Position)!
    return Math.hypot(position.x - from.x, position.y - from.y)
  }
  return nearest(buildings, distance) ?? (NONE as Entity)
}

/** Своё готовое хранилище, которое не сворачивается. */
function isStore(sim: Sim, player: number, building: Entity) {
  return !!specOf(sim, building)?.stores && isReady(sim, player, building) && !sim.world.has(building, Converting)
}

/** Годится ли здание, чтобы выгрузить в него руду из грузовика: хранилище, где есть место, и луч между ними найдётся. */
function isBase(sim: Sim, player: number, building: Entity, truck: Entity) {
  const inventory = sim.world.get(building, Inventory)
  return isStore(sim, player, building) && !!inventory && roomFor(inventory, 'ore') > EPSILON && beamFor(sim, truck, building) !== undefined
}

/** Ближайшее к грузовику хранилище, куда можно выгрузиться; NONE — места нет нигде. */
function pickBase(sim: Sim, truck: Entity, player: number): Entity {
  const stores: Entity[] = []
  for (const [entity] of sim.world.query(Building, Inventory)) if (isBase(sim, player, entity, truck)) stores.push(entity)
  return closest(sim, truck, stores)
}

/** Годится ли здание, чтобы забирать из него руду для космопорта: хранилище с рудой, и луч между ними найдётся. */
function isSource(sim: Sim, player: number, building: Entity, truck: Entity) {
  const inventory = sim.world.get(building, Inventory)
  return isStore(sim, player, building) && !!inventory && amountOf(inventory, 'ore') > EPSILON && beamFor(sim, building, truck) !== undefined
}

/** Ближайшее к грузовику хранилище с рудой в зоне космопорта; NONE — руды в зоне нет. */
function pickSource(sim: Sim, truck: Entity, player: number, port: Entity): Entity {
  const stores = zoneWith(sim, player, port)?.buildings.filter((entity) => isSource(sim, player, entity, truck)) ?? []
  return closest(sim, truck, stores)
}

/** Подводит грузовик к зданию на длину луча, который перенесёт руду между ними. */
function seek(sim: Sim, truck: Entity, building: Entity, toBuilding: boolean) {
  const beam = toBuilding ? beamFor(sim, truck, building) : beamFor(sim, building, truck)
  if (beam !== undefined) approach(sim, truck, building, sim.world.get(beam, Beam)!.radius)
}

/** Раз в тик: шахты добывают руду в свои склады, пока там есть место. */
function extract(sim: Sim) {
  const { world, time } = sim
  const mines: { entity: Entity; rate: number }[] = []
  for (const [entity, building] of world.query(Building, Inventory)) {
    const rate = buildingSpec(building.type).extract
    if (rate && !world.has(entity, Site)) mines.push({ entity, rate })
  }
  // Первая добыча заводит месторождению сущность, а состав мира меняется после обхода.
  for (const { entity, rate } of mines) {
    const inventory = world.get(entity, Inventory)!
    const { x, y } = world.get(entity, Position)!
    put(inventory, 'ore', takeOre(sim, x, y, Math.min(rate * time.step, roomFor(inventory, 'ore'))))
  }
}

/**
 * Раз в тик: шахты добывают, грузовики возят руду. Руду между зданием и грузовиком переносит транспортный луч
 * (см. inventory.ts): грузовику достаточно встать в его радиусе. Луч за тик работает с одним грузовиком,
 * остальные ждут рядом.
 *
 * Работ две. Привязанный к шахте грузовик забирает из неё добытое и везёт в ближайшее хранилище, где есть место;
 * если места нет нигде, ждёт с грузом. Позванный космопортом забирает руду из хранилищ его зоны и везёт к нему,
 * пока заявка не набрана.
 */
export function haul(sim: Sim) {
  const { world, time } = sim
  resetBeams(sim)
  extract(sim)
  // Приказы и поиск зданий — после обхода: внутри него нельзя ни обходить мир заново, ни менять его состав.
  const seeking: { truck: Entity; building: Entity; toBuilding: boolean }[] = []
  /** Гружёным из шахты нужно хранилище, порожним от космопорта — хранилище с рудой. */
  const homeless: Entity[] = []
  const sourceless: Entity[] = []
  const released: Entity[] = []
  const working: { truck: Entity; building: Entity; toBuilding: boolean }[] = []

  for (const [entity, hauler, owner] of world.query(Hauler, Owner)) {
    hauler.loading = false
    const forPort = hauler.port !== NONE
    if (!forPort && hauler.mine === NONE) continue
    if (forPort) {
      // Заявку закрыли, корабль улетел или космопорта больше нет.
      const order = isReady(sim, owner.player, hauler.port as Entity) ? world.get(hauler.port as Entity, Trade) : undefined
      if (!order || order.total > 0 || (!hauler.full && cargoOf(sim, entity) <= 0 && neededBy(sim, hauler.port as Entity) <= EPSILON)) {
        released.push(entity)
        continue
      }
    } else if (!canHaul(sim, owner.player, hauler.mine as Entity)) {
      // Шахты больше нет: грузовик ждёт, пока его привяжут к другой. Груз остаётся в кузове.
      released.push(entity)
      continue
    }
    if (world.has(entity, Path) || world.has(entity, Converting)) continue
    const retry = onTurn(time, entity, RETRY_TICKS)

    let building: Entity
    if (forPort) {
      building = (hauler.full ? hauler.port : hauler.source) as Entity
      if (!hauler.full && !isSource(sim, owner.player, building, entity)) {
        if (retry || hauler.source !== NONE) sourceless.push(entity)
        hauler.source = NONE
        continue
      }
    } else if (hauler.full) {
      building = hauler.base as Entity
      if (!isBase(sim, owner.player, building, entity)) {
        if (retry || hauler.base !== NONE) homeless.push(entity)
        hauler.base = NONE
        continue
      }
    } else {
      building = hauler.mine as Entity
    }

    const toBuilding = hauler.full
    if (!(toBuilding ? reaches(sim, entity, building) : reaches(sim, building, entity))) {
      // Только что получивший работу трогается сразу, не нашедший места — раз в RETRY_TICKS.
      if (retry || !hauler.waiting) seeking.push({ truck: entity, building, toBuilding })
      hauler.waiting = true
      continue
    }
    hauler.waiting = false
    working.push({ truck: entity, building, toBuilding })
  }

  for (const truck of released) releaseHauler(sim, truck)

  for (const { truck, building, toBuilding } of working) {
    const hauler = world.get(truck, Hauler)!
    const cargo = world.get(truck, Inventory)!

    if (hauler.port !== NONE) {
      const order = world.get(hauler.port as Entity, Trade)!
      if (toBuilding) {
        // Выгрузка в космопорт.
        const moved = transfer(sim, truck, building, 'ore')
        order.claimed = Math.max(0, order.claimed - moved)
        hauler.loading = moved > 0
        if (amountOf(cargo, 'ore') > EPSILON) continue
        hauler.full = false
        hauler.source = NONE
        if (neededBy(sim, hauler.port as Entity) <= EPSILON) releaseHauler(sim, truck)
        else sourceless.push(truck)
        continue
      }
      // Погрузка из хранилища: не больше, чем заявке ещё нужно.
      const moved = transfer(sim, building, truck, 'ore', neededBy(sim, hauler.port as Entity))
      order.claimed += moved
      hauler.loading = moved > 0
      if (roomFor(cargo, 'ore') <= EPSILON || neededBy(sim, hauler.port as Entity) <= EPSILON) hauler.full = true
      // Доли копятся с погрешностью: полный кузов — ровно полный.
      if (roomFor(cargo, 'ore') <= EPSILON) put(cargo, 'ore', EPSILON)
      continue
    }

    if (toBuilding) {
      // Выгрузка в хранилище; кончилось место — ищет другое.
      const moved = transfer(sim, truck, building, 'ore')
      hauler.loading = moved > 0
      if (amountOf(cargo, 'ore') > EPSILON) {
        if (roomFor(world.get(building, Inventory)!, 'ore') <= EPSILON) homeless.push(truck)
        continue
      }
      cargo.items.ore = 0
      hauler.full = false
      hauler.base = NONE
      continue
    }
    // Погрузка у шахты. Месторождение выработано, а в шахте пусто — везёт, что успел набрать.
    const moved = transfer(sim, building, truck, 'ore')
    hauler.loading = moved > 0
    const mine = world.get(building, Inventory)!
    const { x, y } = world.get(building, Position)!
    const spent = oreLeft(sim, x, y) <= 0 && amountOf(mine, 'ore') <= EPSILON
    if (roomFor(cargo, 'ore') <= EPSILON || (spent && amountOf(cargo, 'ore') > 0)) {
      // Доли копятся с погрешностью: полный кузов — ровно полный.
      put(cargo, 'ore', EPSILON)
      hauler.full = true
      homeless.push(truck)
    } else if (spent) {
      releaseHauler(sim, truck)
    }
  }

  for (const truck of homeless) {
    const hauler = world.get(truck, Hauler)!
    hauler.base = pickBase(sim, truck, ownerOf(sim, truck))
    hauler.waiting = false
  }
  for (const truck of sourceless) {
    const hauler = world.get(truck, Hauler)!
    if (hauler.port === NONE) continue
    hauler.source = pickSource(sim, truck, ownerOf(sim, truck), hauler.port as Entity)
    hauler.waiting = false
    if (hauler.source !== NONE) continue
    // Руды в хранилищах больше нет — везёт, что успел набрать.
    if (cargoOf(sim, truck) > EPSILON) hauler.full = true
    else releaseHauler(sim, truck)
  }
  for (const { truck, building, toBuilding } of seeking) seek(sim, truck, building, toBuilding)
}
