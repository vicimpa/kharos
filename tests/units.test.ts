import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Owner, Path, Position, Unit, canPlace, createSim, isWalkable, spawnStartingUnits, type Sim } from '../src/sim'
import { findPath, isClear, smoothPath } from '../src/sim/path'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20

/** Карта из строк: # — стена, остальное проходимо. За краями — стена. */
function grid(...rows: string[]) {
  return (x: number, y: number) => rows[y]?.[x] !== undefined && rows[y][x] !== '#'
}

test('путь обходит стену и не режет углы', () => {
  const walkable = grid(
    '.....',
    '.###.',
    '.....',
  )
  const path = findPath(walkable, 0, 2, 4, 0)
  expect(path.slice(-2)).toEqual([4, 0])
  for (let i = 0; i < path.length; i += 2) expect(walkable(path[i], path[i + 1])).toBe(true)
  // Мимо угла стены наискось нельзя: из (3, 2) в (4, 1) только через (4, 2).
  expect(path).toEqual([1, 2, 2, 2, 3, 2, 4, 2, 4, 1, 4, 0])
})

test('путь по открытому месту идёт наискось', () => {
  const walkable = grid('....', '....', '....', '....')
  expect(findPath(walkable, 0, 0, 3, 3)).toEqual([1, 1, 2, 2, 3, 3])
  expect(findPath(walkable, 0, 0, 0, 0)).toEqual([])
})

test('к недостижимой цели путь ведёт до ближайшего тайла', () => {
  const walkable = grid(
    '..#..',
    '..#..',
    '..#..',
  )
  expect(findPath(walkable, 0, 1, 4, 1).slice(-2)).toEqual([1, 1])
  // Цель внутри стены.
  expect(findPath(walkable, 0, 1, 2, 1).slice(-2)).toEqual([1, 1])
})

test('спрямление выбрасывает лишние точки, но не ведёт сквозь стену', () => {
  const open = grid('.....', '.....', '.....')
  const tiles = findPath(open, 0, 0, 4, 2).map((value) => value + 0.5)
  expect(smoothPath(open, 0.5, 0.5, tiles)).toEqual([4.5, 2.5])

  const walled = grid(
    '.....',
    '.###.',
    '.....',
  )
  const around = findPath(walled, 0, 2, 4, 0).map((value) => value + 0.5)
  const smooth = smoothPath(walled, 0.5, 2.5, around)
  expect(smooth.slice(-2)).toEqual([4.5, 0.5])
  expect(smooth.length).toBeLessThan(around.length)
  let fromX = 0.5
  let fromY = 2.5
  for (let i = 0; i < smooth.length; i += 2) {
    expect(isClear(walled, fromX, fromY, smooth[i], smooth[i + 1])).toBe(true)
    fromX = smooth[i]
    fromY = smooth[i + 1]
  }
})

/** Симуляция со стартовым набором игрока 1 у начала мира. */
function start() {
  const sim = createSim(options)
  const units = spawnStartingUnits(sim, 1, 0, 0)
  return { sim, units }
}

const tileOf = (sim: Sim, entity: Entity) => {
  const { x, y } = sim.world.get(entity, Position)!
  return [Math.floor(x), Math.floor(y)]
}

test('стартовый набор появляется на проходимых тайлах, каждый на своём', () => {
  const { sim, units } = start()
  expect(units.map((entity) => sim.world.get(entity, Unit)!.type)).toEqual([
    'mcv', 'builder', 'builder', 'infantry', 'infantry', 'infantry',
  ])
  const tiles = units.map((entity) => tileOf(sim, entity))
  for (const [x, y] of tiles) expect(isWalkable(sim, x, y)).toBe(true)
  expect(new Set(tiles.map(String)).size).toBe(units.length)
})

