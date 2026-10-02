import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, Building, Deposit, Hauler, TRUCK_CAPACITY, canBuild, canPlace, createSim, creditsOf, depositAt, depositIn, depositNear, oreLeft, rewardsOf,
  zoneEconomies, zonesOf, type DepositSpot, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Симуляция и месторождение, справа от которого есть скала под хранилище. */
function start() {
  const sim = createSim(options)
  for (let cellY = -5; cellY < 5; cellY++) {
    for (let cellX = -5; cellX < 5; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (spot && canPlace(sim, 'silo', spot.x + 3, spot.y)) return { sim, spot }
    }
  }
  throw new Error('В мире не нашлось месторождения')
}

test('месторождения считаются из сида: одни и те же в двух мирах, на скале и не чаще одного на клетку', () => {
  const first = createSim(options)
  const second = createSim(options)
  const spots: DepositSpot[] = []
  for (let cellY = -6; cellY < 6; cellY++) {
    for (let cellX = -6; cellX < 6; cellX++) {
      const spot = depositIn(first, cellX, cellY)
      expect(depositIn(second, cellX, cellY)).toEqual(spot)
      if (spot) spots.push(spot)
    }
  }
  // Месторождений заметно меньше, чем клеток, но они есть.
  expect(spots.length).toBeGreaterThan(20)
  expect(spots.length).toBeLessThan(144)
  for (const spot of spots) {
    expect(canPlace(first, 'mine', spot.x, spot.y)).toBe(true)
    expect(spot.ore).toBeGreaterThanOrEqual(4000)
    expect(depositAt(first, spot.x, spot.y)).toBe(spot)
    expect(depositAt(first, spot.x + 1, spot.y)).toBeNull()
    expect(depositNear(first, spot.x + 2.5, spot.y + 1, 3)).toBe(spot)
  }
  // Нетронутые месторождения в мире не хранятся.
  expect(first.world.count(Deposit)).toBe(0)
})

test('шахта ставится только на месторождение и без своей зоны, строит её строитель', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 1000)
  expect(zonesOf(sim, 1).length).toBe(0)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(true)
  expect(canBuild(sim, 1, 'mine', spot.x + 1, spot.y)).toBe(false)
  // Чужая зона закрывает месторождение.
  const core = placeBuilding(sim.world, 'command', spot.x + 6, spot.y, 2)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
  sim.world.destroy(core)

  sim.send(1, { type: 'spawnUnit', unit: 'builder', x: spot.x - 1, y: spot.y })
  sim.send(1, { type: 'build', building: 'mine', x: spot.x, y: spot.y, builders: [] })
  seconds(sim, 30)
  // Готовая шахта начинает свою зону: рядом можно строить.
  expect(zonesOf(sim, 1).length).toBe(1)
  expect(rewardsOf(sim, 1)).toEqual(['mine'])
  expect(canBuild(sim, 1, 'silo', spot.x + 3, spot.y)).toBe(true)
})

/** Крутит симуляцию, пока условие не выполнится; падает, если не дождалась за limit секунд. */
function until(sim: Sim, done: () => boolean, limit = 120) {
  for (let i = 0; i < limit / TICK; i++) {
    if (done()) return
    sim.advance(TICK)
  }
  throw new Error('Не дождались')
}

