import { expect, test } from 'bun:test'
import { Biome, DEFAULT_CONFIG, DUNE_SHIFT, biomeAt, Dunes, Terrain, isCliffFoot, peakOf, setTile, terrainAt, tileBytes } from '../src/map/terrain'
import { Attached, Building, Ghost, Path, canFight, Health, Inventory, Owner, Position, Unit, createSim, creditsOf, type Sim } from '../src/sim'
import { addPlayer, brushTiles, playerCamera, setPlayerCamera, clearTasks, depositsInBox, orderNow, setFacing, setTurretFacing, turretFacings, depositUnder, entitiesIn, entityAt, erase, moveDeposit, moveGhost, moveGroup, moveUnit, paint, playersOf, putBuilding, putDeposit, putUnit, removeDeposit, setCredits, setDeposit, setHealth, setOwner, setStock } from '../src/sim/editor'
import { depositAt, depositIn, depositNear, depositsIn, reserveLeft } from '../src/sim/deposits'
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

test('месторождения: запас и вид правятся, новые ложатся сколько угодно рядом с прежними, убранного нет — всё в сохранении', () => {
  const sim = world()
  const spot = depositIn(sim, 0, 0)!
  expect(spot).not.toBeNull()
  setDeposit(sim, spot, 'kharite', 50)
  expect(depositAt(sim, spot.x, spot.y)!.kind).toBe('kharite')
  expect(reserveLeft(sim, spot.x, spot.y)).toBe(50)
  expect(reserveLeft(reload(sim), spot.x, spot.y)).toBe(50)

  // Много новых в одной клетке, прежнее — на месте. Внахлёст — нельзя.
  const free = [] as { x: number; y: number }[]
  for (let y = 0; y < 38 && free.length < 6; y += 3) for (let x = 0; x < 38 && free.length < 6; x += 3) if (Math.abs(x - spot.x) >= 3 || Math.abs(y - spot.y) >= 3) free.push({ x, y })
  for (const { x, y } of free) expect(putDeposit(sim, x, y, 'fuel', 900)).toBe(true)
  expect(putDeposit(sim, free[0].x + 1, free[0].y, 'fuel', 900)).toBe(false)
  expect(depositsIn(sim, 0, 0)).toHaveLength(free.length + 1)
  expect(depositAt(sim, spot.x, spot.y)!.kind).toBe('kharite')
  expect(depositsIn(reload(sim), 0, 0)).toHaveLength(free.length + 1)
  expect(depositUnder(sim, free[1].x + 1.5, free[1].y + 1.5)).toMatchObject(free[1])
  // Добытое из нового — свой счёт.
  expect(depositNear(sim, free[2].x + 1, free[2].y + 1, 0.5)).toMatchObject(free[2])

  removeDeposit(sim, depositAt(sim, free[0].x, free[0].y)!)
  removeDeposit(sim, depositAt(sim, spot.x, spot.y)!)
  expect(depositAt(sim, spot.x, spot.y)).toBeNull()
  expect(depositsIn(reload(sim), 0, 0)).toHaveLength(free.length - 1)
  // На песок не кладётся.
  paint(sim, 30, 30, 3, { terrain: Terrain.Sand })
  expect(putDeposit(sim, 29, 29, 'metal', 100)).toBe(false)
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

test('юниты и здания тащатся вместе: всё или ничего, друг другу не мешают', () => {
  const sim = world()
  const player = addPlayer(sim)
  const generator = putBuilding(sim, 'generator', 0, 0, player)!
  const tank = putUnit(sim, 'tank', 4, 0, player)!
  expect(entitiesIn(sim, -1, -1, 6, 3).sort()).toEqual([generator, tank].sort())
  // Здание заезжает на место, откуда ушло само.
  expect(moveGroup(sim, [generator, tank], 1, 0)).not.toBeNull()
  expect(sim.world.get(generator, Position)).toEqual({ x: 1, y: 0 })
  expect(sim.occupancy.at(1, 0)).toBe(generator)
  expect(sim.occupancy.at(0, 0)).toBeUndefined()
  expect(sim.world.get(tank, Position)).toEqual({ x: 5.5, y: 0.5 })
  // Танку некуда — не едет никто.
  paint(sim, 15, 0, 1, { terrain: Terrain.Rock, tier: 3, cliff: true })
  const blocked = putBuilding(sim, 'generator', 10, 0, player)!
  expect(moveGroup(sim, [generator, tank], 0, 0)).not.toBeNull()
  expect(moveGroup(sim, [generator, tank], 5, 0)).toBeNull()
  expect(sim.world.get(generator, Position)).toEqual({ x: 1, y: 0 })
  expect(sim.occupancy.at(1, 0)).toBe(generator)
  expect(blocked).toBeDefined()
})

test('месторождение тащится с видом и остатком, но не внахлёст с другим', () => {
  const sim = world()
  const spot = depositIn(sim, 0, 0)!
  setDeposit(sim, spot, 'fuel', 300)
  const x = spot.x < 10 ? 20 : 2
  expect(putDeposit(sim, x + 6, 2, 'metal', 10)).toBe(true)
  const moved = moveDeposit(sim, depositAt(sim, spot.x, spot.y)!, x, 2)!
  expect(moved).toMatchObject({ x, y: 2, kind: 'fuel' })
  expect(reserveLeft(sim, x, 2)).toBe(300)
  expect(depositAt(sim, spot.x, spot.y)).toBeNull()
  // Сдвиг на тайл — внахлёст с самим собой — можно.
  expect(moveDeposit(sim, moved, x + 1, 2)).toMatchObject({ x: x + 1 })
  expect(moveDeposit(sim, depositAt(sim, x + 1, 2)!, x + 5, 2)).toBeNull()
})

test('месторождения тащатся вместе с юнитами; поворот корпуса и турелей; задания снимаются и выдаются сразу', () => {
  const sim = world()
  const player = addPlayer(sim)
  const tank = putUnit(sim, 'tank', 10, 10, player)!
  const spot = depositIn(sim, 0, 0)!
  const moved = moveGroup(sim, [tank], 3, 0, [spot])!
  expect(moved[0]).toMatchObject({ x: spot.x + 3, y: spot.y, kind: spot.kind })
  expect(depositsInBox(sim, spot.x + 3, spot.y, spot.x + 5, spot.y + 2)).toEqual([moved[0]])
  expect(sim.world.get(tank, Position)!.x).toBe(13.5)

  setFacing(sim, tank, Math.PI)
  expect(Math.abs(sim.world.get(tank, Unit)!.facing)).toBeCloseTo(Math.PI)
  setTurretFacing(sim, tank, 0.5)
  expect(turretFacings(sim, tank)[0]).toBeCloseTo(0.5)
  // У носителя турели поворачиваются по одной.
  const carrier = putUnit(sim, 'carrier', 20, 20, player)!
  const before = turretFacings(sim, carrier)
  expect(before.length).toBeGreaterThan(1)
  setTurretFacing(sim, carrier, 1, 1)
  const after = turretFacings(sim, carrier)
  expect(after[1]).toBeCloseTo(1)
  expect(after[0]).toBeCloseTo(before[0])
  // У MCV — пушка на крыше: поворачивается, но не стреляет.
  const mcv = putUnit(sim, 'mcv', 25, 25, player)!
  expect(turretFacings(sim, mcv)).toHaveLength(1)
  expect(canFight(sim, mcv)).toBe(false)

  expect(orderNow(sim, player, { type: 'move', units: [tank], x: 20, y: 10 })).toBe(true)
  expect(sim.world.has(tank, Path)).toBe(true)
  clearTasks(sim, tank)
  expect(sim.world.has(tank, Path)).toBe(false)
})

test('кисть ставит гору одной вершиной и стирает задетую гору целиком; барханы — только на песке и в сохранении', () => {
  const sim = world()
  paint(sim, 0, 0, 5, { terrain: Terrain.Mountain })
  const peak = peakOf(sim.land, 0, 0)!
  expect(peak).toMatchObject({ x: 0.5, y: 0.5 })
  expect(terrainAt(sim.land, 2, 0)).toBe(Terrain.Mountain)
  expect(terrainAt(sim.land, 4, 0)).toBe(Terrain.Rock)
  // Задели краем — стёрта вся.
  paint(sim, 2, 0, 1, { terrain: Terrain.Sand })
  expect(terrainAt(sim.land, 2, 0)).toBe(Terrain.Sand)
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) expect(terrainAt(sim.land, x, y)).not.toBe(Terrain.Mountain)
  // Гора к горе — гряда: тайлы на стыке у ближней вершины, обе остаются.
  paint(sim, 10, 10, 5, { terrain: Terrain.Mountain })
  paint(sim, 13, 10, 5, { terrain: Terrain.Mountain })
  expect(peakOf(sim.land, 10, 10)).toMatchObject({ x: 10.5, y: 10.5 })
  expect(peakOf(sim.land, 13, 10)).toMatchObject({ x: 13.5, y: 10.5 })
  expect(peakOf(sim.land, 12, 10)).toMatchObject({ x: 12.5 + 1, y: 10.5 })

  paint(sim, 20, 20, 3, { terrain: Terrain.Sand, dunes: Dunes.Many })
  paint(sim, 25, 20, 3, { terrain: Terrain.Rock, dunes: Dunes.Many })
  const dunesAt = (land: Sim['land'], x: number, y: number) => (tileBytes(land, x, y)[3] >> DUNE_SHIFT) & 3
  expect(dunesAt(sim.land, 20, 20)).toBe(Dunes.Many)
  expect(dunesAt(sim.land, 25, 20)).toBe(0)
  const loaded = reload(sim)
  expect(dunesAt(loaded.land, 20, 20)).toBe(Dunes.Many)
  expect(peakOf(loaded.land, 12, 10)).toMatchObject({ x: 13.5, y: 10.5 })
})

test('формы кисти: круг меньше квадрата, разброс — часть круга; пакетная правка считает подножие обрыва', () => {
  expect(brushTiles(0, 0, 7, 'square').length / 2).toBe(49)
  const circle = brushTiles(0, 0, 7, 'circle').length / 2
  expect(circle).toBeLessThan(49)
  expect(brushTiles(0, 0, 7, 'spray').length / 2).toBeLessThan(circle)
  const sim = world()
  paint(sim, 5, 5, 5, { terrain: Terrain.Rock, tier: 2, cliff: true })
  expect(isCliffFoot(sim.land, 5, 8)).toBe(true)
  expect(isCliffFoot(sim.land, 5, 5)).toBe(false)
})

test('прямоугольная карта, чистая пустыня, богатство месторождений и кисть биома', () => {
  const wide = createSim({ generator: DEFAULT_CONFIG, size: 320, height: 128 })
  expect(wide.bounds).toEqual({ left: -160, top: -64, right: 160, bottom: 64 })
  expect(createSim(wide.save()).bounds).toEqual(wide.bounds)

  const blank = createSim({ generator: { ...DEFAULT_CONFIG, blank: true }, size: 128 })
  for (const [x, y] of [[0, 0], [-60, 40], [50, -50]]) expect(terrainAt(blank.land, x, y)).toBe(Terrain.Sand)
  expect(depositsIn(blank, 0, 0)).toEqual([])

  const poor = createSim({ generator: { ...DEFAULT_CONFIG, depositChance: 0 }, size: 256 })
  for (let cy = -3; cy < 3; cy++) for (let cx = -3; cx < 3; cx++) expect(depositsIn(poor, cx, cy)).toEqual([])
  const rich = createSim({ generator: { ...DEFAULT_CONFIG, depositRichness: 3 }, size: 256 })
  const base = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  for (let cy = -2; cy < 2; cy++) {
    for (let cx = -2; cx < 2; cx++) {
      const spot = depositIn(base, cx, cy)
      if (spot) expect(depositIn(rich, cx, cy)!.reserve).toBeCloseTo(spot.reserve * 3, -1)
    }
  }

  paint(blank, 0, 0, 3, { biome: Biome.RedWastes })
  expect(biomeAt(blank.land, 0, 0)).toBe(Biome.RedWastes)
  expect(biomeAt(reload(blank).land, 1, 1)).toBe(Biome.RedWastes)
})

test('камера игрока задаётся, переживает сохранение и убирается', () => {
  const sim = world()
  const player = addPlayer(sim)
  expect(playerCamera(sim, player)).toBeUndefined()
  setPlayerCamera(sim, player, { x: 12, y: -7, zoom: 24 })
  expect(playerCamera(reload(sim), player)).toEqual({ x: 12, y: -7, zoom: 24 })
  setPlayerCamera(sim, player, undefined)
  expect(playerCamera(sim, player)).toBeUndefined()
})
