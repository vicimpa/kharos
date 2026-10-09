import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHost, type HostSave, type Peer } from '../src/net/host'
import { PROTOCOL_VERSION, versionMismatch, type ServerMessage } from '../src/net/protocol'
import { createSim } from '../src/sim'
import { decodeSave, encodeSave, readJson } from '../src/save/file'
import { defaultSettings, mergeSettings, type ServerSettings } from './settings'
import { TLS_CHECK_INTERVAL, TLS_MODES, obtainCertificate, readCertificate, tlsDomain, type Certificate } from './tls'

/** Как часто сервер пишет в консоль, что с ним происходит, в секундах. */
const REPORT_INTERVAL = 5
/** Как часто сервер сохраняет мир, в секундах. */
const SAVE_INTERVAL = 30
/** Файл настроек; переменная SETTINGS меняет путь. */
const SETTINGS_PATH = process.env.SETTINGS || 'settings.json'

/** Настройки из файла; нет файла — он создаётся со всеми параметрами по умолчанию, чтобы было что править. */
function readSettings(): ServerSettings {
  const defaults = defaultSettings()
  if (!existsSync(SETTINGS_PATH)) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2) + '\n')
    console.log(`настройки по умолчанию записаны в ${SETTINGS_PATH}`)
    return defaults
  }
  const warnings: string[] = []
  const settings = mergeSettings(defaults, JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')), warnings)
  for (const warning of warnings) console.log(`${SETTINGS_PATH}: ${warning} — пропущено`)
  return settings
}

const settings = readSettings()
// Переменные окружения сильнее файла: так удобнее в docker и systemd.
const port = Number(process.env.PORT) || settings.port
const SAVE_PATH = process.env.SAVE || settings.save

/**
 * Мир из сохранения, поднятый до этой версии игры. Файл, который не читается (прежний JSON, более новая версия,
 * повреждён), откладывается в сторону, и мир начинается заново: молча перезаписать его значило бы потерять старый.
 */
async function load(): Promise<HostSave | undefined> {
  if (!existsSync(SAVE_PATH)) return undefined
  try {
    const { save, sections } = await decodeSave(new Uint8Array(readFileSync(SAVE_PATH)))
    const host = readJson<Omit<HostSave, 'sim'>>(sections.get('HOST')) ?? { players: {}, names: {} }
    return { ...host, sim: save }
  } catch (error) {
    const aside = `${SAVE_PATH}.${Date.now()}.old`
    renameSync(SAVE_PATH, aside)
    console.log(`сохранение не читается (${error instanceof Error ? error.message : error}), отложено в ${aside}, мир начинается заново`)
    return undefined
  }
}

/** Идущая запись: следующая ждёт её, чтобы файлы не легли вперемешку. */
let storing: Promise<void> = Promise.resolve()

/** Пишет во временный файл и подменяет им сохранение: упавший посреди записи сервер не оставит половину файла. */
function store() {
  const { sim, ...rest } = host.save()
  storing = storing.then(async () => {
    const temporary = `${SAVE_PATH}.tmp`
    writeFileSync(temporary, await encodeSave(sim, { HOST: rest }))
    renameSync(temporary, SAVE_PATH)
  })
  return storing
}

const saved = await load()
// Карта и погода у сохранённого мира свои, а правила — из настроек: их можно менять между запусками.
const { generator, size, fog, weather, rules } = settings
const host = createHost(saved ? createSim({ ...saved.sim, rules }) : createSim({ generator, size, fog, weather, rules }), undefined, saved, {
  admin: settings.admin,
  log: (text) => console.log(text),
})
if (saved) console.log(`мир загружен из ${SAVE_PATH}: тик ${saved.sim.tick}, игроков ${Object.keys(saved.players).length}`)
else console.log(`новый мир ${size}×${size}, seed ${generator.seed}`)

type SocketData = { id?: string; name?: string; password: string; version: number; peer?: Peer }

/** Совпадает ли пароль; сравнение за одно и то же время, чтобы его нельзя было подбирать по задержке ответа. */
const digest = (text: string) => createHash('sha256').update(text).digest()
const passwordOk = (password: string) => !settings.password || timingSafeEqual(digest(password), digest(settings.password))

const { tls } = settings
if (!TLS_MODES.includes(tls.mode)) throw new Error(`tls.mode: ${tls.mode}? ожидалось ${TLS_MODES.join(', ')}`)
const domain = tls.mode === 'auto' ? await tlsDomain(tls) : undefined
const certificate = async (): Promise<Certificate | undefined> =>
  tls.mode === 'auto' ? obtainCertificate(tls, domain!) : tls.mode === 'files' ? readCertificate(tls) : undefined

