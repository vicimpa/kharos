import type { Entity, Time } from '../ecs'
import { Owner } from './components'
import type { Sim } from './sim'

/** Значение поля-ссылки на сущность, когда ссылаться не на кого. */
export const NONE = -1

/** Полный оборот в радианах. */
export const TURN = Math.PI * 2

/** Угол, приведённый к промежутку от -π до π. */
export const wrap = (angle: number) => angle - TURN * Math.round(angle / TURN)

/** Куда будет смотреть тот, кто поворачивается от facing к wanted не больше чем на maxTurn радиан. */
export function turnToward(facing: number, wanted: number, maxTurn: number) {
  const off = wrap(wanted - facing)
  return Math.abs(off) <= maxTurn ? wanted : wrap(facing + Math.sign(off) * maxTurn)
}

/** Расстояние от точки до прямоугольника в тайлах; внутри него — ноль. */
export function rectDistance(left: number, top: number, width: number, height: number, x: number, y: number) {
  return Math.hypot(Math.max(left - x, 0, x - left - width), Math.max(top - y, 0, y - top - height))
}

/** Чья это сущность. Ничья и та, у которой владельца нет вовсе, — игрока 0. */
export const ownerOf = (sim: Sim, entity: Entity) => sim.world.get(entity, Owner)?.player ?? 0

/** Принадлежит ли сущность игроку. */
export const isOwn = (sim: Sim, player: number, entity: Entity) => sim.world.get(entity, Owner)?.player === player

/**
 * Пришла ли очередь сущности делать то, что делается раз в ticks тиков. Очередь у каждой своя:
 * так дорогая работа не достаётся всем в один тик.
 */
export const onTurn = (time: Time, entity: Entity, ticks: number) => (time.tick + entity) % ticks === 0

/** Ближайший из items, но не дальше limit; undefined — таких нет. distance — расстояние до item. */
export function nearest<T>(items: Iterable<T>, distance: (item: T) => number, limit = Infinity): T | undefined {
  let best: T | undefined
  let bestDistance = limit
  for (const item of items) {
    const value = distance(item)
    if (value < bestDistance) {
      best = item
      bestDistance = value
    }
  }
  return best
}

/** Занят ли грузовик работой у коннектора прямо сейчас: приехал к нему сам, а не ждёт очереди. */
export const holdsDock = (hauler: { mine: number; port: number; waiting: boolean }) =>
  (hauler.mine !== NONE || hauler.port !== NONE) && !hauler.waiting
