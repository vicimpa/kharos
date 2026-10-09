import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Entity } from '../ecs'
import type { Game } from '../game/game'
import { ordersAt } from '../game/orders'
import { placementOf } from '../game/placing'
import type { SceneEdit } from '../game/scene'
import { Biome, Dunes as DUNES_OF, MAX_PEAK_RADIUS, Terrain, type Dunes } from '../map/terrain'
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
  creditsOf,
  type BuildingType,
  type Good,
  type Sim,
  type UnitType,
} from '../sim'
import { DEPOSIT_KINDS, DEPOSIT_SIZE, DEPOSIT_TYPES, depositAt, reserveLeft, type DepositKind } from '../sim/deposits'
import {
  depositUnder,
  describeTile,
  entityAt,
  erase,
  moveGhost,
  entitiesIn,
  depositsInBox,
  turretFacings,
  playersOf,
  canPutDeposit,
  playerCamera,
  type Brush,
  type BrushShape,
} from '../sim/editor'
import type { EditOp, EditResult } from '../sim/editOps'
import { STANCE_SLOTS } from './commands'
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
  [Terrain.Mountain, 'гора'],
]
const DUNES: [Dunes | undefined, string][] = [
  [undefined, 'как есть'],
  [DUNES_OF.Natural, 'природные'],
  [DUNES_OF.None, 'убрать'],
  [DUNES_OF.Many, 'насыпать'],
]
const BIOMES: [Biome | undefined, string][] = [
  [undefined, 'как есть'],
  [Biome.Erg, 'эрг'],
  [Biome.SaltFlats, 'солончаки'],
  [Biome.RedWastes, 'красные пустоши'],
  [Biome.Marsh, 'топи'],
]
const SHAPES: [BrushShape, string][] = [
  ['square', 'квадрат'],
  ['circle', 'круг'],
  ['spray', 'разброс'],
]
const TIERS: (number | undefined)[] = [undefined, 0, 1, 2, 3]
const CLIFFS: [boolean | undefined, string][] = [
  [undefined, 'как есть'],
  [true, 'обрыв'],
  [false, 'пологий'],
]

export interface EditorPanelProps {
  /** Мир, по которому панель показывает, что есть: у сетевого редактора — копия мира с хоста. */
  sim: Sim
  game: Game
  /** Применяет правку: локально — сразу и с ответом, в сети — шлёт хосту, и ответ придёт в чат. */
  apply(edit: EditOp): EditResult
  /** Редактор живого мира на сервере: правки доходят через тик, призрака юнита нет, игрок сцены остаётся своим. */
  remote?: boolean
  title: string
  subtitle: string
  /** Ники игроков по номеру: на сервере игроков узнают по ним, а не по номерам. */
  names?: ReadonlyMap<number, string>
  /** Правка ушла: локальный редактор помечает несохранённое. */
  changed?(): void
  /** Кнопки внизу панели: выйти, сохранить. */
  children?: ComponentChildren
}

/**
 * Панель редактора — режим бога над миром: кистью правится карта, ставятся и сносятся здания и юниты любого игрока,
 * у выбранного — владелец, прочность и склад, у игрока — кредиты. Каждая правка — EditOp: так одна и та же панель
 * правит и сохранение, и живой мир на сервере. Пока панель открыта, левая и правая кнопки на холсте — её.
 */
