import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import type { MapSettings } from '../map/settings'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer } from '../render/renderer'
import type { Session } from '../net/connect'
import { Position, Unit, createSim, isOwn, driveBattle, randomArmy, spawnBattle, spawnSandbox, spawnStartingUnits, type BuildingType, type Command, type SimOptions } from '../sim'
import { createLightingPass } from '../weather/lightingPass'
import { createPrecipitationPass } from '../weather/precipitationPass'
import { createBoundsPass } from './boundsPass'
import { createBuildingsPass } from './buildings/buildingsPass'
import { createCombatPasses } from './combatPass'
import { Camera } from './camera'
import { createControls } from './controls'
import { createCursorPass } from './cursorPass'
import { createDepositsPass } from './depositsPass'
import { startFrames } from './frames'
import { readHud, type HudState } from './hud'
import type { Scene } from './scene'
import { createPowerPass } from './powerPass'
import { createSelectionPass } from './selectionPass'
import { loadCamera, loadSave, storeCamera, storeSave } from './storage'
import { createUnitsPasses } from './units/unitsPass'

/** Как часто игра сохраняется в браузер, в секундах. */
const SAVE_INTERVAL = 10

export interface Game {
  readonly scene: Scene
  /** Применяет настройки панели. Смена параметров генератора или мира начинает мир заново. */
  setSettings(settings: MapSettings): void
  /** Начинает мир заново с теми же настройками. */
  restart(): void
  /** Состояние интерфейса игрока на этот момент. */
  hud(): HudState
  /** Посылает симуляции команду от имени игрока. */
  send(command: Command): void
  /** Начинает выбор места под здание; null — отменяет его. */
  place(building: BuildingType | null): void
  /** Останавливает игру и освобождает ресурсы. */
  destroy(): void
}

const simOptions = (settings: MapSettings): SimOptions => ({ generator: settings.generator, size: settings.world.size, rules: settings.rules })

/** В одиночной игре игрок один. */
const PLAYER = 1

/** Как часто юнитам показательного боя раздаются цели и сколько после его конца ждать нового, в секундах. */
const BATTLE_ORDERS = 0.5
const BATTLE_PAUSE = 3

/**
 * Во что играют: обычная игра; показательный бой — две случайные армии сходятся снова и снова, каждый раз в новом
 * составе; тестовая карта — готовая база, чтобы сразу посмотреть, как всё работает. Бой и тестовая карта
 * сохранение игрока не читают и не пишут.
 */
export type GameMode = 'play' | 'battle' | 'sandbox'

/**
 * Новая симуляция: стартовый набор игрока у начала мира, в показательном бою — две случайные армии
 * по настройкам боя, на тестовой карте — готовая база.
 */
function createNewSim(settings: MapSettings, mode: GameMode = 'play') {
  const sim = createSim(simOptions(settings))
  // Если месторождения рядом не нашлось, тестовая карта начинается как обычная игра.
  if (mode === 'sandbox' && spawnSandbox(sim, PLAYER)) return sim
  if (mode === 'battle') {
    const { budget, gap, mirror, ...weights } = settings.battle
    const own = randomArmy(budget, weights)
    spawnBattle(sim, PLAYER, 0, 0, own, mirror ? own : randomArmy(budget, weights), gap)
  } else {
    spawnStartingUnits(sim, PLAYER, 0, 0)
  }
  return sim
}

/**
 * Собирает игру на холсте: симуляцию, отрисовку, управление — и запускает кадры.
 * Если запустить не удалось (нет WebGL 2, не собрался шейдер), бросает ошибку.
 * onError получает ошибки, случившиеся уже во время игры; игра после них остановлена.
 * С session игра идёт на сервере: мир приходит оттуда, а местное сохранение и новый старт отключены.
 * mode — во что играют, см. GameMode.
 */
