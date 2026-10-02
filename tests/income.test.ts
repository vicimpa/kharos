import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, Building, Builds, CORE, Owner, Site, Unit,
  canBuild, canPlace, createSim, creditsOf, economyOf, powerOf, refundOf, rewardsOf, siteAt, zoneOf, spawnStartingUnits, type BuildingType, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { REWARDS, STARTING_CREDITS } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
const PLATEAU = 14
/** Скала должна тянуться вправо дальше зоны главного здания: на ней проверяется расширение зоны. */
const WIDE = 26

/** Симуляция, где игрок 1 развернул главное здание в углу просторной скалы; (x, y) — левый верхний тайл скалы. */
function start() {
  const sim = createSim(options)
  const rock = (x: number, y: number) => {
    for (let tileY = y; tileY < y + PLATEAU; tileY++) {
      for (let tileX = x; tileX < x + WIDE; tileX++) if (!canPlace(sim, 'turret', tileX, tileY)) return false
    }
    return true
  }
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!rock(x, y)) continue
      spawnStartingUnits(sim, 1, x + 2, y + 2)
      let mcv: Entity | undefined
      for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'mcv') mcv = entity
      sim.send(1, { type: 'deploy', unit: mcv! })
      seconds(sim, 3.1)
      return { sim, x, y }
    }
  }
  throw new Error('В мире не нашлось места под базу')
}

/** Готовое здание игрока 1, поставленное в обход стройки. */
const put = (sim: Sim, type: BuildingType, x: number, y: number) => placeBuilding(sim.world, type, x, y, 1)

function coreOf(sim: Sim) {
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (building.type === CORE && owner.player === 1) return entity
  }
  throw new Error('Главного здания нет')
}

test('развёрнутое главное здание приносит награду и понемногу кредиты', () => {
  const { sim } = start()
  expect(rewardsOf(sim, 1)).toEqual(['deploy'])
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS + REWARDS.deploy)
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 0, income: BUILDINGS.command.income, crowd: 0 })

  seconds(sim, 50)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS + REWARDS.deploy + 10)
})

test('награда выдаётся один раз: свернуть и развернуть заново ничего не даёт', () => {
  const { sim } = start()
  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(economyOf(sim, 1).income).toBe(0)
  const credits = creditsOf(sim, 1)
  let mcv: Entity | undefined
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'mcv') mcv = entity
  sim.send(1, { type: 'deploy', unit: mcv! })
  seconds(sim, 3.1)
  expect(sim.world.has(coreOf(sim), Building)).toBe(true)
  expect(creditsOf(sim, 1)).toBe(credits)
  expect(rewardsOf(sim, 1)).toEqual(['deploy'])
})

test('генератор материи даёт кредиты за энергию, а при её нехватке — меньше', () => {
  const { sim, x, y } = start()
  put(sim, 'matter', x + 6, y)
  // Без электростанции генератор материи стоит.
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 5, income: 0.2, crowd: 1 })

  put(sim, 'generator', x + 6, y + 4)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 5, income: 1.2, crowd: 1 })
  const credits = creditsOf(sim, 1)
  seconds(sim, 10)
  expect(creditsOf(sim, 1)).toBe(credits + 12)
})

test('каждый следующий генератор материи в зоне просит больше энергии', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y + 4)
  put(sim, 'matter', x + 6, y)
  expect(powerOf('matter', economyOf(sim, 1))).toBe(-10)
  expect(powerOf('generator', economyOf(sim, 1))).toBe(10)

  // Два просят 5 + 10 = 15 энергии, а есть 10: оба работают на две трети.
  put(sim, 'matter', x + 9, y)
  expect(economyOf(sim, 1).demand).toBe(15)
  expect(economyOf(sim, 1).income).toBeCloseTo(0.2 + 2 * (10 / 15))

  // Третий просит ещё 15: без новой электростанции общий доход от него только упадёт.
  put(sim, 'matter', x + 9, y + 4)
  expect(economyOf(sim, 1).demand).toBe(30)
  expect(economyOf(sim, 1).income).toBeCloseTo(0.2 + 3 * (10 / 30))
})

test('здания вне зоны и без главного здания не работают', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y)
  put(sim, 'matter', x + 6, y + 3)
  put(sim, 'matter', x + 60, y)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 5, income: 1.2, crowd: 1 })

  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 0, income: 0, crowd: 0 })
  const credits = creditsOf(sim, 1)
  seconds(sim, 5)
  expect(creditsOf(sim, 1)).toBe(credits)
})

