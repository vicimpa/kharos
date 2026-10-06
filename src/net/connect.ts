import type { BattleConfig } from '../map/settings'
import type { Rules, SimOptions, SimSave } from '../sim'
import type { LocalControl, LocalNotice, LocalSetup } from './local'
import type { ServerMessage } from './protocol'
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

const TOKEN_KEY = 'kharos.token'

/** Случайная строка, по которой сервер узнаёт этот браузер после перезагрузки страницы. */
function token() {
  try {
    let value = localStorage.getItem(TOKEN_KEY)
    if (!value) localStorage.setItem(TOKEN_KEY, (value = crypto.randomUUID()))
    return value
  } catch {
    return crypto.randomUUID()
  }
}

/**
 * Подключается к серверу по WebSocket и ждёт приветствия.
 * lag — отладка: искусственная задержка в миллисекундах в каждую сторону, чтобы почувствовать плохую сеть.
 */
export function connect(url: string, lag = 0): Promise<Session> {
  return new Promise((resolve, reject) => {
    const address = new URL(url)
    address.searchParams.set('token', token())
    const socket = new WebSocket(address)
    const delayed = (action: () => void) => (lag > 0 ? void setTimeout(action, lag) : action())
    let sim: Replica | undefined

    socket.onmessage = (event) => {
      delayed(() => {
        const message = JSON.parse(event.data as string) as ServerMessage
        if (sim) return sim.receive(message)
        if (message.type !== 'welcome') return
        sim = createReplica(
          message,
          (text) => delayed(() => socket.readyState === WebSocket.OPEN && socket.send(text)),
          () => socket.close(),
        )
        resolve({ sim, player: message.player })
      })
    }
    socket.onclose = () => {
      if (sim) sim.fail('Соединение с сервером потеряно')
      else reject(new Error(`Не удалось подключиться к серверу ${url}`))
    }
  })
}

/**
 * Подключается к локальной игре в воркере и ждёт приветствия. Воркер общий, если браузер их умеет: тогда все
 * вкладки с одним name играют в один мир. shared: false — свой воркер только для этой вкладки: его мир никто
 * больше не видит, и с концом игры воркер останавливается. onSave получает сохранения, которые воркер присылает
 * сам, — в том числе последнее, когда вкладка уходит из игры.
 */
export function connectLocal(setup: LocalSetup, onSave: (save: SimSave) => void, name: string, shared = true): Promise<Session> {
  return new Promise((resolve) => {
    let port: MessagePort | Worker
    let worker: Worker | null = null
    if (shared && typeof SharedWorker !== 'undefined') {
      port = new SharedWorker(new URL('./local.worker.ts', import.meta.url), { type: 'module', name }).port
    } else {
      port = worker = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module', name })
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
        // Свой воркер больше никому не нужен; общий живёт, пока его держит хоть одна вкладка.
        worker?.terminate()
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
