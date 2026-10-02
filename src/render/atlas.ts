import { createTexture, type Texture } from '../gl'
import type { Pixmap } from './pixmap'

/** Место картинки в атласе, в долях текстуры: левый верхний угол и размер. */
export interface AtlasFrame {
  u: number
  v: number
  width: number
  height: number
}

const ATLAS_WIDTH = 1024

/**
 * Складывает картинки в одну текстуру, чтобы все спрайты рисовались одним вызовом.
 * Картинки ставятся в ряд слева направо; когда ряд кончается, начинается следующий.
 * Кладите картинки близкой высоты подряд — тогда в рядах не остаётся пустот.
 */
export function createAtlas(gl: WebGL2RenderingContext, images: Pixmap[]): { texture: Texture; frames: AtlasFrame[] } {
  const places: { x: number; y: number }[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const image of images) {
    if (image.width > ATLAS_WIDTH) throw new Error(`Картинка шире атласа: ${image.width} > ${ATLAS_WIDTH}`)
    if (x + image.width > ATLAS_WIDTH) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    places.push({ x, y })
    x += image.width
    rowHeight = Math.max(rowHeight, image.height)
  }
  const height = Math.max(1, y + rowHeight)

  const texture = createTexture(gl, { width: ATLAS_WIDTH, height })
  // Пустые места атласа должны быть прозрачными, а не случайными.
  texture.write(new Uint8Array(ATLAS_WIDTH * height * 4))
  const frames = images.map((image, i) => {
    const place = places[i]
    texture.write(image.data, place.x, place.y, image.width, image.height)
    return { u: place.x / ATLAS_WIDTH, v: place.y / height, width: image.width / ATLAS_WIDTH, height: image.height / height }
  })
  return { texture, frames }
}
