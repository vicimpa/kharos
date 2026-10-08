import type { Entity } from '../ecs'
import { Biome, Terrain, biomeAt, isPassable, terrainAt, tileKey } from '../map/terrain'
import { FOUNDATION_SPEED, ROAD_SPEED, isPaved } from './paved'
import { isOwn } from './common'
import { Armed, Converting, Hauler, Harvester, Health, Owner, Repair, Path, Pave, Position, Producer, Unit } from './components'
import { unitSight } from './vision'
import { STARTING_CREDITS, addCredits } from './economy'
import { equipStorage, type BeamSpec } from './inventory'
import type { Amounts } from './resources'
import { findPath, smoothPath } from './path'
import type { Sim } from './sim'
import { mountTurrets, turretSpec, type MountSpec } from './turrets'
import type { UnitClass, WeaponType } from './weapons'

/** Что симуляция знает о виде юнита. Как он выглядит, знает клиент: см. game/units/unitArt.ts. */
export interface UnitSpec {
  /** Скорость в тайлах в секунду. */
  speed: number
  /** Как быстро поворачивает, в радианах в секунду. */
  turn: number
  /** Радиус в тайлах: по нему юнит выбирается мышью и не пускает в себя других юнитов. */
  radius: number
  /** Цена в кредитах и время производства в секундах. */
  cost: number
  buildTime: number
  /** Класс: пехота, машина, тяжёлая техника или летающий. Летающим не мешают ни местность, ни здания, ни наземные юниты. */
  kind: UnitClass
  /** Прочность: сколько урона юнит выдерживает. */
  hp: number
  /** Чем вооружён; без оружия юнит в бою не участвует. См. combat.ts. */
  weapon?: WeaponType
  /** Строит и чинит всё своё в этом радиусе, в тайлах от своего центра до края цели. См. construction.ts. */
  repair?: number
  /** Турели на юните: каждая — своя сущность, см. turrets.ts. */
  mounts?: MountSpec[]
  /**
   * Материалы на производство вдобавок к кредитам: их привозят производителю грузовики из хранилищ его зоны,
   * и пока их нет, заказ не начинается. Без них — только кредиты.
   */
  materials?: Amounts
  /**
   * Виды зданий (BuildingType), которые должны у игрока стоять готовыми, чтобы юнит можно было заказать: так устроены
   * тиры. Строки, а не BuildingType: виды зданий сами ссылаются на виды юнитов. Имена сверяет тест.
   */
  requires?: readonly string[]
  /** Склад: сколько ресурсов юнит везёт. См. inventory.ts. */
  inventory?: number
  /** Грузовик: возит груз по заявкам зон, из шахты, по маршруту. См. hauling.ts. */
  hauls?: boolean
  /** Транспортный луч: им юнит отдаёт ресурсы со своего склада или забирает на него. */
  beam?: BeamSpec
  /** Харвестер: копает руду сам, столько в секунду, и возит её на переработку. См. harvesting.ts. */
  harvest?: number
  /** Сколько тайлов от центра юнит видит; без поля — по классу, и не меньше дальности оружия. См. vision.ts. */
  sight?: number
}

/**
 * Боевые числа подобраны под боевой треугольник: у каждого юнита есть контр-юниты, ни один не бьёт всех.
 * Как это выглядит на деле — видно прогоном `bun run balance`: он считает урон в секунду и проводит бои.
 */
