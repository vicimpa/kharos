import type { Pixmap } from '../../render/pixmap'
import { BUILDINGS, type BuildingType } from '../../sim/buildings'
import { GOOD_COLORS } from '../resourceColors'


/**
 * Векторные чертежи зданий. Рисуются на Pixmap в пикселях будущего спрайта: ART_TILE пикселей на тайл,
 * как у местности. Начало координат — левый верхний угол основания; высокие части уходят в y < 0.
 * Растеризация без сглаживания превращает чертёж в пиксель-арт (см. render/pixmap.ts).
 */

export const ART_TILE = 16
/** Кадров в цикле анимации. Чертёж получает фазу цикла t от 0 до 1 и обязан замыкаться при t = 1. */
export const ART_FRAMES = 16

export interface BuildingArt {
  /** Сколько тайлов здание занимает на земле. */
  width: number
  height: number
  /** Число вариантов соседства; без поля у здания один общий вид. */
  variants?: number
  /**
   * У здания два вида анимации: в простое (лампы мигают, механизмы стоят) и в работе (working). Без поля — один вид.
   * Работает ли здание, решает проход зданий по тому, что происходит с его складом.
   */
  working?: boolean
  /** light сообщает об огнях кадра; их число и порядок не должны зависеть ни от t, ни от working. */
  draw(g: Pixmap, t: number, light: EmitLight, variant?: number, working?: boolean): void
}

/** Огонь в точке (x, y) чертежа: size — радиус лампы в пикселях, level — яркость от 0 до 1. */
export type EmitLight = (x: number, y: number, size: number, level: number) => void

/** Тона от тёмного к светлому. Свет падает слева сверху. */
type Tones = readonly [number, number, number, number, number]

const INK = 0x0b111b
const STEEL: Tones = [0x1c2b3e, 0x2d4560, 0x41617f, 0x6184a3, 0x9bb9d1]
const IRON: Tones = [0x1e2024, 0x3a3d43, 0x5b5f66, 0x8b9097, 0xc3c7cc]
const RUST = [0x5e2f24, 0x9a523a, 0xc47a57] as const
/** Цвет команды: от погашенного огня к горящему. */
const TEAM = [0x10358f, 0x1f63d8, 0x5aa9ff, 0xe4f4ff] as const

const TURN = Math.PI * 2
const DARK = 0x04070b

/** Плавное мигание: 1 при t = offset, 0 через полцикла. */
const pulse = (t: number, offset = 0) => 0.5 + 0.5 * Math.cos(TURN * (t - offset))
/** Бегущий огонь: вспыхивает при t = offset и быстро гаснет. */
const chase = (t: number, offset: number) => Math.max(0, 1 - (((t - offset) % 1) + 1) % 1 * 3)
const teamColor = (level: number) => TEAM[Math.min(TEAM.length - 1, Math.floor(level * TEAM.length))]

/** Плита с обводкой, фаской и передней стенкой высотой wall. Размер h — вместе со стенкой. */
function slab(g: Pixmap, x: number, y: number, w: number, h: number, wall: number, tones: Tones) {
  const top = h - wall - 2
  g.rect(x, y, w, h, INK)
  g.rect(x + 1, y + 1, w - 2, top, tones[1])
  g.rect(x + 1, y + 1, w - 2, 1, tones[3])
  g.rect(x + 1, y + 2, 1, top - 1, tones[2])
  g.rect(x + w - 2, y + 2, 1, top - 1, tones[0])
  g.rect(x + 1, y + 1 + top, w - 2, wall, tones[0])
}

/** Купол: тон светлеет к левому верхнему краю. */
function dome(g: Pixmap, cx: number, cy: number, r: number, tones: Tones) {
  g.circle(cx, cy, r + 1, INK)
  g.circle(cx, cy, r, tones[0])
  g.circle(cx - r * 0.12, cy - r * 0.12, r * 0.82, tones[1])
  g.circle(cx - r * 0.28, cy - r * 0.28, r * 0.52, tones[2])
  if (r >= 4) g.circle(cx - r * 0.42, cy - r * 0.42, r * 0.2, tones[3])
}

/** Круглая башня: основание в (cx, cy), купол поднят на height. */
function tower(g: Pixmap, cx: number, cy: number, r: number, height: number, tones: Tones) {
  g.circle(cx, cy, r + 1, INK)
  g.rect(cx - r - 1, cy - height, r * 2 + 2, height, INK)
  g.circle(cx, cy, r, tones[0])
  g.rect(cx - r, cy - height, r * 2, height, tones[0])
  g.rect(cx - r + 1, cy - height, Math.max(1, Math.floor(r / 2)), height + 1, tones[1])
  dome(g, cx, cy - height, r, tones)
}

/** Круглая лампа цвета команды; светит на землю. */
function lamp(g: Pixmap, light: EmitLight, cx: number, cy: number, r: number, level: number) {
  light(cx, cy, r, level)
  g.circle(cx, cy, r + 1, INK)
  g.circle(cx, cy, r, teamColor(level * 0.74))
  g.circle(cx - r * 0.3, cy - r * 0.3, r * 0.5, teamColor(0.26 + level * 0.74))
}

/** Огонёк 2×2 с левым верхним углом в (x, y). */
function bulb(g: Pixmap, light: EmitLight, x: number, y: number, level: number) {
  g.rect(x, y, 2, 2, teamColor(level))
  light(x + 1, y + 1, 1, level)
}

/** Генератор: реактор под куполом с бегущим кольцом огней и два бака с подачей по трубам. */
const generator: BuildingArt = {
  ...BUILDINGS.generator,
  draw(g, t, light) {
    slab(g, 0, 1, 32, 31, 3, STEEL)
    g.rect(3, 4, 26, 22, STEEL[0])
    g.rect(4, 5, 25, 21, STEEL[1])
    g.rect(4, 27, 7, 1, RUST[1])
    g.rect(21, 27, 7, 1, RUST[1])

    // Трубы от баков к реактору; по ним бежит порция топлива.
    const step = Math.floor(t * ART_FRAMES) % 8
    for (const y of [8, 20]) {
      g.rect(8, y - 1, 10, 3, INK)
      g.rect(8, y, 10, 1, RUST[1])
      g.rect(9 + step, y, 2, 1, TEAM[3])
      tower(g, 6, y + 1, 3, 2, IRON)
    }

    tower(g, 21, 17, 9, 4, STEEL)
    const LIGHTS = 6
    for (let i = 0; i < LIGHTS; i++) {
      const angle = (i / LIGHTS) * TURN
      const x = Math.round(21 + Math.cos(angle) * 6.5)
      const y = Math.round(13 + Math.sin(angle) * 6.5)
      bulb(g, light, x - 1, y - 1, chase(t, i / LIGHTS))
    }
    lamp(g, light, 21, 13, 3, pulse(t * 2))
  },
}

/**
 * Машинный завод, 3×3: сборочный цех под ребристой крышей с мостовым краном, ворота на юг и двор с пандусом,
 * где стоит выкаченная машина. Вентилятор на крыше крутится, огни над воротами бегут.
 */
