import type { Entity, Time } from '../ecs'
import { tileKey } from '../map/terrain'
import { ownerOf, turnToward, wrap } from './common'
import { Path, Position, Unit } from './components'
import { searchedTiles } from './path'
import type { Sim } from './sim'
import { UNITS, canStand, flies, orderMove, stepAside, terrainSpeed } from './units'

/** Сколько тиков юнит ждёт, не в силах сдвинуться, прежде чем проложить путь заново. */
const WAIT_TICKS = 20
/** Через сколько тиков ожидания юнит просит своего стоящего соседа уступить дорогу. */
const YIELD_TICKS = 4
/** Сколько раз путь к одной точке прокладывается заново, прежде чем юнит сдастся и встанет. */
const MAX_TRIES = 3
/** На сколько тайлов вперёд юнит смотрит, нет ли на пути другого юнита. */
const LOOK_AHEAD = 0.6
/** На столько тайлов юнитам можно заходить друг в друга: без допуска они цеплялись бы, проходя вплотную. */
const OVERLAP = 0.02
/** Промежуточная точка пути засчитывается, когда юнит подошёл к ней на столько тайлов. */
const REACHED = 0.2
/**
 * Последняя точка пути занята другим юнитом: тогда юнит, подъехав к ней на столько тайлов сверх их радиусов,
 * считает, что приехал. Иначе двое с одной целью кружили бы друг вокруг друга без конца.
 */
const SETTLE = 1
/** Во сколько раз круг разворота считается шире настоящего, когда решается, попадёт ли юнит в точку на ходу. */
const ORBIT_MARGIN = 1.3
/**
 * Куда юнит пробует свернуть, если прямо занято: отклонения от нужного направления в радианах, по порядку.
 * Сначала вправо — так двое встречных расходятся в разные стороны, а не зеркалят друг друга.
 */
const DETOURS = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75]
/** Сколько юнитов за тик прокладывают путь заново и сколько уступают дорогу; остальные ждут следующего тика. */
const LOST_SEARCHES = 8
const YIELD_SEARCHES = 8
/** Сколько тайлов за тик вместе осматривают перепрокладывающие путь; остальные ждут следующего тика. */
const LOST_TILES = 8000
/** Сторона ячейки сетки, по которой ищутся соседи, в тайлах. Больше любого расстояния, на котором юниты мешают друг другу. */
const CELL = 4

interface Body {
  entity: Entity
  position: { x: number; y: number }
  radius: number
  /** Летающий: с наземными он не сталкивается. */
  air: boolean
}

/**
 * Раз в тик: двигает юниты по их путям. Юнит поворачивает не мгновенно, а со своей скоростью поворота,
 * и едет туда, куда смотрит, — поэтому на поворотах описывает дугу. Другие юниты для него препятствия:
 * он не входит в них и пробует объехать. Летающие летят по прямой над всем и мешают только друг другу.
 */
