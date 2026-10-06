import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Armed, Blast, Building, Builds, Carrier, activeRepairs, Health, Inventory, INFANTRY_REGEN, isFighter, Repair, wrap, Turret, Owner, Path, Position, Producer, Shot, UNITS, Unit, WEAPONS, buildingHp, canAttack, canPlace, createSim, driveBattle, isWalkable, powerStates, producibleBy, randomArmy, spawnBattle, zoneEconomies, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { REPAIR_PAUSE } from '../src/sim/construction'
import { addCredits } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Симуляция и левый верхний тайл ровного проходимого поля width×height. */
function field(width = 24, height = 7) {
  const sim = createSim(options)
  for (let y = -40; y < 40; y++) {
    search: for (let x = -40; x < 40; x++) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) if (!isWalkable(sim, x + dx, y + dy)) continue search
      }
      return { sim, x, y: y + Math.floor(height / 2) }
    }
  }
  throw new Error('В мире не нашлось ровного поля')
}

/** Крутит симуляцию, пока в воздухе не появится выстрел. */
function untilShot(sim: Sim) {
  for (let i = 0; i < 100 && !sim.world.count(Shot); i++) sim.advance(TICK)
  expect(sim.world.count(Shot)).toBeGreaterThan(0)
}

const health = (sim: Sim, entity: Entity) => sim.world.get(entity, Health)?.value
const alive = (sim: Sim, entity: Entity) => sim.world.alive(entity)
/** Цель первой турели юнита: у танка — башни. */
const gunTarget = (sim: Sim, entity: Entity) => sim.world.get(sim.world.get(entity, Carrier)!.turrets[0] as Entity, Armed)!.target

test('пехотинцы сами стреляют во врага в пределах выстрела: пули летят, цель гибнет и взрывается', () => {
  const { sim, x, y } = field()
  const mine = spawnUnit(sim, 'infantry', 1, x, y)
  const foe = spawnUnit(sim, 'builder', 2, x + 3, y)
  untilShot(sim)
  expect(sim.world.get(mine, Armed)!.target).toBe(foe)
  seconds(sim, 1)
  expect(health(sim, foe)!).toBeLessThan(1)
  // Стрелок повернулся к цели и с места не сошёл.
  expect(Math.abs(sim.world.get(mine, Unit)!.facing)).toBeLessThan(0.2)
  expect(sim.world.get(mine, Position)).toEqual({ x: x + 0.5, y: y + 0.5 })

  seconds(sim, 40)
  expect(alive(sim, foe)).toBe(false)
  expect(sim.world.get(mine, Armed)!.target).toBe(-1)
  // Снаряды и взрывы не копятся.
  seconds(sim, 2)
  expect(sim.world.count(Shot)).toBe(0)
  expect(sim.world.count(Blast)).toBe(0)
})

test('до врага вне дальности юнит сам не идёт; своих и ничьих не трогает', () => {
  const { sim, x, y } = field()
  const mine = spawnUnit(sim, 'infantry', 1, x, y)
  const far = spawnUnit(sim, 'builder', 2, x + 8, y)
  const friend = spawnUnit(sim, 'builder', 1, x + 2, y)
  const nobody = spawnUnit(sim, 'builder', 0, x + 2, y + 2)
  seconds(sim, 3)
  expect(sim.world.get(mine, Armed)!.target).toBe(-1)
  expect(sim.world.has(mine, Path)).toBe(false)
  for (const entity of [far, friend, nobody]) expect(health(sim, entity)).toBe(1)
  expect(canAttack(sim, 1, far)).toBe(true)
  expect(canAttack(sim, 1, friend)).toBe(false)
  expect(canAttack(sim, 1, nobody)).toBe(false)
})

