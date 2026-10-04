import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import type { Entity } from '../src/ecs'
import {
  BUILDINGS, Beam, DEPOSIT_CELL, DEPOSIT_KINDS, DEPOSIT_TYPES, Deposit, Hauler, Inventory, REFINE_RATE, REFINE_RATIO, RESOURCE_SPECS, SELL_SECONDS, TRUCK_CAPACITY, Trade, amountOf, canBuild, deliveredTo, gapBetween, canSell, isWalkable, stockOf, canPlace, createSim, creditsOf, depositAt, depositIn, depositNear, reserveLeft, rewardsOf,
  zonesOf, type BuildingType, type DepositSpot, type Good, type Sim,
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
      if (spot && spot.kind === 'metal' && canPlace(sim, 'silo', spot.x + 3, spot.y)) return { sim, spot }
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
    expect(spot.reserve).toBeGreaterThanOrEqual(DEPOSIT_KINDS[spot.kind].min)
    expect(spot.reserve).toBeLessThanOrEqual(DEPOSIT_KINDS[spot.kind].max)
    expect(depositAt(first, spot.x, spot.y)).toBe(spot)
    expect(depositAt(first, spot.x + 1, spot.y)).toBeNull()
    expect(depositNear(first, spot.x + 2.5, spot.y + 1, 3)).toBe(spot)
  }
  // Нетронутые месторождения в мире не хранятся.
  expect(first.world.count(Deposit)).toBe(0)
})

