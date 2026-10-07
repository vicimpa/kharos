import type { Entity, World } from '../ecs'
import { Terrain, isBuildable, terrainAt, tileKey } from '../map/terrain'
import { isOwn } from './common'
import { Assembly, Building, Health, Inventory, Repair, Owner, Position, Producer, Site } from './components'
import { equipStorage, put, type BeamSpec } from './inventory'
import { ORE_SPECS, PRODUCT_SPECS, WARES, stockedFor, type Amounts, type Good, type Ore, type Product } from './resources'
import type { Sim } from './sim'
import { mountTurrets, type MountSpec } from './turrets'
import { isPaved } from './paved'
import type { UnitType } from './units'

/** Что симуляция знает о виде здания. Как оно выглядит, знает клиент: см. game/buildings/buildingArt.ts. */
export interface BuildingSpec {
  /** Сколько тайлов здание занимает на земле. */
  width: number
  height: number
  /** Цена в кредитах. Из неё же считается время стройки: см. BUILD_RATE. */
  cost: number
  /**
   * Радиус собственной зоны строительства в тайлах от центра здания. Такое здание начинает зону само,
   * и ставить его можно вне своих зон; остальные здания только расширяют зону, в которой стоят.
   */
  zone?: number
  /** На сколько тайлов расширяет зону готовое здание; без поля — общий EXPAND_RADIUS, 0 — не расширяет. */
  expand?: number
  /** Оборонительную постройку можно ставить на песок, где она получает только SAND_DURABILITY прочности. */
  defense?: boolean
  /** Абсолютная прочность; без поля считается из цены здания, см. buildingHp в combat.ts. */
  hp?: number
  /** Турели на здании: каждая — отдельная прикреплённая сущность, см. turrets.ts. */
  mounts?: MountSpec[]
  /** Сколько тайлов от центра видит готовое здание; без поля — на BUILDING_SIGHT от края. См. vision.ts. */
  sight?: number
  /** Энергия: больше нуля — вырабатывает, меньше — потребляет. */
  power?: number
  /**
   * Добывает из месторождения под собой в свой склад, пока там есть место. Что и как быстро — решает
   * месторождение, см. DEPOSIT_KINDS. Ставится только на месторождение.
   */
  extract?: boolean
  /** Материалы на стройку вдобавок к кредитам: их привозят на площадку грузовики из хранилищ зоны. */
  materials?: Amounts
  /** Склад: сколько груза помещается в здании. См. inventory.ts. */
  inventory?: number
  /** Какой груз принимает склад здания: без поля — любой. Хранилищам кладут готовое, переработке — руду. */
  accepts?: readonly Good[]
  /** Предел по каждому виду груза вдобавок к общему объёму склада: см. roomFor. */
  limits?: Amounts
  /** Склад здания — хранилище: в него свозят готовое, из него берут на нужды зоны и на продажу. */
  stores?: boolean
  /**
   * Перерабатывает эту руду из своего склада в её ресурс со скоростью REFINE_RATE. Принимает руду от шахт
   * и харвестеров, а готовое отдаёт по общим заявкам. На каждую руду — своё здание. См. refining.ts.
   */
  refines?: Ore
  /**
   * Завод изделия: собирает его из ресурсов своего склада по рецепту. Новый завод стоит выключенным, пока игрок
   * его не включит. Сырьё заказывает у своей зоны, готовое отдаёт по заявкам и вывозит в хранилища. См. assembly.ts.
   */
  assembles?: Product
  /**
   * Турели здания стреляют боеприпасами с его склада: каждый выстрел тратит WeaponSpec.ammo, пустой склад —
   * турель молчит. Склад здание заказывает у зоны само. Достроенное здание заряжено полностью.
   */
  ammo?: boolean
  /** Транспортный луч: им здание отдаёт ресурсы со своего склада или забирает на него. См. inventory.ts. */
  beam?: BeamSpec
  /** Через это здание продают ресурсы: грузовики свозят их сюда из хранилищ его зоны, см. trade.ts. */
  trades?: boolean
  /** Каких юнитов здание производит, когда достроено. Потребитель энергии при её нехватке производит медленнее. */
  produces?: UnitType[]
  /** Доход в кредитах в секунду. У потребителя энергии он падает вместе с её нехваткой. */
  income?: number
  /**
   * Таким зданиям тесно в одной зоне: каждое следующее просит на одну норму энергии больше предыдущего.
   * Поэтому отдача от них падает, и ставить их без счёта невыгодно.
   */
  crowding?: boolean
  /** Готовое здание строит и чинит всё своё в этом радиусе, в тайлах от своего центра до края цели. */
  repair?: number
}

