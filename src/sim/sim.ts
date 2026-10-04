import { Loop, World, type System, type Time, type WorldSnapshot } from '../ecs'
import { createLand, type GeneratorConfig, type Land } from '../map/terrain'
import { createOccupancy, type Occupancy } from './buildings'
import { fight, recover } from './combat'
import { apply, type Command } from './commands'
import { SAVED } from './components'
import { REPAIR_COST, REPAIR_SPEED, construct } from './construction'
import { convert } from './conversion'
import { haul } from './hauling'
import { earn } from './income'
import { trade } from './trade'
import { moveUnits } from './movement'
import { produceUnits } from './production'
import { followCarriers, restTurrets } from './turrets'

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
}

export const DEFAULT_RULES: Rules = { repairSpeed: REPAIR_SPEED, repairCost: REPAIR_COST }

export interface SimOptions {
  generator: GeneratorConfig
  /** Сторона карты в тайлах. Карта — квадрат с центром в начале координат. */
  size: number
  /** Правила; чего нет — по умолчанию. */
  rules?: Partial<Rules>
}

/** Сохранение симуляции. Обычные данные: их можно положить в JSON, на диск или отправить по сети. */
/** Версия формата сохранения. Меняется, когда старые сохранения перестают подходить: тогда они отбрасываются. */
export const SAVE_VERSION = 15

export interface SimSave extends SimOptions {
  version: typeof SAVE_VERSION
  tick: number
  world: WorldSnapshot
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
  readonly occupancy: Occupancy
  /** Правила. Поля можно менять на ходу: со следующего тика симуляция считает по новым. */
  readonly rules: Rules
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
  const options: SimOptions = { generator: source.generator, size: source.size, rules }
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
      (_, time) => moveUnits(sim, time),
      // Турели встают на носители, уже сдвинувшиеся за этот тик.
      () => followCarriers(sim),
      // После движения: работающий строитель поворачивается к стройке, и поворот сглаживается, как у идущих.
      () => construct(sim),
      () => haul(sim),
      () => trade(sim),
      // После движения и работ: стреляющий юнит поворачивается к цели, и погибшие в этот тик уже ничего не делают.
      () => fight(sim),
      // После работ и боя: кому не досталось ни того, ни другого, — те турели разворачиваются по корпусу.
      () => restTurrets(sim),
      () => recover(sim),
      () => earn(sim),
    ],
  })
  const sim: Sim = {
    options,
    bounds,
    world,
    land: createLand(options.generator),
    occupancy: createOccupancy(world),
    rules,
    time: loop.time,
    send(player, command) {
      queue.push({ player, command })
    },
    advance: (seconds) => loop.advance(seconds),
    save: () => ({ version: SAVE_VERSION, ...options, tick: loop.time.tick, world: world.snapshot(SAVED) }),
    destroy() {
      sim.occupancy.destroy()
      world.clear()
    },
  }

  if ('world' in source) world.restore(source.world, SAVED)
  return sim
}
