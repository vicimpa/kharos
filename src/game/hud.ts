import type { AlertKind } from './alerts'
import type { Replica } from '../net/replica'
import { knownReserve } from './knownReserve'
import type { Entity } from '../ecs'
import {
  Assembly, Harvester, BUILDABLE, isUnlocked, buyPrice, roomFor, BUILDINGS, Building, Converting, Hauler, Health, CORE, GOODS, PRODUCT_SPECS, REFINE_RATE, RESOURCES, RESOURCE_SPECS, buildingSpec, cycleSeconds, isOwn, missingRequirements, producibleBy, productStock, hasRoom, Trade, Inventory, amountOf, loadOf, deliveredTo, stockOf, stockOfZone, zoneWith, Producer, QUEUE_LIMIT, Site, UNITS, UNIT_TYPES, Unit, unitSpec,
  awaitsMaterials, buildTicks, canDemolish, canFight, canDeploy, canPack, depositAt, depositNear, DEPOSIT_SIZE, entriesOf, isDeployBlocked, creditsOf, economyOf, isSiteBlocked, materialsFor, reserveLeft, powerOf, powerStates, refundOf, repairCostOf, rewardsOf, siteTicks, spareOf, zoneEconomies, zonesOf,
  Off, Position, Tactics, isDefeated, stanceOf, type Stance, type Amounts, type BuildingType, type Command, type DepositKind, type Good, type Ore, type Product, type Resource, type UnitType,
} from '../sim'
import { paveStrokeOf } from './placing'
import type { PaveTool, Scene } from './scene'