/** Сколько ресурсов помещается в производящем юнитов здании: материалы на очередной заказ. */
const PRODUCER_HOLD = 100

/**
 * Склад переработки поделён на два места: под руду и под готовое, по REFINERY_HOLD каждое. Общий склад вёл себя
 * непредсказуемо — накопленное готовое отнимало место у руды, и харвестер не мог разгрузиться. Руды помещается
 * полный кузов харвестера, а значит и грузовика.
 */
const REFINERY_HOLD = 30
/** Сколько готового изделия держит цех, пока его не развезут: своё место, сырью оно не мешает. */
const PLANT_OUTPUT = 30

/**
 * Сколько боеприпасов держит оборонительная турель: 35–45 секунд непрерывного огня (см. WeaponSpec.ammo).
 * Хватает отбить налёт, но долгую осаду турель держит, только пока к ней подвозят патроны.
 */
const TURRET_AMMO = 120
const TURRET_STORE = { inventory: TURRET_AMMO, accepts: ['ammo'] as const, ammo: true }

/**
 * Переработка одной руды: принимает только её и складывает её ресурс. Размер, цена и энергия — по руде:
 * металл нужен больше всего, и плавильня дешёвая, но громоздкая; харит редок и дорог, и обогатитель компактный,
 * но дорогой и прожорливый.
 */
function refinery(ore: Ore, width: number, height: number, cost: number, power: number) {
  return {
    width, height, cost, power, inventory: REFINERY_HOLD * 2, refines: ore,
    accepts: [ore, ORE_SPECS[ore].resource], limits: { [ore]: REFINERY_HOLD, [ORE_SPECS[ore].resource]: REFINERY_HOLD },
  } as const satisfies BuildingSpec
}

/** Завод одного изделия: принимает сырьё его рецепта и складывает готовое — у каждого груза своё место. */
function plant(product: Product) {
  const limits: Amounts = { ...stockedFor(product), [product]: PLANT_OUTPUT }
  return {
    width: 2, height: 2, cost: 300, power: -3, inventory: Object.values(limits).reduce((sum, amount) => sum + amount!, 0), assembles: product,
    accepts: [...Object.keys(PRODUCT_SPECS[product].recipe), product] as Good[], limits,
  } as const satisfies BuildingSpec
}

/**
 * Хранилище одного груза: принимает только его. Склада «всего» нет — под каждый ресурс и каждое изделие
 * своё здание со своим размером и ценой: металла нужно больше всего, и двор под него просторный и дешёвый;
 * харит редок и дорог, его сейф маленький и дорогой.
 */
function store(accepts: readonly Good[], width: number, height: number, cost: number, inventory: number) {
  return { width, height, cost, inventory, accepts, stores: true } as const satisfies BuildingSpec
}

/** Сколько кредитов цены здания один строитель возводит за секунду: здание за 300 строится 15 секунд. */
export const BUILD_RATE = 20

/** Доля обычной прочности у оборонительной постройки на песке. */
export const SAND_DURABILITY = 0.7

