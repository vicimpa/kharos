/** Класс юнита: от него зависит, каким оружием его бить. Летающие — air: по ним достаёт не всякое оружие. */
export type UnitClass = 'infantry' | 'vehicle' | 'heavy' | 'air'
/** По чему пришёлся урон: класс юнита или здание. */
export type Armor = UnitClass | 'building'

/**
 * Чем стреляет оружие. Пуля, ракета и ядро летят и бьют, долетев; лазер и разряд бьют мгновенно.
 * Как это выглядит, знает клиент: см. game/combatPass.ts.
 */
export type ShotKind = 'bullet' | 'shell' | 'rocket' | 'laser' | 'arc'

export interface WeaponSpec {
  shot: ShotKind
  /** Дальность в тайлах: до края цели. */
  range: number
  /** Урон одного попадания в единицах прочности. */
  damage: number
  /** Сколько секунд между выстрелами. */
  reload: number
  /** Скорость снаряда в тайлах в секунду. Нет — попадание мгновенное. */
  speed?: number
  /** Радиус взрыва в тайлах: достаётся всем врагам в нём, у края — вполовину. Нет — только цели. */
  splash?: number
  /** Разряд перескакивает на столько соседних врагов, слабея с каждым прыжком. */
  chain?: number
  /** Мёртвая зона: ближе стольких тайлов оружие не стреляет. Нет — стреляет в упор. */
  minRange?: number
  /** Навесной выстрел: снаряд перелетает стены. */
  lob?: boolean
  /** Достаёт ли до летающих. */
  air: boolean
  /** Во сколько раз урон по такой цели отличается от обычного; чего нет — единица. */
  vs?: Partial<Record<Armor, number>>
  /**
   * Сколько боеприпасов тратит выстрел оборонительной турели (BuildingSpec.ammo); юниты стреляют бесплатно.
   * Подобрано так, что непрерывно стреляющая турель любого вида тратит ~3 боеприпаса в секунду: одна линия
   * металла (10 боеприпасов в секунду через цех) держит 3 турели под огнём (§3.7 design.md).
   */
  ammo?: number
}

/**
 * Оружие делит цели по классу брони: у каждого вида есть те, кого он бьёт хорошо, и те, против кого слаб.
 * Так складывается боевой треугольник (см. docs/gameplay.md). Настроить его помогает `bun run balance`.
 */
export const WEAPONS = {
  // Пули: часто и слабо, хороши против пехоты, по броне и стенам почти бесполезны.
  rifle: { shot: 'bullet', range: 4.5, damage: 5, reload: 0.4, speed: 24, air: true, vs: { vehicle: 0.5, heavy: 0.25, building: 0.2 } },
  machinegun: { shot: 'bullet', range: 5, damage: 6, reload: 0.18, speed: 26, air: true, vs: { vehicle: 0.5, heavy: 0.25, building: 0.2 }, ammo: 0.5 },
  // Ядро летит быстро и прямо в точку, где цель была при выстреле: от него можно уехать. Бьёт по площади.
  cannon: { shot: 'shell', range: 7, damage: 60, reload: 2.5, speed: 18, splash: 1.5, air: false, vs: { infantry: 0.6 }, ammo: 8 },
  // Ракета бьёт дальше прочей техники и достаёт и технику, и летающих: этим оружием встречают лёгкую броню и авиацию.
  launcher: { shot: 'rocket', range: 6.5, damage: 36, reload: 2, speed: 8, splash: 0.7, air: true, vs: { infantry: 0.3, heavy: 0.8, air: 1.5 }, ammo: 6 },
  // Лазер попадает сразу и всегда и лучше всех пробивает тяжёлую броню: это оружие против танков.
  laser: { shot: 'laser', range: 7.5, damage: 28, reload: 1.1, air: true, vs: { heavy: 1.6, building: 0.5 } },
  // Гаубица: навесом через стены и дальше турелей, тяжёлым снарядом по площади, вдвое сильнее по зданиям.
  // Вблизи — мёртвая зона: до подошедшего врага ей не достать. Осадное оружие.
  artillery: { shot: 'shell', range: 11, minRange: 3, damage: 70, reload: 4, speed: 8, splash: 1.8, lob: true, air: false, vs: { building: 2, infantry: 0.6, vehicle: 0.4, heavy: 0.5 } },
  // Разряд бьёт цель и перескакивает на соседей: против толпы.
  arc: { shot: 'arc', range: 4.5, damage: 46, reload: 2, chain: 2, air: false, vs: { infantry: 1.5, building: 0.4 } },
} satisfies Record<string, WeaponSpec>

export type WeaponType = keyof typeof WEAPONS
