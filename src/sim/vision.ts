import type { Entity, World } from '../ecs'
import { BUILDINGS, buildingSpec } from './buildings'
import { Attached, Building, Owner, Player, Position, Shot, Site, Unit } from './components'
import type { Sim } from './sim'
import type { Bounds } from './sim'
import { TURRETS } from './turrets'
import { unitSpec, type UnitType } from './units'
import { WEAPONS, type UnitClass } from './weapons'

/** Сколько тайлов от своего центра видит юнит каждого класса, если у вида нет своего числа. */
const CLASS_SIGHT: Record<UnitClass, number> = { infantry: 7, vehicle: 8, heavy: 8, air: 10 }
/** Насколько обзор дальше самого дальнобойного оружия: стрелок видит, в кого стреляет, с запасом. */
const SIGHT_OVER_RANGE = 1.5
/** Сколько тайлов от края видит готовое здание и стройка, если у вида нет своего числа. */
const BUILDING_SIGHT = 4
const SITE_SIGHT = 2

/** Дальность самого дальнобойного оружия у вида — своего или на турелях. */
function longestRange(weapon: keyof typeof WEAPONS | undefined, mounts: { turret: keyof typeof TURRETS }[] = []) {
  let range = weapon ? WEAPONS[weapon].range : 0
  for (const { turret } of mounts) {
    const own = (TURRETS[turret] as { weapon?: keyof typeof WEAPONS }).weapon
    if (own) range = Math.max(range, WEAPONS[own].range)
  }
  return range
}

/** Сколько тайлов от своего центра видит юнит вида type. */
export function unitSight(type: UnitType) {
  const spec = unitSpec(type)
  const range = longestRange(spec.weapon, spec.mounts)
  return Math.max(spec.sight ?? CLASS_SIGHT[spec.kind], range ? range + SIGHT_OVER_RANGE : 0)
}

/** Сколько тайлов от своего центра видит здание вида type; стройка видит меньше. */
export function buildingSight(type: keyof typeof BUILDINGS, site = false) {
  const spec = buildingSpec(type)
  const half = Math.max(spec.width, spec.height) / 2
  if (site) return half + SITE_SIGHT
  const range = longestRange(undefined, spec.mounts)
  return Math.max(spec.sight ?? half + BUILDING_SIGHT, range ? range + SIGHT_OVER_RANGE : 0)
}

/**
 * Что видит игрок: тайл открыт сейчас, разведан раньше или ещё не разведан. Считается по его юнитам и зданиям
 * одинаково на хосте — им хост решает, что слать клиенту, — и в клиенте, где по нему рисуется туман.
 */
export interface Vision {
  /** Видит ли игрок тайл сейчас. */
  sees(player: number, x: number, y: number): boolean
  /** Бывал ли тайл в виду игрока. */
  explored(player: number, x: number, y: number): boolean
  /** Видит ли игрок сущность сейчас: юнит — по его тайлу, здание — по любому тайлу основания. Своё видно всегда. */
  seesEntity(player: number, entity: Entity): boolean
  /**
   * Тайлы карты построчно, начиная с левого верхнего: 0 — не разведан, 1 — разведан, 2 — виден сейчас.
   * Для отрисовки тумана; changed растёт, когда что-то в них поменялось.
   */
  cells(player: number): { cells: Uint8Array; changed: number }
  /** Разведано ли хоть что-то в прямоугольнике тайлов: так скрывают месторождения, которых игрок не нашёл. */
  exploredIn(player: number, x: number, y: number, width: number, height: number): boolean
  /**
   * Разведанное игроком — длины чередующихся отрезков «не разведано», «разведано» по тайлам построчно. Его кладут
   * в сохранение и шлют клиенту при подключении: карта, раз открытая, остаётся открытой.
   */
  map(player: number): number[]
  /** Отмечает разведанным всё, что разведано в map. */
  explore(player: number, map: number[]): void
  /** Игроки, для которых что-то считалось. */
  players(): number[]
  /**
   * Пересчитывает обзор всех, у кого что-то есть на карте. Последняя система тика: так разведанное копится
   * и у игроков, которые сейчас не подключены.
   */
  update(): void
  /** Забывает всё: разведанное в том числе. */
  reset(): void
}

const HIDDEN = 0
const EXPLORED = 1
const VISIBLE = 2

interface Sight {
  cells: Uint8Array
  /** Тайлы, открытые при прошлом подсчёте: их при следующем гасят до «разведан». */
  lit: number[]
  tick: number
  changed: number
}

