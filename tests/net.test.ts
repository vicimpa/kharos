import { afterEach, beforeEach, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost, type Host, type HostSave } from '../src/net/host'
import type { ServerMessage } from '../src/net/protocol'
import { createReplica, type Replica } from '../src/net/replica'
import { Building, Ghost, Owner, Player, Position, Unit, createSim, shownTo } from '../src/sim'
import { SAVED } from '../src/sim/components'
import { wireOf } from '../src/net/wire'
import type { Entity } from '../src/ecs'
import { placeBuilding } from '../src/sim/buildings'

const STEP = 1 / 20

// Хост ставит игроков в случайные места: тестам нужны одни и те же при каждом прогоне.
const random = Math.random
beforeEach(() => {
  let seed = 7
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
})
afterEach(() => {
  Math.random = random
})

/** Клиент, подключённый к хосту напрямую, без сокета: сообщения ходят так же, текстом. */
function join(host: Host, id?: string, name?: string) {
  let replica: Replica | undefined
  let issued: string | undefined
  const peer = host.join(
    (text) => {
      const message = JSON.parse(text) as ServerMessage
      if (message.type === 'welcome' && !replica) {
        issued = message.id
        replica = createReplica(message, (reply) => peer.receive(reply), () => peer.leave())
      } else replica!.receive(message)
    },
    id,
    name,
  )
  return { peer, sim: replica!, id: issued! }
}

const unitsOf = (sim: Replica, player: number) => {
  const units: number[] = []
  for (const [entity] of sim.world.query(Unit)) if (sim.world.get(entity, Owner)?.player === player) units.push(entity)
  return units
}

test('клиент получает мир сразу после подключения', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const { peer, sim } = join(host)
  sim.advance(0)
  expect(peer.player).toBe(1)
  expect(unitsOf(sim, 1).length).toBe(unitsOf(host.sim as never, 1).length)
  expect(unitsOf(sim, 1).length).toBeGreaterThan(0)
})

test('клиент получает только то, что видит: чужую базу вдали — нет, а подошедшего врага — да', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  const second = join(host)
  host.advance(STEP)
  first.sim.advance(STEP)
  expect(unitsOf(first.sim, 2)).toEqual([])
  // Игрок 2 подогнал юнита вплотную к юниту игрока 1.
  const [own] = unitsOf(first.sim, 1)
  const [foe] = unitsOf(host.sim as never, 2)
  Object.assign(host.sim.world.get(foe as never, Position)!, first.sim.world.get(own, Position)!)
  host.advance(STEP)
  first.sim.advance(STEP)
  expect(unitsOf(first.sim, 2)).toEqual([foe])
  // Счёт чужого игрока не приходит никогда.
  expect(second.peer.player).toBe(2)
  expect([...first.sim.world.query(Player)].map(([, player]) => player.id)).toEqual([1])
})

test('приказ клиента выполняет сервер, а клиент видит результат', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
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
  // Место приходит округлённым до тысячной тайла, см. wire.ts.
  const there = host.sim.world.get(unit as never, Position)!
  expect(sim.world.get(unit, Position)!.x).toBeCloseTo(there.x, 2)
  expect(sim.world.get(unit, Position)!.y).toBeCloseTo(there.y, 2)
  expect(sim.world.get(unit, Position)!.x).toBeGreaterThan(from.x + 1)
})

test('чужими юнитами клиент не командует', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  const second = join(host)
  expect(second.peer.player).toBe(2)
  second.sim.advance(0)
  // Юнитов первого игрока второй не видит — они далеко, — но номер юнита можно и угадать.
  expect(unitsOf(second.sim, 1)).toEqual([])
  first.sim.advance(0)
  const [unit] = unitsOf(first.sim, 1)
  const from = { ...first.sim.world.get(unit, Position)! }

  second.sim.send(2, { type: 'move', units: [unit], x: Math.floor(from.x) + 3, y: Math.floor(from.y) })
  for (let i = 0; i < 20; i++) host.advance(STEP)
  first.sim.advance(STEP)
  expect(first.sim.world.get(unit, Position)).toEqual(from)
})

test('вернувшийся игрок получает прежние юниты, а мусор из сети сервер не роняет', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  first.peer.receive('не JSON')
  first.peer.receive('null')
  first.peer.receive('{"type":"command","command":{"type":"move","units":"все"}}')
  first.peer.receive('{"type":"command","command":7}')
  host.advance(STEP)
  const size = host.sim.world.size
  first.peer.leave()
  expect(host.peers).toBe(0)

  const again = join(host, first.id)
  expect(again.peer.player).toBe(1)
  expect(again.id).toBe(first.id)
  expect(host.sim.world.size).toBe(size)
  // Чужой id хост не знает: это новый игрок со своим id.
  const stranger = join(host, 'выдуманный')
  expect(stranger.peer.player).toBe(2)
  expect(stranger.id).not.toBe('выдуманный')
})

test('между тиками копия ведёт alpha, а пропавшее соединение останавливает игру', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
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

test('чужое здание, ушедшее в туман, остаётся призраком, пока место не увидят снова', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  join(host)
  host.advance(STEP)
  // Все юниты игрока 1 ходят вместе: сдвинуть его глаза — значит сдвинуть их всех.
  const eyes = unitsOf(host.sim as never, 1).map((entity) => host.sim.world.get(entity as never, Position)!)
  const shift = (dx: number) => eyes.forEach((position) => (position.x += dx))
  const { x, y } = eyes[0]
  const yard = placeBuilding(host.sim.world, 'khariteVault', Math.floor(x) + 2, Math.floor(y), 2)
  const step = () => {
    host.advance(STEP)
    first.sim.advance(STEP)
  }
  // Обзор пересчитывается раз в несколько тиков: столько и ждём, чтобы хост заметил перемену.
  const settle = () => {
    for (let i = 0; i < 5; i++) step()
  }
  step()
  expect(first.sim.world.has(yard, Building)).toBe(true)
  expect(first.sim.world.has(yard, Ghost)).toBe(false)

  // Юниты ушли — хост здание больше не шлёт, а клиент его помнит.
  shift(-60)
  settle()
  expect(first.sim.world.has(yard, Ghost)).toBe(true)

  // Здание снесли в тумане: клиент узнаёт об этом, только вернувшись.
  host.sim.world.destroy(yard as never)
  step()
  expect(first.sim.world.has(yard, Ghost)).toBe(true)
  shift(60)
  settle()
  expect(first.sim.world.alive(yard)).toBe(false)
})