export function EditorPanel({ sim, game, apply, remote = false, title, subtitle, names, changed, children }: EditorPanelProps) {
  /** Как игрок подписан на кнопке: номер и ник, если он известен. */
  const label = (id: number) => (names?.has(id) ? `${id} ${names.get(id)}` : String(id))
  const [tool, setTool] = useState<Tool>('select')
  const [player, setPlayer] = useState(() => playersOf(sim)[0] ?? 1)
  const [brush, setBrush] = useState<Brush>({ terrain: Terrain.Rock, shape: 'square' })
  const [size, setSize] = useState(3)
  const [building, setBuilding] = useState<BuildingType>('generator')
  const [unit, setUnit] = useState<UnitType>('tank')
  const [status, setStatus] = useState('')
  /** Панель перерисовывается по счётчику: мир меняется мимо Preact. */
  const [, setFrame] = useState(0)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  /** Вид и запас месторождения, которое кладёт инструмент «Ресурсы». */
  const [kind, setKind] = useState<DepositKind>('metal')
  const [reserve, setReserve] = useState(DEPOSIT_KINDS.metal.max)
  /** Приказ мышью: следующий щелчок по карте — приказ выбранным юнитам. */
  const [ordering, setOrdering] = useState(false)
  /** Призрак юнита под указателем, см. moveGhost. В сетевом редакторе его нет: мир копии правит только хост. */
  const ghostRef = useRef<Entity | undefined>(undefined)

  // Обработчики холста читают свежее состояние через ref: обработчик ставится один раз.
  const state = useRef({ tool, player, brush, size, building, unit, kind, reserve, ordering })
  state.current = { tool, player, brush, size, building, unit, kind, reserve, ordering }

  /** Правка: ответ — в строку состояния; удалась — панель помечает её. */
  const edit = (op: EditOp) => {
    const failed = apply(op)
    if (failed) setStatus(failed)
    else {
      setStatus('')
      changed?.()
    }
    return !failed
  }

  useEffect(() => {
    const { scene } = game
    scene.edit = createEdit()
    return () => {
      dropGhost()
      scene.edit = undefined
      scene.marks = []
      scene.depositGhost = null
      scene.placing = null
      scene.selectionBox = null
      scene.selection.clear()
    }
  }, [game])

  // Инструмент и игрок — в сцену: от них зависит, что показано под указателем.
  useEffect(() => {
    const { scene } = game
    // Ничьё — не игрок: смотреть его глазами незачем, свои и чужие тогда — у первого игрока. В сети сцена смотрит
    // глазами своего игрока: от него зависит весь интерфейс.
    if (!remote) scene.player = player || playersOf(sim)[0] || 1
    scene.placing = tool === 'building' ? building : null
    scene.selectionBox = null
    if (tool !== 'unit') dropGhost()
  }, [tool, player, building, game])

  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), PANEL_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  /** Выбранные месторождения: левые верхние тайлы. Живут в ref — их читают обработчики холста; панель и так перерисовывается. */
  const pickedRef = useRef<{ x: number; y: number }[]>([])
  const picked = () => pickedRef.current.map((at) => depositAt(sim, at.x, at.y)).filter((spot) => spot !== null)
  const isPicked = (spot: { x: number; y: number }) => pickedRef.current.some((at) => at.x === spot.x && at.y === spot.y)
  const spotsOf = (list: readonly { x: number; y: number }[]) => list.map(({ x, y }) => ({ x, y }))

  /** Снимает весь выбор: юниты, здания и месторождения. */
  const clearPicks = () => {
    game.scene.selection.clear()
    pickedRef.current = []
  }

  /** Убирает выбранное: юниты, здания и месторождения. */
  const eraseSelection = () => {
    const entities = [...game.scene.selection]
    const spots = picked()
    if (!entities.length && !spots.length) return
    if (entities.length) edit({ op: 'erase', entities })
    if (spots.length) edit({ op: 'removeDeposit', spots: spotsOf(spots) })
    clearPicks()
  }

  /** Обработчик кнопок мыши на холсте: что делает инструмент. */
  function createEdit(): SceneEdit {
    const { scene } = game
    /** Что тянут мышью: выбранное разом или рамку выделения. from — тайл (у рамки — точка), от которого отсчитан сдвиг. */
    let dragging: { kind: 'group' | 'box' | 'camera' | 'zoom'; from: { x: number; y: number } } | null = null
    /** Рамка камеры выбранного игрока: что видно на экране размером с этот, в тайлах. */
    const cameraBox = () => {
      const view = state.current.player ? playerCamera(sim, state.current.player) : undefined
      if (!view) return null
      const halfWidth = scene.camera.width / view.zoom / 2
      const halfHeight = scene.camera.height / view.zoom / 2
      return { view, left: view.x - halfWidth, top: view.y - halfHeight, right: view.x + halfWidth, bottom: view.y + halfHeight }
    }
    /** Попала ли точка в рамку камеры: в угол — менять масштаб, в край — двигать. Внутри рамки — обычный щелчок. */
    const cameraHit = (point: { x: number; y: number }) => {
      const box = cameraBox()
      if (!box) return null
      const reach = 10 / scene.camera.zoom
      const nearX = Math.min(Math.abs(point.x - box.left), Math.abs(point.x - box.right)) < reach
      const nearY = Math.min(Math.abs(point.y - box.top), Math.abs(point.y - box.bottom)) < reach
      const withinX = point.x > box.left - reach && point.x < box.right + reach
      const withinY = point.y > box.top - reach && point.y < box.bottom + reach
      if (nearX && nearY) return 'zoom'
      if ((nearX && withinY) || (nearY && withinX)) return 'camera'
      return null
    }
    let last = ''
    return {
      press(point, phase, shift) {
        const { tool, player, brush, size, unit, kind, reserve, ordering } = state.current
        const x = Math.floor(point.x)
        const y = Math.floor(point.y)
        const tile = `${x},${y}`
        if (ordering && phase === 'down') {
          // Приказ мышью: выбранным юнитам, каждому от имени его владельца, как правой кнопкой в игре. Shift — ещё приказ.
          giveOrders(point, shift)
          if (!shift) setOrdering(false)
          return
        }
        if (tool === 'paint') {
          if (phase === 'up' || (phase === 'drag' && tile === last)) return
          last = tile
          edit({ op: 'paint', x, y, size, brush })
        } else if (tool === 'building' && phase === 'down') {
          // Здание встаёт там, где его показывает рамка под указателем.
          const placement = placementOf(scene)
          if (placement) edit({ op: 'building', type: placement.type, x: placement.x, y: placement.y, player })
        } else if (tool === 'unit' && phase === 'down') {
          // Призрак стоит на месте юнита: убрать его, иначе юнит туда не встанет.
          dropGhost()
          edit({ op: 'unit', type: unit, x, y, player })
        } else if (tool === 'deposit' && phase === 'down') {
          // Как здание: щелчок кладёт ещё одно там, где стоит призрак; выбирают и тащат месторождения в «Выборе».
          const at = depositSpot(x, y)
          edit({ op: 'deposit', x: at.x, y: at.y, kind, reserve })
        } else if (dragging?.kind === 'camera' || dragging?.kind === 'zoom') {
          // Рамку камеры игрока тянут за край — двигают, за угол — меняют масштаб: угол идёт за мышью.
          const box = cameraBox()
          if (box) {
            if (dragging.kind === 'camera') {
              edit({ op: 'camera', player, camera: { ...box.view, x: box.view.x + point.x - dragging.from.x, y: box.view.y + point.y - dragging.from.y } })
              dragging.from = point
            } else {
              const half = Math.max(Math.abs(point.x - box.view.x) / scene.camera.width, Math.abs(point.y - box.view.y) / scene.camera.height)
              edit({ op: 'camera', player, camera: { ...box.view, zoom: scene.camera.clampZoom(1 / (2 * Math.max(half, 1e-3))) } })
            }
          }
          if (phase === 'up') dragging = null
        } else if (tool === 'select' && phase === 'down' && cameraHit(point)) {
          dragging = { kind: cameraHit(point)!, from: point }
        } else if (tool === 'select') {
          if (phase === 'down') {
            const target = entityAt(sim, point.x, point.y)
            // Мимо юнитов и зданий — может быть, по месторождению: выбирается и тащится с ними наравне.
            const spot = target === undefined ? depositUnder(sim, point.x, point.y) : null
            const chosen = target !== undefined ? scene.selection.has(target) : spot ? isPicked(spot) : false
            if (target === undefined && !spot) {
              // Мимо всего — рамка.
              if (!shift) clearPicks()
              dragging = { kind: 'box', from: point }
            } else if (shift && chosen) {
              if (target !== undefined) scene.selection.delete(target)
              else pickedRef.current = pickedRef.current.filter((at) => at.x !== spot!.x || at.y !== spot!.y)
            } else {
              if (!shift && !chosen) clearPicks()
              if (target !== undefined) scene.selection.add(target)
              else if (!chosen) pickedRef.current = [...pickedRef.current, { x: spot!.x, y: spot!.y }]
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
              for (const spot of depositsInBox(sim, left, top, right, bottom)) if (!isPicked(spot)) pickedRef.current = [...pickedRef.current, { x: spot.x, y: spot.y }]
            }
          } else if (dragging?.kind === 'group' && (x !== dragging.from.x || y !== dragging.from.y)) {
            // Выбранное тянут мышью вместе: сдвиг целыми тайлами, если всем есть где встать. В сети ответ придёт
            // позже, поэтому выбор месторождений сдвигается сразу; не сдвинулись — он просто опустеет.
            const dx = x - dragging.from.x
            const dy = y - dragging.from.y
            if (edit({ op: 'move', entities: [...scene.selection], dx, dy, deposits: [...pickedRef.current] })) {
              pickedRef.current = pickedRef.current.map((at) => ({ x: at.x + dx, y: at.y + dy }))
              dragging.from = { x, y }
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
        if (target !== undefined) edit({ op: 'erase', entities: [target] })
        else edit({ op: 'removeDeposit', spots: [{ x: spot!.x, y: spot!.y }] })
      },
      hover(tile) {
        const { tool, size, unit, player, kind } = state.current
        setHover(tile)
        // Месторождение, которое встанет по щелчку, — призраком под указателем.
        const at = tile && depositSpot(tile.x, tile.y)
        scene.depositGhost = tool === 'deposit' && at ? { ...at, kind, blocked: !canPutDeposit(sim, at.x, at.y) } : null
        // Юнит, который встанет по щелчку, — тоже призраком.
        if (tool === 'unit' && tile && !remote) ghostRef.current = moveGhost(sim, ghostRef.current, unit, player, tile.x, tile.y)
        else dropGhost()
        // Пометки: выбранные месторождения, кисть карты — сколько тайлов она накроет, и камера выбранного игрока —
        // рамка экрана с крестом в середине.
        const marks = picked().map((spot) => ({ fromX: spot.x, fromY: spot.y, toX: spot.x + DEPOSIT_SIZE, toY: spot.y + DEPOSIT_SIZE }))
        const box = cameraBox()
        if (box) {
          const arm = 12 / scene.camera.zoom
          marks.push({ fromX: box.left, fromY: box.top, toX: box.right, toY: box.bottom })
          marks.push({ fromX: box.view.x - arm, fromY: box.view.y, toX: box.view.x + arm, toY: box.view.y })
          marks.push({ fromX: box.view.x, fromY: box.view.y - arm, toX: box.view.x, toY: box.view.y + arm })
        }
        if (tool === 'paint' && tile) {
          const from = Math.floor(size / 2)
          marks.push({ fromX: tile.x - from, fromY: tile.y - from, toX: tile.x - from + size, toY: tile.y - from + size })
        }
        scene.marks = marks
      },
    }
  }

  /** Приказ мышью выбранным юнитам: каждому — от имени его владельца, как правой кнопкой в игре; выполняется сразу. */
  function giveOrders(point: { x: number; y: number }, queue: boolean) {
    const { scene } = game
    const byOwner = new Map<number, Entity[]>()
    for (const entity of scene.selection) {
      if (!sim.world.has(entity, Unit)) continue
      const owner = sim.world.get(entity, Owner)?.player ?? 0
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), entity])
    }
    const viewer = scene.player
    const orders: EditOp[] = []
    for (const [owner, units] of byOwner) {
      // Свой и чужой — с точки зрения владельца: по его врагу — атака, по его стройке — помощь.
      scene.player = owner
      for (const command of ordersAt(scene, units, point, queue)) orders.push({ op: 'order', player: owner, command })
    }
    scene.player = viewer
    if (!orders.length) setStatus('Приказ не принят')
    for (const order of orders) edit(order)
  }

  /** Где ляжет месторождение под указателем на тайле (x, y): серединой под ним, как здание. */
  const depositSpot = (x: number, y: number) => ({ x: x - Math.floor(DEPOSIT_SIZE / 2), y: y - Math.floor(DEPOSIT_SIZE / 2) })

  /** Убирает призрак юнита: он не часть мира. */
  const dropGhost = () => {
    if (ghostRef.current !== undefined) erase(sim, ghostRef.current)
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

  const players = playersOf(sim)
  const selected = [...game.scene.selection].filter((entity) => sim.world.alive(entity) && entity !== ghostRef.current)
  const tile = hover ? describeTile(sim, hover.x, hover.y) : null
  const spots = picked()

  return (
    <aside class={`hud editor__panel${remote ? ' is-live' : ''}`}>
      <header class="editor__head">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </header>

      <section class="editor__section">
        <h3>Игрок</h3>
        <div class="editor__chips">
          <button class={player === 0 ? 'is-active' : ''} title="Ничьё: здания и юниты без владельца" onClick={() => setPlayer(0)}>
            0
          </button>
          {players.map((id) => (
            <button key={id} class={player === id ? 'is-active' : ''} onClick={() => setPlayer(id)}>
              {label(id)}
            </button>
          ))}
          <button
            title="Новый игрок"
            onClick={() => {
              const next = Math.max(0, ...players) + 1
              if (edit({ op: 'addPlayer' })) setPlayer(next)
            }}
          >
            +
          </button>
        </div>
        {player > 0 && (
          <div class="editor__chips">
            <button
              title="Где у игрока камера в начале игры: рамка на карте; тянуть за край — двигать, за угол — масштаб"
              onClick={() => {
                const { camera } = game.scene
                edit({ op: 'camera', player, camera: { ...camera.focus, zoom: camera.zoom } })
              }}
            >
              {playerCamera(sim, player) ? 'Камера игрока — сюда' : 'Задать камеру игрока'}
            </button>
            {playerCamera(sim, player) && (
              <>
                <button onClick={() => game.lookAt(playerCamera(sim, player)!.x, playerCamera(sim, player)!.y)}>К ней</button>
                <button onClick={() => edit({ op: 'camera', player })}>Убрать</button>
              </>
            )}
          </div>
        )}
        {player > 0 && (
          <label class="editor__field">
            Кредиты
            <NumberField min={0} step={100} value={creditsOf(sim, player)} set={(amount) => edit({ op: 'credits', player, amount })} />
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
            <Choice label="Биом" options={BIOMES} value={brush.biome} set={(biome) => setBrush({ ...brush, biome })} />
            <Choice label="Ярус" options={TIERS.map((tier) => [tier, tier === undefined ? 'как есть' : String(tier)])} value={brush.tier} set={(tier) => setBrush({ ...brush, tier })} />
            <Choice label="Кромка" options={CLIFFS} value={brush.cliff} set={(cliff) => setBrush({ ...brush, cliff })} />
            <Choice label="Барханы на песке" options={DUNES} value={brush.dunes} set={(dunes) => setBrush({ ...brush, dunes })} />
            <Choice label="Форма" options={SHAPES} value={brush.shape ?? 'square'} set={(shape) => setBrush({ ...brush, shape })} />
            <label class="editor__field">
              Кисть {size}×{size}
              <input type="range" min={1} max={15} step={2} value={size} onInput={(event) => setSize(Number(event.currentTarget.value))} />
            </label>
            <p class="editor__note">
              Гора встаёт одной вершиной в середине кисти, размером с кисть (не больше {Math.round(MAX_PEAK_RADIUS * 2)} тайлов). Горы рядом стыкуются грядой; гору, задетую другой землёй, кисть стирает целиком. Барханы
              ложатся только на песок.{remote ? ' Игроки увидят правку, когда она окажется у них на виду.' : ' Правка карты сразу видна всем игрокам.'}
            </p>
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
          <h3>{spots.length === 1 ? `${RESOURCE_NAMES[spots[0].kind]} · ${spots[0].x}, ${spots[0].y}` : `Месторождений: ${spots.length}`}</h3>
          <Choice
            label="Вид"
            options={DEPOSIT_TYPES.map((type) => [type, RESOURCE_NAMES[type]])}
            value={spots.every((spot) => spot.kind === spots[0].kind) ? spots[0].kind : undefined}
            set={(type) => edit({ op: 'setDeposit', spots: spotsOf(spots), kind: type! })}
          />
          <label class="editor__field">
            Осталось{spots.length > 1 && ' в каждом'}
            <NumberField min={0} step={100} value={reserveLeft(sim, spots[0].x, spots[0].y)} set={(left) => edit({ op: 'setDeposit', spots: spotsOf(spots), left })} />
          </label>
        </section>
      )}

      {tool === 'select' && selected.length > 0 && <Inspector sim={sim} entities={selected} edit={edit} label={label} ordering={ordering} order={setOrdering} />}
      {(selected.length > 0 || spots.length > 0) && tool === 'select' && (
        <button class="menu__danger" onClick={eraseSelection}>
          Снести выбранное
        </button>
      )}

      <footer class="editor__foot">
        <small class="editor__status">
          {tile && hover ? `${hover.x}, ${hover.y} · ${terrainName(tile.terrain)} · ${BIOMES.find(([biome]) => biome === tile.biome)?.[1] ?? ''}${tile.tier === undefined ? '' : ` · ярус ${tile.tier}`}${tile.cliff ? ' · обрыв' : ''}${tile.foot ? ' · подножие' : ''}` : ''}
          {status && <span> · {status}</span>}
        </small>
        <div class="editor__actions">{children}</div>
      </footer>
    </aside>
  )
}

