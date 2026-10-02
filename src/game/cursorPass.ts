import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites, createWhiteTexture } from '../render/sprites'
import type { Scene } from './scene'

/** Толщина рамки в тайлах: один пиксель пиксель-арта. */
const BORDER = 1 / 16
const FILL_ALPHA = 0.18
const BORDER_ALPHA = 0.85

/** Подсветка тайла под указателем мыши. Ставить выше освещения, чтобы ночью не темнела. */
export function createCursorPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const rects = createSprites(gl, program)
  const white = createWhiteTexture(gl)

  return {
    draw({ camera, view }) {
      const tile = scene.camera.pointerTile
      if (!tile) return
      const x = tile.x - camera.x
      const y = tile.y - camera.y

      /** Белый прямоугольник в тайле: место и размер в долях тайла. */
      const rect = (left: number, top: number, width: number, height: number, alpha: number) =>
        rects.push(x + left, y + top, width, height, 0, 0, 1, 1, alpha, alpha, alpha, alpha)

      rects.clear()
      rect(0, 0, 1, 1, FILL_ALPHA)
      rect(0, 0, 1, BORDER, BORDER_ALPHA)
      rect(0, 1 - BORDER, 1, BORDER, BORDER_ALPHA)
      rect(0, BORDER, BORDER, 1 - BORDER * 2, BORDER_ALPHA)
      rect(1 - BORDER, BORDER, BORDER, 1 - BORDER * 2, BORDER_ALPHA)

      setBlend(gl, 'alpha')
      program.use(view, { uTexture: white })
      rects.draw()
    },
    destroy() {
      rects.destroy()
      program.destroy()
      white.destroy()
    },
  }
}
