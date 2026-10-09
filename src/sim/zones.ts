import type { Entity, World } from '../ecs'
import { BUILDINGS, CORE, UNDERGROUND_REACH, buildingSpec, type BuildingSpec } from './buildings'
import { Building, Inventory, Owner, Position, Site } from './components'
import type { Sim } from './sim'

/** Радиус зоны строительства вокруг главного здания, в тайлах от его центра. */
export const CONTROL_RADIUS = BUILDINGS.command.zone
/** На сколько тайлов от своего центра расширяет зону любое другое готовое здание. */
export const EXPAND_RADIUS = 5

/** Расстояние от точки (cx, cy) до основания (x, y, width, height): так узел связи меряет, задевает ли его радиус. */
export const linkGap = (cx: number, cy: number, x: number, y: number, width: number, height: number) =>
  Math.hypot(Math.max(x - cx, 0, cx - x - width), Math.max(y - cy, 0, cy - y - height))

/** Попадает ли точка хотя бы в один круг. circles — x, y и радиус подряд. */
export function inCircles(circles: readonly number[], x: number, y: number) {
  for (let i = 0; i < circles.length; i += 3) {
    if (Math.hypot(x - circles[i], y - circles[i + 1]) <= circles[i + 2]) return true
  }
  return false
}

/**
 * Зона строительства — она же сеть труб: связная группа готовых зданий и труб игрока. Запас, энергия и доставка
 * у каждой сети свои. Здания связаны, только если их соединяет труба: соседство не считается.
 */
export interface Zone {
  /** Круги, из которых зона состоит: x, y и радиус подряд. */
  circles: number[]
  /** Готовые здания и трубы сети, начиная с главного здания, если оно в ней есть. */
  buildings: Entity[]
  /** Стройки, к основанию которых подведена труба сети или которые в радиусе её узла: им сеть везёт материалы. Зону они не расширяют. */
  sites: Entity[]
  /** Граф сети: рёбра a, b и длина в тайлах подряд. Узлы — здания, трубы и стройки. */
  edges: number[]
}

/** Посчитанные сети мира: пересчитываются, только когда появилось или пропало здание или стройка. */
interface Cache {
  zones?: Map<number, Zone[]>
  /** В какой сети каждое здание, труба и подключённая стройка. */
  index?: Map<Entity, Zone>
}
const caches = new WeakMap<World, Cache>()

function cacheOf(world: World) {
  let cache = caches.get(world)
  if (!cache) {
    const fresh: Cache = {}
    const reset = () => {
      fresh.zones = fresh.index = undefined
      return () => void (fresh.zones = fresh.index = undefined)
    }
    world.observe([Building], reset)
    world.observe([Site], reset)
    caches.set(world, (cache = fresh))
  }
  return cache
}

/** Забыть посчитанные сети: так делают, когда меняется то, за чем кэш сам не следит. */
export const resetZones = (sim: Sim) => {
  const cache = cacheOf(sim.world)
  cache.zones = cache.index = undefined
}

/**
 * Сети труб всех игроков, у каждого игрока — сначала сети с главным зданием. Сеть — связная группа готовых зданий
 * и труб: труба связывает соседние по стороне трубы и здания, колодец — ещё и с ближайшим своим колодцем по прямой
 * (подземный отрезок, см. BuildingSpec.pipe), узел связи — со всем своим в радиусе (BuildingSpec.link). Здание без
 * трубы и узла — сеть само по себе. Зону сети составляют круги её
 * зданий (BuildingSpec.zone, expand или EXPAND_RADIUS) и труб (PIPE_REACH). Стена в сеть не входит.
 */
export function allZones(sim: Sim): Map<number, Zone[]> {
  const cache = cacheOf(sim.world)
  if (!cache.zones) {
    cache.zones = computeZones(sim)
    cache.index = new Map()
    for (const zones of cache.zones.values()) {
      for (const zone of zones) for (const entity of [...zone.buildings, ...zone.sites]) cache.index.set(entity, zone)
    }
  }
  return cache.zones
}

