import { DEFAULT_CONFIG, type GeneratorConfig } from './terrain'

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
  light: 1,
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

export interface MapSettings {
  generator: GeneratorConfig
  world: WorldConfig
  render: RenderConfig
  weather: WeatherConfig
}

export const DEFAULT_SETTINGS: MapSettings = {
  generator: DEFAULT_CONFIG,
  world: DEFAULT_WORLD_CONFIG,
  render: DEFAULT_RENDER_CONFIG,
  weather: DEFAULT_WEATHER_CONFIG,
}

const STORAGE_KEY = 'kharos.mapSettings'

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
      weather: merge(DEFAULT_WEATHER_CONFIG, saved?.weather),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: MapSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Хранилище может быть недоступно (приватный режим, запрет в настройках) — тогда просто не сохраняем.
  }
}
