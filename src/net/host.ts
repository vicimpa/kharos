import type { Entity } from '../ecs'
import { Terrain, terrainAt } from '../map/terrain'
import { UNIT_TYPES, creditsOf, flies, isDefeated, type UnitType, notWalledIn, isWalkable, openSpawn, shownTo, spawnStartingUnits, wipePlayer, type Command, type Sim, type SimSave } from '../sim'
import { Attached, Building, Owner, Path, Position, Unit } from '../sim/components'
import { pathOf, seenBy, sharedWireOf, type Wired } from './wire'
import { LAND, encodeDelta, type Motion } from './codec'
import { deflate } from '../save/file'
import { DEPOSIT_SIZE, fillDeposits, saveDeposits } from '../sim/deposits'
import { knownEdits, pristineLand, takeLearned } from '../sim/landMemory'
import type { ServerData } from './protocol'
import { TRACE_CELL, type Trace } from '../sim/traces'
import { cleanChat, cleanName, type ChatLine, type PlayerInfo, type ServerMessage } from './protocol'
import { PLAYER_ARG, parseCommand, type CommandInfo } from './chatCommands'
import { erase, putUnit, setCredits, setHealth } from '../sim/editor'
import { freeTilesNear } from '../sim/units'

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
/** Как часто, в мс, одно подключение может писать в чат. */
const CHAT_GAP = 500
/** Больше скольких юнитов /spawn за раз не ставит. */
const SPAWN_MOST = 50
/** Сколько мс после неверного пароля администратора подключение не может попробовать снова. */
const ADMIN_LOCK = 3000
/** Имя, которым подписаны сообщения администратора и консоли сервера, /say. */
export const SERVER_NAME = '[Сервер]'
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

/** Кто зовёт команду: игрок из чата или консоль сервера (player нет). reply — ответ только ему. */
export interface Caller {
  player?: number
  admin: boolean
  reply(text: string): void
}

/**
 * Команда хоста. admin — только администратору (консоль им считается всегда); game — только из игры, не из
 * консоли; console — только из консоли, клиенту её не видно. args — слова после команды, rest(n) — текст после n слов.
 */
export interface HostCommand extends CommandInfo {
  admin?: boolean
  game?: boolean
  console?: boolean
  run(args: string[], rest: (skip: number) => string, caller: Caller): void
}