export const UNITS = {
  mcv: { speed: 2.5, turn: 2.2, radius: 0.8, cost: 2000, buildTime: 30, kind: 'heavy', hp: 800, sight: 9, materials: { blocks: 20, metal: 20 } },
  builder: { speed: 4, turn: 5, radius: 0.45, cost: 120, buildTime: 5, kind: 'vehicle', hp: 100, repair: 5, sight: 6, inventory: 10, beam: { radius: 2, rate: 10, give: true, take: true } },
  infantry: { speed: 3, turn: 10, radius: 0.3, cost: 60, buildTime: 3, kind: 'infantry', hp: 50, weapon: 'rifle' },
  // Грузовик возит добытое из шахты в хранилище и заказанное по зонам: см. hauling.ts. Своим лучом он и забирает груз,
  // и сгружает его: зданиям лучи не нужны.
  // Харвестер — шахта на колёсах: копает медленнее шахты, зато сам и где угодно, и сам возит руду на
  // переработку. Тяжелее грузовика: его ловят в поле, и он должен пережить первый налёт.
  harvester: { speed: 3, turn: 3, radius: 0.55, cost: 400, buildTime: 10, kind: 'vehicle', hp: 300, sight: 6, inventory: 30, harvest: 0.75, beam: { radius: 2, rate: 10, give: true, take: true } },
  truck: { speed: 3.5, turn: 4, radius: 0.45, cost: 150, buildTime: 8, kind: 'vehicle', hp: 150, sight: 6, inventory: 25, hauls: true, beam: { radius: 2, rate: 10, give: true, take: true } },
  // Пехота.
  // Огнемётчик: штурмовик ближнего боя — выжигает пехоту в окопах и здания, к броне ему не подойти.
  flamer: { speed: 3.4, turn: 10, radius: 0.3, cost: 140, buildTime: 5, kind: 'infantry', hp: 90, weapon: 'flame' },
  rocketeer: { speed: 2.6, turn: 10, radius: 0.3, cost: 120, buildTime: 5, kind: 'infantry', hp: 40, weapon: 'launcher' },
  // Машинки: быстрые и хрупкие.
  // Багги: за водителем сидит пассажир с миниганом и стреляет во все стороны. Она же разведчик: видит дальше всех на земле.
  buggy: {
    speed: 6, turn: 5, radius: 0.45, cost: 250, buildTime: 7, kind: 'vehicle', hp: 150, materials: { metal: 6 }, sight: 11,
    mounts: [{ turret: 'gunner', along: -0.16, across: 0 }],
  },
  // Зенитка: быстрая машина со спаренной автопушкой, бьёт только по воздуху — далеко и сильно.
  flak: { speed: 5, turn: 4.5, radius: 0.5, cost: 350, buildTime: 8, kind: 'vehicle', hp: 170, weapon: 'flak', materials: { metal: 8 }, sight: 10 },
  // Лазеру нужен кремний.
  lancer: { speed: 4.5, turn: 4.5, radius: 0.45, cost: 350, buildTime: 9, kind: 'vehicle', hp: 180, weapon: 'laser', materials: { metal: 8, silicon: 4 } },
  // Тяжёлые: медленные, крепкие и дорогие.
  // Танк бьёт ядрами из башни: она поворачивается сама, и стрелять можно на ходу.
  tank: {
    speed: 2.2, turn: 2.5, radius: 0.7, cost: 600, buildTime: 14, kind: 'heavy', hp: 450, materials: { metal: 20, silicon: 4 }, requires: ['techCenter'],
    mounts: [{ turret: 'cannon', along: -0.06, across: 0 }],
  },
  // Артиллерия: гаубица на колёсном лафете. Бьёт дальше турелей, но видит меньше, чем стреляет, — ей нужен
  // разведчик; хрупкая и с мёртвой зоной вблизи, без прикрытия её съедают машинки. Второй тир.
  artillery: {
    speed: 2.4, turn: 2.2, radius: 0.6, cost: 800, buildTime: 16, kind: 'vehicle', hp: 200, weapon: 'artillery', sight: 8,
    materials: { metal: 16, blocks: 4 }, requires: ['techCenter'],
  },
  // Разрядник: тяжёлое шасси с разрядной башней. Катушку собирают из компонентов: в них харит, и без цеха её не сделать.
  tesla: {
    speed: 2, turn: 2.5, radius: 0.7, cost: 700, buildTime: 16, kind: 'heavy', hp: 500, materials: { metal: 15, silicon: 6, parts: 3 }, requires: ['techCenter'],
    mounts: [{ turret: 'arc', along: 0, across: 0 }],
  },
  // Носитель: колёсное шасси танка без своего оружия — на нём три ракетные турели и ремонтная. Ремонтной нужен компонент.
  carrier: {
    speed: 3, turn: 2.5, radius: 0.8, cost: 1200, buildTime: 20, kind: 'vehicle', hp: 700, materials: { metal: 25, silicon: 8, parts: 1 }, requires: ['techCenter'],
    mounts: [
      { turret: 'rocket', along: 0.36, across: -0.27 },
      { turret: 'rocket', along: 0.36, across: 0.27 },
      { turret: 'rocket', along: -0.28, across: -0.27 },
      { turret: 'repair', along: -0.28, across: 0.27 },
    ],
  },
  // Летающие: им нужно топливо.
  // Летающий грузовик: везёт меньше обычного, зато вдвое быстрее и напрямик — над болотами и горами. Его сбивает ПВО.
  airTruck: { speed: 7, turn: 5, radius: 0.45, cost: 300, buildTime: 10, kind: 'air', hp: 100, sight: 8, inventory: 10, hauls: true, beam: { radius: 2, rate: 10, give: true, take: true }, materials: { fuel: 4 } },
  drone: { speed: 7.5, turn: 6, radius: 0.35, cost: 220, buildTime: 6, kind: 'air', hp: 70, weapon: 'machinegun', materials: { silicon: 3, fuel: 4 } },
  gunship: { speed: 5, turn: 3, radius: 0.55, cost: 500, buildTime: 12, kind: 'air', hp: 200, weapon: 'launcher', materials: { metal: 12, silicon: 4, fuel: 8 } },
  // Бомбардировщик: сносит здания и колонны с воздуха, но сам по воздуху не бьёт и хрупок — его встречают ракеты,
  // турели и зенитки. Второй тир.
  bomber: {
    speed: 5.5, turn: 2.5, radius: 0.7, cost: 700, buildTime: 14, kind: 'air', hp: 180, weapon: 'bomb', sight: 7,
    materials: { metal: 10, fuel: 12 }, requires: ['techCenter'],
  },
} satisfies Record<string, UnitSpec>

