import { Loop, World, type System, type Time, type WorldSnapshot } from '../ecs'
import { createLand, type GeneratorConfig, type Land } from '../map/terrain'
import { createOccupancy, type Occupancy } from './buildings'
import { apply, type Command } from './commands'
import { SAVED } from './components'
import { construct } from './construction'
import { convert } from './conversion'
import { earn } from './income'
import { moveUnits } from './movement'
import { produceUnits } from './production'

/** Границы карты в тайлах. Правая и нижняя — не включая. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface SimOptions {
  generator: GeneratorConfig
  /** Сторона карты в тайлах. Карта — квадрат с центром в начале координат. */
  size: number
}

/** Сохранение симуляции. Обычные данные: их можно положить в JSON, на диск или отправить по сети. */
/** Версия формата сохранения. Меняется, когда старые сохранения перестают подходить: тогда они отбрасываются. */
export const SAVE_VERSION = 4

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
  const options: SimOptions = { generator: source.generator, size: source.size }
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
      // После движения: работающий строитель поворачивается к стройке, и поворот сглаживается, как у идущих.
      () => construct(sim),
      () => earn(sim),
    ],
  })
  const sim: Sim = {
    options,
    bounds,
    world,
    land: createLand(options.generator),
    occupancy: createOccupancy(world),
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
