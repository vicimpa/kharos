/**
 * Нагрузка: две армии по N юнитов сходятся в бою. Печатает время тика с приказом и обычного тика.
 * bun run stress [N]
 */
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, Position, Unit, Owner } from '../src/sim'
import { spawnUnit } from '../src/sim/units'

const n = Number(process.argv[2] ?? 500)
const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } })
const types = ['infantry', 'buggy', 'tank', 'rocketeer'] as const
const side = Math.ceil(Math.sqrt(n))
const ids: Record<number, number[]> = { 1: [], 2: [] }
for (const player of [1, 2]) {
  for (let i = 0; i < n; i++) {
    const x = (player === 1 ? -60 : 60) + (i % side) * 1.2
    const y = -side / 2 + Math.floor(i / side) * 1.2
    ids[player].push(spawnUnit(sim, types[i % types.length], player, x, y))
  }
}
sim.send(1, { type: 'move', units: ids[1], x: 60, y: 0 })
sim.send(2, { type: 'move', units: ids[2], x: -60, y: 0 })

const t0 = performance.now()
sim.advance(1 / 20)
const firstTick = performance.now() - t0
const ticks = 400
const start = performance.now()
let worst = 0
const times: number[] = []
for (let i = 0; i < ticks; i++) {
  const t = performance.now()
  sim.advance(1 / 20)
  const d = performance.now() - t
  times.push(d)
  worst = Math.max(worst, d)
}
const total = performance.now() - start
let alive = 0
for (const _ of sim.world.query(Unit, Owner, Position)) alive++
times.sort((a, b) => a - b)
console.log(`первый тик (приказ)=${firstTick.toFixed(0)}мс p50=${times[times.length >> 1].toFixed(1)} p95=${times[Math.floor(times.length * 0.95)].toFixed(1)}`)
console.log(`N=${n}×2 тиков=${ticks} средний=${(total / ticks).toFixed(2)}мс худший=${worst.toFixed(1)}мс живых=${alive}`)