export const BUILDINGS = {
  // Доход главного здания не даёт остаться без кредитов совсем: на генератор он копит долго, но копит.
  // Своего склада у главного здания нет: всё готовое лежит в хранилищах своего вида.
  // Пушка на крыше держит всю зону главного здания: одиночкам и разведке к нему не подойти.
  command: { width: 3, height: 3, cost: 2000, income: 0.2, zone: 12, sight: 12, produces: ['builder', 'truck', 'harvester'], mounts: [{ turret: 'core', along: 0, across: 0 }] },
  // Переработка — по зданию на руду: каждое принимает только свою руду и выдаёт её ресурс, один передел
  // (§4.3 шаг 5). Приём 1,5 руды/с — примерно полторы шахты металла: где поставить завод между шахтами
  // и хранилищем, решает игрок. Руду держит про запас на кузов, готовое отдаёт по общим заявкам.
  smelter: refinery('metalOre', 3, 3, 300, -3),
  siliconWorks: refinery('siliconOre', 3, 2, 400, -4),
  distillery: refinery('fuelOre', 2, 3, 400, -5),
  enricher: refinery('khariteOre', 2, 2, 650, -7),
  // Заводы изделий: каждый собирает своё изделие из ресурсов (§3.7 design.md). Склад общий на сырьё и готовое.
  blockPlant: plant('blocks'),
  ammoPlant: plant('ammo'),
  partsPlant: plant('parts'),
  // Машинный завод: машинки и тяжёлая техника. Строится из стройблоков: военная промышленность требует цеха.
  factory: { width: 3, height: 3, cost: 450, power: -5, materials: { blocks: 10 }, produces: ['buggy', 'flak', 'lancer', 'tank', 'artillery', 'tesla', 'carrier', 'mcv'] },
  // Техцентр открывает второй тир: тяжёлую технику, артиллерию и бомбардировщик. Строится из стройблоков:
  // до него игрок должен наладить цех.
  techCenter: { width: 3, height: 3, cost: 1000, power: -6, materials: { blocks: 15 }, sight: 8 },
  // Аэродром выпускает летающих: им нужно топливо, бомбардировщику ещё и техцентр.
  airfield: { width: 4, height: 3, cost: 500, power: -4, materials: { metal: 15, blocks: 5 }, produces: ['drone', 'gunship', 'bomber'] },
  // Электростанция.
  generator: { width: 2, height: 2, cost: 300, power: 10 },
  // Генератор материи — базовый доход: превращает энергию в кредиты. Первая электростанция окупает его быстро,
  // дальше теснота делает каждый следующий всё дороже. Он страховка на случай, когда линий добычи нет (§4.3 шаг 3):
  // одной электростанции хватает на два генератора.
  matter: { width: 2, height: 2, cost: 250, power: -3, income: 1.5, crowding: true },
  // Радар открывает туман далеко вокруг: так видно, кто идёт к базе, и куда бить артиллерией.
  radar: { width: 2, height: 2, cost: 400, power: -3, sight: 24 },
  windtrap: { width: 2, height: 2, cost: 300 },
  barracks: { width: 3, height: 2, cost: 250, power: -2, produces: ['infantry', 'rocketeer', 'flamer'] },
  // Шахта энергии не просит и начинает свою зону: тянуть к месторождению цепочку зданий не нужно.
  // Добытое копится в шахте, пока его не выкачают грузовики.
  mine: { width: 2, height: 2, cost: 300, zone: 7, extract: true, inventory: 60 },
  // Хранилища: по одному на каждый ресурс и каждое изделие. Стройблоки громоздкие; боеприпасов делают много,
  // и бункер под них вместительный; компоненты дорогие и мелкие.
  metalYard: store(['metal'], 3, 2, 150, 400),
  siliconStore: store(['silicon'], 2, 2, 150, 300),
  fuelTank: store(['fuel'], 2, 2, 200, 300),
  khariteVault: store(['kharite'], 1, 1, 250, 60),
  blockYard: store(['blocks'], 2, 2, 150, 200),
  ammoBunker: store(['ammo'], 2, 1, 200, 300),
  partsLocker: store(['parts'], 1, 1, 200, 60),
  // Космопорт торгует: энергию просит всегда.
  // Товар на продажу грузовики сгружают в трюм корабля. Строится из металла, а не из стройблоков: с него
  // начинаются деньги, и первой продаже хватает одной линии металла — без цеха и кремния.
  spaceport: { width: 3, height: 3, cost: 450, power: -5, materials: { metal: 20 }, trades: true, inventory: 400, accepts: WARES },
  // Дешёвая стена не расширяет зону: иначе цепочкой стен можно было бы бесплатно протянуть контроль через карту.
  wall: { width: 1, height: 1, cost: 30, hp: 400, defense: true, expand: 0 },
  // Оборонительные турели используют то же оружие, что техника, и стреляют боеприпасами со своего склада.
  // На песке все оборонительные постройки слабее.
  turret: { width: 1, height: 1, cost: 250, hp: 450, defense: true, ...TURRET_STORE, mounts: [{ turret: 'gunner', along: 0, across: 0 }] },
  rocketTurret: { width: 1, height: 1, cost: 300, hp: 400, defense: true, ...TURRET_STORE, mounts: [{ turret: 'rocket', along: 0, across: 0 }] },
  cannonTurret: { width: 1, height: 1, cost: 450, hp: 500, defense: true, ...TURRET_STORE, mounts: [{ turret: 'cannon', along: 0, across: 0 }] },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
/** Описание вида здания со всеми необязательными полями. */
export const buildingSpec = (type: BuildingType): BuildingSpec => BUILDINGS[type]
/** Главное здание — Settlement Core: в него разворачивается MCV. */
export const CORE: BuildingType = 'command'
export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[]
/** Что возводят строители. Остальные здания появятся вместе с тем, для чего они нужны. */
export const BUILDABLE: BuildingType[] = [
  'generator', 'matter', 'mine', 'smelter', 'siliconWorks', 'distillery', 'enricher', 'blockPlant', 'ammoPlant', 'partsPlant',
  'metalYard', 'siliconStore', 'fuelTank', 'khariteVault', 'blockYard', 'ammoBunker', 'partsLocker', 'spaceport', 'barracks', 'factory', 'airfield', 'techCenter',
  'radar', 'wall', 'turret', 'rocketTurret', 'cannonTurret',
]

/** Хранилища — по одному на каждое готовое. */
export const STORES = BUILDING_TYPES.filter((type) => buildingSpec(type).stores)
/** Хранилище, которое принимает этот груз; у руды его нет. */
export const storeFor = (good: Good) => STORES.find((type) => buildingSpec(type).accepts?.includes(good))

/** Какие тайлы заняты зданиями. Обновляется сам: следит за появлением и исчезновением зданий в мире. */
export interface Occupancy {
  /** Здание, занимающее тайл, или undefined. */
  at(x: number, y: number): Entity | undefined
  destroy(): void
}

export function createOccupancy(world: World): Occupancy {
  const tiles = new Map<number, Entity>()
  const stop = world.observe([Position, Building], (entity, position, building) => {
    const { width, height } = BUILDINGS[building.type]
    const keys: number[] = []
    for (let y = position.y; y < position.y + height; y++) {
      for (let x = position.x; x < position.x + width; x++) keys.push(tileKey(x, y))
    }
    for (const key of keys) tiles.set(key, entity)
    return () => {
      for (const key of keys) if (tiles.get(key) === entity) tiles.delete(key)
    }
  })
  return {
    at: (x, y) => (tiles.size ? tiles.get(tileKey(x, y)) : undefined),
    destroy: stop,
  }
}

/** Готовое здание игрока: не площадка, не недострой и не под разбором. */
export const isReady = (sim: Sim, player: number, building: Entity) =>
  sim.world.has(building, Building) && !sim.world.has(building, Site) && isOwn(sim, player, building)

/** Стена ли это здание: только стены укрывают от выстрелов. См. wallOnPath в combat.ts. */
export const isWall = (sim: Sim, entity: Entity) => sim.world.get(entity, Building)?.type === 'wall'

/** Площадка, основание которой накрывает тайл (x, y), или undefined. Площадок мало, поэтому простой перебор. */
export function siteAt(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position, site] of sim.world.query(Position, Site)) {
    const { width, height } = BUILDINGS[site.type]
    if (x >= position.x && x < position.x + width && y >= position.y && y < position.y + height) return entity
  }
  return undefined
}

