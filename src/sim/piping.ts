import type { Entity } from '../ecs'
import { tileKey } from '../map/terrain'
import { BUILDINGS, CORE, UNDERGROUND_REACH, buildingSpec, isPipe, canPlace, placeBuilding, siteAt, type BuildingType } from './buildings'
import { Building, Inventory, Owner, Position, Site } from './components'
import type { Sim } from './sim'
import { assignBuilders, cancelBuild, refundOf } from './construction'
import { addCredits, pay } from './economy'
import { PAVE_LIMIT } from './paving'
import { allZones, inForeignZone, linkGap, networkOf, type Zone } from './zones'

/**
 * Прокладка труб: протяжка наземной трубы, пары колодцев и трассы, которыми тесты и готовые базы (тестовая карта,
 * витрина) соединяют здания без стройки.
 */

/** Дальше скольких тайлов pipeRoute трассу не ищет. */
export const ROUTE_REACH = 16

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/**
 * Трасса наземной трубы от основания (x, y, width, height) до узла сети игрока: тайлы x, y подряд, от основания
 * к сети. Пусто — к основанию уже подходит своя труба. undefined — сети ближе ROUTE_REACH нет. Узел сети —
 * готовая труба или колодец, готовое здание сети (кроме стен) или заложенная своя труба. joins — какую сеть
 * годится брать; без него — любую. planned — тайлы, уже занятые другой заложенной трассой.
 */
export function pipeRoute(sim: Sim, player: number, x: number, y: number, width: number, height: number, joins?: (zone: Zone) => boolean, planned?: ReadonlySet<number>): number[] | undefined {
  const { world, occupancy } = sim
  const inside = (tx: number, ty: number) => tx >= x && tx < x + width && ty >= y && ty < y + height
  /** Заложенные свои трубы: к ним подключаются, как к готовым. */
  const sites = new Set<number>()
  for (const [, position, site, owner] of world.query(Position, Site, Owner)) {
    if (owner.player === player && !site.demolish && buildingSpec(site.type).pipe) sites.add(tileKey(position.x, position.y))
  }
  const node = (tx: number, ty: number, pipeOnly: boolean) => {
    if (inside(tx, ty)) return false
    if (sites.has(tileKey(tx, ty))) return !joins
    const other = occupancy.at(tx, ty)
    if (other === undefined || world.get(other, Owner)?.player !== player || world.has(other, Site)) return false
    const type = world.get(other, Building)!.type
    if (pipeOnly && !buildingSpec(type).pipe) return false
    const zone = networkOf(sim, other)
    return !!zone && (!joins || joins(zone))
  }
  // К основанию уже подведена своя труба.
  for (let tx = x; tx < x + width; tx++) if (node(tx, y - 1, true) || node(tx, y + height, true)) return []
  for (let ty = y; ty < y + height; ty++) if (node(x - 1, ty, true) || node(x + width, ty, true)) return []

  const free = (tx: number, ty: number) => !inside(tx, ty) && !planned?.has(tileKey(tx, ty)) && !sites.has(tileKey(tx, ty)) && canPlace(sim, 'pipe', tx, ty)
  const previous = new Map<number, number>()
  const queue: number[] = []
  const start = (tx: number, ty: number) => {
    const key = tileKey(tx, ty)
    if (previous.has(key) || !free(tx, ty)) return
    previous.set(key, -1)
    queue.push(tx, ty, 1)
  }
  for (let tx = x; tx < x + width; tx++) {
    start(tx, y - 1)
    start(tx, y + height)
  }
  for (let ty = y; ty < y + height; ty++) {
    start(x - 1, ty)
    start(x + width, ty)
  }
  for (let at = 0; at < queue.length; at += 3) {
    const tx = queue[at]
    const ty = queue[at + 1]
    const length = queue[at + 2]
    if (SIDES.some(([dx, dy]) => node(tx + dx, ty + dy, false))) {
      // Назад по цепочке — от сети к основанию; трасса нужна в обратном порядке.
      const back: number[] = []
      for (let i = at; i >= 0; i = previous.get(tileKey(queue[i], queue[i + 1]))!) back.push(queue[i], queue[i + 1])
      const tiles: number[] = []
      for (let i = back.length - 2; i >= 0; i -= 2) tiles.push(back[i], back[i + 1])
      return tiles
    }
    if (length >= ROUTE_REACH) continue
    for (const [dx, dy] of SIDES) {
      const key = tileKey(tx + dx, ty + dy)
      if (previous.has(key) || !free(tx + dx, ty + dy)) continue
      previous.set(key, at)
      queue.push(tx + dx, ty + dy, length + 1)
    }
  }
  return undefined
}

