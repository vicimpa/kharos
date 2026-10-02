import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, Building, CORE, Owner, Unit,
  atLimit, canBuild, canPlace, createSim, creditsOf, economyOf, rewardsOf, spawnStartingUnits, type BuildingType, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { REWARDS, STARTING_CREDITS } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
const PLATEAU = 14

/** Симуляция, где игрок 1 развернул главное здание в углу просторной скалы; (x, y) — левый верхний тайл скалы. */
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
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 0, income: BUILDINGS.command.income })

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

test('космопорт даёт кредиты за энергию, а при её нехватке — меньше', () => {
  const { sim, x, y } = start()
  put(sim, 'starport', x + 6, y)
  // Без генератора космопорт стоит.
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 5, income: 0.2 })

  put(sim, 'generator', x + 6, y + 4)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 5, income: 1.2 })
  const credits = creditsOf(sim, 1)
  seconds(sim, 10)
  expect(creditsOf(sim, 1)).toBe(credits + 12)

  // Три космопорта просят 15 энергии, а есть 10: все работают на две трети.
  put(sim, 'starport', x + 9, y)
  put(sim, 'starport', x + 9, y + 4)
  const economy = economyOf(sim, 1)
  expect(economy.demand).toBe(15)
  expect(economy.income).toBeCloseTo(0.2 + 3 * (10 / 15))
})

test('здания вне радиуса контроля и без главного здания не работают', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y)
  put(sim, 'starport', x + 6, y + 3)
  put(sim, 'starport', x + 60, y)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 5, income: 1.2 })

  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 0, income: 0 })
  const credits = creditsOf(sim, 1)
  seconds(sim, 5)
  expect(creditsOf(sim, 1)).toBe(credits)
})

test('космопортов не больше трёх на главное здание, считая стройки', () => {
  const { sim, x, y } = start()
  put(sim, 'starport', x + 6, y)
  put(sim, 'starport', x + 9, y)
  expect(atLimit(sim, 1, 'starport')).toBe(false)
  expect(canBuild(sim, 1, 'starport', x + 6, y + 4)).toBe(true)
  sim.send(1, { type: 'build', building: 'starport', x: x + 6, y: y + 4, builders: [] })
  sim.advance(TICK)
  expect(atLimit(sim, 1, 'starport')).toBe(true)
  expect(canBuild(sim, 1, 'starport', x + 9, y + 4)).toBe(false)
  expect(atLimit(sim, 1, 'generator')).toBe(false)
})
