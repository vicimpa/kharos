import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { DEPOSIT_KINDS, Building, Hauler, Harvester, Owner, Unit, createSim, powerStates, spawnSandbox, stockOf, zonesOf, type Sim } from '../src/sim'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}

test('тестовая карта: готовая база с энергией, грузовики сами возят добытое в хранилища', () => {
  const sim = createSim(options)
  expect(spawnSandbox(sim, 1)).toBeDefined()
  const types: string[] = []
  for (const [, building] of sim.world.query(Building, Owner)) types.push(building.type)
  for (const type of ['mine', 'command', 'silo', 'spaceport', 'factory', 'barracks', 'generator', 'matter'] as const) expect(types).toContain(type)
  // Всё стоит в одной зоне, и энергии хватает всем.
  expect(zonesOf(sim, 1).length).toBeGreaterThan(0)
  expect([...powerStates(sim).values()].every((state) => state !== 'starved')).toBe(true)

  const units: Entity[] = []
  for (const [entity] of sim.world.query(Unit, Owner)) units.push(entity)
  const trucks = units.filter((entity) => sim.world.has(entity, Hauler) && !sim.world.has(entity, Harvester))
  expect(trucks.length).toBe(4)
  expect(trucks.filter((entity) => sim.world.get(entity, Hauler)!.mine >= 0).length).toBe(1)
  expect(units.length).toBeGreaterThan(trucks.length + 5)

  // Шахта работает: руда идёт через переработку, и металла в хранилищах становится больше.
  const before = stockOf(sim, 1).items.metal ?? 0
  seconds(sim, 120)
  expect(stockOf(sim, 1).items.metal ?? 0).toBeGreaterThan(before + DEPOSIT_KINDS.metal.rate * 60)
})
