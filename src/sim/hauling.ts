import type { Entity } from '../ecs'
import { BUILDINGS, type BuildingSpec } from './buildings'
import { Building, Converting, Hauler, Owner, Path, Position, Site } from './components'
import { REACH, RETRY_TICKS, approach, distanceTo } from './construction'
import { oreLeft, takeOre } from './deposits'
import type { Sim } from './sim'

/** Сколько руды помещается в грузовик. */
export const TRUCK_CAPACITY = 40
/** Сколько руды в секунду грузовик выгружает в хранилище. */
export const UNLOAD_RATE = 20
/** Значение Hauler.mine и Hauler.store, когда шахты или хранилища у грузовика нет. */
const NONE = -1

const specOf = (sim: Sim, building: Entity): BuildingSpec | undefined => {
  const type = sim.world.get(building, Building)?.type
  return type === undefined ? undefined : BUILDINGS[type]
}

/** Готовое здание игрока: не площадка, не недострой и не под разбором. */
const isReady = (sim: Sim, player: number, building: Entity) =>
  sim.world.has(building, Building) && !sim.world.has(building, Site) && sim.world.get(building, Owner)?.player === player

/** Может ли игрок привязать грузовики к этому зданию: это его готовая шахта. */
export const canHaul = (sim: Sim, player: number, mine: Entity) => isReady(sim, player, mine) && !!specOf(sim, mine)?.extract

/**
 * Привязывает грузовики игрока к его шахте: с этого момента они сами возят руду из неё в хранилища.
 * Не грузовики и чужие юниты из списка выбрасываются.
 */
export function assignHaulers(sim: Sim, player: number, mine: Entity, units: Entity[]) {
  const { world } = sim
  if (!canHaul(sim, player, mine)) return false
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && world.get(entity, Owner)?.player === player)
  const claimed = new Set<number>()
  for (const truck of trucks) {
    const hauler = world.get(truck, Hauler)!
    hauler.mine = mine
    hauler.loading = false
    // Гружёный сначала отвезёт то, что уже везёт.
    if (!hauler.full) approach(sim, truck, mine, claimed)
  }
  return trucks.length > 0
}

/** Отвязывает грузовик от шахты: дальше он стоит, где стоит, пока игрок не привяжет его снова. Груз остаётся в кузове. */
export function releaseHauler(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)
  if (!hauler) return
  hauler.mine = hauler.store = NONE
  hauler.loading = false
}

/** Ближайшее к грузовику своё готовое хранилище; из тех, где есть место, если такие есть. */
function pickStore(sim: Sim, truck: Entity, player: number): Entity {
  const { world } = sim
  const from = world.get(truck, Position)!
  let best: Entity = NONE as Entity
  let bestScore = Infinity
  for (const [entity, position, building] of world.query(Position, Building)) {
    const spec: BuildingSpec = BUILDINGS[building.type]
    if (!spec.stores || !isReady(sim, player, entity)) continue
    // Полное хранилище — запасной вариант: к нему едут, только если свободных нет.
    const score = distanceTo(position, building.type, from.x, from.y) + (building.ore >= spec.stores ? 1e6 : 0)
    if (score < bestScore) {
      best = entity
      bestScore = score
    }
  }
  return best
}

/**
 * Раз в тик: грузовики возят руду. Шахта работает, только пока вплотную к ней стоит привязанный грузовик, и грузит
 * его одна — остальные привязанные ждут рядом своей очереди. Полный грузовик едет к ближайшему хранилищу, где есть
 * место, выгружается и возвращается. Если места нет нигде, он ждёт у хранилища.
 */
