/**
 * Раздел «economy»: рудник, производство и разгон.
 *
 *   1. Потолок по описаниям: сколько даёт шахта, во что обходится линия и когда она окупается.
 *   2. Замер живой линии в симуляции: шахта, два грузовика, хранилище, космопорт и продажа — сколько кредитов
 *      в секунду выходит на самом деле, с дорогой, погрузкой и полётом корабля.
 *   3. Производство: сколько кредитов и материалов в секунду тратит здание и сколько линий его кормят.
 *   4. Разгон настоящими командами: типовой порядок стройки от разворота MCV до второго генератора материи —
 *      когда появляются первые деньги и на что их хватает.
 *
 * Раздел отвечает на главный вопрос стабилизации: сколько линий добычи кормит одну производственную.
 */
import type { Entity } from '../../src/ecs'
import {
  BUILDINGS, BUILDING_TYPES, Builds, Building, DEPOSIT_KINDS, DEPOSIT_TYPES, Inventory, Owner, PRODUCTS, PRODUCT_SPECS, REFINE_RATE, RESOURCE_SPECS,
  REWARDS, Site, TRUCK_CAPACITY, TURRETS, Trade, UNITS, Unit, WEAPONS, amountOf, buildingSpec, canBuild, canPlace, canSell, creditsOf, cycleSeconds,
  depositIn, economyOf, entriesOf, isProduct, rewardsOf, stockOf, totalOf, unitSpec,
  type Amounts, type BuildingType, type DepositSpot, type Resource, type Sim, type TurretSpec, type UnitType, type WeaponSpec,
} from '../../src/sim'
import { placeBuilding } from '../../src/sim/buildings'
import { STARTING_CREDITS, addCredits } from '../../src/sim/economy'
import { freeTilesNear, spawnUnit } from '../../src/sim/units'
import { TICK, clock, newSim, placeableNear, printTable, rectOf, rectsApart, rings, round, spotNear } from './lib'

/** Тиков в секунду: внутренние циклы идут ровно по секундам. */
const TICKS = Math.round(1 / TICK)

/** Цена линии добычи: шахта на месторождении, грузовик к ней и переработка, которая делает из руды товар. */
const LINE_COST = BUILDINGS.mine.cost + UNITS.truck.cost + BUILDINGS.smelter.cost

/** 1. Потолок по описаниям: добыча месторождения, цена продажи, окупаемость линии и сколько шахт кормит завод. */
function printLineMath() {
  console.log('\nДобыча и продажа: потолок по описаниям, без дороги и полёта корабля')
  printTable(
    ['ресурс', 'добыча/с', 'цена', 'выручка/с', 'шахт на завод', 'окупаемость', 'запас'],
    DEPOSIT_TYPES.map((kind) => {
      const { rate, min, max } = DEPOSIT_KINDS[kind]
      const revenue = rate * RESOURCE_SPECS[kind].price
      return [
        kind, round(rate, 1), RESOURCE_SPECS[kind].price, round(revenue, 1), round(REFINE_RATE / rate, 1),
        `${Math.round(LINE_COST / revenue)} с`, `${min}–${max}`,
      ]
    }),
  )
  console.log(`  линия — шахта (${BUILDINGS.mine.cost}), грузовик (${UNITS.truck.cost}) и переработка (${BUILDINGS.smelter.cost}) = ${LINE_COST} кр`)
  console.log(`  переработка принимает ${REFINE_RATE} руды/с: столько шахт она держит; вторая шахта на том же заводе — ${BUILDINGS.mine.cost + UNITS.truck.cost} кр`)
  console.log('  запас — сколько даёт одно месторождение')
}

/** Рудник в симуляции: шахта с грузовиками, переработка, база рядом и космопорт. */
interface Mine {
  sim: Sim
  port: Entity
}

