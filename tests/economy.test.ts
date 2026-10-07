import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, DEPOSIT_TYPES, Inventory, Producer, RESOURCE_SPECS, SELL_SECONDS, Site, UNITS, Unit, amountOf, awaitsMaterials, canPlace, createSim, creditsOf,
  depositIn, materialShare, siteTicks, type BuildingType, type Sim,
} from '../src/sim'
import { STORES, placeBuilding, storeFor } from '../src/sim/buildings'
import type { Amounts, Ware } from '../src/sim/resources'
import { addCredits } from '../src/sim/economy'
import { Hauler } from '../src/sim/components'
import { NONE } from '../src/sim/common'
import { spawnUnit } from '../src/sim/units'
import { refineryFor, spaceFor } from '../src/sim/logistics'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }
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
  // Ряд хранилищ — по одному на каждое готовое — после зданий из списка.
  for (const type of [...extra, ...STORES]) {
    layout.push([type, at])
    at += BUILDINGS[type].width + 1
  }
  for (let y = -100; y < 100; y++) {
    for (let x = -100; x < 100; x++) {
      if (!layout.every(([type, dx]) => canPlace(sim, type, x + dx, y))) continue
      if (!canPlace(sim, 'command', x, y + 4) || !canPlace(sim, 'command', x + 4, y + 4)) continue
      const buildings = layout.map(([type, dx]) => placeBuilding(sim.world, type, x + dx, y, 1))
      const placed = buildings.slice(3, 3 + extra.length)
      const shelves = buildings.slice(3 + extra.length)
      const store = (item: Ware) => shelves[STORES.indexOf(storeFor(item)!)]
      /** Кладёт груз в хранилища его вида. */
      const stash = (items: Amounts) => {
        for (const [item, amount] of Object.entries(items) as [Ware, number][]) sim.world.get(store(item), Inventory)!.items[item] = amount
      }
      return { sim, x, y, core: buildings[0], buildings: placed, store, stash }
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
  const { sim, x, y, store, stash } = base([])
  const builder = spawnUnit(sim, 'builder', 1, x + 5, y + 4)
  sim.send(1, { type: 'build', building: 'factory', x, y: y + 4, builders: [builder] })
  sim.advance(TICK)
  let site: Entity | undefined
  for (const [entity] of sim.world.query(Site)) site = entity
  seconds(sim, 10)
  // Материалов нет — стройка стоит в самом начале.
  expect(awaitsMaterials(sim, site!)).toBe(true)
  expect(sim.world.get(site!, Site)!.progress).toBe(0)

  // Стройблоки в хранилище и свободный грузовик — стройка идёт до конца.
  stash({ blocks: 50 })
  spawnUnit(sim, 'truck', 1, x + 6, y + 4)
  until(sim, () => materialShare(sim, site!) > 0)
  expect(sim.world.get(site!, Site)!.progress).toBeLessThanOrEqual(siteTicks('factory', TICK) * materialShare(sim, site!) + 1e-6)
  until(sim, () => !sim.world.has(site!, Site))
  expect(oreIn(sim, store('blocks'), 'blocks')).toBeCloseTo(50 - BUILDINGS.factory.materials.blocks)
})

test('производство ждёт материалов первого заказа и тратит их в начале работы', () => {
  const { sim, x, y, store, stash, buildings } = base(['factory', 'techCenter'])
  const [factory] = buildings
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  seconds(sim, UNITS.tank.buildTime + 2)
  expect(sim.world.get(factory, Producer)).toMatchObject({ queue: ['tank'], progress: 0 })

  stash({ metal: 40, silicon: 10 })
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  const tanks = () => [...sim.world.query(Unit)].filter(([, unit]) => unit.type === 'tank').length
  until(sim, () => tanks() > 0)
  // Привезли ровно на танк, и танк их забрал.
  expect(oreIn(sim, store('metal'), 'metal') + oreIn(sim, factory, 'metal')).toBeCloseTo(40 - UNITS.tank.materials.metal)
  expect(oreIn(sim, store('silicon'), 'silicon') + oreIn(sim, factory, 'silicon')).toBeCloseTo(10 - UNITS.tank.materials.silicon)
})

test('космопорт продаёт любой ресурс по его цене', () => {
  const { sim, x, y, store, stash, buildings } = base(['spaceport'])
  const [port] = buildings
  stash({ metal: 30 })
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 20 })
  seconds(sim, 1)
  const before = creditsOf(sim, 1)
  until(sim, () => creditsOf(sim, 1) - before >= 20 * RESOURCE_SPECS.metal.price)
  expect(oreIn(sim, store('metal'), 'metal')).toBeCloseTo(10)
  expect(oreIn(sim, port, 'metal')).toBeCloseTo(0)
  // Пока везли и летели, прошло не меньше полёта.
  expect(sim.time.tick * TICK).toBeGreaterThan(SELL_SECONDS)
})

