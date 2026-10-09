import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createLineProgram, createLines } from '../render/lines'
import { BUILDINGS, Batch, Building, Position, Site } from '../sim'
import { GOOD_COLORS } from './resourceColors'
import type { Scene } from './scene'

/** Сторона метки пачки в тайлах и толщина её тёмной обводки. */
const MARK = 0.3
const OUTLINE = 0.08

/**
 * Проход потока: что идёт по трубам — бегущие метки цвета груза. Пачка известна клиенту целиком с отправки
 * (путь узлами, тики отправки и прихода, см. Batch), так что метка едет сама, без вестей с хоста. На подземном
 * отрезке между колодцами метки не видно. Хост шлёт пачки только хозяину труб.
 */
export function createFlowPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createLineProgram(gl)
  const lines = createLines(gl, program)

  /** Середина узла пути: здание — центр основания, труба — центр тайла. undefined — узла клиент не знает. */
  const centerOf = (entity: Entity) => {
    const { world } = scene.sim
    const position = world.get(entity, Position)
    const type = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type
    if (!position || type === undefined) return undefined
    return { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2, well: type === 'well' }
  }

  return {
    draw({ camera, width, height, view }) {
      const { world, time } = scene.sim
      const now = time.tick + time.alpha
      const halfWidth = width / 2 / camera.zoom + 1
      const halfHeight = height / 2 / camera.zoom + 1
      lines.clear()
      for (const [, batch] of world.query(Batch)) {
        const share = (now - batch.sent) / Math.max(1, batch.arrive - batch.sent)
        if (share < 0 || share > 1) continue
        const points = batch.path.map((node) => centerOf(node as Entity))
        if (points.some((point) => point === undefined)) continue
        // Длина пути по отрезкам: метка едет с одной скоростью по всей ломаной.
        let total = 0
        for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
        let left = share * total
        for (let i = 1; i < points.length; i++) {
          const from = points[i - 1]!
          const to = points[i]!
          const length = Math.hypot(to.x - from.x, to.y - from.y)
          if (left > length && i < points.length - 1) {
            left -= length
            continue
          }
          // Под землёй — между двумя колодцами, не соседними, — пачки не видно.
          if (from.well && to.well && length > 1) break
          const part = length ? Math.min(1, left / length) : 1
          const x = from.x + (to.x - from.x) * part - camera.x
          const y = from.y + (to.y - from.y) * part - camera.y
          if (Math.abs(x) > halfWidth || Math.abs(y) > halfHeight) break
          const color = GOOD_COLORS[batch.resource]
          const r = ((color >> 16) & 255) / 255
          const g = ((color >> 8) & 255) / 255
          const b = (color & 255) / 255
          const outer = MARK + OUTLINE * 2
          lines.push(x - outer / 2, y, x + outer / 2, y, outer, 0.04, 0.05, 0.08, 1)
          lines.push(x - MARK / 2, y, x + MARK / 2, y, MARK, r, g, b, 1)
          break
        }
      }
      setBlend(gl, 'alpha')
      program.use(view)
      lines.draw()
    },
    destroy() {
      lines.destroy()
      program.destroy()
    },
  }
}
