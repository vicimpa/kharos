import type { ViewBox } from '../net/protocol'
import type { EditOp } from '../sim/editOps'
import { createAudio } from '../audio/audio'
import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import type { MapSettings } from '../map/settings'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer, type Pass } from '../render/renderer'
import type { Session } from '../net/connect'
import { Building, Player, Position, Unit, isOwn, weatherAt, type BuildingType, type Command, type Sim, type SimOptions, type UnitType } from '../sim'
import { createLightingPass } from '../weather/lightingPass'
import { createPrecipitationPass } from '../weather/precipitationPass'
import { createBoundsPass } from './boundsPass'
import { createBuildingsPass } from './buildings/buildingsPass'
import { createCombatPasses } from './combatPass'
import { Camera } from './camera'
import { CameraMotion } from './cameraMotion'
import { createControls } from './controls'
import { createCursorPass } from './cursorPass'
import { createDecalsPass } from './decalsPass'
import { createFogPass } from './fogPass'
import { createAlerts } from './alerts'
import { createMachines } from './machines'
import { createInterfaceSounds } from './interfaceSounds'
import { createShake } from './shake'
import { createSoundscape } from './soundscape'
import { createDepositsPass } from './depositsPass'
import { createPavingPass } from './pavingPass'
import { createDropsPass } from './dropsPass'
import { createFlowPass } from './flowPass'
import { startFrames } from './frames'
import { readHud, type HudState } from './hud'
import { createMinimap, type Minimap } from './minimap'
import type { PaveTool, Scene } from './scene'
import { createPowerPass } from './powerPass'
import { createSelectionPass } from './selectionPass'
import { loadCamera, storeCamera } from './storage'
import { createUnitsPasses } from './units/unitsPass'

/** Как часто вкладка запоминает место камеры, в секундах. */
const CAMERA_INTERVAL = 10
/** Витрина: масштаб в пикселях на тайл, как быстро камера догоняет действие и как медленно кружит вокруг него. */
const SHOWCASE_ZOOM = 28
const SHOWCASE_FOLLOW = 0.4
const SHOWCASE_ORBIT = 0.05
const SHOWCASE_RADIUS = 6
/** С какой ширины экрана меню стоит слева от действия и сколько пикселей оно занимает. */
const SHOWCASE_WIDE = 760
const SHOWCASE_MENU = 400

/**
 * Как играть на холсте. slot — локальная игра из этого слота сохранений: камера встаёт туда, где была, и место
 * запоминается в нём же. showcase — витрина для фона меню: ни управления, ни звука, ни тумана, а камера сама
 * следит за происходящим.
 */
/**
 * Что игра показывает: обычно копию мира хоста (Session), а витрина меню — симуляцию, которую считает сама
 * вкладка; у неё нет поколений мира — она не начинается заново из-под игры.
 */
/** Как часто, в секундах, вкладка может сообщить хосту, где её камера: редактор показывает камеры игроков. */
const VIEW_GAP = 0.5

export type GameSession = Omit<Session, 'sim'> & { sim: Sim & { readonly generation?: number; readonly kept?: boolean; respawn?(): void; say?(text: string): void; edit?(edit: EditOp): void; view?(box: ViewBox): void } }

export interface GameOptions {
  slot?: string
  showcase?: boolean
  /** Редактор сохранений: мир стоит, и уведомлений о врагах и атаках нет — в нём враги ставятся руками. */
  editor?: boolean
}

