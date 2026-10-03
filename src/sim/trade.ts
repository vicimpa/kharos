import type { Entity } from '../ecs'
import { buildingSpec, isReady } from './buildings'
import { Building, Inventory, Owner, Trade } from './components'
import { addCredits } from './economy'
import { amountOf, roomFor, take } from './inventory'
import { incomingTo } from './logistics'
import { RESOURCES, RESOURCE_SPECS, type Amounts, type Resource } from './resources'
import type { Sim } from './sim'
import { zonesOf, type Zone } from './zones'

/** Сколько секунд проходит от погрузки последнего груза до денег: столько летит корабль. */
export const SELL_SECONDS = 20

/** Зона строительства игрока, в которой стоит это готовое здание; undefined — оно ни в какую не входит. */
export const zoneWith = (sim: Sim, player: number, building: Entity): Zone | undefined =>
  zonesOf(sim, player).find((zone) => zone.buildings.includes(building))

/** Хранилище ли это: его склад входит в запас игрока, туда свозят добытое и оттуда берут на нужды зоны. */
export const isStore = (sim: Sim, entity: Entity) => {
  const type = sim.world.get(entity, Building)?.type
  return type !== undefined && !!buildingSpec(type).stores
}

/** Что лежит в хранилищах зоны и сколько в них помещается всего. */
export function stockOfZone(sim: Sim, zone: Zone) {
  const items: Amounts = {}
  let capacity = 0
  for (const entity of zone.buildings) {
    const inventory = sim.world.get(entity, Inventory)
    if (!inventory || !isStore(sim, entity)) continue
    for (const resource of RESOURCES) {
      const amount = amountOf(inventory, resource)
      if (amount > 0) items[resource] = (items[resource] ?? 0) + amount
    }
    capacity += inventory.capacity
  }
  return { items, capacity }
}

/** Запас игрока по всем его зонам. */
export function stockOf(sim: Sim, player: number) {
  const items: Amounts = {}
  let capacity = 0
  for (const zone of zonesOf(sim, player)) {
    const stock = stockOfZone(sim, zone)
    for (const [resource, amount] of Object.entries(stock.items) as [Resource, number][]) items[resource] = (items[resource] ?? 0) + amount
    capacity += stock.capacity
  }
  return { items, capacity }
}

/** Свой готовый космопорт игрока. */
function isPort(sim: Sim, player: number, port: Entity) {
  const type = sim.world.get(port, Building)?.type
  return type !== undefined && !!buildingSpec(type).trades && isReady(sim, player, port)
}

/** Может ли игрок продавать через это здание: это его готовый космопорт, и он не занят прошлой заявкой. */
export const canSell = (sim: Sim, player: number, port: Entity) => isPort(sim, player, port) && !sim.world.has(port, Trade)

/** Сколько товара заявки грузовики уже привезли в космопорт: он лежит в его складе. */
export function deliveredTo(sim: Sim, port: Entity) {
  const order = sim.world.get(port, Trade)
  const inventory = sim.world.get(port, Inventory)
  return order && inventory ? Math.min(order.wanted, amountOf(inventory, order.resource)) : 0
}

/** Сколько товара заявке космопорта ещё не хватает и никто не везёт. */
export function neededBy(sim: Sim, port: Entity) {
  const order = sim.world.get(port, Trade)
  if (!order || order.total > 0) return 0
  return Math.max(0, order.wanted - deliveredTo(sim, port) - incomingTo(sim, port, order.resource))
}

/**
 * Заявка на продажу до amount единиц ресурса. Товар остаётся в хранилищах зоны космопорта, пока его не привезут:
 * космопорт заказывает его, и свободные грузовики свозят его к нему (см. logistics.ts). Когда привезено всё,
 * корабль улетает и через SELL_SECONDS приносит кредиты по цене ресурса. Продаётся целое число единиц и не больше,
 * чем помещается в трюм космопорта. Пока заявка не закрыта, новую космопорт не берёт.
 */
export function sell(sim: Sim, player: number, port: Entity, resource: Resource, amount: number) {
  if (!Object.hasOwn(RESOURCE_SPECS, resource)) return false
  if (!Number.isFinite(amount) || amount < 1 || !canSell(sim, player, port)) return false
  const zone = zoneWith(sim, player, port)
  if (!zone) return false
  const hold = sim.world.get(port, Inventory)
  const room = hold ? amountOf(hold, resource) + roomFor(hold, resource) : 0
  const wanted = Math.min(Math.floor(amount), Math.floor(stockOfZone(sim, zone).items[resource] ?? 0), Math.floor(room))
  if (wanted < 1) return false
  sim.world.add(port, Trade({ resource, wanted }))
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

/** Раз в тик: корабли с полным грузом улетают, а за долетевшие платят. */
export function trade(sim: Sim) {
  const { world, time } = sim
  const done: { port: Entity; player: number }[] = []
  for (const [entity, order, owner] of world.query(Trade, Owner)) {
    if (order.total > 0) {
      if (--order.left <= 0) done.push({ port: entity, player: owner.player })
    } else if (deliveredTo(sim, entity) >= order.wanted - 1e-9) {
      order.left = order.total = Math.round(SELL_SECONDS / time.step)
    }
  }
  // Корабль улетает с товаром заявки; остальное в складе космопорта остаётся.
  for (const { port, player } of done) {
    const order = world.get(port, Trade)!
    const hold = world.get(port, Inventory)
    const sold = hold ? take(hold, order.resource, order.wanted) : 0
    world.remove(port, Trade)
    addCredits(sim, player, Math.round(sold * RESOURCE_SPECS[order.resource].price))
  }
}
