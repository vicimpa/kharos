import type { Pixmap } from '../../render/pixmap'
import type { TurretType, UnitType } from '../../sim'

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
 * в цветах игрока team. phase — кадр анимации хода, от 0 до GAIT_PHASES - 1: на нём колёса, гусеницы и ноги
 * сдвинуты по-своему.
 */
export type UnitArt = (g: Pixmap, angle: number, team: TeamColors, phase: number) => void

/** Чем юнит ходит: от этого зависит анимация хода. */
export type Gait = 'tracks' | 'wheels' | 'legs' | 'air'
export const UNIT_GAITS: Record<UnitType, Gait> = {
  mcv: 'tracks', harvester: 'tracks', builder: 'wheels', infantry: 'legs', truck: 'wheels', rocketeer: 'legs', flamer: 'legs', buggy: 'wheels', flak: 'wheels',
  lancer: 'wheels', tank: 'tracks', artillery: 'wheels', tesla: 'tracks', carrier: 'wheels', drone: 'air', airTruck: 'air', gunship: 'air', bomber: 'air',
}
/**
 * Кадров анимации хода у наземного юнита; у летающего кадр один. Протектор и звенья гусениц повторяются
 * через столько пикселей, и за кадр сдвигаются на пиксель.
 */
export const GAIT_PHASES = 4
/**
 * Сколько тайлов пути проходит юнит за кадр анимации. Колёса и гусеницы сдвигаются на пиксель за пиксель пути:
 * верх гусеницы бежит относительно корпуса с той же скоростью, с какой корпус — по земле. Ноги шагают реже.
 */
export const GAIT_STEP: Record<Gait, number> = { tracks: 1 / 16, wheels: 1 / 16, legs: 0.2, air: Infinity }

/**
 * Следы юнита на земле: колеи от колёс и гусениц или отпечатки ног. sides — где они лежат, в пикселях спрайта вправо
 * от оси юнита; width — их ширина в пикселях. Совпадают с колёсами, гусеницами и ступнями на чертеже.
 */
export const UNIT_TRACES: Partial<Record<UnitType, { sides: number[]; width: number }>> = {
  mcv: { sides: [-8, 8], width: 5 },
  builder: { sides: [-4, 4], width: 3 },
  infantry: { sides: [-1.5, 1.5], width: 1.4 },
  truck: { sides: [-4.5, 4.5], width: 3 },
  harvester: { sides: [-6, 6], width: 4 },
  rocketeer: { sides: [-1.5, 1.5], width: 1.4 },
  buggy: { sides: [-4.5, 4.5], width: 3 },
  flamer: { sides: [-1.5, 1.5], width: 1.4 },
  flak: { sides: [-4.5, 4.5], width: 3 },
  lancer: { sides: [-4.5, 4.5], width: 3 },
  tank: { sides: [-7.5, 7.5], width: 4 },
  artillery: { sides: [-6, 6], width: 3 },
  tesla: { sides: [-7.5, 7.5], width: 4 },
  carrier: { sides: [-9, 9], width: 3.2 },
}

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

type Pen = ReturnType<typeof pen>

/**
 * Поперечные полоски, повторяющиеся через GAIT_PHASES пикселей, на отрезке от from до to вдоль хода: звенья гусеницы
 * или протектор шины. На кадре phase они сдвинуты вперёд на phase пикселей.
 */
function treads(p: Pen, from: number, to: number, across: number, half: number, phase: number, color: number) {
  let along = from + phase
  while (along - GAIT_PHASES >= from) along -= GAIT_PHASES
  for (; along <= to; along += GAIT_PHASES) p.beam(along, across - half, across + half, 1, color)
}

/** Шина: чёрный брусок длиной 2·half вдоль хода, по которому бежит протектор. */
function tire(p: Pen, along: number, across: number, half: number, width: number, phase: number) {
  p.bar(along - half, along + half, across, width, INK)
  treads(p, along - half + 0.5, along + half - 0.5, across, width / 2 - 0.5, phase, IRON[2])
}

/** Ноги пехотинца: на кадрах 1 и 3 одна ступня впереди, другая сзади; на 0 и 2 обе под плечами. */
function legs(p: Pen, phase: number) {
  const stride = phase === 1 ? 2.6 : phase === 3 ? -2.6 : 0
  if (!stride) return
  for (const across of [-1.5, 1.5]) {
    const along = across < 0 ? stride : -stride
    p.dot(along, across, 1.3, INK)
    p.dot(along, across, 0.7, IRON[2])
  }
}

