import type { Entity } from '../ecs'
import {
  BUILDABLE, BUILDINGS, Building, Converting, Hauler, Health, ORE_PRICE, CORE, buildingSpec, isOwn, producibleBy, TRUCK_CAPACITY, Trade, stockOf, stockOfZone, zoneWith, Producer, QUEUE_LIMIT, Site, UNITS, UNIT_TYPES, Unit,
  buildTicks, canDemolish, canFight, canDeploy, canPack, isDeployBlocked, coreCenters, creditsOf, economyOf, isSiteBlocked, oreLeft, powerOf, powerStates, refundOf, repairCostOf, rewardsOf, siteTicks, zoneEconomies, zonesOf,
  Position, type BuildingType, type Command, type UnitType,
} from '../sim'
import type { Scene } from './scene'

/** Что интерфейс игрока показывает прямо сейчас. Обычные данные: их можно сравнивать и хранить в состоянии. */
export interface HudState {
  credits: number
  /** Награды, которые игрок уже получил, по порядку. */
  rewards: string[]
  /** Доход в кредитах в секунду. */
  income: number
  /**
   * Энергия зоны строительства, в которой стоит выбранная электростанция: сколько вырабатывается и сколько
   * просят потребители. У каждой зоны она своя, поэтому общего счётчика нет.
   */
  power: { produced: number; demand: number } | null
  /** Прочность выбранного здания от 0 до 1, если оно повреждено, и сколько кредитов стоит его дочинить. */
  health: number | null
  repair: number
  /** Выбранному зданию не хватает энергии, и оно работает медленнее. */
  starved: boolean
  /** Выбранные юниты по видам. */
  units: { type: UnitType; count: number }[]
  /** Бой: сколько среди выбранных юнитов вооружённых и средняя прочность выбранных юнитов от 0 до 1. */
  army: { armed: number; health: number } | null
  /** Выбранное здание, если выбрано оно. */
  building: BuildingType | null
  /** Сколько руды осталось под выбранной шахтой. */
  ore: number | null
  /** Запас руды игрока во всех хранилищах; null — хранить негде. */
  stock: { ore: number; capacity: number } | null
  /** Запас выбранного хранилища. */
  stored: { ore: number; capacity: number } | null
  /**
   * Продажа, если выбран свой готовый космопорт. available — сколько руды в хранилищах его зоны, price — цена единицы.
   * order — открытая заявка: сколько руды продаётся и сколько уже привезли; flight — готовность полёта от 0 до 1,
   * null — корабль ещё грузится.
   */
  trade: {
    port: number
    available: number
    price: number
    order: { wanted: number; delivered: number; flight: number | null } | null
  } | null
  /** Груз выбранных грузовиков вместе; bound — сколько из них привязано к шахте. */
  cargo: { ore: number; capacity: number; bound: number } | null
  /** Стройка, если выбранное здание ещё не достроено. */
  site: {
    entity: number
    /** Строитель уже начал работу: до этого площадка только размечена. */
    started: boolean
    /** На ещё не начатой площадке стоят юниты: пока не уйдут, стройка не начнётся. */
    blocked: boolean
    /** Готовность от 0 до 1. */
    progress: number
    /** Здание разбирают: готовность идёт к нулю. */
    demolish: boolean
  } | null
  /** Разбор, если выбрано своё готовое здание, которое можно разобрать. refund — сколько кредитов вернётся. */
  demolish: { building: number; refund: number } | null
  /** Что можно построить, если среди выбранного есть строитель. */
  construction: {
    /** Есть ли у игрока главное здание: без него строить негде. */
    available: boolean
    /** Здание, для которого сейчас выбирается место. */
    placing: BuildingType | null
    /** power — как здание изменит баланс энергии: больше нуля — даст, меньше — попросит. */
    options: { building: BuildingType; cost: number; affordable: boolean; power: number }[]
  } | null
  /** Превращение выбранного: MCV разворачивается (deploy), главное здание сворачивается (pack). */
  conversion: {
    kind: 'deploy' | 'pack'
    command: Command
    /** Можно ли начать прямо сейчас. */
    possible: boolean
    /** Доля от 0 до 1, если превращение уже идёт; иначе null. */
    progress: number | null
    /** MCV готов развернуться, но под будущим зданием стоят юниты. */
    blocked: boolean
    /** Команда отмены, если идущее превращение можно отменить. */
    cancel: Command | null
  } | null
  /** Производство, если среди выбранного ровно один производитель: MCV или готовое здание, выпускающее юнитов. */
  production: {
    producer: number
    queue: UnitType[]
    /** Готовность первого заказа, от 0 до 1. */
    progress: number
    full: boolean
    options: { unit: UnitType; cost: number; affordable: boolean }[]
  } | null
}

const round = (value: number) => Math.round(value * 100) / 100

