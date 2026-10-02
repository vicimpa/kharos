import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { BUILDINGS, Building, Position, powerStates, type PowerState } from '../sim'
import type { Scene } from './scene'

/** Сторона картинки молнии в пикселях: молния растягивается на всё здание. */
const BOLT_SIZE = 32
/** Сколько разных молний нарисовано заранее. */
const BOLTS = 6
/** Сколько раз в секунду молния меняется и какую долю этих кадров её видно. */
const BOLT_RATE = 14
const BOLT_SHOWN = 0.6
const BOLT_GLOW = 0x4f9dff
const BOLT_CORE = 0xf2fbff
/** Насколько молния выше основания здания, в тайлах: разряды бьют над крышей. */
const BOLT_RISE = 0.5

/** Сторона значка нехватки энергии в пикселях спрайта и в тайлах на экране. */
const ICON_SIZE = 16
const ICON_TILES = 0.75
/** Значок мигает: столько секунд длится цикл и такую его долю значок виден. */
const ICON_PERIOD = 1
const ICON_SHOWN = 0.7

/** Высота полоски прочности в пикселях экрана и её отступ от нижнего края здания в тайлах. */
const BAR_HEIGHT = 3
const BAR_GAP = 0.1

/** Простое воспроизводимое случайное число от 0 до 1 по двум целым. */
function noise(a: number, b: number) {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Рисует молнию: ломаная от края к краю картинки с короткой веткой, светлая сердцевина в синем ореоле. */
function drawBolt(index: number) {
  const image = new Pixmap(BOLT_SIZE, BOLT_SIZE)
  const points: number[] = []
  const JOINTS = 6
  // Молнии идут то сверху вниз, то наискось: начало и конец на разных краях.
  let x = 4 + noise(index, 1) * (BOLT_SIZE - 8)
  const endX = 4 + noise(index, 2) * (BOLT_SIZE - 8)
  for (let i = 0; i <= JOINTS; i++) {
    const along = i / JOINTS
    x += (endX - x) * along * 0.5 + (noise(index, 10 + i) - 0.5) * 12
    x = Math.max(2, Math.min(BOLT_SIZE - 3, x))
    points.push(Math.round(x), Math.round(2 + along * (BOLT_SIZE - 5)))
  }
  // Ветка от середины в сторону.
  const from = 2 * (1 + Math.floor(noise(index, 3) * (JOINTS - 2)))
  const side = noise(index, 4) < 0.5 ? -1 : 1
  const branch = [
    points[from], points[from + 1],
    points[from] + side * 5, points[from + 1] + 3,
    points[from] + side * 7, points[from + 1] + 8,
  ]
  for (const [line, width, color] of [[points, 3, BOLT_GLOW], [branch, 2, BOLT_GLOW], [points, 1, BOLT_CORE], [branch, 1, BOLT_CORE]] as const) {
    for (let i = 0; i + 3 < line.length; i += 2) image.line(line[i], line[i + 1], line[i + 2], line[i + 3], width, color)
  }
  return image
}

/** Рисует значок нехватки энергии: жёлтая молния на красном круге. */
function drawIcon() {
  const image = new Pixmap(ICON_SIZE, ICON_SIZE)
  image.circle(8, 8, 8, 0x0b111b)
  image.circle(8, 8, 7, 0xc8321f)
  image.circle(7.5, 7.5, 5.5, 0xe5492f)
  for (const [width, color] of [[3, 0x0b111b], [1, 0xffe066]] as const) {
    image.line(10, 3, 6, 8, width, color)
    image.line(6, 8, 10, 8, width, color)
    image.line(10, 8, 6, 13, width, color)
  }
  return image
}

type Color = readonly [number, number, number]
const BAR_BACK: Color = [0.03, 0.05, 0.08]
const BAR_GOOD: Color = [0.45, 0.9, 0.55]
const BAR_BAD: Color = [1, 0.35, 0.25]

/**
 * Проход нехватки энергии: молнии перегруза на электростанциях, значок над зданиями, которые из-за нехватки
 * работают медленнее, и полоска прочности под повреждёнными зданиями. Ставить выше освещения, чтобы ночью не темнело.
 */
export function createPowerPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const bolts = Array.from({ length: BOLTS }, (_, i) => drawBolt(i))
  const white = new Pixmap(4, 4).rect(0, 0, 4, 4, 0xffffff)
  const atlas = createAtlas(gl, [...bolts, drawIcon(), white])
  const boltFrames = atlas.frames.slice(0, BOLTS)
  const iconFrame = atlas.frames[BOLTS]
  const whiteFrame = atlas.frames[BOLTS + 1]
  const whiteU = whiteFrame.u + whiteFrame.width / 2
  const whiteV = whiteFrame.v + whiteFrame.height / 2

  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  // Кому не хватает энергии, пересчитывается раз в тик симуляции, а не каждый кадр.
  let states = new Map<Entity, PowerState>()
  let tick = -1

  return {
    draw({ camera, width, height, time, view }) {
      const { sim } = scene
      const { world } = sim
      if (sim.time.tick !== tick) {
        tick = sim.time.tick
        states = powerStates(sim)
      }
      const halfWidth = width / 2 / camera.zoom + 2
      const halfHeight = height / 2 / camera.zoom + 2
      const step = Math.floor(time * BOLT_RATE)
      const iconOn = (time % ICON_PERIOD) / ICON_PERIOD < ICON_SHOWN
      const barHeight = BAR_HEIGHT / camera.zoom

      sprites.clear()
      for (const [entity, position, building] of world.query(Position, Building)) {
        const spec = BUILDINGS[building.type]
        const x = position.x - camera.x
        const y = position.y - camera.y
        if (x + spec.width < -halfWidth || x > halfWidth || y + spec.height < -halfHeight || y > halfHeight) continue

        const state = states.get(entity)
        if (state === 'overload' && noise(step, entity) < BOLT_SHOWN) {
          const frame = boltFrames[Math.floor(noise(entity, step) * BOLTS)]
          // Каждая вторая молния отражена, чтобы шести картинок хватало надолго.
          const flip = noise(step + 7, entity) < 0.5
          sprites.push(
            x, y - BOLT_RISE, spec.width, spec.height + BOLT_RISE,
            flip ? frame.u + frame.width : frame.u, frame.v, flip ? -frame.width : frame.width, frame.height,
            1, 1, 1, 1,
          )
        }
        if (state === 'starved' && iconOn) {
          sprites.push(
            x + spec.width / 2 - ICON_TILES / 2, y - ICON_TILES / 2, ICON_TILES, ICON_TILES,
            iconFrame.u, iconFrame.v, iconFrame.width, iconFrame.height,
            1, 1, 1, 1,
          )
        }
        if (building.health < 1) {
          const [r, g, b] = building.health > 0.5 ? BAR_GOOD : BAR_BAD
          const top = y + spec.height + BAR_GAP
          sprites.push(x, top, spec.width, barHeight, whiteU, whiteV, 0, 0, ...BAR_BACK, 1)
          sprites.push(x, top, spec.width * Math.max(0, building.health), barHeight, whiteU, whiteV, 0, 0, r, g, b, 1)
        }
      }

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
