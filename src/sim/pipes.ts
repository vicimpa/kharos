import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec } from './buildings'
import { NONE } from './common'
import { Assembly, Batch, Building, Inventory, Owner, Position, Site } from './components'
import { amountOf, put, roomFor, take } from './inventory'
import { flowsOf, offersOf, requestsOf, spareOf } from './logistics'
import { isProduct, type Good } from './resources'
import type { Sim } from './sim'
import { isStore } from './trade'
import { allZones, networkOf, type Zone } from './zones'

/**
 * Доставка по трубам. Внутри сети груз ходит пачками: заказчик (стройка, производство, переработка, цех, турель,
 * космопорт) берёт его у ближайшего по трубам поставщика своей сети, а переработка, цеха и космопорт сами развозят
 * готовое по хранилищам сети. Пачка — до BATCH единиц одного груза, идёт 1 тайл за тик; следующую по тому же
 * маршруту отправляют через тик после прихода. Труба ничего не держит и не занимается: маршрутов сколько угодно.
 * Перерезали трубу — пачки на ней пропадают.
 */

/** Сколько единиц груза самое большее идёт одной пачкой. */
export const BATCH = 5
/** Меньше этого пачкой не шлют, если заказчику нужно больше: иначе маршрут занимали бы крошки. */
const MIN_BATCH = 1
const EPSILON = 1e-9

/** Кратчайшие пути от одного узла сети: длина до каждого узла и следующий шаг к началу. */
interface Routes {
  dist: Map<Entity, number>
  next: Map<Entity, Entity>
}

/** Посчитанное для сети: соседи узлов и пути от узлов. Сеть пересчитывается целиком — и это вместе с ней. */
interface Graph {
  links: Map<Entity, [Entity, number][]>
  routes: Map<Entity, Routes>
}
const graphs = new WeakMap<Zone, Graph>()

function graphOf(zone: Zone): Graph {
  let graph = graphs.get(zone)
  if (!graph) {
    const links = new Map<Entity, [Entity, number][]>()
    const add = (a: Entity, b: Entity, length: number) => {
      let list = links.get(a)
      if (!list) links.set(a, (list = []))
      list.push([b, length])
    }
    for (let i = 0; i < zone.edges.length; i += 3) {
      add(zone.edges[i] as Entity, zone.edges[i + 1] as Entity, zone.edges[i + 2])
      add(zone.edges[i + 1] as Entity, zone.edges[i] as Entity, zone.edges[i + 2])
    }
    graphs.set(zone, (graph = { links, routes: new Map() }))
  }
  return graph
}

/** Кратчайшие пути по трубам сети от узла start до всех остальных (Дейкстра по графу сети). */
export function routesFrom(zone: Zone, start: Entity): Routes {
  const graph = graphOf(zone)
  let found = graph.routes.get(start)
  if (found) return found
  const dist = new Map<Entity, number>([[start, 0]])
  const next = new Map<Entity, Entity>()
  // Двоичная куча пар (длина, узел).
  const heap: [number, Entity][] = [[0, start]]
  const swap = (i: number, j: number) => ([heap[i], heap[j]] = [heap[j], heap[i]])
  while (heap.length) {
    const [length, node] = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ; ) {
        const left = i * 2 + 1
        const right = left + 1
        let least = i
        if (left < heap.length && heap[left][0] < heap[least][0]) least = left
        if (right < heap.length && heap[right][0] < heap[least][0]) least = right
        if (least === i) break
        swap(i, least)
        i = least
      }
    }
    if (length > dist.get(node)!) continue
    // Через стройку груз не идёт: она только принимает.
    if (node !== start && zone.sites.includes(node)) continue
    for (const [other, step] of graph.links.get(node) ?? []) {
      const total = length + step
      if (total >= (dist.get(other) ?? Infinity)) continue
      dist.set(other, total)
      next.set(other, node)
      heap.push([total, other])
      for (let i = heap.length - 1; i > 0; ) {
        const up = (i - 1) >> 1
        if (heap[up][0] <= heap[i][0]) break
        swap(i, up)
        i = up
      }
    }
  }
  graph.routes.set(start, (found = { dist, next }))
  return found
}

