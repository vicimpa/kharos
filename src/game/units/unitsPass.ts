import { setBlend } from '../../gl'
import { createAtlas, type AtlasFrame } from '../../render/atlas'
import { Pixmap } from '../../render/pixmap'
import type { Pass } from '../../render/renderer'
import { createSpriteProgram, createSprites } from '../../render/sprites'
import { Owner, Position, UNIT_TYPES, Unit, flies, type UnitType } from '../../sim'
import type { Scene } from '../scene'
import { TEAMS, UNIT_ART, UNIT_DIRECTIONS, UNIT_FRAME, UNIT_LIGHTS, type Team } from './unitArt'

/** Сторона спрайта юнита в тайлах. */
const SPRITE_TILES = UNIT_FRAME / 16
const SHADOW_ALPHA = 0.4
/** Тень — силуэт юнита, сдвинутый вправо вниз на столько тайлов. */
const SHADOW_SHIFT = 2 / 16
/** Летающий высоко: его тень бледнее и лежит дальше. */
const AIR_SHADOW_ALPHA = 0.25
const AIR_SHADOW_SHIFT = 10 / 16
const TURN = Math.PI * 2
/** На сколько тайлов за край экрана юнит ещё рисуется: его самого не видно, но луч фар дотягивается. */
const LIGHT_REACH = 7

/** Где рисовать юнит в этом кадре: между местом тик назад и нынешним, по доле тика alpha. */
export function drawnPosition(position: { x: number; y: number }, unit: { prevX: number; prevY: number }, alpha: number) {
  return {
    x: unit.prevX + (position.x - unit.prevX) * alpha,
    y: unit.prevY + (position.y - unit.prevY) * alpha,
  }
}

/** Куда юнит смотрит в этом кадре: между прошлым и нынешним углом по короткой дуге. */
export function drawnFacing(unit: { facing: number; prevFacing: number }, alpha: number) {
  const turned = unit.facing - unit.prevFacing
  return unit.prevFacing + (turned - TURN * Math.round(turned / TURN)) * alpha
}

const TEAM_NAMES = Object.keys(TEAMS) as Team[]

/**
 * Проходы юнитов: тени, сами юниты и их огни. Юниты — сущности с Position и Unit. Проходов два: наземные юниты
 * рисуются под зданиями, летающие (air) — над ними. Картинки у проходов общие.
 */
export function createUnitsPasses(gl: WebGL2RenderingContext, scene: Scene): { ground: Pass; air: Pass } {
  // Кадры идут подряд: все направления первого вида, потом второго и так далее — и так для каждого цвета.
  const images = TEAM_NAMES.flatMap((team) => {
    return UNIT_TYPES.flatMap((type) => {
      return Array.from({ length: UNIT_DIRECTIONS }, (_, direction) => {
        const image = new Pixmap(UNIT_FRAME, UNIT_FRAME)
        image.originX = image.originY = UNIT_FRAME / 2
        UNIT_ART[type](image, (direction / UNIT_DIRECTIONS) * TURN, TEAMS[team])
        return image
      })
    })
  })
  const atlas = createAtlas(gl, images)
  const frames = new Map<string, AtlasFrame[]>()
  TEAM_NAMES.forEach((team, t) => {
    UNIT_TYPES.forEach((type, i) => {
      const from = (t * UNIT_TYPES.length + i) * UNIT_DIRECTIONS
      frames.set(`${team}:${type}`, atlas.frames.slice(from, from + UNIT_DIRECTIONS))
    })
  })
  const framesOf = (team: Team, type: UnitType) => frames.get(`${team}:${type}`)!

  const program = createSpriteProgram(gl)

  const layer = (air: boolean): Pass => {
    // Тени лежат под всеми юнитами, иначе тень соседа ляжет на кабину.
    const shadows = createSprites(gl, program)
    const sprites = createSprites(gl, program)
    const shadowShift = air ? AIR_SHADOW_SHIFT : SHADOW_SHIFT
    const shadowAlpha = air ? AIR_SHADOW_ALPHA : SHADOW_ALPHA

    return {
      draw({ camera, width, height, view, lights }) {
        const { world, time } = scene.sim
        const halfWidth = width / 2 / camera.zoom + LIGHT_REACH
        const halfHeight = height / 2 / camera.zoom + LIGHT_REACH

        shadows.clear()
        sprites.clear()
        for (const [, position, unit, owner] of world.query(Position, Unit, Owner)) {
          if (flies(unit.type) !== air) continue
          const { x, y } = drawnPosition(position, unit, time.alpha)
          const left = x - camera.x - SPRITE_TILES / 2
          const top = y - camera.y - SPRITE_TILES / 2
          if (Math.abs(x - camera.x) > halfWidth || Math.abs(y - camera.y) > halfHeight) continue

          const facing = drawnFacing(unit, time.alpha)
          const forwardX = Math.cos(facing) / 16
          const forwardY = Math.sin(facing) / 16
          // Свет встаёт на узел сетки пиксель-арта, иначе его пиксели не совпадут с пикселями земли.
          const snap = (value: number) => Math.round(value * 16) / 16
          const { lamps, beam } = UNIT_LIGHTS[unit.type]
          for (const lamp of lamps) {
            const lampX = snap(x + lamp.along * forwardX - lamp.across * forwardY)
            const lampY = snap(y + lamp.along * forwardY + lamp.across * forwardX)
            lights.add(lampX, lampY, lamp.glow * 2, lamp.glow, 1)
          }
          lights.beam(snap(x + beam.along * forwardX), snap(y + beam.along * forwardY), facing, beam.length, beam.near, beam.spread, beam.level)

          const direction = ((Math.round((facing / TURN) * UNIT_DIRECTIONS) % UNIT_DIRECTIONS) + UNIT_DIRECTIONS) % UNIT_DIRECTIONS
          const team: Team = owner.player === scene.player ? 'own' : 'foe'
          const { u, v, width: frameWidth, height: frameHeight } = framesOf(team, unit.type)[direction]
          shadows.push(left + shadowShift, top + shadowShift, SPRITE_TILES, SPRITE_TILES, u, v, frameWidth, frameHeight, 0, 0, 0, shadowAlpha)
          sprites.push(left, top, SPRITE_TILES, SPRITE_TILES, u, v, frameWidth, frameHeight, 1, 1, 1, 1)
        }
        if (!sprites.count) return

        setBlend(gl, 'alpha')
        program.use(view, { uTexture: atlas.texture })
        shadows.draw()
        sprites.draw()
      },
      // Летающие лучам фар не мешают: они выше.
      drawOccluders: air
        ? undefined
        : (view) => {
            setBlend(gl, 'alpha')
            program.use(view, { uTexture: atlas.texture })
            sprites.draw()
          },
      destroy() {
        shadows.destroy()
        sprites.destroy()
        // Общие картинки и программу освобождает наземный проход.
        if (air) return
        program.destroy()
        atlas.texture.destroy()
      },
    }
  }

  return { ground: layer(false), air: layer(true) }
}
