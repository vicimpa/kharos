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

/**
 * Награды: кредиты за то, что игрок сделал впервые. Каждая выдаётся игроку один раз за всю игру,
 * поэтому повторять действие ради денег бессмысленно. Ключи зданий совпадают с их видами.
 */
export const REWARDS = {
  /** Развернул MCV в главное здание. */
  deploy: 250,
  /** Произвёл первый юнит. */
  unit: 50,
  generator: 150,
  matter: 200,
  mine: 200,
  silo: 50,
} satisfies Record<string, number>

export type Reward = keyof typeof REWARDS

/** Награды, которые игрок уже получил, по порядку. */
export function rewardsOf(sim: Sim, player: number): readonly string[] {
  const entity = playerEntity(sim, player)
  return entity === undefined ? [] : sim.world.get(entity, Player)!.rewards
}

/** Выдаёт игроку награду, если он её ещё не получал. key — что случилось; событий без награды большинство. */
export function reward(sim: Sim, player: number, key: string) {
  const entity = playerEntity(sim, player)
  if (entity === undefined || !Object.hasOwn(REWARDS, key)) return
  const { credits, rewards } = sim.world.get(entity, Player)!
  if (rewards.includes(key)) return
  sim.world.set(entity, Player, { credits: credits + REWARDS[key as Reward], rewards: [...rewards, key] })
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

/**
 * Списывает сумму с дробной частью, если денег хватает: доли идут из заработанного, но ещё не дошедшего
 * до целого кредита (Player.earned), а когда его не хватает — разменивается целый кредит со счёта.
 */
export function spend(sim: Sim, player: number, amount: number) {
  const entity = playerEntity(sim, player)
  if (entity === undefined) return false
  const { credits, earned } = sim.world.get(entity, Player)!
  const left = earned - amount
  const whole = left < 0 ? Math.ceil(-left) : 0
  if (credits < whole) return false
  sim.world.set(entity, Player, { credits: credits - whole, earned: left + whole })
  return true
}
