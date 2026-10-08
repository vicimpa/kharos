import { useEffect, useRef, useState } from 'preact/hooks'
import type { Entity } from '../ecs'
import { createGame, type Game } from '../game/game'
import { ordersAt } from '../game/orders'
import { placementOf } from '../game/placing'
import type { SceneEdit } from '../game/scene'
import { loadSave, storeSave } from '../game/storage'
import type { MapSettings } from '../map/settings'
import { Terrain } from '../map/terrain'
import { decodeSave, encodeSave, readJson, type Sections } from '../save/file'
import {
  Armed,
  BUILDING_TYPES,
  Builds,
  Building,
  Converting,
  Harvester,
  Hauler,
  Orders,
  Path,
  Producer,
  Site,
  Tactics,
  type Command,
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
import { DEPOSIT_KINDS, DEPOSIT_SIZE, DEPOSIT_TYPES, depositAt, reserveLeft, type DepositKind, type DepositSpot } from '../sim/deposits'
import {
  addPlayer,
  depositUnder,
  describeTile,
  entityAt,
  erase,
  moveGhost,
  entitiesIn,
  clearTasks,
  depositsInBox,
  orderNow,
  setFacing,
  setTurretFacing,
  turretFacing,
  moveGroup,
  paint,
  playersOf,
  putBuilding,
  canPutDeposit,
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
import { slotWorker, type Launch } from './launch'
import { reloadLocal } from '../net/connect'
import { STANCE_SLOTS } from './commands'
import { download } from './Menu'
import { BUILDING_NAMES, RESOURCE_NAMES, UNIT_NAMES, goodName } from './names'

/** Как часто панель сверяется с миром, в миллисекундах. */
const PANEL_INTERVAL = 150

type Tool = 'select' | 'paint' | 'building' | 'unit' | 'deposit'
const TOOLS: [Tool, string][] = [
  ['select', 'Выбор'],
  ['paint', 'Карта'],
  ['building', 'Здания'],
  ['unit', 'Юниты'],
  ['deposit', 'Ресурсы'],
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
  /** Приказ мышью: следующий щелчок по карте — приказ выбранным юнитам. */
  const [ordering, setOrdering] = useState(false)
  /** Призрак юнита под указателем, см. moveGhost. */
  const ghostRef = useRef<Entity | undefined>(undefined)

  // Обработчики холста читают свежее состояние через ref: игра создаётся один раз.
  const state = useRef({ tool, player, brush, size, building, unit, kind, reserve, ordering })
  state.current = { tool, player, brush, size, building, unit, kind, reserve, ordering }

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

  /** Выбранные месторождения: левые верхние тайлы. Живут в ref — их читают обработчики холста; панель и так перерисовывается. */
  const pickedRef = useRef<DepositSpot[]>([])
  const picked = (sim: Sim) => pickedRef.current.map((at) => depositAt(sim, at.x, at.y)).filter((spot) => spot !== null)
  const isPicked = (spot: { x: number; y: number }) => pickedRef.current.some((at) => at.x === spot.x && at.y === spot.y)

  /** Снимает весь выбор: юниты, здания и месторождения. */
  const clearPicks = (game: Game) => {
    game.scene.selection.clear()
    pickedRef.current = []
  }

  /** Убирает выбранное: юниты, здания и месторождения. */
  const eraseSelection = () => {
    const sim = simRef.current
    const game = gameRef.current
    if (!sim || !game) return
    const entities = [...game.scene.selection]
    const spots = picked(sim)
    if (!entities.length && !spots.length) return
    for (const entity of entities) erase(sim, entity)
    for (const spot of spots) removeDeposit(sim, spot)
    clearPicks(game)
    touched()
  }

  /** Обработчик кнопок мыши на холсте: что делает инструмент. */
  function createEdit(game: Game, sim: Sim): SceneEdit {
    const { scene } = game
    /** Что тянут мышью: выбранное разом или рамку выделения. from — тайл (у рамки — точка), от которого отсчитан сдвиг. */
    let dragging: { kind: 'group' | 'box'; from: { x: number; y: number } } | null = null
    let last = ''
    return {
      press(point, phase, shift) {
        const { tool, player, brush, size, building, unit, kind, reserve, ordering } = state.current
        const x = Math.floor(point.x)
        const y = Math.floor(point.y)
        const tile = `${x},${y}`
        if (ordering && phase === 'down') {
          // Приказ мышью: выбранным юнитам, каждому от имени его владельца, как правой кнопкой в игре. Shift — ещё приказ.
          giveOrders(game, sim, point, shift)
          if (!shift) setOrdering(false)
          return
        }
        if (tool === 'paint') {
          if (phase === 'up' || (phase === 'drag' && tile === last)) return
          last = tile
          paint(sim, x, y, size, brush)
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
        } else if (tool === 'deposit' && phase === 'down') {
          // Как здание: щелчок кладёт ещё одно там, где стоит призрак; выбирают и тащат месторождения в «Выборе».
          const at = depositSpot(x, y)
          if (putDeposit(sim, at.x, at.y, kind, reserve)) touched()
          else setStatus('Месторождение ложится на скалу не у подножия обрыва и не внахлёст с другим')
        } else if (tool === 'select') {
          if (phase === 'down') {
            const target = entityAt(sim, point.x, point.y)
            // Мимо юнитов и зданий — может быть, по месторождению: выбирается и тащится с ними наравне.
            const spot = target === undefined ? depositUnder(sim, point.x, point.y) : null
            const chosen = target !== undefined ? scene.selection.has(target) : spot ? isPicked(spot) : false
            if (target === undefined && !spot) {
              // Мимо всего — рамка.
              if (!shift) clearPicks(game)
              dragging = { kind: 'box', from: point }
            } else if (shift && chosen) {
              if (target !== undefined) scene.selection.delete(target)
              else pickedRef.current = pickedRef.current.filter((at) => at.x !== spot!.x || at.y !== spot!.y)
            } else {
              if (!shift && !chosen) clearPicks(game)
              if (target !== undefined) scene.selection.add(target)
              else if (!chosen) pickedRef.current = [...pickedRef.current, spot!]
              dragging = { kind: 'group', from: { x, y } }
            }
          } else if (dragging?.kind === 'box') {
            const { from } = dragging
            const left = Math.min(from.x, point.x)
            const top = Math.min(from.y, point.y)
            const right = Math.max(from.x, point.x)
            const bottom = Math.max(from.y, point.y)
            const hits = entitiesIn(sim, left, top, right, bottom)
            scene.selectionBox = phase === 'up' ? null : { fromX: from.x, fromY: from.y, toX: point.x, toY: point.y, hits }
            if (phase === 'up') {
              for (const entity of hits) scene.selection.add(entity)
              for (const spot of depositsInBox(sim, left, top, right, bottom)) if (!isPicked(spot)) pickedRef.current = [...pickedRef.current, spot]
            }
          } else if (dragging?.kind === 'group' && (x !== dragging.from.x || y !== dragging.from.y)) {
            // Выбранное тянут мышью вместе: сдвиг целыми тайлами, если всем есть где встать.
            const moved = moveGroup(sim, scene.selection, x - dragging.from.x, y - dragging.from.y, picked(sim))
            if (moved) {
              pickedRef.current = moved
              dragging.from = { x, y }
              touched()
            }
          }
          if (phase === 'up') dragging = null
        }
      },
      secondary(point) {
        // Правый щелчок сносит: по выбранному — всё выбранное, иначе — то, что под указателем.
        const target = entityAt(sim, point.x, point.y)
        const spot = target === undefined ? depositUnder(sim, point.x, point.y) : null
        if (target === undefined && !spot) return
        if (target !== undefined ? scene.selection.has(target) : isPicked(spot!)) return eraseSelection()
        if (target !== undefined) erase(sim, target)
        else removeDeposit(sim, spot!)
        touched()
      },
      hover(tile) {
        const { tool, size, unit, player, kind } = state.current
        setHover(tile)
        // Месторождение, которое встанет по щелчку, — призраком под указателем.
        const at = tile && depositSpot(tile.x, tile.y)
        scene.depositGhost = tool === 'deposit' && at ? { ...at, kind, blocked: !canPutDeposit(sim, at.x, at.y) } : null
        // Юнит, который встанет по щелчку, — тоже призраком.
        if (tool === 'unit' && tile) ghostRef.current = moveGhost(sim, ghostRef.current, unit, player, tile.x, tile.y)
        else dropGhost()
        // Пометки: выбранные месторождения и кисть карты — сколько тайлов она накроет.
        const marks = picked(sim).map((spot) => ({ fromX: spot.x, fromY: spot.y, toX: spot.x + DEPOSIT_SIZE, toY: spot.y + DEPOSIT_SIZE }))
        if (tool === 'paint' && tile) {
          const from = Math.floor(size / 2)
          marks.push({ fromX: tile.x - from, fromY: tile.y - from, toX: tile.x - from + size, toY: tile.y - from + size })
        }
        scene.marks = marks
      },
    }
  }

  /** Приказ мышью выбранным юнитам: каждому — от имени его владельца, как правой кнопкой в игре; выполняется сразу. */
  function giveOrders(game: Game, sim: Sim, point: { x: number; y: number }, queue: boolean) {
    const { scene } = game
    const byOwner = new Map<number, Entity[]>()
    for (const entity of scene.selection) {
      if (!sim.world.has(entity, Unit)) continue
      const owner = sim.world.get(entity, Owner)?.player ?? 0
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), entity])
    }
    const viewer = scene.player
    let given = 0
    for (const [owner, units] of byOwner) {
      // Свой и чужой — с точки зрения владельца: по его врагу — атака, по его стройке — помощь.
      scene.player = owner
      for (const command of ordersAt(scene, units, point, queue)) if (orderNow(sim, owner, command)) given++
    }
    scene.player = viewer
    if (given) touched()
    else setStatus('Приказ не принят')
  }

  /** Где ляжет месторождение под указателем на тайле (x, y): серединой под ним, как здание. */
  const depositSpot = (x: number, y: number) => ({ x: x - Math.floor(DEPOSIT_SIZE / 2), y: y - Math.floor(DEPOSIT_SIZE / 2) })

  /** Убирает призрак юнита: он не часть мира. */
  const dropGhost = () => {
    const sim = simRef.current
    if (sim && ghostRef.current !== undefined) erase(sim, ghostRef.current)
    ghostRef.current = undefined
  }

  // Delete и Backspace сносят выбранное, Escape снимает приказ мышью.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.code === 'Delete' || event.code === 'Backspace') eraseSelection()
      if (event.code === 'Escape') setOrdering(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
  const game = gameRef.current
  const players = sim ? playersOf(sim) : []
  const selected = game ? [...game.scene.selection].filter((entity) => sim?.world.alive(entity)) : []
  const tile = hover && sim ? describeTile(sim, hover.x, hover.y) : null
  const spots = sim ? picked(sim) : []

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
                <p class="editor__note">Щелчок кладёт месторождение там, где призрак. Выбрать, перенести и поменять — в «Выборе».</p>
              </div>
            )}
            {tool === 'select' && (
              <p class="editor__note">
                Щелчок — выбрать, рамка — юниты, здания и месторождения вместе, Shift — добавить или снять. Выбранное тащится мышью разом. Правый щелчок или Delete — снести.
              </p>
            )}
          </section>

          {tool === 'select' && spots.length > 0 && (
            <section class="editor__section">
              <h3>
                {spots.length === 1 ? `${RESOURCE_NAMES[spots[0].kind]} · ${spots[0].x}, ${spots[0].y}` : `Месторождений: ${spots.length}`}
              </h3>
              <Choice
                label="Вид"
                options={DEPOSIT_TYPES.map((type) => [type, RESOURCE_NAMES[type]])}
                value={spots.every((spot) => spot.kind === spots[0].kind) ? spots[0].kind : undefined}
                set={(type) => {
                  for (const spot of spots) setDepositOf(sim, spot, type!, reserveLeft(sim, spot.x, spot.y))
                  touched()
                }}
              />
              <label class="editor__field">
                Осталось{spots.length > 1 && ' в каждом'}
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={reserveLeft(sim, spots[0].x, spots[0].y)}
                  onChange={(event) => {
                    for (const spot of spots) setDepositOf(sim, spot, spot.kind, Number(event.currentTarget.value) || 0)
                    touched()
                  }}
                />
              </label>
            </section>
          )}

          {tool === 'select' && selected.length > 0 && (
            <Inspector sim={sim} entities={selected} changed={() => touched()} ordering={ordering} order={setOrdering} />
          )}
          {(selected.length > 0 || spots.length > 0) && tool === 'select' && (
            <button class="menu__danger" onClick={eraseSelection}>
              Снести выбранное
            </button>
          )}

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

