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

/** Состояние погоды. Только рисуется; на игру пока не влияет. */
export interface WeatherConfig {
  /** Уровень освещения: 0 — ночь, 1 — полдень. */
  light: number
  /** Вектор ветра в тайлах в секунду: +x — вправо, +y — вниз. */
  windX: number
  windY: number
  /** Уровень осадков: 0 — ясно, 1 — буря. Что именно выпадает, зависит от биома. */
  precipitation: number
}

export const DEFAULT_WEATHER_CONFIG: WeatherConfig = {
  // Ночь: в темноте видны фары, огни зданий и вспышки боя.
  light: 0.1,
  windX: 2,
  windY: 0.5,
  precipitation: 0,
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
  weather: WeatherConfig
  battle: BattleConfig
  rules: RulesConfig
}

export const DEFAULT_SETTINGS: MapSettings = {
  generator: DEFAULT_CONFIG,
  world: DEFAULT_WORLD_CONFIG,
  render: DEFAULT_RENDER_CONFIG,
  weather: DEFAULT_WEATHER_CONFIG,
  battle: DEFAULT_BATTLE_CONFIG,
  rules: DEFAULT_RULES,
}

const STORAGE_KEY = 'kharos.mapSettings'
/** Версия сохранённой погоды. Меняется вместе с погодой по умолчанию: тогда сохранённая один раз отбрасывается. */
const WEATHER_VERSION = 2
/** То же для настроек боя: раньше они сохранялись целиком и перекрывали значения из кода. */
const BATTLE_VERSION = 2

/** Берёт из сохранённого только известные числовые поля; остальные остаются по умолчанию. */
function merge<T extends object>(defaults: T, saved: unknown): T {
  const result = { ...defaults }
  if (typeof saved !== 'object' || saved === null) return result
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = (saved as Record<keyof T, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value as T[keyof T]
  }
  return result
}

export function loadSettings(): MapSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return {
      generator: merge(DEFAULT_CONFIG, saved?.generator),
      world: merge(DEFAULT_WORLD_CONFIG, saved?.world),
      render: merge(DEFAULT_RENDER_CONFIG, saved?.render),
      weather: merge(DEFAULT_WEATHER_CONFIG, saved?.weatherVersion === WEATHER_VERSION ? saved.weather : undefined),
      battle: merge(DEFAULT_BATTLE_CONFIG, saved?.battleVersion === BATTLE_VERSION ? saved.battle : undefined),
      rules: merge(DEFAULT_RULES, saved?.rules),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Только те поля, что отличаются от значений по умолчанию: остальные и дальше берутся из кода, даже если он изменится. */
function changed<T extends object>(defaults: T, values: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(defaults) as (keyof T)[]) if (values[key] !== defaults[key]) result[key] = values[key]
  return result
}

export function saveSettings(settings: MapSettings) {
  try {
    const saved = {
      generator: changed(DEFAULT_CONFIG, settings.generator),
      world: changed(DEFAULT_WORLD_CONFIG, settings.world),
      render: changed(DEFAULT_RENDER_CONFIG, settings.render),
      weather: changed(DEFAULT_WEATHER_CONFIG, settings.weather),
      battle: changed(DEFAULT_BATTLE_CONFIG, settings.battle),
      rules: changed(DEFAULT_RULES, settings.rules),
      weatherVersion: WEATHER_VERSION,
      battleVersion: BATTLE_VERSION,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // Хранилище может быть недоступно (приватный режим, запрет в настройках) — тогда просто не сохраняем.
  }
}
