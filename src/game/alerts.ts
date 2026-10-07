import type { Audio } from '../audio/audio'
import type { Entity } from '../ecs'
import { Building, Health, Owner, Position, Unit, buildingSpec } from '../sim'
import type { Scene } from './scene'

/** Не чаще этого, в секундах, игрока предупреждают, что замечен противник. */
const SPOTTED_GAP = 12
/** Сколько секунд строка уведомления висит в ленте и метка мигает на мини-карте. */
export const ALERT_SECONDS = 8
/** Больше строк лента не держит: старые уходят. */
const MAX_ALERTS = 4
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
 * Уведомления игрока. Раз в кадр смотрит на копию мира: у своего юнита или здания убыло прочности — «атакованы»;
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

      const next = new Map<Entity, number>()
      let hurt: Entity | undefined
      for (const [entity, life, owner] of world.query(Health, Owner)) {
        if (owner.player !== player) continue
        next.set(entity, life.value)
        const before = health.get(entity)
        if (before !== undefined && life.value < before - 1e-6) hurt ??= entity
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
