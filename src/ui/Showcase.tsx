import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, simOptions, type Game } from '../game/game'
import type { MapSettings } from '../map/settings'
import { LOCAL_PLAYER } from '../net/local'
import { SCENES, createSim, type SceneName } from '../sim'

/** Сколько длится слайд и затемнение между слайдами, в миллисекундах. */
const SLIDE_TIME = 40000
const FADE_TIME = 1200
/** Пока местность первого кадра собирается, экран тёмный. */
const SETTLE_TIME = 700
/** Как часто сценка ведёт свой мир, в миллисекундах. */
const DRIVE_INTERVAL = 500
/** Карта витрины крошечная: её считают с нуля для каждого слайда, прямо во вкладке. */
const SHOWCASE_SIZE = 128
const NAMES = Object.keys(SCENES) as SceneName[]

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

/** Отладка: ?scene=<имя> в адресной строке показывает только эту сценку. */
const FORCED = NAMES.find((name) => name === new URLSearchParams(location.search).get('scene'))

/** Следующая сценка — случайная, но не та же, что сейчас. */
const nextScene = (current?: SceneName) => {
  if (FORCED) return FORCED
  const choices = NAMES.filter((name) => name !== current)
  return choices[Math.floor(Math.random() * choices.length)]
}

/**
 * Фон главного меню: слайды-сценки — добыча, стройка, оборона, бои — на каждый раз новой крошечной местности и в
 * новую погоду. Мир считает сама вкладка, без хоста и тумана войны; камера сама следит за происходящим. Сценка,
 * которая не встала на этой местности или кончилась раньше времени, сменяется следующей. Если отрисовка не
 * запустилась (нет WebGL 2), фон просто остаётся тёмным.
 */
export function Showcase({ settings }: { settings: MapSettings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [slide, setSlide] = useState(() => ({ index: 0, scene: nextScene() }))
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const timers: number[] = []
    const later = (action: () => void, delay: number) => timers.push(window.setTimeout(action, delay))
    const next = () => {
      setShown(false)
      later(() => setSlide(({ index, scene }) => ({ index: index + 1, scene: nextScene(scene) })), FADE_TIME)
    }
    const local: MapSettings = {
      ...settings,
      generator: { ...settings.generator, seed: Math.floor(Math.random() * 2 ** 31) },
      world: { ...settings.world, size: SHOWCASE_SIZE },
      weather: randomWeather(settings),
    }
    const sim = createSim({ ...simOptions(local), fog: false })
    const scene = SCENES[slide.scene]()
    let game: Game | null = null
    if (!scene.create(sim, LOCAL_PLAYER)) {
      sim.destroy()
      later(() => setSlide(({ index, scene }) => ({ index: index + 1, scene: nextScene(scene) })), 0)
      return () => timers.forEach(clearTimeout)
    }
    try {
      game = createGame(canvasRef.current!, local, () => setShown(false), { sim, player: LOCAL_PLAYER }, { showcase: true })
    } catch {
      sim.destroy()
      return
    }
    later(() => setShown(true), SETTLE_TIME)
    let ended = false
    const drive = window.setInterval(() => {
      if (ended || !scene.drive) return
      if (scene.drive(sim, LOCAL_PLAYER, DRIVE_INTERVAL / 1000)) return
      // Кончилась — пусть доиграет пару секунд и сменяется.
      ended = true
      later(next, 2500)
    }, DRIVE_INTERVAL)
    later(next, SLIDE_TIME - FADE_TIME)
    return () => {
      clearInterval(drive)
      timers.forEach(clearTimeout)
      game?.destroy()
    }
  }, [slide])

  return (
    <div class="showcase" aria-hidden="true">
      <canvas key={slide.index} ref={canvasRef} class="showcase__canvas" />
      <div class={shown ? 'showcase__veil' : 'showcase__veil is-dark'} />
    </div>
  )
}
