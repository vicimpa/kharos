import { createSim, spawnStartingUnits, type Command, type Sim, type SimOptions } from '../sim'
import type { ServerMessage } from './protocol'

/** На каком расстоянии от начала мира появляются игроки, в тайлах. */
const SPAWN_RADIUS = 24
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
  /** Сколько клиентов сейчас подключено. */
  readonly peers: number
  /** Размер последнего разосланного снимка мира в символах. */
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
 * пришедший текст. Поэтому один и тот же хост работает на сервере за WebSocket, а позже — в Web Worker за WebRTC.
 */
export function createHost(options: SimOptions): Host {
  const sim = createSim(options)
  const senders = new Set<(text: string) => void>()
  const players = new Map<string, number>()
  let nextPlayer = 1
  let stateSize = 0

  const state = () => JSON.stringify({ type: 'state', tick: sim.time.tick, world: sim.save().world } satisfies ServerMessage)

  /** Новый игрок: стартовый набор на круге вокруг начала мира. */
  const addPlayer = () => {
    const player = nextPlayer++
    const slot = player - 1
    const radius = SPAWN_RADIUS * (1 + Math.floor(slot / SPAWN_SLOTS))
    const angle = (slot / SPAWN_SLOTS) * Math.PI * 2
    const limit = Math.floor(options.size / 2) - 2
    const clamp = (value: number) => Math.max(-limit, Math.min(limit, Math.round(value)))
    spawnStartingUnits(sim, player, clamp(Math.cos(angle) * radius), clamp(Math.sin(angle) * radius))
    return player
  }

  return {
    sim,
    get peers() {
      return senders.size
    },
    get stateSize() {
      return stateSize
    },
    join(send, token) {
      let player = token === undefined ? undefined : players.get(token)
      if (player === undefined) {
        player = addPlayer()
        if (token !== undefined) players.set(token, player)
      }
      senders.add(send)
      send(JSON.stringify({ type: 'welcome', player, options, step: sim.time.step } satisfies ServerMessage))
      // Мир сразу, не дожидаясь тика: иначе клиент начал бы с пустого экрана.
      send(state())
      return {
        player,
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
          sim.send(player, command as Command)
        },
        leave() {
          senders.delete(send)
        },
      }
    },
    advance(seconds) {
      const ticks = sim.advance(seconds)
      if (ticks && senders.size) {
        const text = state()
        stateSize = text.length
        for (const send of senders) send(text)
      }
      return ticks
    },
  }
}
