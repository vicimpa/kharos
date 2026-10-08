import type { Entity, Time } from '../ecs'
import { buildingSpec, isReady } from './buildings'
import { Assembly, Building, Hauler, Inventory, Off, Owner, Site } from './components'
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
 * Включает или выключает своё готовое здание — потребителя энергии. Выключенное не просит энергии у зоны и не
 * работает: начатое стоит, турели молчат, радар видит как обычное здание (тег Off). Начатая работа замирает и
 * продолжится после включения. Завод изделий к тому же не заказывает сырья, и лежащее у него увезут в хранилища. Возвращает, изменилось ли что-то.
 */
export function setWorking(sim: Sim, player: number, entity: Entity, on: boolean) {
  const { world } = sim
  const type = world.get(entity, Building)?.type
  if (!type || !isReady(sim, player, entity) || (buildingSpec(type).power ?? 0) >= 0) return false
  // Новый завод изделий выключен без тега Off: у него свой флаг on, и он главнее.
  const assembly = world.get(entity, Assembly)
  if (assembly ? assembly.on === on : on === !world.has(entity, Off)) return false
  if (assembly) assembly.on = on
  if (on) world.remove(entity, Off)
  else world.add(entity, Off())
  return true
}

/**
 * Раз в тик: цеха собирают изделия. Сборка начинается, когда на складе есть сырьё на неё и место под готовое, —
 * тогда сырьё сразу уходит в работу. Хранилища полны — грузовикам некуда увезти готовое, склад цеха забивается,
 * и цех встаёт сам. При нехватке энергии
 * сборка идёт медленнее. Готовое кладётся на склад цеха, откуда его разбирают заявки и вывозят грузовики
 * (см. logistics.ts).
 */
export function assemble(sim: Sim, time: Time) {
  const { world } = sim
  const working: Entity[] = []
  for (const [entity, assembly] of world.query(Assembly, Inventory)) {
    if (world.has(entity, Site)) continue
    if (assembly.progress > 0 || (assembly.on && canStart(sim, entity))) working.push(entity)
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
 * игрока. Цех вне зон считает только свой склад и грузовики.
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

/** Сколько изделия рецепта цеха уже есть у его зоны: столько показывает интерфейс. */
export function productStock(sim: Sim, entity: Entity) {
  const assembly = sim.world.get(entity, Assembly)
  const player = sim.world.get(entity, Owner)?.player
  if (!assembly || player === undefined) return 0
  return stockedIn(sim, zonesOf(sim, player), entity, assembly.recipe)
}

/** Есть ли у цеха место под готовое одной сборки: нет — хранилища полны, и цех стоит. */
export function hasRoom(sim: Sim, entity: Entity) {
  const assembly = sim.world.get(entity, Assembly)!
  return roomFor(sim.world.get(entity, Inventory)!, assembly.recipe) >= productSpec(assembly.recipe).yield - EPSILON
}

/** Можно ли начать сборку: сырьё на месте и под готовое есть место. */
function canStart(sim: Sim, entity: Entity) {
  const assembly = sim.world.get(entity, Assembly)!
  const inventory = sim.world.get(entity, Inventory)!
  if (!hasRoom(sim, entity)) return false
  return recipeOf(assembly.recipe).every(([resource, amount]) => amountOf(inventory, resource) >= amount - EPSILON)
}