/** Ставит готовое здание у месторождения, не задевая место для грузовиков под шахтой. */
function placeNearMine(sim: Sim, spot: DepositSpot, type: BuildingType, x: number, y: number) {
  const ok = (tx: number, ty: number) =>
    placeableNear(sim, type, tx, ty, 1, 0) !== undefined && rectsApart(rectOf(type, tx, ty), rectOf('mine', spot.x, spot.y), 2)
  const tile = spotNear(x, y, ok, 14)
  return tile ? placeBuilding(sim.world, type, tile.x, tile.y, 1) : undefined
}

/** Сколько свободных грузовиков работает на заявки зон; первый привязан к шахте и возит руду на переработку. */
const FREE_TRUCKS = 2

/**
 * База у ближайшего к началу мира месторождения металла: всё готовое — меряется поток, а не стройка.
 * Энергии две электростанции: переработка и космопорт просят по пять, генератор материи — три.
 * freeTrucks — сколько свободных грузовиков сверх привязанного к шахте.
 */
function mineScene(freeTrucks = FREE_TRUCKS): Mine {
  const sim = newSim()
  for (const cell of rings(0, 0, 6)) {
    const spot = depositIn(sim, cell.x, cell.y)
    if (!spot || spot.kind !== 'metal') continue
    const mine = placeBuilding(sim.world, 'mine', spot.x, spot.y, 1)
    const cx = spot.x + 1
    const cy = spot.y + 1
    const core = placeNearMine(sim, spot, 'command', cx + 7, cy)
    const silo = placeNearMine(sim, spot, 'metalYard', cx + 4, cy + 6)
    const refinery = placeNearMine(sim, spot, 'smelter', cx + 4, cy - 4)
    const port = placeNearMine(sim, spot, 'spaceport', cx + 8, cy + 5)
    const generator = placeNearMine(sim, spot, 'generator', cx + 6, cy - 5)
    const generator2 = placeNearMine(sim, spot, 'generator', cx + 8, cy - 5)
    const matter = placeNearMine(sim, spot, 'matter', cx + 3, cy - 5)
    const mineTiles = freeTilesNear(sim, spot.x, spot.y, 2)
    const coreTiles = freeTilesNear(sim, cx + 7, cy, freeTrucks * 2)
    if (!core || !silo || !refinery || !port || !generator || !generator2 || !matter) {
      sim.destroy()
      continue
    }
    if (mineTiles.length < 2 || coreTiles.length < freeTrucks * 2) {
      sim.destroy()
      continue
    }
    const truck = spawnUnit(sim, 'truck', 1, mineTiles[0], mineTiles[1])
    for (let i = 0; i < freeTrucks; i++) spawnUnit(sim, 'truck', 1, coreTiles[i * 2], coreTiles[i * 2 + 1])
    sim.send(1, { type: 'haul', units: [truck], mine })
    return { sim, port }
  }
  throw new Error('Не нашлось места под рудник у месторождения металла')
}

/**
 * Гоняет рудник time секунд, держа заявку на продажу металла открытой, как это делает игрок.
 * Возвращает, на какой секунде пришла первая продажа: 0 — не дождались. Продажа — это когда у космопорта
 * пропадает заявка: корабль улетел и кредиты начислены.
 */
function runMine(scene: Mine, time: number, firstSale = 0) {
  const { sim, port } = scene
  let sale = firstSale
  for (let second = 0; second < time; second++) {
    for (let tick = 0; tick < TICKS; tick++) {
      if (canSell(sim, 1, port)) {
        const stock = Math.floor(stockOf(sim, 1).items.metal ?? 0)
        if (stock >= TRUCK_CAPACITY) sim.send(1, { type: 'sell', port, resource: 'metal', amount: stock })
      }
      const ordered = sim.world.has(port, Trade)
      sim.advance(TICK)
      if (sale === 0 && ordered && !sim.world.has(port, Trade)) sale = second
    }
  }
  return sale
}

