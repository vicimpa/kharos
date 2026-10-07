import { expect, test } from 'bun:test'
import { World, component } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Building, Pave, Position, canPlace, createSim, type Sim } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
/** Один тик симуляции: по умолчанию их двадцать в секунду. */
const TICK = 1 / 20

/** Ближайший к началу мира тайл, где встаёт турель 1×1. */
function freeTile(sim: Sim) {
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) if (canPlace(sim, 'turret', x, y)) return { x, y }
  }
  throw new Error('В мире не нашлось скалы')
}

test('команда выполняется в начале следующего тика, а не сразу', () => {
  const sim = createSim(options)
  addCredits(sim, 1, 1000)
  const { x, y } = freeTile(sim)
  sim.send(1, { type: 'pave', kind: 'road', tiles: [x, y], builders: [] })
  expect(sim.paving.at(x, y)).toBeUndefined()

  expect(sim.advance(TICK)).toBe(1)
  expect(sim.paving.at(x, y)).toBeDefined()
})

test('негодная команда отбрасывается', () => {
  const sim = createSim(options)
  addCredits(sim, 1, 1000)
  const { x, y } = freeTile(sim)
  // Две одинаковые команды за один тик: вторая метит в уже занятый тайл.
  sim.send(1, { type: 'pave', kind: 'road', tiles: [x, y], builders: [] })
  sim.send(1, { type: 'pave', kind: 'road', tiles: [x, y], builders: [] })
  // Команды приходят извне и могут быть какими угодно.
  sim.send(1, { type: 'pave', kind: 'nonsense' as 'road', tiles: [x + 1, y], builders: [] })
  sim.send(1, { type: 'pave', kind: 'road', tiles: [x + 0.5, y], builders: [] })
  sim.send(1, { type: 'pave', kind: 'road', tiles: 'x' as never, builders: [] })
  sim.send(1, { type: 'explode' } as never)
  sim.advance(TICK)
  expect(sim.world.count(Pave)).toBe(1)
})

test('за границами карты строить нельзя', () => {
  const wide = createSim(options)
  const { x, y } = freeTile(wide)
  // Карта, которая кончается ровно перед этим тайлом.
  const narrow = createSim({ ...options, size: Math.max(x, y) * 2 })
  expect(narrow.bounds.right).toBe(Math.max(x, y))
  expect(canPlace(narrow, 'turret', x, y)).toBe(false)
  expect(canPlace(createSim({ ...options, size: (Math.max(x, y) + 1) * 2 }), 'turret', x, y)).toBe(true)
})

test('сохранение восстанавливает мир, тик и номера сущностей', () => {
  const sim = createSim(options)
  const site = freeTile(sim)
  placeBuilding(sim.world, 'turret', site.x, site.y, 1)
  sim.advance(TICK * 3)
  // Через JSON: сохранение должно переживать диск и сеть.
  const save = JSON.parse(JSON.stringify(sim.save()))

  const loaded = createSim(save)
  expect(loaded.time.tick).toBe(3)
  expect(loaded.time.elapsed).toBe(sim.time.elapsed)
  expect(loaded.save()).toEqual(save)

  const rows = (sim: Sim) => {
    const found: unknown[] = []
    for (const [entity, position, building] of sim.world.query(Position, Building)) {
      found.push([entity, position.x, position.y, building.type])
    }
    return found
  }
  expect(rows(loaded)).toEqual(rows(sim))

  // Занятость восстановилась вместе со зданиями, новые сущности не занимают старые номера.
  const [first] = sim.world.query(Position, Building)
  expect(loaded.occupancy.at(first[1].x, first[1].y)).toBe(first[0])
  const { x, y } = freeTile(loaded)
  placeBuilding(loaded.world, 'turret', x, y, 1)
  expect(loaded.occupancy.at(x, y)!).toBeGreaterThanOrEqual(save.world.next)
})

test('две симуляции с одинаковыми командами дают одинаковый мир', () => {
  const run = (frames: number[]) => {
    const sim = createSim(options)
    addCredits(sim, 1, 1000)
    const { x, y } = freeTile(sim)
    sim.send(1, { type: 'pave', kind: 'road', tiles: [x, y, x + 1, y], builders: [] })
    for (const seconds of frames) sim.advance(seconds)
    return sim.save()
  }
  expect(run([TICK, TICK])).toEqual(run([TICK * 2]))
})

test('снимок мира берёт только перечисленные компоненты и не делит данные с миром', () => {
  const Cargo = component('Cargo', () => ({ items: [] as string[] }))
  const Selected = component('Selected')
  const world = new World()
  const truck = world.spawn(Cargo({ items: ['ore'] }), Selected)
  world.spawn(Selected)

  const snapshot = world.snapshot([Cargo])
  expect(snapshot.entities).toEqual([[truck, { Cargo: { items: ['ore'] } }]])
  world.get(truck, Cargo)!.items.push('metal')
  expect(snapshot.entities[0][1].Cargo).toEqual({ items: ['ore'] })

  const copy = new World()
  copy.restore(snapshot, [Cargo, Selected])
  expect(copy.get(truck, Cargo)).toEqual({ items: ['ore'] })
  expect(copy.has(truck, Selected)).toBe(false)
  expect(copy.spawn()).toBe(snapshot.next as typeof truck)
})
