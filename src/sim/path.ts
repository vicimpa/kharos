/** Можно ли юниту находиться в тайле. */
export type Walkable = (x: number, y: number) => boolean

/** Сколько тайлов поиск осматривает, прежде чем сдаться и повести к ближайшему найденному. */
const SEARCH_LIMIT = 20000
const DIAGONAL = Math.SQRT2
/** Насколько по бокам от линии движения должно быть свободно, в тайлах. */
const CLEARANCE = 0.3

/** Куча с наименьшим приоритетом наверху: очередь тайлов для поиска. */
class Heap {
  private readonly items: number[] = []
  private readonly priorities: number[] = []

  get size() {
    return this.items.length
  }

  push(item: number, priority: number) {
    const { items, priorities } = this
    let at = items.length
    items.push(item)
    priorities.push(priority)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (priorities[parent] <= priority) break
      items[at] = items[parent]
      priorities[at] = priorities[parent]
      at = parent
    }
    items[at] = item
    priorities[at] = priority
  }

  pop() {
    const { items, priorities } = this
    const top = items[0]
    const item = items.pop()!
    const priority = priorities.pop()!
    const size = items.length
    if (size) {
      let at = 0
      for (;;) {
        let child = at * 2 + 1
        if (child >= size) break
        if (child + 1 < size && priorities[child + 1] < priorities[child]) child++
        if (priorities[child] >= priority) break
        items[at] = items[child]
        priorities[at] = priorities[child]
        at = child
      }
      items[at] = item
      priorities[at] = priority
    }
    return top
  }
}

/** Соседи тайла: смещение и цена шага. */
const STEPS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
] as const

/**
 * Кратчайший путь по тайлам от (fromX, fromY) до (toX, toY), алгоритм A*. Ходить можно в восемь сторон,
 * но не наискось мимо угла препятствия. Возвращает тайлы пути подряд: x, y, x, y… — без начального.
 * Если до цели не дойти, ведёт к ближайшему к ней тайлу, до которого дойти можно.
 */
export function findPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number): number[] {
  // Тайлы нумеруются относительно старта: поиск не уходит дальше SEARCH_LIMIT шагов, этого окна хватает.
  const SPAN = 1 << 15
  const key = (x: number, y: number) => (y - fromY + SPAN / 2) * SPAN + (x - fromX + SPAN / 2)
  const distance = (x: number, y: number) => {
    const dx = Math.abs(toX - x)
    const dy = Math.abs(toY - y)
    return Math.max(dx, dy) + (DIAGONAL - 1) * Math.min(dx, dy)
  }

  const cost = new Map<number, number>()
  const parent = new Map<number, number>()
  const open = new Heap()
  const start = key(fromX, fromY)
  cost.set(start, 0)
  open.push(start, distance(fromX, fromY))

  let closest = start
  let closestDistance = distance(fromX, fromY)
  let visited = 0

  while (open.size && visited++ < SEARCH_LIMIT) {
    const current = open.pop()
    const x = (current % SPAN) + fromX - SPAN / 2
    const y = Math.floor(current / SPAN) + fromY - SPAN / 2
    if (x === toX && y === toY) {
      closest = current
      break
    }
    const reached = cost.get(current)!
    for (const [dx, dy, price] of STEPS) {
      const nextX = x + dx
      const nextY = y + dy
      if (!walkable(nextX, nextY)) continue
      if (dx && dy && (!walkable(nextX, y) || !walkable(x, nextY))) continue
      const next = key(nextX, nextY)
      const total = reached + price
      if (total >= (cost.get(next) ?? Infinity)) continue
      cost.set(next, total)
      parent.set(next, current)
      const left = distance(nextX, nextY)
      if (left < closestDistance) {
        closest = next
        closestDistance = left
      }
      open.push(next, total + left)
    }
  }

  const path: number[] = []
  for (let at = closest; at !== start; at = parent.get(at)!) {
    path.push(Math.floor(at / SPAN) + fromY - SPAN / 2, (at % SPAN) + fromX - SPAN / 2)
  }
  return path.reverse()
}

/** Свободен ли прямой путь между двумя точками (в тайлах, дробных) с запасом по бокам. */
export function isClear(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX
  const dy = toY - fromY
  const length = Math.hypot(dx, dy)
  if (!length) return walkable(Math.floor(fromX), Math.floor(fromY))
  const sideX = (-dy / length) * CLEARANCE
  const sideY = (dx / length) * CLEARANCE
  const steps = Math.ceil(length / 0.2)
  for (let i = 0; i <= steps; i++) {
    const x = fromX + (dx * i) / steps
    const y = fromY + (dy * i) / steps
    if (!walkable(Math.floor(x + sideX), Math.floor(y + sideY))) return false
    if (!walkable(Math.floor(x - sideX), Math.floor(y - sideY))) return false
  }
  return true
}

/**
 * Спрямляет путь: выбрасывает точки, мимо которых можно пройти по прямой. Точки — дробные, x, y подряд;
 * (fromX, fromY) — откуда путь начинается. Без этого юнит ходил бы по сетке лесенкой.
 */
export function smoothPath(walkable: Walkable, fromX: number, fromY: number, points: number[]) {
  const result: number[] = []
  let anchorX = fromX
  let anchorY = fromY
  let at = 0
  while (at < points.length) {
    // Идём вперёд, пока очередная точка видна из опорной; последняя видимая становится новой опорной.
    let next = at
    while (next + 2 < points.length && isClear(walkable, anchorX, anchorY, points[next + 2], points[next + 3])) next += 2
    anchorX = points[next]
    anchorY = points[next + 1]
    result.push(anchorX, anchorY)
    at = next + 2
  }
  return result
}