/** Собирает состояние интерфейса из симуляции и выделения. */
export function readHud(scene: Scene): HudState {
  const { sim, player, selection } = scene
  const { world } = sim
  const credits = creditsOf(sim, player)

  const counts = new Map<UnitType, number>()
  let building: BuildingType | null = null
  let site: HudState['site'] = null
  let demolish: HudState['demolish'] = null
  let ore: number | null = null
  let stored: HudState['stored'] = null
  let cargo: HudState['cargo'] = null
  let trade: HudState['trade'] = null
  let power: HudState['power'] = null
  let health: number | null = null
  let repair = 0
  let starved = false
  const zones = zoneEconomies(sim, player)
  const producers: Entity[] = []
  let armed = 0
  let unitHealth = 0
  let unitCount = 0
  for (const entity of selection) {
    const unit = world.get(entity, Unit)
    if (unit) {
      counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1)
      unitHealth += world.get(entity, Health)?.value ?? 1
      unitCount++
      if (canFight(sim, entity)) armed++
    }
    building = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type ?? building
    if (building !== null && buildingSpec(building).extract) {
      const position = world.get(entity, Position)!
      ore = Math.floor(oreLeft(sim, position.x, position.y))
    }
    if (building !== null && (buildingSpec(building).power ?? 0) > 0) {
      // Недостроенная и отрезанная от зоны электростанция ни в какую зону не входит — показывать нечего.
      const zone = zonesOf(sim, player).findIndex((zone) => zone.buildings.includes(entity))
      if (zone >= 0) power = { produced: Math.round(zones[zone].produced * 10) / 10, demand: zones[zone].demand }
    }
    const hauler = world.get(entity, Hauler)
    if (hauler) {
      cargo ??= { ore: 0, capacity: 0, bound: 0 }
      cargo.ore += Math.floor(hauler.ore)
      cargo.capacity += TRUCK_CAPACITY
      if (hauler.mine >= 0 || hauler.port >= 0) cargo.bound++
    }
    const built = world.get(entity, Building)
    const capacity = built && !world.has(entity, Site) ? buildingSpec(built.type).stores : undefined
    if (built && capacity) stored = { ore: Math.floor(built.ore), capacity }
    if (built && buildingSpec(built.type).trades && !world.has(entity, Site) && isOwn(sim, player, entity)) {
      const zone = zoneWith(sim, player, entity)
      const order = world.get(entity, Trade)
      trade = {
        port: entity,
        available: zone ? Math.floor(stockOfZone(sim, zone).ore) : 0,
        price: ORE_PRICE,
        order: order
          ? { wanted: Math.round(order.wanted), delivered: Math.floor(order.delivered), flight: order.total ? round(1 - order.left / order.total) : null }
          : null,
      }
    }
    const left = world.get(entity, Health)?.value ?? 1
    if (built && left < 1) {
      health = round(left)
      repair = repairCostOf(BUILDINGS[built.type].cost, left)
    }
    if (built && powerStates(sim).get(entity) === 'starved') starved = true
    const work = world.get(entity, Site)
    if (work) {
      const progress = round(Math.min(1, work.progress / siteTicks(work.type, sim.time.step)))
      site = { entity, started: world.has(entity, Building), blocked: isSiteBlocked(sim, entity), progress, demolish: work.demolish }
    }
    if (canDemolish(sim, player, entity)) demolish = { building: entity, refund: refundOf(world.get(entity, Building)!.type) }
    if (producibleBy(sim, entity).length) producers.push(entity)
  }

  // Кнопки стройки показывают энергию для первой зоны: в какую попадёт здание, до выбора места неизвестно.
  const economy = zones[0] ?? economyOf(sim, player)
  const stock = stockOf(sim, player)
  const state: HudState = {
    credits,
    rewards: [...rewardsOf(sim, player)],
    income: round(economyOf(sim, player).income),
    power,
    health,
    repair,
    starved,
    units: UNIT_TYPES.filter((type) => counts.has(type)).map((type) => ({ type, count: counts.get(type)! })),
    army: unitCount ? { armed, health: round(unitHealth / unitCount) } : null,
    building,
    ore,
    stock: stock.capacity ? { ore: Math.floor(stock.ore), capacity: stock.capacity } : null,
    stored,
    trade,
    cargo,
    site,
    demolish,
    construction: counts.has('builder')
      ? {
          available: coreCenters(sim, player).length > 0,
          placing: scene.placing,
          options: BUILDABLE.map((type) => ({
            building: type,
            cost: BUILDINGS[type].cost,
            affordable: credits >= BUILDINGS[type].cost,
            power: powerOf(type, economy),
          })),
        }
      : null,
    conversion: null,
    production: null,
  }
  if (producers.length !== 1) return state

  // Производитель один. У MCV и главного здания есть ещё и превращение.
  const [entity] = producers
  const converting = world.get(entity, Converting)
  const isUnit = world.has(entity, Unit)
  if (isUnit || world.get(entity, Building)?.type === CORE) state.conversion = {
    kind: isUnit ? 'deploy' : 'pack',
    command: isUnit ? { type: 'deploy', unit: entity } : { type: 'pack', building: entity },
    possible: isUnit ? canDeploy(sim, player, entity) : canPack(sim, player, entity),
    progress: converting ? round(1 - converting.left / converting.total) : null,
    blocked: isDeployBlocked(sim, entity),
    cancel: converting && isUnit ? { type: 'cancelDeploy', unit: entity } : null,
  }

  const producer = world.get(entity, Producer)!
  const [first] = producer.queue
  state.production = {
    producer: entity,
    queue: [...producer.queue],
    progress: first ? round(Math.min(1, producer.progress / buildTicks(first, sim.time.step))) : 0,
    full: producer.queue.length >= QUEUE_LIMIT,
    options: producibleBy(sim, entity).map((unit) => ({ unit, cost: UNITS[unit].cost, affordable: credits >= UNITS[unit].cost })),
  }
  return state
}
