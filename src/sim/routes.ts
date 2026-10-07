import type { Entity } from '../ecs'
import { isReady } from './buildings'
import { NONE, isOwn, onTurn } from './common'
import { Beam, Converting, Hauler, Harvester, Inventory, Owner, Path, Unit } from './components'
import { amountOf, approach, beamFor, reaches, roomFor, transfer } from './inventory'
import { releaseHauler } from './hauling'
import { acceptsDelivery, offersOf, spareOf } from './logistics'
import { GOODS, type Good } from './resources'
import type { Sim } from './sim'

/** Сколько остановок может быть в маршруте. */
export const ROUTE_LIMIT = 8
/** Раз во сколько тиков грузовик, которому негде взять груз или не дотянувшийся до остановки, пробует снова. */
const RETRY_TICKS = 20
const EPSILON = 1e-9

/** Что лежит в кузове: первый груз, которого там есть хоть сколько-то; undefined — пусто. */
const carriedBy = (sim: Sim, truck: Entity): Good | undefined => {
  const cargo = sim.world.get(truck, Inventory)
  return cargo && GOODS.find((resource) => amountOf(cargo, resource) > EPSILON)
}

/** Годится ли здание в остановку маршрута игрока: своё готовое здание со складом. */
export const isStop = (sim: Sim, player: number, building: Entity) => isReady(sim, player, building) && sim.world.has(building, Inventory)

/** Возит ли грузовик этот груз: фильтр пуст или груз в нём есть. */
export const carries = (filter: readonly Good[], resource: Good) => !filter.length || filter.includes(resource)

/**
 * Что грузовику взять на остановке from, чтобы сгрузить на следующей to: первый груз из разрешённых фильтром,
 * который from отдаёт, у него есть и to примет. undefined — брать нечего.
 */
function pickFor(sim: Sim, player: number, filter: readonly Good[], from: Entity, to: Entity, except?: Good): Good | undefined {
  for (const resource of offersOf(sim, from)) {
    if (resource === except || !carries(filter, resource) || spareOf(sim, from, resource) <= EPSILON) continue
    if (acceptsDelivery(sim, player, to, resource)) return resource
  }
  return undefined
}

/**
 * Даёт грузовикам игрока маршрут: здания-остановки по кругу. Остановки — свои готовые здания со складом, подряд
 * одинаковые склеиваются; меньше двух — маршрут снимается. Грузовик бросает прежнюю работу и шахту; груз в кузове
 * повезёт по маршруту. Не грузовики, харвестеры и чужие из списка выбрасываются.
 */
