import type { Entity } from '../ecs'
import { Terrain, isBuildable, isCliffFoot, setTile, terrainAt, tileBytes, tileKey } from '../map/terrain'
import { BUILDINGS, canPlace, placeBuilding, type BuildingType } from './buildings'
import { Attached, Builds, Building, Carrier, Ghost, Harvester, Turret, Health, Inventory, Owner, Path, Player, Position, Unit } from './components'
import { DEPOSIT_CELL, DEPOSIT_SIZE, addDeposit, depositAt, depositsIn, depositNear, dropDeposit, prepareDeposits, reserveLeft, type DepositKind, type DepositSpot } from './deposits'
import { creditsOf, addCredits } from './economy'
import { releaseHauler } from './hauling'
import { apply, type Command } from './commands'
import { NONE, wrap } from './common'
import { stopAttack } from './combat'
import { clearOrders } from './orders'
import { clearTactics } from './tactics'
import type { Good } from './resources'
import type { Sim } from './sim'
import { followCarriers } from './turrets'
import { UNITS, flies, isWalkable, spawnUnit, type UnitType } from './units'

/**
 * Редактор сохранений — режим бога. Симуляция в нём стоит: тиков нет, мир правится напрямую, и в сохранение ложится
 * ровно то, что поставили. Правки не проверяются на деньги, технологии и строителей, но правила места — те же, что
 * в игре: здание не встаёт туда, где его нельзя построить, юнит — туда, где ему не стоять.
 */

/**
 * Турели встают на носители. Мир стоит, поэтому их прошлое место — нынешнее: иначе турель рисовалась бы на полпути от
 * старого места носителя.
 */
function settle(sim: Sim) {
  followCarriers(sim)
  for (const [, position, turret] of sim.world.query(Position, Turret)) Object.assign(turret, { prevX: position.x, prevY: position.y, prevAngle: turret.angle })
}

/** Чем красит кисть карты: что не задано, остаётся у тайла прежним. */
export interface Brush {
  terrain?: Terrain
  tier?: number
  cliff?: boolean
}

/**
 * Красит тайлы в квадрате со стороной size вокруг (x, y). Правка — сразу правда для всех: игроки не узнают её из
 * тумана, а видят новую карту, как будто мир таким и сгенерирован. Горы кистью не ставятся, но стираются.
 */
export function paint(sim: Sim, x: number, y: number, size: number, brush: Brush) {
  const { bounds, land, landMemory } = sim
  const from = Math.floor(size / 2)
  // Месторождения вокруг считаются по карте до правки: кисть их не создаёт и не двигает.
  prepareDeposits(sim, x - from, y - from, x - from + size - 1, y - from + size - 1)
  for (let tileY = y - from; tileY < y - from + size; tileY++) {
    for (let tileX = x - from; tileX < x - from + size; tileX++) {
      if (tileX < bounds.left || tileY < bounds.top || tileX >= bounds.right || tileY >= bounds.bottom) continue
      const [type, biome, , relief] = tileBytes(land, tileX, tileY)
      const mountain = type === Terrain.Mountain
      const terrain = brush.terrain ?? (mountain ? Terrain.Rock : (type as Terrain))
      // У гор в байте рельефа — вершина, а не ярус: стёртая гора становится скалой первого яруса.
      const tier = brush.tier ?? (mountain ? 1 : relief & 3)
      const cliff = brush.cliff ?? (mountain ? false : (relief & 4) !== 0)
      setTile(land, tileX, tileY, { terrain, biome, tier, cliff })
      // Знание игроков об этом тайле больше не нужно: новое видят все.
      const key = tileKey(tileX, tileY)
      landMemory.original.delete(key)
      for (const known of landMemory.known.values()) known.delete(key)
    }
  }
}

/** Игроки мира, по возрастанию номера. */
export function playersOf(sim: Sim): number[] {
  const ids = new Set<number>()
  for (const [, player] of sim.world.query(Player)) ids.add(player.id)
  for (const [, owner] of sim.world.query(Owner)) if (owner.player) ids.add(owner.player)
  return [...ids].sort((a, b) => a - b)
}

