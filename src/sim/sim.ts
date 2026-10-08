import { Loop, World, type System, type Time, type WorldSnapshot } from '../ecs'
import type { WeatherOptions } from './weather'
import { areaOf, createLand, loadLand, saveLand, type GeneratorConfig, type Land } from '../map/terrain'
import { createLandMemory, saveLandMemory, updateLandMemory, type LandMemory, type LandMemorySave } from './landMemory'
import { buildingSpec, createOccupancy, type Occupancy } from './buildings'
import { fight, recover } from './combat'
import { assemble } from './assembly'
import { apply, type Command } from './commands'
import { Building, Carrier, Inventory, Position, SAVED, Site, Unit } from './components'
import { mountTurrets } from './turrets'
import { adoptLegacyDeposits, createDeposits, saveDeposits, type DepositLayer, type DepositsSave } from './deposits'
import { unitSpec } from './units'
import type { Entity } from '../ecs'
import { REPAIR_COST, REPAIR_PAUSE, REPAIR_SPEED, construct } from './construction'
import { convert } from './conversion'
import { harvest } from './harvesting'
import { haul } from './hauling'
import { earn } from './income'
import { trade } from './trade'
import { moveUnits, planPaths } from './movement'
import { produceUnits } from './production'
import { refine } from './refining'
import { followCarriers, restTurrets } from './turrets'
import { createPaving, type Paving } from './paved'
import { createTraces, type Traces } from './traces'
import { createVision, type Vision } from './vision'
import { followOrders } from './orders'
import { patrol } from './tactics'

/** Границы карты в тайлах. Правая и нижняя — не включая. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** Числа правил, которые можно менять на ходу, не начиная мир заново. */
export interface Rules {
  /** Во сколько раз чинить быстрее, чем строить. Ноль — ремонта нет. */
  repairSpeed: number
  /** Какую долю цены здания или юнита стоит починить его с нуля до целого. */
  repairCost: number
  /** Сколько секунд после попадания цель не чинится: ремонт — между боями, а не под огнём. Ноль — чинят и под огнём. */
  repairPause: number
  /** Дерево технологий: здание строится, когда стоят нужные для него, см. REQUIRES. Выключено — открыто всё. */
  techTree: boolean
  /**
   * Замедление наземных юнитов по местности, доля скорости от 0 до 1: колёсная техника (vehicle), гусеничная
   * (heavy) и пехота — на песке и на болоте. По скале все идут в полную силу, летающим местность не мешает.
   */
  vehicleSand: number
  vehicleSwamp: number
  heavySand: number
  heavySwamp: number
  infantrySand: number
  infantrySwamp: number
  /** Замедление пехоты у подножия обрыва: она лезет, технике же туда нельзя вовсе. */
  infantryCliff: number
  /** Какая доля болотного замедления остаётся на солончаках: там болото промёрзло. */
  frozenSwamp: number
  /** Какую долю прочности в секунду теряет наземный юнит в едком болоте красных пустошей. */
  toxicSwamp: number
  /**
   * Доход игрока не в сети: offlineIncome — доля обычного, offlineMinutes — потолок за одно отсутствие, в минутах
   * обычного дохода. Без дохода совсем вернувшегося ждала бы неотремонтированная база: починка тратит кредиты.
   */
  offlineIncome: number
  offlineMinutes: number
}

export const DEFAULT_RULES: Rules = {
  repairSpeed: REPAIR_SPEED,
  repairCost: REPAIR_COST,
  repairPause: REPAIR_PAUSE,
  techTree: true,
  vehicleSand: 0.1,
  vehicleSwamp: 0.8,
  heavySand: 0,
  heavySwamp: 0.5,
  infantrySand: 0,
  infantrySwamp: 0.5,
  infantryCliff: 0.7,
  frozenSwamp: 0.25,
  toxicSwamp: 0.01,
  offlineIncome: 0.2,
  offlineMinutes: 30,
}

export interface SimOptions {
  generator: GeneratorConfig
  /** Сторона карты в тайлах. Карта — квадрат с центром в начале координат. */
  size: number
  /** Правила; чего нет — по умолчанию. */
  rules?: Partial<Rules>
  /** Туман войны; false — каждый видит всю карту и всё на ней. По умолчанию включён. */
  fog?: boolean
  /** Смена дня и ночи и непогода; чего нет — по умолчанию. См. weather.ts. */
  weather?: Partial<WeatherOptions>
}