const factory: BuildingArt = {
  ...BUILDINGS.factory,
  draw(g, t, light) {
    slab(g, 0, 2, 48, 46, 3, STEEL)

    // Двор: бетон с разметкой и пандус от ворот.
    g.rect(3, 30, 42, 14, IRON[1])
    g.rect(3, 30, 42, 1, IRON[0])
    for (let x = 5; x < 44; x += 6) g.rect(x, 42, 3, 1, HAZARD[1])
    g.rect(16, 30, 16, 12, IRON[0])
    for (let y = 32; y < 42; y += 3) g.rect(17, y, 14, 1, IRON[2])
    // Выкаченная машина на пандусе: корпус, гусеницы, башня.
    g.rect(19, 33, 10, 8, INK)
    g.rect(19, 33, 2, 8, IRON[0])
    g.rect(27, 33, 2, 8, IRON[0])
    g.rect(21, 34, 6, 6, TEAM[1])
    g.rect(21, 34, 6, 1, TEAM[2])
    g.circle(24, 37, 2, STEEL[3])
    g.rect(24, 31, 1, 4, INK)

    // Цех: длинный корпус с рёбрами крыши, по которой ездит кран.
    slab(g, 2, 0, 44, 30, 4, IRON)
    for (let x = 5; x <= 41; x += 4) {
      g.rect(x, 2, 1, 22, IRON[0])
      g.rect(x + 1, 2, 1, 22, IRON[2])
    }
    // Мостовой кран: балка поперёк цеха ходит вдоль него туда и обратно.
    const crane = Math.round(8 + 28 * (0.5 - 0.5 * Math.cos(TURN * t)))
    g.rect(crane - 1, 2, 4, 22, INK)
    g.rect(crane, 2, 2, 22, HAZARD[1])
    g.rect(crane - 1, 11, 4, 4, IRON[3])
    // Ворота в торце цеха.
    g.rect(16, 23, 16, 7, INK)
    g.rect(17, 24, 14, 6, DARK)
    for (let i = 0; i < 7; i++) g.rect(17 + i * 2, 22, 2, 1, teamColor(chase(t, i / 7)))

    // Вентилятор на крыше: у крыльчатки четыре лопасти, четверть оборота замыкает цикл.
    g.circle(39, 8, 5, INK)
    g.circle(39, 8, 4, IRON[0])
    const angle = t * TURN * 0.25
    for (const turn of [angle, angle + TURN / 4]) {
      const dx = Math.cos(turn) * 3.5
      const dy = Math.sin(turn) * 3.5
      g.line(39 - dx, 8 - dy, 39 + dx, 8 + dy, 1.2, IRON[3])
    }
    lamp(g, light, 7, 36, 2, pulse(t))
    lamp(g, light, 41, 36, 2, pulse(t, 0.5))
  },
}

/** Материя, которую выдаёт генератор: слитки цвета кредитов. */
const GOLD = [0xc9962b, 0xf0c95a, 0xfff0b0] as const

/**
 * Генератор материи: камера синтеза с пульсирующим ядром в кольце огней, катушки по углам
 * и короткая лента, по которой готовый слиток уезжает в приёмный люк.
 */
const matter: BuildingArt = {
  ...BUILDINGS.matter,
  draw(g, t, light) {
    slab(g, 0, 1, 32, 31, 3, STEEL)

    // Лента от камеры к люку у нижнего края: за цикл по ней проезжает один слиток.
    g.rect(10, 18, 12, 10, INK)
    g.rect(11, 19, 10, 8, IRON[0])
    for (let y = 20; y < 27; y += 2) g.rect(11, y, 10, 1, IRON[1])
    const y = 17 + Math.floor(t * ART_FRAMES) % 8
    g.rect(13, y, 6, 3, INK)
    g.rect(13, y, 6, 2, GOLD[1])
    g.rect(13, y, 3, 1, GOLD[2])
    g.rect(13, y + 2, 6, 1, GOLD[0])
    g.rect(9, 25, 14, 4, INK)
    g.rect(10, 26, 12, 2, DARK)
    g.rect(10, 26, 12, 1, RUST[1])

    // Камера синтеза выше двора и выступает над основанием.
    slab(g, 3, -5, 26, 26, 5, IRON)
    g.circle(16, 6, 10, INK)
    g.circle(16, 6, 9, DARK)
    g.ring(16, 6, 8, 1.5, STEEL[2])
    // Огни кольца бегут навстречу друг другу к ядру: энергия стекается внутрь.
    const LIGHTS = 8
    for (let i = 0; i < LIGHTS; i++) {
      const angle = (i / LIGHTS) * TURN
      const x = Math.round(16 + Math.cos(angle) * 8)
      const lightY = Math.round(6 + Math.sin(angle) * 8)
      bulb(g, light, x - 1, lightY - 1, chase(t * 2, (i % 4) / 4))
    }
    // Ядро: золотое, когда материя готова, и гаснет к следующей порции.
    const glow = pulse(t * 2)
    lamp(g, light, 16, 6, 4, 0.35 + glow * 0.65)
    g.circle(16, 6, 2, GOLD[glow > 0.5 ? 1 : 0])
    if (glow > 0.8) g.rect(15, 5, 1, 1, GOLD[2])

    // Катушки по нижним углам.
    for (const [x, offset] of [[4, 0], [28, 0.5]]) {
      tower(g, x, 26, 2, 4, STEEL)
      bulb(g, light, x - 1, 20, pulse(t * 2, offset))
    }
  },
}

/** Труба с обводкой: горизонтальная, длиной w, осью по строке y. */
function pipe(g: Pixmap, x: number, y: number, w: number) {
  g.rect(x, y - 1, w, 3, INK)
  g.rect(x, y, w, 1, RUST[1])
}

/** Окна цвета команды в ряд: каждое 3×2 с бликом. */
function windows(g: Pixmap, xs: number[], y: number) {
  for (const x of xs) {
    g.rect(x, y, 3, 2, TEAM[1])
    g.rect(x, y, 1, 1, TEAM[2])
  }
}

/** Штаб: двухъярусная цитадель с куполом-маяком, угловыми башенками и мачтой связи. */
const command: BuildingArt = {
  ...BUILDINGS.command,
  draw(g, t, light) {
    slab(g, 0, 2, 48, 46, 3, STEEL)
    g.rect(18, 36, 12, 1, RUST[1])
    g.rect(18, 40, 12, 1, RUST[1])
    g.rect(18, 36, 1, 5, RUST[1])
    g.rect(29, 36, 1, 5, RUST[1])
    for (const [x, offset] of [[5, 0.25], [43, 0.75]]) {
      tower(g, x, 40, 3, 3, IRON)
      bulb(g, light, x - 1, 36, pulse(t, offset))
    }

    slab(g, 6, -2, 36, 36, 8, IRON)
    g.rect(20, 25, 8, 8, INK)
    g.rect(21, 26, 6, 7, DARK)
    windows(g, [9, 14, 31, 36], 27)
    for (let i = 0; i < 4; i++) bulb(g, light, 20 + i * 2, 22, chase(t, i / 4))

    slab(g, 12, -8, 24, 24, 5, STEEL)
    windows(g, [14, 19, 26, 31], 11)
    tower(g, 24, 3, 7, 3, STEEL)
    lamp(g, light, 24, 0, 3, pulse(t))

    tower(g, 38, 20, 2, 7, IRON)
    bulb(g, light, 37, 12, chase(t * 2, 0))
  },
}

/** Три тона цвета: тёмный, основной, светлый — для окраски частей здания цветом его груза. */
function accent(color: number) {
  const mix = (amount: number) => {
    const channel = (shift: number) => {
      const value = (color >> shift) & 255
      return Math.round(amount > 0 ? value + (255 - value) * amount : value * (1 + amount)) << shift
    }
    return channel(16) | channel(8) | channel(0)
  }
  return [mix(-0.55), mix(-0.15), mix(0.3)] as const
}

