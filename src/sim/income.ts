import { BUILDINGS, type BuildingSpec, type BuildingType } from './buildings'
import { Building, Owner, Player, Position, Site } from './components'
import type { Sim } from './sim'
import { allZones, inCircles } from './zones'

/** Хозяйство игрока на этот тик. */
export interface Economy {
  /** Сколько энергии дают его здания и сколько её просят потребители. */
  produced: number
  demand: number
  /** Доход в кредитах в секунду с учётом нехватки энергии. */
  income: number
  /** Сколько в зоне зданий, которым тесно друг с другом (см. BuildingSpec.crowding). */
  crowd: number
}

const NOTHING: Economy = { produced: 0, demand: 0, income: 0, crowd: 0 }

/**
 * Хозяйства всех игроков. Считаются только готовые здания в зоне строительства владельца:
 * свернул главное здание — встало всё. Если энергии не хватает, потребители работают на ту долю, на которую её хватает.
 */
export function economies(sim: Sim): Map<number, Economy> {
  const { world } = sim
  const zones = allZones(sim)
  const result = new Map<number, Economy>()
  if (!zones.size) return result

  /** Доход потребителей при полной энергии; после обхода умножается на долю, на которую её хватило. */
  const powered = new Map<number, number>()
  for (const [entity, position, building, owner] of world.query(Position, Building, Owner)) {
    const zone = zones.get(owner.player)
    if (!zone || world.has(entity, Site)) continue
    const spec: BuildingSpec = BUILDINGS[building.type]
    const power = spec.power ?? 0
    const income = spec.income ?? 0
    if (!power && !income) continue
    if (!inCircles(zone, position.x + spec.width / 2, position.y + spec.height / 2)) continue

    let economy = result.get(owner.player)
    if (!economy) result.set(owner.player, (economy = { produced: 0, demand: 0, income: 0, crowd: 0 }))
    if (power > 0) economy.produced += power
    if (power < 0) {
      // Тесное здание просит тем больше, чем их уже в зоне: первое — одну норму, второе — две, третье — три.
      economy.demand -= power * (spec.crowding ? ++economy.crowd : 1)
      powered.set(owner.player, (powered.get(owner.player) ?? 0) + income)
    } else {
      economy.income += income
    }
  }
  for (const [player, income] of powered) {
    const economy = result.get(player)!
    economy.income += income * Math.min(1, economy.produced / economy.demand)
  }
  return result
}

/** Хозяйство одного игрока. */
export const economyOf = (sim: Sim, player: number): Economy => economies(sim).get(player) ?? NOTHING

/**
 * Как здание этого вида изменит баланс энергии игрока, если его построить в зоне:
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
    const income = all.get(player.id)?.income
    if (!income) continue
    const earned = player.earned + income * time.step
    const whole = Math.floor(earned)
    paid.push({ entity, credits: player.credits + whole, earned: earned - whole })
  }
  for (const { entity, credits, earned } of paid) world.set(entity as never, Player, { credits, earned })
}