/** MCV: широкая гусеничная машина с кабиной спереди и пушкой будущего ядра на крыше. */
const mcv: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  for (const side of [-8, 8]) {
    p.bar(-13, 13, side, 7, INK)
    p.bar(-12, 12, side, 5, IRON[1])
    treads(p, -12, 12, side, 2.5, phase, IRON[0])
  }
  p.bar(-11, 12, 0, 14, INK)
  p.bar(-10, 11, 0, 12, STEEL[1])
  p.bar(-10, 11, -5, 2, STEEL[2])
  p.bar(6, 11, 0, 10, STEEL[3])
  p.bar(8, 10, 0, 6, team[2])
  // Пушка будущего ядра едет на крыше, стволами вперёд.
  coreGun(p, -3, 15, team)
}

/** Строитель: небольшая колёсная машина со стрелой. */
const builder: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  for (const side of [-4, 4]) {
    for (const wheel of [-3.5, 3.5]) tire(p, wheel, side, 2, 3, phase)
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
const infantry: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  legs(p, phase)
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, team[0])
  p.bar(0, 5, 2.5, 1.2, INK)
  p.dot(0.5, 0, 2, INK)
  p.dot(0.5, 0, 1.2, STEEL[4])
}

/** Грузовик: кабина спереди и открытый кузов с рудой. */
const truck: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  for (const side of [-4.5, 4.5]) {
    for (const wheel of [-5, 0, 5]) tire(p, wheel, side, 1.5, 3, phase)
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
  // Излучатель транспортного луча за кабиной.
  p.dot(2, 0, 1.8, INK)
  p.dot(2, 0, 1.2, 0x5ff2d0)
  p.dot(1.6, -0.4, 0.5, 0xd8fff6)
}

/**
 * Харвестер: на гусеницах, спереди — широкий барабан с зубьями, которые крутятся на ходу, за ним бункер
 * с рудой и кабина. Крупнее грузовика и окрашен в цвет стороны: его ловят в поле, его надо узнавать.
 */
const harvester: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  for (const side of [-6, 6]) {
    p.bar(-9, 7, side, 4, INK)
    treads(p, -8.5, 6.5, side, 1.5, phase, IRON[2])
  }
  p.bar(-9, 6, 0, 9, INK)
  p.bar(-8, 5, 0, 7, team[0])
  // Бункер с рудой.
  p.bar(-7, 0, 0, 6, IRON[1])
  p.bar(-6, -1, 0, 4, 0x6b2f1e)
  p.dot(-4, -1, 1.2, 0xb5562e)
  p.dot(-2.5, 1, 1, 0xe58a4a)
  // Кабина.
  p.bar(1, 5, 2.5, 3, HAZARD[1])
  p.bar(3, 4.5, 2.5, 1.5, team[2])
  // Барабан поперёк хода: зубья бегут по кругу вместе с фазой хода.
  p.beam(9, -7, 7, 3.5, INK)
  p.beam(9, -6.5, 6.5, 2.2, IRON[3])
  for (let tooth = -6 + (phase % 2) * 1.5; tooth <= 6; tooth += 3) p.dot(10, tooth, 0.8, IRON[4])
  p.bar(6, 8, -5, 1.2, INK)
  p.bar(6, 8, 5, 1.2, INK)
  // Излучатель транспортного луча на бункере.
  p.dot(-3, -2.5, 1.5, INK)
  p.dot(-3, -2.5, 1, 0x5ff2d0)
}

/** Ракетчик: пехотинец с трубой на плече. */
const rocketeer: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  legs(p, phase)
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, team[0])
  p.bar(-4, 6, -2.5, 3.2, INK)
  p.bar(-3, 5, -2.5, 1.6, IRON[3])
  p.dot(5.5, -2.5, 1, HAZARD[2])
  p.dot(0.5, 0.5, 2, INK)
  p.dot(0.5, 0.5, 1.2, STEEL[4])
}

