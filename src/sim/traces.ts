import type { Entity, World } from '../ecs'
import { tileKey } from '../map/terrain'
import { Owner, Position, Unit } from './components'
import { flies, type UnitType } from './units'

/**
 * Следы на земле: колея и шаги, гарь от взрывов, прожоги лучей, остовы техники. Это не картинка клиента,
 * а данные симуляции: по ним враг, проходящий мимо, видит, кто здесь был, и может пойти по следу — догнать
 * оставившего или найти, откуда тот пришёл. Хост шлёт игроку только те, что тот видит. Следы живут недолго
 * и в сохранение не попадают.
 *
 * track — точка пути юнита: entity — кто прошёл (точки одного юнита соединяются в колею), type и facing — каким
 * он был и куда смотрел. scar — гарь поперечником size. burn — прожог луча. wreck — остов юнита type.
 */
export type Trace = { id: number; tick: number; x: number; y: number } & (
  | { kind: 'track'; entity: number; type: UnitType; facing: number; player: number }
  | { kind: 'scar'; size: number }
  | { kind: 'burn' }
  | { kind: 'wreck'; type: UnitType; facing: number }
)
export type TraceKind = Trace['kind']
type NewTrace = Trace extends infer T ? (T extends Trace ? Omit<T, 'id' | 'tick'> : never) : never

/** Сколько секунд живёт след каждого вида. Клиент растворяет его к концу этого срока. */
export const TRACE_LIFE: Record<TraceKind, number> = { track: 90, scar: 240, burn: 240, wreck: 600 }

/** Через сколько тайлов пути юнит оставляет новую точку следа и на сколько радиан должен повернуть, чтобы оставить её раньше. */
const TRACK_STEP = 0.5
const TRACK_TURN = 0.35
/** Как часто убираются истёкшие следы, в секундах. */
const EXPIRE_EVERY = 1
/**
 * Сколько живых следов одного вида держит тайл; лишние не оставляются. Без предела толпа в тысячи юнитов за минуту
 * оставляет миллионы точек колеи, а прочитать по тайлу, что здесь прошли, можно и по двум. Остовов не больше, чем
 * погибших, им предела нет.
 */
const DENSITY: Partial<Record<TraceKind, number>> = { track: 2, scar: 2, burn: 2 }
/** Сторона ячейки, по которым разложены следы, в тайлах: хост проверяет только ячейки, которые игрок видит. */
export const TRACE_CELL = 16
/** Ячейка следов, в которой лежит точка. */
export const traceCell = (x: number, y: number) => tileKey(Math.floor(x / TRACE_CELL), Math.floor(y / TRACE_CELL))

const KINDS: TraceKind[] = ['track', 'scar', 'burn', 'wreck']

/** Счёт живых следов по тайлу и виду, см. DENSITY. */
function createDensity() {
  const counts = new Map<number, number>()
  const keyOf = (trace: { kind: TraceKind; x: number; y: number }) => tileKey(Math.floor(trace.x), Math.floor(trace.y)) * KINDS.length + KINDS.indexOf(trace.kind)
  return {
    /** Занимает место под след; false — тайл полон, след не оставляется. */
    take(trace: { kind: TraceKind; x: number; y: number }) {
      const limit = DENSITY[trace.kind]
      if (limit === undefined) return true
      const key = keyOf(trace)
      const count = counts.get(key) ?? 0
      if (count >= limit) return false
      counts.set(key, count + 1)
      return true
    },
    /** След ушёл: место освобождается. */
    release(trace: Trace) {
      if (DENSITY[trace.kind] === undefined) return
      const key = keyOf(trace)
      const count = counts.get(key) ?? 0
      if (count > 1) counts.set(key, count - 1)
      else counts.delete(key)
    },
  }
}

export interface Traces {
  /** Оставляет след в этом тике. */
  add(trace: NewTrace): void
  /** Все живые следы, от старых к новым. */
  all(): readonly Trace[]
  /** Следы, оставленные в последнем тике. */
  fresh(): readonly Trace[]
  /** Живые следы в ячейке cell, см. traceCell. */
  inCell(cell: number): readonly Trace[]
  /** Номера следов, убранных в последнем тике: срок вышел. */
  expired(): readonly number[]
  /** Конец тика: точки пути юнитов, истёкшие следы. */
  update(): void
  /**
   * Следы, появившиеся после отметки cursor (ноль — все), и новая отметка. Так отрисовка забирает новые, не
   * просматривая каждый кадр все. В клиенте «появившиеся» — пришедшие от хоста: старый след, найденный
   * только сейчас, тоже новый.
   */
  since(cursor: number): { traces: readonly Trace[]; cursor: number }
}

