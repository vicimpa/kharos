import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Armed, Blast, Building, Path, Position, Producer, Shot, UNITS, Unit, WEAPONS, buildingHp, canAttack, canPlace, createSim, isWalkable, powerStates, producibleBy, zoneEconomies, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
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

const health = (sim: Sim, entity: Entity) => sim.world.get(entity, Unit)?.health
const alive = (sim: Sim, entity: Entity) => sim.world.alive(entity)

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

test('разряд перескакивает на соседей, слабея', () => {
  const { sim, x, y } = field()
  spawnUnit(sim, 'tesla', 1, x, y)
  const foes = [3, 5, 7, 9].map((dx) => spawnUnit(sim, 'truck', 2, x + dx, y))
  seconds(sim, 1.5)
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
  expect(sim.world.get(tank, Armed)!.target).toBe(-1)
  // А дрон по ним стреляет.
  expect(health(sim, tank)! < 1 || health(sim, tesla)! < 1).toBe(true)
  sim.send(2, { type: 'attack', units: [tank, tesla], target: drone })
  seconds(sim, 1)
  expect(sim.world.get(tank, Armed)!.target).toBe(-1)

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
  expect(sim.world.get(tank, Armed)!.target).toBe(building)
  const left = sim.world.get(building, Building)!.health
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
  expect(copy.world.get(foe, Unit)!.health).toBeLessThan(1)
  expect(UNITS.tank.hp).toBeGreaterThan(WEAPONS.cannon.damage * 2)
})

test('пехоту выпускают казармы, технику — машинный завод, летающих — космопорт; всем им нужна энергия', () => {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  const layout = [['command', 0], ['barracks', 4], ['factory', 7], ['spaceport', 10], ['generator', 14], ['generator', 17]] as const
  let spot: { x: number; y: number } | undefined
  for (let y = -80; y < 80 && !spot; y++) {
    for (let x = -80; x < 80 && !spot; x++) if (layout.every(([type, dx]) => canPlace(sim, type, x + dx, y))) spot = { x, y }
  }
  const [, barracks, factory, port, plant, spare] = layout.map(([type, dx]) => placeBuilding(sim.world, type, spot!.x + dx, spot!.y, 1))
  expect(producibleBy(sim, barracks)).toEqual(['infantry', 'rocketeer'])
  expect(producibleBy(sim, factory)).toEqual(['buggy', 'lancer', 'tank', 'tesla'])
  expect(producibleBy(sim, port)).toEqual(['drone', 'gunship'])
  // Потребляют 2 + 5 + 5 из 20.
  expect(zoneEconomies(sim, 1)[0]).toMatchObject({ produced: 20, demand: 12 })

  sim.send(1, { type: 'produce', producer: barracks, unit: 'tank' })
  sim.send(1, { type: 'produce', producer: barracks, unit: 'rocketeer' })
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  sim.send(1, { type: 'produce', producer: port, unit: 'drone' })
  sim.send(2, { type: 'produce', producer: port, unit: 'gunship' })
  sim.advance(TICK)
  expect(sim.world.get(barracks, Producer)!.queue).toEqual(['rocketeer'])
  expect(sim.world.get(factory, Producer)!.queue).toEqual(['tank'])
  expect(sim.world.get(port, Producer)!.queue).toEqual(['drone'])
  seconds(sim, UNITS.tank.buildTime + 1)
  const made: string[] = []
  for (const [, unit] of sim.world.query(Unit)) made.push(unit.type)
  expect(made.sort()).toEqual(['drone', 'rocketeer', 'tank'])

  // Энергии не хватает: 10 из 12 — производство идёт на 5/6 скорости, над зданием значок нехватки.
  sim.world.destroy(spare)
  sim.send(1, { type: 'produce', producer: barracks, unit: 'infantry' })
  seconds(sim, UNITS.infantry.buildTime + 0.1)
  expect(powerStates(sim).get(barracks)).toBe('starved')
  expect(sim.world.get(barracks, Producer)!.queue).toEqual(['infantry'])
  seconds(sim, UNITS.infantry.buildTime * 0.2 + 0.1)
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
