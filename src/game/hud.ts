import type { Entity } from '../ecs'
import {
  BUILDABLE, BUILDINGS, Building, Converting, Hauler, Health, CORE, RESOURCES, RESOURCE_SPECS, buildingSpec, isOwn, producibleBy, Trade, Inventory, amountOf, deliveredTo, stockOf, stockOfZone, zoneWith, Producer, QUEUE_LIMIT, Site, UNITS, UNIT_TYPES, Unit, unitSpec,
  awaitsMaterials, buildTicks, canDemolish, canFight, canDeploy, canPack, depositAt, entriesOf, isDeployBlocked, coreCenters, creditsOf, economyOf, isSiteBlocked, materialsFor, reserveLeft, powerOf, powerStates, refundOf, repairCostOf, rewardsOf, siteTicks, spareOf, zoneEconomies, zonesOf,
  Position, type Amounts, type BuildingType, type Command, type DepositKind, type Resource, type UnitType,
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
  /** Месторождение под выбранной шахтой: что в нём и сколько осталось. */
  deposit: { kind: DepositKind; left: number } | null
  /** Запас игрока во всех хранилищах; null — хранить негде. */
  stock: { items: Stack[]; capacity: number } | null
  /** Склад выбранного здания: что в нём, сколько помещается всего; store — это хранилище. */
  stored: { items: Stack[]; capacity: number; store: boolean } | null
  /**
   * Материалы, которых ждёт выбранная стройка или первый заказ выбранного производителя: сколько нужно и сколько
   * уже на месте. waiting — работа стоит, пока их не привезут.
   */
  materials: { items: { resource: Resource; have: number; need: number }[]; waiting: boolean } | null
  /**
   * Продажа, если выбран свой готовый космопорт. offers — что лежит в хранилищах его зоны и почём.
   * order — открытая заявка: что и сколько продаётся, сколько уже привезли; flight — готовность полёта от 0 до 1,
   * null — корабль ещё грузится.
   */
  trade: {
    port: number
    offers: { resource: Resource; available: number; price: number }[]
    order: { resource: Resource; wanted: number; delivered: number; price: number; flight: number | null } | null
  } | null
  /** Груз выбранных грузовиков вместе; bound — сколько из них привязано к шахте, busy — сколько заняты работой. */
  cargo: { items: Stack[]; capacity: number; bound: number; busy: number } | null
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
    /** power — как здание изменит баланс энергии: больше нуля — даст, меньше — попросит; materials — что привезти на стройку. */
    options: { building: BuildingType; cost: number; affordable: boolean; power: number; materials: Stack[] }[]
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
    options: { unit: UnitType; cost: number; affordable: boolean; materials: Stack[] }[]
  } | null
}

/** Сколько ресурса: для списков в интерфейсе. */
export interface Stack {
  resource: Resource
  amount: number
}

/** Ресурсы списком в порядке RESOURCES, без нулей; доли округляются вниз. */
const stacksOf = (amounts: Amounts): Stack[] =>
  RESOURCES.filter((resource) => (amounts[resource] ?? 0) >= 1).map((resource) => ({ resource, amount: Math.floor(amounts[resource]!) }))

/** То же для цен в материалах: без округления. */
const exactOf = (amounts: Amounts): Stack[] => entriesOf(amounts).map(([resource, amount]) => ({ resource, amount }))

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
  let deposit: HudState['deposit'] = null
  let stored: HudState['stored'] = null
  let materials: HudState['materials'] = null
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
      const spot = depositAt(sim, position.x, position.y)
      if (spot) deposit = { kind: spot.kind, left: Math.floor(reserveLeft(sim, position.x, position.y)) }
    }
    if (building !== null && (buildingSpec(building).power ?? 0) > 0) {
      // Недостроенная и отрезанная от зоны электростанция ни в какую зону не входит — показывать нечего.
      const zone = zonesOf(sim, player).findIndex((zone) => zone.buildings.includes(entity))
      if (zone >= 0) power = { produced: Math.round(zones[zone].produced * 10) / 10, demand: zones[zone].demand }
    }
    const hauler = world.get(entity, Hauler)
    const inventory = world.get(entity, Inventory)
    if (hauler && inventory) {
      cargo ??= { items: [], capacity: 0, bound: 0, busy: 0 }
      const items: Amounts = Object.fromEntries(cargo.items.map(({ resource, amount }) => [resource, amount]))
      for (const resource of RESOURCES) items[resource] = (items[resource] ?? 0) + amountOf(inventory, resource)
      cargo.items = stacksOf(items)
      cargo.capacity += inventory.capacity
      if (hauler.mine >= 0) cargo.bound++
      else if (hauler.from >= 0 || hauler.to >= 0) cargo.busy++
    }
    const built = world.get(entity, Building)
    const ready = !!built && !world.has(entity, Site)
    if (ready && inventory) {
      stored = { items: stacksOf(inventory.items), capacity: inventory.capacity, store: !!buildingSpec(built!.type).stores }
    }
    const wanted = materialsFor(sim, entity)
    if (wanted && isOwn(sim, player, entity)) {
      const site = world.has(entity, Site)
      materials = {
        items: entriesOf(wanted).map(([resource, need]) => ({ resource, need, have: Math.floor(Math.min(need, spareOf(sim, entity, resource))) })),
        waiting: site ? awaitsMaterials(sim, entity) : entriesOf(wanted).some(([resource, need]) => spareOf(sim, entity, resource) < need - 1e-9),
      }
    }
    if (ready && buildingSpec(built!.type).trades && isOwn(sim, player, entity)) {
      const zone = zoneWith(sim, player, entity)
      const order = world.get(entity, Trade)
      const items = zone ? stockOfZone(sim, zone).items : {}
      trade = {
        port: entity,
        offers: stacksOf(items).map(({ resource, amount }) => ({ resource, available: amount, price: RESOURCE_SPECS[resource].price })),
        order: order
          ? {
              resource: order.resource,
              wanted: Math.round(order.wanted),
              delivered: Math.floor(deliveredTo(sim, entity)),
              price: RESOURCE_SPECS[order.resource].price,
              flight: order.total ? round(1 - order.left / order.total) : null,
            }
          : null,
      }
    }
    const record = world.get(entity, Health)
    const left = record?.value ?? 1
    const max = record?.max ?? 1
    if (built && left < max) {
      health = round(left / max)
      repair = repairCostOf(BUILDINGS[built.type].cost, left, sim.rules.repairCost, max)
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
    deposit,
    stock: stock.capacity ? { items: stacksOf(stock.items), capacity: stock.capacity } : null,
    stored,
    materials,
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
            materials: exactOf(buildingSpec(type).materials ?? {}),
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
    options: producibleBy(sim, entity).map((unit) => ({
      unit,
      cost: UNITS[unit].cost,
      affordable: credits >= UNITS[unit].cost,
      materials: exactOf(unitSpec(unit).materials ?? {}),
    })),
  }
  return state
}
