import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Building, Owner, SCENES, stanceOf, Site, TRAINING_PLAYER, Unit, createSim, type Sim, type SceneName } from '../src/sim'

const STEP = 1 / 20
const PLAYER = 1

/** Мир сценки на крошечной карте без тумана; ищет зерно, на котором сценка встаёт. */
function stage(name: SceneName) {
  for (let seed = 1; seed < 20; seed++) {
    const sim = createSim({ generator: { ...DEFAULT_SETTINGS.generator, seed }, size: 128, fog: false })
    const scene = SCENES[name]()
    if (scene.create(sim, PLAYER)) return { sim, scene }
  }
  throw new Error(`Сценка ${name} не встала ни на одном зерне`)
}

/** Ведёт мир seconds секунд, как фон меню: сценка — раз в полсекунды. Возвращает, кончилась ли она. */
function play({ sim, scene }: ReturnType<typeof stage>, seconds: number) {
  for (let i = 0; i < seconds / STEP; i++) {
    sim.advance(STEP)
    if (i % 10 === 9 && scene.drive && !scene.drive(sim, PLAYER, 0.5)) return true
  }
  return false
}

const count = (sim: Sim, component: typeof Unit | typeof Building | typeof Site, player: number) => {
  let n = 0
  for (const [, , owner] of sim.world.query(component, Owner)) if (owner.player === player) n++
  return n
}

test('стройка: бригада поднимает здания одно за другим', () => {
  const staged = stage('construction')
  const before = count(staged.sim, Building, PLAYER)
  play(staged, 90)
  expect(count(staged.sim, Building, PLAYER)).toBeGreaterThan(before + 2)
})

test('оборона: волны идут на стену, а турели их встречают', () => {
  const staged = stage('defense')
  staged.sim.advance(STEP)
  const walls = count(staged.sim, Building, PLAYER)
  let foes = 0
  for (let i = 0; i < 60 && !foes; i++) {
    play(staged, 1)
    foes = count(staged.sim, Unit, TRAINING_PLAYER)
  }
  expect(foes).toBeGreaterThan(0)
  play(staged, 60)
  // Бой был: кто-то из волны погиб или стена пострадала.
  expect(count(staged.sim, Unit, TRAINING_PLAYER) < foes || count(staged.sim, Building, PLAYER) < walls).toBe(true)
})

test('добыча и бои встают на крошечной карте; бой кончается', () => {
  for (const name of ['mining', 'battle', 'armor', 'infantry', 'air'] as const) expect(count(stage(name).sim, Unit, PLAYER) + 1).toBeGreaterThan(1)
  expect(play(stage('infantry'), 120)).toBe(true)
})

test('в сценках боя все бойцы агрессивны: под огнём не стоят, а идут на врага', () => {
  const { sim } = stage('battle')
  let units = 0
  for (const [entity] of sim.world.query(Unit)) {
    units++
    expect(stanceOf(sim, entity)).toBe('aggressive')
  }
  expect(units).toBeGreaterThan(0)
})
