import { setBlend } from '../../gl'
import { createAtlas, type AtlasFrame } from '../../render/atlas'
import { Pixmap } from '../../render/pixmap'
import type { Pass } from '../../render/renderer'
import { createSpriteProgram, createSprites } from '../../render/sprites'
import { BUILDING_TYPES, Building, Position, type BuildingType } from '../../sim'
import type { Scene } from '../scene'
import { ART_FRAMES, ART_TILE, BUILDING_ART, type BuildingArt } from './buildingArt'

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

/** Растеризует чертёж в кадры анимации и собирает его огни. */
function drawSheet(art: BuildingArt): Sheet {
  const images: Pixmap[] = []
  const lights: ArtLight[] = []
  for (let i = 0; i < ART_FRAMES; i++) {
    const image = new Pixmap(art.width * ART_TILE + PAD * 2, art.height * ART_TILE + PAD * 2)
    image.originX = image.originY = PAD
    let slot = 0
    art.draw(image, i / ART_FRAMES, (x, y, size, level) => {
      const light = (lights[slot++] ??= { x, y, size, levels: [] })
      light.levels[i] = level
    })
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
}

/** Проход зданий: тени, сами здания и их огни. Здания — сущности с Position и Building. */
export function createBuildingsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const sheets = new Map<BuildingType, Sheet>(BUILDING_TYPES.map((type) => [type, drawSheet(BUILDING_ART[type])]))
  const all = [...sheets.values()]
  const atlas = createAtlas(gl, all.flatMap((sheet) => sheet.images))
  all.forEach((sheet, i) => (sheet.frames = atlas.frames.slice(i * ART_FRAMES, (i + 1) * ART_FRAMES)))

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

      visible.length = 0
      for (const [, position, building] of scene.sim.world.query(Position, Building)) {
        const sheet = sheets.get(building.type)!
        if (position.x + sheet.art.width < camera.x - halfWidth || position.x > camera.x + halfWidth) continue
        if (position.y + sheet.art.height < camera.y - halfHeight || position.y > camera.y + halfHeight) continue
        visible.push({
          x: position.x,
          y: position.y,
          sheet,
          frame: (step + building.phase) % ART_FRAMES,
          bottom: position.y + sheet.art.height,
        })
      }
      if (!visible.length) return
      // Нижние здания рисуются позже и перекрывают верхние.
      visible.sort((a, b) => a.bottom - b.bottom)

      shadows.clear()
      sprites.clear()
      const pad = PAD / ART_TILE
      const shift = SHADOW_SHIFT / ART_TILE
      for (const { x, y, sheet, frame } of visible) {
        const { u, v, width: frameWidth, height: frameHeight } = sheet.frames[frame]
        const left = x - pad - camera.x
        const top = y - pad - camera.y
        const spriteWidth = sheet.art.width + pad * 2
        const spriteHeight = sheet.art.height + pad * 2
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

      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture })
      shadows.draw()
      sprites.draw()
    },
    drawOccluders({ view }) {
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
