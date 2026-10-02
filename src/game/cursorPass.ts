import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites, createWhiteTexture } from '../render/sprites'
import { BUILDINGS, CONTROL_RADIUS, coreCenters } from '../sim'
import { placementOf } from './placing'
import type { Scene } from './scene'

/** Толщина рамки в тайлах: один пиксель пиксель-арта. */
const BORDER = 1 / 16
const FILL_ALPHA = 0.18
const BORDER_ALPHA = 0.85

type Color = readonly [number, number, number]
const WHITE: Color = [1, 1, 1]
const ALLOWED: Color = [0.35, 1, 0.45]
const FORBIDDEN: Color = [1, 0.3, 0.25]
const CONTROL: Color = [0.3, 0.6, 1]
/** Граница радиуса контроля — пунктир: столько штрихов на круг, каждый такой длины и толщины в пикселях экрана. */
const CONTROL_DASHES = 120
const CONTROL_DASH = 3

/**
 * Подсветка под указателем мыши: тайл, а пока игрок выбирает место под здание — его основание (зелёное, если
 * строить можно, красное, если нельзя) и границы радиуса контроля. Ставить выше освещения, чтобы ночью не темнела.
 */
export function createCursorPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const rects = createSprites(gl, program)
  const white = createWhiteTexture(gl)

  return {
    draw({ camera, view }) {
      const tile = scene.camera.pointerTile
      if (!tile) return
      const placement = placementOf(scene)

      /** Прямоугольник в тайлах от камеры. */
      const rect = (x: number, y: number, width: number, height: number, [r, g, b]: Color, alpha: number) =>
        rects.push(x, y, width, height, 0, 0, 1, 1, r * alpha, g * alpha, b * alpha, alpha)

      /** Залитый прямоугольник с рамкой. */
      const area = (left: number, top: number, width: number, height: number, color: Color) => {
        const x = left - camera.x
        const y = top - camera.y
        rect(x, y, width, height, color, FILL_ALPHA)
        rect(x, y, width, BORDER, color, BORDER_ALPHA)
        rect(x, y + height - BORDER, width, BORDER, color, BORDER_ALPHA)
        rect(x, y + BORDER, BORDER, height - BORDER * 2, color, BORDER_ALPHA)
        rect(x + width - BORDER, y + BORDER, BORDER, height - BORDER * 2, color, BORDER_ALPHA)
      }

      rects.clear()
      if (placement) {
        const size = CONTROL_DASH / camera.zoom
        const centers = coreCenters(scene.sim, scene.player)
        for (let i = 0; i < centers.length; i += 2) {
          for (let dash = 0; dash < CONTROL_DASHES; dash++) {
            const angle = (dash / CONTROL_DASHES) * Math.PI * 2
            const x = centers[i] + Math.cos(angle) * CONTROL_RADIUS - camera.x
            const y = centers[i + 1] + Math.sin(angle) * CONTROL_RADIUS - camera.y
            rect(x - size / 2, y - size / 2, size, size, CONTROL, BORDER_ALPHA)
          }
        }
        const { width, height } = BUILDINGS[placement.type]
        area(placement.x, placement.y, width, height, placement.allowed ? ALLOWED : FORBIDDEN)
      } else {
        area(tile.x, tile.y, 1, 1, WHITE)
      }

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
