/**
 * Раздел «набег»: нападение на экономику.
 *
 * Сцена — живая линия добычи: шахта на металле, переработка с электростанцией, хранилище с главным зданием
 * рядом и два грузовика: один привязан к шахте и возит руду на завод, второй свободный — развозит готовое.
 * Сначала линия меряется на ходу (сколько металла в секунду приходит в хранилище), потом к ней подходит
 * отряд и получает приказ: снести шахту, затем грузовики.
 *
 * Строки — отряды разной цены. Меряется: за сколько секунд они сносят шахту, за сколько — грузовики, и сколько
 * это стоит защитнику. Обороны в сцене нет: она мерится отдельно, в разделе осады. Здесь видно, чего стоит один
 * набег на экономику и сколько линии он останавливает.
 */
import type { Entity } from '../../src/ecs'
import {
  BUILDINGS, Inventory, Owner, Position, RESOURCE_SPECS, UNITS, Unit,
  spawnBattle, type BuildingType, type Sim, type UnitType,
} from '../../src/sim'
import { placeBuilding } from '../../src/sim/buildings'
import { depositIn } from '../../src/sim'
import { freeTilesNear, spawnUnit } from '../../src/sim/units'
import { TICK, buildingAt, clock, newSim, placeableNear, printTable, rings, round, seconds, spotNear } from './lib'

/** На сколько тайлов от шахты встают атакующие. */
const GAP = 12
/** Сколько секунд отводится набегу. */
const LIMIT = 120
/** Как часто атакующим напоминают цель, в секундах. */
const ORDERS_EVERY = 0.25
const ORDERS_TICKS = Math.round(ORDERS_EVERY / TICK)
/** Разгон линии и окно замера её потока, в секундах. */
const WARMUP = 60
const WINDOW = 60
/** Игрок-защитник: его линия добычи. Атакующие — игрок 1, иначе свои цели не бьются. */
const DEFENDER = 2

/** Отряд атакующих: имя для таблицы и состав. Все юниты отряда одного вида. */
interface Squad {
  name: string
  units: UnitType[]
}

/** Отряды, которыми пробуют набег: от дешёвой пехоты до винтокрылов. */
const SQUADS: Squad[] = [
  { name: '12 пехоты', units: Array<UnitType>(12).fill('infantry') },
  { name: '8 ракетчиков', units: Array<UnitType>(8).fill('rocketeer') },
  { name: '4 багги', units: Array<UnitType>(4).fill('buggy') },
  { name: '4 танка', units: Array<UnitType>(4).fill('tank') },
  { name: '4 винтокрыла', units: Array<UnitType>(4).fill('gunship') },
]

/** Линия добычи: шахта и грузовики при ней. */
interface Line {
  sim: Sim
  /** Место шахты: по нему же ищем, жива ли она. */
  mine: { x: number; y: number }
  trucks: Entity[]
}

/** Ставит здание у шахты, не задевая место для грузовиков под ней. */
function placeNearMine(sim: Sim, spot: { x: number; y: number }, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  const mine = BUILDINGS.mine
  const ok = (tx: number, ty: number) => {
    if (!placeableNear(sim, type, tx, ty, 1, 0)) return false
    const apart = tx >= spot.x + mine.width + 2 || tx + width + 2 <= spot.x
    return apart || ty >= spot.y + mine.height + 2 || ty + height + 2 <= spot.y
  }
  const tile = spotNear(x, y, ok, 14)
  return tile && placeBuilding(sim.world, type, tile.x, tile.y, DEFENDER)
}

/** Линия добычи у ближайшего к началу мира месторождения металла. */
function lineScene(): Line {
  const sim = newSim()
  for (const cell of rings(0, 0, 6)) {
    const spot = depositIn(sim, cell.x, cell.y)
    if (!spot || spot.kind !== 'metal') continue
    const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, DEFENDER)
    const silo = placeNearMine(sim, spot, 'metalYard', spot.x + 4, spot.y + 4)
    const core = placeNearMine(sim, spot, 'command', spot.x + 8, spot.y)
    const refinery = placeNearMine(sim, spot, 'smelter', spot.x + 4, spot.y - 4)
    const generator = placeNearMine(sim, spot, 'generator', spot.x + 8, spot.y - 4)
    const tiles = freeTilesNear(sim, spot.x, spot.y, 4)
    if (!silo || !core || !refinery || !generator || tiles.length < 4) break
    const trucks = [0, 1].map((i) => spawnUnit(sim, 'truck', DEFENDER, tiles[i * 2], tiles[i * 2 + 1]))
    // Первый возит руду из шахты на завод, второй свободен: он развозит готовое по хранилищам.
    sim.send(DEFENDER, { type: 'haul', units: [trucks[0]], mine })
    return { sim, mine: { x: spot.x, y: spot.y }, trucks }
  }
  sim.destroy()
  throw new Error('Не нашлось места под линию добычи у месторождения металла')
}