test('по приказу юнит гонится за целью и бьёт её; приказ идти снимает цель', () => {
  const { sim, x, y } = field()
  const mine = spawnUnit(sim, 'infantry', 1, x, y)
  const foe = spawnUnit(sim, 'truck', 2, x + 12, y)
  sim.send(1, { type: 'attack', units: [mine, foe], target: foe })
  seconds(sim, 1)
  expect(sim.world.has(mine, Path)).toBe(true)
  expect(sim.world.get(mine, Armed)).toMatchObject({ target: foe, chase: true })
  seconds(sim, 5)
  // Подошёл на выстрел и встал.
  expect(sim.world.has(mine, Path)).toBe(false)
  expect(health(sim, foe)!).toBeLessThan(1)

  sim.send(1, { type: 'move', units: [mine], x, y })
  seconds(sim, 1)
  expect(sim.world.get(mine, Armed)).toMatchObject({ target: -1, chase: false })
  const left = health(sim, foe)
  seconds(sim, 6)
  expect(health(sim, foe)).toBe(left)

  // Своих и чужими юнитами атаковать нельзя.
  const friend = spawnUnit(sim, 'builder', 1, x + 1, y + 2)
  sim.send(1, { type: 'attack', units: [mine], target: friend })
  sim.send(2, { type: 'attack', units: [mine], target: friend })
  seconds(sim, 3)
  expect(health(sim, friend)).toBe(1)
})

test('попавший под огонь издалека отвечает: идёт к стрелку', () => {
  const { sim, x, y } = field()
  const tank = spawnUnit(sim, 'tank', 1, x, y)
  const foe = spawnUnit(sim, 'infantry', 2, x + 7, y)
  expect(WEAPONS.cannon.range).toBeGreaterThan(WEAPONS.rifle.range + 2)
  seconds(sim, 2.5)
  expect(health(sim, foe)!).toBeLessThan(1)
  expect(sim.world.get(foe, Armed)).toMatchObject({ target: tank, chase: true })
  expect(sim.world.get(foe, Position)!.x).toBeLessThan(x + 7)
})

test('ядро бьёт по площади и падает туда, где цель была при выстреле', () => {
  const { sim, x, y } = field()
  spawnUnit(sim, 'tank', 1, x, y)
  const target = spawnUnit(sim, 'truck', 2, x + 5, y)
  const near = spawnUnit(sim, 'truck', 2, x + 5, y + 1)
  const far = spawnUnit(sim, 'truck', 2, x + 5, y + 3)
  // Ядро летит не мгновенно: пока оно в воздухе, урона нет.
  untilShot(sim)
  seconds(sim, 0.2)
  expect(sim.world.count(Shot)).toBe(1)
  expect(health(sim, target)).toBe(1)
  let blasted = false
  for (let i = 0; i < 20; i++) {
    sim.advance(TICK)
    blasted ||= sim.world.count(Blast) > 0
  }
  expect(health(sim, target)!).toBeLessThan(1)
  expect(health(sim, near)!).toBeLessThan(1)
  expect(health(sim, near)!).toBeGreaterThan(health(sim, target)!)
  expect(health(sim, far)).toBe(1)
  expect(blasted).toBe(true)
})

test('танк наводит башню, а не корпус, стреляет на ходу, а без цели ровняет башню по корпусу', () => {
  const { sim, x, y } = field()
  const tank = spawnUnit(sim, 'tank', 1, x + 5, y)
  const [tower] = sim.world.get(tank, Carrier)!.turrets as Entity[]
  // Враг сбоку: поворачивается башня, корпус смотрит, куда смотрел.
  const facing = sim.world.get(tank, Unit)!.facing
  const foe = spawnUnit(sim, 'truck', 2, x + 10, y)
  untilShot(sim)
  expect(Math.abs(facing)).toBeGreaterThan(1)
  expect(sim.world.get(tank, Unit)!.facing).toBe(facing)
  // Поворот башни — относительно корпуса: она смотрит вправо, корпус — вниз.
  expect(Math.abs(wrap(sim.world.get(tower, Turret)!.angle + facing))).toBeLessThan(0.13)
  expect(sim.world.get(tower, Armed)!.target).toBe(foe)

  // Едет по приказу — и стреляет на ходу, не останавливаясь.
  while (sim.world.get(tower, Armed)!.cooldown > 3) sim.advance(TICK)
  // Корпус разворачивается в дорогу и уводит башню с собой: ей нужно время, чтобы навестись снова.
  sim.send(1, { type: 'move', units: [tank], x, y })
  let fired = false
  for (let i = 0; i < 60 && !fired; i++) {
    const before = sim.world.count(Shot)
    sim.advance(TICK)
    fired ||= sim.world.has(tank, Path) && sim.world.count(Shot) > before
  }
  expect(fired).toBe(true)

  // Цели нет — башня поворачивается туда же, куда корпус.
  sim.world.destroy(foe)
  seconds(sim, 4)
  expect(sim.world.get(tower, Armed)!.target).toBe(-1)
  expect(sim.world.get(tower, Turret)!.angle).toBe(0)
})

