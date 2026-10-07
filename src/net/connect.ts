import type { BattleConfig } from '../map/settings'
import type { SimOptions, SimSave } from '../sim'
import type { LocalControl, LocalNotice, LocalSetup } from './local'
import { PROTOCOL_VERSION, decodeServer } from './protocol'
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
  }
}

const IDS_KEY = 'kharos.ids'
const PASSWORDS_KEY = 'kharos.passwords'

/** Что запомнено по адресу сервера: у каждого сервера своё. */
function loadByUrl(key: string): Record<string, string> {
  try {
    const items = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    return typeof items === 'object' && items !== null ? (items as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Запоминает значение для сервера url; undefined — забывает. */
function storeByUrl(key: string, url: string, value: string | undefined) {
  try {
    const items = loadByUrl(key)
    if (value === undefined) delete items[url]
    else items[url] = value
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Без хранилища после перезагрузки сервер выдаст нового игрока, а пароль придётся ввести снова.
  }
}

/** Сервер не пустил без пароля или с неверным: wrong — пароль был, но не подошёл. */
export class PasswordRequired extends Error {
  constructor(
    message: string,
    readonly wrong: boolean,
  ) {
    super(message)
  }
}

/** Страница открыта по https, а сервер — по незащищённому ws://: браузер такое соединение блокирует. */
export const isInsecure = (url: string) => location.protocol === 'https:' && /^ws:\/\//i.test(url.trim())

/** Что сказать, если до незащищённого сервера не достучаться со страницы по https. */
export const INSECURE_HINT =
  'Страница открыта по https, а сервер — по незащищённому ws://, и браузер блокирует такое соединение. ' +
  'Разрешите его: значок слева от адреса → «Настройки сайтов» → «Небезопасный контент» → «Разрешить», затем перезагрузите вкладку. ' +
  'Либо подключайтесь к серверу по wss://.'

/** Пароль, с которым на сервер url уже пускали. */
export const savedPassword = (url: string) => loadByUrl(PASSWORDS_KEY)[url] ?? ''

/**
 * Подключается к серверу по WebSocket и ждёт приветствия. С сервером, где уже играл, — с прежним id, и сервер
 * отдаёт прежнего игрока; id из приветствия запоминается. name — ник. password — пароль сервера; пустой — тот, с
 * которым сюда уже пускали. Пароль, с которым пустили, запоминается, не подошедший — забывается.
 * lag — отладка: искусственная задержка в миллисекундах в каждую сторону, чтобы почувствовать плохую сеть.
 */
export function connect(url: string, lag = 0, name = '', password = ''): Promise<Session> {
  return new Promise((resolve, reject) => {
    const address = new URL(url)
    const id = loadByUrl(IDS_KEY)[url]
    if (id) address.searchParams.set('id', id)
    if (name) address.searchParams.set('name', name)
    password ||= savedPassword(url)
    if (password) address.searchParams.set('password', password)
    address.searchParams.set('version', String(PROTOCOL_VERSION))
    let refused: string | undefined
    const socket = new WebSocket(address)
    // Изменения мира приходят двоичными, см. codec.ts.
    socket.binaryType = 'arraybuffer'
    const delayed = (action: () => void) => (lag > 0 ? void setTimeout(action, lag) : action())
    let sim: Replica | undefined

    socket.onmessage = (event) => {
      delayed(() => {
        const message = decodeServer(event.data as string | ArrayBuffer)
        if (message.type === 'refused') {
          refused = message.password ? `${message.reason}: переподключитесь и введите пароль` : message.reason
          if (message.password) storeByUrl(PASSWORDS_KEY, url, undefined)
          if (sim) sim.fail(refused)
          else reject(message.password ? new PasswordRequired(message.reason, Boolean(password)) : new Error(refused))
          return
        }
        if (sim) return sim.receive(message)
        if (message.type !== 'welcome') return
        if (message.id) storeByUrl(IDS_KEY, url, message.id)
        if (password) storeByUrl(PASSWORDS_KEY, url, password)
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
      else reject(new Error(`Не удалось подключиться к серверу ${url}${isInsecure(url) ? `\n\n${INSECURE_HINT}` : ''}`))
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
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) return onSave((data as LocalNotice).save)
      const message = decodeServer(data)
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
        },
      })
    }
    // Закрытую вкладку воркер должен забыть: иначе слал бы мир в никуда.
    window.addEventListener('pagehide', leave)
    control({ type: 'start', ...setup })
  })
}
