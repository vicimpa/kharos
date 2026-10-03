import { createTexture, type Texture } from '../gl'
import type { Pixmap } from './pixmap'

/** Место картинки в атласе, в долях текстуры: левый верхний угол и размер. */
export interface AtlasFrame {
  u: number
  v: number
  width: number
  height: number
}

/** Ширина атласа не меньше этой и не больше той, что берут все видеокарты. */
const MIN_WIDTH = 1024
const MAX_WIDTH = 4096

/**
 * Складывает картинки в одну текстуру, чтобы все спрайты рисовались одним вызовом.
 * Картинки ставятся в ряд слева направо; когда ряд кончается, начинается следующий.
 * Кладите картинки близкой высоты подряд — тогда в рядах не остаётся пустот. Ширина — степень двойки: атлас
 * растёт вширь, пока он выше, чем шире, иначе много кадров вытянули бы его за предел высоты текстуры.
 */
export function createAtlas(gl: WebGL2RenderingContext, images: Pixmap[]): { texture: Texture; frames: AtlasFrame[] } {
  const area = images.reduce((sum, image) => sum + image.width * image.height, 0)
  let atlasWidth = MIN_WIDTH
  while (atlasWidth < MAX_WIDTH && area > atlasWidth * atlasWidth) atlasWidth *= 2
  const places: { x: number; y: number }[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const image of images) {
    if (image.width > atlasWidth) throw new Error(`Картинка шире атласа: ${image.width} > ${atlasWidth}`)
    if (x + image.width > atlasWidth) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    places.push({ x, y })
    x += image.width
    rowHeight = Math.max(rowHeight, image.height)
  }
  const height = Math.max(1, y + rowHeight)

  const texture = createTexture(gl, { width: atlasWidth, height })
  // Пустые места атласа должны быть прозрачными, а не случайными.
  texture.write(new Uint8Array(atlasWidth * height * 4))
  const frames = images.map((image, i) => {
    const place = places[i]
    texture.write(image.data, place.x, place.y, image.width, image.height)
    return { u: place.x / atlasWidth, v: place.y / height, width: image.width / atlasWidth, height: image.height / height }
  })
  return { texture, frames }
}
