import type { WorldSnapshot } from '../ecs'
import type { Command, SimOptions } from '../sim'
import type { Trace } from '../sim/traces'

/**
 * Версия сетевой игры. Клиент и сервер играют вместе, только если она у них одна: копия мира у клиента собирается
 * из тех же компонентов и правил, что у сервера. Поднимай её при каждом изменении протокола, компонентов из SAVED
 * или симуляции, которое меняет то, что видит клиент.
 */
export const PROTOCOL_VERSION = 1

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
   */
  | { type: 'welcome'; player: number; options: SimOptions; step: number; id?: string }
  /** Кто играет на хосте: ники и кто сейчас подключён. Приходит после приветствия и при каждом изменении. */
  | { type: 'players'; players: PlayerInfo[] }
  /** Сервер не пускает клиента — например, другой версии, см. PROTOCOL_VERSION — и закрывает соединение. */
  | { type: 'refused'; reason: string }
  /** Мир после тика tick. Пока это снимок целиком; позже — только видимая область и только изменения. */
  | { type: 'state'; tick: number; world: WorldSnapshot }
  /** Сразу после приветствия: что игрок разведал раньше, см. Vision.map. Открытая карта остаётся открытой. */
  | { type: 'explored'; map: number[] }
  /** Следы, которые игрок только что увидел: каждый приходит один раз, дальше клиент держит его сам до конца срока. */
  | { type: 'traces'; traces: Trace[] }

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

/** Что клиент шлёт серверу. */
export type ClientMessage = { type: 'command'; command: Command }
