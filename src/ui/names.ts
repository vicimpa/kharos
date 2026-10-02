import type { BuildingType, Reward, UnitType } from '../sim'

/** Названия для интерфейса. Симуляция знает только ключи. */
export const UNIT_NAMES: Record<UnitType, string> = {
  mcv: 'MCV',
  builder: 'Строитель',
  infantry: 'Пехотинец',
  truck: 'Грузовик',
}

export const BUILDING_NAMES: Record<BuildingType, string> = {
  command: 'Главное здание',
  refinery: 'Переработка',
  factory: 'Завод',
  generator: 'Электростанция',
  matter: 'Генератор материи',
  radar: 'Радар',
  windtrap: 'Ветряная ловушка',
  barracks: 'Казармы',
  mine: 'Шахта',
  silo: 'Хранилище',
  spaceport: 'Космопорт',
  turret: 'Турель',
}

/** За что выдана награда. */
export const REWARD_NAMES: Record<Reward, string> = {
  deploy: 'Главное здание развёрнуто',
  unit: 'Первый юнит произведён',
  generator: 'Первая электростанция',
  matter: 'Первый генератор материи',
  mine: 'Первая шахта',
  silo: 'Первое хранилище',
}
