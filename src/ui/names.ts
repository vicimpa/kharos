import { isOre, isProduct, type BuildingType, type Good, type Ore, type Product, type Resource, type Reward, type UnitType } from '../sim'

/** Названия для интерфейса. Симуляция знает только ключи. */
export const UNIT_NAMES: Record<UnitType, string> = {
  mcv: 'MCV',
  builder: 'Строитель',
  infantry: 'Пехотинец',
  truck: 'Грузовик',
  harvester: 'Харвестер',
  rocketeer: 'Ракетчик',
  buggy: 'Багги',
  lancer: 'Лазерная машина',
  tank: 'Танк',
  artillery: 'Артиллерия',
  tesla: 'Разрядник',
  drone: 'Дрон',
  gunship: 'Штурмовик',
  bomber: 'Бомбардировщик',
  carrier: 'Носитель',
}

export const BUILDING_NAMES: Record<BuildingType, string> = {
  command: 'Главное здание',
  smelter: 'Плавильня',
  siliconWorks: 'Кремниевый завод',
  distillery: 'Нефтеперегонка',
  enricher: 'Обогатитель харита',
  blockPlant: 'Завод стройблоков',
  ammoPlant: 'Патронный завод',
  partsPlant: 'Сборка компонентов',
  factory: 'Машинный завод',
  techCenter: 'Техцентр',
  generator: 'Электростанция',
  matter: 'Генератор материи',
  radar: 'Радар',
  windtrap: 'Ветряная ловушка',
  barracks: 'Казармы',
  mine: 'Шахта',
  metalYard: 'Склад металла',
  siliconStore: 'Склад кремния',
  fuelTank: 'Топливные баки',
  khariteVault: 'Сейф харита',
  blockYard: 'Склад стройблоков',
  ammoBunker: 'Бункер боеприпасов',
  partsLocker: 'Шкаф компонентов',
  spaceport: 'Космопорт',
  airfield: 'Аэродром',
  wall: 'Стена',
  turret: 'Пулемётная турель',
  rocketTurret: 'Ракетная турель',
  cannonTurret: 'Пушечная турель',
}

/** За что выдана награда. */
export const REWARD_NAMES: Record<Reward, string> = {
  deploy: 'Главное здание развёрнуто',
  unit: 'Первый юнит произведён',
  generator: 'Первая электростанция',
  matter: 'Первый генератор материи',
  mine: 'Первая шахта',
  metalYard: 'Первый склад металла',
}

export const RESOURCE_NAMES: Record<Resource, string> = {
  metal: 'Металл',
  silicon: 'Кремний',
  fuel: 'Топливо',
  kharite: 'Харит',
}

/** Руда называется по тому, что из неё выходит на переработке; исключение — нефть. */
export const ORE_NAMES: Record<Ore, string> = {
  metalOre: 'Металлическая руда',
  siliconOre: 'Кремниевая руда',
  fuelOre: 'Нефть',
  khariteOre: 'Харитовая руда',
}

/** Изделия сборочного цеха. */
export const PRODUCT_NAMES: Record<Product, string> = {
  blocks: 'Стройблоки',
  ammo: 'Боеприпасы',
  parts: 'Компоненты',
}

/** Название любого груза: ресурса, изделия или руды. */
export const goodName = (good: Good) => (isOre(good) ? ORE_NAMES[good] : isProduct(good) ? PRODUCT_NAMES[good] : RESOURCE_NAMES[good])
