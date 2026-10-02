import type { Pixmap } from '../../render/pixmap'
import { BUILDINGS, type BuildingType } from '../../sim/buildings'

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
  /** light сообщает об огнях кадра; их число и порядок не должны зависеть от t. */
  draw(g: Pixmap, t: number, light: EmitLight): void
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

/** Завод: ребристый цех с воротами и вентилятором, перед воротами — пандус. */
const factory: BuildingArt = {
  ...BUILDINGS.factory,
  draw(g, t, light) {
    slab(g, 0, 4, 32, 28, 3, STEEL)

    // Пандус и разводка по двору.
    g.rect(10, 20, 12, 8, IRON[0])
    g.rect(11, 20, 10, 7, IRON[1])
    g.rect(11, 22, 10, 1, RUST[1])
    g.rect(11, 25, 10, 1, RUST[1])
    for (const x of [3, 24]) {
      g.rect(x, 22, 5, 1, RUST[1])
      g.rect(x === 3 ? 3 : 28, 22, 1, 5, RUST[1])
    }

    // Цех выше двора и выступает над основанием.
    slab(g, 2, -4, 28, 24, 7, IRON)
    for (let x = 5; x <= 25; x += 4) {
      g.rect(x, -2, 1, 13, IRON[0])
      g.rect(x + 1, -2, 1, 13, IRON[2])
    }
    g.rect(10, 12, 12, 7, INK)
    g.rect(11, 13, 10, 6, 0x04070b)
    for (const x of [4, 24]) {
      g.rect(x, 14, 4, 3, INK)
      g.rect(x, 14, 4, 2, TEAM[1])
      g.rect(x, 14, 2, 1, TEAM[2])
    }
    // Огни над воротами бегут слева направо.
    for (let i = 0; i < 5; i++) g.rect(11 + i * 2, 11, 2, 1, teamColor(chase(t, i / 5)))

    tower(g, 24, 3, 4, 3, STEEL)
    g.circle(24, 0, 3, INK)
    // У крыльчатки четыре лопасти: четверть оборота замыкает цикл.
    const angle = t * TURN * 0.25
    for (const turn of [angle, angle + TURN / 4]) {
      const dx = Math.cos(turn) * 3
      const dy = Math.sin(turn) * 3
      g.line(24 - dx, -dy, 24 + dx, dy, 1.2, IRON[3])
    }
    lamp(g, light, 8, 3, 2, pulse(t))
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

/** Перерабатывающий завод: баки, печь с трубой и приёмный лоток с лентой. */
const refinery: BuildingArt = {
  ...BUILDINGS.refinery,
  draw(g, t, light) {
    slab(g, 0, 2, 48, 30, 3, STEEL)

    pipe(g, 12, 8, 6)
    pipe(g, 12, 19, 6)
    tower(g, 8, 12, 6, 6, IRON)
    tower(g, 9, 22, 4, 3, IRON)

    // Лоток: полосы ленты ползут к печи.
    g.rect(34, 6, 12, 18, INK)
    g.rect(35, 7, 10, 16, RUST[0])
    const step = Math.floor(t * ART_FRAMES) % 4
    for (let k = 0; k < 4; k++) g.rect(35, 7 + ((k * 4 + 3 - step) % 16), 10, 1, RUST[1])
    bulb(g, light, 34, 25, chase(t, 0))
    bulb(g, light, 44, 25, chase(t, 0.5))

    slab(g, 16, -3, 17, 22, 6, IRON)
    g.rect(18, 0, 13, 1, IRON[0])
    g.rect(18, 8, 13, 1, IRON[0])
    g.rect(22, 12, 5, 6, INK)
    g.rect(23, 13, 3, 5, DARK)
    windows(g, [18, 28], 14)
    tower(g, 24, 6, 4, 6, STEEL)
    lamp(g, light, 24, 0, 2, pulse(t * 2))
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

/** Казармы: длинный корпус со знаменем на крыше, дверью и плацем. */
const barracks: BuildingArt = {
  ...BUILDINGS.barracks,
  draw(g, t, light) {
    slab(g, 0, 3, 32, 29, 3, STEEL)
    g.rect(4, 21, 24, 1, RUST[1])
    g.rect(4, 25, 24, 1, RUST[1])
    tower(g, 5, 25, 2, 2, IRON)
    tower(g, 27, 25, 2, 2, IRON)

    slab(g, 2, -2, 28, 20, 6, IRON)
    g.rect(4, 2, 24, 2, IRON[2])
    g.rect(4, 7, 24, 1, IRON[0])
    g.rect(13, -1, 6, 11, TEAM[1])
    g.rect(14, -1, 2, 11, TEAM[2])
    g.rect(13, 11, 6, 6, INK)
    g.rect(14, 12, 4, 5, DARK)
    windows(g, [4, 8, 21, 25], 13)
    bulb(g, light, 10, 9, pulse(t))
    bulb(g, light, 20, 9, pulse(t, 0.5))
  },
}

/** Хранилище: два бака с перемычкой. */
const silo: BuildingArt = {
  ...BUILDINGS.silo,
  draw(g, t, light) {
    slab(g, 0, 1, 32, 15, 2, STEEL)
    pipe(g, 12, 9, 8)
    for (const [x, offset] of [[8, 0], [24, 0.5]]) {
      tower(g, x, 9, 5, 5, IRON)
      bulb(g, light, x - 1, 3, pulse(t, offset))
    }
  },
}

/** Турель: башня с орудием, которое обводит окрестности. */
const turret: BuildingArt = {
  ...BUILDINGS.turret,
  draw(g, t, light) {
    slab(g, 0, 1, 16, 15, 2, STEEL)
    tower(g, 8, 9, 5, 3, IRON)
    const angle = t * TURN
    const tipX = 8 + Math.cos(angle) * 9
    const tipY = 6 + Math.sin(angle) * 7
    g.line(8, 6, tipX, tipY, 4, INK)
    g.line(8, 6, tipX, tipY, 2, IRON[3])
    g.circle(8, 6, 3, INK)
    g.circle(8, 6, 2, IRON[2])
    bulb(g, light, 7, 5, pulse(t * 2))
  },
}

export const BUILDING_ART = {
  command,
  refinery,
  factory,
  generator,
  matter,
  radar,
  windtrap,
  barracks,
  silo,
  turret,
} satisfies Record<BuildingType, BuildingArt>
