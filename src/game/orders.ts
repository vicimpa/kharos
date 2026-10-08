import type { Entity } from '../ecs'
import { DEPOSIT_SIZE, Harvester, Hauler, Owner, Position, Repair, UNITS, Unit, canAttack, canFight, canHaul, canRepair, canSupply, depositNear, dropAt, hasMine, isOwn, siteAt, type Command } from '../sim'
import type { Scene } from './scene'

/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно попасть в него. В пикселях экрана. */
const PICK_MARGIN = 6

/** Юнит под точкой в тайлах: ближайший из тех, в чей круг она попала. own — среди своих или среди чужих. */
export function unitUnder(scene: Scene, x: number, y: number, own = true) {
  const { world } = scene.sim
  const margin = PICK_MARGIN / scene.camera.zoom
  let best: Entity | undefined
  let bestDistance = Infinity
  for (const [entity, position, unit, owner] of world.query(Position, Unit, Owner)) {
    if ((owner.player === scene.player) !== own) continue
    const distance = Math.hypot(position.x - x, position.y - y)
    if (distance > UNITS[unit.type].radius + margin || distance >= bestDistance) continue
    best = entity
    bestDistance = distance
  }
  return best
}

/**
 * Приказ правой кнопкой: что выбранным units игрока scene.player делать с точкой point (в тайлах) — атаковать врага,
 * копать месторождение, возить, строить или чинить, а нет — идти туда. queue — встать в очередь. Возвращает команды.
 */
export function ordersAt(scene: Scene, units: Entity[], point: { x: number; y: number }, queue: boolean): Command[] {
  const commands: Command[] = []
  const unitAt = (x: number, y: number, own = true) => unitUnder(scene, x, y, own)
  const { sim } = scene
  const x = Math.floor(point.x)
  const y = Math.floor(point.y)
  // Работа для строителей: стройка, разбор или своё повреждённое — здание или юнит.
  const damaged = sim.occupancy.at(x, y)
  const broken = unitAt(point.x, point.y) ?? damaged
  const site = siteAt(sim, x, y) ?? (broken !== undefined && canRepair(sim, scene.player, broken) ? broken : undefined)
  const builders = units.some((entity) => sim.world.has(entity, Repair))
  // То, чему грузовики могут привезти груз: своя стройка или здание под курсором.
  const needy = siteAt(sim, x, y) ?? damaged
  // Строители по своей стройке — строят, по повреждённому зданию или юниту — чинят; остальные выбранные при этом стоят.
  const trucks = units.some((entity) => sim.world.has(entity, Hauler) && !sim.world.has(entity, Harvester))
  // Вооружённые по врагу — атакуют: по чужому юниту или зданию под курсором.
  const enemy = unitAt(point.x, point.y, false) ?? damaged
  const fighters = units.some((entity) => canFight(sim, entity))
  // Харвестеры по месторождению — копают его, если на нём нет шахты.
  const harvesters = units.some((entity) => sim.world.has(entity, Harvester))
  const found = harvesters ? depositNear(sim, point.x, point.y, DEPOSIT_SIZE) : null
  const known = found && sim.vision.exploredIn(scene.player, found.x, found.y, DEPOSIT_SIZE, DEPOSIT_SIZE)
  const deposit = found && known && !hasMine(sim, found) ? found : null
  const onDeposit = deposit && x >= deposit.x && x < deposit.x + DEPOSIT_SIZE && y >= deposit.y && y < deposit.y + DEPOSIT_SIZE
  // Грузовики по своей шахте — привязываются к ней и возят добытое.
  if (fighters && enemy !== undefined && canAttack(sim, scene.player, enemy)) {
    commands.push({ type: 'attack', units, target: enemy, queue })
  } else if (deposit && onDeposit) {
    commands.push({ type: 'harvest', units, x: deposit.x, y: deposit.y, queue })
  } else if (trucks && damaged !== undefined && canHaul(sim, scene.player, damaged)) {
    commands.push({ type: 'haul', units, mine: damaged, queue })
  } else if (trucks && dropAt(sim, x, y) !== undefined) {
    // Грузовики по дропу — вывозят его.
    commands.push({ type: 'pickup', units, drop: dropAt(sim, x, y)!, queue })
  } else if (trucks && needy !== undefined && canSupply(sim, scene.player, needy)) {
    // Грузовики по своему зданию или стройке, которым нужен груз, — обеспечивают их; строители при этом строят.
    const haulers = units.filter((entity) => sim.world.has(entity, Hauler) && !sim.world.has(entity, Harvester))
    commands.push({ type: 'supply', units: haulers, target: needy, queue })
    const rest = units.filter((entity) => !haulers.includes(entity) && sim.world.has(entity, Repair))
    if (rest.length && siteAt(sim, x, y) === needy) commands.push({ type: 'assist', units: rest, site: needy, queue })
  } else if (site !== undefined && builders && isOwn(sim, scene.player, site)) {
    commands.push({ type: 'assist', units, site, queue })
  } else {
    commands.push({ type: 'move', units, x, y, queue })
  }
  return commands
}