const DEGREE = Math.PI / 180

/** Что делает юнит или здание сейчас и что у него в очереди: строки для панели. */
function tasksOf(sim: Sim, entity: Entity): string[] {
  const { world } = sim
  const tasks: string[] = []
  const nameOf = (target: number) => {
    const unit = world.get(target as Entity, Unit)?.type
    const building = world.get(target as Entity, Building)?.type ?? world.get(target as Entity, Site)?.type
    return unit ? UNIT_NAMES[unit] : building ? BUILDING_NAMES[building] : `#${target}`
  }
  const converting = world.get(entity, Converting)
  if (converting) tasks.push(world.has(entity, Unit) ? 'Разворачивается в главное здание' : 'Сворачивается в MCV')
  const producer = world.get(entity, Producer)
  if (producer?.queue.length) tasks.push(`Производит: ${producer.queue.map((type) => UNIT_NAMES[type]).join(', ')}`)
  const builds = world.get(entity, Builds)
  if (builds && world.alive(builds.site as Entity)) tasks.push(`${world.has(builds.site as Entity, Site) ? 'Строит' : 'Чинит'}: ${nameOf(builds.site)}`)
  const armed = world.get(entity, Armed)
  if (armed && armed.target >= 0 && world.alive(armed.target as Entity)) tasks.push(`Атакует: ${nameOf(armed.target)}`)
  const harvester = world.get(entity, Harvester)
  if (harvester && harvester.x >= 0) tasks.push(`Копает месторождение ${harvester.x}, ${harvester.y}`)
  else if (harvester?.seek) tasks.push(`Ищет месторождение: ${harvester.seek === 'any' ? 'любое' : RESOURCE_NAMES[harvester.seek]}`)
  const hauler = world.get(entity, Hauler)
  if (hauler && !harvester) {
    if (hauler.mine >= 0) tasks.push(`Возит из шахты #${hauler.mine}`)
    if (hauler.route.length) tasks.push(`Маршрут: ${hauler.route.map(nameOf).join(' → ')}`)
    if (hauler.supply >= 0) tasks.push(`Обеспечивает: ${nameOf(hauler.supply)}`)
    if (hauler.pickup >= 0) tasks.push('Вывозит дроп')
    if (hauler.serve.length) tasks.push(`Обслуживает: ${hauler.serve.map(nameOf).join(', ')}`)
    if (hauler.from >= 0) tasks.push(`Везёт ${goodName(hauler.resource)}: ${nameOf(hauler.from)} → ${hauler.to >= 0 ? nameOf(hauler.to) : '?'}`)
  }
  const tactics = world.get(entity, Tactics)
  if (tactics?.patrol.length) tasks.push(`Патруль: ${tactics.patrol.length / 2} точ.`)
  const path = world.get(entity, Path)
  if (path) tasks.push(`Едет к ${path.goalX}, ${path.goalY}`)
  for (const { command } of world.get(entity, Orders)?.list ?? []) tasks.push(`В очереди: ${COMMAND_NAMES[command.type] ?? command.type}`)
  return tasks
}

