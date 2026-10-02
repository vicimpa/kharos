import { World, type Time } from '../ecs'
import { createLand } from '../map/terrain'
import { DEFAULT_RULES, boundsOf, type Command, type Sim } from '../sim'
import { createOccupancy } from '../sim/buildings'
import { SAVED } from '../sim/components'
import { SAVE_VERSION } from '../sim/sim'
import type { ClientMessage, ServerMessage } from './protocol'

/** Копия чужой симуляции: выглядит как Sim, но сама игру не считает. */
export interface Replica extends Sim {
  /** Сообщение сервера. Мир из него применится в начале следующего кадра. */
  receive(message: ServerMessage): void
  /** Соединение пропало: следующий advance() бросит ошибку с этой причиной. */
  fail(reason: string): void
}

/**
 * Копия симуляции, которую считает сервер. Клиент читает её так же, как локальную: тот же мир, та же местность,
 * та же занятость тайлов. Разница в том, что send() уходит в сеть, а advance() не считает тики, а применяет
 * присланный мир и ведёт alpha, чтобы движение между тиками оставалось плавным.
 */
export function createReplica(welcome: Extract<ServerMessage, { type: 'welcome' }>, send: (text: string) => void, close: () => void): Replica {
  const { options, step } = welcome
  const world = new World()
  const time: Time = { tick: 0, step, elapsed: 0, delta: 0, alpha: 0 }
  let pending: Extract<ServerMessage, { type: 'state' }> | null = null
  let failure: string | null = null

  const occupancy = createOccupancy(world)
  return {
    options,
    bounds: boundsOf(options.size),
    world,
    land: createLand(options.generator),
    occupancy,
    rules: { ...DEFAULT_RULES, ...options.rules },
    time,
    send(_player, command: Command) {
      // Игрока сервер знает по соединению; номеру из сообщения он бы и не поверил.
      send(JSON.stringify({ type: 'command', command } satisfies ClientMessage))
    },
    advance(seconds) {
      if (failure !== null) throw new Error(failure)
      time.delta = seconds
      if (!pending) {
        // Следующий тик опаздывает: юниты доезжают до последнего известного места и ждут.
        time.alpha = Math.min(1, time.alpha + seconds / step)
        return 0
      }
      // Пришло несколько снимков — нужен только последний: где юнит был тик назад, в нём уже записано.
      const ticks = pending.tick - time.tick
      world.restore(pending.world, SAVED)
      world.flush()
      time.tick = pending.tick
      time.elapsed = time.tick * step
      time.alpha = 0
      pending = null
      return ticks
    },
    save: () => ({ version: SAVE_VERSION, ...options, tick: time.tick, world: world.snapshot(SAVED) }),
    destroy() {
      close()
      occupancy.destroy()
      world.clear()
    },
    receive(message) {
      if (message.type === 'state') pending = message
    },
    fail(reason) {
      failure ??= reason
    },
  }
}
