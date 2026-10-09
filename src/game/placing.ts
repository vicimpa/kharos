import { BUILDINGS, DEPOSIT_SIZE, Owner, Pave, PAVE_LIMIT, canBuild, canPlace, canPave, creditsOf, depositNear, paveCost, pipeAt, pipeStroke, type BuildingSpec, type BuildingType } from '../sim'
import type { PaveTool, Scene } from './scene'

/** Где встанет здание, которое игрок сейчас выбирает место: левый верхний тайл основания и годится ли место. */
export interface Placement {
  type: BuildingType
  x: number
  y: number
  allowed: boolean
}

/** С какого расстояния от указателя до центра месторождения шахта сама встаёт на него, в тайлах. */
const SNAP = 3

/**
 * Место под выбранное здание: основание стоит серединой под указателем мыши. Шахта притягивается
 * к месторождению рядом с указателем: попадать в него тайл в тайл не нужно. Вне режима выбора места — null.
 */
export function placementOf(scene: Scene): Placement | null {
  const type = scene.placing
  const tile = scene.camera.pointerTile
  if (!type || !tile) return null
  const { width, height, extract }: BuildingSpec = BUILDINGS[type]
  let x = tile.x - Math.floor(width / 2)
  let y = tile.y - Math.floor(height / 2)
  const near = extract && width === DEPOSIT_SIZE ? depositNear(scene.sim, tile.x + 0.5, tile.y + 0.5, SNAP) : null
  // К месторождению, которого игрок не нашёл, шахта не липнет: иначе выдала бы, где оно.
  const deposit = near && scene.sim.vision.exploredIn(scene.player, near.x, near.y, DEPOSIT_SIZE, DEPOSIT_SIZE) ? near : null
  if (deposit) {
    x = deposit.x
    y = deposit.y
  }
  // Редактору деньги и технологии не нужны: только место.
  return { type, x, y, allowed: scene.edit ? canPlace(scene.sim, type, x, y) : canBuild(scene.sim, scene.player, type, x, y) }
}


/** Тайлы, которые накроет укладка покрытия, пока игрок тянет её мышью, и сколько она стоит. */
export interface PaveStroke {
  tool: PaveTool
  /** Тайлы x, y подряд; allowed — ляжет ли тут покрытие (или снимется), по тайлу. */
  tiles: number[]
  allowed: boolean[]
  /** Класть тут можно, но кредитов на тайл уже не хватает: он не ляжет. По тайлу. */
  short: boolean[]
  /** Цена всего, что ляжет; у снятия — ноль. */
  cost: number
}

/**
 * Что покроет протянутая мышью укладка: от тайла, где зажали кнопку, до тайла под указателем. Фундамент и снятие —
 * прямоугольником, дорога и труба — линией с одним изломом: сначала вдоль длинной стороны, потом поперёк. Пока кнопку
 * не зажали — один тайл под указателем. Больше PAVE_LIMIT тайлов разом не кладут. Вне режима укладки — null.
 */
export function paveStrokeOf(scene: Scene): PaveStroke | null {
  const tool = scene.paving
  const tile = scene.camera.pointerTile
  if (!tool || !tile) return null
  const from = scene.paveFrom ?? tile
  const tiles: number[] = []
  if (tool === 'road' || tool === 'pipe') {
    const horizontal = Math.abs(tile.x - from.x) >= Math.abs(tile.y - from.y)
    const corner = horizontal ? { x: tile.x, y: from.y } : { x: from.x, y: tile.y }
    const walk = (a: { x: number; y: number }, b: { x: number; y: number }, skipFirst: boolean) => {
      const stepX = Math.sign(b.x - a.x)
      const stepY = Math.sign(b.y - a.y)
      const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      for (let i = skipFirst ? 1 : 0; i <= length; i++) tiles.push(a.x + stepX * i, a.y + stepY * i)
    }
    walk(from, corner, false)
    walk(corner, tile, true)
  } else {
    for (let y = Math.min(from.y, tile.y); y <= Math.max(from.y, tile.y); y++) {
      for (let x = Math.min(from.x, tile.x); x <= Math.max(from.x, tile.x); x++) tiles.push(x, y)
    }
  }
  tiles.length = Math.min(tiles.length, PAVE_LIMIT * 2)
  const { sim, player } = scene
  const allowed: boolean[] = []
  const short: boolean[] = []
  // Кредиты списываются по тайлу в том же порядке: на что не хватит, то и не ляжет.
  const credits = creditsOf(sim, player)
  let cost = 0
  if (tool === 'pipe') {
    // Труба тянется цепочкой: на чём кончились кредиты, дальше уже не ляжет, см. orderPipes.
    const price = BUILDINGS.pipe.cost
    let broke = false
    for (const ok of pipeStroke(sim, player, tiles)) {
      const affordable = ok && !broke && cost + price <= credits
      if (ok && !affordable) broke = true
      allowed.push(affordable)
      short.push(ok && !affordable)
      if (affordable) cost += price
    }
    return { tool, tiles, allowed, short, cost }
  }
  for (let i = 0; i < tiles.length; i += 2) {
    const x = tiles[i]
    const y = tiles[i + 1]
    if (tool === 'remove') {
      const entity = sim.paving.at(x, y)
      // Снимают и своё покрытие, и свои трубы с колодцами.
      allowed.push((entity !== undefined && sim.world.get(entity, Owner)?.player === player && !sim.world.get(entity, Pave)?.remove) || pipeAt(sim, player, x, y) !== undefined)
      short.push(false)
      continue
    }
    const price = canPave(sim, player, tool, x, y) ? paveCost(sim, tool, x, y) : undefined
    const affordable = price !== undefined && cost + price <= credits
    allowed.push(affordable)
    short.push(price !== undefined && !affordable)
    if (affordable) cost += price
  }
  return { tool, tiles, allowed, short, cost }
}