/** Что интерфейс игрока показывает прямо сейчас. Обычные данные: их можно сравнивать и хранить в состоянии. */
export interface HudState {
  credits: number
  /** Уведомления, от старых к новым: at — когда, по нему строка узнаётся между опросами. */
  alerts: { kind: AlertKind; text: string; x: number; y: number; at: number }[]
  /**
   * Месторождение под указателем мыши на карте: что в нём, сколько осталось и где указатель на экране,
   * чтобы подсказка встала рядом. null — указатель не над месторождением.
   */
  hover: { kind: DepositKind; left: number | null; x: number; y: number } | null
  /** Награды, которые игрок уже получил, по порядку. */
  rewards: string[]
  /** Время суток в мире, «чч:мм», и идёт ли непогода. */
  clock: string
  storm: boolean
  /** Кто ещё на сервере: ники, свой ли, подключён ли. Пусто в локальной игре. */
  players: { name: string; own: boolean; online: boolean }[]
  /** Пришёл ли мир от хоста: до этого наград ноль не потому, что их нет, а потому, что мира ещё нет. */
  loaded: boolean
  /** Игрок проиграл: у него не осталось ни зданий, ни MCV. */
  defeated: boolean
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
  /**
   * Тактика выбранных бойцов: кому слать стойку и патруль; stance — общая стойка или null, если у них разные;
   * patrolling — сколько из них в патруле; picking — игрок выбирает точку патруля.
   */
  tactics: { units: number[]; stance: Stance | null; patrolling: number; picking: boolean } | null
  /** Выбранное здание, если выбрано оно. */
  building: BuildingType | null
  /** Месторождение под выбранной шахтой: что в нём и сколько осталось. */
  deposit: { kind: DepositKind; left: number } | null
  /** Запас игрока во всех хранилищах; null — хранить негде. */
  stock: { items: Stack[]; capacity: number } | null
  /** Склад выбранного здания: что в нём, сколько помещается всего; store — это хранилище. */
  stored: { items: Stack[]; capacity: number; store: boolean; buffer: boolean; slots: { resource: Good; amount: number; of: number }[] | null } | null
  /** Переработка: какую руду она принимает и сколько в секунду. */
  refinery: { ore: Ore; intake: number } | null
  /**
   * Завод изделий: что собирает, включён ли, готовность нынешней сборки от 0 до 1 и сколько изделия уже
   * есть у зоны; inputs — из чего одна сборка, yield — сколько штук она даёт и за сколько секунд.
   */
  /** Выбранное своё готовое здание — потребитель энергии, кроме завода изделий: его можно выключить. */
  switchable: { building: number; on: boolean } | null
  assembly: {
    plant: number
    recipe: Product
    on: boolean
    progress: number
    have: number
    /** Готовому некуда лечь: хранилища полны, цех стоит. */
    full: boolean
    inputs: Stack[]
    yield: number
    seconds: number
  } | null
  /**
   * Свои харвестеры среди выбранных: кто они, что копают, что ищут (общее у всех, иначе null) и стоят ли все без дела.
   */
  harvest: { units: number[]; kind: DepositKind | null; seek: DepositKind | 'any' | null; parked: boolean } | null
  /** Боеприпасы выбранной турели: сколько есть и сколько помещается. */
  ammo: { have: number; capacity: number } | null
  /**
   * Материалы, которых ждёт выбранная стройка или первый заказ выбранного производителя: сколько нужно и сколько
   * уже на месте. waiting — работа стоит, пока их не привезут.
   */
  materials: { items: { resource: Good; have: number; need: number }[]; waiting: boolean } | null
  /**
   * Продажа, если выбран свой готовый космопорт. offers — что лежит в хранилищах его зоны и почём.
   * order — открытая заявка: что и сколько продаётся, сколько уже привезли; flight — готовность полёта от 0 до 1,
   * null — корабль ещё грузится.
   */
  trade: {
    port: number
    offers: { resource: Resource; available: number; price: number }[]
    /** Закупка с орбиты: почём каждый ресурс и сколько единиц влезет в склад космопорта. */
    purchases: { resource: Resource; price: number; room: number }[]
    /** buy — это закупка: деньги уже отданы, корабль летит с грузом. */
    order: { resource: Resource; wanted: number; delivered: number; price: number; flight: number | null; buy: boolean } | null
  } | null
  /** Груз выбранных грузовиков вместе; bound — сколько из них привязано к шахте, busy — сколько заняты работой. */
  cargo: { items: Stack[]; capacity: number; bound: number; busy: number } | null
  /**
   * Выбранные грузовики (не харвестеры): кому слать маршрут и фильтр. routed — сколько из них ездят по маршруту,
   * filter — фильтр первого из них, routing — сколько остановок игрок уже набрал, null — не набирает.
   */
  haul: { units: number[]; routed: number; served: number; filter: Good[]; routing: number | null; serving: number | null } | null
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
    /** Здание, для которого сейчас выбирается место. */
    placing: BuildingType | null
    /** Покрытие, которое сейчас кладут или снимают, и во что обойдётся протянутое мышью. */
    paving: { tool: PaveTool; cost: number; tiles: number; short: number } | null
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
    /** Здание, а не MCV: ему можно поставить точку сбора. rally — она, если поставлена. */
    building: boolean
    rally: boolean
    options: { unit: UnitType; cost: number; affordable: boolean; materials: Stack[]; missing: BuildingType[] }[]
  } | null
}

/** Сколько груза: для списков в интерфейсе. */
export interface Stack {
  resource: Good
  amount: number
}

/** Груз списком в порядке GOODS, без нулей; доли округляются вниз. Руда показывается рядом с готовым. */
const stacksOf = (amounts: Amounts): Stack[] =>
  GOODS.filter((resource) => (amounts[resource] ?? 0) >= 1).map((resource) => ({ resource, amount: Math.floor(amounts[resource]!) }))

/** Готовые ресурсы списком: для продажи и материалов, куда руда не идёт. */
const resourceStacksOf = (amounts: Amounts): { resource: Resource; amount: number }[] =>
  RESOURCES.filter((resource) => (amounts[resource] ?? 0) >= 1).map((resource) => ({ resource, amount: Math.floor(amounts[resource]!) }))

/** То же для цен в материалах: без округления. */
const exactOf = (amounts: Amounts): Stack[] => entriesOf(amounts).map(([resource, amount]) => ({ resource, amount }))

