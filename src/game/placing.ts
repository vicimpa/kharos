import { BUILDINGS, DEPOSIT_SIZE, Owner, PAVE_LIMIT, canBuild, canPave, canPlace, depositNear, isWalkable, paveCost, type BuildingSpec, type BuildingType } from '../sim'
import type { PaveTool, Scene, Spawn } from './scene'

/** Где встанет здание, которое игрок сейчас выбирает место: левый верхний тайл основания и годится ли место. */
export interface Placement {
  type: BuildingType
  x: number
  y: number
  allowed: boolean
}

/** С какого расстояния от указателя до центра месторождения шахта сама встаёт на него, в тайлах. */
const SNAP = 3

/**
 * Место под выбранное здание: основание стоит серединой под указателем мыши. Шахта притягивается
 * к месторождению рядом с указателем: попадать в него тайл в тайл не нужно. Вне режима выбора места — null.
 */
export function placementOf(scene: Scene): Placement | null {
  const type = scene.placing
  const tile = scene.camera.pointerTile
  if (!type || !tile) return null
  const { width, height, extract }: BuildingSpec = BUILDINGS[type]
  let x = tile.x - Math.floor(width / 2)
  let y = tile.y - Math.floor(height / 2)
  const near = extract && width === DEPOSIT_SIZE ? depositNear(scene.sim, tile.x + 0.5, tile.y + 0.5, SNAP) : null
  // К месторождению, которого игрок не нашёл, шахта не липнет: иначе выдала бы, где оно.
  const deposit = near && scene.sim.vision.exploredIn(scene.player, near.x, near.y, DEPOSIT_SIZE, DEPOSIT_SIZE) ? near : null
  if (deposit) {
    x = deposit.x
    y = deposit.y
  }
  return { type, x, y, allowed: canBuild(scene.sim, scene.player, type, x, y) }
}

/** Призрак отладочного спавна: что и где встанет по щелчку и можно ли туда. Здание — серединой под указателем, юнит — в тайле под ним. */
export interface SpawnGhost {
  spawn: Spawn
  x: number
  y: number
  allowed: boolean
}

export function spawnGhostOf(scene: Scene): SpawnGhost | null {
  const spawn = scene.spawning
  const tile = scene.camera.pointerTile
  if (!spawn || !tile) return null
  if (spawn.kind === 'building') {
    const { width, height } = BUILDINGS[spawn.type]
    const x = tile.x - Math.floor(width / 2)
    const y = tile.y - Math.floor(height / 2)
    return { spawn, x, y, allowed: canPlace(scene.sim, spawn.type, x, y) }
  }
  return { spawn, x: tile.x, y: tile.y, allowed: isWalkable(scene.sim, tile.x, tile.y) }
}

/** Тайлы, которые накроет укладка покрытия, пока игрок тянет её мышью, и сколько она стоит. */
export interface PaveStroke {
  tool: PaveTool
  /** Тайлы x, y подряд; allowed — можно ли тут класть или снимать, по тайлу. */
  tiles: number[]
  allowed: boolean[]
  /** Цена всего, что ляжет; у снятия — ноль. */
  cost: number
}

/**
 * Что покроет протянутая мышью укладка: от тайла, где зажали кнопку, до тайла под указателем. Фундамент и снятие —
 * прямоугольником, дорога — линией с одним изломом: сначала вдоль длинной стороны, потом поперёк. Пока кнопку
 * не зажали — один тайл под указателем. Больше PAVE_LIMIT тайлов разом не кладут. Вне режима укладки — null.
 */
export function paveStrokeOf(scene: Scene): PaveStroke | null {
  const tool = scene.paving
  const tile = scene.camera.pointerTile
  if (!tool || !tile) return null
  const from = scene.paveFrom ?? tile
  const tiles: number[] = []
  if (tool === 'road') {
    const horizontal = Math.abs(tile.x - from.x) >= Math.abs(tile.y - from.y)
    const corner = horizontal ? { x: tile.x, y: from.y } : { x: from.x, y: tile.y }
    const walk = (a: { x: number; y: number }, b: { x: number; y: number }, skipFirst: boolean) => {
      const stepX = Math.sign(b.x - a.x)
      const stepY = Math.sign(b.y - a.y)
      const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      for (let i = skipFirst ? 1 : 0; i <= length; i++) tiles.push(a.x + stepX * i, a.y + stepY * i)
    }
    walk(from, corner, false)
    walk(corner, tile, true)
  } else {
    for (let y = Math.min(from.y, tile.y); y <= Math.max(from.y, tile.y); y++) {
      for (let x = Math.min(from.x, tile.x); x <= Math.max(from.x, tile.x); x++) tiles.push(x, y)
    }
  }
  tiles.length = Math.min(tiles.length, PAVE_LIMIT * 2)
  const { sim, player } = scene
  const allowed: boolean[] = []
  let cost = 0
  for (let i = 0; i < tiles.length; i += 2) {
    const x = tiles[i]
    const y = tiles[i + 1]
    if (tool === 'remove') {
      const entity = sim.paving.at(x, y)
      allowed.push(entity !== undefined && sim.world.get(entity, Owner)?.player === player)
      continue
    }
    const ok = canPave(sim, player, tool, x, y)
    allowed.push(ok)
    if (ok) cost += paveCost(sim, tool, x, y)
  }
  return { tool, tiles, allowed, cost }
}
