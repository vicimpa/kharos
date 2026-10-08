import { tileKey } from '../map/terrain'
import type { Entity } from '../ecs'
import { BUILDINGS, buildingSpec, canPlace, placeBuilding, type BuildingType } from './buildings'
import { Inventory } from './components'
import { depositIn, type DepositSpot } from './deposits'
import { addCredits } from './economy'
import { orderSeek } from './harvesting'
import { assignHaulers } from './hauling'
import { connectAll } from './piping'
import { put } from './inventory'
import { entriesOf, type Amounts } from './resources'
import type { Sim } from './sim'
import { freeTilesNear, isWalkable, spawnUnit, vehicleReach, type UnitType } from './units'

/** Сколько кредитов у игрока на тестовой карте: хватает, чтобы сразу строить и заказывать юнитов. */
const SANDBOX_CREDITS = 10000
/** Что уже лежит в хранилищах: хватает на первые заказы, и сразу есть что продать. */
const SANDBOX_STOCK: Amounts = { metal: 120, silicon: 40, fuel: 30, kharite: 12, blocks: 20, ammo: 60, parts: 6 }
/** Насколько далеко от начала мира ищется месторождение под базу, в клетках месторождений. */
const SEARCH_CELLS = 6
/** Сколько тайлов вокруг шахты оставлено свободными: там встают грузовики. */
const MINE_ROOM = 2

/** Сколько тайлов заливает поиск места, куда доедет техника от шахты: с запасом на всю базу. */
const BASE_REACH = 8000

/** Что стоит на тестовой карте, кроме шахты и главного здания: по порядку, от главного здания наружу. */
const SANDBOX_BUILDINGS: BuildingType[] = [
  'generator', 'generator', 'generator', 'generator', 'smelter', 'siliconWorks', 'blockPlant', 'ammoPlant', 'metalYard', 'siliconStore', 'fuelTank', 'khariteVault', 'blockYard', 'ammoBunker', 'partsLocker', 'spaceport', 'factory', 'barracks', 'matter',
]
/** С какими юнитами игрок начинает на тестовой карте, кроме грузовиков. */
const SANDBOX_UNITS: UnitType[] = ['harvester', 'builder', 'builder', 'infantry', 'infantry', 'rocketeer', 'buggy', 'tank', 'tesla', 'carrier']
/** Сколько грузовиков: первый привязан к шахте, остальные свободны и работают на заявки зон. */
const SANDBOX_TRUCKS = 4

/** Тайлы вокруг (x, y) кольцами, от ближних к дальним, до radius включительно. */
function* rings(x: number, y: number, radius: number) {
  for (let ring = 0; ring <= radius; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) yield { x: x + dx, y: y + dy }
      }
    }
  }
}

/** Месторождение, у которого поместится база: вокруг шахты проходимо, а рядом встаёт главное здание. */
function findBaseSpot(sim: Sim) {
  const cells: { x: number; y: number }[] = []
  for (let y = -SEARCH_CELLS; y <= SEARCH_CELLS; y++) for (let x = -SEARCH_CELLS; x <= SEARCH_CELLS; x++) cells.push({ x, y })
  cells.sort((a, b) => a.x ** 2 + a.y ** 2 - b.x ** 2 - b.y ** 2)
  for (const cell of cells) {
    const spot = depositIn(sim, cell.x, cell.y)
    // Шахта тестовой карты — металлическая: металл нужен почти всему.
    if (!spot || spot.kind !== 'metal' || !canPlace(sim, 'mine', spot.x, spot.y)) continue
    const { width, height } = BUILDINGS.mine
    let open = true
    for (let y = spot.y - 1; y <= spot.y + height && open; y++) {
      for (let x = spot.x - 1; x <= spot.x + width; x++) {
        const inside = x >= spot.x && x < spot.x + width && y >= spot.y && y < spot.y + height
        if (!inside && !isWalkable(sim, x, y)) open = false
      }
    }
    if (open) return spot
  }
  return undefined
}

/** Не подходит ли здание к шахте ближе MINE_ROOM тайлов. */
function clearOfMine(spot: DepositSpot, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  const mine = BUILDINGS.mine
  const apart = x >= spot.x + mine.width + MINE_ROOM || x + width + MINE_ROOM <= spot.x
  return apart || y >= spot.y + mine.height + MINE_ROOM || y + height + MINE_ROOM <= spot.y
}

