import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import {
  BUILDINGS, Building, Builds, CORE, Owner, Position, Site, Unit,
  canBuild, canPlace, createSim, creditsOf, isWalkable, rewardsOf, siteAt, spawnStartingUnits, type Sim,
} from '../src/sim'
import { BUILD_RATE } from '../src/sim/buildings'
import { WORK_RADIUS } from '../src/sim/construction'
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
      for (let tileX = x; tileX < x + PLATEAU; tileX++) {
        if (terrainAt(sim.land, tileX, tileY) !== Terrain.Rock) return false
      }
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
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builders[0]] })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(credits - BUILDINGS.generator.cost)
  const entity = siteAt(sim, site.x + 1, site.y + 1)!
  expect(sim.world.get(entity, Site)).toEqual({ type: 'generator', progress: 0, demolish: false })
  // Пока строитель не доехал, площадка никому не мешает, но второе здание на неё не поставить.
  expect(isWalkable(sim, site.x, site.y)).toBe(true)
  expect(canBuild(sim, 1, 'silo', site.x, site.y)).toBe(false)
  expect(sim.world.get(builders[0], Builds)).toEqual({ site: entity })

  seconds(sim, 8)
  expect(sim.world.has(entity, Building)).toBe(true)
  expect(isWalkable(sim, site.x, site.y)).toBe(false)
  expect(sim.world.has(entity, Site)).toBe(true)

  seconds(sim, BUILDINGS.generator.cost / BUILD_RATE)
  expect(sim.world.has(entity, Site)).toBe(false)
  expect(sim.world.get(entity, Building)!.type).toBe('generator')
  // Первый генератор приносит награду.
  expect(rewardsOf(sim, 1)).toEqual(['deploy', 'generator'])
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  expect(siteAt(sim, site.x, site.y)).toBeUndefined()
})

test('два строителя строят вдвое быстрее одного', () => {
  const progress = (count: number) => {
    const { sim, builders, site } = start()
    // Лишнего строителя убираем: свободный сам пришёл бы помогать.
    for (const builder of builders.slice(count)) sim.world.destroy(builder)
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

test('свои юниты уходят с площадки, и только потом начинается стройка', () => {
  const { sim, builders, site } = start()
  const [soldier] = unitsOf(sim, 'infantry')
  sim.send(1, { type: 'move', units: [soldier], x: site.x, y: site.y })
  sim.send(1, { type: 'move', units: [builders[1]], x: site.x + 1, y: site.y + 1 })
  seconds(sim, 10)
  const inside = (entity: Entity) => {
    const position = sim.world.get(entity, Position)!
    return position.x >= site.x && position.x < site.x + 2 && position.y >= site.y && position.y < site.y + 2
  }
  expect(inside(soldier)).toBe(true)
  expect(inside(builders[1])).toBe(true)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builders[0]] })
  seconds(sim, 10)
  // Ушёл и пехотинец, и строитель, стоявший на площадке без дела.
  expect(inside(soldier)).toBe(false)
  expect(inside(builders[1])).toBe(false)
  expect(sim.occupancy.at(site.x, site.y)).toBeDefined()
})

test('чужой юнит на площадке держит стройку, пока не уйдёт', () => {
  const { sim, builders, site } = start()
  const stranger = spawnUnit(sim, 'infantry', 0, site.x, site.y)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  seconds(sim, 10)
  const entity = siteAt(sim, site.x, site.y)!
  // Чужого не выгнали, стройка не началась, тайлы свободны.
  expect(Math.floor(sim.world.get(stranger, Position)!.x)).toBe(site.x)
  expect(sim.world.has(entity, Building)).toBe(false)
  expect(sim.world.get(entity, Site)!.progress).toBe(0)
  expect(sim.occupancy.at(site.x, site.y)).toBeUndefined()

  sim.send(0, { type: 'move', units: [stranger], x: site.x - 3, y: site.y })
  seconds(sim, 5)
  expect(sim.world.has(entity, Building)).toBe(true)
  expect(sim.world.get(entity, Site)!.progress).toBeGreaterThan(0)
})

