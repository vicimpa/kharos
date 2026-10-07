import { setBlend } from '../gl'
import { Terrain, terrainAt } from '../map/terrain'
import { createAtlas } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { Pave, type PaveKind, type Sim } from '../sim'
import type { Scene } from './scene'

/** Пикселей спрайта на тайл, как у местности. */
const ART_TILE = 16
/** Недостроенное и разбираемое покрытие просвечивает: видно, что над ним работают. */
const UNFINISHED_ALPHA = 0.45

/** Соседи тайла битами: сверху, справа, снизу, слева. Край рисуется там, где соседа нет. */
const UP = 1
const RIGHT = 2
const DOWN = 4
const LEFT = 8

/** Простое воспроизводимое случайное число от 0 до 1 по двум целым. */
function noise(a: number, b: number) {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Фундамент: бетонная плита со швами по краю и болтами по углам. Соседние плиты сливаются в площадку. */
function drawFoundation(mask: number) {
  const image = new Pixmap(ART_TILE, ART_TILE)
  image.rect(0, 0, ART_TILE, ART_TILE, 0x8d8a82)
  for (let i = 0; i < 18; i++) image.rect(Math.floor(noise(i, 1) * 16), Math.floor(noise(i, 2) * 16), 1, 1, noise(i, 3) < 0.5 ? 0x7d7a73 : 0x9c998f)
  // Шов между плитами — тонкий, край площадки — тёмный бордюр.
  const edge = (open: boolean) => (open ? 0x4f4c47 : 0x77746d)
  image.rect(0, 0, ART_TILE, 1, edge(!(mask & UP)))
  image.rect(0, ART_TILE - 1, ART_TILE, 1, edge(!(mask & DOWN)))
  image.rect(0, 0, 1, ART_TILE, edge(!(mask & LEFT)))
  image.rect(ART_TILE - 1, 0, 1, ART_TILE, edge(!(mask & RIGHT)))
  for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12]]) image.rect(x, y, 1, 1, 0x5d5a54)
  return image
}

/** Дорога: укатанное покрытие с зернистостью, по открытым сторонам — бордюр. */
function drawRoad(mask: number) {
  const image = new Pixmap(ART_TILE, ART_TILE)
  image.rect(0, 0, ART_TILE, ART_TILE, 0x45403b)
  for (let i = 0; i < 24; i++) image.rect(Math.floor(noise(i, 7) * 16), Math.floor(noise(i, 8) * 16), 1, 1, noise(i, 9) < 0.5 ? 0x3a3632 : 0x524c46)
  const curb = 0x8c8273
  if (!(mask & UP)) image.rect(0, 0, ART_TILE, 2, curb)
  if (!(mask & DOWN)) image.rect(0, ART_TILE - 2, ART_TILE, 2, curb)
  if (!(mask & LEFT)) image.rect(0, 0, 2, ART_TILE, curb)
  if (!(mask & RIGHT)) image.rect(ART_TILE - 2, 0, 2, ART_TILE, curb)
  return image
}

/** Мост: настил из досок поперёк хода на сваях, по открытым сторонам — перила. */
function drawBridge(mask: number) {
  const image = new Pixmap(ART_TILE, ART_TILE)
  const across = !(mask & (LEFT | RIGHT)) && !!(mask & (UP | DOWN))
  for (let i = 0; i < ART_TILE; i += 4) {
    const tone = i % 8 ? 0x6e4b2c : 0x7d5733
    if (across) image.rect(0, i, ART_TILE, 3, tone)
    else image.rect(i, 0, 3, ART_TILE, tone)
  }
  // Щели между досками.
  for (let i = 3; i < ART_TILE; i += 4) {
    if (across) image.rect(0, i, ART_TILE, 1, 0x3b2a1a)
    else image.rect(i, 0, 1, ART_TILE, 0x3b2a1a)
  }
  const rail = 0x2f2a26
  const post = 0x8f8a80
  if (!(mask & UP)) {
    image.rect(0, 0, ART_TILE, 2, rail)
    image.rect(1, 0, 2, 2, post)
    image.rect(ART_TILE - 3, 0, 2, 2, post)
  }
  if (!(mask & DOWN)) {
    image.rect(0, ART_TILE - 2, ART_TILE, 2, rail)
    image.rect(1, ART_TILE - 2, 2, 2, post)
    image.rect(ART_TILE - 3, ART_TILE - 2, 2, 2, post)
  }
  if (!(mask & LEFT)) {
    image.rect(0, 0, 2, ART_TILE, rail)
    image.rect(0, 1, 2, 2, post)
    image.rect(0, ART_TILE - 3, 2, 2, post)
  }
  if (!(mask & RIGHT)) {
    image.rect(ART_TILE - 2, 0, 2, ART_TILE, rail)
    image.rect(ART_TILE - 2, 1, 2, 2, post)
    image.rect(ART_TILE - 2, ART_TILE - 3, 2, 2, post)
  }
  return image
}

/** Картинки покрытия: на каждый вид — по одной на каждый набор соседей. */
const LOOKS = ['foundation', 'road', 'bridge'] as const
type Look = (typeof LOOKS)[number]
export const PAVE_ART: Record<Look, (mask: number) => Pixmap> = { foundation: drawFoundation, road: drawRoad, bridge: drawBridge }

/** Покрытие этого вида на тайле, готовое или нет. */
function kindAt(sim: Sim, x: number, y: number): PaveKind | undefined {
  const entity = sim.paving.at(x, y)
  return entity === undefined ? undefined : sim.world.get(entity, Pave)?.kind
}

/**
 * Проход покрытия: фундамент, дороги и мосты. Покрытие лежит на земле — ставить сразу над месторождениями,
 * под следами и зданиями. Дорога по болоту рисуется мостом. Обходит не сущности, а тайлы на экране.
 */
export function createPavingPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const images = LOOKS.flatMap((look) => Array.from({ length: 16 }, (_, mask) => PAVE_ART[look](mask)))
  const atlas = createAtlas(gl, images)
  const frameOf = (look: Look, mask: number) => atlas.frames[LOOKS.indexOf(look) * 16 + mask]
  const program = createSpriteProgram(gl)
  const sprites = createSprites(gl, program)

  return {
    draw({ camera, width, height, view }) {
      const { sim } = scene
      const halfWidth = width / 2 / camera.zoom
      const halfHeight = height / 2 / camera.zoom
      const left = Math.floor(camera.x - halfWidth)
      const right = Math.ceil(camera.x + halfWidth)
      const top = Math.floor(camera.y - halfHeight)
      const bottom = Math.ceil(camera.y + halfHeight)

      sprites.clear()
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const entity = sim.paving.at(x, y)
          if (entity === undefined) continue
          const pave = sim.world.get(entity, Pave)
          if (!pave) continue
          const same = (dx: number, dy: number) => kindAt(sim, x + dx, y + dy) === pave.kind
          const mask = (same(0, -1) ? UP : 0) | (same(1, 0) ? RIGHT : 0) | (same(0, 1) ? DOWN : 0) | (same(-1, 0) ? LEFT : 0)
          const look: Look = pave.kind === 'foundation' ? 'foundation' : terrainAt(sim.land, x, y) === Terrain.Swamp ? 'bridge' : 'road'
          const frame = frameOf(look, mask)
          const alpha = pave.done && !pave.remove ? 1 : UNFINISHED_ALPHA
          sprites.push(x - camera.x, y - camera.y, 1, 1, frame.u, frame.v, frame.width, frame.height, alpha, alpha, alpha, alpha)
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
