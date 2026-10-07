import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, Path, Position } from '../src/sim'
import { orderGroupMove, spawnUnit } from '../src/sim/units'

test('большая армия сразу трогается, каждый юнит — к своему месту, и доходит', () => {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024 })
  const units: number[] = []
  for (let i = 0; i < 400; i++) units.push(spawnUnit(sim, i % 2 ? 'infantry' : 'buggy', 1, -40 + (i % 20), -10 + Math.floor(i / 20)))
  orderGroupMove(sim, units, 40, 0)
  const goals = new Set<string>()
  for (const entity of units) {
    const path = sim.world.get(entity, Path)
    if (!path) continue
    goals.add(`${path.goalX},${path.goalY}`)
    // Пути приказ не ищет: их проложит planPaths в следующие тики.
    expect(path.pending).toBe(true)
  }
  // Почти у всех есть путь, и места не повторяются: армии хватает колец вокруг цели.
  expect(goals.size).toBeGreaterThan(380)
  for (let i = 0; i < 20 * 60; i++) sim.advance(1 / 20)
  const arrived = units.filter((entity) => Math.hypot(sim.world.get(entity, Position)!.x - 40, sim.world.get(entity, Position)!.y) < 30)
  expect(arrived.length).toBeGreaterThan(360)
})
