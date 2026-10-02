import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  Deposit, canBuild, canPlace, createSim, creditsOf, depositAt, depositIn, depositNear, oreLeft, rewardsOf,
  zoneEconomies, zonesOf, type DepositSpot, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'

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

test('шахта добывает, только когда в зоне есть хранилище; руда продаётся и кончается', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 0)
  placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
  expect(zoneEconomies(sim, 1)).toEqual([{ produced: 0, demand: 0, income: 0, crowd: 0, ore: 0 }])
  seconds(sim, 2)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(spot.ore)

  placeBuilding(sim.world, 'silo', spot.x + 3, spot.y, 1)
  expect(zoneEconomies(sim, 1)).toEqual([{ produced: 0, demand: 0, income: 2, crowd: 0, ore: 2 }])
  seconds(sim, 10)
  expect(oreLeft(sim, spot.x, spot.y)).toBeCloseTo(spot.ore - 20)
  expect(creditsOf(sim, 1)).toBeGreaterThanOrEqual(19)
  expect(creditsOf(sim, 1)).toBeLessThanOrEqual(20)

  // Сохранение помнит, сколько добыто.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(oreLeft(copy, spot.x, spot.y)).toBeCloseTo(spot.ore - 20)

  // Руда кончилась — шахта встала, второй раз шахту здесь не поставить.
  for (const [, deposit] of sim.world.query(Deposit)) deposit.mined = spot.ore - 1
  seconds(sim, 2)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(0)
  expect(zoneEconomies(sim, 1)[0].ore).toBe(0)
  const credits = creditsOf(sim, 1)
  seconds(sim, 2)
  expect(creditsOf(sim, 1)).toBe(credits)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
})
