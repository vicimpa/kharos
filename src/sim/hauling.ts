import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, isReady, type BuildingSpec } from './buildings'
import { NONE, isOwn, onTurn } from './common'
import { Beam, Building, Converting, Hauler, Harvester, Inventory, Owner, Path, Position, Site } from './components'
import { DEPOSIT_KINDS, reserveLeft, takeReserve } from './deposits'
import { amountOf, approach, beamFor, put, reaches, resetBeams, roomFor, transfer } from './inventory'
import { isStore } from './trade'
import { acceptsDelivery, deliveryFor, dispatch, mineOre, offersPickup, refineryFor, requestsOf, spaceFor } from './logistics'
import { GOODS, resourceOf, type Good } from './resources'
import type { Sim } from './sim'
import { UNITS } from './units'
import { runRoutes } from './routes'

/** Сколько ресурсов помещается в грузовик. */
export const TRUCK_CAPACITY = UNITS.truck.inventory
/** Раз во сколько тиков грузовик, не дотянувшийся до луча или не нашедший, куда выгрузиться, пробует снова. */
const RETRY_TICKS = 20
/** Раз во сколько тиков диспетчер раздаёт работу свободным грузовикам. */
const DISPATCH_TICKS = 10
const EPSILON = 1e-9
const owner = (sim: Sim, truck: Entity) => sim.world.get(truck, Owner)?.player ?? 0

const specOf = (sim: Sim, building: Entity): BuildingSpec | undefined => {
  const type = sim.world.get(building, Building)?.type
  return type === undefined ? undefined : BUILDINGS[type]
}

/** Может ли игрок привязать грузовики к этому зданию: это его готовая шахта. */
export const canHaul = (sim: Sim, player: number, mine: Entity) => isReady(sim, player, mine) && !!specOf(sim, mine)?.extract

/**
 * Привязывает грузовики игрока к его шахте: с этого момента они возят только из неё на переработку, а не работают
 * на заявки зон. Не грузовики и чужие юниты из списка выбрасываются.
 */
export function assignHaulers(sim: Sim, player: number, mine: Entity, units: Entity[]) {
  const { world } = sim
  if (!canHaul(sim, player, mine)) return false
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && !world.has(entity, Harvester) && isOwn(sim, player, entity))
  for (const truck of trucks) {
    releaseHauler(sim, truck)
    world.get(truck, Hauler)!.mine = mine
    // Тронется сам в ближайший тик: гружёный — в хранилище, пустой — к шахте.
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/** Что лежит в кузове: первый груз, которого там есть хоть сколько-то; undefined — пусто. */
const carriedBy = (sim: Sim, truck: Entity): Good | undefined => {
  const cargo = sim.world.get(truck, Inventory)
  return cargo && GOODS.find((resource) => amountOf(cargo, resource) > EPSILON)
}

/** Бросает работу. Груз остаётся в кузове: грузовик сначала отвезёт его в хранилище или на переработку. */
function dropJob(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)!
  hauler.from = hauler.to = NONE
  hauler.amount = 0
  hauler.full = hauler.loading = hauler.waiting = false
}

/**
 * Снимает грузовик с работы, с шахты и с маршрута. Дальше он свободен: работу ему даст диспетчер зон (см. logistics.ts),
 * а груз в кузове он сначала отвезёт в хранилище или на переработку.
 */
export function releaseHauler(sim: Sim, truck: Entity) {
  const hauler = sim.world.get(truck, Hauler)
  if (!hauler) return
  hauler.mine = NONE
  hauler.route = []
  hauler.stop = 0
  dropJob(sim, truck)
}

/** Можно ли вернуть груз туда, откуда он взят: здание стоит и место под него есть. */
const returnsTo = (sim: Sim, building: Entity, resource: Good) => {
  const inventory = sim.world.get(building, Inventory)
  return !!inventory && sim.world.has(building, Building) && roomFor(inventory, resource) > EPSILON
}

/** Ближайший к грузовику заказчик этого груза; NONE — его никто не ждёт. */
function requesterFor(sim: Sim, truck: Entity, resource: Good): Entity {
  const { x, y } = sim.world.get(truck, Position)!
  let best = NONE as Entity
  let bestDistance = Infinity
  for (const request of requestsOf(sim, owner(sim, truck))) {
    if (request.resource !== resource) continue
    const at = sim.world.get(request.to, Position)!
    const far = Math.hypot(at.x - x, at.y - y)
    if (far < bestDistance) {
      best = request.to
      bestDistance = far
    }
  }
  return best
}

