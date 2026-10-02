import type { Entity } from '../ecs'
import { BUILDINGS, type BuildingSpec, type BuildingType } from './buildings'
import { Building, Player } from './components'
import type { Sim } from './sim'
import { allZones, type Zone } from './zones'

/** Хозяйство одной зоны строительства на этот тик. Энергия у каждой зоны своя: из зоны в зону она не передаётся. */
export interface Economy {
  /** Сколько энергии дают здания зоны и сколько её просят потребители. */
  produced: number
  demand: number
  /** Доход в кредитах в секунду с учётом нехватки энергии. */
  income: number
  /** Сколько в зоне зданий, которым тесно друг с другом (см. BuildingSpec.crowding). */
  crowd: number
}

/** Хозяйство зоны. Если энергии не хватает, потребители работают на ту долю, на которую её хватает. */
function economyOfZone(sim: Sim, zone: Zone): Economy {
  const economy: Economy = { produced: 0, demand: 0, income: 0, crowd: 0 }
  /** Доход потребителей при полной энергии. */
  let powered = 0
  for (const entity of zone.buildings) {
    const building = sim.world.get(entity, Building)!
    const spec: BuildingSpec = BUILDINGS[building.type]
    const power = spec.power ?? 0
    const income = spec.income ?? 0
    // Повреждённая электростанция даёт энергии во столько же раз меньше, во сколько упала её прочность.
    if (power > 0) economy.produced += power * building.health
    if (power < 0) {
      // Тесное здание просит тем больше, чем их уже в зоне: первое — одну норму, второе — две, третье — три.
      economy.demand -= power * (spec.crowding ? ++economy.crowd : 1)
      powered += income
    } else {
      economy.income += income
    }
  }
  if (powered) economy.income += powered * Math.min(1, economy.produced / economy.demand)
  return economy
}

/**
 * Хозяйства зон всех игроков, в порядке зон. Считаются только готовые здания в зонах:
 * свернул главное здание — встало всё.
 */
export function economies(sim: Sim): Map<number, Economy[]> {
  const result = new Map<number, Economy[]>()
  for (const [player, zones] of allZones(sim)) result.set(player, zones.map((zone) => economyOfZone(sim, zone)))
  return result
}

const NONE: Economy[] = []

/** Хозяйства зон одного игрока. */
export const zoneEconomies = (sim: Sim, player: number): readonly Economy[] => economies(sim).get(player) ?? NONE

/** Итог по всем зонам игрока. Для дохода это то, что он получает; энергию так складывать можно только для справки. */
export function economyOf(sim: Sim, player: number): Economy {
  const total: Economy = { produced: 0, demand: 0, income: 0, crowd: 0 }
  for (const economy of zoneEconomies(sim, player)) {
    total.produced += economy.produced
    total.demand += economy.demand
    total.income += economy.income
    total.crowd += economy.crowd
  }
  return total
}

/**
 * Как здание этого вида изменит баланс энергии зоны с хозяйством economy, если его там построить:
 * больше нуля — добавит выработки, меньше — попросит столько энергии.
 */
export function powerOf(type: BuildingType, economy: Economy) {
  const spec: BuildingSpec = BUILDINGS[type]
  const power = spec.power ?? 0
  return power < 0 && spec.crowding ? power * (economy.crowd + 1) : power
}

/**
 * Какую долю прочности в секунду теряет электростанция, когда с зоны просят вдвое больше энергии, чем она даёт.
 * При меньшем перегрузе урон меньше во столько же раз, при большем — не растёт.
 */
export const OVERLOAD_DAMAGE = 0.01

/** Насколько зона перегружена: 0 — энергии хватает, 1 — просят вдвое больше, чем есть, и выше. */
const overloadOf = (economy: Economy) => (economy.produced > 0 && economy.demand > economy.produced ? Math.min(1, economy.demand / economy.produced - 1) : 0)

/** Что нехватка энергии делает со зданием: электростанция перегружена и разрушается, потребитель работает медленнее. */
export type PowerState = 'overload' | 'starved'

/** Здания всех игроков, которым сейчас не хватает энергии. Тех, у кого всё в порядке, здесь нет. */
export function powerStates(sim: Sim): Map<Entity, PowerState> {
  const states = new Map<Entity, PowerState>()
  const all = economies(sim)
  for (const [player, zones] of allZones(sim)) {
    zones.forEach((zone, i) => {
      const economy = all.get(player)![i]
      if (economy.demand <= economy.produced) return
      for (const entity of zone.buildings) {
        const power = (BUILDINGS[sim.world.get(entity, Building)!.type] as BuildingSpec).power ?? 0
        if (power) states.set(entity, power > 0 ? 'overload' : 'starved')
      }
    })
  }
  return states
}

/**
 * Электростанции зон, где энергии не хватило бы и целым станциям: потребителей там больше, чем станции тянут.
 * Чинить такие бесполезно, пока перегруз не снят. Станции, которым не хватает только из-за повреждений, сюда не входят.
 */
export function overbuiltPlants(sim: Sim): Set<Entity> {
  const plants = new Set<Entity>()
  const all = economies(sim)
  for (const [player, zones] of allZones(sim)) {
    zones.forEach((zone, i) => {
      const found: Entity[] = []
      let capacity = 0
      for (const entity of zone.buildings) {
        const power = (BUILDINGS[sim.world.get(entity, Building)!.type] as BuildingSpec).power ?? 0
        if (power <= 0) continue
        capacity += power
        found.push(entity)
      }
      if (all.get(player)![i].demand > capacity) for (const entity of found) plants.add(entity)
    })
  }
  return plants
}

/**
 * Раз в тик: перегруженные электростанции теряют прочность и в нуле разрушаются.
 * Сами здания не восстанавливаются: их чинят строители.
 */
function wear(sim: Sim, zones: Map<number, Zone[]>, all: Map<number, Economy[]>) {
  const { world, time } = sim
  const damage = new Map<Entity, number>()
  for (const [player, list] of zones) {
    list.forEach((zone, i) => {
      const overload = overloadOf(all.get(player)![i])
      if (!overload) return
      for (const entity of zone.buildings) {
        const power = (BUILDINGS[world.get(entity, Building)!.type] as BuildingSpec).power ?? 0
        if (power > 0) damage.set(entity, OVERLOAD_DAMAGE * overload * time.step)
      }
    })
  }
  // Состав мира меняется после обхода.
  const ruined: Entity[] = []
  for (const [entity, lost] of damage) {
    const building = world.get(entity, Building)!
    building.health -= lost
    if (building.health <= 0) ruined.push(entity)
  }
  for (const entity of ruined) world.destroy(entity)
}

/**
 * Раз в тик: начисляет игрокам доход и изнашивает перегруженные электростанции.
 * Доли кредита копятся в earned, на счёт попадают целые.
 */
export function earn(sim: Sim) {
  const { world, time } = sim
  const zones = allZones(sim)
  const all = economies(sim)
  // Износ — в самом конце: разрушенное здание исчезает из мира, а зоны этого тика о нём ещё помнят.
  if (!zones.size) return
  const paid: { entity: number; credits: number; earned: number }[] = []
  for (const [entity, player] of world.query(Player)) {
    const income = all.get(player.id)?.reduce((sum, economy) => sum + economy.income, 0)
    if (!income) continue
    const earned = player.earned + income * time.step
    const whole = Math.floor(earned)
    paid.push({ entity, credits: player.credits + whole, earned: earned - whole })
  }
  for (const { entity, credits, earned } of paid) world.set(entity as never, Player, { credits, earned })
  wear(sim, zones, all)
}
