import { isOre, resourceOf, type Good } from '../sim'
import { GOOD_COLORS } from './resourceColors'

/**
 * Мини-иконки грузов для интерфейса: пиксельные маски 10×10, раскрашенные цветом груза. Знаки маски:
 * o — контур (самый тёмный тон, чтобы иконка читалась на тёмной панели), l — светлый тон, b — основной, d — тёмный, x — вкрапление цвета ресурса (у руды), точка — пусто.
 * Руда — серый ком с вкраплениями цвета своего ресурса: сразу видно, что это сырьё и для чего.
 */
const MASKS: Record<string, string[]> = {
  // Слиток.
  metal: [
    '..........',
    '..........',
    '..oooooo..',
    '..ollllo..',
    '.olbbbbdo.',
    '.obbbbbdo.',
    'obbbbbbddo',
    'oooooooooo',
    '..........',
    '..........',
  ],
  // Кристалл.
  silicon: [
    '....oo....',
    '...olbo...',
    '..olbbdo..',
    '..olbbdo..',
    '..olbbdo..',
    '..olbbdo..',
    '..olbbdo..',
    '...obdo...',
    '....oo....',
    '..........',
  ],
  // Канистра.
  fuel: [
    '..........',
    '...ooo....',
    '..oo.oooo.',
    '.olllllbo.',
    '.olbbbbdo.',
    '.olbddbdo.',
    '.olbbbbdo.',
    '.olbbbbdo.',
    '.oddddddo.',
    '.oooooooo.',
  ],
  // Гранёный камень.
  kharite: [
    '..........',
    '..oooooo..',
    '.olllbbbo.',
    'oolllbbddo',
    '.olbbbbdo.',
    '..olbbdo..',
    '...obdo...',
    '....oo....',
    '..........',
    '..........',
  ],
  // Кладка.
  blocks: [
    '..........',
    '..........',
    'oooooooooo',
    'olbbdolbbd',
    'oddddodddd',
    'oooooooooo',
    'olbdolbbdo',
    'oddoddddoo',
    'oooooooooo',
    '..........',
  ],
  // Два патрона.
  ammo: [
    '..o....o..',
    '.olo..olo.',
    '.olo..olo.',
    '.ooo..ooo.',
    '.olo..olo.',
    '.obo..obo.',
    '.obo..obo.',
    '.odo..odo.',
    '.ooo..ooo.',
    '..........',
  ],
  // Микросхема.
  parts: [
    '..........',
    '..o.o.o...',
    '.ooooooo..',
    'oolllllboo',
    '.olbbbbdo.',
    'oolbbbbdoo',
    '.oddddddo.',
    '.ooooooo..',
    '..o.o.o...',
    '..........',
  ],
  // Ком руды.
  ore: [
    '..........',
    '...oooo...',
    '..odbbdo..',
    '.odbxbbdo.',
    '.obbbbxbo.',
    'odbxbbbbdo',
    'obbbbxbbdo',
    'oddbbbddo.',
    '.oooooooo.',
    '..........',
  ],
}

const SIZE = 10
/** Камень руды: тона серо-бурого кома. */
const ROCK = 0x7a6f62

/** Цвет, сдвинутый к белому (amount > 0) или к чёрному (amount < 0). */
function shade(color: number, amount: number) {
  const channel = (shift: number) => {
    const value = (color >> shift) & 255
    return Math.round(amount > 0 ? value + (255 - value) * amount : value * (1 + amount))
  }
  return [channel(16), channel(8), channel(0)] as const
}

const cache = new Map<Good, string>()

/** Адрес картинки мини-иконки груза. Рисуется один раз. */
export function goodIcon(good: Good) {
  let url = cache.get(good)
  if (url) return url
  const ore = isOre(good)
  const base = ore ? ROCK : GOOD_COLORS[good]
  const tones: Record<string, readonly [number, number, number]> = {
    o: shade(base, -0.7),
    l: shade(base, 0.4),
    b: shade(base, 0),
    d: shade(base, -0.4),
    x: shade(ore ? GOOD_COLORS[resourceOf(good)] : base, 0.1),
  }
  const mask = MASKS[ore ? 'ore' : good]
  const image = new ImageData(SIZE, SIZE)
  mask.forEach((row, y) => {
    for (let x = 0; x < SIZE; x++) {
      const tone = tones[row[x]]
      if (!tone) continue
      const index = (y * SIZE + x) * 4
      image.data.set([...tone, 255], index)
    }
  })
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  canvas.getContext('2d')!.putImageData(image, 0, 0)
  cache.set(good, (url = canvas.toDataURL()))
  return url
}
