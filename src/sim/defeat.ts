import type { Entity } from '../ecs'
import { CORE } from './buildings'
import { Attached, Building, Doomed, Owner, Pave, Player, Position, Site, Unit } from './components'
import { dropCargo } from './drops'
import type { Sim } from './sim'

/**
 * Проиграл ли игрок: у него нет ни главного здания, ни MCV — новую базу ему не начать. Недостроенное главное здание
 * не считается. Игрока, которого в мире ещё нет, проигравшим не считают.
 */
export function isDefeated(sim: Sim, player: number) {
  const { world } = sim
  let known = false
  for (const [, info] of world.query(Player)) if (info.id === player) known = true
  if (!known) return false
  for (const [, unit, owner] of world.query(Unit, Owner)) if (owner.player === player && unit.type === 'mcv') return false
  for (const [entity, building, owner] of world.query(Building, Owner)) {
    if (owner.player === player && building.type === CORE && !world.has(entity, Site)) return false
  }
  return true
}

/**
 * Убирает игрока из мира: его юниты и здания исчезают, груз с их складов падает на землю дропами, кредиты — в ноль.
 * Покрытие остаётся: дорогами и фундаментом пользуются и другие.
 */
export function wipePlayer(sim: Sim, player: number) {
  const { world } = sim
  const gone: Entity[] = []
  for (const [entity, owner] of world.query(Owner)) if (owner.player === player && !world.has(entity, Pave)) gone.push(entity)
  for (const entity of gone) if (world.alive(entity)) dropCargo(sim, entity)
  for (const entity of gone) if (world.alive(entity)) world.destroy(entity)
  for (const [entity, info] of world.query(Player)) if (info.id === player) world.set(entity, Player, { credits: 0, earned: 0 })
}

/** За сколько секунд волна взрывов при сдаче доходит от главного здания на тайл дальше. */
const BLAST_WAVE = 0.12
/** Первый взрыв — не сразу: игрок успевает понять, что произошло. */
const BLAST_DELAY = 0.6
/** Разброс взрывов одной волны, в секундах. */
const BLAST_JITTER = 0.5

/**
 * Игрок сдаётся — харакири: все его юниты и здания взрываются волной от главного здания (или от середины его войска)
 * наружу, каждое — обычной гибелью, со взрывом, остовом и грузом, упавшим на землю. Недостроенные площадки исчезают
 * сразу. Кредиты — в ноль.
 */
export function surrender(sim: Sim, player: number) {
  const { world, time } = sim
  const doomed: Entity[] = []
  let sumX = 0
  let sumY = 0
  let center: { x: number; y: number } | undefined
  const sites: Entity[] = []
  for (const [entity, owner, position] of world.query(Owner, Position)) {
    if (owner.player !== player || world.has(entity, Pave) || world.has(entity, Attached) || world.has(entity, Doomed)) continue
    if (!world.has(entity, Unit) && !world.has(entity, Building)) {
      if (world.has(entity, Site)) sites.push(entity)
      continue
    }
    doomed.push(entity)
    sumX += position.x
    sumY += position.y
    if (world.get(entity, Building)?.type === CORE) center ??= { x: position.x + 1.5, y: position.y + 1.5 }
  }
  for (const entity of sites) {
    dropCargo(sim, entity)
    world.destroy(entity)
  }
  for (const [entity, info] of world.query(Player)) if (info.id === player) world.set(entity, Player, { credits: 0, earned: 0 })
  if (!doomed.length) return true
  center ??= { x: sumX / doomed.length, y: sumY / doomed.length }
  for (const entity of doomed) {
    const { x, y } = world.get(entity, Position)!
    const jitter = ((entity * 2654435761) % 1000) / 1000
    const seconds = BLAST_DELAY + Math.hypot(x - center.x, y - center.y) * BLAST_WAVE + jitter * BLAST_JITTER
    world.add(entity, Doomed({ left: Math.max(1, Math.round(seconds / time.step)) }))
  }
  return true
}