/** Подводит грузовик к зданию на длину луча, который перенесёт ресурс между ними. */
function seek(sim: Sim, truck: Entity, building: Entity, toBuilding: boolean) {
  const beam = toBuilding ? beamFor(sim, truck, building) : beamFor(sim, building, truck)
  if (beam !== undefined) approach(sim, truck, building, sim.world.get(beam, Beam)!.radius)
}

/** Раз в тик: шахты добывают руду в свои склады, пока там есть место; что и как быстро — решает месторождение. */
function extract(sim: Sim) {
  const { world, time } = sim
  const mines: Entity[] = []
  for (const [entity, building] of world.query(Building, Inventory)) {
    if (buildingSpec(building.type).extract && !world.has(entity, Site)) mines.push(entity)
  }
  // Первая добыча заводит месторождению сущность, а состав мира меняется после обхода.
  for (const entity of mines) {
    const ore = mineOre(sim, entity)
    if (!ore) continue
    const inventory = world.get(entity, Inventory)!
    const { x, y } = world.get(entity, Position)!
    const rate = DEPOSIT_KINDS[resourceOf(ore)].rate
    put(inventory, ore, takeReserve(sim, x, y, Math.min(rate * time.step, roomFor(inventory, ore))))
  }
}

/** Выработана ли шахта: в месторождении и в её складе пусто. */
function isSpent(sim: Sim, mine: Entity) {
  const position = sim.world.get(mine, Position)
  const inventory = sim.world.get(mine, Inventory)
  const ore = mineOre(sim, mine)
  if (!position || !inventory || !ore) return true
  return reserveLeft(sim, position.x, position.y) <= 0 && amountOf(inventory, ore) <= EPSILON
}

/**
 * Раз в тик: шахты добывают, грузовики возят. Груз между зданием и грузовиком переносит луч грузовика
 * (см. inventory.ts): ему достаточно встать в радиусе. Очередей нет: у одного склада грузятся все сразу.
 *
 * Привязанный к шахте грузовик возит руду из неё на переработку. Свободному работу даёт диспетчер зон: подвезти
 * заказанное или увезти готовое из переработки в хранилище (см. logistics.ts). Работа — забрать груз со склада
 * from и сгрузить на склад to. Пропал склад, кончился груз или место — грузовик ищет другой или бросает работу.
 */
