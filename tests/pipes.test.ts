import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { Assembly, BUILDINGS, Batch, Building, Builds, Inventory, Orders, Site, createSim, refundOf, type Sim } from '../src/sim'
import { placeBuilding, siteAt } from '../src/sim/buildings'
import { amountOf, put } from '../src/sim/inventory'
import { powerSupply } from '../src/sim/income'
import { BATCH } from '../src/sim/pipes'
import { networkOf, zonesOf } from '../src/sim/zones'
import { pipeStroke, pipeSwap, unlinked, wellPartners } from '../src/sim/piping'
import { addCredits, creditsOf } from '../src/sim/economy'
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

test('энергия идёт по зоне: рядом — и без трубы, вдали — по трубе', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 4)
  placeBuilding(sim.world, 'generator', x, y, 1)
  const near = placeBuilding(sim.world, 'radar', x + 4, y, 1)
  const far = placeBuilding(sim.world, 'radar', x + 20, y, 1)
  expect(powerSupply(sim).get(near)).toBeGreaterThan(0)
  expect(powerSupply(sim).get(far)).toBe(0)
  lay(sim, x, y + 2, 22)
  expect(powerSupply(sim).get(far)).toBeGreaterThan(0)
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

test('трубу тянут без зоны: цепочка закладывается целиком, строитель проходит её по очереди', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 40, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 3, y + 3)
  // От главного здания вправо на 30 тайлов — дальше его зоны (12 от центра).
  const tiles: number[] = []
  for (let tx = x + 3; tx < x + 33; tx++) tiles.push(tx, y + 1)
  expect(pipeStroke(sim, 1, tiles).every(Boolean)).toBe(true)
  // Своя зона не нужна и отдельному тайлу.
  expect(pipeStroke(sim, 1, [x + 30, y + 3])).toEqual([true])
  sim.send(1, { type: 'pipes', tiles, builders: [builder] })
  run(sim, 1)
  let sites = 0
  for (const [, site] of sim.world.query(Site)) if (site.type === 'pipe') sites++
  expect(sites).toBe(30)
  run(sim, 20 * 90)
  expect(networkOf(sim, sim.occupancy.at(x + 32, y + 1)!)).toBe(networkOf(sim, sim.occupancy.at(x, y)!))
  // В чужой зоне класть нельзя.
  placeBuilding(sim.world, 'command', x + 36, y, 2)
  expect(pipeStroke(sim, 1, [x + 34, y + 3])).toEqual([false])
})

test('«Снять» убирает и трубы: заложенную — сразу с возвратом, готовую разбирают строители', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 3, y + 3)
  const built = placeBuilding(sim.world, 'pipe', x + 3, y + 1, 1)
  sim.send(1, { type: 'pipes', tiles: [x + 10, y + 1], builders: [] })
  run(sim, 1)
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'unpave', tiles: [x + 3, y + 1, x + 10, y + 1], builders: [builder] })
  run(sim, 1)
  // Заложенная отменилась с полным возвратом; готовую разбирают.
  expect(siteAt(sim, x + 10, y + 1)).toBeUndefined()
  expect(creditsOf(sim, 1) - credits).toBeGreaterThanOrEqual(5)
  expect(sim.world.get(built, Site)?.demolish).toBe(true)
  run(sim, 20 * 10)
  expect(sim.world.alive(built)).toBe(false)
})

test('колодцы кладут парой (по прямой, от 2 до 10 тайлов, оба или ни одного) или по одному', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  addCredits(sim, 1, 1000)
  const wells = () => {
    let count = 0
    for (const [, site] of sim.world.query(Site)) if (site.type === 'well') count++
    return count
  }
  // Не по прямой, слишком близко и слишком далеко — не кладут.
  for (const tiles of [[x, y, x + 4, y + 1], [x, y, x + 1, y], [x, y, x + 11, y]]) sim.send(1, { type: 'wells', tiles, builders: [] })
  run(sim, 1)
  expect(wells()).toBe(0)
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'wells', tiles: [x, y, x + 8, y], builders: [] })
  run(sim, 1)
  expect(wells()).toBe(2)
  expect(credits - creditsOf(sim, 1)).toBe(80)
  // И по одному: щелчок без протяжки.
  sim.send(1, { type: 'wells', tiles: [x + 12, y], builders: [] })
  run(sim, 1)
  expect(wells()).toBe(3)
  expect(credits - creditsOf(sim, 1)).toBe(120)
})