/** Огнемётчик: баллоны за спиной, брандспойт в руках и горящий запальник на конце. */
const flamer: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  legs(p, phase)
  // Баллоны за спиной.
  for (const across of [-1.6, 1.6]) {
    p.dot(-2.2, across, 1.6, INK)
    p.dot(-2.2, across, 1, HAZARD[1])
  }
  p.beam(0, -3.5, 3.5, 5, INK)
  p.beam(0, -2.5, 2.5, 3, team[0])
  // Брандспойт и запальник.
  p.bar(-1, 6, 1.8, 2.4, INK)
  p.bar(0, 5, 1.8, 1, IRON[3])
  p.dot(6.2, 1.8, 1.1, 0xff8a2a)
  p.dot(0.5, -0.3, 2, INK)
  p.dot(0.5, -0.3, 1.2, STEEL[4])
}

/** Колёса лёгкой машины: по два с каждого борта. */
function wheels(p: Pen, side: number, spread: number, phase: number) {
  for (const across of [-side, side]) {
    for (const wheel of [-spread, spread]) tire(p, wheel, across, 2, 3, phase)
  }
}

/** Зенитка: лёгкое колёсное шасси с поворотной платформой и спаренной автопушкой, задранной вверх. */
const flak: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  wheels(p, 4.5, 4.5, phase)
  p.bar(-7, 6, 0, 8, INK)
  p.bar(-6, 5, 0, 6, STEEL[1])
  p.bar(-6, 5, -2.5, 1, STEEL[3])
  p.bar(-6, -4, 0, 6, team[0])
  // Платформа и два ствола.
  p.dot(-0.5, 0, 3.6, INK)
  p.dot(-0.5, 0, 2.8, STEEL[2])
  for (const across of [-1.4, 1.4]) {
    p.bar(0, 9, across, 1.8, INK)
    p.bar(1, 8.5, across, 0.8, IRON[4])
  }
  p.dot(-0.5, 0, 1.4, team[1])
}

/** Багги: узкая быстрая машина с дугой безопасности. Пассажира с миниганом рисует gunnerTurret поверх. */
const buggy: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  wheels(p, 4.5, 4, phase)
  p.bar(-6, 7, 0, 7, INK)
  p.bar(-5, 6, 0, 5, IRON[2])
  p.bar(-5, 6, -2, 1, IRON[3])
  p.bar(-5, -3, 0, 5, team[0])
  // Водитель за лобовым стеклом и дуга над ним.
  p.bar(4.5, 6, 0, 4, team[2])
  p.dot(2.5, 0, 1.3, INK)
  p.dot(2.5, 0, 0.8, STEEL[4])
  p.beam(1, -3.5, 3.5, 1, INK)
}

/** Лазерная машина: излучатель на шасси. */
const lancer: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  wheels(p, 4.5, 4.5, phase)
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
function heavyHull(p: Pen, team: TeamColors, phase: number) {
  for (const side of [-7.5, 7.5]) {
    p.bar(-11, 11, side, 6, INK)
    p.bar(-10, 10, side, 4, IRON[1])
    treads(p, -10, 10, side, 2, phase, IRON[0])
  }
  p.bar(-9, 10, 0, 12, INK)
  p.bar(-8, 9, 0, 10, STEEL[1])
  p.bar(-8, 9, -4, 2, STEEL[2])
  p.bar(-8, -6, 0, 10, team[0])
}

/** Танк: гусеницы, корпус и погон под башню. Башня — отдельная турель, её рисует cannonTurret поверх. */
const tank: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  heavyHull(p, team, phase)
  p.bar(6, 9, 0, 8, STEEL[2])
  p.beam(7.5, -3, 3, 1, STEEL[0])
  p.dot(-1, 0, 6.4, INK)
  p.dot(-1, 0, 5.6, STEEL[0])
}

/**
 * Артиллерия: гаубица на колёсном лафете. Две пары колёс, станины с сошниками назад, щит расчёта и длинный ствол
 * с дульным тормозом вперёд — ствол длиннее корпуса, видно издалека.
 */
