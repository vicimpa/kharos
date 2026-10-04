import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import {
  Armed, Building, Carrier, CONTROL_RADIUS, Health, SAND_DURABILITY, Site, Turret,
  canBuild, canPlace, createSim, durabilityOf, isWalkable, siteAt, zoneOf, type BuildingType, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'
import { spawnUnit, type UnitType } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

/** Скальное место под Core и песчаный тайл в его будущей зоне. */
function frontier(sim: Sim) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!canPlace(sim, 'command', x, y)) continue
      const centerX = x + 1.5
      const centerY = y + 1.5
      for (let tileY = y - 10; tileY <= y + 12; tileY++) {
        for (let tileX = x - 10; tileX <= x + 12; tileX++) {
          if (terrainAt(sim.land, tileX, tileY) !== Terrain.Sand) continue
          if (Math.hypot(tileX + 0.5 - centerX, tileY + 0.5 - centerY) > 12) continue
          if (canPlace(sim, 'wall', tileX, tileY)) return { core: { x, y }, sand: { x: tileX, y: tileY } }
        }
      }
    }
  }
  throw new Error('Не нашлось границы скалы с песком')
}

test('стены и турели ставятся на песке, обычные здания — нет; песок оставляет 70% прочности', () => {
  const sim = createSim(options)
  const { sand } = frontier(sim)
  const defenses: BuildingType[] = ['wall', 'turret', 'rocketTurret', 'cannonTurret']

  for (const type of defenses) {
    expect(canPlace(sim, type, sand.x, sand.y)).toBe(true)
    expect(durabilityOf(sim, type, sand.x, sand.y)).toBe(SAND_DURABILITY)
  }
  expect(canPlace(sim, 'generator', sand.x, sand.y)).toBe(false)
  expect(durabilityOf(sim, 'generator', sand.x, sand.y)).toBe(1)

  // Отладочная команда проходит тем же путём определения прочности, что и обычное размещение.
  sim.send(1, { type: 'placeBuilding', building: 'wall', x: sand.x, y: sand.y })
  sim.advance(TICK)
  const wall = sim.occupancy.at(sand.x, sand.y)!
  expect(sim.world.get(wall, Health)).toMatchObject({ value: SAND_DURABILITY, max: SAND_DURABILITY })
})

test('строитель возводит стену на песке только до её песчаного предела прочности', () => {
  const sim = createSim(options)
  const { core, sand } = frontier(sim)
  placeBuilding(sim.world, 'command', core.x, core.y, 1)
  expect(canBuild(sim, 1, 'wall', sand.x, sand.y)).toBe(true)

  let builderTile: { x: number; y: number } | undefined
  for (let radius = 1; radius <= 3 && !builderTile; radius++) {
    for (let dy = -radius; dy <= radius && !builderTile; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = sand.x + dx
        const y = sand.y + dy
        if ((dx || dy) && isWalkable(sim, x, y)) {
          builderTile = { x, y }
          break
        }
      }
    }
  }
  expect(builderTile).toBeDefined()
  const builder = spawnUnit(sim, 'builder', 1, builderTile!.x, builderTile!.y)
  addCredits(sim, 1, 100)
  sim.send(1, { type: 'build', building: 'wall', x: sand.x, y: sand.y, builders: [builder] })
  sim.advance(TICK)
  const wall = siteAt(sim, sand.x, sand.y)!
  expect(wall).toBeDefined()

  seconds(sim, 3)
  expect(sim.world.has(wall, Building)).toBe(true)
  expect(sim.world.has(wall, Site)).toBe(false)
  expect(sim.world.get(wall, Health)).toMatchObject({ value: SAND_DURABILITY, max: SAND_DURABILITY })
  expect(isWalkable(sim, sand.x, sand.y)).toBe(false)
  const circles = zoneOf(sim, 1)
  const wallCircle = Array.from({ length: circles.length / 3 }, (_, i) => circles.slice(i * 3, i * 3 + 3))
    .find(([x, y]) => x === sand.x + 0.5 && y === sand.y + 0.5)
  expect(wallCircle).toEqual([sand.x + 0.5, sand.y + 0.5, 0])
})

/** Скальное место под здание не ближе min тайлов от точки: там ещё ничьей зоны нет. */
function farSpot(sim: Sim, from: { x: number; y: number }, min: number) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!canPlace(sim, 'generator', x, y)) continue
      if (Math.hypot(x + 0.5 - from.x, y + 0.5 - from.y) < min) continue
      return { x, y }
    }
  }
  throw new Error('Не нашлось скалы вдали от базы')
}

