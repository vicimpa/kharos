import type { Entity } from '../ecs'
import { buildingSpec, isReady } from './buildings'
import { NONE, isOwn, onTurn } from './common'
import { Building, Converting, Hauler, Harvester, Inventory, Owner, Path, Position, Unit } from './components'
import { DEPOSIT_CELL, DEPOSIT_KINDS, DEPOSIT_SIZE, depositAt, depositIn, reserveLeft, takeReserve, type DepositSpot } from './deposits'
import { amountOf, loadOf, put, roomFor } from './inventory'
import { GOODS, ORE_OF, type Ore } from './resources'
import type { Sim } from './sim'
import { orderMove, unitSpec } from './units'

/** Насколько далеко харвестер сам ищет месторождение, в тайлах. */
export const HARVEST_SEARCH = 60
/** С какого расстояния до центра месторождения харвестер копает, в тайлах: встаёт у его края или у шахты на нём. */
const HARVEST_REACH = 2.2
/** На сколько тайлов к центру месторождения подходить: ближе не нужно, а сам центр может быть занят шахтой. */
const APPROACH = 1.5
/** Раз во сколько тиков харвестер без дела ищет месторождение и прокладывает путь заново. */
const RETRY_TICKS = 20
/** Месторождения без своей переработки дальше на столько тайлов: руду с них некуда везти. */
const NO_REFINERY = 1000
const EPSILON = 1e-9

const centerOf = (spot: DepositSpot) => ({ x: spot.x + DEPOSIT_SIZE / 2, y: spot.y + DEPOSIT_SIZE / 2 })

/** Руды, которые у игрока есть где переработать: у него готовая переработка этой руды. */
function refinedBy(sim: Sim, player: number) {
  const ores = new Set<Ore>()
  for (const [entity, building] of sim.world.query(Building)) {
    const ore = buildingSpec(building.type).refines
    if (ore && isReady(sim, player, entity)) ores.add(ore)
  }
  return ores
}

/**
 * Ближайшее к харвестеру месторождение с рудой в пределах HARVEST_SEARCH. Те, руду которых игроку негде
 * переработать, идут последними: копать их можно, но везти некуда.
 */
function nearestDeposit(sim: Sim, x: number, y: number, refined: Set<Ore>) {
  let best: DepositSpot | undefined
  let bestScore = Infinity
  const from = Math.floor((x - HARVEST_SEARCH) / DEPOSIT_CELL)
  const to = Math.floor((x + HARVEST_SEARCH) / DEPOSIT_CELL)
  const top = Math.floor((y - HARVEST_SEARCH) / DEPOSIT_CELL)
  const bottom = Math.floor((y + HARVEST_SEARCH) / DEPOSIT_CELL)
  for (let cellY = top; cellY <= bottom; cellY++) {
    for (let cellX = from; cellX <= to; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (!spot || reserveLeft(sim, spot.x, spot.y) <= 0) continue
      const center = centerOf(spot)
      const distance = Math.hypot(center.x - x, center.y - y)
      if (distance > HARVEST_SEARCH) continue
      const score = distance + (refined.has(ORE_OF[spot.kind]) ? 0 : NO_REFINERY)
      if (score >= bestScore) continue
      best = spot
      bestScore = score
    }
  }
  return best
}

/** Посылает своих харвестеров копать месторождение с левым верхним тайлом (x, y). Не харвестеры выбрасываются. */
export function orderHarvest(sim: Sim, player: number, units: Entity[], x: number, y: number) {
  const { world } = sim
  const spot = depositAt(sim, x, y)
  if (!spot || reserveLeft(sim, x, y) <= 0) return false
  let ordered = false
  for (const entity of new Set(units)) {
    const harvester = world.get(entity, Harvester)
    if (!harvester || !isOwn(sim, player, entity)) continue
    Object.assign(harvester, { x, y, ordered: true })
    world.remove(entity, Path)
    ordered = true
  }
  return ordered
}

