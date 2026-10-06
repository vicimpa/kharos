import { shownTo, spawnStartingUnits, type Command, type Sim } from '../sim'
import { SAVED } from '../sim/components'
import type { ServerMessage } from './protocol'

/** На каком расстоянии от начала мира появляются игроки, в тайлах. */
const SPAWN_RADIUS = 24
/** Раз во сколько тиков хост ищет для игроков старые следы, а не только новые. */
const SWEEP_TICKS = 10
/** Сколько игроков помещается на круге появления; следующие встают на круг шире. */
const SPAWN_SLOTS = 8

/** Подключённый игрок с точки зрения хоста. */
export interface Peer {
  readonly player: number
  /** Сообщение от клиента как пришло из сети. Негодное молча отбрасывается. */
  receive(text: string): void
  /** Клиент отключился. Его юниты и здания остаются в мире. */
  leave(): void
}

export interface Host {
  readonly sim: Sim
  /** Заменяет мир новым: все подключённые получают приветствие и новый мир, как при подключении. */
  replace(sim: Sim): void
  /** Сколько клиентов сейчас подключено. */
  readonly peers: number
  /** Размер самого большого из последних разосланных снимков мира в символах. */
  readonly stateSize: number
  /**
   * Подключает клиента. send отправляет ему текст сообщения. token — то, по чему хост узнаёт вернувшегося игрока:
   * с прежним token клиент получает прежнего игрока, а не новый стартовый набор.
   */
  join(send: (text: string) => void, token?: string): Peer
  /** Продвигает игру на seconds реального времени и рассылает мир, если прошёл хотя бы один тик. */
  advance(seconds: number): number
}

/**
 * Хост — симуляция плюс подключённые игроки. Про сокеты он не знает: ему дают функцию отправки и приносят
 * пришедший текст. Поэтому один и тот же хост работает на сервере за WebSocket и в воркере локальной игры
 * за postMessage. player — все подключения играют за этого игрока, и новых стартовых наборов нет: так вкладки
 * одной локальной игры показывают один мир. Без него каждый новый token — новый игрок.
 */
export function createHost(first: Sim, player?: number): Host {
  let sim = first
  /** Подключённые: как отправить и за кого играет. */
  const peers = new Map<(text: string) => void, number>()
  /** Какие следы каждое подключение уже получило. */
  const shown = new Map<(text: string) => void, Set<number>>()
  let sinceSweep = 0

  /**
   * Следы, которые подключение видит — они в обзоре его юнитов и зданий прямо сейчас, — а ещё не получало. Новые проверяются каждый тик, все — раз в SWEEP_TICKS:
   * так находятся старые следы там, куда игрок только что пришёл.
   */
  const traces = (send: (text: string) => void, player: number, sweep: boolean) => {
    const known = shown.get(send)!
    const found = (sweep ? sim.traces.all() : sim.traces.fresh()).filter(
      (trace) => !known.has(trace.id) && sim.vision.sees(player, trace.x, trace.y),
    )
    for (const trace of found) known.add(trace.id)
    return found
  }
  const players = new Map<string, number>()
  let nextPlayer = 1
  let stateSize = 0

  /** Мир глазами игрока: только то, что он видит. Вкладки одного игрока получают один и тот же текст. */
  const state = (player: number, cache?: Map<number, string>) => {
    let text = cache?.get(player)
    if (text === undefined) {
      const world = sim.world.snapshot(SAVED, (entity) => shownTo(sim, player, entity))
      text = JSON.stringify({ type: 'state', tick: sim.time.tick, world } satisfies ServerMessage)
      cache?.set(player, text)
    }
    return text
  }

  /** Новый игрок: стартовый набор на круге вокруг начала мира. */
  const addPlayer = () => {
    const player = nextPlayer++
    const slot = player - 1
    const radius = SPAWN_RADIUS * (1 + Math.floor(slot / SPAWN_SLOTS))
    const angle = (slot / SPAWN_SLOTS) * Math.PI * 2
    const limit = Math.floor(sim.options.size / 2) - 2
    const clamp = (value: number) => Math.max(-limit, Math.min(limit, Math.round(value)))
    spawnStartingUnits(sim, player, clamp(Math.cos(angle) * radius), clamp(Math.sin(angle) * radius))
    return player
  }

  const explored = (player: number) => JSON.stringify({ type: 'explored', map: sim.vision.map(player) } satisfies ServerMessage)
  const welcome = (player: number) => JSON.stringify({ type: 'welcome', player, options: sim.options, step: sim.time.step } satisfies ServerMessage)

  return {
    get sim() {
      return sim
    },
    replace(next) {
      sim.destroy()
      sim = next
      const cache = new Map<number, string>()
      for (const [send, player] of peers) {
        send(welcome(player))
        send(explored(player))
        send(state(player, cache))
        shown.set(send, new Set())
      }
    },
    get peers() {
      return peers.size
    },
    get stateSize() {
      return stateSize
    },
    join(send, token) {
      let own = player ?? (token === undefined ? undefined : players.get(token))
      if (own === undefined) {
        own = addPlayer()
        if (token !== undefined) players.set(token, own)
      }
      const joined = own
      peers.set(send, joined)
      shown.set(send, new Set())
      send(welcome(joined))
      send(explored(joined))
      // Мир сразу, не дожидаясь тика: иначе клиент начал бы с пустого экрана.
      send(state(joined))
      return {
        player: joined,
        receive(text) {
          let message: unknown
          try {
            message = JSON.parse(text)
          } catch {
            return
          }
          if (typeof message !== 'object' || message === null) return
          const { type, command } = message as { type?: unknown; command?: unknown }
          if (type !== 'command' || typeof command !== 'object' || command === null) return
          // Что внутри команды, проверит сама симуляция: она не доверяет и локальному клиенту.
          sim.send(joined, command as Command)
        },
        leave() {
          peers.delete(send)
          shown.delete(send)
        },
      }
    },
    advance(seconds) {
      const ticks = sim.advance(seconds)
      if (ticks && peers.size) {
        const cache = new Map<number, string>()
        stateSize = 0
        sinceSweep += ticks
        const sweep = sinceSweep >= SWEEP_TICKS
        if (sweep) sinceSweep = 0
        const expired = sim.traces.expired()
        for (const [send, player] of peers) {
          const known = shown.get(send)!
          for (const id of expired) known.delete(id)
          const found = traces(send, player, sweep)
          if (found.length) send(JSON.stringify({ type: 'traces', traces: found } satisfies ServerMessage))
          const text = state(player, cache)
          stateSize = Math.max(stateSize, text.length)
          send(text)
        }
      }
      return ticks
    },
  }
}
