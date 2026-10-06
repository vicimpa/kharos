import { World, type Time } from '../ecs'
import { createLand } from '../map/terrain'
import { DEFAULT_RULES, boundsOf, type Command, type Sim } from '../sim'
import { createOccupancy } from '../sim/buildings'
import { SAVED } from '../sim/components'
import { SAVE_VERSION, type SimSave } from '../sim/sim'
import type { ClientMessage, ServerMessage } from './protocol'

/** Копия чужой симуляции: выглядит как Sim, но сама игру не считает. */
export interface Replica extends Sim {
  /** Сообщение сервера. Мир из него применится в начале следующего кадра. */
  receive(message: ServerMessage): void
  /** Соединение пропало: следующий advance() бросит ошибку с этой причиной. */
  fail(reason: string): void
  /** Растёт, когда хост начинает мир заново: по нему клиент сбрасывает выделение и камеру. */
  readonly generation: number
}

/**
 * Копия симуляции, которую считает сервер. Клиент читает её так же, как локальную: тот же мир, та же местность,
 * та же занятость тайлов. Разница в том, что send() уходит в сеть, а advance() не считает тики, а применяет
 * присланный мир и ведёт alpha, чтобы движение между тиками оставалось плавным.
 */
export function createReplica(welcome: Extract<ServerMessage, { type: 'welcome' }>, send: (text: string) => void, close: () => void): Replica {
  const world = new World()
  const time: Time = { tick: 0, step: welcome.step, elapsed: 0, delta: 0, alpha: 0 }
  let pending: Extract<ServerMessage, { type: 'state' }> | null = null
  let failure: string | null = null

  const occupancy = createOccupancy(world)
  /** Мир по приветствию: при первом подключении и когда хост начинает мир заново. */
  const meet = ({ options, step }: Extract<ServerMessage, { type: 'welcome' }>) => {
    const generator = replica.options?.generator
    replica.options = options
    replica.bounds = boundsOf(options.size)
    if (JSON.stringify(generator) !== JSON.stringify(options.generator)) replica.land = createLand(options.generator)
    replica.rules = { ...DEFAULT_RULES, ...options.rules }
    world.clear()
    world.flush()
    Object.assign(time, { tick: 0, step, elapsed: 0, delta: 0, alpha: 0 })
    pending = null
  }
  const replica = {
    options: undefined as unknown as Replica['options'],
    bounds: undefined as unknown as Replica['bounds'],
    land: undefined as unknown as Replica['land'],
    rules: undefined as unknown as Replica['rules'],
    generation: 0,
    world,
    occupancy,
    time,
    send(_player: number, command: Command) {
      // Игрока сервер знает по соединению; номеру из сообщения он бы и не поверил.
      send(JSON.stringify({ type: 'command', command } satisfies ClientMessage))
    },
    advance(seconds: number) {
      if (failure !== null) throw new Error(failure)
      time.delta = seconds
      if (!pending) {
        // Следующий тик опаздывает: юниты доезжают до последнего известного места и ждут.
        time.alpha = Math.min(1, time.alpha + seconds / time.step)
        return 0
      }
      // Пришло несколько снимков — нужен только последний: где юнит был тик назад, в нём уже записано.
      const ticks = pending.tick - time.tick
      world.restore(pending.world, SAVED)
      world.flush()
      time.tick = pending.tick
      time.elapsed = time.tick * time.step
      time.alpha = 0
      pending = null
      return ticks
    },
    save: (): SimSave => ({ version: SAVE_VERSION, ...replica.options, tick: time.tick, world: world.snapshot(SAVED) }),
    destroy() {
      close()
      occupancy.destroy()
      world.clear()
    },
    receive(message: ServerMessage) {
      if (message.type === 'state') pending = message
      else {
        meet(message)
        replica.generation++
      }
    },
    fail(reason: string) {
      failure ??= reason
    },
  }
  meet(welcome)
  return replica
}
