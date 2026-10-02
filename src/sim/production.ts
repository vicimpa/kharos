import type { Entity, Time } from '../ecs'
import { BUILDINGS } from './buildings'
import { Building, Converting, Owner, Position, Producer, Unit } from './components'
import { addCredits, pay, reward } from './economy'
import type { Sim } from './sim'
import { UNITS, freeTilesNear, spawnUnit, type UnitType } from './units'

/** Кого производят MCV и главное здание. */
export const PRODUCIBLE: UnitType[] = ['builder', 'infantry']
/** Сколько заказов помещается в очередь. */
export const QUEUE_LIMIT = 5

/** Среди скольких ближайших тайлов ищется свободный выход для готового юнита. */
const EXIT_CANDIDATES = 24

const isProducible = (unit: unknown): unit is UnitType => PRODUCIBLE.includes(unit as UnitType)

/** Сколько тиков строится юнит. */
export const buildTicks = (unit: UnitType, step: number) => Math.round(UNITS[unit].buildTime / step)

/** Заказывает юнит. Кредиты списываются сразу. Возвращает, принят ли заказ. */
export function orderUnit(sim: Sim, player: number, entity: Entity, unit: UnitType) {
  const producer = sim.world.get(entity, Producer)
  if (!producer || sim.world.get(entity, Owner)?.player !== player) return false
  if (!isProducible(unit) || producer.queue.length >= QUEUE_LIMIT) return false
  if (!pay(sim, player, UNITS[unit].cost)) return false
  producer.queue.push(unit)
  return true
}

/** Отменяет последний заказ в очереди и возвращает за него кредиты. */
export function cancelUnit(sim: Sim, player: number, entity: Entity) {
  const producer = sim.world.get(entity, Producer)
  if (!producer || sim.world.get(entity, Owner)?.player !== player) return false
  const unit = producer.queue.pop()
  if (!unit) return false
  if (!producer.queue.length) producer.progress = 0
  addCredits(sim, player, UNITS[unit].cost)
  return true
}

/** Тайл, вокруг которого появляются произведённые юниты: центр здания или место машины. */
function exitOf(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const building = sim.world.get(entity, Building)
  if (!building) return { x: Math.floor(position.x), y: Math.floor(position.y) }
  const { width, height } = BUILDINGS[building.type]
  return { x: position.x + Math.floor(width / 2), y: position.y + Math.floor(height / 2) }
}

/** Ближайший к точке проходимый тайл, в котором не стоит другой юнит; сама точка не в счёт. */
function emptyTileNear(sim: Sim, x: number, y: number) {
  const taken = new Set<string>()
  for (const [, position] of sim.world.query(Position, Unit)) taken.add(`${Math.floor(position.x)},${Math.floor(position.y)}`)
  const tiles = freeTilesNear(sim, x, y, EXIT_CANDIDATES, 1)
  for (let i = 0; i < tiles.length; i += 2) {
    if (!taken.has(`${tiles[i]},${tiles[i + 1]}`)) return { x: tiles[i], y: tiles[i + 1] }
  }
  return undefined
}

/** Раз в тик: продвигает производство и выпускает готовых юнитов рядом с производителем. */
export function produceUnits(sim: Sim, time: Time) {
  const { world } = sim
  const ready: Entity[] = []
  for (const [entity, producer] of world.query(Producer)) {
    // Пока здание сворачивается или машина разворачивается, производство стоит.
    if (!producer.queue.length || world.has(entity, Converting)) continue
    const needed = buildTicks(producer.queue[0], time.step)
    if (producer.progress < needed) producer.progress++
    if (producer.progress >= needed) ready.push(entity)
  }

  // Юниты создаются после обхода: во время него состав мира менять нельзя.
  for (const entity of ready) {
    const producer = world.get(entity, Producer)!
    const exit = exitOf(sim, entity)
    const tile = emptyTileNear(sim, exit.x, exit.y)
    // Выйти некуда — готовый юнит ждёт внутри, очередь стоит.
    if (!tile) continue
    const { player } = world.get(entity, Owner)!
    spawnUnit(sim, producer.queue.shift()!, player, tile.x, tile.y)
    reward(sim, player, 'unit')
    producer.progress = 0
  }
}
