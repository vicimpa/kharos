import { createTexture, type Texture } from '../gl'
import type { Viewpoint } from '../render/renderer'
import { CHUNK_SIZE, getChunk, type Land } from './terrain'

/** Сторона текстуры-окна в тайлах. Должна совпадать с WINDOW в шейдерах. */
export const WINDOW = 512
const WINDOW_CHUNKS = WINDOW / CHUNK_SIZE
/** Запас в тайлах вокруг экрана: шейдеры смешивают соседние тайлы и искажают их границы. */
const MARGIN = 2

export const wrap = (value: number, period: number) => ((value % period) + period) % period

/** Самый мелкий зум, при котором экран вместе с запасом помещается в окно; иначе чанки затирают друг друга. */
export const minZoom = (screenWidth: number, screenHeight: number) =>
  Math.max(screenWidth, screenHeight) / (WINDOW - CHUNK_SIZE - MARGIN * 2)

/**
 * Окно местности вокруг камеры, общее для всех шейдеров карты: текстура тайлов и положение камеры в ней.
 * Тайл (x, y) хранится в текселе (x mod WINDOW, y mod WINDOW), а чанки дописываются по мере движения камеры.
 */
export interface LandWindow {
  /**
   * uMap — тайлы: r = тип местности, g = биом, b и a — см. terrain.ts.
   * uCamera — центр экрана в тайлах по модулю WINDOW.
   */
  readonly uniforms: { uMap: Texture; uCamera: Float32Array }
  /**
   * Подгружает чанки вокруг точки обзора. Если местность сменилась, окно забывает загруженное
   * и читает чанки заново. Зум не должен быть меньше minZoom().
   */
  update(land: Land, viewpoint: Viewpoint, screenWidth: number, screenHeight: number): void
  destroy(): void
}

export function createLandWindow(gl: WebGL2RenderingContext): LandWindow {
  const texture = createTexture(gl, { width: WINDOW, height: WINDOW })
  const uniforms = { uMap: texture, uCamera: new Float32Array(2) }
  // Какой чанк сейчас лежит в каждом слоте окна. NaN — слот пуст.
  const slotChunkX = new Float64Array(WINDOW_CHUNKS * WINDOW_CHUNKS).fill(NaN)
  const slotChunkY = new Float64Array(WINDOW_CHUNKS * WINDOW_CHUNKS).fill(NaN)
  let loaded: Land | null = null

  return {
    uniforms,
    update(land, camera, screenWidth, screenHeight) {
      if (land !== loaded) {
        loaded = land
        slotChunkX.fill(NaN)
        slotChunkY.fill(NaN)
      }

      const halfWidth = screenWidth / 2 / camera.zoom + MARGIN
      const halfHeight = screenHeight / 2 / camera.zoom + MARGIN
      const fromX = Math.floor((camera.x - halfWidth) / CHUNK_SIZE)
      const toX = Math.floor((camera.x + halfWidth) / CHUNK_SIZE)
      const fromY = Math.floor((camera.y - halfHeight) / CHUNK_SIZE)
      const toY = Math.floor((camera.y + halfHeight) / CHUNK_SIZE)

      for (let chunkY = fromY; chunkY <= toY; chunkY++) {
        for (let chunkX = fromX; chunkX <= toX; chunkX++) {
          const slotX = wrap(chunkX, WINDOW_CHUNKS)
          const slotY = wrap(chunkY, WINDOW_CHUNKS)
          const slot = slotY * WINDOW_CHUNKS + slotX
          if (slotChunkX[slot] === chunkX && slotChunkY[slot] === chunkY) continue

          // Чанк пишется прямо в свой угол текстуры: копия окна в памяти не нужна.
          texture.write(getChunk(land, chunkX, chunkY), slotX * CHUNK_SIZE, slotY * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE)
          slotChunkX[slot] = chunkX
          slotChunkY[slot] = chunkY
        }
      }

      uniforms.uCamera[0] = wrap(camera.x, WINDOW)
      uniforms.uCamera[1] = wrap(camera.y, WINDOW)
    },
    destroy() {
      texture.destroy()
    },
  }
}
