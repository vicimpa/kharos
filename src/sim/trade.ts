import type { Entity } from '../ecs'
import { ORE_PRICE, buildingSpec, isReady } from './buildings'
import { NONE, nearest, onTurn } from './common'
import { Building, Converting, Hauler, Owner, Path, Position, Trade } from './components'
import { addCredits } from './economy'
import type { Sim } from './sim'
import { zonesOf, type Zone } from './zones'

/** Сколько секунд проходит от погрузки последней руды до денег: столько летит корабль. */
export const SELL_SECONDS = 20
/** Раз во сколько тиков космопорт зовёт свободные грузовики. */
const CALL_TICKS = 20

/** Зона строительства игрока, в которой стоит это готовое здание; undefined — оно ни в какую не входит. */
export const zoneWith = (sim: Sim, player: number, building: Entity): Zone | undefined =>
  zonesOf(sim, player).find((zone) => zone.buildings.includes(building))

/** Сколько руды лежит в хранилищах зоны и сколько в них помещается всего. */
export function stockOfZone(sim: Sim, zone: Zone) {
  let ore = 0
  let capacity = 0
  for (const entity of zone.buildings) {
    const building = sim.world.get(entity, Building)!
    const stores = buildingSpec(building.type).stores
    if (!stores) continue
    ore += building.ore
    capacity += stores
  }
  return { ore, capacity }
}

/** Запас руды игрока по всем его зонам. */
export function stockOf(sim: Sim, player: number) {
  const total = { ore: 0, capacity: 0 }
  for (const zone of zonesOf(sim, player)) {
    const { ore, capacity } = stockOfZone(sim, zone)
    total.ore += ore
    total.capacity += capacity
  }
  return total
}

/** Кладёт руду в хранилища зоны, пока в них есть место. Возвращает, сколько поместилось. */
export function storeOre(sim: Sim, zone: Zone, amount: number) {
  let left = amount
  for (const entity of zone.buildings) {
    if (left <= 0) break
    const building = sim.world.get(entity, Building)!
    const stores = buildingSpec(building.type).stores
    if (!stores) continue
    const put = Math.min(left, stores - building.ore)
    building.ore += put
    left -= put
  }
  return amount - left
}

/** Свой готовый космопорт игрока. */
function isPort(sim: Sim, player: number, port: Entity) {
  const type = sim.world.get(port, Building)?.type
  return type !== undefined && !!buildingSpec(type).trades && isReady(sim, player, port)
}

/** Может ли игрок продавать через это здание: это его готовый космопорт, и он не занят прошлой заявкой. */
export const canSell = (sim: Sim, player: number, port: Entity) => isPort(sim, player, port) && !sim.world.has(port, Trade)

/** Сколько руды заявке ещё не хватает и никто не везёт. */
export const neededBy = (order: { wanted: number; delivered: number; claimed: number }) =>
  Math.max(0, order.wanted - order.delivered - order.claimed)

/**
 * Заявка на продажу до amount руды. Руда остаётся в хранилищах зоны космопорта, пока её не привезут: космопорт
 * зовёт свободные грузовики, и те свозят её к его коннектору. Когда привезено всё, корабль улетает и через
 * SELL_SECONDS приносит кредиты. Продаётся целое число единиц. Пока заявка не закрыта, новую космопорт не берёт.
 */
export function sellOre(sim: Sim, player: number, port: Entity, amount: number) {
  if (!Number.isFinite(amount) || amount < 1 || !canSell(sim, player, port)) return false
  const zone = zoneWith(sim, player, port)
  if (!zone) return false
  const wanted = Math.min(Math.floor(amount), Math.floor(stockOfZone(sim, zone).ore))
  if (wanted < 1) return false
  sim.world.add(port, Trade({ wanted }))
  return true
}

/**
 * Закрывает заявку раньше срока: корабль улетает с тем, что уже привезли, а если не привезли ничего — заявка
 * просто снимается. Улетевший корабль не вернуть.
 */
export function closeSale(sim: Sim, player: number, port: Entity) {
  const { world } = sim
  const order = world.get(port, Trade)
  if (!order || order.total > 0 || !isPort(sim, player, port)) return false
  if (order.delivered < 1e-9) world.remove(port, Trade)
  else order.wanted = order.delivered
  return true
}

/**
 * Раз в тик: космопорты с открытой заявкой зовут свободные грузовики, корабли с полным грузом улетают,
 * а за долетевшие платят.
 */
export function trade(sim: Sim) {
  const { world, time } = sim
  const done: { port: Entity; player: number; ore: number }[] = []
  /** Заявки, которым нужны ещё грузовики. */
  const calling: { port: Entity; player: number; x: number; y: number }[] = []
  for (const [entity, order, owner, position] of world.query(Trade, Owner, Position)) {
    if (order.total > 0) {
      if (--order.left <= 0) done.push({ port: entity, player: owner.player, ore: order.delivered })
    } else if (order.delivered >= order.wanted - 1e-9) {
      order.left = order.total = Math.round(SELL_SECONDS / time.step)
    } else if (onTurn(time, entity, CALL_TICKS) && neededBy(order) > 1e-9) {
      calling.push({ port: entity, player: owner.player, x: position.x, y: position.y })
    }
  }
  // Состав мира меняется после обхода.
  for (const { port, player, ore } of done) {
    world.remove(port, Trade)
    addCredits(sim, player, Math.round(ore * ORE_PRICE))
  }
  if (!calling.length) return

  // Свободный грузовик: ни к чему не привязан, пуст и стоит.
  const free: { truck: Entity; player: number; x: number; y: number }[] = []
  for (const [entity, hauler, position, owner] of world.query(Hauler, Position, Owner)) {
    if (hauler.mine !== NONE || hauler.port !== NONE || hauler.ore > 0) continue
    if (world.has(entity, Path) || world.has(entity, Converting)) continue
    free.push({ truck: entity, player: owner.player, x: position.x, y: position.y })
  }
  for (const { port, player, x, y } of calling) {
    // За один зов — ближайший свободный грузовик: следующему, если руды осталось, достанется следующий зов.
    const best = nearest(free, (truck) => (truck.player === player ? Math.hypot(truck.x - x, truck.y - y) : Infinity))
    if (!best) continue
    world.get(best.truck, Hauler)!.port = port
    free.splice(free.indexOf(best), 1)
  }
}
