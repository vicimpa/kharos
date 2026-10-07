import type { Entity } from '../ecs'
import { driveBattle, randomArmy, spawnBattle } from './battle'
import { BUILDINGS, buildingSpec, canPlace, placeBuilding, type BuildingType } from './buildings'
import { TRAINING_PLAYER, orderAttack } from './combat'
import { Armed, Building, Inventory, Owner, Path, Position, Site, Unit } from './components'
import { orderBuild } from './construction'
import { addCredits } from './economy'
import { orderSeek } from './harvesting'
import { fortification } from './fortify'
import { put } from './inventory'
import { spawnSandbox } from './sandbox'
import type { Sim } from './sim'
import { setStance } from './tactics'
import { freeTilesNear, spawnUnit, type UnitType } from './units'

/**
 * Сценки для фона главного меню: каждая заводит мир (create) и потом ведёт его (drive, раз в полсекунды). drive
 * возвращает false, когда сценка кончилась: тогда её начинают заново. create возвращает false, если на этой
 * местности сценка не встала.
 */
export interface Scene {
  create(sim: Sim, player: number): boolean
  drive?(sim: Sim, player: number, seconds: number): boolean
}

/** Тайлы вокруг (x, y) по расширяющимся квадратам, до radius включительно. */
function* around(x: number, y: number, radius: number) {
  for (let ring = 0; ring <= radius; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) yield { x: x + dx, y: y + dy }
    }
  }
}

/** Ближайшее к началу мира место, где встаёт здание type с проходом gap вокруг. */
function openSpot(sim: Sim, type: BuildingType, gap: number, radius = 40) {
  for (const tile of around(0, 0, radius)) if (canPlace(sim, type, tile.x, tile.y, gap)) return tile
  return undefined
}

function spawnGroup(sim: Sim, types: UnitType[], player: number, x: number, y: number, from = 0) {
  const tiles = freeTilesNear(sim, Math.floor(x), Math.floor(y), types.length, from)
  const units: Entity[] = []
  for (let i = 0; i < types.length && i * 2 < tiles.length; i++) units.push(spawnUnit(sim, types[i], player, tiles[i * 2], tiles[i * 2 + 1]))
  // В сценках все агрессивны: увидел врага — идёт на него. В обороне юнит под огнём издалека стоял бы и молчал.
  setStance(sim, player, units, 'aggressive')
  return units
}

/** Готова ли сущность к новому приказу: не идёт и не держит живую цель. */
function idle(sim: Sim, entity: Entity) {
  if (sim.world.has(entity, Path)) return false
  const target = sim.world.get(entity, Armed)?.target
  return target === undefined || target === null || !sim.world.has(target as Entity, Position)
}

/** Добыча: работающая база и несколько харвестеров, которые сами разведывают и копают все виды руды. */
const mining: Scene = {
  create(sim, player) {
    const base = spawnSandbox(sim, player)
    if (!base) return false
    const harvesters = spawnGroup(sim, ['harvester', 'harvester', 'harvester', 'truck', 'truck'], player, base.x, base.y, 3).filter(
      (entity) => sim.world.get(entity, Unit)?.type === 'harvester',
    )
    for (const harvester of harvesters) orderSeek(sim, player, [harvester], 'any')
    return true
  },
}

/** Что строят строители, по очереди, вокруг главного здания. */
const PLAN: BuildingType[] = ['generator', 'barracks', 'generator', 'radar', 'metalYard', 'windtrap', 'matter', 'turret', 'rocketTurret', 'generator', 'siliconStore', 'cannonTurret']
/** Через сколько секунд после конца стройки сценка начинается заново. */
const BUILT_PAUSE = 12

/** Стройка: главное здание и бригада строителей, которая поднимает вокруг него базу здание за зданием. */
function construction(): Scene {
  let step = 0
  let done = 0
  let core = { x: 0, y: 0 }
  return {
    create(sim, player) {
      const spot = openSpot(sim, 'command', 6)
      if (!spot) return false
      step = 0
      done = 0
      placeBuilding(sim.world, 'command', spot.x, spot.y, player)
      core = { x: spot.x + 1, y: spot.y + 1 }
      addCredits(sim, player, 50000)
      spawnGroup(sim, ['builder', 'builder', 'builder', 'builder', 'builder', 'truck', 'truck', 'infantry', 'infantry'], player, core.x, core.y, 3)
      return true
    },
    drive(sim, player, seconds) {
      // Новая площадка — только когда прежние достроены: бригада работает вместе, и стройку видно.
      for (const [, , owner] of sim.world.query(Site, Owner)) if (owner.player === player) return true
      if (step >= PLAN.length) return (done += seconds) < BUILT_PAUSE
      const builders: Entity[] = []
      for (const [entity, unit, owner] of sim.world.query(Unit, Owner)) if (owner.player === player && unit.type === 'builder') builders.push(entity)
      const type = PLAN[step++]
      for (const tile of around(core.x, core.y, 12)) {
        if (Math.abs(tile.x - core.x) < 4 && Math.abs(tile.y - core.y) < 4) continue
        if (!canPlace(sim, type, tile.x, tile.y, 1)) continue
        if (orderBuild(sim, player, type, tile.x, tile.y, builders) !== undefined) break
      }
      return true
    },
  }
}

