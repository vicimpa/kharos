import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, Building, Builds, CORE, Owner, Position, Site, Unit,
  canBuild, canPlace, createSim, creditsOf, isWalkable, siteAt, spawnStartingUnits, type Sim,
} from '../src/sim'
import { STARTING_CREDITS } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

function unitsOf(sim: Sim, type: string) {
  const found: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === type) found.push(entity)
  return found
}

function coreOf(sim: Sim) {
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (building.type === CORE && owner.player === 1) return entity
  }
  throw new Error('Главного здания нет')
}

/** Сторона квадрата сплошной скалы, на котором ставится тестовая база. */
const PLATEAU = 12

/** Симуляция, где игрок 1 уже развернул главное здание на просторной скале; рядом два строителя и место под генератор. */
function start() {
  const sim = createSim(options)
  const rock = (x: number, y: number) => {
    for (let tileY = y; tileY < y + PLATEAU; tileY++) {
      for (let tileX = x; tileX < x + PLATEAU; tileX++) if (!canPlace(sim, 'turret', tileX, tileY)) return false
    }
    return true
  }
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!rock(x, y)) continue
      spawnStartingUnits(sim, 1, x + 2, y + 2)
      sim.send(1, { type: 'deploy', unit: unitsOf(sim, 'mcv')[0] })
      seconds(sim, 6)
      return { sim, core: coreOf(sim), builders: unitsOf(sim, 'builder'), site: { x: x + 7, y: y + 4 } }
    }
  }
  throw new Error('В мире не нашлось места под базу')
}

test('строитель возводит здание: кредиты списаны, площадка проходима, готовое здание занимает тайлы', () => {
  const { sim, builders, site } = start()
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builders[0]] })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS - BUILDINGS.generator.cost)
  const entity = siteAt(sim, site.x + 1, site.y + 1)!
  expect(sim.world.get(entity, Site)).toEqual({ type: 'generator', progress: 0 })
  // Пока строитель не доехал, площадка никому не мешает, но второе здание на неё не поставить.
  expect(isWalkable(sim, site.x, site.y)).toBe(true)
  expect(canBuild(sim, 1, 'silo', site.x, site.y)).toBe(false)
  expect(sim.world.get(builders[0], Builds)).toEqual({ site: entity })

  seconds(sim, 8)
  expect(sim.world.has(entity, Building)).toBe(true)
  expect(isWalkable(sim, site.x, site.y)).toBe(false)
  expect(sim.world.has(entity, Site)).toBe(true)

  seconds(sim, BUILDINGS.generator.buildTime)
  expect(sim.world.has(entity, Site)).toBe(false)
  expect(sim.world.get(entity, Building)!.type).toBe('generator')
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  expect(siteAt(sim, site.x, site.y)).toBeUndefined()
})

test('два строителя строят вдвое быстрее одного', () => {
  const progress = (count: number) => {
    const { sim, builders, site } = start()
    sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: builders.slice(0, count) })
    seconds(sim, 6)
    const entity = sim.occupancy.at(site.x, site.y)!
    const before = sim.world.get(entity, Site)!.progress
    seconds(sim, 2)
    return sim.world.get(entity, Site)!.progress - before
  }
  expect(progress(1)).toBe(40)
  expect(progress(2)).toBe(80)
})

test('юниты уходят с площадки, когда начинается стройка', () => {
  const { sim, builders, site } = start()
  const [soldier] = unitsOf(sim, 'infantry')
  sim.send(1, { type: 'move', units: [soldier], x: site.x, y: site.y })
  seconds(sim, 10)
  expect(Math.floor(sim.world.get(soldier, Position)!.x)).toBe(site.x)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  seconds(sim, 10)
  const position = sim.world.get(soldier, Position)!
  expect(sim.occupancy.at(Math.floor(position.x), Math.floor(position.y))).toBeUndefined()
  expect(sim.occupancy.at(site.x, site.y)).toBeDefined()
})

