import type { Entity } from '../ecs'
import { buildingSpec } from './buildings'
import { Building, Crafter, Inventory, Site } from './components'
import { powerSupply } from './income'
import { amountOf, put, roomFor, take } from './inventory'
import { entriesOf } from './resources'
import type { Sim } from './sim'

const EPSILON = 1e-9

/** Что сейчас с перерабатывающим зданием: работает, ждёт сырья, некуда класть готовое или стоит без энергии. */
export type CraftState = 'working' | 'input' | 'full' | 'power'

/** Сколько тиков идёт цикл переработки здания этого вида. */
const cycleTicks = (sim: Sim, entity: Entity) => {
  const type = sim.world.get(entity, Building)!.type
  return Math.max(1, Math.round(buildingSpec(type).recipe!.seconds / sim.time.step))
}

/** Хватит ли на складе сырья на цикл и места под его готовое. */
function canStart(sim: Sim, entity: Entity) {
  const inventory = sim.world.get(entity, Inventory)!
  const { recipe } = buildingSpec(sim.world.get(entity, Building)!.type)
  if (!entriesOf(recipe!.inputs).every(([resource, amount]) => amountOf(inventory, resource) >= amount - EPSILON)) return 'input'
  if (!entriesOf(recipe!.outputs).every(([resource, amount]) => roomFor(inventory, resource) >= amount - EPSILON)) return 'full'
  return undefined
}

/**
 * Раз в тик: перерабатывающие здания (BuildingSpec.recipe) работают. Цикл начинается, когда на складе есть сырьё
 * на него и место под готовое: сырьё сразу списывается, готовое появляется в конце цикла. При нехватке энергии
 * цикл идёт медленнее, вне зоны строительства стоит.
 */
export function craft(sim: Sim) {
  const { world } = sim
  let supply: Map<Entity, number> | undefined
  for (const [entity, crafter, building, inventory] of world.query(Crafter, Building, Inventory)) {
    if (world.has(entity, Site)) continue
    const { recipe } = buildingSpec(building.type)
    if (!recipe) continue
    if (crafter.progress <= 0) {
      if (canStart(sim, entity)) continue
      for (const [resource, amount] of entriesOf(recipe.inputs)) take(inventory, resource, amount)
    }
    crafter.progress += (supply ??= powerSupply(sim)).get(entity) ?? 0
    // Цикл начат, пусть и без энергии: сырьё уже списано.
    crafter.progress = Math.max(crafter.progress, EPSILON)
    if (crafter.progress < cycleTicks(sim, entity)) continue
    for (const [resource, amount] of entriesOf(recipe.outputs)) put(inventory, resource, amount)
    crafter.progress = 0
  }
}

/** Что сейчас с перерабатывающим зданием и как далеко продвинулся цикл, от 0 до 1. */
export function craftStateOf(sim: Sim, entity: Entity): { state: CraftState; progress: number } | undefined {
  const crafter = sim.world.get(entity, Crafter)
  if (!crafter || sim.world.has(entity, Site)) return undefined
  const progress = Math.min(1, crafter.progress / cycleTicks(sim, entity))
  if (crafter.progress <= 0) return { state: canStart(sim, entity) ?? 'working', progress }
  return { state: (powerSupply(sim).get(entity) ?? 0) > 0 ? 'working' : 'power', progress }
}
