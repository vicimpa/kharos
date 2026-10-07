import { expect, test } from 'bun:test'
import { createAlerts } from '../src/game/alerts'
import type { Scene } from '../src/game/scene'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Health, createSim } from '../src/sim'
import { spawnUnit } from '../src/sim/units'

/** Уведомления над миром без отрисовки: им нужны только мир и номер игрока. */
function setup() {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 256 })
  const alerts = createAlerts({ sim, player: 1 } as Scene, null)
  const kinds = () => alerts.current().map(({ kind }) => kind)
  return { sim, alerts, kinds }
}

test('о замеченном противнике предупреждают не чаще раза в 12 секунд', () => {
  const { sim, alerts, kinds } = setup()
  alerts.update(0.1)
  spawnUnit(sim, 'infantry', 2, 5, 5)
  alerts.update(0.1)
  expect(kinds()).toEqual(['spotted'])
  // Ещё один враг через 5 секунд — тихо.
  alerts.update(5)
  spawnUnit(sim, 'infantry', 2, 6, 5)
  alerts.update(0.1)
  expect(alerts.current().filter(({ kind }) => kind === 'spotted')).toHaveLength(1)
  // Через 12 — снова.
  alerts.update(8)
  spawnUnit(sim, 'infantry', 2, 7, 5)
  alerts.update(0.1)
  expect(kinds().at(-1)).toBe('spotted')
  expect(alerts.current().at(-1)!.age).toBeLessThan(1)
})

test('об атаке предупреждают раз, а снова — когда враги пропали из виду и напали опять', () => {
  const { sim, alerts, kinds } = setup()
  const own = spawnUnit(sim, 'tank', 1, 0, 0)
  const foe = spawnUnit(sim, 'infantry', 2, 5, 5)
  alerts.update(0.1)
  const hit = () => {
    sim.world.get(own, Health)!.value -= 1
    alerts.update(0.1)
  }
  hit()
  expect(kinds()).toEqual(['spotted', 'attacked'])
  hit()
  hit()
  expect(kinds().filter((kind) => kind === 'attacked')).toHaveLength(1)
  // Враг пропал из виду: флаг сброшен. Вернулся и снова бьёт — снова тревога.
  sim.world.destroy(foe)
  alerts.update(0.1)
  spawnUnit(sim, 'infantry', 2, 5, 5)
  alerts.update(0.1)
  hit()
  expect(kinds().filter((kind) => kind === 'attacked')).toHaveLength(2)
})
