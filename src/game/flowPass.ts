import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createLineProgram, createLines } from '../render/lines'
import { BUILDINGS, Batch, Building, Owner, Position, Site, buildingSpec, isPipe, zonesOf } from '../sim'
import { GOOD_COLORS } from './resourceColors'
import type { Scene } from './scene'

/** Сторона метки пачки в тайлах и толщина её тёмной обводки. */
const MARK = 0.3
const OUTLINE = 0.08

/**
 * Проход потока: что идёт по трубам — бегущие метки цвета груза. Пачка известна клиенту целиком с отправки
 * (путь узлами, тики отправки и прихода, см. Batch), так что метка едет сама, без вестей с хоста. На подземном
 * отрезке между колодцами и над зданиями метки не видно — только на трубе. Хост шлёт пачки только хозяину труб.
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

  const isHub = (entity: Entity) => {
    const type = scene.sim.world.get(entity, Building)?.type
    return type !== undefined && !!buildingSpec(type).link
  }

  /**
   * Подземные отрезки своих колодцев: пунктир от колодца до парного, по графу сети (см. zones.ts). У колодца
   * без пары — красная метка: под землёй он ни с чем не связан. И связи узлов — пунктир до подключённого.
   */
  const drawWells = (camera: { x: number; y: number }) => {
    const { world } = scene.sim
    const paired = new Set<number>()
    for (const zone of zonesOf(scene.sim, scene.player)) {
      for (let i = 0; i < zone.edges.length; i += 3) {
        const a = zone.edges[i] as Entity
        const b = zone.edges[i + 1] as Entity
        if (world.get(a, Building)?.type !== 'well' || world.get(b, Building)?.type !== 'well') continue
        paired.add(a).add(b)
        const one = centerOf(a)!
        const two = centerOf(b)!
        const length = Math.hypot(two.x - one.x, two.y - one.y)
        // Штрих на каждом тайле отрезка, кроме самих колодцев.
        for (let step = 0.75; step < length - 0.5; step += 1) {
          const from = step / length
          const to = Math.min(step + 0.5, length - 0.5) / length
          lines.push(one.x + (two.x - one.x) * from - camera.x, one.y + (two.y - one.y) * from - camera.y, one.x + (two.x - one.x) * to - camera.x, one.y + (two.y - one.y) * to - camera.y, 0.12, 0.25, 0.39, 0.56, 0.7)
        }
      }
    }
    // Связи узлов: тонкий пунктир от узла до каждого, кого он подключает.
    for (const zone of zonesOf(scene.sim, scene.player)) {
      for (let i = 0; i < zone.edges.length; i += 3) {
        const a = zone.edges[i] as Entity
        const b = zone.edges[i + 1] as Entity
        const hub = isHub(a) ? a : isHub(b) ? b : undefined
        if (hub === undefined) continue
        const one = centerOf(hub)!
        const two = centerOf(hub === a ? b : a)!
        const length = Math.hypot(two.x - one.x, two.y - one.y)
        for (let step = 1; step < length - 0.5; step += 1) {
          const from = step / length
          const to = Math.min(step + 0.4, length - 0.5) / length
          lines.push(one.x + (two.x - one.x) * from - camera.x, one.y + (two.y - one.y) * from - camera.y, one.x + (two.x - one.x) * to - camera.x, one.y + (two.y - one.y) * to - camera.y, 0.08, 0.35, 0.66, 1, 0.45)
        }
      }
    }
    for (const [entity, building, position, owner] of world.query(Building, Position, Owner)) {
      if (building.type !== 'well' || owner.player !== scene.player || paired.has(entity) || world.has(entity, Site)) continue
      const x = position.x + 0.5 - camera.x
      const y = position.y + 0.5 - camera.y
      lines.push(x - 0.3, y - 0.3, x + 0.3, y + 0.3, 0.12, 0.81, 0.18, 0.14, 0.9)
      lines.push(x - 0.3, y + 0.3, x + 0.3, y - 0.3, 0.12, 0.81, 0.18, 0.14, 0.9)
    }
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
          const atX = from.x + (to.x - from.x) * part
          const atY = from.y + (to.y - from.y) * part
          // Груз видно только на трубе: над зданием метку не рисуют.
          const under = scene.sim.occupancy.at(Math.floor(atX), Math.floor(atY))
          const type = under === undefined ? undefined : world.get(under, Building)?.type
          if (type === undefined || !isPipe(type)) break
          const x = atX - camera.x
          const y = atY - camera.y
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
      drawWells(camera)
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
