/**
 * Нагрузка на сеть: хост с двумя игроками, у каждого армия из N юнитов, армии сходятся в бою.
 * Печатает время тика хоста вместе с рассылкой и сколько байт в секунду уходит игроку. Туман выключен: игрок видит всё.
 * bun tools/stress-net.ts [N]
 */
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createHost } from '../src/net/host'
import { createSim, Unit, Owner } from '../src/sim'
import { spawnUnit } from '../src/sim/units'

const n = Number(process.argv[2] ?? 1000)
const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false }, fog: false })
const host = createHost(sim)
let bytes = 0
host.join((text) => (bytes += Buffer.byteLength(text)))
host.join(() => {})
// Игроки 1 и 2 получили стартовые наборы где-то на карте; армии ставятся у начала мира.
const types = ['infantry', 'buggy', 'tank', 'rocketeer'] as const
const side = Math.ceil(Math.sqrt(n))
const ids: Record<number, number[]> = { 1: [], 2: [] }
for (const player of [1, 2]) {
  for (let i = 0; i < n; i++) {
    ids[player].push(spawnUnit(sim, types[i % 4], player, (player === 1 ? -60 : 60) + (i % side) * 1.2, -side / 2 + Math.floor(i / side) * 1.2))
  }
}
sim.send(1, { type: 'move', units: ids[1], x: 60, y: 0 })
sim.send(2, { type: 'move', units: ids[2], x: -60, y: 0 })
host.advance(1 / 20)
bytes = 0
const ticks = 200
let hostTime = 0
for (let i = 0; i < ticks; i++) {
  const t = performance.now()
  host.advance(1 / 20)
  hostTime += performance.now() - t
}
let units = 0
for (const _ of sim.world.query(Unit, Owner)) units++
console.log(`N=${n}×2 тик хоста с рассылкой=${(hostTime / ticks).toFixed(1)}мс игроку=${(bytes / (ticks / 20) / 1024).toFixed(0)} КБ/с живых=${units}`)
