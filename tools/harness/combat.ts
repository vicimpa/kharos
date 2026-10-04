/**
 * Раздел боя: боевые числа юнитов и парные бои.
 *
 *   1. Таблица: у каждого боевого юнита — цена, прочность, скорость, дальность и урон в секунду по классам брони.
 *      Из неё видно, кто выгоднее за кредит и нет ли выбросов.
 *   2. Бои: два отряда одинаковой цены дерутся на ровном поле, пока одна сторона не погибнет. По нескольку боёв
 *      видно, кто кого побеждает. Это и есть обратная связь для правки чисел.
 */
import {
  UNITS, UNIT_TYPES, WEAPONS, createSim, driveBattle, isFighter, spawnBattle, unitSpec, Unit, Owner,
  type TurretSpec, type UnitType, type WeaponSpec, type WeaponType,
} from '../../src/sim'
import { turretSpec } from '../../src/sim/turrets'
import { arena, options, pad, printTable, round } from './lib'

/** Сколько реального времени отводится одному бою, в секундах. */
const BATTLE_LIMIT = 240
/** Как часто бойцам раздаются цели, в секундах: как в показательном бою (game.ts). */
const ORDERS_EVERY = 0.25
/** Сколько раз повторяется каждый парный бой: один бой — дело случая. */
const ROUNDS = 7
/** Цена отряда в парном бою: по нему берётся число юнитов каждой стороны. */
const DUEL_BUDGET = 2400

/** Классы брони и здания — то, по чему отличается урон. */
const ARMORS = ['infantry', 'vehicle', 'heavy', 'air', 'building'] as const
type ArmorKey = (typeof ARMORS)[number]

/** Всё оружие юнита: своё и на его турелях. */
function weaponsOf(type: UnitType): WeaponType[] {
  const spec = unitSpec(type)
  const list: WeaponType[] = []
  if (spec.weapon) list.push(spec.weapon)
  for (const mount of spec.mounts ?? []) {
    const turret: TurretSpec = turretSpec(mount.turret)
    if (turret.weapon) list.push(turret.weapon)
  }
  return list
}

/** Урон в секунду по цели этого класса. */
function dpsAgainst(weapons: WeaponType[], armor: ArmorKey): number {
  return weapons.reduce((sum, weapon) => {
    const spec: WeaponSpec = WEAPONS[weapon]
    return sum + (spec.damage / spec.reload) * (spec.vs?.[armor] ?? 1)
  }, 0)
}

/** Дальность самого дальнобойного оружия юнита. */
const rangeOf = (weapons: WeaponType[]) => (weapons.length ? Math.max(...weapons.map((weapon) => WEAPONS[weapon].range)) : 0)

/** Строка таблицы боевых чисел одного юнита. */
interface Row {
  type: UnitType
  cost: number
  hp: number
  speed: number
  range: number
  /** Урон в секунду по каждому классу брони. */
  dps: Record<ArmorKey, number>
  /** Общий урон в секунду без поправок на броню. */
  raw: number
  /** Урон в секунду и прочность на кредит цены. */
  dpsPerCredit: number
  hpPerCredit: number
}

function rows(): Row[] {
  return UNIT_TYPES.filter(isFighter).map((type) => {
    const spec = unitSpec(type)
    const weapons = weaponsOf(type)
    const dps = Object.fromEntries(ARMORS.map((armor) => [armor, dpsAgainst(weapons, armor)])) as Record<ArmorKey, number>
    const raw = weapons.reduce((sum, weapon) => sum + WEAPONS[weapon].damage / WEAPONS[weapon].reload, 0)
    return {
      type,
      cost: spec.cost,
      hp: spec.hp,
      speed: spec.speed,
      range: rangeOf(weapons),
      dps,
      raw,
      dpsPerCredit: raw / spec.cost,
      hpPerCredit: spec.hp / spec.cost,
    }
  })
}

