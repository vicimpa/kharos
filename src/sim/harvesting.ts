import type { Entity } from '../ecs'
import { isBuildable, terrainAt, tileKey } from '../map/terrain'
import { buildingSpec, isReady, siteAt } from './buildings'
import { NONE, isOwn, onTurn } from './common'
import { Building, Converting, Site, Hauler, Harvester, Inventory, Owner, Path, Position, Unit } from './components'
import { DEPOSIT_CELL, DEPOSIT_KINDS, DEPOSIT_SIZE, DEPOSIT_TYPES, depositAt, depositsIn, reserveLeft, takeReserve, type DepositKind, type DepositSpot } from './deposits'
import { amountOf, loadOf, put, roomFor } from './inventory'
import { GOODS, ORE_OF, type Ore } from './resources'
import type { Sim } from './sim'
import { inBounds, isWalkable, orderMove, unitSpec } from './units'

/** Насколько далеко харвестер сам ищет месторождение и разведывает, в тайлах. */
export const HARVEST_SEARCH = 60
/** Шаг колец разведки, в тайлах: харвестер едет к ближайшему неразведанному месту на одном из них. */
const SCOUT_STEP = 4
/** Сколько направлений проверяется на каждом кольце. */
const SCOUT_DIRECTIONS = 16
/** С какого расстояния до центра месторождения харвестер копает, в тайлах: встаёт у его края. */
const HARVEST_REACH = 2.2
/** На сколько тайлов к центру месторождения подходить: ближе не нужно. */
const APPROACH = 1.5
/** Раз во сколько тиков харвестер без дела ищет месторождение и прокладывает путь заново. */
const RETRY_TICKS = 20
/** Месторождения без своей переработки дальше на столько тайлов: руду с них некуда везти. */
const NO_REFINERY = 1000
const EPSILON = 1e-9

const centerOf = (spot: DepositSpot) => ({ x: spot.x + DEPOSIT_SIZE / 2, y: spot.y + DEPOSIT_SIZE / 2 })

/**
 * Стоит ли на месторождении шахта — готовая или строящаяся, чья угодно. Такое месторождение харвестер не копает:
 * его выкачивает шахта, и вдвоём они бы делили один запас.
 */
export function hasMine(sim: Sim, spot: DepositSpot) {
  for (let y = spot.y; y < spot.y + DEPOSIT_SIZE; y++) {
    for (let x = spot.x; x < spot.x + DEPOSIT_SIZE; x++) {
      const building = sim.occupancy.at(x, y)
      const type = building === undefined ? undefined : sim.world.get(building, Building)?.type
      if (type && buildingSpec(type).extract) return true
      const site = siteAt(sim, x, y)
      const planned = site === undefined ? undefined : sim.world.get(site, Site)!.type
      if (planned && buildingSpec(planned).extract) return true
    }
  }
  return false
}

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
 * Ближайшее к харвестеру месторождение с рудой и без шахты в пределах HARVEST_SEARCH, о котором игрок player знает:
 * хоть краем разведанное. kind — только этого вида. Те, руду которых игроку негде переработать, идут последними:
 * копать их можно, но везти некуда.
 */
function nearestDeposit(sim: Sim, player: number, x: number, y: number, refined: Set<Ore>, kind?: DepositSpot['kind']) {
  let best: DepositSpot | undefined
  let bestScore = Infinity
  const from = Math.floor((x - HARVEST_SEARCH) / DEPOSIT_CELL)
  const to = Math.floor((x + HARVEST_SEARCH) / DEPOSIT_CELL)
  const top = Math.floor((y - HARVEST_SEARCH) / DEPOSIT_CELL)
  const bottom = Math.floor((y + HARVEST_SEARCH) / DEPOSIT_CELL)
  for (let cellY = top; cellY <= bottom; cellY++) {
    for (let cellX = from; cellX <= to; cellX++) {
      for (const spot of depositsIn(sim, cellX, cellY)) {
        if ((kind && spot.kind !== kind) || reserveLeft(sim, spot.x, spot.y) <= 0 || hasMine(sim, spot)) continue
        if (!sim.vision.exploredIn(player, spot.x, spot.y, DEPOSIT_SIZE, DEPOSIT_SIZE)) continue
        const center = centerOf(spot)
        const distance = Math.hypot(center.x - x, center.y - y)
        if (distance > HARVEST_SEARCH) continue
        const score = distance + (refined.has(ORE_OF[spot.kind]) ? 0 : NO_REFINERY)
        if (score >= bestScore) continue
        best = spot
        bestScore = score
      }
    }
  }
  return best
}

