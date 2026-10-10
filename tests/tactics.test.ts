import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import { Armed, Health, Orders, Path, Position, Tactics, createSim, type Sim } from '../src/sim'
import { spawnUnit, type UnitType } from '../src/sim/units'
import { placeBuilding } from '../src/sim/buildings'
import { searchedTiles } from '../src/sim/path'

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

test('стойки работают и на юнитах с турелями: багги «не стрелять» молчит, «агрессивно» — едет на врага', () => {
  const run = (stance: 'passive' | 'aggressive' | 'defensive') => {
    const { sim, x, y } = field()
    const ours = put(sim, 'buggy', 1, x + 5, y)
    // Пулемётчик багги бьёт на 5 тайлов, а видит багги дальше: враг на 7 — в обзоре, но не на выстреле.
    const foe = put(sim, 'infantry', 2, x + (stance === 'passive' ? 8 : 12), y)
    sim.send(1, { type: 'stance', units: [ours], stance })
    sim.send(2, { type: 'stance', units: [foe], stance: 'passive' })
    seconds(sim, 5)
    return hurt(sim, foe)
  }
  expect(run('passive')).toBe(false)
  expect(run('aggressive')).toBe(true)
  expect(run('defensive')).toBe(false)
})

test('«держать позицию» на юните с турелью: под огнём издалека багги с места не сходит', () => {
  const run = (stance: 'hold' | 'defensive') => {
    const { sim, x, y } = field()
    const ours = put(sim, 'buggy', 1, x + 5, y)
    const foe = put(sim, 'rocketeer', 2, x + 11.5, y)
    sim.send(1, { type: 'stance', units: [ours], stance })
    sim.send(2, { type: 'stance', units: [foe], stance: 'hold' })
    sim.send(2, { type: 'attack', units: [foe], target: ours })
    seconds(sim, 3)
    return sim.world.alive(ours) ? at(sim, ours).x - (x + 5.5) : Infinity
  }
  expect(Math.abs(run('hold'))).toBeLessThan(0.5)
  expect(run('defensive')).toBeGreaterThan(1)
})

test('Shift к патрулю: точка добавляется к идущему патрулю, без Shift — патруль новый', () => {
  const { sim, x, y } = field()
  const ours = put(sim, 'buggy', 1, x + 2, y)
  sim.send(1, { type: 'patrol', units: [ours], points: [x + 10, y] })
  sim.advance(TICK)
  sim.send(1, { type: 'patrol', units: [ours], points: [x + 20, y + 2], append: true })
  sim.advance(TICK)
  expect(sim.world.get(ours, Tactics)!.patrol).toEqual([x + 2, y, x + 10, y, x + 20, y + 2])
  seconds(sim, 2)
  sim.send(1, { type: 'patrol', units: [ours], points: [x + 30, y] })
  sim.advance(TICK)
  expect(sim.world.get(ours, Tactics)!.patrol.slice(2)).toEqual([x + 30, y])
})

test('поход: агрессивный, посланный идти, бьёт увиденного по дороге и идёт дальше, куда послали', () => {
  for (const type of ['buggy', 'infantry'] as const) {
    const { sim, x, y } = field()
    const ours = put(sim, type, 1, x + 2, y)
    // Враг в стороне от пути: в обзоре, но не на выстреле.
    const foe = put(sim, 'truck', 2, x + 12, y + 3)
    sim.send(1, { type: 'stance', units: [ours], stance: 'aggressive' })
    sim.send(1, { type: 'move', units: [ours], x: x + 22, y })
    for (let i = 0; i < 60 * 20 && sim.world.alive(foe); i++) sim.advance(TICK)
    expect(sim.world.alive(foe)).toBe(false)
    // Бой кончился не там, куда шёл: юнит вспоминает о месте назначения и доходит.
    seconds(sim, 30)
    expect(Math.hypot(at(sim, ours).x - (x + 22.5), at(sim, ours).y - (y + 0.5))).toBeLessThan(1.6)
    expect(sim.world.get(ours, Tactics)!.away).toBe(false)
    expect(sim.world.has(ours, Path)).toBe(false)
  }
})

