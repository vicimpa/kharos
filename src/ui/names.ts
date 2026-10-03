import type { BuildingType, Resource, Reward, UnitType } from '../sim'

/** Названия для интерфейса. Симуляция знает только ключи. */
export const UNIT_NAMES: Record<UnitType, string> = {
  mcv: 'MCV',
  builder: 'Строитель',
  infantry: 'Пехотинец',
  truck: 'Грузовик',
  rocketeer: 'Ракетчик',
  buggy: 'Багги',
  lancer: 'Лазерная машина',
  tank: 'Танк',
  tesla: 'Разрядник',
  drone: 'Дрон',
  gunship: 'Штурмовик',
  carrier: 'Носитель',
}

export const BUILDING_NAMES: Record<BuildingType, string> = {
  command: 'Главное здание',
  refinery: 'Нефтезавод',
  smelter: 'Плавильня',
  kiln: 'Кремниевый завод',
  assembly: 'Сборочный цех',
  factory: 'Машинный завод',
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

export const RESOURCE_NAMES: Record<Resource, string> = {
  ore: 'Руда',
  silica: 'Кремнезём',
  oil: 'Нефть',
  kharite: 'Харит',
  water: 'Вода',
  metal: 'Металл',
  silicon: 'Кремний',
  fuel: 'Топливо',
  components: 'Компоненты',
}
