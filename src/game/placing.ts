import { BUILDINGS, DEPOSIT_SIZE, canBuild, canPlace, depositNear, isWalkable, type BuildingSpec, type BuildingType } from '../sim'
import type { Scene, Spawn } from './scene'

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
  const deposit = extract && width === DEPOSIT_SIZE ? depositNear(scene.sim, tile.x + 0.5, tile.y + 0.5, SNAP) : null
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