export interface Game {
  readonly scene: Scene
  /** Применяет настройки панели. Смена параметров генератора или мира начинает мир заново. */
  /** Начинает мир заново с теми же настройками. */
  restart(): void
  /** Состояние интерфейса игрока на этот момент. */
  hud(): HudState
  /** Посылает симуляции команду от имени игрока. */
  send(command: Command): void
  /** Начинает выбор места под здание; null — отменяет его. */
  place(building: BuildingType | null): void
  /** Начинает укладку или снятие покрытия; null — отменяет. */
  pave(tool: PaveTool | null): void
  /** Начинает набор маршрута выбранным грузовикам щелчками по зданиям; false — отменяет. */
  route(start: boolean): void
  /** Начинает выбор зданий, которые будут обслуживать выбранные грузовики; false — отменяет. */
  serve(start: boolean): void
  /** Проигравший начинает заново: на сервере — новый стартовый набор в новом месте, в локальной игре — новый мир. */
  respawn(): void
  /** Написать в чат сетевой игры. */
  say(text: string): void
  /** Правка редактора живого мира: уходит хосту, см. /editor. */
  edit(edit: EditOp): void
  /** Начинает выбор точки патруля выбранным бойцам; false — отменяет. */
  patrol(start: boolean): void
  /** Мини-карта нижней панели. */
  readonly minimap: Minimap
  /** Ставит центр экрана в точку карты, в тайлах. */
  lookAt(x: number, y: number): void
  /** Камера летит к точке карты, в тайлах. */
  flyTo(x: number, y: number): void
  /** Оставляет в выделении только юнитов вида type; remove — убирает их. */
  narrow(type: UnitType, remove: boolean): void
  /** Наводит камеру на выделенное. */
  lookAtSelection(): void
  /** Посылает выделенных юнитов в точку карты, в тайлах. */
  moveSelected(x: number, y: number): void
  /** Выключен ли звук; выбор хранится в браузере. */
  muted: boolean
  /** Поверх игры открыто меню: управление выключено, звук тише. Сама игра идёт дальше. */
  paused: boolean
  /** Зовётся, когда Escape нечего отменять: интерфейс открывает меню игры. */
  set onMenu(value: () => void)
  /** Перечитывает настройки звука: их поменяли в меню. */
  refreshSound(): void
  /** Останавливает игру и освобождает ресурсы. */
  destroy(): void
}

export const simOptions = (settings: MapSettings): SimOptions => ({ generator: settings.generator, size: settings.world.size, rules: settings.rules })

/**
 * Собирает игру на холсте: отрисовку и управление поверх копии мира из session — и запускает кадры.
 * Сам мир считает хост: воркер локальной игры или сервер. Если запустить не удалось (нет WebGL 2, не собрался
 * шейдер), бросает ошибку. onError получает ошибки, случившиеся уже во время игры; игра после них остановлена.
 */
