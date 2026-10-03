import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import { Terrain, terrainAt } from '../map/terrain'
import { createLineProgram, createLines } from '../render/lines'
import type { Pass } from '../render/renderer'
import { Position, Unit } from '../sim'
import type { Scene } from './scene'
import { UNIT_GAITS, UNIT_TRACES } from './units/unitArt'
import { drawnFacing, drawnPosition } from './units/unitsPass'

/** Через сколько тайлов пути юнит кладёт новый кусок колеи, а пехотинец — новый отпечаток ступни. */
const TRACE_STEP = 0.15
const STEP_LENGTH = 0.3
/** Длина отпечатка ступни в тайлах. */
const FOOTPRINT = 0.09
/** Сколько секунд след виден, прежде чем исчезнуть совсем; последнюю треть он тает. */
const TRACE_LIFE = 10
/** Больше кусков следа разом не бывает: самые старые уступают место новым. */
const TRACE_LIMIT = 6000
/** Цвет следа: тень вдавленного грунта. Насколько он заметен — решает местность: на скале почти не виден. */
const TRACE_COLOR = [0.16, 0.11, 0.06] as const
const TRACE_LEVEL: Record<Terrain, number> = {
  [Terrain.Sand]: 0.32,
  [Terrain.Rock]: 0.12,
  [Terrain.Swamp]: 0,
  [Terrain.Mountain]: 0,
}

/** Кусок следа: отрезок в тайлах мира, его ширина в тайлах, возраст в секундах и плотность. */
interface Trace {
  fromX: number
  fromY: number
  toX: number
  toY: number
  width: number
  age: number
  level: number
}

/**
 * Проход следов: колёса и гусеницы оставляют на земле колеи, пехота — отпечатки ног. Следы живут только на экране,
 * в симуляции их нет, и через TRACE_LIFE секунд исчезают. Ставится над землёй и под юнитами, до освещения: ночью
 * следы темнеют вместе с землёй.
 */
export function createTracksPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createLineProgram(gl)
  const lines = createLines(gl, program)
  const traces: Trace[] = []
  /** Где каждый юнит положил прошлый кусок следа: от этих точек тянется следующий. foot — какой ногой шагнёт пехотинец. */
  const walkers = new Map<Entity, { x: number; y: number; ends: { x: number; y: number }[]; foot: number; seen: number }>()
  let frame = 0

  const add = (trace: Omit<Trace, 'age'>) => {
    if (trace.level <= 0) return
    if (traces.length >= TRACE_LIMIT) traces.shift()
    traces.push({ ...trace, age: 0 })
  }
  const levelAt = (x: number, y: number) => TRACE_LEVEL[terrainAt(scene.sim.land, Math.floor(x), Math.floor(y))]

  /** Новые следы этого кадра от юнитов на экране. */
  const leave = (camera: { x: number; y: number }, halfWidth: number, halfHeight: number) => {
    const { world, time } = scene.sim
    frame++
    for (const [entity, position, unit] of world.query(Position, Unit)) {
      const trace = UNIT_TRACES[unit.type]
      if (!trace) continue
      const { x, y } = drawnPosition(position, unit, time.alpha)
      if (Math.abs(x - camera.x) > halfWidth || Math.abs(y - camera.y) > halfHeight) continue
      const facing = drawnFacing(unit, time.alpha)
      const acrossX = -Math.sin(facing) / 16
      const acrossY = Math.cos(facing) / 16
      const ends = trace.sides.map((side) => ({ x: x + acrossX * side, y: y + acrossY * side }))
      const last = walkers.get(entity)
      // Новый юнит или вернувшийся издалека начинает след с места.
      if (!last || Math.hypot(x - last.x, y - last.y) > 1) {
        walkers.set(entity, { x, y, ends, foot: 0, seen: frame })
        continue
      }
      last.seen = frame
      const legs = UNIT_GAITS[unit.type] === 'legs'
      if (Math.hypot(x - last.x, y - last.y) < (legs ? STEP_LENGTH / 2 : TRACE_STEP)) continue
      const width = trace.width / 16
      if (legs) {
        // Ноги шагают по очереди: отпечаток ступни вдоль хода.
        const end = ends[last.foot % ends.length]
        const alongX = (Math.cos(facing) * FOOTPRINT) / 2
        const alongY = (Math.sin(facing) * FOOTPRINT) / 2
        add({ fromX: end.x - alongX, fromY: end.y - alongY, toX: end.x + alongX, toY: end.y + alongY, width, level: levelAt(end.x, end.y) })
        last.foot++
      } else {
        ends.forEach((end, i) => {
          const from = last.ends[i]
          add({ fromX: from.x, fromY: from.y, toX: end.x, toY: end.y, width, level: levelAt(end.x, end.y) })
        })
      }
      last.x = x
      last.y = y
      last.ends = ends
    }
    if (frame % 120 === 0) for (const [entity, walker] of walkers) if (frame - walker.seen > 120) walkers.delete(entity)
  }

  return {
    draw({ camera, width, height, delta, view }) {
      const halfWidth = width / 2 / camera.zoom + 2
      const halfHeight = height / 2 / camera.zoom + 2
      leave(camera, halfWidth, halfHeight)
      lines.clear()
      let kept = 0
      for (const trace of traces) {
        trace.age += delta
        if (trace.age >= TRACE_LIFE) continue
        traces[kept++] = trace
        if (Math.abs(trace.toX - camera.x) > halfWidth || Math.abs(trace.toY - camera.y) > halfHeight) continue
        const level = trace.level * Math.min(1, ((TRACE_LIFE - trace.age) / TRACE_LIFE) * 3)
        const [r, g, b] = TRACE_COLOR
        lines.push(trace.fromX - camera.x, trace.fromY - camera.y, trace.toX - camera.x, trace.toY - camera.y, trace.width, r * level, g * level, b * level, level)
      }
      traces.length = kept
      if (!lines.count) return
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
