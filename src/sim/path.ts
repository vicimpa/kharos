/** Можно ли юниту находиться в тайле. */
export type Walkable = (x: number, y: number) => boolean
/**
 * Во сколько раз шаг по тайлу дороже шага по ровному: 1 — ровное, больше — медленная местность, меньше — дорога.
 * Не меньше fastest, переданного в findPath.
 */
export type Slowness = (x: number, y: number) => number

const EVEN: Slowness = () => 1

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
let prices: Float64Array
let generation = 0

/**
 * Кратчайший путь по тайлам от (fromX, fromY) до (toX, toY), алгоритм A*. Ходить можно в восемь сторон,
 * но не наискось мимо угла препятствия. Возвращает тайлы пути подряд: x, y, x, y… — без начального.
 * Если до цели не дойти, ведёт к ближайшему к ней тайлу, до которого дойти можно.
 * near — на сколько тайлов достаточно подойти к цели: путь кончается в первом найденном тайле не дальше этого.
 * limit — сколько тайлов поиск осматривает, прежде чем сдаться. slowness — цена шага по тайлу: путь ищется самый быстрый,
 * а не самый короткий; fastest — самая низкая цена шага, какая бывает у этого юнита (дорога).
 */
export function findPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near = 0, limit = SEARCH_LIMIT, slowness = EVEN, fastest = 1): number[] {
  if (Math.abs(toX - fromX) < HALF - 1 && Math.abs(toY - fromY) < HALF - 1) {
    const path = findNearPath(walkable, fromX, fromY, toX, toY, near, limit, slowness, fastest)
    if (path) return path
  }
  return findFarPath(walkable, fromX, fromY, toX, toY, near, limit, slowness, fastest)
}

/**
 * Поиск пути внутри окна вокруг старта. Возвращает null, если цель не найдена, а поиск упёрся в край окна:
 * тогда путь, возможно, лежит за ним, и искать надо без окна.
 */
function findNearPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near: number, limit: number, slowness: Slowness, fastest: number): number[] | null {
  if (!stamps) {
    stamps = new Uint32Array(WINDOW * WINDOW)
    costs = new Float64Array(WINDOW * WINDOW)
    parents = new Int32Array(WINDOW * WINDOW)
    passable = new Uint8Array(WINDOW * WINDOW)
    prices = new Float64Array(WINDOW * WINDOW)
  }
  const stamp = stamps
  const current = ++generation
  // Левый верхний тайл окна.
  const originX = fromX - HALF
  const originY = fromY - HALF
  const distance = (x: number, y: number) => {
    const dx = Math.abs(toX - x)
    const dy = Math.abs(toY - y)
    // Оценка остатка не дороже самого быстрого пути: иначе поиск не заметил бы дорогу в стороне.
    return (Math.max(dx, dy) + (DIAGONAL - 1) * Math.min(dx, dy)) * fastest
  }
  /** Можно ли в тайл окна; спрашивает walkable один раз за поиск. */
  const free = (index: number, x: number, y: number) => {
    if (stamp[index] !== current) {
      stamp[index] = current
      costs[index] = Infinity
      passable[index] = walkable(x, y) ? 1 : 0
      prices[index] = passable[index] ? slowness(x, y) : Infinity
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
      const total = reached + price * prices[next]
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
function findFarPath(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, near: number, limit: number, slowness: Slowness, fastest: number): number[] {
  // Тайлы нумеруются относительно старта: поиск не уходит дальше SEARCH_LIMIT шагов, этого окна хватает.
  const SPAN = 1 << 15
  const key = (x: number, y: number) => (y - fromY + SPAN / 2) * SPAN + (x - fromX + SPAN / 2)
  const distance = (x: number, y: number) => {
    const dx = Math.abs(toX - x)
    const dy = Math.abs(toY - y)
    // Оценка остатка не дороже самого быстрого пути: иначе поиск не заметил бы дорогу в стороне.
    return (Math.max(dx, dy) + (DIAGONAL - 1) * Math.min(dx, dy)) * fastest
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
      const total = reached + price * slowness(nextX, nextY)
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

/**
 * Свободен ли прямой путь между двумя точками (в тайлах, дробных) с запасом по бокам. Со slowness прямая годится,
 * только если на ней нет тайлов медленнее концов: спрямление не должно срезать угол через болото. Если хоть один конец
 * на дороге, прямая не заходит на тайлы медленнее него: иначе спрямление уводило бы с дороги.
 */
export function isClear(walkable: Walkable, fromX: number, fromY: number, toX: number, toY: number, slowness = EVEN) {
  const dx = toX - fromX
  const dy = toY - fromY
  const length = Math.hypot(dx, dy)
  if (!length) return walkable(Math.floor(fromX), Math.floor(fromY))
  const sideX = (-dy / length) * CLEARANCE
  const sideY = (dx / length) * CLEARANCE
  const steps = Math.ceil(length / 0.2)
  const from = slowness(Math.floor(fromX), Math.floor(fromY))
  const to = slowness(Math.floor(toX), Math.floor(toY))
  // С дороги прямая не сходит: срезав по обочине, юнит ехал бы медленнее, чем по найденному пути.
  const slowest = Math.min(from, to) < 1 ? Math.min(from, to) : Math.max(from, to)
  for (let i = 0; i <= steps; i++) {
    const x = fromX + (dx * i) / steps
    const y = fromY + (dy * i) / steps
    if (!walkable(Math.floor(x + sideX), Math.floor(y + sideY))) return false
    if (!walkable(Math.floor(x - sideX), Math.floor(y - sideY))) return false
    if (slowness(Math.floor(x), Math.floor(y)) > slowest) return false
  }
  return true
}

/**
 * Спрямляет путь: выбрасывает точки, мимо которых можно пройти по прямой. Точки — дробные, x, y подряд;
 * (fromX, fromY) — откуда путь начинается. Без этого юнит ходил бы по сетке лесенкой.
 */
export function smoothPath(walkable: Walkable, fromX: number, fromY: number, points: number[], slowness = EVEN) {
  const result: number[] = []
  let anchorX = fromX
  let anchorY = fromY
  let at = 0
  const visible = (index: number) => isClear(walkable, anchorX, anchorY, points[index], points[index + 1], slowness)
  while (at < points.length) {
    // Самая дальняя точка, видная из опорной, становится новой опорной. Проверять подряд каждую — квадрат от длины
    // пути, а у армии путей сотни: дальность ищется скачками вдвое, потом делением пополам.
    let next = at
    let step = 2
    while (next + step < points.length && visible(next + step)) {
      next += step
      step *= 2
    }
    for (step >>= 1; step >= 2; step >>= 1) {
      const far = Math.min(next + step, points.length - 2)
      if (far > next && visible(far)) next = far
    }
    anchorX = points[next]
    anchorY = points[next + 1]
    result.push(anchorX, anchorY)
    at = next + 2
  }
  return result
}

/** Память поля путей: своя, чтобы поиски внутри не затирали её. Устроена как окно findNearPath, только вокруг цели. */
let fieldStamps: Uint32Array | undefined
let fieldCosts: Float64Array
let fieldParents: Int32Array
let fieldPrices: Float64Array
let fieldClosed: Uint32Array
let fieldGeneration = 0

/**
 * Пути от многих стартов к одной цели за один поиск: алгоритм Дейкстры от цели во все стороны, пока не дойдёт до всех
 * стартов или не осмотрит limit тайлов. Так группа в сотни юнитов прокладывает путь за цену одного поиска, а не сотни.
 * origins — старты, x, y подряд. Возвращает для каждого тайлы пути, как findPath, или null: до старта поиск не дошёл
 * или он дальше окна. Цена шага, как и в findPath, — по тайлу, на который ступают. Поиск тянется к прямоугольнику,
 * в котором лежат старты (A* с оценкой до него), а не расходится кругом: оценка согласованная, и пути остаются кратчайшими.
 */
export function findPaths(walkable: Walkable, toX: number, toY: number, origins: number[], limit = SEARCH_LIMIT * 3, slowness = EVEN, fastest = 1): (number[] | null)[] {
  if (!fieldStamps) {
    fieldStamps = new Uint32Array(WINDOW * WINDOW)
    fieldCosts = new Float64Array(WINDOW * WINDOW)
    fieldParents = new Int32Array(WINDOW * WINDOW)
    fieldPrices = new Float64Array(WINDOW * WINDOW)
    fieldClosed = new Uint32Array(WINDOW * WINDOW)
  }
  const stamp = fieldStamps
  const current = ++fieldGeneration
  const originX = toX - HALF
  const originY = toY - HALF
  const indexOf = (x: number, y: number) => {
    const localX = x - originX
    const localY = y - originY
    return localX < 0 || localY < 0 || localX >= WINDOW || localY >= WINDOW ? -1 : localY * WINDOW + localX
  }
  /** Цена шага на тайл окна; Infinity — туда нельзя. Спрашивает walkable один раз за поиск. */
  const price = (index: number, x: number, y: number) => {
    if (stamp[index] !== current) {
      stamp[index] = current
      fieldCosts[index] = Infinity
      fieldPrices[index] = walkable(x, y) ? slowness(x, y) : Infinity
    }
    return fieldPrices[index]
  }

  // Старты помечаются заранее: поиск кончается, когда дойдёт до всех.
  const wanted = new Map<number, number>()
  for (let i = 0; i < origins.length; i += 2) {
    const index = indexOf(origins[i], origins[i + 1])
    if (index >= 0) wanted.set(index, (wanted.get(index) ?? 0) + 1)
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < origins.length; i += 2) {
    minX = Math.min(minX, origins[i])
    maxX = Math.max(maxX, origins[i])
    minY = Math.min(minY, origins[i + 1])
    maxY = Math.max(maxY, origins[i + 1])
  }
  const estimate = (x: number, y: number) => {
    const dx = Math.max(0, minX - x, x - maxX)
    const dy = Math.max(0, minY - y, y - maxY)
    return (Math.max(dx, dy) + (DIAGONAL - 1) * Math.min(dx, dy)) * fastest
  }
  const closed = fieldClosed
  const goal = indexOf(toX, toY)
  price(goal, toX, toY)
  fieldCosts[goal] = 0
  const open = new Heap()
  open.push(goal, estimate(toX, toY))
  let left = wanted.size
  let visited = 0
  while (open.size && left && visited < limit) {
    const at = open.pop()
    if (closed[at] === current) continue
    closed[at] = current
    visited++
    if (wanted.has(at)) left--
    const localX = at % WINDOW
    const localY = (at - localX) / WINDOW
    const x = localX + originX
    const y = localY + originY
    // Обратный шаг: из соседа в этот тайл. Цена — по этому тайлу, как у шага вперёд.
    const step = at === goal ? 1 : fieldPrices[at]
    for (const [dx, dy, length] of STEPS) {
      const nextLocalX = localX + dx
      const nextLocalY = localY + dy
      if (nextLocalX < 0 || nextLocalY < 0 || nextLocalX >= WINDOW || nextLocalY >= WINDOW) continue
      const next = nextLocalY * WINDOW + nextLocalX
      // Старт может стоять там, куда нельзя (в нём самом юнит есть всегда): из него выйти можно.
      if (price(next, x + dx, y + dy) === Infinity && !wanted.has(next)) continue
      if (dx && dy && (price(at + dx, x + dx, y) === Infinity || price(at + dy * WINDOW, x, y + dy) === Infinity)) continue
      const total = fieldCosts[at] + length * step
      if (total >= fieldCosts[next]) continue
      fieldCosts[next] = total
      fieldParents[next] = at
      open.push(next, total + estimate(x + dx, y + dy))
    }
  }
  searched += visited

  const paths: (number[] | null)[] = []
  for (let i = 0; i < origins.length; i += 2) {
    const start = indexOf(origins[i], origins[i + 1])
    if (start < 0 || closed[start] !== current) {
      paths.push(null)
      continue
    }
    const path: number[] = []
    for (let at = start; at !== goal; ) {
      at = fieldParents[at]
      path.push((at % WINDOW) + originX, Math.floor(at / WINDOW) + originY)
    }
    paths.push(path)
  }
  return paths
}
