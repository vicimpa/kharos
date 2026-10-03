import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, isReady } from './buildings'
import { NONE, isOwn } from './common'
import { Building, Converting, Crafter, Hauler, Inventory, Owner, Path, Position, Producer, Site, Trade, Unit } from './components'
import { depositAt } from './deposits'
import { amountOf, loadOf, roomFor } from './inventory'
import { entriesOf, type Amounts, type Resource } from './resources'
import type { Sim } from './sim'
import { deliveredTo, isStore } from './trade'
import { unitSpec } from './units'
import { inCircles, zonesOf, type Zone } from './zones'

/**
 * Зональные заявки. Всё, что потребляет ресурсы, само заказывает их у своей зоны строительства: стройка — материалы
 * на здание, производитель — материалы на первый заказ очереди, перерабатывающее здание — сырьё, космопорт — товар
 * по заявке на продажу. Свободные грузовики игрока берут самую важную заявку и везут ресурс из хранилищ той же зоны
 * (или прямо из шахты или перерабатывающего здания в ней). Когда заявок нет, они развозят добытое и переработанное
 * из шахт и перерабатывающих зданий по хранилищам. Игроку не нужно указывать каждому грузовику, что и куда везти.
 */

/** Заявка: складу to не хватает amount ресурса resource. Чем выше priority, тем раньше её везут. */
export interface Request {
  to: Entity
  resource: Resource
  amount: number
  priority: number
  zone: Zone
}

/** Что важнее везти: стройка, потом производство юнитов, потом сырьё на переработку, потом товар на продажу. */
export const PRIORITY = { site: 4, production: 3, craft: 2, trade: 1 } as const

/** Сколько тайлов пути перевешивает одна ступень важности: ближняя мелкая заявка не обгоняет важную дальнюю. */
const PRIORITY_WEIGHT = 1000
/** Перерабатывающее здание заказывает сырьё, когда его меньше этой доли запаса: так грузовики возят полные кузова. */
const REFILL_SHARE = 0.5
/**
 * Сколько добытого или переработанного должно накопиться, чтобы за ним поехал грузовик и увёз в хранилище:
 * PUSH_MIN единиц или половина того, что здание вмещает, — что меньше.
 */
const PUSH_MIN = 10
const PUSH_SHARE = 0.5
/** Заявки меньше этого не возят. */
const MIN_JOB = 0.5

/** Груз грузовиков: сколько каждого ресурса едет на склады и сколько ещё заберут со складов. */
interface Flows {
  incoming: Map<Entity, Amounts>
  outgoing: Map<Entity, Amounts>
}

const add = (map: Map<Entity, Amounts>, entity: Entity, resource: Resource, amount: number) => {
  if (amount <= 0) return
  let amounts = map.get(entity)
  if (!amounts) map.set(entity, (amounts = {}))
  amounts[resource] = (amounts[resource] ?? 0) + amount
}

/**
 * Что сейчас везут грузовики. Набравший груз везёт то, что в кузове; ещё не набравший обещал привезти и забрать
 * столько, сколько в его работе.
 */
function flowsOf(sim: Sim): Flows {
  const flows: Flows = { incoming: new Map(), outgoing: new Map() }
  for (const [, hauler, cargo] of sim.world.query(Hauler, Inventory)) {
    if (hauler.from === NONE && hauler.to === NONE) continue
    const carried = amountOf(cargo, hauler.resource)
    if (hauler.to !== NONE) add(flows.incoming, hauler.to as Entity, hauler.resource, hauler.full ? carried : Math.max(carried, hauler.amount))
    if (hauler.from !== NONE && !hauler.full) add(flows.outgoing, hauler.from as Entity, hauler.resource, hauler.amount - carried)
  }
  return flows
}

/** Сколько ресурса уже едет на склад в кузовах грузовиков. */
export const incomingTo = (sim: Sim, entity: Entity, resource: Resource) => flowsOf(sim).incoming.get(entity)?.[resource] ?? 0

