import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import type { HudState } from '../game/hud'
import type { MapSettings } from '../map/settings'
import { Hud } from './Hud'
import { PasswordRequired } from '../net/connect'
import { startSession, type Launch } from './launch'

/** Как часто интерфейс сверяется с игрой, в миллисекундах. */
const HUD_INTERVAL = 100

interface GameViewProps {
  launch: Launch
  settings: MapSettings
  /** Выйти в главное меню. */
  exit(): void
}

/** Экран игры: холст, на котором живёт сама игра, и интерфейс поверх него. */
export function GameView({ launch, settings, exit }: GameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [hud, setHud] = useState<HudState | null>(null)
  const [muted, setMuted] = useState(false)
  /** Настоящая игра — за свою базу: в ней можно сдаться и проиграть. Песочница и показательный бой — не в счёт. */
  const real = launch.kind === 'save' || launch.kind === 'server'

  /** Сервер просит пароль: wrong — введённый не подошёл. Окно спрашивает снова, пока не пустят или не отменят. */
  const [asking, setAsking] = useState<{ wrong: boolean } | null>(null)
  const [password, setPassword] = useState('')
  const connectRef = useRef<(password?: string) => void>(() => {})

  // Игра создаётся один раз.
  useEffect(() => {
    let closed = false
    const start = async (password?: string) => {
      const session = await startSession(launch.kind === 'server' && password !== undefined ? { ...launch, password } : launch, settings)
      if (closed) return session.sim.destroy()
      gameRef.current = createGame(canvasRef.current!, settings, setError, session, { slot: launch.kind === 'save' ? launch.slot.id : undefined })
      setMuted(gameRef.current.muted)
    }
    const attempt = (password?: string) =>
      start(password).catch((error: unknown) => {
        if (closed) return
        if (error instanceof PasswordRequired) setAsking({ wrong: error.wrong })
        else setError(error)
      })
    connectRef.current = attempt
    attempt()
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

  return (
    <main class="game">
      <canvas ref={canvasRef} class="game__canvas" />
      {hud && error === null && gameRef.current && (
        <Hud
          state={hud}
          send={(command) => gameRef.current?.send(command)}
          place={(building) => gameRef.current?.place(building)}
          pave={(tool) => gameRef.current?.pave(tool)}
          route={(start) => gameRef.current?.route(start)}
          serve={(start) => gameRef.current?.serve(start)}
          patrol={(start) => gameRef.current?.patrol(start)}
          minimap={gameRef.current.minimap}
          lookAt={(x, y) => gameRef.current?.lookAt(x, y)}
          flyTo={(x, y) => gameRef.current?.flyTo(x, y)}
          lookAtSelection={() => gameRef.current?.lookAtSelection()}
          narrow={(type, remove) => gameRef.current?.narrow(type, remove)}
          moveSelected={(x, y) => gameRef.current?.moveSelected(x, y)}
          menu={
            <>
              {(launch.kind === 'battle' || launch.kind === 'sandbox') && (
                <button onClick={() => gameRef.current?.restart()}>{launch.kind === 'battle' ? 'Новый бой' : 'Заново'}</button>
              )}
              {real && !hud.defeated && (
                <button
                  data-tip="Проиграть сразу: всё своё взорвётся"
                  onClick={() => {
                    if (confirm('Сдаться? Все ваши юниты и здания взорвутся.')) gameRef.current?.send({ type: 'surrender' })
                  }}
                >
                  Сдаться
                </button>
              )}
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
      {real && hud?.defeated && error === null && (
        <div class="game__defeat" role="alert">
          <strong>Поражение</strong>
          <span>{launch.kind === 'server' ? 'Не осталось ни зданий, ни MCV. Можно начать заново в новом месте этого мира.' : 'Не осталось ни зданий, ни MCV.'}</span>
          <div class="game__actions">
            <button onClick={exit}>В меню</button>
            <button onClick={() => gameRef.current?.respawn()}>Начать заново</button>
          </div>
        </div>
      )}
      {asking && error === null && (
        <form
          class="game__error"
          onSubmit={(event) => {
            event.preventDefault()
            setAsking(null)
            connectRef.current(password)
          }}
        >
          <strong>{asking.wrong ? 'Неверный пароль' : 'Сервер закрыт паролем'}</strong>
          <input class="game__password" type="password" autoFocus value={password} placeholder="Пароль" onInput={(event) => setPassword(event.currentTarget.value)} />
          <div class="game__actions">
            <button type="button" onClick={exit}>
              Отмена
            </button>
            <button type="submit" disabled={!password}>
              Подключиться
            </button>
          </div>
        </form>
      )}
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
