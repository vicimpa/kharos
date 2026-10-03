import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game, type GameMode } from '../game/game'
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

/**
 * Во что играют: параметр ?battle в адресной строке — показательный бой, ?sandbox — тестовая карта,
 * без них — обычная игра. Бой и тестовая карта сохранение не трогают.
 */
const MODES = ['battle', 'sandbox'] as const
const MODE: GameMode = MODES.find((mode) => new URLSearchParams(location.search).has(mode)) ?? 'play'

/** Переходит в другой режим игры: меняет параметр в адресной строке и перезагружает страницу. */
function openMode(mode: GameMode) {
  const query = new URLSearchParams(location.search)
  for (const other of MODES) query.delete(other)
  if (mode !== 'play') query.set(mode, '')
  location.search = query.toString()
}

/** Страница игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [error, setError] = useState<unknown>(null)
  const [hud, setHud] = useState<HudState | null>(null)
  const [muted, setMuted] = useState(false)

  // Игра создаётся один раз; дальше она получает только новые настройки.
  useEffect(() => {
    const server = serverAddress()
    let closed = false
    const start = async () => {
      const session = server ? await connect(server.url, server.lag) : undefined
      if (closed) return session?.sim.destroy()
      gameRef.current = createGame(canvasRef.current!, settings, setError, session, MODE)
      setMuted(gameRef.current.muted)
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
      {hud && error === null && !serverAddress() && (
        <div class="hud hud--battle">
          {MODE === 'play' ? (
            <>
              <button onClick={() => openMode('battle')}>Случайный бой</button>
              <button onClick={() => openMode('sandbox')}>Тестовая карта</button>
            </>
          ) : (
            <>
              <button onClick={() => gameRef.current?.restart()}>{MODE === 'battle' ? 'Новый бой' : 'Заново'}</button>
              <button onClick={() => openMode('play')}>В игру</button>
            </>
          )}
        </div>
      )}
      {hud && error === null && (
        <button
          class="hud hud--sound"
          title={muted ? 'Включить звук' : 'Выключить звук'}
          onClick={() => {
            const game = gameRef.current
            if (!game) return
            game.muted = !muted
            setMuted(game.muted)
          }}
        >
          {muted ? 'Звук выкл' : 'Звук вкл'}
        </button>
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
