import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import type { Entity } from '../src/ecs'
import {
  BUILDINGS, Building, Deposit, Hauler, ORE_PRICE, Position, SELL_SECONDS, TRUCK_CAPACITY, Trade, Unit, canBuild, canSell, isWalkable, stockOf, canPlace, createSim, creditsOf, depositAt, depositIn, depositNear, oreLeft, rewardsOf,
  zonesOf, type DepositSpot, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Симуляция и месторождение, справа от которого есть скала под хранилище. */
function start() {
  const sim = createSim(options)
  for (let cellY = -5; cellY < 5; cellY++) {
    for (let cellX = -5; cellX < 5; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (spot && canPlace(sim, 'silo', spot.x + 3, spot.y)) return { sim, spot }
    }
  }
  throw new Error('В мире не нашлось месторождения')
}

test('месторождения считаются из сида: одни и те же в двух мирах, на скале и не чаще одного на клетку', () => {
  const first = createSim(options)
  const second = createSim(options)
  const spots: DepositSpot[] = []
  for (let cellY = -6; cellY < 6; cellY++) {
    for (let cellX = -6; cellX < 6; cellX++) {
      const spot = depositIn(first, cellX, cellY)
      expect(depositIn(second, cellX, cellY)).toEqual(spot)
      if (spot) spots.push(spot)
    }
  }
  // Месторождений заметно меньше, чем клеток, но они есть.
  expect(spots.length).toBeGreaterThan(20)
  expect(spots.length).toBeLessThan(144)
  for (const spot of spots) {
    expect(canPlace(first, 'mine', spot.x, spot.y)).toBe(true)
    expect(spot.ore).toBeGreaterThanOrEqual(4000)
    expect(depositAt(first, spot.x, spot.y)).toBe(spot)
    expect(depositAt(first, spot.x + 1, spot.y)).toBeNull()
    expect(depositNear(first, spot.x + 2.5, spot.y + 1, 3)).toBe(spot)
  }
  // Нетронутые месторождения в мире не хранятся.
  expect(first.world.count(Deposit)).toBe(0)
})

test('шахта ставится только на месторождение и без своей зоны, строит её строитель', () => {
  const { sim, spot } = start()
  addCredits(sim, 1, 1000)
  expect(zonesOf(sim, 1).length).toBe(0)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(true)
  expect(canBuild(sim, 1, 'mine', spot.x + 1, spot.y)).toBe(false)
  // Чужая зона закрывает месторождение.
  const core = placeBuilding(sim.world, 'command', spot.x + 6, spot.y, 2)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
  sim.world.destroy(core)

  sim.send(1, { type: 'spawnUnit', unit: 'builder', x: spot.x - 1, y: spot.y })
  sim.send(1, { type: 'build', building: 'mine', x: spot.x, y: spot.y, builders: [] })
  seconds(sim, 30)
  // Готовая шахта начинает свою зону: рядом можно строить.
  expect(zonesOf(sim, 1).length).toBe(1)
  expect(rewardsOf(sim, 1)).toEqual(['mine'])
  expect(canBuild(sim, 1, 'silo', spot.x + 3, spot.y)).toBe(true)
})

/** Крутит симуляцию, пока условие не выполнится; падает, если не дождалась за limit секунд. */
function until(sim: Sim, done: () => boolean, limit = 200) {
  for (let i = 0; i < limit / TICK; i++) {
    if (done()) return
    sim.advance(TICK)
  }
  throw new Error('Не дождались')
}

/** База у месторождения: шахта, главное здание справа от неё и грузовик игрока 1. */
function base() {
  const sim = createSim(options)
  for (let cellY = -6; cellY < 6; cellY++) {
    for (let cellX = -6; cellX < 6; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (!spot || !canPlace(sim, 'command', spot.x + 5, spot.y)) continue
      // Оба коннектора и место под грузовики должны быть проходимы.
      const free = [[0, 2], [6, 3], [-1, 0], [-1, 1], [-1, 2], [1, 2]].every(([x, y]) => isWalkable(sim, spot.x + x, spot.y + y))
      if (!free) continue
      addCredits(sim, 1, 0)
      const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
      const core = placeBuilding(sim.world, 'command', spot.x + 5, spot.y, 1)
      const truck = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y)
      return { sim, spot, mine, core, truck }
    }
  }
  throw new Error('В мире не нашлось места под базу у месторождения')
}

