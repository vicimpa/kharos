import type { BuildingType, UnitType } from '../sim'

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
