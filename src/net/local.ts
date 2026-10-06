import type { BattleConfig } from '../map/settings'
import { createSim, driveBattle, randomArmy, spawnBattle, spawnSandbox, spawnStartingUnits, type Sim, type SimOptions, type SimSave } from '../sim'
import { createHost, type Host, type Peer } from './host'

/**
 * Во что играют: обычная игра; показательный бой — две случайные армии сходятся снова и снова, каждый раз в новом
 * составе; тестовая карта — готовая база, чтобы сразу посмотреть, как всё работает. Бой и тестовая карта
 * сохранение игрока не читают и не пишут.
 */
export type GameMode = 'play' | 'battle' | 'sandbox'

/** В локальной игре игрок один: за него играют все вкладки. */
export const LOCAL_PLAYER = 1

/** Как часто локальная игра отдаёт вкладкам сохранение, в секундах. */
const SAVE_INTERVAL = 5
/** Как часто юнитам показательного боя раздаются цели и сколько после его конца ждать нового, в секундах. */
const BATTLE_ORDERS = 0.5
const BATTLE_PAUSE = 3

/** С чем вкладка начинает локальную игру. save — сохранение из её браузера, если есть. */
export interface LocalSetup {
  options: SimOptions
  mode: GameMode
  battle: BattleConfig
  save: SimSave | null
}

/**
 * Что вкладка шлёт воркеру локальной игры, кроме текста протокола (его — как серверу, строкой).
 * start — подключиться: первая вкладка заводит мир, остальные получают уже идущий; restart — начать мир заново;
 * leave — вкладку закрывают или она уходит в меню: обычной игре воркер
 * тогда шлёт последнее сохранение.
 */
export type LocalControl =
  | ({ type: 'start' } & LocalSetup)
  | { type: 'restart'; options: SimOptions; battle: BattleConfig }
  | { type: 'leave' }

/** Что воркер шлёт вкладке, кроме текста протокола: сохранение, чтобы она положила его в свой браузер. */
export type LocalNotice = { type: 'saved'; save: SimSave }

/** Канал до одной вкладки: MessagePort общего воркера или сам обычный воркер. */
export interface LocalPort {
  postMessage(data: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
}

/** Новый мир по режиму: стартовый набор у начала мира, две случайные армии или готовая база. */
export function createWorld(options: SimOptions, mode: GameMode, battle: BattleConfig): Sim {
  const sim = createSim(options)
  // Если месторождения рядом не нашлось, тестовая карта начинается как обычная игра.
  if (mode === 'sandbox' && spawnSandbox(sim, LOCAL_PLAYER)) return sim
  if (mode === 'battle') {
    const { budget, gap, mirror, ...weights } = battle
    const own = randomArmy(budget, weights)
    spawnBattle(sim, LOCAL_PLAYER, 0, 0, own, mirror ? own : randomArmy(budget, weights), gap)
  } else {
    spawnStartingUnits(sim, LOCAL_PLAYER, 0, 0)
  }
  return sim
}

export interface LocalServer {
  /** Подключает вкладку. */
  connect(port: LocalPort): void
  /** Продвигает игру на seconds реального времени. */
  advance(seconds: number): void
  /** Хост, когда первая вкладка уже завела мир. */
  readonly host: Host | null
}

/**
 * Локальная игра — тот же хост, что на сервере, только вкладки говорят с ним через postMessage. Живёт в общем
 * воркере: все вкладки одной игры видят один мир. Про браузер не знает, поэтому проверяется тестами как есть.
 */
export function createLocalServer(): LocalServer {
  let host: Host | null = null
  let setup: Omit<LocalSetup, 'save'> | null = null
  const ports = new Set<LocalPort>()
  let sinceSave = 0
  let sinceOrders = 0
  let battleOver = 0

  const restart = () => {
    if (!host || !setup) return
    host.replace(createWorld(setup.options, setup.mode, setup.battle))
    battleOver = 0
  }

  return {
    get host() {
      return host
    },
    connect(port) {
      let peer: Peer | null = null
      port.onmessage = ({ data }) => {
        if (typeof data === 'string') return peer?.receive(data)
        const control = data as LocalControl
        if (control.type === 'start' && !peer) {
          if (!host) {
            const { save, ...rest } = control
            setup = rest
            const resumed = save && rest.mode === 'play' ? createSim({ ...save, rules: rest.options.rules }) : null
            host = createHost(resumed ?? createWorld(rest.options, rest.mode, rest.battle), LOCAL_PLAYER)
          }
          ports.add(port)
          peer = host.join((text) => port.postMessage(text))
        } else if (control.type === 'restart' && setup) {
          setup = { ...setup, options: control.options, battle: control.battle }
          restart()
        } else if (control.type === 'leave') {
          // Уходящая вкладка уносит мир как есть: в меню список сохранений покажет его свежим.
          if (peer && host && setup?.mode === 'play') port.postMessage({ type: 'saved', save: host.sim.save() } satisfies LocalNotice)
          peer?.leave()
          peer = null
          ports.delete(port)
        }
      }
    },
    advance(seconds) {
      // Без вкладок мир стоит: в него никто не играет, а воркер может жить, пока открыта страница.
      if (!host || !setup || !ports.size) return
      if (setup.mode === 'battle') {
        sinceOrders += seconds
        if (battleOver) {
          battleOver += seconds
          if (battleOver > BATTLE_PAUSE) restart()
        } else if (sinceOrders >= BATTLE_ORDERS) {
          sinceOrders = 0
          if (!driveBattle(host.sim, LOCAL_PLAYER)) battleOver = seconds
        }
      }
      host.advance(seconds)
      sinceSave += seconds
      if (setup.mode === 'play' && sinceSave >= SAVE_INTERVAL && ports.size) {
        sinceSave = 0
        const notice: LocalNotice = { type: 'saved', save: host.sim.save() }
        for (const port of ports) port.postMessage(notice)
      }
    },
  }
}
