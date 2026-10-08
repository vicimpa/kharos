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

test('места в замкнутом кармане между зданиями грузовик не пробует: подъезжает с открытой стороны', () => {
  const sim = createSim({ generator: { ...DEFAULT_CONFIG, blank: true }, size: 256 })
  const building = placeBuilding(sim.world, 'blockPlant', 0, 0, 1)
  placeBuilding(sim.world, 'blockPlant', 0, 2, 1)
  // Карман x = -1, y = 0…3: слева, сверху и снизу — склады, справа — заводы. Он ближе к грузовику, чем открытая сторона.
  for (let x = -2; x <= 3; x++) placeBuilding(sim.world, 'khariteVault', x, -1, 1)
  for (let y = 0; y <= 4; y++) placeBuilding(sim.world, 'khariteVault', -2, y, 1)
  placeBuilding(sim.world, 'khariteVault', -1, 4, 1)
  const truck = spawnUnit(sim, 'truck', 1, -10, 1)
  expect(approach(sim, truck, building, 2)).toBe(true)
  const { goalX, goalY } = sim.world.get(truck, Path)!
  expect(goalX === -1 && goalY >= 0 && goalY <= 3).toBe(false)
})