test('турели носителя, попавшего под огонь издалека, отвечают: носитель едет к стрелку', () => {
  const { sim, x, y } = field()
  expect(WEAPONS.cannon.range).toBeGreaterThan(WEAPONS.launcher.range)
  const carrier = spawnUnit(sim, 'carrier', 1, x, y)
  const tank = spawnUnit(sim, 'tank', 2, x + 7, y)
  // Пушка до носителя достаёт, а ракеты до танка — нет.
  sim.world.get(tank, Position)!.x = sim.world.get(tank, Unit)!.prevX = x + 8.1
  for (let i = 0; i < 200 && health(sim, carrier) === 1; i++) sim.advance(TICK)
  sim.advance(TICK)
  const turrets = sim.world.get(carrier, Carrier)!.turrets as Entity[]
  const rockets = turrets.filter((turret) => sim.world.has(turret, Armed))
  for (const turret of rockets) expect(sim.world.get(turret, Armed)).toMatchObject({ target: tank, chase: true })
  seconds(sim, 1)
  expect(sim.world.get(carrier, Position)!.x).toBeGreaterThan(x + 0.5)
})

test('разряд перескакивает на соседей, слабея', () => {
  const { sim, x, y } = field()
  const tesla = spawnUnit(sim, 'tesla', 1, x, y)
  const facing = sim.world.get(tesla, Unit)!.facing
  const foes = [3, 5, 7, 9].map((dx) => spawnUnit(sim, 'truck', 2, x + dx, y))
  seconds(sim, 1.5)
  // Наводится катушка-турель, а не корпус.
  expect(sim.world.get(tesla, Unit)!.facing).toBe(facing)
  const [first, second, third, fourth] = foes.map((entity) => 1 - health(sim, entity)!)
  expect(first).toBeGreaterThan(second)
  expect(second).toBeGreaterThan(third)
  expect(third).toBeGreaterThan(0)
  // Прыжков всего два.
  expect(fourth).toBe(0)
})

test('лазер попадает сразу, оставляя след', () => {
  const { sim, x, y } = field()
  spawnUnit(sim, 'lancer', 1, x, y)
  const foe = spawnUnit(sim, 'truck', 2, x + 4, y)
  let traced = false
  for (let i = 0; i < 40 && health(sim, foe) === 1; i++) sim.advance(TICK)
  for (const [, shot] of sim.world.query(Shot)) traced ||= shot.weapon === 'laser' && shot.toX === x + 4.5
  expect(health(sim, foe)!).toBeLessThan(1)
  expect(traced).toBe(true)
})

test('летающие летят по прямой над зданиями, а пушка и разряд до них не достают', () => {
  const { sim, x, y } = field()
  const drone = spawnUnit(sim, 'drone', 1, x, y)
  // Стена из зданий поперёк пути, если здесь есть скала; летающему всё равно.
  for (let dy = -3; dy <= 3; dy += 2) if (canPlace(sim, 'generator', x + 5, y + dy)) placeBuilding(sim.world, 'generator', x + 5, y + dy, 0)
  sim.send(1, { type: 'move', units: [drone], x: x + 12, y })
  sim.advance(TICK)
  expect(sim.world.get(drone, Path)!.points).toEqual([x + 12.5, y + 0.5])
  seconds(sim, 3)
  expect(sim.world.get(drone, Position)).toEqual({ x: x + 12.5, y: y + 0.5 })

  const tank = spawnUnit(sim, 'tank', 2, x + 15, y)
  const tesla = spawnUnit(sim, 'tesla', 2, x + 15, y + 2)
  seconds(sim, 5)
  expect(health(sim, drone)).toBe(1)
  expect(gunTarget(sim, tank)).toBe(-1)
  // А дрон по ним стреляет.
  expect(health(sim, tank)! < 1 || health(sim, tesla)! < 1).toBe(true)
  sim.send(2, { type: 'attack', units: [tank, tesla], target: drone })
  seconds(sim, 1)
  expect(gunTarget(sim, tank)).toBe(-1)

  // Ракетчик достаёт.
  spawnUnit(sim, 'rocketeer', 2, x + 12, y + 3)
  seconds(sim, 12)
  expect(alive(sim, drone)).toBe(false)
})

