import type { Entity, Time } from '../ecs'
import { isReady } from './buildings'
import { Assembly, Hauler, Inventory, Owner, Site } from './components'
import { powerSupply } from './income'
import { amountOf, put, roomFor, take } from './inventory'
import { entriesOf, productSpec, totalOf, type Product, type Resource } from './resources'
import type { Sim } from './sim'
import { isStore } from './trade'
import { zonesOf, type Zone } from './zones'

/**
 * Сколько единиц сырья завод изделий перерабатывает в секунду, всех видов вместе. Одна сборка стройблоков —
 * 2 металла и 1 кремний — идёт 3 секунды, боеприпасов — 1 секунду, компонентов — 3 секунды (§3.7 design.md).
 */
export const ASSEMBLE_RATE = 1
const EPSILON = 1e-9

/** Сколько секунд идёт одна сборка изделия. */
export const cycleSeconds = (product: Product) => totalOf(productSpec(product).recipe) / ASSEMBLE_RATE

/** Сырьё рецепта парами ресурс — сколько на одну сборку. */
export const recipeOf = (product: Product) => entriesOf(productSpec(product).recipe) as [Resource, number][]

/** Сырьё, которое завод сейчас заказывает: у выключенного — никакого, его остатки увозят в хранилища. */
export const inputsOf = (sim: Sim, entity: Entity): readonly Resource[] => {
  const assembly = sim.world.get(entity, Assembly)
  return assembly?.on ? recipeOf(assembly.recipe).map(([resource]) => resource) : []
}

/**
 * Включает или выключает свой готовый завод. Выключенный доделывает начатую сборку, но новых не начинает
 * и сырья не заказывает; лежащее у него сырьё грузовики увезут в хранилища. Возвращает, изменилось ли что-то.
 */
export function setWorking(sim: Sim, player: number, entity: Entity, on: boolean) {
  const assembly = sim.world.get(entity, Assembly)
  if (!assembly || !isReady(sim, player, entity) || assembly.on === on) return false
  assembly.on = on
  return true
}

/**
 * Раз в тик: цеха собирают изделия. Сборка начинается, когда на складе есть сырьё на неё и место под готовое,
 * а изделий у зоны меньше нормы (ProductSpec.stock), — тогда сырьё сразу уходит в работу. При нехватке энергии
 * сборка идёт медленнее. Готовое кладётся на склад цеха, откуда его разбирают заявки и вывозят грузовики
 * (см. logistics.ts).
 */
export function assemble(sim: Sim, time: Time) {
  const { world } = sim
  const working: Entity[] = []
  const zones = new Map<number, readonly Zone[]>()
  for (const [entity, assembly, , owner] of world.query(Assembly, Inventory, Owner)) {
    if (world.has(entity, Site)) continue
    if (assembly.progress > 0) {
      working.push(entity)
      continue
    }
    if (!assembly.on || !canStart(sim, entity)) continue
    if (!zones.has(owner.player)) zones.set(owner.player, zonesOf(sim, owner.player))
    if (stockedIn(sim, zones.get(owner.player)!, entity, assembly.recipe) < productSpec(assembly.recipe).stock) working.push(entity)
  }
  if (!working.length) return
  // Считается недёшево, поэтому только когда есть что собирать, и один раз за тик.
  const supply = powerSupply(sim)
  for (const entity of working) {
    const assembly = world.get(entity, Assembly)!
    const inventory = world.get(entity, Inventory)!
    const spec = productSpec(assembly.recipe)
    if (assembly.progress <= 0) {
      for (const [resource, amount] of recipeOf(assembly.recipe)) take(inventory, resource, amount)
      // Сырьё ушло в работу — сборка начата, даже если энергии сейчас нет.
      assembly.progress = EPSILON
    }
    assembly.progress = Math.min(cycleSeconds(assembly.recipe), assembly.progress + time.step * (supply.get(entity) ?? 0))
    if (assembly.progress < cycleSeconds(assembly.recipe) - EPSILON) continue
    // Готовому некуда лечь — сборка ждёт, пока грузовики не освободят склад.
    if (roomFor(inventory, assembly.recipe) < spec.yield - EPSILON) continue
    put(inventory, assembly.recipe, spec.yield)
    assembly.progress = 0
  }
}

/**
 * Сколько изделия уже есть у зоны цеха: в хранилищах и на складах всех её цехов, а ещё в кузовах грузовиков
 * игрока — иначе цех не видел бы того, что везут из него в хранилище, и собирал бы сверх нормы. По этому числу
 * цех решает, дошёл ли он до нормы. Цех вне зон считает только свой склад и грузовики.
 */
export function stockedIn(sim: Sim, zones: readonly Zone[], entity: Entity, product: Product) {
  const { world } = sim
  const zone = zones.find((item) => item.buildings.includes(entity))
  let total = 0
  for (const building of zone?.buildings ?? [entity]) {
    const inventory = world.get(building, Inventory)
    if (inventory && (isStore(sim, building) || world.has(building, Assembly))) total += amountOf(inventory, product)
  }
  const player = world.get(entity, Owner)?.player
  for (const [, , cargo, owner] of world.query(Hauler, Inventory, Owner)) {
    if (owner.player === player) total += amountOf(cargo, product)
  }
  return total
}

/** Сколько изделия рецепта цеха уже есть у его зоны: столько интерфейс показывает рядом с нормой. */
export function productStock(sim: Sim, entity: Entity) {
  const assembly = sim.world.get(entity, Assembly)
  const player = sim.world.get(entity, Owner)?.player
  if (!assembly || player === undefined) return 0
  return stockedIn(sim, zonesOf(sim, player), entity, assembly.recipe)
}

/** Можно ли начать сборку: сырьё на месте и под готовое есть место. */
function canStart(sim: Sim, entity: Entity) {
  const assembly = sim.world.get(entity, Assembly)!
  const inventory = sim.world.get(entity, Inventory)!
  if (roomFor(inventory, assembly.recipe) < productSpec(assembly.recipe).yield - EPSILON) return false
  return recipeOf(assembly.recipe).every(([resource, amount]) => amountOf(inventory, resource) >= amount - EPSILON)
}