test('из вставшей переработки грузовик увозит готовое до крошки, из работающей мелочь не возит', () => {
  const { sim, x, y, store, buildings } = base(['smelter'])
  const [smelter] = buildings
  const inventory = sim.world.get(smelter, Inventory)!
  // Руда ещё есть: переработка сделает больше, и за 3 единицами грузовик не едет.
  inventory.items.metal = 3
  inventory.items.metalOre = 20
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  seconds(sim, 2)
  expect(oreIn(sim, store('metal'), 'metal')).toBe(0)

  // Руды нет и не везут: остаток меньше порога увозят весь.
  inventory.items.metal = 7
  inventory.items.metalOre = 0
  until(sim, () => oreIn(sim, smelter, 'metal') < 1e-9)
  until(sim, () => oreIn(sim, store('metal'), 'metal') >= 7 - 1e-6)
})

test('дробный остаток материалов довозят: завод не встаёт на 19,7 из 20', () => {
  const { sim, x, y, store, stash, buildings } = base(['factory', 'techCenter'])
  const [factory] = buildings
  const inventory = sim.world.get(factory, Inventory)!
  inventory.items.metal = UNITS.tank.materials.metal - 0.3
  inventory.items.silicon = UNITS.tank.materials.silicon
  stash({ metal: 10 })
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  until(sim, () => sim.world.get(factory, Producer)!.progress > 0, 60)
  expect(oreIn(sim, store('metal'), 'metal')).toBeLessThan(10)
})

test('груз, который стал не нужен, грузовик везёт обратно в хранилище, откуда взял', () => {
  const { sim, x, y, store, stash, buildings } = base(['factory', storeFor('metal')!, 'techCenter'])
  const [factory, second] = buildings
  stash({ metal: 40, silicon: 10 })
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  const truck = spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  until(sim, () => amountOf(sim.world.get(truck, Inventory)!, 'metal') > 0)
  sim.world.get(factory, Producer)!.queue.length = 0
  until(sim, () => amountOf(sim.world.get(truck, Inventory)!, 'metal') < 1e-9)
  expect(oreIn(sim, second, 'metal')).toBe(0)
  expect(oreIn(sim, store('metal'), 'metal') + oreIn(sim, factory, 'metal')).toBeCloseTo(40)
})

test('грузу некуда деться — грузовик везёт его заказчику, а нет заказчика — обратно, и снова свободен', () => {
  const { sim, x, y, store, buildings } = base(['smelter', 'factory'])
  const [smelter, factory] = buildings
  const shelf = sim.world.get(store('metal'), Inventory)!
  shelf.items.metal = shelf.capacity
  const truck = spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  const cargo = () => amountOf(sim.world.get(truck, Inventory)!, 'metal')
  const load = () => {
    sim.world.get(truck, Inventory)!.items.metal = 10
    Object.assign(sim.world.get(truck, Hauler)!, { from: smelter, to: NONE, resource: 'metal', amount: 10, full: true })
  }
  // Заказчик есть — металл едет на завод.
  sim.send(1, { type: 'produce', producer: factory, unit: 'buggy' })
  load()
  until(sim, () => cargo() < 1e-9, 60)
  expect(oreIn(sim, factory, 'metal') + (sim.world.get(factory, Producer)!.progress > 0 ? UNITS.buggy.materials.metal : 0)).toBeGreaterThan(0)
  // Заказчиков нет — обратно в переработку.
  sim.world.get(factory, Producer)!.queue.length = 0
  until(sim, () => sim.world.get(factory, Producer)!.queue.length === 0 && !sim.world.get(truck, Hauler)!.full, 60)
  load()
  until(sim, () => cargo() < 1e-9, 60)
  expect(oreIn(sim, smelter, 'metal')).toBeGreaterThan(0)
})

test('машинный завод строит MCV из стройблоков и металла, и тот разворачивается в новую базу', () => {
  const { sim, x, y, stash, buildings } = base(['factory'])
  const [factory] = buildings
  stash({ blocks: 40, metal: 40 })
  spawnUnit(sim, 'truck', 1, x + 5, y + 4)
  sim.send(1, { type: 'produce', producer: factory, unit: 'mcv' })
  const mcvs = () => [...sim.world.query(Unit)].filter(([, unit]) => unit.type === 'mcv').map(([entity]) => entity)
  until(sim, () => mcvs().length > 0)
  expect(sim.world.has(mcvs()[0], Producer)).toBe(true)
})

test('груз, который уже везут на переработку, занимает её место: второй грузовик туда не едет и не набирает руду', () => {
  const { sim, x, y, buildings: [smelter] } = base(['smelter'])
  const inventory = sim.world.get(smelter, Inventory)!
  const room = 6
  inventory.items.metalOre = inventory.limits.metalOre! - room
  const [first, second] = [0, 2].map((dx) => spawnUnit(sim, 'truck', 1, x + dx, y + 5))
  expect(refineryFor(sim, first, 'metalOre')).toBe(smelter)
  const hauler = sim.world.get(first, Hauler)!
  hauler.to = smelter
  hauler.resource = 'metalOre'
  hauler.amount = room
  sim.world.get(first, Inventory)!.items.metalOre = room
  hauler.full = true
  expect(spaceFor(sim, second, smelter, 'metalOre')).toBeLessThanOrEqual(1e-9)
  expect(refineryFor(sim, second, 'metalOre')).toBe(NONE)
  // Свой груз грузовик у себя же места не отнимает.
  expect(spaceFor(sim, first, smelter, 'metalOre')).toBe(room)
})