/** Огонь печи: от тёмно-красного к белому. */
const FIRE = [0x6a1a10, 0xc2401a, 0xf08a2a, 0xffd36a, 0xfff4d0] as const
const fireColor = (level: number) => FIRE[Math.min(FIRE.length - 1, Math.max(0, Math.floor(level * FIRE.length)))]
/** Жёлто-чёрные полосы опасности. */
const HAZARD = [0x1a1608, 0xd9b021] as const
/** Огнеупорный кирпич печей. */
const BRICK: Tones = [0x2a1a16, RUST[0], RUST[1], RUST[2], 0xe0a080]
/** Электрическая дуга: от синего к белому. */
const ARC = [0x2f5fd0, 0x8fc0ff, 0xf2f8ff] as const

/** Воспроизводимое случайное число от 0 до 1 по двум целым: дуги и пузыри скачут, но кадры одинаковы при каждой сборке. */
function hash(a: number, b: number) {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Переработки у каждой руды свои, и силуэты у них нарочно непохожие: какую руду завод берёт, видно издалека,
 * а не только по цвету. Цвет ресурса — у того, что завод выдаёт. В простое горят только сигнальные лампы,
 * печь тлеет, механизмы стоят; в работе всё движется и светит.
 */

/**
 * Плавильня, 3×3: открытая ванна жидкого металла — сверху видно раскалённое зеркало с коркой шлака, — жёлоб из неё
 * на конвейер изложниц, где слитки остывают, и штабель готовых слитков.
 */
const smelter: BuildingArt = {
  ...BUILDINGS.smelter,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.metal)
    const frame = Math.floor(t * ART_FRAMES)
    slab(g, 0, 2, 48, 46, 3, IRON)
    g.rect(2, 4, 44, 1, RUST[0])

    // Ванна: кирпичное кольцо, внутри металл. В работе он ярко светится и по нему плывёт шлак; в простое — остывшая корка.
    const cx = 16
    const cy = 18
    g.circle(cx, cy, 14, INK)
    g.circle(cx, cy, 13, BRICK[1])
    g.circle(cx - 1, cy - 1, 12, BRICK[2])
    g.circle(cx, cy, 10, INK)
    g.circle(cx, cy, 9, working ? fireColor(0.55) : fireColor(0.05))
    g.circle(cx - 1, cy - 1, 7, working ? fireColor(0.75) : 0x3a2a26)
    g.circle(cx - 2, cy - 2, 4, working ? fireColor(0.95) : 0x4a3530)
    for (let i = 0; i < 5; i++) {
      // Корка шлака: в работе кружит по зеркалу, в простое лежит и чуть тлеет трещинами.
      const angle = TURN * ((working ? t : 0) + i / 5)
      const reach = 4 + hash(i, 1) * 4
      const x = Math.round(cx + Math.cos(angle) * reach)
      const y = Math.round(cy + Math.sin(angle) * reach)
      g.rect(x, y, 2, 1, working ? FIRE[1] : fireColor(0.25 + 0.15 * pulse(t, i / 5)))
    }
    if (working) {
      // Пузырь лопается в случайном месте каждые пару кадров.
      const bubble = Math.floor(frame / 2)
      g.rect(Math.round(cx - 5 + hash(bubble, 7) * 10), Math.round(cy - 5 + hash(bubble, 9) * 10), 1, 1, FIRE[4])
    }
    light(cx, cy, 8, working ? 0.8 + 0.2 * pulse(t * 2) : 0.15)

    // Жёлоб из ванны вправо, на конвейер.
    g.rect(29, 15, 7, 4, INK)
    g.rect(29, 16, 7, 2, working ? fireColor(0.7 + 0.25 * pulse(t * 4)) : BRICK[0])

    // Конвейер изложниц вдоль правого края: формы едут вниз, металл в них остывает от огня к цвету металла.
    g.rect(35, 5, 10, 38, INK)
    g.rect(36, 6, 8, 36, IRON[0])
    const shift = working ? frame % 6 : 0
    for (let k = 0; k < 7; k++) {
      const y = 6 + k * 6 + shift - 6
      if (y < 6 || y > 38) continue
      g.rect(37, y, 6, 4, IRON[2])
      g.rect(38, y + 1, 4, 2, k < 2 && working ? fireColor(0.9 - k * 0.3) : k < 4 && working ? FIRE[1] : tint[1])
      g.rect(38, y + 1, 4, 1, k < 2 && working ? FIRE[4] : tint[2])
    }

    // Штабель готовых слитков внизу слева.
    for (const [x, y] of [[4, 38], [11, 38], [18, 38], [7, 35], [14, 35], [10, 32]] as const) {
      g.rect(x, y, 7, 4, INK)
      g.rect(x + 1, y + 1, 5, 2, tint[1])
      g.rect(x + 1, y + 1, 5, 1, tint[2])
    }
    lamp(g, light, 29, 40, 2, pulse(t))
  },
}

/**
 * Кремниевый завод, 3×2: дуговая печь — три электрода в тигле, между ними трещат разряды, — две камеры, где
 * из расплава тянут кристаллы, и стопки готовых пластин.
 */
const siliconWorks: BuildingArt = {
  ...BUILDINGS.siliconWorks,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.silicon)
    const frame = Math.floor(t * ART_FRAMES)
    const WHITE: Tones = [0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff]
    slab(g, 0, 2, 48, 30, 3, WHITE)

    // Тигель печи с расплавом.
    const cx = 14
    const cy = 15
    g.circle(cx, cy, 12, INK)
    g.circle(cx, cy, 11, IRON[1])
    g.circle(cx - 1, cy - 1, 10, IRON[2])
    g.circle(cx, cy, 8, INK)
    // Расплав кварца рыжий от жара: на нём голубые дуги видны, а цвет кремния — у кристаллов и пластин.
    g.circle(cx, cy, 7, working ? fireColor(0.45) : 0x262a30)
    g.circle(cx - 1, cy - 1, 4, working ? fireColor(0.7) : 0x30353c)
    // Три электрода треугольником; в работе между ними и к расплаву бьют дуги, каждые два кадра — новые.
    const electrodes = [0, 1, 2].map((i) => {
      const angle = TURN * (i / 3) - TURN / 4
      return [Math.round(cx + Math.cos(angle) * 5), Math.round(cy + Math.sin(angle) * 5)] as const
    })
    if (working) {
      const beat = Math.floor(frame / 2)
      for (let i = 0; i < 3; i++) {
        const [x0, y0] = electrodes[i]
        const [x1, y1] = electrodes[(i + 1) % 3]
        const bend = (hash(beat, i) - 0.5) * 4
        const mx = (x0 + x1) / 2 + (cx - (x0 + x1) / 2) * 0.3 + bend
        const my = (y0 + y1) / 2 + (cy - (y0 + y1) / 2) * 0.3 - bend
        g.line(x0, y0, mx, my, 1.5, hash(beat, i + 5) > 0.3 ? ARC[2] : ARC[1])
        g.line(mx, my, x1, y1, 1.5, ARC[2])
        g.rect(Math.round(mx), Math.round(my), 1, 1, ARC[2])
      }
    }
    for (const [x, y] of electrodes) {
      g.circle(x, y, 2, INK)
      g.circle(x, y, 1.5, working ? ARC[1] : IRON[4])
    }
    light(cx, cy, 6, working ? 0.6 + 0.4 * hash(Math.floor(frame / 2), 11) : 0)

    // Камеры выращивания: круглые колпаки со смотровым окном, в работе внутри светится тянущийся кристалл.
    for (const [x, y, offset] of [[33, 10, 0], [33, 22, 0.5]] as const) {
      g.circle(x, y, 5, INK)
      g.circle(x, y, 4, WHITE[2])
      g.circle(x - 1, y - 1, 2, WHITE[4])
      g.circle(x, y, 2, working ? tint[1] : WHITE[0])
      if (working) g.rect(x, y - 1 + Math.round(pulse(t, offset)), 1, 1, tint[2])
    }
    // Стопки готовых пластин: тонкие диски цвета кремния.
    for (const [x, y] of [[42, 9], [42, 17], [42, 25]] as const) {
      g.circle(x, y, 3, INK)
      g.circle(x, y, 2, tint[1])
      g.rect(x - 1, y - 2, 2, 1, tint[2])
    }
    lamp(g, light, 26, 26, 1, pulse(t))
  },
}

