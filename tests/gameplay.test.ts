import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import {
  BUILDINGS, DEPOSIT_KINDS, Owner, RESOURCE_SPECS, TRUCK_CAPACITY, UNITS, Unit,
  createSim, driveBattle, isWalkable, spawnBattle, type Sim, type UnitType,
} from '../src/sim'
import { REWARDS, STARTING_CREDITS } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
/** Цена отряда в бою: у каждой стороны столько юнитов, сколько в неё влезает. */
const DUEL_BUDGET = 2400

/** Находит левый верхний тайл ровной проходимой площадки width×height: арена для боя. */
function arena(sim: Sim, width: number, height: number) {
  for (let y = -200; y < 200; y++) {
    search: for (let x = -200; x < 200; x++) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) if (!isWalkable(sim, x + dx, y + dy)) continue search
      }
      return { x, y }
    }
  }
  throw new Error(`Не нашлось площадки ${width}×${height}`)
}

/** Бой двух отрядов равной цены на ровном поле: true — победил первый. */
function beats(ownType: UnitType, foeType: UnitType) {
  const sim = createSim(options)
  const ownCount = Math.max(1, Math.floor(DUEL_BUDGET / UNITS[ownType].cost))
  const foeCount = Math.max(1, Math.floor(DUEL_BUDGET / UNITS[foeType].cost))
  const own = Array<UnitType>(ownCount).fill(ownType)
  const foe = Array<UnitType>(foeCount).fill(foeType)
  const spot = arena(sim, 20 + Math.ceil(Math.max(ownCount, foeCount) / 3) * 2, 16)
  spawnBattle(sim, 1, spot.x + 14, spot.y + 8, own, foe, 7)
  for (let spent = 0; spent < 240; spent += 0.25) {
    if (!driveBattle(sim, 1)) break
    sim.advance(0.25)
  }
  let mine = 0
  let others = 0
  for (const [, , owner] of sim.world.query(Unit, Owner)) {
    if (owner.player === 1) mine++
    else if (owner.player !== 0) others++
  }
  return mine > 0 && others === 0
}

test('боевой треугольник: у каждого юнита есть контр-юнит', () => {
  // Пехоту — дешёвый рой — бьют миниганы, осколки и разряд.
  expect(beats('buggy', 'infantry')).toBe(true)
  expect(beats('tesla', 'infantry')).toBe(true)
  expect(beats('tank', 'infantry')).toBe(true)
  // Пехота сама бьёт ракетчиков (по ней ракета слаба) и авиацию.
  expect(beats('infantry', 'rocketeer')).toBe(true)
  expect(beats('infantry', 'drone')).toBe(true)
  // Ракетчик — против лёгкой техники и авиации.
  expect(beats('rocketeer', 'buggy')).toBe(true)
  expect(beats('rocketeer', 'lancer')).toBe(true)
  expect(beats('rocketeer', 'gunship')).toBe(true)
  // Танк переживает ракеты и давит осколками; против танка — лазер и авиация.
  expect(beats('tank', 'rocketeer')).toBe(true)
  expect(beats('lancer', 'tank')).toBe(true)
  expect(beats('drone', 'tank')).toBe(true)
  expect(beats('gunship', 'tank')).toBe(true)
})

test('стартовых кредитов хватает на первый набор: электростанцию, генератор материи, шахту и грузовик', () => {
  const kit = BUILDINGS.generator.cost + BUILDINGS.matter.cost + BUILDINGS.mine.cost + UNITS.truck.cost
  expect(kit).toBeLessThanOrEqual(STARTING_CREDITS)
  // Развернув MCV, игрок получает награду — её хватает ещё и на первый космопорт.
  expect(STARTING_CREDITS + REWARDS.deploy).toBeGreaterThanOrEqual(kit + BUILDINGS.spaceport.cost)
})

test('продажа сырья — основной доход: шахта с грузовиком окупается за минуты', () => {
  const perSecond = DEPOSIT_KINDS.metal.rate * RESOURCE_SPECS.metal.price
  expect(perSecond).toBeGreaterThan(0)
  // Стоимость шахты и грузовика отбивается потоком сырья быстрее двух минут.
  expect((BUILDINGS.mine.cost + UNITS.truck.cost) / perSecond).toBeLessThan(120)
  // Грузовик увозит заметную партию, а шахта успевает её накопить.
  expect(TRUCK_CAPACITY).toBeGreaterThanOrEqual(20)
  expect(BUILDINGS.mine.inventory).toBeGreaterThan(TRUCK_CAPACITY)
})
