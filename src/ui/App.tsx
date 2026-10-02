import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import { loadSettings, saveSettings } from '../map/settings'
import { GeneratorPanel } from './GeneratorPanel'

/** Страница игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [error, setError] = useState<unknown>(null)

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

  useEffect(() => {
    gameRef.current?.setSettings(settings)
    saveSettings(settings)
  }, [settings])

  return (
    <main class="game">
      <canvas ref={canvasRef} class="game__canvas" />
      <GeneratorPanel settings={settings} onChange={setSettings} />
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