/** 2. Замер живой линии: пять минут рудника с продажей. Возвращает выручку линии в кредитах в секунду. */
function measureMine(): number {
  const { sim, port } = mineScene()
  const warmup = 120
  const firstSale = runMine({ sim, port }, warmup)
  const before = creditsOf(sim, 1)
  const passive = economyOf(sim, 1).income
  runMine({ sim, port }, 180, firstSale)
  const measured = (creditsOf(sim, 1) - before) / 180
  const line = Math.max(0, measured - passive)
  const invested = BUILDINGS.mine.cost + (FREE_TRUCKS + 1) * UNITS.truck.cost + BUILDINGS.silo.cost + BUILDINGS.smelter.cost + BUILDINGS.spaceport.cost + 2 * BUILDINGS.generator.cost

  console.log(`\nРудник в симуляции: шахта, ${FREE_TRUCKS + 1} грузовика, переработка, хранилище и космопорт; продажа металла, 5 минут`)
  console.log(`  первая продажа         ${firstSale ? clock(firstSale) : 'не дождались'}`)
  console.log(`  доход всего            ${round(measured, 1)} кр/с`)
  console.log(`  пассивка               ${round(passive, 1)} кр/с (главное здание и генератор материи)`)
  console.log(`  выручка линии          ${round(line, 1)} кр/с`)
  console.log(`  через переработку      ${round(line / RESOURCE_SPECS.metal.price, 1)} металла/с (шахта даёт 1 руды/с, завод принимает ${REFINE_RATE}/с)`)
  if (line > 0) {
    console.log(`  окупаемость линии      ${Math.round(LINE_COST / line)} с (шахта, грузовик и переработка, ${LINE_COST} кр)`)
    console.log(`  вложено в рудник       ${invested} кр, окупается за ${Math.round(invested / line)} с`)
  }
  sim.destroy()
  printTrucks()
  return line
}

/** Сколько металла в мире: в хранилищах, на заводе и в кузовах грузовиков. */
function metalInWorld(sim: Sim) {
  let total = 0
  for (const [, inventory] of sim.world.query(Inventory)) total += amountOf(inventory, 'metal')
  return total
}

/**
 * Сколько металла в секунду даёт линия при разном числе грузовиков (вопрос 3.4: не превращается ли игра
 * в возню с рудой). Первый грузовик привязан к шахте и возит руду, остальные свободны: они и руду возят по
 * заявке завода, и развозят готовое по хранилищам. Считается всё, что вышло из завода: и то, что лежит
 * в хранилищах, и то, что уже продано.
 */
function printTrucks() {
  const window = 240
  const rows: (string | number)[][] = []
  for (const free of [0, 1, 2]) {
    const scene = mineScene(free)
    runMine(scene, 120)
    const before = metalInWorld(scene.sim)
    const credits = creditsOf(scene.sim, 1)
    const passive = economyOf(scene.sim, 1).income
    runMine(scene, window)
    const made = metalInWorld(scene.sim) - before
    const sold = (creditsOf(scene.sim, 1) - credits - passive * window) / RESOURCE_SPECS.metal.price
    const rate = Math.max(0, made + sold) / window
    rows.push([free + 1, round(rate, 2), round(rate * RESOURCE_SPECS.metal.price, 1), `${Math.round((rate / DEPOSIT_KINDS.metal.rate) * 100)}%`])
    scene.sim.destroy()
  }
  console.log('\nСколько грузовиков нужно линии: привязанный к шахте и свободные, металла в секунду')
  printTable(['грузовиков', 'металла/с', 'кр/с', 'от потолка'], rows)
  console.log('  от потолка — доля от добычи шахты (1 руды/с); свободные грузовики возят и руду по заявке завода,')
  console.log('  и готовое из переработки в хранилища: без свободного грузовика готовое остаётся на заводе')
}

