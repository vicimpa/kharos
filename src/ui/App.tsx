import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import { loadSettings, saveSettings } from '../map/settings'
import type { HudState } from '../game/hud'
import { GeneratorPanel } from './GeneratorPanel'
import { Hud } from './Hud'

/** Как часто интерфейс сверяется с игрой, в миллисекундах. */
const HUD_INTERVAL = 100

/** Страница игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [error, setError] = useState<unknown>(null)
  const [hud, setHud] = useState<HudState | null>(null)

  // Игра создаётся один раз; дальше она получает только новые настройки.
  useEffect(() => {
    try {
      const game = (gameRef.current = createGame(canvasRef.current!, settings, setError))
      return () => {
        game.destroy()
        gameRef.current = null
      }
    } catch (error) {
      setError(error)
    }
  }, [])

  // Интерфейс не подписывается на каждую сущность, а раз в HUD_INTERVAL спрашивает у игры готовое состояние
  // и перерисовывается, только если оно изменилось.
  useEffect(() => {
    let last = ''
    const timer = setInterval(() => {
      const game = gameRef.current
      if (!game) return
      const next = game.hud()
      const key = JSON.stringify(next)
      if (key === last) return
      last = key
      setHud(next)
    }, HUD_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    gameRef.current?.setSettings(settings)
    saveSettings(settings)
  }, [settings])

  return (
    <main class="game">
      <canvas ref={canvasRef} class="game__canvas" />
      {hud && error === null && <Hud state={hud} send={(command) => gameRef.current?.send(command)} />}
      <GeneratorPanel settings={settings} onChange={setSettings} onRestart={() => gameRef.current?.restart()} />
      {error !== null && (
        <div class="game__error" role="alert">
          <strong>Игра остановилась</strong>
          <pre>{error instanceof Error ? error.message : String(error)}</pre>
          <button onClick={() => location.reload()}>Перезагрузить</button>
        </div>
      )}
    </main>
  )
}
