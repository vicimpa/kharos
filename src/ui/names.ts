import type { BuildingType, Reward, UnitType } from '../sim'

/** Названия для интерфейса. Симуляция знает только ключи. */
export const UNIT_NAMES: Record<UnitType, string> = {
  mcv: 'MCV',
  builder: 'Строитель',
  infantry: 'Пехотинец',
}

export const BUILDING_NAMES: Record<BuildingType, string> = {
  command: 'Главное здание',
  refinery: 'Переработка',
  factory: 'Завод',
  generator: 'Генератор',
  starport: 'Космопорт',
  radar: 'Радар',
  windtrap: 'Ветряная ловушка',
  barracks: 'Казармы',
  silo: 'Хранилище',
  turret: 'Турель',
}

/** За что выдана награда. */
export const REWARD_NAMES: Record<Reward, string> = {
  deploy: 'Главное здание развёрнуто',
  unit: 'Первый юнит произведён',
  generator: 'Первый генератор',
  starport: 'Первый космопорт',
  silo: 'Первое хранилище',
}