/**
 * Соединяет трубами все сети игрока с первой (с главным зданием): готовые трубы сразу, без стройки. Для готовых баз
 * тестовой карты, витрины и редактора. Сеть, до которой трассы не нашлось, остаётся отдельной.
 */
export function connectAll(sim: Sim, player: number) {
  for (let joined = true; joined; ) {
    joined = false
    const zones = allZones(sim).get(player) ?? []
    if (zones.length < 2) return
    const main = zones[0]
    for (const zone of zones.slice(1)) {
      const entity = zone.buildings.find((item) => !buildingSpec(sim.world.get(item, Building)!.type).pipe) ?? zone.buildings[0]
      const position = sim.world.get(entity, Position)!
      const { width, height } = BUILDINGS[sim.world.get(entity, Building)!.type as BuildingType]
      const tiles = pipeRoute(sim, player, position.x, position.y, width, height, (other) => other === main)
      if (!tiles?.length) continue
      for (let i = 0; i < tiles.length; i += 2) placeBuilding(sim.world, 'pipe', tiles[i], tiles[i + 1], player)
      joined = true
      break
    }
  }
}

/**
 * Что подключит узел связи с центром (cx, cy) и радиусом reach: свои здания, трубы и стройки, кроме узлов и стен.
 * Для показа при установке узла.
 */
export function hubTargets(sim: Sim, player: number, cx: number, cy: number, reach: number) {
  const found: { x: number; y: number; width: number; height: number; ready: boolean }[] = []
  for (const [entity, position, owner] of sim.world.query(Position, Owner)) {
    const site = sim.world.get(entity, Site)
    const type = sim.world.get(entity, Building)?.type ?? site?.type
    if (owner.player !== player || type === undefined || site?.demolish) continue
    const spec = buildingSpec(type)
    if (spec.link || spec.isolated) continue
    const { width, height } = BUILDINGS[type]
    if (linkGap(cx, cy, position.x, position.y, width, height) <= reach) found.push({ x: position.x, y: position.y, width, height, ready: !site })
  }
  return found
}

/** Готовые свои узлы связи, радиус которых задевает основание (x, y, width, height): их центры. */
export function hubsReaching(sim: Sim, player: number, x: number, y: number, width: number, height: number) {
  const found: { x: number; y: number }[] = []
  for (const [entity, position, building, owner] of sim.world.query(Position, Building, Owner)) {
    const reach = buildingSpec(building.type).link
    if (!reach || owner.player !== player || sim.world.has(entity, Site)) continue
    const cx = position.x + BUILDINGS[building.type].width / 2
    const cy = position.y + BUILDINGS[building.type].height / 2
    if (linkGap(cx, cy, x, y, width, height) <= reach) found.push({ x: cx, y: cy })
  }
  return found
}

/**
 * Подключает готовое здание к ближайшей другой своей сети готовой трубой, без стройки: так ставят здания в обход
 * стройки редактор и тесты. Возвращает уложенные трубы; пусто — сети рядом нет или труба уже подходит.
 */
export function connectBuilding(sim: Sim, building: Entity): Entity[] {
  const { world } = sim
  const player = world.get(building, Owner)?.player ?? 0
  const type = world.get(building, Building)?.type
  if (!player || type === undefined || buildingSpec(type).pipe || buildingSpec(type).isolated) return []
  const own = networkOf(sim, building)
  const position = world.get(building, Position)!
  const { width, height } = BUILDINGS[type]
  const tiles = pipeRoute(sim, player, position.x, position.y, width, height, (zone) => zone !== own) ?? []
  const pipes: Entity[] = []
  for (let i = 0; i < tiles.length; i += 2) pipes.push(placeBuilding(world, 'pipe', tiles[i], tiles[i + 1], player))
  return pipes
}

/**
 * С какими своими колодцами связался бы колодец в тайле (x, y): ближайший по прямой в каждую сторону, не дальше
 * UNDERGROUND_REACH и не вплотную (вплотную он связан как наземная труба). Как считает сеть, см. zones.ts; заложенные
 * колодцы тоже в счёте — ready у них false: связь появится, когда достроят.
 */
