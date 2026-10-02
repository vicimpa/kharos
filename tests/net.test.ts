import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost, type Host } from '../src/net/host'
import type { ServerMessage } from '../src/net/protocol'
import { createReplica, type Replica } from '../src/net/replica'
import { Owner, Position, Unit } from '../src/sim'

const STEP = 1 / 20

/** Клиент, подключённый к хосту напрямую, без сокета: сообщения ходят так же, текстом. */
function join(host: Host, token?: string) {
  let replica: Replica | undefined
  const peer = host.join((text) => {
    const message = JSON.parse(text) as ServerMessage
    if (message.type === 'welcome') replica = createReplica(message, (reply) => peer.receive(reply), () => peer.leave())
    else replica!.receive(message)
  }, token)
  return { peer, sim: replica! }
}

const unitsOf = (sim: Replica, player: number) => {
  const units: number[] = []
  for (const [entity] of sim.world.query(Unit)) if (sim.world.get(entity, Owner)?.player === player) units.push(entity)
  return units
}

test('клиент получает мир сразу после подключения', () => {
  const host = createHost({ generator: DEFAULT_CONFIG, size: 256 })
  const { peer, sim } = join(host)
  sim.advance(0)
  expect(peer.player).toBe(1)
  expect(unitsOf(sim, 1).length).toBeGreaterThan(0)
  expect(sim.world.size).toBe(host.sim.world.size)
})

test('приказ клиента выполняет сервер, а клиент видит результат', () => {
  const host = createHost({ generator: DEFAULT_CONFIG, size: 256 })
  const { sim } = join(host)
  sim.advance(0)
  const [unit] = unitsOf(sim, 1)
  const from = { ...sim.world.get(unit, Position)! }

  sim.send(1, { type: 'move', units: [unit], x: Math.floor(from.x) + 3, y: Math.floor(from.y) })
  // Сама копия мир не считает: без сервера юнит стоит.
  sim.advance(1)
  expect(sim.world.get(unit, Position)).toEqual(from)

  for (let i = 0; i < 40; i++) {
    host.advance(STEP)
    sim.advance(STEP)
  }
  expect(sim.time.tick).toBe(host.sim.time.tick)
  expect(sim.world.get(unit, Position)).toEqual(host.sim.world.get(unit as never, Position)!)
  expect(sim.world.get(unit, Position)!.x).toBeGreaterThan(from.x + 1)
})

test('чужими юнитами клиент не командует', () => {
  const host = createHost({ generator: DEFAULT_CONFIG, size: 256 })
  const first = join(host)
  const second = join(host)
  expect(second.peer.player).toBe(2)
  second.sim.advance(0)
  const [unit] = unitsOf(second.sim, 1)
  const from = { ...second.sim.world.get(unit, Position)! }

  second.sim.send(2, { type: 'move', units: [unit], x: Math.floor(from.x) + 3, y: Math.floor(from.y) })
  for (let i = 0; i < 20; i++) host.advance(STEP)
  first.sim.advance(STEP)
  expect(first.sim.world.get(unit, Position)).toEqual(from)
})

test('вернувшийся игрок получает прежние юниты, а мусор из сети сервер не роняет', () => {
  const host = createHost({ generator: DEFAULT_CONFIG, size: 256 })
  const first = join(host, 'a')
  first.peer.receive('не JSON')
  first.peer.receive('null')
  first.peer.receive('{"type":"command","command":{"type":"move","units":"все"}}')
  first.peer.receive('{"type":"command","command":7}')
  host.advance(STEP)
  const size = host.sim.world.size
  first.peer.leave()
  expect(host.peers).toBe(0)

  const again = join(host, 'a')
  expect(again.peer.player).toBe(1)
  expect(host.sim.world.size).toBe(size)
  expect(join(host, 'b').peer.player).toBe(2)
})

test('между тиками копия ведёт alpha, а пропавшее соединение останавливает игру', () => {
  const host = createHost({ generator: DEFAULT_CONFIG, size: 256 })
  const { sim } = join(host)
  sim.advance(0)
  expect(sim.time.alpha).toBe(0)
  sim.advance(STEP / 2)
  expect(sim.time.alpha).toBeCloseTo(0.5)
  sim.advance(STEP)
  expect(sim.time.alpha).toBe(1)
  sim.fail('обрыв')
  expect(() => sim.advance(STEP)).toThrow('обрыв')
})
