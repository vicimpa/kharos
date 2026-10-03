/** Насколько далеко тряска уводит камеру при полной силе, в пикселях экрана. */
const MAX_OFFSET = 14
/** Сколько силы тряски уходит за секунду: от полной до нуля — за 1 / DECAY секунды. */
const DECAY = 1.6
/** Как быстро камера дёргается туда-сюда, раз в секунду. */
const FREQUENCY = 22

/**
 * Тряска камеры от взрывов. Сила копится от каждого толчка и понемногу уходит; камеру уводит на квадрат силы:
 * слабые толчки едва заметны, а сильные бьют. Движение плавное, по сумме синусов, а не случайные скачки.
 */
export function createShake() {
  let trauma = 0
  let time = 0
  /** Плавное число от -1 до 1, своё для каждого seed. */
  const wave = (seed: number) =>
    (Math.sin(time * FREQUENCY + seed) + Math.sin(time * FREQUENCY * 1.73 + seed * 2.1) * 0.6 + Math.sin(time * FREQUENCY * 2.9 + seed * 3.7) * 0.3) / 1.9

  return {
    /** Толчок силой amount: 1 — самый сильный. */
    add(amount: number) {
      trauma = Math.min(1, trauma + amount)
    },
    update(seconds: number) {
      time += seconds
      trauma = Math.max(0, trauma - seconds * DECAY)
    },
    /** Куда сейчас уведена камера, в пикселях экрана. */
    offset() {
      const strength = trauma * trauma * MAX_OFFSET
      return { x: wave(0) * strength, y: wave(17) * strength }
    },
  }
}
