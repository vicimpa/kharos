import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Health, Position, TOWER_RANGE, TRAINING_PLAYER, Unit, WEAPONS, createSim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { spawnUnit } from '../src/sim/units'

const newSim = () => createSim({ generator: DEFAULT_SETTINGS.generator, size: DEFAULT_SETTINGS.world.size, rules: DEFAULT_SETTINGS.rules })

test('ракетная турель достаёт штурмовика дальше его собственного выстрела', () => {
  const sim = newSim()
  placeBuilding(sim.world, 'rocketTurret', 0, 0, 1)
  // Дальше дальности ракетницы штурмовика, но в пределах надбавки турели.
  const away = WEAPONS.launcher.range + TOWER_RANGE / 2
  spawnUnit(sim, 'gunship', TRAINING_PLAYER, Math.floor(0.5 + away), 0)
  for (let i = 0; i < 20 * 10; i++) sim.advance(0.05)
  for (const [, , unit, health] of sim.world.query(Position, Unit, Health)) {
    if (unit.type === 'gunship') expect(health.value).toBeLessThan(1)
  }
})

test('главное здание бьёт по всей своей зоне, и по воздуху тоже, а дальше — нет', () => {
  // Центр главного здания — (1.5, 1.5); его зона — 12 тайлов. Каждую цель — в своём мире: турель бьёт по одной.
  const hurt = (type: 'buggy' | 'drone', x: number, y: number) => {
    const sim = newSim()
    placeBuilding(sim.world, 'command', 0, 0, 1)
    const unit = spawnUnit(sim, type, TRAINING_PLAYER, x, y)
    for (let i = 0; i < 20 * 10; i++) sim.advance(0.05)
    return !sim.world.alive(unit) || sim.world.get(unit, Health)!.value < 1
  }
  expect(hurt('buggy', 12, 1)).toBe(true)
  expect(hurt('drone', 1, 12)).toBe(true)
  expect(hurt('buggy', -14, 1)).toBe(false)
})
