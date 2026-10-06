import { DEFAULT_CONFIG, type GeneratorConfig } from './terrain'
import { DEFAULT_RULES, type Rules } from '../sim'

/** Параметры отрисовки: меняют только картинку, мир при этом не перегенерируется. */
export interface RenderConfig {
  /** Насколько часто встречаются поля барханов в эрге и в красных пустошах: 0 — нет совсем, 1 — сплошь. */
  ergDunes: number
  redDunes: number
  /** Отступ барханов от скал и болот: 0 — вплотную, больше — только в глубине песков. */
  duneMargin: number
}

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  ergDunes: 0.6,
  redDunes: 0.37,
  duneMargin: 0.3,
}

/** Параметры мира, не относящиеся к генератору местности. Их смена, как и смена генератора, начинает мир заново. */
export interface WorldConfig {
  /** Сторона карты в тайлах. Временная мера: с окончательным размером мира определимся позже. */
  size: number
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  size: 1024,
}

/**
 * Параметры случайного боя. Действуют со следующего боя: идущий не прерывают.
 * Поля с именами юнитов — насколько часто тип попадает в армию: 0 — не попадает совсем.
 */
export interface BattleConfig {
  /** Сколько кредитов стоит армия каждой стороны. */
  budget: number
  /** На сколько тайлов от точки встречи стоит передний ряд каждой стороны. */
  gap: number
  /** 1 — у сторон одинаковый состав, 0 — у каждой свой. */
  mirror: number
  infantry: number
  rocketeer: number
  buggy: number
  lancer: number
  tank: number
  tesla: number
  carrier: number
  drone: number
  gunship: number
}

export const DEFAULT_BATTLE_CONFIG: BattleConfig = {
  budget: 3500,
  gap: 6,
  mirror: 0,
  infantry: 1,
  rocketeer: 1,
  buggy: 1,
  lancer: 1,
  tank: 1,
  tesla: 1,
  carrier: 1,
  drone: 1,
  gunship: 1,
}

/** Правила симуляции: меняются на ходу, мир при этом не начинается заново. */
export type RulesConfig = Rules

export interface MapSettings {
  generator: GeneratorConfig
  world: WorldConfig
  render: RenderConfig
  battle: BattleConfig
  rules: RulesConfig
}

export const DEFAULT_SETTINGS: MapSettings = {
  generator: DEFAULT_CONFIG,
  world: DEFAULT_WORLD_CONFIG,
  render: DEFAULT_RENDER_CONFIG,
  battle: DEFAULT_BATTLE_CONFIG,
  rules: DEFAULT_RULES,
}
