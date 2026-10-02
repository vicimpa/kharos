import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites, createWhiteTexture } from '../render/sprites'
import type { Scene } from './scene'

/** Насколько темнеет местность за границей карты. */
const OUTSIDE_ALPHA = 0.65

/** Затемняет всё, что за границами карты. Ставить сразу над местностью. */
export function createBoundsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const rects = createSprites(gl, program)
  const white = createWhiteTexture(gl)

  return {
    draw({ camera, width, height, view }) {
      const { bounds } = scene.sim
      // Видимая часть мира и границы — в тайлах от камеры.
      const halfWidth = width / 2 / camera.zoom
      const halfHeight = height / 2 / camera.zoom
      const left = Math.max(-halfWidth, bounds.left - camera.x)
      const right = Math.min(halfWidth, bounds.right - camera.x)
      const top = Math.max(-halfHeight, bounds.top - camera.y)
      const bottom = Math.min(halfHeight, bounds.bottom - camera.y)

      rects.clear()
      const rect = (x1: number, y1: number, x2: number, y2: number) => {
        if (x2 > x1 && y2 > y1) rects.push(x1, y1, x2 - x1, y2 - y1, 0, 0, 1, 1, 0, 0, 0, OUTSIDE_ALPHA)
      }
      // Полосы сверху и снизу — во всю ширину экрана, слева и справа — между ними.
      rect(-halfWidth, -halfHeight, halfWidth, top)
      rect(-halfWidth, bottom, halfWidth, halfHeight)
      rect(-halfWidth, top, left, bottom)
      rect(right, top, halfWidth, bottom)
      if (!rects.count) return

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
