import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  Building, CORE, Converting, Owner, Position, Producer, UNITS, Unit,
  canDeploy, canPlace, createSim, creditsOf, spawnStartingUnits, type Sim,
} from '../src/sim'
import { REWARDS, STARTING_CREDITS } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

// Строка запроса одна на весь обход, поэтому нужное из неё вынимается сразу, в цикле.
function unitsOf(sim: Sim, type: string) {
  const found: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === type) found.push(entity)
  return found
}

/** Симуляция, где MCV игрока 1 стоит на скале и может развернуться, а рядом — пехотинец. */
function start() {
  const sim = createSim(options)
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!canPlace(sim, CORE, x, y)) continue
      spawnStartingUnits(sim, 1, x + 1, y + 1)
      return { sim, mcv: unitsOf(sim, 'mcv')[0], site: { x, y } }
    }
  }
  throw new Error('В мире не нашлось скалы')
}

const units = (sim: Sim, type: string) => unitsOf(sim, type).length
function core(sim: Sim) {
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (building.type === CORE && owner.player === 1) return entity
  }
  return undefined
}

test('игрок появляется с кредитами', () => {
  const { sim } = start()
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS)
  expect(creditsOf(sim, 2)).toBe(0)
})

test('MCV разворачивается в главное здание и сворачивается обратно', () => {
  const { sim, mcv, site } = start()
  expect(canDeploy(sim, 1, mcv)).toBe(true)
  sim.send(1, { type: 'deploy', unit: mcv })
  sim.advance(TICK)
  expect(sim.world.has(mcv, Converting)).toBe(true)
  // Пока разворачивается, с места не трогается и второй раз развернуть нельзя.
  sim.send(1, { type: 'move', units: [mcv], x: site.x + 10, y: site.y })
  seconds(sim, 1)
  expect(Math.floor(sim.world.get(mcv, Position)!.x)).toBe(site.x + 1)
  expect(canDeploy(sim, 1, mcv)).toBe(false)

  seconds(sim, 2.1)
  expect(sim.world.alive(mcv)).toBe(false)
  const building = core(sim)!
  expect(sim.world.get(building, Position)).toEqual({ x: site.x, y: site.y })
  expect(units(sim, 'mcv')).toBe(0)

  // Юниты, стоявшие на месте здания, вышли из него.
  seconds(sim, 3)
  for (const [, position] of sim.world.query(Position, Unit)) {
    expect(sim.occupancy.at(Math.floor(position.x), Math.floor(position.y))).toBeUndefined()
  }

  sim.send(2, { type: 'pack', building })
  sim.send(1, { type: 'pack', building })
  seconds(sim, 9)
  expect(sim.world.alive(building)).toBe(true)
  seconds(sim, 1.2)
  expect(sim.world.alive(building)).toBe(false)
  expect(units(sim, 'mcv')).toBe(1)
  expect(sim.occupancy.at(site.x, site.y)).toBeUndefined()
})

test('развернуться можно только на свободной скале и только своим MCV', () => {
  const { sim, mcv } = start()
  expect(canDeploy(sim, 2, mcv)).toBe(false)
  const [infantry] = unitsOf(sim, 'infantry')
  expect(canDeploy(sim, 1, infantry)).toBe(false)
  expect(canDeploy(sim, 1, 999999 as Entity)).toBe(false)

  // MCV на песке.
  for (let x = 0; x < 400; x++) {
    const sand = spawnUnit(sim, 'mcv', 1, x, 0)
    if (!canDeploy(sim, 1, sand)) return
    sim.world.destroy(sand)
  }
  throw new Error('Не нашлось места, где развернуться нельзя')
})

test('производство списывает кредиты, строит по очереди и выпускает юнитов рядом', () => {
  const { sim, mcv } = start()
  const before = { builders: units(sim, 'builder'), infantry: units(sim, 'infantry') }
  sim.send(1, { type: 'produce', producer: mcv, unit: 'infantry' })
  sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS - UNITS.infantry.cost - UNITS.builder.cost)
  expect(sim.world.get(mcv, Producer)!.queue).toEqual(['infantry', 'builder'])

  seconds(sim, UNITS.infantry.buildTime + 0.1)
  expect(units(sim, 'infantry')).toBe(before.infantry + 1)
  expect(units(sim, 'builder')).toBe(before.builders)
  seconds(sim, UNITS.builder.buildTime + 0.1)
  expect(units(sim, 'builder')).toBe(before.builders + 1)
  expect(sim.world.get(mcv, Producer)!.queue).toEqual([])

  // Каждый вышел на свой тайл, а не встал на голову соседу.
  const tiles: string[] = []
  for (const [, position] of sim.world.query(Position, Unit)) tiles.push(`${Math.floor(position.x)},${Math.floor(position.y)}`)
  expect(new Set(tiles).size).toBe(tiles.length)
})

