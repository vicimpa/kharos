import { createAudio } from '../audio/audio'
import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import type { MapSettings } from '../map/settings'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer } from '../render/renderer'
import type { Session } from '../net/connect'
import { Position, Unit, isOwn, type BuildingType, type Command, type SimOptions, type UnitType } from '../sim'
import { createLightingPass } from '../weather/lightingPass'
import { createPrecipitationPass } from '../weather/precipitationPass'
import { createBoundsPass } from './boundsPass'
import { createBuildingsPass } from './buildings/buildingsPass'
import { createCombatPasses } from './combatPass'
import { Camera } from './camera'
import { createControls } from './controls'
import { createCursorPass } from './cursorPass'
import { createDecalsPass } from './decalsPass'
import { createShake } from './shake'
import { createSoundscape } from './soundscape'
import { createDepositsPass } from './depositsPass'
import { startFrames } from './frames'
import { readHud, type HudState } from './hud'
import { createMinimap, type Minimap } from './minimap'
import type { Scene, Spawn } from './scene'
import { createPowerPass } from './powerPass'
import { createSelectionPass } from './selectionPass'
import { loadCamera, storeCamera } from './storage'
import { createUnitsPasses } from './units/unitsPass'

/** Как часто вкладка запоминает место камеры, в секундах. */
const CAMERA_INTERVAL = 10

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
  /** Выбирает, что ставит отладочный спавн; null — выключает его. */
  spawn(spawn: Spawn | null): void
  /** Мини-карта нижней панели. */
  readonly minimap: Minimap
  /** Ставит центр экрана в точку карты, в тайлах. */
  lookAt(x: number, y: number): void
  /** Оставляет в выделении только юнитов вида type; remove — убирает их. */
  narrow(type: UnitType, remove: boolean): void
  /** Наводит камеру на выделенное. */
  lookAtSelection(): void
  /** Посылает выделенных юнитов в точку карты, в тайлах. */
  moveSelected(x: number, y: number): void
  /** Выключен ли звук; выбор хранится в браузере. */
  muted: boolean
  /** Останавливает игру и освобождает ресурсы. */
  destroy(): void
}

export const simOptions = (settings: MapSettings): SimOptions => ({ generator: settings.generator, size: settings.world.size, rules: settings.rules })

/**
 * Собирает игру на холсте: отрисовку и управление поверх копии мира из session — и запускает кадры.
 * Сам мир считает хост: воркер локальной игры или сервер. Если запустить не удалось (нет WebGL 2, не собрался
 * шейдер), бросает ошибку. onError получает ошибки, случившиеся уже во время игры; игра после них остановлена.
 * resumed — локальная игра продолжает сохранение: тогда камера встаёт туда, где была.
 */
export function createGame(canvas: HTMLCanvasElement, settings: MapSettings, onError: (error: unknown) => void, session: Session, resumed = false): Game {
  const camera = new Camera()
  // Камера возвращается туда, где была, только вместе с миром: в новом мире старое место ничего не значит.
  const view = resumed ? loadCamera() : null
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
    spawning: null,
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
        // Следы, гарь и остовы — на земле, под юнитами.
        createDecalsPass(gl, scene),
        createBoundsPass(gl, scene),
        units.ground,
        buildings,
        units.emplacements,
        // Пыль от винтов — на земле и на крышах, под летающими.
        combat.dust,
        // Летающие — над зданиями.
        units.air,
        createPrecipitationPass(gl, scene, landWindow),
        combat.lights,
        createLightingPass(gl, scene, [units.ground, buildings, units.emplacements]),
        createPowerPass(gl, scene),
        combat.effects,
        createSelectionPass(gl, scene),
        createCursorPass(gl, scene),
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
  }
  const controls = createControls(canvas, scene)
  const audio = createAudio()
  const shake = createShake()
  const soundscape = createSoundscape(scene, audio, shake)

  const saveCamera = () => storeCamera(camera)
  let sinceSave = 0
  // Игрок на сервере появляется не в начале мира, а база тестовой карты — у ближайшего месторождения:
  // камера встаёт на его юнит, как только мир готов. Так же — когда хост начал мир заново.
  let centered = view !== null
  let generation = session.sim.generation

  // Мир один на все вкладки, и начинает его заново хост; на сервере — не может никто.
  const restart = () => session.local?.restart(simOptions(scene.settings), scene.settings.battle)

  const stop = startFrames((seconds) => {
    const { sim } = scene
    sim.advance(seconds)
    if (session.sim.generation !== generation) {
      generation = session.sim.generation
      scene.selection.clear()
      scene.placing = null
      scene.spawning = null
      centered = false
    }
    controls.update(seconds)
    if (!centered) {
      for (const [entity, position] of sim.world.query(Position, Unit)) {
        if (!isOwn(sim, scene.player, entity)) continue
        camera.centerOn(position.x, position.y)
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

    soundscape.update(seconds)
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
    renderer.draw(camera, time.elapsed + time.alpha * time.step, seconds)
    camera.x -= shakeX
    camera.y -= shakeY
  }, onError)

  // Последний шанс сохраниться: вкладку закрывают или уводят в фон.
  window.addEventListener('pagehide', saveCamera)

  return {
    scene,
    setSettings(next) {
      const changed = next.generator !== scene.settings.generator || next.world !== scene.settings.world
      scene.settings = next
      // Правила сервера задаёт сервер.
      session.local?.rules(next.rules)
      if (changed) restart()
    },
    restart,
    hud: () => readHud(scene),
    send: (command) => scene.sim.send(scene.player, command),
    place(building) {
      scene.placing = building
    },
    spawn(spawn) {
      scene.spawning = spawn
      if (spawn) scene.placing = null
    },
    minimap: createMinimap(scene),
    lookAt: (x, y) => camera.centerOn(x, y),
    lookAtSelection: () => controls.lookAtSelection(),
    narrow: (type, remove) => controls.narrow(type, remove),
    moveSelected(x, y) {
      const units = [...scene.selection].filter((entity) => scene.sim.world.has(entity, Unit))
      if (units.length) scene.sim.send(scene.player, { type: 'move', units, x: Math.floor(x), y: Math.floor(y) })
    },
    get muted() {
      return audio.muted
    },
    set muted(value) {
      audio.muted = value
    },
    destroy() {
      stop()
      window.removeEventListener('pagehide', saveCamera)
      saveCamera()
      controls.destroy()
      audio.destroy()
      scene.sim.destroy()
      renderer.destroy()
      landWindow.destroy()
    },
  }
}
