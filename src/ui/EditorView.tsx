import { useEffect, useRef, useState } from 'preact/hooks'
import type { Entity } from '../ecs'
import { createGame, type Game } from '../game/game'
import { placementOf } from '../game/placing'
import type { SceneEdit } from '../game/scene'
import { loadSave, storeSave } from '../game/storage'
import type { MapSettings } from '../map/settings'
import { Terrain } from '../map/terrain'
import { decodeSave, encodeSave, readJson, type Sections } from '../save/file'
import {
  BUILDING_TYPES,
  Building,
  GOODS,
  Health,
  Inventory,
  Owner,
  UNIT_TYPES,
  Unit,
  createSim,
  creditsOf,
  type BuildingType,
  type Good,
  type Sim,
  type SimSave,
  type UnitType,
} from '../sim'
import { DEPOSIT_KINDS, DEPOSIT_SIZE, DEPOSIT_TYPES, depositAt, reserveLeft, type DepositKind } from '../sim/deposits'
import {
  addPlayer,
  depositUnder,
  describeTile,
  entityAt,
  erase,
  moveGhost,
  entitiesIn,
  moveDeposit,
  moveGroup,
  paint,
  playersOf,
  putBuilding,
  putDeposit,
  putUnit,
  removeDeposit,
  setCredits,
  setDeposit as setDepositOf,
  setHealth,
  setOwner,
  setStock,
  type Brush,
} from '../sim/editor'
import type { Launch } from './launch'
import { download } from './Menu'
import { BUILDING_NAMES, RESOURCE_NAMES, UNIT_NAMES, goodName } from './names'

/** Как часто панель сверяется с миром, в миллисекундах. */
const PANEL_INTERVAL = 150

type Tool = 'select' | 'paint' | 'building' | 'unit' | 'deposit' | 'erase'
const TOOLS: [Tool, string][] = [
  ['select', 'Выбор'],
  ['paint', 'Карта'],
  ['building', 'Здания'],
  ['unit', 'Юниты'],
  ['deposit', 'Ресурсы'],
  ['erase', 'Снос'],
]
const TERRAINS: [Terrain | undefined, string][] = [
  [undefined, 'как есть'],
  [Terrain.Rock, 'скала'],
  [Terrain.Sand, 'песок'],
  [Terrain.Swamp, 'болото'],
]
const TIERS: (number | undefined)[] = [undefined, 0, 1, 2, 3]
const CLIFFS: [boolean | undefined, string][] = [
  [undefined, 'как есть'],
  [true, 'обрыв'],
  [false, 'пологий'],
]

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
 * Редактор сохранений — игра в режиме бога: тот же холст, но симуляция стоит, а вместо нижней панели — боковая.
 * Кистью правится карта, ставятся и сносятся здания и юниты любого игрока, у выбранного — владелец, прочность и
 * склад, у игрока — кредиты. Тумана нет; разведанное игроками сохраняется таким, каким было.
 */
