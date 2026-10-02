import type { Entity } from '../ecs'
import { BUILDINGS, CORE, dockOf, isReady, type BuildingSpec, type Dock } from './buildings'
import { NONE, holdsDock, isOwn, nearest, onTurn, ownerOf, turnToward, wrap } from './common'
import { Building, Converting, Hauler, Owner, Path, Position, Trade, Unit } from './components'
import { oreLeft, takeOre } from './deposits'
import type { Sim } from './sim'
import { neededBy, storeOre, zoneWith } from './trade'
import { UNITS, clearGround, orderMove } from './units'

/** Сколько руды помещается в грузовик. */
export const TRUCK_CAPACITY = 20
/** Сколько руды в секунду грузовик выгружает в здание и забирает из хранилища. */
export const UNLOAD_RATE = 10
/** Раз во сколько тиков грузовик, не вставший к коннектору, пробует подъехать снова. */
const RETRY_TICKS = 20
/** С какого расстояния до коннектора грузовик ждёт очереди на месте, а не подъезжает ближе, в тайлах. */
const WAIT_RADIUS = 2.5
/** Насколько точно грузовик встаёт задом к зданию, в радианах. */
const ALIGNED = 0.05
const EPSILON = 1e-9

const specOf = (sim: Sim, building: Entity): BuildingSpec | undefined => {
  const type = sim.world.get(building, Building)?.type
  return type === undefined ? undefined : BUILDINGS[type]
}

/** Может ли игрок привязать грузовики к этому зданию: это его готовая шахта. */
export const canHaul = (sim: Sim, player: number, mine: Entity) => isReady(sim, player, mine) && !!specOf(sim, mine)?.extract

/** Коннектор здания на карте или undefined, если у здания его нет. */
function dockAt(sim: Sim, building: Entity): Dock | undefined {
  const position = sim.world.get(building, Position)
  const type = sim.world.get(building, Building)?.type
  return position && type ? dockOf(type, position.x, position.y) : undefined
}

/**
 * Привязывает грузовики игрока к его шахте: с этого момента они сами возят руду из неё на базу.
 * Не грузовики и чужие юниты из списка выбрасываются.
 */
export function assignHaulers(sim: Sim, player: number, mine: Entity, units: Entity[]) {
  const { world } = sim
  if (!canHaul(sim, player, mine)) return false
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && isOwn(sim, player, entity))
  for (const truck of trucks) {
    releaseHauler(sim, truck)
    world.get(truck, Hauler)!.mine = mine
    // Тронется сам в ближайший тик: гружёный — на базу, пустой — к шахте.
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/**
 * Снимает грузовик с работы: дальше он стоит, где стоит, пока игрок не привяжет его к шахте или его не позовёт
 * космопорт. Груз остаётся в кузове; руда, которую он вёз в космопорт, заявкой больше не считается.
 */
export function releaseHauler(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)
  if (!hauler) return
  const order = sim.world.get(hauler.port as Entity, Trade)
  if (order) order.claimed = Math.max(0, order.claimed - hauler.ore)
  hauler.mine = hauler.base = hauler.port = hauler.source = NONE
  hauler.docked = hauler.waiting = false
  // Гружёный останется гружёным: привязанный к шахте, он сначала отвезёт груз на базу.
  hauler.full = hauler.ore > 0
}

