import { describe, expect, test } from 'bun:test'
import { World, component, type Entity } from '../src/ecs'

const Position = component('Position', { x: 0, y: 0 })
const Velocity = component('Velocity', { x: 0, y: 0 })
const Stock = component('Stock', { ore: 0, capacity: 100 }, { tracked: true })
const Path = component('Path', () => ({ points: [] as number[] }))
const Selected = component('Selected')

describe('сущности и компоненты', () => {
  test('spawn задаёт значения по умолчанию и начальные', () => {
    const world = new World()
    const entity = world.spawn(Position({ x: 5 }), Velocity)
    expect(world.get(entity, Position)).toEqual({ x: 5, y: 0 })
    expect(world.get(entity, Velocity)).toEqual({ x: 0, y: 0 })
    expect(world.has(entity, Stock)).toBe(false)
    expect(world.get(entity, Stock)).toBeUndefined()
  })

  test('номера сущностей не переиспользуются', () => {
    const world = new World()
    const first = world.spawn()
    world.destroy(first)
    const second = world.spawn()
    expect(second).not.toBe(first)
    expect(world.alive(first)).toBe(false)
    expect(world.alive(second)).toBe(true)
  })

  test('функция в defaults даёт каждой сущности свой экземпляр', () => {
    const world = new World()
    const a = world.spawn(Path)
    const b = world.spawn(Path)
    world.get(a, Path)!.points.push(1)
    expect(world.get(b, Path)!.points).toEqual([])
  })

  test('миры независимы', () => {
    const a = new World()
    const b = new World()
    const inA = a.spawn(Position({ x: 1 }))
    const inB = b.spawn(Position({ x: 99 }))
    expect(a.get(inA, Position)!.x).toBe(1)
    expect(b.get(inB, Position)!.x).toBe(99)
  })

  test('destroy убирает все компоненты', () => {
    const world = new World()
    const entity = world.spawn(Position, Velocity, Selected)
    world.destroy(entity)
    expect(world.size).toBe(0)
    expect(world.count(Position)).toBe(0)
    expect(world.has(entity, Selected)).toBe(false)
  })

  test('add для уничтоженной сущности ничего не делает', () => {
    const world = new World()
    const entity = world.spawn()
    world.destroy(entity)
    world.add(entity, Position)
    expect(world.count(Position)).toBe(0)
  })

  test('remove сохраняет данные остальных сущностей', () => {
    const world = new World()
    const entities = [1, 2, 3].map((x) => world.spawn(Position({ x })))
    world.remove(entities[0], Position)
    expect(world.get(entities[1], Position)!.x).toBe(2)
    expect(world.get(entities[2], Position)!.x).toBe(3)
    expect(world.count(Position)).toBe(2)
  })
})

describe('set', () => {
  test('обычный компонент меняется на месте', () => {
    const world = new World()
    const entity = world.spawn(Position)
    const position = world.get(entity, Position)!
    world.set(entity, Position, { x: 7 })
    expect(world.get(entity, Position)).toBe(position)
    expect(position.x).toBe(7)
  })

  test('отслеживаемый компонент неизменяем и заменяется целиком', () => {
    const world = new World()
    const entity = world.spawn(Stock)
    const before = world.get(entity, Stock)!
    expect(() => {
      ;(before as { ore: number }).ore = 30
    }).toThrow()
    world.set(entity, Stock, { ore: 30 })
    expect(before.ore).toBe(0)
    expect(world.get(entity, Stock)).toEqual({ ore: 30, capacity: 100 })
  })

  test('добавляет компонент, если его не было', () => {
    const world = new World()
    const entity = world.spawn()
    world.set(entity, Stock, { ore: 3 })
    expect(world.get(entity, Stock)).toEqual({ ore: 3, capacity: 100 })
  })
})

describe('query', () => {
  test('возвращает только сущности со всеми компонентами', () => {
    const world = new World()
    const moving = world.spawn(Position, Velocity({ x: 2 }))
    world.spawn(Position)
    world.spawn(Velocity)

    const found: Entity[] = []
    for (const [entity, position, velocity] of world.query(Position, Velocity)) {
      position.x += velocity.x
      found.push(entity)
    }
    expect(found).toEqual([moving])
    expect(world.get(moving, Position)!.x).toBe(2)
  })

  test('неизвестный миру компонент даёт пустой результат', () => {
    const world = new World()
    world.spawn(Position)
    expect([...world.query(Position, Stock)]).toEqual([])
  })

  test('изменения состава во время обхода применяются после него', () => {
    const world = new World()
    const entities = [1, 2, 3, 4].map((x) => world.spawn(Position({ x })))

    let visited = 0
    for (const [entity] of world.query(Position)) {
      visited++
      world.destroy(entity)
      world.spawn(Position)
      expect(world.count(Position)).toBe(4)
    }
    expect(visited).toBe(4)
    expect(entities.some((entity) => world.alive(entity))).toBe(false)
    expect(world.count(Position)).toBe(4)
  })

  test('досрочный выход из обхода тоже применяет отложенное', () => {
    const world = new World()
    const entity = world.spawn(Position)
    for (const _ of world.query(Position)) {
      world.destroy(entity)
      break
    }
    expect(world.alive(entity)).toBe(false)
  })
})

describe('observe', () => {
  test('вызывает enter при появлении набора и очистку при его потере', () => {
    const world = new World()
    const log: string[] = []
    world.observe([Position, Selected], (entity, position) => {
      log.push(`enter ${entity} ${position.x}`)
      return () => log.push(`leave ${entity}`)
    })

    const entity = world.spawn(Position({ x: 4 }))
    expect(log).toEqual([])
    world.add(entity, Selected)
    world.remove(entity, Selected)
    world.add(entity, Selected)
    world.destroy(entity)
    expect(log).toEqual([`enter ${entity} 4`, `leave ${entity}`, `enter ${entity} 4`, `leave ${entity}`])
  })

  test('сразу срабатывает для существующих сущностей, а отписка всё очищает', () => {
    const world = new World()
    const entity = world.spawn(Position)
    let active = 0
    const stop = world.observe([Position], () => {
      active++
      return () => active--
    })
    expect(active).toBe(1)
    stop()
    expect(active).toBe(0)

    world.remove(entity, Position)
    world.add(entity, Position)
    expect(active).toBe(0)
  })
})

describe('onChange', () => {
  test('сообщает об изменениях в flush(), по разу на сущность', () => {
    const world = new World()
    const changed: Entity[] = []
    world.onChange(Stock, (entity) => changed.push(entity))

    const depot = world.spawn(Stock)
    world.set(depot, Stock, { ore: 10 })
    world.set(depot, Stock, { ore: 20 })
    expect(changed).toEqual([])
    world.flush()
    expect(changed).toEqual([depot])
    world.flush()
    expect(changed).toEqual([depot])
  })

  test('set с теми же значениями не считается изменением', () => {
    const world = new World()
    const depot = world.spawn(Stock({ ore: 5 }))
    let calls = 0
    world.onChange(Stock, () => calls++)
    world.set(depot, Stock, { ore: 5 })
    world.flush()
    expect(calls).toBe(0)
  })

  test('touch, удаление компонента и отписка', () => {
    const world = new World()
    const entity = world.spawn(Position)
    let calls = 0
    const stop = world.onChange(Position, () => calls++)

    world.get(entity, Position)!.x = 3
    world.touch(entity, Position)
    world.flush()
    expect(calls).toBe(1)

    world.remove(entity, Position)
    world.flush()
    expect(calls).toBe(2)

    stop()
    world.add(entity, Position)
    world.flush()
    expect(calls).toBe(2)
  })
})
