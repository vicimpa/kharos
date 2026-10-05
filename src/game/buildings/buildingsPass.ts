import { setBlend } from '../../gl'
import { tileKey } from '../../map/terrain'
import { createAtlas, type AtlasFrame } from '../../render/atlas'
import { Pixmap } from '../../render/pixmap'
import type { Pass } from '../../render/renderer'
import { createSpriteProgram, createSprites } from '../../render/sprites'
import type { Entity } from '../../ecs'
import { Assembly, BUILDING_TYPES, Building, Inventory, Position, Site, amountOf, buildingSpec, siteTicks, type BuildingType } from '../../sim'
import { spawnGhostOf } from '../placing'
import type { Scene } from '../scene'
import { ART_FRAMES, ART_TILE, BUILDING_ART, WALL_CONNECTION, type BuildingArt } from './buildingArt'

/** Поля вокруг основания в пикселях спрайта: место для высоких частей. */
const PAD = ART_TILE
const FRAMES_PER_SECOND = 8
const SHADOW_ALPHA = 0.4
/** Тень — силуэт здания, сдвинутый вправо вниз на столько пикселей спрайта. */
const SHADOW_SHIFT = 3
/** Во сколько раз пятно света на земле и ореол шире самой лампы. */
const LIGHT_REACH = 16
const BLOOM_REACH = 3
/** Запас в тайлах вокруг экрана: здание за краем ещё может дотянуться до него светом. */
const VISIBLE_MARGIN = 5
/**
 * Сколько секунд здание ещё считается работающим после того, как работа последний раз сдвинулась: склад меняется
 * по тикам симуляции, а не каждый кадр, и без запаса анимация мигала бы.
 */
const WORK_HOLD = 0.6
/** Цвет недостроенного: чертёж здания, сквозь который видно землю. Альфа меньше половины — тени от лучей он не даёт. */
const BLUEPRINT = [0.3, 0.6, 1, 0.4] as const
/** Призрак отладочного спавна: полупрозрачное здание; красное — если туда нельзя. */
const GHOST = [0.55, 0.55, 0.55, 0.55] as const
const GHOST_FORBIDDEN = [0.55, 0.12, 0.1, 0.55] as const

/** Огонь чертежа: место в пикселях спрайта и яркость в каждом кадре. */
interface ArtLight {
  x: number
  y: number
  size: number
  levels: number[]
}

interface Sheet {
  art: BuildingArt
  images: Pixmap[]
  /** Места кадров в атласе; заполняются после его сборки. */
  frames: AtlasFrame[]
  lights: ArtLight[]
}

/** Сколько кадров в листе: у здания с видом работы — сначала кадры простоя, за ними кадры работы. */
const framesOf = (art: BuildingArt) => ART_FRAMES * (art.working ? 2 : 1)

/** Растеризует один вариант чертежа в кадры анимации и собирает его огни. */
function drawSheet(art: BuildingArt, variant: number): Sheet {
  const images: Pixmap[] = []
  const lights: ArtLight[] = []
  for (let i = 0; i < framesOf(art); i++) {
    const image = new Pixmap(art.width * ART_TILE + PAD * 2, art.height * ART_TILE + PAD * 2)
    image.originX = image.originY = PAD
    let slot = 0
    art.draw(image, (i % ART_FRAMES) / ART_FRAMES, (x, y, size, level) => {
      const light = (lights[slot++] ??= { x, y, size, levels: [] })
      light.levels[i] = level
    }, variant, i >= ART_FRAMES)
    images.push(image)
  }
  return { art, images, frames: [], lights }
}

interface Visible {
  x: number
  y: number
  sheet: Sheet
  frame: number
  /** Нижний край основания: по нему здания перекрывают друг друга. */
  bottom: number
  /** Готовность от 0 до 1: у достроенного — 1, у размеченной площадки — 0. */
  built: number
}

/**
 * Проход зданий: тени, сами здания и их огни. Здания — сущности с Position и Building.
 * Стройка (Site) рисуется чертежом, поверх которого снизу вверх растёт настоящее здание.
 */
