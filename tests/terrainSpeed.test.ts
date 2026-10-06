import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Biome, Terrain, biomeAt, terrainAt } from '../src/map/terrain'
import { Health, createSim, isWalkable } from '../src/sim'
import { findPath, smoothPath } from '../src/sim/path'
import { spawnUnit, terrainSpeed } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }

function tileOf(sim: ReturnType<typeof createSim>, terrain: Terrain, biome: Biome = Biome.Marsh) {
  for (let y = -500; y < 500; y++) {
    for (let x = -500; x < 500; x++) if (terrainAt(sim.land, x, y) === terrain && biomeAt(sim.land, x, y) === biome) return { x, y }
  }
  throw new Error('не нашлось местности')
}

test('колёсная техника на песке теряет 10% скорости, на болоте — 80%; гусеницы и пехота — меньше; авиации всё равно', () => {
  const sim = createSim(options)
  const sand = tileOf(sim, Terrain.Sand, Biome.Erg)
  const swamp = tileOf(sim, Terrain.Swamp)
  const rock = tileOf(sim, Terrain.Rock, Biome.Erg)
  expect(isWalkable(sim, swamp.x, swamp.y)).toBe(true)
  expect(terrainSpeed(sim, 'truck', rock.x, rock.y)).toBe(1)
  expect(terrainSpeed(sim, 'truck', sand.x, sand.y)).toBeCloseTo(0.9)
  expect(terrainSpeed(sim, 'truck', swamp.x, swamp.y)).toBeCloseTo(0.2)
  expect(terrainSpeed(sim, 'tank', swamp.x, swamp.y)).toBeCloseTo(0.5)
  expect(terrainSpeed(sim, 'infantry', sand.x, sand.y)).toBe(1)
  expect(terrainSpeed(sim, 'drone', swamp.x, swamp.y)).toBe(1)
  // Правила меняются на ходу.
  sim.rules.vehicleSwamp = 0.5
  expect(terrainSpeed(sim, 'truck', swamp.x, swamp.y)).toBeCloseTo(0.5)
})

test('путь объезжает болото, если в объезд быстрее, и спрямление не срезает через него угол', () => {
  // Болото — полоса x от 5 до 14 при y от -3 до 3; в обход сверху — чуть длиннее, зато по твёрдому.
  const swamp = (x: number, y: number) => x >= 5 && x < 15 && y >= -3 && y <= 3
  const slowness = (x: number, y: number) => (swamp(x, y) ? 5 : 1)
  const walkable = (x: number, y: number) => Math.abs(x) < 40 && Math.abs(y) < 40
  const tiles = findPath(walkable, 0, 0, 20, 0, 0, undefined, slowness)
  for (let i = 0; i < tiles.length; i += 2) expect(swamp(tiles[i], tiles[i + 1])).toBe(false)
  const points = smoothPath(walkable, 0.5, 0.5, tiles.map((value) => value + 0.5), slowness)
  let fromX = 0.5
  let fromY = 0.5
  for (let i = 0; i < points.length; i += 2) {
    for (let t = 0; t <= 1; t += 0.05) expect(swamp(Math.floor(fromX + (points[i] - fromX) * t), Math.floor(fromY + (points[i + 1] - fromY) * t))).toBe(false)
    fromX = points[i]
    fromY = points[i + 1]
  }
  // Без замедления — напрямик.
  expect(findPath(walkable, 0, 0, 20, 0).length / 2).toBe(20)
})

test('на солончаках болото промёрзло и вязнут меньше, в красных пустошах оно жжёт наземных', () => {
  const sim = createSim(options)
  const frozen = tileOf(sim, Terrain.Swamp, Biome.SaltFlats)
  expect(terrainSpeed(sim, 'truck', frozen.x, frozen.y)).toBeCloseTo(0.8)
  const toxic = tileOf(sim, Terrain.Swamp, Biome.RedWastes)
  const soldier = spawnUnit(sim, 'infantry', 1, toxic.x + 0.5, toxic.y + 0.5)
  const drone = spawnUnit(sim, 'drone', 1, toxic.x + 0.5, toxic.y + 0.5)
  for (let i = 0; i < 20 * 10; i++) sim.advance(1 / 20)
  // Пехота сама залечивается, но медленнее, чем жжёт болото.
  expect(sim.world.get(soldier, Health)!.value).toBeLessThan(0.98)
  expect(sim.world.get(soldier, Health)!.value).toBeGreaterThan(0.85)
  expect(sim.world.get(drone, Health)!.value).toBe(1)
})