/** Заводит нового игрока без кредитов и возвращает его номер. */
export function addPlayer(sim: Sim) {
  const id = Math.max(0, ...playersOf(sim)) + 1
  addCredits(sim, id, 0)
  return id
}

/** Ставит игроку ровно столько кредитов. */
export function setCredits(sim: Sim, player: number, credits: number) {
  addCredits(sim, player, Math.max(0, Math.round(credits)) - creditsOf(sim, player))
}

/** Ставит готовое здание игроку player (0 — ничьё) левым верхним углом в (x, y), если оно там встанет. */
export function putBuilding(sim: Sim, type: BuildingType, x: number, y: number, player: number): Entity | undefined {
  if (!canPlace(sim, type, x, y)) return undefined
  if (player) addCredits(sim, player, 0)
  return placeBuilding(sim.world, type, x, y, player)
}

/** Может ли юнит вида type стоять на тайле (x, y): наземному — проходимо и не у подножия обрыва (пехоте — можно). */
export function canPut(sim: Sim, type: UnitType, x: number, y: number) {
  const { bounds } = sim
  if (flies(type)) return x >= bounds.left && y >= bounds.top && x < bounds.right && y < bounds.bottom
  return isWalkable(sim, x, y, UNITS[type].kind === 'infantry')
}

/** Ставит юнит игроку player на тайл (x, y), если ему там стоять. */
export function putUnit(sim: Sim, type: UnitType, x: number, y: number, player: number): Entity | undefined {
  if (!canPut(sim, type, x, y)) return undefined
  addCredits(sim, player, 0)
  const unit = spawnUnit(sim, type, player, x, y)
  settle(sim)
  return unit
}

/** Переносит юнит на тайл (x, y), если ему там стоять. Здания не переносятся: их сносят и ставят заново. */
export function moveUnit(sim: Sim, entity: Entity, x: number, y: number) {
  const { world } = sim
  const unit = world.get(entity, Unit)
  const position = world.get(entity, Position)
  if (!unit || !position || !canPut(sim, unit.type, x, y)) return false
  Object.assign(position, { x: x + 0.5, y: y + 0.5 })
  Object.assign(unit, { prevX: x + 0.5, prevY: y + 0.5 })
  world.remove(entity, Path)
  settle(sim)
  return true
}

/** Убирает здание или юнит вместе с его турелями, без взрыва и без груза на земле. */
export function erase(sim: Sim, entity: Entity) {
  const { world } = sim
  if (!world.alive(entity) || world.has(entity, Attached)) return
  releaseHauler(sim, entity)
  for (const turret of world.get(entity, Carrier)?.turrets ?? []) if (world.alive(turret as Entity)) world.destroy(turret as Entity)
  world.destroy(entity)
}

/** Передаёт здание или юнит игроку player вместе с турелями. */
export function setOwner(sim: Sim, entity: Entity, player: number) {
  const { world } = sim
  if (player) addCredits(sim, player, 0)
  for (const target of [entity, ...((world.get(entity, Carrier)?.turrets ?? []) as Entity[])]) {
    if (world.has(target, Owner)) world.set(target, Owner, { player })
  }
}

/** Прочность — доля от полной, от 1% до 100%. */
export function setHealth(sim: Sim, entity: Entity, share: number) {
  const health = sim.world.get(entity, Health)
  if (health) health.value = health.max * Math.min(1, Math.max(0.01, share))
}

/** Кладёт на склад ровно amount груза. Объём и пределы склада не мешают: это бог, а не грузовик. */
export function setStock(sim: Sim, entity: Entity, good: Good, amount: number) {
  const inventory = sim.world.get(entity, Inventory)
  if (!inventory) return
  const value = Math.max(0, Math.round(amount))
  if (value) inventory.items[good] = value
  else delete inventory.items[good]
}

