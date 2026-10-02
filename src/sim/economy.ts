import type { Entity } from '../ecs'
import { Player } from './components'
import type { Sim } from './sim'

/** С какой суммой игрок появляется в мире. */
export const STARTING_CREDITS = 1000

function playerEntity(sim: Sim, player: number): Entity | undefined {
  for (const [entity, data] of sim.world.query(Player)) if (data.id === player) return entity
  return undefined
}

/** Сколько кредитов у игрока. У неизвестного игрока — ноль. */
export function creditsOf(sim: Sim, player: number) {
  const entity = playerEntity(sim, player)
  return entity === undefined ? 0 : sim.world.get(entity, Player)!.credits
}

/** Начисляет кредиты. Игрок, которого ещё нет в мире, при этом появляется. */
export function addCredits(sim: Sim, player: number, amount: number) {
  const entity = playerEntity(sim, player)
  if (entity === undefined) sim.world.spawn(Player({ id: player, credits: amount }))
  else sim.world.set(entity, Player, { credits: sim.world.get(entity, Player)!.credits + amount })
}

/** Списывает кредиты, если их хватает. Возвращает, удалось ли. */
export function pay(sim: Sim, player: number, amount: number) {
  const entity = playerEntity(sim, player)
  if (entity === undefined) return false
  const { credits } = sim.world.get(entity, Player)!
  if (credits < amount) return false
  sim.world.set(entity, Player, { credits: credits - amount })
  return true
}
