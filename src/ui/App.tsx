import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import { loadSettings, saveSettings } from '../map/settings'
import { connect } from '../net/connect'
import { DEFAULT_PORT } from '../net/protocol'
import type { HudState } from '../game/hud'
import { GeneratorPanel } from './GeneratorPanel'
import { Hud } from './Hud'

/** Как часто интерфейс сверяется с игрой, в миллисекундах. */
const HUD_INTERVAL = 100

/**
 * Адрес сервера из адресной строки: ?server=ws://host:port, а просто ?server — сервер на этой же машине.
 * Без параметра игра одиночная. ?lag=100 добавляет задержку в миллисекундах в каждую сторону.
 */
function serverAddress() {
  const query = new URLSearchParams(location.search)
  const server = query.get('server')
  if (server === null) return null
  return { url: server || `ws://${location.hostname}:${DEFAULT_PORT}`, lag: Number(query.get('lag')) || 0 }
}

/** Отладочная панель генератора скрыта; открывается параметром ?panel в адресной строке. */
const SHOW_PANEL = new URLSearchParams(location.search).has('panel')

/** Показательный бой вместо обычной игры: параметр ?battle в адресной строке. Сохранение он не трогает. */
const BATTLE = new URLSearchParams(location.search).has('battle')

/** Страница игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [error, setError] = useState<unknown>(null)
  const [hud, setHud] = useState<HudState | null>(null)

  // Игра создаётся один раз; дальше она получает только новые настройки.
  useEffect(() => {
    const server = serverAddress()
    let closed = false
    const start = async () => {
      const session = server ? await connect(server.url, server.lag) : undefined
      if (closed) return session?.sim.destroy()
      gameRef.current = createGame(canvasRef.current!, settings, setError, session, BATTLE)
    }
    start().catch(setError)
    return () => {
      closed = true
      gameRef.current?.destroy()
      gameRef.current = null
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
      {hud && error === null && (
        <Hud
          state={hud}
          send={(command) => gameRef.current?.send(command)}
          place={(building) => gameRef.current?.place(building)}
        />
      )}
      {SHOW_PANEL && (
        <GeneratorPanel settings={settings} onChange={setSettings} onRestart={() => gameRef.current?.restart()} />
      )}
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
