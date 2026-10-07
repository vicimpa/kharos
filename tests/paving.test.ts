import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import {
  BRIDGE_COST, Building, CORE, FOUNDATION_COST, Owner, Pave, Position, ROAD_COST, ROAD_SPEED, Site, Unit,
  FOUNDATION_SPEED, buildSpeed, canBuild, canPave, canPlace, createSim, creditsOf, isPaved, spawnStartingUnits, type Sim,
} from '../src/sim'
import { spawnUnit, terrainSpeed } from '../src/sim/units'
import { canDeploy } from '../src/sim/conversion'
import { breakSlabs } from '../src/sim/combat'
import { inCircles, zoneOf, zonesOf } from '../src/sim/zones'
import { placeBuilding } from '../src/sim/buildings'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
function unitsOf(sim: Sim, type: string) {
  const found: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === type) found.push(entity)
  return found
}

/** Игрок 1 развернул главное здание на просторной скале; рядом строители. */
function start() {
  const sim = createSim(options)
  const rock = (x: number, y: number) => {
    for (let tileY = y; tileY < y + 12; tileY++) {
      for (let tileX = x; tileX < x + 12; tileX++) if (terrainAt(sim.land, tileX, tileY) !== Terrain.Rock) return false
    }
    return true
  }
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!rock(x, y)) continue
      spawnStartingUnits(sim, 1, x + 2, y + 2)
      sim.send(1, { type: 'deploy', unit: unitsOf(sim, 'mcv')[0] })
      seconds(sim, 6)
      let core: Entity | undefined
      for (const [entity, building, owner] of sim.world.query(Building, Owner)) if (building.type === CORE && owner.player === 1) core = entity
      return { sim, core: core!, builders: unitsOf(sim, 'builder'), x, y }
    }
  }
  throw new Error('В мире не нашлось места под базу')
}

/** Ближайший к (x, y) квадрат side×side сплошной местности terrain. */
function find(sim: Sim, terrain: Terrain, x: number, y: number, side: number) {
  for (let radius = 0; radius < 200; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        let all = true
        for (let ty = 0; ty < side && all; ty++) for (let tx = 0; tx < side && all; tx++) all = terrainAt(sim.land, x + dx + tx, y + dy + ty) === terrain
        if (all) return { x: x + dx, y: y + dy }
      }
    }
  }
  throw new Error('Не нашлось местности')
}

/** Кладёт готовое покрытие без строителей. */
const lay = (sim: Sim, kind: 'foundation' | 'road', x: number, y: number) =>
  sim.world.spawn(Position({ x, y }), Pave({ kind, done: true, work: 1 }), Owner({ player: 1 }))

test('строители кладут дорогу: тайлы оплачены сразу, достраиваются и ускоряют наземных', () => {
  const { sim, builders, x, y } = start()
  const credits = creditsOf(sim, 1)
  const tiles = [x + 5, y + 9, x + 6, y + 9, x + 7, y + 9]
  sim.send(1, { type: 'pave', kind: 'road', tiles, builders })
  seconds(sim, TICK)
  expect(creditsOf(sim, 1)).toBe(credits - 3 * ROAD_COST)
  expect(isPaved(sim, 'road', x + 5, y + 9)).toBe(false)
  // На уже покрытый тайл второй раз не кладут.
  expect(canPave(sim, 1, 'road', x + 5, y + 9)).toBe(false)
  seconds(sim, 15)
  for (let i = 0; i < tiles.length; i += 2) expect(isPaved(sim, 'road', tiles[i], tiles[i + 1])).toBe(true)
  expect(terrainSpeed(sim, 'buggy', x + 6, y + 9)).toBe(ROAD_SPEED)
  expect(terrainSpeed(sim, 'buggy', x + 6, y + 10)).toBe(1)
  // По фундаменту — быстрее скалы, но медленнее дороги.
  lay(sim, 'foundation', x + 6, y + 10)
  expect(terrainSpeed(sim, 'buggy', x + 6, y + 10)).toBe(FOUNDATION_SPEED)
  expect(FOUNDATION_SPEED).toBeGreaterThan(1)
  expect(FOUNDATION_SPEED).toBeLessThan(ROAD_SPEED)
})

