import type { Entity } from '../ecs'
import { BUILDINGS, isReady } from './buildings'
import { NONE, onTurn } from './common'
import { Beam, Builds, Converting, Inventory, Owner, Path, Position, Site, Supply, Unit } from './components'
import { amountOf, approach, reaches, roomFor, transfer } from './inventory'
import { flowsOf, missingFor, offersOf, spareOf, storeFor } from './logistics'
import { GOODS, entriesOf, type Good } from './resources'
import type { Sim } from './sim'
import { inCircles, zonesOf } from './zones'

/**
 * Подвоз материалов строителями. Стройке, которой не хватает материалов, их привозит её же строитель: едет на склад
 * её зоны строительства, где груз есть, набирает в кузов сколько влезет и сколько ещё не везут другие, подъезжает
 * к площадке на длину луча и выгружает. Грузовики материалы на стройку не возят. Груз, ставший ненужным
 * (стройку отменили, достроили или строителя увели), строитель отвозит в хранилище.
 */

/** Раз во сколько тиков строитель, которому некуда подъехать или неоткуда взять, пробует снова. */
const RETRY_TICKS = 20
const EPSILON = 1e-9

/** Что лежит в кузове строителя: первый груз, которого там есть хоть сколько-то. */
const carriedBy = (sim: Sim, builder: Entity): Good | undefined => {
  const cargo = sim.world.get(builder, Inventory)
  return cargo && GOODS.find((resource) => amountOf(cargo, resource) > EPSILON)
}

/** Стройка с материалами: площадка или недостроенное здание, а не разбор. */
const supplied = (sim: Sim, site: Entity) => {
  const work = sim.world.get(site, Site)
  return !!work && !work.demolish && sim.world.has(site, Inventory)
}

/** Склады зоны, в которой стоит стройка: только из них строитель берёт материалы. */
function sourcesFor(sim: Sim, site: Entity): readonly Entity[] {
  const player = sim.world.get(site, Owner)?.player ?? 0
  const position = sim.world.get(site, Position)!
  const { width, height } = BUILDINGS[sim.world.get(site, Site)!.type]
  const zone = zonesOf(sim, player).find((zone) => inCircles(zone.circles, position.x + width / 2, position.y + height / 2))
  return zone?.buildings ?? []
}

/**
 * Чего стройке ещё не хватает с учётом того, что уже везут другие строители, и откуда это взять ближе всего
 * к строителю. undefined — везти нечего или неоткуда.
 */
function jobFor(sim: Sim, builder: Entity, site: Entity) {
  const flows = flowsOf(sim, builder)
  const capacity = sim.world.get(builder, Inventory)!.capacity
  const at = sim.world.get(builder, Position)!
  let best: { from: Entity; resource: Good; amount: number; distance: number } | undefined
  for (const [resource, lack] of entriesOf(missingFor(sim, site))) {
    const need = lack - (flows.incoming.get(site)?.[resource] ?? 0)
    if (need <= EPSILON) continue
    for (const source of sourcesFor(sim, site)) {
      if (!isReady(sim, sim.world.get(site, Owner)!.player, source) || sim.world.has(source, Converting)) continue
      if (!offersOf(sim, source).includes(resource)) continue
      const available = spareOf(sim, source, resource) - (flows.outgoing.get(source)?.[resource] ?? 0)
      if (available <= EPSILON) continue
      const position = sim.world.get(source, Position)!
      const distance = Math.hypot(position.x - at.x, position.y - at.y)
      if (best && distance >= best.distance) continue
      best = { from: source, resource, amount: Math.min(need, available, capacity), distance }
    }
  }
  return best
}

/** Есть ли у стройки материалы, которые её строитель может подвезти: тогда она не просто ждёт. */
export function canSupply(sim: Sim, builder: Entity, site: Entity) {
  return sim.world.has(builder, Inventory) && supplied(sim, site) && jobFor(sim, builder, site) !== undefined
}

