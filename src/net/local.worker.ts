import { createLocalServer, type LocalPort } from './local'

/**
 * Воркер локальной игры. Общий (SharedWorker) — один на все вкладки игры, и они видят один мир; где общих нет,
 * его запускают обычным воркером, и тогда вкладка с ним одна.
 */
const server = createLocalServer()
const scope = self as unknown as LocalPort & { onconnect?: ((event: { ports: LocalPort[] }) => void) | null }

if ('onconnect' in scope) scope.onconnect = (event) => server.connect(event.ports[0])
else server.connect(scope)

let last = performance.now()
setInterval(() => {
  const now = performance.now()
  server.advance((now - last) / 1000)
  last = now
}, 1000 / 20)
