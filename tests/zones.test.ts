import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { createSim, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { zonesOf } from '../src/sim/zones'
import { throughJson } from './throughJson'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }

/** Ближайший к началу мира прямоугольник сплошной скалы width×height. */
function rock(sim: Sim, width: number, height: number) {
  for (let y = -200; y < 200; y++) {
    for (let x = -200; x < 200; x++) {
      let ok = true
      for (let ty = y; ty < y + height && ok; ty++) for (let tx = x; tx < x + width && ok; tx++) ok = terrainAt(sim.land, tx, ty) === Terrain.Rock
      if (ok) return { x, y }
    }
  }
  throw new Error('Не нашлось скалы')
}

test('шахта рядом с главным зданием — отдельная сеть, пока их не соединит труба', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  placeBuilding(sim.world, 'mine', x + 10, y, 1)
  expect(zonesOf(sim, 1).length).toBe(2)
  for (let tx = x + 3; tx < x + 10; tx++) placeBuilding(sim.world, 'pipe', tx, y, 1)
  expect(zonesOf(sim, 1).length).toBe(1)
  expect(zonesOf(sim, 1)[0].buildings.length).toBe(2 + 7)
})

test('сеть с главным зданием — первая; стена в сеть не входит', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 4)
  placeBuilding(sim.world, 'generator', x + 20, y, 1)
  const core = placeBuilding(sim.world, 'command', x, y, 1)
  const wall = placeBuilding(sim.world, 'wall', x + 3, y, 1)
  expect(zonesOf(sim, 1)[0].buildings[0]).toBe(core)
  expect(zonesOf(sim, 1).some((zone) => zone.buildings.includes(wall))).toBe(false)
})

/** Сохранение через JSON, как на сервере. */
const reload = (sim: Sim) => createSim(throughJson(sim.save()))

test('после загрузки сохранения сети те же, и разрыв трубы снова их делит', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 34, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  const generator = placeBuilding(sim.world, 'generator', x + 30, y, 1)
  expect(zonesOf(sim, 1).length).toBe(2)
  for (let tx = x + 3; tx < x + 30; tx++) placeBuilding(sim.world, 'pipe', tx, y, 1)
  expect(zonesOf(sim, 1).length).toBe(1)
  const loaded = reload(sim)
  expect(zonesOf(loaded, 1).length).toBe(1)
  expect(zonesOf(loaded, 1)[0].buildings).toContain(generator)
  loaded.world.destroy(loaded.occupancy.at(x + 20, y)!)
  loaded.advance(1 / 20)
  expect(zonesOf(loaded, 1).length).toBe(2)
})

test('стройка с подведённой трубой входит в сеть: ей сеть везёт материалы', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 16, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  placeBuilding(sim.world, 'pipe', x + 3, y, 1)
  addCredits(sim, 1, 1000)
  sim.send(1, { type: 'build', building: 'factory', x: x + 4, y, builders: [] })
  sim.advance(1 / 20)
  const [zone] = zonesOf(sim, 1)
  expect(zone.sites.length).toBe(1)
})