test('дорога по болоту — мост: дороже, болото под ним не вязнет', () => {
  const { sim, x, y } = start()
  const swamp = find(sim, Terrain.Swamp, x, y, 1)
  expect(terrainSpeed(sim, 'tank', swamp.x, swamp.y)).toBeLessThan(1)
  // Фундамент на болото не кладут.
  expect(canPave(sim, 1, 'foundation', swamp.x, swamp.y)).toBe(false)
  expect(canPave(sim, 1, 'road', swamp.x, swamp.y)).toBe(true)
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'pave', kind: 'road', tiles: [swamp.x, swamp.y], builders: [] })
  seconds(sim, TICK)
  expect(creditsOf(sim, 1)).toBe(credits - BRIDGE_COST)
  sim.world.get(sim.paving.at(swamp.x, swamp.y)!, Pave)!.done = true
  expect(terrainSpeed(sim, 'tank', swamp.x, swamp.y)).toBe(ROAD_SPEED)
})

test('фундамент на песке разрешает стройку, но зону не заменяет', () => {
  const { sim, x, y } = start()
  const sand = find(sim, Terrain.Sand, x + 40, y + 40, 2)
  expect(canPlace(sim, 'generator', sand.x, sand.y)).toBe(false)
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) lay(sim, 'foundation', sand.x + dx, sand.y + dy)
  expect(canPlace(sim, 'generator', sand.x, sand.y)).toBe(true)
  // Здание, которому нужна зона, вне её не ставят и на фундаменте; оборону — можно.
  expect(canBuild(sim, 1, 'generator', sand.x, sand.y)).toBe(false)
  expect(canBuild(sim, 1, 'turret', sand.x, sand.y)).toBe(true)
  // На песке с фундаментом строят чуть медленнее, чем на голой скале.
  expect(buildSpeed(sim, 'generator', sand.x, sand.y)).toBeLessThan(1)

})

test('снимают покрытие строители: недостроенное — сразу с возвратом, готовое разбирают; без строителей — никак', () => {
  const { sim, builders, x, y } = start()
  const credits = creditsOf(sim, 1)
  const far = find(sim, Terrain.Rock, x + 60, y + 60, 1)
  sim.send(1, { type: 'pave', kind: 'foundation', tiles: [far.x, far.y], builders: [] })
  seconds(sim, TICK)
  expect(creditsOf(sim, 1)).toBe(credits - FOUNDATION_COST)
  sim.send(1, { type: 'unpave', tiles: [far.x, far.y], builders: [] })
  seconds(sim, TICK)
  expect(sim.paving.at(far.x, far.y)).toBeDefined()
  const before = creditsOf(sim, 1)
  sim.send(1, { type: 'unpave', tiles: [far.x, far.y], builders })
  seconds(sim, TICK)
  expect(sim.paving.at(far.x, far.y)).toBeUndefined()
  expect(creditsOf(sim, 1)).toBe(before + FOUNDATION_COST)

  const near = lay(sim, 'road', x + 6, y + 9)
  sim.send(1, { type: 'unpave', tiles: [x + 6, y + 9], builders })
  seconds(sim, TICK)
  // Пока разбирают, дорога ещё работает.
  expect(sim.world.get(near, Pave)!.remove).toBe(true)
  expect(isPaved(sim, 'road', x + 6, y + 9)).toBe(true)
  seconds(sim, 10)
  expect(sim.paving.at(x + 6, y + 9)).toBeUndefined()
})

test('на фундаменте на скале здание строится вдвое быстрее', () => {
  const progress = (paved: boolean) => {
    const { sim, builders, x, y } = start()
    const at = { x: x + 7, y: y + 4 }
    if (paved) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) lay(sim, 'foundation', at.x + dx, at.y + dy)
    sim.send(1, { type: 'build', building: 'generator', x: at.x, y: at.y, builders })
    seconds(sim, 4)
    for (const [, site] of sim.world.query(Site)) return site.progress
    return Infinity
  }
  const bare = progress(false)
  const paved = progress(true)
  expect(bare).toBeGreaterThan(0)
  expect(paved).toBeGreaterThan(bare * 1.5)
})

test('по покрытию не стреляют и оно не мешает ходить', () => {
  const { sim, x, y } = start()
  const entity: Entity = lay(sim, 'road', x + 5, y + 10)
  expect(sim.occupancy.at(x + 5, y + 10)).toBeUndefined()
  expect(sim.world.has(entity, Building)).toBe(false)
})