export function createGame(
  canvas: HTMLCanvasElement,
  settings: MapSettings,
  onError: (error: unknown) => void,
  session: GameSession,
  { slot, showcase = false, editor = false }: GameOptions = {},
): Game {
  const camera = new Camera()
  // Камера возвращается туда, где была, только вместе с миром: в новом мире слота места ещё нет.
  const view = slot ? loadCamera(slot) : null
  if (view) {
    camera.x = view.x
    camera.y = view.y
    camera.zoomTo(view.zoom)
  }
  const scene: Scene = {
    sim: session.sim,
    player: session.player,
    camera,
    settings,
    selection: new Set(),
    selectionBox: null,
    placing: null,
    paving: null,
    paveFrom: null,
    routing: null,
    serving: null,
    patrolling: false,
    grid: false,
    weather: weatherAt(session.sim.options, session.sim.time.elapsed),
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
      // Порядок проходов — порядок отрисовки, снизу вверх. Витрине не нужны туман, зоны, выделение и курсор.
      const play = (pass: Pass) => (showcase ? [] : [pass])
      return [
        createTerrainPass(gl, scene, landWindow),
        createDepositsPass(gl, scene),
        createPavingPass(gl, scene),
        createDropsPass(gl, scene),
        // Следы, гарь и остовы — на земле, под юнитами.
        createDecalsPass(gl, scene),
        units.ground,
        buildings,
        // Поток по трубам — поверх труб, под турелями и летающими.
        createFlowPass(gl, scene),
        units.emplacements,
        // Пыль от винтов — на земле и на крышах, под летающими.
        combat.dust,
        // Летающие — над зданиями.
        units.air,
        createPrecipitationPass(gl, scene, landWindow),
        combat.lights,
        createLightingPass(gl, scene, [units.ground, buildings, units.emplacements]),
        // Туман — над миром и его светом, под зонами, выделением и курсором.
        ...play(createFogPass(gl, scene)),
        // Буря за краем мира — над туманом: границу видно и там, где ещё не бывали.
        createBoundsPass(gl, scene),
        ...play(createPowerPass(gl, scene)),
        combat.effects,
        ...play(createSelectionPass(gl, scene)),
        ...play(createCursorPass(gl, scene)),
      ]
    },
    onError,
  )
  /**
   * Какие края холста закрыты интерфейсом: верхняя полоса и нижняя панель лежат поверх него. Меряется каждый кадр —
   * панели могут меняться, — по классам интерфейса.
   */
  const measureInset = () => {
    const frame = canvas.getBoundingClientRect()
    const top = document.querySelector('.hud--top')?.getBoundingClientRect()
    const bottom = document.querySelector('.hud.bar')?.getBoundingClientRect()
    camera.inset.top = top ? Math.max(0, Math.min(frame.height, top.bottom - frame.top)) : 0
    camera.inset.bottom = bottom ? Math.max(0, Math.min(frame.height, frame.bottom - bottom.top)) : 0
    // Боковая панель редактора — справа.
    const side = document.querySelector('.editor__panel')?.getBoundingClientRect()
    if (side) camera.inset.right = Math.max(0, Math.min(frame.width, frame.right - side.left))
  }
  const motion = new CameraMotion(camera)
  motion.simple = editor
  const controls = showcase ? null : createControls(canvas, scene, motion)
  // В редакторе мир стоит, и гул машин и зданий ни к чему: звука нет вовсе.
  const audio = showcase || editor ? null : createAudio()
  const shake = createShake()
  const soundscape = audio && createSoundscape(scene, audio, shake)
  if (!showcase && !editor) scene.alerts = createAlerts(scene, audio)
  const interfaceSounds = audio ? createInterfaceSounds(session.sim, audio) : null
  const machines = audio && createMachines(scene, audio)

  const saveCamera = () => slot && storeCamera(slot, camera)
  let sinceSave = 0
  // Игрок на сервере появляется не в начале мира, а база тестовой карты — у ближайшего месторождения:
  // камера встаёт на его юнит, как только мир готов. Так же — когда хост начал мир заново.
  let centered = view !== null
  let generation = session.sim.generation

  /**
   * Камера витрины: плавно идёт к середине всех юнитов и зданий, медленно кружа вокруг неё, — так в кадре бой или
   * работающая база, даже когда всё стоит.
   */
  let orbit = Math.random() * Math.PI * 2
  const direct = (seconds: number) => {
    let x = 0
    let y = 0
    let count = 0
    // Здания — тоже действие: у стройки и обороны оно вокруг них.
    for (const component of [Unit, Building]) {
      for (const [, position] of scene.sim.world.query(Position, component)) {
        x += position.x
        y += position.y
        count++
      }
    }
    if (!count) return
    // Слева на широком экране — меню: действие держится правее него.
    camera.inset.left = camera.width >= SHOWCASE_WIDE ? Math.min(camera.width * 0.4, SHOWCASE_MENU) : 0
    orbit += seconds * SHOWCASE_ORBIT * Math.PI * 2
    const target = { x: x / count + Math.cos(orbit) * SHOWCASE_RADIUS, y: y / count + Math.sin(orbit) * SHOWCASE_RADIUS }
    const focus = camera.focus
    // Первый кадр — сразу на месте, дальше — вдогонку.
    const follow = centered ? 1 - Math.exp(-seconds * SHOWCASE_FOLLOW) : 1
    centered = true
    camera.centerOn(focus.x + (target.x - focus.x) * follow, focus.y + (target.y - focus.y) * follow)
    camera.zoomTo(SHOWCASE_ZOOM)
  }

  // Мир один на все вкладки, и начинает его заново хост; на сервере — не может никто.
  const restart = () => session.local?.restart(simOptions(scene.settings), scene.settings.battle)

  /** Какую видимую часть хост знает: камера шлётся, когда сдвинулась хотя бы на тайл, не чаще раза в VIEW_GAP с. */
  let viewSent = ''
  let sinceView = 0
  const stop = startFrames((seconds) => {
    const { sim } = scene
    sim.advance(seconds)
    sinceView += seconds
    if (session.sim.view && sinceView >= VIEW_GAP) {
      sinceView = 0
      const { from, to } = scene.camera.visible
      const box = { left: Math.round(from.x), top: Math.round(from.y), right: Math.round(to.x), bottom: Math.round(to.y) }
      const key = JSON.stringify(box)
      if (key !== viewSent) {
        viewSent = key
        session.sim.view(box)
      }
    }
    if (session.sim.generation !== generation) {
      generation = session.sim.generation
      scene.selection.clear()
      scene.placing = null
      scene.paving = null
      scene.paveFrom = null
      scene.routing = null
      scene.serving = null
      scene.patrolling = false
      // Тот же мир заново — вход в редактор и выход из него: камера остаётся, где была.
      centered = !!session.sim.kept
    }
    controls?.update(seconds)
    if (showcase) direct(seconds)
    else if (!centered) {
      // Камера, которую игроку задали в редакторе, главнее места его юнитов.
      for (const [, data] of sim.world.query(Player)) {
        if (data.id !== scene.player || data.camera.length !== 3) continue
        motion.jump(data.camera[0], data.camera[1])
        camera.zoomTo(data.camera[2])
        centered = true
      }
      if (!centered) for (const [entity, position] of sim.world.query(Position, Unit)) {
        if (!isOwn(sim, scene.player, entity)) continue
        motion.jump(position.x, position.y)
        centered = true
        break
      }
    }

    const { width, height } = renderer.resize()
    camera.width = width
    camera.height = height
    measureInset()
    camera.minZoom = minZoom(width, height)
    if (camera.zoom < camera.minZoom) camera.zoomTo(camera.minZoom)
    // Середина видимой части не уходит за границы карты: край карты можно подвести к краю панели, но не под неё.
    const focus = camera.focus
    camera.centerOn(
      Math.min(sim.bounds.right, Math.max(sim.bounds.left, focus.x)),
      Math.min(sim.bounds.bottom, Math.max(sim.bounds.top, focus.y)),
    )
    motion.measure(seconds)

    soundscape?.update(seconds, motion.speed)
    scene.alerts?.update(seconds)
    machines?.update(seconds)
    interfaceSounds?.update(seconds, scene.selection)
    shake.update(seconds)

    sinceSave += seconds
    if (sinceSave >= CAMERA_INTERVAL) {
      sinceSave = 0
      saveCamera()
    }

    // Пока контекст потерян, рисовать некуда; игра при этом продолжает идти.
    if (renderer.lost) return
    // Тряска уводит только картинку, вместе с землёй: управление и сохранение видят камеру на месте.
    const { x: shakeX, y: shakeY } = shake.offset(camera.zoom)
    camera.x += shakeX
    camera.y += shakeY
    landWindow.update(sim.land, camera, width, height)
    const { time } = sim
    scene.weather = weatherAt(sim.options, time.elapsed + time.alpha * time.step)
    renderer.draw(camera, time.elapsed + time.alpha * time.step, seconds)
    camera.x -= shakeX
    camera.y -= shakeY
  }, onError)

  // Последний шанс сохраниться: вкладку закрывают или уводят в фон.
  window.addEventListener('pagehide', saveCamera)

  return {
    scene,
    restart,
    hud: () => readHud(scene),
    send: (command) => scene.sim.send(scene.player, command),
    place(building) {
      scene.placing = building
      if (building) scene.paving = null
    },
    say(text) {
      session.sim.say?.(text)
    },
    edit(edit) {
      session.sim.edit?.(edit)
    },
    respawn() {
      if (session.local) restart()
      else session.sim.respawn?.()
    },
    patrol(start) {
      scene.patrolling = start
      if (start) scene.placing = scene.paving = scene.routing = scene.serving = null
    },
    route(start) {
      scene.routing = start ? [] : null
      if (start) scene.placing = scene.paving = scene.serving = null
    },
    serve(start) {
      scene.serving = start ? [] : null
      if (start) scene.placing = scene.paving = scene.routing = null
    },
    pave(tool) {
      scene.paving = tool
      scene.paveFrom = null
      if (tool) scene.placing = null
    },
    minimap: createMinimap(scene),
    lookAt: (x, y) => motion.jump(x, y),
    flyTo: (x, y) => motion.flyTo(x, y),
    lookAtSelection: () => controls?.lookAtSelection(),
    narrow: (type, remove) => controls?.narrow(type, remove),
    moveSelected(x, y) {
      const units = [...scene.selection].filter((entity) => scene.sim.world.has(entity, Unit))
      if (units.length) scene.sim.send(scene.player, { type: 'move', units, x: Math.floor(x), y: Math.floor(y) })
    },
    get muted() {
      return audio?.muted ?? true
    },
    set muted(value) {
      if (audio) audio.muted = value
    },
    set onMenu(value: () => void) {
      if (controls) controls.onMenu = value
    },
    get paused() {
      return controls?.paused ?? false
    },
    set paused(value) {
      if (controls) controls.paused = value
      if (audio) audio.dimmed = value
    },
    refreshSound: () => audio?.refresh(),
    destroy() {
      stop()
      window.removeEventListener('pagehide', saveCamera)
      saveCamera()
      controls?.destroy()
      interfaceSounds?.destroy()
      audio?.destroy()
      scene.sim.destroy()
      renderer.destroy()
      landWindow.destroy()
    },
  }
}
