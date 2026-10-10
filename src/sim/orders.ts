import type { Entity } from '../ecs'
import { apply, type Command } from './commands'
import { NONE, isOwn } from './common'
import { Armed, Builds, Converting, Harvester, Hauler, Orders, Owner, Path, Tactics, Unit } from './components'
import { orderBuild } from './construction'
import type { Sim } from './sim'
import { turretsOf } from './turrets'

/** Приказы, которые можно ставить в очередь, — у них есть конец или их дело ведёт юнит сам. */
const QUEUED = new Set<Command['type']>(['move', 'attack', 'assist', 'build', 'harvest', 'haul', 'pickup', 'supply'])

export const canQueue = (command: Command) => QUEUED.has(command.type)

/** Юниты, которым адресован приказ: units, а у стройки — builders. */
export function unitsOf(command: Command): Entity[] {
  const units = 'units' in command ? command.units : 'builders' in command ? command.builders : null
  return Array.isArray(units) ? (units as Entity[]) : []
}

/** Приказ без Shift забывает очередь. */
export function clearOrders(sim: Sim, units: Entity[]) {
  for (const entity of units) sim.world.get(entity, Orders)?.list.splice(0)
}

let lastTick = -1
let seq = 0
/** Номер группы: в пределах тика — по порядку; разным тикам номера не пересекаются. */
const nextGroup = (sim: Sim) => {
  if (sim.time.tick !== lastTick) {
    lastTick = sim.time.tick
    seq = 0
  }
  return sim.time.tick * 1024 + seq++
}

/**
 * Ставит приказ своим юнитам в конец очереди. Стройку закладывает сразу — место и кредиты заняты, — а строителям
 * в очередь идёт помощь на ней: так строитель получает список построек.
 */
export function queueOrder(sim: Sim, player: number, command: Command) {
  if (!canQueue(command)) return false
  const { world } = sim
  const units = [...new Set(unitsOf(command))].filter((entity) => world.has(entity, Unit) && isOwn(sim, player, entity))
  if (command.type === 'build') {
    const site = orderBuild(sim, player, command.building, command.x, command.y, [])
    if (site === undefined) return false
    command = { type: 'assist', units, site }
  }
  if (!units.length) return command.type === 'assist'
  const group = nextGroup(sim)
  for (const entity of units) {
    if (!world.has(entity, Orders)) world.add(entity, Orders())
    world.get(entity, Orders)!.list.push({ group, command: { ...command, units, queue: false } as Command })
  }
  return true
}

/** Строитель на работе, которую дал ему игрок, или с приказами в очереди: новую стройку из меню он берёт в очередь. */
export function isBusyBuilder(sim: Sim, entity: Entity) {
  return !!sim.world.get(entity, Builds)?.ordered || !!sim.world.get(entity, Orders)?.list.length
}

/** Нечем занят: не едет, не строит, не гонится за целью по приказу, не патрулирует и не работает по приказу игрока. */
function idle(sim: Sim, entity: Entity) {
  const { world } = sim
  if (world.has(entity, Path) || world.has(entity, Builds) || world.has(entity, Converting)) return false
  for (const gunner of [entity, ...turretsOf(sim, entity)]) {
    const armed = world.get(gunner, Armed)
    if (armed?.ordered && armed.target !== NONE) return false
  }
  if (world.get(entity, Tactics)?.patrol.length) return false
  const harvester = world.get(entity, Harvester)
  if (harvester && (harvester.picked || harvester.seek)) return false
  // Заявки зон грузовик возит и сам, без приказа: их очередь прерывает.
  const hauler = world.get(entity, Hauler)
  if (hauler && (hauler.mine !== NONE || hauler.pickup !== NONE || hauler.supply !== NONE || hauler.route.length || hauler.serve.length)) return false
  return true
}

/**
 * Раз в тик: освободившиеся юниты берут следующий приказ из очереди. Приказ группы ждёт, пока освободятся все её
 * юниты, у которых он следующий, — тогда они получают его вместе и встают строем, а не в одну точку.
 */
export function followOrders(sim: Sim) {
  const { world } = sim
  const groups = new Map<number, { player: number; command: Command; units: Entity[]; ready: boolean }>()
  for (const [entity, orders, owner] of world.query(Orders, Owner)) {
    const next = orders.list[0]
    if (!next) continue
    let group = groups.get(next.group)
    if (!group) groups.set(next.group, (group = { player: owner.player, command: next.command, units: [], ready: true }))
    group.units.push(entity)
    group.ready &&= idle(sim, entity)
  }
  for (const { player, command, units, ready } of groups.values()) {
    if (!ready) continue
    // apply забывает очередь, как у любого приказа без Shift: остаток кладётся обратно.
    const rest = units.map((entity) => world.get(entity, Orders)!.list.slice(1))
    apply(sim, player, { ...command, units } as Command)
    units.forEach((entity, i) => {
      const orders = world.get(entity, Orders)
      if (orders) orders.list = rest[i]
    })
  }
}