test('юниты доходят до цели и встают на разные тайлы', () => {
  const { sim, units } = start()
  const [x, y] = tileOf(sim, units[0])
  sim.send(1, { type: 'move', units, x: x + 20, y: y + 6 })
  sim.advance(TICK)
  expect(sim.world.count(Path)).toBe(units.length)

  // С запасом: двадцать тайлов самому медленному — восемь секунд по прямой.
  for (let i = 0; i < 20 * 60 && sim.world.count(Path); i++) sim.advance(TICK)
  expect(sim.world.count(Path)).toBe(0)
  const tiles = units.map((entity) => tileOf(sim, entity))
  expect(new Set(tiles.map(String)).size).toBe(units.length)
  for (const [tileX, tileY] of tiles) {
    expect(isWalkable(sim, tileX, tileY)).toBe(true)
    expect(Math.hypot(tileX - x - 20, tileY - y - 6)).toBeLessThan(30)
  }
})

test('за тик юнит проходит не больше своей скорости и запоминает прошлое место', () => {
  const { sim, units } = start()
  const mcv = units[0]
  const [x, y] = tileOf(sim, mcv)
  sim.send(1, { type: 'move', units: [mcv], x: x + 20, y })
  sim.advance(TICK)
  for (let i = 0; i < 10; i++) {
    const before = { ...sim.world.get(mcv, Position)! }
    sim.advance(TICK)
    const after = sim.world.get(mcv, Position)!
    const unit = sim.world.get(mcv, Unit)!
    expect([unit.prevX, unit.prevY]).toEqual([before.x, before.y])
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(2.5 * TICK, 9)
  }
})

test('чужими юнитами командовать нельзя', () => {
  const { sim, units } = start()
  const [x, y] = tileOf(sim, units[0])
  sim.send(2, { type: 'move', units, x: x + 5, y })
  sim.send(1, { type: 'move', units: [999999, -1, 'x' as never], x: x + 5, y })
  sim.send(1, { type: 'move', units, x: x + 0.5, y })
  sim.advance(TICK)
  expect(sim.world.count(Path)).toBe(0)
})

test('здание на пути заставляет проложить путь заново', () => {
  const { sim, units } = start()
  const scout = units[3]
  // Ищем скалу, через которую пройдёт прямой путь, и ставим на ней здание, когда юнит уже идёт.
  let site: { x: number; y: number } | undefined
  search: for (let radius = 6; radius < 200; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (canPlace(sim, 'command', dx, dy)) {
          site = { x: dx, y: dy }
          break search
        }
      }
    }
  }
  expect(site).toBeDefined()
  const { x, y } = site!
  // Цель — за будущим зданием, если смотреть от юнита.
  const [fromX, fromY] = tileOf(sim, scout)
  const goalX = x + 1 + Math.sign(x + 1 - fromX) * 4
  const goalY = y + 1 + Math.sign(y + 1 - fromY) * 4
  sim.send(1, { type: 'move', units: [scout], x: goalX, y: goalY })
  sim.advance(TICK)
  sim.send(1, { type: 'placeBuilding', building: 'command', x, y })

  for (let i = 0; i < 20 * 120 && sim.world.has(scout, Path); i++) {
    sim.advance(TICK)
    const [tileX, tileY] = tileOf(sim, scout)
    expect(sim.occupancy.at(tileX, tileY)).toBeUndefined()
  }
  expect(sim.world.has(scout, Path)).toBe(false)
  expect(sim.world.get(sim.occupancy.at(x, y)!, Owner)!.player).toBe(1)
})

test('сохранение посреди пути продолжается так же, как оригинал', () => {
  const { sim, units } = start()
  const [x, y] = tileOf(sim, units[0])
  sim.send(1, { type: 'move', units, x: x + 15, y: y - 4 })
  for (let i = 0; i < 20; i++) sim.advance(TICK)

  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  for (let i = 0; i < 200; i++) {
    sim.advance(TICK)
    copy.advance(TICK)
  }
  expect(copy.save()).toEqual(sim.save())
})