export function haul(sim: Sim) {
  const { world, time } = sim
  /** Грузовики, стоящие у своей шахты и готовые грузиться, по шахтам. */
  const docked = new Map<Entity, Entity[]>()
  // Приказы и выбор хранилища — после обхода: внутри него нельзя ни обходить мир заново, ни менять его состав.
  const toMine: Entity[] = []
  const toStore: Entity[] = []
  const unloading: Entity[] = []

  for (const [entity, hauler, position, owner] of world.query(Hauler, Position, Owner)) {
    const mine = hauler.mine as Entity
    if (mine === NONE) continue
    if (!canHaul(sim, owner.player, mine)) {
      // Шахты больше нет: грузовик ждёт, пока его привяжут к другой. Груз остаётся в кузове.
      hauler.mine = hauler.store = NONE
      hauler.loading = false
      continue
    }
    if (world.has(entity, Path) || world.has(entity, Converting)) {
      hauler.loading = false
      continue
    }
    const retry = (time.tick + entity) % RETRY_TICKS === 0

    if (hauler.full) {
      const store = hauler.store as Entity
      const corner = isReady(sim, owner.player, store) ? world.get(store, Position) : undefined
      const type = world.get(store, Building)?.type
      if (!corner || !type || distanceTo(corner, type, position.x, position.y) > REACH) {
        if (retry || !corner) toStore.push(entity)
        continue
      }
      unloading.push(entity)
      continue
    }

    const corner = world.get(mine, Position)!
    const distance = distanceTo(corner, world.get(mine, Building)!.type, position.x, position.y)
    if (distance === 0 || distance > REACH) {
      hauler.loading = false
      if (retry) toMine.push(entity)
      continue
    }
    const queue = docked.get(mine)
    if (queue) queue.push(entity)
    else docked.set(mine, [entity])
  }

  // Шахта грузит одного: того, кого уже грузила, иначе первого из ждущих.
  for (const [mine, trucks] of docked) {
    const truck = trucks.find((entity) => world.get(entity, Hauler)!.loading) ?? trucks[0]
    const hauler = world.get(truck, Hauler)!
    const { x, y } = world.get(mine, Position)!
    hauler.loading = true
    hauler.ore += takeOre(sim, x, y, Math.min(specOf(sim, mine)!.extract! * time.step, TRUCK_CAPACITY - hauler.ore))
    const spent = oreLeft(sim, x, y) <= 0
    if (hauler.ore >= TRUCK_CAPACITY - 1e-9 || (spent && hauler.ore > 0)) {
      hauler.ore = Math.min(hauler.ore, TRUCK_CAPACITY)
      hauler.full = true
      hauler.loading = false
      toStore.push(truck)
    } else if (spent) {
      // Месторождение выработано, а везти нечего.
      for (const entity of trucks) releaseHauler(sim, entity)
    }
  }

  for (const truck of unloading) {
    const hauler = world.get(truck, Hauler)!
    const store = world.get(hauler.store as Entity, Building)!
    const room = (BUILDINGS[store.type] as BuildingSpec).stores! - store.ore
    const amount = Math.max(0, Math.min(UNLOAD_RATE * time.step, hauler.ore, room))
    store.ore += amount
    hauler.ore -= amount
    if (hauler.ore <= 1e-9) {
      hauler.ore = 0
      hauler.full = false
      hauler.store = NONE
      if (hauler.mine !== NONE) toMine.push(truck)
    } else if (room <= 0 && (time.tick + truck) % RETRY_TICKS === 0) {
      // Хранилище полно: может быть, место появилось в другом.
      toStore.push(truck)
    }
  }

  for (const truck of toStore) {
    const hauler = world.get(truck, Hauler)!
    const store = pickStore(sim, truck, world.get(truck, Owner)!.player)
    const changed = store !== hauler.store
    hauler.store = store
    if (store === NONE) continue
    const position = world.get(truck, Position)!
    const near = distanceTo(world.get(store, Position)!, world.get(store, Building)!.type, position.x, position.y)
    if (changed || near === 0 || near > REACH) approach(sim, truck, store, new Set())
  }
  for (const truck of toMine) approach(sim, truck, world.get(truck, Hauler)!.mine as Entity, new Set())
}