export function haul(sim: Sim) {
  const { world, time } = sim
  resetBeams(sim)
  extract(sim)
  // Приказы и поиск зданий — после обхода: внутри него нельзя ни обходить мир заново, ни менять его состав.
  const seeking: { truck: Entity; building: Entity; toBuilding: boolean }[] = []
  const working: Entity[] = []
  const released: Entity[] = []
  const dropped: Entity[] = []
  /** Набравшие груз, которым надо решить, куда его везти. */
  const homeless: Entity[] = []

  for (const [entity, hauler, owner, cargo] of world.query(Hauler, Owner, Inventory)) {
    hauler.loading = false
    // Харвестер, пока копает, — забота harvesting.ts: сюда он попадает, только когда везёт руду.
    if (!hauler.full && world.has(entity, Harvester)) continue
    // Грузовик с маршрутом ездит по нему сам: см. routes.ts.
    if (hauler.route.length && !world.has(entity, Harvester)) continue
    if (hauler.mine !== NONE && !canHaul(sim, owner.player, hauler.mine as Entity)) {
      // Шахты больше нет: грузовик свободен. Груз остаётся в кузове.
      released.push(entity)
      continue
    }
    if (world.has(entity, Path) || world.has(entity, Converting)) continue
    const retry = onTurn(time, entity, RETRY_TICKS)

    if (hauler.from === NONE && hauler.to === NONE) {
      const carried = GOODS.find((resource) => amountOf(cargo, resource) > EPSILON)
      if (carried) {
        // Остался груз — сначала в хранилище или переработку.
        hauler.resource = carried
        hauler.full = true
      } else if (hauler.mine !== NONE) {
        const ore = mineOre(sim, hauler.mine as Entity)
        // Шахта выработана и вывезена: грузовик свободен.
        if (!ore || isSpent(sim, hauler.mine as Entity)) {
          released.push(entity)
          continue
        }
        // Руду, которую некуда везти, не берёт: ждёт у шахты, пока на переработке не освободится место. Место
        // бронирует сразу и набирает не больше него: иначе все грузовики шахты набрали бы по кузову на одно место.
        if (!retry) continue
        const to = refineryFor(sim, entity, ore)
        if (to === NONE) continue
        hauler.from = hauler.mine
        hauler.to = to
        hauler.resource = ore
        hauler.amount = Math.min(cargo.capacity, spaceFor(sim, entity, to, ore))
        hauler.full = false
      } else {
        // Свободный и пустой ждёт работы от диспетчера.
        continue
      }
    }

    if (hauler.full) {
      const back = hauler.to !== NONE && hauler.to === hauler.from && returnsTo(sim, hauler.to as Entity, hauler.resource)
      if (hauler.to === NONE || !(back || acceptsDelivery(sim, owner.player, hauler.to as Entity, hauler.resource))) {
        if (retry || hauler.to !== NONE) homeless.push(entity)
        hauler.to = NONE
        continue
      }
    } else if (!offersPickup(sim, owner.player, hauler.from as Entity, hauler.resource)) {
      // Брать нечего. Шахта ещё добывает — грузовик ждёт у неё; иначе везёт, что набрал, или бросает работу.
      const mining = hauler.from === hauler.mine && !isSpent(sim, hauler.from as Entity)
      if (!mining) {
        if (amountOf(cargo, hauler.resource) > EPSILON) hauler.full = true
        else dropped.push(entity)
        continue
      }
    }

    const building = (hauler.full ? hauler.to : hauler.from) as Entity
    const toBuilding = hauler.full
    if (!(toBuilding ? reaches(sim, entity, building) : reaches(sim, building, entity))) {
      // Только что получивший работу трогается сразу, не нашедший места — раз в RETRY_TICKS.
      if (retry || !hauler.waiting) seeking.push({ truck: entity, building, toBuilding })
      hauler.waiting = true
      continue
    }
    hauler.waiting = false
    working.push(entity)
  }

  for (const truck of released) releaseHauler(sim, truck)
  for (const truck of dropped) dropJob(sim, truck)

  for (const truck of working) {
    const hauler = world.get(truck, Hauler)!
    const cargo = world.get(truck, Inventory)!
    const resource = hauler.resource
    if (hauler.full) {
      hauler.loading = transfer(sim, truck, hauler.to as Entity, resource) > 0
      if (amountOf(cargo, resource) <= EPSILON) {
        // Доли копятся с погрешностью: пустой кузов — ровно пустой.
        cargo.items[resource] = 0
        dropJob(sim, truck)
      } else if (roomFor(world.get(hauler.to as Entity, Inventory)!, resource) <= EPSILON) {
        // Места больше нет — остаток повезёт в другое хранилище.
        homeless.push(truck)
      }
      continue
    }
    const want = hauler.amount - amountOf(cargo, resource)
    hauler.loading = transfer(sim, hauler.from as Entity, truck, resource, want) > 0
    if (amountOf(cargo, resource) >= hauler.amount - EPSILON || roomFor(cargo, resource) <= EPSILON) {
      // Доли копятся с погрешностью: полный кузов — ровно полный.
      if (roomFor(cargo, resource) <= EPSILON) put(cargo, resource, EPSILON)
      hauler.full = true
      if (hauler.to === NONE) homeless.push(truck)
    } else if (hauler.from === hauler.mine && isSpent(sim, hauler.from as Entity)) {
      // Шахта выработана: довозит набранное и освобождается.
      releaseHauler(sim, truck)
    }
  }

  for (const truck of homeless) {
    const hauler = world.get(truck, Hauler)!
    const resource = carriedBy(sim, truck)
    if (!resource) {
      dropJob(sim, truck)
      continue
    }
    // Хранилища полны — груз остаётся в кузове, грузовик пробует снова раз в RETRY_TICKS.
    hauler.resource = resource
    hauler.full = true
    hauler.waiting = false
    // Взятое из хранилища и ставшее ненужным едет обратно туда же: возить из одного хранилища в другое незачем.
    const from = hauler.from as Entity
    if (from !== NONE && isStore(sim, from) && acceptsDelivery(sim, owner(sim, truck), from, resource)) {
      hauler.to = from
      continue
    }
    // Остальное туда, откуда взял, не везёт: остаток едет в другое хранилище или на другую переработку. Другого
    // нет — везёт обратно: хранилище у каждого груза своё, и единственное нельзя исключать.
    const other = deliveryFor(sim, truck, resource, from)
    hauler.to = other === NONE ? deliveryFor(sim, truck, resource) : other
    // Хранилищ с местом нет — груз едет тому, кто его заказывал, а нет и таких — обратно, откуда взят, если там есть
    // место. Иначе грузовик так и стоял бы с полным кузовом и не брал работу.
    if (hauler.to === NONE) hauler.to = requesterFor(sim, truck, resource)
    if (hauler.to === NONE && from !== NONE && returnsTo(sim, from, resource)) hauler.to = from
  }

  runRoutes(sim)
  if (time.tick % DISPATCH_TICKS === 0) dispatch(sim)
  for (const { truck, building, toBuilding } of seeking) seek(sim, truck, building, toBuilding)
}
