import { bindScreen, createContext, forgetContext } from '../gl'

/** Откуда смотрим на мир. */
export interface Viewpoint {
  /** Центр экрана в тайлах. */
  x: number
  y: number
  /** Пикселей на тайл. */
  zoom: number
}

/** Всё, что проходу нужно знать о текущем кадре. Объект один на все кадры — не сохраняй его. */
export interface Frame {
  readonly gl: WebGL2RenderingContext
  /** Размер экрана в пикселях CSS; холст может быть плотнее. */
  width: number
  height: number
  camera: Viewpoint
  /** Время игры в секундах, плавное: между тиками оно растёт вместе с кадрами. */
  time: number
  /** Реальное время с прошлого кадра в секундах. */
  delta: number
  /**
   * Юниформы, общие для всех шейдеров: uScreenSize, uZoom, uTime и uScale.
   * uScale переводит тайлы, отсчитанные от камеры, в координаты экрана от -1 до 1.
   */
  view: { uScreenSize: Float32Array; uScale: Float32Array; uZoom: number; uTime: number }
  /** Огни кадра. Проходы, рисующие источники света, добавляют их сюда; проход освещения — использует. */
  lights: Lights
}

/** Источники света, собранные за кадр: по пять чисел на огонь и по восемь на луч. */
export interface Lights {
  readonly data: number[]
  readonly beams: number[]
  /**
   * Огонь в точке (x, y) в тайлах. cutRadius — радиус освещённого пятна на земле, bloomRadius — радиус ореола,
   * оба в пикселях местности; нулевой радиус — без пятна или без ореола. level — яркость от 0 до 1.
   */
  add(x: number, y: number, cutRadius: number, bloomRadius: number, level: number): void
  /**
   * Луч из точки (x, y) в тайлах под углом angle (радианы, 0 — вправо, растёт по часовой стрелке): фара, фонарь.
   * length — длина в пикселях местности; near — полуширина у источника, тоже в пикселях; spread — на сколько
   * пикселей луч расширяется в каждую сторону за пиксель длины. В отличие от огней, луч не проходит сквозь
   * то, что проходы нарисовали в drawOccluders: за зданием и юнитом остаётся тень.
   */
  beam(x: number, y: number, angle: number, length: number, near: number, spread: number, level: number): void
}

/**
 * Проход отрисовки — один слой картинки: местность, здания, погода. Проходы рисуются по порядку,
 * каждый сам выбирает шейдер и способ наложения. Чтобы добавить слой, напиши проход и верни его из setup.
 */
export interface Pass {
  draw(frame: Frame): void
  /**
   * Рисует силуэты того, что не пропускает свет лучей: всё, у чего альфа больше половины, отбрасывает тень.
   * Вызывается проходом освещения после draw() того же кадра, так что набранные в draw() спрайты годятся.
   */
  drawOccluders?(frame: Frame): void
  destroy(): void
}

export interface Renderer {
  readonly gl: WebGL2RenderingContext
  /** Контекст потерян: браузер отобрал видеокарту. Пока это так, draw() ничего не рисует. */
  readonly lost: boolean
  /** Подгоняет холст под размер элемента на странице. Возвращает размер в пикселях CSS. */
  resize(): { width: number; height: number }
  /** Рисует кадр всеми проходами. */
  draw(camera: Viewpoint, time: number, delta: number): void
  /** Уничтожает проходы и освобождает их ресурсы. */
  destroy(): void
}

/**
 * Создаёт проходы и всё, что им нужно на видеокарте. Порядок в списке — порядок отрисовки, снизу вверх.
 * Вызывается при запуске и заново после каждого восстановления контекста: тогда прежние текстуры, буферы
 * и программы уже недействительны, и хранить на них ссылки вне setup нельзя.
 */
export type Setup = (gl: WebGL2RenderingContext) => Pass[]

/**
 * onError получает ошибку, если после восстановления контекста проходы не удалось создать заново.
 * Ошибка при первом создании бросается из самого createRenderer.
 */
export function createRenderer(canvas: HTMLCanvasElement, setup: Setup, onError?: (error: unknown) => void): Renderer {
  const gl = createContext(canvas)
  const size = { width: 1, height: 1 }
  const lightData: number[] = []
  const beamData: number[] = []
  const frame: Frame = {
    gl,
    width: 1,
    height: 1,
    camera: { x: 0, y: 0, zoom: 1 },
    time: 0,
    delta: 0,
    view: { uScreenSize: new Float32Array(2), uScale: new Float32Array(2), uZoom: 1, uTime: 0 },
    lights: {
      data: lightData,
      beams: beamData,
      add(x, y, cutRadius, bloomRadius, level) {
        lightData.push(x, y, cutRadius, bloomRadius, level)
      },
      beam(x, y, angle, length, near, spread, level) {
        beamData.push(x, y, length, level, Math.cos(angle), Math.sin(angle), near, spread)
      },
    },
  }
  let passes = setup(gl)
  let lost = gl.isContextLost()

  const onLost = (event: Event) => {
    // Без этого браузер не станет восстанавливать контекст.
    event.preventDefault()
    lost = true
  }
  const onRestored = () => {
    forgetContext(gl)
    try {
      passes = setup(gl)
      lost = false
    } catch (error) {
      passes = []
      if (!onError) throw error
      onError(error)
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    gl,
    get lost() {
      return lost
    },
    resize() {
      size.width = Math.max(1, canvas.clientWidth)
      size.height = Math.max(1, canvas.clientHeight)
      // Плотнее двух пикселей на пиксель CSS не рисуем: разницы не видно, а работы вчетверо больше.
      const density = Math.min(window.devicePixelRatio || 1, 2)
      const pixelWidth = Math.round(size.width * density)
      const pixelHeight = Math.round(size.height * density)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      return size
    },
    draw(camera, time, delta) {
      if (lost) return
      frame.width = size.width
      frame.height = size.height
      frame.camera = camera
      frame.time = time
      frame.delta = delta
      const { view } = frame
      view.uScreenSize[0] = size.width
      view.uScreenSize[1] = size.height
      view.uScale[0] = (camera.zoom * 2) / size.width
      view.uScale[1] = (camera.zoom * 2) / size.height
      view.uZoom = camera.zoom
      view.uTime = time
      lightData.length = 0
      beamData.length = 0

      bindScreen(gl)
      for (const pass of passes) pass.draw(frame)
    },
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      for (const pass of passes) pass.destroy()
      passes = []
    },
  }
}
