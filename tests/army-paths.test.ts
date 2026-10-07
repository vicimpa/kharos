import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, Path, Position } from '../src/sim'
import { findPath, findPaths } from '../src/sim/path'
import { orderGroupMove, spawnUnit } from '../src/sim/units'

/** Цена пути по тайлам: шаг прямо — 1, наискось — корень из двух, умноженные на цену тайла. */
function cost(fromX: number, fromY: number, path: number[], slowness: (x: number, y: number) => number) {
  let total = 0
  let x = fromX
  let y = fromY
  for (let i = 0; i < path.length; i += 2) {
    total += Math.hypot(path[i] - x, path[i + 1] - y) * slowness(path[i], path[i + 1])
    x = path[i]
    y = path[i + 1]
  }
  return total
}

test('общий поиск находит пути той же цены, что и поиск для каждого', () => {
  // Стена с проходом и болото: путь есть, но не прямой.
  const walkable = (x: number, y: number) => x !== 10 || y === 25
  const slowness = (x: number, y: number) => (y > 30 && x > 12 ? 3 : 1)
  const origins = [0, 0, 2, 40, 5, 10, -3, 25, 9, 9]
  const paths = findPaths(walkable, 20, 20, origins, undefined, slowness)
  for (let i = 0; i < origins.length; i += 2) {
    const shared = paths[i / 2]!
    expect(shared.slice(-2)).toEqual([20, 20])
    const own = findPath(walkable, origins[i], origins[i + 1], 20, 20, 0, undefined, slowness)
    expect(cost(origins[i], origins[i + 1], shared, slowness)).toBeCloseTo(cost(origins[i], origins[i + 1], own, slowness), 6)
  }
})

test('до недостижимого старта общий поиск пути не находит', () => {
  const walkable = (x: number) => x !== 10
  expect(findPaths(walkable, 20, 0, [0, 0], 5000)).toEqual([null])
})

test('большая армия получает пути, и каждый юнит — своё место', () => {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024 })
  const units: number[] = []
  for (let i = 0; i < 400; i++) units.push(spawnUnit(sim, i % 2 ? 'infantry' : 'buggy', 1, -40 + (i % 20), -10 + Math.floor(i / 20)))
  orderGroupMove(sim, units, 40, 0)
  const goals = new Set<string>()
  for (const entity of units) {
    const path = sim.world.get(entity, Path)
    if (!path) continue
    goals.add(`${path.goalX},${path.goalY}`)
  }
  // Почти у всех есть путь, и места не повторяются: армии хватает колец вокруг цели.
  expect(goals.size).toBeGreaterThan(380)
  for (let i = 0; i < 20 * 60; i++) sim.advance(1 / 20)
  const arrived = units.filter((entity) => Math.hypot(sim.world.get(entity, Position)!.x - 40, sim.world.get(entity, Position)!.y) < 30)
  expect(arrived.length).toBeGreaterThan(360)
})
