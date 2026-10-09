import { DEFAULT_CONFIG, type GeneratorConfig } from '../src/map/terrain'
import { DEFAULT_PORT } from '../src/net/protocol'
import { DEFAULT_RULES, type Rules } from '../src/sim'
import { DEFAULT_WEATHER, type WeatherOptions } from '../src/sim/weather'
import { DEFAULT_TLS, type TlsSettings } from './tls'

/** Настройки сервера из settings.json. */
export interface ServerSettings {
  port: number
  /** Пароль на вход; пустой — заходит кто угодно. */
  password: string
  /** Пароль режима администратора, /admin в чате; пустой — режима нет. */
  admin: string
  /** Файл сохранения мира, двоичный, см. src/save/file.ts. */
  save: string
  /** Сторона карты в тайлах. Как и generator, fog и weather, действует только на новый мир. */
  size: number
  /** Туман войны. */
  fog: boolean
  generator: GeneratorConfig
  weather: WeatherOptions
  /** Правила игры. В отличие от остального применяются и к миру из сохранения. */
  rules: Rules
  /** wss: off, auto (Let's Encrypt) или files (свои сертификат и ключ). */
  tls: TlsSettings
}

/** Настройки по умолчанию; seed у каждого нового сервера свой. */
export const defaultSettings = (): ServerSettings => ({
  port: DEFAULT_PORT,
  password: '',
  admin: '',
  save: 'save.kharos',
  size: 256,
  fog: true,
  generator: { ...DEFAULT_CONFIG, seed: Math.floor(Math.random() * 2 ** 31) },
  weather: { ...DEFAULT_WEATHER },
  rules: { ...DEFAULT_RULES },
  tls: { ...DEFAULT_TLS },
})

/**
 * Накладывает прочитанное из файла на значения по умолчанию. Берёт только известные ключи того же типа, что
 * и по умолчанию; про остальное пишет в warnings, чтобы опечатка не пропала молча.
 */
export function mergeSettings(defaults: ServerSettings, source: unknown, warnings: string[] = []): ServerSettings {
  const merge = <T extends object>(base: T, value: unknown, path: string): T => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warnings.push(`${path || 'настройки'}: ожидался объект`)
      return base
    }
    const result = { ...base } as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) {
      const name = path ? `${path}.${key}` : key
      if (!(key in base)) warnings.push(`${name}: неизвестный параметр`)
      else if (typeof result[key] === 'object') result[key] = merge(result[key] as object, item, name)
      else if (typeof item !== typeof result[key] || (typeof item === 'number' && !Number.isFinite(item))) warnings.push(`${name}: ожидалось ${typeof result[key]}`)
      else result[key] = item
    }
    return result as T
  }
  return merge(defaults, source, '')
}
