import { Terrain, terrainAt } from '../map/terrain'
import { isWalkable, shownTo, spawnStartingUnits, type Command, type Sim, type SimSave } from '../sim'
import { Owner, Position, SAVED } from '../sim/components'
import type { Trace } from '../sim/traces'
import { cleanName, type PlayerInfo, type ServerMessage } from './protocol'

/**
 * Где появляется новый игрок: в случайной точке карты, на скале, где хватит места под базу, и не ближе SPAWN_APART
 * тайлов к чужим юнитам и зданиям. Не нашлось за SPAWN_TRIES попыток — требование к расстоянию слабеет вдвое.
 */
const SPAWN_APART = 96
const SPAWN_TRIES = 400
/** Сколько тайлов скалы должно быть в квадрате SPAWN_AREA вокруг точки появления: MCV есть где развернуться. */
const SPAWN_AREA = 6
const SPAWN_ROCK = 100
/** Отступ точки появления от края карты. */
const SPAWN_MARGIN = 16
/** Запасной круг: если случайной точки не нашлось совсем, игроки встают на нём вокруг начала мира. */
const SPAWN_RADIUS = 24
/** Раз во сколько тиков хост ищет для игроков старые следы, а не только новые. */
const SWEEP_TICKS = 5
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
   * Подключает клиента. send отправляет ему текст сообщения. id — то, по чему хост узнаёт вернувшегося игрока: его
   * выдаёт сам хост в приветствии; с прежним id клиент получает прежнего игрока, а не новый стартовый набор.
   * Неизвестный или пустой id — новый игрок с новым id. name — ник; пустой — «Игрок N».
   */
  join(send: (text: string) => void, id?: string, name?: string): Peer
  /** Продвигает игру на seconds реального времени и рассылает мир, если прошёл хотя бы один тик. */
  advance(seconds: number): number
  /** Мир вместе с тем, кого хост знает: по id игроки узнаются и после перезапуска сервера. */
  save(): HostSave
}

/** Сохранение сервера: мир, id игроков и их ники. */
export interface HostSave {
  sim: SimSave
  /** Номер игрока по выданному ему id. */
  players: Record<string, number>
  /** Ники по номеру игрока. */
  names: Record<string, string>
}

/**
 * Хост — симуляция плюс подключённые игроки. Про сокеты он не знает: ему дают функцию отправки и приносят
 * пришедший текст. Поэтому один и тот же хост работает на сервере за WebSocket и в воркере локальной игры
 * за postMessage. player — все подключения играют за этого игрока, и новых стартовых наборов нет: так вкладки
 * одной локальной игры показывают один мир. Без него каждый новый token — новый игрок.
 */
export function createHost(first: Sim, player?: number, saved?: Omit<HostSave, 'sim'>): Host {
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
    const found: Trace[] = []
    for (const trace of sweep ? sim.traces.all() : sim.traces.fresh()) {
      const seen = sim.vision.sees(player, trace.x, trace.y)
      if (seen && !known.has(trace.id)) {
        found.push(trace)
        known.add(trace.id)
      } else if (!seen && known.has(trace.id)) {
        // Ушёл из обзора — клиент его выбросил, а вернётся в обзор — получит снова.
        known.delete(trace.id)
      }
    }
    return found
  }
  /** Номер игрока по id, который ему выдал хост. */
  const players = new Map<string, number>(Object.entries(saved?.players ?? {}))
  let nextPlayer = Math.max(0, ...players.values()) + 1
  /** Ники игроков по номеру. */
  const names = new Map<number, string>(Object.entries(saved?.names ?? {}).map(([player, name]) => [Number(player), name]))
  const roster = () => {
    const online = new Set(peers.values())
    const list: PlayerInfo[] = [...names].map(([player, name]) => ({ player, name, online: online.has(player) }))
    return JSON.stringify({ type: 'players', players: list } satisfies ServerMessage)
  }
  /** Сообщает всем подключённым, кто сейчас в игре. */
  const announce = () => {
    const text = roster()
    for (const send of peers.keys()) send(text)
  }
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

  /** Случайная точка появления: на скале, просторная и подальше от других игроков; undefined — не нашлась. */
  const spawnPoint = () => {
    const others: { x: number; y: number }[] = []
    for (const [, position, owner] of sim.world.query(Position, Owner)) if (owner.player) others.push(position)
    const half = Math.floor(sim.options.size / 2) - SPAWN_MARGIN
    for (let apart = SPAWN_APART; apart >= 8; apart /= 2) {
      for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
        const x = Math.floor((Math.random() * 2 - 1) * half)
        const y = Math.floor((Math.random() * 2 - 1) * half)
        if (terrainAt(sim.land, x, y) !== Terrain.Rock || !isWalkable(sim, x, y)) continue
        if (others.some((other) => Math.hypot(other.x - x, other.y - y) < apart)) continue
        let rock = 0
        for (let dy = -SPAWN_AREA; dy <= SPAWN_AREA; dy++) {
          for (let dx = -SPAWN_AREA; dx <= SPAWN_AREA; dx++) if (terrainAt(sim.land, x + dx, y + dy) === Terrain.Rock) rock++
        }
        if (rock >= SPAWN_ROCK) return { x, y }
      }
    }
    return undefined
  }

  /** Новый игрок: стартовый набор в случайном месте, см. spawnPoint; не нашлось — на круге вокруг начала мира. */
  const addPlayer = () => {
    const player = nextPlayer++
    const point = spawnPoint()
    if (point) {
      spawnStartingUnits(sim, player, point.x, point.y)
      return player
    }
    const slot = player - 1
    const radius = SPAWN_RADIUS * (1 + Math.floor(slot / SPAWN_SLOTS))
    const angle = (slot / SPAWN_SLOTS) * Math.PI * 2
    const limit = Math.floor(sim.options.size / 2) - 2
    const clamp = (value: number) => Math.max(-limit, Math.min(limit, Math.round(value)))
    spawnStartingUnits(sim, player, clamp(Math.cos(angle) * radius), clamp(Math.sin(angle) * radius))
    return player
  }

  const explored = (player: number) => JSON.stringify({ type: 'explored', map: sim.vision.map(player) } satisfies ServerMessage)
  const welcome = (player: number, id?: string) => JSON.stringify({ type: 'welcome', player, options: sim.options, step: sim.time.step, id } satisfies ServerMessage)

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
      announce()
    },
    get peers() {
      return peers.size
    },
    get stateSize() {
      return stateSize
    },
    join(send, id, name) {
      let own = player
      // У локальной игры игрок один, и узнавать его не нужно.
      if (own === undefined) {
        own = id ? players.get(id) : undefined
        if (own === undefined) {
          own = addPlayer()
          id = crypto.randomUUID()
          players.set(id, own)
        }
      } else id = undefined
      const joined = own
      const nick = cleanName(name ?? '')
      if (nick || !names.has(joined)) names.set(joined, nick || `Игрок ${joined}`)
      peers.set(send, joined)
      shown.set(send, new Set())
      send(welcome(joined, id))
      send(explored(joined))
      // Мир сразу, не дожидаясь тика: иначе клиент начал бы с пустого экрана.
      send(state(joined))
      announce()
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
          announce()
        },
      }
    },
    save() {
      return { sim: sim.save(), players: Object.fromEntries(players), names: Object.fromEntries(names) }
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