test('фундамент, сплошь примыкающий к зоне, расширяет её на клетку вокруг себя; отдельный — нет', () => {
  const { sim, x, y } = start()
  // Полоса скалы или песка от базы наружу, дальше зоны главного здания.
  const row = y + 6
  let end = x + 6
  const usable = (tx: number) => [Terrain.Rock, Terrain.Sand].includes(terrainAt(sim.land, tx, row) as never)
  while (usable(end + 1) && end < x + 40) end++
  expect(end).toBeGreaterThanOrEqual(x + 22)
  const beyond = end + 1
  // Отдельный островок за пределами зоны зону не тянет.
  lay(sim, 'foundation', end, row)
  expect(inCircles(zoneOf(sim, 1), end + 0.5, row + 0.5)).toBe(false)
  for (let tx = x + 6; tx < end; tx++) lay(sim, 'foundation', tx, row)
  expect(inCircles(zoneOf(sim, 1), end + 0.5, row + 0.5)).toBe(true)
  expect(inCircles(zoneOf(sim, 1), beyond + 0.5, row + 0.5)).toBe(true)
  expect(inCircles(zoneOf(sim, 1), beyond + 2.5, row + 0.5)).toBe(false)
  // Разрыв полосы — и дальний конец из зоны выпадает.
  sim.world.destroy(sim.paving.at(x + 18, row)!)
  expect(inCircles(zoneOf(sim, 1), end + 0.5, row + 0.5)).toBe(false)
})

test('наземный взрыв разбивает фундамент под собой, пуля — нет', () => {
  const { sim, x, y } = start()
  for (let dx = 0; dx < 3; dx++) lay(sim, 'foundation', x + 4 + dx, y + 10)
  breakSlabs(sim, x + 5.5, y + 10.5, 0.2)
  expect(sim.paving.at(x + 5, y + 10)).toBeDefined()
  breakSlabs(sim, x + 5.5, y + 10.5, 1)
  expect(sim.paving.at(x + 5, y + 10)).toBeUndefined()
  expect(sim.paving.at(x + 4, y + 10)).toBeDefined()
  breakSlabs(sim, x + 5, y + 10.5, 3)
  expect(sim.paving.at(x + 4, y + 10)).toBeUndefined()
  expect(sim.paving.at(x + 6, y + 10)).toBeUndefined()
})

test('MCV разворачивается на фундаменте, лежащем на песке', () => {
  const { sim, x, y } = start()
  const sand = find(sim, Terrain.Sand, x + 40, y + 40, 3)
  const mcv = spawnUnit(sim, 'mcv', 1, sand.x + 1, sand.y + 1)
  expect(canDeploy(sim, 1, mcv)).toBe(false)
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) lay(sim, 'foundation', sand.x + dx, sand.y + dy)
  expect(canDeploy(sim, 1, mcv)).toBe(true)
  sim.send(1, { type: 'deploy', unit: mcv })
  seconds(sim, 6)
  expect(sim.occupancy.at(sand.x + 1, sand.y + 1)).toBeDefined()
})

test('полоса фундамента от новой зоны подхватывает базу, оставшуюся без главного здания', () => {
  const sim = createSim(options)
  // Ряд скалы: новое главное здание слева, старая база справа, между ними — фундамент.
  let row = { x: 0, y: 0 }
  search: for (let y = -200; y < 200; y++) {
    for (let x = -200; x < 200; x++) {
      let ok = true
      for (let ty = y; ty < y + 3 && ok; ty++) for (let tx = x; tx < x + 34 && ok; tx++) ok = terrainAt(sim.land, tx, ty) === Terrain.Rock
      if (ok) {
        row = { x, y }
        break search
      }
    }
  }
  const { x, y } = row
  placeBuilding(sim.world, 'command', x, y, 1)
  const generator = placeBuilding(sim.world, 'generator', x + 26, y, 1)
  const yard = placeBuilding(sim.world, 'metalYard', x + 30, y, 1)
  const inZone = (entity: Entity) => zonesOf(sim, 1).some((zone) => zone.buildings.includes(entity))
  expect(inZone(generator)).toBe(false)
  for (let tx = x + 3; tx < x + 26; tx++) lay(sim, 'foundation', tx, y + 2)
  expect(inZone(generator)).toBe(true)
  // Дальше зону тянет уже само здание: соседнее хранилище тоже в ней.
  expect(inZone(yard)).toBe(true)
})
