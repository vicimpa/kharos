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

/** Самый длинный кадр, который цикл в браузере отдаёт системам. */
const MAX_FRAME_SECONDS = 0.25

/** Система — обычная функция. Порядок вызова задаёт место в списке. */
export type System = (world: World, time: Time) => void

export interface LoopOptions {
  world: World
  /** Тиков симуляции в секунду. По умолчанию 20. */
  tickRate?: number
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
    this.time = { tick: 0, step: 1 / (options.tickRate ?? 20), elapsed: 0, delta: 0, alpha: 0 }
  }

  /**
   * Один кадр: делает столько тиков, сколько накопилось за seconds, затем вызывает системы кадра.
   * Возвращает число сделанных тиков. Вызывается из start(), а в тестах и на сервере — напрямую.
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

  /**
   * Запускает цикл в браузере. Возвращает остановку. Ошибка в системе останавливает цикл:
   * с onError она передаётся туда, без него — уходит в консоль.
   */
  start(onError?: (error: unknown) => void) {
    let frame = 0
    let last: number | undefined
    const tick = (now: number) => {
      // Вкладка была в фоне — кадр «длился» минуты. Системам кадра такой скачок ни к чему.
      const seconds = last === undefined ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS)
      last = now
      try {
        this.advance(seconds)
      } catch (error) {
        if (!onError) throw error
        onError(error)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }
}