/** Перегонный завод, 2×3: ректификационная колонна сверху, шаровые баки и факел, где сгорает лишний газ. */
const distillery: BuildingArt = {
  ...BUILDINGS.distillery,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.fuel)
    slab(g, 0, 2, 32, 46, 3, STEEL)
    g.rect(3, 42, 26, 1, RUST[1])

    pipe(g, 4, 30, 24)
    pipe(g, 10, 22, 3)
    for (const x of [8, 22]) {
      g.circle(x, 36, 6, INK)
      g.circle(x, 36, 5, tint[0])
      g.circle(x - 1, 35, 4, tint[1])
      g.rect(x - 3, 33, 2, 1, tint[2])
    }

    // Колонна сверху: толстый круг с кольцевой площадкой; в работе по кольцу бегут огни.
    tower(g, 12, 16, 8, 3, STEEL)
    g.circle(12, 13, 5, INK)
    g.circle(12, 13, 4, STEEL[2])
    g.circle(11, 12, 2, STEEL[3])
    for (let i = 0; i < 6; i++) {
      const angle = (TURN * i) / 6
      bulb(g, light, Math.round(12 + Math.cos(angle) * 6.5) - 1, Math.round(13 + Math.sin(angle) * 6.5) - 1, working ? chase(t, i / 6) : 0)
    }
    pipe(g, 19, 10, 5)

    // Факел сверху: в работе пляшет огонь, в простое тлеет запальник.
    const flame = working ? pulse(t * 4) : 0
    g.circle(25, 10, 4, INK)
    g.circle(25, 10, 3, IRON[2])
    if (working) {
      g.circle(25, 10, 2 + flame, fireColor(0.55 + flame * 0.2))
      g.circle(25, 9, 1 + flame * 0.6, fireColor(0.95))
    } else g.rect(25, 10, 1, 1, fireColor(0.5 + 0.3 * pulse(t)))
    light(25, 9, 4, working ? 0.7 + flame * 0.3 : 0.1)
    lamp(g, light, 27, 24, 1, pulse(t))
  },
}

/** Обогатитель харита, 2×2: круглая центрифуга во всю площадку за полосами опасности, в центре — светящееся ядро. */
const enricher: BuildingArt = {
  ...BUILDINGS.enricher,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.kharite)
    slab(g, 0, 2, 32, 30, 3, IRON)
    for (let x = 2; x < 30; x += 4) {
      g.rect(x, 4, 2, 2, HAZARD[1])
      g.rect(x + 2, 4, 2, 2, HAZARD[0])
    }

    // Центрифуга: в работе капсулы бегут по кольцу, в простое стоят.
    const cx = 16
    const cy = 16
    g.circle(cx, cy, 11, INK)
    g.circle(cx, cy, 10, IRON[2])
    g.circle(cx, cy, 7, INK)
    g.circle(cx, cy, 6, IRON[0])
    for (let i = 0; i < 4; i++) {
      const angle = TURN * ((working ? t : 0.125) + i / 4)
      const x = cx + Math.cos(angle) * 8.5
      const y = cy + Math.sin(angle) * 8.5
      g.line(cx, cy, x, y, 1, IRON[3])
      g.circle(x, y, 2, working ? tint[1] : tint[0])
      g.rect(Math.round(x) - 1, Math.round(y) - 1, 1, 1, tint[2])
    }
    // Ядро: в работе дышит светом харита, в простое едва теплится.
    const core = working ? 0.6 + 0.4 * pulse(t * 2) : 0.15
    g.circle(cx, cy, 4, tint[0])
    g.circle(cx, cy, 3, core > 0.85 ? tint[2] : working ? tint[1] : tint[0])
    light(cx, cy, 5, core)
    lamp(g, light, 28, 26, 2, pulse(t * (working ? 3 : 1)))
  },
}

/**
 * Цеха изделий, как и переработки, нарочно непохожи: что цех делает, видно по силуэту, а цвет изделия — у готового.
 * В простое горит только сигнальная лампа и механизмы стоят; в работе всё движется.
 */

/** Цех стройблоков: бетономешалка с лопастями, формовочный стол, где блок выдавливается из формы, и паллеты кладки. */
const blockPlant: BuildingArt = {
  ...BUILDINGS.blockPlant,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.blocks)
    const CONCRETE: Tones = [0x4a4844, 0x6e6a63, 0x8f8a80, 0xb1aba0, 0xd4cfc4]
    slab(g, 0, 2, 32, 30, 3, CONCRETE)

    // Мешалка: барабан с лопастями, в работе они крутятся в сером растворе.
    const cx = 10
    const cy = 11
    g.circle(cx, cy, 8, INK)
    g.circle(cx, cy, 7, RUST[1])
    g.circle(cx, cy, 5, INK)
    g.circle(cx, cy, 4, CONCRETE[1])
    for (let i = 0; i < 3; i++) {
      const angle = TURN * ((working ? t : 0) + i / 3)
      g.line(cx, cy, cx + Math.cos(angle) * 4, cy + Math.sin(angle) * 4, 1, CONCRETE[3])
    }
    g.rect(cx, cy, 1, 1, INK)

    // Формовочный стол под мешалкой: блок выдавливается из формы и уезжает вправо.
    g.rect(2, 21, 16, 7, INK)
    g.rect(3, 22, 14, 5, IRON[1])
    g.rect(3, 22, 4, 5, IRON[0])
    const slide = working ? Math.floor(t * ART_FRAMES) % 8 : 0
    if (working) {
      g.rect(4 + slide, 23, 4, 3, INK)
      g.rect(5 + slide, 23, 3, 2, tint[1])
      g.rect(5 + slide, 23, 3, 1, tint[2])
    }

    // Паллеты стройблоков: кладка вперевязку.
    for (const [x, y] of [[20, 5], [20, 17]] as const) {
      g.rect(x, y, 10, 9, INK)
      for (let row = 0; row < 3; row++) {
        const offset = row % 2 ? 2 : 0
        for (let col = -1; col < 3; col++) {
          const bx = x + 1 + offset + col * 4
          const left = Math.max(bx, x + 1)
          const right = Math.min(bx + 3, x + 9)
          if (right <= left) continue
          g.rect(left, y + 1 + row * 3, right - left, 2, tint[1])
          g.rect(left, y + 1 + row * 3, right - left, 1, tint[2])
        }
      }
    }
    lamp(g, light, 18, 3, 1, pulse(t))
    bulb(g, light, 15, 18, working ? chase(t, 0) : 0)
  },
}