test('строить можно только в радиусе контроля, за кредиты и только строителями', () => {
  const { sim, builders, site } = start()
  expect(canBuild(sim, 1, 'generator', site.x + 60, site.y)).toBe(false)
  expect(canBuild(sim, 2, 'generator', site.x, site.y)).toBe(false)
  // Главное здание строители не возводят.
  expect(canBuild(sim, 1, CORE, site.x, site.y)).toBe(false)
  sim.send(2, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  sim.send(1, { type: 'build', building: 'radar', x: site.x, y: site.y, builders })
  sim.advance(TICK)
  expect(siteAt(sim, site.x, site.y)).toBeUndefined()
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS)

  // Пехотинец и чужой строитель на стройку не идут.
  const stranger = spawnUnit(sim, 'builder', 2, site.x - 1, site.y)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [...unitsOf(sim, 'infantry'), stranger] })
  sim.advance(TICK)
  expect(siteAt(sim, site.x, site.y)).toBeDefined()
  expect(sim.world.count(Builds)).toBe(0)

  // На второе и третье здание хватает, на четвёртое уже нет: 1000 − 300 × 3 = 100.
  for (const y of [site.y - 3, site.y + 3, site.y + 6]) {
    expect(canBuild(sim, 1, 'generator', site.x, y)).toBe(true)
    sim.send(1, { type: 'build', building: 'generator', x: site.x, y, builders: [] })
    sim.advance(TICK)
  }
  expect(sim.world.count(Site)).toBe(3)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS - 3 * BUILDINGS.generator.cost)
})

test('отмена возвращает кредиты, а приказ идти снимает строителя со стройки', () => {
  const { sim, builders, site } = start()
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  seconds(sim, 7)
  const entity = sim.occupancy.at(site.x, site.y)!
  sim.send(1, { type: 'move', units: [builders[0]], x: site.x - 3, y: site.y })
  sim.send(2, { type: 'cancelBuild', site: entity })
  sim.advance(TICK)
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  expect(sim.world.has(builders[1], Builds)).toBe(true)
  expect(sim.world.alive(entity)).toBe(true)

  // Строителя можно вернуть на стройку.
  sim.send(1, { type: 'assist', units: [builders[0]], site: entity })
  sim.advance(TICK)
  expect(sim.world.get(builders[0], Builds)).toEqual({ site: entity })

  sim.send(1, { type: 'cancelBuild', site: entity })
  seconds(sim, 0.2)
  expect(sim.world.alive(entity)).toBe(false)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS)
  expect(isWalkable(sim, site.x, site.y)).toBe(true)
  expect(sim.world.count(Builds)).toBe(0)
})

test('без главного здания стройка стоит, готовые здания остаются', () => {
  const { sim, core, builders, site } = start()
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builders[0]] })
  sim.send(1, { type: 'pack', building: core })
  seconds(sim, 10.5)
  const entity = sim.occupancy.at(site.x, site.y)!
  const frozen = sim.world.get(entity, Site)!.progress
  expect(frozen).toBeGreaterThan(0)
  seconds(sim, 5)
  expect(sim.world.get(entity, Site)!.progress).toBe(frozen)
  expect(canBuild(sim, 1, 'silo', site.x, site.y + 3)).toBe(false)

  // Развернулся на прежнем месте — стройка продолжается.
  sim.send(1, { type: 'deploy', unit: unitsOf(sim, 'mcv')[0] })
  seconds(sim, 20)
  expect(sim.world.has(entity, Site)).toBe(false)
  expect(sim.world.has(entity, Building)).toBe(true)
})

test('сохранение посреди стройки продолжается так же', () => {
  const { sim, builders, site } = start()
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  seconds(sim, 7)
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  seconds(sim, 12)
  seconds(copy, 12)
  expect(copy.save()).toEqual(sim.save())
  expect(copy.world.count(Site)).toBe(0)
})
