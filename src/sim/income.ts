import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, type BuildingSpec, type BuildingType } from './buildings'
import { Assembly, Building, Health, Off, Player } from './components'
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

/** Есть ли в зоне главное здание: без него доход приносит только оно само, генераторы материи стоят. */
const hasCore = (sim: Sim, zone: Zone) => zone.buildings.some((entity) => sim.world.get(entity, Building)!.type === 'command')

/** Приносит ли здание доход только при главном здании в зоне: все доходные, кроме самого главного. */
const needsCore = (type: BuildingType) => type !== 'command' && !!buildingSpec(type).income

/**
 * Хозяйство зоны. Если энергии не хватает, потребители работают на ту долю, на которую её хватает.
 * Доход с генераторов материи — только если в зоне есть главное здание; энергию они просят и без него.
 */
function economyOfZone(sim: Sim, zone: Zone): Economy {
  const economy: Economy = { produced: 0, demand: 0, income: 0, crowd: 0 }
  const core = hasCore(sim, zone)
  /** Доход потребителей при полной энергии. */
  let powered = 0
  for (const entity of zone.buildings) {
    const building = sim.world.get(entity, Building)!
    const spec: BuildingSpec = BUILDINGS[building.type]
    const power = spec.power ?? 0
    const income = core || !needsCore(building.type) ? (spec.income ?? 0) : 0
    // Выключенный потребитель энергии не просит и ничего не даёт.
    if (power < 0 && switchedOff(sim, entity)) continue
    // Повреждённая электростанция даёт энергии во столько же раз меньше, во сколько упала её прочность.
    if (power > 0) economy.produced += power * (sim.world.get(entity, Health)?.value ?? 1)
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

/** Здания всех игроков, которые принесли бы доход, но стоят в зоне без главного здания и поэтому не приносят. */
export function coreless(sim: Sim): Set<Entity> {
  const idle = new Set<Entity>()
  for (const { zone } of books(sim)) {
    if (hasCore(sim, zone)) continue
    for (const entity of zone.buildings) if (needsCore(sim.world.get(entity, Building)!.type)) idle.add(entity)
  }
  return idle
}

/** Сколько энергии даёт или просит здание: больше нуля — вырабатывает, меньше — потребляет. */
const powerAt = (sim: Sim, building: Entity) => buildingSpec(sim.world.get(building, Building)!.type).power ?? 0
/** Потребитель, которого игрок выключил: энергии ему не нужно, и работать он не будет. У завода изделий — свой флаг. */
function switchedOff(sim: Sim, building: Entity) {
  const assembly = sim.world.get(building, Assembly)
  return assembly ? !assembly.on : sim.world.has(building, Off)
}

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
      if (power > 0) states.set(entity, 'overload')
      else if (power < 0 && !switchedOff(sim, entity)) states.set(entity, 'starved')
    }
  }
  return states
}

/**
 * На какую долю от полной скорости работает каждый потребитель энергии: 1 — энергии хватает. Потребителя,
 * который не входит ни в одну зону строительства или выключен, здесь нет — он не работает вовсе.
 */
export function powerSupply(sim: Sim): Map<Entity, number> {
  const supply = new Map<Entity, number>()
  for (const { zone, economy } of books(sim)) {
    const share = economy.demand > 0 ? Math.min(1, economy.produced / economy.demand) : 1
    for (const entity of zone.buildings) if (powerAt(sim, entity) < 0 && !switchedOff(sim, entity)) supply.set(entity, share)
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
      const health = world.get(entity, Health)!
      health.value -= OVERLOAD_DAMAGE * overload * time.step
      if (health.value <= 0) ruined.push(entity)
    }
  }
  for (const entity of ruined) world.destroy(entity)
}

/**
 * Раз в тик: начисляет игрокам доход и изнашивает перегруженные электростанции.
 * Доли кредита копятся в earned, на счёт попадают целые. Игроку не в сети — доля дохода, и за одно отсутствие
 * не больше потолка (Rules.offlineIncome, offlineMinutes): иначе за ночь копилось бы целое состояние.
 */
export function earn(sim: Sim) {
  const { world, time } = sim
  const all = books(sim)
  if (!all.length) return
  const incomes = new Map<number, number>()
  for (const { player, economy } of all) incomes.set(player, (incomes.get(player) ?? 0) + economy.income)
  const paid: { entity: Entity; credits: number; earned: number; away: number }[] = []
  const { online, rules } = sim
  for (const [entity, player] of world.query(Player)) {
    const here = !online || online.has(player.id)
    const income = incomes.get(player.id) ?? 0
    let gain = income * time.step
    if (!here) gain = Math.max(0, Math.min(gain * rules.offlineIncome, income * rules.offlineMinutes * 60 - player.away))
    // В сети — отсутствие кончилось, и потолок снова полный.
    const away = here ? 0 : player.away + gain
    if (gain <= 0 && away === player.away) continue
    const earned = player.earned + gain
    const whole = Math.floor(earned)
    paid.push({ entity, credits: player.credits + whole, earned: earned - whole, away })
  }
  for (const { entity, credits, earned, away } of paid) world.set(entity, Player, { credits, earned, away })
  // Износ — в самом конце: разрушенное здание исчезает из мира, а зоны этого тика о нём ещё помнят.
  wear(sim, all)
}
