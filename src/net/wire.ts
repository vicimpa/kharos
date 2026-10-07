import type { Component, Entity, World } from '../ecs'
import { Armed, Assembly, Attached, Builds, Drop, Harvester, Hauler, Health, Inventory, Owner, Path, Position, Producer, Repair, SAVED, Tactics, Trade, Turret, Unit } from '../sim/components'
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
  /** Чей это: от чужих часть компонентов скрыта, см. PRIVATE. undefined — ничей. */
  owner?: number
  /** Склад ящика с грузом виден всем: это не тайна хозяина. */
  drop?: boolean
  /** Та же сущность глазами чужого игрока: собирается один раз, когда понадобится. */
  foreign?: Wired
}

/**
 * Что о своём знает только хозяин: склад, очередь производства, работа грузовиков, копателей и строителей, сборка,
 * торговля, тактика. Чужому это незачем рисовать, а знать — нечестно.
 */
const PRIVATE = new Set([Inventory, Producer, Hauler, Harvester, Assembly, Trade, Tactics, Builds, Repair].map((component) => component.key))

/** Сущность глазами игрока viewer: своё и ничьё — целиком, чужое — без PRIVATE и без цели стрелка. */
export function seenBy(wired: Wired, viewer: number): Wired {
  if (wired.owner === undefined || wired.owner === 0 || wired.owner === viewer) return wired
  if (!wired.foreign) {
    const parts = new Map(wired.parts)
    for (const key of PRIVATE) if (!(key === Inventory.key && wired.drop)) parts.delete(key)
    // В кого целится стрелок, знает только хозяин: чужой узнал бы это раньше выстрела.
    const armed = parts.get(Armed.key)
    if (armed) {
      const { target: _target, ...rest } = JSON.parse(armed)
      parts.set(Armed.key, JSON.stringify(rest))
    }
    wired.foreign = { parts, motion: wired.motion }
  }
  return wired.foreign
}

/**
 * Сущность, какой она уходит игрокам, кроме пути: хозяину целиком, чужим — через seenBy; пусто — сущности в сети нечего показать. Не зависит от того,
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
  const owner = world.get(entity, Owner)?.player
  const drop = world.has(entity, Drop)
  const position = mounted ? undefined : world.get(entity, Position)
  if (!position) return { parts, owner, drop }
  return { parts, owner, drop, motion: quantize(position.x, position.y, world.get(entity, Unit)?.facing) }
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
  const shared = seenBy(sharedWireOf(world, entity, tick), viewer)
  const path = pathOf(world, entity, viewer)
  if (path === undefined) return shared
  return { parts: new Map(shared.parts).set(Path.key, path), motion: shared.motion }
}