const artillery: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  // Станины расходятся назад, на концах — сошники.
  p.line(-1, -3, -12, -6, 2.4, INK)
  p.line(-1, 3, -12, 6, 2.4, INK)
  p.line(-1, -3, -11.5, -5.8, 1, IRON[2])
  p.line(-1, 3, -11.5, 5.8, 1, IRON[2])
  p.beam(-12, -7.5, -4.5, 1.6, IRON[3])
  p.beam(-12, 4.5, 7.5, 1.6, IRON[3])
  for (const along of [-3, 3]) for (const across of [-6, 6]) tire(p, along, across, 2.2, 3, phase)
  // Лафет.
  p.bar(-6, 5, 0, 9, INK)
  p.bar(-5, 4, 0, 7, STEEL[1])
  p.bar(-5, 4, -2.8, 1, STEEL[3])
  p.bar(-5, -3, 0, 7, team[0])
  // Щит расчёта.
  p.beam(2.5, -5, 5, 2, INK)
  p.beam(2.5, -4.5, 4.5, 1, STEEL[3])
  // Ствол с дульным тормозом.
  p.bar(-2, 14, 0, 3.4, INK)
  p.bar(-1, 13, 0, 1.8, IRON[3])
  p.bar(-1, 13, -0.6, 0.6, IRON[4])
  p.bar(12.5, 15, 0, 4.2, INK)
  p.bar(13, 14.5, 0, 2.6, IRON[2])
  p.dot(-1.5, 0, 2.6, INK)
  p.dot(-1.5, 0, 1.8, team[1])
}

/** Разрядник: тяжёлое шасси с погоном и кожухами питания. Катушка — отдельная турель, её рисует arcTurret поверх. */
const tesla: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  heavyHull(p, team, phase)
  for (const side of [-3.5, 3.5]) p.bar(5, 9, side, 2, ENERGY[0])
  p.dot(0, 0, 6.6, INK)
  p.dot(0, 0, 5.8, IRON[1])
}

/**
 * Носитель: колёсное шасси танка — по три колеса с борта и плоская палуба с четырьмя гнёздами под турели.
 * Сами турели — отдельные сущности, их рисует turretArt.ts поверх.
 */
