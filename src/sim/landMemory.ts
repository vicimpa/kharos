import { patchSavedTile, saveLand, setTile, tileBytes, tileKey, type TileEdit } from '../map/terrain'
import { prepareDeposits } from './deposits'
import type { Sim } from './sim'

/**
 * Что игроки знают о карте. Карта у всех одна, но её правки (снесли гору, проложили пандус) игрок узнаёт, только
 * увидев: в тумане войны тайл остаётся для него таким, каким он его знал. Поэтому помнится, каким был каждый
 * изменённый тайл до первой правки, и какую версию изменённых тайлов видел каждый игрок. Неизменённые тайлы у всех
 * одинаковы и не помнятся.
 *
 * Тайлы здесь — хранимые байты, см. tileBytes.
 */
export interface LandMemory {
  /** Каким был изменённый тайл до первой правки, по tileKey. */
  original: Map<number, { x: number; y: number; tile: number[] }>
  /** Какую версию изменённых тайлов знает игрок, по tileKey. Нет записи — знает исходную. */
  known: Map<number, Map<number, number[]>>
  /** Что игрок узнал с прошлого takeLearned: по ним хост шлёт правки, см. host.ts. */
  learned: Map<number, Set<number>>
}

/** В сохранении: изменённые тайлы — x, y и исходные байты подряд; знание игроков — x, y и байты подряд. */
export interface LandMemorySave {
  original: number[]
  known: Record<string, number[]>
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, i) => value === b[i])

export function createLandMemory(save?: LandMemorySave): LandMemory {
  const memory: LandMemory = { original: new Map(), known: new Map(), learned: new Map() }
  if (!save) return memory
  for (let i = 0; i + 5 < save.original.length; i += 6) {
    const [x, y, ...tile] = save.original.slice(i, i + 6)
    memory.original.set(tileKey(x, y), { x, y, tile })
  }
  for (const [player, flat] of Object.entries(save.known)) {
    const known = new Map<number, number[]>()
    for (let i = 0; i + 5 < flat.length; i += 6) known.set(tileKey(flat[i], flat[i + 1]), flat.slice(i + 2, i + 6))
    memory.known.set(Number(player), known)
  }
  return memory
}

export function saveLandMemory(memory: LandMemory): LandMemorySave {
  const original: number[] = []
  for (const { x, y, tile } of memory.original.values()) original.push(x, y, ...tile)
  const known: Record<string, number[]> = {}
  for (const [player, tiles] of memory.known) {
    const flat: number[] = []
    for (const [key, tile] of tiles) {
      const { x, y } = memory.original.get(key)!
      flat.push(x, y, ...tile)
    }
    known[player] = flat
  }
  return { original, known }
}

/** Меняет тайл мира. Кто из игроков видит его сейчас, узнает об этом в конце тика, см. updateLandMemory. */
export function editTile(sim: Sim, x: number, y: number, edit: TileEdit) {
  const key = tileKey(x, y)
  const before = tileBytes(sim.land, x, y)
  if (!sim.landMemory.original.has(key)) sim.landMemory.original.set(key, { x, y, tile: before })
  // Месторождения вокруг считаются по карте до правки: правка их не создаёт и не двигает.
  prepareDeposits(sim, x, y, x, y)
  setTile(sim.land, x, y, edit)
}

/** Какую версию тайла знает игрок. */
const knownTile = (memory: LandMemory, player: number, key: number) => memory.known.get(player)?.get(key) ?? memory.original.get(key)!.tile

/** Система тика, после обзора: каждый игрок узнаёт изменённые тайлы, которые видит. */
export function updateLandMemory(sim: Sim) {
  const memory = sim.landMemory
  if (!memory.original.size) return
  for (const player of sim.vision.players()) {
    for (const [key, { x, y }] of memory.original) {
      if (!sim.vision.sees(player, x, y)) continue
      const tile = tileBytes(sim.land, x, y)
      if (same(knownTile(memory, player, key), tile)) continue
      let known = memory.known.get(player)
      if (!known) memory.known.set(player, (known = new Map()))
      known.set(key, tile)
      let learned = memory.learned.get(player)
      if (!learned) memory.learned.set(player, (learned = new Set()))
      learned.add(key)
    }
  }
}

/** Правки, которые игрок узнал с прошлого вызова: x, y и байты тайла подряд, см. applyEdits. */
export function takeLearned(memory: LandMemory, player: number): number[] {
  const learned = memory.learned.get(player)
  if (!learned?.size) return []
  memory.learned.delete(player)
  const edits: number[] = []
  for (const key of learned) {
    const { x, y } = memory.original.get(key)!
    edits.push(x, y, ...knownTile(memory, player, key))
  }
  return edits
}

/** Всё, что игрок знает об изменённых тайлах иначе, чем исходная карта: правки поверх pristineLand при подключении. */
export function knownEdits(memory: LandMemory, player: number): number[] {
  const edits: number[] = []
  for (const [key, tile] of memory.known.get(player) ?? []) {
    const { x, y, tile: original } = memory.original.get(key)!
    if (!same(tile, original)) edits.push(x, y, ...tile)
  }
  return edits
}

/** Карта, какой её знают все до правок: saveLand с изменёнными тайлами в исходном виде. Её шлют всем одинаковой. */
export function pristineLand(sim: Sim): Uint8Array {
  const bytes = saveLand(sim.land)
  for (const { x, y, tile } of sim.landMemory.original.values()) patchSavedTile(bytes, x, y, tile)
  return bytes
}