const onTile = (sim: Sim, unit: Entity, x: number, y: number) => {
  const position = sim.world.get(unit, Position)!
  return Math.floor(position.x) === x && Math.floor(position.y) === y
}

test('шахта работает, только пока грузовик стоит на её коннекторе задом; руду он везёт к главному зданию', () => {
  const { sim, spot, mine, core, truck } = base()
  const cargo = () => sim.world.get(truck, Hauler)!
  const stock = () => sim.world.get(core, Building)!.ore
  // Без привязки грузовик стоит, шахта тоже.
  seconds(sim, 5)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(spot.ore)
  expect(cargo().mine).toBe(-1)
  // Чужой грузовик к шахте не привязать.
  const stranger = spawnUnit(sim, 'truck', 2, spot.x - 1, spot.y + 1)
  sim.send(2, { type: 'haul', units: [stranger], mine })
  sim.send(1, { type: 'haul', units: [truck, stranger], mine })
  sim.advance(TICK)
  expect(sim.world.get(stranger, Hauler)!.mine).toBe(-1)
  sim.world.destroy(stranger)

  // Грузовик встаёт на коннектор под шахтой носом от неё, и только тогда идёт руда.
  until(sim, () => cargo().docked)
  expect(onTile(sim, truck, spot.x, spot.y + 2)).toBe(true)
  expect(sim.world.get(truck, Unit)!.facing).toBeCloseTo(Math.PI / 2)
  expect(oreLeft(sim, spot.x, spot.y)).toBeGreaterThan(spot.ore - 1)
  seconds(sim, 10)
  expect(cargo().ore).toBeCloseTo(BUILDINGS.mine.extract * 10, 0)
  expect(oreLeft(sim, spot.x, spot.y)).toBeCloseTo(spot.ore - cargo().ore)

  // Полный едет к коннектору главного здания и выгружается в его запас; сама руда кредитов не даёт.
  until(sim, () => cargo().full)
  expect(cargo().ore).toBe(TRUCK_CAPACITY)
  until(sim, () => stock() > 0)
  expect(onTile(sim, truck, spot.x + 6, spot.y + 3)).toBe(true)
  until(sim, () => !cargo().full)
  expect(stock()).toBeCloseTo(TRUCK_CAPACITY)
  expect(stockOf(sim, 1)).toEqual({ ore: stock(), capacity: BUILDINGS.command.stores })
  // Разгрузился — вернулся к шахте сам.
  until(sim, () => cargo().docked && cargo().ore > 0)
  expect(onTile(sim, truck, spot.x, spot.y + 2)).toBe(true)

  // Приказ идти снимает грузовик с маршрута, и шахта встаёт.
  sim.send(1, { type: 'move', units: [truck], x: spot.x - 3, y: spot.y })
  seconds(sim, 5)
  expect(cargo().mine).toBe(-1)
  const left = oreLeft(sim, spot.x, spot.y)
  seconds(sim, 5)
  expect(oreLeft(sim, spot.x, spot.y)).toBe(left)

  // Сохранение помнит и добытое, и груз, и запас.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(oreLeft(copy, spot.x, spot.y)).toBe(left)
  expect(copy.world.get(truck, Hauler)!.ore).toBe(cargo().ore)
  expect(copy.world.get(core, Building)!.ore).toBe(stock())
})

