import type { BuildingType } from './buildings'

/**
 * Укрепление в своих осях: u — от главного здания к врагу, v — поперёк фронта. Главное здание — в начале осей,
 * занимает |u|, |v| ≤ 1. Схема поворачивается к нужной стороне уже при постановке.
 */
export interface Piece {
  type: BuildingType
  u: number
  v: number
}

/** Турели по весам: какая из них чаще встаёт в этой обороне. */
type Mix = Partial<Record<'turret' | 'rocketTurret' | 'cannonTurret', number>>

/** Наборы турелей: оборона то ровная, то с упором в пулемёты, ракеты или пушки. */
const MIXES: Mix[] = [
  { turret: 1, rocketTurret: 1, cannonTurret: 1 },
  { turret: 3, rocketTurret: 1 },
  { rocketTurret: 3, cannonTurret: 1 },
  { cannonTurret: 2, turret: 1 },
  { turret: 1, cannonTurret: 1 },
]

type Random = () => number

const between = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1))

function picker(random: Random, mix: Mix) {
  const entries = Object.entries(mix) as [BuildingType, number][]
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  return () => {
    let roll = random() * total
    for (const [type, weight] of entries) if ((roll -= weight) < 0) return type
    return entries[0][0]
  }
}

/** Схема: какие клетки занять. turret — даёт турель по набору обороны. */
type Layout = (random: Random, turret: () => BuildingType) => Piece[]

/** Прямая стена с одним-двумя проходами и ряд турелей за ней. */
const line: Layout = (random, turret) => {
  const pieces: Piece[] = []
  const half = between(random, 6, 10)
  const front = between(random, 5, 7)
  const gates = random() < 0.5 ? [0] : [-Math.ceil(half / 2), Math.ceil(half / 2)]
  const gateWidth = between(random, 1, 2)
  for (let v = -half - 1; v <= half + 1; v++) {
    if (gates.some((gate) => Math.abs(v - gate) < gateWidth)) continue
    pieces.push({ type: 'wall', u: front + 2, v })
  }
  const spacing = between(random, 2, 4)
  for (let v = -half + 1; v <= half - 1; v += spacing) pieces.push({ type: turret(), u: front, v })
  return pieces
}

/** Дуга стены вокруг главного здания, со стороны врага, с воротами посередине; турели — внутренним кольцом. */
const arc: Layout = (random, turret) => {
  const pieces: Piece[] = []
  const radius = between(random, 7, 10)
  const spread = 0.9 + random() * 0.6
  const seen = new Set<string>()
  const ring = (r: number, step: number, place: (u: number, v: number, angle: number) => void) => {
    for (let angle = -spread; angle <= spread; angle += step) {
      const u = Math.round(Math.cos(angle) * r)
      const v = Math.round(Math.sin(angle) * r)
      const key = `${u},${v}`
      if (seen.has(key)) continue
      seen.add(key)
      place(u, v, angle)
    }
  }
  const gate = 1.2 / radius
  ring(radius, 0.5 / radius, (u, v, angle) => Math.abs(angle) > gate && pieces.push({ type: 'wall', u, v }))
  ring(radius - 2, between(random, 2, 3) / (radius - 2), (u, v) => pieces.push({ type: turret(), u, v }))
  return pieces
}

/** Бастионы: несколько гнёзд из пары-тройки турелей, прикрытых стеной спереди и с боков; между ними — открыто. */
const bastions: Layout = (random, turret) => {
  const pieces: Piece[] = []
  const count = between(random, 2, 4)
  const gap = between(random, 8, 11)
  const front = between(random, 5, 8)
  for (let i = 0; i < count; i++) {
    const v0 = Math.round((i - (count - 1) / 2) * gap)
    const wide = random() < 0.5
    const guns = wide ? [-1, 0, 1] : [0, 1]
    for (const dv of guns) pieces.push({ type: turret(), u: front, v: v0 + dv })
    const left = v0 + guns[0] - 1
    const right = v0 + guns[guns.length - 1] + 1
    for (let v = left; v <= right; v++) pieces.push({ type: 'wall', u: front + 1, v })
    pieces.push({ type: 'wall', u: front, v: left }, { type: 'wall', u: front, v: right })
    // Иногда гнездо глубже: вторая линия турелей позади.
    if (random() < 0.4) pieces.push({ type: turret(), u: front - 1, v: v0 })
  }
  return pieces
}

/** Клин: стена углом к врагу, остриё — с воротами; турели вдоль обеих сторон клина. */
const wedge: Layout = (random, turret) => {
  const pieces: Piece[] = []
  const tip = between(random, 9, 12)
  const half = between(random, 7, 10)
  const slope = 0.5 + random() * 0.5
  const spacing = between(random, 2, 3)
  for (let v = -half; v <= half; v++) {
    const u = Math.round(tip - Math.abs(v) * slope)
    if (Math.abs(v) > 1) pieces.push({ type: 'wall', u, v })
    if (Math.abs(v) >= 2 && Math.abs(v) % spacing === 0) pieces.push({ type: turret(), u: u - 2, v })
  }
  return pieces
}

/** Две линии: дальняя — редкие турели без стены, ближняя — стена с турелями; прорвавшиеся упираются во вторую. */
const depth: Layout = (random, turret) => {
  const pieces: Piece[] = []
  const half = between(random, 6, 8)
  const outer = between(random, 11, 13)
  for (let v = -half; v <= half; v += between(random, 3, 5)) pieces.push({ type: turret(), u: outer, v })
  const inner = between(random, 5, 6)
  for (let v = -half; v <= half; v++) if (Math.abs(v) > 1) pieces.push({ type: 'wall', u: inner + 1, v })
  for (let v = -half + 1; v <= half - 1; v += 3) pieces.push({ type: turret(), u: inner - 1, v })
  return pieces
}

export const LAYOUTS = { line, arc, bastions, wedge, depth }

/**
 * Случайная оборона перед главным зданием: схема из LAYOUTS и набор турелей. Каждая клетка — один раз: где схема
 * ставит две постройки в одно место, остаётся первая.
 */
export function fortification(random: Random = Math.random) {
  const layouts = Object.values(LAYOUTS)
  const layout = layouts[Math.floor(random() * layouts.length)]
  const pieces = layout(random, picker(random, MIXES[Math.floor(random() * MIXES.length)]))
  const taken = new Set<string>()
  return pieces.filter(({ u, v }) => {
    const key = `${u},${v}`
    if (taken.has(key) || (Math.abs(u) <= 2 && Math.abs(v) <= 2)) return false
    taken.add(key)
    return true
  })
}
