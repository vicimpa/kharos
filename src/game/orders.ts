import type { Entity } from '../ecs'
import { resolveOrder, unitNear, type Command } from '../sim'
import type { Scene } from './scene'

/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно попасть в него. В пикселях экрана. */
const PICK_MARGIN = 6

/** Юнит под точкой в тайлах: ближайший из тех, в чей круг она попала. own — среди своих или среди чужих. */
export function unitUnder(scene: Scene, x: number, y: number, own = true) {
  return unitNear(scene.sim, scene.player, x, y, own, PICK_MARGIN / scene.camera.zoom)
}

/**
 * Приказ правой кнопкой в редакторе: что выбранным units игрока scene.player делать с точкой point (в тайлах).
 * Администратор видит всё и приказывает за любого, поэтому цель выбирается здесь и без тумана; в игре приказ уходит
 * точкой, см. команду order.
 */
export function ordersAt(scene: Scene, units: Entity[], point: { x: number; y: number }, queue: boolean): Command[] {
  return resolveOrder(scene.sim, scene.player, units, point, PICK_MARGIN / scene.camera.zoom, false).map((command) => ({ ...command, queue }))
}
