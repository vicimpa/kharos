import type { Entity } from '../ecs'
import { BUILDINGS, ORE_PRICE, type BuildingSpec } from './buildings'
import { Building, Owner, Site, Trade } from './components'
import { addCredits } from './economy'
import type { Sim } from './sim'
import { zonesOf, type Zone } from './zones'

/** Сколько секунд проходит от заявки на продажу до денег: столько летит корабль с рудой. */
export const SELL_SECONDS = 20

/** Зона строительства игрока, в которой стоит это готовое здание; undefined — оно ни в какую не входит. */
export const zoneWith = (sim: Sim, player: number, building: Entity): Zone | undefined =>
  zonesOf(sim, player).find((zone) => zone.buildings.includes(building))

/** Сколько руды лежит в хранилищах зоны и сколько в них помещается всего. */
export function stockOfZone(sim: Sim, zone: Zone) {
  let ore = 0
  let capacity = 0
  for (const entity of zone.buildings) {
    const building = sim.world.get(entity, Building)!
    const stores = (BUILDINGS[building.type] as BuildingSpec).stores
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
    const stores = (BUILDINGS[building.type] as BuildingSpec).stores
    if (!stores) continue
    const put = Math.min(left, stores - building.ore)
    building.ore += put
    left -= put
  }
  return amount - left
}

/** Забирает руду из хранилищ зоны. Возвращает, сколько удалось забрать. */
function takeStock(sim: Sim, zone: Zone, amount: number) {
  let left = amount
  for (const entity of zone.buildings) {
    if (left <= 0) break
    const building = sim.world.get(entity, Building)!
    if (!(BUILDINGS[building.type] as BuildingSpec).stores) continue
    const taken = Math.min(left, building.ore)
    building.ore -= taken
    left -= taken
  }
  return amount - left
}

/** Может ли игрок продавать через это здание: это его готовый космопорт, и он не занят прошлой заявкой. */
export function canSell(sim: Sim, player: number, port: Entity) {
  const { world } = sim
  const type = world.get(port, Building)?.type
  if (type === undefined || !(BUILDINGS[type] as BuildingSpec).trades) return false
  return world.get(port, Owner)?.player === player && !world.has(port, Site) && !world.has(port, Trade)
}

/**
 * Заявка на продажу: космопорт забирает до amount руды из хранилищ своей зоны строительства и через SELL_SECONDS
 * приносит за неё кредиты. Продаётся целое число единиц. Пока заявка в пути, новую космопорт не берёт.
 */
export function sellOre(sim: Sim, player: number, port: Entity, amount: number) {
  if (!Number.isFinite(amount) || amount < 1 || !canSell(sim, player, port)) return false
  const zone = zoneWith(sim, player, port)
  if (!zone) return false
  const wanted = Math.min(Math.floor(amount), Math.floor(stockOfZone(sim, zone).ore))
  if (wanted < 1) return false
  const ore = takeStock(sim, zone, wanted)
  const ticks = Math.round(SELL_SECONDS / sim.time.step)
  sim.world.add(port, Trade({ ore, left: ticks, total: ticks }))
  return true
}

/** Раз в тик: продвигает заявки на продажу и платит за те, что дошли. */
export function trade(sim: Sim) {
  const { world } = sim
  const done: { port: Entity; player: number; ore: number }[] = []
  for (const [entity, order, owner] of world.query(Trade, Owner)) {
    if (--order.left <= 0) done.push({ port: entity, player: owner.player, ore: order.ore })
  }
  // Состав мира меняется после обхода.
  for (const { port, player, ore } of done) {
    world.remove(port, Trade)
    addCredits(sim, player, Math.round(ore * ORE_PRICE))
  }
}
