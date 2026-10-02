import type { Entity } from '../ecs'
import { TRAINING_PLAYER, orderAttack } from './combat'
import { Armed, Owner, Position, Unit } from './components'
import type { Sim } from './sim'
import { UNITS, UNIT_TYPES, flies, freeTilesNear, spawnUnit, type UnitSpec, type UnitType } from './units'
import { WEAPONS } from './weapons'

/** Сколько кредитов стоит армия одной стороны показательного боя. */
const ARMY_BUDGET = 3500

/** На сколько тайлов от точки встречи стоит каждая сторона. */
const BATTLE_GAP = 10

/**
 * Случайная армия из боевых юнитов на budget кредитов: юниты добираются по одному, пока хватает денег хотя бы
 * на самого дешёвого. random — источник случайных чисел от 0 до 1.
 */
export function randomArmy(budget = ARMY_BUDGET, random: () => number = Math.random) {
  const armed = UNIT_TYPES.filter((type) => (UNITS[type] as UnitSpec).weapon)
  const army: UnitType[] = []
  for (;;) {
    const affordable = armed.filter((type) => UNITS[type].cost <= budget)
    if (!affordable.length) return army
    const type = affordable[Math.floor(random() * affordable.length)]
    army.push(type)
    budget -= UNITS[type].cost
  }
}

/**
 * Показательный бой: две армии по обе стороны от тайла (x, y) — own игрока player слева, foe учебного противника
 * справа. Без составов каждая сторона получает свою случайную армию той же цены.
 * Сами они не сойдутся: вести их в бой должен driveBattle.
 */
export function spawnBattle(sim: Sim, player: number, x: number, y: number, own = randomArmy(), foe = randomArmy()) {
  for (const [owner, side, army] of [[player, -1, own], [TRAINING_PLAYER, 1, foe]] as const) {
    for (const air of [false, true]) {
      const types = army.filter((type) => flies(type) === air)
      const tiles = freeTilesNear(sim, x + side * BATTLE_GAP, y, types.length, 0, undefined, air)
      for (let i = 0; i < types.length && i * 2 < tiles.length; i++) spawnUnit(sim, types[i], owner, tiles[i * 2], tiles[i * 2 + 1])
    }
  }
}

/**
 * Ведёт показательный бой: каждому вооружённому юниту без цели указывает ближайшего врага, которого тот может достать.
 * Возвращает false, когда бой кончился: хотя бы у одной из сторон не осталось юнитов.
 */
export function driveBattle(sim: Sim, player: number) {
  const { world } = sim
  const units: { entity: Entity; player: number; x: number; y: number; air: boolean }[] = []
  for (const [entity, unit, position, owner] of world.query(Unit, Position, Owner)) {
    units.push({ entity, player: owner.player, x: position.x, y: position.y, air: flies(unit.type) })
  }
  const idle: Entity[] = []
  for (const [entity, armed] of world.query(Armed, Unit)) {
    if (!world.has(armed.target as Entity, Position)) idle.push(entity)
  }
  for (const entity of idle) {
    const self = units.find((unit) => unit.entity === entity)
    const weapon = (UNITS[world.get(entity, Unit)!.type] as UnitSpec).weapon
    if (!self || !weapon) continue
    let nearest: Entity | null = null
    let best = Infinity
    for (const other of units) {
      if (other.player === self.player || (other.air && !WEAPONS[weapon].air)) continue
      const distance = Math.hypot(other.x - self.x, other.y - self.y)
      if (distance < best) {
        best = distance
        nearest = other.entity
      }
    }
    if (nearest !== null) orderAttack(sim, self.player, [entity], nearest)
  }
  return units.some((unit) => unit.player === player) && units.some((unit) => unit.player !== player)
}
