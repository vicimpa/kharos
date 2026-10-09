import type { Entity } from '../ecs'
import { Terrain, isCliffFoot, isPassable, terrainAt, tileKey } from '../map/terrain'
import { BUILDINGS, CORE, siteAt, type BuildingType } from './buildings'
import { isOwn } from './common'
import { Building, Owner, Pave, Position, Repair, Site, Unit } from './components'
import { assignBuilders, cancelBuild, demolish } from './construction'
import { pipeAt } from './piping'
import { addCredits, pay } from './economy'
import type { Sim } from './sim'
import { inForeignZone } from './zones'
import { PAVE_KINDS, isPaved, type PaveKind } from './paved'

export { FOUNDATION_SPEED, PAVE_KINDS, ROAD_SPEED, createPaving, isPaved, type PaveKind, type Paving } from './paved'

/** Цена тайла фундамента. */
export const FOUNDATION_COST = 15
/** Цена тайла дороги. */
export const ROAD_COST = 5
/** Цена тайла моста — дороги по болоту. */
export const BRIDGE_COST = 20
/** Во сколько раз быстрее строится здание на фундаменте на скале. */
export const FOUNDATION_ROCK = 2
/** Скорость стройки на фундаменте на песке — доля скорости на голой скале. */
export const FOUNDATION_SAND = 0.8
/** Сколько тайлов можно заложить одной командой. */
export const PAVE_LIMIT = 400

/** Что стоит тайл покрытия: дорога по болоту — мост — дороже. */
export function paveCost(sim: Sim, kind: PaveKind, x: number, y: number) {
  if (kind === 'foundation') return FOUNDATION_COST
  return terrainAt(sim.land, x, y) === Terrain.Swamp ? BRIDGE_COST : ROAD_COST
}

/**
 * Можно ли игроку заложить покрытие в тайл: внутри карты, на свободном от покрытия, зданий и площадок месте,
 * не в чужой зоне и не у подножия обрыва. Фундамент — на скале или песке, дорога — где угодно, кроме гор. Своей
 * зоны покрытию не нужно.
 */
export function canPave(sim: Sim, player: number, kind: PaveKind, x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !PAVE_KINDS.includes(kind)) return false
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom) return false
  const terrain = terrainAt(sim.land, x, y)
  if (kind === 'foundation' ? terrain !== Terrain.Rock && terrain !== Terrain.Sand : !isPassable(terrain)) return false
  // У подножия обрыва стоит его стенка: класть туда нельзя, как и строить, см. canPlace.
  if (isCliffFoot(sim.land, x, y)) return false
  if (sim.paving.at(x, y) !== undefined || sim.occupancy.at(x, y) !== undefined || siteAt(sim, x, y) !== undefined) return false
  return !inForeignZone(sim, player, x, y, 1, 1)
}

/**
 * Закладывает покрытие в тайлы (x и y подряд) и посылает к нему строителей. Платят за каждый тайл сразу; на что
 * не хватило кредитов и куда нельзя — не кладут. Дальше по соседним тайлам строители пойдут сами. Возвращает,
 * сколько заложено.
 */
export function orderPave(sim: Sim, player: number, kind: PaveKind, tiles: readonly number[], builders: Entity[]) {
  let first: Entity | undefined
  let count = 0
  for (let i = 0; i + 1 < tiles.length && i < PAVE_LIMIT * 2; i += 2) {
    const x = tiles[i]
    const y = tiles[i + 1]
    if (!canPave(sim, player, kind, x, y) || !pay(sim, player, paveCost(sim, kind, x, y))) continue
    const entity = sim.world.spawn(Position({ x, y }), Pave({ kind }), Owner({ player }))
    first ??= entity
    count++
  }
  if (first !== undefined) assignBuilders(sim, player, first, builders)
  return count
}