/** Патронный цех: бункер пороха, по ленте рядами едут латунные гильзы, на краях — полосы опасности. */
const ammoPlant: BuildingArt = {
  ...BUILDINGS.ammoPlant,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.ammo)
    slab(g, 0, 2, 32, 30, 3, IRON)
    for (let x = 2; x < 30; x += 4) {
      g.rect(x, 26, 2, 2, HAZARD[1])
      g.rect(x + 2, 26, 2, 2, HAZARD[0])
    }

    // Бункер пороха: воронка сверху, тёмная засыпка; в работе из горла сыплется порох.
    g.rect(2, 4, 11, 11, INK)
    g.rect(3, 5, 9, 9, IRON[2])
    g.rect(5, 7, 5, 5, IRON[1])
    g.rect(6, 8, 3, 3, 0x1a1a1a)
    if (working) g.rect(7, 9 + (Math.floor(t * ART_FRAMES) % 2), 1, 1, IRON[3])
    // Подача с бункера на ленту.
    g.rect(13, 8, 4, 3, INK)
    g.rect(13, 9, 4, 1, RUST[1])

    // Лента: три ряда гильз, в работе ползут вниз; донца гильз сверху — латунные кружки.
    g.rect(16, 4, 14, 21, INK)
    g.rect(17, 5, 12, 19, IRON[0])
    const shift = working ? Math.floor(t * ART_FRAMES) % 4 : 0
    for (let row = 0; row < 6; row++) {
      const y = 5 + row * 4 + shift - 2
      if (y < 5 || y > 21) continue
      for (let col = 0; col < 3; col++) {
        const x = 19 + col * 4
        g.circle(x, y + 1, 1.5, tint[0])
        g.rect(x, y + 1, 1, 1, row > 2 ? tint[2] : IRON[3])
      }
    }
    // Готовые ящики с патронами внизу слева.
    for (const x of [3, 9]) {
      g.rect(x, 17, 6, 7, INK)
      g.rect(x + 1, 18, 4, 5, 0x3d4a2a)
      g.rect(x + 1, 20, 4, 1, tint[1])
    }
    lamp(g, light, 29, 3, 1, pulse(t * (working ? 3 : 1)))
    bulb(g, light, 14, 13, working ? chase(t, 0.5) : 0)
  },
}

/** Цех компонентов: чистая комната с зелёной платой, над которой ездит манипулятор и ставит микросхемы. */
const partsPlant: BuildingArt = {
  ...BUILDINGS.partsPlant,
  working: true,
  draw(g, t, light, _variant, working = false) {
    const tint = accent(GOOD_COLORS.parts)
    const WHITE: Tones = [0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff]
    slab(g, 0, 2, 32, 30, 3, WHITE)

    // Плата: зелёное поле с дорожками и микросхемами.
    const PCB = [0x0d3a22, 0x16603a, 0x2a8c55] as const
    g.rect(3, 5, 26, 18, INK)
    g.rect(4, 6, 24, 16, PCB[1])
    for (let y = 8; y < 21; y += 4) g.rect(5, y, 22, 1, PCB[2])
    for (let x = 9; x < 27; x += 6) g.rect(x, 7, 1, 14, PCB[0])
    for (const [x, y] of [[6, 9], [14, 9], [22, 9], [6, 16], [14, 16]] as const) {
      g.rect(x, y, 4, 3, INK)
      g.rect(x, y, 4, 1, 0x30363c)
    }
    // Светодиоды платы: в работе бегут, в простое тихо.
    for (let i = 0; i < 3; i++) bulb(g, light, 22 + (i % 2) * 3, 15 + i * 2, working ? chase(t, i / 3) : 0)

    // Портал манипулятора: рельс поперёк, каретка ездит туда-сюда и опускает головку.
    const along = working ? 0.5 - 0.5 * Math.cos(TURN * t) : 0
    const hx = Math.round(6 + along * 18)
    g.rect(3, 12, 26, 2, INK)
    g.rect(3, 12, 26, 1, WHITE[3])
    g.rect(hx - 2, 10, 5, 6, INK)
    g.rect(hx - 1, 11, 3, 4, WHITE[2])
    g.rect(hx, 12, 1, 2, working && along > 0.45 && along < 0.55 ? tint[2] : tint[0])

    // Готовые компоненты в лотке внизу.
    g.rect(3, 23, 26, 5, INK)
    g.rect(4, 24, 24, 3, WHITE[1])
    for (let x = 5; x < 27; x += 4) {
      g.rect(x, 24, 3, 2, tint[0])
      g.rect(x, 24, 3, 1, tint[1])
    }
    lamp(g, light, 29, 4, 1, pulse(t))
  },
}

/**
 * Техцентр, 3×3: лаборатория под стеклянным куполом, где крутится голограмма чертежа, корпус с рядами окон
 * и мачта с антенной решёткой. Огни по периметру купола бегут по кругу.
 */
const techCenter: BuildingArt = {
  ...BUILDINGS.techCenter,
  draw(g, t, light) {
    slab(g, 0, 2, 48, 46, 3, STEEL)
    // Двор: дорожка к входу.
    g.rect(20, 38, 8, 7, IRON[1])
    g.rect(20, 38, 8, 1, IRON[0])

    // Корпус лаборатории с окнами.
    slab(g, 3, 14, 42, 26, 6, IRON)
    windows(g, [6, 11, 33, 38], 30)
    g.rect(20, 30, 8, 8, INK)
    g.rect(21, 31, 6, 7, DARK)
    for (let i = 0; i < 4; i++) bulb(g, light, 20 + i * 2, 27, chase(t, i / 4))

    // Стеклянный купол.
    const GLASS: Tones = [0x123047, 0x1d4a6b, 0x2f6f96, 0x5aa0c8, 0xb8e2f5]
    g.circle(24, 14, 13, INK)
    g.circle(24, 14, 12, GLASS[0])
    g.circle(23, 13, 10, GLASS[1])
    // Голограмма: вращающийся каркас куба — два квадрата и рёбра между ними.
    const angle = t * TURN * 0.25
    const corner = (k: number, lift: number) => {
      const a = angle + (k * TURN) / 4
      return [24 + Math.cos(a) * 5, 15 + Math.sin(a) * 2.2 - lift] as const
    }
    const color = TEAM[2]
    for (let k = 0; k < 4; k++) {
      const [x1, y1] = corner(k, 0)
      const [x2, y2] = corner(k + 1, 0)
      const [x3, y3] = corner(k, 6)
      const [x4, y4] = corner(k + 1, 6)
      g.line(x1, y1, x2, y2, 1, color)
      g.line(x3, y3, x4, y4, 1, color)
      g.line(x1, y1, x3, y3, 1, TEAM[1])
    }
    light(24, 12, 4, 0.6 + 0.4 * pulse(t * 2))
    // Блик на стекле.
    g.rect(17, 7, 3, 1, GLASS[4])
    g.rect(16, 8, 1, 2, GLASS[3])
    // Огни по кругу купола.
    const LIGHTS = 8
    for (let i = 0; i < LIGHTS; i++) {
      const a = (i / LIGHTS) * TURN
      bulb(g, light, Math.round(24 + Math.cos(a) * 12) - 1, Math.round(14 + Math.sin(a) * 12) - 1, chase(t, i / LIGHTS))
    }

    // Мачта с антенной решёткой в углу.
    tower(g, 41, 12, 2, 10, STEEL)
    g.rect(37, -3, 9, 1, IRON[3])
    g.rect(37, -1, 9, 1, IRON[3])
    g.rect(41, -5, 1, 6, IRON[4])
    bulb(g, light, 40, -7, pulse(t * 2))
    lamp(g, light, 6, 8, 2, pulse(t, 0.5))
  },
}

/**
 * Аэродром, 4×3: взлётная полоса с разметкой и бегущими огнями вдоль неё, ангар с полукруглой крышей и открытыми
 * воротами, где стоит самолёт, и диспетчерская вышка с вращающимся маяком.
 */