/** Материалы в сырых ресурсах: изделия раскладываются по рецепту цеха на то, из чего их собирают. */
function rawOf(materials: Amounts): Partial<Record<Resource, number>> {
  const raw: Partial<Record<Resource, number>> = {}
  for (const [good, amount] of entriesOf(materials)) {
    if (isProduct(good)) {
      const { recipe, yield: made } = PRODUCT_SPECS[good]
      for (const [resource, need] of entriesOf(recipe)) raw[resource as Resource] = (raw[resource as Resource] ?? 0) + (need * amount) / made
    } else raw[good as Resource] = (raw[good as Resource] ?? 0) + amount
  }
  return raw
}

/** 3. Что тратит производство и сколько линий его кормят. */
function printProduction(lineRate: number) {
  const feed = Math.max(lineRate, 0.1)
  console.log('\nПроизводство: что здание тратит в секунду, если работает без остановки')
  const rows: (string | number)[][] = []
  for (const type of BUILDING_TYPES) {
    for (const unit of buildingSpec(type).produces ?? []) {
      const info = unitSpec(unit)
      const burn = info.cost / info.buildTime
      const raw = rawOf(info.materials ?? {})
      const share = (resource: Resource) => (raw[resource] ?? 0) / info.buildTime
      const lines = (['metal', 'silicon', 'fuel', 'kharite'] as Resource[]).reduce(
        (sum, resource) => sum + share(resource) / DEPOSIT_KINDS[resource].rate,
        0,
      )
      const show = (value: number) => (value > 0 ? round(value, 2) : '—')
      // Материалы по цене продажи: столько кредитов игрок не выручил, пустив сырьё на юнит.
      const value = entriesOf(raw).reduce((sum, [resource, amount]) => sum + amount * RESOURCE_SPECS[resource as Resource].price, 0)
      rows.push([
        type, unit, info.cost, round(info.buildTime, 0), round(burn, 1),
        show(share('metal')), show(share('silicon')), show(share('fuel')), show(share('kharite')),
        round(lines, 1), round(burn / feed, 1), value ? `${Math.round((value / (value + info.cost)) * 100)}%` : '—',
      ])
    }
  }
  printTable(['здание', 'юнит', 'цена', 'время', 'кр/с', 'м/с', 'к/с', 'т/с', 'х/с', 'линий', 'по деньгам', 'материалы'], rows, 12, 8)
  console.log('  кр/с — кредитов в секунду; м/к/т/х — материалов в секунду, изделия разложены по рецепту цеха;')
  console.log('  материалы — доля сырья по цене продажи в полной цене юнита (кредиты плюс сырьё), цель 25–40%;')
  console.log(`  линий — столько шахт с грузовиками нужно на материалы, и каждая кормится переработкой (завод держит ${REFINE_RATE} руды/с);`)
  console.log(`  по деньгам — на кредиты при выручке ${round(feed, 1)} кр/с`)
}

/** Сколько боеприпасов в секунду тратит непрерывно стреляющая турель каждого вида. */
function ammoBurn() {
  return BUILDING_TYPES.filter((type) => buildingSpec(type).ammo).map((type) => {
    const turret: TurretSpec = TURRETS[buildingSpec(type).mounts![0].turret]
    const weapon: WeaponSpec = WEAPONS[turret.weapon!]
    return { type, burn: (weapon.ammo ?? 0) / weapon.reload, capacity: buildingSpec(type).inventory ?? 0 }
  })
}

/**
 * 4. Производные: что ест цех на каждом рецепте, сколько линий его кормят и сколько он даёт; сколько турелей
 * держит одна линия металла через цех на патронах (§3.7 design.md: цель — 2–4 турели под огнём).
 */
