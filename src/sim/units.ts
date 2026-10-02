import type { Entity } from '../ecs'
import { isPassable, terrainAt } from '../map/terrain'
import { Converting, Hauler, Owner, Path, Position, Producer, Unit } from './components'
import { STARTING_CREDITS, addCredits } from './economy'
import { findPath, smoothPath } from './path'
import type { Sim } from './sim'

/** Что симуляция знает о виде юнита. Как он выглядит, знает клиент: см. game/units/unitArt.ts. */
export interface UnitSpec {
  /** Скорость в тайлах в секунду. */
  speed: number
  /** Как быстро поворачивает, в радианах в секунду. */
  turn: number
  /** Радиус в тайлах: по нему юнит выбирается мышью и не пускает в себя других юнитов. */
  radius: number
  /** Цена в кредитах и время производства в секундах. */
  cost: number
  buildTime: number
}

export const UNITS = {
  mcv: { speed: 2.5, turn: 2.2, radius: 0.8, cost: 2000, buildTime: 30 },
  builder: { speed: 4, turn: 5, radius: 0.45, cost: 150, buildTime: 5 },
  infantry: { speed: 3, turn: 10, radius: 0.3, cost: 60, buildTime: 3 },
  // Грузовик возит руду из шахты в хранилище: см. hauling.ts.
  truck: { speed: 3.5, turn: 4, radius: 0.45, cost: 200, buildTime: 8 },
} satisfies Record<string, UnitSpec>

export type UnitType = keyof typeof UNITS
export const UNIT_TYPES = Object.keys(UNITS) as UnitType[]

/** С чем игрок появляется в мире. */
const STARTING_UNITS: UnitType[] = ['mcv', 'builder', 'builder', 'infantry', 'infantry', 'infantry']

/** Может ли наземный юнит находиться в тайле: внутри карты, на песке или скале, не в здании. */
export function isWalkable(sim: Sim, x: number, y: number) {
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom) return false
  return isPassable(terrainAt(sim.land, x, y)) && sim.occupancy.at(x, y) === undefined
}

/** Номер тайла одним числом: ключ для множеств тайлов. */
export const tileKey = (x: number, y: number) => (y + 32768) * 65536 + (x + 32768)

/**
 * Тайлы, занятые стоящими юнитами: путь прокладывается в обход них. Идущие юниты сюда не попадают —
 * к тому времени, как до них дойдут, они уйдут; с ними юнит расходится на ходу, см. movement.ts.
 * ignore — кого не считать: сам идущий и те, кто трогается вместе с ним. radius — радиус идущего:
 * тайл занят, если, встав в его центр, идущий задел бы стоящего. Так крупная машина не лезет в щель между соседями.
 */
export function standingUnits(sim: Sim, ignore: ReadonlySet<Entity>, radius: number) {
  const { world } = sim
  const tiles = new Set<number>()
  for (const [entity, position, unit] of world.query(Position, Unit)) {
    if (ignore.has(entity) || world.has(entity, Path)) continue
    const reach = UNITS[unit.type].radius + radius
    for (let y = Math.floor(position.y - reach); y <= Math.floor(position.y + reach); y++) {
      for (let x = Math.floor(position.x - reach); x <= Math.floor(position.x + reach); x++) {
        if (Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y) < reach) tiles.add(tileKey(x, y))
      }
    }
  }
  return tiles
}

/** Шаг между местами юнитов в группе, в тайлах: крупные машины не помещаются в один тайл. */
const GROUP_SPACING = 2

/**
 * Проходимые тайлы вокруг точки, от ближних к дальним: места для группы юнитов, через GROUP_SPACING тайлов.
 * Возвращает не больше count тайлов (x, y подряд); если рядом их меньше — сколько нашлось.
 * fromRadius — с какого кольца начинать: 1 пропускает саму точку. blocked — тайлы, которые тоже не годятся.
 */
export function freeTilesNear(sim: Sim, x: number, y: number, count: number, fromRadius = 0, blocked?: ReadonlySet<number>) {
  const SEARCH_RADIUS = 8
  const tiles: number[] = []
  for (let radius = fromRadius; radius <= SEARCH_RADIUS && tiles.length < count * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Только кольцо на расстоянии radius: внутренние тайлы уже проверены.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const tileX = x + dx * GROUP_SPACING
        const tileY = y + dy * GROUP_SPACING
        if (tiles.length >= count * 2 || blocked?.has(tileKey(tileX, tileY))) continue
        if (isWalkable(sim, tileX, tileY)) tiles.push(tileX, tileY)
      }
    }
  }
  return tiles
}

/** Создаёт юнит в центре тайла (x, y). */
export function spawnUnit(sim: Sim, type: UnitType, player: number, x: number, y: number) {
  const position = { x: x + 0.5, y: y + 0.5 }
  const { world } = sim
  const entity = world.spawn(Position(position), Unit({ type, prevX: position.x, prevY: position.y }), Owner({ player }))
  if (type === 'mcv') world.add(entity, Producer)
  if (type === 'truck') world.add(entity, Hauler)
  return entity
}

/**
 * Стартовый набор игрока вокруг тайла (x, y) и стартовые кредиты.
 * Возвращает созданных юнитов; их меньше, если места не хватило.
 */