test('стены и турели ставятся вне зоны строительства, обычные здания — нет', () => {
  const sim = createSim(options)
  const { core } = frontier(sim)
  placeBuilding(sim.world, 'command', core.x, core.y, 1)
  const spot = farSpot(sim, { x: core.x + 1.5, y: core.y + 1.5 }, CONTROL_RADIUS + 8)

  expect(canBuild(sim, 1, 'generator', spot.x, spot.y)).toBe(false)
  for (const type of ['wall', 'turret', 'rocketTurret', 'cannonTurret'] as BuildingType[]) {
    expect(canBuild(sim, 1, type, spot.x, spot.y)).toBe(true)
  }
})

test('в чужой зоне не ставится и оборона', () => {
  const sim = createSim(options)
  const { core } = frontier(sim)
  placeBuilding(sim.world, 'command', core.x, core.y, 1)
  const spot = farSpot(sim, { x: core.x + 1.5, y: core.y + 1.5 }, 2 * CONTROL_RADIUS + 4)

  // Главное здание второго игрока неподалёку: место входит в его зону (12 тайлов), само здание его не занимает,
  // а до зоны первого далеко.
  let foe: { x: number; y: number } | undefined
  for (let dy = -10; dy <= 10 && !foe; dy++) {
    for (let dx = -10; dx <= 10; dx++) {
      const distance = Math.hypot(dx + 1, dy + 1)
      if (distance < 6 || distance > 10) continue
      if (canPlace(sim, 'command', spot.x + dx, spot.y + dy)) {
        foe = { x: spot.x + dx, y: spot.y + dy }
        break
      }
    }
  }
  expect(foe).toBeDefined()
  placeBuilding(sim.world, 'command', foe!.x, foe!.y, 2)

  // Второй игрок здесь строить может — место в его зоне; первый не может: рядом чужая зона.
  expect(canBuild(sim, 2, 'generator', spot.x, spot.y)).toBe(true)
  for (const type of ['wall', 'turret', 'rocketTurret', 'cannonTurret'] as BuildingType[]) {
    expect(canBuild(sim, 1, type, spot.x, spot.y)).toBe(false)
  }
})

test('стройка обороны вне зоны идёт своим ходом: свободный строитель доводит стену до конца', () => {
  const sim = createSim(options)
  const { core } = frontier(sim)
  placeBuilding(sim.world, 'command', core.x, core.y, 1)
  const spot = farSpot(sim, { x: core.x + 1.5, y: core.y + 1.5 }, CONTROL_RADIUS + 8)
  expect(canBuild(sim, 1, 'wall', spot.x, spot.y)).toBe(true)

  let builderTile: { x: number; y: number } | undefined
  for (let radius = 1; radius <= 3 && !builderTile; radius++) {
    for (let dy = -radius; dy <= radius && !builderTile; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if ((dx || dy) && isWalkable(sim, spot.x + dx, spot.y + dy)) {
          builderTile = { x: spot.x + dx, y: spot.y + dy }
          break
        }
      }
    }
  }
  expect(builderTile).toBeDefined()
  spawnUnit(sim, 'builder', 1, builderTile!.x, builderTile!.y)
  addCredits(sim, 1, 100)
  // Строителей не называем: за площадку берётся свободный — та же проверка зоны, что и у стройки.
  sim.send(1, { type: 'build', building: 'wall', x: spot.x, y: spot.y, builders: [] })
  sim.advance(TICK)
  const wall = siteAt(sim, spot.x, spot.y)!
  expect(wall).toBeDefined()

  seconds(sim, 3)
  expect(sim.world.has(wall, Building)).toBe(true)
  expect(sim.world.has(wall, Site)).toBe(false)
})

test('три оборонительные турели получают своё оружие, сами стреляют и гибнут вместе с основанием', () => {
  const sim = createSim(options)
  const types = [
    ['turret', 'gunner'],
    ['rocketTurret', 'rocket'],
    ['cannonTurret', 'cannon'],
  ] as const
  const buildings: Entity[] = []
  const mounted: Entity[] = []

  for (let i = 0; i < types.length; i++) {
    const [buildingType, turretType] = types[i]
    const building = placeBuilding(sim.world, buildingType, i * 10, 0, 1)
    const turrets = sim.world.get(building, Carrier)!.turrets as Entity[]
    expect(turrets).toHaveLength(1)
    expect(sim.world.get(turrets[0], Turret)!.type).toBe(turretType)
    expect(sim.world.has(turrets[0], Armed)).toBe(true)
    buildings.push(building)
    mounted.push(turrets[0])
  }

  const foe = spawnUnit(sim, 'infantry', 2, 4, 0)
  seconds(sim, 1)
  expect(sim.world.get(foe, Health)?.value ?? 0).toBeLessThan(1)

  // У прикреплённой турели нет своей прочности: разрушается основание — следующий тик убирает сироту.
  expect(sim.world.has(mounted[0], Health)).toBe(false)
  sim.world.destroy(buildings[0])
  sim.advance(TICK)
  expect(sim.world.alive(mounted[0])).toBe(false)
})