export function setRoute(sim: Sim, player: number, units: Entity[], stops: Entity[]) {
  const { world } = sim
  const route: Entity[] = []
  for (const stop of stops.slice(0, ROUTE_LIMIT)) {
    if (!isStop(sim, player, stop) || route[route.length - 1] === stop) continue
    route.push(stop)
  }
  if (route.length > 1 && route[0] === route[route.length - 1]) route.pop()
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && world.has(entity, Unit) && !world.has(entity, Harvester) && isOwn(sim, player, entity))
  for (const truck of trucks) {
    const hauler = world.get(truck, Hauler)!
    hauler.mine = hauler.from = hauler.to = NONE
    hauler.amount = 0
    hauler.full = hauler.loading = hauler.waiting = false
    hauler.route = route.length > 1 ? [...route] : []
    hauler.stop = 0
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/** Сколько зданий может обслуживать грузовик. */
export const SERVE_LIMIT = 16

/**
 * Назначает грузовики игрока обслуживать здания: дальше они возят только по их заявкам, беря груз в любых своих
 * хранилищах, цехах и шахтах. Годятся свои готовые здания со складом, повторы выбрасываются; пустой список снимает
 * назначение. Грузовик бросает прежнюю работу, шахту и маршрут; груз в кузове сначала отвезёт в хранилище.
 */
export function setServe(sim: Sim, player: number, units: Entity[], buildings: Entity[]) {
  const { world } = sim
  const serve = [...new Set(buildings)].filter((building) => isStop(sim, player, building)).slice(0, SERVE_LIMIT)
  const trucks = [...new Set(units)].filter((entity) => world.has(entity, Hauler) && world.has(entity, Unit) && !world.has(entity, Harvester) && isOwn(sim, player, entity))
  for (const truck of trucks) {
    releaseHauler(sim, truck)
    world.get(truck, Hauler)!.serve = serve
    world.remove(truck, Path)
  }
  return trucks.length > 0
}

/**
 * Ставит грузовикам игрока фильтр груза; пустой — возят всё. Неизвестные грузы выбрасываются. Начатая работа с грузом,
 * которого фильтр не пускает, бросается.
 */
export function setFilter(sim: Sim, player: number, units: Entity[], goods: Good[]) {
  const { world } = sim
  const filter = GOODS.filter((good) => goods.includes(good))
  let count = 0
  for (const truck of new Set(units)) {
    const hauler = world.get(truck, Hauler)
    if (!hauler || !isOwn(sim, player, truck)) continue
    hauler.filter = filter
    // Работа на заявку с грузом, который фильтр теперь не пускает, бросается сразу: грузовик встаёт и ждёт новой.
    // Набранное он, как после любой отмены, сначала отвезёт в хранилище.
    const job = hauler.from !== NONE || hauler.to !== NONE
    if (job && filter.length && !filter.includes(hauler.resource)) {
      hauler.from = hauler.to = NONE
      hauler.amount = 0
      hauler.full = hauler.loading = hauler.waiting = false
      world.remove(truck, Path)
    }
    count++
  }
  return count > 0
}

/**
 * Грузовик уезжает к остановке stop. На стоянке full — разгрузка кончилась и идёт погрузка, resource при amount > 0 —
 * что он здесь сгрузил: поля работы у грузовика с маршрутом свободны, заявки зон его не трогают.
 */
function leave(hauler: { stop: number; full: boolean; amount: number }, stop: number) {
  hauler.stop = stop
  hauler.full = false
  hauler.amount = 0
}

/**
 * Раз в тик: грузовики с маршрутом объезжают его. На остановке грузовик сгружает то, что она принимает, и берёт
 * то, что примет следующая, кроме только что привезённого сюда; разгрузился и загрузился — едет дальше. Пустой, которому здесь брать нечего, едет
 * к ближайшей по кругу остановке, где груз для следующей есть; нет такой — ждёт на месте. Пропавшие остановки
 * выпадают из маршрута, и с одной остановкой маршрут кончается.
 */
export function runRoutes(sim: Sim) {
  const { world, time } = sim
  const seeking: { truck: Entity; building: Entity }[] = []
  const ended: Entity[] = []

  for (const [truck, hauler, owner, cargo] of world.query(Hauler, Owner, Inventory)) {
    if (!hauler.route.length || world.has(truck, Harvester)) continue
    if (world.has(truck, Path) || world.has(truck, Converting)) continue
    const player = owner.player
    if (hauler.route.some((stop) => !isStop(sim, player, stop as Entity))) {
      hauler.route = hauler.route.filter((stop) => isStop(sim, player, stop as Entity))
      hauler.stop = 0
    }
    const route = hauler.route as Entity[]
    if (route.length < 2) {
      ended.push(truck)
      continue
    }
    hauler.stop %= route.length
    const retry = onTurn(time, truck, RETRY_TICKS)
    const here = route[hauler.stop]
    if (!reaches(sim, truck, here) && !reaches(sim, here, truck)) {
      if (retry || !hauler.waiting) seeking.push({ truck, building: here })
      hauler.waiting = true
      continue
    }
    hauler.waiting = false
    const next = route[(hauler.stop + 1) % route.length]
    // Сначала грузовик сгружает всё, что здесь принимают, и только потом грузится: иначе на складе, который
    // и принимает, и отдаёт, он перекладывал бы один и тот же груз туда и обратно.
    if (!hauler.full) {
      const carried = carriedBy(sim, truck)
      const moved = carried && acceptsDelivery(sim, player, here, carried) ? transfer(sim, truck, here, carried) : 0
      hauler.loading = moved > 0
      if (moved > 0) {
        // Привезённое сюда отсюда же и не забирают.
        hauler.resource = carried!
        hauler.amount = 1
        continue
      }
      hauler.full = true
    }
    // Берёт для следующей остановки: тот же груз, что уже в кузове, или первый подходящий.
    const carried = carriedBy(sim, truck)
    const unloaded = hauler.amount > 0 ? hauler.resource : undefined
    const wanted = carried ?? pickFor(sim, player, hauler.filter, here, next, unloaded)
    let moved = 0
    if (wanted && wanted !== unloaded && roomFor(cargo, wanted) > EPSILON && offersOf(sim, here).includes(wanted) && spareOf(sim, here, wanted) > EPSILON && acceptsDelivery(sim, player, next, wanted)) {
      moved = transfer(sim, here, truck, wanted, Math.min(roomFor(cargo, wanted), spareOf(sim, here, wanted)))
    }
    hauler.loading = moved > 0
    if (moved > 0) continue
    if (carriedBy(sim, truck)) {
      leave(hauler, (hauler.stop + 1) % route.length)
      continue
    }
    // Пустой и брать здесь нечего: едет туда, где груз есть, а нет его нигде — ждёт.
    if (!retry) continue
    for (let step = 1; step < route.length; step++) {
      const index = (hauler.stop + step) % route.length
      if (pickFor(sim, player, hauler.filter, route[index], route[(index + 1) % route.length])) {
        leave(hauler, index)
        break
      }
    }
  }

  for (const truck of ended) {
    const hauler = world.get(truck, Hauler)!
    hauler.route = []
    hauler.stop = 0
  }
  for (const { truck, building } of seeking) {
    const beam = beamFor(sim, truck, building) ?? beamFor(sim, building, truck)
    if (beam !== undefined) approach(sim, truck, building, world.get(beam, Beam)!.radius)
  }
}