/**
 * Числовое поле, значение которого меняется само (панель перерисовывается каждые PANEL_INTERVAL): пока в нём курсор,
 * оно показывает набранное, а не живое значение. Новое число уходит по Enter или когда поле теряет фокус.
 */
function NumberField({ value, set, min, max, step }: { value: number; set(value: number): void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const number = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(number)) set(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number)))
    setDraft(null)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onFocus={(event) => setDraft(event.currentTarget.value)}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft(null)
      }}
    />
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
function Inspector({ sim, entities, edit, label, ordering, order }: { sim: Sim; entities: Entity[]; edit(op: EditOp): boolean; label(id: number): string; ordering: boolean; order(on: boolean): void }) {
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
  // У одного выбранного — ползунок на каждую турель, у нескольких — общий на все.
  const turrets = entities.length === 1 ? turretFacings(sim, first) : []
  const turretAt = entities.map((entity) => turretFacings(sim, entity)[0]).find((angle) => angle !== undefined)
  const stance = world.get(first, Tactics)?.stance
  const tasks = entities.length === 1 ? tasksOf(sim, first) : []
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
            <button key={id} class={owner === id ? 'is-active' : ''} onClick={() => edit({ op: 'owner', entities, player: id })}>
              {label(id)}
            </button>
          ))}
        </div>
      </div>
      {health && (
        <label class="editor__field">
          Прочность {Math.round((health.value / health.max) * 100)}%
          <input type="range" min={1} max={100} value={Math.round((health.value / health.max) * 100)} onInput={(event) => edit({ op: 'health', entities, share: Number(event.currentTarget.value) / 100 })} />
        </label>
      )}
      {facing !== undefined && (
        <label class="editor__field">
          Корпус {Math.round(facing / DEGREE)}°
          <input type="range" min={-180} max={180} step={15} value={Math.round(facing / DEGREE)} onInput={(event) => edit({ op: 'facing', entities, angle: Number(event.currentTarget.value) * DEGREE })} />
        </label>
      )}
      {turrets.length > 0 &&
        turrets.map((angle, index) => (
          <label key={index} class="editor__field">
            {turrets.length > 1 ? `Турель ${index + 1}` : 'Турель'} {Math.round(angle / DEGREE)}°
            <input type="range" min={-180} max={180} step={15} value={Math.round(angle / DEGREE)} onInput={(event) => edit({ op: 'turret', entities, angle: Number(event.currentTarget.value) * DEGREE, index })} />
          </label>
        ))}
      {entities.length > 1 && turretAt !== undefined && (
        <label class="editor__field">
          Турели {Math.round(turretAt / DEGREE)}°
          <input type="range" min={-180} max={180} step={15} value={Math.round(turretAt / DEGREE)} onInput={(event) => edit({ op: 'turret', entities, angle: Number(event.currentTarget.value) * DEGREE })} />
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
                  onClick={() => {
                    for (const entity of entities) edit({ op: 'order', player: world.get(entity, Owner)?.player ?? 0, command: { type: 'stance', units: [entity], stance: slot.stance } })
                  }}
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
            <button onClick={() => edit({ op: 'clearTasks', entities })}>Снять задания</button>
          </div>
        </div>
      )}
      {inventory && entities.length === 1 && (
        <div class="editor__stock">
          <span>Склад · объём {inventory.capacity}</span>
          {GOODS.map((good: Good) => (
            <label key={good} class="editor__field">
              {goodName(good)}
              <NumberField
                min={0}
                value={inventory.items[good] ?? 0}
                set={(amount) => edit({ op: 'stock', entity: first, good, amount })}
              />
            </label>
          ))}
        </div>
      )}
    </section>
  )
}
