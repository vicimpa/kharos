import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  Assembly, Building, BUILDINGS, BUY_MARKUP, BUY_SECONDS, Health, Inventory, PRODUCT_SPECS, RESOURCE_SPECS, Trade, buyPrice, creditsOf, UNITS, WEAPONS, amountOf, canPlace, createSim, cycleSeconds,
  hasRoom, stockOf, type BuildingType, type Good, type Sim,
} from '../src/sim'
import { STORES, placeBuilding, storeFor } from '../src/sim/buildings'
import type { Amounts, Ware } from '../src/sim/resources'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
function until(sim: Sim, done: () => boolean, limit = 300) {
  for (let i = 0; i < limit / TICK; i++) {
    if (done()) return
    sim.advance(TICK)
  }
  throw new Error('Не дождались')
}
const good = (sim: Sim, entity: Entity, item: Good) => amountOf(sim.world.get(entity, Inventory)!, item)

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
      // Над рядом — труба вдоль всей базы: все здания в одной сети.
      let piped = true
      for (let dx = 0; dx < at && piped; dx++) piped = canPlace(sim, 'pipe', x + dx, y - 1)
      if (!piped) continue
      const buildings = layout.map(([type, dx]) => placeBuilding(sim.world, type, x + dx, y, 1))
      for (let dx = 0; dx < at; dx++) placeBuilding(sim.world, 'pipe', x + dx, y - 1, 1)
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

test('завод стройблоков собирает их из сырья хранилищ, отвозит в хранилище и встаёт, когда сырьё кончилось', () => {
  const { sim, x, y, stash, buildings } = base(['blockPlant'])
  const [workshop] = buildings
  expect(sim.world.get(workshop, Assembly)!.recipe).toBe('blocks')
  stash({ metal: 20, silicon: 10 })
  sim.send(1, { type: 'work', building: workshop, on: true })
  for (let i = 0; i < 2; i++) spawnUnit(sim, 'truck', 1, x + 2 + i * 2, y + 5)

  const blocks = () => stockOf(sim, 1).items.blocks ?? 0
  // Сырья — на 10 сборок: нормы нет, цех съедает его целиком.
  until(sim, () => blocks() + good(sim, workshop, 'blocks') >= 10)
  seconds(sim, cycleSeconds('blocks') * 5)
  expect(blocks() + good(sim, workshop, 'blocks')).toBe(10)
  expect((stockOf(sim, 1).items.metal ?? 0) + good(sim, workshop, 'metal')).toBeCloseTo(0)
  // Свободные грузовики увезли готовое в хранилища: цех не копит его у себя.
  expect(blocks()).toBeGreaterThan(0)
})

test('цех встаёт, когда готовому некуда лечь', () => {
  const { sim, x, y, stash, buildings } = base(['ammoPlant'])
  const [plant] = buildings
  stash({ metal: 500 })
  sim.send(1, { type: 'work', building: plant, on: true })
  for (let i = 0; i < 2; i++) spawnUnit(sim, 'truck', 1, x + 2 + i * 2, y + 5)
  seconds(sim, 240)
  const metal = () => (stockOf(sim, 1).items.metal ?? 0) + good(sim, plant, 'metal')
  const before = metal()
  seconds(sim, 30)
  // Бункер и склад цеха полны: металл больше не тратится, хотя его ещё много.
  expect(metal()).toBe(before)
  expect(before).toBeGreaterThan(100)
  expect(hasRoom(sim, plant)).toBe(false)
})

test('новый завод выключен: сырья не заказывает; выключенный замирает посреди сборки, а сырьё увозят', () => {
  const { sim, x, y, store, stash, buildings } = base(['ammoPlant'])
  const [plant] = buildings
  stash({ metal: 30 })
  spawnUnit(sim, 'truck', 1, x + 2, y + 5)
  const assembly = () => sim.world.get(plant, Assembly)!

  // Выключенный завод ничего не просит и не собирает.
  expect(assembly().on).toBe(false)
  seconds(sim, 10)
  expect(good(sim, plant, 'metal')).toBe(0)
  expect(assembly().progress).toBe(0)

  // Чужой приказ не принимается, свой — включает.
  sim.send(2, { type: 'work', building: plant, on: true })
  sim.advance(TICK)
  expect(assembly().on).toBe(false)
  sim.send(1, { type: 'work', building: plant, on: true })
  until(sim, () => assembly().progress > 0)

  // Выключили — начатая сборка замирает, а лежащий у завода металл грузовик увозит в хранилище.
  sim.send(1, { type: 'work', building: plant, on: false })
  sim.advance(TICK)
  const paused = assembly().progress
  until(sim, () => good(sim, plant, 'metal') < 1e-6)
  const made = (stockOf(sim, 1).items.ammo ?? 0) + good(sim, plant, 'ammo')
  seconds(sim, 10)
  expect(assembly().progress).toBe(paused)
  expect((stockOf(sim, 1).items.ammo ?? 0) + good(sim, plant, 'ammo')).toBe(made)
  // Включили — сборка продолжается с того же места.
  sim.send(1, { type: 'work', building: plant, on: true })
  until(sim, () => assembly().progress === 0)
})

test('изделия не продаются: космопорт берёт только ресурсы', () => {
  const { sim, store, stash, buildings } = base(['spaceport'])
  const [port] = buildings
  stash({ blocks: 30, metal: 30 })
  sim.send(1, { type: 'sell', port, resource: 'blocks' as never, amount: 10 })
  sim.advance(TICK)
  expect(sim.world.has(port, Trade)).toBe(false)
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 10 })
  sim.advance(TICK)
  expect(sim.world.has(port, Trade)).toBe(true)
})