test('летающие не занимают землю: наземный проходит под ними', () => {
  const { sim, x, y } = field()
  spawnUnit(sim, 'gunship', 1, x + 3, y)
  const walker = spawnUnit(sim, 'infantry', 1, x, y)
  sim.send(1, { type: 'move', units: [walker], x: x + 3, y })
  seconds(sim, 3)
  expect(sim.world.get(walker, Position)).toEqual({ x: x + 3.5, y: y + 0.5 })
})

test('здания разрушаются: прочность считается от цены, занятые тайлы освобождаются', () => {
  const { sim, x, y } = field()
  const tank = spawnUnit(sim, 'tank', 1, x, y)
  const spot = { x: x + 4, y: y - 1 }
  const building = placeBuilding(sim.world, 'generator', spot.x, spot.y, 2)
  expect(buildingHp('generator')).toBe(600)
  expect(sim.occupancy.at(spot.x, spot.y)).toBe(building)
  seconds(sim, 4)
  expect(gunTarget(sim, tank)).toBe(building)
  const left = sim.world.get(building, Health)!.value
  expect(left).toBeLessThan(1)
  expect(left).toBeGreaterThan(0.5)
  seconds(sim, 40)
  expect(alive(sim, building)).toBe(false)
  expect(sim.occupancy.at(spot.x, spot.y)).toBeUndefined()
})

test('бой переживает сохранение', () => {
  const { sim, x, y } = field()
  spawnUnit(sim, 'tank', 1, x, y)
  const foe = spawnUnit(sim, 'tank', 2, x + 6, y)
  untilShot(sim)
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  seconds(copy, 3)
  expect(copy.world.get(foe, Health)!.value).toBeLessThan(1)
  expect(UNITS.tank.hp).toBeGreaterThan(WEAPONS.cannon.damage * 2)
})

