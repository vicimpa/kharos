import type { World } from './world'

/** Время, которое цикл передаёт системам. Объект один на весь цикл — не сохраняй его, читай поля сразу. */
export interface Time {
  /** Номер тика симуляции, с нуля. В кадре — номер следующего тика. */
  tick: number
  /** Длина тика в секундах. Постоянна: системы симуляции считают движение через неё. */
  step: number
  /** Сколько секунд симуляции прошло: tick * step. */
  elapsed: number
  /** Реальное время с прошлого кадра в секундах. Только для систем кадра. */
  delta: number
  /** Доля тика от 0 до 1, прошедшая после последнего тика. Системы кадра сглаживают ею движение. */
  alpha: number
}

/** Система — обычная функция. Порядок вызова задаёт место в списке. */
export type System = (world: World, time: Time) => void

export interface LoopOptions {
  world: World
  /** Тиков симуляции в секунду. По умолчанию 20. */
  tickRate?: number
  /** С какого тика начать: номер из сохранения. По умолчанию 0. */
  tick?: number
  /** Системы симуляции: вызываются каждый тик с постоянным шагом. */
  update?: System[]
  /** Системы кадра: вызываются раз в кадр после тиков. Состояние игры не меняют, только показывают. */
  render?: System[]
  /**
   * Сколько тиков можно сделать за один кадр. Если кадр длился дольше (вкладка была в фоне,
   * симуляция не успевает), лишнее время отбрасывается: игра замедляется, но не зависает. По умолчанию 5.
   */
  maxTicksPerFrame?: number
}

/**
 * Игровой цикл с постоянным тиком. Симуляция идёт шагами одинаковой длины и не зависит от частоты кадров,
 * поэтому на клиенте и на сервере даёт одинаковый результат. Кадр рисуется так часто, как может экран,
 * и сглаживает движение между тиками через time.alpha.
 */
export class Loop {
  readonly world: World
  readonly time: Time
  private readonly update: System[]
  private readonly render: System[]
  private readonly maxTicks: number
  /** Реальное время, ещё не отданное симуляции. */
  private pending = 0

  constructor(options: LoopOptions) {
    this.world = options.world
    this.update = options.update ?? []
    this.render = options.render ?? []
    this.maxTicks = options.maxTicksPerFrame ?? 5
    const tick = options.tick ?? 0
    const step = 1 / (options.tickRate ?? 20)
    this.time = { tick, step, elapsed: tick * step, delta: 0, alpha: 0 }
  }

  /**
   * Один кадр: делает столько тиков, сколько накопилось за seconds, затем вызывает системы кадра.
   * Возвращает число сделанных тиков. Кто и как часто это вызывает, цикл не знает: в браузере — кадр, на сервере — таймер.
   */
  advance(seconds: number) {
    const { world, time } = this
    this.pending += seconds

    let ticks = 0
    while (this.pending >= time.step) {
      if (ticks === this.maxTicks) {
        this.pending %= time.step
        break
      }
      this.pending -= time.step
      time.delta = time.step
      time.alpha = 0
      for (const system of this.update) system(world, time)
      time.tick++
      time.elapsed = time.tick * time.step
      world.flush()
      ticks++
    }

    time.delta = seconds
    time.alpha = this.pending / time.step
    for (const system of this.render) system(world, time)
    // Между кадрами мир меняют ещё и обработчики ввода — их изменения тоже надо раздать.
    world.flush()
    return ticks
  }
}
