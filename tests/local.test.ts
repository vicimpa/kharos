import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createLocalServer, type LocalControl, type LocalNotice, type LocalPort, type LocalServer } from '../src/net/local'
import type { ServerMessage } from '../src/net/protocol'
import { createReplica, type Replica } from '../src/net/replica'
import { Position, Unit, type SimSave } from '../src/sim'

const STEP = 1 / 20
const options = { generator: DEFAULT_SETTINGS.generator, size: 256 }
const battle = DEFAULT_SETTINGS.battle

/** Вкладка, подключённая к локальному серверу: сообщения ходят так же, как через postMessage. */
function tab(server: LocalServer, save: SimSave | null = null, mode: 'play' | 'battle' = 'play') {
  const saves: SimSave[] = []
  let sim: Replica | undefined
  const port: LocalPort = {
    onmessage: null,
    postMessage(data) {
      if (typeof data !== 'string') return void saves.push((data as LocalNotice).save)
      const message = JSON.parse(data) as ServerMessage
      if (sim) sim.receive(message)
      else if (message.type === 'welcome') sim = createReplica(message, (text) => port.onmessage!({ data: text }), () => {})
    },
  }
  server.connect(port)
  const control = (message: LocalControl) => port.onmessage!({ data: message })
  control({ type: 'start', options, mode, battle, save })
  sim!.advance(0)
  return { sim: sim!, saves, control }
}

const units = (sim: Replica) => [...sim.world.query(Unit)].map(([entity]) => entity)

test('две вкладки локальной игры видят один мир и играют за одного игрока', () => {
  const server = createLocalServer()
  const first = tab(server)
  const second = tab(server)
  expect(second.sim.world.size).toBe(first.sim.world.size)
  const [unit] = units(first.sim)
  const from = { ...first.sim.world.get(unit, Position)! }

  // Приказ из второй вкладки двигает юнита, которого видит первая.
  second.sim.send(1, { type: 'move', units: [unit], x: Math.floor(from.x) + 3, y: Math.floor(from.y) })
  for (let i = 0; i < 40; i++) server.advance(STEP)
  first.sim.advance(STEP)
  second.sim.advance(STEP)
  expect(first.sim.world.get(unit, Position)!.x).toBeGreaterThan(from.x + 1)
  expect(second.sim.world.get(unit, Position)).toEqual(first.sim.world.get(unit, Position)!)
})

test('локальная игра присылает сохранение, и с него она продолжается', () => {
  const server = createLocalServer()
  const { saves } = tab(server)
  for (let i = 0; i < 6 / STEP; i++) server.advance(STEP)
  expect(saves.length).toBeGreaterThan(0)
  const save = saves.at(-1)!

  const resumed = tab(createLocalServer(), save)
  expect(resumed.sim.time.tick).toBe(save.tick)
  expect(units(resumed.sim).length).toBe(units(tab(createLocalServer()).sim).length)
})

test('новый мир получают все вкладки: копии сбрасываются, а не смешивают старое с новым', () => {
  const server = createLocalServer()
  const first = tab(server)
  const second = tab(server)
  for (let i = 0; i < 20; i++) server.advance(STEP)
  first.sim.advance(STEP)

  first.control({ type: 'restart', options, battle })
  first.sim.advance(0)
  second.sim.advance(0)
  expect(first.sim.generation).toBe(1)
  expect(second.sim.generation).toBe(1)
  expect(second.sim.time.tick).toBe(0)
  expect(second.sim.world.size).toBe(server.host!.sim.world.size)
})

test('показательный бой идёт сам и не сохраняется', () => {
  const server = createLocalServer()
  const { sim, saves } = tab(server, null, 'battle')
  const before = units(sim).map((entity) => ({ ...sim.world.get(entity, Position)! }))
  for (let i = 0; i < 10 / STEP; i++) server.advance(STEP)
  sim.advance(STEP)
  const moved = units(sim).some((entity, i) => {
    const now = sim.world.get(entity, Position)
    return now && before[i] && (now.x !== before[i].x || now.y !== before[i].y)
  })
  expect(moved).toBe(true)
  expect(saves.length).toBe(0)
})

test('уходящая вкладка получает последнее сохранение, а без вкладок мир стоит', () => {
  const server = createLocalServer()
  const { saves, control } = tab(server)
  for (let i = 0; i < 2 / STEP; i++) server.advance(STEP)
  expect(saves.length).toBe(0)
  control({ type: 'leave' })
  expect(saves.length).toBe(1)
  expect(saves[0].tick).toBe(server.host!.sim.time.tick)

  const tick = server.host!.sim.time.tick
  for (let i = 0; i < 2 / STEP; i++) server.advance(STEP)
  expect(server.host!.sim.time.tick).toBe(tick)
  // Вернувшаяся вкладка застаёт мир там, где его оставили, и он идёт дальше.
  const back = tab(server)
  expect(back.sim.time.tick).toBe(tick)
  for (let i = 0; i < 10; i++) server.advance(STEP)
  expect(server.host!.sim.time.tick).toBeGreaterThan(tick)
})
