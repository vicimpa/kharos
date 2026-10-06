import type { WorldSnapshot } from '../ecs'
import type { Command, SimOptions } from '../sim'
import type { Trace } from '../sim/traces'

/** Порт сервера по умолчанию. */
export const DEFAULT_PORT = 8787

/** Что сервер шлёт клиенту. */
export type ServerMessage =
  /** Первое сообщение: за кого клиент играет и из чего собрать местность. step — длина тика в секундах. */
  | { type: 'welcome'; player: number; options: SimOptions; step: number }
  /** Мир после тика tick. Пока это снимок целиком; позже — только видимая область и только изменения. */
  | { type: 'state'; tick: number; world: WorldSnapshot }
  /** Сразу после приветствия: что игрок разведал раньше, см. Vision.map. Открытая карта остаётся открытой. */
  | { type: 'explored'; map: number[] }
  /** Следы, которые игрок только что увидел: каждый приходит один раз, дальше клиент держит его сам до конца срока. */
  | { type: 'traces'; traces: Trace[] }

/** Что клиент шлёт серверу. */
export type ClientMessage = { type: 'command'; command: Command }
