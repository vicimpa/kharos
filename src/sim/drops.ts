import type { Entity } from '../ecs'
import { BUILDINGS } from './buildings'
import { Building, Drop, Inventory, Position, Site, Unit } from './components'
import { amountOf, loadOf } from './inventory'
import { GOODS, type Amounts } from './resources'
import type { Sim } from './sim'

/**
 * Дроп — груз, брошенный на землю: что лежало на складе разрушенного или разобранного здания, в кузове погибшей
 * машины, на отменённой стройке. Это склад без здания на одном тайле и без хозяина: подобрать его может любой
 * грузовик, а свободные везут его в хранилище, руду — на переработку (см. logistics.ts). Пустой дроп исчезает,
 * а стройка или развёрнутый MCV поверх дропа его уничтожают.
 */

const EPSILON = 1e-9

/** Дроп на тайле или undefined. Дропов немного, поэтому простой перебор. */
export function dropAt(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position] of sim.world.query(Position, Drop)) if (position.x === x && position.y === y) return entity
  return undefined
}

/** Бросает груз на тайл (x, y): к дропу, который уже там лежит, или новым дропом. Пустое не бросают. */
export function dropItems(sim: Sim, x: number, y: number, items: Amounts) {
  const goods = GOODS.filter((good) => (items[good] ?? 0) > EPSILON)
  if (!goods.length) return undefined
  const { world } = sim
  const tileX = Math.floor(x)
  const tileY = Math.floor(y)
  const drop = dropAt(sim, tileX, tileY) ?? world.spawn(Position({ x: tileX, y: tileY }), Drop, Inventory())
  const inventory = world.get(drop, Inventory)!
  for (const good of goods) inventory.items[good] = amountOf(inventory, good) + items[good]!
  // Дроп принимает только то, что на него бросили: места ровно под груз.
  inventory.capacity = loadOf(inventory)
  return drop
}

/** Бросает весь груз сущности на землю под ней: у здания — на тайл в середине основания, у юнита — на его тайл. */
export function dropCargo(sim: Sim, entity: Entity) {
  const { world } = sim
  const inventory = world.get(entity, Inventory)
  const position = world.get(entity, Position)
  if (!inventory || !position || world.has(entity, Drop)) return
  const type = world.get(entity, Building)?.type ?? (world.has(entity, Unit) ? undefined : world.get(entity, Site)?.type)
  const { width, height } = type === undefined ? { width: 0, height: 0 } : BUILDINGS[type]
  dropItems(sim, position.x + Math.floor(width / 2), position.y + Math.floor(height / 2), inventory.items)
}

/** Уничтожает дропы под основанием, на котором встаёт здание. */
export function clearDrops(sim: Sim, x: number, y: number, width: number, height: number) {
  const gone: Entity[] = []
  for (const [entity, position] of sim.world.query(Position, Drop)) {
    if (position.x >= x && position.x < x + width && position.y >= y && position.y < y + height) gone.push(entity)
  }
  for (const entity of gone) sim.world.destroy(entity)
}

/** Раз в тик: пустые дропы исчезают. */
export function sweepDrops(sim: Sim) {
  const gone: Entity[] = []
  for (const [entity, , , inventory] of sim.world.query(Position, Drop, Inventory)) if (loadOf(inventory) <= EPSILON) gone.push(entity)
  for (const entity of gone) sim.world.destroy(entity)
}
