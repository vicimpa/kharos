import { Terrain, terrainAt } from '../map/terrain'
import { isDefeated, isWalkable, shownTo, spawnStartingUnits, wipePlayer, type Command, type Sim, type SimSave } from '../sim'
import { Owner, Path, Position } from '../sim/components'
import { pathOf, seenBy, sharedWireOf, type Wired } from './wire'
import { encodeDelta, type Motion } from './codec'
import type { ServerData } from './protocol'
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

/** Мир, каким его видит игрок: по сущности — JSON каждого её компонента. */
type View = Map<number, Wired>
/** Как отправить сообщение подключению: изменения мира — двоичные, остальное — текст. */
type Send = (data: ServerData) => void

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
  /** Размер самого большого из последних разосланных изменений мира в байтах. */
  readonly stateSize: number
  /**
   * Подключает клиента. send отправляет ему сообщение: текст или двоичный кадр изменений мира, см. codec.ts. id — то, по чему хост узнаёт вернувшегося игрока: его
   * выдаёт сам хост в приветствии; с прежним id клиент получает прежнего игрока, а не новый стартовый набор.
   * Неизвестный или пустой id — новый игрок с новым id. name — ник; пустой — «Игрок N».
   */
  join(send: Send, id?: string, name?: string): Peer
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
  // На сервере до первого подключения не в сети никто.
  if (player === undefined) sim.online = new Set()
  /** Подключённые: как отправить и за кого играет. */
  const peers = new Map<Send, number>()
  /** Какие следы каждое подключение уже получило. */
  const shown = new Map<Send, Set<number>>()
  /** Какой мир каждое подключение уже получило: по сущности — JSON каждого её компонента. */
  const sent = new Map<Send, View>()
  let sinceSweep = 0

  /**
   * Следы, которые подключение видит — они в обзоре его юнитов и зданий прямо сейчас, — а ещё не получало. Новые проверяются каждый тик, все — раз в SWEEP_TICKS:
   * так находятся старые следы там, куда игрок только что пришёл.
   */
  const traces = (send: Send, player: number, sweep: boolean) => {
    const known = shown.get(send)!
    const found: Trace[] = []
    // Колею, оставленную на глазах у игрока, клиент кладёт сам: он видит того же юнита, см. traces.ts.
    for (const trace of sim.traces.fresh()) if (trace.kind === 'track' && sim.vision.sees(player, trace.x, trace.y)) known.add(trace.id)
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
    // Кто в сети, знает только сервер: доход игрока не в сети урезан, см. Rules.offlineIncome. Локальная игра
    // (player задан) идёт, только пока открыта, и там все в сети.
    if (player === undefined) sim.online = new Set(peers.values())
    const text = roster()
    for (const send of peers.keys()) send(text)
  }
  let stateSize = 0

  /** Сущности, какими они уходят всем, кроме пути, — собранные в этом тике, см. sharedWireOf. */
  const common: { tick: number; sim: Sim | undefined; wired: Map<number, Wired> } = { tick: -1, sim: undefined, wired: new Map() }

  /** Мир глазами игрока: только то, что он видит. Вкладки одного игрока смотрят на один и тот же. */
  const view = (player: number, cache?: Map<number, View>) => {
    let found = cache?.get(player)
    if (found === undefined) {
      found = new Map()
      const tick = sim.time.tick
      if (common.tick !== tick || common.sim !== sim) Object.assign(common, { tick, sim, wired: new Map() })
      for (const entity of sim.world.all) {
        if (!shownTo(sim, player, entity)) continue
        // Общее для всех собирается раз за тик — у первого, кто увидел сущность; путь — свой у каждого.
        let shared = common.wired.get(entity)
        if (!shared) common.wired.set(entity, (shared = sharedWireOf(sim.world, entity, tick)))
        let wired = seenBy(shared, player)
        const path = pathOf(sim.world, entity, player)
        if (path !== undefined) wired = { parts: new Map(wired.parts).set(Path.key, path), motion: wired.motion }
        if (wired.parts.size || wired.motion) found.set(entity, wired)
      }
      cache?.set(player, found)
    }
    return found
  }

  /**
   * Что поменялось в мире подключения с прошлого раза: сравнивается JSON компонентов, так что неподвижное здание
   * не уходит в сеть каждый тик. Текст собирается из готовых кусков JSON, чтобы не сериализовать всё второй раз.
   */
  const delta = (send: Send, player: number, cache?: Map<number, View>) => {
    const before = sent.get(send)!
    const now = view(player, cache)
    const set: string[] = []
    const unset: [number, string[]][] = []
    const remove: number[] = []
    const motions: [number, Motion][] = []
    for (const [id, { parts: components, motion }] of now) {
      const old = before.get(id)
      const parts: string[] = []
      for (const [key, json] of components) if (old?.parts.get(key) !== json) parts.push(`${JSON.stringify(key)}:${json}`)
      if (parts.length) set.push(`[${id},{${parts.join(',')}}]`)
      // Новая сущность получает движение, даже если ничего, кроме него, у неё нет: так клиент узнаёт о ней.
      if (motion && (!old?.motion || motion.some((value, i) => value !== old.motion![i]))) motions.push([id, motion])
      else if (!old && !parts.length) set.push(`[${id},{}]`)
      if (old) {
        const dropped = [...old.parts.keys()].filter((key) => !components.has(key))
        if (dropped.length) unset.push([id, dropped])
      }
      before.set(id, { parts: components, motion })
    }
    for (const id of before.keys()) {
      if (now.has(id)) continue
      remove.push(id)
      before.delete(id)
    }
    return encodeDelta(sim.time.tick, motions, `{"set":[${set.join(',')}],"unset":${JSON.stringify(unset)},"remove":${JSON.stringify(remove)}}`)
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
  const addPlayer = () => place(nextPlayer++)

  /** Ставит игроку стартовый набор: в случайном месте вдали от других, а не нашлось — на круге вокруг начала мира. */
  const place = (player: number) => {
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
      const cache = new Map<number, View>()
      for (const [send, player] of peers) {
        send(welcome(player))
        send(explored(player))
        sent.set(send, new Map())
        send(delta(send, player, cache))
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
      sent.set(send, new Map())
      send(welcome(joined, id))
      send(explored(joined))
      // Мир сразу, не дожидаясь тика: иначе клиент начал бы с пустого экрана.
      send(delta(send, joined))
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
          // Проигравший начинает заново: остатки его базы исчезают, а сам он получает новый стартовый набор.
          if (type === 'respawn') {
            if (!isDefeated(sim, joined)) return
            wipePlayer(sim, joined)
            sim.vision.forget(joined)
            place(joined)
            // Вкладки игрока начинают как в новом мире: туман закрыт, камера встаёт на новый стартовый набор.
            for (const [peer, owner] of peers) {
              if (owner !== joined) continue
              peer(welcome(joined))
              peer(explored(joined))
              sent.set(peer, new Map())
              shown.set(peer, new Set())
              peer(delta(peer, joined))
            }
            return
          }
          if (type !== 'command' || typeof command !== 'object' || command === null) return
          // Что внутри команды, проверит сама симуляция: она не доверяет и локальному клиенту.
          sim.send(joined, command as Command)
        },
        leave() {
          peers.delete(send)
          shown.delete(send)
          sent.delete(send)
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
        const cache = new Map<number, View>()
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
          const text = delta(send, player, cache)
          stateSize = Math.max(stateSize, text.length)
          send(text)
        }
      }
      return ticks
    },
  }
}
