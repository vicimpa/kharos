import { hash } from '../map/terrain'
import type { SimOptions } from './sim'

/**
 * Погода мира: смена дня и ночи и медленно бродящие ветер и осадки. Состояния у неё нет — это функция параметров
 * мира и времени, поэтому хост и все клиенты видят одну и ту же погоду, а в сохранение попадают только параметры.
 * Пока только рисуется; на игру не влияет.
 */
export interface WeatherOptions {
  /** Сколько секунд игры длятся сутки; 0 — время стоит. */
  dayLength: number
  /** Который час в начале мира, от 0 до 24. */
  startHour: number
  /** Меняются ли ветер и осадки; false — всегда ясно и лёгкий ветер. */
  changes: boolean
}

export const DEFAULT_WEATHER: WeatherOptions = { dayLength: 1200, startHour: 9, changes: true }

export interface Weather {
  /** Который час, от 0 до 24. */
  hour: number
  /** Освещение: 0 — ночь, 1 — полдень. */
  light: number
  /** Ветер в тайлах в секунду: +x — вправо, +y — вниз. */
  windX: number
  windY: number
  /** Осадки: 0 — ясно, 1 — буря. Что именно выпадает, зависит от биома. */
  precipitation: number
}

/** Освещение глубокой ночью: в темноте видны фары, огни зданий и вспышки боя. */
const NIGHT_LIGHT = 0.1
/** За сколько секунд игры ветер и осадки заметно меняются: погода бродит медленно. */
const WIND_PERIOD = 300
const RAIN_PERIOD = 900
/** Сильнейший ветер, тайлов в секунду, и ветер, когда погода не меняется. */
const WIND_MAX = 3
const CALM_WIND = { x: 1.5, y: 0.4 }
/** Сколько времени идут осадки: шум выше этого порога — дождь или снег, ниже — ясно. */
const RAIN_THRESHOLD = 0.55

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Гладкий шум Перлина по одной оси: от -1 до 1, одно и то же значение для одних t и канала. */
function perlin(t: number, seed: number, channel: number) {
  const i = Math.floor(t)
  const f = t - i
  const gradient = (cell: number) => hash(cell, channel, seed) * 2 - 1
  const a = gradient(i) * f
  const b = gradient(i + 1) * (f - 1)
  // Наклоны в узлах не больше единицы, и сумма двух половинок держится в пределах ±0,5: растягиваем до ±1.
  return Math.max(-1, Math.min(1, (a + (b - a) * smooth(f)) * 2))
}

/** Два слоя шума: крупные перемены и мелкая рябь поверх. */
const drift = (t: number, seed: number, channel: number) => perlin(t, seed, channel) * 0.75 + perlin(t * 3.1, seed, channel + 7) * 0.25

export const weatherOptionsOf = (options: SimOptions): WeatherOptions => ({ ...DEFAULT_WEATHER, ...options.weather })

/** Погода мира с параметрами options через seconds секунд игры от его начала. */
export function weatherAt(options: SimOptions, seconds: number): Weather {
  const { dayLength, startHour, changes } = weatherOptionsOf(options)
  const hour = (((startHour + (dayLength > 0 ? (seconds / dayLength) * 24 : 0)) % 24) + 24) % 24
  // Солнце: выше нуля — день; сумерки мягкие, полдень — ярче всего.
  const sun = Math.sin(((hour - 6) / 12) * Math.PI)
  const day = smooth(Math.max(0, Math.min(1, (sun + 0.2) / 0.6)))
  const light = NIGHT_LIGHT + (1 - NIGHT_LIGHT) * day
  if (!changes) return { hour, light, windX: CALM_WIND.x, windY: CALM_WIND.y, precipitation: 0 }

  const seed = options.generator.seed
  const rain = (drift(seconds / RAIN_PERIOD, seed, 3) + 1) / 2
  const precipitation = Math.max(0, Math.min(1, (rain - RAIN_THRESHOLD) / (1 - RAIN_THRESHOLD) * 1.5))
  // В непогоду ветер крепче.
  const strength = WIND_MAX * (0.5 + 0.5 * precipitation)
  return {
    hour,
    light: light * (1 - 0.35 * precipitation),
    windX: drift(seconds / WIND_PERIOD, seed, 1) * strength,
    windY: drift(seconds / WIND_PERIOD, seed, 2) * strength * 0.6,
    precipitation,
  }
}