/** Ближайшее к грузовику своё главное здание, которое не сворачивается; NONE — такого нет. */
function pickBase(sim: Sim, truck: Entity, player: number): Entity {
  const { world } = sim
  const bases: Entity[] = []
  for (const [entity, , building] of world.query(Position, Building)) {
    if (building.type === CORE && isReady(sim, player, entity) && !world.has(entity, Converting)) bases.push(entity)
  }
  return closest(sim, truck, bases)
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

/** Годится ли здание, чтобы забирать из него руду для космопорта: готовое хранилище с коннектором и рудой. */
function isSource(sim: Sim, player: number, building: Entity) {
  const spec = specOf(sim, building)
  return !!spec?.stores && !!spec.dock && isReady(sim, player, building) && sim.world.get(building, Building)!.ore > EPSILON
}

/** Ближайшее к грузовику хранилище с рудой в зоне космопорта; NONE — руды в зоне нет. */
function pickSource(sim: Sim, truck: Entity, player: number, port: Entity): Entity {
  const stores = zoneWith(sim, player, port)?.buildings.filter((entity) => isSource(sim, player, entity)) ?? []
  return closest(sim, truck, stores)
}

/**
 * Ведёт грузовик к коннектору. Если тайл коннектора свободен — едет на него. Своих стоящих юнитов с него
 * просит уйти; чужих и другой грузовик, который сейчас у коннектора работает, ждёт неподалёку.
 */
function seekDock(sim: Sim, truck: Entity, dock: Dock) {
  const { world } = sim
  // Грузовик, который сам встал к этому коннектору — подключён или ещё разворачивается, — остаётся.
  const works = (entity: Entity) => {
    const other = world.get(entity, Hauler)
    return !!other && holdsDock(other)
  }
  if (clearGround(sim, ownerOf(sim, truck), dock.x, dock.y, 1, 1, true, truck, works)) return orderMove(sim, truck, dock.x, dock.y)
  // Издалека подъезжает поближе: orderMove сам поставит его на свободный тайл рядом с занятым.
  const position = world.get(truck, Position)!
  if (Math.hypot(dock.x + 0.5 - position.x, dock.y + 0.5 - position.y) > WAIT_RADIUS) orderMove(sim, truck, dock.x, dock.y)
}

/**
 * Раз в тик: грузовики возят руду. У шахты, главного здания, хранилища и космопорта есть коннектор — тайл вплотную
 * к зданию; грузовик встаёт на него задом к зданию, и только тогда идёт погрузка или выгрузка. Коннектор один,
 * поэтому здание работает с одним грузовиком, а остальные ждут рядом.
 *
 * Работ две. Привязанный к шахте грузовик грузится у неё — шахта работает, только пока он подключён, — и везёт руду
 * к ближайшему главному зданию, в хранилища его зоны строительства; если места в них нет, стоит у коннектора и ждёт.
 * Позванный космопортом забирает руду из хранилищ его зоны и везёт к нему, пока заявка не набрана.
 */
export function haul(sim: Sim) {
  const { world, time } = sim
  // Приказы и поиск зданий — после обхода: внутри него нельзя ни обходить мир заново, ни менять его состав.
  const seeking: { truck: Entity; dock: Dock }[] = []
  /** Гружёным из шахты нужно главное здание, порожним от космопорта — хранилище с рудой. */
  const homeless: Entity[] = []
  const sourceless: Entity[] = []
  const released: Entity[] = []
  const docked: Entity[] = []

  for (const [entity, hauler, position, unit, owner] of world.query(Hauler, Position, Unit, Owner)) {
    const forPort = hauler.port !== NONE
    if (!forPort && hauler.mine === NONE) continue
    if (forPort) {
      // Заявку закрыли, корабль улетел или космопорта больше нет.
      const order = isReady(sim, owner.player, hauler.port as Entity) ? world.get(hauler.port as Entity, Trade) : undefined
      if (!order || order.total > 0 || (!hauler.full && hauler.ore <= 0 && neededBy(order) <= EPSILON)) {
        released.push(entity)
        continue
      }
    } else if (!canHaul(sim, owner.player, hauler.mine as Entity)) {
      // Шахты больше нет: грузовик ждёт, пока его привяжут к другой. Груз остаётся в кузове.
      released.push(entity)
      continue
    }
    if (world.has(entity, Path) || world.has(entity, Converting)) {
      hauler.docked = false
      continue
    }
    const retry = onTurn(time, entity, RETRY_TICKS)

    let target: Entity
    if (forPort) {
      target = (hauler.full ? hauler.port : hauler.source) as Entity
      if (!hauler.full && !isSource(sim, owner.player, target)) {
        hauler.docked = false
        if (retry || hauler.source !== NONE) sourceless.push(entity)
        hauler.source = NONE
        continue
      }
    } else if (hauler.full) {
      target = hauler.base as Entity
      const valid = world.get(target, Building)?.type === CORE && isReady(sim, owner.player, target) && !world.has(target, Converting)
      if (!valid) {
        hauler.docked = false
        if (retry || hauler.base !== NONE) homeless.push(entity)
        hauler.base = NONE
        continue
      }
    } else {
      target = hauler.mine as Entity
    }

    const dock = dockAt(sim, target)!
    if (Math.floor(position.x) !== dock.x || Math.floor(position.y) !== dock.y) {
      hauler.docked = false
      // Только что получивший работу трогается сразу, ждущий очереди — раз в RETRY_TICKS.
      if (retry || !hauler.waiting) seeking.push({ truck: entity, dock })
      hauler.waiting = true
      continue
    }
    hauler.waiting = false
    // На коннекторе: разворачивается задом к зданию и подключается.
    unit.facing = turnToward(unit.facing, dock.facing, UNITS[unit.type].turn * time.step)
    hauler.docked = Math.abs(wrap(dock.facing - unit.facing)) < ALIGNED
    if (hauler.docked) docked.push(entity)
  }

  for (const truck of released) releaseHauler(sim, truck)

  for (const truck of docked) {
    const hauler = world.get(truck, Hauler)!
    const player = ownerOf(sim, truck)

    if (hauler.port !== NONE) {
      const order = world.get(hauler.port as Entity, Trade)!
      if (hauler.full) {
        // Выгрузка в космопорт.
        const amount = Math.min(UNLOAD_RATE * time.step, hauler.ore)
        hauler.ore -= amount
        order.delivered += amount
        order.claimed = Math.max(0, order.claimed - amount)
        if (hauler.ore > EPSILON) continue
        hauler.ore = 0
        hauler.full = hauler.docked = false
        hauler.source = NONE
        if (neededBy(order) <= EPSILON) releaseHauler(sim, truck)
        else sourceless.push(truck)
        continue
      }
      // Погрузка из хранилища: не больше, чем заявке ещё нужно.
      const store = world.get(hauler.source as Entity, Building)!
      const amount = Math.max(0, Math.min(UNLOAD_RATE * time.step, TRUCK_CAPACITY - hauler.ore, store.ore, neededBy(order)))
      store.ore -= amount
      hauler.ore += amount
      order.claimed += amount
      if (hauler.ore >= TRUCK_CAPACITY - EPSILON || neededBy(order) <= EPSILON) {
        if (hauler.ore >= TRUCK_CAPACITY - EPSILON) hauler.ore = TRUCK_CAPACITY
        hauler.full = true
        hauler.docked = false
        seeking.push({ truck, dock: dockAt(sim, hauler.port as Entity)! })
      }
      continue
    }

    if (hauler.full) {
      // Выгрузка в хранилища зоны главного здания.
      const zone = zoneWith(sim, player, hauler.base as Entity)
      if (zone) hauler.ore -= storeOre(sim, zone, Math.min(UNLOAD_RATE * time.step, hauler.ore))
      if (hauler.ore > EPSILON) continue
      hauler.ore = 0
      hauler.full = hauler.docked = false
      hauler.base = NONE
      // Месторождение могло кончиться, пока он ездил.
      const { x, y } = world.get(hauler.mine as Entity, Position)!
      if (oreLeft(sim, x, y) <= 0) releaseHauler(sim, truck)
      else seeking.push({ truck, dock: dockAt(sim, hauler.mine as Entity)! })
      continue
    }
    // Погрузка у шахты.
    const mine = hauler.mine as Entity
    const { x, y } = world.get(mine, Position)!
    hauler.ore += takeOre(sim, x, y, Math.min(specOf(sim, mine)!.extract! * time.step, TRUCK_CAPACITY - hauler.ore))
    const spent = oreLeft(sim, x, y) <= 0
    if (hauler.ore >= TRUCK_CAPACITY - EPSILON || (spent && hauler.ore > 0)) {
      // Доли копятся с погрешностью: полный кузов — ровно полный.
      if (hauler.ore >= TRUCK_CAPACITY - EPSILON) hauler.ore = TRUCK_CAPACITY
      hauler.full = true
      hauler.docked = false
      homeless.push(truck)
    } else if (spent) {
      // Месторождение выработано, а везти нечего.
      releaseHauler(sim, truck)
    }
  }

  for (const truck of homeless) {
    const hauler = world.get(truck, Hauler)!
    hauler.base = pickBase(sim, truck, ownerOf(sim, truck))
    if (hauler.base !== NONE) seeking.push({ truck, dock: dockAt(sim, hauler.base as Entity)! })
  }
  for (const truck of sourceless) {
    const hauler = world.get(truck, Hauler)!
    if (hauler.port === NONE) continue
    hauler.source = pickSource(sim, truck, ownerOf(sim, truck), hauler.port as Entity)
    if (hauler.source !== NONE) {
      seeking.push({ truck, dock: dockAt(sim, hauler.source as Entity)! })
    } else if (hauler.ore > EPSILON) {
      // Руды в хранилищах больше нет — везёт, что успел набрать.
      hauler.full = true
      seeking.push({ truck, dock: dockAt(sim, hauler.port as Entity)! })
    } else {
      releaseHauler(sim, truck)
    }
  }
  for (const { truck, dock } of seeking) seekDock(sim, truck, dock)
}
