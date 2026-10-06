import type { WorldSnapshot } from '../ecs'
import type { Command, SimOptions } from '../sim'

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

/** Что клиент шлёт серверу. */
export type ClientMessage = { type: 'command'; command: Command }
