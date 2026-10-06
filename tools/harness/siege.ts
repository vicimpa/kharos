/**
 * Раздел «осада»: штурм узла обороны.
 *
 * Сцена — типовой узел: кольцо стен в 24 тайла, внутри три турели (стрелковая, ракетная, пушечная).
 * Отряд атакующих встаёт в 12 тайлах от стены и получает приказ, как его дал бы игрок: пробить стену, потом
 * добить турели. Винтокрылы летят через стену сразу к турелям — их ракетам она не помеха.
 *
 * Строки — отряды разной цены. Меряется: когда пробили стену, сколько своих потеряли в кредитах, сколько турелей
 * снесли и во сколько защитнику обошёлся ремонт. Вторая половина таблицы — тот же штурм, но у защитника внутри
 * узла стоит строитель, и он чинит.
 *
 * Сцена ставится на скале: на песке оборона держит лишь 70% прочности, и мерить надо одно и то же.
 */
import type { Entity } from '../../src/ecs'
import {
  Owner, UNITS, Unit, durabilityOf, flies, isWalkable, spawnBattle,
  type BuildingType, type Sim, type UnitType,
} from '../../src/sim'
import { placeBuilding } from '../../src/sim/buildings'
import { addCredits, creditsOf } from '../../src/sim/economy'
import { spawnUnit } from '../../src/sim/units'
import { TICK, buildingAt, clock, newSim, printTable } from './lib'

/** Половина стороны кольца: стены стоят на кольце от −3 до 3, внутри 5×5. */
const RING = 3
/** На сколько тайлов от стены встают атакующие. */
const GAP = 12
/** Сколько секунд отводится штурму. */
const LIMIT = 240
/** Как часто атакующим напоминают цель, в секундах: как в показательном бою. */
const ORDERS_EVERY = 0.25
const ORDERS_TICKS = Math.round(ORDERS_EVERY / TICK)
/** Игрок-защитник и его кошелёк: ремонт тратит кредиты, и по трате видно, во что он обошёлся. */
const DEFENDER = 2
const REPAIR_CREDITS = 2000

/** Отряд атакующих: имя для таблицы и состав. Все юниты отряда одного вида. */
interface Squad {
  name: string
  units: UnitType[]
}

/** Отряды разной цены: от дешёвой пехоты до восьми танков. */
const SQUADS: Squad[] = [
  { name: '12 пехоты', units: Array<UnitType>(12).fill('infantry') },
  { name: '8 ракетчиков', units: Array<UnitType>(8).fill('rocketeer') },
  { name: '4 багги', units: Array<UnitType>(4).fill('buggy') },
  { name: '2 танка', units: Array<UnitType>(2).fill('tank') },
  { name: '4 танка', units: Array<UnitType>(4).fill('tank') },
  { name: '8 танков', units: Array<UnitType>(8).fill('tank') },
  { name: '3 артиллерии', units: Array<UnitType>(3).fill('artillery') },
  { name: '3 артиллерии и 4 багги', units: [...Array<UnitType>(3).fill('artillery'), ...Array<UnitType>(4).fill('buggy')] },
  { name: '2 носителя', units: Array<UnitType>(2).fill('carrier') },
  { name: '3 бомбардировщика', units: Array<UnitType>(3).fill('bomber') },
  { name: '4 винтокрыла', units: Array<UnitType>(4).fill('gunship') },
]

/** Место постройки: вид и левый верхний тайл. */
interface Spot {
  type: BuildingType
  x: number
  y: number
}

/** Кольцо стен 7×7 и три турели в ряд внутри. */
function layout(ax: number, ay: number) {
  const walls: Spot[] = []
  for (let dx = 0; dx <= 2 * RING; dx++) {
    for (let dy = 0; dy <= 2 * RING; dy++) {
      if (dx === 0 || dy === 0 || dx === 2 * RING || dy === 2 * RING) walls.push({ type: 'wall', x: ax + dx, y: ay + dy })
    }
  }
  const turrets: Spot[] = [
    { type: 'turret', x: ax + 1, y: ay + RING },
    { type: 'rocketTurret', x: ax + RING, y: ay + RING },
    { type: 'cannonTurret', x: ax + 2 * RING - 1, y: ay + RING },
  ]
  return { walls, turrets }
}

/** Живое здание на этом месте: undefined — места пусто или там уже другое. */
function entityAt(sim: Sim, spot: Spot) {
  return buildingAt(sim, spot.type, spot.x, spot.y)
}

/** Ровная скальная площадка под узел: проходимая вся и без песка под обороной. */
function ground(sim: Sim, width: number, height: number) {
  for (let y = -200; y < 200; y++) {
    search: for (let x = -200; x < 200; x++) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          if (!isWalkable(sim, x + dx, y + dy) || durabilityOf(sim, 'wall', x + dx, y + dy) < 1) continue search
        }
      }
      return { x, y }
    }
  }
  throw new Error(`Не нашлось скальной площадки ${width}×${height} под узел обороны`)
}

