import { BUILDINGS, canBuild, type BuildingType } from '../sim'
import type { Scene } from './scene'

/** Где встанет здание, которое игрок сейчас выбирает место: левый верхний тайл основания и годится ли место. */
export interface Placement {
  type: BuildingType
  x: number
  y: number
  allowed: boolean
}

/** Место под выбранное здание: основание стоит серединой под указателем мыши. Вне режима выбора места — null. */
export function placementOf(scene: Scene): Placement | null {
  const type = scene.placing
  const tile = scene.camera.pointerTile
  if (!type || !tile) return null
  const { width, height } = BUILDINGS[type]
  const x = tile.x - Math.floor(width / 2)
  const y = tile.y - Math.floor(height / 2)
  return { type, x, y, allowed: canBuild(scene.sim, scene.player, type, x, y) }
}
