import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createSim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { Path } from '../src/sim/components'
import { approach } from '../src/sim/inventory'
import { spawnUnit } from '../src/sim/units'

test('грузовик едет к зданию дальше окна поиска пути: путь до края окна, остальное — на ходу', () => {
  const sim = createSim({ generator: { ...DEFAULT_CONFIG, blank: true }, size: 1024 })
  const building = placeBuilding(sim.world, 'metalYard', 200, 0, 1)
  const truck = spawnUnit(sim, 'truck', 1, -150, 0)
  expect(approach(sim, truck, building, 3)).toBe(true)
  expect(sim.world.get(truck, Path)?.goalX).toBeGreaterThan(190)
})
