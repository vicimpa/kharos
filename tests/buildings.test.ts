import { expect, test } from 'bun:test'
import { BUILDING_ART } from '../src/game/buildings/buildingArt'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Pixmap } from '../src/render/pixmap'
import { BUILDING_TYPES, canPlace, createSim, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'

const createScene = () => ({ sim: createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024 }) })
type Scene = { sim: Sim }

/** Ближайший к началу мира тайл, где встаёт турель 1×1. */
function freeTile(scene: Scene) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) if (canPlace(scene.sim, 'turret', x, y)) return { x, y }
  }
  throw new Error('В мире не нашлось скалы')
}

test('занятость следит за появлением и исчезновением зданий', () => {
  const scene = createScene()
  const { x, y } = freeTile(scene)
  const turret = placeBuilding(scene.sim.world, 'turret', x, y)
  expect(scene.sim.occupancy.at(x, y)).toBe(turret)
  expect(canPlace(scene.sim, 'turret', x, y)).toBe(false)

  scene.sim.world.destroy(turret)
  expect(scene.sim.occupancy.at(x, y)).toBeUndefined()
  expect(canPlace(scene.sim, 'turret', x, y)).toBe(true)
})

test('зазор не даёт ставить здания вплотную', () => {
  const scene = createScene()
  const { x, y } = freeTile(scene)
  placeBuilding(scene.sim.world, 'turret', x, y)
  expect(canPlace(scene.sim, 'turret', x - 2, y, 2)).toBe(false)
})

test('каждый чертёж рисуется во всех кадрах и сообщает одни и те же огни', () => {
  for (const type of BUILDING_TYPES) {
    const art = BUILDING_ART[type]
    const counts = new Set<number>()
    for (let frame = 0; frame < 16; frame++) {
      const image = new Pixmap(art.width * 16 + 32, art.height * 16 + 32)
      image.originX = image.originY = 16
      let lights = 0
      art.draw(image, frame / 16, () => lights++)
      counts.add(lights)
      expect(image.data.some((value) => value > 0)).toBe(true)
    }
    expect(counts.size).toBe(1)
  }
})