export function createTraces(world: World, tick: () => number, step: number): Traces {
  let list: Trace[] = []
  let fresh: Trace[] = []
  /** Оставленные с конца прошлого тика: в конце этого они станут fresh. */
  let pending: Trace[] = []
  let expired: number[] = []
  let sinceExpire = 0
  let next = 1
  const walk = createWalkers(world)
  const density = createDensity()
  /** Живые следы по ячейкам, см. traceCell. */
  const cells = new Map<number, Trace[]>()

  const traces: Traces = {
    add(trace) {
      if (!density.take(trace)) return
      const full = { ...trace, id: next++, tick: tick() } as Trace
      list.push(full)
      pending.push(full)
      const cell = traceCell(full.x, full.y)
      const bucket = cells.get(cell)
      if (bucket) bucket.push(full)
      else cells.set(cell, [full])
    },
    all: () => list,
    inCell: (cell) => cells.get(cell) ?? [],
    since(cursor) {
      // Номера в списке растут: новые — в хвосте.
      let from = list.length
      while (from > 0 && list[from - 1].id > cursor) from--
      return { traces: list.slice(from), cursor: next - 1 }
    },
    fresh: () => fresh,
    expired: () => expired,
    update() {
      walk((track) => traces.add(track))

      fresh = pending
      pending = []

      // Истёкшие убираются раз в EXPIRE_EVERY: сроки у видов разные, и список приходится просматривать целиком.
      expired = []
      sinceExpire += step
      if (sinceExpire < EXPIRE_EVERY) return
      sinceExpire = 0
      const now = tick()
      const alive = (trace: Trace) => (now - trace.tick) * step < TRACE_LIFE[trace.kind]
      list = list.filter((trace) => {
        if (alive(trace)) return true
        expired.push(trace.id)
        density.release(trace)
        return false
      })
      for (const [cell, bucket] of cells) {
        const left = bucket.filter(alive)
        if (left.length) cells.set(cell, left)
        else cells.delete(cell)
      }
    },
  }
  return traces
}

const angleBetween = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

type NewTrack = Extract<NewTrace, { kind: 'track' }>

/**
 * Колея: наземный юнит оставляет точку, пройдя TRACK_STEP или повернув на TRACK_TURN. Возвращает обход, который
 * отдаёт новые точки тика. Одно правило у хоста и у клиента: колею, оставленную на глазах у игрока, клиент кладёт
 * сам, и хосту не нужно слать её по сети.
 */
function createWalkers(world: World) {
  /** Где каждый наземный юнит оставил последнюю точку. */
  const walkers = new Map<Entity, { x: number; y: number; facing: number }>()
  return (emit: (track: NewTrack) => void) => {
    const seen = new Set<Entity>()
    for (const [entity, unit, position, owner] of world.query(Unit, Position, Owner)) {
      if (flies(unit.type)) continue
      seen.add(entity)
      const last = walkers.get(entity)
      const moved = last ? Math.hypot(position.x - last.x, position.y - last.y) : Infinity
      if (last && moved < TRACK_STEP && Math.abs(angleBetween(unit.facing, last.facing)) < TRACK_TURN) continue
      if (last && moved < 1e-3) continue
      walkers.set(entity, { x: position.x, y: position.y, facing: unit.facing })
      // Первая точка — тоже точка: от неё колея и потянется. Скачок клиент узнаёт по расстоянию и не соединяет.
      emit({ kind: 'track', entity, type: unit.type, facing: unit.facing, player: owner.player, x: position.x, y: position.y })
    }
    for (const entity of walkers.keys()) if (!seen.has(entity)) walkers.delete(entity)
  }
}

/**
 * Следы в клиенте: их получают от хоста — те, что игрок видит сейчас; ушедшие из обзора (sees — видно ли место)
 * выбрасываются. Колею юнитов, которых игрок видит, клиент кладёт сам: хост её не шлёт, см. host.ts. Свои следы
 * клиент нумерует отрицательными числами, чтобы не спутать с хостовыми. Отметка since — порядковый номер
 * прихода, а не номер следа: след, найденный поздно, приходит поздно.
 */
export function createReceivedTraces(world: World, tick: () => number, step: number, sees: (x: number, y: number) => boolean): Traces & { receive(traces: Trace[]): void } {
  let list: { trace: Trace; seq: number }[] = []
  let seq = 0
  let fresh: Trace[] = []
  /** Пришедшие от хоста после прошлого update: в update они станут fresh вместе со своими. */
  let incoming: Trace[] = []
  let own = 0
  const walk = createWalkers(world)
  // Предел плотности — и для колеи, которую клиент кладёт сам: в толпе её столько же, сколько у хоста.
  const density = createDensity()
  return {
    add() {
      // Следы оставляет хост.
    },
    all: () => list.map(({ trace }) => trace),
    fresh: () => fresh,
    inCell: (cell) => list.filter(({ trace }) => traceCell(trace.x, trace.y) === cell).map(({ trace }) => trace),
    expired: () => [],
    receive(traces) {
      incoming.push(...traces)
      for (const trace of traces) list.push({ trace, seq: ++seq })
    },
    update() {
      const now = tick()
      fresh = incoming
      incoming = []
      walk((track) => {
        if (!density.take(track)) return
        const trace = { ...track, id: -++own, tick: now } as Trace
        fresh.push(trace)
        list.push({ trace, seq: ++seq })
      })
      // Ушедшее из обзора клиент не хранит: о следах он знает только там, где видит сейчас.
      list = list.filter(({ trace }) => {
        if (sees(trace.x, trace.y) && (now - trace.tick) * step < TRACE_LIFE[trace.kind]) return true
        // Место держат только свои: пришедшие от хоста он уже отмерил.
        if (trace.id < 0) density.release(trace)
        return false
      })
    },
    since(cursor) {
      let from = list.length
      while (from > 0 && list[from - 1].seq > cursor) from--
      return { traces: list.slice(from).map(({ trace }) => trace), cursor: seq }
    },
  }
}
