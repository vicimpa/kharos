import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { BUILDINGS, Building, Converting, DEPOSIT_SIZE, Orders, Owner, Path, Position, Producer, Site, UNITS, Unit, buildTicks, siteTicks } from '../sim'
import type { Scene } from './scene'
import { drawnPosition } from './units/unitsPass'

/** Сторона картинки кольца в пикселях. */
const RING_SIZE = 64
/** Насколько кольцо шире самого юнита, в тайлах. */
const RING_MARGIN = 0.2
/** Толщина рамок в пикселях экрана. */
const BORDER = 1
const BOX_FILL_ALPHA = 0.12
/** Насколько ярко подсвечены те, кого выберет рамка, пока её тянут. */
const HIT_ALPHA = 0.5
/** Высота полоски прогресса в пикселях экрана и её отступ от сущности в тайлах. */
const BAR_HEIGHT = 4
const BAR_GAP = 0.3

/** Путь выбранного юнита — пунктир: точки такого размера в пикселях экрана через столько тайлов. */
const PATH_DOT = 4
const PATH_STEP = 0.4
const PATH_ALPHA = 1
/** Сторона метки в конце пути, в тайлах. */
const PATH_GOAL = 0.4
/** Очередь приказов выбранного юнита — пунктир бледнее пути, с метками точек. */
const QUEUE_ALPHA = 0.55

type Color = readonly [number, number, number]
const SELECTED: Color = [0.35, 1, 0.45]
const BAR_BACK: Color = [0.03, 0.05, 0.08]
const BAR_CONVERTING: Color = [1, 0.8, 0.3]
const BAR_PRODUCING: Color = [0.35, 0.65, 1]
const BAR_BUILDING: Color = [0.45, 0.9, 0.55]
/** Рамка своей площадки, к которой строитель ещё не приступил: ночью чертёж на земле почти не виден. */
const PLANNED: Color = [0.3, 0.6, 1]

/**
 * Выделение и прогресс: кольца вокруг выбранных юнитов, их пути и очереди приказов, рамка вокруг выбранного здания, рамка, которую
 * игрок тянет мышью, рамки размеченных площадок и полоски превращения, производства и стройки над своими сущностями.
 * Ставить выше освещения, чтобы ночью не темнело.
 */
