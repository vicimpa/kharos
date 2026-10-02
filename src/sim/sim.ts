import { Loop, World, type System, type Time, type WorldSnapshot } from '../ecs'
import { createLand, type GeneratorConfig, type Land } from '../map/terrain'
import { createOccupancy, type Occupancy } from './buildings'
import { apply, type Command } from './commands'
import { SAVED } from './components'

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
export interface SimSave extends SimOptions {
  version: 1
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
  /** Ставит команду в очередь. Она выполнится в начале следующего тика. */
  send(command: Command): void
  /** Продвигает симуляцию на seconds реального времени. Возвращает число сделанных тиков. */
  advance(seconds: number): number
  save(): SimSave
  destroy(): void
}

/** Создаёт симуляцию: новую или, если передано сохранение, продолжает его. */
export function createSim(source: SimOptions | SimSave): Sim {
  const options: SimOptions = { generator: source.generator, size: source.size }
  const half = Math.floor(options.size / 2)
  const bounds: Bounds = { left: -half, top: -half, right: options.size - half, bottom: options.size - half }

  const world = new World()
  const queue: Command[] = []

  /** Первая система тика: выполняет команды, накопившиеся с прошлого тика. */
  const commands: System = () => {
    // Команда, посланная во время выполнения другой, дождётся следующего тика.
    for (const command of queue.splice(0)) apply(sim, command)
  }

  // Порядок систем — порядок событий внутри тика. Новые системы симуляции добавляются сюда.
  const loop = new Loop({ world, tick: 'tick' in source ? source.tick : 0, update: [commands] })
  const sim: Sim = {
    options,
    bounds,
    world,
    land: createLand(options.generator),
    occupancy: createOccupancy(world),
    time: loop.time,
    send(command) {
      queue.push(command)
    },
    advance: (seconds) => loop.advance(seconds),
    save: () => ({ version: 1, ...options, tick: loop.time.tick, world: world.snapshot(SAVED) }),
    destroy() {
      sim.occupancy.destroy()
      world.clear()
    },
  }


  if ('world' in source) world.restore(source.world, SAVED)
  return sim
}
