import { DEPOSIT_SIZE, reserveLeft, type Sim } from '../sim'

type Spot = { x: number; y: number; reserve: number }

/** Остаток, каким игрок видел месторождение в последний раз: ключ — «x,y» левого верхнего тайла. */
const seen = new WeakMap<Sim, Map<string, number>>()

/**
 * Остаток месторождения, известный игроку: пока он видит хоть тайл месторождения — настоящий, в тумане — каким
 * был, когда игрок видел его в последний раз; null — с тех пор, как вкладка открыта, не видел ни разу. Так туман
 * не выдаёт, копают ли месторождение чужие.
 */
export function knownReserve(sim: Sim, player: number, spot: Spot): number | null {
  let memory = seen.get(sim)
  if (!memory) seen.set(sim, (memory = new Map()))
  const key = `${spot.x},${spot.y}`
  for (let dy = 0; dy < DEPOSIT_SIZE; dy++) {
    for (let dx = 0; dx < DEPOSIT_SIZE; dx++) {
      if (!sim.vision.sees(player, spot.x + dx, spot.y + dy)) continue
      const left = reserveLeft(sim, spot.x, spot.y)
      memory.set(key, left)
      return left
    }
  }
  return memory.get(key) ?? null
}
