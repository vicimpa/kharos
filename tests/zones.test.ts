import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { Owner, Pave, Position, createSim, type BuildingType, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { zonesOf } from '../src/sim/zones'

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

// Шахта с центром в 10 тайлах от главного здания: она в его круге (12), а оно вне её круга (7).
for (const first of ['mine', 'command'] as BuildingType[]) {
  test(`шахта в зоне главного здания — одна зона, что бы ни построили раньше (${first})`, () => {
    const sim = createSim(options)
    const { x, y } = rock(sim, 16, 4)
    const layout: [BuildingType, number][] = [['command', 0], ['mine', 10]]
    if (first === 'mine') layout.reverse()
    for (const [type, dx] of layout) placeBuilding(sim.world, type, x + dx, y, 1)
    expect(zonesOf(sim, 1).length).toBe(1)
    expect(zonesOf(sim, 1)[0].buildings.length).toBe(2)
  })
}

test('здание в перекрытии двух зон соединяет их; без него зоны раздельные', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 24, 4)
  placeBuilding(sim.world, 'command', x, y, 1)
  placeBuilding(sim.world, 'command', x + 20, y, 1)
  expect(zonesOf(sim, 1).length).toBe(2)
  placeBuilding(sim.world, 'generator', x + 10, y, 1)
  expect(zonesOf(sim, 1).length).toBe(1)
})

/** Сохранение через JSON, как на сервере. */
const reload = (sim: Sim) => createSim(JSON.parse(JSON.stringify(sim.save())))

test('после загрузки сохранения зоны те же: шахта раньше главного и полоса фундамента', () => {
  const sim = createSim(options)
  const { x, y } = rock(sim, 34, 4)
  placeBuilding(sim.world, 'mine', x + 10, y, 1)
  placeBuilding(sim.world, 'command', x, y, 1)
  const generator = placeBuilding(sim.world, 'generator', x + 30, y, 1)
  expect(zonesOf(sim, 1).length).toBe(2)
  for (let tx = x + 12; tx < x + 30; tx++) sim.world.spawn(Position({ x: tx, y: y + 2 }), Pave({ kind: 'foundation', done: true, work: 1 }), Owner({ player: 1 }))
  expect(zonesOf(sim, 1).length).toBe(1)
  const loaded = reload(sim)
  expect(zonesOf(loaded, 1).length).toBe(1)
  expect(zonesOf(loaded, 1)[0].buildings.length).toBe(3)
  expect(zonesOf(loaded, 1)[0].buildings).toContain(generator)
  // И дальше зоны пересчитываются: разрыв полосы снова отделяет электростанцию.
  loaded.world.destroy(loaded.paving.at(x + 20, y + 2)!)
  loaded.advance(1 / 20)
  expect(zonesOf(loaded, 1).length).toBe(2)
})
