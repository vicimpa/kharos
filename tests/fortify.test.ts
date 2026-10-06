import { expect, test } from 'bun:test'
import { fortification } from '../src/sim/fortify'

test('укрепление: разные схемы, ни одной постройки на главном здании и ни одной клетки дважды, всегда есть турели', () => {
  let seed = 1
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const shapes = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const pieces = fortification(random)
    const keys = pieces.map(({ u, v }) => `${u},${v}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const { u, v } of pieces) expect(Math.abs(u) > 2 || Math.abs(v) > 2).toBe(true)
    expect(pieces.some((piece) => piece.type !== 'wall')).toBe(true)
    shapes.add(keys.sort().join(' '))
  }
  expect(shapes.size).toBeGreaterThan(40)
})
