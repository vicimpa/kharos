import type { Command, SimOptions } from '../sim'
import type { EditOp } from '../sim/editOps'
import type { DepositsSave } from '../sim/deposits'
import type { Trace } from '../sim/traces'
import type { CommandInfo } from './chatCommands'
import { LAND, decodeDelta } from './codec'

/**
 * Версия сетевой игры. Клиент и сервер играют вместе, только если она у них одна: копия мира у клиента собирается
 * из тех же компонентов и правил, что у сервера. Поднимай её при каждом изменении протокола, компонентов из SAVED
 * или симуляции, которое меняет то, что видит клиент.
 */
export const PROTOCOL_VERSION = 15

/** Почему сервер не пустил клиента другой версии: текст для игрока. */
export function versionMismatch(server: number, client: number) {
  const fix = client < server ? 'обновите страницу' : 'сервер старее клиента, его нужно обновить'
  return `Версии не совпадают: у сервера ${server}, у вас ${client} — ${fix}`
}

/** Порт сервера по умолчанию. */
export const DEFAULT_PORT = 8787

/** Что сервер шлёт клиенту. */
export type ServerMessage =
  /**
   * Первое сообщение: за кого клиент играет и из чего собрать местность. step — длина тика в секундах. id — под каким
   * именем этот сервер помнит игрока: клиент хранит его и подключается с ним снова; у локальной игры его нет.
   * editor — игрок в редакторе: мир приходит весь, без тумана, и клиент показывает панель редактора. keep — тот же
   * мир заново (вход в редактор и выход из него): камера остаётся, где была.
   */
  | { type: 'welcome'; player: number; options: SimOptions; step: number; id?: string; editor?: true; keep?: true }
  /** Кто играет на хосте: ники и кто сейчас подключён. Приходит после приветствия и при каждом изменении. */
  | { type: 'players'; players: PlayerInfo[] }
  /**
   * Сервер не пускает клиента — например, другой версии, см. PROTOCOL_VERSION, — и закрывает соединение. password —
   * дело в пароле: его нет или он не тот.
   */
  | { type: 'refused'; reason: string; password?: boolean }
  /**
   * Мир после тика tick — только то, что поменялось с прошлого сообщения в том, что игрок видит. set — новые сущности
   * целиком и поменявшиеся компоненты остальных, unset — снятые компоненты, remove — сущности, которых игрок больше
   * не видит или которых не стало. Первое после приветствия приносит весь видимый мир. motion — места и повороты:
   * номер сущности, x, y и поворот подряд (поворота нет — NaN); они идут не в set, а отдельно и двоично, см. codec.ts.
   */
  | { type: 'delta'; tick: number; set: [number, Record<string, object>][]; unset: [number, string[]][]; remove: number[]; motion: number[] }
  /** Сразу после приветствия: что игрок разведал раньше, см. Vision.map. Открытая карта остаётся открытой. */
  | { type: 'explored'; map: number[] }
  /** Следы, которые игрок только что увидел: каждый приходит один раз, дальше клиент держит его сам до конца срока. */
  | { type: 'traces'; traces: Trace[] }
  /**
   * Карта мира, сжатая (см. saveLand и src/save/file.ts): двоичный кадр LAND после приветствия. До неё клиент рисует
   * местность по генератору из приветствия.
   */
  | { type: 'land'; data: Uint8Array }
  /** Правки карты, см. takeEdits: x, y и четыре байта тайла подряд. */
  | { type: 'tiles'; edits: number[] }
  /** Месторождения: слой целиком, см. DepositLayer. Шлётся при входе и когда слой поменялся. */
  | { type: 'deposits'; deposits: DepositsSave }
  /** Новые сообщения чата. Хост их не хранит: вошедший позже прошлых не увидит. */
  | { type: 'chat'; lines: ChatLine[] }
  /**
   * Команды чата, которые клиенту можно, — для дополнения, см. chatCommands.ts. Приходит при входе и когда игрок
   * входит в режим администратора или выходит из него; admin — он сейчас администратор.
   */
  | { type: 'commands'; commands: CommandInfo[]; admin: boolean }
  /** Только редактору: где сейчас камеры игроков, см. PlayerView. Приходит, когда они сдвинулись. */
  | { type: 'views'; views: PlayerView[] }

/** Сообщение чата: кто написал и что. */
export interface ChatLine {
  player: number
  name: string
  text: string
  /** Сообщение самого сервера: кто зашёл, вышел, проиграл. name у него — о ком оно; пустой name — ответ на команду. */
  system?: true
  /** Личное сообщение, /msg: ник того, кому оно. Приходит только ему и автору. */
  whisper?: string
}

/** Видимая часть карты у вкладки игрока, в тайлах. */
export interface ViewBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** Камера вкладки игрока, какой её видит редактор. */
export interface PlayerView extends ViewBox {
  player: number
  name: string
}

/** Самое длинное сообщение чата; длиннее обрезается. */
export const CHAT_LENGTH = 200

/** Сообщение чата, каким его примет хост: без управляющих символов и лишних пробелов, не длиннее CHAT_LENGTH. */
export const cleanChat = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_LENGTH)

/** Игрок хоста, каким его видят все: номер, ник и подключён ли он сейчас. */
export interface PlayerInfo {
  player: number
  name: string
  online: boolean
}

/** Самый длинный ник; длиннее обрезается. */
export const NAME_LENGTH = 24

/** Ник, каким его примет хост: без управляющих символов и лишних пробелов, не длиннее NAME_LENGTH. */
export const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LENGTH)

/** Сообщение сервера как оно идёт по проводу: изменения мира — двоичные, остальное — текст JSON. */
export type ServerData = string | Uint8Array

/** Разбирает сообщение сервера: текст или двоичный кадр изменений мира. */
export function decodeServer(data: ServerData | ArrayBuffer): ServerMessage {
  if (typeof data === 'string') return JSON.parse(data) as ServerMessage
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes[0] === LAND) return { type: 'land', data: bytes.subarray(1) }
  return { type: 'delta', ...decodeDelta(bytes) }
}

/** Что клиент шлёт серверу. */
export type ClientMessage =
  | { type: 'command'; command: Command }
  /** Проигравший начинает заново: хост убирает его остатки и ставит новый стартовый набор в новом месте. */
  | { type: 'respawn' }
  /** Сообщение в чат: хост разошлёт его всем с ником автора. */
  | { type: 'chat'; text: string }
  /** Где камера вкладки: шлётся, когда она сдвинулась; хост показывает камеры редактору. */
  | ({ type: 'view' } & ViewBox)
  /** Правка редактора от администратора в редакторе, см. EditOp и /editor. */
  | { type: 'edit'; edit: EditOp }
