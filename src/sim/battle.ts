import type { Entity } from '../ecs'
import { TRAINING_PLAYER, orderAttack, weaponOf } from './combat'
import { Armed, Owner, Path, Position, Unit } from './components'
import { turretsOf } from './turrets'
import type { Sim } from './sim'
import { UNITS, UNIT_TYPES, canStand, flies, spawnUnit, isFighter, type UnitType } from './units'
import { WEAPONS } from './weapons'

/** Сколько кредитов стоит армия одной стороны показательного боя. */
const ARMY_BUDGET = 3500

/** На сколько тайлов от точки встречи стоит передний ряд каждой стороны. */
const BATTLE_GAP = 6

/**
 * Случайная армия из боевых юнитов на budget кредитов: юниты добираются по одному, пока хватает денег хотя бы
 * на самого дешёвого из разрешённых. weights — насколько часто берётся каждый тип: 0 — не берётся совсем, тип без
 * веса берётся с весом 1; если все веса нулевые, типы равноправны. random — источник случайных чисел от 0 до 1.
 */
export function randomArmy(budget = ARMY_BUDGET, weights: Partial<Record<UnitType, number>> = {}, random: () => number = Math.random) {
  const weightOf = (type: UnitType) => Math.max(0, weights[type] ?? 1)
  let armed = UNIT_TYPES.filter(isFighter)
  if (armed.some((type) => weightOf(type) > 0)) armed = armed.filter((type) => weightOf(type) > 0)
  else weights = {}
  const army: UnitType[] = []
  for (;;) {
    const affordable = armed.filter((type) => UNITS[type].cost <= budget)
    if (!affordable.length) return army
    let pick = random() * affordable.reduce((sum, type) => sum + weightOf(type), 0)
    let type = affordable[affordable.length - 1]
    for (const candidate of affordable) {
      pick -= weightOf(candidate)
      if (pick < 0) {
        type = candidate
        break
      }
    }
    army.push(type)
    budget -= UNITS[type].cost
  }
}

/** Шаг строя в тайлах и сколько колонн в глубину под него ищется место. */
const FORMATION_SPACING = 2
const FORMATION_DEPTH = 200

/**
 * Места для строя из count юнитов: колонны от тайла (x, y) в сторону side (-1 — влево, 1 — вправо), ближняя
 * к противнику заполняется первой, каждая — от середины к краям. Тайлы, где стоять нельзя, пропускаются.
 * Возвращает x, y подряд; мест меньше count, если строй упёрся в край карты.
 */
function formation(sim: Sim, x: number, y: number, side: number, count: number, air: boolean) {
  const rows = Math.max(3, Math.ceil(Math.sqrt(count * 2)))
  const tiles: number[] = []
  for (let column = 0; column < FORMATION_DEPTH && tiles.length < count * 2; column++) {
    for (let row = 0; row < rows && tiles.length < count * 2; row++) {
      // 0, 1, -1, 2, -2…
      const offset = row % 2 ? (row + 1) / 2 : -row / 2
      const tileX = x + side * column * FORMATION_SPACING
      const tileY = y + offset * FORMATION_SPACING
      if (canStand(sim, air, tileX, tileY)) tiles.push(tileX, tileY)
    }
  }
  return tiles
}

/**
 * Показательный бой: две армии по обе стороны от тайла (x, y) — own игрока player слева, foe учебного противника
 * справа; передний ряд каждой — в gap тайлах от него, остальные строятся за ним. Без составов каждая сторона
 * получает свою случайную армию той же цены. Сами они не сойдутся: вести их в бой должен driveBattle.
 */
export function spawnBattle(sim: Sim, player: number, x: number, y: number, own = randomArmy(), foe = randomArmy(), gap = BATTLE_GAP) {
  for (const [owner, side, army] of [[player, -1, own], [TRAINING_PLAYER, 1, foe]] as const) {
    for (const air of [false, true]) {
      const types = army.filter((type) => flies(type) === air)
      const tiles = formation(sim, x + side * gap, y, side, types.length, air)
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
  const byEntity = new Map<Entity, (typeof units)[number]>()
  for (const [entity, unit, position, owner] of world.query(Unit, Position, Owner)) {
    const item = { entity, player: owner.player, x: position.x, y: position.y, air: flies(unit.type) }
    units.push(item)
    byEntity.set(entity, item)
  }
  // Свободен тот, кто стоит, а ни у него, ни у его турелей нет цели. Идущего не трогают: его ведёт приказ игрока.
  const idle: Entity[] = []
  for (const { entity } of units) {
    if (world.has(entity, Path)) continue
    const targets = [entity, ...turretsOf(sim, entity)].flatMap((gunner) => world.get(gunner, Armed)?.target ?? [])
    if (targets.length && !targets.some((target) => world.has(target as Entity, Position))) idle.push(entity)
  }
  for (const entity of idle) {
    const self = byEntity.get(entity)
    const gunners = [entity, ...turretsOf(sim, entity)]
    const weapons = gunners.map((gunner) => weaponOf(sim, gunner)).filter((weapon) => weapon !== undefined)
    if (!self || !weapons.length) continue
    const hitsAir = weapons.some((weapon) => WEAPONS[weapon].air)
    let nearest: Entity | null = null
    let best = Infinity
    for (const other of units) {
      if (other.player === self.player || (other.air && !hitsAir)) continue
      const distance = (other.x - self.x) ** 2 + (other.y - self.y) ** 2
      if (distance < best) {
        best = distance
        nearest = other.entity
      }
    }
    if (nearest !== null) orderAttack(sim, self.player, [entity], nearest)
  }
  return units.some((unit) => unit.player === player) && units.some((unit) => unit.player !== player)
}
