import { World, type Time } from '../ecs'
import { createLand } from '../map/terrain'
import { DEFAULT_RULES, boundsOf, type Command, type Sim } from '../sim'
import { createOccupancy } from '../sim/buildings'
import { createReceivedTraces } from '../sim/traces'
import { createVision } from '../sim/vision'
import { BUILDINGS, type BuildingType } from '../sim/buildings'
import { Ghost, SAVED } from '../sim/components'
import { SAVE_VERSION, type SimSave } from '../sim/sim'
import type { ClientMessage, ServerMessage } from './protocol'

/** Из чего собираются призраки: сохраняемое и метка призрака. */
const REMEMBERED = [...SAVED, Ghost]

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
  let player = welcome.player
  /** Чужие здания и месторождения, увиденные раньше: какими их видели последний раз. */
  const memory = new Map<number, Record<string, object>>()
  /** Снесено ли запомненное: его место сейчас в обзоре, а хост его не прислал. */
  const gone = (data: Record<string, object>) => {
    const at = data.Position as { x: number; y: number } | undefined
    if (!at) return true
    const type = (data.Building as { type: BuildingType } | undefined)?.type
    const { width, height } = type ? BUILDINGS[type] : { width: 1, height: 1 }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (replica.vision.sees(player, at.x + x, at.y + y)) return true
    return false
  }

  const occupancy = createOccupancy(world)
  /** Мир по приветствию: при первом подключении и когда хост начинает мир заново. */
  const meet = ({ options, step, player: own }: Extract<ServerMessage, { type: 'welcome' }>) => {
    player = own
    memory.clear()
    const generator = replica.options?.generator
    replica.options = options
    replica.bounds = boundsOf(options.size)
    if (JSON.stringify(generator) !== JSON.stringify(options.generator)) replica.land = createLand(options.generator)
    replica.rules = { ...DEFAULT_RULES, ...options.rules }
    // Разведанное в новом мире ничего не значит.
    replica.vision = createVision(world, replica.bounds, () => time.tick)
    replica.traces = createReceivedTraces(() => time.tick, step)
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
    vision: undefined as unknown as Replica['vision'],
    traces: undefined as unknown as ReturnType<typeof createReceivedTraces>,
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
      // Чужое здание, ушедшее в туман, остаётся на карте призраком, пока его место не окажется в обзоре.
      const present = new Set<number>()
      for (const [id, data] of pending.world.entities) {
        present.add(id)
        const owner = (data.Owner as { player: number } | undefined)?.player
        if (('Building' in data || 'Deposit' in data) && owner !== player) memory.set(id, data)
      }
      for (const [id, data] of memory) {
        if (present.has(id)) continue
        if (gone(data)) memory.delete(id)
        else world.insert(id, { ...data, Ghost: {} }, REMEMBERED)
      }
      world.flush()
      replica.traces.update()
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
      else if (message.type === 'explored') replica.vision.explore(player, message.map)
      else if (message.type === 'traces') replica.traces.receive(message.traces)
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