const airfield: BuildingArt = {
  ...BUILDINGS.airfield,
  draw(g, t, light) {
    slab(g, 0, 2, 64, 46, 3, STEEL)

    // Полоса вдоль нижнего края: асфальт, осевая разметка, огни по краям бегут к торцу.
    g.rect(3, 30, 58, 13, INK)
    g.rect(4, 31, 56, 11, 0x23262b)
    for (let x = 7; x < 58; x += 7) g.rect(x, 36, 4, 1, 0xd8d2bf)
    g.rect(5, 32, 1, 9, 0xd8d2bf)
    g.rect(58, 32, 1, 9, 0xd8d2bf)
    const LIGHTS = 8
    for (let i = 0; i < LIGHTS; i++) {
      const x = 7 + i * 7
      bulb(g, light, x, 30, chase(t, i / LIGHTS))
      bulb(g, light, x, 41, chase(t, i / LIGHTS))
    }

    // Ангар: полукруглая крыша с рёбрами и открытые ворота.
    slab(g, 3, 1, 34, 28, 4, IRON)
    for (let x = 6; x < 35; x += 4) {
      g.rect(x, 3, 1, 18, IRON[0])
      g.rect(x + 1, 3, 1, 18, IRON[2])
    }
    g.rect(9, 18, 22, 10, INK)
    g.rect(10, 19, 20, 9, DARK)
    // Самолёт в воротах носом наружу.
    g.rect(19, 20, 2, 8, STEEL[3])
    g.rect(13, 23, 14, 2, STEEL[2])
    g.rect(17, 20, 6, 1, STEEL[2])
    g.rect(19, 27, 2, 1, TEAM[2])

    // Вышка: тонкая башня, остеклённая кабина и маяк на крыше.
    tower(g, 52, 22, 3, 12, STEEL)
    g.rect(46, 4, 13, 7, INK)
    g.rect(47, 5, 11, 5, TEAM[1])
    g.rect(47, 5, 11, 1, TEAM[2])
    const sweep = Math.cos(TURN * t)
    g.rect(52 + Math.round(sweep * 3), 2, 2, 2, TEAM[3])
    lamp(g, light, 52, 1, 1, pulse(t * 2))
    lamp(g, light, 42, 24, 2, pulse(t, 0.5))
  },
}

/** Радар: мачта с вращающейся тарелкой и аппаратная будка. */
const radar: BuildingArt = {
  ...BUILDINGS.radar,
  draw(g, t, light) {
    slab(g, 0, 2, 32, 30, 3, STEEL)
    g.rect(3, 5, 26, 21, STEEL[0])
    g.rect(4, 6, 25, 20, STEEL[1])
    bulb(g, light, 4, 6, chase(t, 0))
    bulb(g, light, 26, 23, chase(t, 0.5))

    slab(g, 3, 15, 11, 12, 4, IRON)
    windows(g, [5, 9], 22)
    lamp(g, light, 8, 18, 1, pulse(t * 2))

    tower(g, 20, 17, 6, 7, IRON)
    // Тарелка видна под наклоном: по вертикали всё сжато.
    const angle = t * TURN
    const [dx, dy] = [Math.cos(angle), Math.sin(angle) * 0.65]
    const [px, py] = [-Math.sin(angle) * 9, Math.cos(angle) * 9 * 0.65]
    const cx = 20
    const cy = 8
    g.line(cx - px, cy - py, cx + px, cy + py, 5, INK)
    g.line(cx - px, cy - py, cx + px, cy + py, 3, IRON[3])
    g.line(cx - px + dx, cy - py + dy, cx + px + dx, cy + py + dy, 1.2, IRON[4])
    g.line(cx, cy, cx + dx * 5, cy + dy * 5, 1.2, IRON[1])
    g.rect(Math.round(cx + dx * 5) - 1, Math.round(cy + dy * 5) - 1, 2, 2, TEAM[3])
  },
}

/** Ветроуловитель: широкая шахта с крыльчаткой. */
const windtrap: BuildingArt = {
  ...BUILDINGS.windtrap,
  draw(g, t, light) {
    slab(g, 0, 2, 32, 30, 3, STEEL)
    for (const x of [3, 25]) {
      g.rect(x, 5, 4, 1, RUST[1])
      g.rect(x, 26, 4, 1, RUST[1])
    }

    tower(g, 16, 17, 11, 4, STEEL)
    g.circle(16, 13, 8, INK)
    g.circle(16, 13, 7, DARK)
    // Четыре лопасти: четверть оборота замыкает цикл.
    const angle = t * TURN * 0.25
    for (const turn of [angle, angle + TURN / 4]) {
      const dx = Math.cos(turn) * 7
      const dy = Math.sin(turn) * 7
      g.line(16 - dx, 13 - dy, 16 + dx, 13 + dy, 2, IRON[2])
    }
    lamp(g, light, 16, 13, 2, pulse(t * 2))
  },
}

/**
 * Казармы, 3×2: два спальных корпуса с плоскими крышами, между ними штаб со знаменем, перед ними плац
 * с разметкой строя. По плацу ходит часовой.
 */
const barracks: BuildingArt = {
  ...BUILDINGS.barracks,
  draw(g, t, light) {
    slab(g, 0, 2, 48, 30, 3, STEEL)

    // Плац: песчаная площадка с точками строя.
    g.rect(3, 19, 42, 9, 0x6b5a3e)
    g.rect(3, 19, 42, 1, 0x4d4030)
    for (let x = 7; x < 44; x += 5) for (const y of [22, 25]) g.rect(x, y, 1, 1, 0x8f7a55)
    // Часовой ходит вдоль плаца туда и обратно.
    const walk = Math.round(6 + 34 * (0.5 - 0.5 * Math.cos(TURN * t)))
    g.rect(walk, 22, 3, 3, INK)
    g.rect(walk + 1, 23, 1, 1, TEAM[2])

    // Спальные корпуса по бокам: крыши с вентиляцией.
    for (const x of [2, 31]) {
      slab(g, x, 3, 15, 15, 3, IRON)
      g.rect(x + 2, 6, 11, 1, IRON[0])
      g.rect(x + 2, 10, 11, 1, IRON[0])
      g.rect(x + 6, 7, 3, 2, IRON[3])
    }
    // Штаб посередине со знаменем команды.
    slab(g, 17, 1, 14, 17, 3, STEEL)
    g.rect(19, 3, 10, 9, TEAM[1])
    g.rect(19, 3, 10, 2, TEAM[2])
    g.rect(23, 6, 2, 3, TEAM[3])
    g.rect(21, 13, 6, 2, INK)
    bulb(g, light, 18, 15, pulse(t))
    bulb(g, light, 28, 15, pulse(t, 0.5))
  },
}

