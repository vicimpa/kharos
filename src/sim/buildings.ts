import type { Entity, World } from '../ecs'
import { isBuildable, isPassable, terrainAt } from '../map/terrain'
import { Building, Owner, Position, Producer, Site } from './components'
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
   * Сколько руды в секунду здание добывает из месторождения под собой — прямо в кузов грузовика на коннекторе.
   * Ставится только на месторождение.
   */
  extract?: number
  /** Сколько руды помещается в здании. Руду привозят грузовики — к коннектору главного здания зоны. */
  stores?: number
  /** Через это здание продают руду: грузовики свозят её сюда из хранилищ его зоны, см. trade.ts. */
  trades?: boolean
  /**
   * Коннектор: тайл вплотную к зданию, на который грузовик встаёт задом к нему. x и y — сдвиг тайла от левого
   * верхнего тайла основания, facing — куда при этом смотрит грузовик. Тайл должен оставаться проходимым.
   */
  dock?: { x: number; y: number; facing: number }
  /** Каких юнитов здание производит, когда достроено. Потребитель энергии при её нехватке производит медленнее. */
  produces?: UnitType[]
  /** Доход в кредитах в секунду. У потребителя энергии он падает вместе с её нехваткой. */
  income?: number
  /**
   * Таким зданиям тесно в одной зоне: каждое следующее просит на одну норму энергии больше предыдущего.
   * Поэтому отдача от них падает, и ставить их без счёта невыгодно.
   */
  crowding?: boolean
}

/** Сколько кредитов приносит единица руды, проданная через космопорт. */
export const ORE_PRICE = 4

/** Сколько кредитов цены здания один строитель возводит за секунду: здание за 300 строится 15 секунд. */
export const BUILD_RATE = 20

export const BUILDINGS = {
  // Доход главного здания не даёт остаться без кредитов совсем: на генератор он копит долго, но копит.
  // Коннектор — под воротами, посередине нижней стороны. Немного руды главное здание хранит само.
  command: { width: 3, height: 3, cost: 2000, income: 0.2, zone: 12, stores: 100, produces: ['builder', 'truck'], dock: { x: 1, y: 3, facing: Math.PI / 2 } },
  refinery: { width: 3, height: 2, cost: 600 },
  // Машинный завод: машинки и тяжёлая техника.
  factory: { width: 2, height: 2, cost: 500, power: -5, produces: ['buggy', 'lancer', 'tank', 'tesla'] },
  // Электростанция.
  generator: { width: 2, height: 2, cost: 300, power: 10 },
  // Генератор материи — базовый доход: превращает энергию в кредиты.
  matter: { width: 2, height: 2, cost: 400, power: -5, income: 1, crowding: true },
  radar: { width: 2, height: 2, cost: 400 },
  windtrap: { width: 2, height: 2, cost: 300 },
  barracks: { width: 2, height: 2, cost: 300, power: -2, produces: ['infantry', 'rocketeer'] },
  // Шахта энергии не просит и начинает свою зону: тянуть к месторождению цепочку зданий не нужно.
  // Месторождения невелики, поэтому добыча медленная, а руда дорогая. Коннектор — под левым нижним тайлом.
  mine: { width: 2, height: 2, cost: 500, zone: 6, extract: 0.5, dock: { x: 0, y: 2, facing: Math.PI / 2 } },
  silo: { width: 2, height: 1, cost: 150, stores: 200, dock: { x: 0, y: 1, facing: Math.PI / 2 } },
  // Космопорт ещё и выпускает летающих. Энергию просит всегда, но от её нехватки замедляется только производство.
  spaceport: { width: 3, height: 3, cost: 600, power: -5, trades: true, produces: ['drone', 'gunship'], dock: { x: 1, y: 3, facing: Math.PI / 2 } },
  turret: { width: 1, height: 1, cost: 250 },
} satisfies Record<string, BuildingSpec>

export type BuildingType = keyof typeof BUILDINGS
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
  const key = (x: number, y: number) => (y + 32768) * 65536 + x + 32768
  const tiles = new Map<number, Entity>()
  const stop = world.observe([Position, Building], (entity, position, building) => {
    const { width, height } = BUILDINGS[building.type]
    const keys: number[] = []
    for (let y = position.y; y < position.y + height; y++) {
      for (let x = position.x; x < position.x + width; x++) keys.push(key(x, y))
    }
    for (const key of keys) tiles.set(key, entity)
    return () => {
      for (const key of keys) if (tiles.get(key) === entity) tiles.delete(key)
    }
  })
  return {
    at: (x, y) => (tiles.size ? tiles.get(key(x, y)) : undefined),
    destroy: stop,
  }
}

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

/** Коннектор здания на карте: тайл и куда смотрит вставший на него грузовик. */
export interface Dock {
  x: number
  y: number
  facing: number
}

/** Коннектор здания этого вида с левым верхним углом основания в (x, y); undefined — у вида его нет. */
export function dockOf(type: BuildingType, x: number, y: number): Dock | undefined {
  const dock = (BUILDINGS[type] as BuildingSpec).dock
  return dock && { x: x + dock.x, y: y + dock.y, facing: dock.facing }
}

/**
 * Не мешает ли здание коннекторам: его основание не накрывает коннектор другого здания или площадки,
 * а его собственный коннектор приходится на проходимый тайл, не занятый зданием или площадкой.
 */
export function docksClear(sim: Sim, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  const covers = (dock: Dock | undefined) => !!dock && dock.x >= x && dock.x < x + width && dock.y >= y && dock.y < y + height
  for (const [entity, position, building] of sim.world.query(Position, Building)) {
    if (!sim.world.has(entity, Site) && covers(dockOf(building.type, position.x, position.y))) return false
  }
  for (const [, position, site] of sim.world.query(Position, Site)) {
    if (covers(dockOf(site.type, position.x, position.y))) return false
  }
  const own = dockOf(type, x, y)
  if (!own) return true
  if (!isPassable(terrainAt(sim.land, own.x, own.y)) || sim.occupancy.at(own.x, own.y) !== undefined) return false
  return siteAt(sim, own.x, own.y) === undefined
}

/** Ставит здание без проверок. player — владелец; 0 — ничьё. */
export function placeBuilding(world: World, type: BuildingType, x: number, y: number, player = 0) {
  const entity = world.spawn(Position({ x, y }), Building({ type, phase: world.count(Building) * 5 }), Owner({ player }))
  if ((BUILDINGS[type] as BuildingSpec).produces && player) world.add(entity, Producer)
  return entity
}
