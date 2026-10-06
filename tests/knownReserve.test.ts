import { expect, test } from 'bun:test'
import { knownReserve } from '../src/game/knownReserve'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, depositIn, reserveLeft } from '../src/sim'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }

function firstSpot(sim: ReturnType<typeof createSim>) {
  for (let cellY = -5; cellY < 5; cellY++) for (let cellX = -5; cellX < 5; cellX++) {
    const spot = depositIn(sim, cellX, cellY)
    if (spot) return spot
  }
  throw new Error('нет месторождения')
}

test('остаток месторождения в тумане неизвестен, без тумана — настоящий', () => {
  const fogged = createSim(options)
  expect(knownReserve(fogged, 1, firstSpot(fogged))).toBeNull()
  const clear = createSim({ ...options, fog: false })
  clear.vision.update()
  const spot = firstSpot(clear)
  expect(knownReserve(clear, 1, spot)).toBe(reserveLeft(clear, spot.x, spot.y))
})
