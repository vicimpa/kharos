import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, type BuildingSpec, type BuildingType } from './buildings'
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

/** Зона строительства вместе с её хозяйством. */
interface Book {
  player: number
  zone: Zone
  economy: Economy
}

/**
 * Зоны всех игроков с их хозяйствами, у каждого игрока — в порядке зон. Считаются только готовые здания в зонах:
 * свернул главное здание — встало всё.
 */
function books(sim: Sim): Book[] {
  const result: Book[] = []
  for (const [player, zones] of allZones(sim)) {
    for (const zone of zones) result.push({ player, zone, economy: economyOfZone(sim, zone) })
  }
  return result
}

/** Сколько энергии даёт или просит здание: больше нуля — вырабатывает, меньше — потребляет. */
const powerAt = (sim: Sim, building: Entity) => buildingSpec(sim.world.get(building, Building)!.type).power ?? 0

/** Хозяйства зон одного игрока. */
export const zoneEconomies = (sim: Sim, player: number): readonly Economy[] =>
  books(sim).filter((book) => book.player === player).map((book) => book.economy)

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
  for (const { zone, economy } of books(sim)) {
    if (economy.demand <= economy.produced) continue
    for (const entity of zone.buildings) {
      const power = powerAt(sim, entity)
      if (power) states.set(entity, power > 0 ? 'overload' : 'starved')
    }
  }
  return states
}

/**
 * На какую долю от полной скорости работает каждый потребитель энергии: 1 — энергии хватает. Потребителя,
 * который не входит ни в одну зону строительства, здесь нет — он не работает вовсе.
 */
export function powerSupply(sim: Sim): Map<Entity, number> {
  const supply = new Map<Entity, number>()
  for (const { zone, economy } of books(sim)) {
    const share = economy.demand > 0 ? Math.min(1, economy.produced / economy.demand) : 1
    for (const entity of zone.buildings) if (powerAt(sim, entity) < 0) supply.set(entity, share)
  }
  return supply
}

/**
 * Электростанции зон, где энергии не хватило бы и целым станциям: потребителей там больше, чем станции тянут.
 * Чинить такие бесполезно, пока перегруз не снят. Станции, которым не хватает только из-за повреждений, сюда не входят.
 */
export function overbuiltPlants(sim: Sim): Set<Entity> {
  const plants = new Set<Entity>()
  for (const { zone, economy } of books(sim)) {
    const found = zone.buildings.filter((entity) => powerAt(sim, entity) > 0)
    const capacity = found.reduce((sum, entity) => sum + powerAt(sim, entity), 0)
    if (economy.demand > capacity) for (const entity of found) plants.add(entity)
  }
  return plants
}

/**
 * Раз в тик: перегруженные электростанции теряют прочность и в нуле разрушаются.
 * Сами здания не восстанавливаются: их чинят строители.
 */
function wear(sim: Sim, all: Book[]) {
  const { world, time } = sim
  // Состав мира меняется после обхода.
  const ruined: Entity[] = []
  for (const { zone, economy } of all) {
    const overload = overloadOf(economy)
    if (!overload) continue
    for (const entity of zone.buildings) {
      if (powerAt(sim, entity) <= 0) continue
      const building = world.get(entity, Building)!
      building.health -= OVERLOAD_DAMAGE * overload * time.step
      if (building.health <= 0) ruined.push(entity)
    }
  }
  for (const entity of ruined) world.destroy(entity)
}

/**
 * Раз в тик: начисляет игрокам доход и изнашивает перегруженные электростанции.
 * Доли кредита копятся в earned, на счёт попадают целые.
 */
export function earn(sim: Sim) {
  const { world, time } = sim
  const all = books(sim)
  if (!all.length) return
  const incomes = new Map<number, number>()
  for (const { player, economy } of all) incomes.set(player, (incomes.get(player) ?? 0) + economy.income)
  const paid: { entity: Entity; credits: number; earned: number }[] = []
  for (const [entity, player] of world.query(Player)) {
    const income = incomes.get(player.id)
    if (!income) continue
    const earned = player.earned + income * time.step
    const whole = Math.floor(earned)
    paid.push({ entity, credits: player.credits + whole, earned: earned - whole })
  }
  for (const { entity, credits, earned } of paid) world.set(entity, Player, { credits, earned })
  // Износ — в самом конце: разрушенное здание исчезает из мира, а зоны этого тика о нём ещё помнят.
  wear(sim, all)
}