/** Занят ли строитель подвозом: едет за грузом или везёт его. Такого строителя стройка не подзывает к себе. */
export function isSupplying(sim: Sim, builder: Entity) {
  const supply = sim.world.get(builder, Supply)
  return (!!supply && supply.from !== NONE) || carriedBy(sim, builder) !== undefined
}

/** Подводит строителя к складу или стройке на длину его луча. */
const seek = (sim: Sim, builder: Entity, target: Entity) => approach(sim, builder, target, sim.world.get(builder, Beam)!.radius)

/** Раз в тик: строители везут материалы на свои стройки и увозят ненужное в хранилища. */
export function supply(sim: Sim) {
  const { world, time } = sim
  const seeking: { builder: Entity; target: Entity }[] = []
  const fresh: { builder: Entity; from: Entity; resource: Good; amount: number }[] = []
  const done: Entity[] = []

  for (const [builder, , cargo] of world.query(Unit, Inventory, Beam, Owner)) {
    if (!world.has(builder, Builds) && !world.has(builder, Supply) && carriedBy(sim, builder) === undefined) continue
    // Подвозят только строители: у остальных юнитов со складом своя работа.
    if (world.get(builder, Unit)!.type !== 'builder') continue
    if (world.has(builder, Path) || world.has(builder, Converting)) continue
    const retry = onTurn(time, builder, RETRY_TICKS)
    const site = world.get(builder, Builds)?.site as Entity | undefined
    const work = site !== undefined && supplied(sim, site) ? site : undefined
    const job = world.get(builder, Supply)
    const carried = carriedBy(sim, builder)

    if (carried !== undefined && (job?.from === NONE || job === undefined || job.resource !== carried || work === undefined)) {
      // Везёт груз: стройке, если ей он нужен, иначе в хранилище.
      const needed = work !== undefined && (missingFor(sim, work)[carried] ?? 0) > EPSILON
      const target = needed ? work : storeFor(sim, builder, carried)
      if (target === NONE) continue
      if (reaches(sim, builder, target)) {
        transfer(sim, builder, target, carried, needed ? missingFor(sim, work!)[carried] : Infinity)
        // Доли копятся с погрешностью: пустой кузов — ровно пустой.
        if (amountOf(cargo, carried) <= 1e-6) cargo.items[carried] = 0
        if (carriedBy(sim, builder) === undefined) done.push(builder)
      } else if (retry) seeking.push({ builder, target })
      continue
    }

    if (job && job.from !== NONE) {
      // Едет за грузом или грузится.
      const from = job.from as Entity
      const stale = work === undefined || !world.alive(from) || !world.has(from, Inventory) || spareOf(sim, from, job.resource) <= EPSILON
      if (stale) {
        // Брать нечего или стройки больше нет: везёт то, что успел набрать, а пустой — свободен.
        job.from = NONE
        if (carriedBy(sim, builder) === undefined) done.push(builder)
        continue
      }
      if (!reaches(sim, from, builder)) {
        if (retry) seeking.push({ builder, target: from })
        continue
      }
      const want = job.amount - amountOf(cargo, job.resource)
      transfer(sim, from, builder, job.resource, want)
      if (amountOf(cargo, job.resource) >= job.amount - 1e-6 || roomFor(cargo, job.resource) <= EPSILON) {
        // Набрал — сразу к стройке.
        job.from = NONE
        seeking.push({ builder, target: work })
      }
      continue
    }

    // Пустой: берёт работу, если стройке чего-то не хватает и это есть в её зоне. Проверяет не каждый тик.
    if (work === undefined || !retry) continue
    const next = jobFor(sim, builder, work)
    if (next) fresh.push({ builder, ...next })
  }

  for (const builder of done) world.remove(builder, Supply)
  for (const { builder, from, resource, amount } of fresh) {
    world.add(builder, Supply({ from, resource, amount }))
    seeking.push({ builder, target: from })
  }
  for (const { builder, target } of seeking) seek(sim, builder, target)
}
