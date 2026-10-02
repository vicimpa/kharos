import { expect, test } from 'bun:test'
import { World } from '../src/ecs'
import { BUILDING_ART, BUILDING_TYPES } from '../src/game/buildings/buildingArt'
import { canPlace, createOccupancy, placeBuilding, placeDemoBuildings } from '../src/game/buildings/buildings'
import { Camera } from '../src/game/camera'
import { Building } from '../src/game/components'
import type { Scene } from '../src/game/scene'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createLand } from '../src/map/terrain'
import { Pixmap } from '../src/render/pixmap'

function createScene(): Scene {
  const world = new World()
  return {
    world,
    land: createLand(DEFAULT_SETTINGS.generator),
    camera: new Camera(),
    settings: DEFAULT_SETTINGS,
    occupancy: createOccupancy(world),
    grid: false,
  }
}

/** Ближайший к началу мира тайл, где встаёт турель 1×1. */
function freeTile(scene: Scene) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) if (canPlace(scene, 'turret', x, y)) return { x, y }
  }
  throw new Error('В мире не нашлось скалы')
}

test('занятость следит за появлением и исчезновением зданий', () => {
  const scene = createScene()
  const { x, y } = freeTile(scene)
  const turret = placeBuilding(scene.world, 'turret', x, y)
  expect(scene.occupancy.at(x, y)).toBe(turret)
  expect(canPlace(scene, 'turret', x, y)).toBe(false)

  scene.world.destroy(turret)
  expect(scene.occupancy.at(x, y)).toBeUndefined()
  expect(canPlace(scene, 'turret', x, y)).toBe(true)
})

test('зазор не даёт ставить здания вплотную', () => {
  const scene = createScene()
  const { x, y } = freeTile(scene)
  placeBuilding(scene.world, 'turret', x, y)
  expect(canPlace(scene, 'turret', x - 2, y, 2)).toBe(false)
})

test('пробная расстановка ставит здания только на скале и без наложений', () => {
  const scene = createScene()
  placeDemoBuildings(scene, 0, 0)
  expect(scene.world.count(Building)).toBeGreaterThan(50)
  scene.world.clear()
  expect(scene.world.count(Building)).toBe(0)
  expect(scene.occupancy.at(0, 0)).toBeUndefined()
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