/** Стоит ли здание вплотную к тайлу, куда доедет техника: иначе грузовики к нему не подъедут, например, из-за обрыва. */
function servable(reach: Set<number>, type: BuildingType, x: number, y: number) {
  const { width, height } = BUILDINGS[type]
  for (let tileY = y - 1; tileY <= y + height; tileY++) {
    for (let tileX = x - 1; tileX <= x + width; tileX++) {
      const inside = tileX >= x && tileX < x + width && tileY >= y && tileY < y + height
      if (!inside && reach.has(tileKey(tileX, tileY))) return true
    }
  }
  return false
}

/** Ставит здание на ближайшее к (x, y) место с проходом вокруг, куда подъедет техника; undefined — места не нашлось. */
function placeNear(sim: Sim, spot: DepositSpot, reach: Set<number>, type: BuildingType, x: number, y: number, player: number, gap: number) {
  for (const tile of rings(Math.round(x), Math.round(y), 14)) {
    if (!canPlace(sim, type, tile.x, tile.y, gap) || !clearOfMine(spot, type, tile.x, tile.y) || !servable(reach, type, tile.x, tile.y)) continue
    return placeBuilding(sim.world, type, tile.x, tile.y, player)
  }
  return undefined
}

/**
 * Тестовая карта: готовая база игрока у ближайшего к началу мира месторождения металла. Шахта, главное здание,
 * переработка, сборочный цех, хранилища с запасом всего готового, космопорт, электростанции и заводы уже стоят;
 * один грузовик возит руду из шахты на переработку, остальные работают на заявки зон. Есть строители, немного
 * войск и кредитов. Возвращает, где база: туда смотрит камера. undefined — подходящего месторождения рядом нет.
 */
export function spawnSandbox(sim: Sim, player: number) {
  const spot = findBaseSpot(sim)
  if (!spot) return undefined
  addCredits(sim, player, SANDBOX_CREDITS)
  // Куда доедет техника от шахты: здания и юниты — только там, чтобы обрыв не отрезал их от базы. Считается до
  // того, как встанут здания: между ними оставлены проходы.
  const reach = vehicleReach(sim, spot.x - 1, spot.y, BASE_REACH)
  const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, player)
  const centerX = spot.x + BUILDINGS.mine.width / 2
  const centerY = spot.y + BUILDINGS.mine.height / 2
  const core = placeNear(sim, spot, reach, 'command', centerX + 4, centerY, player, 2)
  const at = core === undefined ? { x: centerX, y: centerY } : { x: centerX + 6, y: centerY }
  const stores: Entity[] = []
  for (const type of SANDBOX_BUILDINGS) {
    const building = placeNear(sim, spot, reach, type, at.x, at.y, player, 1)
    if (building !== undefined && buildingSpec(type).stores) stores.push(building)
  }
  // База — одна сеть: здания соединены трубами.
  connectAll(sim, player)
  // Запас раскладывается по хранилищам, пока в них есть место.
  for (const [resource, amount] of entriesOf(SANDBOX_STOCK)) {
    let left = amount
    for (const store of stores) left -= put(sim.world.get(store, Inventory)!, resource, left)
  }

  const tiles = freeTilesNear(sim, Math.floor(centerX), Math.floor(centerY), SANDBOX_TRUCKS + SANDBOX_UNITS.length, 2, { has: (key) => !reach.has(key) })
  const trucks: Entity[] = []
  for (let i = 0; i * 2 < tiles.length; i++) {
    const type = i < SANDBOX_TRUCKS ? 'truck' : SANDBOX_UNITS[i - SANDBOX_TRUCKS]
    const unit = spawnUnit(sim, type, player, tiles[i * 2], tiles[i * 2 + 1])
    if (type === 'truck') trucks.push(unit)
    // Харвестер сам не ищет: здесь ему сразу велено искать любое месторождение.
    if (type === 'harvester') orderSeek(sim, player, [unit], 'any')
  }
  assignHaulers(sim, player, mine, trucks.slice(0, 1))
  return { x: at.x, y: at.y }
}
