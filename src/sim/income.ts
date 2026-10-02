import { BUILDINGS, ORE_PRICE, type BuildingSpec, type BuildingType } from './buildings'
import { Building, Player, Position } from './components'
import { oreLeft, takeOre } from './deposits'
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
  /** Сколько руды в секунду зона добывает и продаёт. */
  ore: number
}

/** Работающая шахта: месторождение под ней и сколько руды в секунду она добывает в полную силу. */
interface Mining {
  x: number
  y: number
  rate: number
}

/**
 * Добыча зоны: шахты, под которыми ещё есть руда, и доля, на которую они работают. Руду принимают хранилища зоны;
 * если шахты добывают больше, чем те принимают, все шахты замедляются поровну. Без хранилища шахты стоят.
 */
function miningOf(sim: Sim, zone: Zone): { mines: Mining[]; share: number } {
  const mines: Mining[] = []
  let extracted = 0
  let handled = 0
  for (const entity of zone.buildings) {
    const spec: BuildingSpec = BUILDINGS[sim.world.get(entity, Building)!.type]
    handled += spec.handles ?? 0
    if (!spec.extract) continue
    const { x, y } = sim.world.get(entity, Position)!
    if (oreLeft(sim, x, y) <= 0) continue
    mines.push({ x, y, rate: spec.extract })
    extracted += spec.extract
  }
  return { mines, share: extracted ? Math.min(1, handled / extracted) : 0 }
}

/** Хозяйство зоны. Если энергии не хватает, потребители работают на ту долю, на которую её хватает. */
function economyOfZone(sim: Sim, zone: Zone): Economy {
  const economy: Economy = { produced: 0, demand: 0, income: 0, crowd: 0, ore: 0 }
  const { mines, share } = miningOf(sim, zone)
  for (const mine of mines) economy.ore += mine.rate * share
  economy.income += economy.ore * ORE_PRICE
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
  const total: Economy = { produced: 0, demand: 0, income: 0, crowd: 0, ore: 0 }
  for (const economy of zoneEconomies(sim, player)) {
    total.produced += economy.produced
    total.demand += economy.demand
    total.income += economy.income
    total.crowd += economy.crowd
    total.ore += economy.ore
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
 * Раз в тик: начисляет игрокам доход и вынимает из месторождений добытую руду.
 * Доли кредита копятся в earned, на счёт попадают целые.
 */
export function earn(sim: Sim) {
  const { world, time } = sim
  const zones = allZones(sim)
  if (!zones.size) return
  const all = economies(sim)
  for (const list of zones.values()) {
    for (const zone of list) {
      const { mines, share } = miningOf(sim, zone)
      for (const mine of mines) takeOre(sim, mine.x, mine.y, mine.rate * share * time.step)
    }
  }
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
