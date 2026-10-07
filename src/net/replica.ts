import { World, type Component, type Entity, type Time } from '../ecs'
import { createLand } from '../map/terrain'
import { DEFAULT_RULES, boundsOf, type Command, type Sim } from '../sim'
import { createOccupancy } from '../sim/buildings'
import { createPaving } from '../sim/paved'
import { createReceivedTraces } from '../sim/traces'
import { createVision } from '../sim/vision'
import { BUILDINGS, type BuildingType } from '../sim/buildings'
import { Armed, Attached, Ghost, Position, SAVED, Turret, Unit } from '../sim/components'
import { placeTurret } from '../sim/turrets'
import { SAVE_VERSION, type SimSave } from '../sim/sim'
import type { ClientMessage, PlayerInfo, ServerMessage } from './protocol'

/** Из чего собираются призраки: сохраняемое и метка призрака. */
const REMEMBERED = [...SAVED, Ghost]
/** Компоненты, которые присылает хост, по имени. */
const BY_KEY = new Map<string, Component<any>>(SAVED.map((component) => [component.key, component]))

type Delta = Extract<ServerMessage, { type: 'delta' }>

/** Копия чужой симуляции: выглядит как Sim, но сама игру не считает. */
export interface Replica extends Sim {
  /** Сообщение сервера. Мир из него применится в начале следующего кадра. */
  receive(message: ServerMessage): void
  /** Соединение пропало: следующий advance() бросит ошибку с этой причиной. */
  fail(reason: string): void
  /** Проигравший просит хост начать заново: новый стартовый набор в новом месте. */
  respawn(): void
  /** Растёт, когда хост начинает мир заново: по нему клиент сбрасывает выделение и камеру. */
  readonly generation: number
  /** Кто играет на хосте, как его прислал хост; пусто, пока не прислал. */
  readonly players: readonly PlayerInfo[]
}

/**
 * Копия симуляции, которую считает сервер. Клиент читает её так же, как локальную: тот же мир, та же местность,
 * та же занятость тайлов. Разница в том, что send() уходит в сеть, а advance() не считает тики, а применяет
 * присланный мир и ведёт alpha, чтобы движение между тиками оставалось плавным.
 */
