import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import type { Entity } from '../src/ecs'
import {
  BUILDINGS, Beam, DEPOSIT_KINDS, Deposit, Hauler, Inventory, RESOURCE_SPECS, SELL_SECONDS, TRUCK_CAPACITY, Trade, amountOf, canBuild, deliveredTo, gapBetween, canSell, isWalkable, stockOf, canPlace, createSim, creditsOf, depositAt, depositIn, depositNear, reserveLeft, rewardsOf,
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
      if (spot && spot.kind === 'ore' && canPlace(sim, 'silo', spot.x + 3, spot.y)) return { sim, spot }
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
      if (!spot || spot.kind !== 'ore' || !canPlace(sim, 'command', spot.x + 5, spot.y)) continue
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

/** Сколько руды на складе сущности. */
const oreIn = (sim: Sim, entity: Entity) => amountOf(sim.world.get(entity, Inventory)!, 'ore')

test('шахта копит добытое у себя; грузовик забирает его лучом шахты и везёт в ближайшее хранилище', () => {
  const { sim, spot, mine, core, truck } = base()
  const hauler = () => sim.world.get(truck, Hauler)!
  const cargo = () => oreIn(sim, truck)
  // Без грузовика шахта добывает в свой склад.
  seconds(sim, 5)
  expect(oreIn(sim, mine)).toBeCloseTo(DEPOSIT_KINDS.ore.rate * 5)
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
  expect(beam.links).toEqual([{ target: mine, pulling: true, resource: 'ore' }])
  until(sim, () => oreIn(sim, mine) < 0.1)
  // Дальше грузится по мере добычи.
  const loaded = cargo()
  seconds(sim, 10)
  expect(cargo()).toBeCloseTo(loaded + DEPOSIT_KINDS.ore.rate * 10, 0)

  // Полный едет к главному зданию и сгружает руду лучом; сама руда кредитов не даёт.
  until(sim, () => hauler().full)
  expect(cargo()).toBe(TRUCK_CAPACITY)
  until(sim, () => oreIn(sim, core) > 0)
  expect(gapBetween(sim, core, truck)).toBeLessThanOrEqual(beam.radius)
  expect(beam.links).toEqual([{ target: core, pulling: false, resource: 'ore' }])
  until(sim, () => !hauler().full)
  expect(oreIn(sim, core)).toBeCloseTo(TRUCK_CAPACITY)
  expect(stockOf(sim, 1)).toEqual({ items: { ore: oreIn(sim, core) }, capacity: BUILDINGS.command.inventory })
  // Разгрузился — вернулся к шахте сам.
  until(sim, () => hauler().loading && cargo() > 0)
  expect(gapBetween(sim, mine, truck)).toBeLessThanOrEqual(beam.radius)

  // Приказ идти снимает грузовик с шахты. Дальше он свободен: накопленное в шахте диспетчер велит ему увезти самому.
  sim.send(1, { type: 'move', units: [truck], x: spot.x - 3, y: spot.y })
  seconds(sim, 1)
  expect(hauler().mine).toBe(-1)
  sim.world.get(mine, Inventory)!.items.ore = BUILDINGS.mine.inventory
  until(sim, () => hauler().from === mine)

  // Сохранение помнит и добытое, и груз, и запас.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(reserveLeft(copy, spot.x, spot.y)).toBe(reserveLeft(sim, spot.x, spot.y))
  expect(oreIn(copy, truck)).toBe(cargo())
  expect(oreIn(copy, core)).toBe(oreIn(sim, core))
  expect(oreIn(copy, mine)).toBe(oreIn(sim, mine))
  expect(copy.world.get(truck, Hauler)).toEqual(hauler())

  // Полная шахта, которую некому вывезти, не добывает.
  sim.world.destroy(truck)
  sim.world.get(mine, Inventory)!.items.ore = BUILDINGS.mine.inventory
  const left = reserveLeft(sim, spot.x, spot.y)
  seconds(sim, 5)
  expect(reserveLeft(sim, spot.x, spot.y)).toBe(left)
})

test('очередей нет: несколько грузовиков выкачивают шахту одновременно', () => {
  const { sim, mine, truck, spot } = base()
  const second = spawnUnit(sim, 'truck', 1, spot.x - 1, spot.y + 1)
  sim.world.get(mine, Inventory)!.items.ore = BUILDINGS.mine.inventory
  sim.send(1, { type: 'haul', units: [truck, second], mine })
  // Руду грузовикам даёт только шахта: прибавилось у обоих в один тик — качали одновременно.
  let both = 0
  for (let i = 0; i < 20 / TICK; i++) {
    const before = [oreIn(sim, truck), oreIn(sim, second)]
    sim.advance(TICK)
    if (oreIn(sim, truck) > before[0] && oreIn(sim, second) > before[1]) both++
  }
  expect(both).toBeGreaterThan(0)
  // В шахте было на два кузова: оба довезли полные до главного здания.
  until(sim, () => (stockOf(sim, 1).items.ore ?? 0) >= 2 * TRUCK_CAPACITY - 1e-6)
})

test('хранилище конечно: когда место кончилось, грузовик везёт остаток в другое; запас — по всем хранилищам', () => {
  const { sim, spot, mine, core, truck } = base()
  const capacity = BUILDINGS.command.inventory
  sim.world.get(core, Inventory)!.items.ore = capacity - 5
  sim.send(1, { type: 'haul', units: [truck], mine })
  const hauler = () => sim.world.get(truck, Hauler)!
  until(sim, () => hauler().full && oreIn(sim, core) >= capacity)
  seconds(sim, 10)
  // Влезло только пять единиц, остальное в кузове: везти некуда, он ждёт.
  expect(oreIn(sim, core)).toBe(capacity)
  expect(oreIn(sim, truck)).toBeCloseTo(TRUCK_CAPACITY - 5)
  expect(hauler().to).toBe(-1)

  // Новое хранилище принимает остаток.
  const silo = placeBuilding(sim.world, 'silo', spot.x + 9, spot.y, 1)
  until(sim, () => !hauler().full)
  expect(oreIn(sim, silo)).toBeCloseTo(TRUCK_CAPACITY - 5)
  expect(stockOf(sim, 1).capacity).toBe(capacity + BUILDINGS.silo.inventory)
})

test('космопорт продаёт по заявке: диспетчер шлёт свободные грузовики свезти товар из хранилищ, потом приходят кредиты', () => {
  const { sim, spot, mine, core, truck } = base()
  sim.world.get(core, Inventory)!.items.ore = 80
  const silo = placeBuilding(sim.world, 'silo', spot.x + 9, spot.y + 5, 1)
  sim.world.get(silo, Inventory)!.items.ore = 15
  const credits = creditsOf(sim, 1)
  const hauler = () => sim.world.get(truck, Hauler)!
  const stored = () => oreIn(sim, core) + oreIn(sim, silo)
  // Без космопорта руда лежит и денег не приносит.
  seconds(sim, 5)
  expect(creditsOf(sim, 1) - credits).toBeLessThanOrEqual(1)
  expect(canBuild(sim, 1, 'spaceport', spot.x + 9, spot.y)).toBe(true)
  const port = placeBuilding(sim.world, 'spaceport', spot.x + 9, spot.y, 1)
  expect(canSell(sim, 1, port)).toBe(true)
  expect(canSell(sim, 2, port)).toBe(false)

  // Заявка руду не забирает: её должны привезти.
  sim.send(2, { type: 'sell', port, resource: 'ore', amount: 50 })
  sim.send(1, { type: 'sell', port, resource: 'ore', amount: 50 })
  sim.advance(TICK)
  const order = () => sim.world.get(port, Trade)!
  const delivered = () => deliveredTo(sim, port)
  expect(order().wanted).toBe(50)
  expect(stored()).toBe(95)
  // Пока заявка открыта, вторую космопорт не берёт.
  sim.send(1, { type: 'sell', port, resource: 'ore', amount: 10 })
  sim.advance(TICK)
  expect(order().wanted).toBe(50)

  // Космопорт заказал руду, и диспетчер отдал заявку свободному грузовику: тот выкачивает её из хранилища
  // и сгружает в космопорт.
  until(sim, () => hauler().to === port)
  until(sim, () => hauler().loading && oreIn(sim, truck) > 0)
  until(sim, () => delivered() > 0)
  expect(gapBetween(sim, port, truck)).toBeLessThanOrEqual(sim.world.get(truck, Beam)!.radius)
  // Руда нигде не теряется: она в хранилищах, в кузове или в космопорте.
  expect(stored() + oreIn(sim, truck) + delivered()).toBeCloseTo(95)

  // Привезли всё — грузовик свободен, корабль улетел, кредиты приходят после полёта.
  until(sim, () => order().total > 0)
  expect(delivered()).toBeCloseTo(50)
  expect(stored()).toBeCloseTo(45)
  until(sim, () => hauler().to !== port, 5)
  expect(oreIn(sim, truck)).toBe(0)
  const before = creditsOf(sim, 1)
  seconds(sim, SELL_SECONDS - 2)
  expect(creditsOf(sim, 1) - before).toBeLessThan(10)
  expect(sim.world.has(port, Trade)).toBe(true)
  seconds(sim, 2)
  expect(sim.world.has(port, Trade)).toBe(false)
  expect(delivered()).toBe(0)
  const income = BUILDINGS.command.income * SELL_SECONDS
  expect(Math.abs(creditsOf(sim, 1) - before - 50 * RESOURCE_SPECS.ore.price - income)).toBeLessThanOrEqual(1)

  // Грузовик, привязанный к шахте, на зов космопорта не идёт; заявку можно закрыть с тем, что привезли.
  sim.send(1, { type: 'haul', units: [truck], mine })
  seconds(sim, 1)
  const stock = Math.floor(stored())
  sim.send(1, { type: 'sell', port, resource: 'ore', amount: 1000 })
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
  // Вплотную к шахте строить можно: место для грузовика под ней не нужно.
  expect(canBuild(sim, 1, 'silo', spot.x, spot.y + 2)).toBe(true)

  sim.send(1, { type: 'haul', units: [truck], mine })
  const hauler = () => sim.world.get(truck, Hauler)!
  until(sim, () => hauler().loading)
  for (const [, deposit] of sim.world.query(Deposit)) deposit.mined = spot.reserve - 1
  until(sim, () => reserveLeft(sim, spot.x, spot.y) === 0)
  // Довёз остаток и освободился.
  until(sim, () => hauler().mine === -1)
  expect(oreIn(sim, truck)).toBe(0)
  expect((stockOf(sim, 1).items.ore ?? 0)).toBeGreaterThan(1)
  expect(canBuild(sim, 1, 'mine', spot.x, spot.y)).toBe(false)
})