const COMMAND_NAMES: Partial<Record<Command['type'], string>> = {
  move: 'ехать',
  attack: 'атаковать',
  assist: 'строить',
  harvest: 'копать',
  haul: 'возить из шахты',
  pickup: 'вывезти дроп',
  supply: 'обеспечить',
  patrol: 'патруль',
  build: 'заложить здание',
  pave: 'класть покрытие',
  unpave: 'снять покрытие',
  demolish: 'разобрать',
}

/** Выбранное: владелец, прочность, поворот, задания, склад. Если выбрано несколько — правится каждое. */
function Inspector({ sim, entities, changed, ordering, order }: { sim: Sim; entities: Entity[]; changed(): void; ordering: boolean; order(on: boolean): void }) {
  const { world } = sim
  const first = entities[0]
  const type = world.get(first, Unit)?.type
  const kind = world.get(first, Building)?.type
  const name = type ? UNIT_NAMES[type] : kind ? BUILDING_NAMES[kind] : '—'
  const health = world.get(first, Health)
  const inventory = world.get(first, Inventory)
  const owner = world.get(first, Owner)?.player ?? 0
  const players = [0, ...playersOf(sim)]
  const units = entities.filter((entity) => world.has(entity, Unit))
  const facing = world.get(units[0], Unit)?.facing
  const turretAt = entities.map((entity) => turretFacing(sim, entity)).find((angle) => angle !== undefined)
  const stance = world.get(first, Tactics)?.stance
  const tasks = entities.length === 1 ? tasksOf(sim, first) : []
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
      {facing !== undefined && (
        <label class="editor__field">
          Корпус {Math.round(facing / DEGREE)}°
          <input type="range" min={-180} max={180} step={15} value={Math.round(facing / DEGREE)} onInput={(event) => each((entity) => setFacing(sim, entity, Number(event.currentTarget.value) * DEGREE))} />
        </label>
      )}
      {turretAt !== undefined && (
        <label class="editor__field">
          Турели {Math.round(turretAt / DEGREE)}°
          <input type="range" min={-180} max={180} step={15} value={Math.round(turretAt / DEGREE)} onInput={(event) => each((entity) => setTurretFacing(sim, entity, Number(event.currentTarget.value) * DEGREE))} />
        </label>
      )}
      {units.length > 0 && (
        <div class="editor__stock">
          <span>Задания</span>
          {entities.length === 1 && (tasks.length ? tasks.map((task) => <small key={task}>{task}</small>) : <small class="editor__note">нет — стоит</small>)}
          {stance && (
            <div class="editor__chips">
              {STANCE_SLOTS.map((slot) => (
                <button
                  key={slot.stance}
                  title={slot.title}
                  class={stance === slot.stance ? 'is-active' : ''}
                  onClick={() => each((entity) => orderNow(sim, world.get(entity, Owner)?.player ?? 0, { type: 'stance', units: [entity], stance: slot.stance }))}
                >
                  {slot.label}
                </button>
              ))}
            </div>
          )}
          <div class="editor__chips">
            <button class={ordering ? 'is-active' : ''} title="Следующий щелчок по карте — приказ, как правой кнопкой в игре; с Shift — в очередь" onClick={() => order(!ordering)}>
              Приказ мышью
            </button>
            <button onClick={() => each((entity) => clearTasks(sim, entity))}>Снять задания</button>
          </div>
        </div>
      )}
      {inventory && entities.length === 1 && (
        <div class="editor__stock">
          <span>Склад · объём {inventory.capacity}</span>
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
    </section>
  )
}
