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
    const spec: BuildingSpec = BUILDINGS[sim.world.get(entity, Building)!.type]
    const power = spec.power ?? 0
    const income = spec.income ?? 0
    if (power > 0) economy.produced += power
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

/** Раз в тик: начисляет игрокам доход. Доли кредита копятся в earned, на счёт попадают целые. */
export function earn(sim: Sim) {
  const { world, time } = sim
  const all = economies(sim)
  if (!all.size) return
  const paid: { entity: number; credits: number; earned: number }[] = []
  for (const [entity, player] of world.query(Player)) {
    const income = all.get(player.id)?.reduce((sum, economy) => sum + economy.income, 0)
    if (!income) continue
    const earned = player.earned + income * time.step
    const whole = Math.floor(earned)
    paid.push({ entity, credits: player.credits + whole, earned: earned - whole })
  }
  for (const { entity, credits, earned } of paid) world.set(entity as never, Player, { credits, earned })
}
