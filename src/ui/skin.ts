/**
 * Пиксельный скин интерфейса: рамки панелей, утопленные окна, кнопки и монета рисуются кодом — как здания и юниты,
 * теми же тонами, — и отдаются стилям как картинки через CSS-переменные (--skin-*). Рамки — девятичастные:
 * SIZE×SIZE пикселей, углы по CORNER пикселей, в стилях каждый пиксель скина — SCALE пикселей экрана
 * (border-image: var(--skin-panel) 4 fill / 8px).
 */

const SIZE = 12
/** Сторона угла девятичастной рамки в пикселях скина: столько отрезает border-image-slice. */
export const CORNER = 4

/** Те же тона, что у построек: чернила, сталь от тёмной к светлой, огни команды, золото кредитов. */
const INK = '#0b111b'
const STEEL = ['#1c2b3e', '#2d4560', '#41617f', '#6184a3', '#9bb9d1'] as const
const DEEP = '#0e1825'
const WELL = '#070d15'
const TEAM = ['#10358f', '#1f63d8', '#5aa9ff', '#e4f4ff'] as const
const GOLD = ['#5a3d0c', '#c9962b', '#f0c95a', '#fff1b8'] as const
const RED = ['#4a1410', '#a8382a', '#ff6b5a'] as const

type Paint = (x: number, y: number, width: number, height: number, color: string) => void

function image(width: number, height: number, draw: (paint: Paint) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  draw((x, y, w, h, color) => {
    context.fillStyle = color
    context.fillRect(x, y, w, h)
  })
  return `url(${canvas.toDataURL()})`
}

/**
 * Рамка со срезанными углами: обводка чернилами, фаска (светлая сверху и слева, тёмная снизу и справа; у утопленной —
 * наоборот) и заливка. rivets — заклёпки в углах, как на корпусах зданий.
 */
function frame({ fill, light, dark, edge = INK, rivets }: { fill: string; light: string; dark: string; edge?: string; rivets?: string }) {
  return image(SIZE, SIZE, (paint) => {
    const last = SIZE - 1
    // Обводка без угловых пикселей: углы срезаны.
    paint(1, 0, SIZE - 2, 1, edge)
    paint(1, last, SIZE - 2, 1, edge)
    paint(0, 1, 1, SIZE - 2, edge)
    paint(last, 1, 1, SIZE - 2, edge)
    paint(1, 1, SIZE - 2, SIZE - 2, fill)
    // Фаска.
    paint(1, 1, SIZE - 2, 1, light)
    paint(1, 2, 1, SIZE - 3, light)
    paint(1, last - 1, SIZE - 2, 1, dark)
    paint(last - 1, 1, 1, SIZE - 2, dark)
    if (rivets) for (const [x, y] of [[2, 2], [last - 2, 2], [2, last - 2], [last - 2, last - 2]]) paint(x, y, 1, 1, rivets)
  })
}

/** Монета кредитов 8×8: золотой кружок с бликом и тенью. */
const coin = () =>
  image(8, 8, (paint) => {
    paint(2, 0, 4, 1, GOLD[0])
    paint(2, 7, 4, 1, GOLD[0])
    paint(0, 2, 1, 4, GOLD[0])
    paint(7, 2, 1, 4, GOLD[0])
    paint(1, 1, 1, 1, GOLD[0])
    paint(6, 1, 1, 1, GOLD[0])
    paint(1, 6, 1, 1, GOLD[0])
    paint(6, 6, 1, 1, GOLD[0])
    paint(1, 2, 6, 4, GOLD[2])
    paint(2, 1, 4, 6, GOLD[2])
    paint(5, 2, 1, 4, GOLD[1])
    paint(2, 5, 4, 1, GOLD[1])
    paint(2, 2, 2, 1, GOLD[3])
    paint(2, 3, 1, 1, GOLD[3])
  })

/** Рисует скин и выставляет его переменными на корневом элементе. Вызывать один раз до первого кадра интерфейса. */
export function installSkin() {
  const skins: Record<string, string> = {
    // Панели: тёмная сталь с заклёпками.
    panel: frame({ fill: DEEP, light: STEEL[2], dark: INK, rivets: STEEL[3] }),
    // Утопленное окно: мини-карта, портрет, сведения, полоски.
    well: frame({ fill: WELL, light: INK, dark: STEEL[1], edge: STEEL[0] }),
    // Кнопки: выпуклая, наведённая, нажатая или выбранная (огни команды), недоступная.
    button: frame({ fill: STEEL[1], light: STEEL[3], dark: STEEL[0] }),
    'button-hover': frame({ fill: STEEL[2], light: STEEL[4], dark: STEEL[0] }),
    'button-active': frame({ fill: TEAM[0], light: INK, dark: TEAM[2], edge: TEAM[2] }),
    'button-disabled': frame({ fill: STEEL[0], light: STEEL[1], dark: INK }),
    // Награды и важное — золотая рамка; опасное — красная.
    gold: frame({ fill: DEEP, light: GOLD[2], dark: GOLD[0], edge: GOLD[0], rivets: GOLD[3] }),
    danger: frame({ fill: RED[0], light: RED[2], dark: INK, rivets: RED[2] }),
    coin: coin(),
  }
  const root = document.documentElement.style
  for (const [name, url] of Object.entries(skins)) root.setProperty(`--skin-${name}`, url)
}