export type UnitType = keyof typeof UNITS
export const UNIT_TYPES = Object.keys(UNITS) as UnitType[]
/** Описание вида юнита со всеми необязательными полями. */
export const unitSpec = (type: UnitType): UnitSpec => UNITS[type]

/** Боевой ли вид: вооружён сам или несёт вооружённые турели. */
export const isFighter = (type: UnitType) => {
  const { weapon, mounts } = unitSpec(type)
  return !!weapon || !!mounts?.some(({ turret }) => turretSpec(turret).weapon)
}

/** Летает ли юнит этого вида. */
export const flies = (type: UnitType) => unitSpec(type).kind === 'air'

/** Лежит ли тайл внутри карты. */
export function inBounds(sim: Sim, x: number, y: number) {
  const { bounds } = sim
  return x >= bounds.left && y >= bounds.top && x < bounds.right && y < bounds.bottom
}

/** Может ли юнит находиться в тайле: наземному нужен проходимый тайл без здания, летающему — любой внутри карты. */
export const canStand = (sim: Sim, air: boolean, x: number, y: number) => (air ? inBounds(sim, x, y) : isWalkable(sim, x, y))

/** Какую долю прочности пехотинец восстанавливает сам за секунду. */
export const INFANTRY_REGEN = 0.02

/** С чем игрок появляется в мире. */
const STARTING_UNITS: UnitType[] = ['mcv', 'builder', 'builder', 'infantry', 'infantry', 'infantry']

/** Может ли наземный юнит находиться в тайле: внутри карты, на песке или скале, не в здании. */
export function isWalkable(sim: Sim, x: number, y: number) {
  if (!inBounds(sim, x, y)) return false
  return isPassable(terrainAt(sim.land, x, y)) && sim.occupancy.at(x, y) === undefined
}

/** Медленнее этой доли скорости местность не замедляет: иначе юнит застрял бы навсегда. */
const SLOWEST = 0.05

/**
 * Сколько тайлов в поперечнике покрытия нужно юниту, чтобы ехать по нему быстрее: юниту шире тайла — полоса в два.
 */
const paveWidthOf = (type: UnitType) => (UNITS[type].radius > 0.5 ? 2 : 1)

/** Хватает ли юниту ширины покрытия в тайле (x, y): тайл лежит в квадрате готового покрытия его ширины. */
function pavedFor(sim: Sim, type: UnitType, x: number, y: number) {
  const width = paveWidthOf(type)
  const paved = (tileX: number, tileY: number) => isPaved(sim, 'road', tileX, tileY) || isPaved(sim, 'foundation', tileX, tileY)
  for (let top = y - width + 1; top <= y; top++) {
    search: for (let left = x - width + 1; left <= x; left++) {
      for (let tileY = top; tileY < top + width; tileY++) for (let tileX = left; tileX < left + width; tileX++) if (!paved(tileX, tileY)) continue search
      return true
    }
  }
  return false
}