test('турель строится заряженной, тратит патроны на выстрелы и без них молчит', () => {
  const sim = createSim(options)
  const defense = placeBuilding(sim.world, 'turret', 0, 0, 1)
  const full = BUILDINGS.turret.inventory
  expect(good(sim, defense, 'ammo')).toBe(full)

  const foe = spawnUnit(sim, 'tank', 2, 4, 0)
  seconds(sim, 2)
  expect(good(sim, defense, 'ammo')).toBeLessThan(full)
  expect(sim.world.get(foe, Health)!.value).toBeLessThan(1)

  // Патроны кончились — новых выстрелов нет.
  sim.world.get(defense, Inventory)!.items.ammo = WEAPONS.machinegun.ammo / 2
  seconds(sim, 0.5)
  const stopped = sim.world.get(foe, Health)!.value
  seconds(sim, 2)
  expect(sim.world.get(foe, Health)!.value).toBe(stopped)
  // Юниты стреляют бесплатно: танк бьёт турель и без всяких патронов.
  expect(sim.world.get(defense, Health)!.value).toBeLessThan(1)
})

test('расстрелявшая запас турель заказывает патроны, и грузовик везёт их из хранилища', () => {
  const { sim, x, y, store, stash, buildings } = base(['turret'])
  const [defense] = buildings
  const full = BUILDINGS.turret.inventory
  stash({ ammo: 100 })
  // Расстреляла меньше четверти — заказа ещё нет.
  sim.world.get(defense, Inventory)!.items.ammo = full - 20
  spawnUnit(sim, 'truck', 1, x + 2, y + 5)
  seconds(sim, 20)
  expect(good(sim, defense, 'ammo')).toBe(full - 20)

  // Расстреляла больше — грузовики дозаряжают её кузовами, пока пустого места не станет меньше четверти.
  sim.world.get(defense, Inventory)!.items.ammo = 10
  until(sim, () => good(sim, defense, 'ammo') > full * 0.75)
  seconds(sim, 20)
  const loaded = good(sim, defense, 'ammo')
  expect(loaded).toBeGreaterThan(full * 0.75)
  expect(good(sim, store('ammo'), 'ammo')).toBeCloseTo(100 - (loaded - 10))
})

test('компоненты нужны верхнему тиру: разрядник ждёт их на заводе', () => {
  expect(UNITS.tesla.materials).toMatchObject({ parts: 3 })
  expect(UNITS.carrier.materials).toMatchObject({ parts: 1 })
  expect(BUILDINGS.factory.materials).toEqual({ blocks: 10 })
  // Космопорт — исключение: с него начинаются деньги, и строится он из металла.
  expect(BUILDINGS.spaceport.materials).toEqual({ metal: 20 })
})

test('закупка с орбиты: кредиты сразу, груз через полёт корабля, грузовики увозят его в хранилище', () => {
  const { sim, x, y, buildings } = base(['spaceport', 'metalYard'])
  const [port] = buildings
  spawnUnit(sim, 'truck', 1, x + 2, y + 5)
  const credits = creditsOf(sim, 1)

  // Чужой космопорт не закупает; дороже, чем есть кредитов, — тоже.
  sim.send(2, { type: 'buy', port, resource: 'metal', amount: 10 })
  sim.send(1, { type: 'buy', port, resource: 'metal', amount: 100000 })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(credits)

  sim.send(1, { type: 'buy', port, resource: 'metal', amount: 50 })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(credits - 50 * buyPrice('metal'))
  expect(buyPrice('metal')).toBe(RESOURCE_SPECS.metal.price * BUY_MARKUP)
  // Пока корабль летит, космопорт занят: вторая закупка не принимается.
  sim.send(1, { type: 'buy', port, resource: 'silicon', amount: 10 })
  sim.advance(TICK)
  expect(sim.world.get(port, Trade)!.resource).toBe('metal')

  seconds(sim, BUY_SECONDS)
  expect(sim.world.has(port, Trade)).toBe(false)
  until(sim, () => (stockOf(sim, 1).items.metal ?? 0) >= 50 - 1e-6)
  expect(good(sim, port, 'metal')).toBeLessThan(1e-6)
})

test('старое сохранение получает нынешние пределы склада переработки', () => {
  const sim = createSim(options)
  const smelter = placeBuilding(sim.world, 'smelter', 0, 0, 1)
  const inventory = sim.world.get(smelter, Inventory)!
  Object.assign(inventory, { capacity: 60, limits: { metalOre: 25 } })
  const loaded = createSim(sim.save())
  const restored = loaded.world.get(smelter, Inventory)!
  expect(restored.capacity).toBe(60)
  expect(restored.limits).toEqual({ metalOre: 30, metal: 30 })
})

test('готовое расходится по всем хранилищам, а не копится в ближайшем', () => {
  const { sim, x, y, stash, buildings } = base(['ammoPlant', 'ammoBunker'])
  const [plant, bunker] = buildings
  stash({ metal: 200 })
  sim.send(1, { type: 'work', building: plant, on: true })
  for (let i = 0; i < 3; i++) spawnUnit(sim, 'truck', 1, x + 2 + i * 2, y + 5)
  seconds(sim, 90)
  // В обоих бункерах — ряд хранилищ base добавляет ещё один — что-то есть.
  const filled: number[] = []
  for (const [entity, inventory] of sim.world.query(Inventory)) if (entity !== plant && (inventory.items.ammo ?? 0) > 0 && STORES.includes(sim.world.get(entity, Building)?.type as never)) filled.push(entity)
  expect(filled.length).toBeGreaterThanOrEqual(2)
  expect(filled).toContain(bunker)
})