const carrier: UnitArt = (g, angle, team, phase) => {
  const p = pen(g, angle)
  for (const side of [-9, 9]) {
    for (const wheel of [-8, 0, 8]) {
      p.bar(wheel - 3, wheel + 3, side, 4.6, INK)
      p.bar(wheel - 2.3, wheel + 2.3, side, 3.2, IRON[1])
      treads(p, wheel - 2.3, wheel + 2.3, side, 1.6, phase, IRON[3])
    }
  }
  p.bar(-12, 12, 0, 15, INK)
  p.bar(-11, 11, 0, 13, STEEL[1])
  p.bar(-11, 11, -5.5, 2, STEEL[2])
  p.bar(-11, -9, 0, 13, team[0])
  p.bar(10, 12, 0, 8, team[2])
  p.beam(0.5, -5.5, 5.5, 1, STEEL[0])
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

/** Летающий грузовик: четыре винта на длинных балках, под ними — грузовой контейнер в жёлто-чёрных полосах. */
const airTruck: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  for (const [along, across] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) {
    p.line(0, 0, along, across, 2.4, INK)
    p.line(0, 0, along, across, 1, IRON[2])
    p.dot(along, across, 3.2, INK)
    p.dot(along, across, 2.2, IRON[3])
    p.dot(along, across, 0.8, IRON[0])
  }
  // Контейнер.
  p.bar(-4.5, 4.5, 0, 8, INK)
  p.bar(-3.5, 3.5, 0, 6, HAZARD[1])
  for (const along of [-2, 1]) p.beam(along, -3, 3, 1, HAZARD[0])
  // Кабина спереди.
  p.bar(4, 7, 0, 4, INK)
  p.bar(4.5, 6.5, 0, 2.4, team[0])
  p.dot(6, -0.6, 0.7, team[2])
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

/** Бомбардировщик: широкое крыло-стрела с двумя моторами, бомбовый отсек на брюхе и двойной хвост. */
const bomber: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  // Крыло-стрела: от носа назад к законцовкам.
  for (const side of [-1, 1]) {
    p.line(4, 0, -6, side * 13, 5, INK)
    p.line(4, 0, -6, side * 12.5, 3, STEEL[1])
    p.line(3, side * 1, -5, side * 11.5, 1, STEEL[3])
    p.dot(-6, side * 12, 1.4, team[0])
    // Мотор на крыле.
    p.bar(-3, 4, side * 6, 3.4, INK)
    p.bar(-2, 3, side * 6, 1.8, IRON[3])
    p.dot(4, side * 6, 1, HAZARD[2])
  }
  // Двойной хвост.
  for (const side of [-3, 3]) {
    p.bar(-12, -7, side, 2.4, INK)
    p.bar(-11, -7, side, 1, STEEL[2])
  }
  // Фюзеляж и бомбовый отсек.
  p.bar(-11, 11, 0, 6, INK)
  p.bar(-10, 10, 0, 4, STEEL[2])
  p.bar(-10, 10, -1.5, 1, STEEL[3])
  p.bar(-5, 3, 0, 3, INK)
  p.bar(-4, 2, 0, 1.6, HAZARD[1])
  p.bar(-10, -7, 0, 4, team[0])
  p.bar(6, 10, 0, 2.6, team[2])
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
  harvester: {
    lamps: [{ along: 7, across: -4, glow: 2 }, { along: 7, across: 4, glow: 2 }],
    beam: { along: 12, length: 56, near: 5, spread: 0.32, level: 1 },
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
  flamer: {
    lamps: [{ along: 6, across: 1.5, glow: 1.5 }],
    beam: { along: 7, length: 30, near: 1.5, spread: 0.25, level: 0.8 },
  },
  flak: {
    lamps: [{ along: 7, across: -2.5, glow: 2 }, { along: 7, across: 2.5, glow: 2 }],
    beam: { along: 10, length: 56, near: 4, spread: 0.3, level: 1 },
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
  artillery: {
    lamps: [{ along: 6, across: -3, glow: 2 }, { along: 6, across: 3, glow: 2 }],
    beam: { along: 9, length: 52, near: 4, spread: 0.3, level: 1 },
  },
  tesla: {
    lamps: [{ along: 10, across: -4, glow: 2.5 }, { along: 10, across: 4, glow: 2.5 }],
    beam: { along: 13, length: 60, near: 6, spread: 0.3, level: 1 },
  },
  carrier: {
    lamps: [{ along: 12, across: -4.5, glow: 2.5 }, { along: 12, across: 4.5, glow: 2.5 }],
    beam: { along: 15, length: 60, near: 6, spread: 0.3, level: 1 },
  },
  airTruck: {
    lamps: [{ along: 7, across: 0, glow: 1.5 }],
    beam: { along: 8, length: 44, near: 2, spread: 0.3, level: 0.8 },
  },
  drone: {
    lamps: [{ along: 5, across: 0, glow: 1.5 }],
    beam: { along: 7, length: 40, near: 2, spread: 0.3, level: 0.8 },
  },
  bomber: {
    lamps: [{ along: 9, across: -6, glow: 2 }, { along: 9, across: 6, glow: 2 }],
    beam: { along: 13, length: 56, near: 4, spread: 0.32, level: 0.9 },
  },
  gunship: {
    lamps: [{ along: 10, across: 0, glow: 2.5 }],
    beam: { along: 12, length: 64, near: 4, spread: 0.35, level: 1 },
  },
}

export const UNIT_ART = { mcv, builder, infantry, truck, harvester, rocketeer, flamer, buggy, flak, lancer, tank, artillery, tesla, carrier, drone, airTruck, gunship, bomber } satisfies Record<UnitType, UnitArt>

/** Сторона кадра турели в пикселях: два тайла, чтобы влез длинный ствол. */
export const TURRET_FRAME = 32

/** Танковая башня: круглая, с люком и длинным стволом с дульным тормозом. */
const cannonTurret: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.bar(2, 13, 0, 3.6, INK)
  p.bar(2, 12.5, 0, 1.6, IRON[3])
  p.bar(11.5, 14, 0, 4.4, INK)
  p.bar(12, 13.5, 0, 2.6, IRON[2])
  p.dot(0, 0, 5.4, INK)
  p.dot(0, 0, 4.4, STEEL[2])
  p.dot(-1, 0, 3.4, team[0])
  p.dot(-1.5, -1.5, 1.6, team[1])
  p.dot(-2, 1.5, 1, IRON[4])
}

/** Ракетная турель: квадратный блок с двумя пусковыми трубами. */
const rocketTurret: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.bar(-3, 3, 0, 6.4, INK)
  p.bar(-2.4, 2.4, 0, 5, team[0])
  p.bar(-2.4, -1.2, 0, 5, team[1])
  for (const side of [-1.5, 1.5]) {
    p.bar(0, 6, side, 2.2, INK)
    p.bar(0.5, 5.5, side, 1, IRON[4])
    p.dot(5.6, side, 0.6, HAZARD[2])
  }
}