/** Что под тайлом (x, y) для редактора: юнит, если он там стоит, иначе здание. */
export function entityAt(sim: Sim, x: number, y: number): Entity | undefined {
  let best: Entity | undefined
  let nearest = Infinity
  for (const [entity, position, unit] of sim.world.query(Position, Unit)) {
    if (sim.world.has(entity, Ghost)) continue
    const distance = Math.hypot(position.x - x, position.y - y)
    if (distance <= Math.max(0.5, UNITS[unit.type].radius) && distance < nearest) {
      nearest = distance
      best = entity
    }
  }
  return best ?? sim.occupancy.at(Math.floor(x), Math.floor(y))
}

/** Тайл для подписи в панели: тип, ярус, обрыв и подножие. */
export function describeTile(sim: Sim, x: number, y: number) {
  const [, , , relief] = tileBytes(sim.land, x, y)
  const terrain = terrainAt(sim.land, x, y)
  const mountain = terrain === Terrain.Mountain
  return { terrain, tier: mountain ? undefined : relief & 3, cliff: !mountain && (relief & 4) !== 0, foot: isCliffFoot(sim.land, x, y) }
}

/** Месторождение под точкой (x, y): то, на чьи тайлы она попала, или null. */
export function depositUnder(sim: Sim, x: number, y: number): DepositSpot | null {
  const spot = depositNear(sim, x, y, DEPOSIT_SIZE)
  return spot && x >= spot.x && x < spot.x + DEPOSIT_SIZE && y >= spot.y && y < spot.y + DEPOSIT_SIZE ? spot : null
}

/**
 * Можно ли положить месторождение левым верхним тайлом в (x, y): там, где встала бы шахта, — скала не у подножия
 * обрыва, — и не внахлёст с другим месторождением. ignore — месторождения, которые переносят: они уйдут со своих мест.
 */
export function canPutDeposit(sim: Sim, x: number, y: number, ignore: readonly DepositSpot[] = []) {
  const { bounds, land } = sim
  if (x < bounds.left || y < bounds.top || x + DEPOSIT_SIZE > bounds.right || y + DEPOSIT_SIZE > bounds.bottom) return false
  for (let cellY = Math.floor((y - DEPOSIT_SIZE) / DEPOSIT_CELL); cellY <= Math.floor((y + DEPOSIT_SIZE) / DEPOSIT_CELL); cellY++) {
    for (let cellX = Math.floor((x - DEPOSIT_SIZE) / DEPOSIT_CELL); cellX <= Math.floor((x + DEPOSIT_SIZE) / DEPOSIT_CELL); cellX++) {
      for (const other of depositsIn(sim, cellX, cellY)) {
        if (ignore.some((spot) => spot.x === other.x && spot.y === other.y)) continue
        if (Math.abs(other.x - x) < DEPOSIT_SIZE && Math.abs(other.y - y) < DEPOSIT_SIZE) return false
      }
    }
  }
  for (let tileY = y; tileY < y + DEPOSIT_SIZE; tileY++) {
    for (let tileX = x; tileX < x + DEPOSIT_SIZE; tileX++) if (!isBuildable(terrainAt(land, tileX, tileY)) || isCliffFoot(land, tileX, tileY)) return false
  }
  return true
}

/** Кладёт ещё одно месторождение вида kind с запасом reserve левым верхним тайлом в (x, y); прежние остаются, где были. */
export function putDeposit(sim: Sim, x: number, y: number, kind: DepositKind, reserve: number, ignore: readonly DepositSpot[] = []) {
  if (!canPutDeposit(sim, x, y, ignore)) return false
  addDeposit(sim, { x, y, kind, reserve: Math.max(0, Math.round(reserve)) })
  return true
}

/** Меняет месторождению вид и сколько в нём осталось. */
export function setDeposit(sim: Sim, spot: DepositSpot, kind: DepositKind, left: number) {
  // Добытое забывается: запас — ровно столько, сколько осталось.
  dropDeposit(sim, spot.x, spot.y)
  addDeposit(sim, { x: spot.x, y: spot.y, kind, reserve: Math.max(0, Math.round(left)) })
}

/** Убирает месторождение. */
export function removeDeposit(sim: Sim, spot: DepositSpot) {
  dropDeposit(sim, spot.x, spot.y)
}

/**
 * Призрак юнита под указателем: юнит, который встанет по щелчку, нарисован полупрозрачным. Он в мире, но не в счёт:
 * его не выбрать, а перед сохранением его убирают. Возвращает призрак; undefined — показывать нечего.
 */
