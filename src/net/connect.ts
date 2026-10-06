import type { BattleConfig } from '../map/settings'
import type { Rules, SimOptions, SimSave } from '../sim'
import type { LocalControl, LocalNotice, LocalSetup } from './local'
import { PROTOCOL_VERSION, type ServerMessage } from './protocol'
import { createReplica, type Replica } from './replica'

/**
 * Игра на хосте: копия его симуляции и номер игрока, которого хост выдал этому клиенту. local — управление
 * локальной игрой; у сервера его нет: мир там один на всех, и начать его заново клиент не может.
 */
export interface Session {
  sim: Replica
  player: number
  local?: {
    restart(options: SimOptions, battle: BattleConfig): void
    rules(rules: Rules): void
  }
}

const IDS_KEY = 'kharos.ids'

/** id, которые выдали серверы, по адресу сервера: у каждого сервера свой. */
function loadIds(): Record<string, string> {
  try {
    const ids = JSON.parse(localStorage.getItem(IDS_KEY) ?? '{}') as unknown
    return typeof ids === 'object' && ids !== null ? (ids as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Запоминает id, под которым сервер url знает этот браузер: с ним клиент вернётся за своего игрока. */
function storeId(url: string, id: string) {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify({ ...loadIds(), [url]: id }))
  } catch {
    // Без хранилища после перезагрузки сервер выдаст нового игрока.
  }
}

/**
 * Подключается к серверу по WebSocket и ждёт приветствия. С сервером, где уже играл, — с прежним id, и сервер
 * отдаёт прежнего игрока; id из приветствия запоминается. name — ник.
 * lag — отладка: искусственная задержка в миллисекундах в каждую сторону, чтобы почувствовать плохую сеть.
 */
export function connect(url: string, lag = 0, name = ''): Promise<Session> {
  return new Promise((resolve, reject) => {
    const address = new URL(url)
    const id = loadIds()[url]
    if (id) address.searchParams.set('id', id)
    if (name) address.searchParams.set('name', name)
    address.searchParams.set('version', String(PROTOCOL_VERSION))
    let refused: string | undefined
    const socket = new WebSocket(address)
    const delayed = (action: () => void) => (lag > 0 ? void setTimeout(action, lag) : action())
    let sim: Replica | undefined

    socket.onmessage = (event) => {
      delayed(() => {
        const message = JSON.parse(event.data as string) as ServerMessage
        if (message.type === 'refused') {
          refused = message.reason
          if (sim) sim.fail(message.reason)
          else reject(new Error(message.reason))
          return
        }
        if (sim) return sim.receive(message)
        if (message.type !== 'welcome') return
        if (message.id) storeId(url, message.id)
        sim = createReplica(
          message,
          (text) => delayed(() => socket.readyState === WebSocket.OPEN && socket.send(text)),
          () => socket.close(),
        )
        resolve({ sim, player: message.player })
      })
    }
    socket.onclose = () => {
      if (refused) return
      if (sim) sim.fail('Соединение с сервером потеряно')
      else reject(new Error(`Не удалось подключиться к серверу ${url}`))
    }
  })
}

/**
 * Подключается к локальной игре в воркере и ждёт приветствия. Воркер общий, если браузер их умеет: тогда все
 * вкладки с одним name играют в один мир. onSave получает сохранения, которые воркер присылает сам, — в том числе
 * последнее, когда вкладка уходит из игры.
 */
export function connectLocal(setup: LocalSetup, onSave: (save: SimSave) => void, name: string): Promise<Session> {
  return new Promise((resolve) => {
    let port: MessagePort | Worker
    if (typeof SharedWorker !== 'undefined') {
      port = new SharedWorker(new URL('./local.worker.ts', import.meta.url), { type: 'module', name }).port
    } else {
      port = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module', name })
    }
    const control = (message: LocalControl) => port.postMessage(message)
    const leave = () => control({ type: 'leave' })
    let sim: Replica | undefined

    port.onmessage = ({ data }: MessageEvent) => {
      if (typeof data !== 'string') return onSave((data as LocalNotice).save)
      const message = JSON.parse(data) as ServerMessage
      if (sim) return sim.receive(message)
      if (message.type !== 'welcome') return
      sim = createReplica(message, (text) => port.postMessage(text), () => {
        leave()
        window.removeEventListener('pagehide', leave)
      })
      resolve({
        sim,
        player: message.player,
        local: {
          restart: (options, battle) => control({ type: 'restart', options, battle }),
          rules: (rules) => control({ type: 'rules', rules }),
        },
      })
    }
    // Закрытую вкладку воркер должен забыть: иначе слал бы мир в никуда.
    window.addEventListener('pagehide', leave)
    control({ type: 'start', ...setup })
  })
}