test('«Разобрать» рамкой разбирает здания, только целиком попавшие в неё', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 6, y + 3)
  const inside = placeBuilding(sim.world, 'generator', x, y, 1)
  const half = placeBuilding(sim.world, 'generator', x + 3, y, 1)
  // Рамка 4×2 от (x, y): первая станция целиком, вторая — наполовину.
  const tiles: number[] = []
  for (let ty = y; ty < y + 2; ty++) for (let tx = x; tx < x + 4; tx++) tiles.push(tx, ty)
  sim.send(1, { type: 'unpave', tiles, builders: [builder] })
  run(sim, 1)
  expect(sim.world.get(inside, Site)?.demolish).toBe(true)
  expect(sim.world.has(half, Site)).toBe(false)
})

test('здание со складом без трубы — не подключено к сети, с трубой — подключено', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 12, 4)
  const yard = placeBuilding(sim.world, 'metalYard', x, y, 1)
  const radar = placeBuilding(sim.world, 'radar', x + 8, y, 1)
  expect(unlinked(sim, 1, yard)).toBe(true)
  expect(unlinked(sim, 1, radar)).toBe(false)
  expect(unlinked(sim, 2, yard)).toBe(false)
  lay(sim, x, y + 2, 10)
  expect(unlinked(sim, 1, yard)).toBe(false)
})

test('протяжка через стоящую трубу пропускает её тайл и тянется дальше; кончились кредиты — обрывается', () => {
  const pipeSites = (sim: Sim) => {
    let count = 0
    for (const [, site] of sim.world.query(Site)) if (site.type === 'pipe') count++
    return count
  }
  const stroke = (credits: number) => {
    const sim = createSim(options)
    const { x, y } = rock(sim, 20, 2)
    placeBuilding(sim.world, 'pipe', x + 4, y, 1)
    addCredits(sim, 1, credits)
    const tiles: number[] = []
    for (let tx = x; tx < x + 15; tx++) tiles.push(tx, y)
    expect(pipeStroke(sim, 1, tiles).filter(Boolean).length).toBe(14)
    sim.send(1, { type: 'pipes', tiles, builders: [] })
    run(sim, 1)
    return pipeSites(sim)
  }
  expect(stroke(1000)).toBe(14)
  expect(stroke(BUILDINGS.pipe.cost * 6)).toBe(6)
})

/** Что лежит в тайле: вид готового здания или заложенной стройки. */
const kindAt = (sim: Sim, x: number, y: number) => {
  const built = sim.occupancy.at(x, y)
  if (built !== undefined && sim.world.alive(built)) return sim.world.get(built, Building)!.type
  const site = siteAt(sim, x, y)
  return site === undefined ? undefined : `${sim.world.get(site, Site)!.type}?`
}

test('колодец кладут вместо своей трубы и трубу вместо колодца: старое убирается с возвратом, новое закладывается', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  addCredits(sim, 1, 1000)
  lay(sim, x, y, 3)
  placeBuilding(sim.world, 'well', x + 8, y, 1)
  let credits = creditsOf(sim, 1)
  sim.send(1, { type: 'wells', tiles: [x + 1, y], builders: [] })
  sim.send(2, { type: 'wells', tiles: [x, y], builders: [] })
  run(sim, 1)
  expect([kindAt(sim, x, y), kindAt(sim, x + 1, y), kindAt(sim, x + 2, y)]).toEqual(['pipe', 'well?', 'pipe'])
  expect(credits - creditsOf(sim, 1)).toBe(BUILDINGS.well.cost - refundOf('pipe'))
  // Обратно: труба поверх заложенного колодца (возврат целиком) и поверх готового (как за разбор).
  credits = creditsOf(sim, 1)
  sim.send(1, { type: 'pipes', tiles: [x + 1, y, x + 8, y], builders: [] })
  run(sim, 1)
  expect([kindAt(sim, x + 1, y), kindAt(sim, x + 8, y)]).toEqual(['pipe?', 'pipe?'])
  expect(credits - creditsOf(sim, 1)).toBe(2 * BUILDINGS.pipe.cost - BUILDINGS.well.cost - refundOf('well'))
  // Колодец на своём колодце и труба на своей трубе — не кладутся.
  placeBuilding(sim.world, 'well', x + 12, y, 1)
  credits = creditsOf(sim, 1)
  sim.send(1, { type: 'wells', tiles: [x + 12, y], builders: [] })
  sim.send(1, { type: 'pipes', tiles: [x, y], builders: [] })
  run(sim, 1)
  expect(creditsOf(sim, 1)).toBe(credits)
  // Чужую трубу не заменить.
  placeBuilding(sim.world, 'pipe', x + 5, y + 3, 2)
  run(sim, 1)
  expect(pipeSwap(sim, 1, 'well', x + 5, y + 3)).toBeUndefined()
  expect(pipeStroke(sim, 1, [x + 5, y + 3], 'well')).toEqual([false])
})