/** Сохранение симуляции. Обычные данные: их можно положить в JSON, на диск или отправить по сети. */
/**
 * Версия формата сохранения. Меняется, когда старые сохранения перестают подходить: тогда они отбрасываются.
 * 16 — руда: шахты кладут в свой склад руду, а не готовый ресурс, и в старых сохранениях она осталась бы там навсегда.
 * 17 — изделия: склады хранилищ помнят, что принимают, и в старых сохранениях не взяли бы стройблоки и боеприпасы;
 * у старых турелей нет склада патронов.
 * 19 — хранилища под каждый ресурс: общего хранилища больше нет.
 * 20 — двоичный файл, см. src/save/file.ts, и в нём карта мира. С неё старые сохранения поднимаются миграциями, а не
 * отбрасываются.
 */
export const SAVE_VERSION = 20

export interface SimSave extends SimOptions {
  version: typeof SAVE_VERSION
  tick: number
  world: WorldSnapshot
  /** Разведанное каждым игроком, см. Vision.map. В старых сохранениях его нет: там карта начинается закрытой. */
  explored?: Record<string, number[]>
  /** Карта мира, см. saveLand: с ней мир не зависит от того, каким стал генератор. */
  land: Uint8Array
  /** Что игроки знают о правках карты, см. landMemory.ts. */
  landMemory?: LandMemorySave
  /** Месторождения, см. DepositLayer. В прежних сохранениях их нет: клетки досчитает генератор. */
  deposits?: DepositsSave
}

/**
 * Симуляция — вся игра без картинки и ввода: мир, местность, правила. Не знает про браузер,
 * поэтому одинаково работает в клиенте, в Web Worker и на сервере. Снаружи на неё влияют только
 * команды (send) и ход времени (advance); всё остальное клиент лишь читает.
 */
export interface Sim {
  readonly options: SimOptions
  readonly bounds: Bounds
  readonly world: World
  readonly land: Land
  /** Что игроки знают о правках карты: правки в тумане игрок узнаёт, только увидев. */
  readonly landMemory: LandMemory
  /** Месторождения: слой карты, см. deposits.ts. */
  readonly deposits: DepositLayer
  readonly occupancy: Occupancy
  /** Какое покрытие — фундамент, дорога, мост — лежит на каком тайле. См. paving.ts. */
  readonly paving: Paving
  /** Что видит каждый игрок: по ней хост решает, что слать клиенту, а клиент рисует туман. */
  readonly vision: Vision
  /** Следы на земле: колеи, гарь, остовы. См. traces.ts. */
  readonly traces: Traces
  /** Правила. Поля можно менять на ходу: со следующего тика симуляция считает по новым. */
  readonly rules: Rules
  /** Кто из игроков сейчас в сети; null — все: локальная игра. Задаёт сервер, см. host.ts. */
  online: ReadonlySet<number> | null
  /** Время симуляции. alpha — доля тика, прошедшая после последнего: ею клиент сглаживает движение. */
  readonly time: Time
  /** Ставит команду игрока player в очередь. Она выполнится в начале следующего тика. */
  send(player: number, command: Command): void
  /** Продвигает симуляцию на seconds реального времени. Возвращает число сделанных тиков. */
  advance(seconds: number): number
  save(): SimSave
  destroy(): void
}

/** Границы квадратной карты со стороной size и центром в начале координат. */
export function boundsOf(size: number): Bounds {
  const half = Math.floor(size / 2)
  return { left: -half, top: -half, right: size - half, bottom: size - half }
}

