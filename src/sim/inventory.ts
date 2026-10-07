import type { Entity, World } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDINGS, siteAt } from './buildings'
import { Beam, Building, Drop, Inventory, Position, Unit } from './components'
import { GOODS, type Amounts, type Good } from './resources'
import type { Sim } from './sim'
import { UNITS, isWalkable, orderMove, standingUnits } from './units'

/** Транспортный луч вида здания или юнита: см. компонент Beam. */
export interface BeamSpec {
  radius: number
  rate: number
  give?: boolean
  take?: boolean
}

type Stock = { items: Amounts; capacity: number; accepts: readonly Good[]; limits: Amounts }

/** Сколько этого груза лежит на складе. */
export const amountOf = (inventory: Stock, resource: Good) => inventory.items[resource] ?? 0

/** Сколько лежит на складе всего, любого груза вместе, вместе с рудой. */
export const loadOf = (inventory: Stock) => GOODS.reduce((sum, resource) => sum + amountOf(inventory, resource), 0)

/** Сколько этого груза ещё поместится на склад; ноль — склад полон, такое сюда не кладут или его предел набран. */
export function roomFor(inventory: Stock, resource: Good) {
  if (inventory.accepts.length && !inventory.accepts.includes(resource)) return 0
  const limit = inventory.limits[resource]
  const left = limit === undefined ? Infinity : limit - amountOf(inventory, resource)
  return Math.max(0, Math.min(left, inventory.capacity - loadOf(inventory)))
}

/** Кладёт на склад до amount груза, сколько поместится. Возвращает, сколько положено. */
export function put(inventory: Stock, resource: Good, amount: number) {
  const moved = Math.max(0, Math.min(amount, roomFor(inventory, resource)))
  if (moved) inventory.items[resource] = amountOf(inventory, resource) + moved
  return moved
}

/** Забирает со склада до amount груза, сколько есть. Возвращает, сколько забрано. */
export function take(inventory: Stock, resource: Good, amount: number) {
  const moved = Math.max(0, Math.min(amount, amountOf(inventory, resource)))
  if (moved) inventory.items[resource] = amountOf(inventory, resource) - moved
  return moved
}

/** Склад и луч вида здания или юнита: capacity — объём, accepts и limits — что и сколько каждого сюда кладут. */
export interface StorageSpec {
  inventory?: number
  accepts?: readonly Good[]
  limits?: Amounts
  beam?: BeamSpec
}

/** Даёт сущности склад и луч, положенные её виду. */
export function equipStorage(world: World, entity: Entity, spec: StorageSpec) {
  if (spec.inventory) world.add(entity, Inventory({ capacity: spec.inventory, accepts: spec.accepts ?? [], limits: spec.limits ?? {} }))
  if (spec.beam) world.add(entity, Beam({ radius: spec.beam.radius, rate: spec.beam.rate, give: !!spec.beam.give, take: !!spec.beam.take }))
}

/** Что сущность занимает на карте: основание здания (width, height) или круг юнита (radius) с центром в (x, y). */
function shapeOf(sim: Sim, entity: Entity) {
  const { world } = sim
  const position = world.get(entity, Position)
  if (!position) return undefined
  const building = world.get(entity, Building)
  if (building) return { x: position.x, y: position.y, width: BUILDINGS[building.type].width, height: BUILDINGS[building.type].height, radius: 0 }
  // Дроп лежит на своём тайле.
  if (world.has(entity, Drop)) return { x: position.x, y: position.y, width: 1, height: 1, radius: 0 }
  const unit = world.get(entity, Unit)
  return { x: position.x, y: position.y, width: 0, height: 0, radius: unit ? UNITS[unit.type].radius : 0 }
}

/** Расстояние между краями двух сущностей в тайлах; вплотную и внахлёст — ноль. */
export function gapBetween(sim: Sim, a: Entity, b: Entity) {
  const one = shapeOf(sim, a)
  const two = shapeOf(sim, b)
  if (!one || !two) return Infinity
  const dx = Math.max(0, one.x - two.x - two.width, two.x - one.x - one.width)
  const dy = Math.max(0, one.y - two.y - two.height, two.y - one.y - one.height)
  return Math.max(0, Math.hypot(dx, dy) - one.radius - two.radius)
}