test('коннектор один: второй грузовик ждёт рядом, своих с коннектора выгоняют, чужой его блокирует', () => {
  const { sim, spot, mine, truck } = base()
  const second = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y + 1)
  const hauler = (entity: Entity) => sim.world.get(entity, Hauler)!
  // Свой пехотинец стоит на коннекторе — его попросят уйти.
  const soldier = spawnUnit(sim, 'infantry', 1, spot.x, spot.y + 2)
  sim.send(1, { type: 'haul', units: [truck, second], mine })
  until(sim, () => hauler(truck).docked || hauler(second).docked)
  expect(onTile(sim, soldier, spot.x, spot.y + 2)).toBe(false)
  seconds(sim, 10)
  // Грузится один; второй пуст и стоит не на коннекторе.
  const [busy, idle] = hauler(truck).docked ? [truck, second] : [second, truck]
  expect(hauler(idle).docked).toBe(false)
  expect(hauler(idle).ore).toBe(0)
  expect(hauler(busy).ore).toBeGreaterThan(0)
  // Первый уехал — второй занял коннектор.
  until(sim, () => hauler(busy).full)
  until(sim, () => hauler(idle).docked)

  // Чужой юнит на коннекторе главного здания: грузовик не выгружается и никого не гонит.
  const stranger = spawnUnit(sim, 'infantry', 0, spot.x + 6, spot.y + 3)
  seconds(sim, 30)
  expect(hauler(busy).ore).toBe(TRUCK_CAPACITY)
  expect(onTile(sim, stranger, spot.x + 6, spot.y + 3)).toBe(true)
  sim.send(0, { type: 'move', units: [stranger], x: spot.x + 6, y: spot.y + 7 })
  until(sim, () => !hauler(busy).full)
})

test('хранилище конечно: когда место кончилось, грузовик ждёт у коннектора; хранилища зоны добавляют места', () => {
  const { sim, spot, mine, core, truck } = base()
  const capacity = BUILDINGS.command.stores
  sim.world.get(core, Building)!.ore = capacity - 5
  sim.send(1, { type: 'haul', units: [truck], mine })
  const cargo = () => sim.world.get(truck, Hauler)!
  until(sim, () => cargo().full && cargo().docked)
  seconds(sim, 10)
  // Влезло только пять единиц, остальное в кузове.
  expect(sim.world.get(core, Building)!.ore).toBe(capacity)
  expect(cargo().ore).toBeCloseTo(TRUCK_CAPACITY - 5)

  // Хранилище в той же зоне принимает остаток.
  const silo = placeBuilding(sim.world, 'silo', spot.x + 9, spot.y, 1)
  until(sim, () => !cargo().full)
  expect(sim.world.get(silo, Building)!.ore).toBeCloseTo(TRUCK_CAPACITY - 5)
  expect(stockOf(sim, 1).capacity).toBe(capacity + BUILDINGS.silo.stores)
})