/** Создаёт симуляцию: новую или, если передано сохранение, продолжает его. */
export function createSim(source: SimOptions | SimSave): Sim {
  const rules: Rules = { ...DEFAULT_RULES, ...source.rules }
  // Правила в сохранение попадают такими, какие они на момент сохранения.
  const options: SimOptions = { generator: source.generator, size: source.size, rules, ...(source.fog === false && { fog: false }), ...(source.weather && { weather: source.weather }) }
  const bounds = boundsOf(options.size)

  const world = new World()
  const queue: { player: number; command: Command }[] = []

  /** Первая система тика: выполняет команды, накопившиеся с прошлого тика. */
  const commands: System = () => {
    // Команда, посланная во время выполнения другой, дождётся следующего тика.
    for (const { player, command } of queue.splice(0)) apply(sim, player, command)
  }

  // Порядок систем — порядок событий внутри тика. Новые системы симуляции добавляются сюда.
  const loop = new Loop({
    world,
    tick: 'tick' in source ? source.tick : 0,
    update: [
      commands,
      () => convert(sim),
      (_, time) => produceUnits(sim, time),
      // После производства и до движения: переработка превращает привезённую руду в готовое, грузовики развезут его.
      (_, time) => refine(sim, time),
      // Цеха собирают изделия из привезённого сырья.
      (_, time) => assemble(sim, time),
      // До движения: едущие к цели напрямую получают пути, сколько успеет поиск за тик.
      () => planPaths(sim),
      (_, time) => moveUnits(sim, time),
      // Турели встают на носители, уже сдвинувшиеся за этот тик.
      () => followCarriers(sim),
      // После движения: работающий строитель поворачивается к стройке, и поворот сглаживается, как у идущих.
      () => construct(sim),
      () => harvest(sim),
      () => haul(sim),
      () => trade(sim),
      // После движения и работ: стреляющий юнит поворачивается к цели, и погибшие в этот тик уже ничего не делают.
      () => fight(sim),
      // После боя: вставшие без цели продолжают патруль или возвращаются на место.
      () => patrol(sim),
      // После всех дел тика: освободившиеся берут следующий приказ из очереди.
      () => followOrders(sim),
      // После работ и боя: кому не досталось ни того, ни другого, — те турели разворачиваются по корпусу.
      () => restTurrets(sim),
      () => recover(sim),
      () => earn(sim),
      () => sim.traces.update(),
      () => sim.vision.update(),
      // После обзора: игроки узнают правки карты, которые теперь видят.
      () => updateLandMemory(sim),
    ],
  })
  const sim: Sim = {
    options,
    bounds,
    world,
    land: 'land' in source ? loadLand(options.generator, source.land) : createLand(options.generator, areaOf(bounds)),
    landMemory: createLandMemory('landMemory' in source ? source.landMemory : undefined),
    deposits: createDeposits('deposits' in source ? source.deposits : undefined),
    occupancy: createOccupancy(world),
    paving: createPaving(world),
    vision: createVision(world, bounds, () => loop.time.tick, options.fog !== false),
    traces: createTraces(world, () => loop.time.tick, loop.time.step),
    rules,
    online: null,
    time: loop.time,
    send(player, command) {
      queue.push({ player, command })
    },
    advance: (seconds) => loop.advance(seconds),
    save: () => ({
      version: SAVE_VERSION,
      ...options,
      tick: loop.time.tick,
      world: world.snapshot(SAVED),
      explored: Object.fromEntries(sim.vision.players().map((player) => [player, sim.vision.map(player)])),
      land: saveLand(sim.land),
      ...(sim.landMemory.original.size && { landMemory: saveLandMemory(sim.landMemory) }),
      deposits: saveDeposits(sim.deposits),
    }),
    destroy() {
      sim.occupancy.destroy()
      sim.paving.destroy()
      world.clear()
    },
  }

  if ('world' in source) {
    world.restore(source.world, SAVED)
    refreshStorage(sim)
    remount(sim)
    adoptLegacyDeposits(sim)
    for (const [player, map] of Object.entries(source.explored ?? {})) sim.vision.explore(Number(player), map)
  }
  return sim
}

/**
 * Турели, положенные виду, но которых нет: их дали виду позже, чем записано сохранение (так MCV получил пушку
 * на крыше). Юниты и здания с турелями сохраняются вместе с ними, поэтому ставятся только недостающие.
 */
function remount(sim: Sim) {
  const { world } = sim
  const bare: Entity[] = []
  for (const [entity] of world.query(Position)) {
    if (world.has(entity, Carrier) || world.has(entity, Site)) continue
    const unit = world.get(entity, Unit)
    const building = unit ? undefined : world.get(entity, Building)
    const mounts = unit ? unitSpec(unit.type).mounts : building ? buildingSpec(building.type).mounts : undefined
    if (mounts?.length) bare.push(entity)
  }
  for (const entity of bare) mountTurrets(world, entity)
}

/**
 * Склад здания сохраняется целиком, вместе с объёмом и пределами, и старое сохранение принесло бы прежние числа.
 * После загрузки они берутся из нынешнего описания здания; лишнее сверх нового предела не пропадает, а уходит
 * само, когда его развезут. Стройки не трогаются: их склад — под материалы.
 */
function refreshStorage(sim: Sim) {
  for (const [entity, building, inventory] of sim.world.query(Building, Inventory)) {
    if (sim.world.has(entity, Site)) continue
    const spec = buildingSpec(building.type)
    if (!spec.inventory) continue
    inventory.capacity = spec.inventory
    inventory.accepts = spec.accepts ?? []
    inventory.limits = { ...spec.limits }
  }
}