/**
 * Видит ли юнит готовую дорогу: в радиусе его обзора. Дорогу, которой юнит не видит, поиск пути не ищет: оценка с запасом
 * на дорогу дороже, и в поле она только тратила бы поиск. Увидит дорогу по пути — перестроит путь, см. movement.ts.
 */
export function roadInSight(sim: Sim, entity: Entity) {
  // Покрытия нет вовсе — и смотреть нечего.
  if (!sim.world.count(Pave)) return false
  const position = sim.world.get(entity, Position)
  const unit = sim.world.get(entity, Unit)
  if (!position || !unit) return false
  const sight = unitSight(unit.type)
  const centerX = Math.floor(position.x)
  const centerY = Math.floor(position.y)
  const reach = Math.ceil(sight)
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx * dx + dy * dy > sight * sight) continue
      if (isPaved(sim, 'road', centerX + dx, centerY + dy)) return true
    }
  }
  return false
}

/** Самая высокая доля скорости, какая бывает у юнита: по нему поиск пути оценивает, сколько ещё ехать. */
export const fastestOf = (type: UnitType) => (UNITS[type].kind === 'heavy' || UNITS[type].kind === 'air' ? 1 : ROAD_SPEED)

/** Доля полной скорости юнита type на тайле (x, y): по скале и в воздухе — 1, песок и болото замедляют, см. Rules; дорога ускоряет. */
export function terrainSpeed(sim: Sim, type: UnitType, x: number, y: number) {
  const { kind } = UNITS[type]
  if (kind === 'air') return 1
  // Покрытие убирает замедление местности: болото под мостом не вязнет. Быстрее скалы по нему едут колёсные и пехота,
  // и то, если покрытие не уже их самих; гусеничным всё равно, по чему ехать.
  const road = isPaved(sim, 'road', x, y)
  if (road || isPaved(sim, 'foundation', x, y)) {
    if (kind === 'heavy' || !pavedFor(sim, type, x, y)) return 1
    return road ? ROAD_SPEED : FOUNDATION_SPEED
  }
  const terrain = terrainAt(sim.land, x, y)
  if (terrain === Terrain.Sand) return Math.max(SLOWEST, 1 - sim.rules[`${kind}Sand`])
  if (terrain === Terrain.Swamp) {
    // На солончаках болото промёрзло: вязнут в нём меньше.
    const frozen = biomeAt(sim.land, x, y) === Biome.SaltFlats ? sim.rules.frozenSwamp : 1
    return Math.max(SLOWEST, 1 - sim.rules[`${kind}Swamp`] * frozen)
  }
  return 1
}

/** Набор тайлов, про который можно только спросить, входит ли в него тайл; ключ — tileKey. */
export interface TileSet {
  has(key: number): boolean
}

/**
 * Тайлы, занятые стоящими юнитами: путь прокладывается в обход них. Идущие юниты сюда не попадают —
 * к тому времени, как до них дойдут, они уйдут; с ними юнит расходится на ходу, см. movement.ts.
 * ignore — кого не считать: сам идущий и те, кто трогается вместе с ним. radius — радиус идущего:
 * тайл занят, если, встав в его центр, идущий задел бы стоящего. Так крупная машина не лезет в щель между соседями.
 * air — считать летающих, а не наземных: друг другу они не мешают.
 */
export function standingUnits(sim: Sim, ignore: ReadonlySet<Entity>, radius: number, air = false): TileSet {
  const { world } = sim
  const tiles = new Set<number>()
  for (const [entity, position, unit] of world.query(Position, Unit)) {
    if (ignore.has(entity) || world.has(entity, Path) || flies(unit.type) !== air) continue
    const reach = UNITS[unit.type].radius + radius
    const right = Math.floor(position.x + reach)
    const bottom = Math.floor(position.y + reach)
    for (let y = Math.floor(position.y - reach); y <= bottom; y++) {
      const dy = y + 0.5 - position.y
      for (let x = Math.floor(position.x - reach); x <= right; x++) {
        const dx = x + 0.5 - position.x
        if (dx * dx + dy * dy < reach * reach) tiles.add(tileKey(x, y))
      }
    }
  }
  return tiles
}

/** Сколько тайлов осматривает поиск пути, когда к цели надо только подойти на расстояние. */
const APPROACH_LIMIT = 3000
/** Сколько тайлов осматривает поиск пути, когда юнит уступает дорогу. */
const STEP_ASIDE_LIMIT = 300