/** Ремонтная турель: жёлтый купол с рукой-излучателем. */
const repairTurret: UnitArt = (g, angle) => {
  const p = pen(g, angle)
  p.bar(0, 5.5, 0, 2.2, INK)
  p.bar(0, 5, 0, 1, IRON[3])
  p.dot(5.6, 0, 1.5, INK)
  p.dot(5.6, 0, 0.9, 0x7dffa8)
  p.dot(-0.5, 0, 3.4, INK)
  p.dot(-0.5, 0, 2.6, HAZARD[1])
  p.dot(-1.2, -0.8, 1, HAZARD[2])
}

/** Разрядная башня: катушка на кольце и два электрода вперёд со светящимися концами. */
const arcTurret: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  for (const side of [-2.6, 2.6]) {
    p.bar(2, 11, side, 2.6, INK)
    p.bar(2, 10, side, 1.2, IRON[3])
    p.dot(11, side, 1.4, ENERGY[1])
    p.dot(11, side, 0.6, ENERGY[2])
  }
  p.dot(0, 0, 5.4, INK)
  p.dot(0, 0, 4.6, IRON[2])
  p.beam(-3.5, -2.5, 2.5, 1.4, team[0])
  p.dot(0, 0, 3.4, INK)
  p.dot(0, 0, 2.6, ENERGY[0])
  p.dot(0, 0, 1.2, ENERGY[2])
}

/** Пассажир багги: плечи и шлем в цвет команды, миниган — светлый блок стволов с жёлтым дульным срезом. */
const gunnerTurret: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.beam(0, -3.6, 3.6, 4.4, INK)
  p.beam(0, -2.8, 2.8, 2.8, team[1])
  p.bar(0, 7.5, 1.8, 3, INK)
  p.bar(1, 7, 1.8, 1.4, IRON[4])
  p.dot(7.2, 1.8, 0.8, HAZARD[2])
  p.dot(-1, -0.6, 1.5, INK)
  p.dot(-1, -0.6, 0.9, team[2])
}

/**
 * Пушка главного здания: широкий купол цвета команды с линзой и спаренный излучатель с голубыми концами. Купол —
 * along пикселей вперёд от центра, стволы длиной reach. Та же пушка стоит на крыше главного здания и на MCV.
 */
function coreGun(p: Pen, along: number, reach: number, team: TeamColors) {
  for (const side of [-2.2, 2.2]) {
    p.bar(along + 2, along + reach, side, 2.8, INK)
    p.bar(along + 2.5, along + reach - 0.5, side, 1.4, IRON[3])
    p.dot(along + reach, side, 1.3, ENERGY[1])
    p.dot(along + reach, side, 0.6, ENERGY[2])
  }
  p.dot(along, 0, 7.2, INK)
  p.dot(along, 0, 6.2, STEEL[2])
  p.dot(along - 0.8, 0, 4.8, team[0])
  p.dot(along - 1.8, -1.8, 2, team[1])
  p.dot(along + 2.2, 0, 1.8, INK)
  p.dot(along + 2.2, 0, 1.1, ENERGY[0])
}

/** Лазерная турель: купол цвета команды и один излучатель с голубой линзой на конце. */
const laserTurret: UnitArt = (g, angle, team) => {
  const p = pen(g, angle)
  p.bar(1, 10, 0, 2.6, INK)
  p.bar(1.5, 9.5, 0, 1.2, IRON[3])
  p.dot(10, 0, 1.4, ENERGY[1])
  p.dot(10, 0, 0.7, ENERGY[2])
  p.dot(0, 0, 4.6, INK)
  p.dot(0, 0, 3.8, STEEL[2])
  p.dot(-0.6, 0, 2.8, team[0])
  p.dot(-1.2, -1.2, 1.1, team[1])
}

const coreTurret: UnitArt = (g, angle, team) => coreGun(pen(g, angle), 0, 14, team)

export const TURRET_ART = { gunner: gunnerTurret, arc: arcTurret, cannon: cannonTurret, rocket: rocketTurret, repair: repairTurret, laser: laserTurret, core: coreTurret } satisfies Record<TurretType, UnitArt>
