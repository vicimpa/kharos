import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { BUILDINGS, Position, buildingSight, createSim, unitSight, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 256 }
const TICK = 1 / 20

test('обзор: разведчик видит дальше пехоты, стрелок — дальше своего оружия, радар — дальше всех зданий', () => {
  expect(unitSight('buggy')).toBeGreaterThan(unitSight('infantry'))
  expect(unitSight('lancer')).toBeGreaterThan(7.5)
  expect(buildingSight('radar')).toBeGreaterThan(buildingSight('command'))
  expect(buildingSight('command', true)).toBeLessThan(buildingSight('command'))
})

test('игрок видит вокруг своих юнитов, а ушедший юнит оставляет за собой разведанное, но не видимое', () => {
  const sim = createSim(options)
  const scout = spawnUnit(sim, 'infantry', 1, 0, 0)
  const sight = unitSight('infantry')
  expect(sim.vision.sees(1, 0, 0)).toBe(true)
  expect(sim.vision.sees(1, sight - 1, 0)).toBe(true)
  expect(sim.vision.sees(1, sight + 2, 0)).toBe(false)
  expect(sim.vision.explored(1, 30, 30)).toBe(false)
  // Другой игрок здесь ничего не видит.
  expect(sim.vision.sees(2, 0, 0)).toBe(false)

  sim.world.get(scout, Position)!.x = 40
  sim.advance(TICK)
  expect(sim.vision.sees(1, 0, 0)).toBe(false)
  expect(sim.vision.explored(1, 0, 0)).toBe(true)
  expect(sim.vision.sees(1, 40, 0)).toBe(true)
})

test('чужое видно, только пока оно в обзоре: здание — хотя бы краем основания', () => {
  const sim: Sim = createSim(options)
  spawnUnit(sim, 'infantry', 1, 0, 0)
  const sight = unitSight('infantry')
  const near = spawnUnit(sim, 'tank', 2, 3, 0)
  const far = spawnUnit(sim, 'tank', 2, 0, 30)
  // Край склада металла — в обзоре, его середина — нет.
  const edge = placeBuilding(sim.world, 'metalYard', Math.floor(sight) - 1, -1, 2)
  expect(BUILDINGS.metalYard.width).toBeGreaterThan(1)
  sim.advance(TICK)
  expect(sim.vision.seesEntity(1, near)).toBe(true)
  expect(sim.vision.seesEntity(1, far)).toBe(false)
  expect(sim.vision.seesEntity(1, edge)).toBe(true)
  // Своё видно всегда.
  expect(sim.vision.seesEntity(2, far)).toBe(true)
})

test('разведанное переживает сохранение, а видимое — нет: после загрузки видно только то, что видят юниты', () => {
  const sim = createSim(options)
  const scout = spawnUnit(sim, 'infantry', 1, 0, 0)
  sim.advance(TICK)
  sim.world.get(scout, Position)!.x = 60
  sim.advance(TICK)
  expect(sim.vision.explored(1, 0, 0)).toBe(true)

  const loaded = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(loaded.vision.explored(1, 0, 0)).toBe(true)
  expect(loaded.vision.sees(1, 0, 0)).toBe(false)
  expect(loaded.vision.sees(1, 60, 0)).toBe(true)
  expect(loaded.vision.explored(1, -60, 0)).toBe(false)
})

test('без тумана войны видно всё, и параметр переживает сохранение', () => {
  const sim = createSim({ ...options, fog: false })
  spawnUnit(sim, 'infantry', 1, 0, 0)
  const far = spawnUnit(sim, 'tank', 2, 0, 80)
  sim.advance(TICK)
  expect(sim.vision.sees(1, 100, -100)).toBe(true)
  expect(sim.vision.seesEntity(1, far)).toBe(true)
  // У игрока, у которого на карте ничего нет, — тоже.
  expect(sim.vision.sees(3, 0, 0)).toBe(true)
  expect(createSim(JSON.parse(JSON.stringify(sim.save()))).vision.sees(1, 100, -100)).toBe(true)
  expect(createSim(options).options.fog).toBeUndefined()
})