/** Дальше скольких колец от цели места группе не ищутся: армия в тысячи юнитов встаёт плотнее, а не расползается. */
const MAX_GROUP_RADIUS = 40

/** Шаг между местами юнитов в группе, в тайлах: крупные машины не помещаются в один тайл. */
const GROUP_SPACING = 2

/**
 * Проходимые тайлы вокруг точки, от ближних к дальним: места для группы юнитов, через GROUP_SPACING тайлов.
 * Возвращает не больше count тайлов (x, y подряд); если рядом их меньше — сколько нашлось.
 * fromRadius — с какого кольца начинать: 1 пропускает саму точку. blocked — тайлы, которые тоже не годятся.
 * air — места для летающих: им годится любой тайл карты.
 */
export function freeTilesNear(sim: Sim, x: number, y: number, count: number, fromRadius = 0, blocked?: TileSet, air = false) {
  // Кольца до восьмого — всегда; большой армии — столько, чтобы места хватило каждому, с запасом на непроходимое.
  const searchRadius = Math.min(MAX_GROUP_RADIUS, Math.max(8, Math.ceil(Math.sqrt(count))))
  const tiles: number[] = []
  for (let radius = fromRadius; radius <= searchRadius && tiles.length < count * 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Только кольцо на расстоянии radius: внутренние тайлы уже проверены.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const tileX = x + dx * GROUP_SPACING
        const tileY = y + dy * GROUP_SPACING
        if (tiles.length >= count * 2 || blocked?.has(tileKey(tileX, tileY))) continue
        if (canStand(sim, air, tileX, tileY)) tiles.push(tileX, tileY)
      }
    }
  }
  return tiles
}

/** Создаёт юнит в центре тайла (x, y). */
export function spawnUnit(sim: Sim, type: UnitType, player: number, x: number, y: number) {
  const position = { x: x + 0.5, y: y + 0.5 }
  const { world } = sim
  const spec = unitSpec(type)
  // Пехоту не чинят: она поправляется сама.
  const infantry = spec.kind === 'infantry'
  const entity = world.spawn(Position(position), Unit({ type, prevX: position.x, prevY: position.y }), Owner({ player }), Health(infantry ? { repairable: false, regen: INFANTRY_REGEN } : {}))
  if (type === 'mcv') world.add(entity, Producer)
  if (spec.hauls || spec.harvest) world.add(entity, Hauler)
  if (spec.harvest) world.add(entity, Harvester)
  if (spec.weapon) world.add(entity, Armed)
  if (spec.repair) world.add(entity, Repair({ radius: spec.repair }))
  equipStorage(world, entity, spec)
  mountTurrets(sim.world, entity)
  return entity
}

/**
 * Стартовый набор игрока вокруг тайла (x, y) и стартовые кредиты.
 * Возвращает созданных юнитов; их меньше, если места не хватило.
 */
export function spawnStartingUnits(sim: Sim, player: number, x: number, y: number) {
  addCredits(sim, player, STARTING_CREDITS)
  const tiles = freeTilesNear(sim, x, y, STARTING_UNITS.length)
  const units: Entity[] = []
  for (let i = 0; i < STARTING_UNITS.length && i * 2 < tiles.length; i++) {
    units.push(spawnUnit(sim, STARTING_UNITS[i], player, tiles[i * 2], tiles[i * 2 + 1]))
  }
  return units
}

/**
 * Отправляет юнит в тайл (x, y): прокладывает путь и кладёт его в компонент Path.
 * Стоящих юнитов путь обходит; если в самой цели кто-то стоит, юнит идёт на свободный тайл рядом.
 * Если идти некуда, юнит остаётся на месте.
 * ignore — кто из стоящих юнитов не препятствие; tries — который раз прокладывается путь к этой цели.
 * near — на сколько тайлов достаточно подойти к цели; тогда сама цель может быть занята или недоступна.
 * limit — сколько тайлов можно осмотреть в поиске пути; по умолчанию — сколько позволяет path.ts.
 */