export function createVision(world: World, bounds: Bounds, tick: () => number): Vision {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  const sights = new Map<number, Sight>()

  /** Открывает тайлы в круге радиуса radius вокруг точки (x, y). */
  const stamp = (sight: Sight, x: number, y: number, radius: number) => {
    const reach = radius * radius
    const fromY = Math.max(bounds.top, Math.floor(y - radius))
    const toY = Math.min(bounds.bottom - 1, Math.floor(y + radius))
    for (let tileY = fromY; tileY <= toY; tileY++) {
      const dy = tileY + 0.5 - y
      const span = Math.sqrt(Math.max(0, reach - dy * dy))
      const fromX = Math.max(bounds.left, Math.floor(x - span))
      const toX = Math.min(bounds.right - 1, Math.floor(x + span))
      const row = (tileY - bounds.top) * width - bounds.left
      for (let tileX = fromX; tileX <= toX; tileX++) {
        const index = row + tileX
        if (sight.cells[index] === VISIBLE) continue
        sight.cells[index] = VISIBLE
        sight.lit.push(index)
      }
    }
  }

  /** Пересчитывает видимое игроком, если с прошлого подсчёта прошёл тик. */
  const sightOf = (player: number) => {
    let sight = sights.get(player)
    if (!sight) {
      sight = { cells: new Uint8Array(width * height), lit: [], tick: -1, changed: 0 }
      sights.set(player, sight)
    }
    const now = tick()
    if (sight.tick === now) return sight
    sight.tick = now
    const before = sight.lit
    for (const index of before) sight.cells[index] = EXPLORED
    sight.lit = []
    for (const [entity, owner, position] of world.query(Owner, Position)) {
      if (owner.player !== player || world.has(entity, Attached)) continue
      const unit = world.get(entity, Unit)
      if (unit) {
        stamp(sight, position.x, position.y, unitSight(unit.type))
        continue
      }
      const building = world.get(entity, Building)
      if (!building) continue
      const { width: w, height: h } = BUILDINGS[building.type]
      stamp(sight, position.x + w / 2, position.y + h / 2, buildingSight(building.type, world.has(entity, Site)))
    }
    if (before.length !== sight.lit.length || before.some((index, i) => index !== sight!.lit[i])) sight.changed++
    return sight
  }

  const indexOf = (x: number, y: number) => {
    const tileX = Math.floor(x)
    const tileY = Math.floor(y)
    if (tileX < bounds.left || tileX >= bounds.right || tileY < bounds.top || tileY >= bounds.bottom) return -1
    return (tileY - bounds.top) * width + tileX - bounds.left
  }

  const vision: Vision = {
    sees(player, x, y) {
      const index = indexOf(x, y)
      return index >= 0 && sightOf(player).cells[index] === VISIBLE
    },
    explored(player, x, y) {
      const index = indexOf(x, y)
      return index >= 0 && sightOf(player).cells[index] !== HIDDEN
    },
    seesEntity(player, entity) {
      const parent = world.get(entity, Attached)?.parent
      const target = parent === undefined ? entity : (parent as Entity)
      if (world.get(target, Owner)?.player === player) return true
      const position = world.get(target, Position)
      if (!position) return false
      const building = world.get(target, Building)
      if (!building) return vision.sees(player, position.x, position.y)
      const { width: w, height: h } = BUILDINGS[building.type]
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (vision.sees(player, position.x + x, position.y + y)) return true
      return false
    },
    cells(player) {
      const { cells, changed } = sightOf(player)
      return { cells, changed }
    },
    exploredIn(player, x, y, w, h) {
      for (let tileY = Math.floor(y); tileY < y + h; tileY++) for (let tileX = Math.floor(x); tileX < x + w; tileX++) if (vision.explored(player, tileX, tileY)) return true
      return false
    },
    map(player) {
      const { cells } = sightOf(player)
      const runs: number[] = []
      let value = 0
      let run = 0
      for (let i = 0; i < cells.length; i++) {
        const next = cells[i] === HIDDEN ? 0 : 1
        if (next !== value) {
          runs.push(run)
          value = next
          run = 0
        }
        run++
      }
      runs.push(run)
      return runs
    },
    explore(player, map) {
      const { cells } = sightOf(player)
      let index = 0
      map.forEach((run, i) => {
        const end = Math.min(cells.length, index + run)
        if (i % 2) for (let j = index; j < end; j++) if (cells[j] === HIDDEN) cells[j] = EXPLORED
        index = end
      })
      sights.get(player)!.changed++
    },
    players: () => [...sights.keys()],
    update() {
      const players = new Set<number>()
      for (const [, owner] of world.query(Owner, Position)) if (owner.player) players.add(owner.player)
      for (const player of players) sightOf(player)
    },
    reset() {
      sights.clear()
    },
  }
  return vision
}

/**
 * Узнаёт ли игрок о сущности: так хост решает, что слать клиенту. Своё — всегда; чужого игрока — его счёт — никогда;
 * выстрел — если виден снаряд, стрелок или место попадания: по выстрелу из тумана видно, откуда бьют. Остальное
 * с местом на карте — пока оно в обзоре; без места — всегда.
 */
export function shownTo(sim: Sim, player: number, entity: Entity) {
  const { world, vision } = sim
  const owner = world.get(entity, Player)
  if (owner) return owner.id === player
  const shot = world.get(entity, Shot)
  if (shot) {
    const at = world.get(entity, Position)
    return (
      shot.player === player ||
      vision.sees(player, shot.fromX, shot.fromY) ||
      vision.sees(player, shot.toX, shot.toY) ||
      (at !== undefined && vision.sees(player, at.x, at.y))
    )
  }
  if (!world.has(entity, Position)) return true
  return vision.seesEntity(player, entity)
}
