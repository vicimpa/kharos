import type { Pixmap } from '../../render/pixmap'
import type { UnitType } from '../../sim'

/**
 * Векторные чертежи юнитов, вид сверху. Рисуются на Pixmap в пикселях будущего спрайта, 16 пикселей на тайл;
 * начало координат — центр юнита. Каждый чертёж рисуется заново для каждого направления: повёрнутый
 * чертёж растеризуется чище, чем повёрнутая картинка.
 */

/** Сторона кадра в пикселях: два тайла. */
export const UNIT_FRAME = 32
/**
 * Сколько кадров поворота у юнита. Нулевой — вправо, дальше по часовой стрелке. Симуляция угол не ограничивает;
 * кадров столько, чтобы соседние отличались меньше чем на пиксель-два и поворот выглядел непрерывным.
 */
export const UNIT_DIRECTIONS = 64

/** Чертёж: рисует юнит, смотрящий под углом angle (радианы, 0 — вправо, растёт по часовой стрелке). */
export type UnitArt = (g: Pixmap, angle: number) => void

const INK = 0x0b111b
const STEEL = [0x1c2b3e, 0x2d4560, 0x41617f, 0x6184a3, 0x9bb9d1] as const
const IRON = [0x1e2024, 0x3a3d43, 0x5b5f66, 0x8b9097, 0xc3c7cc] as const
const HAZARD = [0x7a5a16, 0xc9962b, 0xf0c95a] as const
const TEAM = [0x1f63d8, 0x5aa9ff, 0xe4f4ff] as const

/**
 * Перо, повёрнутое вместе с юнитом: координаты — вперёд (along) и вправо (across) от его центра.
 * Так чертёж описывается один раз, как будто юнит смотрит вправо.
 */
function pen(g: Pixmap, angle: number) {
  const forwardX = Math.cos(angle)
  const forwardY = Math.sin(angle)
  const x = (along: number, across: number) => along * forwardX - across * forwardY
  const y = (along: number, across: number) => along * forwardY + across * forwardX
  return {
    /** Брусок вдоль хода: от from до to по оси «вперёд», со сдвигом across вбок, толщиной width. */
    bar(from: number, to: number, across: number, width: number, color: number) {
      g.line(x(from, across), y(from, across), x(to, across), y(to, across), width, color)
    },
    /** Брусок поперёк хода: на расстоянии along вперёд, от from до to по оси «вправо». */
    beam(along: number, from: number, to: number, width: number, color: number) {
      g.line(x(along, from), y(along, from), x(along, to), y(along, to), width, color)
    },
    dot(along: number, across: number, radius: number, color: number) {
      g.circle(x(along, across), y(along, across), radius, color)
    },
  }
}

/** MCV: широкая гусеничная машина с кабиной спереди и куполом будущего ядра. */
const mcv: UnitArt = (g, angle) => {
  const p = pen(g, angle)
  for (const side of [-8, 8]) {
    p.bar(-13, 13, side, 7, INK)
    p.bar(-12, 12, side, 5, IRON[1])
    for (let link = -10; link <= 10; link += 4) p.beam(link, side - 2.5, side + 2.5, 1, IRON[0])
  }
  p.bar(-11, 12, 0, 14, INK)
  p.bar(-10, 11, 0, 12, STEEL[1])
  p.bar(-10, 11, -5, 2, STEEL[2])
  p.bar(6, 11, 0, 10, STEEL[3])
  p.bar(8, 10, 0, 6, TEAM[2])
  p.dot(-3, 0, 5, INK)
  p.dot(-3, 0, 4, TEAM[0])
  p.dot(-4, -1, 2, TEAM[1])
}

/** Строитель: небольшая колёсная машина со стрелой. */
const builder: UnitArt = (g, angle) => {
  const p = pen(g, angle)
  for (const side of [-4, 4]) {
    for (const wheel of [-3.5, 3.5]) p.bar(wheel - 2, wheel + 2, side, 3, INK)
  }
  p.bar(-6, 6, 0, 8, INK)
  p.bar(-5, 5, 0, 6, HAZARD[1])
  p.bar(-5, 5, -2.5, 1, HAZARD[2])
  p.bar(-5, -3, 0, 6, HAZARD[0])
  p.bar(2, 4, 0, 4, TEAM[1])
  p.bar(-1, 8, 2, 2, INK)
  p.dot(8, 2, 1.5, IRON[3])
}

/** Пехотинец: плечи, голова и оружие. */
const infantry: UnitArt = (g, angle) => {
  const p = pen(g, angle)
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, TEAM[0])
  p.bar(0, 5, 2.5, 1.2, INK)
  p.dot(0.5, 0, 2, INK)
  p.dot(0.5, 0, 1.2, STEEL[4])
}

/**
 * Огонь юнита: фара или фонарь. Место — вперёд (along) и вправо (across) от центра юнита, в пикселях спрайта.
 * spot — радиус пятна на земле, glow — радиус ореола, оба в пикселях местности; ноль — без него.
 */
export interface UnitLight {
  along: number
  across: number
  spot: number
  glow: number
  level: number
}

/** Луч: пятна света, уходящие вперёд от точки (along, across) и растущие с расстоянием — вместе дают конус. */
function beam(along: number, across: number, length: number, width: number, level: number): UnitLight[] {
  const STEPS = 5
  return Array.from({ length: STEPS }, (_, i) => {
    const share = (i + 1) / STEPS
    // Пятна перекрываются и складываются, поэтому каждое неяркое.
    return { along: along + length * share, across: across * (1 - share), spot: width * (0.35 + 0.65 * share), glow: 0, level }
  })
}

/** Лампа: маленький ореол в самой фаре. */
const lamp = (along: number, across: number, glow: number): UnitLight => ({ along, across, spot: glow * 2, glow, level: 1 })

/** Машины светят двумя фарами, пехотинец — фонарём у оружия. */
export const UNIT_LIGHTS: Record<UnitType, UnitLight[]> = {
  mcv: [lamp(12, -4, 3), lamp(12, 4, 3), ...beam(12, -4, 60, 26, 0.3), ...beam(12, 4, 60, 26, 0.3)],
  builder: [lamp(6, -2, 2), lamp(6, 2, 2), ...beam(6, -2, 42, 18, 0.3), ...beam(6, 2, 42, 18, 0.3)],
  infantry: [lamp(5, 2.5, 1.5), ...beam(5, 2.5, 30, 12, 0.45)],
}

export const UNIT_ART = { mcv, builder, infantry } satisfies Record<UnitType, UnitArt>
