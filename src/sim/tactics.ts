import type { Entity } from '../ecs'
import { isOwn, onTurn } from './common'
import { Armed, Path, Position, Tactics, Unit } from './components'
import type { Sim } from './sim'
import { turretsOf } from './turrets'
import { inBounds, orderMove } from './units'
import { weaponOf } from './combat'

/**
 * Стойка — как юнит воюет без приказа:
 * - aggressive — высматривает врага на всю дальность обзора и гонится за ним, сколько бы ни пришлось;
 * - defensive — бьёт тех, до кого достаёт с места, на огонь отвечает погоней, но не дальше LEASH от места, где стоял,
 *   и потом возвращается туда;
 * - hold — с места не сходит: бьёт только тех, до кого достаёт, и под огнём тоже;
 * - passive — огонь сам не открывает и не отвечает: стреляет только по прямому приказу атаки.
 */
export type Stance = 'aggressive' | 'defensive' | 'hold' | 'passive'
export const STANCES: readonly Stance[] = ['aggressive', 'defensive', 'hold', 'passive']

/** Дальше этого от места, где стоял, юнит в обороне за врагом не гонится, в тайлах. */
export const LEASH = 8
/** Сколько точек может быть в патруле. */
export const PATROL_LIMIT = 8
/** Раз во сколько тиков вставший юнит вспоминает о патруле и о месте, куда вернуться. */
const RESUME_TICKS = 10

/** Стойка юнита: без тактики — оборона. */
export const stanceOf = (sim: Sim, entity: Entity): Stance => sim.world.get(entity, Tactics)?.stance ?? 'defensive'

/** Тактика юнита: заводит её, если её ещё не было. */
function tacticsOf(sim: Sim, entity: Entity) {
  if (!sim.world.has(entity, Tactics)) sim.world.add(entity, Tactics)
  return sim.world.get(entity, Tactics)!
}

/** Свои вооружённые юниты из списка — им и их турелям раздаются стойка и патруль. Безоружные носители — тоже. */
function fightersOf(sim: Sim, player: number, units: Entity[]) {
  return [...new Set(units)].filter((entity) => {
    if (!sim.world.has(entity, Unit) || !isOwn(sim, player, entity)) return false
    return [entity, ...turretsOf(sim, entity)].some((gunner) => sim.world.has(gunner, Armed) && weaponOf(sim, gunner) !== undefined)
  })
}

/** Ставит своим вооружённым юнитам стойку. Неизвестная стойка — ничего. */
export function setStance(sim: Sim, player: number, units: Entity[], stance: Stance) {
  if (!STANCES.includes(stance)) return false
  const fighters = fightersOf(sim, player, units)
  for (const entity of fighters) {
    tacticsOf(sim, entity).stance = stance
    // Стрелять нельзя — бросает и самовыбранную цель; приказанную тоже: игрок сказал «не стрелять».
    if (stance === 'passive') {
      for (const gunner of [entity, ...turretsOf(sim, entity)]) {
        const armed = sim.world.get(gunner, Armed)
        if (armed) Object.assign(armed, { target: -1, chase: false, ordered: false })
      }
    }
  }
  return fighters.length > 0
}

/**
 * Посылает своих вооружённых юнитов в патруль: каждый ходит по кругу от тайла, где стоит, через точки (x, y подряд)
 * и обратно. По пути бьёт врагов по своей стойке, а после боя продолжает обход. append — точки добавляются к уже
 * идущему патрулю; кто не патрулировал, начинает патруль от своего места.
 */
export function orderPatrol(sim: Sim, player: number, units: Entity[], points: number[], append = false) {
  const stops: number[] = []
  for (let i = 0; i + 1 < points.length && stops.length < PATROL_LIMIT * 2; i += 2) {
    if (Number.isInteger(points[i]) && Number.isInteger(points[i + 1]) && inBounds(sim, points[i], points[i + 1])) stops.push(points[i], points[i + 1])
  }
  if (!stops.length) return false
  const fighters = fightersOf(sim, player, units)
  for (const entity of fighters) {
    const { x, y } = sim.world.get(entity, Position)!
    const tactics = tacticsOf(sim, entity)
    if (append && tactics.patrol.length) {
      tactics.patrol.push(...stops.slice(0, Math.max(0, (PATROL_LIMIT + 1) * 2 - tactics.patrol.length)))
      continue
    }
    tactics.patrol = [Math.floor(x), Math.floor(y), ...stops]
    tactics.leg = 1
    tactics.away = false
    orderMove(sim, entity, stops[0], stops[1])
  }
  return fighters.length > 0
}

/** Снимает патруль и возвращение на место: юнит слушает приказ игрока. Стойка остаётся. */
export function clearTactics(sim: Sim, entity: Entity) {
  const tactics = sim.world.get(entity, Tactics)
  if (!tactics) return
  tactics.patrol = []
  tactics.leg = 0
  tactics.away = false
}

/** Юнит уходит в погоню без приказа: запоминает, откуда, чтобы вернуться. В патруле возвращаться некуда — он продолжит обход. */
export function leaveHome(sim: Sim, entity: Entity) {
  const tactics = tacticsOf(sim, entity)
  if (tactics.away || tactics.patrol.length) return
  const { x, y } = sim.world.get(entity, Position)!
  tactics.away = true
  tactics.homeX = Math.floor(x)
  tactics.homeY = Math.floor(y)
}

/** Занят ли юнит боем: у него или у его турелей есть цель. */
function fighting(sim: Sim, entity: Entity) {
  return [entity, ...turretsOf(sim, entity)].some((gunner) => (sim.world.get(gunner, Armed)?.target ?? -1) >= 0)
}

/**
 * Раз в тик, после боя: вставшие юниты без цели продолжают патруль или возвращаются на место, откуда ушли в погоню.
 * Дошедший до точки патруля идёт к следующей.
 */
export function patrol(sim: Sim) {
  const { world, time } = sim
  const moves: { entity: Entity; x: number; y: number }[] = []
  for (const [entity, tactics, position] of world.query(Tactics, Position)) {
    if (world.has(entity, Path) || !onTurn(time, entity, RESUME_TICKS) || fighting(sim, entity)) continue
    if (tactics.patrol.length) {
      const count = tactics.patrol.length / 2
      const goalX = tactics.patrol[tactics.leg * 2]
      const goalY = tactics.patrol[tactics.leg * 2 + 1]
      // Дошёл до точки — к следующей; встал, не дойдя (после боя), — снова к ней.
      if (Math.floor(position.x) === goalX && Math.floor(position.y) === goalY) tactics.leg = (tactics.leg + 1) % count
      moves.push({ entity, x: tactics.patrol[tactics.leg * 2], y: tactics.patrol[tactics.leg * 2 + 1] })
      continue
    }
    if (tactics.away) {
      tactics.away = false
      if (Math.floor(position.x) !== tactics.homeX || Math.floor(position.y) !== tactics.homeY) moves.push({ entity, x: tactics.homeX, y: tactics.homeY })
    }
  }
  for (const { entity, x, y } of moves) orderMove(sim, entity, x, y)
}
