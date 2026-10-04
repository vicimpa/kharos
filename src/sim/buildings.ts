import type { Entity, World } from '../ecs'
import { Terrain, isBuildable, isPassable, terrainAt, tileKey } from '../map/terrain'
import { isOwn } from './common'
import { Building, Health, Repair, Owner, Position, Producer, Site } from './components'
import { equipStorage, type BeamSpec } from './inventory'
import type { Amounts } from './resources'
import type { Sim } from './sim'
import { mountTurrets, type MountSpec } from './turrets'
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
  /** Энергия: больше нуля — вырабатывает, меньше — потребляет. */
  power?: number
  /**
   * Добывает из месторождения под собой в свой склад, пока там есть место. Что и как быстро — решает
   * месторождение, см. DEPOSIT_KINDS. Ставится только на месторождение.
   */
  extract?: boolean
  /** Материалы на стройку вдобавок к кредитам: их привозят на площадку грузовики из хранилищ зоны. */
  materials?: Amounts
  /** Склад: сколько ресурсов помещается в здании. См. inventory.ts. */
  inventory?: number
  /** Склад здания — хранилище: в него свозят добытое, из него берут на нужды зоны и на продажу. */
  stores?: boolean
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

/** Сколько кредитов цены здания один строитель возводит за секунду: здание за 300 строится 15 секунд. */
export const BUILD_RATE = 20

/** Доля обычной прочности у оборонительной постройки на песке. */
export const SAND_DURABILITY = 0.7

export const BUILDINGS = {
  // Доход главного здания не даёт остаться без кредитов совсем: на генератор он копит долго, но копит.
  // Немного ресурсов главное здание хранит само.
  command: { width: 3, height: 3, cost: 2000, income: 0.2, zone: 12, inventory: 100, stores: true, produces: ['builder', 'truck'] },
  refinery: { width: 3, height: 2, cost: 600 },
  // Машинный завод: машинки и тяжёлая техника.
  factory: { width: 2, height: 2, cost: 450, power: -5, materials: { metal: 20 }, produces: ['buggy', 'lancer', 'tank', 'tesla', 'carrier'] },
  // Электростанция.
  generator: { width: 2, height: 2, cost: 300, power: 10 },
  // Генератор материи — базовый доход: превращает энергию в кредиты. Первая электростанция окупает его быстро,
  // дальше теснота делает каждый следующий всё дороже. Он страховка на случай, когда линий добычи нет (§4.3 шаг 3):
  // одной электростанции хватает на два генератора.
  matter: { width: 2, height: 2, cost: 250, power: -3, income: 1.5, crowding: true },
  radar: { width: 2, height: 2, cost: 400 },
  windtrap: { width: 2, height: 2, cost: 300 },
  barracks: { width: 2, height: 2, cost: 250, power: -2, produces: ['infantry', 'rocketeer'] },
  // Шахта энергии не просит и начинает свою зону: тянуть к месторождению цепочку зданий не нужно.
  // Добытое копится в шахте, пока его не выкачают грузовики.
  mine: { width: 2, height: 2, cost: 300, zone: 7, extract: true, inventory: 60 },
  silo: { width: 2, height: 1, cost: 100, inventory: 200, stores: true },
  // Космопорт ещё и выпускает летающих. Энергию просит всегда, но от её нехватки замедляется только производство.
  // Товар на продажу грузовики сгружают в трюм корабля.
  spaceport: { width: 3, height: 3, cost: 450, power: -5, materials: { metal: 20 }, trades: true, inventory: 400, produces: ['drone', 'gunship'] },
  // Дешёвая стена не расширяет зону: иначе цепочкой стен можно было бы бесплатно протянуть контроль через карту.
  wall: { width: 1, height: 1, cost: 30, hp: 400, defense: true, expand: 0 },
  // Оборонительные турели используют то же оружие, что техника. На песке все оборонительные постройки слабее.
  turret: { width: 1, height: 1, cost: 250, hp: 450, defense: true, mounts: [{ turret: 'gunner', along: 0, across: 0 }] },
  rocketTurret: { width: 1, height: 1, cost: 300, hp: 400, defense: true, mounts: [{ turret: 'rocket', along: 0, across: 0 }] },
  cannonTurret: { width: 1, height: 1, cost: 450, hp: 500, defense: true, mounts: [{ turret: 'cannon', along: 0, across: 0 }] },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
/** Описание вида здания со всеми необязательными полями. */
export const buildingSpec = (type: BuildingType): BuildingSpec => BUILDINGS[type]
/** Главное здание — Settlement Core: в него разворачивается MCV. */
export const CORE: BuildingType = 'command'
export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[]
/** Что возводят строители. Остальные здания появятся вместе с тем, для чего они нужны. */
export const BUILDABLE: BuildingType[] = [
  'generator', 'matter', 'mine', 'silo', 'spaceport', 'barracks', 'factory',
  'wall', 'turret', 'rocketTurret', 'cannonTurret',
]

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
 * Можно ли поставить здание левым верхним углом основания в тайл (x, y): основное здание целиком на скале,
 * оборонительное — на скале или песке; внутри границ карты и без других зданий и площадок.
 * gap — зазор до соседних зданий в тайлах.
 */
export function canPlace(sim: Sim, type: BuildingType, x: number, y: number, gap = 0) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  const spec: BuildingSpec = BUILDINGS[type]
  const { width, height } = spec
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) return false
  const accepts = spec.defense ? isPassable : isBuildable
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      if (!accepts(terrainAt(sim.land, tileX, tileY))) return false
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
 * Максимальная доля прочности здания на этом месте. Оборона на песке получает 70%; на скале и у обычных
 * зданий предел равен единице. Для многотайловой обороны достаточно одного песчаного тайла под основанием.
 */
export function durabilityOf(sim: Sim, type: BuildingType, x: number, y: number) {
  const spec: BuildingSpec = BUILDINGS[type]
  if (!spec.defense) return 1
  for (let tileY = y; tileY < y + spec.height; tileY++) {
    for (let tileX = x; tileX < x + spec.width; tileX++) {
      if (terrainAt(sim.land, tileX, tileY) === Terrain.Sand) return SAND_DURABILITY
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
  mountTurrets(world, entity)
}

/** Ставит здание без проверок. player — владелец; 0 — ничьё. */
export function placeBuilding(world: World, type: BuildingType, x: number, y: number, player = 0, durability = 1) {
  const entity = world.spawn(Position({ x, y }), newBuilding(world, type), Health({ value: durability, max: durability }), Owner({ player }))
  if (buildingSpec(type).produces && player) world.add(entity, Producer)
  equip(world, entity, type)
  return entity
}
