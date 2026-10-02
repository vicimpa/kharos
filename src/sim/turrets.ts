import type { Entity } from '../ecs'
import { NONE } from './common'
import { Armed, Attached, Carrier, Owner, Position, Repair, Turret, Unit } from './components'
import type { Sim } from './sim'
import { UNITS, unitSpec } from './units'
import type { WeaponType } from './weapons'

/**
 * Что симуляция знает о виде турели. Турель — отдельная сущность, прикреплённая к юниту-носителю (Attached):
 * ездит вместе с ним, но поворачивается сама. Урона не получает — бьют по носителю, и гибнет она вместе с ним.
 * Как она выглядит, знает клиент: см. game/units/turretArt.ts.
 */
export interface TurretSpec {
  /** Как быстро поворачивает, в радианах в секунду. */
  turn: number
  /** Радиус в тайлах: снаряд вылетает с его края. */
  radius: number
  /** Чем стреляет; см. combat.ts. */
  weapon?: WeaponType
  /** Строит и чинит всё своё в этом радиусе, в тайлах; см. construction.ts. */
  repair?: number
}

export const TURRETS = {
  rocket: { turn: 4, radius: 0.2, weapon: 'launcher' },
  repair: { turn: 4, radius: 0.2, repair: 5 },
} satisfies Record<string, TurretSpec>

export type TurretType = keyof typeof TURRETS
export const TURRET_TYPES = Object.keys(TURRETS) as TurretType[]
export const turretSpec = (type: TurretType): TurretSpec => TURRETS[type]

/** Где на носителе стоит турель: вперёд (along) и вправо (across) от его центра, в тайлах. */
export interface MountSpec {
  turret: TurretType
  along: number
  across: number
}

/** Где турель с таким креплением стоит, когда носитель в (x, y) смотрит под углом facing. */
const mountedAt = (x: number, y: number, facing: number, along: number, across: number) => ({
  x: x + along * Math.cos(facing) - across * Math.sin(facing),
  y: y + along * Math.sin(facing) + across * Math.cos(facing),
})

/** Ставит на юнит турели, положенные его виду, и записывает их в его Carrier. */
export function mountTurrets(sim: Sim, entity: Entity) {
  const { world } = sim
  const unit = world.get(entity, Unit)
  const position = world.get(entity, Position)
  const mounts = unit && unitSpec(unit.type).mounts
  if (!mounts || !position) return
  const player = world.get(entity, Owner)?.player ?? 0
  const turrets: number[] = []
  for (const { turret: type, along, across } of mounts) {
    const at = mountedAt(position.x, position.y, unit.facing, along, across)
    const spec = turretSpec(type)
    const turret = world.spawn(
      Position(at),
      Owner({ player }),
      Attached({ parent: entity, along, across }),
      Turret({ type, facing: unit.facing, prevFacing: unit.facing, prevX: at.x, prevY: at.y }),
    )
    if (spec.weapon) world.add(turret, Armed)
    if (spec.repair) world.add(turret, Repair({ radius: spec.repair }))
    turrets.push(turret)
  }
  world.add(entity, Carrier({ turrets }))
}

/** Носитель турели или сама сущность, если она ни к чему не прикреплена. */
export const carrierOf = (sim: Sim, entity: Entity): Entity => (sim.world.get(entity, Attached)?.parent as Entity | undefined) ?? entity

/** Турели юнита; у юнита без них — пусто. */
export const turretsOf = (sim: Sim, entity: Entity): readonly Entity[] => (sim.world.get(entity, Carrier)?.turrets ?? []) as Entity[]

/**
 * То, что поворачивается само: юнит или турель. body.facing можно менять, turn — скорость поворота в радианах
 * в секунду, radius — радиус в тайлах. undefined — сущность не поворачивается: например, здание.
 */
export function turnerOf(sim: Sim, entity: Entity): { body: { facing: number }; turn: number; radius: number } | undefined {
  const unit = sim.world.get(entity, Unit)
  if (unit) return { body: unit, turn: UNITS[unit.type].turn, radius: UNITS[unit.type].radius }
  const turret = sim.world.get(entity, Turret)
  if (turret) return { body: turret, turn: TURRETS[turret.type].turn, radius: TURRETS[turret.type].radius }
  return undefined
}

/**
 * Раз в тик, после движения: турели встают на свои места на носителях, а турели погибших носителей исчезают.
 * Направление турели своё: носитель, поворачиваясь, её не крутит.
 */
export function followCarriers(sim: Sim) {
  const { world } = sim
  const orphans: Entity[] = []
  for (const [entity, attached, position, turret] of world.query(Attached, Position, Turret)) {
    turret.prevX = position.x
    turret.prevY = position.y
    turret.prevFacing = turret.facing
    const parent = attached.parent as Entity
    const unit = world.get(parent, Unit)
    const at = world.get(parent, Position)
    if (!unit || !at || attached.parent === NONE) {
      orphans.push(entity)
      continue
    }
    const { x, y } = mountedAt(at.x, at.y, unit.facing, attached.along, attached.across)
    position.x = x
    position.y = y
  }
  // Состав мира меняется после обхода.
  for (const entity of orphans) world.destroy(entity)
}

/** Может ли юнит воевать: вооружён сам или несёт вооружённые турели. */
export const canFight = (sim: Sim, entity: Entity) =>
  sim.world.has(entity, Armed) || turretsOf(sim, entity).some((turret) => sim.world.has(turret, Armed))
