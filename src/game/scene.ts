import type { Alerts } from './alerts'
import type { Entity } from '../ecs'
import type { MapSettings } from '../map/settings'
import type { BuildingType, DepositKind, PaveKind, Sim, Weather } from '../sim'
import type { Camera } from './camera'

/** Прямоугольник в тайлах, заданный двумя противоположными углами. */
export interface Box {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/** Рамка выделения, которую тянут: углы и кого она выберет, если отпустить сейчас. */
export interface SelectionBox extends Box {
  hits: Entity[]
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
  /** Уведомления игрока; у витрины их нет. */
  alerts?: Alerts
  camera: Camera
  /** Настройки мира: генератор, размер, отрисовка. */
  settings: MapSettings
  /** Выбранные юниты. Это состояние клиента: симуляция о выделении не знает. */
  selection: Set<Entity>
  /** Рамка выделения, пока игрок тянет её мышью. */
  selectionBox: SelectionBox | null
  /** Здание, для которого игрок сейчас выбирает место; null — обычный режим. */
  placing: BuildingType | null
  /** Покрытие, которое игрок сейчас кладёт мышью, или снятие покрытия; null — обычный режим. */
  paving: PaveTool | null
  /** Остановки маршрута, который игрок сейчас набирает щелчками по зданиям для выбранных грузовиков; null — не набирает. */
  routing: Entity[] | null
  /** Здания, которые игрок сейчас отмечает щелчками, чтобы выбранные грузовики их обслуживали; null — не отмечает. */
  serving: Entity[] | null
  /** Игрок выбирает точку патруля выбранным бойцам: щелчок — патруль до неё, Shift+щелчок — ещё точка к патрулю. */
  patrolling: boolean
  /** Откуда игрок тянет укладку покрытия: тайл, где зажал кнопку; null — ещё не зажал. */
  paveFrom: { x: number; y: number } | null
  /** Показывать ли сетку тайлов. */
  grid: boolean
  /** Пометки редактора рамками: выбранные месторождения, кисть карты. В отличие от рамки выделения, камеру у края не двигают. */
  marks?: Box[]
  /** Призрак месторождения под указателем в редакторе: какое встанет по щелчку; blocked — встать ему там нельзя. */
  depositGhost?: { x: number; y: number; kind: DepositKind; blocked: boolean } | null
  /** Редактор сохранений: левая кнопка — его инструмент, а не выделение и приказы. Нет — обычная игра. */
  edit?: SceneEdit
  /** Погода в этом кадре: её считает симуляция по времени мира, игра обновляет каждый кадр. */
  weather: Weather
}

/** Инструмент редактора на холсте: нажатие, протяжка и отпускание левой кнопки, указатель — каждый кадр. Точки — в тайлах. */
export interface SceneEdit {
  press(point: { x: number; y: number }, phase: 'down' | 'drag' | 'up', shift: boolean): void
  /** Щелчок правой кнопкой без протяжки. */
  secondary(point: { x: number; y: number }): void
  hover(tile: { x: number; y: number } | null): void
}

/** Чем работает игрок на покрытии: кладёт фундамент или дорогу, или снимает своё. */
/** Инструмент протяжки: покрытие, его снятие или наземная труба. */
export type PaveTool = PaveKind | 'remove' | 'pipe'