test('вернувшийся игрок получает карту, разведанную раньше', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  host.advance(STEP)
  first.sim.advance(STEP)
  const [unit] = unitsOf(first.sim, 1)
  const { x, y } = first.sim.world.get(unit, Position)!
  first.peer.leave()

  const again = join(host, first.id)
  // Ещё ни одного мира от хоста, а разведанное уже есть.
  expect(again.sim.vision.explored(1, x, y)).toBe(true)
  expect(again.sim.vision.explored(1, x + 100, y)).toBe(false)
})

test('игроки видят ники друг друга и кто из них в сети', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host, undefined, '  Вася\u0007 ')
  const second = join(host)
  expect(first.sim.players).toEqual([
    { player: 1, name: 'Вася', online: true },
    { player: 2, name: 'Игрок 2', online: true },
  ])
  second.peer.leave()
  expect(first.sim.players[1].online).toBe(false)
  // Вернулся без ника — ник прежний.
  const back = join(host, second.id, 'Петя')
  expect(back.sim.players[1]).toEqual({ player: 2, name: 'Петя', online: true })
  expect(join(host, first.id).sim.players[0].name).toBe('Вася')
})

test('сохранённый сервер после перезапуска узнаёт игроков по id, помнит ники и не путает номера новых', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host, undefined, 'Вася')
  join(host, undefined, 'Петя').peer.leave()
  host.advance(STEP * 4)
  const units = unitsOf(first.sim, 1).length
  const save = JSON.parse(JSON.stringify(host.save())) as HostSave

  const restarted = createHost(createSim(save.sim), undefined, save)
  const back = join(restarted, first.id)
  expect(back.peer.player).toBe(1)
  expect(unitsOf(back.sim, 1).length).toBe(units)
  expect(back.sim.players).toEqual([
    { player: 1, name: 'Вася', online: true },
    { player: 2, name: 'Петя', online: false },
  ])
  expect(join(restarted).peer.player).toBe(3)
})

test('мир клиента, собранный из изменений, совпадает с тем, что игрок видит на хосте', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const first = join(host)
  const second = join(host)
  first.sim.advance(0)
  second.sim.advance(0)
  // Юниты обоих едут навстречу друг другу: появляются в обзоре, двигаются, уходят, стреляют.
  const target = host.sim.world.get(unitsOf(host.sim as never, 2)[0]! as never, Position)!
  const start = host.sim.world.get(unitsOf(host.sim as never, 1)[0]! as never, Position)!
  first.sim.send(1, { type: 'move', units: unitsOf(first.sim, 1), x: Math.floor(target.x), y: Math.floor(target.y) })
  second.sim.send(2, { type: 'move', units: unitsOf(second.sim, 2), x: Math.floor(start.x), y: Math.floor(start.y) })
  // Сравнивается то, что уходит в сеть: хост шлёт не все поля и округляет дробные, см. wire.ts.
  const wired = (world: Replica['world'], player: number, keep: (entity: Entity) => boolean) =>
    [...world.all]
      .filter(keep)
      .sort((a, b) => a - b)
      .map((entity) => [entity, Object.fromEntries([...wireOf(world, entity, player, 0)].map(([key, json]) => [key, JSON.parse(json)]))])
      .filter(([, data]) => Object.keys(data).length)
  const seen = (sim: Replica, player = 1) => wired(sim.world, player, (entity) => !sim.world.has(entity, Ghost))
  const truth = (player: number) => wired(host.sim.world as never, player, (entity) => shownTo(host.sim, player, entity as never))
  for (let tick = 1; tick <= 600; tick++) {
    host.advance(STEP)
    // Первый клиент применяет каждое изменение, второй — пачками по несколько.
    first.sim.advance(STEP)
    if (tick % 7 === 0) second.sim.advance(STEP)
    if (tick % 50 === 0) expect(seen(first.sim)).toEqual(truth(1))
  }
  second.sim.advance(STEP)
  expect(seen(second.sim, 2)).toEqual(truth(2))
})

test('сдавшийся на сервере начинает заново: новый стартовый набор, а до поражения — нельзя', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const { peer, sim } = join(host)
  host.advance(STEP)
  const before = unitsOf(host.sim as never, 1).length
  // Не проигравший заново не начинает.
  sim.respawn()
  host.advance(STEP)
  expect(unitsOf(host.sim as never, 1).length).toBe(before)
  sim.send(1, { type: 'surrender' })
  for (let i = 0; i < 8 / STEP; i++) host.advance(STEP)
  expect(unitsOf(host.sim as never, 1).length).toBe(0)
  const generation = sim.generation
  sim.respawn()
  host.advance(STEP)
  expect(unitsOf(host.sim as never, 1).length).toBe(before)
  expect(peer.player).toBe(1)
  sim.advance(STEP)
  // Клиент получил новое приветствие: туман и камера — как в новом мире, а юниты нового набора у него есть.
  expect(sim.generation).toBe(generation + 1)
  expect(unitsOf(sim, 1).length).toBe(before)
})