test('заказ отклоняется без кредитов, у чужого производителя, сверх очереди и для непроизводимого юнита', () => {
  const { sim, mcv } = start()
  sim.send(2, { type: 'produce', producer: mcv, unit: 'infantry' })
  sim.send(1, { type: 'produce', producer: mcv, unit: 'mcv' })
  sim.send(1, { type: 'produce', producer: mcv, unit: 'tank' as never })
  sim.advance(TICK)
  expect(sim.world.get(mcv, Producer)!.queue).toEqual([])
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS)

  // Очередь — не больше пяти заказов; на строителей хватает кредитов на шесть.
  for (let i = 0; i < 8; i++) sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.advance(TICK)
  expect(sim.world.get(mcv, Producer)!.queue.length).toBe(5)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS - 5 * UNITS.builder.cost)

  // Первый готовый юнит приносит награду, но в очереди освободилось только одно место.
  seconds(sim, UNITS.builder.buildTime + 0.1)
  sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS + REWARDS.unit - 6 * UNITS.builder.cost)
})

test('отмена возвращает кредиты за последний заказ', () => {
  const { sim, mcv } = start()
  sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.send(1, { type: 'produce', producer: mcv, unit: 'infantry' })
  sim.send(1, { type: 'cancelProduction', producer: mcv })
  sim.advance(TICK)
  expect(sim.world.get(mcv, Producer)!.queue).toEqual(['builder'])
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS - UNITS.builder.cost)

  seconds(sim, 1)
  sim.send(1, { type: 'cancelProduction', producer: mcv })
  sim.send(1, { type: 'cancelProduction', producer: mcv })
  sim.advance(TICK)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS)
  expect(sim.world.get(mcv, Producer)!.progress).toBe(0)
})

test('очередь производства переезжает из MCV в здание, а пока идёт превращение — стоит', () => {
  const { sim, mcv } = start()
  sim.send(1, { type: 'produce', producer: mcv, unit: 'builder' })
  sim.send(1, { type: 'deploy', unit: mcv })
  sim.advance(TICK)
  const builders = units(sim, 'builder')
  seconds(sim, 3.1)
  const building = core(sim)!
  expect(sim.world.get(building, Producer)!.queue).toEqual(['builder'])
  expect(units(sim, 'builder')).toBe(builders)

  seconds(sim, UNITS.builder.buildTime + 0.1)
  expect(units(sim, 'builder')).toBe(builders + 1)
})

test('сохранение посреди превращения и производства продолжается так же', () => {
  const { sim, mcv } = start()
  sim.send(1, { type: 'produce', producer: mcv, unit: 'infantry' })
  sim.send(1, { type: 'deploy', unit: mcv })
  seconds(sim, 1)
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  seconds(sim, 10)
  seconds(copy, 10)
  expect(copy.save()).toEqual(sim.save())
  // Награды за главное здание и за первый юнит и кредит, который главное здание успело принести само.
  expect(creditsOf(copy, 1)).toBe(STARTING_CREDITS - UNITS.infantry.cost + REWARDS.deploy + REWARDS.unit + 1)
})

test('MCV не разворачивается, пока под будущим зданием чужой юнит, а своих выгоняет', () => {
  const { sim, mcv, site } = start()
  const stranger = spawnUnit(sim, 'infantry', 2, site.x, site.y)
  const own = spawnUnit(sim, 'builder', 1, site.x + 2, site.y)
  sim.send(1, { type: 'deploy', unit: mcv })
  seconds(sim, 8)
  // Свой строитель ушёл, чужой пехотинец стоит, MCV ждёт.
  const position = sim.world.get(own, Position)!
  expect(position.x >= site.x && position.x < site.x + 3 && position.y >= site.y && position.y < site.y + 3).toBe(false)
  expect(Math.floor(sim.world.get(stranger, Position)!.x)).toBe(site.x)
  expect(core(sim)).toBeUndefined()
  expect(sim.world.has(mcv, Converting)).toBe(true)

  sim.send(2, { type: 'move', units: [stranger], x: site.x - 3, y: site.y })
  seconds(sim, 5)
  expect(core(sim)).toBeDefined()
})

test('разворачивание можно отменить: MCV снова едет', () => {
  const { sim, mcv, site } = start()
  spawnUnit(sim, 'infantry', 2, site.x, site.y)
  sim.send(1, { type: 'deploy', unit: mcv })
  seconds(sim, 5)
  sim.send(2, { type: 'cancelDeploy', unit: mcv })
  sim.send(1, { type: 'cancelDeploy', unit: mcv })
  sim.advance(TICK)
  expect(sim.world.has(mcv, Converting)).toBe(false)
  expect(core(sim)).toBeUndefined()
  const before = { ...sim.world.get(mcv, Position)! }
  sim.send(1, { type: 'move', units: [mcv], x: site.x + 6, y: site.y + 1 })
  seconds(sim, 2)
  expect(sim.world.get(mcv, Position)!.x).not.toBe(before.x)
})