function printProducts() {
  console.log('\nСборочный цех: рецепт, что он ест и что даёт, работая без остановки')
  const rows: (string | number)[][] = []
  for (const product of PRODUCTS) {
    const { recipe, yield: made, stock } = PRODUCT_SPECS[product]
    const seconds = cycleSeconds(product)
    const show = (resource: Resource) => ((recipe as Partial<Record<Resource, number>>)[resource] ? round((recipe as Record<Resource, number>)[resource] / seconds, 2) : '—')
    const lines = entriesOf(recipe).reduce((sum, [resource, need]) => sum + need / seconds / DEPOSIT_KINDS[resource as Resource].rate, 0)
    rows.push([product, round(made / seconds, 2), show('metal'), show('silicon'), show('kharite'), round(lines, 2), stock])
  }
  printTable(['изделие', 'штук/с', 'м/с', 'к/с', 'х/с', 'линий', 'норма'], rows)
  console.log(`  линий — сколько линий добычи цех съедает, работая без остановки; встаёт он, набрав норму у зоны`)

  const ammoPerLine = (PRODUCT_SPECS.ammo.yield / totalOf(PRODUCT_SPECS.ammo.recipe)) * DEPOSIT_KINDS.metal.rate
  console.log('\nБоеприпасы: что тратит турель под непрерывным огнём и сколько их держит одна линия металла')
  printTable(
    ['турель', 'патр/с', 'запас', 'хватает', 'на линию'],
    ammoBurn().map(({ type, burn, capacity }) => [type, round(burn, 2), capacity, `${Math.round(capacity / burn)} с`, round(ammoPerLine / burn, 1)]),
    14,
    10,
  )
  console.log(`  линия металла через цех даёт ${round(ammoPerLine, 1)} патронов/с; хватает — сколько турель стреляет на своём запасе`)
}

/** Состояние разгона: что уже построено и кто свободен. */
interface Opening {
  mcv: Entity
  core?: Entity
  mine?: Entity
  port?: Entity
  /** Грузовик, привязанный к шахте. */
  bound?: Entity
  builders: Entity[]
  trucks: Entity[]
}

/** Сколько готовых зданий этого вида у игрока. */
function countBuildings(sim: Sim, type: BuildingType) {
  let count = 0
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (owner.player === 1 && building.type === type && !sim.world.has(entity, Site)) count++
  }
  return count
}

/** Сколько юнитов этого вида у игрока. */
function countUnits(sim: Sim, type: UnitType) {
  let count = 0
  for (const [, unit, owner] of sim.world.query(Unit, Owner)) if (owner.player === 1 && unit.type === type) count++
  return count
}

/** Шаг разгона: что игрок делает, когда на это хватает денег. */
interface Step {
  title: string
  /** Сколько кредитов нужно, чтобы шаг начался. */
  cost: number
  started: boolean
  run: (sim: Sim, opening: Opening) => boolean
  done: (sim: Sim, opening: Opening) => boolean
}

/** Свободный строитель: не занят стройкой. */
const freeBuilder = (sim: Sim, opening: Opening) => opening.builders.find((builder) => !sim.world.has(builder, Builds))