export function orderMove(sim: Sim, entity: Entity, x: number, y: number, ignore?: ReadonlySet<Entity>, tries = 0, near = 0, limit?: number) {
  const { world } = sim
  const position = world.get(entity, Position)
  // Юнит, который разворачивается, с места не трогается.
  if (!position || world.has(entity, Converting)) return
  const { type } = world.get(entity, Unit)!
  const air = flies(type)
  const taken = standingUnits(sim, ignore ?? new Set([entity]), UNITS[type].radius, air)
  if (!near && taken.has(tileKey(x, y))) {
    const [freeX, freeY] = freeTilesNear(sim, x, y, 1, 1, taken, air)
    if (freeX === undefined) return void world.remove(entity, Path)
    x = freeX
    y = freeY
  }
  if (air) {
    // Летающему преград нет: он летит к цели по прямой.
    if (!inBounds(sim, x, y)) return void world.remove(entity, Path)
    world.add(entity, Path({ points: [x + 0.5, y + 0.5], goalX: x, goalY: y, tries, near, direct: false, stuck: false }))
    return
  }
  const fromX = Math.floor(position.x)
  const fromY = Math.floor(position.y)
  // Свой тайл проходим всегда: иначе юнит, вставший вплотную к соседу, не смог бы тронуться.
  const walkable = (tileX: number, tileY: number) => {
    if (tileX === fromX && tileY === fromY) return true
    return isWalkable(sim, tileX, tileY) && !taken.has(tileKey(tileX, tileY))
  }
  // Шаг по тайлу стоит столько, сколько по нему ехать: медленные пески и болота путь объезжает, если выходит быстрее.
  const slowness = (tileX: number, tileY: number) => 1 / terrainSpeed(sim, type, tileX, tileY)
  // Подход на расстояние ищется недолго: не вышло обойти — юнит встанет поближе и попробует оттуда.
  // Оценка с запасом на дорогу дороже обычной — поиск осматривает больше тайлов; нужна она, только если дорога в виду.
  const fastest = fastestOf(type) > 1 && roadInSight(sim, entity) ? 1 / fastestOf(type) : 1
  const tiles = findPath(walkable, fromX, fromY, x, y, near, near ? APPROACH_LIMIT : limit, slowness, fastest)
  // Уже достаточно близко, а идти всё равно велят: значит, надо подойти вплотную. Цель рядом — и искать недолго.
  if (near && !tiles.length && (fromX - x) ** 2 + (fromY - y) ** 2 <= near * near) return orderMove(sim, entity, x, y, ignore, tries, 0, APPROACH_LIMIT)
  // Юнит идёт по центрам тайлов.
  const points = smoothPath(
    walkable,
    position.x,
    position.y,
    tiles.map((value) => value + 0.5),
    slowness,
  )
  if (points.length) world.add(entity, Path({ points, goalX: x, goalY: y, tries, near, roads: fastest < 1, direct: false, stuck: false }))
  else world.remove(entity, Path)
}

/**
 * Отправляет группу к тайлу (x, y): каждому юниту достаётся свой тайл рядом с целью.
 * Летающие и наземные расходятся по местам порознь: друг другу они не мешают.
 */
export function orderGroupMove(sim: Sim, all: Entity[], x: number, y: number) {
  const air = flies(sim.world.get(all[0], Unit)!.type)
  const units = all.filter((entity) => flies(sim.world.get(entity, Unit)!.type) === air)
  if (units.length < all.length) orderGroupMove(sim, all.filter((entity) => !units.includes(entity)), x, y)
  // Друг другу юниты группы не препятствие: они трогаются вместе.
  const group = new Set(units)
  const radius = Math.max(...units.map((entity) => UNITS[sim.world.get(entity, Unit)!.type].radius))
  const taken = standingUnits(sim, group, radius, air)
  const tiles = freeTilesNear(sim, x, y, units.length, 0, taken, air)
  if (air) sendToTiles(sim, units, tiles, group)
  else aimAtTiles(sim, units, tiles)
}

/**
 * Раздаёт наземным юнитам тайлы (x, y подряд), каждому свой, но путь не прокладывает: юнит сразу едет к своему тайлу
 * напрямую, объезжая встречное на ходу. Путь ищется, только если упрётся (planPaths) или увидит дорогу (movement.ts):
 * в открытом поле армия в тысячи юнитов не ищет путей вовсе.
 */
