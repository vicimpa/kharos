import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Path, Producer, Unit, canPlace, createSim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'

test('точка сбора: готовый юнит сам едет к ней; чужому зданию её не поставить', () => {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 256 })
  addCredits(sim, 1, 10000)
  let spot: { x: number; y: number } | undefined
  for (let y = -60; y < 60 && !spot; y++) for (let x = -60; x < 60 && !spot; x++) if (canPlace(sim, 'command', x, y) && canPlace(sim, 'command', x + 3, y + 3)) spot = { x, y }
  const core = placeBuilding(sim.world, 'command', spot!.x, spot!.y, 1)
  // Чужой не поставит, неверный тайл не примется.
  sim.send(2, { type: 'rally', building: core, x: spot!.x + 8, y: spot!.y })
  sim.advance(1 / 20)
  expect(sim.world.get(core, Producer)!.rally).toEqual([])
  sim.send(1, { type: 'rally', building: core, x: spot!.x + 8, y: spot!.y + 1 })
  sim.send(1, { type: 'produce', producer: core, unit: 'builder' })
  sim.advance(1 / 20)
  expect(sim.world.get(core, Producer)!.rally).toEqual([spot!.x + 8, spot!.y + 1])
  const before = new Set([...sim.world.query(Unit)].map(([entity]) => entity))
  let made: number | undefined
  for (let i = 0; i < 20 * 60 && made === undefined; i++) {
    sim.advance(1 / 20)
    for (const [entity] of sim.world.query(Unit)) if (!before.has(entity)) made = entity
  }
  expect(made).toBeDefined()
  const path = sim.world.get(made!, Path)!
  expect(Math.hypot(path.goalX - (spot!.x + 8), path.goalY - (spot!.y + 1))).toBeLessThan(2)
})
