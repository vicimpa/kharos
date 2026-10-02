import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import type { MapSettings } from '../map/settings'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer } from '../render/renderer'
import { createSim, placeDemoBuildings, type SimOptions } from '../sim'
import { createLightingPass } from '../weather/lightingPass'
import { createPrecipitationPass } from '../weather/precipitationPass'
import { createBoundsPass } from './boundsPass'
import { createBuildingsPass } from './buildings/buildingsPass'
import { Camera } from './camera'
import { createControls } from './controls'
import { createCursorPass } from './cursorPass'
import { startFrames } from './frames'
import type { Scene } from './scene'
import { loadSave, storeSave } from './storage'

/** Как часто игра сохраняется в браузер, в секундах. */
const SAVE_INTERVAL = 10

export interface Game {
  readonly scene: Scene
  /** Применяет настройки панели. Смена параметров генератора или мира начинает мир заново. */
  setSettings(settings: MapSettings): void
  /** Начинает мир заново с теми же настройками. */
  restart(): void
  /** Останавливает игру и освобождает ресурсы. */
  destroy(): void
}

const simOptions = (settings: MapSettings): SimOptions => ({ generator: settings.generator, size: settings.world.size })

/** Новая симуляция с пробными зданиями: пока игрока нет, смотреть больше не на что. */
function createDemoSim(settings: MapSettings) {
  const sim = createSim(simOptions(settings))
  placeDemoBuildings(sim, 0, 0)
  return sim
}

/**
 * Собирает игру на холсте: симуляцию, отрисовку, управление — и запускает кадры.
 * Если запустить не удалось (нет WebGL 2, не собрался шейдер), бросает ошибку.
 * onError получает ошибки, случившиеся уже во время игры; игра после них остановлена.
 */
export function createGame(canvas: HTMLCanvasElement, settings: MapSettings, onError: (error: unknown) => void): Game {
  const camera = new Camera()
  const save = loadSave(simOptions(settings))
  const scene: Scene = {
    sim: save ? createSim(save) : createDemoSim(settings),
    camera,
    settings,
    grid: false,
  }

  // Всё, что живёт на видеокарте, создаётся здесь: после потери контекста рендер вызовет это заново.
  let landWindow: LandWindow
  const renderer = createRenderer(
    canvas,
    (gl) => {
      landWindow = createLandWindow(gl)
      // Порядок проходов — порядок отрисовки, снизу вверх.
      return [
        createTerrainPass(gl, scene, landWindow),
        createBoundsPass(gl, scene),
        createBuildingsPass(gl, scene),
        createPrecipitationPass(gl, scene, landWindow),
        createLightingPass(gl, scene),
        createCursorPass(gl, scene),
      ]
    },
    onError,
  )
  const controls = createControls(canvas, scene)

  const saveNow = () => storeSave(scene.sim.save())
  let sinceSave = 0

  const restart = () => {
    scene.sim.destroy()
    scene.sim = createDemoSim(scene.settings)
    saveNow()
  }

  const stop = startFrames((seconds) => {
    const { sim } = scene
    sim.advance(seconds)
    controls.update(seconds)

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
      if (changed) restart()
    },
    restart,
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
