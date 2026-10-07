import type { Audio } from '../audio/audio'
import type { Entity } from '../ecs'
import { Building, Health, Owner, Position, Shot, Unit, buildingSpec } from '../sim'
import type { Scene } from './scene'

/** Не чаще этого, в секундах, игрока предупреждают, что замечен противник. */
const SPOTTED_GAP = 12
/** Сколько секунд строка уведомления висит в ленте и метка мигает на мини-карте. */
export const ALERT_SECONDS = 8
/** Больше строк лента не держит: старые уходят. */
const MAX_ALERTS = 4
/**
 * Атака — это урон, рядом с которым упал чужой выстрел: не дальше HIT_REACH тайлов от края и не раньше HIT_MEMORY
 * секунд назад. Прочность падает и без врага — у электростанции без энергии, от непогоды, — это не атака.
 */
const HIT_REACH = 3
const HIT_MEMORY = 1.5
/** Громкость сигналов: они слышны всегда, где бы ни была камера. */
const VOLUME = 0.7

export type AlertKind = 'attacked' | 'spotted'

export interface Alert {
  kind: AlertKind
  text: string
  /** Где это случилось, в тайлах. */
  x: number
  y: number
  /** Когда, в секундах часов уведомлений. */
  at: number
}

/**
 * Уведомления игрока. Раз в кадр смотрит на копию мира: у своего юнита или здания убыло прочности, а рядом упал
 * чужой выстрел — «атакованы»;
 * в виду появился чужой юнит — «замечен противник». Хост шлёт только то, что игрок видит, поэтому чужие юниты
 * в копии мира — это враги в виду. Об атаке предупреждают раз: снова — когда враги пропали из виду и напали опять.
 * О замеченном — не чаще SPOTTED_GAP. Каждое уведомление — строка в ленте, сигнал и метка на мини-карте.
 */
export function createAlerts(scene: Scene, audio: Audio | null) {
  let clock = 0
  let health = new Map<Entity, number>()
  let foes = new Set<Entity>()
  /** Об атаке уже предупредили: снова — после того как враги пропадут из виду. */
  let warned = false
  let spottedAt = -Infinity
  const alerts: Alert[] = []
  /** Куда недавно падали чужие выстрелы: номер выстрела — место и когда его заметили. */
  const impacts = new Map<Entity, { x: number; y: number; at: number }>()

  const raise = (kind: AlertKind, text: string, x: number, y: number) => {
    alerts.push({ kind, text, x, y, at: clock })
    if (alerts.length > MAX_ALERTS) alerts.shift()
    audio?.play(kind, VOLUME, 0)
  }

  /** Середина сущности: у здания — центр основания. */
  const centerOf = (entity: Entity, position: { x: number; y: number }) => {
    const type = scene.sim.world.get(entity, Building)?.type
    if (type === undefined) return position
    const { width, height } = buildingSpec(type)
    return { x: position.x + width / 2, y: position.y + height / 2 }
  }

  return {
    update(seconds: number) {
      clock += seconds
      const { world } = scene.sim
      const player = scene.player

      const nextFoes = new Set<Entity>()
      let spotted: Entity | undefined
      for (const [entity, , owner] of world.query(Unit, Owner)) {
        if (owner.player === player || owner.player === 0) continue
        nextFoes.add(entity)
        if (!foes.has(entity)) spotted ??= entity
      }
      foes = nextFoes
      if (!foes.size) warned = false
      if (spotted !== undefined && clock - spottedAt >= SPOTTED_GAP) {
        spottedAt = clock
        const { x, y } = world.get(spotted, Position)!
        raise('spotted', 'Замечен противник', x, y)
      }

      for (const [entity, shot] of world.query(Shot)) {
        if (shot.player !== player && shot.player !== 0 && !impacts.has(entity)) impacts.set(entity, { x: shot.toX, y: shot.toY, at: clock })
      }
      for (const [entity, impact] of impacts) if (clock - impact.at > HIT_MEMORY) impacts.delete(entity)
      /** Упал ли рядом с сущностью чужой выстрел: (x, y) — её угол, size — ширина и высота. */
      const shotAt = (x: number, y: number, width: number, height: number) => {
        for (const impact of impacts.values()) {
          const dx = Math.max(x - impact.x, 0, impact.x - (x + width))
          const dy = Math.max(y - impact.y, 0, impact.y - (y + height))
          if (Math.hypot(dx, dy) <= HIT_REACH) return true
        }
        return false
      }

      const next = new Map<Entity, number>()
      let hurt: Entity | undefined
      for (const [entity, life, owner] of world.query(Health, Owner)) {
        if (owner.player !== player) continue
        next.set(entity, life.value)
        const before = health.get(entity)
        if (hurt !== undefined || before === undefined || life.value >= before - 1e-6) continue
        const position = world.get(entity, Position)
        if (!position) continue
        const type = world.get(entity, Building)?.type
        const size = type === undefined ? { width: 0, height: 0 } : buildingSpec(type)
        if (shotAt(position.x, position.y, size.width, size.height)) hurt = entity
      }
      health = next
      if (hurt !== undefined && !warned) {
        warned = true
        const position = world.get(hurt, Position)
        if (position) {
          const { x, y } = centerOf(hurt, position)
          raise('attacked', world.has(hurt, Building) ? 'Атакована база' : 'Атакованы наши юниты', x, y)
        }
      }
      while (alerts.length && clock - alerts[0].at > ALERT_SECONDS) alerts.shift()
    },
    /** Уведомления, которые ещё видны: от старых к новым, с возрастом в секундах. */
    current: () => alerts.map((alert) => ({ ...alert, age: clock - alert.at })),
  }
}

export type Alerts = ReturnType<typeof createAlerts>
