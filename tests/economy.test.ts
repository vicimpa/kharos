import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, DEPOSIT_TYPES, Inventory, Producer, RESOURCE_SPECS, SELL_SECONDS, Site, UNITS, Unit, amountOf, awaitsMaterials, canPlace, createSim, creditsOf,
  depositIn, materialShare, siteTicks, type BuildingType, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
function until(sim: Sim, done: () => boolean, limit = 200) {
  for (let i = 0; i < limit / TICK; i++) {
    if (done()) return
    sim.advance(TICK)
  }
  throw new Error('Не дождались')
}

/** База игрока 1 в ряд на скале: главное здание, две электростанции и здания из списка; под ними — место для юнитов. */
function base(extra: BuildingType[]) {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  const layout: [BuildingType, number][] = [['command', 0], ['generator', 4], ['generator', 7]]
  let at = 10
  for (const type of extra) {
    layout.push([type, at])
    at += BUILDINGS[type].width + 1
  }
  for (let y = -100; y < 100; y++) {
    for (let x = -100; x < 100; x++) {
      if (!layout.every(([type, dx]) => canPlace(sim, type, x + dx, y))) continue
      if (!canPlace(sim, 'command', x, y + 4) || !canPlace(sim, 'command', x + 4, y + 4)) continue
      const buildings = layout.map(([type, dx]) => placeBuilding(sim.world, type, x + dx, y, 1))
      return { sim, x, y, core: buildings[0], buildings: buildings.slice(3) }
    }
  }
  throw new Error('Не нашлось места под базу')
}

const oreIn = (sim: Sim, entity: Entity, resource: Parameters<typeof amountOf>[1]) => amountOf(sim.world.get(entity, Inventory)!, resource)

test('месторождения бывают разных видов: что где лежит, решает биом', () => {
  const sim = createSim(options)
  const kinds = new Set<string>()
  for (let cellY = -12; cellY < 12; cellY++) {
    for (let cellX = -12; cellX < 12; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (spot) kinds.add(spot.kind)
    }
  }
  expect([...kinds].sort()).toEqual([...DEPOSIT_TYPES].sort())
})

test('стройка ждёт материалов: без стройблоков она не идёт дальше привезённого, грузовик привозит их из хранилища', () => {
  const { sim, x, y, core } = base([])
  const builder = spawnUnit(sim, 'builder', 1, x + 5, y + 4)
  sim.send(1, { type: 'build', building: 'factory', x: x + 10, y, builders: [builder] })
  sim.advance(TICK)
  let site: Entity | undefined
  for (const [entity] of sim.world.query(Site)) site = entity
  seconds(sim, 10)
  // Материалов нет — стройка стоит в самом начале.
  expect(awaitsMaterials(sim, site!)).toBe(true)
  expect(sim.world.get(site!, Site)!.progress).toBe(0)

  // Стройблоки в хранилище и свободный грузовик — стройка идёт до конца.
  sim.world.get(core, Inventory)!.items.blocks = 50
  spawnUnit(sim, 'truck', 1, x + 6, y + 4)
  until(sim, () => materialShare(sim, site!) > 0)
  expect(sim.world.get(site!, Site)!.progress).toBeLessThanOrEqual(siteTicks('factory', TICK) * materialShare(sim, site!) + 1e-6)
  until(sim, () => !sim.world.has(site!, Site))
  expect(oreIn(sim, core, 'blocks')).toBeCloseTo(50 - BUILDINGS.factory.materials.blocks)
})

test('производство ждёт материалов первого заказа и тратит их в начале работы', () => {
  const { sim, x, y, core, buildings } = base(['factory'])
  const [factory] = buildings
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  seconds(sim, UNITS.tank.buildTime + 2)
  expect(sim.world.get(factory, Producer)).toMatchObject({ queue: ['tank'], progress: 0 })

  sim.world.get(core, Inventory)!.items = { metal: 40, silicon: 10 }
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  const tanks = () => [...sim.world.query(Unit)].filter(([, unit]) => unit.type === 'tank').length
  until(sim, () => tanks() > 0)
  // Привезли ровно на танк, и танк их забрал.
  expect(oreIn(sim, core, 'metal') + oreIn(sim, factory, 'metal')).toBeCloseTo(40 - UNITS.tank.materials.metal)
  expect(oreIn(sim, core, 'silicon') + oreIn(sim, factory, 'silicon')).toBeCloseTo(10 - UNITS.tank.materials.silicon)
})

test('космопорт продаёт любой ресурс по его цене', () => {
  const { sim, x, y, core, buildings } = base(['spaceport'])
  const [port] = buildings
  sim.world.get(core, Inventory)!.items.metal = 30
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 20 })
  seconds(sim, 1)
  const before = creditsOf(sim, 1)
  until(sim, () => creditsOf(sim, 1) - before >= 20 * RESOURCE_SPECS.metal.price)
  expect(oreIn(sim, core, 'metal')).toBeCloseTo(10)
  expect(oreIn(sim, port, 'metal')).toBeCloseTo(0)
  // Пока везли и летели, прошло не меньше полёта.
  expect(sim.time.tick * TICK).toBeGreaterThan(SELL_SECONDS)
})
