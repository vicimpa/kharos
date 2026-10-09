import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { Assembly, Batch, Inventory, Site, createSim, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { amountOf, put } from '../src/sim/inventory'
import { powerSupply } from '../src/sim/income'
import { BATCH } from '../src/sim/pipes'
import { networkOf, zonesOf } from '../src/sim/zones'
import { pipeStroke, wellPartners } from '../src/sim/piping'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'
import { throughJson } from './throughJson'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }

function rock(sim: Sim, width: number, height: number) {
  for (let y = -200; y < 200; y++) {
    for (let x = -200; x < 200; x++) {
      let ok = true
      for (let ty = y; ty < y + height && ok; ty++) for (let tx = x; tx < x + width && ok; tx++) ok = terrainAt(sim.land, tx, ty) === Terrain.Rock
      if (ok) return { x, y }
    }
  }
  throw new Error('Не нашлось скалы')
}

/** Прогоняет ticks тиков: advance за раз делает их не больше нескольких. */
const run = (sim: Sim, ticks: number) => {
  for (let i = 0; i < ticks; i++) sim.advance(sim.time.step)
}

/** Наземная труба по ряду y от x до x + length - 1. */
const lay = (sim: Sim, x: number, y: number, length: number, player = 1) => {
  const pipes = []
  for (let i = 0; i < length; i++) pipes.push(placeBuilding(sim.world, 'pipe', x + i, y, player))
  return pipes
}

test('здания вплотную без трубы — разные сети, труба их соединяет', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 12, 4)
  const generator = placeBuilding(sim.world, 'generator', x, y, 1)
  const matter = placeBuilding(sim.world, 'matter', x + 2, y, 1)
  expect(networkOf(sim, generator)).not.toBe(networkOf(sim, matter))
  // Труба под ними: рядом с обоими основаниями снизу.
  lay(sim, x, y + 2, 4)
  expect(networkOf(sim, generator)).toBe(networkOf(sim, matter))
  expect(zonesOf(sim, 1).length).toBe(1)
})

test('энергия идёт только по сети: без трубы потребитель стоит', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 12, 4)
  placeBuilding(sim.world, 'generator', x, y, 1)
  const radar = placeBuilding(sim.world, 'radar', x + 6, y, 1)
  expect(powerSupply(sim).get(radar)).toBe(0)
  lay(sim, x, y + 2, 8)
  expect(powerSupply(sim).get(radar)).toBe(1)
})

test('колодцы связываются подземным отрезком по прямой', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  const one = placeBuilding(sim.world, 'well', x, y, 1)
  const two = placeBuilding(sim.world, 'well', x + 8, y, 1)
  expect(networkOf(sim, one)).toBe(networkOf(sim, two))
  const far = placeBuilding(sim.world, 'well', x + 8 + 11, y, 1)
  expect(networkOf(sim, far)).not.toBe(networkOf(sim, two))
})

test('пачка идёт тайл за тик и приходит на склад; следующая — через тик после прихода', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 6)
  // Хранилище металла и завод стройблоков на одной трубе. Без энергии завод только копит сырьё.
  const yard = placeBuilding(sim.world, 'metalYard', x, y, 1)
  const plant = placeBuilding(sim.world, 'blockPlant', x + 14, y, 1)
  put(sim.world.get(yard, Inventory)!, 'metal', 100)
  lay(sim, x, y + 2, 16)
  const assembly = sim.world.get(plant, Assembly)!
  assembly.on = true
  const step = sim.time.step
  sim.advance(step)
  const batches = []
  for (const [, item] of sim.world.query(Batch)) batches.push({ ...item })
  expect(batches.length).toBe(1)
  const batch = batches[0]
  expect(batch.amount).toBe(BATCH)
  expect(batch.to).toBe(plant)
  const length = batch.arrive - batch.sent
  expect(length).toBeGreaterThan(10)
  const before = amountOf(sim.world.get(plant, Inventory)!, 'metal')
  run(sim, length)
  expect(amountOf(sim.world.get(plant, Inventory)!, 'metal')).toBeGreaterThanOrEqual(before + BATCH - 1e-9)
  // Через тик после прихода маршрут свободен и уходит следующая.
  sim.advance(step)
  const next = []
  for (const [, item] of sim.world.query(Batch)) next.push({ ...item })
  expect(next.some((item) => item.sent > batch.sent && item.to === plant)).toBe(true)
})

test('перерезанная труба: пачка на ней пропадает', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 6)
  const yard = placeBuilding(sim.world, 'metalYard', x, y, 1)
  const plant = placeBuilding(sim.world, 'blockPlant', x + 14, y, 1)
  put(sim.world.get(yard, Inventory)!, 'metal', 100)
  const pipes = lay(sim, x, y + 2, 16)
  sim.world.get(plant, Assembly)!.on = true
  sim.advance(sim.time.step)
  const metal = () => amountOf(sim.world.get(yard, Inventory)!, 'metal') + amountOf(sim.world.get(plant, Inventory)!, 'metal')
  const total = metal()
  sim.world.destroy(pipes[8])
  run(sim, 30)
  expect(amountOf(sim.world.get(plant, Inventory)!, 'metal')).toBe(0)
  expect(metal()).toBeLessThanOrEqual(total)
})

test('пачки в пути переживают сохранение', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 6)
  const yard = placeBuilding(sim.world, 'metalYard', x, y, 1)
  const plant = placeBuilding(sim.world, 'blockPlant', x + 14, y, 1)
  put(sim.world.get(yard, Inventory)!, 'metal', 100)
  lay(sim, x, y + 2, 16)
  sim.world.get(plant, Assembly)!.on = true
  run(sim, 3)
  const loaded = createSim(throughJson(sim.save()))
  expect(loaded.world.count(Batch)).toBe(1)
  run(loaded, 40)
  expect(amountOf(loaded.world.get(plant, Inventory)!, 'metal')).toBeGreaterThan(0)
})

test('при постройке колодца видно, с какими колодцами он свяжется', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  placeBuilding(sim.world, 'well', x, y, 1)
  // Чужой колодец не в счёт, вплотную — не подземная связь.
  placeBuilding(sim.world, 'well', x + 4, y + 2, 2)
  expect(wellPartners(sim, 1, x + 6, y)).toEqual([{ x, y, ready: true }])
  expect(wellPartners(sim, 1, x + 1, y)).toEqual([])
  expect(wellPartners(sim, 1, x + 4, y + 2)).toEqual([])
  expect(wellPartners(sim, 1, x + 11, y)).toEqual([])
})

test('трубу тянут за край зоны: цепочка закладывается целиком, строитель проходит её по очереди', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 40, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 3, y + 3)
  // От главного здания вправо на 30 тайлов — дальше его зоны (12 от центра).
  const tiles: number[] = []
  for (let tx = x + 3; tx < x + 33; tx++) tiles.push(tx, y + 1)
  expect(pipeStroke(sim, 1, tiles).every(Boolean)).toBe(true)
  // Отдельный тайл вне зоны, не примыкающий к цепочке, не годится.
  expect(pipeStroke(sim, 1, [x + 30, y + 3])).toEqual([false])
  sim.send(1, { type: 'pipes', tiles, builders: [builder] })
  run(sim, 1)
  let sites = 0
  for (const [, site] of sim.world.query(Site)) if (site.type === 'pipe') sites++
  expect(sites).toBe(30)
  run(sim, 20 * 90)
  expect(networkOf(sim, sim.occupancy.at(x + 32, y + 1)!)).toBe(networkOf(sim, sim.occupancy.at(x, y)!))
})
