import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import type { HudState } from '../game/hud'
import type { MapSettings } from '../map/settings'
import { DebugSpawn } from './DebugSpawn'
import { GeneratorPanel } from './GeneratorPanel'
import { Hud } from './Hud'
import { startSession, type Launch } from './launch'

/** Как часто интерфейс сверяется с игрой, в миллисекундах. */
const HUD_INTERVAL = 100

interface GameViewProps {
  launch: Launch
  settings: MapSettings
  setSettings(settings: MapSettings): void
  /** Показывать ли отладочную панель генератора. */
  panel: boolean
  /** Выйти в главное меню. */
  exit(): void
}

/** Экран игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function GameView({ launch, settings, setSettings, panel, exit }: GameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [hud, setHud] = useState<HudState | null>(null)
  const [muted, setMuted] = useState(false)
  const [debug, setDebug] = useState(false)

  // Игра создаётся один раз; дальше она получает только новые настройки.
  useEffect(() => {
    let closed = false
    const start = async () => {
      const session = await startSession(launch, settings)
      if (closed) return session.sim.destroy()
      gameRef.current = createGame(canvasRef.current!, settings, setError, session, { slot: launch.kind === 'save' ? launch.slot.id : undefined })
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
  }, [settings])

  return (
    <main class="game">
      <canvas ref={canvasRef} class="game__canvas" />
      {hud && error === null && gameRef.current && (
        <Hud
          state={hud}
          send={(command) => gameRef.current?.send(command)}
          place={(building) => gameRef.current?.place(building)}
          minimap={gameRef.current.minimap}
          lookAt={(x, y) => gameRef.current?.lookAt(x, y)}
          lookAtSelection={() => gameRef.current?.lookAtSelection()}
          narrow={(type, remove) => gameRef.current?.narrow(type, remove)}
          moveSelected={(x, y) => gameRef.current?.moveSelected(x, y)}
          menu={
            <>
              {(launch.kind === 'battle' || launch.kind === 'sandbox') && (
                <button onClick={() => gameRef.current?.restart()}>{launch.kind === 'battle' ? 'Новый бой' : 'Заново'}</button>
              )}
              <button
                class={debug ? 'is-active' : undefined}
                data-tip="Отладочный спавн: поставить здание, свой юнит или врага, куда щёлкнешь"
                onClick={() => {
                  if (debug) gameRef.current?.spawn(null)
                  setDebug(!debug)
                }}
              >
                Отладка
              </button>
              <button
                data-tip={muted ? 'Включить звук' : 'Выключить звук'}
                onClick={() => {
                  const game = gameRef.current
                  if (!game) return
                  game.muted = !muted
                  setMuted(game.muted)
                }}
              >
                {muted ? 'Звук выкл' : 'Звук вкл'}
              </button>
              <button data-tip={launch.kind === 'save' ? 'Сохранить и выйти в главное меню' : 'Выйти в главное меню'} onClick={exit}>
                Меню
              </button>
            </>
          }
        />
      )}
      {hud && error === null && debug && <DebugSpawn spawning={hud.spawning} spawn={(spawn) => gameRef.current?.spawn(spawn)} />}
      {panel && <GeneratorPanel settings={settings} onChange={setSettings} onRestart={() => gameRef.current?.restart()} />}
      {error !== null && (
        <div class="game__error" role="alert">
          <strong>Игра остановилась</strong>
          <pre>{error instanceof Error ? error.message : String(error)}</pre>
          <div class="game__actions">
            <button onClick={exit}>В меню</button>
            <button onClick={() => location.reload()}>{launch.kind === 'server' ? 'Переподключиться' : 'Перезагрузить'}</button>
          </div>
        </div>
      )}
    </main>
  )
}
