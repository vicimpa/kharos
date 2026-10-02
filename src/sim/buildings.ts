import type { Entity, World } from '../ecs'
import { isBuildable, terrainAt, tileKey } from '../map/terrain'
import { isOwn } from './common'
import { Building, Health, Repair, Owner, Position, Producer, Site } from './components'
import { equipStorage, type BeamSpec } from './inventory'
import type { Sim } from './sim'
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
  /** Энергия: больше нуля — вырабатывает, меньше — потребляет. */
  power?: number
  /**
   * Сколько руды в секунду здание добывает из месторождения под собой — в свой склад, пока там есть место.
   * Ставится только на месторождение.
   */
  extract?: number
  /** Склад: сколько ресурсов помещается в здании. См. inventory.ts. */
  inventory?: number
  /** Склад здания — хранилище руды: в него свозят добытое, из него продают, он входит в запас игрока. */
  stores?: boolean
  /** Транспортный луч: им здание отдаёт ресурсы со своего склада или забирает на него. См. inventory.ts. */
  beam?: BeamSpec
  /** Через это здание продают руду: грузовики свозят её сюда из хранилищ его зоны, см. trade.ts. */
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

/** Сколько кредитов приносит единица руды, проданная через космопорт. */
export const ORE_PRICE = 4

/** Сколько кредитов цены здания один строитель возводит за секунду: здание за 300 строится 15 секунд. */
export const BUILD_RATE = 20

/** Луч хранилища: принимает руду из грузовиков и отдаёт её в них. */
const STORE_BEAM: BeamSpec = { radius: 2, rate: 10, give: true, take: true }

export const BUILDINGS = {
  // Доход главного здания не даёт остаться без кредитов совсем: на генератор он копит долго, но копит.
  // Немного руды главное здание хранит само и лучом принимает её из грузовиков и отдаёт в них.
  command: { width: 3, height: 3, cost: 2000, income: 0.2, zone: 12, inventory: 100, stores: true, beam: STORE_BEAM, produces: ['builder', 'truck'] },
  refinery: { width: 3, height: 2, cost: 600 },
  // Машинный завод: машинки и тяжёлая техника.
  factory: { width: 2, height: 2, cost: 500, power: -5, produces: ['buggy', 'lancer', 'tank', 'tesla', 'carrier'] },
  // Электростанция.
  generator: { width: 2, height: 2, cost: 300, power: 10 },
  // Генератор материи — базовый доход: превращает энергию в кредиты.
  matter: { width: 2, height: 2, cost: 400, power: -5, income: 1, crowding: true },
  radar: { width: 2, height: 2, cost: 400 },
  windtrap: { width: 2, height: 2, cost: 300 },
  barracks: { width: 2, height: 2, cost: 300, power: -2, produces: ['infantry', 'rocketeer'] },
  // Шахта энергии не просит и начинает свою зону: тянуть к месторождению цепочку зданий не нужно.
  // Месторождения невелики, поэтому добыча медленная, а руда дорогая. Добытое копится в шахте, пока грузовик
  // не заберёт: забирать сам он не умеет, руду ему отдаёт луч шахты.
  mine: { width: 2, height: 2, cost: 500, zone: 6, extract: 0.5, inventory: 40, beam: { radius: 2, rate: 10, give: true } },
  silo: { width: 2, height: 1, cost: 150, inventory: 200, stores: true, beam: STORE_BEAM },
  // Космопорт ещё и выпускает летающих. Энергию просит всегда, но от её нехватки замедляется только производство.
  // Руду на продажу его луч забирает из грузовиков в трюм корабля.
  spaceport: { width: 3, height: 3, cost: 600, power: -5, trades: true, inventory: 400, beam: { radius: 2, rate: 10, take: true }, produces: ['drone', 'gunship'] },
  turret: { width: 1, height: 1, cost: 250 },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
/** Описание вида здания со всеми необязательными полями. */
export const buildingSpec = (type: BuildingType): BuildingSpec => BUILDINGS[type]
/** Главное здание — Settlement Core: в него разворачивается MCV. */
export const CORE: BuildingType = 'command'
export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[]
/** Что возводят строители. Остальные здания появятся вместе с тем, для чего они нужны. */
export const BUILDABLE: BuildingType[] = ['generator', 'matter', 'mine', 'silo', 'spaceport', 'barracks', 'factory']

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

/** Площадка, основание которой накрывает тайл (x, y), или undefined. Площадок мало, поэтому простой перебор. */
export function siteAt(sim: Sim, x: number, y: number): Entity | undefined {
  for (const [entity, position, site] of sim.world.query(Position, Site)) {
    const { width, height } = BUILDINGS[site.type]
    if (x >= position.x && x < position.x + width && y >= position.y && y < position.y + height) return entity
  }
  return undefined
}

/**
 * Можно ли поставить здание левым верхним углом основания в тайл (x, y): основание целиком на скале,
 * внутри границ карты и не задевает другие здания и площадки. gap — зазор до соседних зданий в тайлах.
 */
export function canPlace(sim: Sim, type: BuildingType, x: number, y: number, gap = 0) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  const { width, height } = BUILDINGS[type]
  const { bounds } = sim
  if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom) return false
  for (let tileY = y; tileY < y + height; tileY++) {
    for (let tileX = x; tileX < x + width; tileX++) {
      if (!isBuildable(terrainAt(sim.land, tileX, tileY))) return false
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

/** Заготовка компонента нового здания: сдвиг анимации у каждого свой. */
export const newBuilding = (world: World, type: BuildingType) => Building({ type, phase: world.count(Building) * 5 })

/** Даёт готовому зданию то, что положено его виду помимо производства. */
export function equip(world: World, entity: Entity, type: BuildingType) {
  const spec = buildingSpec(type)
  if (spec.repair) world.add(entity, Repair({ radius: spec.repair }))
  equipStorage(world, entity, spec)
}

/** Ставит здание без проверок. player — владелец; 0 — ничьё. */
export function placeBuilding(world: World, type: BuildingType, x: number, y: number, player = 0) {
  const entity = world.spawn(Position({ x, y }), newBuilding(world, type), Health, Owner({ player }))
  if (buildingSpec(type).produces && player) world.add(entity, Producer)
  equip(world, entity, type)
  return entity
}