export function createGame(
  canvas: HTMLCanvasElement,
  settings: MapSettings,
  onError: (error: unknown) => void,
  session?: Session,
  mode: GameMode = 'play',
): Game {
  const camera = new Camera()
  const save = session || mode !== 'play' ? null : loadSave(simOptions(settings))
  // Камера возвращается туда, где была, только вместе с миром: в новом мире старое место ничего не значит.
  const view = save ? loadCamera() : null
  if (view) {
    camera.x = view.x
    camera.y = view.y
    camera.zoomTo(view.zoom)
  }
  const scene: Scene = {
    // Правила берутся из настроек, а не из сохранения: их меняют на ходу.
    sim: session ? session.sim : save ? createSim({ ...save, rules: settings.rules }) : createNewSim(settings, mode),
    player: session ? session.player : PLAYER,
    camera,
    settings,
    selection: new Set(),
    selectionBox: null,
    placing: null,
    grid: false,
  }

  // Всё, что живёт на видеокарте, создаётся здесь: после потери контекста рендер вызовет это заново.
  let landWindow: LandWindow
  const renderer = createRenderer(
    canvas,
    (gl) => {
      landWindow = createLandWindow(gl)
      const units = createUnitsPasses(gl, scene)
      const buildings = createBuildingsPass(gl, scene)
      const combat = createCombatPasses(gl, scene)
      // Порядок проходов — порядок отрисовки, снизу вверх.
      return [
        createTerrainPass(gl, scene, landWindow),
        createDepositsPass(gl, scene),
        createBoundsPass(gl, scene),
        units.ground,
        buildings,
        // Пыль от винтов — на земле и на крышах, под летающими.
        combat.dust,
        // Летающие — над зданиями.
        units.air,
        createPrecipitationPass(gl, scene, landWindow),
        combat.lights,
        createLightingPass(gl, scene, [units.ground, buildings]),
        createPowerPass(gl, scene),
        combat.effects,
        createSelectionPass(gl, scene),
        createCursorPass(gl, scene),
      ]
    },
    onError,
  )
  const controls = createControls(canvas, scene)

  const saveNow = () => {
    if (session || mode !== 'play') return
    storeSave(scene.sim.save())
    storeCamera(camera)
  }
  let sinceSave = 0
  // На сервере игрок появляется не в начале мира, а база тестовой карты — у ближайшего месторождения:
  // камера встаёт на его юнит, как только мир готов.
  let centered = !session && mode !== 'sandbox'

  const restart = () => {
    // Мир сервера один на всех: начать его заново клиент не может.
    if (session) return
    scene.sim.destroy()
    scene.selection.clear()
    scene.placing = null
    scene.sim = createNewSim(scene.settings, mode)
    // Новый мир — камера снова у стартового набора.
    camera.x = camera.y = 0
    centered = mode !== 'sandbox'
    saveNow()
  }

  let sinceOrders = 0
  let battleOver = 0

  const stop = startFrames((seconds) => {
    if (mode === 'battle') {
      sinceOrders += seconds
      if (battleOver) {
        battleOver += seconds
        if (battleOver > BATTLE_PAUSE) {
          battleOver = 0
          restart()
        }
      } else if (sinceOrders >= BATTLE_ORDERS) {
        sinceOrders = 0
        if (!driveBattle(scene.sim, PLAYER)) battleOver = seconds
      }
    }
    const { sim } = scene
    sim.advance(seconds)
    controls.update(seconds)
    if (!centered) {
      for (const [entity, position] of sim.world.query(Position, Unit)) {
        if (!isOwn(sim, scene.player, entity)) continue
        camera.x = position.x
        camera.y = position.y
        centered = true
        break
      }
    }

    const { width, height } = renderer.resize()
    camera.width = width
    camera.height = height
    camera.minZoom = minZoom(width, height)
    if (camera.zoom < camera.minZoom) camera.zoomTo(camera.minZoom)
    // Центр экрана не уходит за границы карты.
    camera.x = Math.min(sim.bounds.right, Math.max(sim.bounds.left, camera.x))
    camera.y = Math.min(sim.bounds.bottom, Math.max(sim.bounds.top, camera.y))

    sinceSave += seconds
    if (sinceSave >= SAVE_INTERVAL) {
      sinceSave = 0
      saveNow()
    }

    // Пока контекст потерян, рисовать некуда; игра при этом продолжает идти.
    if (renderer.lost) return
    landWindow.update(sim.land, camera, width, height)
    const { time } = sim
    renderer.draw(camera, time.elapsed + time.alpha * time.step, seconds)
  }, onError)

  // Последний шанс сохраниться: вкладку закрывают или уводят в фон.
  window.addEventListener('pagehide', saveNow)

  return {
    scene,
    setSettings(next) {
      const changed = next.generator !== scene.settings.generator || next.world !== scene.settings.world
      scene.settings = next
      // Правила сервера задаёт сервер.
      if (!session) Object.assign(scene.sim.rules, next.rules)
      if (changed) restart()
    },
    restart,
    hud: () => readHud(scene),
    send: (command) => scene.sim.send(scene.player, command),
    place(building) {
      scene.placing = building
    },
    destroy() {
      stop()
      window.removeEventListener('pagehide', saveNow)
      saveNow()
      controls.destroy()
      scene.sim.destroy()
      renderer.destroy()
      landWindow.destroy()
    },
  }
}
