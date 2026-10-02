import type { Entity } from '../ecs'
import { ORE_PRICE, buildingSpec, isReady } from './buildings'
import { NONE, nearest, onTurn } from './common'
import { Building, Converting, Hauler, Inventory, Owner, Path, Position, Trade } from './components'
import { addCredits } from './economy'
import { amountOf, roomFor, take } from './inventory'
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
    const inventory = sim.world.get(entity, Inventory)
    if (!inventory || !buildingSpec(sim.world.get(entity, Building)!.type).stores) continue
    ore += amountOf(inventory, 'ore')
    capacity += inventory.capacity
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

/** Свой готовый космопорт игрока. */
function isPort(sim: Sim, player: number, port: Entity) {
  const type = sim.world.get(port, Building)?.type
  return type !== undefined && !!buildingSpec(type).trades && isReady(sim, player, port)
}

/** Может ли игрок продавать через это здание: это его готовый космопорт, и он не занят прошлой заявкой. */
export const canSell = (sim: Sim, player: number, port: Entity) => isPort(sim, player, port) && !sim.world.has(port, Trade)

/** Сколько руды грузовики уже привезли в космопорт: она лежит в его складе. */
export const deliveredTo = (sim: Sim, port: Entity) => {
  const inventory = sim.world.get(port, Inventory)
  return inventory ? amountOf(inventory, 'ore') : 0
}

/** Сколько руды заявке космопорта ещё не хватает и никто не везёт. */
export function neededBy(sim: Sim, port: Entity) {
  const order = sim.world.get(port, Trade)
  return order ? Math.max(0, order.wanted - deliveredTo(sim, port) - order.claimed) : 0
}

/**
 * Заявка на продажу до amount руды. Руда остаётся в хранилищах зоны космопорта, пока её не привезут: космопорт
 * зовёт свободные грузовики, и те свозят её к нему. Когда привезено всё, корабль улетает и через
 * SELL_SECONDS приносит кредиты. Продаётся целое число единиц и не больше, чем помещается в трюм космопорта.
 * Пока заявка не закрыта, новую космопорт не берёт.
 */
export function sellOre(sim: Sim, player: number, port: Entity, amount: number) {
  if (!Number.isFinite(amount) || amount < 1 || !canSell(sim, player, port)) return false
  const zone = zoneWith(sim, player, port)
  if (!zone) return false
  const hold = sim.world.get(port, Inventory)
  const wanted = Math.min(Math.floor(amount), Math.floor(stockOfZone(sim, zone).ore), hold ? Math.floor(roomFor(hold, 'ore')) : 0)
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
  const delivered = deliveredTo(sim, port)
  if (delivered < 1e-9) world.remove(port, Trade)
  else order.wanted = delivered
  return true
}

/**
 * Раз в тик: космопорты с открытой заявкой зовут свободные грузовики, корабли с полным грузом улетают,
 * а за долетевшие платят.
 */
export function trade(sim: Sim) {
  const { world, time } = sim
  const done: { port: Entity; player: number }[] = []
  /** Заявки, которым нужны ещё грузовики. */
  const calling: { port: Entity; player: number; x: number; y: number }[] = []
  for (const [entity, order, owner, position] of world.query(Trade, Owner, Position)) {
    if (order.total > 0) {
      if (--order.left <= 0) done.push({ port: entity, player: owner.player })
    } else if (deliveredTo(sim, entity) >= order.wanted - 1e-9) {
      order.left = order.total = Math.round(SELL_SECONDS / time.step)
    } else if (onTurn(time, entity, CALL_TICKS) && neededBy(sim, entity) > 1e-9) {
      calling.push({ port: entity, player: owner.player, x: position.x, y: position.y })
    }
  }
  // Состав мира меняется после обхода.
  // Корабль улетает с тем, что лежит в трюме.
  for (const { port, player } of done) {
    world.remove(port, Trade)
    const hold = world.get(port, Inventory)
    const ore = hold ? take(hold, 'ore', Infinity) : 0
    addCredits(sim, player, Math.round(ore * ORE_PRICE))
  }
  if (!calling.length) return

  // Свободный грузовик: ни к чему не привязан, пуст и стоит.
  const free: { truck: Entity; player: number; x: number; y: number }[] = []
  for (const [entity, hauler, position, owner, cargo] of world.query(Hauler, Position, Owner, Inventory)) {
    if (hauler.mine !== NONE || hauler.port !== NONE || amountOf(cargo, 'ore') > 0) continue
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