export function createReplica(welcome: Extract<ServerMessage, { type: 'welcome' }>, send: (text: string) => void, close: () => void): Replica {
  const world = new World()
  const time: Time = { tick: 0, step: welcome.step, elapsed: 0, delta: 0, alpha: 0 }
  /** Турели, которым место на носителе нашлось впервые: компонент добавляется после обхода. */
  const deferred: [Entity, { x: number; y: number }][] = []
  /** Пришедшие изменения мира, ещё не применённые: применяются все и по порядку. */
  let pending: Delta[] = []
  /** Что хост прислал и что игрок сейчас видит: сущность целиком, как её собрали из изменений. */
  const mirror = new Map<number, Record<string, object>>()
  let failure: string | null = null
  let player = welcome.player
  /** Чужие здания и месторождения, увиденные раньше: какими их видели последний раз. */
  const memory = new Map<number, Record<string, object>>()
  /** Снесено ли запомненное: его место сейчас в обзоре, а хост его не прислал. */
  const gone = (data: Record<string, object>) => {
    const at = data.Position as { x: number; y: number } | undefined
    if (!at) return true
    const type = (data.Building as { type: BuildingType } | undefined)?.type
    const { width, height } = type ? BUILDINGS[type] : { width: 1, height: 1 }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (replica.vision.sees(player, at.x + x, at.y + y)) return true
    return false
  }

  const occupancy = createOccupancy(world)
  const paving = createPaving(world)
  /** Мир по приветствию: при первом подключении и когда хост начинает мир заново. */
  const meet = ({ options, step, player: own }: Extract<ServerMessage, { type: 'welcome' }>) => {
    player = own
    memory.clear()
    const generator = replica.options?.generator
    replica.options = options
    replica.bounds = boundsOf(options.size)
    if (JSON.stringify(generator) !== JSON.stringify(options.generator)) replica.land = createLand(options.generator)
    replica.rules = { ...DEFAULT_RULES, ...options.rules }
    // Разведанное в новом мире ничего не значит.
    replica.vision = createVision(world, replica.bounds, () => time.tick, options.fog !== false)
    replica.traces = createReceivedTraces(() => time.tick, step, (x, y) => replica.vision.sees(player, x, y))
    world.clear()
    world.flush()
    mirror.clear()
    Object.assign(time, { tick: 0, step, elapsed: 0, delta: 0, alpha: 0 })
    pending = []
  }

  /** Накладывает изменения на мир на месте: незатронутые сущности и их наблюдатели не трогаются. */
  const apply = ({ set, unset, remove }: Delta) => {
    for (const id of remove) {
      mirror.delete(id)
      // Запомненное здание остаётся и станет призраком, остальное исчезает.
      if (!memory.has(id)) world.destroy(id as Entity)
    }
    for (const [id, data] of set) {
      const entity = id as Entity
      let entry = mirror.get(id)
      if (!entry) {
        // Новая для игрока сущность приходит целиком — в том числе вместо своего призрака.
        world.destroy(entity)
        entry = { ...data }
        mirror.set(id, entry)
        world.insert(id, data, BY_KEY)
      } else {
        Object.assign(entry, data)
        for (const key in data) {
          const component = BY_KEY.get(key)
          if (!component) continue
          const current = world.get(entity, component)
          if (!current) {
            world.add(entity, component(data[key]))
            continue
          }
          // Компонент приходит целиком: поля, которых в нём больше нет, обнуляются.
          const patch: Record<string, unknown> = { ...data[key] }
          for (const field in current) if (!(field in patch)) patch[field] = undefined
          world.set(entity, component, patch)
        }
      }
      const owner = (entry.Owner as { player: number } | undefined)?.player
      if (('Building' in entry || 'Deposit' in entry) && owner !== player) memory.set(id, entry)
    }
    for (const [id, keys] of unset) {
      const entry = mirror.get(id)
      for (const key of keys) {
        if (entry) delete entry[key]
        const component = BY_KEY.get(key)
        if (component) world.remove(id as Entity, component)
      }
    }
  }
  const replica = {
    options: undefined as unknown as Replica['options'],
    bounds: undefined as unknown as Replica['bounds'],
    land: undefined as unknown as Replica['land'],
    rules: undefined as unknown as Replica['rules'],
    generation: 0,
    players: [] as PlayerInfo[],
    world,
    occupancy,
    paving,
    vision: undefined as unknown as Replica['vision'],
    traces: undefined as unknown as ReturnType<typeof createReceivedTraces>,
    time,
    respawn() {
      send(JSON.stringify({ type: 'respawn' } satisfies ClientMessage))
    },
    send(_player: number, command: Command) {
      // Игрока сервер знает по соединению; номеру из сообщения он бы и не поверил.
      send(JSON.stringify({ type: 'command', command } satisfies ClientMessage))
    },
    advance(seconds: number) {
      if (failure !== null) throw new Error(failure)
      time.delta = seconds
      if (!pending.length) {
        // Следующий тик опаздывает: юниты доезжают до последнего известного места и ждут.
        time.alpha = Math.min(1, time.alpha + seconds / time.step)
        return 0
      }
      // Изменения идут одно за другим, поэтому применяются все пришедшие.
      const last = pending[pending.length - 1]!
      const ticks = last.tick - time.tick
      // Прошлое место и поворот юнитов хост не шлёт: это то, что было до пришедших изменений.
      const before = new Map<Entity, [number, number, number]>()
      for (const [entity, position, unit] of world.query(Position, Unit)) before.set(entity, [position.x, position.y, unit.facing])
      for (const [entity, position, turret] of world.query(Position, Turret)) before.set(entity, [position.x, position.y, turret.angle])
      for (const delta of pending) apply(delta)
      for (const [entity, position, unit] of world.query(Position, Unit)) {
        const [x, y, facing] = before.get(entity) ?? [position.x, position.y, unit.facing]
        unit.prevX = x
        unit.prevY = y
        unit.prevFacing = facing
      }
      // Место турели на носителе хост не шлёт: она встаёт на него здесь, после того как носитель сдвинулся.
      for (const [entity, attached, turret] of world.query(Attached, Turret)) {
        let position = world.get(entity, Position)
        if (!position) {
          position = { x: 0, y: 0 }
          if (!placeTurret(world, attached, position)) continue
          // Состав мира меняется после обхода: новое место ставится там же, где и у остальных, и сразу без сглаживания.
          deferred.push([entity, position])
          continue
        }
        placeTurret(world, attached, position)
        const [x, y, angle] = before.get(entity) ?? [position.x, position.y, turret.angle]
        turret.prevX = x
        turret.prevY = y
        turret.prevAngle = angle
      }
      for (const [entity, position] of deferred.splice(0)) {
        world.add(entity, Position(position))
        const turret = world.get(entity, Turret)!
        turret.prevX = position.x
        turret.prevY = position.y
        turret.prevAngle = turret.angle
      }
      // Перезарядку хост шлёт тиком её конца, см. wire.ts.
      for (const [, armed] of world.query(Armed)) {
        const wired = armed as typeof armed & { until?: number }
        armed.cooldown = Math.max(0, (wired.until ?? 0) - last.tick)
      }
      world.flush()
      time.tick = last.tick
      // Чужое здание, ушедшее в туман, остаётся на карте призраком, пока его место не окажется в обзоре.
      for (const [id, data] of memory) {
        if (mirror.has(id)) continue
        const entity = id as Entity
        if (gone(data)) {
          memory.delete(id)
          world.destroy(entity)
        } else if (!world.has(entity, Ghost)) {
          if (world.alive(entity)) world.add(entity, Ghost)
          else world.insert(id, { ...data, Ghost: {} }, REMEMBERED)
        }
      }
      world.flush()
      replica.traces.update()
      time.elapsed = time.tick * time.step
      time.alpha = 0
      pending = []
      return ticks
    },
    save: (): SimSave => ({ version: SAVE_VERSION, ...replica.options, tick: time.tick, world: world.snapshot(SAVED) }),
    destroy() {
      close()
      occupancy.destroy()
      paving.destroy()
      world.clear()
    },
    receive(message: ServerMessage) {
      if (message.type === 'delta') pending.push(message)
      else if (message.type === 'explored') replica.vision.explore(player, message.map)
      else if (message.type === 'traces') replica.traces.receive(message.traces)
      else if (message.type === 'players') replica.players = message.players
      else if (message.type === 'refused') replica.fail(message.reason)
      else {
        meet(message)
        replica.generation++
      }
    },
    fail(reason: string) {
      failure ??= reason
    },
  }
  meet(welcome)
  return replica
}
