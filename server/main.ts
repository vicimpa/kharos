import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost, type Peer } from '../src/net/host'
import { createSim } from '../src/sim'
import { DEFAULT_PORT } from '../src/net/protocol'

/** Сторона карты сервера в тайлах. */
const SIZE = 256
/** Как часто сервер пишет в консоль, что с ним происходит, в секундах. */
const REPORT_INTERVAL = 5

const port = Number(process.env.PORT) || DEFAULT_PORT
const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: SIZE }))

Bun.serve<{ token?: string; peer?: Peer }>({
  port,
  fetch(request, server) {
    const token = new URL(request.url).searchParams.get('token') ?? undefined
    if (server.upgrade(request, { data: { token } })) return undefined
    return new Response('Kharos: сюда подключаются по WebSocket\n', { status: 426 })
  },
  websocket: {
    open(socket) {
      socket.data.peer = host.join((text) => socket.send(text), socket.data.token)
      console.log(`+ игрок ${socket.data.peer.player}`)
    },
    message(socket, text) {
      if (typeof text === 'string') socket.data.peer?.receive(text)
    },
    close(socket) {
      socket.data.peer?.leave()
      console.log(`- игрок ${socket.data.peer?.player}`)
    },
  },
})

let last = performance.now()
let sinceReport = 0
let ticks = 0
let busy = 0
setInterval(() => {
  const now = performance.now()
  const seconds = (now - last) / 1000
  last = now
  ticks += host.advance(seconds)
  busy += performance.now() - now

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

console.log(`Kharos слушает ws://localhost:${port}`)