test('пехоту выпускают казармы, технику — машинный завод, летающих — аэродром, космопорт только торгует; всем им нужна энергия', () => {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  const layout = [['command', 0], ['barracks', 4], ['factory', 7], ['airfield', 10], ['generator', 15], ['generator', 18], ['spaceport', 21]] as const
  let spot: { x: number; y: number } | undefined
  for (let y = -80; y < 80 && !spot; y++) {
    for (let x = -80; x < 80 && !spot; x++) if (layout.every(([type, dx]) => canPlace(sim, type, x + dx, y))) spot = { x, y }
  }
  const [, barracks, factory, port, plant, spare, trader] = layout.map(([type, dx]) => placeBuilding(sim.world, type, spot!.x + dx, spot!.y, 1))
  expect(producibleBy(sim, barracks)).toEqual(['infantry', 'rocketeer', 'flamer'])
  expect(producibleBy(sim, factory)).toEqual(['buggy', 'flak', 'lancer', 'tank', 'artillery', 'tesla', 'carrier', 'mcv'])
  expect(producibleBy(sim, port)).toEqual(['drone', 'gunship', 'bomber'])
  expect(producibleBy(sim, trader)).toEqual([])
  // Потребляют 2 + 5 + 4 + 5 из 20.
  expect(zoneEconomies(sim, 1)[0]).toMatchObject({ produced: 20, demand: 16 })
  // Материалы на заказы уже на месте: подвоз проверяется в economy.test.ts.
  sim.world.get(factory, Inventory)!.items = { ...UNITS.buggy.materials }
  sim.world.get(port, Inventory)!.items = { ...UNITS.drone.materials }

  sim.send(1, { type: 'produce', producer: barracks, unit: 'buggy' })
  sim.send(1, { type: 'produce', producer: barracks, unit: 'rocketeer' })
  sim.send(1, { type: 'produce', producer: factory, unit: 'buggy' })
  sim.send(1, { type: 'produce', producer: port, unit: 'drone' })
  sim.send(2, { type: 'produce', producer: port, unit: 'gunship' })
  sim.advance(TICK)
  expect(sim.world.get(barracks, Producer)!.queue).toEqual(['rocketeer'])
  expect(sim.world.get(factory, Producer)!.queue).toEqual(['buggy'])
  expect(sim.world.get(port, Producer)!.queue).toEqual(['drone'])
  seconds(sim, UNITS.buggy.buildTime + 1)
  const made: string[] = []
  for (const [, unit] of sim.world.query(Unit)) made.push(unit.type)
  expect(made.sort()).toEqual(['buggy', 'drone', 'rocketeer'])

  // Энергии не хватает: 10 из 16 — производство идёт на 5/8 скорости, над зданием значок нехватки.
  sim.world.destroy(spare)
  sim.send(1, { type: 'produce', producer: barracks, unit: 'infantry' })
  seconds(sim, UNITS.infantry.buildTime + 0.1)
  expect(powerStates(sim).get(barracks)).toBe('starved')
  expect(sim.world.get(barracks, Producer)!.queue).toEqual(['infantry'])
  seconds(sim, UNITS.infantry.buildTime * 0.6 + 0.1)
  expect(sim.world.get(barracks, Producer)!.queue).toEqual([])

  // Без энергии совсем производство стоит.
  sim.world.destroy(plant)
  sim.send(1, { type: 'produce', producer: barracks, unit: 'infantry' })
  seconds(sim, 10)
  expect(sim.world.get(barracks, Producer)).toMatchObject({ queue: ['infantry'], progress: 0 })

  // Здание под разбором не производит.
  sim.send(1, { type: 'demolish', building: factory, builders: [] })
  sim.send(1, { type: 'produce', producer: factory, unit: 'buggy' })
  sim.advance(TICK)
  sim.advance(TICK)
  expect(producibleBy(sim, factory)).toEqual([])
  expect(sim.world.get(factory, Producer)!.queue).toEqual([])
})

test('показательный бой: армии сходятся сами, и бой кончается', () => {
  const sim = createSim(options)
  const army = randomArmy(3500, {}, () => 0.37)
  // Нулевой вес убирает тип из армии, а когда запрещены все — типы снова равноправны.
  const tanks = randomArmy(3500, { infantry: 0, rocketeer: 0, flamer: 0, buggy: 0, flak: 0, lancer: 0, artillery: 0, tesla: 0, carrier: 0, drone: 0, gunship: 0, bomber: 0 })
  expect(tanks).toEqual(Array(5).fill('tank'))
  expect(randomArmy(3500, { infantry: 0, rocketeer: 0, flamer: 0, buggy: 0, flak: 0, lancer: 0, tank: 0, tesla: 0, drone: 0, gunship: 0 }).length).toBeGreaterThan(0)
  expect(army.reduce((sum, type) => sum + UNITS[type].cost, 0)).toBeGreaterThan(3500 - 60)
  expect(army.every(isFighter)).toBe(true)
  spawnBattle(sim, 1, 0, 0)
  const sides = () => {
    const players = new Set<number>()
    for (const [, , owner] of sim.world.query(Unit, Owner)) players.add(owner.player)
    return players.size
  }
  expect(sides()).toBe(2)
  let time = 0
  while (driveBattle(sim, 1) && time < 600) {
    seconds(sim, 0.5)
    time += 0.5
  }
  expect(time).toBeLessThan(600)
  expect(sides()).toBeLessThan(2)
})

test('показательный бой не перебивает приказ идти, ни стрелку, ни носителю турелей', () => {
  const { sim, x, y } = field()
  const units = (['infantry', 'lancer', 'buggy'] as const).map((type, i) => spawnUnit(sim, type, 1, x + 8, y - 2 + i * 2))
  spawnUnit(sim, 'infantry', 2, x + 12, y)
  spawnUnit(sim, 'infantry', 2, x + 13, y + 1)
  seconds(sim, 1)
  sim.send(1, { type: 'move', units, x, y })
  sim.advance(TICK)
  for (let i = 0; i < 8; i++) {
    driveBattle(sim, 1)
    seconds(sim, 0.25)
  }
  for (const entity of units) expect(sim.world.get(entity, Position)!.x).toBeLessThan(x + 6.5)
})