export function moveGhost(sim: Sim, ghost: Entity | undefined, type: UnitType, player: number, x: number, y: number): Entity | undefined {
  const { world } = sim
  if (ghost !== undefined && world.alive(ghost) && world.get(ghost, Unit)?.type === type && world.get(ghost, Owner)?.player === player) {
    const position = world.get(ghost, Position)!
    Object.assign(position, { x: x + 0.5, y: y + 0.5 })
    Object.assign(world.get(ghost, Unit)!, { prevX: x + 0.5, prevY: y + 0.5 })
    world.get(ghost, Ghost)!.blocked = !canPut(sim, type, x, y)
    settle(sim)
    return ghost
  }
  if (ghost !== undefined) erase(sim, ghost)
  const entity = spawnUnit(sim, type, player, x, y)
  world.add(entity, Ghost({ blocked: !canPut(sim, type, x, y) }))
  settle(sim)
  return entity
}

/**
 * Сдвигает юниты, здания и месторождения вместе на (dx, dy) тайлов: всё или ничего. Здания встают по правилам места,
 * юниты — где им стоять, месторождения — где их можно положить; друг другу сдвигаемые не мешают — места, откуда они
 * ушли, свободны. Возвращает новые места месторождений или null, если сдвинуть нельзя.
 */
export function moveGroup(sim: Sim, entities: Iterable<Entity>, dx: number, dy: number, deposits: readonly DepositSpot[] = []): DepositSpot[] | null {
  const { world } = sim
  if (!dx && !dy) return [...deposits]
  if (!deposits.every((spot) => canPutDeposit(sim, spot.x + dx, spot.y + dy, deposits))) return null
  const buildings: { entity: Entity; x: number; y: number; type: BuildingType }[] = []
  const units: { entity: Entity; x: number; y: number }[] = []
  for (const entity of entities) {
    const position = world.get(entity, Position)
    if (!position || !world.alive(entity) || world.has(entity, Ghost)) continue
    const building = world.get(entity, Building)
    if (building) buildings.push({ entity, x: position.x, y: position.y, type: building.type })
    else if (world.has(entity, Unit)) units.push({ entity, x: position.x, y: position.y })
  }
  // Здания снимаются с места: занятость тайлов следит за Position, см. createOccupancy.
  for (const { entity } of buildings) world.remove(entity, Position)
  const placed: Entity[] = []
  let ok = true
  for (const { entity, x, y, type } of buildings) {
    if (!canPlace(sim, type, x + dx, y + dy)) {
      ok = false
      break
    }
    world.add(entity, Position({ x: x + dx, y: y + dy }))
    placed.push(entity)
  }
  ok &&= units.every(({ entity, x, y }) => canPut(sim, world.get(entity, Unit)!.type, Math.floor(x + dx), Math.floor(y + dy)))
  if (!ok) {
    for (const entity of placed) world.remove(entity, Position)
    for (const { entity, x, y } of buildings) world.add(entity, Position({ x, y }))
    return null
  }
  for (const { entity, x, y } of units) {
    Object.assign(world.get(entity, Position)!, { x: x + dx, y: y + dy })
    Object.assign(world.get(entity, Unit)!, { prevX: x + dx, prevY: y + dy })
    world.remove(entity, Path)
  }
  // Месторождения сначала все уходят, потом все встают: иначе первое встало бы на ещё не освобождённое место второго.
  const moving = deposits.map((spot) => ({ ...spot, left: reserveLeft(sim, spot.x, spot.y) }))
  for (const spot of moving) removeDeposit(sim, spot)
  for (const spot of moving) putDeposit(sim, spot.x + dx, spot.y + dy, spot.kind, spot.left, deposits)
  settle(sim)
  return moving.map((spot) => depositAt(sim, spot.x + dx, spot.y + dy)!)
}

