import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { BUILDINGS, Drop, Hauler, Inventory, Position, TRUCK_CAPACITY, amountOf, canPlace, createSim, type BuildingType, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { dropItems } from '../src/sim/drops'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
function until(sim: Sim, done: () => boolean, limit = 120) {
  for (let i = 0; i < limit / TICK; i++) {
    if (done()) return
    sim.advance(TICK)
  }
  throw new Error('Не дождались')
}

/** Главное здание, электростанции и здания из списка в ряд на скале; под ними — грузовик и строитель. */
function base(types: BuildingType[]) {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  const layout: [BuildingType, number][] = [['command', 0], ['generator', 4], ['generator', 7]]
  let at = 10
  for (const type of types) {
    layout.push([type, at])
    at += BUILDINGS[type].width + 4
  }
  for (let y = -100; y < 100; y++) {
    for (let x = -100; x < 100; x++) {
      if (!layout.every(([type, dx]) => canPlace(sim, type, x + dx, y))) continue
      if (!canPlace(sim, 'command', x + 10, y + 4)) continue
      const buildings = layout.map(([type, dx]) => placeBuilding(sim.world, type, x + dx, y, 1))
      const truck = spawnUnit(sim, 'truck', 1, x + 11, y + 4)
      const builder = spawnUnit(sim, 'builder', 1, x + 13, y + 4)
      return { sim, x, y, buildings: buildings.slice(3), truck, builder }
    }
  }
  throw new Error('Не нашлось места')
}

const drops = (sim: Sim) => {
  const found: { entity: Entity; x: number; y: number }[] = []
  for (const [entity, position] of sim.world.query(Position, Drop)) found.push({ entity, x: position.x, y: position.y })
  return found
}
const amount = (sim: Sim, entity: Entity, good: Parameters<typeof amountOf>[1]) => amountOf(sim.world.get(entity, Inventory)!, good)

test('разобранное хранилище бросает груз на землю, свободный грузовик отвозит его в другое хранилище', () => {
  const { sim, buildings: [gone, kept], builder } = base(['metalYard', 'metalYard'])
  sim.world.get(gone, Inventory)!.items.metal = 50
  sim.send(1, { type: 'demolish', building: gone, builders: [builder] })
  until(sim, () => !sim.world.alive(gone))
  const [drop] = drops(sim)
  expect(drop).toBeDefined()
  expect(amount(sim, drop.entity, 'metal')).toBe(50)
  until(sim, () => amount(sim, kept, 'metal') >= 50)
  // Пустой дроп исчезает.
  sim.advance(TICK)
  expect(drops(sim)).toEqual([])
})

test('стройка поверх дропа его уничтожает', () => {
  const { sim, x, y, builder } = base([])
  const spot = { x: x + 4, y: y + 6 }
  expect(canPlace(sim, 'generator', spot.x, spot.y)).toBe(true)
  dropItems(sim, spot.x + 1, spot.y, { metal: 10 })
  expect(drops(sim).length).toBe(1)
  sim.send(1, { type: 'build', building: 'generator', x: spot.x, y: spot.y, builders: [builder] })
  until(sim, () => drops(sim).length === 0, 30)
})

test('за дропом вне своих зон свободный грузовик сам не едет', () => {
  const { sim, x, y, truck } = base(['metalYard'])
  const drop = dropItems(sim, x + 400, y, { metal: 10 })!
  const start = { ...sim.world.get(truck, Position)! }
  for (let i = 0; i < 5 / TICK; i++) sim.advance(TICK)
  expect(amount(sim, drop, 'metal')).toBe(10)
  expect(sim.world.get(truck, Position)).toEqual(start)
})

test('посланный за дропом грузовик вывозит его весь, сколько бы рейсов ни понадобилось, и освобождается', () => {
  const { sim, x, y, truck, buildings: [store] } = base(['metalYard'])
  const drop = dropItems(sim, x + 60, y, { metal: TRUCK_CAPACITY * 2 })!
  sim.send(1, { type: 'pickup', units: [truck], drop })
  until(sim, () => !sim.world.alive(drop), 600)
  until(sim, () => amount(sim, store, 'metal') >= TRUCK_CAPACITY * 2, 120)
  until(sim, () => sim.world.get(truck, Hauler)!.pickup === -1, 10)
})

test('груз с дропа, которому негде лежать, грузовик не берёт и ждёт; фильтр, не пускающий ничего с дропа, снимает приказ', () => {
  const { sim, x, y, truck } = base(['metalYard'])
  const drop = dropItems(sim, x + 20, y, { fuel: 3 })!
  sim.send(1, { type: 'pickup', units: [truck], drop })
  for (let i = 0; i < 30 / TICK; i++) sim.advance(TICK)
  expect(amount(sim, drop, 'fuel')).toBe(3)
  expect(sim.world.get(truck, Hauler)!.pickup).toBe(drop)
  sim.send(1, { type: 'filter', units: [truck], goods: ['metal'] })
  until(sim, () => sim.world.get(truck, Hauler)!.pickup === -1, 10)
})

test('груз падает к уже лежащему дропу того же тайла', () => {
  const { sim, x, y } = base([])
  dropItems(sim, x + 2.4, y + 6.7, { metal: 3 })
  dropItems(sim, x + 2, y + 6, { fuel: 2, metalOre: 1 })
  const [drop] = drops(sim)
  expect(drops(sim).length).toBe(1)
  expect([amount(sim, drop.entity, 'metal'), amount(sim, drop.entity, 'fuel'), amount(sim, drop.entity, 'metalOre')]).toEqual([3, 2, 1])
})
