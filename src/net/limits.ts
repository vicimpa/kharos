/** Ведро жетонов: пропускает в среднем rate раз в секунду, а разом — не больше burst. now — часы в мс. */
export function createBucket(rate: number, burst: number, now: () => number = Date.now) {
  let tokens = burst
  let last = now()
  return {
    /** Берёт жетон; false — жетонов нет, действие пропускать нельзя. */
    take() {
      const time = now()
      tokens = Math.min(burst, tokens + ((time - last) / 1000) * rate)
      last = time
      if (tokens < 1) return false
      tokens--
      return true
    },
  }
}

/** Ограничения на подключения с одного адреса. Ноль снимает ограничение. */
export interface ConnectLimits {
  /** Сколько подключений с одного адреса держится разом. */
  connections: number
  /** Сколько попыток подключиться с одного адреса проходит в минуту. */
  connectsPerMinute: number
  /** Сколько новых игроков с одного адреса заводится в час: каждый занимает место на карте. */
  newPlayersPerHour: number
}

export const DEFAULT_LIMITS: ConnectLimits = { connections: 8, connectsPerMinute: 30, newPlayersPerHour: 5 }

/** Больше скольких адресов привратник не помнит: дальше забывает те, с которых сейчас никто не подключён. */
const REMEMBERED = 10000

/**
 * Привратник сервера: считает подключения по адресам, чтобы один адрес не занял все места, не завалил сервер
 * попытками входа (заодно так не подобрать пароль) и не засеял карту новыми игроками.
 */
export function createGate(limits: ConnectLimits, now: () => number = Date.now) {
  const bucket = (perSecond: number, burst: number) => (burst > 0 ? createBucket(perSecond, burst, now) : { take: () => true })
  const addresses = new Map<string, { open: number; attempts: { take(): boolean }; fresh: { take(): boolean } }>()
  const of = (address: string) => {
    let entry = addresses.get(address)
    if (!entry) {
      if (addresses.size >= REMEMBERED) for (const [key, other] of addresses) if (!other.open) addresses.delete(key)
      entry = { open: 0, attempts: bucket(limits.connectsPerMinute / 60, limits.connectsPerMinute), fresh: bucket(limits.newPlayersPerHour / 3600, limits.newPlayersPerHour) }
      addresses.set(address, entry)
    }
    return entry
  }
  return {
    /** Попытка подключиться с адреса; false — слишком часто или уже слишком много подключений. */
    admit(address: string) {
      const entry = of(address)
      return entry.attempts.take() && (!limits.connections || entry.open < limits.connections)
    },
    /** Можно ли завести с адреса ещё одного нового игрока. */
    newcomer: (address: string) => of(address).fresh.take(),
    opened(address: string) {
      of(address).open++
    },
    closed(address: string) {
      const entry = addresses.get(address)
      if (entry) entry.open = Math.max(0, entry.open - 1)
    },
  }
}

/**
 * Адрес клиента. forwarded — заголовок X-Forwarded-For: ему верят, только когда подключился свой же прокси
 * (direct — петля), и берут из него последний адрес — его дописал прокси, остальное мог прислать сам клиент.
 */
export function clientAddress(direct: string | undefined, forwarded: string | null) {
  const local = direct === undefined || direct === '::1' || direct.startsWith('127.') || direct.startsWith('::ffff:127.')
  const last = forwarded?.split(',').pop()?.trim()
  return (local && last) || direct || 'unknown'
}
