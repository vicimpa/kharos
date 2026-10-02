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

/** Цвета игрока на юните: тёмный, основной и светлый. */
export type TeamColors = readonly [number, number, number]
/** Свои юниты — синие, чужие — красные. */
export const TEAMS = {
  own: [0x1f63d8, 0x5aa9ff, 0xe4f4ff],
  foe: [0xb3261e, 0xff6b5a, 0xffe9e4],
} satisfies Record<string, TeamColors>
export type Team = keyof typeof TEAMS

/**
 * Чертёж: рисует юнит, смотрящий под углом angle (радианы, 0 — вправо, растёт по часовой стрелке),
 * в цветах игрока team.
 */
export type UnitArt = (g: Pixmap, angle: number, team: TeamColors) => void

const INK = 0x0b111b
const STEEL = [0x1c2b3e, 0x2d4560, 0x41617f, 0x6184a3, 0x9bb9d1] as const
const IRON = [0x1e2024, 0x3a3d43, 0x5b5f66, 0x8b9097, 0xc3c7cc] as const
const HAZARD = [0x7a5a16, 0xc9962b, 0xf0c95a] as const
const ENERGY = [0x4f9dff, 0x9fd0ff, 0xf2fbff] as const

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
    /** Отрезок между двумя точками, каждая — вперёд и вправо от центра. */
    line(fromAlong: number, fromAcross: number, toAlong: number, toAcross: number, width: number, color: number) {
      g.line(x(fromAlong, fromAcross), y(fromAlong, fromAcross), x(toAlong, toAcross), y(toAlong, toAcross), width, color)
    },
  }
}

/** MCV: широкая гусеничная машина с кабиной спереди и куполом будущего ядра. */
const mcv: UnitArt = (g, angle, team) => {
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
  p.bar(8, 10, 0, 6, team[2])
  p.dot(-3, 0, 5, INK)
  p.dot(-3, 0, 4, team[0])
  p.dot(-4, -1, 2, team[1])
}

/** Строитель: небольшая колёсная машина со стрелой. */
const builder: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  for (const side of [-4, 4]) {
    for (const wheel of [-3.5, 3.5]) p.bar(wheel - 2, wheel + 2, side, 3, INK)
  }
  p.bar(-6, 6, 0, 8, INK)
  p.bar(-5, 5, 0, 6, HAZARD[1])
  p.bar(-5, 5, -2.5, 1, HAZARD[2])
  p.bar(-5, -3, 0, 6, HAZARD[0])
  p.bar(2, 4, 0, 4, team[1])
  p.bar(-1, 8, 2, 2, INK)
  p.dot(8, 2, 1.5, IRON[3])
}

/** Пехотинец: плечи, голова и оружие. */
const infantry: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, team[0])
  p.bar(0, 5, 2.5, 1.2, INK)
  p.dot(0.5, 0, 2, INK)
  p.dot(0.5, 0, 1.2, STEEL[4])
}

/** Грузовик: кабина спереди и открытый кузов с рудой. */
const truck: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  for (const side of [-4.5, 4.5]) {
    for (const wheel of [-5, 0, 5]) p.bar(wheel - 1.5, wheel + 1.5, side, 3, INK)
  }
  p.bar(-8, 8, 0, 9, INK)
  // Кузов: борта и руда внутри.
  p.bar(-7, 2, 0, 7, IRON[2])
  p.bar(-6, 1, 0, 5, 0x6b2f1e)
  p.bar(-5, 0, -1, 2, 0xb5562e)
  p.dot(-2, 1, 1, 0xe58a4a)
  // Кабина.
  p.bar(3, 7, 0, 7, HAZARD[1])
  p.bar(3, 7, -3, 1, HAZARD[2])
  p.bar(5, 6, 0, 5, team[2])
}

/** Ракетчик: пехотинец с трубой на плече. */
const rocketeer: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, team[0])
  p.bar(-4, 6, -2.5, 3.2, INK)
  p.bar(-3, 5, -2.5, 1.6, IRON[3])
  p.dot(5.5, -2.5, 1, HAZARD[2])
  p.dot(0.5, 0.5, 2, INK)
  p.dot(0.5, 0.5, 1.2, STEEL[4])
}