/**
 * Чей луч перенесёт ресурс со склада from на склад to: луч from, который умеет отдавать, или луч to, который
 * умеет забирать. Если годятся оба — тот, что дальше дотягивается. undefined — такого луча нет ни у кого.
 */
export function beamFor(sim: Sim, from: Entity, to: Entity): Entity | undefined {
  const { world } = sim
  if (!world.has(from, Inventory) || !world.has(to, Inventory)) return undefined
  const giving = world.get(from, Beam)
  const taking = world.get(to, Beam)
  const candidates = [giving?.give ? from : undefined, taking?.take ? to : undefined].filter((entity) => entity !== undefined)
  return candidates.sort((a, b) => world.get(b, Beam)!.radius - world.get(a, Beam)!.radius)[0]
}

/** Дотягивается ли луч, который перенёс бы ресурс со склада from на склад to. */
export function reaches(sim: Sim, from: Entity, to: Entity) {
  const beam = beamFor(sim, from, to)
  return beam !== undefined && gapBetween(sim, from, to) <= sim.world.get(beam, Beam)!.radius
}

/**
 * Переносит лучом до amount ресурса со склада from на склад to, если луч дотягивается. Очереди нет: один луч
 * за тик может работать с любым числом складов, каждый получает до rate в секунду. Возвращает, сколько перенесено.
 */
export function transfer(sim: Sim, from: Entity, to: Entity, resource: Good, amount = Infinity) {
  const { world, time } = sim
  const carrier = beamFor(sim, from, to)
  if (carrier === undefined) return 0
  const beam = world.get(carrier, Beam)!
  const partner = carrier === from ? to : from
  if (gapBetween(sim, from, to) > beam.radius) return 0
  const source = world.get(from, Inventory)!
  const target = world.get(to, Inventory)!
  const moved = Math.min(amount, beam.rate * time.step, amountOf(source, resource), roomFor(target, resource))
  if (moved <= 0) return 0
  const pulling = carrier === to
  if (!beam.links.some((link) => link.target === partner && link.pulling === pulling)) beam.links.push({ target: partner, pulling, resource })
  put(target, resource, take(source, resource, moved))
  return moved
}

/** В начале тика лучи забывают, с кем работали в прошлом: клиент рисует только нынешние. */
export function resetBeams(sim: Sim) {
  for (const [, beam] of sim.world.query(Beam)) beam.links.length = 0
}

/** На сколько тайлов ближе радиуса луча встаёт подъезжающий к нему: с запасом на неточную остановку. */
const APPROACH_MARGIN = 0.5

/**
 * Подводит юнит к зданию (или дропу) так, чтобы между ними дотянулся луч длиной radius: на ближайший к юниту свободный тайл,
 * откуда хватает. Вплотную ему не нужно. Возвращает, нашлось ли такое место.
 */
export function approach(sim: Sim, entity: Entity, building: Entity, radius: number) {
  const { world } = sim
  const position = world.get(entity, Position)
  const unit = world.get(entity, Unit)
  const at = world.get(building, Position)
  const type = world.get(building, Building)?.type
  if (!position || !unit || !at || (type === undefined && !world.has(building, Drop))) return false
  const { width, height } = type === undefined ? { width: 1, height: 1 } : BUILDINGS[type]
  const size = UNITS[unit.type].radius
  const reach = Math.max(0, radius - APPROACH_MARGIN)
  const taken = standingUnits(sim, new Set([entity]), size)
  const span = Math.ceil(reach + size)
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  for (let y = at.y - span; y < at.y + height + span; y++) {
    for (let x = at.x - span; x < at.x + width + span; x++) {
      const distance = Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y)
      if (distance >= bestDistance) continue
      const dx = Math.max(0, at.x - x - 0.5, x + 0.5 - at.x - width)
      const dy = Math.max(0, at.y - y - 0.5, y + 0.5 - at.y - height)
      if (Math.hypot(dx, dy) - size > reach) continue
      if (taken.has(tileKey(x, y)) || !isWalkable(sim, x, y) || siteAt(sim, x, y) !== undefined) continue
      best = { x, y }
      bestDistance = distance
    }
  }
  if (!best) return false
  orderMove(sim, entity, best.x, best.y)
  return true
}
