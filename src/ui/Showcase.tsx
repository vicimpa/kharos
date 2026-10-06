import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, simOptions, type Game } from '../game/game'
import type { MapSettings } from '../map/settings'
import { connectLocal } from '../net/connect'
import { Building } from '../sim'

/** Что показывают слайды по очереди: бой двух случайных армий и работающую базу. */
const SLIDES = ['battle', 'sandbox'] as const
/** Сколько длится слайд и затемнение между слайдами, в миллисекундах. */
const SLIDE_TIME = 40000
const FADE_TIME = 1200
/** Пока местность первого кадра собирается, экран тёмный. */
const SETTLE_TIME = 700
/** Мир витрины маленький: его считают с нуля для каждого слайда. */
const SHOWCASE_SIZE = 256

/** Погода слайда: от сумерек до полудня, иногда с осадками. */
function randomWeather(settings: MapSettings) {
  return {
    ...settings.weather,
    light: 0.3 + Math.random() * 0.7,
    windX: (Math.random() - 0.5) * 4,
    windY: (Math.random() - 0.5) * 2,
    precipitation: Math.random() < 0.3 ? Math.random() * 0.8 : 0,
  }
}

/**
 * Фон главного меню: слайды настоящей симуляции — бой и база на каждый раз новой местности и в новую погоду.
 * Каждый слайд считает свой воркер, его никто больше не видит; камера сама следит за происходящим. Если
 * отрисовка не запустилась (нет WebGL 2), фон просто остаётся тёмным.
 */
export function Showcase({ settings }: { settings: MapSettings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [slide, setSlide] = useState(() => Math.floor(Math.random() * SLIDES.length))
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let closed = false
    let game: Game | null = null
    const timers: number[] = []
    const later = (action: () => void, delay: number) => timers.push(window.setTimeout(action, delay))
    const local: MapSettings = {
      ...settings,
      generator: { ...settings.generator, seed: Math.floor(Math.random() * 2 ** 31) },
      world: { ...settings.world, size: SHOWCASE_SIZE },
      weather: randomWeather(settings),
    }
    const mode = SLIDES[slide % SLIDES.length]
    connectLocal({ options: simOptions(local), mode, battle: settings.battle, save: null }, () => {}, 'kharos-showcase', false)
      .then((session) => {
        if (closed) return session.sim.destroy()
        game = createGame(canvasRef.current!, local, () => setShown(false), session, { showcase: true })
        later(() => setShown(true), SETTLE_TIME)
        // Если у тестовой карты не нашлось места под базу, мир начался голым: такой слайд не показываем.
        later(() => {
          if (mode !== 'sandbox') return
          // Обход дочитывается или прерывается break: брошенный посреди, он не даёт миру обновиться.
          for (const _ of session.sim.world.query(Building)) return
          setSlide((index) => index + 1)
        }, SETTLE_TIME)
      })
      .catch(() => {})
    later(() => setShown(false), SLIDE_TIME - FADE_TIME)
    later(() => setSlide((index) => index + 1), SLIDE_TIME)
    return () => {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      game?.destroy()
    }
  }, [slide])

  return (
    <div class="showcase" aria-hidden="true">
      <canvas key={slide} ref={canvasRef} class="showcase__canvas" />
      <div class={shown ? 'showcase__veil' : 'showcase__veil is-dark'} />
    </div>
  )
}