/** Сколько ресурса склада занято заявкой на продажу: его не тратят на производство. */
function reservedIn(sim: Sim, entity: Entity, resource: Resource) {
  const order = sim.world.get(entity, Trade)
  return order && order.resource === resource ? deliveredTo(sim, entity) : 0
}

/** Сколько ресурса на складе можно потратить на нужды самого здания: всё, кроме товара на продажу. */
export function spareOf(sim: Sim, entity: Entity, resource: Resource) {
  const inventory = sim.world.get(entity, Inventory)
  return inventory ? Math.max(0, amountOf(inventory, resource) - reservedIn(sim, entity, resource)) : 0
}

/**
 * Материалы, которых ждёт сущность: стройка — на здание, производитель — на первый заказ очереди, пока тот не начат.
 * undefined — ничего не ждёт.
 */
export function materialsFor(sim: Sim, entity: Entity): Amounts | undefined {
  const { world } = sim
  const site = world.get(entity, Site)
  if (site) return site.demolish ? undefined : buildingSpec(site.type).materials
  const producer = world.get(entity, Producer)
  const [head] = producer?.queue ?? []
  if (!producer || !head || producer.progress > 0) return undefined
  return unitSpec(head).materials
}

/** Чего из материалов ещё нет на складе: пусто — всё на месте. */
export function missingFor(sim: Sim, entity: Entity): Amounts {
  const missing: Amounts = {}
  for (const [resource, amount] of entriesOf(materialsFor(sim, entity) ?? {})) {
    const lack = amount - spareOf(sim, entity, resource)
    if (lack > 1e-9) missing[resource] = lack
  }
  return missing
}

/** Центр здания или место юнита. */
function centerOf(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const type = sim.world.get(entity, Building)?.type ?? sim.world.get(entity, Site)?.type
  if (type === undefined) return position
  return { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2 }
}

const distance = (sim: Sim, a: Entity, b: Entity) => {
  const one = centerOf(sim, a)
  const two = centerOf(sim, b)
  return Math.hypot(one.x - two.x, one.y - two.y)
}

/** Что добывает шахта: вид месторождения под ней. */
export function mineKind(sim: Sim, mine: Entity): Resource | undefined {
  const position = sim.world.get(mine, Position)
  return position ? depositAt(sim, position.x, position.y)?.kind : undefined
}

/** Что здание отдаёт как готовое: шахта — добытое, перерабатывающее — выход рецепта. Хранилища сюда не входят. */
function outputsOf(sim: Sim, entity: Entity): Resource[] {
  const type = sim.world.get(entity, Building)?.type
  if (type === undefined || sim.world.has(entity, Site)) return []
  const spec = buildingSpec(type)
  if (spec.extract) {
    const kind = mineKind(sim, entity)
    return kind ? [kind] : []
  }
  return spec.recipe ? entriesOf(spec.recipe.outputs).map(([resource]) => resource) : []
}

