import { expect, test } from 'bun:test'
import { Loop, World, component, type System } from '../src/ecs'

const Position = component('Position', { x: 0 })
const Stock = component('Stock', { ore: 0 }, { tracked: true })

// Четыре тика в секунду: шаг 0.25 представим точно, без погрешностей в накоплении.
const tickRate = 4

test('делает столько тиков, сколько накопилось времени', () => {
  const world = new World()
  const steps: number[] = []
  const loop = new Loop({ world, tickRate, update: [(_, time) => steps.push(time.tick)] })

  expect(loop.advance(0.1)).toBe(0)
  expect(loop.advance(0.2)).toBe(1)
  expect(loop.advance(0.5)).toBe(2)
  expect(steps).toEqual([0, 1, 2])
  expect(loop.time.tick).toBe(3)
  expect(loop.time.elapsed).toBe(0.75)
})

test('симуляция не зависит от частоты кадров', () => {
  const run = (frames: number[]) => {
    const world = new World()
    const entity = world.spawn(Position)
    const move: System = (world, time) => {
      for (const [, position] of world.query(Position)) position.x += 10 * time.step
    }
    const loop = new Loop({ world, tickRate, update: [move] })
    for (const seconds of frames) loop.advance(seconds)
    return world.get(entity, Position)!.x
  }
  expect(run([1])).toBe(run([0.125, 0.125, 0.25, 0.5]))
})

test('системы идут по порядку, кадр — после тиков и с долей тика', () => {
  const world = new World()
  const log: string[] = []
  const loop = new Loop({
    world,
    tickRate,
    update: [() => log.push('a'), () => log.push('b')],
    render: [(_, time) => log.push(`render ${time.alpha} ${time.delta}`)],
  })
  loop.advance(0.375)
  expect(log).toEqual(['a', 'b', 'render 0.5 0.375'])
})

test('слишком длинный кадр не догоняется целиком', () => {
  const world = new World()
  const loop = new Loop({ world, tickRate, maxTicksPerFrame: 3 })
  expect(loop.advance(10.1)).toBe(3)
  expect(loop.time.alpha).toBeLessThan(1)
  expect(loop.advance(0)).toBe(0)
})

test('изменения раздаются после каждого тика и после кадра', () => {
  const world = new World()
  const depot = world.spawn(Stock)
  const seen: number[] = []
  world.onChange(Stock, (entity) => seen.push(world.get(entity, Stock)!.ore))

  const mine: System = (world) => world.set(depot, Stock, { ore: world.get(depot, Stock)!.ore + 1 })
  const loop = new Loop({ world, tickRate, update: [mine] })
  loop.advance(0.5)
  expect(seen).toEqual([1, 2])

  world.set(depot, Stock, { ore: 10 })
  loop.advance(0)
  expect(seen).toEqual([1, 2, 10])
})
