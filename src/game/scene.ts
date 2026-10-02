import type { MapSettings } from '../map/settings'
import type { Sim } from '../sim'
import type { Camera } from './camera'

/**
 * Состояние клиента, общее для проходов отрисовки и управления.
 * Сама игра живёт в sim; клиент её только читает, а меняет — командами через sim.send().
 */
export interface Scene {
  /** Симуляция. Заменяется целиком, когда мир начинается заново, — не сохраняй ссылку, читай каждый кадр. */
  sim: Sim
  camera: Camera
  /** Настройки отладочной панели. Читаются каждый кадр, поэтому их смена видна сразу. */
  settings: MapSettings
  /** Показывать ли сетку тайлов. */
  grid: boolean
}
