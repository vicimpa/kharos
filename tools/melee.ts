/**
 * Свалка: K армий по N юнитов стоят по кругу и сходятся в центре, каждая против всех. За каждую играет
 * подключённый к хосту игрок, туман включён — как в настоящей игре. Раз в 10 секунд игры печатает, сколько живых,
 * время тика симуляции и тика хоста с рассылкой (среднее и худшее) и сколько байт в секунду уходит игроку в среднем.
 * bun tools/melee.ts [K] [N] [секунд]
 */
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createHost } from '../src/net/host'
import { createSim, Owner, Unit } from '../src/sim'
import { spawnUnit } from '../src/sim/units'

const armies = Number(process.argv[2] ?? 10)
const n = Number(process.argv[3] ?? 1000)
const seconds = Number(process.argv[4] ?? 120)
const TICK = 1 / 20
const SPACING = 1.2

const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } })
const host = createHost(sim)
let bytes = 0
for (let i = 0; i < armies; i++) host.join((data) => (bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength))

// Каре армии — сторона side юнитов; по кругу каре стоят с зазором в одно каре.
const types = ['infantry', 'buggy', 'tank', 'rocketeer'] as const
const side = Math.ceil(Math.sqrt(n))
const radius = Math.max(60, (armies * side * SPACING * 2) / (2 * Math.PI))
for (let army = 0; army < armies; army++) {
  const player = army + 1
  const angle = (army / armies) * Math.PI * 2
  const cx = Math.cos(angle) * radius
  const cy = Math.sin(angle) * radius
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const x = cx + ((i % side) - side / 2) * SPACING
    const y = cy + (Math.floor(i / side) - side / 2) * SPACING
    ids.push(spawnUnit(sim, types[i % types.length], player, x, y))
  }
  sim.send(player, { type: 'move', units: ids, x: 0, y: 0 })
}

// Время симуляции отдельно от рассылки: advance хоста зовёт её внутри.
let simTime = 0
const advance = sim.advance.bind(sim)
sim.advance = (step: number) => {
  const t = performance.now()
  const ticks = advance(step)
  simTime += performance.now() - t
  return ticks
}

const alive = () => {
  let count = 0
  for (const _ of sim.world.query(Unit, Owner)) count++
  return count
}

console.log(`армий=${armies} по ${n}, радиус круга ${radius.toFixed(0)} тайлов, живых=${alive()}`)
const report = 10 / TICK
let hostTotal = 0
let hostWorst = 0
let simTotal = 0
let simWorst = 0
for (let tick = 1; tick <= seconds / TICK; tick++) {
  const before = simTime
  const t = performance.now()
  host.advance(TICK)
  const hostTick = performance.now() - t
  const simTick = simTime - before
  hostTotal += hostTick
  simTotal += simTick
  hostWorst = Math.max(hostWorst, hostTick)
  simWorst = Math.max(simWorst, simTick)
  if (tick % report === 0) {
    const perPlayer = bytes / armies / (report * TICK) / 1024
    console.log(
      `${(tick * TICK).toFixed(0)} с: живых=${alive()} сущностей=${sim.world.size} следов=${[...sim.traces.all()].length} симуляция=${(simTotal / report).toFixed(1)}мс (худший ${simWorst.toFixed(0)}) ` +
        `хост=${(hostTotal / report).toFixed(1)}мс (худший ${hostWorst.toFixed(0)}) игроку=${perPlayer.toFixed(0)} КБ/с`,
    )
    hostTotal = hostWorst = simTotal = simWorst = bytes = 0
  }
}
