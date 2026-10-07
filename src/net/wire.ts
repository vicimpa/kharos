import type { Component, Entity, World } from '../ecs'
import { Armed, Attached, Health, Owner, Path, Position, SAVED, Turret, Unit } from '../sim/components'

/** До скольких знаков после запятой округляются дробные числа в сети: тысячная тайла глазу не видна. */
const PRECISION = 1000

/** Дробное — до PRECISION: короче в тексте, и стоящий юнит не уходит в сеть из-за дрожи в последних знаках. */
const round = (_key: string, value: unknown) =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * PRECISION) / PRECISION : value

/**
 * Каким компонент уходит игроку viewer: только то, что нужно клиенту, или undefined — не уходит вовсе.
 * Путь — только своему: чужой клиенту не нужен и выдал бы, куда идёт враг; из пути — только точки, по ним рисуется
 * дорожка выбранного. Прошлое место и поворот юнита и турели клиент помнит сам, место турели на носителе находит сам,
 * перезарядку считает по тику её конца, см. replica.ts. Всё, что меняется каждый тик без нужды, уходило бы каждый тик.
 */
function wire(component: Component<any>, data: any, viewer: number, owner: number | undefined, tick: number, mounted: boolean): object | undefined {
  if (component === Path) return owner === viewer ? { points: data.points } : undefined
  if (component === Unit) {
    const { prevX: _x, prevY: _y, prevFacing: _facing, ...rest } = data
    return rest
  }
  // Турель на носителе клиент ставит на место сам: её место меняется с каждым шагом носителя.
  if (component === Position && mounted) return undefined
  if (component === Turret) return { type: data.type, angle: data.angle }
  // Перезарядка тает каждый тик; тик, когда она кончится, — нет. Клиенту она нужна только для отдачи.
  if (component === Armed) return { target: data.target, until: data.cooldown > 0 ? tick + data.cooldown : 0 }
  if (component === Health) {
    const { hit: _hit, ...rest } = data
    return rest
  }
  return data
}

/** JSON компонентов сущности, какими они уходят игроку viewer, по имени; пусто — сущности в сети нечего показать. */
export function wireOf(world: World, entity: Entity, viewer: number, tick: number): Map<string, string> {
  const owner = world.get(entity, Owner)?.player
  const mounted = world.has(entity, Attached) && world.has(entity, Turret)
  const found = new Map<string, string>()
  for (const component of SAVED) {
    const data = world.get(entity, component)
    if (data === undefined) continue
    const shown = wire(component, data, viewer, owner, tick, mounted)
    if (shown !== undefined) found.set(component.key, JSON.stringify(shown, round))
  }
  return found
}