export function wellPartners(sim: Sim, player: number, x: number, y: number) {
  const { world, occupancy } = sim
  const sites = new Map<number, Entity>()
  for (const [entity, position, site, owner] of world.query(Position, Site, Owner)) {
    if (owner.player === player && site.type === 'well' && !site.demolish) sites.set(tileKey(position.x, position.y), entity)
  }
  const found: { x: number; y: number; ready: boolean }[] = []
  for (const [dx, dy] of SIDES) {
    for (let step = 2; step <= UNDERGROUND_REACH; step++) {
      const tx = x + dx * step
      const ty = y + dy * step
      const other = occupancy.at(tx, ty)
      const ready = other !== undefined && world.get(other, Building)?.type === 'well' && world.get(other, Owner)?.player === player && !world.has(other, Site)
      if (!ready && !sites.has(tileKey(tx, ty))) continue
      found.push({ x: tx, y: ty, ready })
      break
    }
  }
  return found
}

/** Вид трубы: наземная или колодец. */
export type PipeKind = 'pipe' | 'well'

/** Вид своей трубы в тайле, см. pipeAt; undefined — её там нет. */
function pipeKindAt(sim: Sim, player: number, x: number, y: number): PipeKind | undefined {
  const entity = pipeAt(sim, player, x, y)
  if (entity === undefined) return undefined
  return (sim.world.get(entity, Building)?.type ?? sim.world.get(entity, Site)!.type) as PipeKind
}

/**
 * Своя труба другого вида в тайле: наземная там, куда кладут колодец, и колодец там, куда кладут наземную. Новая
 * ложится вместо неё, см. replacePipe. undefined — такой нет.
 */
export function pipeSwap(sim: Sim, player: number, kind: PipeKind, x: number, y: number): Entity | undefined {
  const other = pipeKindAt(sim, player, x, y)
  return other !== undefined && other !== kind ? pipeAt(sim, player, x, y) : undefined
}

/** Стоит ли в тайле свой колодец — готовый, строящийся или заложенный: с ним свяжется новый, см. orderWells. */
export const wellAt = (sim: Sim, player: number, x: number, y: number) => pipeKindAt(sim, player, x, y) === 'well'

/**
 * Убирает трубу, вместо которой кладут другую: не начатую и недостроенную — как отмену стройки, с возвратом цены,
 * готовую — сразу, с возвратом как за разбор.
 */
function replacePipe(sim: Sim, player: number, entity: Entity) {
  if (sim.world.has(entity, Site)) return void cancelBuild(sim, player, entity)
  addCredits(sim, player, refundOf(sim.world.get(entity, Building)!.type))
  sim.world.destroy(entity)
}

/**
 * Какие тайлы протянутой трубы вида kind можно заложить, по тайлу: место годится под трубу или там своя труба
 * другого вида (её заменят, см. pipeSwap), и оно не в чужой зоне. Своя зона трубе не нужна: её тянут куда угодно.
 * Кредиты здесь не считаются.
 */
export function pipeStroke(sim: Sim, player: number, tiles: readonly number[], kind: PipeKind = 'pipe'): boolean[] {
  const taken = new Set<number>()
  const allowed: boolean[] = []
  for (let i = 0; i + 1 < tiles.length; i += 2) {
    const x = tiles[i]
    const y = tiles[i + 1]
    const fits = Number.isInteger(x) && Number.isInteger(y) && (canPlace(sim, 'pipe', x, y) || pipeSwap(sim, player, kind, x, y) !== undefined)
    const ok = !taken.has(tileKey(x, y)) && fits && !inForeignZone(sim, player, x, y, 1, 1)
    if (ok) taken.add(tileKey(x, y))
    allowed.push(ok)
  }
  return allowed
}

/**
 * Закладывает протянутую наземную трубу (тайлы x, y подряд, по порядку протяжки) и посылает к ней строителей.
 * Платят за каждый тайл сразу; на что не хватило кредитов и куда нельзя (см. pipeStroke) — не кладут; без кредитов
 * цепочка дальше не тянется. Свой колодец на её пути заменяется трубой. Возвращает, сколько заложено.
 */
export function orderPipes(sim: Sim, player: number, tiles: readonly number[], builders: Entity[]) {
  const allowed = pipeStroke(sim, player, tiles.slice(0, PAVE_LIMIT * 2))
  let first: Entity | undefined
  let count = 0
  for (let i = 0; i < allowed.length; i++) {
    // Негодный тайл пропускается, как в предпросмотре; кончились кредиты — цепочка дальше не тянется.
    if (!allowed[i]) continue
    if (!pay(sim, player, BUILDINGS.pipe.cost)) break
    // Свой колодец на пути трубы заменяется ею.
    const swap = pipeSwap(sim, player, 'pipe', tiles[i * 2], tiles[i * 2 + 1])
    if (swap !== undefined) replacePipe(sim, player, swap)
    const site = sim.world.spawn(Position({ x: tiles[i * 2], y: tiles[i * 2 + 1] }), Site({ type: 'pipe' }), Owner({ player }))
    first ??= site
    count++
  }
  if (first !== undefined) assignBuilders(sim, player, first, builders)
  return count
}

