import type { ServerMessage } from './protocol'
import { createReplica, type Replica } from './replica'

/** Игра на сервере: копия его симуляции и номер игрока, которого сервер выдал этому клиенту. */
export interface Session {
  sim: Replica
  player: number
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