test('протяжка колодца от своего колодца закладывает только второй, а от своей трубы — заменяет её и кладёт оба', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  addCredits(sim, 1, 1000)
  const well = placeBuilding(sim.world, 'well', x, y, 1)
  lay(sim, x, y + 2, 2)
  let credits = creditsOf(sim, 1)
  // От стоящего колодца дальше 10 тайлов и не по прямой — никак; по прямой — один новый.
  sim.send(1, { type: 'wells', tiles: [x, y, x + 11, y], builders: [] })
  sim.send(1, { type: 'wells', tiles: [x, y, x + 6, y + 1], builders: [] })
  run(sim, 1)
  expect(creditsOf(sim, 1)).toBe(credits)
  sim.send(1, { type: 'wells', tiles: [x, y, x + 6, y], builders: [] })
  run(sim, 1)
  expect(sim.world.alive(well)).toBe(true)
  expect([kindAt(sim, x, y), kindAt(sim, x + 6, y)]).toEqual(['well', 'well?'])
  expect(credits - creditsOf(sim, 1)).toBe(BUILDINGS.well.cost)
  expect(wellPartners(sim, 1, x + 6, y)).toEqual([{ x, y, ready: true }])
  // Оба конца уже колодцы — класть нечего.
  credits = creditsOf(sim, 1)
  sim.send(1, { type: 'wells', tiles: [x, y, x + 6, y], builders: [] })
  run(sim, 1)
  expect(creditsOf(sim, 1)).toBe(credits)
  // От трубы: труба уходит, колодцев два.
  sim.send(1, { type: 'wells', tiles: [x + 1, y + 2, x + 9, y + 2], builders: [] })
  run(sim, 1)
  expect([kindAt(sim, x, y + 2), kindAt(sim, x + 1, y + 2), kindAt(sim, x + 9, y + 2)]).toEqual(['pipe', 'well?', 'well?'])
  expect(credits - creditsOf(sim, 1)).toBe(2 * BUILDINGS.well.cost - refundOf('pipe'))
})

test('укладка труб не стирает очередь строителя и не срывает его с работы; с Shift встаёт в очередь всем', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 20, 8)
  addCredits(sim, 1, 5000)
  const busy = spawnUnit(sim, 'builder', 1, x + 1, y + 6)
  const free = spawnUnit(sim, 'builder', 1, x + 3, y + 6)
  // Занятый строит колодец по приказу, и в очереди у него ещё один.
  sim.send(1, { type: 'wells', tiles: [x + 14, y + 6], builders: [busy] })
  run(sim, 1)
  const first = siteAt(sim, x + 14, y + 6)!
  sim.send(1, { type: 'wells', tiles: [x + 17, y + 6], builders: [busy], queue: true })
  run(sim, 1)
  const second = siteAt(sim, x + 17, y + 6)!
  const queued = () => sim.world.get(busy, Orders)?.list.map((item) => (item.command as { site?: number }).site) ?? []
  expect(sim.world.get(busy, Builds)).toMatchObject({ site: first, ordered: true })
  expect(queued()).toEqual([second])

  sim.send(1, { type: 'pipes', tiles: [x, y, x + 1, y, x + 2, y], builders: [busy, free] })
  run(sim, 1)
  const pipe = siteAt(sim, x, y)!
  // Занятый доделывает своё, труба встала ему в конец очереди; свободный поехал сразу.
  expect(sim.world.get(busy, Builds)).toMatchObject({ site: first })
  expect(queued()).toEqual([second, pipe])
  expect(sim.world.get(free, Builds)).toMatchObject({ site: pipe })
  // С Shift — в очередь и свободному; покрытие и снятие — так же.
  sim.send(1, { type: 'pave', kind: 'road', tiles: [x + 5, y + 3], builders: [busy, free], queue: true })
  sim.send(1, { type: 'unpave', tiles: [x + 2, y], builders: [busy], queue: true })
  run(sim, 1)
  expect(sim.world.get(free, Builds)).toMatchObject({ site: pipe })
  expect(sim.world.get(free, Orders)!.list.length).toBe(1)
  expect(queued().slice(0, 2)).toEqual([second, pipe])
  expect(queued().length).toBe(3)
  expect(siteAt(sim, x + 2, y)).toBeUndefined()
})
