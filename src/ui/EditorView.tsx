import { useEffect, useRef, useState } from 'preact/hooks'
import { createGame, type Game } from '../game/game'
import { loadSave, storeSave } from '../game/storage'
import type { MapSettings } from '../map/settings'
import { decodeSave, encodeSave, readJson, type Sections } from '../save/file'
import { Ghost, createSim, type Sim, type SimSave } from '../sim'
import { erase, playersOf } from '../sim/editor'
import { applyEdit } from '../sim/editOps'
import { slotWorker, type Launch } from './launch'
import { reloadLocal } from '../net/connect'
import { EditorPanel } from './EditorPanel'
import { download } from './Menu'

type EditorLaunch = Extract<Launch, { kind: 'editor' }>

/** Откуда открыто сохранение: мир и разделы файла, чтобы записать его обратно с ними же (HOST сервера, имя). */
interface Opened {
  save: SimSave
  sections?: Sections
}

async function open(launch: EditorLaunch): Promise<Opened> {
  if ('slot' in launch) {
    const save = await loadSave(launch.slot.id)
    if (!save) throw new Error('Мир этого слота ещё не сохранён')
    return { save }
  }
  return decodeSave(launch.file)
}

/**
 * Редактор сохранений — игра в режиме бога: тот же холст, но симуляция стоит, а вместо нижней панели — боковая,
 * см. EditorPanel. Тумана нет; разведанное игроками сохраняется таким, каким было.
 */
export function EditorView({ launch, settings, exit }: { launch: EditorLaunch; settings: MapSettings; exit(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [game, setGame] = useState<Game | null>(null)
  const simRef = useRef<Sim | null>(null)
  const openedRef = useRef<Opened | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let closed = false
    let made: Game | null = null
    open(launch)
      .then((opened) => {
        if (closed) return
        openedRef.current = opened
        // Тумана в редакторе нет: видно всё, а не то, что разведал игрок.
        const sim = createSim({ ...opened.save, fog: false })
        // Симуляция стоит: кадры игры зовут advance, а тиков нет.
        const frozen: Sim = Object.create(sim, { advance: { value: () => 0 } })
        simRef.current = sim
        made = createGame(canvasRef.current!, settings, setError, { sim: frozen, player: playersOf(sim)[0] ?? 1 }, { editor: true })
        setGame(made)
      })
      .catch(setError)
    return () => {
      closed = true
      made?.destroy()
    }
  }, [])

  const save = async () => {
    const sim = simRef.current
    const opened = openedRef.current
    if (!sim || !opened) return
    // Призрак юнита под указателем — не часть мира.
    const ghosts = [...sim.world.query(Ghost)].map(([entity]) => entity)
    for (const ghost of ghosts) erase(sim, ghost)
    const { fog: _, ...rest } = sim.save()
    // Без тумана разведанной была бы вся карта: игроки получают прежнее разведанное.
    const save: SimSave = { ...rest, ...(opened.save.fog === false && { fog: false }), explored: opened.save.explored }
    try {
      if ('slot' in launch) {
        await storeSave(launch.slot.id, save)
        // Если в слот играют в другой вкладке, её мир — поправленный: иначе автосохранение игры затёрло бы правки.
        reloadLocal(slotWorker(launch.slot.id), save)
        setStatus('Сохранено в слот')
      } else {
        // Свои разделы файла (игроки сервера, имя слота) пишутся обратно как были.
        const extras: Record<string, unknown> = {}
        for (const tag of opened.sections?.keys() ?? []) {
          if (!['META', 'WRLD', 'LAND', 'EXPL'].includes(tag)) extras[tag] = readJson(opened.sections!.get(tag))
        }
        download(launch.name.endsWith('.kharos') ? launch.name : `${launch.name}.kharos`, await encodeSave(save, extras))
        setStatus('Файл скачан')
      }
      setDirty(false)
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const sim = simRef.current
  return (
    <main class="game editor">
      <canvas ref={canvasRef} class="game__canvas" />
      {sim && game && error === null && (
        <EditorPanel
          sim={sim}
          game={game}
          apply={(edit) => applyEdit(sim, edit)}
          title="Редактор"
          subtitle={`${'slot' in launch ? launch.slot.name : launch.name}${status ? ` · ${status}` : ''}`}
          changed={() => (setDirty(true), setStatus(''))}
        >
          <button
            onClick={() => {
              if (dirty && !confirm('Выйти без сохранения? Правки пропадут.')) return
              exit()
            }}
          >
            Выйти
          </button>
          <button class="menu__primary" onClick={save}>
            {'slot' in launch ? 'Сохранить' : 'Скачать файл'}
            {dirty ? ' •' : ''}
          </button>
        </EditorPanel>
      )}
      {error !== null && (
        <div class="game__error" role="alert">
          <strong>Редактор не открылся</strong>
          <pre>{error instanceof Error ? error.message : String(error)}</pre>
          <div class="game__actions">
            <button onClick={exit}>В меню</button>
          </div>
        </div>
      )}
    </main>
  )
}
