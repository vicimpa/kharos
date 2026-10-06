import { createTexture, setBlend, type Texture } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import type { Scene } from './scene'

/** Насколько тёмен тайл: не разведанный, разведанный и тот, что виден сейчас. */
const FOG_ALPHA = [0.94, 0.5, 0] as const

/**
 * Туман войны: чего игрок не видит, затемнено — разведанное наполовину, остальное почти дочерна. Тайл — пиксель
 * текстуры, а сглаживание между пикселями даёт мягкий край обзора. Ставить над миром, под выделением и курсором.
 */
export function createFogPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)
  let texture: Texture | null = null
  let size = { width: 0, height: 0 }
  let pixels = new Uint8Array(0)
  /** Что уже лежит в текстуре: номер изменения обзора и записанный прямоугольник. */
  let written = { changed: -1, left: 0, top: 0, right: 0, bottom: 0, cells: null as Uint8Array | null }

  return {
    draw({ camera, width, height, view }) {
      const { sim, player } = scene
      const { bounds } = sim
      const mapWidth = bounds.right - bounds.left
      const mapHeight = bounds.bottom - bounds.top
      if (!texture || size.width !== mapWidth || size.height !== mapHeight) {
        texture?.destroy()
        texture = createTexture(gl, { width: mapWidth, height: mapHeight, filter: 'linear' })
        size = { width: mapWidth, height: mapHeight }
        written = { ...written, changed: -1 }
      }
      const { cells, changed } = sim.vision.cells(player)

      // В текстуру пишется только видимая часть карты с запасом в тайл: сглаживанию нужны соседи.
      const halfWidth = width / 2 / camera.zoom
      const halfHeight = height / 2 / camera.zoom
      const left = Math.max(bounds.left, Math.floor(camera.x - halfWidth) - 1)
      const right = Math.min(bounds.right, Math.ceil(camera.x + halfWidth) + 1)
      const top = Math.max(bounds.top, Math.floor(camera.y - halfHeight) - 1)
      const bottom = Math.min(bounds.bottom, Math.ceil(camera.y + halfHeight) + 1)
      if (right <= left || bottom <= top) return
      const moved = left < written.left || right > written.right || top < written.top || bottom > written.bottom
      if (changed !== written.changed || moved || cells !== written.cells) {
        const w = right - left
        const h = bottom - top
        if (pixels.length < w * h * 4) pixels = new Uint8Array(w * h * 4)
        for (let y = 0; y < h; y++) {
          const row = (y + top - bounds.top) * mapWidth + left - bounds.left
          for (let x = 0; x < w; x++) pixels[(y * w + x) * 4 + 3] = Math.round(FOG_ALPHA[cells[row + x]] * 255)
        }
        texture.write(pixels.subarray(0, w * h * 4), left - bounds.left, top - bounds.top, w, h)
        written = { changed, left, top, right, bottom, cells }
      }

      sprites.clear()
      // Вся карта одним спрайтом; кадр — вся текстура.
      sprites.push(bounds.left - camera.x, bounds.top - camera.y, mapWidth, mapHeight, 0, 0, 1, 1, 1, 1, 1, 1)
      setBlend(gl, 'alpha')
      program.use(view, { uTexture: texture })
      sprites.draw()
    },
    destroy() {
      sprites.destroy()
      program.destroy()
      texture?.destroy()
    },
  }
}