test('показательный бой: большая армия строится целиком, стороны не перемешаны, и тик остаётся коротким', () => {
  const sim = createSim(options)
  const army = randomArmy(60000, {}, () => 0.37)
  spawnBattle(sim, 1, 0, 0, army, army)
  let own = 0
  let foe = 0
  for (const [, position, , owner] of sim.world.query(Position, Unit, Owner)) {
    if (owner.player === 1) {
      own++
      expect(position.x).toBeLessThan(0)
    } else {
      foe++
      expect(position.x).toBeGreaterThan(0)
    }
  }
  expect(own).toBe(army.length)
  expect(foe).toBe(army.length)
  // Десять секунд боя: сотни юнитов ищут путь разом, и ни один тик не должен превращаться в заметную запинку.
  let worst = 0
  for (let tick = 0; tick < 200; tick++) {
    if (tick % 10 === 0) driveBattle(sim, 1)
    const from = performance.now()
    sim.advance(sim.time.step)
    worst = Math.max(worst, performance.now() - from)
  }
  expect(worst).toBeLessThan(100)
})

test('гонящийся идёт на выстрел от цели, а не в неё саму', () => {
  const sim = createSim(options)
  const tank = spawnUnit(sim, 'tank', 1, 0, 0)
  const target = spawnUnit(sim, 'tank', 2, 30, 0)
  sim.send(1, { type: 'attack', units: [tank], target })
  seconds(sim, 1)
  const path = sim.world.get(tank, Path)!
  expect(path.near).toBeGreaterThan(0)
  // Путь кончается не ближе дальности выстрела с запасом, но в пределах выстрела.
  const reach = Math.hypot(path.points[path.points.length - 2] - 30.5, path.points[path.points.length - 1] - 0.5)
  expect(reach).toBeLessThanOrEqual(WEAPONS.cannon.range)
  expect(reach).toBeGreaterThan(2)
})

test('строитель чинит повреждённую технику — по приказу и сам; пехоту не чинит, она поправляется сама', () => {
  const { sim, x, y } = field()
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 2, y)
  const tank = spawnUnit(sim, 'tank', 1, x + 8, y)
  const soldier = spawnUnit(sim, 'infantry', 1, x + 4, y + 2)
  const value = (entity: Entity) => sim.world.get(entity, Health)!.value

  // Целый юнит работой не считается, раненый пехотинец — тоже.
  sim.world.get(soldier, Health)!.value = 0.5
  sim.send(1, { type: 'assist', units: [builder], site: tank })
  sim.send(1, { type: 'assist', units: [builder], site: soldier })
  seconds(sim, 2)
  expect(sim.world.has(builder, Builds)).toBe(false)
  expect(sim.world.has(builder, Path)).toBe(false)
  expect(value(soldier)).toBeCloseTo(0.5 + INFANTRY_REGEN * 2)

  // Повреждённый танк свободный строитель находит сам, подъезжает и чинит; починка стоит денег.
  sim.world.get(tank, Health)!.value = 0.5
  seconds(sim, 1.5)
  expect(sim.world.get(builder, Builds)?.site).toBe(tank)
  seconds(sim, 30)
  expect(value(tank)).toBe(1)
  expect(sim.world.has(builder, Builds)).toBe(false)
  const from = sim.world.get(builder, Position)!
  const to = sim.world.get(tank, Position)!
  // Вплотную строитель не подъезжает: ему достаточно дотянуться.
  expect(Math.hypot(from.x - to.x, from.y - to.y)).toBeGreaterThan(3)
  expect(Math.hypot(from.x - to.x, from.y - to.y)).toBeLessThanOrEqual(UNITS.builder.repair + UNITS.tank.radius)

  // Сам себя строитель не чинит, не своего — тоже.
  sim.world.get(builder, Health)!.value = 0.5
  const { x: nearX, y: nearY } = sim.world.get(builder, Position)!
  const foe = spawnUnit(sim, 'builder', 0, Math.floor(nearX) + 1, Math.floor(nearY))
  sim.world.get(foe, Health)!.value = 0.5
  seconds(sim, 3)
  expect(value(builder)).toBe(0.5)
  expect(value(foe)).toBe(0.5)
  seconds(sim, 30)
  expect(value(soldier)).toBe(1)
})

