import { knownReserve } from './knownReserve'
import { setBlend } from '../gl'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { DEPOSIT_CELL, DEPOSIT_SIZE, DEPOSIT_TYPES, depositsIn, type DepositKind } from '../sim'
import type { Scene } from './scene'

/** Пикселей спрайта на тайл, как у местности. */
const ART_TILE = 16
const INK = 0x2a1410
/** Тона породы каждого вида месторождения от тёмного к блику. */
const TONES: Record<DepositKind, readonly [number, number, number, number]> = {
  metal: [0x6b2f1e, 0xb5562e, 0xe58a4a, 0xffd9a0],
  silicon: [0x6e6856, 0xa9a184, 0xe0d9bc, 0xffffff],
  fuel: [0x0d0b10, 0x221d29, 0x3a3340, 0x8f86a8],
  kharite: [0x2e1247, 0x6a2fa8, 0xc06bff, 0xf3dcff],
}
/** Выработанное месторождение остаётся на карте бледным следом. */
const SPENT_ALPHA = 0.3

/** Глыбы породы: левый верхний угол, ширина и высота в пикселях спрайта. */
const CHUNKS = [
  [3, 5, 7, 5], [13, 2, 6, 4], [22, 6, 7, 6], [9, 11, 9, 7], [1, 15, 6, 5], [21, 16, 8, 6], [5, 23, 7, 5], [15, 22, 6, 6], [25, 25, 5, 4],
] as const
/** Рудная крошка между глыбами: по пикселю-двум. */
const CRUMBS = [
  [11, 8], [20, 3], [29, 14], [2, 11], [18, 19], [8, 20], [13, 29], [23, 23], [30, 21], [1, 27], [19, 13], [27, 2],
] as const

/** Топливо: тёмная лужа с радужным бликом и брызгами вокруг. */
function drawOil() {
  const image = new Pixmap(DEPOSIT_SIZE * ART_TILE, DEPOSIT_SIZE * ART_TILE)
  const tones = TONES.fuel
  for (const [x, y] of CRUMBS) image.rect(x, y, 2, 1, tones[1])
  image.circle(15, 16, 11, INK)
  image.circle(15, 16, 10, tones[0])
  image.circle(20, 21, 6, tones[0])
  image.circle(13, 14, 7, tones[1])
  image.rect(9, 11, 6, 1, tones[2])
  image.rect(10, 12, 3, 1, tones[3])
  image.rect(19, 19, 3, 1, 0x4a6a8a)
  return image
}

/** Рисует месторождение: угловатые глыбы породы с жилами и крошка вокруг; топливо — лужей. */
function drawDeposit(kind: DepositKind) {
  if (kind === 'fuel') return drawOil()
  const ORE = TONES[kind]
  const image = new Pixmap(DEPOSIT_SIZE * ART_TILE, DEPOSIT_SIZE * ART_TILE)
  for (const [x, y] of CRUMBS) image.rect(x, y, 2, 1, ORE[1])
  CHUNKS.forEach(([x, y, w, h], i) => {
    // Срезанные углы делают глыбу гранёной, а не квадратной.
    image.rect(x + 1, y, w - 2, h, INK)
    image.rect(x, y + 1, w, h - 2, INK)
    image.rect(x + 1, y + 1, w - 2, h - 2, ORE[0])
    image.rect(x + 1, y + 1, w - 3, h - 3, ORE[1])
    // Жила: светлая грань сверху слева и блик на каждой второй глыбе.
    image.rect(x + 1, y + 1, Math.ceil(w / 2), 1, ORE[2])
    image.rect(x + 1, y + 2, 1, Math.max(1, h - 4), ORE[2])
    if (i % 2 === 0) image.rect(x + 2, y + 2, 1, 1, ORE[3])
  })
  return image
}

/**
 * Проход месторождений. Месторождения, как и местность, считаются из сида, поэтому проход не обходит сущности,
 * а спрашивает клетки мира, попавшие на экран. Ставить сразу над местностью: шахта закрывает месторождение собой.
 */
export function createDepositsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const atlas = createAtlas(gl, DEPOSIT_TYPES.map(drawDeposit))
  const frames = new Map(DEPOSIT_TYPES.map((kind, i) => [kind, atlas.frames[i]]))
  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  return {
    draw({ camera, width, height, view }) {
      const { sim } = scene
      const halfWidth = width / 2 / camera.zoom
      const halfHeight = height / 2 / camera.zoom
      const left = Math.floor((camera.x - halfWidth - DEPOSIT_SIZE) / DEPOSIT_CELL)
      const right = Math.floor((camera.x + halfWidth) / DEPOSIT_CELL)
      const top = Math.floor((camera.y - halfHeight - DEPOSIT_SIZE) / DEPOSIT_CELL)
      const bottom = Math.floor((camera.y + halfHeight) / DEPOSIT_CELL)

      sprites.clear()
      for (let cellY = top; cellY <= bottom; cellY++) {
        for (let cellX = left; cellX <= right; cellX++) {
          for (const spot of depositsIn(sim, cellX, cellY)) {
            // Не найденное игроком не видно и сквозь туман.
            if (!sim.vision.exploredIn(scene.player, spot.x, spot.y, DEPOSIT_SIZE, DEPOSIT_SIZE)) continue
            const alpha = knownReserve(sim, scene.player, spot) === 0 ? SPENT_ALPHA : 1
            const frame = frames.get(spot.kind)!
            sprites.push(
              spot.x - camera.x, spot.y - camera.y, DEPOSIT_SIZE, DEPOSIT_SIZE,
              frame.u, frame.v, frame.width, frame.height,
              alpha, alpha, alpha, alpha,
            )
          }
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