test('поход — только в агрессивной стойке и только по приказу идти: в обороне и с приказом атаки на других не смотрят', () => {
  {
    // С приказом атаки агрессивный едет к своей цели мимо прочих.
    const { sim, x, y } = field()
    const hunter = put(sim, 'buggy', 1, x + 2, y + 2)
    const bystander = put(sim, 'truck', 2, x + 12, y - 3)
    const prey = put(sim, 'truck', 2, x + 22, y + 2)
    sim.send(1, { type: 'stance', units: [hunter], stance: 'aggressive' })
    sim.send(1, { type: 'attack', units: [hunter], target: prey })
    for (let i = 0; i < 60 * 20 && sim.world.alive(prey); i++) sim.advance(TICK)
    expect(sim.world.alive(prey)).toBe(false)
    expect(hurt(sim, bystander)).toBe(false)
  }
  {
    // В обороне приказ идти — просто идти: врага в обзоре, но не на выстреле, юнит не трогает.
    const { sim, x, y } = field()
    const calm = put(sim, 'infantry', 1, x + 2, y - 3)
    const bystander = put(sim, 'truck', 2, x + 12, y + 3)
    sim.send(1, { type: 'move', units: [calm], x: x + 22, y: y - 3 })
    seconds(sim, 40)
    expect(Math.floor(at(sim, calm).x)).toBe(x + 22)
    expect(hurt(sim, bystander)).toBe(false)
    expect(sim.world.get(calm, Tactics)?.away ?? false).toBe(false)
  }
})

test('приказ с Shift ждёт, пока агрессивный не дойдёт, куда шёл: бой по дороге — не конец приказа', () => {
  const { sim, x, y } = field()
  const ours = put(sim, 'buggy', 1, x + 2, y)
  const foe = put(sim, 'truck', 2, x + 12, y + 3)
  sim.send(1, { type: 'stance', units: [ours], stance: 'aggressive' })
  sim.send(1, { type: 'move', units: [ours], x: x + 22, y })
  sim.send(1, { type: 'move', units: [ours], x: x + 22, y: y + 3, queue: true })
  let reached = false
  for (let i = 0; i < 90 * 20; i++) {
    sim.advance(TICK)
    reached ||= Math.hypot(at(sim, ours).x - (x + 22.5), at(sim, ours).y - (y + 0.5)) < 1.6
    // Следующий приказ из очереди не берётся, пока не дошёл до первой точки.
    if (!reached) expect(sim.world.get(ours, Orders)!.list.length).toBe(1)
  }
  expect(sim.world.alive(foe)).toBe(false)
  expect(reached).toBe(true)
  expect(Math.floor(at(sim, ours).y)).toBe(y + 3)
})

test('точка патруля на здании засчитывается, когда ближе не подойти: патруль идёт дальше, путь не ищется без конца', () => {
  const { sim, x, y } = field()
  const generator = placeBuilding(sim.world, 'generator', x + 20, y - 1, 1)
  const units = [0, 1, 2, 3, 4].map((i) => put(sim, 'infantry', 1, x + i, y))
  sim.send(1, { type: 'patrol', units, points: [x + 21, y] })
  seconds(sim, 10)
  const before = searchedTiles()
  const legs = new Set<number>()
  for (let i = 0; i < 30 * 20; i++) {
    sim.advance(1 / 20)
    legs.add(sim.world.get(units[0], Tactics)!.leg)
  }
  expect(sim.world.alive(generator)).toBe(true)
  // Ходит туда и обратно.
  expect(legs.size).toBe(2)
  expect((searchedTiles() - before) / (30 * 20)).toBeLessThan(1000)
})