/**
 * Раз в тик, до перевозок: харвестеры копают. Пустой или неполный харвестер едет к своему месторождению
 * (назначенному игроком или ближайшему) и копает в кузов со скоростью UnitSpec.harvest. Полный — или когда
 * месторождение выработано, а в кузове что-то есть, — отдаёт руду перевозкам: дальше его ведёт Hauler, как
 * гружёный грузовик, на ближайшую переработку этой руды. Разгрузился — снова копать.
 */
export function harvest(sim: Sim) {
  const { world, time } = sim
  const refined = new Map<number, Set<Ore>>()
  const moves: { entity: Entity; x: number; y: number }[] = []
  // Первая добыча заводит месторождению сущность, а состав мира меняется только после обхода.
  const digs: { entity: Entity; spot: DepositSpot; amount: number }[] = []
  for (const [entity, harvester, hauler, cargo, position, unit, owner] of world.query(Harvester, Hauler, Inventory, Position, Unit, Owner)) {
    // Везёт руду — этим занимаются перевозки.
    if (hauler.full || world.has(entity, Converting)) continue
    const retry = onTurn(time, entity, RETRY_TICKS)
    let spot = harvester.x === NONE ? null : depositAt(sim, harvester.x, harvester.y)
    if (spot && reserveLeft(sim, spot.x, spot.y) <= 0) spot = null
    if (!spot) {
      if (loadOf(cargo) > EPSILON) {
        // Месторождение выработано — довезти, что накопано.
        deliver(sim, entity, cargo)
        continue
      }
      Object.assign(harvester, { x: NONE, y: NONE, ordered: false })
      if (!retry) continue
      if (!refined.has(owner.player)) refined.set(owner.player, refinedBy(sim, owner.player))
      spot = nearestDeposit(sim, position.x, position.y, refined.get(owner.player)!) ?? null
      if (!spot) continue
      harvester.x = spot.x
      harvester.y = spot.y
    }
    const center = centerOf(spot)
    if (Math.hypot(center.x - position.x, center.y - position.y) > HARVEST_REACH) {
      // Едет — пусть едет; не доехал — через RETRY_TICKS путь прокладывается заново.
      if (!world.has(entity, Path) && retry) moves.push({ entity, ...center })
      continue
    }
    if (world.has(entity, Path)) continue
    const ore = ORE_OF[spot.kind]
    const rate = unitSpec(unit.type).harvest ?? 0
    // Кузов харвестера держит одну руду: сменилось месторождение — старое сначала уедет на переработку.
    if (loadOf(cargo) - amountOf(cargo, ore) > EPSILON) {
      deliver(sim, entity, cargo)
      continue
    }
    digs.push({ entity, spot, amount: Math.min(rate * DEPOSIT_KINDS[spot.kind].rate * time.step, roomFor(cargo, ore)) })
  }
  for (const { entity, spot, amount } of digs) {
    const cargo = world.get(entity, Inventory)!
    const ore = ORE_OF[spot.kind]
    put(cargo, ore, takeReserve(sim, spot.x, spot.y, amount))
    if (roomFor(cargo, ore) <= EPSILON || reserveLeft(sim, spot.x, spot.y) <= 0) deliver(sim, entity, cargo)
  }
  for (const { entity, x, y } of moves) orderMove(sim, entity, Math.floor(x), Math.floor(y), undefined, 0, APPROACH)
}

/** Отдаёт накопанное перевозкам: куда везти, они решат сами (см. haul в hauling.ts). */
function deliver(sim: Sim, entity: Entity, cargo: Parameters<typeof loadOf>[0]) {
  const hauler = sim.world.get(entity, Hauler)!
  const resource = GOODS.find((good) => amountOf(cargo, good) > EPSILON)
  if (!resource) return
  hauler.resource = resource
  hauler.full = true
  hauler.from = hauler.to = NONE
}
