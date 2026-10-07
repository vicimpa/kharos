import { setBlend } from '../gl'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { Drop, GOODS, Inventory, Position, amountOf, loadOf, type Good } from '../sim'
import { GOOD_COLORS } from './resourceColors'
import type { Scene } from './scene'

/** Пикселей спрайта на тайл, как у местности. */
const ART_TILE = 16
const INK = 0x1c1712
/** Сколько ящиков в кучке: от одного до четырёх, по тому, сколько груза лежит. Ящик — на столько единиц. */
const CRATES = 4
const PER_CRATE = 15
/** Ящики кучки: левый верхний угол и сторона в пикселях спрайта; первые кладутся первыми. */
const SPOTS = [
  [4, 7, 7],
  [9, 3, 6],
  [1, 2, 5],
  [10, 10, 5],
] as const

/** Затемняет цвет: доля яркости от 0 до 1. */
const shade = (color: number, level: number) =>
  (Math.round(((color >> 16) & 255) * level) << 16) | (Math.round(((color >> 8) & 255) * level) << 8) | Math.round((color & 255) * level)

/** Кучка ящиков: деревянные короба с полосой цвета груза, count штук. */
function drawPile(good: Good, count: number) {
  const image = new Pixmap(ART_TILE, ART_TILE)
  const band = GOOD_COLORS[good]
  for (let i = 0; i < count; i++) {
    const [x, y, side] = SPOTS[i]
    image.rect(x, y, side, side, INK)
    image.rect(x + 1, y + 1, side - 2, side - 2, 0x7a5a36)
    image.rect(x + 1, y + 1, side - 2, 1, 0x9c7646)
    // Полоса груза поперёк ящика и её тень.
    const middle = y + Math.floor(side / 2)
    image.rect(x + 1, middle - 1, side - 2, 2, band)
    image.rect(x + 1, middle + 1, side - 2, 1, shade(band, 0.6))
  }
  return image
}

/**
 * Проход дропов: брошенный на землю груз — кучка ящиков цвета того груза, которого в ней больше всего. Чем больше
 * груза, тем больше ящиков. Ставить над покрытием и под зданиями.
 */
export function createDropsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const images = GOODS.flatMap((good) => Array.from({ length: CRATES }, (_, i) => drawPile(good, i + 1)))
  const atlas = createAtlas(gl, images)
  const frameOf = (good: Good, count: number) => atlas.frames[GOODS.indexOf(good) * CRATES + count - 1]
  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  return {
    draw({ camera, width, height, view }) {
      const halfWidth = width / 2 / camera.zoom + 1
      const halfHeight = height / 2 / camera.zoom + 1
      sprites.clear()
      for (const [, position, , inventory] of scene.sim.world.query(Position, Drop, Inventory)) {
        if (Math.abs(position.x - camera.x) > halfWidth || Math.abs(position.y - camera.y) > halfHeight) continue
        const load = loadOf(inventory)
        if (load <= 0) continue
        const main = GOODS.reduce((best, good) => (amountOf(inventory, good) > amountOf(inventory, best) ? good : best), GOODS[0])
        const count = Math.min(CRATES, Math.max(1, Math.ceil(load / PER_CRATE)))
        const frame = frameOf(main, count)
        sprites.push(position.x - camera.x, position.y - camera.y, 1, 1, frame.u, frame.v, frame.width, frame.height, 1, 1, 1, 1)
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