/** Стороны, откуда может идти враг: оборона разворачивается к ней. */
const SIDES = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
/** Насколько волна может прийти в стороне от оси обороны, тайлов. */
const WAVE_SPREAD = 8
/** Чем идут волны: наземные бойцы. Бюджет первой волны и прибавка к каждой следующей. */
const WAVE_WEIGHTS: Partial<Record<UnitType, number>> = { infantry: 2, rocketeer: 1, buggy: 1, lancer: 1, tank: 1, tesla: 0.5, carrier: 0, drone: 0, gunship: 0 }
const WAVE_BUDGET = 1200
const WAVE_GROWTH = 500
const WAVES = 6
/** Откуда идут волны: тайлов перед самой дальней постройкой обороны. */
const WAVE_DISTANCE = 20
/** Кто защищает базу вместе с турелями: случайный отряд такой цены, и при нём строители. */
const GUARD_BUDGET = 1500
const GUARD_WEIGHTS: Partial<Record<UnitType, number>> = { infantry: 2, rocketeer: 2, buggy: 1, lancer: 1, tank: 1, tesla: 0.5, carrier: 0, drone: 0, gunship: 0 }

/**
 * Оборона: главное здание, перед ним случайное укрепление (см. fortification) лицом к случайной стороне, защитники
 * за ним отбивают волну за волной; турели подпитываются патронами.
 */
function defense(): Scene {
  let wave = 0
  let calm = 0
  /** Точка в осях обороны (u — к врагу, v — поперёк) → тайл на карте. */
  let at = (u: number, v: number) => ({ x: u, y: v })
  let reach = 0
  return {
    create(sim, player) {
      const spot = openSpot(sim, 'command', 10)
      if (!spot) return false
      wave = 0
      calm = 0
      const side = SIDES[Math.floor(Math.random() * SIDES.length)]
      const core = { x: spot.x + 1, y: spot.y + 1 }
      at = (u, v) => ({ x: core.x + side.x * u - side.y * v, y: core.y + side.y * u + side.x * v })
      placeBuilding(sim.world, 'command', spot.x, spot.y, player)
      const pieces = fortification()
      reach = Math.max(...pieces.map((piece) => piece.u))
      for (const { type, u, v } of pieces) {
        const { x, y } = at(u, v)
        if (canPlace(sim, type, x, y)) placeBuilding(sim.world, type, x, y, player)
      }
      const guard = at(3, 0)
      spawnGroup(sim, [...randomArmy(GUARD_BUDGET, GUARD_WEIGHTS), 'builder', 'builder'], player, guard.x, guard.y, 1)
      return true
    },
    drive(sim, player, seconds) {
      let turrets = 0
      let foes = 0
      const targets: { entity: Entity; x: number; y: number }[] = []
      for (const [entity, building, position, owner] of sim.world.query(Building, Position, Owner)) {
        if (owner.player !== player) continue
        if (buildingSpec(building.type).ammo) {
          turrets++
          // Патроны подвозят «за кадром»: сценка про бой, а не про снабжение.
          const store = sim.world.get(entity, Inventory)
          if (store) put(store, 'ammo', 20)
        }
        const { width, height } = BUILDINGS[building.type]
        targets.push({ entity, x: position.x + width / 2, y: position.y + height / 2 })
      }
      for (const [entity, , position, owner] of sim.world.query(Unit, Position, Owner)) {
        if (owner.player === player) targets.push({ entity, x: position.x, y: position.y })
      }
      const attackers: { entity: Entity; x: number; y: number }[] = []
      for (const [entity, , position, owner] of sim.world.query(Unit, Position, Owner)) {
        if (owner.player !== TRAINING_PLAYER) continue
        foes++
        if (idle(sim, entity)) attackers.push({ entity, x: position.x, y: position.y })
      }
      for (const attacker of attackers) {
        let nearest: Entity | null = null
        let best = Infinity
        for (const target of targets) {
          const distance = (target.x - attacker.x) ** 2 + (target.y - attacker.y) ** 2
          if (distance < best) {
            best = distance
            nearest = target.entity
          }
        }
        if (nearest !== null) orderAttack(sim, TRAINING_PLAYER, [attacker.entity], nearest)
      }
      if (!turrets) return false
      if (foes) return true
      calm += seconds
      if (calm < 3) return true
      calm = 0
      if (wave >= WAVES) return false
      const army = randomArmy(WAVE_BUDGET + wave * WAVE_GROWTH, WAVE_WEIGHTS)
      const from = at(reach + WAVE_DISTANCE, Math.round((Math.random() * 2 - 1) * WAVE_SPREAD))
      spawnGroup(sim, army, TRAINING_PLAYER, from.x, from.y)
      wave++
      return true
    },
  }
}

/** Бой двух армий одной цены; weights — из кого они набираются (см. randomArmy). */
function battle(budget: number, weights: Partial<Record<UnitType, number>> = {}): () => Scene {
  return () => ({
    create(sim, player) {
      spawnBattle(sim, player, 0, 0, randomArmy(budget, weights), randomArmy(budget, weights))
      return true
    },
    drive: (sim, player) => driveBattle(sim, player),
  })
}

const NONE = { infantry: 0, rocketeer: 0, buggy: 0, lancer: 0, tank: 0, tesla: 0, carrier: 0, drone: 0, gunship: 0 }

/** Сценки фона меню: у каждой своё состояние, поэтому create() даёт новую на каждый мир. */
export const SCENES = {
  mining: () => mining,
  construction,
  defense,
  battle: battle(3500),
  armor: battle(4000, { ...NONE, tank: 2, lancer: 1, tesla: 1, carrier: 1, buggy: 1 }),
  infantry: battle(1500, { ...NONE, infantry: 2, rocketeer: 1 }),
  air: battle(3000, { ...NONE, drone: 2, gunship: 1, rocketeer: 1 }),
} satisfies Record<string, () => Scene>

export type SceneName = keyof typeof SCENES