test('всё, у чего есть Repair, чинит своих в радиусе — по одному, ближнего первым; не дотягивается — не чинит', () => {
  const { sim, x, y } = field()
  addCredits(sim, 1, 5000)
  // Ремонтная станция: здание, которому выдан Repair. Здание смотрит во все стороны.
  const station = placeBuilding(sim.world, 'turret', x + 6, y, 1)
  sim.world.add(station, Repair({ radius: 3 }))
  const near = spawnUnit(sim, 'tank', 1, x + 4, y)
  const other = spawnUnit(sim, 'buggy', 1, x + 8, y + 1)
  const far = spawnUnit(sim, 'tank', 1, x + 14, y)
  for (const entity of [near, other, far]) sim.world.get(entity, Health)!.value = 0.5
  const value = (entity: Entity) => sim.world.get(entity, Health)!.value
  seconds(sim, 1)
  expect(value(near)).toBeGreaterThan(0.5)
  expect(value(other)).toBe(0.5)
  seconds(sim, 15)
  expect(value(near)).toBe(1)
  expect(value(other)).toBeGreaterThan(0.5)
  expect(value(far)).toBe(0.5)
})

test('строитель чинит, только повернувшись к цели', () => {
  const { sim, x, y } = field()
  addCredits(sim, 1, 1000)
  const builder = spawnUnit(sim, 'builder', 1, x + 2, y)
  const tank = spawnUnit(sim, 'tank', 1, x + 5, y)
  // Смотрит в обратную сторону.
  sim.world.get(builder, Unit)!.facing = Math.PI
  sim.world.get(tank, Health)!.value = 0.5
  sim.advance(TICK)
  expect(sim.world.get(tank, Health)!.value).toBe(0.5)
  seconds(sim, 1)
  expect(Math.abs(sim.world.get(builder, Unit)!.facing)).toBeLessThan(0.2)
  expect(sim.world.get(tank, Health)!.value).toBeGreaterThan(0.5)
})

test('носитель везёт турели: они едут с ним, ракетные бьют врага и на ходу, ремонтная чинит соседей, но не его', () => {
  const { sim, x, y } = field()
  addCredits(sim, 1, 5000)
  const carrier = spawnUnit(sim, 'carrier', 1, x + 2, y)
  const turrets = sim.world.get(carrier, Carrier)!.turrets as Entity[]
  expect(turrets.map((turret) => sim.world.get(turret, Turret)!.type)).toEqual(['rocket', 'rocket', 'rocket', 'repair'])
  // Турели — не юниты: их не выделить и не подстрелить, у них нет своей прочности.
  for (const turret of turrets) expect(sim.world.has(turret, Unit) || sim.world.has(turret, Health)).toBe(false)

  // Едут вместе с носителем.
  sim.send(1, { type: 'move', units: [carrier], x: x + 10, y })
  seconds(sim, 1.5)
  const at = sim.world.get(carrier, Position)!
  for (const turret of turrets) {
    const position = sim.world.get(turret, Position)!
    expect(Math.hypot(position.x - at.x, position.y - at.y)).toBeLessThan(0.5)
  }

  // Ракетные турели сами бьют врага в пределах выстрела, даже пока носитель едет; урон считается за носителем.
  const foe = spawnUnit(sim, 'tank', 2, x + 14, y + 2)
  seconds(sim, 3)
  expect(sim.world.get(foe, Health)!.value).toBeLessThan(1)
  expect(sim.world.get(turrets[0], Armed)!.target).toBe(foe)

  // Ремонтная чинит свой юнит рядом, а свой носитель — нет.
  sim.world.destroy(foe)
  const tank = spawnUnit(sim, 'tank', 1, Math.floor(at.x) + 3, Math.floor(at.y) - 2)
  sim.world.get(tank, Health)!.value = 0.5
  sim.world.get(carrier, Health)!.value = 0.5
  seconds(sim, 3)
  expect(sim.world.get(tank, Health)!.value).toBeGreaterThan(0.5)
  expect(sim.world.get(carrier, Health)!.value).toBe(0.5)

  // Переживает сохранение, а с гибелью носителя турели исчезают.
  const copy = createSim(JSON.parse(JSON.stringify(sim.save())))
  expect(copy.world.get(carrier, Carrier)!.turrets).toEqual(turrets)
  copy.world.destroy(carrier)
  copy.advance(TICK)
  for (const turret of turrets) expect(copy.world.alive(turret)).toBe(false)
})