/** Порядок разгона: типовой старт игрока — от разворота MCV до второго генератора материи. */
function makeSteps(opening: Opening, core: { x: number; y: number }, deposit: DepositSpot): Step[] {
  const mine = rectOf('mine', deposit.x, deposit.y)
  /**
   * Шаг стройки: место ищется в момент, когда до шага дошли деньги, — соседние здания уже стоят.
   * Кроме шахты, все здания ставятся в стороне от месторождения: займи они его, шахту будет не поставить.
   */
  const build = (title: string, type: BuildingType, count: number, x: number, y: number): Step => ({
    title,
    cost: BUILDINGS[type].cost,
    started: false,
    run(sim, opening) {
      const builder = freeBuilder(sim, opening)
      if (builder === undefined) return false
      const suit = (tx: number, ty: number) =>
        canBuild(sim, 1, type, tx, ty) && (type === 'mine' || rectsApart(rectOf(type, tx, ty), mine, 1))
      const tile = spotNear(x, y, suit, 12)
      if (!tile) return false
      sim.send(1, { type: 'build', building: type, x: tile.x, y: tile.y, builders: [builder] })
      return true
    },
    done: (sim) => countBuildings(sim, type) >= count,
  })
  const produce = (title: string, unit: UnitType, count: number): Step => ({
    title,
    cost: UNITS[unit].cost,
    started: false,
    run(sim, opening) {
      if (opening.core === undefined) return false
      sim.send(1, { type: 'produce', producer: opening.core, unit })
      return true
    },
    done: (sim) => countUnits(sim, unit) >= count,
  })
  return [
    {
      title: 'разворот MCV',
      cost: 0,
      started: false,
      run(sim) {
        sim.send(1, { type: 'deploy', unit: opening.mcv })
        return true
      },
      done: (_sim, opening) => opening.core !== undefined,
    },
    build('электростанция', 'generator', 1, core.x + 5, core.y - 4),
    build('шахта', 'mine', 1, deposit.x, deposit.y),
    build('генератор материи', 'matter', 1, core.x + 2, core.y - 4),
    build('хранилище', 'metalYard', 1, core.x + 4, core.y + 5),
    produce('грузовик', 'truck', 1),
    // Второй грузовик — свободный: привязанный к шахте руду на переработку возит, а космопорту нужен металл.
    produce('второй грузовик', 'truck', 2),
    // Переработка идёт до космопорта: продавать нечего, пока руда не станет металлом.
    build('переработка', 'smelter', 1, core.x + 5, core.y + 4),
    build('космопорт', 'spaceport', 1, core.x + 8, core.y + 4),
    build('вторая электростанция', 'generator', 2, core.x - 5, core.y - 4),
    build('второй генератор материи', 'matter', 2, core.x - 2, core.y - 4),
  ]
}

/** Обновляет, что уже построено и кто свободен; привязывает первый грузовик к шахте. */
function refresh(sim: Sim, opening: Opening) {
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (owner.player !== 1 || sim.world.has(entity, Site)) continue
    if (building.type === 'command') opening.core = entity
    if (building.type === 'mine') opening.mine = entity
    if (building.type === 'spaceport') opening.port = entity
  }
  opening.builders = []
  opening.trucks = []
  for (const [entity, unit, owner] of sim.world.query(Unit, Owner)) {
    if (owner.player !== 1) continue
    if (unit.type === 'builder') opening.builders.push(entity)
    if (unit.type === 'truck') opening.trucks.push(entity)
  }
  if (opening.mine !== undefined && opening.bound === undefined && opening.trucks.length) {
    sim.send(1, { type: 'haul', units: [opening.trucks[0]], mine: opening.mine })
    opening.bound = opening.trucks[0]
  }
}

/** Стартовая точка разгона: месторождение металла и место под главное здание рядом. */
function startSpot(sim: Sim) {
  for (const cell of rings(0, 0, 6)) {
    const spot = depositIn(sim, cell.x, cell.y)
    if (!spot || spot.kind !== 'metal') continue
    // Главное здание не строят: его разворачивает MCV на своё место, поэтому проверяется только место.
    // От месторождения оно стоит в стороне: займи оно его, шахту будет не поставить.
    const suit = (x: number, y: number) => canPlace(sim, 'command', x, y, 2) && rectsApart(rectOf('command', x, y), rectOf('mine', spot.x, spot.y), 1)
    const core = spotNear(spot.x + 1, spot.y + 1, suit, 12)
    if (core) return { spot, core }
  }
  throw new Error('Не нашлось места под старт у месторождения металла')
}

/** Русские имена наград: в таблице наград они названы по-английски, игроку они знакомы по-русски. */
const REWARD_NAMES: Record<string, string> = {
  deploy: 'разворот MCV', unit: 'первый юнит', generator: 'электростанция',
  matter: 'генератор материи', mine: 'шахта', silo: 'хранилище',
}

