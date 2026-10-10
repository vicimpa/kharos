import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, isCliffFoot, terrainAt } from '../src/map/terrain'
import { Building, Builds, CORE, Orders, Owner, Path, Position, Site, Unit, createSim, siteAt, spawnStartingUnits, type Sim } from '../src/sim'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }
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
        if (terrainAt(sim.land, tileX, tileY) !== Terrain.Rock || isCliffFoot(sim.land, tileX, tileY)) return false
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


/** Первые count юнитов игрока, кроме MCV. */
function squad(sim: Sim, count: number) {
  const units: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type !== 'mcv' && units.length < count) units.push(entity)
  return units
}

test('Shift+ПКМ: точки по очереди, приказ без Shift забывает очередь', () => {
  const { sim, site } = start()
  const units = squad(sim, 2)
  const position = (entity: Entity) => sim.world.get(entity, Position)!
  sim.send(1, { type: 'move', units, x: site.x, y: site.y })
  sim.send(1, { type: 'move', units, x: site.x + 4, y: site.y + 5, queue: true })
  seconds(sim, 0.2)
  expect(sim.world.get(units[0], Orders)!.list.length).toBe(1)
  seconds(sim, 20)
  expect(sim.world.get(units[0], Orders)!.list.length).toBe(0)
  for (const entity of units) expect(Math.hypot(position(entity).x - site.x - 4, position(entity).y - site.y - 5)).toBeLessThan(3)

  sim.send(1, { type: 'move', units, x: site.x, y: site.y })
  sim.send(1, { type: 'move', units, x: site.x + 4, y: site.y, queue: true })
  seconds(sim, 0.2)
  sim.send(1, { type: 'move', units, x: site.x + 1, y: site.y + 1 })
  seconds(sim, 0.2)
  expect(sim.world.get(units[0], Orders)!.list.length).toBe(0)
})

test('приказ группы ждёт всех: пока один едет, никто не берёт следующий', () => {
  const { sim, site } = start()
  const [a, b] = squad(sim, 2)
  // b занят своим путём — a стоит и ждёт.
  sim.send(1, { type: 'move', units: [b], x: site.x + 6, y: site.y + 6 })
  sim.send(1, { type: 'move', units: [a, b], x: site.x + 4, y: site.y + 5, queue: true })
  seconds(sim, 0.1)
  expect(sim.world.has(b, Path)).toBe(true)
  expect(sim.world.has(a, Path)).toBe(false)
})

test('очередь построек: стройка закладывается сразу, строитель берётся за неё, закончив прежнее', () => {
  const { sim, builders, site } = start()
  const [builder] = builders
  sim.send(1, { type: 'move', units: [builder], x: site.x + 3, y: site.y + 6 })
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builder], queue: true })
  seconds(sim, 0.1)
  const placed = siteAt(sim, site.x, site.y)
  expect(placed).toBeDefined()
  expect(sim.world.has(builder, Builds)).toBe(false)
  expect(sim.world.get(builder, Orders)!.list[0].command).toMatchObject({ type: 'assist', site: placed })
  seconds(sim, 10)
  expect(sim.world.get(builder, Builds)?.site ?? (sim.world.has(placed!, Site) ? -1 : placed)).toBe(placed!)
})

test('стройка из меню: строитель на своей стройке берёт новую в очередь, а ПКМ по ней — бросает всё и идёт', () => {
  const { sim, builders, site } = start()
  const [builder] = builders
  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y, builders: [builder] })
  seconds(sim, 0.1)
  const first = siteAt(sim, site.x, site.y)!
  expect(sim.world.get(builder, Builds)?.site).toBe(first)

  sim.send(1, { type: 'build', building: 'generator', x: site.x, y: site.y + 3, builders: [builder] })
  seconds(sim, 0.1)
  const second = siteAt(sim, site.x, site.y + 3)!
  expect(second).toBeDefined()
  expect(sim.world.get(builder, Builds)?.site).toBe(first)
  expect(sim.world.get(builder, Orders)!.list[0].command).toMatchObject({ type: 'assist', site: second })

  sim.send(1, { type: 'assist', units: [builder], site: second })
  seconds(sim, 0.1)
  expect(sim.world.get(builder, Builds)?.site).toBe(second)
  expect(sim.world.get(builder, Orders)!.list.length).toBe(0)
})

test('мусор в полях команды не роняет тик: команда отбрасывается, и сразу, и из очереди', () => {
  const { sim, builders } = start()
  // Объект без рабочих toString и valueOf бросает при приведении к числу — так упал живой сервер.
  const junk = JSON.parse('{"toString":0,"valueOf":0}')
  for (const type of ['harvest', 'move', 'build', 'rally', 'sell', 'patrol', 'pave']) {
    for (const queue of [false, true]) {
      sim.send(1, { type, queue, units: builders, builders, x: junk, y: junk, points: [junk, junk], tiles: [junk, junk], building: junk, port: junk, amount: junk, resource: junk, kind: junk } as never)
    }
  }
  expect(() => seconds(sim, 2)).not.toThrow()
})
