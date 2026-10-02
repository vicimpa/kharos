import type { Entity } from '../ecs'
import {
  BUILDABLE, BUILDINGS, Building, Converting, PRODUCIBLE, Producer, QUEUE_LIMIT, Site, UNITS, UNIT_TYPES, Unit,
  atLimit, buildTicks, canDeploy, canPack, coreCenters, creditsOf, economyOf, rewardsOf, siteTicks,
  type BuildingType, type Command, type UnitType,
} from '../sim'
import type { Scene } from './scene'

/** Что интерфейс игрока показывает прямо сейчас. Обычные данные: их можно сравнивать и хранить в состоянии. */
export interface HudState {
  credits: number
  /** Награды, которые игрок уже получил, по порядку. */
  rewards: string[]
  /** Доход в кредитах в секунду. */
  income: number
  /** Энергия: сколько вырабатывается и сколько просят потребители. */
  power: { produced: number; demand: number }
  /** Выбранные юниты по видам. */
  units: { type: UnitType; count: number }[]
  /** Выбранное здание, если выбрано оно. */
  building: BuildingType | null
  /** Стройка, если выбранное здание ещё не достроено. */
  site: {
    entity: number
    /** Строитель уже начал работу: до этого площадка только размечена. */
    started: boolean
    /** Готовность от 0 до 1. */
    progress: number
  } | null
  /** Что можно построить, если среди выбранного есть строитель. */
  construction: {
    /** Есть ли у игрока главное здание: без него строить негде. */
    available: boolean
    /** Здание, для которого сейчас выбирается место. */
    placing: BuildingType | null
    /** limited — лимит на такие здания исчерпан. */
    options: { building: BuildingType; cost: number; affordable: boolean; limited: boolean }[]
  } | null
  /** Превращение выбранного: MCV разворачивается (deploy), главное здание сворачивается (pack). */
  conversion: {
    kind: 'deploy' | 'pack'
    command: Command
    /** Можно ли начать прямо сейчас. */
    possible: boolean
    /** Доля от 0 до 1, если превращение уже идёт; иначе null. */
    progress: number | null
  } | null
  /** Производство, если среди выбранного ровно один производитель. */
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
  const producers: Entity[] = []
  for (const entity of selection) {
    const unit = world.get(entity, Unit)
    if (unit) counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1)
    building = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type ?? building
    const work = world.get(entity, Site)
    if (work) {
      const progress = round(Math.min(1, work.progress / siteTicks(work.type, sim.time.step)))
      site = { entity, started: world.has(entity, Building), progress }
    }
    if (world.has(entity, Producer)) producers.push(entity)
  }

  const economy = economyOf(sim, player)
  const state: HudState = {
    credits,
    rewards: [...rewardsOf(sim, player)],
    income: round(economy.income),
    power: { produced: economy.produced, demand: economy.demand },
    units: UNIT_TYPES.filter((type) => counts.has(type)).map((type) => ({ type, count: counts.get(type)! })),
    building,
    site,
    construction: counts.has('builder')
      ? {
          available: coreCenters(sim, player).length > 0,
          placing: scene.placing,
          options: BUILDABLE.map((type) => ({
            building: type,
            cost: BUILDINGS[type].cost,
            affordable: credits >= BUILDINGS[type].cost,
            limited: atLimit(sim, player, type),
          })),
        }
      : null,
    conversion: null,
    production: null,
  }
  if (producers.length !== 1) return state

  // Производитель один: это MCV или главное здание. У него есть и превращение, и производство.
  const [entity] = producers
  const converting = world.get(entity, Converting)
  const isUnit = world.has(entity, Unit)
  state.conversion = {
    kind: isUnit ? 'deploy' : 'pack',
    command: isUnit ? { type: 'deploy', unit: entity } : { type: 'pack', building: entity },
    possible: isUnit ? canDeploy(sim, player, entity) : canPack(sim, player, entity),
    progress: converting ? round(1 - converting.left / converting.total) : null,
  }

  const producer = world.get(entity, Producer)!
  const [first] = producer.queue
  state.production = {
    producer: entity,
    queue: [...producer.queue],
    progress: first ? round(Math.min(1, producer.progress / buildTicks(first, sim.time.step))) : 0,
    full: producer.queue.length >= QUEUE_LIMIT,
    options: PRODUCIBLE.map((unit) => ({ unit, cost: UNITS[unit].cost, affordable: credits >= UNITS[unit].cost })),
  }
  return state
}