/**
 * Своя труба или колодец в тайле — готовые, строящиеся или только заложенные; undefined — такой нет или её уже
 * разбирают. Её снимает инструмент «Снять» вместе с покрытием, см. removePave.
 */
export function pipeAt(sim: Sim, player: number, x: number, y: number): Entity | undefined {
  const { world } = sim
  const entity = sim.occupancy.at(x, y) ?? siteAt(sim, x, y)
  if (entity === undefined || world.get(entity, Owner)?.player !== player) return undefined
  const site = world.get(entity, Site)
  const type = world.get(entity, Building)?.type ?? site?.type
  return type !== undefined && buildingSpec(type).pipe && !site?.demolish ? entity : undefined
}

/**
 * Каким концам пары колодцев уже стоит свой колодец, по концу: такой конец не закладывают заново. Так второй колодец
 * тянут от стоящего — протяжка только держит его на прямой и не дальше UNDERGROUND_REACH.
 */
export function wellsKept(sim: Sim, player: number, tiles: readonly number[]): boolean[] {
  const kept: boolean[] = []
  for (let i = 0; i + 1 < tiles.length; i += 2) kept.push(tiles.length === 4 && wellAt(sim, player, tiles[i], tiles[i + 1]))
  return kept
}

/**
 * Закладывает колодцы и посылает к ним строителей: один (tiles — его x, y; свяжется с уже стоящим по прямой, см.
 * wellPartners) или пару — концы подземного отрезка (x, y первого и второго): на одной прямой, от 2
 * до UNDERGROUND_REACH тайлов. Каждый — где можно положить трубу (см. pipeStroke); своя наземная труба в этом тайле
 * заменяется колодцем. Конец пары, где свой колодец уже стоит, остаётся как есть: закладывают только другой.
 * Пару кладут целиком или никак. Возвращает, заложено ли.
 */
export function orderWells(sim: Sim, player: number, tiles: readonly number[], builders: Entity[]) {
  const single = tiles.length === 2 && tiles.every(Number.isInteger)
  if (!single && !isWellPair(tiles)) return false
  const kept = wellsKept(sim, player, tiles)
  const fits = pipeStroke(sim, player, tiles, 'well')
  const fresh = kept.filter((item) => !item).length
  if (!fresh || !fits.every((ok, i) => ok || kept[i])) return false
  if (!pay(sim, player, BUILDINGS.well.cost * fresh)) return false
  let first: Entity | undefined
  for (let i = 0; i < tiles.length; i += 2) {
    if (kept[i >> 1]) continue
    const swap = pipeSwap(sim, player, 'well', tiles[i], tiles[i + 1])
    if (swap !== undefined) replacePipe(sim, player, swap)
    const site = sim.world.spawn(Position({ x: tiles[i], y: tiles[i + 1] }), Site({ type: 'well' }), Owner({ player }))
    first ??= site
  }
  assignBuilders(sim, player, first!, builders)
  return true
}

/** Годятся ли тайлы концами подземного отрезка: два целых тайла на одной прямой, от 2 до UNDERGROUND_REACH. */
export function isWellPair(tiles: readonly number[]) {
  if (tiles.length !== 4 || !tiles.every(Number.isInteger)) return false
  const [ax, ay, bx, by] = tiles
  const length = Math.abs(bx - ax) + Math.abs(by - ay)
  return (ax === bx || ay === by) && length >= 2 && length <= UNDERGROUND_REACH
}

/**
 * Не подключено к сети: готовое здание игрока со складом, которое ни с чем не соединено трубой или узлом — ресурсы
 * к нему не придут и от него не уйдут. Главное здание не в счёт: с него сеть начинается.
 */
export function unlinked(sim: Sim, player: number, entity: Entity) {
  const { world } = sim
  const type = world.get(entity, Building)?.type
  if (type === undefined || type === CORE || isPipe(type) || world.has(entity, Site)) return false
  if (world.get(entity, Owner)?.player !== player || !world.has(entity, Inventory)) return false
  return (networkOf(sim, entity)?.buildings.length ?? 1) <= 1
}
