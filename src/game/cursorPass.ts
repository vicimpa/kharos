import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites, createWhiteTexture } from '../render/sprites'
import { BUILDINGS, CONTROL_RADIUS, allZones } from '../sim'
import { placementOf } from './placing'
import type { Scene } from './scene'

/** Толщина рамки в тайлах: один пиксель пиксель-арта. */
const BORDER = 1 / 16
const FILL_ALPHA = 0.18
const BORDER_ALPHA = 0.85

type Color = readonly [number, number, number]
const ALLOWED: Color = [0.35, 1, 0.45]
const FORBIDDEN: Color = [1, 0.3, 0.25]
const CONTROL: Color = [0.3, 0.6, 1]
/** Граница радиуса контроля — пунктир: столько штрихов на круг, каждый такой длины и толщины в пикселях экрана. */
const CONTROL_DASHES = 120
const CONTROL_DASH = 3

/**
 * Подсветка под указателем мыши, пока игрок выбирает место под здание: его основание (зелёное, если строить можно,
 * красное, если нельзя) и границы зон строительства. В остальное время ничего не рисует.
 * Ставить выше освещения, чтобы ночью не темнела.
 */
export function createCursorPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const rects = createSprites(gl, program)
  const white = createWhiteTexture(gl)

  return {
    draw({ camera, view }) {
      if (!scene.camera.pointerTile) return
      const placement = placementOf(scene)
      if (!placement) return

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
      {
        const size = CONTROL_DASH / camera.zoom
        /** Внешняя граница зоны пунктиром. zone — круги: x, y и радиус подряд. */
        const outline = (zone: readonly number[], color: Color) => {
          for (let i = 0; i < zone.length; i += 3) {
            const radius = zone[i + 2]
            // Точки идут с одним шагом на любом круге, поэтому на малом их меньше.
            const dashes = Math.round((CONTROL_DASHES * radius) / CONTROL_RADIUS)
            dashes: for (let dash = 0; dash < dashes; dash++) {
              const angle = (dash / dashes) * Math.PI * 2
              const x = zone[i] + Math.cos(angle) * radius
              const y = zone[i + 1] + Math.sin(angle) * radius
              // Рисуется только внешняя граница зоны: точка внутри соседнего круга — не граница.
              for (let other = 0; other < zone.length; other += 3) {
                if (other !== i && Math.hypot(x - zone[other], y - zone[other + 1]) < zone[other + 2] - 0.01) continue dashes
              }
              rect(x - camera.x - size / 2, y - camera.y - size / 2, size, size, color, BORDER_ALPHA)
            }
          }
        }
        // Свои зоны — где строить можно, чужие — где нельзя.
        for (const [player, zones] of allZones(scene.sim)) {
          const own = player === scene.player
          if (own) outline(zones.flatMap((zone) => zone.circles), CONTROL)
          else for (const zone of zones) outline(zone.circles, FORBIDDEN)
        }
        const { width, height } = BUILDINGS[placement.type]
        area(placement.x, placement.y, width, height, placement.allowed ? ALLOWED : FORBIDDEN)
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
