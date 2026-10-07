import { expect, test } from 'bun:test'
import type { Audio } from '../src/audio/audio'
import type { LoopName } from '../src/audio/synth'
import { createMachines } from '../src/game/machines'
import { Camera } from '../src/game/camera'
import type { Scene } from '../src/game/scene'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Position, Unit, createSim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { spawnUnit } from '../src/sim/units'

/** Звук работы над миром без браузера: камера в (0, 0), звук записывает, что ему велели. */
function setup() {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 256 })
  const camera = new Camera()
  camera.width = 1280
  camera.height = 800
  camera.zoomTo(32)
  camera.centerOn(0, 0)
  const levels = new Map<LoopName, number>()
  const audio = { loop: (name: LoopName, volume: number) => levels.set(name, volume) } as unknown as Audio
  const machines = createMachines({ sim, player: 1, camera, weather: { precipitation: 0 } } as unknown as Scene, audio)
  return { sim, levels, update: () => machines.update(1) }
}

test('техника звучит, только когда едет', () => {
  const { sim, levels, update } = setup()
  const tank = spawnUnit(sim, 'tank', 1, 2, 2)
  update()
  expect(levels.get('tracks')).toBe(0)
  const unit = sim.world.get(tank, Unit)!
  const position = sim.world.get(tank, Position)!
  unit.prevX = position.x - 0.1
  update()
  expect(levels.get('tracks')).toBeGreaterThan(0)
  expect(levels.get('engine')).toBe(0)
})

test('своя электростанция гудит, чужая — нет', () => {
  const { sim, levels, update } = setup()
  placeBuilding(sim.world, 'generator', 4, 4, 2)
  update()
  expect(levels.get('hum')).toBe(0)
  placeBuilding(sim.world, 'generator', -4, 4, 1)
  update()
  expect(levels.get('hum')).toBeGreaterThan(0)
})