/**
 * Сколько металла у игрока всего: в складах зданий и в кузовах грузовиков. Грузовики сгружают в ближайшее
 * хранилище — им может оказаться и главное здание, поэтому мерить поток по одному хранилищу нельзя.
 */
function storedMetal(sim: Sim, player: number) {
  let total = 0
  for (const [, inventory, owner] of sim.world.query(Inventory, Owner)) {
    if (owner.player === player) total += inventory.items.metal ?? 0
  }
  return total
}

/** Сколько у игрока живых юнитов этого вида. */
function countUnits(sim: Sim, player: number, type: UnitType) {
  let count = 0
  for (const [, unit, owner] of sim.world.query(Unit, Owner)) if (owner.player === player && unit.type === type) count++
  return count
}

/** Итог одного набега. */
interface Result {
  /** Поток линии до набега: металла в секунду. */
  flow: number
  /** Секунда, когда пала шахта: 0 — не снесли. */
  mineAt: number
  /** Секунда, когда пал последний грузовик: 0 — не добили. */
  trucksAt: number
}

/** Один набег: живая линия, отряд, приказы и замер. */
function raid(squad: Squad): Result {
  const { sim, mine, trucks } = lineScene()
  seconds(sim, WARMUP)
  const before = storedMetal(sim, DEFENDER)
  seconds(sim, WINDOW)
  const flow = (storedMetal(sim, DEFENDER) - before) / WINDOW

  spawnBattle(sim, 1, mine.x + 1, mine.y + 1, squad.units, [], GAP)
  const kind = squad.units[0]
  const alive = (id: Entity) => sim.world.get(id, Unit) !== undefined
  let mineAt = 0
  let trucksAt = 0
  for (let tick = 0; tick < Math.round(LIMIT / TICK); tick++) {
    if (tick % ORDERS_TICKS === 0) {
      if (countUnits(sim, 1, kind) === 0) break
      // Приказ как у игрока: сперва шахта, потом грузовики — по одному, ближний первым.
      const target =
        buildingAt(sim, 'mine', mine.x, mine.y) ??
        trucks.filter(alive).sort((a, b) => distanceTo(sim, a, mine) - distanceTo(sim, b, mine))[0]
      if (target !== undefined) {
        const units: Entity[] = []
        for (const [entity, unit, owner] of sim.world.query(Unit, Owner)) {
          if (owner.player === 1 && unit.type === kind) units.push(entity)
        }
        sim.send(1, { type: 'attack', units, target })
      }
    }
    sim.advance(TICK)
    if (mineAt === 0 && buildingAt(sim, 'mine', mine.x, mine.y) === undefined) mineAt = (tick + 1) * TICK
    if (trucksAt === 0 && trucks.every((id) => !alive(id))) trucksAt = (tick + 1) * TICK
    if (trucksAt > 0) break
  }
  sim.destroy()
  return { flow, mineAt, trucksAt }
}

/** Насколько юнит далеко от места шахты, в квадрате расстояния. */
function distanceTo(sim: Sim, entity: Entity, spot: { x: number; y: number }) {
  const position = sim.world.get(entity, Position)
  if (!position) return Infinity
  return (position.x - spot.x) ** 2 + (position.y - spot.y) ** 2
}

/** Печатает таблицу набегов. */
export function runRaids() {
  console.log('\nНабег на экономику: шахта с грузовиками, переработкой и хранилищем, обороны нет')
  console.log(`  сперва меряется поток линии, потом отряд в ${GAP} тайлах получает приказ: шахта, затем грузовики`)
  const rows: (string | number)[][] = []
  let flow = 0
  for (const squad of SQUADS) {
    const cost = squad.units.reduce((sum, type) => sum + UNITS[type].cost, 0)
    const result = raid(squad)
    flow = result.flow
    const damage = BUILDINGS.mine.cost + 2 * UNITS.truck.cost
    const done = result.trucksAt || result.mineAt || LIMIT
    rows.push([
      squad.name,
      cost,
      result.mineAt ? clock(result.mineAt) : '—',
      result.trucksAt ? clock(result.trucksAt) : '—',
      damage,
      round(damage / done, 1),
      round(cost / damage, 2),
    ])
  }
  printTable(['отряд', 'цена', 'шахта', 'грузовики', 'ущерб кр', 'ущерб/с', 'цена/ущерб'], rows, 14, 10)
  console.log('  шахта и грузовики — когда их снесли; ущерб — сколько защитнику строить заново;')
  console.log('  ущерб/с — с какой скоростью отряд сносит линию; цена/ущерб — во сколько кр обходится 1 кр ущерба')
  console.log('  переработка в ущерб не входит: она переживает набег, но встаёт без шахты и грузовиков')
  console.log(`  линия добывает металла в секунду: ${round(flow, 2)}, это ${round(flow * RESOURCE_SPECS.metal.price, 1)} кр/с выручки, пока цела`)
}