test('строить можно только в радиусе контроля, за кредиты и только строителями', () => {
  const { sim, builders, site } = start()
  const credits = creditsOf(sim, 1)
  expect(canBuild(sim, 1, 'generator', site.x + 60, site.y)).toBe(false)
  expect(canBuild(sim, 2, 'generator', site.x, site.y)).toBe(false)
  // Главное здание строители не возводят.
  expect(canBuild(sim, 1, CORE, site.x, site.y)).toBe(false)
  sim.send(2, { type: 'build', building: 'generator', x: site.x, y: site.y, builders })
  sim.send(1, { type: 'build', building: 'radar', x: site.x, y: site.y, builders })
  sim.advance(TICK)
  expect(siteAt(sim, site.x, site.y)).toBeUndefined()
  expect(creditsOf(sim, 1)).toBe(credits)

  // Пехотинец и чужой строитель на стройку не идут.
  const stranger = spawnUnit(sim, 'builder', 2, site.x - 1, site.y)
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [...unitsOf(sim, 'infantry'), stranger] })
  sim.advance(TICK)
  expect(siteAt(sim, site.x, site.y)).toBeDefined()
  expect(sim.world.count(Builds)).toBe(0)

  // Площадки можно закладывать и без строителей: кредиты списываются за каждую.
  for (const y of [site.y - 3, site.y + 3, site.y + 6]) {
    expect(canBuild(sim, 1, 'generator', site.x, y)).toBe(true)
    sim.send(1, { type: 'build', building: 'generator', x: site.x, y, builders: [] })
    sim.advance(TICK)
  }
  expect(sim.world.count(Site)).toBe(4)
  expect(creditsOf(sim, 1)).toBe(credits - 4 * BUILDINGS.generator.cost)

  // На пятую уже не хватает.
  sim.send(1, { type: 'build', building: 'generator', x: site.x + 3, y: site.y, builders: [] })
  sim.advance(TICK)
  expect(sim.world.count(Site)).toBe(4)
})

test('отмена возвращает кредиты, а приказ идти снимает строителя со стройки', () => {
  const { sim, builders, site } = start()
  const credits = creditsOf(sim, 1)
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
  // Вернулось всё; сверх того — кредит-другой, который за это время принесло главное здание.
  expect(creditsOf(sim, 1) - credits).toBeGreaterThanOrEqual(0)
  expect(creditsOf(sim, 1) - credits).toBeLessThan(3)
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

test('свободный строитель сам берётся за стройку рядом, а за далёкую и за стройку вне зоны — нет', () => {
  const { sim, core, builders, site } = start()
  sim.world.destroy(builders[1])
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [] })
  seconds(sim, 1.1)
  const entity = siteAt(sim, site.x, site.y)!
  expect(sim.world.get(builders[0], Builds)).toEqual({ site: entity })
  seconds(sim, 6)
  expect(sim.world.get(entity, Site)!.progress).toBeGreaterThan(0)

  // Приказ идти снимает его со стройки; уехав дальше WORK_RADIUS, он не возвращается.
  const position = sim.world.get(builders[0], Position)!
  spawnUnit(sim, 'builder', 1, site.x + WORK_RADIUS + 6, site.y)
  const far = unitsOf(sim, 'builder').find((builder) => builder !== builders[0])!
  seconds(sim, 2)
  expect(sim.world.has(far, Builds)).toBe(false)

  // Главное здание свёрнуто — стройка стоит, и браться за неё незачем.
  sim.send(1, { type: 'pack', building: core })
  seconds(sim, 10.1)
  sim.send(1, { type: 'move', units: [builders[0]], x: Math.floor(position.x) - 1, y: Math.floor(position.y) })
  seconds(sim, 3)
  expect(sim.world.has(builders[0], Builds)).toBe(false)
})
