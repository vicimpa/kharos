import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, Terrain, setTile, terrainAt } from '../src/map/terrain'
import { Attached, Building, Ghost, Health, Inventory, Owner, Position, Unit, createSim, creditsOf, type Sim } from '../src/sim'
import { addPlayer, depositUnder, entityAt, erase, moveGhost, moveUnit, paint, playersOf, putBuilding, putDeposit, putUnit, removeDeposit, setCredits, setDeposit, setHealth, setOwner, setStock } from '../src/sim/editor'
import { depositAt, depositIn, reserveLeft } from '../src/sim/deposits'
import { editTile } from '../src/sim/landMemory'

const world = () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  for (let y = -30; y < 30; y++) for (let x = -30; x < 30; x++) setTile(sim.land, x, y, { terrain: Terrain.Rock, biome: 0, tier: 1, cliff: false })
  return sim
}
const reload = (sim: Sim) => createSim(sim.save())

test('кисть красит карту, и правка — в сохранении для всех, без памяти тумана', () => {
  const sim = world()
  editTile(sim, 0, 0, { terrain: Terrain.Sand, biome: 0, tier: 1, cliff: false })
  paint(sim, 0, 0, 3, { terrain: Terrain.Swamp })
  expect(terrainAt(sim.land, -1, -1)).toBe(Terrain.Swamp)
  expect(terrainAt(sim.land, 1, 1)).toBe(Terrain.Swamp)
  expect(terrainAt(sim.land, 2, 2)).toBe(Terrain.Rock)
  expect(sim.landMemory.original.size).toBe(0)
  expect(terrainAt(reload(sim).land, 0, 0)).toBe(Terrain.Swamp)
})

test('здание и юнит ставятся по правилам места, без денег и строителей', () => {
  const sim = world()
  const player = addPlayer(sim)
  expect(playersOf(sim)).toEqual([player])
  const mine = putBuilding(sim, 'generator', 0, 0, player)
  expect(mine).toBeDefined()
  expect(putBuilding(sim, 'generator', 0, 0, player)).toBeUndefined()
  expect(putUnit(sim, 'tank', 0, 0, player)).toBeUndefined()
  const tank = putUnit(sim, 'tank', 10, 10, player)!
  expect(entityAt(sim, 10.5, 10.5)).toBe(tank)
  expect(entityAt(sim, 0.5, 0.5)).toBe(mine)
  expect(moveUnit(sim, tank, 12, 12)).toBe(true)
  expect(sim.world.get(tank, Position)).toEqual({ x: 12.5, y: 12.5 })
})

test('деньги, прочность, склад и владелец правятся и переживают сохранение', () => {
  const sim = world()
  const player = addPlayer(sim)
  const other = addPlayer(sim)
  setCredits(sim, player, 5000)
  const store = putBuilding(sim, 'metalYard', 0, 0, player)!
  setStock(sim, store, 'metal', 77)
  setHealth(sim, store, 0.4)
  const carrier = putUnit(sim, 'carrier', 10, 10, player)
  setOwner(sim, store, other)
  const loaded = reload(sim)
  expect(creditsOf(loaded, player)).toBe(5000)
  const [[entity, , inventory, health, owner]] = [...loaded.world.query(Building, Inventory, Health, Owner)]
  expect(inventory.items.metal).toBe(77)
  expect(health.value / health.max).toBeCloseTo(0.4)
  expect(owner.player).toBe(other)
  expect(entity).toBeDefined()
  if (carrier !== undefined) {
    erase(sim, carrier)
    expect([...sim.world.query(Attached)].length).toBe(0)
    expect([...sim.world.query(Unit)].length).toBe(0)
  }
})

test('месторождения: запас и вид правятся, новое заменяет прежнее в клетке, убранного нет — и всё это в сохранении', () => {
  const sim = world()
  const spot = depositIn(sim, 0, 0)!
  expect(spot).not.toBeNull()
  setDeposit(sim, spot, 'kharite', 50)
  expect(depositAt(sim, spot.x, spot.y)!.kind).toBe('kharite')
  expect(reserveLeft(sim, spot.x, spot.y)).toBe(50)
  expect(reserveLeft(reload(sim), spot.x, spot.y)).toBe(50)

  const x = spot.x === 2 ? 6 : 2
  expect(putDeposit(sim, x, 2, 'fuel', 900)).toBe(true)
  expect(depositAt(sim, spot.x, spot.y)).toBeNull()
  expect(depositIn(sim, 0, 0)).toMatchObject({ x, y: 2, kind: 'fuel', reserve: 900 })
  expect(depositUnder(sim, x + 1.5, 3.5)).toMatchObject({ x, y: 2 })

  removeDeposit(sim, depositIn(sim, 0, 0)!)
  expect(depositIn(sim, 0, 0)).toBeNull()
  expect(depositIn(reload(sim), 0, 0)).toBeNull()
  // На песок не кладётся.
  paint(sim, 10, 10, 3, { terrain: Terrain.Sand })
  expect(putDeposit(sim, 9, 9, 'metal', 100)).toBe(false)
})

test('призрак юнита не выбирается, краснеет там, где не встать, и не в счёт мира', () => {
  const sim = world()
  const player = addPlayer(sim)
  putBuilding(sim, 'generator', 0, 0, player)
  let ghost = moveGhost(sim, undefined, 'tank', player, 10, 10)!
  expect(sim.world.get(ghost, Ghost)!.blocked).toBe(false)
  expect(entityAt(sim, 10.5, 10.5)).toBeUndefined()
  ghost = moveGhost(sim, ghost, 'tank', player, 0, 0)!
  expect(sim.world.get(ghost, Ghost)!.blocked).toBe(true)
  erase(sim, ghost)
  expect([...sim.world.query(Unit)].length).toBe(0)
})
