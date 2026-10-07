import type { Entity, Time } from '../ecs'
import { tileKey } from '../map/terrain'
import { onTurn, ownerOf, turnToward, wrap } from './common'
import { Path, Position, Unit } from './components'
import { searchedTiles } from './path'
import type { Sim } from './sim'
import { UNITS, canStand, fastestOf, flies, orderMove, roadInSight, stepAside, terrainSpeed } from './units'

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
/** Раз во сколько тиков идущий юнит смотрит, не показалась ли в обзоре дорога. */
const ROAD_LOOK_TICKS = 20
/**
 * Насколько дальше суммы радиусов сосед ещё может помешать за тик: юнит смотрит вперёд на LOOK_AHEAD, а шагает
 * не дальше — самый быстрый проходит за тик меньше половины тайла.
 */
const NEIGHBOUR_REACH = LOOK_AHEAD + 0.1
/**
 * Сторона ячейки сетки, по которой ищутся соседи, в тайлах. Больше любого расстояния, на котором мешают друг другу
 * юниты не крупнее LARGE: тогда соседи — в девяти ячейках вокруг. Чем мельче ячейка, тем меньше в толпе лишних.
 */
const CELL = 2.5
/** Юниты крупнее этого радиуса — редкость: в сетку они не кладутся, их проверяет каждый. */
const LARGE = 0.9

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
  const large: Body[] = []
  // Клиент рисует юнит между прошлым и нынешним положением, поэтому прошлое запоминается у всех, даже у стоящих.
  for (const [entity, position, unit] of world.query(Position, Unit)) {
    unit.prevX = position.x
    unit.prevY = position.y
    unit.prevFacing = unit.facing
    // Сетка строится по местам на начало тика: за тик юнит сдвигается куда меньше, чем на ячейку.
    const key = tileKey(Math.floor(position.x / CELL), Math.floor(position.y / CELL))
    const body = { entity, position, radius: UNITS[unit.type].radius, air: flies(unit.type) }
    if (body.radius > LARGE) {
      large.push(body)
      continue
    }
    const cell = cells.get(key)
    if (cell) cell.push(body)
    else cells.set(key, [body])
  }

  /**
   * Соседи юнита в (x, y), которых он может задеть за тик: и глядя вперёд, и шагнув. Собираются раз на юнит,
   * а не на каждый пробуемый обход: в толпе их пробуется до десятка.
   */
  const neighbours: Body[] = []
  const gather = (self: Entity, air: boolean, radius: number, x: number, y: number) => {
    neighbours.length = 0
    const check = (other: Body) => {
      if (other.entity === self || other.air !== air) return
      const reach = radius + other.radius + NEIGHBOUR_REACH
      const offsetX = other.position.x - x
      const offsetY = other.position.y - y
      if (offsetX * offsetX + offsetY * offsetY < reach * reach) neighbours.push(other)
    }
    // Крупному юниту мешают и те, что дальше соседних ячеек.
    const span = radius > LARGE ? Math.ceil((radius + LARGE + NEIGHBOUR_REACH) / CELL) : 1
    const cellX = Math.floor(x / CELL)
    const cellY = Math.floor(y / CELL)
    for (let cy = cellY - span; cy <= cellY + span; cy++) {
      for (let cx = cellX - span; cx <= cellX + span; cx++) {
        const cell = cells.get(tileKey(cx, cy))
        if (cell) for (const other of cell) check(other)
      }
    }
    for (const other of large) check(other)
  }

  /** Кого из соседей юнит заденет, пройдя по прямой из (fromX, fromY) в (toX, toY). Соседей собирает gather. */
  const collides = (radius: number, fromX: number, fromY: number, toX: number, toY: number) => {
    const dx = toX - fromX
    const dy = toY - fromY
    const lengthSquared = dx * dx + dy * dy
    for (const other of neighbours) {
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
    return undefined
  }

  // Пути меняются после обхода: во время него состав мира трогать нельзя.
  const stopped: Entity[] = []
  const lost: { entity: Entity; x: number; y: number; tries: number; near: number }[] = []
  /** Дошедшие до конца пути, не дойдя до цели: ищут путь дальше. */
  const further: { entity: Entity; x: number; y: number; tries: number; near: number; from?: number }[] = []
  const asked: { entity: Entity; by: Entity; x: number; y: number; heading: number; room: number }[] = []
  /** Увидевшие дорогу на ходу: перестраивают путь с ней. */
  const roadward: { entity: Entity; x: number; y: number; near: number }[] = []
  /** Юнит не может идти дальше: прокладывает путь заново или, если уже пробовал, встаёт. */
  const giveUp = (entity: Entity, path: { goalX: number; goalY: number; tries: number; near: number; wait: number; direct: boolean; stuck: boolean }) => {
    // Ехал напрямую: путь ему проложит planPaths, по очереди с другими упёршимися.
    if (path.direct) {
      path.wait = 0
      path.stuck = true
    }
    else if (path.tries >= MAX_TRIES) stopped.push(entity)
    // Сверх нормы — юнит просто ждёт дальше и попробует в следующий тик.
    else if (lost.length < LOST_SEARCHES) lost.push({ entity, x: path.goalX, y: path.goalY, tries: path.tries + 1, near: path.near })
  }

  for (const [entity, position, unit, path] of world.query(Position, Unit, Path)) {
    const { points } = path
    const { speed, turn, radius } = UNITS[unit.type]
    const air = flies(unit.type)
    // Путь проложен без дороги, а она показалась в обзоре — юнит прикинет путь заново. Смотрит не каждый тик.
    if (!path.roads && fastestOf(unit.type) > 1 && onTurn(time, entity, ROAD_LOOK_TICKS) && roadInSight(sim, entity)) {
      roadward.push({ entity, x: path.goalX, y: path.goalY, near: path.near })
    }
    const dx = points[0] - position.x
    const dy = points[1] - position.y
    const distance = Math.hypot(dx, dy)
    const wanted = distance ? Math.atan2(dy, dx) : unit.facing

    // Юнит, под которым выросло здание, выходит из него: внутри здания тайлы ему не преграда.
    const inside = !canStand(sim, air, Math.floor(position.x), Math.floor(position.y))

    gather(entity, air, radius, position.x, position.y)
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
      const other = collides(radius, position.x, position.y, lookX, lookY)
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
      const blocker = open ? collides(radius, position.x, position.y, nextX, nextY) : undefined
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
      if (!points.length) {
        // Поиск пути ограничен, и до далёкой цели путь мог кончиться раньше неё: оттуда юнит ищет дальше.
        const tileX = Math.floor(position.x)
        const tileY = Math.floor(position.y)
        const reached = path.near ? (tileX - path.goalX) ** 2 + (tileY - path.goalY) ** 2 <= path.near ** 2 : tileX === path.goalX && tileY === path.goalY
        if (reached || air) stopped.push(entity)
        else further.push({ entity, x: path.goalX, y: path.goalY, tries: 0, near: path.near })
      }
    }
  }

  for (const entity of stopped) world.remove(entity, Path)
  const searchedBefore = searchedTiles()
  for (const { entity, x, y, near } of further) {
    // Поиски сверх нормы тика отложены: юнит постоит и поищет в следующий тик.
    const path = world.get(entity, Path)!
    if (searchedTiles() - searchedBefore >= LOST_TILES) {
      const position = world.get(entity, Position)!
      path.points.push(position.x, position.y)
      continue
    }
    const before = world.get(entity, Position)!
    const fromX = Math.floor(before.x)
    const fromY = Math.floor(before.y)
    orderMove(sim, entity, x, y, undefined, 0, near)
    // Ближе к цели не подойти — встаёт: иначе искал бы на месте каждый тик.
    const next = world.get(entity, Path)
    const end = next?.points.length ? [Math.floor(next.points.at(-2)!), Math.floor(next.points.at(-1)!)] : undefined
    if (end && end[0] === fromX && end[1] === fromY) world.remove(entity, Path)
  }
  for (const { entity, x, y, near } of roadward) {
    if (searchedTiles() - searchedBefore >= LOST_TILES) break
    if (!world.has(entity, Path)) continue
    // Новый путь помнит, что дорогу уже учёл, и второй раз её не ищет.
    orderMove(sim, entity, x, y, undefined, 0, near)
  }
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

/** Сколько тайлов за тик осматривают поиски пути упёршихся юнитов, ехавших напрямую. */
const PLAN_TILES = 20000

/**
 * Раз в тик, до движения: прокладывает пути юнитам, которые ехали к цели напрямую и упёрлись (Path.stuck), пока
 * не кончится норма тика. Первый в очереди получает путь всегда. Кто не дождался, ждёт следующего тика.
 */
export function planPaths(sim: Sim) {
  const { world } = sim
  const waiting: Entity[] = []
  for (const [entity, path] of world.query(Path)) if (path.direct && path.stuck) waiting.push(entity)
  const searchedBefore = searchedTiles()
  for (const entity of waiting) {
    const path = world.get(entity, Path)
    if (!path?.stuck) continue
    orderMove(sim, entity, path.goalX, path.goalY, undefined, 0, path.near)
    if (searchedTiles() - searchedBefore >= PLAN_TILES) break
  }
}