export interface HostOptions {
  /** Пароль режима администратора, /admin; пустой или нет — режима нет. В локальной игре он не нужен. */
  admin?: string
  /** Куда писать, что делают администраторы: консоль сервера. */
  log?(text: string): void
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
  join(send: Send, id?: string, name?: string, close?: () => void): Peer
  /** Выполняет команду (строку без «/» или с ним) от имени caller, см. HostCommand. */
  command(text: string, caller: Caller): void
  /** Добавляет команду: например, сохранение и остановку, которые умеет только сервер. */
  addCommand(command: HostCommand): void
  /** Пишет всем в чат от имени сервера. */
  say(text: string): void
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
export function createHost(first: Sim, player?: number, saved?: Omit<HostSave, 'sim'>, options: HostOptions = {}): Host {
  let sim = first
  // Клиенты получают месторождения слоем целиком: генератор у них их не считает.
  fillDeposits(sim)
  /** Какую правку месторождений уже разослали. */
  let depositsSent = sim.deposits.revision
  /** Какой слой месторождений каждое подключение получило последним: шлётся заново, только если он поменялся. */
  const depositsShown = new Map<Send, string>()
  // На сервере до первого подключения не в сети никто.
  if (player === undefined) sim.online = new Set()
  /** Подключённые: как отправить и за кого играет. */
  const peers = new Map<Send, number>()
  /** Какие следы каждое подключение уже получило. */
  const shown = new Map<Send, Set<number>>()
  /** Ячейки следов, которые подключение видело при прошлом полном обходе, см. traces. */
  const swept = new Map<Send, ReadonlySet<number>>()
  /** Какой мир каждое подключение уже получило: по сущности — JSON каждого её компонента. */
  const sent = new Map<Send, View>()
  let sinceSweep = 0

  /**
   * Следы, которые подключение видит — они в обзоре его юнитов и зданий прямо сейчас, — а ещё не получало. Новые проверяются каждый тик, все — раз в SWEEP_TICKS:
   * так находятся старые следы там, куда игрок только что пришёл. Полный обход смотрит не все следы мира, а только
   * ячейки, где игрок видит хоть что-то сейчас или видел при прошлом обходе: в остальных ничего не поменялось.
   */
  const traces = (send: Send, player: number, sweep: boolean) => {
    const known = shown.get(send)!
    const found: Trace[] = []
    const check = (trace: Trace) => {
      const seen = sim.vision.sees(player, trace.x, trace.y)
      if (seen && !known.has(trace.id)) {
        found.push(trace)
        known.add(trace.id)
      } else if (!seen && known.has(trace.id)) {
        // Ушёл из обзора — клиент его выбросил, а вернётся в обзор — получит снова.
        known.delete(trace.id)
      }
    }
    // Колею, оставленную на глазах у игрока, клиент кладёт сам: он видит того же юнита, см. traces.ts.
    for (const trace of sim.traces.fresh()) if (trace.kind === 'track' && sim.vision.sees(player, trace.x, trace.y)) known.add(trace.id)
    if (!sweep) {
      for (const trace of sim.traces.fresh()) check(trace)
      return found
    }
    const cells = sim.vision.seenCells(player, TRACE_CELL)
    for (const cell of cells) for (const trace of sim.traces.inCell(cell)) check(trace)
    for (const cell of swept.get(send) ?? []) if (!cells.has(cell)) for (const trace of sim.traces.inCell(cell)) check(trace)
    swept.set(send, cells)
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
  /** Когда подключение писало в чат последний раз, в мс: чаще CHAT_GAP сообщения отбрасываются. */
  const lastChat = new Map<Send, number>()
  /** Рассылает сообщения чата всем подключённым. */
  const broadcast = (lines: ChatLine[]) => {
    const out = JSON.stringify({ type: 'chat', lines } satisfies ServerMessage)
    for (const peer of peers.keys()) peer(out)
  }
  /** Сообщение сервера о игроке: «<ник> text». */
  const notice = (about: number, text: string) => broadcast([{ player: about, name: names.get(about) ?? `Игрок ${about}`, text, system: true }])
  const online = (who: number) => [...peers.values()].includes(who)
  /** Подключения в режиме администратора. */
  const admins = new Set<Send>()
  /** Когда подключению снова можно пробовать пароль администратора, в мс. */
  const adminLocked = new Map<Send, number>()
  /** Как закрыть подключение: им администратор выгоняет игрока. */
  const closers = new Map<Send, () => void>()
  /** Ответ на команду только этому подключению. */
  const reply = (send: Send) => (text: string) => send(JSON.stringify({ type: 'chat', lines: [{ player: 0, name: '', text, system: true }] } satisfies ServerMessage))
  const nameOf = (who: number) => names.get(who) ?? `Игрок ${who}`
  /** Игрок по номеру или нику без учёта регистра; не нашёлся — undefined. */
  const findPlayer = (text: string | undefined) => {
    if (!text) return undefined
    const number = Number(text)
    if (Number.isInteger(number) && names.has(number)) return number
    const lower = text.toLowerCase()
    for (const [who, name] of names) if (name.toLowerCase() === lower) return who
    return undefined
  }
  const commands = new Map<string, HostCommand>()
  /** Команды, которые видит подключение: для дополнения у клиента. */
  const commandsFor = (admin: boolean): CommandInfo[] =>
    [...commands.values()]
      .filter((command) => !command.console && (admin || !command.admin))
      // Локальной игре пароль не нужен, и клиент не спросит его.
      .map(({ name, args, help, secret, choices }) => ({ name, args, help, ...(choices && { choices }), ...(secret && player === undefined && { secret }) }))
  const sendCommands = (send: Send) => send(JSON.stringify({ type: 'commands', commands: commandsFor(admins.has(send)), admin: admins.has(send) } satisfies ServerMessage))
  const serverSay = (text: string) => broadcast([{ player: 0, name: SERVER_NAME, text, system: true }])
  /** Подключение по его reply: команде из игры нужно знать, кто её прислал. */
  const callers = new WeakMap<Caller, Send>()
  const usage = (command: HostCommand) => `Как: /${[command.name, ...command.args].join(' ')}`
  const add = (command: HostCommand) => commands.set(command.name, command)

  add({
    name: 'help',
    args: [],
    help: 'список команд',
    run(_args, _rest, caller) {
      for (const command of commands.values()) {
        if (command.admin && !caller.admin) continue
        if (caller.player === undefined ? command.game : command.console) continue
        caller.reply(`/${[command.name, ...command.args].join(' ')} — ${command.help}`)
      }
    },
  })
  add({
    name: 'list',
    args: [],
    help: 'кто сейчас в игре',
    run(_args, _rest, caller) {
      const here = [...new Set(peers.values())].map(nameOf)
      caller.reply(here.length ? `В игре ${here.length}: ${here.join(', ')}` : 'В игре никого')
    },
  })
  add({
    name: 'me',
    args: ['<действие>'],
    help: 'написать о себе от третьего лица',
    game: true,
    run(_args, rest, caller) {
      const text = rest(0)
      if (text) broadcast([{ player: caller.player!, name: `* ${nameOf(caller.player!)}`, text, system: true }])
    },
  })
  add({
    name: 'msg',
    args: [PLAYER_ARG, '<текст>'],
    help: 'личное сообщение',
    game: true,
    run(args, rest, caller) {
      const to = findPlayer(args[0])
      const text = rest(1)
      if (to === undefined) return caller.reply(`Нет игрока «${args[0] ?? ''}»`)
      if (!text) return caller.reply(usage(this))
      const out = JSON.stringify({ type: 'chat', lines: [{ player: caller.player!, name: nameOf(caller.player!), text, whisper: nameOf(to) }] } satisfies ServerMessage)
      const self = callers.get(caller)
      for (const [peer, owner] of peers) if (owner === to || owner === caller.player || peer === self) peer(out)
      if (![...peers.values()].includes(to)) caller.reply(`${nameOf(to)} сейчас не в игре`)
    },
  })
  add({
    name: 'admin',
    args: [],
    help: 'режим администратора',
    secret: true,
    game: true,
    run(args, _rest, caller) {
      const send = callers.get(caller)!
      // В локальной игре мир свой, и пароль не нужен.
      const local = player !== undefined
      if (!local && !options.admin) return caller.reply('Режима администратора на этом сервере нет')
      if (admins.has(send)) return caller.reply('Вы уже администратор')
      const now = Date.now()
      if (now < (adminLocked.get(send) ?? 0)) return caller.reply('Подождите немного')
      if (!local && args.join(' ') !== options.admin) {
        adminLocked.set(send, now + ADMIN_LOCK)
        options.log?.(`! неверный пароль администратора от ${nameOf(caller.player!)}`)
        return caller.reply('Неверный пароль')
      }
      admins.add(send)
      sendCommands(send)
      options.log?.(`! ${nameOf(caller.player!)} — администратор`)
      caller.reply('Режим администратора включён: /help — что теперь можно')
    },
  })
  add({
    name: 'logout',
    args: [],
    help: 'выйти из режима администратора',
    admin: true,
    game: true,
    run(_args, _rest, caller) {
      const send = callers.get(caller)!
      admins.delete(send)
      sendCommands(send)
      caller.reply('Режим администратора выключен')
    },
  })
  add({
    name: 'say',
    args: ['<текст>'],
    help: 'написать всем от имени сервера',
    admin: true,
    run(_args, rest, caller) {
      const text = cleanChat(rest(0))
      if (!text) return caller.reply(usage(this))
      serverSay(text)
      options.log?.(`${SERVER_NAME} ${text}`)
    },
  })
  add({
    name: 'kick',
    args: [PLAYER_ARG],
    help: 'отключить игрока; его база остаётся',
    admin: true,
    run(args, _rest, caller) {
      const who = findPlayer(args.join(' '))
      if (who === undefined) return caller.reply(`Нет игрока «${args.join(' ')}»`)
      const out = JSON.stringify({ type: 'refused', reason: 'Вас отключил администратор' } satisfies ServerMessage)
      let count = 0
      for (const [peer, owner] of [...peers]) {
        if (owner !== who) continue
        peer(out)
        closers.get(peer)?.()
        count++
      }
      if (!count) return caller.reply(`${nameOf(who)} сейчас не в игре`)
      notice(who, 'отключён администратором')
      options.log?.(`! ${nameOf(who)} отключён`)
    },
  })
  add({
    name: 'credits',
    args: [PLAYER_ARG, '<сумма>'],
    help: 'поставить игроку кредиты; +N и -N — прибавить и убавить',
    admin: true,
    run(args, _rest, caller) {
      const who = findPlayer(args[0])
      const amount = Number(args[1])
      if (who === undefined) return caller.reply(`Нет игрока «${args[0] ?? ''}»`)
      if (!Number.isFinite(amount)) return caller.reply(usage(this))
      const relative = /^[+-]/.test(args[1])
      setCredits(sim, who, relative ? creditsOf(sim, who) + amount : amount)
      caller.reply(`У ${nameOf(who)} теперь ${creditsOf(sim, who)} кредитов`)
      options.log?.(`! кредиты ${nameOf(who)}: ${creditsOf(sim, who)}`)
    },
  })

  /**
   * Игрок, о котором команда: по нику или номеру, а без аргумента — тот, кто её позвал. Не нашёлся — ответ caller и
   * undefined.
   */
  const target = (arg: string | undefined, caller: Caller) => {
    const who = arg === undefined ? caller.player : findPlayer(arg)
    if (who === undefined) caller.reply(arg === undefined ? 'Укажите игрока' : `Нет игрока «${arg}»`)
    return who
  }
  /** Своё у игрока: юниты и здания, без турелей — они уходят вместе с носителем. */
  const ownedBy = (who: number) => {
    const units: Entity[] = []
    const buildings: Entity[] = []
    for (const [entity, owner] of sim.world.query(Owner)) {
      if (owner.player !== who || sim.world.has(entity, Attached)) continue
      if (sim.world.has(entity, Unit)) units.push(entity)
      else if (sim.world.has(entity, Building)) buildings.push(entity)
    }
    return { units, buildings }
  }
  /** Середина базы игрока: среднее его зданий, а без них — юнитов. */
  const baseOf = (who: number) => {
    const { units, buildings } = ownedBy(who)
    const points = (buildings.length ? buildings : units).map((entity) => sim.world.get(entity, Position)!)
    if (!points.length) return undefined
    return { x: Math.floor(points.reduce((sum, p) => sum + p.x, 0) / points.length), y: Math.floor(points.reduce((sum, p) => sum + p.y, 0) / points.length) }
  }

  add({
    name: 'players',
    args: [],
    help: 'все игроки мира: номер, в сети ли, кредиты, юниты и здания',
    admin: true,
    run(_args, _rest, caller) {
      const here = new Set(peers.values())
      for (const [who, name] of names) {
        const { units, buildings } = ownedBy(who)
        const state = isDefeated(sim, who) ? 'побеждён' : here.has(who) ? 'в сети' : 'не в сети'
        caller.reply(`#${who} ${name} — ${state}, ${creditsOf(sim, who)} кр., юнитов ${units.length}, зданий ${buildings.length}`)
      }
    },
  })
  add({
    name: 'spawn',
    args: ['<юнит>', '[кол-во]', `[${PLAYER_ARG.slice(1, -1)}]`],
    choices: [UNIT_TYPES, null, null],
    help: 'поставить юнитов у базы игрока (себе — без ника)',
    admin: true,
    run(args, _rest, caller) {
      const type = args[0] as UnitType
      if (!UNIT_TYPES.includes(type)) return caller.reply(`Юниты: ${UNIT_TYPES.join(', ')}`)
      const count = Math.min(SPAWN_MOST, Math.max(1, Math.floor(Number(args[1] ?? 1)) || 1))
      const who = target(args[2], caller)
      if (who === undefined) return
      const base = baseOf(who)
      if (!base) return caller.reply(`У ${nameOf(who)} нет базы: /reset ${who}`)
      const tiles = freeTilesNear(sim, base.x, base.y, count, 2, undefined, flies(type))
      let made = 0
      for (let i = 0; i + 1 < tiles.length; i += 2) if (putUnit(sim, type, tiles[i], tiles[i + 1], who)) made++
      caller.reply(`${nameOf(who)}: ${type} × ${made}`)
      options.log?.(`! spawn ${type} × ${made} → ${nameOf(who)}`)
    },
  })
  add({
    name: 'killunits',
    args: [`${PLAYER_ARG.slice(0, -1)}|all>`],
    help: 'убрать все юниты игрока или всех (all); здания остаются',
    admin: true,
    run(args, _rest, caller) {
      const all = args[0]?.toLowerCase() === 'all'
      const who = all ? undefined : target(args[0], caller)
      if (!all && who === undefined) return
      const units = all ? [...names.keys()].flatMap((each) => ownedBy(each).units) : ownedBy(who!).units
      for (const entity of units) erase(sim, entity)
      const count = units.length
      caller.reply(`Убрано юнитов: ${count}`)
      options.log?.(`! killunits ${all ? 'all' : nameOf(who!)}: ${count}`)
    },
  })
  add({
    name: 'heal',
    args: [PLAYER_ARG],
    help: 'вся техника и здания игрока целы',
    admin: true,
    run(args, _rest, caller) {
      const who = target(args[0], caller)
      if (who === undefined) return
      const { units, buildings } = ownedBy(who)
      for (const entity of [...units, ...buildings]) setHealth(sim, entity, 1)
      caller.reply(`${nameOf(who)}: починено ${units.length + buildings.length}`)
    },
  })
  add({
    name: 'reset',
    args: [PLAYER_ARG],
    help: 'снести всё у игрока и дать ему новый стартовый набор',
    admin: true,
    run(args, _rest, caller) {
      const who = target(args[0], caller)
      if (who === undefined) return
      restart(who)
      caller.reply(`${nameOf(who)} начинает заново`)
      options.log?.(`! reset ${nameOf(who)}`)
    },
  })
  add({
    name: 'reveal',
    args: [PLAYER_ARG],
    help: 'открыть игроку всю карту',
    admin: true,
    run(args, _rest, caller) {
      const who = target(args[0], caller)
      if (who === undefined) return
      // Один отрезок «разведано» длиннее любой карты: explore обрежет его по её краю.
      sim.vision.explore(who, [0, 2 ** 31])
      for (const [peer, owner] of peers) if (owner === who) peer(explored(who))
      caller.reply(`${nameOf(who)} видит всю карту`)
    },
  })

  const runCommand = (text: string, caller: Caller) => {
    const parsed = parseCommand(text.startsWith('/') ? text : `/${text}`)
    if (!parsed || !parsed.name) return
    const command = commands.get(parsed.name)
    const fromGame = caller.player !== undefined
    if (!command || (command.admin && !caller.admin) || (fromGame ? command.console : command.game)) {
      return caller.reply(`Нет команды /${parsed.name}: /help — список`)
    }
    command.run(parsed.args, parsed.rest, caller)
  }

  /** Игрок начинает заново: остатки базы исчезают, туман закрыт, новый стартовый набор в новом месте. */
  const restart = (who: number) => {
    wipePlayer(sim, who)
    defeated.delete(who)
    if (player === undefined) notice(who, 'начинает заново')
    sim.vision.forget(who)
    place(who)
    // Вкладки игрока начинают как в новом мире: туман закрыт, камера встаёт на новый стартовый набор.
    for (const [peer, owner] of peers) {
      if (owner !== who) continue
      peer(welcome(who))
      sendLand(peer, who)
      peer(explored(who))
      sent.set(peer, new Map())
      shown.set(peer, new Set())
      peer(delta(peer, who))
    }
  }

  /** Кто уже побеждён: о поражении сообщается один раз, когда оно случилось. */
  const defeated = new Set([...names.keys()].filter((who) => isDefeated(sim, who)))

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
    const { left, top, right, bottom } = sim.bounds
    const halfX = Math.max(0, (right - left) / 2 - SPAWN_MARGIN)
    const halfY = Math.max(0, (bottom - top) / 2 - SPAWN_MARGIN)
    for (let apart = SPAWN_APART; apart >= 8; apart /= 2) {
      for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
        const x = Math.floor((left + right) / 2 + (Math.random() * 2 - 1) * halfX)
        const y = Math.floor((top + bottom) / 2 + (Math.random() * 2 - 1) * halfY)
        if (terrainAt(sim.land, x, y) !== Terrain.Rock || !isWalkable(sim, x, y)) continue
        if (others.some((other) => Math.hypot(other.x - x, other.y - y) < apart)) continue
        let rock = 0
        for (let dy = -SPAWN_AREA; dy <= SPAWN_AREA; dy++) {
          for (let dx = -SPAWN_AREA; dx <= SPAWN_AREA; dx++) if (terrainAt(sim.land, x + dx, y + dy) === Terrain.Rock) rock++
        }
        // Обрывы не должны запирать базу: технике надо куда-то выехать.
        if (rock >= SPAWN_ROCK && notWalledIn(sim, x, y)) return { x, y }
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
    const { left, top, right, bottom } = sim.bounds
    const clamp = (value: number, from: number, to: number) => Math.max(from + 2, Math.min(to - 3, Math.round(value)))
    const spot = openSpawn(sim, clamp(Math.cos(angle) * radius, left, right), clamp(Math.sin(angle) * radius, top, bottom))
    spawnStartingUnits(sim, player, spot.x, spot.y)
    return player
  }

  /**
   * Сжатая карта мира, одна на всех: изменённые тайлы в ней исходные (см. pristineLand), а что из правок знает игрок,
   * он получает следом сообщением tiles. Сжимается заново, когда карта поменялась или мир начался заново.
   */
  let landCache: { sim: Sim; revision: number; frame: Promise<Uint8Array> } | null = null
  const landFrame = () => {
    if (landCache?.sim !== sim || landCache.revision !== sim.land.revision) {
      const frame = deflate(pristineLand(sim)).then((packed) => {
        const bytes = new Uint8Array(packed.length + 1)
        bytes[0] = LAND
        bytes.set(packed, 1)
        return bytes
      })
      landCache = { sim, revision: sim.land.revision, frame }
    }
    return landCache.frame
  }
  /**
   * Шлёт карту мира, если подключение ещё здесь, когда она сожмётся, и сразу — что игрок знает о правках. Правки
   * придут раньше карты, и клиент наложит их, когда она придёт.
   */
  const sendLand = (send: Send, player: number) => {
    void landFrame().then((frame) => {
      if (peers.has(send)) send(frame)
    })
    const edits = knownEdits(sim.landMemory, player)
    if (edits.length) send(JSON.stringify({ type: 'tiles', edits } satisfies ServerMessage))
    depositsShown.delete(send)
    sendDeposits(send, player)
  }
  /**
   * Месторождения, которые игрок знает: те, что на разведанной им земле. Остальные клиенту не шлются — иначе их видно
   * сквозь туман. cache — слой на игрока за один проход по подключениям.
   */
  const depositsMessage = (player: number) => {
    const { cells, spots } = saveDeposits(sim.deposits)
    const known: number[] = []
    for (let i = 0; i + 3 < spots.length; i += 4) {
      if (sim.vision.exploredIn(player, spots[i], spots[i + 1], DEPOSIT_SIZE, DEPOSIT_SIZE)) known.push(...spots.slice(i, i + 4))
    }
    return JSON.stringify({ type: 'deposits', deposits: { cells, spots: known } } satisfies ServerMessage)
  }
  /** Шлёт подключению слой месторождений, если игрок узнал новые или слой поменялся. */
  const sendDeposits = (send: Send, player: number, cache = new Map<number, string>()) => {
    let text = cache.get(player)
    if (text === undefined) cache.set(player, (text = depositsMessage(player)))
    if (depositsShown.get(send) === text) return
    depositsShown.set(send, text)
    send(text)
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
      fillDeposits(sim)
      depositsSent = sim.deposits.revision
      defeated.clear()
      for (const who of names.keys()) if (isDefeated(sim, who)) defeated.add(who)
      const cache = new Map<number, View>()
      for (const [send, player] of peers) {
        send(welcome(player))
        sendLand(send, player)
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
    command: runCommand,
    addCommand: add,
    say: serverSay,
    join(send, id, name, close) {
      if (close) closers.set(send, close)
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
      // О входе — только когда игрок появился: вторая вкладка того же игрока не в счёт. Локальной игре не нужно.
      if (player === undefined && !online(joined)) notice(joined, 'заходит в игру')
      peers.set(send, joined)
      shown.set(send, new Set())
      sent.set(send, new Map())
      send(welcome(joined, id))
      sendLand(send, joined)
      send(explored(joined))
      // Мир сразу, не дожидаясь тика: иначе клиент начал бы с пустого экрана.
      send(delta(send, joined))
      sendCommands(send)
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
          const { type, command, text: said } = message as { type?: unknown; command?: unknown; text?: unknown }
          if (type === 'chat') {
            const clean = typeof said === 'string' ? cleanChat(said) : ''
            const now = Date.now()
            if (!clean || now - (lastChat.get(send) ?? -Infinity) < CHAT_GAP) return
            lastChat.set(send, now)
            // Команда никому не уходит: пароль администратора не должен попасть в чат.
            if (clean.startsWith('/')) {
              const caller: Caller = { player: joined, admin: admins.has(send), reply: reply(send) }
              callers.set(caller, send)
              runCommand(clean, caller)
              return
            }
            const line: ChatLine = { player: joined, name: names.get(joined) ?? `Игрок ${joined}`, text: clean }
            broadcast([line])
            return
          }
          // Проигравший начинает заново: остатки его базы исчезают, а сам он получает новый стартовый набор.
          if (type === 'respawn') {
            if (isDefeated(sim, joined)) restart(joined)
            return
          }
          if (type !== 'command' || typeof command !== 'object' || command === null) return
          // Что внутри команды, проверит сама симуляция: она не доверяет и локальному клиенту.
          sim.send(joined, command as Command)
        },
        leave() {
          peers.delete(send)
          shown.delete(send)
          swept.delete(send)
          depositsShown.delete(send)
          lastChat.delete(send)
          admins.delete(send)
          adminLocked.delete(send)
          closers.delete(send)
          sent.delete(send)
          if (player === undefined && !online(joined)) notice(joined, 'выходит из игры')
          announce()
        },
      }
    },
    save() {
      return { sim: sim.save(), players: Object.fromEntries(players), names: Object.fromEntries(names) }
    },
    advance(seconds) {
      const ticks = sim.advance(seconds)
      // Правки карты — только тем, кто их увидел, см. landMemory.ts. Узнанное игроками без вкладок уже в их памяти.
      const learned = new Map<number, string>()
      for (const player of new Set(peers.values())) {
        const edits = takeLearned(sim.landMemory, player)
        if (edits.length) learned.set(player, JSON.stringify({ type: 'tiles', edits } satisfies ServerMessage))
      }
      sim.landMemory.learned.clear()
      // Месторождения поменялись — всем слой заново: он невелик, а меняется редко. Узнанные разведкой — при обходе ниже.
      if (sim.deposits.revision !== depositsSent) {
        depositsSent = sim.deposits.revision
        const cache = new Map<number, string>()
        for (const [send, player] of peers) sendDeposits(send, player, cache)
      }
      for (const [send, player] of peers) {
        const text = learned.get(player)
        if (text) send(text)
      }
      if (ticks && peers.size) {
        const cache = new Map<number, View>()
        stateSize = 0
        sinceSweep += ticks
        const sweep = sinceSweep >= SWEEP_TICKS
        if (sweep) sinceSweep = 0
        // Поражение — сообщение всем, один раз. Локальной игре не нужно: там игрок один.
        if (sweep && player === undefined) {
          for (const who of names.keys()) {
            if (defeated.has(who) || !isDefeated(sim, who)) continue
            defeated.add(who)
            notice(who, 'терпит поражение')
          }
        }
        const expired = sim.traces.expired()
        const deposits = new Map<number, string>()
        for (const [send, player] of peers) {
          const known = shown.get(send)!
          for (const id of expired) known.delete(id)
          if (sweep) sendDeposits(send, player, deposits)
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
