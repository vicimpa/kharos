import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { isBuildable, terrainAt } from '../src/map/terrain'
import { Owner, Path, Position, UNITS, Unit, canPlace, createSim, isWalkable, spawnStartingUnits, type Sim, type UnitType } from '../src/sim'
import { findPath, isClear, smoothPath } from '../src/sim/path'
import { orderMove, spawnUnit } from '../src/sim/units'
import { placeBuilding } from '../src/sim/buildings'

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
  let moved = 0
  for (let i = 0; i < 40; i++) {
    const before = { ...sim.world.get(mcv, Position)! }
    sim.advance(TICK)
    const after = sim.world.get(mcv, Position)!
    const unit = sim.world.get(mcv, Unit)!
    expect([unit.prevX, unit.prevY]).toEqual([before.x, before.y])
    moved = Math.hypot(after.x - before.x, after.y - before.y)
    expect(moved).toBeLessThanOrEqual(2.5 * TICK + 1e-9)
  }
  // Развернувшись к цели, машина идёт полным ходом.
  expect(moved).toBeCloseTo(2.5 * TICK, 9)
})

test('юнит поворачивает плавно: за тик не больше своей скорости поворота', () => {
  const { sim, units } = start()
  const mcv = units[0]
  const [x, y] = tileOf(sim, mcv)
  // MCV появляется, глядя вниз; цель — сзади и сбоку.
  sim.send(1, { type: 'move', units: [mcv], x: x + 6, y: y - 10 })
  sim.advance(TICK)
  const angles = new Set<number>()
  while (sim.world.has(mcv, Path)) {
    sim.advance(TICK)
    const { facing, prevFacing } = sim.world.get(mcv, Unit)!
    const turned = Math.abs(Math.atan2(Math.sin(facing - prevFacing), Math.cos(facing - prevFacing)))
    expect(turned).toBeLessThanOrEqual(UNITS.mcv.turn * TICK + 1e-9)
    angles.add(facing)
  }
  // Угол не привязан к восьми или шестнадцати направлениям.
  expect(angles.size).toBeGreaterThan(20)
  expect(tileOf(sim, mcv)).toEqual([x + 6, y - 10])
})

/** Ровная проходимая площадка 30×9 тайлов скалы — местность нигде не замедляет: её левый верхний тайл. */
function field(sim: Sim) {
  for (let y = -200; y < 200; y += 3) {
    search: for (let x = -200; x < 200; x += 3) {
      for (let dy = 0; dy < 9; dy++) {
        for (let dx = 0; dx < 30; dx++) if (!isWalkable(sim, x + dx, y + dy) || !isBuildable(terrainAt(sim.land, x + dx, y + dy))) continue search
      }
      return { x, y }
    }
  }
  throw new Error('В мире не нашлось ровной площадки')
}

/** Крутит симуляцию, пока кто-то идёт, и проверяет, что юниты не входят друг в друга. Возвращает, сколько тиков прошло. */
function runApart(sim: Sim, units: Entity[]) {
  // Команды выполняются в начале тика: первый тик только раздаёт пути.
  sim.advance(TICK)
  let ticks = 0
  for (; ticks < 20 * 60 && sim.world.count(Path); ticks++) {
    sim.advance(TICK)
    for (const a of units) {
      for (const b of units) {
        if (a >= b) continue
        const first = sim.world.get(a, Position)!
        const second = sim.world.get(b, Position)!
        const reach = UNITS[sim.world.get(a, Unit)!.type].radius + UNITS[sim.world.get(b, Unit)!.type].radius
        expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(reach - 0.05)
      }
    }
  }
  return ticks
}

test('встречные юниты расходятся, не проходя друг сквозь друга', () => {
  for (const type of ['infantry', 'builder', 'mcv'] as UnitType[]) {
    const sim = createSim(options)
    const { x, y } = field(sim)
    const left = spawnUnit(sim, type, 1, x + 2, y + 4)
    const right = spawnUnit(sim, type, 1, x + 26, y + 4)
    sim.send(1, { type: 'move', units: [left], x: x + 23, y: y + 4 })
    sim.send(1, { type: 'move', units: [right], x: x + 5, y: y + 4 })
    runApart(sim, [left, right])
    expect(tileOf(sim, left)).toEqual([x + 23, y + 4])
    expect(tileOf(sim, right)).toEqual([x + 5, y + 4])
  }
})

test('стоящего юнита объезжают, а занятая им цель заменяется соседней', () => {
  const sim = createSim(options)
  const { x, y } = field(sim)
  const guard = spawnUnit(sim, 'mcv', 1, x + 14, y + 4)
  const runner = spawnUnit(sim, 'builder', 1, x + 2, y + 4)
  sim.send(1, { type: 'move', units: [runner], x: x + 26, y: y + 4 })
  runApart(sim, [guard, runner])
  expect(tileOf(sim, runner)).toEqual([x + 26, y + 4])
  expect(tileOf(sim, guard)).toEqual([x + 14, y + 4])

  sim.send(1, { type: 'move', units: [runner], x: x + 14, y: y + 4 })
  runApart(sim, [guard, runner])
  expect(sim.world.has(runner, Path)).toBe(false)
  const [tileX, tileY] = tileOf(sim, runner)
  expect(Math.hypot(tileX - x - 14, tileY - y - 4)).toBeLessThan(4)
})