test('турель здания не пытается гнаться за дальним стрелком и перестаёт работать под разбором', () => {
  const sim = createSim(options)
  const defense = placeBuilding(sim.world, 'turret', 0, 0, 1)
  const gun = sim.world.get(defense, Carrier)!.turrets[0] as Entity
  const lancer = spawnUnit(sim, 'lancer', 2, 7, 0)

  // Лазер достаёт до здания, а его пулемёт в ответ — нет. Здание не должно попадать в логику движения юнита.
  sim.send(2, { type: 'attack', units: [lancer], target: defense })
  seconds(sim, 2)
  expect(sim.world.get(defense, Health)!.value).toBeLessThan(1)
  expect(sim.world.get(gun, Armed)!.chase).toBe(false)
  expect(sim.world.get(gun, Armed)!.target).toBe(-1)

  sim.world.destroy(lancer)
  const tank = spawnUnit(sim, 'tank', 2, 4, 0)
  seconds(sim, 0.5)
  sim.world.add(defense, Site({ type: 'turret', progress: 1, demolish: true }))
  // Даём уже выпущенным пулям долететь, затем проверяем, что новых выстрелов нет.
  seconds(sim, 0.5)
  const stopped = sim.world.get(tank, Health)!.value
  seconds(sim, 1)
  expect(sim.world.get(tank, Health)!.value).toBe(stopped)
})

/** Стена игрока 1 поперёк пути с запада на восток, стрелок игрока 2 к западу от неё, цель игрока 3 — к востоку. */
function behindWall(sim: Sim, shooter: UnitType, target: UnitType) {
  const wall = placeBuilding(sim.world, 'wall', 2, 0, 1)
  const gun = spawnUnit(sim, shooter, 2, 0, 0)
  const foe = spawnUnit(sim, target, 3, 4, 0)
  sim.send(2, { type: 'attack', units: [gun], target: foe })
  return { wall, gun, foe }
}

test('стена принимает на себя пули, ядро и лазер: цель за ней остаётся целой', () => {
  for (const shooter of ['infantry', 'tank', 'lancer'] as const) {
    const sim = createSim(options)
    const { wall, foe } = behindWall(sim, shooter, 'builder')
    seconds(sim, 2)

    expect(sim.world.get(foe, Health)!.value).toBe(1)
    expect(sim.world.get(wall, Health)!.value).toBeLessThan(1)
  }
})

test('ракета летит поверх стены, разряд бьёт через неё', () => {
  const rocket = createSim(options)
  const rocketWall = behindWall(rocket, 'rocketeer', 'builder')
  seconds(rocket, 3)
  expect(rocket.world.get(rocketWall.foe, Health)!.value).toBeLessThan(1)
  expect(rocket.world.get(rocketWall.wall, Health)!.value).toBe(1)

  // Разряд идёт к цели напрямую; стены он не замечает, и в цепь ему попадается разве что сама стена.
  const arc = createSim(options)
  const arcWall = behindWall(arc, 'tesla', 'builder')
  seconds(arc, 1.5)
  expect(arc.world.get(arcWall.foe, Health)!.value).toBeLessThan(1)
})

test('своя стена своим не мешает: через неё стреляют, как через бруствер', () => {
  const sim = createSim(options)
  const own = placeBuilding(sim.world, 'wall', 2, 0, 1)
  const gun = spawnUnit(sim, 'infantry', 1, 0, 0)
  const foe = spawnUnit(sim, 'builder', 2, 4, 0)
  sim.send(1, { type: 'attack', units: [gun], target: foe })
  seconds(sim, 2)
  expect(sim.world.get(foe, Health)!.value).toBeLessThan(1)
  expect(sim.world.get(own, Health)!.value).toBe(1)
})

test('турель здания стоит выше стены и бьёт поверх неё — в отличие от пехоты за той же стеной', () => {
  const sim = createSim(options)
  placeBuilding(sim.world, 'turret', 0, 0, 1)
  const enemyWall = placeBuilding(sim.world, 'wall', 2, 0, 2)
  const foe = spawnUnit(sim, 'builder', 2, 4, 0)
  // Та же стена, но стрелок — пехотинец: его пули в стену и попадут.
  const wall = placeBuilding(sim.world, 'wall', 2, 5, 2)
  const gun = spawnUnit(sim, 'infantry', 1, 0, 5)
  const behind = spawnUnit(sim, 'builder', 2, 4, 5)
  sim.send(1, { type: 'attack', units: [gun], target: behind })

  seconds(sim, 2)
  expect(sim.world.get(foe, Health)!.value).toBeLessThan(1)
  expect(sim.world.get(enemyWall, Health)!.value).toBe(1)
  expect(sim.world.get(behind, Health)!.value).toBe(1)
  expect(sim.world.get(wall, Health)!.value).toBeLessThan(1)
})
