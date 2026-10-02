import type { Entity } from '../ecs'
import type { MapSettings } from '../map/settings'
import type { Sim } from '../sim'
import type { Camera } from './camera'

/** Прямоугольник в тайлах, заданный двумя противоположными углами. */
export interface Box {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/**
 * Состояние клиента, общее для проходов отрисовки и управления.
 * Сама игра живёт в sim; клиент её только читает, а меняет — командами через sim.send().
 */
export interface Scene {
  /** Симуляция. Заменяется целиком, когда мир начинается заново, — не сохраняй ссылку, читай каждый кадр. */
  sim: Sim
  /** Номер игрока, за которого играет этот клиент. */
  player: number
  camera: Camera
  /** Настройки отладочной панели. Читаются каждый кадр, поэтому их смена видна сразу. */
  settings: MapSettings
  /** Выбранные юниты. Это состояние клиента: симуляция о выделении не знает. */
  selection: Set<Entity>
  /** Рамка выделения, пока игрок тянет её мышью. */
  selectionBox: Box | null
  /** Показывать ли сетку тайлов. */
  grid: boolean
}
