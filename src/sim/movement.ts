import type { Time } from '../ecs'
import { Path, Position, Unit } from './components'
import type { Sim } from './sim'
import { UNITS, isWalkable, orderMove } from './units'

/** Раз в тик: двигает юниты по их путям. */
export function moveUnits(sim: Sim, time: Time) {
  const { world } = sim
  // Клиент рисует юнит между прошлым и нынешним местом, поэтому прошлое запоминается у всех, даже у стоящих.
  for (const [, position, unit] of world.query(Position, Unit)) {
    unit.prevX = position.x
    unit.prevY = position.y
  }

  for (const [entity, position, unit, path] of world.query(Position, Unit, Path)) {
    const { points } = path
    let left = UNITS[unit.type].speed * time.step
    while (left > 0 && points.length) {
      const dx = points[0] - position.x
      const dy = points[1] - position.y
      const distance = Math.hypot(dx, dy)
      const move = Math.min(left, distance)
      const nextX = distance ? position.x + (dx / distance) * move : position.x
      const nextY = distance ? position.y + (dy / distance) * move : position.y

      // Пока юнит шёл, на пути могли что-то построить. Тогда путь прокладывается заново с того места, где он стоит.
      if (!isWalkable(sim, Math.floor(nextX), Math.floor(nextY))) {
        if (path.blocked) world.remove(entity, Path)
        else {
          path.blocked = true
          orderMove(sim, entity, path.goalX, path.goalY)
        }
        break
      }
      path.blocked = false

      if (distance) unit.facing = Math.atan2(dy, dx)
      position.x = nextX
      position.y = nextY
      left -= move
      if (move === distance) points.splice(0, 2)
    }
    if (!points.length) world.remove(entity, Path)
  }
}