export function EditorView({ launch, settings, exit }: { launch: EditorLaunch; settings: MapSettings; exit(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const simRef = useRef<Sim | null>(null)
  const openedRef = useRef<Opened | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [player, setPlayer] = useState(1)
  const [brush, setBrush] = useState<Brush>({ terrain: Terrain.Rock })
  const [size, setSize] = useState(3)
  const [building, setBuilding] = useState<BuildingType>('generator')
  const [unit, setUnit] = useState<UnitType>('tank')
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)
  /** Панель перерисовывается по счётчику: мир меняется мимо Preact. */
  const [, setFrame] = useState(0)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  /** Вид и запас месторождения, которое кладёт инструмент «Ресурсы». */
  const [kind, setKind] = useState<DepositKind>('metal')
  const [reserve, setReserve] = useState(DEPOSIT_KINDS.metal.max)
  /** Выбранное месторождение: левый верхний тайл. */
  const [deposit, setDeposit] = useState<{ x: number; y: number } | null>(null)
  /** Призрак юнита под указателем, см. moveGhost. */
  const ghostRef = useRef<Entity | undefined>(undefined)

  // Обработчики холста читают свежее состояние через ref: игра создаётся один раз.
  const state = useRef({ tool, player, brush, size, building, unit, kind, reserve, deposit })
  state.current = { tool, player, brush, size, building, unit, kind, reserve, deposit }

  useEffect(() => {
    let closed = false
    open(launch)
      .then((opened) => {
        if (closed) return
        openedRef.current = opened
        // Тумана в редакторе нет: видно всё, а не то, что разведал игрок.
        const sim = createSim({ ...opened.save, fog: false })
        // Симуляция стоит: кадры игры зовут advance, а тиков нет.
        const frozen: Sim = Object.create(sim, { advance: { value: () => 0 } })
        simRef.current = sim
        const game = createGame(canvasRef.current!, settings, setError, { sim: frozen, player: state.current.player }, { editor: true })
        gameRef.current = game
        game.scene.edit = createEdit(game, sim)
        const first = playersOf(sim)[0]
        if (first) setPlayer(first)
        setFrame((n) => n + 1)
      })
      .catch(setError)
    return () => {
      closed = true
      gameRef.current?.destroy()
      gameRef.current = null
    }
  }, [])

  // Инструмент и игрок — в сцену: от них зависит, что показано под указателем.
  useEffect(() => {
    const scene = gameRef.current?.scene
    if (!scene) return
    scene.player = player
    scene.placing = tool === 'building' ? building : null
    scene.selectionBox = null
  }, [tool, player, building, gameRef.current])

  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), PANEL_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  const touched = (message = '') => {
    setDirty(true)
    setStatus(message)
  }

  /** Обработчик левой кнопки на холсте: что делает инструмент. */
  function createEdit(game: Game, sim: Sim): SceneEdit {
    const { scene } = game
    /**
     * Что тянут мышью: выбранные юниты и здания разом, месторождение или рамку выделения. from — тайл, от которого
     * отсчитан уже сделанный сдвиг.
     */
    let dragging: { kind: 'group' | 'deposit'; from: { x: number; y: number } } | { kind: 'box'; from: { x: number; y: number } } | null = null
    let last = ''
    return {
      press(point, phase, shift) {
        const { tool, player, brush, size, building, unit, kind, reserve } = state.current
        const x = Math.floor(point.x)
        const y = Math.floor(point.y)
        const tile = `${x},${y}`
        if (tool === 'paint') {
          if (phase === 'up' || (phase === 'drag' && tile === last)) return
          last = tile
          paint(sim, x, y, size, brush)
          touched()
        } else if (tool === 'erase') {
          if (phase === 'up') return
          const target = entityAt(sim, point.x, point.y)
          if (target === undefined) return
          erase(sim, target)
          touched()
        } else if (tool === 'building' && phase === 'down') {
          // Здание встаёт там, где его показывает рамка под указателем.
          const placement = placementOf(scene)
          if (!placement) return
          if (putBuilding(sim, placement.type, placement.x, placement.y, player) === undefined) setStatus(`${BUILDING_NAMES[building]} сюда не встанет`)
          else touched()
        } else if (tool === 'unit' && phase === 'down') {
          if (putUnit(sim, unit, x, y, player) === undefined) setStatus(`${UNIT_NAMES[unit]} здесь не встанет`)
          else touched()
        } else if (dragging?.kind === 'deposit') {
          // Выбранное месторождение тянут мышью — в «Ресурсах» и в «Выборе» одинаково.
          const at = state.current.deposit
          const spot = at && depositAt(sim, at.x, at.y)
          const moved = spot && (x !== dragging.from.x || y !== dragging.from.y) ? moveDeposit(sim, spot, at.x + x - dragging.from.x, at.y + y - dragging.from.y) : null
          if (moved) {
            dragging.from = { x, y }
            // Ref — сразу: следующий сдвиг придёт раньше, чем Preact перерисует панель.
            selectDeposit(moved)
            touched()
          }
          if (phase === 'up') dragging = null
        } else if (tool === 'deposit') {
          if (phase !== 'down') return
          // Щелчок по месторождению выбирает его, и его можно тащить. Мимо — снимает выбор, а если выбора не было, кладёт
          // ещё одно: прежние остаются на местах.
          const spot = depositUnder(sim, point.x, point.y)
          if (spot) {
            selectDeposit(spot)
            dragging = { kind: 'deposit', from: { x, y } }
          } else if (state.current.deposit) selectDeposit(null)
          else if (putDeposit(sim, x, y, kind, reserve)) {
            selectDeposit({ x, y })
            touched()
          } else setStatus('Месторождение ложится на скалу не у подножия обрыва и не внахлёст с другим')
        } else if (tool === 'select') {
          if (phase === 'down') {
            const target = entityAt(sim, point.x, point.y)
            // Мимо юнитов и зданий — может быть, по месторождению: оно выбирается само по себе и тащится так же.
            const spot = target === undefined ? depositUnder(sim, point.x, point.y) : null
            selectDeposit(spot)
            if (spot) {
              scene.selection.clear()
              dragging = { kind: 'deposit', from: { x, y } }
            } else if (target === undefined) {
              // Мимо — рамка: юниты и здания вместе.
              if (!shift) scene.selection.clear()
              dragging = { kind: 'box', from: point }
            } else {
              if (shift && scene.selection.has(target)) scene.selection.delete(target)
              else {
                if (!shift && !scene.selection.has(target)) scene.selection.clear()
                scene.selection.add(target)
                dragging = { kind: 'group', from: { x, y } }
              }
            }
          } else if (dragging?.kind === 'box') {
            const { from } = dragging
            const box = { fromX: from.x, fromY: from.y, toX: point.x, toY: point.y }
            const hits = entitiesIn(sim, Math.min(box.fromX, box.toX), Math.min(box.fromY, box.toY), Math.max(box.fromX, box.toX), Math.max(box.fromY, box.toY))
            scene.selectionBox = phase === 'up' ? null : { ...box, hits }
            if (phase === 'up') for (const entity of hits) scene.selection.add(entity)
          } else if (dragging?.kind === 'group' && (x !== dragging.from.x || y !== dragging.from.y)) {
            // Выбранное тянут мышью вместе: сдвиг целыми тайлами, если всем есть где встать.
            if (moveGroup(sim, scene.selection, x - dragging.from.x, y - dragging.from.y)) {
              dragging.from = { x, y }
              touched()
            }
          }
          if (phase === 'up') dragging = null
        }
      },
      hover(tile) {
        const { tool, size, unit, player, deposit } = state.current
        setHover(tile)
        // Месторождение под указателем или выбранное — в рамке. В «Выборе» рамка занята, пока тянут выделение.
        if (tool === 'deposit' || (tool === 'select' && dragging?.kind !== 'box')) {
          const spot = (tool === 'deposit' && tile && depositUnder(sim, tile.x + 0.5, tile.y + 0.5)) || deposit
          scene.selectionBox = spot ? { fromX: spot.x, fromY: spot.y, toX: spot.x + DEPOSIT_SIZE, toY: spot.y + DEPOSIT_SIZE, hits: [] } : null
          dropGhost()
          return
        }
        // Юнит, который встанет по щелчку, виден под указателем призраком.
        if (tool === 'unit' && tile) ghostRef.current = moveGhost(sim, ghostRef.current, unit, player, tile.x, tile.y)
        else dropGhost()
        // Кисть карты показана рамкой: сколько тайлов она накроет.
        if (tool !== 'paint' || !tile) {
          if (tool !== 'select') scene.selectionBox = null
          return
        }
        const from = Math.floor(size / 2)
        scene.selectionBox = { fromX: tile.x - from, fromY: tile.y - from, toX: tile.x - from + size, toY: tile.y - from + size, hits: [] }
      },
    }
  }

  /** Выбирает месторождение (null — снимает выбор). Ref — сразу: обработчики холста читают его раньше перерисовки. */
  const selectDeposit = (spot: { x: number; y: number } | null) => {
    const at = spot && { x: spot.x, y: spot.y }
    state.current.deposit = at
    setDeposit(at)
  }

  /** Убирает призрак юнита: он не часть мира. */
  const dropGhost = () => {
    const sim = simRef.current
    if (sim && ghostRef.current !== undefined) erase(sim, ghostRef.current)
    ghostRef.current = undefined
  }

  const save = async () => {
    const sim = simRef.current
    const opened = openedRef.current
    if (!sim || !opened) return
    dropGhost()
    const { fog: _, ...rest } = sim.save()
    // Без тумана разведанной была бы вся карта: игроки получают прежнее разведанное.
    const save: SimSave = { ...rest, ...(opened.save.fog === false && { fog: false }), explored: opened.save.explored }
    try {
      if ('slot' in launch) {
        await storeSave(launch.slot.id, save)
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
  const game = gameRef.current
  const players = sim ? playersOf(sim) : []
  const selected = game ? [...game.scene.selection].filter((entity) => sim?.world.alive(entity)) : []
  const tile = hover && sim ? describeTile(sim, hover.x, hover.y) : null
  const spot = deposit && sim ? depositAt(sim, deposit.x, deposit.y) : null

  return (
    <main class="game editor">
      <canvas ref={canvasRef} class="game__canvas" />
      {sim && error === null && (
        <aside class="hud editor__panel">
          <header class="editor__head">
            <strong>Редактор</strong>
            <span>{'slot' in launch ? launch.slot.name : launch.name}</span>
          </header>

          <section class="editor__section">
            <h3>Игрок</h3>
            <div class="editor__chips">
              <button class={player === 0 ? 'is-active' : ''} title="Ничьё: здания и юниты без владельца" onClick={() => setPlayer(0)}>
                0
              </button>
              {players.map((id) => (
                <button key={id} class={player === id ? 'is-active' : ''} onClick={() => setPlayer(id)}>
                  {id}
                </button>
              ))}
              <button title="Новый игрок" onClick={() => (setPlayer(addPlayer(sim)), touched())}>
                +
              </button>
            </div>
            {player > 0 && (
              <label class="editor__field">
                Кредиты
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={creditsOf(sim, player)}
                  onChange={(event) => {
                    setCredits(sim, player, Number(event.currentTarget.value) || 0)
                    touched()
                  }}
                />
              </label>
            )}
          </section>

          <section class="editor__section">
            <div class="editor__tabs">
              {TOOLS.map(([id, label]) => (
                <button key={id} class={tool === id ? 'is-active' : ''} onClick={() => setTool(id)}>
                  {label}
                </button>
              ))}
            </div>
            {tool === 'paint' && (
              <div class="editor__options">
                <Choice label="Земля" options={TERRAINS} value={brush.terrain} set={(terrain) => setBrush({ ...brush, terrain })} />
                <Choice label="Ярус" options={TIERS.map((tier) => [tier, tier === undefined ? 'как есть' : String(tier)])} value={brush.tier} set={(tier) => setBrush({ ...brush, tier })} />
                <Choice label="Кромка" options={CLIFFS} value={brush.cliff} set={(cliff) => setBrush({ ...brush, cliff })} />
                <label class="editor__field">
                  Кисть {size}×{size}
                  <input type="range" min={1} max={15} step={2} value={size} onInput={(event) => setSize(Number(event.currentTarget.value))} />
                </label>
                <p class="editor__note">Горы кистью не ставятся, но стираются. Правка карты сразу видна всем игрокам.</p>
              </div>
            )}
            {tool === 'building' && (
              <div class="editor__list">
                {BUILDING_TYPES.map((type) => (
                  <button key={type} class={building === type ? 'is-active' : ''} onClick={() => setBuilding(type)}>
                    {BUILDING_NAMES[type]}
                  </button>
                ))}
              </div>
            )}
            {tool === 'unit' && (
              <div class="editor__list">
                {UNIT_TYPES.map((type) => (
                  <button key={type} class={unit === type ? 'is-active' : ''} onClick={() => setUnit(type)}>
                    {UNIT_NAMES[type]}
                  </button>
                ))}
              </div>
            )}
            {tool === 'deposit' && (
              <div class="editor__options">
                <Choice label="Новое месторождение" options={DEPOSIT_TYPES.map((type) => [type, RESOURCE_NAMES[type]])} value={kind} set={(type) => (setKind(type), setReserve(DEPOSIT_KINDS[type].max))} />
                <label class="editor__field">
                  Запас
                  <input type="number" min={0} step={100} value={reserve} onChange={(event) => setReserve(Number(event.currentTarget.value) || 0)} />
                </label>
                <p class="editor__note">Щелчок по месторождению — выбрать, тащить — перенести. Щелчок по скале кладёт ещё одно, щелчок мимо выбранного — снимает выбор.</p>
              </div>
            )}
            {(tool === 'deposit' || tool === 'select') && spot && (
              <div class="editor__options">
                <h3>
                  {RESOURCE_NAMES[spot.kind]} · {spot.x}, {spot.y}
                </h3>
                <Choice label="Вид" options={DEPOSIT_TYPES.map((type) => [type, RESOURCE_NAMES[type]])} value={spot.kind} set={(type) => (setDepositOf(sim, spot, type, reserveLeft(sim, spot.x, spot.y)), touched())} />
                <label class="editor__field">
                  Осталось
                  <input type="number" min={0} step={100} value={reserveLeft(sim, spot.x, spot.y)} onChange={(event) => (setDepositOf(sim, spot, spot.kind, Number(event.currentTarget.value) || 0), touched())} />
                </label>
                <button class="menu__danger" onClick={() => (removeDeposit(sim, spot), selectDeposit(null), touched())}>
                  Убрать месторождение
                </button>
              </div>
            )}
            {tool === 'select' && <p class="editor__note">Щелчок — выбрать юнит, здание или месторождение, рамка — юниты и здания вместе, Shift — добавить или снять. Выбранное тащится мышью разом.</p>}
            {tool === 'erase' && <p class="editor__note">Щелчок или протяжка убирает здание или юнит без взрыва и груза на земле.</p>}
          </section>

          {tool === 'select' && selected.length > 0 && <Inspector sim={sim} entities={selected} changed={() => touched()} />}

          <footer class="editor__foot">
            <small class="editor__status">
              {tile && hover ? `${hover.x}, ${hover.y} · ${terrainName(tile.terrain)}${tile.tier === undefined ? '' : ` · ярус ${tile.tier}`}${tile.cliff ? ' · обрыв' : ''}${tile.foot ? ' · подножие' : ''}` : ''}
              {status && <span> · {status}</span>}
            </small>
            <div class="editor__actions">
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
            </div>
          </footer>
        </aside>
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

const terrainName = (terrain: Terrain) => ({ [Terrain.Swamp]: 'болото', [Terrain.Sand]: 'песок', [Terrain.Rock]: 'скала', [Terrain.Mountain]: 'гора' })[terrain] ?? '—'

function Choice<T>({ label, options, value, set }: { label: string; options: [T, string][]; value: T; set(value: T): void }) {
  return (
    <div class="editor__choice">
      <span>{label}</span>
      <div class="editor__chips">
        {options.map(([option, name]) => (
          <button key={name} class={option === value ? 'is-active' : ''} onClick={() => set(option)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Выбранное: владелец, прочность, склад. Если выбрано несколько — правится каждое. */
function Inspector({ sim, entities, changed }: { sim: Sim; entities: Entity[]; changed(): void }) {
  const { world } = sim
  const first = entities[0]
  const type = world.get(first, Unit)?.type
  const kind = world.get(first, Building)?.type
  const name = type ? UNIT_NAMES[type] : kind ? BUILDING_NAMES[kind] : '—'
  const health = world.get(first, Health)
  const inventory = world.get(first, Inventory)
  const owner = world.get(first, Owner)?.player ?? 0
  const players = [0, ...playersOf(sim)]
  const each = (action: (entity: Entity) => void) => {
    for (const entity of entities) action(entity)
    changed()
  }
  return (
    <section class="editor__section">
      <h3>
        {name}
        {entities.length > 1 && ` и ещё ${entities.length - 1}`}
      </h3>
      <div class="editor__choice">
        <span>Владелец</span>
        <div class="editor__chips">
          {players.map((id) => (
            <button key={id} class={owner === id ? 'is-active' : ''} onClick={() => each((entity) => setOwner(sim, entity, id))}>
              {id}
            </button>
          ))}
        </div>
      </div>
      {health && (
        <label class="editor__field">
          Прочность {Math.round((health.value / health.max) * 100)}%
          <input type="range" min={1} max={100} value={Math.round((health.value / health.max) * 100)} onInput={(event) => each((entity) => setHealth(sim, entity, Number(event.currentTarget.value) / 100))} />
        </label>
      )}
      {inventory && entities.length === 1 && (
        <div class="editor__stock">
          <span>
            Склад · объём {inventory.capacity}
          </span>
          {GOODS.map((good: Good) => (
            <label key={good} class="editor__field">
              {goodName(good)}
              <input
                type="number"
                min={0}
                value={inventory.items[good] ?? 0}
                onChange={(event) => {
                  setStock(sim, first, good, Number(event.currentTarget.value) || 0)
                  changed()
                }}
              />
            </label>
          ))}
        </div>
      )}
      <button class="menu__danger" onClick={() => each((entity) => erase(sim, entity))}>
        Убрать
      </button>
    </section>
  )
}