function aimAtTiles(sim: Sim, units: Entity[], tiles: number[]) {
  if (!tiles.length) return
  const { world } = sim
  units.forEach((entity, i) => {
    if (world.has(entity, Converting)) return
    const at = Math.min(i * 2, tiles.length - 2)
    const x = tiles[at]
    const y = tiles[at + 1]
    world.add(entity, Path({ points: [x + 0.5, y + 0.5], goalX: x, goalY: y, wait: 0, tries: 0, near: 0, roads: false, direct: true, stuck: false }))
  })
}

/** Рассылает юнитов по тайлам (x, y подряд), каждого в свой. Друг другу юниты group не препятствие. */
function sendToTiles(sim: Sim, units: Entity[], tiles: number[], group: ReadonlySet<Entity>) {
  if (!tiles.length) return
  units.forEach((entity, i) => {
    // Мест может оказаться меньше, чем юнитов; тогда лишние идут в последнее.
    const at = Math.min(i * 2, tiles.length - 2)
    orderMove(sim, entity, tiles[at], tiles[at + 1], group)
  })
}

/**
 * Просит стоящий юнит уступить дорогу тому, кто идёт из (fromX, fromY) в направлении heading: отойти вбок
 * от линии его движения на room тайлов. Отходит в ту сторону, с которой уже стоит; если там занято — в другую.
 */
export function stepAside(sim: Sim, entity: Entity, fromX: number, fromY: number, heading: number, room: number) {
  const { world } = sim
  const position = world.get(entity, Position)
  const unit = world.get(entity, Unit)
  if (!position || !unit || world.has(entity, Path) || world.has(entity, Converting)) return
  // Грузовик под лучом место не уступает: иначе ждущий очереди сгонял бы того, кто грузится.
  if (world.get(entity, Hauler)?.loading) return
  const sideX = -Math.sin(heading)
  const sideY = Math.cos(heading)
  const side = (position.x - fromX) * sideX + (position.y - fromY) * sideY >= 0 ? 1 : -1
  const air = flies(unit.type)
  const taken = standingUnits(sim, new Set([entity]), UNITS[unit.type].radius, air)
  for (const sign of [side, -side]) {
    const x = Math.floor(position.x + sideX * sign * room)
    const y = Math.floor(position.y + sideY * sign * room)
    if (!canStand(sim, air, x, y) || taken.has(tileKey(x, y))) continue
    // Отойти надо на пару тайлов: если туда не пройти, обход издалека не нужен.
    orderMove(sim, entity, x, y, undefined, 0, 0, STEP_ASIDE_LIMIT)
    return
  }
}

/** Наземные юниты, чей центр лежит внутри прямоугольника в тайлах. Летающие не в счёт: земли они не занимают. */
export function unitsIn(sim: Sim, x: number, y: number, width: number, height: number) {
  const inside: Entity[] = []
  for (const [entity, position, unit] of sim.world.query(Position, Unit)) {
    if (flies(unit.type)) continue
    if (position.x >= x && position.x < x + width && position.y >= y && position.y < y + height) inside.push(entity)
  }
  return inside
}

/**
 * Отправляет юнитов, оказавшихся внутри основания здания, на свободные тайлы рядом.
 * inside — кого именно отправлять; по умолчанию всех, кто там есть.
 */
export function evictUnits(sim: Sim, x: number, y: number, width: number, height: number, inside = unitsIn(sim, x, y, width, height)) {
  if (!inside.length) return
  const group = new Set(inside)
  const taken = standingUnits(sim, group, UNITS.mcv.radius)
  sendToTiles(sim, inside, freeTilesNear(sim, x + Math.floor(width / 2), y + Math.floor(height / 2), inside.length, 1, taken), group)
}

/**
 * Освобождает прямоугольник в тайлах под здание игрока player и говорит, свободен ли он. Свои стоящие юниты
 * с evict уходят сами; тех, кто едет, не трогают: проедут. Чужих остаётся только ждать.
 * ignore — кто не в счёт вовсе; stays — кого не выгонять, хотя место он занимает.
 */
export function clearGround(
  sim: Sim, player: number, x: number, y: number, width: number, height: number,
  evict: boolean, ignore?: Entity, stays?: (entity: Entity) => boolean,
) {
  const inside = unitsIn(sim, x, y, width, height).filter((entity) => entity !== ignore)
  if (!inside.length) return true
  if (evict) {
    const own = inside.filter((entity) => isOwn(sim, player, entity) && !sim.world.has(entity, Path) && !stays?.(entity))
    evictUnits(sim, x, y, width, height, own)
  }
  return false
}