/**
 * Можно ли поставить здание левым верхним углом основания в тайл (x, y): основное здание целиком на скале
 * или фундаменте, оборонительное — ещё и на песке; внутри границ карты и без других зданий и площадок.
 * gap — зазор до соседних зданий в тайлах.
 */
export function canPlace(sim: Sim, type: BuildingType, x: number, y: number, gap = 0) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  const spec: BuildingSpec = BUILDINGS[type]
  const { width, height } = spec
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) return false
  const accepts = spec.defense ? (terrain: Terrain) => terrain === Terrain.Sand || isBuildable(terrain) : isBuildable
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      // Готовый фундамент делает песок пригодным для любого здания.
      if (!accepts(terrainAt(sim.land, tileX, tileY)) && !isPaved(sim, 'foundation', tileX, tileY)) return false
    }
  }
  for (let tileY = y - gap; tileY < y + height + gap; tileY++) {
    for (let tileX = x - gap; tileX < x + width + gap; tileX++) {
      if (sim.occupancy.at(tileX, tileY) !== undefined) return false
    }
  }
  // Площадка, которую ещё не начали строить, тайлов не занимает, но место за ней уже закреплено.
  for (const [, position, site] of sim.world.query(Position, Site)) {
    const other = BUILDINGS[site.type]
    if (x - gap < position.x + other.width && x + width + gap > position.x) {
      if (y - gap < position.y + other.height && y + height + gap > position.y) return false
    }
  }
  return true
}