/** Заявки зон игрока: что, куда и сколько везти, с учётом того, что уже едет. */
export function requestsOf(sim: Sim, player: number, flows = flowsOf(sim)): Request[] {
  const { world } = sim
  const zones = zonesOf(sim, player)
  const requests: Request[] = []
  const zoneOf = (entity: Entity) => {
    const { x, y } = centerOf(sim, entity)
    return zones.find((zone) => zone.buildings.includes(entity) || inCircles(zone.circles, x, y))
  }
  const need = (to: Entity, resource: Resource, amount: number, priority: number) => {
    const left = amount - (flows.incoming.get(to)?.[resource] ?? 0)
    if (left < MIN_JOB) return
    const zone = zoneOf(to)
    if (zone) requests.push({ to, resource, amount: left, priority, zone })
  }

  // Стройки и производство: материалы, которых нет на месте.
  for (const [entity, owner] of world.query(Owner, Inventory)) {
    if (owner.player !== player) continue
    const site = world.has(entity, Site)
    if (!site && !world.has(entity, Producer)) continue
    if (!site && (!isReady(sim, player, entity) || world.has(entity, Converting))) continue
    for (const [resource, amount] of entriesOf(missingFor(sim, entity))) need(entity, resource, amount, site ? PRIORITY.site : PRIORITY.production)
  }
  // Переработка: сырьё до полного запаса, когда его стало мало.
  for (const [entity, , , inventory] of world.query(Crafter, Building, Inventory)) {
    if (!isReady(sim, player, entity)) continue
    for (const [resource] of entriesOf(buildingSpec(world.get(entity, Building)!.type).recipe!.inputs)) {
      const limit = inventory.limits[resource] ?? 0
      const have = amountOf(inventory, resource) + (flows.incoming.get(entity)?.[resource] ?? 0)
      if (have <= limit * REFILL_SHARE) need(entity, resource, limit - amountOf(inventory, resource), PRIORITY.craft)
    }
  }
  // Продажа: товар заявки.
  for (const [entity, order] of world.query(Trade, Inventory)) {
    if (order.total > 0 || !isReady(sim, player, entity)) continue
    need(entity, order.resource, order.wanted - deliveredTo(sim, entity), PRIORITY.trade)
  }
  return requests.sort((a, b) => b.priority - a.priority)
}

/** Сколько ресурса можно забрать со склада, кроме того, что уже обещано другим грузовикам. */
const availableIn = (sim: Sim, flows: Flows, entity: Entity, resource: Resource) =>
  Math.max(0, spareOf(sim, entity, resource) - (flows.outgoing.get(entity)?.[resource] ?? 0))

/** Работа грузовику: откуда, куда, что и сколько. to = NONE — куда везти, решится, когда наберёт груз. */
export interface Job {
  from: Entity
  to: Entity
  resource: Resource
  amount: number
}

/** Ближайшее к грузовику своё хранилище, куда поместится ресурс; NONE — места нет нигде. */
export function storeFor(sim: Sim, truck: Entity, resource: Resource, except: Entity = NONE as Entity): Entity {
  const player = sim.world.get(truck, Owner)?.player ?? 0
  let best = NONE as Entity
  let bestDistance = Infinity
  for (const [entity, inventory] of sim.world.query(Inventory, Building)) {
    if (entity === except || !isStore(sim, entity) || !isReady(sim, player, entity) || sim.world.has(entity, Converting)) continue
    if (roomFor(inventory, resource) <= 1e-9) continue
    const far = distance(sim, truck, entity)
    if (far < bestDistance) {
      best = entity
      bestDistance = far
    }
  }
  return best
}

/**
 * Годится ли склад, чтобы выгрузить в него ресурс: своё хранилище с местом или то, что этот ресурс заказывало
 * (стройка, производитель, перерабатывающее здание, космопорт с заявкой на него).
 */
export function acceptsDelivery(sim: Sim, player: number, to: Entity, resource: Resource) {
  const { world } = sim
  const inventory = world.get(to, Inventory)
  if (!inventory || !isOwn(sim, player, to) || roomFor(inventory, resource) <= 1e-9) return false
  if (world.has(to, Site)) return !!materialsFor(sim, to)?.[resource]
  if (!isReady(sim, player, to) || world.has(to, Converting)) return false
  if (isStore(sim, to)) return true
  const order = world.get(to, Trade)
  if (order) return order.total <= 0 && order.resource === resource
  if (world.has(to, Crafter)) return inventory.accepts.includes(resource)
  return !!materialsFor(sim, to)?.[resource]
}

/** Можно ли забирать ресурс со склада: свой готовый склад, где он есть. */
export function offersPickup(sim: Sim, player: number, from: Entity, resource: Resource) {
  return isReady(sim, player, from) && spareOf(sim, from, resource) > 1e-9
}

