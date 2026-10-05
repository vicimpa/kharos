import type { Entity, Time } from '../ecs'
import { buildingSpec } from './buildings'
import { Building, Inventory, Site } from './components'
import { powerSupply } from './income'
import { amountOf, put, roomFor, take } from './inventory'
import { resourceOf } from './resources'
import type { Sim } from './sim'

/**
 * Сколько руды переработка принимает в секунду. Шахта металла даёт 1/с, кремния — 1/с,
 * топлива — 0,8/с: одного завода хватает примерно на полторы шахты металла, и это делает место завода
 * между шахтами и хранилищем решением игрока (§5 этапа 3).
 */
export const REFINE_RATE = 1.5
/** Сколько руды уходит на единицу готового ресурса. Один к одному, пока замеры харнесса не скажут иначе. */
export const REFINE_RATIO = 1
const EPSILON = 1e-9

/**
 * Раз в тик: переработка превращает свою руду со склада в её ресурс со скоростью REFINE_RATE, а готовое кладёт,
 * только пока под него есть место: потерять руду нельзя. При нехватке энергии завод работает медленнее.
 */
export function refine(sim: Sim, time: Time) {
  const { world } = sim
  const working: Entity[] = []
  for (const [entity, building, inventory] of world.query(Building, Inventory)) {
    const ore = buildingSpec(building.type).refines
    if (!ore || world.has(entity, Site)) continue
    if (amountOf(inventory, ore) > EPSILON) working.push(entity)
  }
  if (!working.length) return
  // Считается недёшево, поэтому только когда есть что перерабатывать, и один раз за тик.
  const supply = powerSupply(sim)
  for (const entity of working) {
    const inventory = world.get(entity, Inventory)!
    const ore = buildingSpec(world.get(entity, Building)!.type).refines!
    const product = resourceOf(ore)
    const wanted = Math.min(REFINE_RATE * time.step * (supply.get(entity) ?? 0), amountOf(inventory, ore))
    // Готовому некуда лечь — завод стоит, пока грузовики не развезут его.
    const taken = Math.min(wanted, roomFor(inventory, product) * REFINE_RATIO)
    if (taken > EPSILON) put(inventory, product, take(inventory, ore, taken) / REFINE_RATIO)
  }
}