/** Сеть, в которую входит здание, труба или подключённая стройка; undefined — ни в какую. */
export function networkOf(sim: Sim, entity: Entity): Zone | undefined {
  allZones(sim)
  return cacheOf(sim.world).index!.get(entity)
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

function computeZones(sim: Sim): Map<number, Zone[]> {
  const { world, occupancy } = sim
  /** Готовые здания и трубы, которые входят в сети: сущность — игрок. */
  const members = new Map<Entity, number>()
  for (const [entity, building, owner] of world.query(Building, Owner)) {
    if (world.has(entity, Site) || buildingSpec(building.type).isolated) continue
    members.set(entity, owner.player)
  }
  const parent = new Map<Entity, Entity>()
  const find = (entity: Entity): Entity => {
    let root = entity
    while (parent.has(root)) root = parent.get(root)!
    while (entity !== root) {
      const next = parent.get(entity)!
      parent.set(entity, root)
      entity = next
    }
    return root
  }
  const edges: number[] = []
  const link = (a: Entity, b: Entity, length: number) => {
    edges.push(a, b, length)
    const one = find(a)
    const two = find(b)
    if (one !== two) parent.set(two, one)
  }
  const pipeOf = (entity: Entity) => buildingSpec(world.get(entity, Building)!.type).pipe
  for (const [entity, position, building] of world.query(Position, Building)) {
    const kind = buildingSpec(building.type).pipe
    const player = members.get(entity)
    if (!kind || player === undefined) continue
    for (const [dx, dy] of SIDES) {
      const other = occupancy.at(position.x + dx, position.y + dy)
      if (other === undefined || members.get(other) !== player) continue
      // Две соседние трубы видят друг друга дважды: ребро — от меньшей.
      if (pipeOf(other) && other < entity) continue
      link(entity, other, 1)
    }
    if (kind !== 'well') continue
    // Подземный отрезок — к ближайшему своему колодцу вправо и вниз: влево и вверх его найдёт тот колодец.
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      for (let step = 2; step <= UNDERGROUND_REACH; step++) {
        const other = occupancy.at(position.x + dx * step, position.y + dy * step)
        if (other === undefined || members.get(other) !== player || pipeOf(other) !== 'well') continue
        link(entity, other, step)
        break
      }
    }
  }

  // Узел связи — со всем своим, что задевает его радиус, кроме других узлов. Длина ребра — от центра узла до основания.
  const hubs: { entity: Entity; player: number; x: number; y: number; reach: number }[] = []
  for (const [entity, player] of members) {
    const type = world.get(entity, Building)!.type
    const reach = buildingSpec(type).link
    if (!reach) continue
    const position = world.get(entity, Position)!
    hubs.push({ entity, player, x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2, reach })
  }
  const gap = (hub: (typeof hubs)[number], x: number, y: number, width: number, height: number) => linkGap(hub.x, hub.y, x, y, width, height)
  for (const hub of hubs) {
    for (const [other, player] of members) {
      if (player !== hub.player || other === hub.entity) continue
      const type = world.get(other, Building)!.type
      if (buildingSpec(type).link) continue
      const position = world.get(other, Position)!
      const distance = gap(hub, position.x, position.y, BUILDINGS[type].width, BUILDINGS[type].height)
      if (distance <= hub.reach) link(hub.entity, other, Math.max(1, Math.round(distance)))
    }
  }

  const byRoot = new Map<Entity, Zone>()
  const result = new Map<number, Zone[]>()
  for (const [entity, player] of members) {
    const root = find(entity)
    let zone = byRoot.get(root)
    if (!zone) {
      byRoot.set(root, (zone = { circles: [], buildings: [], sites: [], edges: [] }))
      let list = result.get(player)
      if (!list) result.set(player, (list = []))
      list.push(zone)
    }
    const position = world.get(entity, Position)!
    const type = world.get(entity, Building)!.type
    const { width, height, zone: own, expand }: BuildingSpec = BUILDINGS[type]
    zone.circles.push(position.x + width / 2, position.y + height / 2, own ?? expand ?? EXPAND_RADIUS)
    if (type === CORE) zone.buildings.unshift(entity)
    else zone.buildings.push(entity)
  }
  for (let i = 0; i < edges.length; i += 3) byRoot.get(find(edges[i] as Entity))!.edges.push(edges[i], edges[i + 1], edges[i + 2])

  // Стройка входит в сеть первой трубы, подведённой к её основанию сбоку.
  for (const [entity, position, site, owner] of world.query(Position, Site, Owner)) {
    if (site.demolish || !world.has(entity, Inventory)) continue
    const { width, height } = BUILDINGS[site.type]
    let zone: Zone | undefined
    const touch = (x: number, y: number) => {
      const other = occupancy.at(x, y)
      if (other === undefined || members.get(other) !== owner.player || !pipeOf(other)) return
      const found = byRoot.get(find(other))!
      if (zone && zone !== found) return
      if (!zone) found.sites.push(entity)
      zone = found
      zone.edges.push(entity, other, 1)
    }
    for (let x = position.x; x < position.x + width; x++) {
      touch(x, position.y - 1)
      touch(x, position.y + height)
    }
    for (let y = position.y; y < position.y + height; y++) {
      touch(position.x - 1, y)
      touch(position.x + width, y)
    }
    // Узел связи подключает стройку в своём радиусе, как и здание.
    for (const hub of hubs) {
      if (hub.player !== owner.player || buildingSpec(site.type).link) continue
      const distance = gap(hub, position.x, position.y, width, height)
      if (distance > hub.reach) continue
      const found = byRoot.get(find(hub.entity))!
      if (zone && zone !== found) continue
      if (!zone) found.sites.push(entity)
      zone = found
      zone.edges.push(entity, hub.entity, Math.max(1, Math.round(distance)))
    }
  }
  // Сети с главным зданием — первыми: по первой сети игрока интерфейс показывает его энергию.
  for (const zones of result.values()) {
    zones.sort((a, b) => Number(isCore(world, b.buildings[0])) - Number(isCore(world, a.buildings[0])))
  }
  return result
}

const isCore = (world: World, entity: Entity) => world.get(entity, Building)?.type === CORE

const NONE: Zone[] = []

/** Зоны строительства одного игрока. */
export const zonesOf = (sim: Sim, player: number): readonly Zone[] => allZones(sim).get(player) ?? NONE

/** Все зоны игрока одним списком кругов: x, y и радиус подряд. */
export const zoneOf = (sim: Sim, player: number): readonly number[] => zonesOf(sim, player).flatMap((zone) => zone.circles)

/**
 * Задевает ли основание здания чужую зону строительства: в чужих зонах строить нельзя.
 * Проверяются центр и углы основания. Там, где зоны двух игроков перекрываются, не строит ни один.
 */
export function inForeignZone(sim: Sim, player: number, x: number, y: number, width: number, height: number) {
  for (const [other, zones] of allZones(sim)) {
    if (other === player) continue
    for (const { circles } of zones) {
      if (inCircles(circles, x + width / 2, y + height / 2)) return true
      if (inCircles(circles, x, y) || inCircles(circles, x + width, y)) return true
      if (inCircles(circles, x, y + height) || inCircles(circles, x + width, y + height)) return true
    }
  }
  return false
}
