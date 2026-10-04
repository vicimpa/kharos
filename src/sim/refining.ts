import type { Entity, Time } from '../ecs'
import { buildingSpec } from './buildings'
import { Building, Inventory, Site } from './components'
import { powerSupply } from './income'
import { amountOf, put, roomFor, take } from './inventory'
import { ORES, resourceOf } from './resources'
import type { Sim } from './sim'

/**
 * Сколько руды переработка принимает в секунду, всех видов вместе. Шахта металла даёт 1/с, кремния — 1/с,
 * топлива — 0,8/с: одного завода хватает примерно на полторы шахты металла, и это делает место завода
 * между шахтами и хранилищем решением игрока (§5 этапа 3).
 */
export const REFINE_RATE = 1.5
/** Сколько руды уходит на единицу готового ресурса. Один к одному, пока замеры харнесса не скажут иначе. */
export const REFINE_RATIO = 1
const EPSILON = 1e-9

/**
 * Раз в тик: переработка превращает руду со своего склада в готовый ресурс. Руда всех видов берётся из общего
 * приёма — REFINE_RATE на всех, — а готовое кладётся, только пока под него есть место: потерять руду нельзя.
 * При нехватке энергии завод работает медленнее, как и производство.
 */
export function refine(sim: Sim, time: Time) {
  const { world } = sim
  const working: Entity[] = []
  for (const [entity, building, inventory] of world.query(Building, Inventory)) {
    if (!buildingSpec(building.type).refines || world.has(entity, Site)) continue
    if (ORES.some((ore) => amountOf(inventory, ore) > EPSILON)) working.push(entity)
  }
  if (!working.length) return
  // Считается недёшево, поэтому только когда есть что перерабатывать, и один раз за тик.
  const supply = powerSupply(sim)
  for (const entity of working) {
    const inventory = world.get(entity, Inventory)!
    let budget = REFINE_RATE * time.step * (supply.get(entity) ?? 0)
    for (const ore of ORES) {
      if (budget <= EPSILON) break
      const product = resourceOf(ore)
      const wanted = Math.min(budget, amountOf(inventory, ore))
      if (wanted <= EPSILON) continue
      // Пропустить ход, когда готовому некуда лечь, — завод встанет до тех пор, пока грузовики не развезут его.
      const taken = Math.min(wanted, roomFor(inventory, product) * REFINE_RATIO)
      if (taken <= EPSILON) continue
      put(inventory, product, take(inventory, ore, taken) / REFINE_RATIO)
      budget -= taken
    }
  }
}
