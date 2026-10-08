import type { Entity } from '../ecs'
import { Terrain, isCliffFoot, setTile, terrainAt, tileBytes, tileKey } from '../map/terrain'
import { canPlace, placeBuilding, type BuildingType } from './buildings'
import { Attached, Carrier, Health, Inventory, Owner, Path, Player, Position, Unit } from './components'
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
  followCarriers(sim)
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
  followCarriers(sim)
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
