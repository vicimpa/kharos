import { simOptions } from '../game/game'
import { listSaves, loadSave, storeSave, type SaveSlot } from '../game/storage'
import type { MapSettings } from '../map/settings'
import { connect, connectLocal, type Session } from '../net/connect'
import { DEFAULT_PORT } from '../net/protocol'

/**
 * Во что играть: локальная игра в слоте сохранений, показательный бой или тестовая карта (они сохранение не
 * трогают) либо игра на сервере. lag — отладка: задержка в миллисекундах в каждую сторону.
 */
export type Launch =
  | { kind: 'save'; slot: SaveSlot }
  | { kind: 'battle' | 'sandbox' }
  | { kind: 'server'; url: string; lag: number; name?: string; password?: string }
  /** Редактор сохранения: слота или файла (например, мира сервера), см. EditorView. */
  | { kind: 'editor'; slot: SaveSlot }
  | { kind: 'editor'; file: Uint8Array; name: string }

/** Игра, а не редактор. */
export type PlayLaunch = Exclude<Launch, { kind: 'editor' }>

/** Адрес сервера на этой же машине. */
export const localServerUrl = () => `ws://${location.hostname}:${DEFAULT_PORT}`

/**
 * Игра, заданная адресной строкой, — тогда меню пропускается: ?server=ws://host:port (просто ?server — сервер на
 * этой машине, ?lag=100 — задержка), ?battle — показательный бой, ?sandbox — тестовая карта.
 */
export function launchFromAddress(): Launch | null {
  const query = new URLSearchParams(location.search)
  const server = query.get('server')
  if (server !== null) return { kind: 'server', url: server || localServerUrl(), lag: Number(query.get('lag')) || 0 }
  if (query.has('battle')) return { kind: 'battle' }
  if (query.has('sandbox')) return { kind: 'sandbox' }
  return null
}

const CURRENT_KEY = 'kharos.current'

/**
 * Запоминает, во что играет вкладка (null — она в меню), чтобы перезагрузка вернула в ту же игру. Хранится на время
 * жизни вкладки: новая вкладка открывает меню.
 */
export function rememberLaunch(launch: Launch | null) {
  try {
    // Файл в редакторе живёт только в памяти: после перезагрузки его открывают заново.
    if (!launch || (launch.kind === 'editor' && !('slot' in launch))) sessionStorage.removeItem(CURRENT_KEY)
    else if (launch.kind === 'editor') sessionStorage.setItem(CURRENT_KEY, JSON.stringify({ kind: 'editor', slot: launch.slot.id }))
    // Пароль не хранится и здесь: с ним сервер уже пустил, и connect() помнит его сам.
    else sessionStorage.setItem(CURRENT_KEY, JSON.stringify(launch.kind === 'save' ? { kind: 'save', slot: launch.slot.id } : { ...launch, password: undefined }))
  } catch {
    // Без хранилища перезагрузка просто откроет меню.
  }
}

const LAST_KEY = 'kharos.last'
const SERVERS_KEY = 'kharos.servers'
/** Сколько недавних серверов помнится. */
const RECENT_SERVERS = 8

/** Сервер, на котором уже играли: адрес, с каким ником и когда последний раз, мс от эпохи. */
export interface RecentServer {
  url: string
  name: string
  played: number
}

/** Недавние серверы, свежие первыми. */
export function recentServers(): RecentServer[] {
  try {
    const list = JSON.parse(localStorage.getItem(SERVERS_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((item): item is RecentServer => typeof item?.url === 'string') : []
  } catch {
    return []
  }
}

/** Убирает сервер из недавних. */
export function forgetServer(url: string) {
  storeServers(recentServers().filter((server) => server.url !== url))
}

function storeServers(list: RecentServer[]) {
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(list.slice(0, RECENT_SERVERS)))
  } catch {
    // Список просто не запомнится.
  }
}

/**
 * Во что играли последним: сохранение или сервер. Его открывает «Продолжить»; бой и тестовая карта не в счёт.
 * Сервер к тому же встаёт первым в недавние.
 */
export function rememberLast(launch: Launch) {
  if (launch.kind !== 'save' && launch.kind !== 'server') return
  if (launch.kind === 'server') {
    const { url, name = '' } = launch
    storeServers([{ url, name, played: Date.now() }, ...recentServers().filter((server) => server.url !== url)])
  }
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(launch.kind === 'save' ? { kind: 'save', slot: launch.slot.id } : launch))
  } catch {
    // «Продолжить» откроет самое свежее сохранение.
  }
}

/** Последняя игра для «Продолжить»: сервер или слот, взятый свежим из списка; иначе — самое свежее сохранение. */
export function lastLaunch(): Launch | null {
  try {
    const last = parseLaunch(localStorage.getItem(LAST_KEY))
    if (last) return last
  } catch {
    // Тогда — самое свежее сохранение.
  }
  const slot = listSaves()[0]
  return slot ? { kind: 'save', slot } : null
}

/** Игра из сохранённого текста: слот — по id из нынешнего списка, удалённый — null. */
function parseLaunch(text: string | null): Launch | null {
  const saved = JSON.parse(text ?? 'null') as (Omit<Launch, 'slot'> & { slot?: string }) | null
  if (!saved) return null
  if (saved.kind !== 'save' && saved.kind !== 'editor') return saved as Launch
  const slot = listSaves().find((other) => other.id === saved.slot)
  return slot ? ({ kind: saved.kind, slot } as Launch) : null
}

/** Игра, в которой вкладка была до перезагрузки; слот берётся свежим из списка, удалённый — забыт. */
export function recallLaunch(): Launch | null {
  try {
    return parseLaunch(sessionStorage.getItem(CURRENT_KEY))
  } catch {
    return null
  }
}

/**
 * Подключается к игре. Локальную считает воркер: у каждого слота свой общий воркер, и вкладки, открывшие один
 * слот, играют в один мир. Новый слот ещё пуст — его мир заводится по зерну и размеру слота.
 */
export async function startSession(launch: PlayLaunch, settings: MapSettings, signal?: AbortSignal): Promise<Session> {
  if (launch.kind === 'server') return connect(launch.url, launch.lag, launch.name, launch.password, signal)
  const options = simOptions(settings)
  if (launch.kind !== 'save') return connectLocal({ options, mode: launch.kind, battle: settings.battle, save: null }, () => {}, `kharos-${launch.kind}`)
  const { slot } = launch
  return connectLocal(
    {
      options: { ...options, generator: { ...options.generator, ...slot.generator, seed: slot.seed }, size: slot.size, weather: slot.weather },
      mode: 'play',
      battle: settings.battle,
      save: await loadSave(slot.id),
    },
    (save) => void storeSave(slot.id, save),
    `kharos-play-${slot.id}`,
  )
}
