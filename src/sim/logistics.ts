import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, isReady } from './buildings'
import { NONE, isOwn } from './common'
import { Building, Converting, Hauler, Inventory, Owner, Path, Position, Producer, Site, Trade, Unit } from './components'
import { depositAt } from './deposits'
import { amountOf, loadOf, roomFor } from './inventory'
import { entriesOf, isOre, ORE_OF, ORES, RESOURCES, type Amounts, type Good, type Ore } from './resources'
import type { Sim } from './sim'
import { deliveredTo, isStore } from './trade'
import { unitSpec } from './units'
import { inCircles, zonesOf, type Zone } from './zones'

/**
 * Зональные заявки. Всё, что потребляет груз, само заказывает его у своей зоны строительства: стройка — материалы
 * на здание, производитель — материалы на первый заказ очереди, космопорт — товар по заявке на продажу, переработка
 * — руду из шахт (её берут где угодно: месторождение решает, где шахта, а не зона). Свободные грузовики игрока
 * берут самую важную заявку и везут груз из хранилищ и переработки той же зоны. Когда заявок нет, они развозят
 * готовое по хранилищам. Руду без переработки никто не возит: она копится в шахте, пока завод не построят.
 * Игроку не нужно указывать каждому грузовику, что и куда везти.
 */

/** Заявка: складу to не хватает amount груза resource. Чем выше priority, тем раньше её везут. */
export interface Request {
  to: Entity
  resource: Good
  amount: number
  priority: number
  zone: Zone
  /** Где искать груз: в своей зоне (готовое) или в своих шахтах где угодно (руда). */
  source: 'zone' | 'mines'
}

/** Что важнее везти: стройка, потом руда на переработку, потом производство юнитов, потом товар на продажу. */
export const PRIORITY = { site: 4, refine: 3, production: 2, trade: 1 } as const

/** Сколько тайлов пути перевешивает одна ступень важности: ближняя мелкая заявка не обгоняет важную дальнюю. */
const PRIORITY_WEIGHT = 1000
/**
 * Сколько добытого должно накопиться, чтобы за ним поехал грузовик и увёз в хранилище: PUSH_MIN единиц
 * или половина того, что шахта вмещает, — что меньше.
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

const add = (map: Map<Entity, Amounts>, entity: Entity, resource: Good, amount: number) => {
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

/** Сколько груза уже едет на склад в кузовах грузовиков. */
export const incomingTo = (sim: Sim, entity: Entity, resource: Good) => flowsOf(sim).incoming.get(entity)?.[resource] ?? 0

/** Сколько груза склада занято заявкой на продажу: его не тратят на производство. */
function reservedIn(sim: Sim, entity: Entity, resource: Good) {
  const order = sim.world.get(entity, Trade)
  return order && order.resource === resource ? deliveredTo(sim, entity) : 0
}