/** Шахта: ствол под копром с крутящимся шкивом и бункер, куда лента поднимает руду. */
const mine: BuildingArt = {
  ...BUILDINGS.mine,
  draw(g, t, light) {
    slab(g, 0, 1, 32, 31, 3, STEEL)

    // Ствол шахты и лента от него к бункеру: по ней идёт порция руды.
    g.rect(4, 12, 14, 14, INK)
    g.rect(5, 13, 12, 12, DARK)
    g.rect(5, 13, 12, 1, IRON[1])
    g.rect(17, 19, 7, 5, INK)
    g.rect(17, 20, 7, 3, IRON[0])
    const step = Math.floor(t * ART_FRAMES) % 8
    if (step < 6) {
      g.rect(17 + step, 20, 2, 2, RUST[1])
      g.rect(17 + step, 20, 1, 1, RUST[2])
    }

    // Бункер с рудой.
    slab(g, 21, 10, 10, 18, 4, IRON)
    g.rect(23, 12, 6, 9, DARK)
    for (const [x, y] of [[23, 17], [26, 16], [24, 19], [27, 19], [25, 13]]) {
      g.rect(x, y, 2, 2, RUST[1])
      g.rect(x, y, 1, 1, RUST[2])
    }

    // Копёр: две ноги сходятся к шкиву над стволом.
    for (const x of [5, 16]) {
      g.line(x, 24, 11, -2, 3, INK)
      g.line(x, 24, 11, -2, 1.2, IRON[3])
    }
    g.rect(6, 10, 10, 1, IRON[2])
    g.circle(11, -2, 5, INK)
    g.circle(11, -2, 4, IRON[1])
    // У шкива четыре спицы: четверть оборота замыкает цикл.
    const angle = t * TURN * 0.25
    for (const turn of [angle, angle + TURN / 4]) {
      const dx = Math.cos(turn) * 3.5
      const dy = Math.sin(turn) * 3.5
      g.line(11 - dx, -2 - dy, 11 + dx, -2 + dy, 1.2, IRON[4])
    }
    // Трос ходит в ствол.
    g.rect(11, 3, 1, 12, IRON[2])
    bulb(g, light, 2, 6, pulse(t))
    bulb(g, light, 27, 7, pulse(t, 0.5))
  },
}

/** Космопорт: посадочная площадка с разметкой и бегущими огнями, сбоку — диспетчерская башня. */
const spaceport: BuildingArt = {
  ...BUILDINGS.spaceport,
  draw(g, t, light) {
    slab(g, 0, 1, 48, 47, 3, STEEL)
    g.rect(3, 4, 42, 38, IRON[0])
    g.rect(4, 5, 41, 37, IRON[1])
    // Посадочный круг с крестом.
    g.ring(22, 24, 15, 2, GOLD[0])
    g.ring(22, 24, 8, 1, IRON[3])
    g.rect(21, 12, 2, 24, IRON[3])
    g.rect(10, 23, 24, 2, IRON[3])
    g.circle(22, 24, 3, INK)
    g.circle(22, 24, 2, GOLD[1])
    // Огни по кругу бегут к центру захода.
    const LIGHTS = 8
    for (let i = 0; i < LIGHTS; i++) {
      const angle = (i / LIGHTS) * TURN
      bulb(g, light, Math.round(22 + Math.cos(angle) * 18) - 1, Math.round(24 + Math.sin(angle) * 17) - 1, chase(t, i / LIGHTS))
    }
    // Диспетчерская.
    tower(g, 41, 12, 4, 9, STEEL)
    lamp(g, light, 41, 2, 2, pulse(t * 2))
  },
}

/**
 * Хранилища у каждого ресурса свои, и, как у переработки, силуэт говорит, что в них лежит: штабеля слитков,
 * герметичные боксы, круглые баки, бронированный сейф, поддоны блоков, бункер боеприпасов и шкаф компонентов. Цвет груза — его цвет на складе.
 */

/** Склад металла, 3×2: открытый двор со штабелями слитков и козловым краном над ними. */
const metalYard: BuildingArt = {
  ...BUILDINGS.metalYard,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.metal)
    slab(g, 0, 1, 48, 31, 3, IRON)
    g.rect(2, 3, 44, 24, IRON[1])
    for (let x = 3; x < 46; x += 8) g.rect(x, 26, 4, 1, HAZARD[1])
    // Штабеля: каждый — три ряда слитков.
    for (const sx of [4, 19, 34]) {
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 2; k++) {
          const x = sx + k * 5
          const y = 6 + row * 6
          g.rect(x, y, 5, 5, INK)
          g.rect(x + 1, y + 1, 3, 3, tint[1])
          g.rect(x + 1, y + 1, 3, 1, tint[2])
        }
      }
    }
    // Козловой кран ходит над штабелями.
    const x = Math.round(6 + 34 * (0.5 - 0.5 * Math.cos(TURN * t)))
    g.rect(x, 2, 3, 25, INK)
    g.rect(x + 1, 2, 1, 25, HAZARD[1])
    g.rect(x - 1, 12, 5, 3, IRON[3])
    bulb(g, light, 2, 28, pulse(t))
    bulb(g, light, 44, 28, pulse(t, 0.5))
  },
}

/** Склад кремния, 2×2: белый герметичный корпус с боксами под стеклом, чистый воздух гонят фильтры. */
const siliconStore: BuildingArt = {
  ...BUILDINGS.siliconStore,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.silicon)
    const WHITE: Tones = [0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff]
    slab(g, 0, 1, 32, 31, 3, WHITE)
    // Боксы: окна в корпусе, за стеклом — стопки пластин.
    for (const [x, y] of [[3, 4], [17, 4], [3, 15], [17, 15]] as const) {
      g.rect(x, y, 12, 9, INK)
      g.rect(x + 1, y + 1, 10, 7, 0x1a2a38)
      for (let k = 0; k < 3; k++) {
        g.rect(x + 2 + k * 3, y + 3, 2, 4, tint[1])
        g.rect(x + 2 + k * 3, y + 3, 2, 1, tint[2])
      }
      g.rect(x + 1, y + 1, 3, 1, 0x5a7a90)
    }
    // Фильтры на крыше: решётки вентиляторов, огонёк чистоты.
    for (const x of [8, 22]) {
      g.circle(x, 27, 2, INK)
      g.rect(x - 1, 27 - (Math.floor(t * ART_FRAMES) % 2), 2, 1, WHITE[3])
    }
    bulb(g, light, 14, 26, pulse(t))
  },
}

/** Топливные баки, 2×2: два круглых бака сверху, обвязка труб и задвижка. */
const fuelTank: BuildingArt = {
  ...BUILDINGS.fuelTank,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.fuel)
    slab(g, 0, 1, 32, 31, 3, STEEL)
    pipe(g, 3, 26, 26)
    for (const [x, y] of [[10, 11], [22, 19]] as const) {
      g.circle(x, y, 8, INK)
      g.circle(x, y, 7, IRON[2])
      g.circle(x - 1, y - 1, 5, IRON[3])
      // Плавающая крыша: кольцо цвета груза, по нему ходит блик.
      g.ring(x, y, 4, 1, tint[1])
      const angle = TURN * t
      g.rect(Math.round(x + Math.cos(angle) * 4), Math.round(y + Math.sin(angle) * 4), 1, 1, tint[2])
      g.circle(x, y, 1, INK)
    }
    // Задвижка между баками.
    g.rect(14, 13, 4, 4, INK)
    g.rect(15, 14, 2, 2, HAZARD[1])
    bulb(g, light, 26, 4, pulse(t))
  },
}

/** Сейф харита, 1×1: бронированный куб с толстой дверью и замком, сквозь щели светится груз. */
const khariteVault: BuildingArt = {
  ...BUILDINGS.khariteVault,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.kharite)
    slab(g, 0, 1, 16, 15, 2, IRON)
    g.rect(2, 3, 12, 9, IRON[0])
    g.rect(3, 4, 10, 7, IRON[2])
    g.rect(3, 4, 10, 1, IRON[3])
    // Щели светятся цветом харита.
    const glow = 0.5 + 0.5 * pulse(t)
    g.rect(3, 7, 10, 1, glow > 0.6 ? tint[2] : tint[1])
    light(8, 7, 3, 0.3 + 0.4 * glow)
    // Замок.
    g.circle(8, 7, 2, INK)
    g.circle(8, 7, 1, HAZARD[1])
  },
}

