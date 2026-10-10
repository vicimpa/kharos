import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import type { Entity } from '../src/ecs'
import { BUILDINGS, Health, Path, Position, Producer, UNIT_TYPES, WEAPONS, canPlace, createSim, isWalkable, missingRequirements, unitSpec } from '../src/sim'
import { TOWER_RANGE, orderAttack } from '../src/sim/combat'
import { spawnUnit } from '../src/sim/units'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }

/** Ставит здания игрока 1 в ряд на скале. */
function row(types: (keyof typeof BUILDINGS)[]) {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  for (let y = -100; y < 100; y++) {
    for (let x = -100; x < 100; x++) {
      let at = x
      const spots = types.map((type) => {
        const spot = at
        at += BUILDINGS[type].width + 1
        return spot
      })
      if (!types.every((type, i) => canPlace(sim, type, spots[i], y))) continue
      return { sim, buildings: types.map((type, i) => placeBuilding(sim.world, type, spots[i], y, 1)) }
    }
  }
  throw new Error('Не нашлось места')
}

test('требования юнитов называют существующие здания', () => {
  for (const unit of UNIT_TYPES) for (const type of unitSpec(unit).requires ?? []) expect(BUILDINGS).toHaveProperty(type)
})

test('тяжёлую технику не заказать без техцентра, с ним — можно', () => {
  const { sim, buildings } = row(['command', 'generator', 'generator', 'factory'])
  const factory = buildings[3]
  expect(missingRequirements(sim, 1, 'tank')).toEqual(['techCenter'])
  expect(missingRequirements(sim, 1, 'buggy')).toEqual([])
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  sim.send(1, { type: 'produce', producer: factory, unit: 'buggy' })
  sim.advance(1 / 20)
  expect(sim.world.get(factory, Producer)!.queue).toEqual(['buggy'])

  const { sim: other, buildings: more } = row(['command', 'generator', 'generator', 'factory', 'techCenter'])
  expect(missingRequirements(other, 1, 'tank')).toEqual([])
  other.send(1, { type: 'produce', producer: more[3], unit: 'tank' })
  other.advance(1 / 20)
  expect(other.world.get(more[3], Producer)!.queue).toEqual(['tank'])
  // Чужой техцентр не в счёт.
  expect(missingRequirements(other, 2, 'tank')).toEqual(['techCenter'])
})

const seconds = (sim: ReturnType<typeof createSim>, time: number) => {
  for (let i = 0; i < time * 20; i++) sim.advance(1 / 20)
}

test('артиллерия бьёт дальше любой турели и разносит её, не получив ответа', () => {
  expect(WEAPONS.artillery.range).toBeGreaterThan(Math.max(WEAPONS.cannon.range, WEAPONS.launcher.range, WEAPONS.machinegun.range) + TOWER_RANGE)
  const sim = createSim(options)
  const turret = placeBuilding(sim.world, 'cannonTurret', 0, 0, 2)
  const gun = spawnUnit(sim, 'artillery', 1, 11, 0)
  seconds(sim, 60)
  expect(sim.world.alive(turret)).toBe(false)
  expect(sim.world.get(gun, Health)!.value).toBe(1)
})

test('в мёртвой зоне артиллерия молчит', () => {
  const sim = createSim(options)
  const foe = spawnUnit(sim, 'infantry', 2, 0, 0)
  spawnUnit(sim, 'artillery', 1, 2, 0)
  seconds(sim, 10)
  expect(sim.world.get(foe, Health)!.value).toBe(1)
})

test('бомбардировщик сносит здание, а по летающим не бьёт', () => {
  const sim = createSim(options)
  const target = placeBuilding(sim.world, 'generator', 0, 0, 2)
  const bomber = spawnUnit(sim, 'bomber', 1, 8, 0)
  const drone = spawnUnit(sim, 'drone', 2, 9, 3)
  sim.send(1, { type: 'attack', units: [bomber], target })
  seconds(sim, 60)
  expect(sim.world.alive(target)).toBe(false)
  // Дрон бомбардировщика клюёт, а тот ему не отвечает.
  expect(sim.world.get(drone, Health)!.value).toBe(1)
})

test('зенитка сбивает летающих, а по земле не стреляет', () => {
  const sim = createSim(options)
  const flak = spawnUnit(sim, 'flak', 1, 0, 0)
  const ground = spawnUnit(sim, 'infantry', 2, 5, 0)
  const drone = spawnUnit(sim, 'drone', 2, 0, 6)
  seconds(sim, 8)
  expect(sim.world.alive(drone)).toBe(false)
  expect(sim.world.get(ground, Health)!.value).toBe(1)
  expect(orderAttack(sim, 1, [flak], ground)).toBe(false)
})

test('огнемётчик выжигает пехоту, и огонь перекидывается на соседа', () => {
  const sim = createSim(options)
  spawnUnit(sim, 'flamer', 1, 0, 0)
  const first = spawnUnit(sim, 'infantry', 2, 2, 0)
  const second = spawnUnit(sim, 'infantry', 2, 3, 1)
  seconds(sim, 1)
  expect(sim.world.get(first, Health)!.value).toBeLessThan(1)
  expect(sim.world.get(second, Health)!.value).toBeLessThan(1)
})

test('армия доходит по пересечённой местности вся: никто не бросает цель оттого, что по дороге мешали', () => {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 2048, fog: false })
  // Место, где до правки вставала четверть армии: у выхода с плато техника упиралась в соседей и в скалу.
  const start = { x: 300, y: -200 }
  const goal = { x: 500, y: -200 }
  for (let y = 0; y < 5; y++) for (let x = 0; x < 8; x++) expect(isWalkable(sim, start.x + x, start.y + y)).toBe(true)
  const kinds = ['tank', 'tank', 'tank', 'buggy', 'lancer', 'flak', 'artillery', 'infantry', 'rocketeer', 'tank'] as const
  const units: Entity[] = []
  for (let i = 0; i < 40; i++) units.push(spawnUnit(sim, kinds[i % kinds.length], 1, start.x + (i % 8), start.y + Math.floor(i / 8)))
  sim.advance(1 / 20)
  sim.send(1, { type: 'move', units, x: goal.x, y: goal.y })
  for (let tick = 0; tick < 20 * 180; tick++) sim.advance(1 / 20)
  const far = units.filter((unit) => {
    const position = sim.world.get(unit, Position)!
    return Math.hypot(position.x - goal.x, position.y - goal.y) > 16
  })
  expect(far).toEqual([])
  expect(units.filter((unit) => sim.world.has(unit, Path))).toEqual([])
})
