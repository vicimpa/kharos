import type { Entity, World } from '../ecs'
import { tileKey } from '../map/terrain'
import { Pave, Position } from './components'
import type { Sim } from './sim'

/**
 * Покрытие тайла, которое кладут строители. Фундамент: на нём здания строятся быстрее, а на песке он вообще
 * разрешает стройку, и здание на сплошном фундаменте не требует зоны строительства. Дорога: наземные по ней
 * едут быстрее, а положенная на болото — это мост, по которому болото не вязнет и не жжёт.
 * Покрытие — не здание: по нему не стреляют, оно не видит и не мешает ходить.
 */
export type PaveKind = 'foundation' | 'road'
export const PAVE_KINDS: readonly PaveKind[] = ['foundation', 'road']

/** Во сколько раз быстрее, чем по голой скале, наземные идут по дороге и мосту. */
export const ROAD_SPEED = 1.5

/** Какое покрытие лежит на каком тайле. Обновляется само: следит за появлением и исчезновением покрытия. */
export interface Paving {
  /** Покрытие тайла, готовое или нет, или undefined. */
  at(x: number, y: number): Entity | undefined
  destroy(): void
}

export function createPaving(world: World): Paving {
  const tiles = new Map<number, Entity>()
  const stop = world.observe([Position, Pave], (entity, position) => {
    const key = tileKey(position.x, position.y)
    tiles.set(key, entity)
    return () => {
      if (tiles.get(key) === entity) tiles.delete(key)
    }
  })
  return {
    at: (x, y) => (tiles.size ? tiles.get(tileKey(x, y)) : undefined),
    destroy: stop,
  }
}

/** Лежит ли на тайле готовое покрытие этого вида. */
export function isPaved(sim: Sim, kind: PaveKind, x: number, y: number) {
  const entity = sim.paving.at(x, y)
  if (entity === undefined) return false
  const pave = sim.world.get(entity, Pave)
  return !!pave && pave.done && pave.kind === kind
}

