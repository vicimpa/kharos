import type { Entity, Time } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDINGS, CORE, buildingSpec, missingBuildings, type BuildingType } from './buildings'
import { isOwn, ownerOf } from './common'
import { Building, Converting, Inventory, Position, Producer, Site, Unit } from './components'
import { addCredits, pay, reward } from './economy'
import { powerSupply } from './income'
import { put, take } from './inventory'
import { missingFor } from './logistics'
import { entriesOf } from './resources'
import type { Sim } from './sim'
import { UNITS, freeTilesNear, orderGroupMove, spawnUnit, unitSpec, type UnitType } from './units'

const NOTHING: UnitType[] = []

/**
 * Кого сейчас производит эта сущность: готовое здание — тех, кто записан в его виде (пехоту — казармы, технику —
 * машинный завод, летающих — космопорт), MCV — тех же, что главное здание. Здание под разбором не производит.
 */
export function producibleBy(sim: Sim, entity: Entity): UnitType[] {
  const { world } = sim
  if (!world.has(entity, Producer) || world.has(entity, Site)) return NOTHING
  const type = world.get(entity, Building)?.type ?? (world.get(entity, Unit)?.type === 'mcv' ? CORE : undefined)
  return (type && buildingSpec(type).produces) || NOTHING
}
/** Каких зданий из требований юнита у игрока нет готовыми: пусто — заказывать можно. */
export const missingRequirements = (sim: Sim, player: number, unit: UnitType): BuildingType[] =>
  missingBuildings(sim, player, unitSpec(unit).requires as readonly BuildingType[] | undefined)

/** Сколько заказов помещается в очередь. */
export const QUEUE_LIMIT = 5

/** Среди скольких ближайших тайлов ищется свободный выход для готового юнита. */
const EXIT_CANDIDATES = 24

/** Сколько тиков строится юнит. */
export const buildTicks = (unit: UnitType, step: number) => Math.round(UNITS[unit].buildTime / step)

/**
 * Заказывает юнит. Кредиты списываются сразу; материалы (UnitSpec.materials) производитель заказывает у своей
 * зоны, когда заказ дойдёт до начала очереди, и тратит их в начале работы. Возвращает, принят ли заказ.
 */
export function orderUnit(sim: Sim, player: number, entity: Entity, unit: UnitType) {
  const producer = sim.world.get(entity, Producer)
  if (!producer || !isOwn(sim, player, entity)) return false
  if (!producibleBy(sim, entity).includes(unit) || producer.queue.length >= QUEUE_LIMIT) return false
  if (missingRequirements(sim, player, unit).length) return false
  if (!pay(sim, player, UNITS[unit].cost)) return false
  producer.queue.push(unit)
  return true
}

/** Отменяет последний заказ в очереди и возвращает за него кредиты. */
export function cancelUnit(sim: Sim, player: number, entity: Entity) {
  const producer = sim.world.get(entity, Producer)
  if (!producer || !isOwn(sim, player, entity)) return false
  const started = producer.queue.length === 1 && producer.progress > 0
  const unit = producer.queue.pop()
  if (!unit) return false
  if (!producer.queue.length) producer.progress = 0
  addCredits(sim, player, UNITS[unit].cost)
  // Начатый заказ уже забрал материалы: они возвращаются на склад производителя.
  const inventory = sim.world.get(entity, Inventory)
  if (started && inventory) for (const [resource, amount] of entriesOf(unitSpec(unit).materials ?? {})) put(inventory, resource, amount)
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
  const taken = new Set<number>()
  for (const [, position] of sim.world.query(Position, Unit)) taken.add(tileKey(Math.floor(position.x), Math.floor(position.y)))
  const tiles = freeTilesNear(sim, x, y, EXIT_CANDIDATES, 1)
  for (let i = 0; i < tiles.length; i += 2) {
    if (!taken.has(tileKey(tiles[i], tiles[i + 1]))) return { x: tiles[i], y: tiles[i + 1] }
  }
  return undefined
}

/** Раз в тик: продвигает производство и выпускает готовых юнитов рядом с производителем. */
export function produceUnits(sim: Sim, time: Time) {
  const { world } = sim
  const ready: Entity[] = []
  // Считается недёшево, поэтому только когда производит здание-потребитель, и один раз за тик.
  let supply: Map<Entity, number> | undefined
  const working: Entity[] = []
  for (const [entity, producer] of world.query(Producer)) {
    if (producer.queue.length) working.push(entity)
  }
  /** Скорость производства: потребителю энергии при её нехватке — доля, вне зоны строительства — ноль. */
  const speedOf = (entity: Entity) => {
    const type = world.get(entity, Building)?.type
    if (!type || (buildingSpec(type).power ?? 0) >= 0) return 1
    return (supply ??= powerSupply(sim)).get(entity) ?? 0
  }
  const speeds = new Map(working.map((entity) => [entity, speedOf(entity)]))
  for (const [entity, producer] of world.query(Producer)) {
    // Пока здание сворачивается, разбирается или машина разворачивается, производство стоит.
    if (!producer.queue.length || world.has(entity, Converting) || world.has(entity, Site)) continue
    const needed = buildTicks(producer.queue[0], time.step)
    if (producer.progress <= 0) {
      // Заказ начинается, когда его материалы на месте, и сразу их тратит.
      if (Object.keys(missingFor(sim, entity)).length) continue
      const materials = entriesOf(unitSpec(producer.queue[0]).materials ?? {})
      const inventory = world.get(entity, Inventory)
      if (inventory) for (const [resource, amount] of materials) take(inventory, resource, amount)
      // Материалы потрачены — заказ начат, даже если энергии сейчас нет.
      if (materials.length) producer.progress = 1e-9
    }
    if (producer.progress < needed) producer.progress += speeds.get(entity) ?? 1
    if (producer.progress >= needed) ready.push(entity)
  }

  // Юниты создаются после обхода: во время него состав мира менять нельзя.
  for (const entity of ready) {
    const producer = world.get(entity, Producer)!
    const exit = exitOf(sim, entity)
    const tile = emptyTileNear(sim, exit.x, exit.y)
    // Выйти некуда — готовый юнит ждёт внутри, очередь стоит.
    if (!tile) continue
    const player = ownerOf(sim, entity)
    const unit = spawnUnit(sim, producer.queue.shift()!, player, tile.x, tile.y)
    // Есть точка сбора — готовый едет туда, на свободное место рядом с ней.
    if (producer.rally.length) orderGroupMove(sim, [unit], producer.rally[0], producer.rally[1])
    reward(sim, player, 'unit')
    producer.progress = 0
  }
}