/** Середина узла сети: здания или стройки — центр основания, трубы — центр тайла. */
function centerOf(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const type = sim.world.get(entity, Building)?.type ?? sim.world.get(entity, Site)!.type
  return { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2 }
}

/**
 * Путь пачки от узла from по кратчайшим путям routes (посчитанным от to): узлы, где путь поворачивает, вместе
 * с началом и концом. Между соседними узлами списка путь прямой — так его рисует клиент.
 */
function pathOf(sim: Sim, routes: Routes, from: Entity, to: Entity): number[] {
  const nodes: Entity[] = [from]
  for (let node = from; node !== to; ) nodes.push((node = routes.next.get(node)!))
  if (nodes.length <= 2) return nodes
  const path: number[] = [from]
  const direction = (a: Entity, b: Entity) => {
    const one = centerOf(sim, a)
    const two = centerOf(sim, b)
    return `${Math.sign(two.x - one.x)},${Math.sign(two.y - one.y)}`
  }
  for (let i = 1; i < nodes.length - 1; i++) {
    if (direction(nodes[i - 1], nodes[i]) !== direction(nodes[i], nodes[i + 1])) path.push(nodes[i])
  }
  path.push(to)
  return path
}

/** Отправляет пачку: груз уходит со склада from сразу и придёт на склад to через столько тиков, сколько тайлов пути. */
function send(sim: Sim, player: number, from: Entity, to: Entity, resource: Good, amount: number, length: number, routes: Routes, push: boolean) {
  const taken = take(sim.world.get(from, Inventory)!, resource, amount)
  if (taken <= EPSILON) return
  const tick = sim.time.tick
  // Длина в тайлах: на тайл — тик, но не меньше одного.
  sim.world.spawn(Batch({ from, to, resource, amount: taken, sent: tick, arrive: tick + Math.max(1, Math.round(length)), push, path: push ? pathOf(sim, routes, to, from).reverse() : pathOf(sim, routes, from, to) }), Owner({ player }))
}

/** Цел ли путь пачки: все его узлы стоят и в одной сети с получателем. Иначе трубу перерезали, и пачка пропала. */
function intact(sim: Sim, path: readonly number[], to: Entity) {
  const zone = networkOf(sim, to)
  // Отправитель мог сгореть, когда пачка уже ушла: его не проверяют.
  return !!zone && path.slice(1).every((node) => networkOf(sim, node as Entity) === zone)
}

/** Пачка пришла: груз ложится на склад получателя; не поместилось — обратно отправителю или в хранилище сети. */
function deliver(sim: Sim, batch: { from: number; to: number; resource: Good; amount: number; path: number[] }) {
  const { world } = sim
  const to = batch.to as Entity
  if (!world.alive(to) || !intact(sim, batch.path, to)) return
  let left = batch.amount
  const inventory = world.get(to, Inventory)
  if (inventory) left -= put(inventory, batch.resource, left)
  if (left <= EPSILON) return
  const from = batch.from as Entity
  const zone = networkOf(sim, to)!
  for (const other of [from, ...zone.buildings]) {
    if (left <= EPSILON) break
    if (!world.alive(other) || networkOf(sim, other) !== zone || (other !== from && !isStore(sim, other))) continue
    const store = world.get(other, Inventory)
    if (store) left -= put(store, batch.resource, left)
  }
}

/** Куда класть готовое: склад отдаёт его, только когда в сети есть хранилище, где ему есть место. */
const OUTLET_MIN = BATCH

/**
 * Раз в тик: пришедшие пачки сгружаются, освободившиеся маршруты шлют следующие. Сначала заказы (по важности,
 * как у грузовиков, см. requestsOf), потом развоз готового по хранилищам.
 */
