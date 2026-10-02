import { Loop, World, type System } from '../ecs'
import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import type { MapSettings } from '../map/settings'
import { createLand } from '../map/terrain'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer } from '../render/renderer'
import { createLightingPass } from '../weather/lightingPass'
import { createPrecipitationPass } from '../weather/precipitationPass'
import { createOccupancy, placeDemoBuildings } from './buildings/buildings'
import { createBuildingsPass } from './buildings/buildingsPass'
import { Camera } from './camera'
import { createControls } from './controls'
import { createCursorPass } from './cursorPass'
import type { Scene } from './scene'

export interface Game {
  readonly scene: Scene
  /** Применяет настройки панели. Смена параметров генератора пересоздаёт местность и здания. */
  setSettings(settings: MapSettings): void
  /** Останавливает игру и освобождает ресурсы. */
  destroy(): void
}

/**
 * Собирает игру на холсте: мир, отрисовку, управление — и запускает игровой цикл.
 * Если запустить не удалось (нет WebGL 2, не собрался шейдер), бросает ошибку.
 * onError получает ошибки, случившиеся уже во время игры; игра после них остановлена.
 */
export function createGame(canvas: HTMLCanvasElement, settings: MapSettings, onError: (error: unknown) => void): Game {
  const world = new World()
  const camera = new Camera()
  const scene: Scene = {
    world,
    land: createLand(settings.generator),
    camera,
    settings,
    occupancy: createOccupancy(world),
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
        createBuildingsPass(gl, scene),
        createPrecipitationPass(gl, scene, landWindow),
        createLightingPass(gl, scene),
        createCursorPass(gl, scene),
      ]
    },
    onError,
  )
  const controls = createControls(canvas, scene)

  /** Система кадра: подгоняет камеру под экран и рисует сцену. */
  const draw: System = (_, time) => {
    const { width, height } = renderer.resize()
    camera.width = width
    camera.height = height
    camera.minZoom = minZoom(width, height)
    if (camera.zoom < camera.minZoom) camera.zoomTo(camera.minZoom)

    // Пока контекст потерян, рисовать некуда; игра при этом продолжает идти.
    if (renderer.lost) return
    landWindow.update(scene.land, camera, width, height)
    renderer.draw(camera, time.elapsed + time.alpha * time.step, time.delta)
  }

  // Для пробы: несколько баз рядом с камерой.
  placeDemoBuildings(scene, camera.x, camera.y)

  // Систем симуляции пока нет: в мире ничего не движется.
  const loop = new Loop({ world, update: [], render: [controls.update, draw] })
  const stop = loop.start(onError)

  return {
    scene,
    setSettings(next) {
      const regenerate = next.generator !== scene.settings.generator
      scene.settings = next
      if (!regenerate) return
      scene.land = createLand(next.generator)
      world.clear()
      placeDemoBuildings(scene, camera.x, camera.y)
    },
    destroy() {
      stop()
      controls.destroy()
      scene.occupancy.destroy()
      renderer.destroy()
      landWindow.destroy()
    },
  }
}
