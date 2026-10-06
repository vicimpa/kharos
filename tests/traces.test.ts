import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost, type Host } from '../src/net/host'
import type { ServerMessage } from '../src/net/protocol'
import { createReplica, type Replica } from '../src/net/replica'
import { Owner, Position, Unit, createSim, type Sim } from '../src/sim'
import { TRACE_LIFE, type Trace } from '../src/sim/traces'
import { spawnUnit } from '../src/sim/units'

const STEP = 1 / 20
const options = { generator: DEFAULT_CONFIG, size: 256 }

function join(host: Host) {
  let replica: Replica | undefined
  const peer = host.join((text) => {
    const message = JSON.parse(text) as ServerMessage
    if (message.type === 'welcome') replica = createReplica(message, (reply) => peer.receive(reply), () => peer.leave())
    else replica!.receive(message)
  })
  return replica!
}

const run = (sim: Sim, seconds: number, each?: () => void) => {
  for (let i = 0; i < seconds / STEP; i++) {
    sim.advance(STEP)
    each?.()
  }
}
const own = (sim: Sim, player: number) => {
  // Запрос отдаёт один и тот же массив на каждом шаге: сущности собираются по ходу.
  const units = []
  for (const [entity, , owner] of sim.world.query(Unit, Owner)) if (owner.player === player) units.push(entity)
  return units
}

test('идущий юнит оставляет точки пути, летающий — нет; следы истекают', () => {
  const sim = createSim(options)
  const tank = spawnUnit(sim, 'tank', 1, 0, 0)
  spawnUnit(sim, 'drone', 1, 0, 4)
  sim.advance(STEP)
  sim.send(1, { type: 'move', units: [tank], x: 10, y: 0 })
  run(sim, 5)
  const tracks = sim.traces.all().filter((trace) => trace.kind === 'track')
  expect(tracks.length).toBeGreaterThan(5)
  expect(tracks.every((trace) => trace.kind === 'track' && trace.entity === tank && trace.player === 1)).toBe(true)
  run(sim, TRACE_LIFE.track + 2)
  expect(sim.traces.all().some((trace) => trace.kind === 'track' && trace.tick < tracks.at(-1)!.tick)).toBe(false)
})

test('погибшая техника оставляет остов и гарь', () => {
  const sim = createSim(options)
  const tank = spawnUnit(sim, 'tank', 2, 0, 0)
  sim.advance(STEP)
  for (const _ of Array(3)) spawnUnit(sim, 'lancer', 1, 4, 0)
  run(sim, 30)
  expect(sim.world.alive(tank)).toBe(false)
  const kinds = new Set(sim.traces.all().map((trace) => trace.kind))
  expect(kinds.has('wreck')).toBe(true)
  expect(kinds.has('scar') || kinds.has('burn')).toBe(true)
})

test('следы приходят только в обзор: пришедший позже видит колею врага, ушедший её забывает, вернувшийся получает снова', () => {
  // Хост ставит игроков в случайные места: здесь они нужны одни и те же при каждом прогоне.
  const random = Math.random
  let seed = 3
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const host = createHost(createSim(options))
  const first = join(host)
  join(host)
  Math.random = random
  // Созданное попадает в запросы мира с первым тиком.
  host.advance(STEP * 2)
  // Юнит игрока 2 проходит в стороне от всех, и никто его не видит.
  const [scout] = own(host.sim, 2)
  const path = host.sim.world.get(scout, Position)!
  const home = own(host.sim, 1).map((entity) => host.sim.world.get(entity, Position)!)
  const far = { x: home[0].x + 40, y: home[0].y + 40 }
  Object.assign(path, far)
  host.sim.send(2, { type: 'move', units: [scout], x: Math.floor(far.x) + 6, y: Math.floor(far.y) })
  const tick = () => {
    host.advance(STEP)
    first.advance(STEP)
  }
  for (let i = 0; i < 3 / STEP; i++) tick()
  const enemyTracks = (traces: readonly Trace[]) => traces.filter((trace) => trace.kind === 'track' && trace.player === 2)
  expect(enemyTracks(host.sim.traces.all()).length).toBeGreaterThan(3)
  expect(enemyTracks(first.traces.all())).toEqual([])

  // Ушёл — следы остались. Игрок 1 приводит своих туда, где враг прошёл.
  Object.assign(path, { x: far.x + 80, y: far.y })
  for (const position of home) Object.assign(position, { x: far.x + 3, y: far.y })
  for (let i = 0; i < 1 / STEP; i++) tick()
  const seen = enemyTracks(first.traces.all())
  expect(seen.length).toBeGreaterThan(3)
  // Пришли они старыми: по их времени видно, давно ли тут прошли.
  expect(Math.max(...seen.map((trace) => trace.tick))).toBeLessThan(first.time.tick - 0.5 / STEP)
  expect(new Set(seen.map((trace) => trace.id)).size).toBe(seen.length)

  // Ушли — клиент о следах больше не знает; вернулись — хост присылает их снова.
  for (const position of home) Object.assign(position, { x: far.x - 60, y: far.y })
  for (let i = 0; i < 1 / STEP; i++) tick()
  expect(enemyTracks(first.traces.all())).toEqual([])
  for (const position of home) Object.assign(position, { x: far.x + 3, y: far.y })
  for (let i = 0; i < 1 / STEP; i++) tick()
  expect(enemyTracks(first.traces.all()).length).toBe(seen.length)
})
