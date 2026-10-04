/**
 * Общее для всех разделов харнесса: мир по умолчанию, шаг времени, поиск места под сцену и печать таблиц.
 * Сцены ставятся той же симуляцией и на той же карте, что и в игре: харнесс ничего не подкручивает.
 */
import type { Entity } from '../../src/ecs'
import { DEFAULT_SETTINGS } from '../../src/map/settings'
import { BUILDINGS, Building, Position, Site, canPlace, createSim, isWalkable, type BuildingType, type Sim } from '../../src/sim'
import { placeBuilding } from '../../src/sim/buildings'

/** Шаг симуляции в секундах: 20 тиков в секунду, как в игре. */
export const TICK = 1 / 20

/** Мир харнесса: карта по умолчанию — та же, на которой играют. */
export const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
export const newSim = (): Sim => createSim(options)

/** Прокручивает симуляцию на time секунд. */
export function seconds(sim: Sim, time: number) {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Крутит симуляцию, пока условие не выполнится. false — не дождались за limit секунд. */
export function until(sim: Sim, done: () => boolean, limit = 300) {
  for (let i = 0; i < Math.round(limit / TICK); i++) {
    if (done()) return true
    sim.advance(TICK)
  }
  return false
}

export const round = (value: number, digits = 2) => Number(value.toFixed(digits))
export const pad = (value: string | number, width: number) => String(value).padStart(width)
/** Время в секундах как «м:сс». */
export const clock = (time: number) => `${Math.floor(time / 60)}:${pad(Math.floor(time % 60), 2)}`

/** Печатает таблицу: первый столбец шире остальных. */
export function printTable(head: (string | number)[], rows: (string | number)[][], first = 14, rest = 9) {
  const line = (cells: (string | number)[]) => [pad(cells[0], first), ...cells.slice(1).map((cell) => pad(cell, rest))].join(' ')
  console.log(line(head))
  for (const row of rows) console.log(line(row))
}

/** Левый верхний тайл ровной проходимой площадки width×height — место под сцену боя или осады. */
export function arena(sim: Sim, width: number, height: number) {
  for (let y = -200; y < 200; y++) {
    search: for (let x = -200; x < 200; x++) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) if (!isWalkable(sim, x + dx, y + dy)) continue search
      }
      return { x, y }
    }
  }
  throw new Error(`Не нашлось площадки ${width}×${height}`)
}

/** Тайлы вокруг (x, y) кольцами, от ближних к дальним, до radius включительно. */
export function* rings(x: number, y: number, radius: number) {
  for (let ring = 0; ring <= radius; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) yield { x: x + dx, y: y + dy }
      }
    }
  }
}

/** Ближайшее к (x, y) место, где подходит ok; undefined — не нашлось. */
export function spotNear(x: number, y: number, ok: (x: number, y: number) => boolean, radius = 16) {
  for (const tile of rings(Math.round(x), Math.round(y), radius)) if (ok(tile.x, tile.y)) return tile
  return undefined
}

/** Ближайшее к (x, y) место, где здание этого вида поместится и не заденет соседей. */
export function placeableNear(sim: Sim, type: BuildingType, x: number, y: number, gap = 1, radius = 16) {
  return spotNear(Math.round(x), Math.round(y), (tx, ty) => canPlace(sim, type, tx, ty, gap), radius)
}

/** Ставит готовое здание ближайшим подходящим местом к (x, y). undefined — места нет. */
export function placeNear(sim: Sim, type: BuildingType, x: number, y: number, player: number, gap = 1): Entity | undefined {
  const spot = placeableNear(sim, type, x, y, gap)
  return spot && placeBuilding(sim.world, type, spot.x, spot.y, player)
}

/** Центр здания или место юнита — то, от чего считается расстояние. */
export function centerOf(sim: Sim, entity: Entity) {
  const position = sim.world.get(entity, Position)!
  const type = sim.world.get(entity, Building)?.type ?? sim.world.get(entity, Site)?.type
  if (type === undefined) return { x: position.x, y: position.y }
  return { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2 }
}

/**
 * Живое здание этого вида на этом месте: undefined — места пусто или там уже другое. Ищем по месту, а не по
 * запомненному Entity: уничтоженная сущность освобождает номер, и его может занять выстрел.
 */
export function buildingAt(sim: Sim, type: BuildingType, x: number, y: number) {
  for (const [entity, building, position] of sim.world.query(Building, Position)) {
    if (building.type === type && position.x === x && position.y === y) return entity
  }
  return undefined
}

/** Прямоугольник в тайлах: левый верхний тайл и размеры. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Разошлись ли прямоугольники на gap тайлов: false — они пересекаются или стоят вплотную. */
export function rectsApart(a: Rect, b: Rect, gap = 0) {
  return a.x >= b.x + b.width + gap || b.x >= a.x + a.width + gap || a.y >= b.y + b.height + gap || b.y >= a.y + a.height + gap
}

/** Прямоугольник здания этого вида с левым верхним тайлом в (x, y). */
export const rectOf = (type: BuildingType, x: number, y: number): Rect => ({ x, y, ...BUILDINGS[type] })