export function moveUnits(sim: Sim, time: Time) {
  const { world } = sim
  const cells = new Map<number, Body[]>()
  // Клиент рисует юнит между прошлым и нынешним положением, поэтому прошлое запоминается у всех, даже у стоящих.
  for (const [entity, position, unit] of world.query(Position, Unit)) {
    unit.prevX = position.x
    unit.prevY = position.y
    unit.prevFacing = unit.facing
    // Сетка строится по местам на начало тика: за тик юнит сдвигается куда меньше, чем на ячейку.
    const key = tileKey(Math.floor(position.x / CELL), Math.floor(position.y / CELL))
    const body = { entity, position, radius: UNITS[unit.type].radius, air: flies(unit.type) }
    const cell = cells.get(key)
    if (cell) cell.push(body)
    else cells.set(key, [body])
  }

  /** Кого юнит заденет, пройдя по прямой из (fromX, fromY) в (toX, toY). */
  const collides = (self: Entity, air: boolean, radius: number, fromX: number, fromY: number, toX: number, toY: number) => {
    const dx = toX - fromX
    const dy = toY - fromY
    const lengthSquared = dx * dx + dy * dy
    const cellX = Math.floor(fromX / CELL)
    const cellY = Math.floor(fromY / CELL)
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        const cell = cells.get(tileKey(x, y))
        if (!cell) continue
        for (const other of cell) {
          if (other.entity === self || other.air !== air) continue
          const reach = radius + other.radius - OVERLAP
          const offsetX = other.position.x - fromX
          const offsetY = other.position.y - fromY
          const along = offsetX * dx + offsetY * dy
          // Уже стоят друг в друге (так бывает сразу после появления): расходиться можно, сближаться нельзя.
          if (offsetX * offsetX + offsetY * offsetY < reach * reach) {
            if (along > 0) return other
            continue
          }
          const share = lengthSquared ? Math.min(1, Math.max(0, along / lengthSquared)) : 0
          const gapX = offsetX - dx * share
          const gapY = offsetY - dy * share
          if (gapX * gapX + gapY * gapY < reach * reach) return other
        }
      }
    }
    return undefined
  }

  // Пути меняются после обхода: во время него состав мира трогать нельзя.
  const stopped: Entity[] = []
  const lost: { entity: Entity; x: number; y: number; tries: number; near: number }[] = []
  const asked: { entity: Entity; by: Entity; x: number; y: number; heading: number; room: number }[] = []
  /** Юнит не может идти дальше: прокладывает путь заново или, если уже пробовал, встаёт. */
  const giveUp = (entity: Entity, path: { goalX: number; goalY: number; tries: number; near: number }) => {
    if (path.tries >= MAX_TRIES) stopped.push(entity)
    // Сверх нормы — юнит просто ждёт дальше и попробует в следующий тик.
    else if (lost.length < LOST_SEARCHES) lost.push({ entity, x: path.goalX, y: path.goalY, tries: path.tries + 1, near: path.near })
  }

  for (const [entity, position, unit, path] of world.query(Position, Unit, Path)) {
    const { points } = path
    const { speed, turn, radius } = UNITS[unit.type]
    const air = flies(unit.type)
    const dx = points[0] - position.x
    const dy = points[1] - position.y
    const distance = Math.hypot(dx, dy)
    const wanted = distance ? Math.atan2(dy, dx) : unit.facing

    // Юнит, под которым выросло здание, выходит из него: внутри здания тайлы ему не преграда.
    const inside = !canStand(sim, air, Math.floor(position.x), Math.floor(position.y))

    // Куда ехать: прямо к точке пути, а если там другой юнит — в ближайшую свободную сторону.
    const look = Math.min(distance, LOOK_AHEAD)
    let heading: number | undefined
    /** Кто стоит прямо на пути к точке. */
    let ahead: Body | undefined
    for (const detour of DETOURS) {
      const angle = wanted + detour
      const lookX = position.x + Math.cos(angle) * look
      const lookY = position.y + Math.sin(angle) * look
      // Прямой путь проверен, когда прокладывался; в стороне от него может оказаться стена.
      if (detour && !inside && !canStand(sim, air, Math.floor(lookX), Math.floor(lookY))) continue
      const other = collides(entity, air, radius, position.x, position.y, lookX, lookY)
      if (!detour) ahead = other
      if (other) continue
      heading = wrap(angle)
      break
    }
    // Последнюю точку занял тот, кто мешает проехать прямо: ближе к ней не подъехать — юнит встаёт, где стоит.
    if (ahead && points.length === 2) {
      const reach = radius + ahead.radius
      const taken = Math.hypot(ahead.position.x - points[0], ahead.position.y - points[1]) < reach
      if (taken && distance < reach + SETTLE) {
        stopped.push(entity)
        continue
      }
    }
    const direct = heading === wrap(wanted)
    heading ??= wrap(wanted)

    unit.facing = turnToward(unit.facing, heading, turn * time.step)
    const aligned = unit.facing === heading

    // Чем сильнее юнит смотрит в сторону, тем медленнее едет; развернувшись больше чем на четверть оборота, крутится на месте.
    const askew = Math.abs(wrap(heading - unit.facing))
    // Песок и болото замедляют наземных: см. terrainSpeed.
    let move = speed * terrainSpeed(sim, unit.type, Math.floor(position.x), Math.floor(position.y)) * time.step * Math.max(0, Math.cos(askew))
    // Точка внутри круга, который юнит описывает на полном ходу: в неё не попасть, сколько ни кружи.
    // Тогда он доворачивает на месте. Запас — на то, что поворот идёт шагами.
    if (direct && distance < ((2 * speed) / turn) * Math.sin(Math.min(askew, Math.PI / 2)) * ORBIT_MARGIN) move = 0
    // Глядя точно на точку пути, юнит приходит в неё ровно, без перелёта.
    const arrives = aligned && direct && move >= distance
    if (arrives) move = distance
    if (move > 0) {
      const nextX = arrives ? points[0] : position.x + Math.cos(unit.facing) * move
      const nextY = arrives ? points[1] : position.y + Math.sin(unit.facing) * move
      const open = inside || canStand(sim, air, Math.floor(nextX), Math.floor(nextY))
      const blocker = open ? collides(entity, air, radius, position.x, position.y, nextX, nextY) : undefined
      if (open && !blocker) {
        position.x = nextX
        position.y = nextY
        path.wait = 0
      } else if (!open && aligned && direct) {
        // Пока юнит шёл, на пути что-то построили: ждать нечего.
        giveUp(entity, path)
        continue
      } else if (++path.wait >= WAIT_TICKS) {
        giveUp(entity, path)
        continue
      } else if (blocker && path.wait === YIELD_TICKS && asked.length < YIELD_SEARCHES) {
        const room = radius + blocker.radius + 1
        asked.push({ entity: blocker.entity, by: entity, x: position.x, y: position.y, heading: wrap(wanted), room })
      }
    } else if (!distance) {
      path.wait = 0
    }

    const last = points.length === 2
    const left = Math.hypot(points[0] - position.x, points[1] - position.y)
    // В последнюю точку юнит встаёт точно, промежуточные проезжает по дуге.
    if (left === 0 || (!last && left < REACHED)) {
      points.splice(0, 2)
      path.tries = 0
      if (!points.length) stopped.push(entity)
    }
  }

  for (const entity of stopped) world.remove(entity, Path)
  const searchedBefore = searchedTiles()
  for (const { entity, x, y, tries, near } of lost) {
    // Не уложившиеся в норму ждут дальше: их путь цел, и в следующий тик они попробуют снова.
    if (searchedTiles() - searchedBefore >= LOST_TILES) break
    orderMove(sim, entity, x, y, undefined, tries, near)
  }
  // Дорогу уступают только своим: чужой юнит стоит, где стоял.
  for (const { entity, by, x, y, heading, room } of asked) {
    if (ownerOf(sim, entity) === ownerOf(sim, by)) stepAside(sim, entity, x, y, heading, room)
  }
}