test('готовые здания расширяют зону строительства по цепочке, стройки — нет', () => {
  const { sim, x, y } = start()
  // Главное здание стоит у (x + 3.5, y + 3.5): радиус 12 кончается около x + 15.
  const far = x + 17
  expect(zoneOf(sim, 1).length).toBe(3)
  expect(canPlace(sim, 'silo', far, y + 3)).toBe(true)
  expect(canBuild(sim, 1, 'silo', far, y + 3)).toBe(false)

  // Площадка у края зоны её не расширяет, готовое здание — расширяет.
  sim.send(1, { type: 'build', building: 'silo', x: x + 13, y: y + 3, builders: [] })
  sim.advance(TICK)
  expect(canBuild(sim, 1, 'silo', far, y + 3)).toBe(false)
  put(sim, 'silo', x + 13, y + 5)
  expect(zoneOf(sim, 1).length).toBe(6)
  expect(canBuild(sim, 1, 'silo', far, y + 3)).toBe(true)

  // Здание, до которого цепочка не дотягивается, зону не даёт; встанет звено между ними — даст.
  put(sim, 'silo', x + 22, y + 5)
  expect(zoneOf(sim, 1).length).toBe(6)
  put(sim, 'silo', x + 18, y + 5)
  expect(zoneOf(sim, 1).length).toBe(12)

  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(zoneOf(sim, 1).length).toBe(0)
})

test('здание разбирают строители в полтора раза быстрее стройки; половина цены возвращается в конце', () => {
  const { sim, x, y } = start()
  const plant = put(sim, 'generator', x + 6, y + 6)
  const link = put(sim, 'silo', x + 13, y + 5)
  const core = coreOf(sim)
  const builders: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'builder') builders.push(entity)
  expect(refundOf('generator')).toBe(150)
  expect(canBuild(sim, 1, 'silo', x + 17, y + 3)).toBe(true)

  // Чужое, главное и недостроенное под разбор не идут.
  sim.send(1, { type: 'build', building: 'silo', x: x + 9, y: y + 9, builders: [] })
  sim.advance(TICK)
  const site = siteAt(sim, x + 9, y + 9)!
  sim.send(2, { type: 'demolish', building: plant, builders: [] })
  sim.send(1, { type: 'demolish', building: core, builders: [] })
  sim.send(1, { type: 'demolish', building: site, builders: [] })
  sim.advance(TICK)
  expect(sim.world.has(plant, Site) || sim.world.has(core, Site)).toBe(false)
  expect(sim.world.get(site, Site)!.demolish).toBe(false)

  // Пока строитель не подошёл, здание стоит целым, но уже не работает и зону не расширяет.
  sim.world.destroy(builders[1])
  sim.send(1, { type: 'demolish', building: plant, builders: [] })
  sim.send(1, { type: 'demolish', building: link, builders: [] })
  sim.advance(TICK)
  expect(sim.world.get(plant, Site)).toEqual({ type: 'generator', progress: 300, demolish: true })
  expect(economyOf(sim, 1).produced).toBe(0)
  expect(canBuild(sim, 1, 'silo', x + 17, y + 3)).toBe(false)

  // Отмена разбора возвращает здание в строй, денег при этом не даёт.
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'cancelBuild', site: link })
  sim.advance(TICK)
  expect(sim.world.has(link, Site)).toBe(false)
  expect(canBuild(sim, 1, 'silo', x + 17, y + 3)).toBe(true)
  expect(creditsOf(sim, 1) - credits).toBeLessThan(2)

  // Свободный строитель рядом берётся за разбор сам. Один разбирает электростанцию за 15 / 1,5 = 10 секунд, не считая дороги.
  let ticks = 0
  let working = 0
  while (sim.world.alive(plant) && ticks++ < 1200) {
    if (sim.world.get(plant, Site)!.progress < 300) working++
    sim.advance(TICK)
  }
  expect(sim.world.alive(plant)).toBe(false)
  expect(working).toBe(199)
  expect(sim.occupancy.at(x + 6, y + 6)).toBeUndefined()
  // Строитель освобождается на следующем тике.
  sim.advance(TICK)
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  const gained = creditsOf(sim, 1) - credits
  expect(gained).toBeGreaterThanOrEqual(150)
  expect(gained).toBeLessThan(150 + 20)
})
