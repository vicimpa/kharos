import { component } from '../ecs'
import type { BuildingType } from './buildings'

/** Место на карте в тайлах. У здания — левый верхний тайл основания. */
export const Position = component('Position', { x: 0, y: 0 })

/** Здание. phase — сдвиг анимации в кадрах, чтобы одинаковые здания не мигали в такт. */
export const Building = component('Building', { type: 'command' as BuildingType, phase: 0 })

/** Компоненты, которые попадают в сохранение и в сеть. Новый компонент симуляции добавляй сюда. */
export const SAVED = [Position, Building]
