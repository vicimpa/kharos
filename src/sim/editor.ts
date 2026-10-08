import type { Entity } from '../ecs'
import { Terrain, isBuildable, isCliffFoot, setTile, terrainAt, tileBytes, tileKey } from '../map/terrain'
import { BUILDINGS, canPlace, placeBuilding, type BuildingType } from './buildings'
import { Attached, Building, Carrier, Deposit, Ghost, Turret, Health, Inventory, Owner, Path, Player, Position, Unit } from './components'
import { DEPOSIT_CELL, DEPOSIT_SIZE, depositEntity, depositAt, depositsIn, depositNear, forgetDeposits, reserveLeft, type DepositKind, type DepositSpot } from './deposits'
import { creditsOf, addCredits } from './economy'
import { releaseHauler } from './hauling'
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
  // Месторождения лежат только на скале: после правки карты они считаются заново.
  forgetDeposits(sim)
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

/** Запись правок месторождения с левым верхним тайлом (x, y): сущность Deposit там, новая — если её нет. */
function depositRecord(sim: Sim, x: number, y: number) {
  const entity = depositEntity(sim, x, y) ?? sim.world.spawn(Position({ x, y }), Deposit())
  return sim.world.get(entity, Deposit)!
}

/**
 * Можно ли положить месторождение левым верхним тайлом в (x, y): там, где встала бы шахта, — скала не у подножия
 * обрыва, — и не внахлёст с другим месторождением. ignore — месторождение, которое сюда переносят: ему не мешает оно само.
 */
export function canPutDeposit(sim: Sim, x: number, y: number, ignore?: DepositSpot) {
  const { bounds, land } = sim
  if (x < bounds.left || y < bounds.top || x + DEPOSIT_SIZE > bounds.right || y + DEPOSIT_SIZE > bounds.bottom) return false
  for (let cellY = Math.floor((y - DEPOSIT_SIZE) / DEPOSIT_CELL); cellY <= Math.floor((y + DEPOSIT_SIZE) / DEPOSIT_CELL); cellY++) {
    for (let cellX = Math.floor((x - DEPOSIT_SIZE) / DEPOSIT_CELL); cellX <= Math.floor((x + DEPOSIT_SIZE) / DEPOSIT_CELL); cellX++) {
      for (const other of depositsIn(sim, cellX, cellY)) {
        if (ignore && other.x === ignore.x && other.y === ignore.y) continue
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
export function putDeposit(sim: Sim, x: number, y: number, kind: DepositKind, reserve: number, ignore?: DepositSpot) {
  if (!canPutDeposit(sim, x, y, ignore)) return false
  Object.assign(depositRecord(sim, x, y), { kind, reserve: Math.max(0, Math.round(reserve)), mined: 0, gone: false })
  forgetDeposits(sim)
  return true
}

/** Меняет месторождению вид и сколько в нём осталось. */
export function setDeposit(sim: Sim, spot: DepositSpot, kind: DepositKind, left: number) {
  Object.assign(depositRecord(sim, spot.x, spot.y), { kind, reserve: Math.max(0, Math.round(left)), mined: 0, gone: false })
  forgetDeposits(sim)
}

/** Убирает месторождение. */
export function removeDeposit(sim: Sim, spot: DepositSpot) {
  Object.assign(depositRecord(sim, spot.x, spot.y), { kind: '', gone: true })
  forgetDeposits(sim)
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
 * Сдвигает юниты и здания вместе на (dx, dy) тайлов: всё или ничего. Здания встают по правилам места, юниты — где им
 * стоять; друг другу сдвигаемые не мешают — места, откуда они ушли, свободны. Возвращает, удалось ли.
 */
export function moveGroup(sim: Sim, entities: Iterable<Entity>, dx: number, dy: number) {
  const { world } = sim
  if (!dx && !dy) return true
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
    return false
  }
  for (const { entity, x, y } of units) {
    Object.assign(world.get(entity, Position)!, { x: x + dx, y: y + dy })
    Object.assign(world.get(entity, Unit)!, { prevX: x + dx, prevY: y + dy })
    world.remove(entity, Path)
  }
  settle(sim)
  return true
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
  if (!canPutDeposit(sim, x, y, spot)) return null
  const left = reserveLeft(sim, spot.x, spot.y)
  removeDeposit(sim, spot)
  putDeposit(sim, x, y, spot.kind, left, spot)
  return depositAt(sim, x, y)
}
