/** Можно ли юниту находиться в тайле. */
export type Walkable = (x: number, y: number) => boolean

/** Сколько тайлов поиск осматривает, прежде чем сдаться и повести к ближайшему найденному, если не сказано иначе. */
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

let searched = 0
/** Сколько тайлов осмотрели все поиски пути с начала работы: по приросту видно, во что обошлись поиски за тик. */
export const searchedTiles = () => searched

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

/** Сторона окна вокруг старта, внутри которого поиск хранит тайлы в массивах, а не в словарях: так в разы быстрее. */
const WINDOW = 512
const HALF = WINDOW / 2

/** Память поиска в окне, одна на все поиски. Тайл относится к текущему поиску, если его метка равна generation. */
let stamps: Uint32Array | undefined
let costs: Float64Array
let parents: Int32Array
let passable: Uint8Array
let generation = 0

/**
 * Кратчайший путь по тайлам от (fromX, fromY) до (toX, toY), алгоритм A*. Ходить можно в восемь сторон,
 * но не наискось мимо угла препятствия. Возвращает тайлы пути подряд: x, y, x, y… — без начального.
 * Если до цели не дойти, ведёт к ближайшему к ней тайлу, до которого дойти можно.
 * near — на сколько тайлов достаточно подойти к цели: путь кончается в первом найденном тайле не дальше этого.
 * limit — сколько тайлов поиск осматривает, прежде чем сдаться.
 */
export function findPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near = 0, limit = SEARCH_LIMIT): number[] {
  if (Math.abs(toX - fromX) < HALF - 1 && Math.abs(toY - fromY) < HALF - 1) {
    const path = findNearPath(walkable, fromX, fromY, toX, toY, near, limit)
    if (path) return path
  }
  return findFarPath(walkable, fromX, fromY, toX, toY, near, limit)
}

/**
 * Поиск пути внутри окна вокруг старта. Возвращает null, если цель не найдена, а поиск упёрся в край окна:
 * тогда путь, возможно, лежит за ним, и искать надо без окна.
 */
function findNearPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near: number, limit: number): number[] | null {
  if (!stamps) {
    stamps = new Uint32Array(WINDOW * WINDOW)
    costs = new Float64Array(WINDOW * WINDOW)
    parents = new Int32Array(WINDOW * WINDOW)
    passable = new Uint8Array(WINDOW * WINDOW)
  }
  const stamp = stamps
  const current = ++generation
  // Левый верхний тайл окна.
  const originX = fromX - HALF
  const originY = fromY - HALF
  const distance = (x: number, y: number) => {
    const dx = Math.abs(toX - x)
    const dy = Math.abs(toY - y)
    return Math.max(dx, dy) + (DIAGONAL - 1) * Math.min(dx, dy)
  }
  /** Можно ли в тайл окна; спрашивает walkable один раз за поиск. */
  const free = (index: number, x: number, y: number) => {
    if (stamp[index] !== current) {
      stamp[index] = current
      costs[index] = Infinity
      passable[index] = walkable(x, y) ? 1 : 0
    }
    return passable[index] === 1
  }

  const open = new Heap()
  const start = HALF * WINDOW + HALF
  stamp[start] = current
  costs[start] = 0
  passable[start] = 1
  open.push(start, distance(fromX, fromY))

  let closest = start
  let closestDistance = distance(fromX, fromY)
  let visited = 0
  let found = false
  let edge = false

  while (open.size && visited++ < limit) {
    const at = open.pop()
    const localX = at % WINDOW
    const localY = (at - localX) / WINDOW
    const x = localX + originX
    const y = localY + originY
    if (near ? (x - toX) * (x - toX) + (y - toY) * (y - toY) <= near * near : x === toX && y === toY) {
      closest = at
      found = true
      break
    }
    const reached = costs[at]
    for (const [dx, dy, price] of STEPS) {
      const nextLocalX = localX + dx
      const nextLocalY = localY + dy
      if (nextLocalX < 0 || nextLocalY < 0 || nextLocalX >= WINDOW || nextLocalY >= WINDOW) {
        edge = true
        continue
      }
      const next = nextLocalY * WINDOW + nextLocalX
      if (!free(next, x + dx, y + dy)) continue
      if (dx && dy && (!free(at + dx, x + dx, y) || !free(at + dy * WINDOW, x, y + dy))) continue
      const total = reached + price
      if (total >= costs[next]) continue
      costs[next] = total
      parents[next] = at
      const left = distance(x + dx, y + dy)
      if (left < closestDistance) {
        closest = next
        closestDistance = left
      }
      open.push(next, total + left)
    }
  }
  if (!found && edge) {
    searched += visited
    return null
  }

  searched += visited
  const path: number[] = []
  for (let at = closest; at !== start; at = parents[at]) {
    path.push(Math.floor(at / WINDOW) + originY, (at % WINDOW) + originX)
  }
  return path.reverse()
}

/** То же, что findPath, но без окна: тайлы хранятся в словарях. Медленнее, зато годится для пути любой длины. */
function findFarPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near: number, limit: number): number[] {
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

  while (open.size && visited++ < limit) {
    const current = open.pop()
    const x = (current % SPAN) + fromX - SPAN / 2
    const y = Math.floor(current / SPAN) + fromY - SPAN / 2
    if (near ? (x - toX) * (x - toX) + (y - toY) * (y - toY) <= near * near : x === toX && y === toY) {
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

  searched += visited
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