/** Печатает таблицу боевых чисел. */
export function printStats() {
  const all = rows()
  console.log('\nБоевые числа (урон в секунду по классам брони; без поправок — сырой dps)')
  printTable(
    ['юнит', 'цена', 'hp', 'скор', 'дальн', 'пех', 'маш', 'тяж', 'возд', 'здан', 'сырой', 'dps/кр', 'hp/кр'],
    all.map((row) => [
      row.type, row.cost, row.hp, round(row.speed, 1), round(row.range, 1),
      round(row.dps.infantry, 1), round(row.dps.vehicle, 1), round(row.dps.heavy, 1),
      round(row.dps.air, 1), round(row.dps.building, 1), round(row.raw, 1),
      round(row.dpsPerCredit, 3), round(row.hpPerCredit, 2),
    ]),
    10,
    7,
  )
}

/** Кто уцелел в бою: свои — игрок 1, враги — учебный противник. */
interface Outcome {
  own: number
  foe: number
}

/** Один бой двух заданных отрядов на ровном поле. gap — дистанция между передними рядами. */
function fight(own: UnitType[], foe: UnitType[], gap: number): Outcome {
  const sim = createSim(options)
  const width = 20 + Math.ceil(Math.max(own.length, foe.length) / 3) * 2
  const spot = arena(sim, width, 16)
  spawnBattle(sim, 1, spot.x + Math.floor(width / 2), spot.y + 8, own, foe, gap)
  let spent = 0
  while (spent < BATTLE_LIMIT) {
    if (!driveBattle(sim, 1)) break
    sim.advance(ORDERS_EVERY)
    spent += ORDERS_EVERY
  }
  const outcome: Outcome = { own: 0, foe: 0 }
  for (const [, , owner] of sim.world.query(Unit, Owner)) {
    if (owner.player === 1) outcome.own++
    else if (owner.player !== 0) outcome.foe++
  }
  return outcome
}

/** Парный бой: у каждой стороны столько юнитов, сколько влезает в DUEL_BUDGET кредитов. */
function duel(a: UnitType, b: UnitType) {
  const countA = Math.max(1, Math.floor(DUEL_BUDGET / UNITS[a].cost))
  const countB = Math.max(1, Math.floor(DUEL_BUDGET / UNITS[b].cost))
  const own = Array<UnitType>(countA).fill(a)
  const foe = Array<UnitType>(countB).fill(b)
  let winsA = 0
  let winsB = 0
  let draws = 0
  let leftA = 0
  let leftB = 0
  for (let round = 0; round < ROUNDS; round++) {
    // Дистанция боя меняется от раунда к раунду: так видно, решает ли бой дальнобойность.
    const result = fight(own, foe, 4 + round)
    leftA += result.own
    leftB += result.foe
    if (result.own > 0 && result.foe === 0) winsA++
    else if (result.foe > 0 && result.own === 0) winsB++
    else draws++
  }
  const costA = countA * UNITS[a].cost
  const costB = countB * UNITS[b].cost
  return { a, b, countA, countB, costA, costB, winsA, winsB, draws, leftA: leftA / ROUNDS, leftB: leftB / ROUNDS }
}

/** Печатает таблицу парных боёв: строка побеждает столбец. */
export function printDuels() {
  const types = rows().map((row) => row.type)
  console.log(`\nПарные бои: цена отряда ~${DUEL_BUDGET}; по ${ROUNDS} боёв; в клетке — доля побед строки`)
  console.log([''.padStart(10), ...types.map((type) => pad(type, 10))].join(''))
  for (const a of types) {
    const cells = types.map((b) => {
      if (a === b) return pad('—', 10)
      const result = duel(a, b)
      return pad(`${result.winsA}/${ROUNDS}`, 10)
    })
    console.log([pad(a, 10), ...cells].join(''))
  }
}

/** Таблица боевых чисел и парные бои разом. */
export function runCombat() {
  printStats()
  printDuels()
}
