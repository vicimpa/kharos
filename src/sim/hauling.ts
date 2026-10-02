import type { Entity } from '../ecs'
import { BUILDINGS, CORE, dockOf, type BuildingSpec, type Dock } from './buildings'
import { Building, Converting, Hauler, Owner, Path, Position, Site, Unit } from './components'
import { oreLeft, takeOre } from './deposits'
import type { Sim } from './sim'
import { storeOre, zoneWith } from './trade'
import { UNITS, evictUnits, orderMove, unitsIn } from './units'

/** Сколько руды помещается в грузовик. */
export const TRUCK_CAPACITY = 20
/** Сколько руды в секунду грузовик выгружает в хранилища базы. */
export const UNLOAD_RATE = 10
/** Значение Hauler.mine и Hauler.base, когда шахты или базы у грузовика нет. */
const NONE = -1
/** Раз во сколько тиков грузовик, не вставший к коннектору, пробует подъехать снова. */
const RETRY_TICKS = 20
/** С какого расстояния до коннектора грузовик ждёт очереди на месте, а не подъезжает ближе, в тайлах. */
const WAIT_RADIUS = 2.5
/** Насколько точно грузовик встаёт задом к зданию, в радианах. */
const ALIGNED = 0.05

const TURN = Math.PI * 2
const wrap = (angle: number) => angle - TURN * Math.round(angle / TURN)

const specOf = (sim: Sim, building: Entity): BuildingSpec | undefined => {
  const type = sim.world.get(building, Building)?.type
  return type === undefined ? undefined : BUILDINGS[type]
}

/** Готовое здание игрока: не площадка, не недострой и не под разбором. */
const isReady = (sim: Sim, player: number, building: Entity) =>
  sim.world.has(building, Building) && !sim.world.has(building, Site) && sim.world.get(building, Owner)?.player === player

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
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && world.get(entity, Owner)?.player === player)
  for (const truck of trucks) {
    const hauler = world.get(truck, Hauler)!
    hauler.mine = mine
    hauler.docked = hauler.waiting = false
    // Тронется сам в ближайший тик: гружёный — на базу, пустой — к шахте.
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/** Отвязывает грузовик от шахты: дальше он стоит, где стоит, пока игрок не привяжет его снова. Груз остаётся в кузове. */
export function releaseHauler(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)
  if (!hauler) return
  hauler.mine = hauler.base = NONE
  hauler.docked = false
}

/** Ближайшее к грузовику своё главное здание, которое не сворачивается; NONE — такого нет. */
function pickBase(sim: Sim, truck: Entity, player: number): Entity {
  const { world } = sim
  const from = world.get(truck, Position)!
  let best = NONE as Entity
  let bestDistance = Infinity
  for (const [entity, position, building] of world.query(Position, Building)) {
    if (building.type !== CORE || !isReady(sim, player, entity) || world.has(entity, Converting)) continue
    const distance = Math.hypot(position.x - from.x, position.y - from.y)
    if (distance < bestDistance) {
      best = entity
      bestDistance = distance
    }
  }
  return best
}

/**
 * Ведёт грузовик к коннектору. Если тайл коннектора свободен — едет на него. Своих стоящих юнитов с него
 * просит уйти; чужих и другой грузовик, который сейчас у коннектора работает, ждёт неподалёку.
 */
function seekDock(sim: Sim, truck: Entity, dock: Dock) {
  const { world } = sim
  const player = world.get(truck, Owner)!.player
  const inside = unitsIn(sim, dock.x, dock.y, 1, 1).filter((entity) => entity !== truck)
  if (!inside.length) return orderMove(sim, truck, dock.x, dock.y)
  const own = inside.filter((entity) => {
    if (world.get(entity, Owner)?.player !== player || world.has(entity, Path)) return false
    // Грузовик, который сам встал к этому коннектору — подключён или ещё разворачивается, — остаётся.
    const other = world.get(entity, Hauler)
    return !other || other.mine === NONE || other.waiting
  })
  evictUnits(sim, dock.x, dock.y, 1, 1, own)
  // Издалека подъезжает поближе: orderMove сам поставит его на свободный тайл рядом с занятым.
  const position = world.get(truck, Position)!
  if (Math.hypot(dock.x + 0.5 - position.x, dock.y + 0.5 - position.y) > WAIT_RADIUS) orderMove(sim, truck, dock.x, dock.y)
}