/**
 * Куда ехать на разведку: ближайшее к (x, y) неразведанное игроком место на кольцах через SCOUT_STEP тайлов,
 * не дальше HARVEST_SEARCH. Направления у каждого харвестера свои, чтобы несколько не ехали в одну точку.
 * undefined — вокруг всё разведано.
 */
function scoutTarget(sim: Sim, player: number, entity: Entity, x: number, y: number) {
  const turn = (entity * 0.618) % 1
  // Месторождения лежат только на скале: сперва обшаривается скала, на которой начат поиск, потом — любая.
  const rock = rockAround(sim, Math.floor(x), Math.floor(y))
  const onRock = (tileX: number, tileY: number) => isBuildable(terrainAt(sim.land, tileX, tileY))
  for (const allowed of [(tileX: number, tileY: number) => rock.has(tileKey(tileX, tileY)), onRock]) {
    for (let radius = SCOUT_STEP; radius <= HARVEST_SEARCH; radius += SCOUT_STEP) {
      for (let i = 0; i < SCOUT_DIRECTIONS; i++) {
        const angle = ((i + turn) / SCOUT_DIRECTIONS) * Math.PI * 2
        const tileX = Math.floor(x + Math.cos(angle) * radius)
        const tileY = Math.floor(y + Math.sin(angle) * radius)
        if (!inBounds(sim, tileX, tileY) || !isWalkable(sim, tileX, tileY) || !allowed(tileX, tileY)) continue
        if (!sim.vision.explored(player, tileX, tileY)) return { x: tileX, y: tileY }
      }
    }
  }
  return undefined
}

/**
 * Тайлы скалы, связной с (x, y), не дальше HARVEST_SEARCH; ключ — tileKey. Здания на скале её не
 * разрывают. Стоит не на скале — от ближайшего тайла скалы в пределах нескольких шагов.
 */
function rockAround(sim: Sim, x: number, y: number) {
  const rock = (tileX: number, tileY: number) => inBounds(sim, tileX, tileY) && isBuildable(terrainAt(sim.land, tileX, tileY))
  const tiles = new Set<number>()
  const queue: number[] = []
  for (let reach = 0; reach <= 3 && !queue.length; reach++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (rock(x + dx, y + dy) && !tiles.has(tileKey(x + dx, y + dy))) {
          tiles.add(tileKey(x + dx, y + dy))
          queue.push(x + dx, y + dy)
        }
      }
    }
  }
  for (let i = 0; i < queue.length; i += 2) {
    const tileX = queue[i]
    const tileY = queue[i + 1]
    for (const [nextX, nextY] of [[tileX + 1, tileY], [tileX - 1, tileY], [tileX, tileY + 1], [tileX, tileY - 1]]) {
      const key = tileKey(nextX, nextY)
      if (tiles.has(key) || Math.hypot(nextX - x, nextY - y) > HARVEST_SEARCH || !rock(nextX, nextY)) continue
      tiles.add(key)
      queue.push(nextX, nextY)
    }
  }
  return tiles
}

/** Велит своим харвестерам искать месторождение вида kind или любое: они найдут известное или разведают. */
export function orderSeek(sim: Sim, player: number, units: Entity[], kind: DepositKind | 'any') {
  if (kind !== 'any' && !DEPOSIT_TYPES.includes(kind)) return false
  let ordered = false
  for (const entity of new Set(units)) {
    const harvester = sim.world.get(entity, Harvester)
    if (!harvester || !isOwn(sim, player, entity)) continue
    Object.assign(harvester, { x: NONE, y: NONE, ordered: false, parked: false, seek: kind, scoutX: NONE, scoutY: NONE })
    sim.world.remove(entity, Path)
    ordered = true
  }
  return ordered
}

/** Посылает своих харвестеров копать месторождение с левым верхним тайлом (x, y). Не харвестеры выбрасываются. */
export function orderHarvest(sim: Sim, player: number, units: Entity[], x: number, y: number) {
  const { world } = sim
  const spot = depositAt(sim, x, y)
  if (!spot || reserveLeft(sim, x, y) <= 0 || hasMine(sim, spot)) return false
  // Послать можно только к найденному: координаты неразведанного игроку неоткуда знать.
  if (!sim.vision.exploredIn(player, spot.x, spot.y, DEPOSIT_SIZE, DEPOSIT_SIZE)) return false
  let ordered = false
  for (const entity of new Set(units)) {
    const harvester = world.get(entity, Harvester)
    if (!harvester || !isOwn(sim, player, entity)) continue
    // Выработает — будет искать того же вида.
    Object.assign(harvester, { x: spot.x, y: spot.y, ordered: true, parked: false, seek: spot.kind })
    world.remove(entity, Path)
    ordered = true
  }
  return ordered
}

