import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { Armed, Health, Path, Position, Tactics, createSim, type Sim } from '../src/sim'
import { spawnUnit, type UnitType } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Полоса скалы 40×9: на ней ставятся бойцы. */
function field() {
  const sim = createSim(options)
  for (let y = -200; y < 200; y++) {
    for (let x = -200; x < 200; x++) {
      let ok = true
      for (let ty = y; ty < y + 9 && ok; ty++) for (let tx = x; tx < x + 40 && ok; tx++) ok = terrainAt(sim.land, tx, ty) === Terrain.Rock
      if (ok) return { sim, x, y: y + 4 }
    }
  }
  throw new Error('Нет места')
}

const hurt = (sim: Sim, entity: Entity) => !sim.world.alive(entity) || sim.world.get(entity, Health)!.value < 1
const at = (sim: Sim, entity: Entity) => sim.world.get(entity, Position)!
const put = (sim: Sim, type: UnitType, player: number, x: number, y: number) => spawnUnit(sim, type, player, x, y)

test('«не стрелять»: юнит не открывает огонь и не отвечает, но приказ атаки выполняет', () => {
  const { sim, x, y } = field()
  const ours = put(sim, 'infantry', 1, x + 5, y)
  const foe = put(sim, 'infantry', 2, x + 8, y)
  sim.send(1, { type: 'stance', units: [ours], stance: 'passive' })
  // Враг тоже молчит: смотрим только, что наш никого не трогает сам.
  sim.send(2, { type: 'stance', units: [foe], stance: 'passive' })
  seconds(sim, 3)
  expect(hurt(sim, foe)).toBe(false)
  sim.send(1, { type: 'attack', units: [ours], target: foe })
  seconds(sim, 3)
  expect(hurt(sim, foe)).toBe(true)
})

test('«держать позицию»: под огнём издалека юнит с места не сходит; в обороне — идёт на стрелка', () => {
  const run = (stance: 'hold' | 'defensive') => {
    const { sim, x, y } = field()
    const ours = put(sim, 'infantry', 1, x + 5, y)
    // Ракетчик бьёт дальше пехотинца: тот его с места не достаёт.
    const foe = put(sim, 'rocketeer', 2, x + 11, y)
    sim.send(1, { type: 'stance', units: [ours], stance })
    sim.send(2, { type: 'stance', units: [foe], stance: 'hold' })
    sim.send(2, { type: 'attack', units: [foe], target: ours })
    seconds(sim, 3)
    return sim.world.alive(ours) ? at(sim, ours).x - (x + 5.5) : Infinity
  }
  expect(Math.abs(run('hold'))).toBeLessThan(0.5)
  expect(run('defensive')).toBeGreaterThan(1)
})

test('«агрессивно»: юнит идёт на врага, которого видит, но не достаёт; в обороне — нет', () => {
  const run = (stance: 'aggressive' | 'defensive') => {
    const { sim, x, y } = field()
    const ours = put(sim, 'infantry', 1, x + 5, y)
    const foe = put(sim, 'infantry', 2, x + 11, y)
    sim.send(1, { type: 'stance', units: [ours], stance })
    sim.send(2, { type: 'stance', units: [foe], stance: 'passive' })
    seconds(sim, 4)
    return hurt(sim, foe)
  }
  expect(run('aggressive')).toBe(true)
  expect(run('defensive')).toBe(false)
})

test('в обороне юнит не гонится дальше поводка и возвращается на место', () => {
  const { sim, x, y } = field()
  const ours = put(sim, 'lancer', 1, x + 3, y)
  const foe = put(sim, 'buggy', 2, x + 12, y)
  sim.send(2, { type: 'stance', units: [foe], stance: 'passive' })
  // Враг ранит нашего и уезжает далеко: наш погонится, бросит у края поводка и вернётся.
  sim.world.get(ours, Armed)!.target = foe
  sim.world.get(ours, Armed)!.chase = true
  sim.world.add(ours, Tactics({ away: true, homeX: x + 3, homeY: y }))
  sim.send(2, { type: 'move', units: [foe], x: x + 38, y })
  seconds(sim, 20)
  expect(Math.abs(at(sim, ours).x - (x + 3.5))).toBeLessThan(1.5)
  expect(sim.world.get(ours, Armed)!.target).toBe(-1)
})

test('патруль: юнит ходит туда и обратно, а приказ идти его снимает', () => {
  const { sim, x, y } = field()
  const ours = put(sim, 'buggy', 1, x + 2, y)
  sim.send(1, { type: 'patrol', units: [ours], points: [x + 20, y] })
  let far = false
  let back = false
  for (let i = 0; i < 60 / TICK; i++) {
    sim.advance(TICK)
    const { x: px } = at(sim, ours)
    if (px > x + 19) far = true
    if (far && px < x + 3) back = true
  }
  expect(far && back).toBe(true)
  sim.send(1, { type: 'move', units: [ours], x: x + 10, y })
  seconds(sim, 1)
  expect(sim.world.get(ours, Tactics)!.patrol).toEqual([])
  seconds(sim, 10)
  expect(sim.world.has(ours, Path)).toBe(false)
})
