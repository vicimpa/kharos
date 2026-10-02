/** Самый длинный кадр, который отдаётся игре. */
const MAX_FRAME_SECONDS = 0.25

/**
 * Вызывает frame каждый кадр браузера с реальным временем, прошедшим с прошлого кадра, в секундах.
 * Возвращает остановку. Ошибка в frame останавливает кадры: с onError она передаётся туда, без него — уходит в консоль.
 */
export function startFrames(frame: (seconds: number) => void, onError?: (error: unknown) => void) {
  let handle = 0
  let last: number | undefined
  const tick = (now: number) => {
    // Вкладка была в фоне — кадр «длился» минуты. Игре такой скачок ни к чему.
    const seconds = last === undefined ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS)
    last = now
    try {
      frame(seconds)
    } catch (error) {
      if (!onError) throw error
      onError(error)
      return
    }
    handle = requestAnimationFrame(tick)
  }
  handle = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(handle)
}