test('космопорт продаёт руду по заявке: свободные грузовики свозят её из хранилищ, потом приходят кредиты', () => {
  const { sim, spot, mine, core, truck } = base()
  sim.world.get(core, Building)!.ore = 80
  const silo = placeBuilding(sim.world, 'silo', spot.x + 9, spot.y + 5, 1)
  sim.world.get(silo, Building)!.ore = 15
  const credits = creditsOf(sim, 1)
  const cargo = () => sim.world.get(truck, Hauler)!
  const stored = () => sim.world.get(core, Building)!.ore + sim.world.get(silo, Building)!.ore
  // Без космопорта руда лежит и денег не приносит.
  seconds(sim, 5)
  expect(creditsOf(sim, 1) - credits).toBeLessThanOrEqual(1)
  expect(canBuild(sim, 1, 'spaceport', spot.x + 9, spot.y)).toBe(true)
  const port = placeBuilding(sim.world, 'spaceport', spot.x + 9, spot.y, 1)
  expect(canSell(sim, 1, port)).toBe(true)
  expect(canSell(sim, 2, port)).toBe(false)

  // Заявка руду не забирает: её должны привезти.
  sim.send(2, { type: 'sell', port, amount: 50 })
  sim.send(1, { type: 'sell', port, amount: 50 })
  sim.advance(TICK)
  const order = () => sim.world.get(port, Trade)!
  expect(order().wanted).toBe(50)
  expect(stored()).toBe(95)
  // Пока заявка открыта, вторую космопорт не берёт.
  sim.send(1, { type: 'sell', port, amount: 10 })
  sim.advance(TICK)
  expect(order().wanted).toBe(50)

  // Космопорт сам позвал свободный грузовик; тот грузится у хранилища и везёт к коннектору космопорта.
  until(sim, () => cargo().port === port)
  until(sim, () => cargo().docked && cargo().ore > 0)
  expect(onTile(sim, truck, spot.x + 10, spot.y + 3)).toBe(false)
  until(sim, () => order().delivered > 0)
  expect(onTile(sim, truck, spot.x + 10, spot.y + 3)).toBe(true)
  // Руда нигде не теряется: она в хранилищах, в кузове или в космопорте.
  expect(stored() + cargo().ore + order().delivered).toBeCloseTo(95)

  // Привезли всё — грузовик свободен, корабль улетел, кредиты приходят после полёта.
  until(sim, () => order().total > 0)
  expect(order().delivered).toBeCloseTo(50)
  expect(stored()).toBeCloseTo(45)
  until(sim, () => cargo().port === -1, 5)
  expect(cargo().ore).toBe(0)
  const before = creditsOf(sim, 1)
  seconds(sim, SELL_SECONDS - 2)
  expect(creditsOf(sim, 1) - before).toBeLessThan(10)
  expect(sim.world.has(port, Trade)).toBe(true)
  seconds(sim, 2)
  expect(sim.world.has(port, Trade)).toBe(false)
  const income = BUILDINGS.command.income * SELL_SECONDS
  expect(Math.abs(creditsOf(sim, 1) - before - 50 * ORE_PRICE - income)).toBeLessThanOrEqual(1)

  // Грузовик, привязанный к шахте, на зов космопорта не идёт; заявку можно закрыть с тем, что привезли.
  sim.send(1, { type: 'haul', units: [truck], mine })
  sim.send(1, { type: 'sell', port, amount: 1000 })
  seconds(sim, 5)
  expect(order().wanted).toBe(45)
  expect(cargo().port).toBe(-1)
  expect(order().delivered).toBe(0)
  sim.send(1, { type: 'closeSale', port })
  sim.advance(TICK)
  expect(sim.world.has(port, Trade)).toBe(false)
  expect(stored()).toBeCloseTo(45)
})

test('коннекторы нельзя застраивать, а выработанное месторождение освобождает грузовик', () => {
  const { sim, spot, mine, truck } = base()
  addCredits(sim, 1, 1000)
  // Тайл под шахтой и тайл под воротами главного здания — коннекторы.
  expect(canBuild(sim, 1, 'silo', spot.x, spot.y + 2)).toBe(false)
  expect(canBuild(sim, 1, 'silo', spot.x + 5, spot.y + 3)).toBe(false)
  expect(canBuild(sim, 1, 'silo', spot.x + 2, spot.y + 3)).toBe(true)

  sim.send(1, { type: 'haul', units: [truck], mine })
  const cargo = () => sim.world.get(truck, Hauler)!
  until(sim, () => cargo().docked)
  for (const [, deposit] of sim.world.query(Deposit)) deposit.mined = spot.ore - 1
  until(sim, () => oreLeft(sim, spot.x, spot.y) === 0)
  // Довёз остаток и освободился.
  until(sim, () => cargo().mine === -1)
  expect(cargo().ore).toBe(0)
  expect(stockOf(sim, 1).ore).toBeGreaterThan(1)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
})