/** Колёса лёгкой машины: по два с каждого борта. */
function wheels(p: ReturnType<typeof pen>, side: number, spread: number) {
  for (const across of [-side, side]) {
    for (const wheel of [-spread, spread]) p.bar(wheel - 2, wheel + 2, across, 3, INK)
  }
}

/** Багги: узкая быстрая машина с пулемётом. */
const buggy: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  wheels(p, 4.5, 4)
  p.bar(-6, 7, 0, 7, INK)
  p.bar(-5, 6, 0, 5, IRON[2])
  p.bar(-5, 6, -2, 1, IRON[3])
  p.bar(-5, -3, 0, 5, team[0])
  p.bar(3, 5, 0, 3, team[2])
  p.bar(-1, 8, 0, 1.6, INK)
  p.dot(-1, 0, 2.6, INK)
  p.dot(-1, 0, 1.6, team[1])
}

/** Лазерная машина: излучатель на шасси. */
const lancer: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  wheels(p, 4.5, 4.5)
  p.bar(-7, 6, 0, 8, INK)
  p.bar(-6, 5, 0, 6, STEEL[1])
  p.bar(-6, 5, -2.5, 1, STEEL[3])
  p.bar(-6, -4, 0, 6, team[0])
  p.bar(-2, 8, 0, 3.4, INK)
  p.bar(-1, 7, 0, 1.6, STEEL[4])
  p.dot(8, 0, 1.6, 0xff4d6d)
  p.dot(-2, 0, 3.2, INK)
  p.dot(-2, 0, 2.2, team[1])
}

/** Гусеницы и корпус тяжёлой машины. */
function heavyHull(p: ReturnType<typeof pen>, team: TeamColors) {
  for (const side of [-7.5, 7.5]) {
    p.bar(-11, 11, side, 6, INK)
    p.bar(-10, 10, side, 4, IRON[1])
    for (let link = -8; link <= 8; link += 4) p.beam(link, side - 2, side + 2, 1, IRON[0])
  }
  p.bar(-9, 10, 0, 12, INK)
  p.bar(-8, 9, 0, 10, STEEL[1])
  p.bar(-8, 9, -4, 2, STEEL[2])
  p.bar(-8, -6, 0, 10, team[0])
}

/** Танк: гусеницы, башня и длинный ствол. */
const tank: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  heavyHull(p, team)
  p.bar(0, 14, 0, 3.6, INK)
  p.bar(0, 13, 0, 1.6, IRON[3])
  p.dot(-1, 0, 5.6, INK)
  p.dot(-1, 0, 4.6, STEEL[2])
  p.dot(-2, -1, 2, team[1])
}

/** Разрядник: тяжёлое шасси с катушкой и двумя электродами. */
const tesla: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  heavyHull(p, team)
  for (const side of [-3, 3]) {
    p.bar(3, 11, side, 2.6, INK)
    p.bar(3, 10, side, 1.2, IRON[3])
    p.dot(11, side, 1.3, ENERGY[1])
  }
  p.dot(0, 0, 6, INK)
  p.dot(0, 0, 5, IRON[2])
  p.dot(0, 0, 3.6, INK)
  p.dot(0, 0, 2.6, ENERGY[0])
  p.dot(0, 0, 1.2, ENERGY[2])
}

/** Дрон: четыре винта крестом и маленький корпус. */
const drone: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  for (const [along, across] of [[4, 4], [4, -4], [-4, 4], [-4, -4]]) {
    p.line(0, 0, along, across, 2.4, INK)
    p.line(0, 0, along, across, 1, IRON[2])
    p.dot(along, across, 2.8, INK)
    p.dot(along, across, 1.8, IRON[3])
    p.dot(along, across, 0.7, IRON[0])
  }
  p.bar(0, 6, 0, 1.6, INK)
  p.dot(0, 0, 3.2, INK)
  p.dot(0, 0, 2.2, team[0])
  p.dot(0.5, -0.5, 1, team[2])
}

