import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, Terrain, terrainAt } from '../src/map/terrain'
import { createHost, type Host } from '../src/net/host'
import { decodeServer } from '../src/net/protocol'
import { createReplica, type Replica } from '../src/net/replica'
import { Owner, Position, Unit, createSim, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { editTile, knownEdits } from '../src/sim/landMemory'
import { throughJson } from './throughJson'

const STEP = 1 / 20

/** Клиент на хосте напрямую; карта мира приходит асинхронно — после неё надо подождать, см. settle. */
function join(host: Host, id?: string) {
  let replica: Replica | undefined
  let issued: string | undefined
  const peer = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'welcome' && !replica) {
      issued = message.id
      replica = createReplica(message, (reply) => peer.receive(reply), () => peer.leave())
    } else replica!.receive(message)
  }, id)
  return { peer, sim: replica!, id: issued! }
}

/** Сжатие и разбор карты идут промисами: даём им дойти. */
const settle = () => Bun.sleep(30)

const ownUnit = (sim: Sim, player: number) => {
  for (const [, , position, owner] of sim.world.query(Unit, Position, Owner)) if (owner.player === player) return { x: Math.floor(position.x), y: Math.floor(position.y) }
  throw new Error('нет юнитов')
}

/** Тайл, который игрок не видит и не видел: в дальнем углу карты от его юнитов. */
const hidden = (sim: Sim, player: number) => {
  const { x, y } = ownUnit(sim, player)
  const target = { x: x > 0 ? -100 : 100, y: y > 0 ? -100 : 100 }
  expect(sim.vision.sees(player, target.x, target.y)).toBe(false)
  return target
}

const rock = { terrain: Terrain.Rock, biome: 0, tier: 1, cliff: false }
const swamp = { terrain: Terrain.Swamp, biome: 0, tier: 0, cliff: false }

test('правку в тумане игрок не узнаёт, пока не увидит; на виду — узнаёт сразу', async () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const client = join(host)
  host.advance(STEP)
  await settle()

  const near = ownUnit(host.sim, 1)
  const far = hidden(host.sim, 1)
  const before = terrainAt(client.sim.land, far.x, far.y)
  const changed = before === Terrain.Swamp ? rock : swamp
  editTile(host.sim, near.x, near.y, changed === rock ? swamp : rock)
  editTile(host.sim, far.x, far.y, changed)
  host.advance(STEP)
  await settle()
  expect(terrainAt(client.sim.land, near.x, near.y)).toBe(terrainAt(host.sim.land, near.x, near.y))
  expect(terrainAt(client.sim.land, far.x, far.y)).toBe(before)

  // Новая вкладка того же игрока получает ту же карту: правку на виду — да, в тумане — нет.
  const second = join(host, client.id)
  await settle()
  expect(terrainAt(second.sim.land, near.x, near.y)).toBe(terrainAt(host.sim.land, near.x, near.y))
  expect(terrainAt(second.sim.land, far.x, far.y)).toBe(before)

  // Своё здание у дальнего тайла открывает его: правка доходит.
  placeBuilding(host.sim.world, 'turret', far.x + 1, far.y + 1, 1)
  // Обзор пересчитывается не каждый тик, см. VISION_TICKS.
  for (let i = 0; i < 10; i++) host.advance(STEP)
  await settle()
  expect(terrainAt(client.sim.land, far.x, far.y)).toBe(changed.terrain)
})

test('знание игроков о карте переживает сохранение', () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  sim.advance(STEP)
  const host = createHost(sim)
  join(host)
  host.advance(STEP)
  const near = ownUnit(host.sim, 1)
  editTile(host.sim, near.x, near.y, terrainAt(host.sim.land, near.x, near.y) === Terrain.Rock ? swamp : rock)
  host.advance(STEP)
  const edits = knownEdits(host.sim.landMemory, 1)
  expect(edits.length).toBe(6)
  const loaded = createSim(throughJson(host.sim.save()))
  expect(knownEdits(loaded.landMemory, 1)).toEqual(edits)
  expect(terrainAt(loaded.land, near.x, near.y)).toBe(terrainAt(host.sim.land, near.x, near.y))
})
