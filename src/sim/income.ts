import { BUILDINGS, CORE, type BuildingSpec, type BuildingType } from './buildings'
import { Building, Owner, Player, Position, Site } from './components'
import { CONTROL_RADIUS } from './construction'
import type { Sim } from './sim'

/** Хозяйство игрока на этот тик. */
export interface Economy {
  /** Сколько энергии дают его здания и сколько её просят потребители. */
  produced: number
  demand: number
  /** Доход в кредитах в секунду с учётом нехватки энергии. */
  income: number
}

const NOTHING: Economy = { produced: 0, demand: 0, income: 0 }

/**
 * Хозяйства всех игроков. Считаются только готовые здания в радиусе контроля главного здания владельца:
 * свернул главное здание — встало всё. Если энергии не хватает, потребители работают на ту долю, на которую её хватает.
 */
export function economies(sim: Sim): Map<number, Economy> {
  const { world } = sim
  const core = BUILDINGS[CORE]
  const centers = new Map<number, number[]>()
  for (const [, position, building, owner] of world.query(Position, Building, Owner)) {
    if (building.type !== CORE) continue
    let list = centers.get(owner.player)
    if (!list) centers.set(owner.player, (list = []))
    list.push(position.x + core.width / 2, position.y + core.height / 2)
  }

  const result = new Map<number, Economy>()
  /** Доход потребителей при полной энергии; после обхода умножается на долю, на которую её хватило. */
  const powered = new Map<number, number>()
  for (const [entity, position, building, owner] of world.query(Position, Building, Owner)) {
    const list = centers.get(owner.player)
    if (!list || world.has(entity, Site)) continue
    const spec: BuildingSpec = BUILDINGS[building.type]
    const power = spec.power ?? 0
    const income = spec.income ?? 0
    if (!power && !income) continue
    let near = false
    for (let i = 0; i < list.length && !near; i += 2) {
      near = Math.hypot(position.x + spec.width / 2 - list[i], position.y + spec.height / 2 - list[i + 1]) <= CONTROL_RADIUS
    }
    if (!near) continue

    let economy = result.get(owner.player)
    if (!economy) result.set(owner.player, (economy = { produced: 0, demand: 0, income: 0 }))
    if (power > 0) economy.produced += power
    if (power < 0) {
      economy.demand -= power
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

/** Сколько зданий этого вида у игрока, считая стройки. */
export function countOf(sim: Sim, player: number, type: BuildingType) {
  let count = 0
  for (const [, building, owner] of sim.world.query(Building, Owner)) if (building.type === type && owner.player === player) count++
  // Площадка, которую ещё не начали строить, зданием не считается, но место в лимите уже заняла.
  for (const [entity, site, owner] of sim.world.query(Site, Owner)) {
    if (site.type === type && owner.player === player && !sim.world.has(entity, Building)) count++
  }
  return count
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
