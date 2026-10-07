/**
 * Скорость симуляции на разных рантаймах: один и тот же бандл гоняется под Bun и Node.
 * bun build tools/bench.ts --target=node --outfile=<файл>.mjs, потом bun <файл>.mjs и node <файл>.mjs.
 * Замеры: экономика тестовой базы 5 минут и бой двух армий по N юнитов минуту. Печатает строку JSON: время тика в мс.
 */
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, type Sim } from '../src/sim'
import { spawnSandbox } from '../src/sim/sandbox'
import { spawnUnit } from '../src/sim/units'

const TICK = 1 / 20
const options = { generator: DEFAULT_SETTINGS.generator, size: 1024 }

/** Гоняет ticks тиков и отдаёт среднее и 95-й перцентиль времени тика в мс. */
function run(sim: Sim, ticks: number) {
  const times: number[] = []
  for (let i = 0; i < ticks; i++) {
    const t = performance.now()
    sim.advance(TICK)
    times.push(performance.now() - t)
  }
  const total = times.reduce((a, b) => a + b, 0)
  times.sort((a, b) => a - b)
  return { total: Math.round(total), mean: +(total / ticks).toFixed(3), p95: +times[Math.floor(ticks * 0.95)].toFixed(3) }
}

const economy = createSim(options)
if (!spawnSandbox(economy, 1)) throw new Error('Сандбокс не встал')
const eco = run(economy, 20 * 60 * 5)

const n = Number(process.argv[2] ?? 400)
const battle = createSim({ ...options, rules: { techTree: false } })
const types = ['infantry', 'buggy', 'tank', 'rocketeer'] as const
const side = Math.ceil(Math.sqrt(n))
const ids: Record<number, number[]> = { 1: [], 2: [] }
for (const player of [1, 2]) {
  for (let i = 0; i < n; i++) {
    const x = (player === 1 ? -60 : 60) + (i % side) * 1.2
    const y = -side / 2 + Math.floor(i / side) * 1.2
    ids[player].push(spawnUnit(battle, types[i % types.length], player, x, y))
  }
}
battle.send(1, { type: 'move', units: ids[1], x: 60, y: 0 })
battle.send(2, { type: 'move', units: ids[2], x: -60, y: 0 })
const fight = run(battle, 20 * 60)

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === 'object' ? 'bun' : 'node'
console.log(JSON.stringify({ runtime, economy: eco, battle: fight }))