export function createBuildingsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const sheets = new Map<BuildingType, Sheet[]>(BUILDING_TYPES.map((type): [BuildingType, Sheet[]] => {
    const art = BUILDING_ART[type]
    return [type, Array.from({ length: art.variants ?? 1 }, (_, variant) => drawSheet(art, variant))]
  }))
  const all = [...sheets.values()].flat()
  const atlas = createAtlas(gl, all.flatMap((sheet) => sheet.images))
  let first = 0
  for (const sheet of all) {
    sheet.frames = atlas.frames.slice(first, first + sheet.images.length)
    first += sheet.images.length
  }

  /**
   * Работает ли здание: переработка — пока убывает её руда, цех — пока движется сборка. Для каждого здания
   * помнится прошлое значение и до какой секунды экранных часов оно считается работающим.
   */
  const activity = new Map<Entity, { value: number; until: number }>()
  const workOf = (entity: Entity, type: BuildingType) => {
    const { world } = scene.sim
    const ore = buildingSpec(type).refines
    if (ore) return amountOf(world.get(entity, Inventory)!, ore)
    const assembly = world.get(entity, Assembly)
    return assembly ? assembly.progress : undefined
  }

  const program = createSpriteProgram(gl)
  // Тени лежат под всеми зданиями, иначе тень соседа ляжет на стену.
  const shadows = createSprites(gl, program)
  const sprites = createSprites(gl, program)
  const visible: Visible[] = []

  return {
    draw({ camera, width, height, time, view, lights }) {
      const halfWidth = width / 2 / camera.zoom + VISIBLE_MARGIN
      const halfHeight = height / 2 / camera.zoom + VISIBLE_MARGIN
      const step = Math.floor(time * FRAMES_PER_SECOND)
      const pad = PAD / ART_TILE

      const { world, time: simTime } = scene.sim
      // И готовая стена, и ещё не начатая соседняя площадка участвуют в соединении: чертёж сразу показывает итог.
      const walls = new Set<number>()
      for (const [, position, building] of world.query(Position, Building)) {
        if (building.type === 'wall') walls.add(tileKey(position.x, position.y))
      }
      for (const [, position, site] of world.query(Position, Site)) {
        if (site.type === 'wall') walls.add(tileKey(position.x, position.y))
      }
      const wallVariant = (position: { x: number; y: number }, type: BuildingType) => {
        if (type !== 'wall') return 0
        let variant = 0
        if (walls.has(tileKey(position.x, position.y - 1))) variant |= WALL_CONNECTION.north
        if (walls.has(tileKey(position.x + 1, position.y))) variant |= WALL_CONNECTION.east
        if (walls.has(tileKey(position.x, position.y + 1))) variant |= WALL_CONNECTION.south
        if (walls.has(tileKey(position.x - 1, position.y))) variant |= WALL_CONNECTION.west
        return variant
      }
      const see = (position: { x: number; y: number }, type: BuildingType, phase: number, built: number, working = false) => {
        const sheet = sheets.get(type)![wallVariant(position, type)]
        if (position.x + sheet.art.width < camera.x - halfWidth || position.x > camera.x + halfWidth) return
        if (position.y + sheet.art.height < camera.y - halfHeight || position.y > camera.y + halfHeight) return
        const frame = ((step + phase) % ART_FRAMES) + (working && sheet.art.working ? ART_FRAMES : 0)
        visible.push({ x: position.x, y: position.y, sheet, frame, bottom: position.y + sheet.art.height, built })
      }

      visible.length = 0
      for (const [entity, position, building] of world.query(Position, Building)) {
        const site = world.get(entity, Site)
        let working = false
        const value = !site && BUILDING_ART[building.type].working ? workOf(entity, building.type) : undefined
        if (value !== undefined) {
          const state = activity.get(entity) ?? { value, until: 0 }
          if (Math.abs(value - state.value) > 1e-9) state.until = time + WORK_HOLD
          state.value = value
          activity.set(entity, state)
          working = time < state.until
        }
        see(position, building.type, building.phase, site ? site.progress / siteTicks(site.type, simTime.step) : 1, working)
      }
      // Площадки, к которым строитель ещё не приступил: здания на них пока нет.
      for (const [entity, position, site] of world.query(Position, Site)) {
        if (!world.has(entity, Building)) see(position, site.type, 0, 0)
      }
      if (step % 64 === 0) for (const entity of activity.keys()) if (!world.has(entity, Building)) activity.delete(entity)
      // Призрак отладочного спавна рисуется поверх всех зданий.
      const ghost = spawnGhostOf(scene)
      if (!visible.length && ghost?.spawn.kind !== 'building') return
      // Нижние здания рисуются позже и перекрывают верхние.
      visible.sort((a, b) => a.bottom - b.bottom)

      shadows.clear()
      sprites.clear()
      const shift = SHADOW_SHIFT / ART_TILE
      for (const { x, y, sheet, frame, built } of visible) {
        const { u, v, width: frameWidth, height: frameHeight } = sheet.frames[frame]
        const left = x - pad - camera.x
        const top = y - pad - camera.y
        const spriteWidth = sheet.art.width + pad * 2
        const spriteHeight = sheet.art.height + pad * 2
        if (built < 1) {
          sprites.push(left, top, spriteWidth, spriteHeight, u, v, frameWidth, frameHeight, ...BLUEPRINT)
          // Готовая часть — нижние строки спрайта, целое число пикселей.
          const rows = Math.round(spriteHeight * ART_TILE)
          const hidden = (rows - Math.floor(rows * built)) / rows
          sprites.push(
            left, top + spriteHeight * hidden, spriteWidth, spriteHeight * (1 - hidden),
            u, v + frameHeight * hidden, frameWidth, frameHeight * (1 - hidden),
            1, 1, 1, 1,
          )
          continue
        }
        shadows.push(left + shift, top + shift, spriteWidth, spriteHeight, u, v, frameWidth, frameHeight, 0, 0, 0, SHADOW_ALPHA)
        sprites.push(left, top, spriteWidth, spriteHeight, u, v, frameWidth, frameHeight, 1, 1, 1, 1)
        for (const light of sheet.lights) {
          lights.add(
            x + light.x / ART_TILE,
            y + light.y / ART_TILE,
            light.size * LIGHT_REACH,
            light.size * BLOOM_REACH + 2,
            light.levels[frame],
          )
        }
      }

      if (ghost && ghost.spawn.kind === 'building') {
        const sheet = sheets.get(ghost.spawn.type)![0]
        const { u, v, width: frameWidth, height: frameHeight } = sheet.frames[step % ART_FRAMES]
        sprites.push(
          ghost.x - pad - camera.x, ghost.y - pad - camera.y, sheet.art.width + pad * 2, sheet.art.height + pad * 2,
          u, v, frameWidth, frameHeight, ...(ghost.allowed ? GHOST : GHOST_FORBIDDEN),
        )
      }

      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture })
      shadows.draw()
      sprites.draw()
    },
    drawOccluders(view) {
      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture })
      sprites.draw()
    },
    destroy() {
      shadows.destroy()
      sprites.destroy()
      program.destroy()
      atlas.texture.destroy()
    },
  }
}
