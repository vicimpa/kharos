import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHost, type HostSave, type Peer } from '../src/net/host'
import { PROTOCOL_VERSION, versionMismatch, type ServerMessage } from '../src/net/protocol'
import { SAVE_VERSION, createSim } from '../src/sim'
import { defaultSettings, mergeSettings, type ServerSettings } from './settings'

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

/** Мир из сохранения; сохранение другой версии игры откладывается в сторону, и мир начинается заново. */
function load(): HostSave | undefined {
  if (!existsSync(SAVE_PATH)) return undefined
  // Битый файл сервер не перезаписывает: молча начать новый мир значило бы потерять старый.
  const save = JSON.parse(readFileSync(SAVE_PATH, 'utf8')) as HostSave
  if (save.sim?.version === SAVE_VERSION) return save
  const aside = `${SAVE_PATH}.v${save.sim?.version ?? 0}`
  renameSync(SAVE_PATH, aside)
  console.log(`сохранение другой версии игры отложено в ${aside}, мир начинается заново`)
  return undefined
}

/** Пишет во временный файл и подменяет им сохранение: упавший посреди записи сервер не оставит половину файла. */
function store() {
  const temporary = `${SAVE_PATH}.tmp`
  writeFileSync(temporary, JSON.stringify(host.save()))
  renameSync(temporary, SAVE_PATH)
}

const saved = load()
// Карта и погода у сохранённого мира свои, а правила — из настроек: их можно менять между запусками.
const { generator, size, fog, weather, rules } = settings
const host = createHost(saved ? createSim({ ...saved.sim, rules }) : createSim({ generator, size, fog, weather, rules }), undefined, saved)
if (saved) console.log(`мир загружен из ${SAVE_PATH}: тик ${saved.sim.tick}, игроков ${Object.keys(saved.players).length}`)
else console.log(`новый мир ${size}×${size}, seed ${generator.seed}`)

Bun.serve<{ id?: string; name?: string; version: number; peer?: Peer }>({
  port,
  fetch(request, server) {
    const query = new URL(request.url).searchParams
    const data = { id: query.get('id') ?? undefined, name: query.get('name') ?? undefined, version: Number(query.get('version')) || 0 }
    if (server.upgrade(request, { data })) return undefined
    return new Response('Kharos: сюда подключаются по WebSocket\n', { status: 426 })
  },
  websocket: {
    open(socket) {
      // Клиент другой версии собрал бы мир не так, как сервер: его не пускают, но говорят почему.
      if (socket.data.version !== PROTOCOL_VERSION) {
        const reason = versionMismatch(PROTOCOL_VERSION, socket.data.version)
        socket.send(JSON.stringify({ type: 'refused', reason } satisfies ServerMessage))
        socket.close(1008, 'version')
        console.log(`× клиент версии ${socket.data.version}`)
        return
      }
      socket.data.peer = host.join((text) => socket.send(text), socket.data.id, socket.data.name)
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
    store()
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store()
    console.log(`мир сохранён в ${SAVE_PATH}`)
    process.exit(0)
  })
}

console.log(`Kharos слушает ws://localhost:${port}`)
