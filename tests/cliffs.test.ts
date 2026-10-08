import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, Terrain, isCliffFoot, setTile } from '../src/map/terrain'
import { Position, canDeploy, createSim, type Sim } from '../src/sim'
import { CORE, canPlace } from '../src/sim/buildings'
import { isWalkable, notWalledIn, openSpawn, orderMove, spawnUnit, terrainSpeed } from '../src/sim/units'

const STEP = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / STEP); i++) sim.advance(STEP)
}

/** Ровная скала первого яруса в квадрате side × side от (left, top). */
function flat(sim: Sim, left: number, top: number, side: number) {
  for (let y = top; y < top + side; y++) for (let x = left; x < left + side; x++) setTile(sim.land, x, y, { terrain: Terrain.Rock, biome: 0, tier: 1, cliff: false })
}

/** Плато второго яруса с обрывом по всему краю: квадрат side × side от (left, top). */
function mesa(sim: Sim, left: number, top: number, side: number) {
  for (let y = top; y < top + side; y++) for (let x = left; x < left + side; x++) setTile(sim.land, x, y, { terrain: Terrain.Rock, biome: 0, tier: 2, cliff: true })
}

const world = () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  flat(sim, -30, -30, 60)
  return sim
}

test('подножие обрыва — нижние тайлы у стенки; технике туда нельзя, пехоте можно, но медленно; верх — свободен', () => {
  const sim = world()
  mesa(sim, 0, 0, 10)
  expect(isCliffFoot(sim.land, -1, 5)).toBe(true)
  expect(isCliffFoot(sim.land, 5, 10)).toBe(true)
  expect(isCliffFoot(sim.land, 10, 10)).toBe(true)
  expect(isCliffFoot(sim.land, 0, 5)).toBe(false)
  expect(isCliffFoot(sim.land, -2, 5)).toBe(false)
  expect(isWalkable(sim, 0, 5)).toBe(true)
  expect(isWalkable(sim, 5, 10)).toBe(false)
  expect(isWalkable(sim, 5, 10, true)).toBe(true)
  expect(terrainSpeed(sim, 'infantry', 5, 10)).toBeLessThan(terrainSpeed(sim, 'infantry', 5, 12))
  expect(terrainSpeed(sim, 'buggy', 5, 12)).toBe(1)
})

test('пологий край (без обрыва) проходим всем', () => {
  const sim = world()
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setTile(sim.land, x, y, { terrain: Terrain.Rock, biome: 0, tier: 2, cliff: false })
  expect(isCliffFoot(sim.land, -1, 5)).toBe(false)
  expect(isWalkable(sim, -1, 5)).toBe(true)
})

test('на плато за обрывом пехота забирается, а техника — нет', () => {
  const sim = world()
  mesa(sim, 0, 0, 10)
  const tank = spawnUnit(sim, 'tank', 1, -10, 5)
  const soldier = spawnUnit(sim, 'infantry', 1, -10, 6)
  orderMove(sim, tank, 5, 5)
  orderMove(sim, soldier, 5, 6)
  seconds(sim, 30)
  const at = (entity: number) => sim.world.get(entity as never, Position)!
  expect(Math.floor(at(soldier).x)).toBe(5)
  expect(Math.floor(at(soldier).y)).toBe(6)
  // Танк встаёт у подножия: на плато он не заезжает.
  const onMesa = (x: number, y: number) => x >= 0 && x < 10 && y >= 0 && y < 10
  expect(onMesa(at(tank).x, at(tank).y)).toBe(false)
})

test('место появления не запирается обрывами', () => {
  const sim = world()
  // Карман первого яруса посреди плато: со всех сторон обрыв, технике не выбраться.
  mesa(sim, -20, -20, 40)
  flat(sim, -3, -3, 6)
  expect(notWalledIn(sim, 0, 0)).toBe(false)
  const spot = openSpawn(sim, 0, 0)
  expect(notWalledIn(sim, spot.x, spot.y)).toBe(true)
  expect(Math.max(Math.abs(spot.x), Math.abs(spot.y))).toBeGreaterThan(3)
})

test('здание и разворачивание MCV — по одному правилу: не у подножия обрыва, а через пологий въезд — можно на два яруса', () => {
  const sim = world()
  mesa(sim, 0, 0, 10)
  // Подножие под плато — ряд y = 10.
  expect(canPlace(sim, 'generator', 4, 10)).toBe(false)
  expect(canPlace(sim, 'generator', 4, 11)).toBe(true)
  // На самом плато у края — можно: стенка ниже.
  expect(canPlace(sim, 'generator', 4, 8)).toBe(true)

  const mcvAt = (x: number, y: number) => spawnUnit(sim, 'mcv', 1, x, y)
  // Главное здание встаёт вокруг MCV: над подножием — нельзя, в стороне — можно.
  const blocked = mcvAt(5, 11)
  expect(canDeploy(sim, 1, blocked)).toBe(canPlace(sim, CORE, 4, 10))
  expect(canDeploy(sim, 1, blocked)).toBe(false)
  const open = mcvAt(-15, -15)
  expect(canDeploy(sim, 1, open)).toBe(true)

  // Пологий въезд: второй ярус без обрыва — здание встаёт поперёк перепада.
  for (let y = 20; y < 26; y++) for (let x = 0; x < 6; x++) setTile(sim.land, x, y, { terrain: Terrain.Rock, biome: 0, tier: 2, cliff: false })
  expect(canPlace(sim, 'generator', 5, 22)).toBe(true)
})