test('двое, посланные в одну или соседние точки, не кружат друг вокруг друга, а встают рядом', () => {
  for (const [a, b, offset] of [['infantry', 'infantry', 0], ['tank', 'tank', 0], ['carrier', 'carrier', 1], ['buggy', 'carrier', 1]] as const) {
    const sim = createSim(options)
    const { x, y } = field(sim)
    const first = spawnUnit(sim, a, 1, x + 2, y + 4)
    const second = spawnUnit(sim, b, 1, x + 26, y + 4)
    sim.send(1, { type: 'move', units: [first], x: x + 14, y: y + 4 })
    sim.send(1, { type: 'move', units: [second], x: x + 14 + offset, y: y + 4 })
    sim.advance(TICK)
    // Ехать каждому — секунд пять; кружащие не встали бы и за двадцать.
    for (let i = 0; i < 8 / TICK; i++) sim.advance(TICK)
    for (const entity of [first, second]) {
      expect(sim.world.has(entity, Path)).toBe(false)
      const [tileX, tileY] = tileOf(sim, entity)
      expect(Math.hypot(tileX - x - 14, tileY - y - 4)).toBeLessThan(4)
    }
  }
})

test('быстрый юнит обгоняет медленного, а потом уступает ему дорогу', () => {
  const sim = createSim(options)
  const { x, y } = field(sim)
  const slow = spawnUnit(sim, 'mcv', 1, x + 5, y + 4)
  const fast = spawnUnit(sim, 'builder', 1, x + 2, y + 4)
  sim.send(1, { type: 'move', units: [slow], x: x + 27, y: y + 4 })
  sim.send(1, { type: 'move', units: [fast], x: x + 23, y: y + 4 })
  runApart(sim, [slow, fast])
  expect(tileOf(sim, slow)).toEqual([x + 27, y + 4])
  // Строитель пришёл первым и встал на пути MCV; тот попросил его отойти.
  const [tileX, tileY] = tileOf(sim, fast)
  expect([tileX, tileY]).not.toEqual([x + 23, y + 4])
  expect(Math.hypot(tileX - x - 23, tileY - y - 4)).toBeLessThan(4)
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
  placeBuilding(sim.world, 'command', x, y, 1)

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

test('юнит попадает в точку сразу за крутым поворотом, а не кружит вокруг неё', () => {
  const sim = createSim(options)
  const { x, y } = field(sim)
  for (const type of ['mcv', 'builder', 'infantry'] as UnitType[]) {
    const unit = spawnUnit(sim, type, 1, x + 1, y + 4)
    // Последняя точка — в тайле вбок от предпоследней: ближе, чем радиус разворота машины на ходу.
    sim.world.add(unit, Path({ points: [x + 8.5, y + 4.5, x + 8.5, y + 5.5], goalX: x + 8, goalY: y + 5 }))
    for (let i = 0; i < 20 * 10; i++) sim.advance(TICK)
    expect(sim.world.has(unit, Path)).toBe(false)
    expect(sim.world.get(unit, Position)).toEqual({ x: x + 8.5, y: y + 5.5 })
    sim.world.destroy(unit)
  }
})

test('путь, оборванный лимитом поиска, юнит продолжает с конца и доходит до цели', () => {
  const sim = createSim(options)
  let x = 0
  while (!isWalkable(sim, x, 0)) x++
  const y = 0
  const buggy = spawnUnit(sim, 'buggy', 1, x, y)
  // Дальняя достижимая цель: её находит поиск без лимита.
  let goal: number[] | undefined
  for (let r = 60; !goal && r < 120; r += 4) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      if (!isWalkable(sim, x + dx, y + dy)) continue
      const tiles = findPath((tx, ty) => isWalkable(sim, tx, ty), x, y, x + dx, y + dy, 0, 1e6)
      if (tiles.at(-2) === x + dx && tiles.at(-1) === y + dy) {
        goal = [x + dx, y + dy]
        break
      }
    }
  }
  // Первый поиск обрывается на 200 тайлах.
  orderMove(sim, buggy, goal![0], goal![1], undefined, 0, 0, 200)
  for (let i = 0; i < 20 * 120 && sim.world.has(buggy, Path); i++) sim.advance(TICK)
  const [atX, atY] = tileOf(sim, buggy)
  expect(Math.hypot(atX - goal![0], atY - goal![1])).toBeLessThan(2)
})

test('юниты, едущие через одну точку навстречу друг другу, доезжают, а не кружат хороводом', () => {
  for (const type of ['buggy', 'infantry', 'tank'] as const) {
    const sim = createSim({ generator: { ...DEFAULT_SETTINGS.generator, seed: 7 }, size: 256 })
    const units: Entity[] = []
    // По кругу, каждый — к противоположной точке: все пересекаются в центре, и двоим может достаться один тайл.
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2
      const unit = spawnUnit(sim, type, 1, Math.cos(angle) * 8, Math.sin(angle) * 8)
      orderMove(sim, unit, Math.floor(-Math.cos(angle) * 8), Math.floor(-Math.sin(angle) * 8))
      units.push(unit)
    }
    for (let tick = 0; tick < 20 * 100 && units.some((unit) => sim.world.has(unit, Path)); tick++) sim.advance(1 / 20)
    expect(units.filter((unit) => sim.world.has(unit, Path))).toEqual([])
  }
})
