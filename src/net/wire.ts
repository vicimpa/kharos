import type { Component, Entity, World } from '../ecs'
import { Armed, Attached, Health, Owner, Path, Position, SAVED, Turret, Unit } from '../sim/components'
import { quantize, type Motion } from './codec'

/** До скольких знаков после запятой округляются дробные числа в сети: тысячная тайла глазу не видна. */
const PRECISION = 1000

/** Дробное — до PRECISION: короче в тексте, и стоящий юнит не уходит в сеть из-за дрожи в последних знаках. */
const round = (_key: string, value: unknown) =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * PRECISION) / PRECISION : value

/**
 * Каким компонент уходит игроку viewer: только то, что нужно клиенту, или undefined — не уходит вовсе.
 * Прошлое место и поворот юнита и турели клиент помнит сам, место турели на носителе находит сам,
 * перезарядку считает по тику её конца, см. replica.ts. Всё, что меняется каждый тик без нужды, уходило бы каждый тик.
 */
function wire(component: Component<any>, data: any, tick: number): object | undefined {
  // Путь — свой у каждого игрока, см. pathOf.
  if (component === Path) return undefined
  // Место и поворот юнита идут движением, см. codec.ts.
  if (component === Unit) {
    const { prevX: _x, prevY: _y, prevFacing: _previous, facing: _facing, ...rest } = data
    return rest
  }
  if (component === Position) return undefined
  if (component === Turret) return { type: data.type, angle: data.angle }
  // Перезарядка тает каждый тик; тик, когда она кончится, — нет. Клиенту она нужна только для отдачи.
  if (component === Armed) return { target: data.target, until: data.cooldown > 0 ? tick + data.cooldown : 0 }
  if (component === Health) {
    const { hit: _hit, ...rest } = data
    return rest
  }
  return data
}

/** Сущность, какой она уходит игроку: JSON компонентов по имени и движение — место и поворот, см. codec.ts. */
export interface Wired {
  parts: Map<string, string>
  motion?: Motion
}

/**
 * Сущность, какой она уходит любому игроку, кроме пути; пусто — сущности в сети нечего показать. Не зависит от того,
 * кто смотрит: хост собирает её раз за тик и раздаёт всем, кто её видит. Турель на носителе клиент ставит на место
 * сам: её место меняется с каждым шагом носителя.
 */
export function sharedWireOf(world: World, entity: Entity, tick: number): Wired {
  const mounted = world.has(entity, Attached) && world.has(entity, Turret)
  const parts = new Map<string, string>()
  for (const component of SAVED) {
    const data = world.get(entity, component)
    if (data === undefined) continue
    const shown = wire(component, data, tick)
    if (shown !== undefined) parts.set(component.key, JSON.stringify(shown, round))
  }
  const position = mounted ? undefined : world.get(entity, Position)
  if (!position) return { parts }
  return { parts, motion: quantize(position.x, position.y, world.get(entity, Unit)?.facing) }
}

/**
 * JSON пути сущности для игрока viewer или undefined. Путь — только своему: чужой клиенту не нужен и выдал бы,
 * куда идёт враг; из пути — только точки, по ним рисуется дорожка выбранного.
 */
export function pathOf(world: World, entity: Entity, viewer: number) {
  const path = world.get(entity, Path)
  if (!path || world.get(entity, Owner)?.player !== viewer) return undefined
  return JSON.stringify({ points: path.points }, round)
}

/** Сущность, какой она уходит игроку viewer: общее для всех и его путь. */
export function wireOf(world: World, entity: Entity, viewer: number, tick: number): Wired {
  const shared = sharedWireOf(world, entity, tick)
  const path = pathOf(world, entity, viewer)
  if (path === undefined) return shared
  return { parts: new Map(shared.parts).set(Path.key, path), motion: shared.motion }
}
