import { component } from '../ecs'
import type { BuildingType } from './buildings/buildingArt'

/** Место на карте в тайлах. У здания — левый верхний тайл основания. */
export const Position = component('Position', { x: 0, y: 0 })

/** Здание. phase — сдвиг анимации в кадрах, чтобы одинаковые здания не мигали в такт. */
export const Building = component('Building', { type: 'command' as BuildingType, phase: 0 })
