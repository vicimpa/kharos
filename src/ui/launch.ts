import { simOptions } from '../game/game'
import { loadSave, storeSave, type SaveSlot } from '../game/storage'
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
  | { kind: 'server'; url: string; lag: number }

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

/**
 * Подключается к игре. Локальную считает воркер: у каждого слота свой общий воркер, и вкладки, открывшие один
 * слот, играют в один мир. Новый слот ещё пуст — его мир заводится по зерну и размеру слота.
 */
export function startSession(launch: Launch, settings: MapSettings): Promise<Session> {
  if (launch.kind === 'server') return connect(launch.url, launch.lag)
  const options = simOptions(settings)
  if (launch.kind !== 'save') return connectLocal({ options, mode: launch.kind, battle: settings.battle, save: null }, () => {}, `kharos-${launch.kind}`)
  const { slot } = launch
  return connectLocal(
    {
      options: { ...options, generator: { ...options.generator, seed: slot.seed }, size: slot.size },
      mode: 'play',
      battle: settings.battle,
      save: loadSave(slot.id),
    },
    (save) => storeSave(slot.id, save),
    `kharos-play-${slot.id}`,
  )
}
