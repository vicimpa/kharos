import type { Entity } from '../ecs'
import { siteAt } from './buildings'
import { canAttack } from './combat'
import type { Command } from './commands'
import { isOwn } from './common'
import { Harvester, Hauler, Owner, Position, Repair, Unit } from './components'
import { canRepair } from './construction'
import { DEPOSIT_SIZE, depositNear } from './deposits'
import { dropAt } from './drops'
import { hasMine } from './harvesting'
import { canHaul, canSupply } from './hauling'
import type { Sim } from './sim'
import { canFight } from './turrets'
import { UNITS } from './units'

/** Насколько мимо юнита можно попасть точкой приказа, чтобы всё равно попасть в него. В тайлах. */
export const ORDER_MARGIN = 0.3

/**
 * Юнит под точкой в тайлах: ближайший из тех, в чей круг с запасом margin она попала. own — среди юнитов игрока
 * или среди чужих. С fog чужой юнит, которого игрок сейчас не видит, не находится.
 */
export function unitNear(sim: Sim, player: number, x: number, y: number, own = true, margin = ORDER_MARGIN, fog = false) {
  let best: Entity | undefined
  let bestDistance = Infinity
  for (const [entity, position, unit, owner] of sim.world.query(Position, Unit, Owner)) {
    if ((owner.player === player) !== own) continue
    const distance = Math.hypot(position.x - x, position.y - y)
    if (distance > UNITS[unit.type].radius + margin || distance >= bestDistance) continue
    if (fog && !own && !sim.vision.seesEntity(player, entity)) continue
    best = entity
    bestDistance = distance
  }
  return best
}

/**
 * Приказ точкой: что юнитам units игрока делать с точкой point (в тайлах) — атаковать врага, копать месторождение,
 * возить, строить или чинить, а нет — идти туда. Возвращает команды с целями по номерам сущностей.
 *
 * Цель выбирает симуляция, а не клиент: по номеру сущности клиент мог бы назвать и то, чего не видит. Поэтому
 * с fog точка в тумане — всегда движение: что там стоит, игрок не знает. Кроме разведанного месторождения:
 * оно с места не уйдёт, и игрок о нём помнит.
 */
export function resolveOrder(sim: Sim, player: number, units: Entity[], point: { x: number; y: number }, margin = ORDER_MARGIN, fog = true): Command[] {
  const { world } = sim
  const x = Math.floor(point.x)
  const y = Math.floor(point.y)
  const seen = !fog || sim.vision.sees(player, x, y)
  const unitAt = (own: boolean) => (seen ? unitNear(sim, player, point.x, point.y, own, margin, fog) : undefined)
  // Работа для строителей: стройка, разбор или своё повреждённое — здание или юнит.
  const damaged = seen ? sim.occupancy.at(x, y) : undefined
  const planned = seen ? siteAt(sim, x, y) : undefined
  const broken = unitAt(true) ?? damaged
  const site = planned ?? (broken !== undefined && canRepair(sim, player, broken) ? broken : undefined)
  const builders = units.some((entity) => world.has(entity, Repair))
  // То, чему грузовики могут привезти груз: своя стройка или здание в точке.
  const needy = planned ?? damaged
  const isTruck = (entity: Entity) => world.has(entity, Hauler) && !world.has(entity, Harvester)
  const trucks = units.some(isTruck)
  const drop = seen && trucks ? dropAt(sim, x, y) : undefined
  // Вооружённые по врагу — атакуют: по чужому юниту или зданию в точке.
  const enemy = unitAt(false) ?? damaged
  const fighters = units.some((entity) => canFight(sim, entity))
  // Харвестеры по месторождению — копают его, если на нём нет шахты.
  const harvesters = units.some((entity) => world.has(entity, Harvester))
  const found = harvesters ? depositNear(sim, point.x, point.y, DEPOSIT_SIZE) : null
  const known = found && sim.vision.exploredIn(player, found.x, found.y, DEPOSIT_SIZE, DEPOSIT_SIZE)
  const deposit = found && known && !hasMine(sim, found) ? found : null
  const onDeposit = deposit && x >= deposit.x && x < deposit.x + DEPOSIT_SIZE && y >= deposit.y && y < deposit.y + DEPOSIT_SIZE
  if (fighters && enemy !== undefined && canAttack(sim, player, enemy)) return [{ type: 'attack', units, target: enemy }]
  if (deposit && onDeposit) return [{ type: 'harvest', units, x: deposit.x, y: deposit.y }]
  // Грузовики по своей шахте — привязываются к ней и возят добытое.
  if (trucks && damaged !== undefined && canHaul(sim, player, damaged)) return [{ type: 'haul', units, mine: damaged }]
  // Грузовики по дропу — вывозят его.
  if (drop !== undefined) return [{ type: 'pickup', units, drop }]
  if (trucks && needy !== undefined && canSupply(sim, player, needy)) {
    // Грузовики по своему зданию или стройке, которым нужен груз, — обеспечивают их; строители при этом строят.
    const haulers = units.filter(isTruck)
    const commands: Command[] = [{ type: 'supply', units: haulers, target: needy }]
    const rest = units.filter((entity) => !haulers.includes(entity) && world.has(entity, Repair))
    if (rest.length && planned === needy) commands.push({ type: 'assist', units: rest, site: needy })
    return commands
  }
  // Строители по своей стройке — строят, по повреждённому зданию или юниту — чинят; остальные выбранные при этом стоят.
  if (site !== undefined && builders && isOwn(sim, player, site)) return [{ type: 'assist', units, site }]
  return [{ type: 'move', units, x, y }]
}