/** Свободен ли грузовик для диспетчера: не привязан к шахте, без работы и груза, стоит. */
const isIdle = (sim: Sim, truck: Entity) => {
  const { world } = sim
  const hauler = world.get(truck, Hauler)!
  const cargo = world.get(truck, Inventory)
  return hauler.mine === NONE && hauler.from === NONE && hauler.to === NONE && (!cargo || loadOf(cargo) <= 1e-9) && !world.has(truck, Path) && !world.has(truck, Converting)
}

/**
 * Раздаёт работу свободным грузовикам. Каждому — лучшая из заявок его игрока: важнее и ближе (путь до склада,
 * откуда брать, и оттуда до заказчика). Ресурс берётся только в зоне заказчика. Если заявок, которые можно
 * выполнить, нет — грузовик увозит в хранилище накопленное в шахте или перерабатывающем здании.
 */
export function dispatch(sim: Sim) {
  const { world } = sim
  const idle = new Map<number, Entity[]>()
  for (const [entity, , owner] of world.query(Hauler, Owner, Unit)) {
    if (!isIdle(sim, entity)) continue
    let list = idle.get(owner.player)
    if (!list) idle.set(owner.player, (list = []))
    list.push(entity)
  }
  if (!idle.size) return
  const flows = flowsOf(sim)

  for (const [player, trucks] of idle) {
    const requests = requestsOf(sim, player, flows)
    // Откуда брать: хранилища, шахты и перерабатывающие здания игрока.
    const sources: Entity[] = []
    for (const [entity] of world.query(Inventory, Building, Owner)) {
      if (!isReady(sim, player, entity) || world.has(entity, Converting)) continue
      if (isStore(sim, entity) || outputsOf(sim, entity).length) sources.push(entity)
    }

    for (const truck of trucks) {
      const room = world.get(truck, Inventory)?.capacity ?? 0
      let best: (Job & { score: number }) | undefined
      for (const request of requests) {
        if (request.amount < MIN_JOB) continue
        for (const source of request.zone.buildings) {
          if (source === request.to || !sources.includes(source)) continue
          if (!isStore(sim, source) && !outputsOf(sim, source).includes(request.resource)) continue
          const available = availableIn(sim, flows, source, request.resource)
          if (available < Math.min(request.amount, MIN_JOB)) continue
          const score = request.priority * PRIORITY_WEIGHT - distance(sim, truck, source) - distance(sim, source, request.to)
          if (best && score <= best.score) continue
          best = { from: source, to: request.to, resource: request.resource, amount: Math.min(request.amount, available, room), score }
        }
      }
      if (!best) {
        // Заявок нет — развозит накопленное по хранилищам; куда именно, решит, когда наберёт груз.
        for (const source of sources) {
          for (const resource of outputsOf(sim, source)) {
            const available = availableIn(sim, flows, source, resource)
            const inventory = world.get(source, Inventory)!
            const holds = Math.min(inventory.limits[resource] ?? inventory.capacity, inventory.capacity)
            if (available < Math.min(PUSH_MIN, room, holds * PUSH_SHARE)) continue
            const score = -distance(sim, truck, source)
            if (best && score <= best.score) continue
            best = { from: source, to: NONE as Entity, resource, amount: Math.min(available, room), score }
          }
        }
      }
      if (!best) continue
      const hauler = world.get(truck, Hauler)!
      hauler.from = best.from
      hauler.to = best.to
      hauler.resource = best.resource
      hauler.amount = best.amount
      hauler.full = false
      hauler.waiting = false
      add(flows.outgoing, best.from, best.resource, best.amount)
      if (best.to !== NONE) {
        add(flows.incoming, best.to, best.resource, best.amount)
        const request = requests.find((item) => item.to === best!.to && item.resource === best!.resource)
        if (request) request.amount -= best.amount
      }
    }
  }
}