export function pipeFlow(sim: Sim) {
  const { world, time } = sim
  const tick = time.tick
  const finished: Entity[] = []
  /** Занятые маршруты: заказ — получатель и груз, развоз — отправитель и груз. */
  const busy = new Set<string>()
  for (const [entity, batch] of world.query(Batch)) {
    if (tick > batch.arrive) {
      finished.push(entity)
      continue
    }
    busy.add(batch.push ? `>${batch.from}:${batch.resource}` : `<${batch.to}:${batch.resource}`)
    if (tick === batch.arrive) deliver(sim, batch)
  }
  for (const entity of finished) world.destroy(entity)

  const zones = allZones(sim)
  if (!zones.size) return
  const flows = flowsOf(sim)
  for (const [player, list] of zones) {
    if (!player) continue
    for (const request of requestsOf(sim, player, flows)) {
      const key = `<${request.to}:${request.resource}`
      if (busy.has(key)) continue
      const zone = networkOf(sim, request.to)
      if (!zone) continue
      const routes = routesFrom(zone, request.to)
      let best = NONE as Entity
      let bestLength = Infinity
      let bestAmount = 0
      for (const source of zone.buildings) {
        const length = routes.dist.get(source)
        if (source === request.to || length === undefined || length >= bestLength) continue
        if (!offersOf(sim, source).includes(request.resource)) continue
        const available = spareOf(sim, source, request.resource)
        if (available < Math.min(request.amount, MIN_BATCH) - EPSILON) continue
        best = source
        bestLength = length
        bestAmount = Math.min(BATCH, request.amount, available)
      }
      if (best === NONE) continue
      busy.add(key)
      send(sim, player, best, request.to, request.resource, bestAmount, bestLength, routes, false)
    }
    for (const zone of list) pushOutlets(sim, player, zone, busy, flows.incoming)
  }
}

/**
 * Развоз готового: переработка, цеха и космопорт отправляют его в хранилища своей сети — по пачке, когда накопилось
 * на пачку, а остатки (сырьё прежнего рецепта цеха, закупку космопорта) — сколько есть. Хранилище — самое пустое
 * по этому грузу с учётом едущего туда, из равных — ближайшее по трубам.
 */
function pushOutlets(sim: Sim, player: number, zone: Zone, busy: Set<string>, incoming: Map<Entity, Partial<Record<Good, number>>>) {
  const { world } = sim
  const stores = zone.buildings.filter((entity) => isStore(sim, entity))
  if (!stores.length) return
  for (const source of zone.buildings) {
    const type = world.get(source, Building)!.type
    const spec = buildingSpec(type)
    if (!spec.refines && !spec.assembles && !spec.trades) continue
    const inventory = world.get(source, Inventory)
    if (!inventory) continue
    for (const resource of offersOf(sim, source)) {
      const key = `>${source}:${resource}`
      if (busy.has(key)) continue
      const available = spareOf(sim, source, resource)
      const leftover = !!spec.trades || (world.has(source, Assembly) && !isProduct(resource)) || (!!spec.refines && amountOf(inventory, spec.refines) <= EPSILON)
      if (available < (leftover ? EPSILON : OUTLET_MIN)) continue
      const routes = routesFrom(zone, source)
      let best = NONE as Entity
      let bestFill = Infinity
      let bestLength = Infinity
      let bestSpace = 0
      for (const store of stores) {
        const length = routes.dist.get(store)
        if (length === undefined) continue
        const held = world.get(store, Inventory)!
        const space = roomFor(held, resource) - (incoming.get(store)?.[resource] ?? 0)
        if (space <= EPSILON) continue
        const holds = Math.min(held.limits[resource] ?? held.capacity, held.capacity)
        const fill = Math.round((1 - space / holds) * 10)
        if (fill > bestFill || (fill === bestFill && length >= bestLength)) continue
        best = store
        bestFill = fill
        bestLength = length
        bestSpace = space
      }
      if (best === NONE) continue
      const amount = Math.min(BATCH, available, bestSpace)
      busy.add(key)
      let list = incoming.get(best)
      if (!list) incoming.set(best, (list = {}))
      list[resource] = (list[resource] ?? 0) + amount
      send(sim, player, source, best, resource, amount, bestLength, routes, true)
    }
  }
}
