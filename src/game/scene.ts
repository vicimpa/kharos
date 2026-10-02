import type { World } from '../ecs'
import type { MapSettings } from '../map/settings'
import type { Land } from '../map/terrain'
import type { Occupancy } from './buildings/buildings'
import type { Camera } from './camera'

/**
 * Состояние игры, общее для систем, проходов отрисовки и управления.
 * Сущности живут в world; здесь — то, что существует в одном экземпляре.
 */
export interface Scene {
  world: World
  /** Местность. Заменяется целиком при смене параметров генератора. */
  land: Land
  camera: Camera
  /** Настройки отладочной панели. Читаются каждый кадр, поэтому их смена видна сразу. */
  settings: MapSettings
  /** Какие тайлы заняты зданиями. */
  occupancy: Occupancy
  /** Показывать ли сетку тайлов. */
  grid: boolean
}
