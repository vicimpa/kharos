import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, isCliffFoot, terrainAt } from '../src/map/terrain'
import { Blast, Building, Owner, Position, Unit, createSim, creditsOf, isDefeated, spawnStartingUnits, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

function start() {
  const sim = createSim(options)
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      let ok = true
      for (let ty = y; ty < y + 12 && ok; ty++) for (let tx = x; tx < x + 12 && ok; tx++) ok = terrainAt(sim.land, tx, ty) === Terrain.Rock && !isCliffFoot(sim.land, tx, ty)
      if (!ok) continue
      spawnStartingUnits(sim, 1, x + 2, y + 2)
      let mcv: Entity | undefined
      for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'mcv') mcv = entity
      sim.send(1, { type: 'deploy', unit: mcv! })
      seconds(sim, 6)
      return sim
    }
  }
  throw new Error('Нет места')
}

const owned = (sim: Sim, player: number) => {
  let count = 0
  for (const [, owner] of sim.world.query(Owner)) if (owner.player === player) count++
  return count
}

test('сдавшийся взрывает всё своё волной и проигрывает', () => {
  const sim = start()
  expect(isDefeated(sim, 1)).toBe(false)
  const before = owned(sim, 1)
  sim.send(1, { type: 'surrender' })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(0)
  // Не всё сразу: волна идёт от главного здания.
  seconds(sim, 0.3)
  expect(owned(sim, 1)).toBe(before)
  let blasts = 0
  for (let i = 0; i < 6 / TICK; i++) {
    sim.advance(TICK)
    for (const _ of sim.world.query(Blast)) blasts++
  }
  expect(owned(sim, 1)).toBe(0)
  expect(blasts).toBeGreaterThan(0)
  expect(isDefeated(sim, 1)).toBe(true)
})

test('игрока, которого в мире нет, проигравшим не считают; с главным зданием — не проиграл', () => {
  const sim = start()
  expect(isDefeated(sim, 2)).toBe(false)
  expect(isDefeated(sim, 1)).toBe(false)
})

test('без главного здания, но с другим зданием — не проиграл; без зданий и MCV — проиграл', () => {
  const sim = start()
  const core = [...sim.world.query(Building, Owner)].find(([, building, owner]) => building.type === 'command' && owner.player === 1)![0]
  const spot = sim.world.get(core, Position)!
  sim.world.destroy(core)
  const generator = placeBuilding(sim.world, 'generator', spot.x, spot.y, 1)
  expect(isDefeated(sim, 1)).toBe(false)
  sim.world.destroy(generator)
  expect(isDefeated(sim, 1)).toBe(true)
})
