import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { BUILDINGS, Inventory, Position, amountOf, canPlace, createSim, type BuildingType, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { Hauler } from '../src/sim/components'
import { addCredits } from '../src/sim/economy'
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
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Главное здание, электростанции и здания из списка в ряд на скале; под ними — место для грузовика. */
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
      return { sim, buildings: buildings.slice(3), truck }
    }
  }
  throw new Error('Не нашлось места')
}

const amount = (sim: Sim, entity: Entity, good: Parameters<typeof amountOf>[1]) => amountOf(sim.world.get(entity, Inventory)!, good)

test('грузовик с маршрутом возит со склада на склад то, что принимает следующая остановка', () => {
  const { sim, buildings: [from, to], truck } = base(['metalYard', 'metalYard'])
  sim.world.get(from, Inventory)!.items.metal = 100
  sim.send(1, { type: 'route', units: [truck], stops: [from, to] })
  until(sim, () => amount(sim, to, 'metal') >= 100)
  expect(amount(sim, from, 'metal')).toBeLessThan(1e-6)
  // Возить больше нечего: грузовик пустой ждёт, маршрут остаётся.
  seconds(sim, 3)
  expect(sim.world.get(truck, Hauler)!.route).toEqual([from, to])
})

test('фильтр: грузовик возит только разрешённое, и по маршруту тоже', () => {
  const { sim, buildings: [smelter, yard], truck } = base(['smelter', 'metalYard'])
  sim.world.get(smelter, Inventory)!.items.metal = 20
  sim.send(1, { type: 'filter', units: [truck], goods: ['silicon'] })
  sim.send(1, { type: 'route', units: [truck], stops: [smelter, yard] })
  seconds(sim, 20)
  expect(amount(sim, yard, 'metal')).toBe(0)
  sim.send(1, { type: 'filter', units: [truck], goods: [] })
  until(sim, () => amount(sim, yard, 'metal') >= 20)
})

test('приказ идти снимает маршрут; с одной остановкой маршрута нет', () => {
  const { sim, buildings: [from, to], truck } = base(['metalYard', 'metalYard'])
  sim.send(1, { type: 'route', units: [truck], stops: [from, from] })
  sim.advance(TICK)
  expect(sim.world.get(truck, Hauler)!.route).toEqual([])
  sim.send(1, { type: 'route', units: [truck], stops: [from, to] })
  sim.advance(TICK)
  expect(sim.world.get(truck, Hauler)!.route.length).toBe(2)
  sim.send(1, { type: 'move', units: [truck], x: 0, y: 0 })
  sim.advance(TICK)
  expect(sim.world.get(truck, Hauler)!.route).toEqual([])
})

test('фильтр действует и на работу от диспетчера: чужой груз грузовик не берёт', () => {
  const { sim, buildings: [smelter, yard], truck } = base(['smelter', 'metalYard'])
  sim.world.get(smelter, Inventory)!.items.metal = 20
  sim.send(1, { type: 'filter', units: [truck], goods: ['silicon', 'fuel'] })
  seconds(sim, 20)
  expect(amount(sim, yard, 'metal')).toBe(0)
  sim.send(1, { type: 'filter', units: [truck], goods: ['metal'] })
  until(sim, () => amount(sim, yard, 'metal') >= 20)
})

test('летающий грузовик возит по маршруту, как обычный: меньше за раз, но быстрее', () => {
  const { sim, buildings: [from, to], truck } = base(['metalYard', 'metalYard'])
  const { x, y } = sim.world.get(truck, Position)!
  sim.world.destroy(truck)
  const flyer = spawnUnit(sim, 'airTruck', 1, Math.floor(x), Math.floor(y))
  expect(sim.world.has(flyer, Hauler)).toBe(true)
  expect(sim.world.get(flyer, Inventory)!.capacity).toBeLessThan(25)
  sim.world.get(from, Inventory)!.items.metal = 40
  sim.send(1, { type: 'route', units: [flyer], stops: [from, to] })
  until(sim, () => amount(sim, to, 'metal') >= 40)
})

test('фильтр снимает начатую работу с грузом, которого он не пускает', () => {
  const { sim, buildings: [smelter], truck } = base(['smelter', 'metalYard'])
  sim.world.get(smelter, Inventory)!.items.metal = 20
  const hauler = sim.world.get(truck, Hauler)!
  // Диспетчер дал работу: вывезти металл из плавильни в хранилище.
  until(sim, () => hauler.from === smelter)
  expect(hauler.resource).toBe('metal')
  sim.send(1, { type: 'filter', units: [truck], goods: ['silicon'] })
  sim.advance(TICK)
  expect(hauler.from).toBe(-1)
  expect(hauler.to).toBe(-1)
  // И новую работу с металлом он не берёт.
  seconds(sim, 5)
  expect(hauler.from === -1 || hauler.resource !== 'metal').toBe(true)
})

test('назначенный на здания грузовик возит только по их заявкам, а груз берёт и в чужой для них зоне', () => {
  const { sim, buildings: [bunker, mine, other], truck } = base(['ammoBunker', 'turret', 'turret'])
  sim.world.get(bunker, Inventory)!.items.ammo = 200
  sim.world.get(mine, Inventory)!.items.ammo = 0
  sim.world.get(other, Inventory)!.items.ammo = 0
  // Турели — отдельная зона без хранилищ: свободный грузовик патроны из чужой зоны к ним не возит.
  seconds(sim, 20)
  expect(amount(sim, mine, 'ammo')).toBe(0)
  sim.send(1, { type: 'serve', units: [truck], buildings: [mine] })
  // Турель заказывает, пока не наберёт три четверти запаса и больше.
  until(sim, () => amount(sim, mine, 'ammo') >= sim.world.get(mine, Inventory)!.capacity * 0.75)
  seconds(sim, 20)
  expect(amount(sim, other, 'ammo')).toBe(0)
})

test('назначение: чужие и без склада здания выбрасываются, приказ идти снимает его, снесённое выпадает', () => {
  const { sim, buildings: [yard, turret], truck } = base(['metalYard', 'turret'])
  const hauler = sim.world.get(truck, Hauler)!
  sim.send(1, { type: 'serve', units: [truck], buildings: [yard, turret, 99999] })
  sim.advance(TICK)
  expect(hauler.serve).toEqual([yard, turret])
  sim.world.destroy(yard)
  seconds(sim, 1)
  expect(hauler.serve).toEqual([turret])
  sim.send(1, { type: 'move', units: [truck], x: 0, y: 0 })
  sim.advance(TICK)
  expect(hauler.serve).toEqual([])
})
