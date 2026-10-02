import { setBlend } from '../../gl'
import { createAtlas, type AtlasFrame } from '../../render/atlas'
import { Pixmap } from '../../render/pixmap'
import type { Pass } from '../../render/renderer'
import { createSpriteProgram, createSprites } from '../../render/sprites'
import { Position, UNIT_TYPES, Unit, type UnitType } from '../../sim'
import type { Scene } from '../scene'
import { UNIT_ART, UNIT_DIRECTIONS, UNIT_FRAME } from './unitArt'

/** Сторона спрайта юнита в тайлах. */
const SPRITE_TILES = UNIT_FRAME / 16
const SHADOW_ALPHA = 0.4
/** Тень — силуэт юнита, сдвинутый вправо вниз на столько тайлов. */
const SHADOW_SHIFT = 2 / 16
const TURN = Math.PI * 2

/** Где рисовать юнит в этом кадре: между местом тик назад и нынешним, по доле тика alpha. */
export function drawnPosition(position: { x: number; y: number }, unit: { prevX: number; prevY: number }, alpha: number) {
  return {
    x: unit.prevX + (position.x - unit.prevX) * alpha,
    y: unit.prevY + (position.y - unit.prevY) * alpha,
  }
}

/** Проход юнитов: тени и сами юниты. Юниты — сущности с Position и Unit. */
export function createUnitsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  // Кадры идут подряд: все направления первого вида, потом второго и так далее.
  const images = UNIT_TYPES.flatMap((type) => {
    return Array.from({ length: UNIT_DIRECTIONS }, (_, direction) => {
      const image = new Pixmap(UNIT_FRAME, UNIT_FRAME)
      image.originX = image.originY = UNIT_FRAME / 2
      UNIT_ART[type](image, (direction / UNIT_DIRECTIONS) * TURN)
      return image
    })
  })
  const atlas = createAtlas(gl, images)
  const frames = new Map<UnitType, AtlasFrame[]>(
    UNIT_TYPES.map((type, i) => [type, atlas.frames.slice(i * UNIT_DIRECTIONS, (i + 1) * UNIT_DIRECTIONS)]),
  )

  const program = createSpriteProgram(gl)
  // Тени лежат под всеми юнитами, иначе тень соседа ляжет на кабину.
  const shadows = createSprites(gl, program)
  const sprites = createSprites(gl, program)

  return {
    draw({ camera, width, height, view }) {
      const { world, time } = scene.sim
      const halfWidth = width / 2 / camera.zoom + SPRITE_TILES
      const halfHeight = height / 2 / camera.zoom + SPRITE_TILES

      shadows.clear()
      sprites.clear()
      for (const [, position, unit] of world.query(Position, Unit)) {
        const { x, y } = drawnPosition(position, unit, time.alpha)
        const left = x - camera.x - SPRITE_TILES / 2
        const top = y - camera.y - SPRITE_TILES / 2
        if (Math.abs(x - camera.x) > halfWidth || Math.abs(y - camera.y) > halfHeight) continue

        const direction = ((Math.round((unit.facing / TURN) * UNIT_DIRECTIONS) % UNIT_DIRECTIONS) + UNIT_DIRECTIONS) % UNIT_DIRECTIONS
        const { u, v, width: frameWidth, height: frameHeight } = frames.get(unit.type)![direction]
        shadows.push(left + SHADOW_SHIFT, top + SHADOW_SHIFT, SPRITE_TILES, SPRITE_TILES, u, v, frameWidth, frameHeight, 0, 0, 0, SHADOW_ALPHA)
        sprites.push(left, top, SPRITE_TILES, SPRITE_TILES, u, v, frameWidth, frameHeight, 1, 1, 1, 1)
      }
      if (!sprites.count) return

      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture })
      shadows.draw()
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
