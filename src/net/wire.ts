import type { Component, Entity, World } from '../ecs'
import { Owner, Path, SAVED, Unit } from '../sim/components'

/** До скольких знаков после запятой округляются дробные числа в сети: тысячная тайла глазу не видна. */
const PRECISION = 1000

/** Дробное — до PRECISION: короче в тексте, и стоящий юнит не уходит в сеть из-за дрожи в последних знаках. */
const round = (_key: string, value: unknown) =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * PRECISION) / PRECISION : value

/**
 * Каким компонент уходит игроку viewer: только то, что нужно клиенту, или undefined — не уходит вовсе.
 * Путь — только своему: чужой клиенту не нужен и выдал бы, куда идёт враг; из пути — только точки, по ним рисуется
 * дорожка выбранного. Прошлое место и поворот юнита клиент помнит сам, см. replica.ts.
 */
function wire(component: Component<any>, data: any, viewer: number, owner: number | undefined): object | undefined {
  if (component === Path) return owner === viewer ? { points: data.points } : undefined
  if (component === Unit) {
    const { prevX: _x, prevY: _y, prevFacing: _facing, ...rest } = data
    return rest
  }
  return data
}

/** JSON компонентов сущности, какими они уходят игроку viewer, по имени; пусто — сущности в сети нечего показать. */
export function wireOf(world: World, entity: Entity, viewer: number): Map<string, string> {
  const owner = world.get(entity, Owner)?.player
  const found = new Map<string, string>()
  for (const component of SAVED) {
    const data = world.get(entity, component)
    if (data === undefined) continue
    const shown = wire(component, data, viewer, owner)
    if (shown !== undefined) found.set(component.key, JSON.stringify(shown, round))
  }
  return found
}
