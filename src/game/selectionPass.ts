import { setBlend } from '../gl'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { Position, UNITS, Unit } from '../sim'
import type { Scene } from './scene'
import { drawnPosition } from './units/unitsPass'

/** Сторона картинки кольца в пикселях. */
const RING_SIZE = 64
/** Насколько кольцо шире самого юнита, в тайлах. */
const RING_MARGIN = 0.2
/** Толщина рамки выделения в пикселях экрана. */
const BOX_BORDER = 1
const BOX_FILL_ALPHA = 0.12

/**
 * Выделение: кольца вокруг выбранных юнитов и рамка, которую игрок тянет мышью.
 * Ставить выше освещения, чтобы ночью не темнело.
 */
export function createSelectionPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const ring = new Pixmap(RING_SIZE, RING_SIZE)
  ring.ring(RING_SIZE / 2, RING_SIZE / 2, RING_SIZE / 2 - 3, 4, 0xffffff)
  const white = new Pixmap(4, 4).rect(0, 0, 4, 4, 0xffffff)
  const atlas = createAtlas(gl, [ring, white])
  const [ringFrame, whiteFrame] = atlas.frames

  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  return {
    draw({ camera, view }) {
      const { world, time } = scene.sim
      sprites.clear()

      for (const entity of scene.selection) {
        const position = world.get(entity, Position)
        const unit = world.get(entity, Unit)
        if (!position || !unit) continue
        const { x, y } = drawnPosition(position, unit, time.alpha)
        const size = (UNITS[unit.type].radius + RING_MARGIN) * 2
        sprites.push(
          x - camera.x - size / 2, y - camera.y - size / 2, size, size,
          ringFrame.u, ringFrame.v, ringFrame.width, ringFrame.height,
          0.35, 1, 0.45, 1,
        )
      }

      const box = scene.selectionBox
      if (box) {
        const left = Math.min(box.fromX, box.toX) - camera.x
        const top = Math.min(box.fromY, box.toY) - camera.y
        const boxWidth = Math.abs(box.toX - box.fromX)
        const boxHeight = Math.abs(box.toY - box.fromY)
        const border = BOX_BORDER / camera.zoom
        // Середина кадра белой заливки: по краям текстуры цвет подмешивался бы от соседей.
        const u = whiteFrame.u + whiteFrame.width / 2
        const v = whiteFrame.v + whiteFrame.height / 2
        const rect = (x: number, y: number, rectWidth: number, rectHeight: number, alpha: number) =>
          sprites.push(x, y, rectWidth, rectHeight, u, v, 0, 0, 0.35 * alpha, alpha, 0.45 * alpha, alpha)
        rect(left, top, boxWidth, boxHeight, BOX_FILL_ALPHA)
        rect(left, top, boxWidth, border, 1)
        rect(left, top + boxHeight - border, boxWidth, border, 1)
        rect(left, top, border, boxHeight, 1)
        rect(left + boxWidth - border, top, border, boxHeight, 1)
      }
      if (!sprites.count) return

      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture })
      sprites.draw()
    },
    destroy() {
      sprites.destroy()
      program.destroy()
      atlas.texture.destroy()
    },
  }
}