/**
 * Разбирает строителями своё на тайлах: покрытие, трубы с колодцами и здания, основание которых целиком попало
 * в тайлы (главное здание не разбирают — его сворачивают). Недостроенное покрытие и не начатые стройки отменяются
 * сразу, с возвратом кредитов целиком; готовое покрытие строители разбирают без возврата, готовые трубы и здания —
 * с возвратом половины цены. Без своих строителей среди units не разбирают ничего.
 */
export function removePave(sim: Sim, player: number, tiles: readonly number[], units: Entity[]) {
  const builders = units.filter((entity) => isOwn(sim, player, entity) && sim.world.has(entity, Repair) && sim.world.has(entity, Unit))
  if (!builders.length) return false
  let first: Entity | undefined
  let count = 0
  const taken: Entity[] = []
  const covered = new Set<number>()
  for (let i = 0; i + 1 < tiles.length && i < PAVE_LIMIT * 2; i += 2) covered.add(tileKey(tiles[i], tiles[i + 1]))
  for (let i = 0; i + 1 < tiles.length && i < PAVE_LIMIT * 2; i += 2) {
    // Трубу снимают, даже если рамка задела её одним тайлом: она сама в тайл.
    const pipe = pipeAt(sim, player, tiles[i], tiles[i + 1])
    if (pipe !== undefined && !taken.includes(pipe)) taken.push(pipe)
    const building = buildingWithin(sim, player, tiles[i], tiles[i + 1], covered)
    if (building !== undefined && !taken.includes(building)) taken.push(building)
    const entity = sim.paving.at(tiles[i], tiles[i + 1])
    if (entity === undefined || !isOwn(sim, player, entity)) continue
    const pave = sim.world.get(entity, Pave)!
    count++
    if (!pave.done) {
      addCredits(sim, player, paveCost(sim, pave.kind, tiles[i], tiles[i + 1]))
      sim.world.destroy(entity)
      continue
    }
    pave.remove = true
    first ??= entity
  }
  for (const entity of taken) {
    count++
    // Стройку отменяют целиком, с возвратом, как площадку; готовое строители разбирают.
    if (sim.world.has(entity, Site)) cancelBuild(sim, player, entity)
    else if (demolish(sim, player, entity, [])) first ??= entity
  }
  if (first !== undefined) assignBuilders(sim, player, first, builders)
  return count > 0
}

/**
 * Своё здание или стройка в тайле (x, y), основание которого целиком лежит в covered (ключи tileKey);
 * undefined — такого нет. Главное здание и то, что уже разбирают, не в счёт.
 */
export function buildingWithin(sim: Sim, player: number, x: number, y: number, covered: ReadonlySet<number>): Entity | undefined {
  const { world } = sim
  const entity = sim.occupancy.at(x, y) ?? siteAt(sim, x, y)
  if (entity === undefined || !isOwn(sim, player, entity)) return undefined
  const site = world.get(entity, Site)
  const type = world.get(entity, Building)?.type ?? site?.type
  if (type === undefined || type === CORE || site?.demolish) return undefined
  const position = world.get(entity, Position)!
  const { width, height } = BUILDINGS[type]
  for (let ty = position.y; ty < position.y + height; ty++) {
    for (let tx = position.x; tx < position.x + width; tx++) if (!covered.has(tileKey(tx, ty))) return undefined
  }
  return entity
}

/**
 * Во сколько раз быстрее голой скалы строится здание на этом месте: по самому медленному тайлу основания.
 * Фундамент на скале ускоряет, на песке — разрешает стройку, но чуть медленнее скалы.
 */
export function buildSpeed(sim: Sim, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  let speed = Infinity
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      if (!isPaved(sim, 'foundation', tileX, tileY)) speed = Math.min(speed, 1)
      else speed = Math.min(speed, terrainAt(sim.land, tileX, tileY) === Terrain.Sand ? FOUNDATION_SAND : FOUNDATION_ROCK)
    }
  }
  return speed === Infinity ? 1 : speed
}
