import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Armed, Harvester, Hauler, Orders, Path, Position, canPlace, createSim, depositIn, depositNear, resolveOrder, type Sim } from '../src/sim'
import { dropItems } from '../src/sim/drops'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }
const TICK = 1 / 20

/** Симуляция и месторождение, справа от которого ровная скала. */
function start() {
  const sim = createSim(options)
  for (let cellY = -5; cellY < 5; cellY++) {
    for (let cellX = -5; cellX < 5; cellX++) {
      const spot = depositIn(sim, cellX, cellY)
      if (spot && spot.kind === 'metal' && canPlace(sim, 'metalYard', spot.x + 3, spot.y)) return { sim, spot }
    }
  }
  throw new Error('В мире не нашлось месторождения')
}

/** Приказ точкой и тик, чтобы он выполнился. */
function order(sim: Sim, player: number, units: number[], x: number, y: number, queue = false) {
  sim.send(player, { type: 'order', units, x, y, queue })
  sim.advance(TICK)
}

test('приказ точкой харвестеру: по месторождению на виду — копать, по неразведанному — идти, по разведанному в тумане — копать', () => {
  const { sim, spot } = start()
  const harvester = spawnUnit(sim, 'harvester', 1, spot.x - 1, spot.y)
  const state = () => sim.world.get(harvester, Harvester)!
  sim.advance(TICK)
  order(sim, 1, [harvester], spot.x + 1.5, spot.y + 0.5)
  expect(state()).toMatchObject({ x: spot.x, y: spot.y, picked: true, ordered: true })

  const other = depositNear(sim, spot.x + 60, spot.y, 50)!
  expect(sim.vision.explored(1, other.x, other.y)).toBe(false)
  order(sim, 1, [harvester], other.x + 0.5, other.y + 0.5)
  // О неразведанном игрок не знает: туда просто едут, и с прежнего месторождения приказ снимает.
  expect(state()).toMatchObject({ picked: false, parked: true })
  expect(sim.world.get(harvester, Path)).toMatchObject({ goalX: other.x, goalY: other.y })

  sim.vision.explore(1, [0, 1e9])
  expect(sim.vision.sees(1, other.x, other.y)).toBe(false)
  order(sim, 1, [harvester], other.x + 0.5, other.y + 0.5)
  expect(state()).toMatchObject({ x: other.x, y: other.y, picked: true })
})

test('приказ точкой грузовику: дроп на виду — вывозить, дроп в тумане — просто ехать', () => {
  const { sim, spot } = start()
  const truck = spawnUnit(sim, 'truck', 1, spot.x + 3, spot.y)
  const near = dropItems(sim, spot.x + 5, spot.y, { metal: 10 })!
  const far = dropItems(sim, spot.x + 80, spot.y, { metal: 10 })!
  sim.advance(TICK)
  expect(sim.vision.sees(1, spot.x + 80, spot.y)).toBe(false)
  order(sim, 1, [truck], spot.x + 5.5, spot.y + 0.5)
  expect(sim.world.get(truck, Hauler)!.pickup).toBe(near)
  order(sim, 1, [truck], spot.x + 80.5, spot.y + 0.5)
  expect(sim.world.get(truck, Hauler)!.pickup).not.toBe(far)
  expect(sim.world.get(truck, Hauler)!.pickup).toBe(-1)
  // Сама симуляция без тумана (редактор) цель там находит.
  expect(resolveOrder(sim, 1, [truck], { x: spot.x + 80.5, y: spot.y + 0.5 }, 0.3, false)).toEqual([{ type: 'pickup', units: [truck], drop: far }])
})

test('приказ точкой бойцу: с Shift встаёт в очередь атакой, чужими юнитами не командует, мусор не роняет тик', () => {
  const { sim, spot } = start()
  const gunner = spawnUnit(sim, 'infantry', 1, spot.x + 3, spot.y)
  const foe = spawnUnit(sim, 'truck', 2, spot.x + 6, spot.y)
  const at = sim.world.get(foe, Position)!
  sim.advance(TICK)
  // Чужой игрок приказывает моим юнитом: ничего не происходит.
  order(sim, 2, [gunner], at.x, at.y)
  expect(sim.world.get(gunner, Armed)!.ordered).toBe(false)
  expect(sim.world.has(gunner, Path)).toBe(false)
  // С Shift приказ встаёт в очередь уже атакой.
  order(sim, 1, [gunner], spot.x + 3.5, spot.y + 2.5)
  order(sim, 1, [gunner], at.x, at.y, true)
  expect(sim.world.get(gunner, Orders)!.list.map((item) => item.command)).toMatchObject([{ type: 'attack', target: foe }])
  // Попал рядом с юнитом, в пределах допуска, — всё равно атака.
  order(sim, 1, [gunner], at.x + 0.2, at.y)
  expect(sim.world.get(gunner, Armed)).toMatchObject({ target: foe, ordered: true })
  for (const junk of [NaN, Infinity, '5', null, {}, JSON.parse('{"toString":0,"valueOf":0}')]) {
    sim.send(1, { type: 'order', units: [gunner], x: junk, y: junk } as never)
    sim.send(1, { type: 'order', units: junk, x: 1, y: 1 } as never)
  }
  expect(() => sim.advance(TICK)).not.toThrow()
  expect(sim.world.get(gunner, Armed)).toMatchObject({ target: foe, ordered: true })
})