test('приказ атаковать носителю: он подъезжает на выстрел турелей, и они бьют цель', () => {
  const { sim, x, y } = field()
  const carrier = spawnUnit(sim, 'carrier', 1, x + 1, y)
  const foe = spawnUnit(sim, 'tesla', 2, x + 18, y)
  sim.send(1, { type: 'attack', units: [carrier], target: foe })
  seconds(sim, 1)
  expect(sim.world.has(carrier, Path)).toBe(true)
  seconds(sim, 8)
  expect(sim.world.get(foe, Health)?.value ?? 0).toBeLessThan(1)
  const from = sim.world.get(carrier, Position)!
  expect(Math.hypot(from.x - (x + 18.5), from.y - (y + 0.5))).toBeLessThan(WEAPONS.launcher.range + 1)
})

test('скорость и цена ремонта берутся из правил симуляции и меняются на ходу', () => {
  const repaired = (repairSpeed: number) => {
    const { sim, x, y } = field()
    addCredits(sim, 1, 5000)
    const station = placeBuilding(sim.world, 'turret', x + 6, y, 1)
    sim.world.add(station, Repair({ radius: 3 }))
    const tank = spawnUnit(sim, 'tank', 1, x + 4, y)
    sim.world.get(tank, Health)!.value = 0.2
    sim.rules.repairSpeed = repairSpeed
    seconds(sim, 2)
    return sim.world.get(tank, Health)!.value - 0.2
  }
  expect(repaired(4)).toBeCloseTo(repaired(2) * 2, 2)
  expect(repaired(0)).toBe(0)

  const sim = createSim({ ...options, rules: { repairCost: 1 } })
  expect(sim.rules).toMatchObject({ repairSpeed: 2, repairCost: 1, repairPause: 3 })
  expect(createSim(JSON.parse(JSON.stringify(sim.save()))).rules.repairCost).toBe(1)
})

test('под огнём не чинят: три секунды после попадания работа стоит', () => {
  const { sim, x, y } = field()
  addCredits(sim, 1, 5000)
  const station = placeBuilding(sim.world, 'turret', x + 6, y, 1)
  sim.world.add(station, Repair({ radius: 3 }))
  const tank = spawnUnit(sim, 'tank', 1, x + 4, y)
  const health = () => sim.world.get(tank, Health)!.value

  // Попадание отмечает тик: ремонтник рядом, но пока не работает.
  sim.world.get(tank, Health)!.value = 0.2
  sim.world.get(tank, Health)!.hit = sim.time.tick
  seconds(sim, REPAIR_PAUSE - 0.5)
  expect(health()).toBe(0.2)

  // Пауза вышла — чинят как обычно.
  seconds(sim, 1)
  expect(health()).toBeGreaterThan(0.2)

  // Правило нулевое — чинят и под огнём.
  sim.rules.repairPause = 0
  sim.world.get(tank, Health)!.value = 0.2
  sim.world.get(tank, Health)!.hit = sim.time.tick
  seconds(sim, 1)
  expect(health()).toBeGreaterThan(0.2)
})

test('бесплатная починка идёт и без кредитов', () => {
  const { sim, x, y } = field()
  const builder = spawnUnit(sim, 'builder', 1, x + 2, y)
  const tank = spawnUnit(sim, 'tank', 1, x + 5, y)
  sim.world.get(tank, Health)!.value = 0.5
  sim.rules.repairCost = 0
  seconds(sim, 2)
  expect(sim.world.get(tank, Health)!.value).toBeGreaterThan(0.5)
  expect(activeRepairs(sim).map((link) => link.from)).toEqual([builder])
})