/** Узел обороны в симуляции: стены, турели и, если withRepair, строитель внутри. */
function node(withRepair: boolean) {
  const sim = newSim()
  const at = ground(sim, 2 * RING + 3, 2 * RING + 3)
  const { walls, turrets } = layout(at.x + 1, at.y + 1)
  for (const spot of [...walls, ...turrets]) placeBuilding(sim.world, spot.type, spot.x, spot.y, DEFENDER)
  addCredits(sim, DEFENDER, REPAIR_CREDITS)
  if (withRepair) {
    // Строитель встаёт на первый свободный тайл внутри кольца и сам берётся чинить повреждённое рядом.
    const inside: { x: number; y: number }[] = []
    for (let dy = 1; dy <= 2 * RING - 1; dy++) {
      for (let dx = 1; dx <= 2 * RING - 1; dx++) {
        if (isWalkable(sim, at.x + 1 + dx, at.y + 1 + dy)) inside.push({ x: at.x + 1 + dx, y: at.y + 1 + dy })
      }
    }
    const tile = inside[0] ?? { x: at.x + 1 + RING, y: at.y + 1 + RING }
    spawnUnit(sim, 'builder', DEFENDER, tile.x, tile.y)
  }
  // Стена, которую будут пробивать: середина левой.
  const gate = walls.find((spot) => spot.x === at.x + 1 && spot.y === at.y + 1 + RING)!
  return { sim, turrets, at, gate }
}

/** Итог одного штурма. */
interface Result {
  /** Секунда, когда стена пала: 0 — не пробили. */
  breach: number
  /** Потери атакующего в юнитах и кредитах. */
  lostUnits: number
  lost: number
  /** Сколько турелей снесено из трёх. */
  killed: number
  /** Сколько защитник потратил на ремонт. */
  spend: number
}

/** Сколько у игрока живых юнитов этого вида. */
function countUnits(sim: Sim, player: number, type: UnitType) {
  let count = 0
  for (const [, unit, owner] of sim.world.query(Unit, Owner)) if (owner.player === player && unit.type === type) count++
  return count
}

/** Один штурм: узел, отряд, приказы и замер. */
function assault(squad: Squad, withRepair: boolean): Result {
  const { sim, turrets, gate } = node(withRepair)
  spawnBattle(sim, 1, gate.x, gate.y, squad.units, [], GAP)
  const kind = squad.units[0]
  const air = flies(kind)
  const spendBefore = creditsOf(sim, DEFENDER)

  let breach = 0
  let killed = 0
  for (let tick = 0; tick < Math.round(LIMIT / TICK); tick++) {
    if (tick % ORDERS_TICKS === 0) {
      if (countUnits(sim, 1, kind) === 0) break
      // Приказ как у игрока: сперва стена, после пролома — ближайшая живая турель. Летящие идут к турели сразу.
      const wall = entityAt(sim, gate)
      const turret = turrets.map((spot) => entityAt(sim, spot)).find((entity) => entity !== undefined)
      const target = air || wall === undefined ? turret : wall
      if (target !== undefined) {
        const units: Entity[] = []
        for (const [entity, unit, owner] of sim.world.query(Unit, Owner)) {
          if (owner.player === 1 && unit.type === kind) units.push(entity)
        }
        sim.send(1, { type: 'attack', units, target })
      }
    }
    sim.advance(TICK)
    if (breach === 0 && entityAt(sim, gate) === undefined) breach = (tick + 1) * TICK
    killed = turrets.filter((spot) => entityAt(sim, spot) === undefined).length
    if (killed === turrets.length) break
  }

  const lostUnits = squad.units.length - countUnits(sim, 1, kind)
  const result: Result = {
    breach,
    lostUnits,
    lost: lostUnits * UNITS[kind].cost,
    killed,
    spend: withRepair ? Math.round(spendBefore - creditsOf(sim, DEFENDER)) : 0,
  }
  sim.destroy()
  return result
}

/** Итоги по отрядам: строка таблицы и что из неё следует. */
interface Outcome {
  squad: Squad
  cost: number
  bare: Result
  repair: Result
}

function outcomes(): Outcome[] {
  return SQUADS.map((squad) => ({
    squad,
    cost: squad.units.reduce((sum, type) => sum + UNITS[type].cost, 0),
    bare: assault(squad, false),
    repair: assault(squad, true),
  }))
}

/** Строка таблицы по одному штурму. */
function row(squad: Squad, cost: number, result: Result, withRepair: boolean): (string | number)[] {
  return [
    withRepair ? `${squad.name} /ремонт` : squad.name,
    cost,
    result.breach ? clock(result.breach) : '—',
    `${result.lostUnits}/${squad.units.length}`,
    result.lost,
    withRepair ? result.spend : '—',
    `${result.killed}/3`,
  ]
}

/** Печатает таблицу штурмов и выводы по числам. */
export function printSieges() {
  console.log('\nШтурм узла обороны: кольцо стен 7×7, внутри стрелковая, ракетная и пушечная турели')
  console.log(`  атакующие встают в ${GAP} тайлах и бьют в стену, после пролома — в турели; винтокрылы летят через стену`)
  const all = outcomes()
  const rows: (string | number)[][] = []
  for (const item of all) {
    rows.push(row(item.squad, item.cost, item.bare, false))
    rows.push(row(item.squad, item.cost, item.repair, true))
  }
  printTable(['отряд', 'цена', 'стена', 'потери', 'потери кр', 'ремонт', 'турелей'], rows, 20, 9)
  console.log('  стена — когда пробили кольцо; потери — юнитов и кредитов у атакующего;')
  console.log(`  ремонт — сколько защитник потратил из своих ${REPAIR_CREDITS} кр; турелей — сколько снёс из трёх`)
  for (const item of all) {
    if (item.bare.killed === 3 && item.bare.breach === 0) console.log(`  ${item.squad.name}: турели снесены, не тронув стены`)
    else if (item.bare.breach > 0 && item.bare.killed === 0) console.log(`  ${item.squad.name}: стену пробили за ${clock(item.bare.breach)}, но турели устояли`)
  }
}

/** Раздел целиком. */
export function runSiege() {
  printSieges()
}