test('шахта работает, только пока у неё стоит грузовик; руду возят в хранилище, там она продаётся', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 0)
  const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
  const silo = placeBuilding(sim.world, 'silo', spot.x + 3, spot.y, 1)
  const stock = () => sim.world.get(silo, Building)!.ore
  // Без грузовика шахта стоит, сколько бы хранилищ рядом ни было.
  seconds(sim, 5)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(spot.ore)
  expect(zoneEconomies(sim, 1)).toEqual([{ produced: 0, demand: 0, income: 0, crowd: 0, ore: 0 }])

  // Грузовик без привязки сам за руду не берётся.
  const truck = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y)
  const cargo = () => sim.world.get(truck, Hauler)!
  seconds(sim, 3)
  expect(cargo().ore).toBe(0)
  // Чужой грузовик к шахте не привязать.
  const stranger = spawnUnit(sim, 'truck', 2, spot.x - 1, spot.y + 1)
  sim.send(2, { type: 'haul', units: [stranger], mine })
  sim.send(1, { type: 'haul', units: [truck, stranger], mine })
  sim.advance(TICK)
  expect(sim.world.get(stranger, Hauler)!.mine).toBe(-1)
  sim.world.destroy(stranger)

  // Привязанный грузится со скоростью шахты и везёт полный кузов в хранилище.
  seconds(sim, 10)
  expect(cargo().ore).toBeCloseTo(20, 0)
  expect(oreLeft(sim, spot.x, spot.y)).toBeCloseTo(spot.ore - cargo().ore)
  until(sim, () => cargo().full)
  expect(cargo().ore).toBe(TRUCK_CAPACITY)
  until(sim, () => stock() > 0)
  expect(zoneEconomies(sim, 1)[0].ore).toBe(2)
  // Разгрузился — вернулся к шахте сам.
  until(sim, () => !cargo().full && cargo().ore > 0)
  expect(creditsOf(sim, 1)).toBeGreaterThan(0)
  seconds(sim, 60)
  // Всё добытое либо продано, либо лежит в хранилище, либо едет в кузове.
  const mined = spot.ore - oreLeft(sim, spot.x, spot.y)
  expect(mined).toBeGreaterThan(TRUCK_CAPACITY)
  expect(Math.abs(mined - creditsOf(sim, 1) - stock() - cargo().ore)).toBeLessThan(1.5)

  // Приказ идти снимает грузовик с маршрута.
  sim.send(1, { type: 'move', units: [truck], x: spot.x - 3, y: spot.y })
  seconds(sim, 5)
  expect(cargo().mine).toBe(-1)
  const left = oreLeft(sim, spot.x, spot.y)
  seconds(sim, 5)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(left)

  // Сохранение помнит и добытое, и груз.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(oreLeft(copy, spot.x, spot.y)).toBe(left)
  expect(copy.world.get(truck, Hauler)!.ore).toBe(cargo().ore)
})

test('шахта грузит один грузовик, остальные ждут рядом; полное хранилище больше не принимает', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 0)
  const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
  const silo = placeBuilding(sim.world, 'silo', spot.x + 3, spot.y, 1)
  const trucks = [spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y), spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y + 1)]
  const haulers = () => trucks.map((truck) => sim.world.get(truck, Hauler)!)
  sim.send(1, { type: 'haul', units: trucks, mine })
  seconds(sim, 10)
  // За 10 секунд шахта выдала 20 руды, и вся она в одном кузове.
  expect(haulers().filter((hauler) => hauler.loading).length).toBe(1)
  expect(haulers().map((hauler) => Math.round(hauler.ore)).sort((a, b) => a - b)).toEqual([0, 20])
  // Первый уехал — шахта взялась за второго.
  until(sim, () => haulers().some((hauler) => hauler.full))
  seconds(sim, 3)
  expect(haulers().filter((hauler) => hauler.loading).length).toBe(1)
  expect(haulers().every((hauler) => hauler.full || hauler.loading)).toBe(true)

  // Хранилище конечно: в полное грузовик выгружает только то, что успело продаться.
  const capacity = BUILDINGS.silo.stores
  sim.world.get(silo, Building)!.ore = capacity
  until(sim, () => haulers().some((hauler) => hauler.full && hauler.ore < TRUCK_CAPACITY))
  const waiting = haulers().find((hauler) => hauler.full && hauler.ore < TRUCK_CAPACITY)!
  const before = waiting.ore
  seconds(sim, 5)
  expect(sim.world.get(silo, Building)!.ore).toBeLessThanOrEqual(capacity)
  expect(sim.world.get(silo, Building)!.ore).toBeGreaterThan(capacity - 3)
  // За 5 секунд продано 10 руды — столько же и выгружено; без ограничения ушло бы 100.
  expect(before - waiting.ore).toBeGreaterThan(8)
  expect(before - waiting.ore).toBeLessThan(12)
})

test('выработанное месторождение: грузовик довозит остаток и освобождается, шахту второй раз не поставить', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 0)
  const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
  placeBuilding(sim.world, 'silo', spot.x + 3, spot.y, 1)
  const truck = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y)
  sim.send(1, { type: 'haul', units: [truck], mine })
  seconds(sim, 3)
  for (const [, deposit] of sim.world.query(Deposit)) deposit.mined = spot.ore - 1
  until(sim, () => oreLeft(sim, spot.x, spot.y) === 0)
  until(sim, () => sim.world.get(truck, Hauler)!.mine === -1)
  expect(sim.world.get(truck, Hauler)!.ore).toBe(0)
  seconds(sim, 10)
  const credits = creditsOf(sim, 1)
  expect(credits).toBeGreaterThan(0)
  seconds(sim, 5)
  expect(creditsOf(sim, 1)).toBe(credits)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
})