export function spawnStartingUnits(sim: Sim, player: number, x: number, y: number) {
  addCredits(sim, player, STARTING_CREDITS)
  const tiles = freeTilesNear(sim, x, y, STARTING_UNITS.length)
  const units: Entity[] = []
  for (let i = 0; i < STARTING_UNITS.length && i * 2 < tiles.length; i++) {
    units.push(spawnUnit(sim, STARTING_UNITS[i], player, tiles[i * 2], tiles[i * 2 + 1]))
  }
  return units
}

/**
 * Отправляет юнит в тайл (x, y): прокладывает путь и кладёт его в компонент Path.
 * Стоящих юнитов путь обходит; если в самой цели кто-то стоит, юнит идёт на свободный тайл рядом.
 * Если идти некуда, юнит остаётся на месте.
 * ignore — кто из стоящих юнитов не препятствие; tries — который раз прокладывается путь к этой цели.
 */
export function orderMove(sim: Sim, entity: Entity, x: number, y: number, ignore?: ReadonlySet<Entity>, tries = 0) {
  const { world } = sim
  const position = world.get(entity, Position)
  // Юнит, который разворачивается, с места не трогается.
  if (!position || world.has(entity, Converting)) return
  const taken = standingUnits(sim, ignore ?? new Set([entity]), UNITS[world.get(entity, Unit)!.type].radius)
  if (taken.has(tileKey(x, y))) {
    const [freeX, freeY] = freeTilesNear(sim, x, y, 1, 1, taken)
    if (freeX === undefined) return void world.remove(entity, Path)
    x = freeX
    y = freeY
  }
  const fromX = Math.floor(position.x)
  const fromY = Math.floor(position.y)
  // Свой тайл проходим всегда: иначе юнит, вставший вплотную к соседу, не смог бы тронуться.
  const walkable = (tileX: number, tileY: number) => {
    if (tileX === fromX && tileY === fromY) return true
    return isWalkable(sim, tileX, tileY) && !taken.has(tileKey(tileX, tileY))
  }
  const tiles = findPath(walkable, fromX, fromY, x, y)
  // Юнит идёт по центрам тайлов.
  const points = smoothPath(
    walkable,
    position.x,
    position.y,
    tiles.map((value) => value + 0.5),
  )
  if (points.length) world.add(entity, Path({ points, goalX: x, goalY: y, tries }))
  else world.remove(entity, Path)
}

/** Отправляет группу к тайлу (x, y): каждому юниту достаётся свой тайл рядом с целью. */
export function orderGroupMove(sim: Sim, units: Entity[], x: number, y: number) {
  // Друг другу юниты группы не препятствие: они трогаются вместе.
  const group = new Set(units)
  const radius = Math.max(...units.map((entity) => UNITS[sim.world.get(entity, Unit)!.type].radius))
  const taken = standingUnits(sim, group, radius)
  const tiles = freeTilesNear(sim, x, y, units.length, 0, taken)
  if (!tiles.length) return
  units.forEach((entity, i) => {
    // Мест может оказаться меньше, чем юнитов; тогда лишние идут в последнее.
    const at = Math.min(i * 2, tiles.length - 2)
    orderMove(sim, entity, tiles[at], tiles[at + 1], group)
  })
}

/**
 * Просит стоящий юнит уступить дорогу тому, кто идёт из (fromX, fromY) в направлении heading: отойти вбок
 * от линии его движения на room тайлов. Отходит в ту сторону, с которой уже стоит; если там занято — в другую.
 */
export function stepAside(sim: Sim, entity: Entity, fromX: number, fromY: number, heading: number, room: number) {
  const { world } = sim
  const position = world.get(entity, Position)
  const unit = world.get(entity, Unit)
  if (!position || !unit || world.has(entity, Path) || world.has(entity, Converting)) return
  const sideX = -Math.sin(heading)
  const sideY = Math.cos(heading)
  const side = (position.x - fromX) * sideX + (position.y - fromY) * sideY >= 0 ? 1 : -1
  const taken = standingUnits(sim, new Set([entity]), UNITS[unit.type].radius)
  for (const sign of [side, -side]) {
    const x = Math.floor(position.x + sideX * sign * room)
    const y = Math.floor(position.y + sideY * sign * room)
    if (!isWalkable(sim, x, y) || taken.has(tileKey(x, y))) continue
    orderMove(sim, entity, x, y)
    return
  }
}

/** Юниты, чей центр лежит внутри прямоугольника в тайлах. */
export function unitsIn(sim: Sim, x: number, y: number, width: number, height: number) {
  const inside: Entity[] = []
  for (const [entity, position] of sim.world.query(Position, Unit)) {
    if (position.x >= x && position.x < x + width && position.y >= y && position.y < y + height) inside.push(entity)
  }
  return inside
}

/**
 * Отправляет юнитов, оказавшихся внутри основания здания, на свободные тайлы рядом.
 * inside — кого именно отправлять; по умолчанию всех, кто там есть.
 */
export function evictUnits(sim: Sim, x: number, y: number, width: number, height: number, inside = unitsIn(sim, x, y, width, height)) {
  if (!inside.length) return
  const group = new Set(inside)
  const taken = standingUnits(sim, group, UNITS.mcv.radius)
  const tiles = freeTilesNear(sim, x + Math.floor(width / 2), y + Math.floor(height / 2), inside.length, 1, taken)
  inside.forEach((entity, i) => {
    const at = Math.min(i * 2, tiles.length - 2)
    if (at >= 0) orderMove(sim, entity, tiles[at], tiles[at + 1], group)
  })
}
