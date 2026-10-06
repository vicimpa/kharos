import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { BUILDINGS, Producer, UNIT_TYPES, canPlace, createSim, missingRequirements, unitSpec } from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { addCredits } from '../src/sim/economy'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }

/** Ставит здания игрока 1 в ряд на скале. */
function row(types: (keyof typeof BUILDINGS)[]) {
  const sim = createSim(options)
  addCredits(sim, 1, 10000)
  for (let y = -100; y < 100; y++) {
    for (let x = -100; x < 100; x++) {
      let at = x
      const spots = types.map((type) => {
        const spot = at
        at += BUILDINGS[type].width + 1
        return spot
      })
      if (!types.every((type, i) => canPlace(sim, type, spots[i], y))) continue
      return { sim, buildings: types.map((type, i) => placeBuilding(sim.world, type, spots[i], y, 1)) }
    }
  }
  throw new Error('Не нашлось места')
}

test('требования юнитов называют существующие здания', () => {
  for (const unit of UNIT_TYPES) for (const type of unitSpec(unit).requires ?? []) expect(BUILDINGS).toHaveProperty(type)
})

test('тяжёлую технику не заказать без техцентра, с ним — можно', () => {
  const { sim, buildings } = row(['command', 'generator', 'generator', 'factory'])
  const factory = buildings[3]
  expect(missingRequirements(sim, 1, 'tank')).toEqual(['techCenter'])
  expect(missingRequirements(sim, 1, 'buggy')).toEqual([])
  sim.send(1, { type: 'produce', producer: factory, unit: 'tank' })
  sim.send(1, { type: 'produce', producer: factory, unit: 'buggy' })
  sim.advance(1 / 20)
  expect(sim.world.get(factory, Producer)!.queue).toEqual(['buggy'])

  const { sim: other, buildings: more } = row(['command', 'generator', 'generator', 'factory', 'techCenter'])
  expect(missingRequirements(other, 1, 'tank')).toEqual([])
  other.send(1, { type: 'produce', producer: more[3], unit: 'tank' })
  other.advance(1 / 20)
  expect(other.world.get(more[3], Producer)!.queue).toEqual(['tank'])
  // Чужой техцентр не в счёт.
  expect(missingRequirements(other, 2, 'tank')).toEqual(['techCenter'])
})