export function createSelectionPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const ring = new Pixmap(RING_SIZE, RING_SIZE)
  ring.ring(RING_SIZE / 2, RING_SIZE / 2, RING_SIZE / 2 - 3, 4, 0xffffff)
  const white = new Pixmap(4, 4).rect(0, 0, 4, 4, 0xffffff)
  const atlas = createAtlas(gl, [ring, white])
  const [ringFrame, whiteFrame] = atlas.frames
  // Середина кадра белой заливки: по краям текстуры цвет подмешивался бы от соседей.
  const whiteU = whiteFrame.u + whiteFrame.width / 2
  const whiteV = whiteFrame.v + whiteFrame.height / 2

  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  /** Закрашенный прямоугольник в тайлах от камеры. */
  const rect = (x: number, y: number, width: number, height: number, [r, g, b]: Color, alpha = 1) =>
    sprites.push(x, y, width, height, whiteU, whiteV, 0, 0, r * alpha, g * alpha, b * alpha, alpha)

  /** Рамка толщиной border внутри прямоугольника. */
  const frame = (x: number, y: number, width: number, height: number, border: number, color: Color) => {
    rect(x, y, width, border, color)
    rect(x, y + height - border, width, border, color)
    rect(x, y, border, height, color)
    rect(x + width - border, y, border, height, color)
  }

  return {
    draw({ camera, view }) {
      const { world, time } = scene.sim
      const pixel = 1 / camera.zoom
      sprites.clear()

      /** Где сущность на экране: верхний левый угол и размер в тайлах от камеры. Для юнита — описанный квадрат. */
      const boundsOf = (entity: Entity) => {
        const position = world.get(entity, Position)
        if (!position) return null
        const unit = world.get(entity, Unit)
        if (unit) {
          const { x, y } = drawnPosition(position, unit, time.alpha)
          const size = (UNITS[unit.type].radius + RING_MARGIN) * 2
          return { x: x - camera.x - size / 2, y: y - camera.y - size / 2, width: size, height: size, round: true }
        }
        const type = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type
        if (!type) return null
        const { width, height } = BUILDINGS[type]
        return { x: position.x - camera.x, y: position.y - camera.y, width, height, round: false }
      }

      // Пути выбранных юнитов — под кольцами. Точки отсчитываются от конца пути, поэтому стоят на земле
      // неподвижно, а не ползут вместе с юнитом.
      const dot = PATH_DOT * pixel
      for (const entity of scene.selection) {
        const path = world.get(entity, Path)
        const unit = world.get(entity, Unit)
        const position = world.get(entity, Position)
        if (!path || !unit || !position || !path.points.length) continue
        const from = drawnPosition(position, unit, time.alpha)
        const points = [from.x, from.y, ...path.points]
        let carry = 0
        for (let i = points.length - 2; i >= 2; i -= 2) {
          const dx = points[i - 2] - points[i]
          const dy = points[i - 1] - points[i + 1]
          const length = Math.hypot(dx, dy)
          let along = carry
          for (; along < length; along += PATH_STEP) {
            const x = points[i] + (dx / length) * along
            const y = points[i + 1] + (dy / length) * along
            rect(x - camera.x - dot / 2, y - camera.y - dot / 2, dot, dot, SELECTED, PATH_ALPHA)
          }
          carry = along - length
        }
        const goalX = points[points.length - 2] - camera.x - PATH_GOAL / 2
        const goalY = points[points.length - 1] - camera.y - PATH_GOAL / 2
        frame(goalX, goalY, PATH_GOAL, PATH_GOAL, pixel * 2, SELECTED)
      }

      /** Середина сущности в тайлах мира: юнита — где он, здания или площадки — середина основания. */
      const centerOf = (target: number) => {
        const entity = target as Entity
        const position = world.get(entity, Position)
        if (!position) return null
        const type = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type
        if (!type) return { x: position.x, y: position.y }
        return { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2 }
      }
      /** Пунктир от (fromX, fromY) к (toX, toY) в тайлах мира. */
      const dashes = (fromX: number, fromY: number, toX: number, toY: number, alpha: number) => {
        const length = Math.hypot(toX - fromX, toY - fromY)
        for (let along = 0; along < length; along += PATH_STEP) {
          const x = toX + ((fromX - toX) / length) * along
          const y = toY + ((fromY - toY) / length) * along
          rect(x - camera.x - dot / 2, y - camera.y - dot / 2, dot, dot, SELECTED, alpha)
        }
      }
      // Очередь приказов: от конца нынешнего пути через места следующих приказов.
      for (const entity of scene.selection) {
        const list = world.get(entity, Orders)?.list
        const unit = world.get(entity, Unit)
        const position = world.get(entity, Position)
        if (!list?.length || !unit || !position) continue
        const points = world.get(entity, Path)?.points
        let from = points?.length ? { x: points[points.length - 2], y: points[points.length - 1] } : drawnPosition(position, unit, time.alpha)
        for (const { command } of list) {
          const to =
            command.type === 'move' ? { x: command.x + 0.5, y: command.y + 0.5 }
            : command.type === 'harvest' ? { x: command.x + DEPOSIT_SIZE / 2, y: command.y + DEPOSIT_SIZE / 2 }
            : command.type === 'attack' ? centerOf(command.target)
            : command.type === 'assist' ? centerOf(command.site)
            : command.type === 'haul' ? centerOf(command.mine)
            : command.type === 'pickup' ? centerOf(command.drop)
            : command.type === 'supply' ? centerOf(command.target)
            : null
          if (!to) continue
          dashes(from.x, from.y, to.x, to.y, QUEUE_ALPHA)
          frame(to.x - camera.x - PATH_GOAL / 2, to.y - camera.y - PATH_GOAL / 2, PATH_GOAL, PATH_GOAL, pixel * 2, SELECTED)
          from = to
        }
      }

      // Точка сбора выбранного здания: пунктир от его середины и флажок на месте.
      for (const entity of scene.selection) {
        const rally = world.get(entity, Producer)?.rally
        const building = world.get(entity, Building)
        const position = world.get(entity, Position)
        if (!rally?.length || !building || !position) continue
        const { width, height } = BUILDINGS[building.type]
        const fromX = position.x + width / 2
        const fromY = position.y + height / 2
        const toX = rally[0] + 0.5
        const toY = rally[1] + 0.5
        dashes(fromX, fromY, toX, toY, PATH_ALPHA)
        // Флажок: древко и полотнище.
        rect(toX - camera.x - pixel, toY - camera.y - 0.9, pixel * 2, 0.9, SELECTED, 1)
        rect(toX - camera.x + pixel, toY - camera.y - 0.9, 0.45, 0.3, SELECTED, 1)
      }

      /** Кольцо вокруг юнита или рамка вокруг здания; alpha — насколько ярко. */
      const mark = (entity: Entity, alpha: number) => {
        const bounds = boundsOf(entity)
        if (!bounds) return
        if (bounds.round) {
          sprites.push(
            bounds.x, bounds.y, bounds.width, bounds.height,
            ringFrame.u, ringFrame.v, ringFrame.width, ringFrame.height,
            SELECTED[0] * alpha, SELECTED[1] * alpha, SELECTED[2] * alpha, alpha,
          )
        } else {
          rect(bounds.x, bounds.y, bounds.width, pixel * 2, SELECTED, alpha)
          rect(bounds.x, bounds.y + bounds.height - pixel * 2, bounds.width, pixel * 2, SELECTED, alpha)
          rect(bounds.x, bounds.y, pixel * 2, bounds.height, SELECTED, alpha)
          rect(bounds.x + bounds.width - pixel * 2, bounds.y, pixel * 2, bounds.height, SELECTED, alpha)
        }
      }
      for (const entity of scene.selection) mark(entity, 1)
      // Кого выберет рамка, если отпустить её сейчас, — бледнее выбранных.
      for (const entity of scene.selectionBox?.hits ?? []) if (!scene.selection.has(entity)) mark(entity, HIT_ALPHA)

      /** Полоска прогресса над сущностью: value от 0 до 1. */
      const bar = (entity: Entity, value: number, color: Color) => {
        const bounds = boundsOf(entity)
        if (!bounds) return
        const height = BAR_HEIGHT * pixel
        const top = bounds.y - BAR_GAP - height
        rect(bounds.x - pixel, top - pixel, bounds.width + pixel * 2, height + pixel * 2, BAR_BACK)
        rect(bounds.x, top, bounds.width * Math.min(1, Math.max(0, value)), height, color)
      }
      for (const [entity, converting, owner] of world.query(Converting, Owner)) {
        if (owner.player === scene.player) bar(entity, 1 - converting.left / converting.total, BAR_CONVERTING)
      }
      for (const [entity, producer, owner] of world.query(Producer, Owner)) {
        if (owner.player !== scene.player || !producer.queue.length || world.has(entity, Converting)) continue
        bar(entity, producer.progress / buildTicks(producer.queue[0], time.step), BAR_PRODUCING)
      }

      for (const [entity, site, owner] of world.query(Site, Owner)) {
        if (owner.player !== scene.player) continue
        if (site.progress > 0) {
          bar(entity, site.progress / siteTicks(site.type, time.step), BAR_BUILDING)
          continue
        }
        const bounds = boundsOf(entity)
        if (bounds) frame(bounds.x, bounds.y, bounds.width, bounds.height, pixel, PLANNED)
      }

      const box = scene.selectionBox
      if (box) {
        const left = Math.min(box.fromX, box.toX) - camera.x
        const top = Math.min(box.fromY, box.toY) - camera.y
        const width = Math.abs(box.toX - box.fromX)
        const height = Math.abs(box.toY - box.fromY)
        rect(left, top, width, height, SELECTED, BOX_FILL_ALPHA)
        frame(left, top, width, height, BORDER * pixel, SELECTED)
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