/** Склад стройблоков, 2×2: двор с поддонами кирпичных блоков и погрузчиком, который их развозит. */
const blockYard: BuildingArt = {
  ...BUILDINGS.blockYard,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.blocks)
    slab(g, 0, 1, 32, 31, 3, IRON)
    g.rect(2, 3, 28, 22, IRON[1])
    // Поддоны: деревянная решётка, на ней кладка блоков со швами.
    for (const [x, y] of [[3, 4], [17, 4], [3, 14], [17, 14]] as const) {
      g.rect(x, y, 12, 9, INK)
      g.rect(x + 1, y + 7, 10, 1, RUST[1])
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 3; k++) {
          const bx = x + 1 + k * 3 + (row % 2)
          g.rect(bx, y + 1 + row * 2, 3, 2, row === 0 ? tint[2] : tint[1])
          g.rect(bx + 2, y + 1 + row * 2, 1, 2, tint[0])
        }
      }
    }
    // Погрузчик ездит по проходу внизу.
    const x = Math.round(4 + 20 * (0.5 - 0.5 * Math.cos(TURN * t)))
    g.rect(x, 26, 5, 3, INK)
    g.rect(x + 1, 26, 3, 2, HAZARD[1])
    bulb(g, light, 28, 27, pulse(t))
  },
}

/** Бункер боеприпасов, 2×1: заглублённый бетонный каземат с полосами опасности и бронедверью. */
const ammoBunker: BuildingArt = {
  ...BUILDINGS.ammoBunker,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.ammo)
    slab(g, 0, 1, 32, 15, 2, IRON)
    // Обвалование: земляной вал вокруг крыши.
    g.rect(2, 3, 28, 9, 0x4d4030)
    g.rect(4, 4, 24, 7, IRON[2])
    g.rect(4, 4, 24, 1, IRON[3])
    // Полосы опасности по краю крыши.
    for (let x = 4; x < 28; x += 4) g.rect(x, 10, 2, 1, HAZARD[1])
    // Ящики у входа и бронедверь.
    for (const x of [6, 10]) {
      g.rect(x, 6, 3, 3, INK)
      g.rect(x, 6, 2, 2, tint[1])
      g.rect(x, 6, 2, 1, tint[2])
    }
    g.rect(18, 5, 8, 5, INK)
    g.rect(19, 6, 6, 3, IRON[1])
    g.rect(21, 7, 2, 1, HAZARD[1])
    // Красная лампа «взрывоопасно» мигает.
    const level = pulse(t * 2)
    g.rect(28, 5, 2, 2, level > 0.5 ? 0xff6b5a : 0x6a1a10)
    light(29, 6, 1, level * 0.5)
  },
}

/** Шкаф компонентов, 1×1: закрытая стойка с ящичками, на каждом — огонёк учёта. */
const partsLocker: BuildingArt = {
  ...BUILDINGS.partsLocker,
  draw(g, t, light) {
    const tint = accent(GOOD_COLORS.parts)
    slab(g, 0, 1, 16, 15, 2, STEEL)
    g.rect(2, 3, 12, 9, INK)
    // Ящички в два столбца, огоньки бегут сверху вниз.
    for (let row = 0; row < 3; row++) {
      for (const x of [3, 9]) {
        g.rect(x, 4 + row * 3, 4, 2, STEEL[2])
        g.rect(x + 1, 4 + row * 3, 2, 1, STEEL[3])
      }
      const level = chase(t, row / 3)
      g.rect(7, 4 + row * 3, 2, 2, level > 0.3 ? tint[2] : tint[0])
    }
    light(8, 7, 2, 0.3 + 0.3 * pulse(t))
  },
}

/** Биты соседей стены: четыре направления дают 16 вариантов от одиночной секции до перекрёстка. */
export const WALL_CONNECTION = { north: 1, east: 2, south: 4, west: 8 } as const

/** Стена: центральная опора и рукава до соседних секций. */
const wall: BuildingArt = {
  ...BUILDINGS.wall,
  variants: 16,
  draw(g, _t, _light, connections = 0) {
    const north = !!(connections & WALL_CONNECTION.north)
    const east = !!(connections & WALL_CONNECTION.east)
    const south = !!(connections & WALL_CONNECTION.south)
    const west = !!(connections & WALL_CONNECTION.west)

    // Рукава доходят до края тайла только со стороны соседа: две секции встречаются без прозрачного шва.
    if (east || west) {
      const left = west ? 0 : 3
      const right = east ? 16 : 13
      g.rect(left, 4, right - left, 9, INK)
      g.rect(left, 5, right - left, 6, STEEL[1])
      g.rect(left, 5, right - left, 1, STEEL[3])
      g.rect(left, 11, right - left, 1, STEEL[0])
    }
    if (north || south) {
      const top = north ? 0 : 3
      const bottom = south ? 16 : 13
      g.rect(4, top, 9, bottom - top, INK)
      g.rect(5, top, 6, bottom - top, STEEL[1])
      g.rect(5, top, 1, bottom - top, STEEL[3])
      g.rect(11, top, 1, bottom - top, STEEL[0])
    }

    // Центральная опора скрывает наложение рукавов и остаётся у одиночной секции.
    g.rect(3, 3, 10, 10, INK)
    g.rect(4, 4, 8, 8, IRON[1])
    g.rect(4, 4, 8, 1, IRON[3])
    g.rect(4, 11, 8, 1, IRON[0])
    g.rect(4, 5, 1, 6, IRON[2])
    g.rect(11, 5, 1, 6, IRON[0])
    for (const [x, y] of [[5, 5], [10, 5], [5, 10], [10, 10]]) g.rect(x, y, 1, 1, RUST[1])
  },
}

/** Основание оборонительной турели; само вращающееся оружие рисуется поверх отдельной сущностью. */
function emplacement(g: Pixmap, t: number, light: EmitLight, band: number) {
  slab(g, 0, 1, 16, 15, 2, STEEL)
  g.circle(8, 8, 6, INK)
  g.circle(8, 8, 5, IRON[0])
  g.ring(8, 8, 4, 1, band)
  g.circle(8, 8, 2, IRON[2])
  bulb(g, light, 1, 2, pulse(t))
  bulb(g, light, 13, 2, pulse(t, 0.5))
}

/** Пулемётная турель: серое кольцо наведения. */
const turret: BuildingArt = {
  ...BUILDINGS.turret,
  draw(g, t, light) {
    emplacement(g, t, light, IRON[3])
  },
}

/** Ракетная турель: ржаво-красное кольцо. */
const rocketTurret: BuildingArt = {
  ...BUILDINGS.rocketTurret,
  draw(g, t, light) {
    emplacement(g, t, light, RUST[1])
  },
}

/** Пушечная турель: золотое кольцо тяжёлого орудия. */
const cannonTurret: BuildingArt = {
  ...BUILDINGS.cannonTurret,
  draw(g, t, light) {
    emplacement(g, t, light, GOLD[1])
  },
}

export const BUILDING_ART = {
  techCenter,
  airfield,
  command,
  smelter,
  siliconWorks,
  distillery,
  enricher,
  blockPlant,
  ammoPlant,
  partsPlant,
  factory,
  generator,
  matter,
  radar,
  windtrap,
  barracks,
  mine,
  metalYard,
  siliconStore,
  fuelTank,
  khariteVault,
  blockYard,
  ammoBunker,
  partsLocker,
  spaceport,
  wall,
  turret,
  rocketTurret,
  cannonTurret,
} satisfies Record<BuildingType, BuildingArt>