/** Штурмовик: фюзеляж, крылья с ракетными блоками и хвост. */
const gunship: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.beam(-1, -11, 11, 6, INK)
  p.beam(-1, -10, 10, 4, STEEL[1])
  p.beam(-2, -10, 10, 1, STEEL[3])
  p.beam(-1, -10, -7, 4, team[0])
  p.beam(-1, 7, 10, 4, team[0])
  for (const side of [-6.5, 6.5]) {
    p.bar(-2, 6, side, 3.4, INK)
    p.bar(-1, 5, side, 1.6, IRON[3])
    p.dot(5.5, side, 0.9, HAZARD[2])
  }
  p.beam(-9, -4, 4, 3.4, INK)
  p.beam(-9, -3, 3, 1.6, STEEL[2])
  p.bar(-10, 10, 0, 6, INK)
  p.bar(-9, 9, 0, 4, STEEL[2])
  p.bar(-9, 9, -1.5, 1, STEEL[3])
  p.bar(4, 8, 0, 2.6, team[2])
}

/**
 * Свет юнита. lamps — ореолы самих ламп: место вперёд (along) и вправо (across) от центра юнита в пикселях спрайта,
 * glow — радиус ореола в пикселях местности. beam — луч вперёд из точки along на оси юнита: длина, полуширина
 * у источника (near) в пикселях и расширение на пиксель длины (spread). Источник луча стоит перед самым носом
 * юнита: силуэт юнита свет не пропускает, и из-под него луч бы не вышел.
 */
export interface UnitLights {
  lamps: { along: number; across: number; glow: number }[]
  beam: { along: number; length: number; near: number; spread: number; level: number }
}

/** Машины светят двумя фарами, пехотинец — фонарём у оружия. */
export const UNIT_LIGHTS: Record<UnitType, UnitLights> = {
  mcv: {
    lamps: [{ along: 12, across: -4, glow: 3 }, { along: 12, across: 4, glow: 3 }],
    beam: { along: 14, length: 72, near: 7, spread: 0.3, level: 1 },
  },
  builder: {
    lamps: [{ along: 6, across: -2, glow: 2 }, { along: 6, across: 2, glow: 2 }],
    beam: { along: 10, length: 52, near: 4, spread: 0.3, level: 1 },
  },
  truck: {
    lamps: [{ along: 8, across: -2.5, glow: 2 }, { along: 8, across: 2.5, glow: 2 }],
    beam: { along: 11, length: 56, near: 4.5, spread: 0.3, level: 1 },
  },
  infantry: {
    lamps: [{ along: 5, across: 2.5, glow: 1.5 }],
    beam: { along: 7, length: 36, near: 1.5, spread: 0.22, level: 0.9 },
  },
  rocketeer: {
    lamps: [{ along: 4, across: 2.5, glow: 1.5 }],
    beam: { along: 7, length: 36, near: 1.5, spread: 0.22, level: 0.9 },
  },
  buggy: {
    lamps: [{ along: 7, across: -2, glow: 2 }, { along: 7, across: 2, glow: 2 }],
    beam: { along: 10, length: 60, near: 4, spread: 0.28, level: 1 },
  },
  lancer: {
    lamps: [{ along: 6, across: -2.5, glow: 2 }, { along: 6, across: 2.5, glow: 2 }],
    beam: { along: 10, length: 52, near: 4, spread: 0.3, level: 1 },
  },
  tank: {
    lamps: [{ along: 10, across: -4, glow: 2.5 }, { along: 10, across: 4, glow: 2.5 }],
    beam: { along: 15, length: 60, near: 6, spread: 0.3, level: 1 },
  },
  tesla: {
    lamps: [{ along: 10, across: -4, glow: 2.5 }, { along: 10, across: 4, glow: 2.5 }],
    beam: { along: 13, length: 60, near: 6, spread: 0.3, level: 1 },
  },
  drone: {
    lamps: [{ along: 5, across: 0, glow: 1.5 }],
    beam: { along: 7, length: 40, near: 2, spread: 0.3, level: 0.8 },
  },
  gunship: {
    lamps: [{ along: 10, across: 0, glow: 2.5 }],
    beam: { along: 12, length: 64, near: 4, spread: 0.35, level: 1 },
  },
}

export const UNIT_ART = { mcv, builder, infantry, truck, rocketeer, buggy, lancer, tank, tesla, drone, gunship } satisfies Record<UnitType, UnitArt>
