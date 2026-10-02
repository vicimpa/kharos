import { component } from '../ecs'
import type { BuildingType } from './buildings'
import type { UnitType } from './units'

/** Место на карте в тайлах. У здания — левый верхний тайл основания, у юнита — его центр. */
export const Position = component('Position', { x: 0, y: 0 })

/** Здание. phase — сдвиг анимации в кадрах, чтобы одинаковые здания не мигали в такт. */
export const Building = component('Building', { type: 'command' as BuildingType, phase: 0 })

/** Чьё это. Игрок 0 — ничей: такими сущностями никто не командует. */
export const Owner = component('Owner', { player: 0 })

/**
 * Юнит. prevX, prevY — где он был тик назад: клиент рисует его между прошлым и нынешним местом.
 * facing — куда смотрит, в радианах: 0 — вправо, растёт по часовой стрелке.
 */
export const Unit = component('Unit', { type: 'infantry' as UnitType, prevX: 0, prevY: 0, facing: Math.PI / 2 })

/**
 * Путь, по которому юнит идёт; компонент есть, только пока он в пути.
 * points — оставшиеся точки в тайлах, x, y подряд. goalX, goalY — тайл, куда он шёл изначально.
 * blocked — путь упёрся в препятствие и уже прокладывался заново.
 */
export const Path = component('Path', () => ({ points: [] as number[], goalX: 0, goalY: 0, blocked: false }))

/** Компоненты, которые попадают в сохранение и в сеть. Новый компонент симуляции добавляй сюда. */
export const SAVED = [Position, Building, Owner, Unit, Path]
