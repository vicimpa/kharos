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
 * facing — куда смотрит, в радианах от -π до π: 0 — вправо, растёт по часовой стрелке. prevFacing — куда смотрел тик назад.
 */
export const Unit = component('Unit', {
  type: 'infantry' as UnitType,
  prevX: 0,
  prevY: 0,
  facing: Math.PI / 2,
  prevFacing: Math.PI / 2,
})

/**
 * Путь, по которому юнит идёт; компонент есть, только пока он в пути.
 * points — оставшиеся точки в тайлах, x, y подряд. goalX, goalY — тайл, куда он шёл изначально.
 * wait — сколько тиков подряд юнит не может сдвинуться; tries — сколько раз путь к этой точке уже прокладывался заново.
 */
export const Path = component('Path', () => ({ points: [] as number[], goalX: 0, goalY: 0, wait: 0, tries: 0 }))

/** Игрок: сущность без места на карте. Отслеживается, чтобы интерфейс узнавал о смене счёта. */
export const Player = component('Player', { id: 0, credits: 0 }, { tracked: true })

/**
 * Производство юнитов: есть у MCV и у главного здания.
 * queue — очередь заказов, первый строится сейчас; progress — сколько тиков он уже строится.
 */
export const Producer = component('Producer', () => ({ queue: [] as UnitType[], progress: 0 }))

/**
 * Превращение: MCV разворачивается в главное здание или здание сворачивается обратно.
 * Компонент есть, только пока оно идёт. left — сколько тиков осталось, total — сколько было всего.
 */
export const Converting = component('Converting', { left: 0, total: 0 })

/** Компоненты, которые попадают в сохранение и в сеть. Новый компонент симуляции добавляй сюда. */
export const SAVED = [Position, Building, Owner, Unit, Path, Player, Producer, Converting]