const listen = (certificate?: Certificate) => Bun.serve<SocketData>({
  port,
  tls: certificate,
  fetch(request, server) {
    const query = new URL(request.url).searchParams
    const data = { id: query.get('id') ?? undefined, name: query.get('name') ?? undefined, password: query.get('password') ?? '', version: Number(query.get('version')) || 0 }
    if (server.upgrade(request, { data })) return undefined
    return new Response('Kharos: сюда подключаются по WebSocket\n', { status: 426 })
  },
  websocket: {
    // Снимки мира — JSON, который почти не меняется от тика к тику: deflate ужимает его в разы.
    perMessageDeflate: true,
    open(socket) {
      // Клиент другой версии собрал бы мир не так, как сервер: его не пускают, но говорят почему.
      if (socket.data.version !== PROTOCOL_VERSION) {
        const reason = versionMismatch(PROTOCOL_VERSION, socket.data.version)
        socket.send(JSON.stringify({ type: 'refused', reason } satisfies ServerMessage))
        socket.close(1008, 'version')
        console.log(`× клиент версии ${socket.data.version}`)
        return
      }
      if (!passwordOk(socket.data.password)) {
        const reason = socket.data.password ? 'Неверный пароль' : 'Сервер закрыт паролем'
        socket.send(JSON.stringify({ type: 'refused', reason, password: true } satisfies ServerMessage))
        socket.close(1008, 'password')
        console.log(`× ${reason.toLowerCase()}`)
        return
      }
      socket.data.peer = host.join((text) => socket.send(text), socket.data.id, socket.data.name, () => socket.close(1000, 'kick'))
      console.log(`+ игрок ${socket.data.peer.player} ${socket.data.name ?? ''}`)
    },
    message(socket, text) {
      if (typeof text === 'string') socket.data.peer?.receive(text)
    },
    close(socket) {
      if (!socket.data.peer) return
      socket.data.peer.leave()
      console.log(`- игрок ${socket.data.peer.player}`)
    },
  },
})

let current = await certificate()
let server = listen(current)

// Bun не умеет менять сертификат у открытого сервера, поэтому новый сертификат — это новый сервер.
// Игроки при этом на миг отключаются; бывает раз в пару месяцев.
if (current) {
  setInterval(async () => {
    try {
      const next = await certificate()
      if (!next || next.cert === current?.cert) return
      current = next
      server.stop(true)
      server = listen(current)
      console.log('сертификат обновлён')
    } catch (error) {
      console.log(`сертификат не обновился: ${error instanceof Error ? error.message : error}`)
    }
  }, TLS_CHECK_INTERVAL)
}

let last = performance.now()
let sinceReport = 0
let sinceSave = 0
let ticks = 0
let busy = 0
setInterval(() => {
  const now = performance.now()
  const seconds = (now - last) / 1000
  last = now
  ticks += host.advance(seconds)
  busy += performance.now() - now

  sinceSave += seconds
  if (sinceSave >= SAVE_INTERVAL) {
    sinceSave = 0
    void store()
  }

  sinceReport += seconds
  if (sinceReport < REPORT_INTERVAL) return
  if (host.peers) {
    const kilobytes = (host.stateSize / 1024).toFixed(1)
    const perTick = ticks ? (busy / ticks).toFixed(2) : '—'
    console.log(`клиентов ${host.peers}, сущностей ${host.sim.world.size}, снимок ${kilobytes} КБ, тик ${perTick} мс`)
  }
  sinceReport = 0
  ticks = 0
  busy = 0
}, host.sim.time.step * 1000)

/** Сохраняет мир и выходит. */
async function stop() {
  await store()
  console.log(`мир сохранён в ${SAVE_PATH}`)
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop)

host.addCommand({
  name: 'save',
  args: [],
  help: 'сохранить мир сейчас',
  console: true,
  run: async (_args, _rest, caller) => {
    await store()
    caller.reply(`мир сохранён в ${SAVE_PATH}`)
  },
})
host.addCommand({ name: 'stop', args: [], help: 'сохранить мир и остановить сервер', console: true, run: () => void stop() })

// Консоль сервера: строка stdin — команда, как в чате, но без «/» и всегда от администратора. Под pm2 stdin
// закрыт, и цикл просто кончается.
const operator = { admin: true, reply: (text: string) => console.log(text) }
void (async () => {
  for await (const line of console) if (line.trim()) host.command(line.trim(), operator)
})()

console.log(`Kharos слушает ${current ? `wss://${domain ?? 'localhost'}` : 'ws://localhost'}:${port}`)