/**
 * Максимальная доля прочности здания на этом месте. Оборона на песке без фундамента получает 70%; на скале и у обычных
 * зданий предел равен единице. Для многотайловой обороны достаточно одного песчаного тайла под основанием.
 */
export function durabilityOf(sim: Sim, type: BuildingType, x: number, y: number) {
  const spec: BuildingSpec = BUILDINGS[type]
  if (!spec.defense) return 1
  for (let tileY = y; tileY < y + spec.height; tileY++) {
    for (let tileX = x; tileX < x + spec.width; tileX++) {
      if (terrainAt(sim.land, tileX, tileY) === Terrain.Sand && !isPaved(sim, 'foundation', tileX, tileY)) return SAND_DURABILITY
    }
  }
  return 1
}

/** Заготовка компонента нового здания: сдвиг анимации у каждого свой. */
export const newBuilding = (world: World, type: BuildingType) => Building({ type, phase: world.count(Building) * 5 })

/** Даёт готовому зданию то, что положено его виду помимо производства. */
export function equip(world: World, entity: Entity, type: BuildingType) {
  const spec = buildingSpec(type)
  if (spec.repair) world.add(entity, Repair({ radius: spec.repair }))
  if (spec.produces && !spec.inventory) {
    equipStorage(world, entity, { inventory: PRODUCER_HOLD })
  }
  equipStorage(world, entity, spec)
  // Достроенная турель заряжена: оборона работает сразу, а подвоз нужен, когда она отстреляется.
  const store = world.get(entity, Inventory)
  if (spec.ammo && store) put(store, 'ammo', store.capacity)
  // Завод изделий стоит выключенным, пока игрок его не включит: иначе он сразу съел бы сырьё зоны.
  if (spec.assembles) world.add(entity, Assembly({ recipe: spec.assembles }))
  mountTurrets(world, entity)
}

/** Ставит здание без проверок. player — владелец; 0 — ничьё. */
export function placeBuilding(world: World, type: BuildingType, x: number, y: number, player = 0, durability = 1) {
  const entity = world.spawn(Position({ x, y }), newBuilding(world, type), Health({ value: durability, max: durability }), Owner({ player }))
  if (buildingSpec(type).produces && player) world.add(entity, Producer)
  equip(world, entity, type)
  return entity
}