/**
 * Раз в тик: грузовики возят руду. У шахты и у главного здания есть коннектор — тайл вплотную к зданию; грузовик
 * встаёт на него задом к зданию, и только тогда идёт погрузка или выгрузка. Коннектор один, поэтому шахта грузит
 * один грузовик, а остальные привязанные ждут рядом. Шахта работает, только пока грузовик подключён.
 * Полный грузовик едет к ближайшему главному зданию и выгружается в хранилища его зоны строительства;
 * если места в них нет, стоит у коннектора и ждёт.
 */
export function haul(sim: Sim) {
  const { world, time } = sim
  // Приказы и поиск базы — после обхода: внутри него нельзя ни обходить мир заново, ни менять его состав.
  const seeking: { truck: Entity; dock: Dock }[] = []
  const homeless: Entity[] = []
  const loading: Entity[] = []
  const unloading: Entity[] = []

  for (const [entity, hauler, position, unit, owner] of world.query(Hauler, Position, Unit, Owner)) {
    const mine = hauler.mine as Entity
    if (mine === NONE) continue
    if (!canHaul(sim, owner.player, mine)) {
      // Шахты больше нет: грузовик ждёт, пока его привяжут к другой. Груз остаётся в кузове.
      hauler.mine = hauler.base = NONE
      hauler.docked = false
      continue
    }
    if (world.has(entity, Path) || world.has(entity, Converting)) {
      hauler.docked = false
      continue
    }
    const retry = (time.tick + entity) % RETRY_TICKS === 0

    let target = mine
    if (hauler.full) {
      target = hauler.base as Entity
      const valid = world.get(target, Building)?.type === CORE && isReady(sim, owner.player, target) && !world.has(target, Converting)
      if (!valid) {
        hauler.docked = false
        if (retry || hauler.base !== NONE) homeless.push(entity)
        hauler.base = NONE
        continue
      }
    }
    const dock = dockAt(sim, target)!
    if (Math.floor(position.x) !== dock.x || Math.floor(position.y) !== dock.y) {
      hauler.docked = false
      // Только что привязанный или освободившийся трогается сразу, ждущий очереди — раз в RETRY_TICKS.
      if (retry || !hauler.waiting) seeking.push({ truck: entity, dock })
      hauler.waiting = true
      continue
    }
    hauler.waiting = false
    // На коннекторе: разворачивается задом к зданию и подключается.
    const off = wrap(dock.facing - unit.facing)
    const maxTurn = UNITS[unit.type].turn * time.step
    unit.facing = Math.abs(off) <= maxTurn ? dock.facing : wrap(unit.facing + Math.sign(off) * maxTurn)
    hauler.docked = Math.abs(wrap(dock.facing - unit.facing)) < ALIGNED
    if (hauler.docked) (hauler.full ? unloading : loading).push(entity)
  }

  for (const truck of loading) {
    const hauler = world.get(truck, Hauler)!
    const mine = hauler.mine as Entity
    const { x, y } = world.get(mine, Position)!
    hauler.ore += takeOre(sim, x, y, Math.min(specOf(sim, mine)!.extract! * time.step, TRUCK_CAPACITY - hauler.ore))
    const spent = oreLeft(sim, x, y) <= 0
    if (hauler.ore >= TRUCK_CAPACITY - 1e-9 || (spent && hauler.ore > 0)) {
      // Доли копятся с погрешностью: полный кузов — ровно полный.
      if (hauler.ore >= TRUCK_CAPACITY - 1e-9) hauler.ore = TRUCK_CAPACITY
      hauler.full = true
      hauler.docked = false
      homeless.push(truck)
    } else if (spent) {
      // Месторождение выработано, а везти нечего.
      releaseHauler(sim, truck)
    }
  }

  for (const truck of unloading) {
    const hauler = world.get(truck, Hauler)!
    const zone = zoneWith(sim, world.get(truck, Owner)!.player, hauler.base as Entity)
    if (zone) hauler.ore -= storeOre(sim, zone, Math.min(UNLOAD_RATE * time.step, hauler.ore))
    if (hauler.ore > 1e-9) continue
    hauler.ore = 0
    hauler.full = false
    hauler.docked = false
    hauler.base = NONE
    // Месторождение могло кончиться, пока он ездил.
    const { x, y } = world.get(hauler.mine as Entity, Position)!
    if (oreLeft(sim, x, y) <= 0) releaseHauler(sim, truck)
    else seeking.push({ truck, dock: dockAt(sim, hauler.mine as Entity)! })
  }

  for (const truck of homeless) {
    const hauler = world.get(truck, Hauler)!
    hauler.base = pickBase(sim, truck, world.get(truck, Owner)!.player)
    if (hauler.base !== NONE) seeking.push({ truck, dock: dockAt(sim, hauler.base as Entity)! })
  }
  for (const { truck, dock } of seeking) seekDock(sim, truck, dock)
}