/**
 * Раз в тик, до перевозок: харвестеры копают. Пустой или неполный харвестер едет к своему месторождению
 * (назначенному игроком или найденному по приказу искать; выработанное меняет на найденное того же вида; не
 * найдя известного — разведывает) и копает в кузов со скоростью UnitSpec.harvest. Полный — или когда
 * месторождение выработано, а в кузове что-то есть, — отдаёт руду перевозкам: дальше его ведёт Hauler, как
 * гружёный грузовик, на ближайшую переработку этой руды. Разгрузился — снова копать.
 */
export function harvest(sim: Sim) {
  const { world, time } = sim
  const refined = new Map<number, Set<Ore>>()
  const moves: { entity: Entity; x: number; y: number; near: number }[] = []
  // Первая добыча заводит месторождению сущность, а состав мира меняется только после обхода.
  const digs: { entity: Entity; spot: DepositSpot; amount: number }[] = []
  for (const [entity, harvester, hauler, cargo, position, unit, owner] of world.query(Harvester, Hauler, Inventory, Position, Unit, Owner)) {
    // Везёт руду — этим занимаются перевозки.
    if (hauler.full || world.has(entity, Converting)) continue
    const retry = onTurn(time, entity, RETRY_TICKS)
    // Уведённый приказом идти стоит, пока игрок не даст новую команду.
    if (harvester.parked) continue
    let spot = harvester.x === NONE ? null : depositAt(sim, harvester.x, harvester.y)
    // Выработано или на нём поставили шахту — искать другое того же вида.
    const spent = spot && (reserveLeft(sim, spot.x, spot.y) <= 0 || hasMine(sim, spot)) ? spot : null
    if (spent) spot = null
    if (!spot) {
      if (loadOf(cargo) > EPSILON) {
        // Месторождение выработано — довезти, что накопано.
        deliver(sim, entity, cargo)
        continue
      }
      if (!retry) continue
      if (!harvester.seek) {
        Object.assign(harvester, { x: NONE, y: NONE, ordered: false, parked: true })
        continue
      }
      if (!refined.has(owner.player)) refined.set(owner.player, refinedBy(sim, owner.player))
      const kind = harvester.seek === 'any' ? undefined : harvester.seek
      spot = nearestDeposit(sim, owner.player, position.x, position.y, refined.get(owner.player)!, kind) ?? null
      if (!spot) {
        harvester.x = harvester.y = NONE
        // Разведка — вокруг места, где начат поиск, а не вокруг себя: иначе ближайшее неразведанное всё время
        // впереди, и харвестер уезжает по прямой на край карты.
        // Проверка «не ≥ 0» — и для старых сохранений, где поля нет.
        if (!(harvester.scoutX >= 0)) Object.assign(harvester, { scoutX: position.x, scoutY: position.y })
        // Известного нет — разведывает; едущего не дёргают, пока не доедет.
        if (world.has(entity, Path)) continue
        const target = scoutTarget(sim, owner.player, entity, harvester.scoutX, harvester.scoutY)
        if (target) moves.push({ entity, x: target.x, y: target.y, near: 0 })
        // Вокруг всё разведано, а искомого нет — ждёт команды.
        else Object.assign(harvester, { ordered: false, parked: true })
        continue
      }
      // Нашёл, пока ехал на разведку: разворачивается к месторождению.
      world.remove(entity, Path)
      Object.assign(harvester, { x: spot.x, y: spot.y, ordered: false, scoutX: NONE, scoutY: NONE })
    }
    const center = centerOf(spot)
    if (Math.hypot(center.x - position.x, center.y - position.y) > HARVEST_REACH) {
      // Едет — пусть едет; не доехал — через RETRY_TICKS путь прокладывается заново.
      if (!world.has(entity, Path) && retry) moves.push({ entity, ...center, near: APPROACH })
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
  for (const { entity, x, y, near } of moves) orderMove(sim, entity, Math.floor(x), Math.floor(y), undefined, 0, near)
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
