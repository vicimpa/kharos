import acme from 'acme-client'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Настройки TLS из settings.json. */
export interface TlsSettings {
  /** off — обычный ws; auto — сертификат Let's Encrypt сам; files — свои cert и key. */
  mode: string
  /** Домен для auto; пусто — имя sslip.io по внешнему IP. */
  domain: string
  /** Почта для Let's Encrypt: туда пишут, если сертификат не продлился. Можно оставить пустой. */
  email: string
  /** Файлы сертификата и ключа для files. */
  cert: string
  key: string
  /** Папка, где auto хранит ключ аккаунта и выданный сертификат. */
  dir: string
  /** Порт для проверки Let's Encrypt: он стучится только на 80. */
  challengePort: number
  /** Тестовый Let's Encrypt: сертификат недоверенный, зато нет лимитов. */
  staging: boolean
}

export const DEFAULT_TLS: TlsSettings = {
  mode: 'off',
  domain: '',
  email: '',
  cert: '',
  key: '',
  dir: 'tls',
  challengePort: 80,
  staging: false,
}

export const TLS_MODES = ['off', 'auto', 'files']

/** Сертификат за сколько дней до конца продлевается. */
const RENEW_DAYS = 30
/** Как часто проверяется, не пора ли продлить или перечитать сертификат. */
export const TLS_CHECK_INTERVAL = 12 * 60 * 60 * 1000

export interface Certificate {
  cert: string
  key: string
}

/** Имя sslip.io для IP: 1.2.3.4 → 1-2-3-4.sslip.io, оно само указывает на этот адрес. */
export const sslipName = (ip: string) => `${ip.replaceAll('.', '-')}.sslip.io`

/** Пора ли продлевать сертификат, который действует до notAfter. */
export const needsRenewal = (notAfter: Date, now = new Date()) => notAfter.getTime() - now.getTime() < RENEW_DAYS * 24 * 60 * 60 * 1000

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Внешний IPv4 сервера: спрашивает у пары сервисов по очереди. */
export async function externalIp(): Promise<string> {
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip']) {
    try {
      const text = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()).trim()
      if (IPV4.test(text)) return text
    } catch {}
  }
  throw new Error('не удалось узнать внешний IP: укажи tls.domain в настройках')
}

/** Домен для auto: из настроек или по внешнему IP. */
export const tlsDomain = async (tls: TlsSettings) => tls.domain || sslipName(await externalIp())

/** Пишет через временный файл, как и сохранение мира. */
function writeAtomic(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

/** Сертификат из своих файлов (режим files). */
export function readCertificate(tls: TlsSettings): Certificate {
  if (!tls.cert || !tls.key) throw new Error('tls.mode = files: укажи tls.cert и tls.key')
  return { cert: readFileSync(tls.cert, 'utf8'), key: readFileSync(tls.key, 'utf8') }
}

/**
 * Сертификат для домена от Let's Encrypt (режим auto). Лежащий в tls.dir отдаётся как есть, пока до конца
 * больше RENEW_DAYS дней; иначе выпускается новый. Let's Encrypt проверяет домен по HTTP на challengePort:
 * на время проверки там поднимается маленький сервер.
 */
export async function obtainCertificate(tls: TlsSettings, domain: string, log = console.log): Promise<Certificate> {
  mkdirSync(tls.dir, { recursive: true })
  const certPath = join(tls.dir, `${domain}.crt`)
  const keyPath = join(tls.dir, `${domain}.key`)
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8')
    if (!needsRenewal(acme.crypto.readCertificateInfo(cert).notAfter)) return { cert, key: readFileSync(keyPath, 'utf8') }
  }

  const accountPath = join(tls.dir, tls.staging ? 'account-staging.key' : 'account.key')
  if (!existsSync(accountPath)) writeAtomic(accountPath, (await acme.crypto.createPrivateKey()).toString())
  const client = new acme.Client({
    directoryUrl: tls.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: readFileSync(accountPath, 'utf8'),
  })

  const tokens = new Map<string, string>()
  const prefix = '/.well-known/acme-challenge/'
  const challenge = Bun.serve({
    port: tls.challengePort,
    fetch(request) {
      const path = new URL(request.url).pathname
      const answer = path.startsWith(prefix) && tokens.get(path.slice(prefix.length))
      return answer ? new Response(answer) : new Response('Kharos\n', { status: 404 })
    },
  })
  try {
    log(`получаю сертификат для ${domain}${tls.staging ? ' (тестовый)' : ''}`)
    const [key, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] })
    const cert = await client.auto({
      csr,
      email: tls.email || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_, item, keyAuthorization) => void tokens.set(item.token, keyAuthorization),
      challengeRemoveFn: async (_, item) => void tokens.delete(item.token),
    })
    writeAtomic(keyPath, key.toString())
    writeAtomic(certPath, cert)
    log(`сертификат для ${domain} получен, действует до ${acme.crypto.readCertificateInfo(cert).notAfter.toISOString().slice(0, 10)}`)
    return { cert, key: key.toString() }
  } finally {
    challenge.stop(true)
  }
}
