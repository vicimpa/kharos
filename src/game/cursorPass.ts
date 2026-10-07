import { setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites, createWhiteTexture } from '../render/sprites'
import type { Entity } from '../ecs'
import { BUILDINGS, Building, CONTROL_RADIUS, Hauler, Position, Tactics, allZones } from '../sim'
import { paveStrokeOf, placementOf } from './placing'
import type { Scene } from './scene'

/** Толщина рамки в тайлах: один пиксель пиксель-арта. */
const BORDER = 1 / 16
const FILL_ALPHA = 0.18
const BORDER_ALPHA = 0.85

type Color = readonly [number, number, number]
const ALLOWED: Color = [0.35, 1, 0.45]
const FORBIDDEN: Color = [1, 0.3, 0.25]
const CONTROL: Color = [0.3, 0.6, 1]
/** Снимаемое покрытие. */
const REMOVE: Color = [1, 0.65, 0.2]
/** Покрытие, на которое не хватает кредитов. */
const SHORT: Color = [1, 0.85, 0.15]
/** Маршрут грузовиков: цвет, размер точки пунктира в пикселях экрана и шаг пунктира в тайлах. */
const ROUTE: Color = [1, 0.85, 0.3]
/** Здания, которые обслуживают выбранные грузовики: только рамки, без пунктира. */
const SERVE: Color = [0.45, 0.85, 1]
const ROUTE_DOT = 3
const ROUTE_STEP = 0.5

/** Маршрут на карте: остановки прямоугольниками основания; closed — замкнут по кругу, а не ещё набирается. */
interface DrawnRoute {
  stops: { x: number; y: number; width: number; height: number }[]
  closed: boolean
  /** Только рамки зданий, без пунктира между ними: назначение грузовиков, а не маршрут. */
  marks?: boolean
}

/** Маршруты для показа: набираемый игроком и маршруты выбранных грузовиков, каждый по разу. */
function routesOf(scene: Scene): DrawnRoute[] {
  const { world } = scene.sim
  const stopOf = (entity: number) => {
    const position = world.get(entity as Entity, Position)
    const type = world.get(entity as Entity, Building)?.type
    return position && type !== undefined ? { x: position.x, y: position.y, ...BUILDINGS[type] } : null
  }
  const routes: DrawnRoute[] = []
  const seen = new Set<string>()
  const add = (entities: readonly number[], closed: boolean) => {
    const key = `${closed}:${entities.join()}`
    if (!entities.length || seen.has(key)) return
    seen.add(key)
    routes.push({ stops: entities.map(stopOf).filter((stop) => stop !== null), closed })
  }
  if (scene.routing) add(scene.routing, false)
  // Назначение: отмечаемые сейчас здания и назначенные выбранным грузовикам.
  const marks = (entities: readonly number[]) => {
    const key = `serve:${entities.join()}`
    if (!entities.length || seen.has(key)) return
    seen.add(key)
    routes.push({ stops: entities.map(stopOf).filter((stop) => stop !== null), closed: false, marks: true })
  }
  if (scene.serving) marks(scene.serving)
  for (const entity of scene.selection) {
    const serve = world.get(entity, Hauler)?.serve
    if (serve?.length) marks(serve)
  }
  for (const entity of scene.selection) {
    const route = world.get(entity, Hauler)?.route
    if (route?.length) add(route, true)
  }
  // Патруль: точки — тайлы. Набираемый — от выбранного бойца через набранные точки.
  const tiles = (points: readonly number[], closed: boolean) => {
    const key = `patrol:${closed}:${points.join()}`
    if (points.length < 2 || seen.has(key)) return
    seen.add(key)
    const stops = []
    for (let i = 0; i + 1 < points.length; i += 2) stops.push({ x: points[i], y: points[i + 1], width: 1, height: 1 })
    routes.push({ stops, closed })
  }
  for (const entity of scene.selection) {
    const patrol = world.get(entity, Tactics)?.patrol
    if (patrol?.length) tiles(patrol, true)
  }
  return routes
}
/** Граница радиуса контроля — пунктир: столько штрихов на круг, каждый такой длины и толщины в пикселях экрана. */
const CONTROL_DASHES = 120
const CONTROL_DASH = 3

/**
 * Подсветка под указателем мыши, пока игрок выбирает место под здание: его основание (зелёное, если строить можно,
 * красное, если нельзя) и границы зон строительства. Так же — тайлы покрытия, которое игрок тянет мышью.
 * В остальное время ничего не рисует.
 * Ставить выше освещения, чтобы ночью не темнела.
 */
export function createCursorPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createSpriteProgram(gl)
  const rects = createSprites(gl, program)
  const white = createWhiteTexture(gl)

  return {
    draw({ camera, view }) {
      const placement = scene.camera.pointerTile ? placementOf(scene) : null
      const stroke = scene.camera.pointerTile ? paveStrokeOf(scene) : null
      const routes = routesOf(scene)
      if (!placement && !stroke && !routes.length) return

      /** Прямоугольник в тайлах от камеры. */
      const rect = (x: number, y: number, width: number, height: number, [r, g, b]: Color, alpha: number) =>
        rects.push(x, y, width, height, 0, 0, 1, 1, r * alpha, g * alpha, b * alpha, alpha)

      /** Рамка прямоугольника. */
      const frame = (left: number, top: number, width: number, height: number, color: Color) => {
        const x = left - camera.x
        const y = top - camera.y
        rect(x, y, width, BORDER, color, BORDER_ALPHA)
        rect(x, y + height - BORDER, width, BORDER, color, BORDER_ALPHA)
        rect(x, y + BORDER, BORDER, height - BORDER * 2, color, BORDER_ALPHA)
        rect(x + width - BORDER, y + BORDER, BORDER, height - BORDER * 2, color, BORDER_ALPHA)
      }
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
      // Маршруты грузовиков: остановки в рамке, между ними — пунктир по кругу.
      for (const { stops, closed, marks } of routes) {
        const size = ROUTE_DOT / camera.zoom
        const centers = stops.map(({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 2 }))
        for (const { x, y, width, height } of stops) area(x, y, width, height, marks ? SERVE : ROUTE)
        const legs = marks ? 0 : closed ? centers.length : centers.length - 1
        for (let i = 0; i < legs; i++) {
          const from = centers[i]
          const to = centers[(i + 1) % centers.length]
          const length = Math.hypot(to.x - from.x, to.y - from.y)
          for (let along = 0; along < length; along += ROUTE_STEP) {
            const t = along / length
            rect(from.x + (to.x - from.x) * t - camera.x - size / 2, from.y + (to.y - from.y) * t - camera.y - size / 2, size, size, ROUTE, BORDER_ALPHA)
          }
        }
      }
      if (placement || stroke) {
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
        if (placement) {
          const { width, height } = BUILDINGS[placement.type]
          // Само здание рисует призраком проход зданий: здесь — только обводка основания.
          frame(placement.x, placement.y, width, height, placement.allowed ? ALLOWED : FORBIDDEN)
        }
        if (stroke) {
          const good = stroke.tool === 'remove' ? REMOVE : ALLOWED
          for (let i = 0; i < stroke.tiles.length; i += 2) {
            const tile = i >> 1
            area(stroke.tiles[i], stroke.tiles[i + 1], 1, 1, stroke.allowed[tile] ? good : stroke.short[tile] ? SHORT : FORBIDDEN)
          }
        }
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