test('у большинства точек карты все четыре вида месторождений в радиусе 150 тайлов', () => {
  // Спавн игроков случайный (как в Rust), поэтому проверяется статистика по сетке точек, а не одна точка:
  // шансы видов подобраны так, что у 8 из 10 точек карты в радиусе 150 тайлов есть все четыре вида,
  // и ни один вид не отсутствует более чем у каждой десятой точки (вопрос 14 §6 design.md).
  const sim = createSim(options)
  const reach = 150
  let all = 0
  let points = 0
  const missing: Record<string, number> = {}
  for (const kind of DEPOSIT_TYPES) missing[kind] = 0
  for (let x = -448; x <= 448; x += 64) {
    for (let y = -448; y <= 448; y += 64) {
      points++
      const kinds = new Set<string>()
      const from = Math.floor((x - reach) / DEPOSIT_CELL)
      const to = Math.floor((x + reach) / DEPOSIT_CELL)
      const top = Math.floor((y - reach) / DEPOSIT_CELL)
      const bottom = Math.floor((y + reach) / DEPOSIT_CELL)
      for (let cellY = top; cellY <= bottom; cellY++) {
        for (let cellX = from; cellX <= to; cellX++) {
          const spot = depositIn(sim, cellX, cellY)
          if (spot && Math.hypot(spot.x + 1 - x, spot.y + 1 - y) <= reach) kinds.add(spot.kind)
        }
      }
      if (DEPOSIT_TYPES.every((kind) => kinds.has(kind))) all++
      for (const kind of DEPOSIT_TYPES) if (!kinds.has(kind)) missing[kind]++
    }
  }
  expect(all / points).toBeGreaterThanOrEqual(0.8)
  for (const kind of DEPOSIT_TYPES) expect(missing[kind] / points).toBeLessThanOrEqual(0.1)
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
      if (!spot || spot.kind !== 'metal' || !canPlace(sim, 'command', spot.x + 5, spot.y)) continue
      // Место под грузовики вокруг шахты и под главным зданием должно быть проходимо.
      const free = [[0, 2], [1, 2], [6, 3], [-1, 0], [-1, 1], [-1, 2], [2, 2], [3, 1]].every(([x, y]) => isWalkable(sim, spot.x + x, spot.y + y))
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

/** Ставит здание игрока 1 рядом с базой; место не проверяется — тесты ставят здания нарочно. */
const place = (sim: Sim, type: BuildingType, x: number, y: number) => placeBuilding(sim.world, type, x, y, 1)

/** Сколько груза на складе сущности. */
const good = (sim: Sim, entity: Entity, resource: Good) => amountOf(sim.world.get(entity, Inventory)!, resource)
/** Сколько руды металла на складе сущности. */
const oreIn = (sim: Sim, entity: Entity) => good(sim, entity, 'metalOre')
/** Сколько готового металла на складе сущности. */
const metalIn = (sim: Sim, entity: Entity) => good(sim, entity, 'metal')

/** Переработка с электростанцией в зоне главного здания: завод работает, только когда есть энергия. */
function refineryAt(sim: Sim, spot: DepositSpot) {
  const refinery = place(sim, 'refinery', spot.x + 12, spot.y + 2)
  place(sim, 'generator', spot.x + 14, spot.y)
  return refinery
}

test('шахта копит руду; привязанный грузовик возит её на переработку, а без неё копит в кузове', () => {
  const { sim, spot, mine, core, truck } = base()
  const hauler = () => sim.world.get(truck, Hauler)!
  const cargo = () => oreIn(sim, truck)
  // Без грузовика шахта добывает руду в свой склад.
  seconds(sim, 5)
  expect(oreIn(sim, mine)).toBeCloseTo(DEPOSIT_KINDS.metal.rate * 5)
  expect(reserveLeft(sim, spot.x, spot.y)).toBeCloseTo(spot.reserve - oreIn(sim, mine))
  expect(hauler().mine).toBe(-1)
  // Чужой грузовик к шахте не привязать.
  const stranger = spawnUnit(sim, 'truck', 2, spot.x - 1, spot.y + 1)
  sim.send(2, { type: 'haul', units: [stranger], mine })
  sim.send(1, { type: 'haul', units: [truck, stranger], mine })
  sim.advance(TICK)
  expect(sim.world.get(stranger, Hauler)!.mine).toBe(-1)
  sim.world.destroy(stranger)

  // Грузовик подъезжает на длину своего луча — вплотную и задом вставать не нужно — и выкачивает добытое.
  until(sim, () => hauler().loading)
  const beam = sim.world.get(truck, Beam)!
  expect(gapBetween(sim, mine, truck)).toBeLessThanOrEqual(beam.radius)
  expect(beam.links).toEqual([{ target: mine, pulling: true, resource: 'metalOre' }])
  until(sim, () => oreIn(sim, mine) < 0.1)
  // Дальше грузится по мере добычи.
  const loaded = cargo()
  seconds(sim, 10)
  expect(cargo()).toBeCloseTo(loaded + DEPOSIT_KINDS.metal.rate * 10, 0)

  // Полный не находит переработки и ждёт с грузом: руду в хранилища не кладут.
  until(sim, () => hauler().full)
  expect(cargo()).toBe(TRUCK_CAPACITY)
  seconds(sim, 5)
  expect(hauler().to).toBe(-1)
  expect(stockOf(sim, 1).items).toEqual({})
  expect(oreIn(sim, core)).toBe(0)

  // Появилась переработка: кузов уезжает к ней и становится металлом.
  const refinery = refineryAt(sim, spot)
  until(sim, () => !hauler().full)
  expect(metalIn(sim, refinery) + oreIn(sim, refinery)).toBeCloseTo(TRUCK_CAPACITY)
  until(sim, () => metalIn(sim, refinery) > 15)
  // Готовое копится у завода: заявок на него нет, а сам грузовик возит только руду.
  seconds(sim, 10)
  expect(stockOf(sim, 1).items).toEqual({})

  // Приказ идти снимает грузовик с шахты. Дальше он свободен: накопленное в шахте диспетчер велит ему увезти.
  sim.send(1, { type: 'move', units: [truck], x: spot.x - 3, y: spot.y })
  seconds(sim, 1)
  expect(hauler().mine).toBe(-1)
  sim.world.get(mine, Inventory)!.items.metalOre = BUILDINGS.mine.inventory
  until(sim, () => hauler().from === mine)

  // Сохранение помнит и руду, и груз, и запас.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(reserveLeft(copy, spot.x, spot.y)).toBe(reserveLeft(sim, spot.x, spot.y))
  expect(oreIn(copy, truck)).toBe(cargo())
  expect(metalIn(copy, refinery)).toBe(metalIn(sim, refinery))
  expect(oreIn(copy, mine)).toBe(oreIn(sim, mine))
  expect(copy.world.get(truck, Hauler)).toEqual(hauler())

  // Полная шахта, которую некому вывезти, не добывает.
  sim.world.destroy(truck)
  sim.world.get(mine, Inventory)!.items.metalOre = BUILDINGS.mine.inventory
  const left = reserveLeft(sim, spot.x, spot.y)
  seconds(sim, 5)
  expect(reserveLeft(sim, spot.x, spot.y)).toBe(left)
})

test('без переработки руда копится в шахте и кузове: металла не появляется нигде', () => {
  const { sim, spot, mine, truck } = base()
  sim.send(1, { type: 'haul', units: [truck], mine })
  until(sim, () => sim.world.get(truck, Hauler)!.full)
  seconds(sim, 30)
  expect(stockOf(sim, 1).items).toEqual({})
  expect(oreIn(sim, mine) + oreIn(sim, truck)).toBeGreaterThan(DEPOSIT_KINDS.metal.rate * 25)
  expect(reserveLeft(sim, spot.x, spot.y)).toBeGreaterThan(0)
})

test('очередей нет: несколько грузовиков выкачивают шахту одновременно', () => {
  const { sim, mine, truck, spot } = base()
  const refinery = refineryAt(sim, spot)
  const second = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y + 1)
  sim.world.get(mine, Inventory)!.items.metalOre = BUILDINGS.mine.inventory
  sim.send(1, { type: 'haul', units: [truck, second], mine })
  // Руду грузовикам даёт только шахта: прибавилось у обоих в один тик — качали одновременно.
  let both = 0
  for (let i = 0; i < 20 / TICK; i++) {
    const before = [oreIn(sim, truck), oreIn(sim, second)]
    sim.advance(TICK)
    if (oreIn(sim, truck) > before[0] && oreIn(sim, second) > before[1]) both++
  }
  expect(both).toBeGreaterThan(0)
  // В шахте было на два кузова: оба доехали до переработки и стали металлом.
  until(sim, () => metalIn(sim, refinery) + oreIn(sim, refinery) >= 2 * TRUCK_CAPACITY - 1e-6)
})

test('переработка берёт 1,5 руды в секунду и отдаёт металл один к одному', () => {
  const { sim, spot, mine, truck } = base()
  sim.world.destroy(mine)
  sim.world.destroy(truck)
  const refinery = refineryAt(sim, spot)
  const inventory = sim.world.get(refinery, Inventory)!
  inventory.items.metalOre = 40
  seconds(sim, 10)
  const made = metalIn(sim, refinery)
  expect(made).toBeCloseTo((REFINE_RATE * 10) / REFINE_RATIO, 1)
  expect(oreIn(sim, refinery)).toBeCloseTo(40 - made * REFINE_RATIO)
  // Руда не теряется: сколько переработано, столько и стало металла.
  seconds(sim, 20)
  expect(metalIn(sim, refinery)).toBeCloseTo(40 / REFINE_RATIO)
  expect(oreIn(sim, refinery)).toBe(0)
})

test('заводу некуда девать готовое — он стоит и руду не тратит', () => {
  const { sim, spot, mine, truck } = base()
  sim.world.destroy(mine)
  sim.world.destroy(truck)
  const refinery = refineryAt(sim, spot)
  const inventory = sim.world.get(refinery, Inventory)!
  inventory.items.metalOre = 25
  inventory.items.metal = inventory.capacity - 25
  seconds(sim, 10)
  expect(oreIn(sim, refinery)).toBe(25)
  expect(metalIn(sim, refinery)).toBe(inventory.capacity - 25)
})

test('хранилище конечно: когда место кончилось, грузовик везёт остаток в другое; запас — по всем хранилищам', () => {
  const { sim, spot, mine, core, truck } = base()
  const refinery = refineryAt(sim, spot)
  // Руда шахты тут не при чём: у завода уже лежит готовый металл, а в кузове шахты — нет.
  sim.world.destroy(mine)
  const capacity = BUILDINGS.command.inventory
  sim.world.get(core, Inventory)!.items.metal = capacity - 5
  sim.world.get(refinery, Inventory)!.items.metal = TRUCK_CAPACITY
  const hauler = () => sim.world.get(truck, Hauler)!
  const stock = () => amountOf(sim.world.get(core, Inventory)!, 'metal')

  // Грузовик вывозит металл от завода, но в главное здание влезает только пять единиц.
  until(sim, () => hauler().full && stock() >= capacity)
  seconds(sim, 10)
  expect(stock()).toBe(capacity)
  expect(metalIn(sim, truck)).toBeCloseTo(TRUCK_CAPACITY - 5)
  expect(hauler().to).toBe(-1)

  // Новое хранилище принимает остаток.
  const silo = place(sim, 'silo', spot.x + 9, spot.y)
  until(sim, () => !hauler().full)
  expect(amountOf(sim.world.get(silo, Inventory)!, 'metal')).toBeCloseTo(TRUCK_CAPACITY - 5)
  expect(stockOf(sim, 1).capacity).toBe(capacity + BUILDINGS.silo.inventory)
})

test('космопорт продаёт по заявке: диспетчер шлёт свободные грузовики свезти товар из хранилищ, потом приходят кредиты', () => {
  const { sim, spot, mine, core, truck } = base()
  sim.world.get(core, Inventory)!.items.metal = 80
  const silo = placeBuilding(sim.world, 'silo', spot.x + 9, spot.y + 5, 1)
  sim.world.get(silo, Inventory)!.items.metal = 15
  const credits = creditsOf(sim, 1)
  const hauler = () => sim.world.get(truck, Hauler)!
  const stored = () => metalIn(sim, core) + metalIn(sim, silo)
  // Без космопорта металл лежит и денег не приносит.
  seconds(sim, 5)
  expect(creditsOf(sim, 1) - credits).toBeLessThanOrEqual(1)
  expect(canBuild(sim, 1, 'spaceport', spot.x + 9, spot.y)).toBe(true)
  const port = placeBuilding(sim.world, 'spaceport', spot.x + 9, spot.y, 1)
  expect(canSell(sim, 1, port)).toBe(true)
  expect(canSell(sim, 2, port)).toBe(false)

  // Заявка сама по себе товар не приносит: его должны привезти.
  sim.send(2, { type: 'sell', port, resource: 'metal', amount: 50 })
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 50 })
  sim.advance(TICK)
  const order = () => sim.world.get(port, Trade)!
  const delivered = () => deliveredTo(sim, port)
  expect(order().wanted).toBe(50)
  expect(stored()).toBe(95)
  // Пока заявка открыта, вторую космопорт не берёт.
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 10 })
  sim.advance(TICK)
  expect(order().wanted).toBe(50)

  // Космопорт заказал металл, и диспетчер отдал заявку свободному грузовику: тот выкачивает его из хранилища
  // и сгружает в космопорт.
  until(sim, () => hauler().to === port)
  until(sim, () => hauler().loading && metalIn(sim, truck) > 0)
  until(sim, () => delivered() > 0)
  expect(gapBetween(sim, port, truck)).toBeLessThanOrEqual(sim.world.get(truck, Beam)!.radius)
  // Металл нигде не теряется: он в хранилищах, в кузове или в космопорте.
  expect(stored() + metalIn(sim, truck) + delivered()).toBeCloseTo(95)

  // Привезли всё — грузовик свободен, корабль улетел, кредиты приходят после полёта.
  until(sim, () => order().total > 0)
  expect(delivered()).toBeCloseTo(50)
  expect(stored()).toBeCloseTo(45)
  until(sim, () => hauler().to !== port, 5)
  expect(metalIn(sim, truck)).toBe(0)
  const before = creditsOf(sim, 1)
  seconds(sim, SELL_SECONDS - 2)
  expect(creditsOf(sim, 1) - before).toBeLessThan(10)
  expect(sim.world.has(port, Trade)).toBe(true)
  seconds(sim, 2)
  expect(sim.world.has(port, Trade)).toBe(false)
  expect(delivered()).toBe(0)
  const income = BUILDINGS.command.income * SELL_SECONDS
  expect(Math.abs(creditsOf(sim, 1) - before - 50 * RESOURCE_SPECS.metal.price - income)).toBeLessThanOrEqual(1)

  // Грузовик, привязанный к шахте, на зов космопорта не идёт; заявку можно закрыть с тем, что привезли.
  sim.send(1, { type: 'haul', units: [truck], mine })
  seconds(sim, 1)
  const stock = Math.floor(stored())
  sim.send(1, { type: 'sell', port, resource: 'metal', amount: 1000 })
  seconds(sim, 5)
  expect(order().wanted).toBe(stock)
  expect(hauler().to).not.toBe(port)
  expect(delivered()).toBe(0)
  sim.send(1, { type: 'closeSale', port })
  sim.advance(TICK)
  expect(sim.world.has(port, Trade)).toBe(false)
  expect(stored()).toBeGreaterThanOrEqual(45)
})

test('здания можно ставить вплотную к шахте, а выработанное месторождение освобождает грузовик', () => {
  const { sim, spot, mine, truck } = base()
  addCredits(sim, 1, 1000)
  refineryAt(sim, spot)
  // Вплотную к шахте строить можно: место для грузовика под ней не нужно.
  expect(canBuild(sim, 1, 'silo', spot.x, spot.y + 2)).toBe(true)

  sim.send(1, { type: 'haul', units: [truck], mine })
  const hauler = () => sim.world.get(truck, Hauler)!
  until(sim, () => hauler().loading)
  // Даём грузовику набрать груз, потом вырабатываем месторождение.
  seconds(sim, 15)
  for (const [, deposit] of sim.world.query(Deposit)) deposit.mined = spot.reserve - 1
  until(sim, () => reserveLeft(sim, spot.x, spot.y) === 0)
  // Довёз остаток до переработки и освободился.
  until(sim, () => hauler().mine === -1 && oreIn(sim, truck) === 0)
  // Переработанный металл свободный грузовик свозит в хранилище.
  until(sim, () => (stockOf(sim, 1).items.metal ?? 0) > 1)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
})
