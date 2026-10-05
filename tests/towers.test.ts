import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Health, Position, TOWER_RANGE, Unit, WEAPONS, createSim } from '../src/sim'

const newSim = () => createSim({ generator: DEFAULT_SETTINGS.generator, size: DEFAULT_SETTINGS.world.size, rules: DEFAULT_SETTINGS.rules })

test('ракетная турель достаёт штурмовика дальше его собственного выстрела', () => {
  const sim = newSim()
  sim.send(1, { type: 'placeBuilding', building: 'rocketTurret', x: 0, y: 0 })
  // Дальше дальности ракетницы штурмовика, но в пределах надбавки турели.
  const away = WEAPONS.launcher.range + TOWER_RANGE / 2
  sim.send(1, { type: 'spawnUnit', unit: 'gunship', x: Math.floor(0.5 + away), y: 0, enemy: true })
  for (let i = 0; i < 20 * 10; i++) sim.advance(0.05)
  for (const [, , unit, health] of sim.world.query(Position, Unit, Health)) {
    if (unit.type === 'gunship') expect(health.value).toBeLessThan(1)
  }
})