/** Сколько груза на складе можно потратить на нужды самого здания: всё, кроме товара на продажу. */
export function spareOf(sim: Sim, entity: Entity, resource: Good) {
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

/** Какая руда лежит под шахтой: вид месторождения, переведённый в руду. */
export function mineOre(sim: Sim, mine: Entity): Ore | undefined {
  const position = sim.world.get(mine, Position)
  const kind = position ? depositAt(sim, position.x, position.y)?.kind : undefined
  return kind === undefined ? undefined : ORE_OF[kind]
}

const NOTHING_OFFERED: Good[] = []

/**
 * Что здание отдаёт по заявкам: хранилище и переработка — готовый ресурс, шахта — свою руду. Пусто — ничего.
 * Сколько груза есть на деле, решает availableIn; шахту это не касается, её руду берут только заявкой.
 */
function offersOf(sim: Sim, entity: Entity): Good[] {
  const type = sim.world.get(entity, Building)?.type
  if (type === undefined || sim.world.has(entity, Site)) return NOTHING_OFFERED
  const spec = buildingSpec(type)
  if (spec.stores || spec.refines) return RESOURCES
  if (!spec.extract) return NOTHING_OFFERED
  const ore = mineOre(sim, entity)
  return ore ? [ore] : NOTHING_OFFERED
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
  const need = (to: Entity, resource: Good, amount: number, priority: number, source: 'zone' | 'mines' = 'zone') => {
    const left = amount - (flows.incoming.get(to)?.[resource] ?? 0)
    if (left < MIN_JOB) return
    const zone = zoneOf(to)
    if (zone) requests.push({ to, resource, amount: left, priority, zone, source })
  }

  // Стройки и производство: материалы, которых нет на месте.
  for (const [entity, owner] of world.query(Owner, Inventory)) {
    if (owner.player !== player) continue
    const site = world.has(entity, Site)
    if (!site && !world.has(entity, Producer)) continue
    if (!site && (!isReady(sim, player, entity) || world.has(entity, Converting))) continue
    for (const [resource, amount] of entriesOf(missingFor(sim, entity))) need(entity, resource, amount, site ? PRIORITY.site : PRIORITY.production)
  }
  // Переработка: руда из своих шахт, в какой бы зоне они ни стояли.
  for (const [entity, owner, inventory, building] of world.query(Owner, Inventory, Building)) {
    if (owner.player !== player || !buildingSpec(building.type).refines) continue
    if (!isReady(sim, player, entity) || world.has(entity, Converting)) continue
    // Сколько ещё поместится: больше буфера руды завод не просит, пока не переработает привезённое.
    for (const ore of ORES) {
      const room = roomFor(inventory, ore)
      if (room > 0) need(entity, ore, room, PRIORITY.refine, 'mines')
    }
  }
  // Продажа: товар заявки.
  for (const [entity, order] of world.query(Trade, Inventory)) {
    if (order.total > 0 || !isReady(sim, player, entity)) continue
    need(entity, order.resource, order.wanted - deliveredTo(sim, entity), PRIORITY.trade)
  }
  return requests.sort((a, b) => b.priority - a.priority)
}

/** Сколько груза можно забрать со склада, кроме того, что уже обещано другим грузовикам. */
const availableIn = (sim: Sim, flows: Flows, entity: Entity, resource: Good) =>
  Math.max(0, spareOf(sim, entity, resource) - (flows.outgoing.get(entity)?.[resource] ?? 0))

/** Работа грузовику: откуда, куда, что и сколько. to = NONE — куда везти, решится, когда наберёт груз. */
export interface Job {
  from: Entity
  to: Entity
  resource: Good
  amount: number
}

/** Ближайшее к грузовику своё хранилище, куда поместится груз; NONE — места нет нигде. */
export function storeFor(sim: Sim, truck: Entity, resource: Good, except: Entity = NONE as Entity): Entity {
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

/** Ближайшая к грузовику своя переработка, куда поместится руда; NONE — такой нет. */
export function refineryFor(sim: Sim, truck: Entity, ore: Ore, except: Entity = NONE as Entity): Entity {
  const player = sim.world.get(truck, Owner)?.player ?? 0
  let best = NONE as Entity
  let bestDistance = Infinity
  for (const [entity, inventory, building] of sim.world.query(Inventory, Building)) {
    if (entity === except || !buildingSpec(building.type).refines || !isReady(sim, player, entity) || sim.world.has(entity, Converting)) continue
    if (roomFor(inventory, ore) <= 1e-9) continue
    const far = distance(sim, truck, entity)
    if (far < bestDistance) {
      best = entity
      bestDistance = far
    }
  }
  return best
}

/** Куда везти груз без заявки: готовое — в ближайшее хранилище, руду — на ближайшую переработку. */
export const deliveryFor = (sim: Sim, truck: Entity, resource: Good, except: Entity = NONE as Entity): Entity =>
  isOre(resource) ? refineryFor(sim, truck, resource, except) : storeFor(sim, truck, resource, except)

/**
 * Годится ли склад, чтобы выгрузить в него груз: своё хранилище с местом, переработка с местом под руду или то,
 * что этот груз заказывало (стройка, производитель, космопорт с заявкой на него).
 */
export function acceptsDelivery(sim: Sim, player: number, to: Entity, resource: Good) {
  const { world } = sim
  const inventory = world.get(to, Inventory)
  if (!inventory || !isOwn(sim, player, to) || roomFor(inventory, resource) <= 1e-9) return false
  if (world.has(to, Site)) return !!materialsFor(sim, to)?.[resource]
  if (!isReady(sim, player, to) || world.has(to, Converting)) return false
  if (isStore(sim, to)) return true
  const order = world.get(to, Trade)
  if (order) return order.total <= 0 && order.resource === resource
  if (materialsFor(sim, to)?.[resource]) return true
  // Свой склад здания: переработка так принимает руду, которой больше негде лежать.
  const type = world.get(to, Building)?.type
  return type !== undefined && !!buildingSpec(type).refines && isOre(resource)
}

/** Можно ли забирать груз со склада: свой готовый склад, где он есть. */
export function offersPickup(sim: Sim, player: number, from: Entity, resource: Good) {
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
 * откуда брать, и оттуда до заказчика). Готовое берётся в хранилищах зоны заказчика, руда — в шахтах игрока,
 * где бы они ни стояли. Если заявок, которые можно выполнить, нет — грузовик увозит готовое из переработки
 * по хранилищам; руду без заявки не возит никто.
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
    // Откуда брать: переработка отдаёт готовое, её шахты — руду. Хранилища груз только принимают: возить из
    // одного хранилища в другое незачем, а руду в них не кладут.
    const refineries: Entity[] = []
    const mines: Entity[] = []
    for (const [entity, building] of world.query(Building, Inventory)) {
      if (!isReady(sim, player, entity) || world.has(entity, Converting)) continue
      const spec = buildingSpec(building.type)
      if (spec.refines) refineries.push(entity)
      else if (spec.extract) mines.push(entity)
    }
    // У шахты с привязанным грузовиком есть свой возчик: свободные её руду не трогают и занимаются готовым.
    const bound = new Set<Entity>()
    for (const [, hauler] of world.query(Hauler)) if (hauler.mine !== NONE) bound.add(hauler.mine as Entity)

    for (const truck of trucks) {
      const room = world.get(truck, Inventory)?.capacity ?? 0
      let best: (Job & { score: number }) | undefined
      for (const request of requests) {
        if (request.amount < MIN_JOB) continue
        for (const source of request.source === 'mines' ? mines : request.zone.buildings) {
          if (source === request.to || !offersOf(sim, source).includes(request.resource)) continue
          // Руду шахты, у которой уже есть привязанный грузовик, свободные не возят.
          if (request.source === 'mines' && bound.has(source)) continue
          const available = availableIn(sim, flows, source, request.resource)
          if (available < Math.min(request.amount, MIN_JOB)) continue
          const score = request.priority * PRIORITY_WEIGHT - distance(sim, truck, source) - distance(sim, source, request.to)
          if (best && score <= best.score) continue
          best = { from: source, to: request.to, resource: request.resource, amount: Math.min(request.amount, available, room), score }
        }
      }
      if (!best) {
        // Заявок нет — увозит готовое из переработки; куда именно, решит, когда наберёт груз.
        for (const source of refineries) {
          for (const resource of offersOf(sim, source)) {
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