/** Месторождения, середина которых в прямоугольнике в тайлах. */
export function depositsInBox(sim: Sim, left: number, top: number, right: number, bottom: number): DepositSpot[] {
  const found: DepositSpot[] = []
  for (let cellY = Math.floor((top - DEPOSIT_SIZE) / DEPOSIT_CELL); cellY <= Math.floor(bottom / DEPOSIT_CELL); cellY++) {
    for (let cellX = Math.floor((left - DEPOSIT_SIZE) / DEPOSIT_CELL); cellX <= Math.floor(right / DEPOSIT_CELL); cellX++) {
      for (const spot of depositsIn(sim, cellX, cellY)) {
        const x = spot.x + DEPOSIT_SIZE / 2
        const y = spot.y + DEPOSIT_SIZE / 2
        if (x >= left && x <= right && y >= top && y <= bottom) found.push(spot)
      }
    }
  }
  return found
}

/** Куда смотрит юнит, в радианах: корпус поворачивается сразу, без сглаживания. */
export function setFacing(sim: Sim, entity: Entity, facing: number) {
  const unit = sim.world.get(entity, Unit)
  if (!unit) return
  unit.facing = unit.prevFacing = wrap(facing)
  settle(sim)
}

/**
 * Куда смотрят турели юнита или здания, в радианах на карте: турель поворачивается относительно носителя.
 * index — только эта турель по порядку креплений; нет — все.
 */
export function setTurretFacing(sim: Sim, entity: Entity, facing: number, index?: number) {
  const { world } = sim
  const base = world.get(entity, Unit)?.facing ?? 0
  const turrets = (world.get(entity, Carrier)?.turrets ?? []) as Entity[]
  for (const [i, turret] of turrets.entries()) {
    const state = world.get(turret, Turret)
    if (state && (index === undefined || index === i)) state.angle = state.prevAngle = wrap(facing - base)
  }
}

/** Куда смотрит каждая турель юнита или здания, в радианах на карте, по порядку креплений. */
export function turretFacings(sim: Sim, entity: Entity): number[] {
  const { world } = sim
  const base = world.get(entity, Unit)?.facing ?? 0
  const facings: number[] = []
  for (const turret of (world.get(entity, Carrier)?.turrets ?? []) as Entity[]) {
    const state = world.get(turret, Turret)
    if (state) facings.push(wrap(state.angle + base))
  }
  return facings
}

/** Снимает с юнита все задания: путь, стройку, цель, груз, месторождение, патруль и очередь приказов. */
export function clearTasks(sim: Sim, entity: Entity) {
  const { world } = sim
  clearOrders(sim, [entity])
  world.remove(entity, Path)
  world.remove(entity, Builds)
  const harvester = world.get(entity, Harvester)
  if (harvester) Object.assign(harvester, { x: NONE, y: NONE, ordered: false, parked: true, seek: '' })
  releaseHauler(sim, entity)
  stopAttack(sim, entity)
  clearTactics(sim, entity)
}

/** Выполняет приказ игрока player сразу, а не в начале тика: мир в редакторе стоит. */
export function orderNow(sim: Sim, player: number, command: Command) {
  const done = apply(sim, player, command)
  settle(sim)
  return done
}

/** Юниты и здания, середина которых в прямоугольнике в тайлах. */
export function entitiesIn(sim: Sim, left: number, top: number, right: number, bottom: number): Entity[] {
  const { world } = sim
  const found: Entity[] = []
  for (const [entity, position] of world.query(Position)) {
    if (world.has(entity, Ghost)) continue
    const building = world.get(entity, Building)
    if (!building && !world.has(entity, Unit)) continue
    const x = building ? position.x + BUILDINGS[building.type].width / 2 : position.x
    const y = building ? position.y + BUILDINGS[building.type].height / 2 : position.y
    if (x >= left && x <= right && y >= top && y <= bottom) found.push(entity)
  }
  return found
}

/** Переносит месторождение левым верхним тайлом в (x, y) вместе с видом и остатком. Возвращает новое место или null. */
export function moveDeposit(sim: Sim, spot: DepositSpot, x: number, y: number): DepositSpot | null {
  if (spot.x === x && spot.y === y) return spot
  return moveGroup(sim, [], x - spot.x, y - spot.y, [spot])?.[0] ?? null
}