const round = (value: number) => Math.round(value * 100) / 100

/** Месторождение под указателем мыши, см. HudState.hover. */
function hoverOf(scene: Scene): HudState['hover'] {
  const { camera, sim } = scene
  const tile = camera.pointerTile
  if (!tile || !camera.pointer) return null
  // Месторождение занимает DEPOSIT_SIZE × DEPOSIT_SIZE тайлов: подходит то, что накрывает тайл под указателем.
  const spot = depositNear(sim, tile.x + 0.5, tile.y + 0.5, DEPOSIT_SIZE)
  const covers = spot && tile.x >= spot.x && tile.x < spot.x + DEPOSIT_SIZE && tile.y >= spot.y && tile.y < spot.y + DEPOSIT_SIZE
  if (!spot || !covers) return null
  // В тумане — остаток, каким его видели в последний раз: чужую добычу сквозь туман не видно.
  const left = knownReserve(sim, scene.player, spot)
  return { kind: spot.kind, left: left === null ? null : Math.floor(left), x: camera.pointer.x, y: camera.pointer.y }
}

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
  let refinery: HudState['refinery'] = null
  let assembly: HudState['assembly'] = null
  let switchable: HudState['switchable'] = null
  let harvest: HudState['harvest'] = null
  let ammo: HudState['ammo'] = null
  let materials: HudState['materials'] = null
  let cargo: HudState['cargo'] = null
  let haul: HudState['haul'] = null
  let tactics: HudState['tactics'] = null
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
      if (canFight(sim, entity)) {
        armed++
        const stance = stanceOf(sim, entity)
        tactics ??= { units: [], stance, patrolling: 0, picking: scene.patrolling }
        tactics.units.push(entity)
        if (tactics.stance !== stance) tactics.stance = null
        if (world.get(entity, Tactics)?.patrol.length) tactics.patrolling++
      }
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
      for (const resource of GOODS) items[resource] = (items[resource] ?? 0) + amountOf(inventory, resource)
      cargo.items = stacksOf(items)
      cargo.capacity += inventory.capacity
      if (hauler.mine >= 0) cargo.bound++
      else if (hauler.from >= 0 || hauler.to >= 0 || hauler.route.length || hauler.serve.length) cargo.busy++
      if (!world.has(entity, Harvester)) {
        haul ??= { units: [], routed: 0, served: 0, filter: [...hauler.filter], routing: scene.routing ? scene.routing.length : null, serving: scene.serving ? scene.serving.length : null }
        haul.units.push(entity)
        if (hauler.route.length) haul.routed++
        if (hauler.serve.length) haul.served++
      }
    }
    const built = world.get(entity, Building)
    const ready = !!built && !world.has(entity, Site)
    const spec = built && buildingSpec(built.type)
    // У турели на складе только патроны: их показывает своя строка.
    // Буфер производителя — не склад: показываем его, только пока там лежат материалы заказа.
    const buffer = !!spec && !spec.inventory
    if (ready && inventory && !spec!.ammo && !(buffer && loadOf(inventory) <= 0)) {
      // У переработок и цехов у каждого груза своё место: показываем, сколько в каждом из скольких.
      const slots = inventory.accepts.length && inventory.accepts.every((good) => inventory.limits[good] !== undefined)
        ? inventory.accepts.map((good) => ({ resource: good, amount: Math.floor(amountOf(inventory, good)), of: inventory.limits[good]! }))
        : null
      stored = { items: stacksOf(inventory.items), capacity: inventory.capacity, store: !!spec!.stores, buffer, slots }
    }
    if (ready && spec!.refines) refinery = { ore: spec!.refines, intake: REFINE_RATE }
    const digging = world.get(entity, Harvester)
    if (digging && isOwn(sim, player, entity)) {
      const first: boolean = !harvest
      harvest ??= { units: [], kind: null, seek: digging.seek || null, parked: true }
      harvest.units.push(entity)
      if (digging.x >= 0) harvest.kind = depositAt(sim, digging.x, digging.y)?.kind ?? harvest.kind
      if (!first && harvest.seek !== (digging.seek || null)) harvest.seek = null
      harvest.parked &&= digging.parked
    }
    if (ready && spec!.ammo && inventory) ammo = { have: Math.floor(amountOf(inventory, 'ammo')), capacity: inventory.capacity }
    if (ready && (spec!.power ?? 0) < 0 && !world.has(entity, Assembly) && isOwn(sim, player, entity)) {
      switchable = { building: entity, on: !world.has(entity, Off) }
    }
    const assembling = ready ? world.get(entity, Assembly) : undefined
    if (assembling && isOwn(sim, player, entity)) {
      const spec = PRODUCT_SPECS[assembling.recipe]
      assembly = {
        plant: entity,
        recipe: assembling.recipe,
        on: assembling.on,
        progress: round(Math.min(1, assembling.progress / cycleSeconds(assembling.recipe))),
        have: Math.floor(productStock(sim, entity)),
        full: !hasRoom(sim, entity),
        inputs: exactOf(spec.recipe),
        yield: spec.yield,
        seconds: cycleSeconds(assembling.recipe),
      }
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
        offers: resourceStacksOf(items).map(({ resource, amount }) => ({ resource, available: amount, price: RESOURCE_SPECS[resource].price })),
        purchases: RESOURCES.map((resource) => ({
          resource,
          price: buyPrice(resource),
          room: Math.floor(roomFor(world.get(entity, Inventory)!, resource)),
        })),
        order: order
          ? {
              resource: order.resource,
              wanted: Math.round(order.wanted),
              delivered: Math.floor(deliveredTo(sim, entity)),
              price: order.buy ? buyPrice(order.resource) : RESOURCE_SPECS[order.resource].price,
              flight: order.total ? round(1 - order.left / order.total) : null,
              buy: order.buy,
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
    hover: hoverOf(scene),
    rewards: [...rewardsOf(sim, player)],
    loaded: sim.time.tick > 0,
    defeated: sim.time.tick > 0 && isDefeated(sim, player),
    // Минуты — десятками: интерфейс перерисовывается, только когда состояние изменилось.
    clock: `${String(Math.floor(scene.weather.hour)).padStart(2, '0')}:${Math.floor((scene.weather.hour % 1) * 6)}0`,
    storm: scene.weather.precipitation > 0.05,
    alerts: (scene.alerts?.current() ?? []).map(({ kind, text, x, y, at }) => ({ kind, text, x, y, at })),
    // Список игроков есть только у копии мира с сервера.
    players: 'players' in sim ? (sim as Replica).players.map(({ player, name, online }) => ({ name, own: player === scene.player, online })) : [],
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
    refinery,
    assembly,
    switchable,
    harvest,
    ammo,
    materials,
    trade,
    cargo,
    haul,
    tactics,
    site,
    demolish,
    construction: counts.has('builder')
      ? {
          placing: scene.placing,
          paving: pavingOf(scene),
          options: BUILDABLE.filter((type) => isUnlocked(sim, player, type)).map((type) => ({
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
    building: !isUnit,
    rally: producer.rally.length > 0,
    options: producibleBy(sim, entity).map((unit) => ({
      unit,
      cost: UNITS[unit].cost,
      affordable: credits >= UNITS[unit].cost,
      materials: exactOf(unitSpec(unit).materials ?? {}),
      missing: missingRequirements(sim, player, unit),
    })),
  }
  return state
}

/** Укладка покрытия, которую игрок тянет мышью: инструмент, цена и сколько тайлов ляжет. */
function pavingOf(scene: Scene): NonNullable<HudState['construction']>['paving'] {
  if (!scene.paving) return null
  const stroke = paveStrokeOf(scene)
  return { tool: scene.paving, cost: stroke?.cost ?? 0, tiles: stroke ? stroke.allowed.filter(Boolean).length : 0, short: stroke ? stroke.short.filter(Boolean).length : 0 }
}