/** 4. Разгон настоящими командами: от разворота MCV до второго генератора материи. */
function printOpening() {
  const sim = newSim()
  const start = startSpot(sim)
  const center = { x: start.core.x + 1, y: start.core.y + 1 }
  const opening: Opening = { mcv: spawnUnit(sim, 'mcv', 1, center.x, center.y), builders: [], trucks: [] }
  addCredits(sim, 1, STARTING_CREDITS)
  const tiles = freeTilesNear(sim, start.core.x, start.core.y, 8)
  for (let i = 0; i < 2 && i * 2 + 1 < tiles.length; i++) {
    opening.builders.push(spawnUnit(sim, 'builder', 1, tiles[i * 2], tiles[i * 2 + 1]))
  }
  const steps = makeSteps(opening, center, start.spot)

  const limit = 600
  const events: { time: number; text: string }[] = []
  const curve: (string | number)[][] = []
  const known = new Set(rewardsOf(sim, 1))
  let index = 0
  let sales = 0
  let minute = creditsOf(sim, 1)
  let minuteRewards = 0
  let minuteSpend = 0

  for (let tick = 0; tick < Math.round(limit / TICK); tick++) {
    const time = tick * TICK
    // Продажа: игрок держит заявку открытой, как только есть что везти.
    const port = opening.port
    if (port !== undefined && canSell(sim, 1, port)) {
      const stock = Math.floor(stockOf(sim, 1).items.metal ?? 0)
      if (stock >= TRUCK_CAPACITY) sim.send(1, { type: 'sell', port, resource: 'metal', amount: stock })
    }
    const step = index < steps.length ? steps[index] : undefined
    if (step && !step.started && creditsOf(sim, 1) >= step.cost && step.run(sim, opening)) {
      step.started = true
      minuteSpend += step.cost
    }
    const ordered = port !== undefined && sim.world.has(port, Trade)
    sim.advance(TICK)
    refresh(sim, opening)
    // Корабль улетел: заявка пропала, кредиты начислены.
    if (ordered && !sim.world.has(port!, Trade)) {
      sales++
      if (sales === 1) events.push({ time, text: 'первая продажа металла' })
    }
    // Награды за вехи — это тоже доход, но разовый: в доходе на графике их не считаем.
    for (const key of rewardsOf(sim, 1)) {
      if (known.has(key)) continue
      known.add(key)
      const amount = REWARDS[key as keyof typeof REWARDS] ?? 0
      minuteRewards += amount
      events.push({ time, text: `награда: ${REWARD_NAMES[key] ?? key} +${amount}` })
    }
    if (step?.started && step.done(sim, opening)) {
      events.push({ time, text: step.title })
      index++
    }
    if ((tick + 1) % TICKS === 0) {
      const second = (tick + 1) / TICKS
      const credits = creditsOf(sim, 1)
      if (second % 60 === 0) {
        // Доход — это всё, что пришло не от разовых наград: продажи и пассивка, за вычетом потраченного.
        const income = (credits - minute - minuteRewards + minuteSpend) / 60
        curve.push([clock(second), credits, round(income, 1), Math.floor(stockOf(sim, 1).items.metal ?? 0), opening.trucks.length])
        minute = credits
        minuteRewards = 0
        minuteSpend = 0
      }
    }
  }

  events.sort((a, b) => a.time - b.time)
  console.log('\nРазгон настоящими командами: от MCV до второго генератора материи')
  for (const event of events) console.log(`  ${clock(event.time).padStart(5)}  ${event.text}`)
  if (index < steps.length) console.log(`  застряли на шаге «${steps[index].title}»: не хватило места, денег или строителя`)
  printTable(['минута', 'кредиты', 'доход/с', 'металл', 'грузовиков'], curve)
  console.log(`  продаж за прогон: ${sales}; доход/с — продажи и пассивка, без разовых наград за вехи`)
  sim.destroy()
}

/** Раздел целиком: сначала рудник, потом производство по его выручке, потом разгон. */
export function runEconomy() {
  printLineMath()
  const lineRate = measureMine()
  printProduction(lineRate)
  printProducts()
  printOpening()
}
