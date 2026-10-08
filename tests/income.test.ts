import { expect, test } from 'bun:test'
import type { Entity } from '../src/ecs'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { Terrain, terrainAt } from '../src/map/terrain'
import {
  BUILDINGS, Building, Builds, CORE, Health, Owner, Player, Site, Unit,
  Off, OVERLOAD_DAMAGE, REPAIR_COST, powerSupply, REPAIR_SPEED, canBuild, canDeploy, canPlace, createSim, creditsOf, economyOf, powerOf, powerStates, refundOf, rewardsOf, siteAt, zoneEconomies, zoneOf, zonesOf, spawnStartingUnits, type BuildingType, type Sim,
} from '../src/sim'
import { placeBuilding } from '../src/sim/buildings'
import { REWARDS, STARTING_CREDITS } from '../src/sim/economy'
import { spawnUnit } from '../src/sim/units'

const options = { generator: DEFAULT_SETTINGS.generator, size: 1024, rules: { techTree: false } }
const TICK = 1 / 20
const seconds = (sim: Sim, time: number) => {
  for (let i = 0; i < Math.round(time / TICK); i++) sim.advance(TICK)
}
const PLATEAU = 14
/** Скала должна тянуться вправо дальше зоны главного здания: на ней проверяется расширение зоны. */
const WIDE = 26

/** Симуляция, где игрок 1 развернул главное здание в углу просторной скалы; (x, y) — левый верхний тайл скалы. */
function start() {
  const sim = createSim(options)
  const rock = (x: number, y: number) => {
    for (let tileY = y; tileY < y + PLATEAU; tileY++) {
      for (let tileX = x; tileX < x + WIDE; tileX++) {
        if (terrainAt(sim.land, tileX, tileY) !== Terrain.Rock) return false
      }
    }
    return true
  }
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!rock(x, y)) continue
      spawnStartingUnits(sim, 1, x + 2, y + 2)
      let mcv: Entity | undefined
      for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'mcv') mcv = entity
      sim.send(1, { type: 'deploy', unit: mcv! })
      seconds(sim, 3.1)
      return { sim, x, y }
    }
  }
  throw new Error('В мире не нашлось места под базу')
}

/** Готовое здание игрока 1, поставленное в обход стройки. */
const put = (sim: Sim, type: BuildingType, x: number, y: number) => placeBuilding(sim.world, type, x, y, 1)

function coreOf(sim: Sim) {
  for (const [entity, building, owner] of sim.world.query(Building, Owner)) {
    if (building.type === CORE && owner.player === 1) return entity
  }
  throw new Error('Главного здания нет')
}

test('развёрнутое главное здание приносит награду и понемногу кредиты', () => {
  const { sim } = start()
  expect(rewardsOf(sim, 1)).toEqual(['deploy'])
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS + REWARDS.deploy)
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 0, income: BUILDINGS.command.income, crowd: 0 })

  seconds(sim, 50)
  expect(creditsOf(sim, 1)).toBe(STARTING_CREDITS + REWARDS.deploy + 10)
})

test('награда выдаётся один раз: свернуть и развернуть заново ничего не даёт', () => {
  const { sim } = start()
  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(economyOf(sim, 1).income).toBe(0)
  const credits = creditsOf(sim, 1)
  let mcv: Entity | undefined
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'mcv') mcv = entity
  sim.send(1, { type: 'deploy', unit: mcv! })
  seconds(sim, 3.1)
  expect(sim.world.has(coreOf(sim), Building)).toBe(true)
  expect(creditsOf(sim, 1)).toBe(credits)
  expect(rewardsOf(sim, 1)).toEqual(['deploy'])
})

test('генератор материи даёт кредиты за энергию, а при её нехватке — меньше', () => {
  const { sim, x, y } = start()
  put(sim, 'matter', x + 6, y)
  // Без электростанции генератор материи стоит.
  expect(economyOf(sim, 1)).toEqual({ produced: 0, demand: 3, income: 0.2, crowd: 1 })

  put(sim, 'generator', x + 6, y + 4)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 3, income: 1.7, crowd: 1 })
  const credits = creditsOf(sim, 1)
  seconds(sim, 10)
  expect(creditsOf(sim, 1)).toBe(credits + 17)
})

test('каждый следующий генератор материи в зоне просит больше энергии', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y + 4)
  put(sim, 'matter', x + 6, y)
  // Второму генератору тесно: он просит две нормы вместо одной.
  expect(powerOf('matter', economyOf(sim, 1))).toBe(-6)
  expect(powerOf('generator', economyOf(sim, 1))).toBe(10)

  // Два просят 3 + 6 = 9 энергии — одной электростанции пока хватает.
  put(sim, 'matter', x + 9, y)
  expect(economyOf(sim, 1).demand).toBe(9)
  expect(economyOf(sim, 1).income).toBeCloseTo(0.2 + 2 * 1.5)

  // Третий просит ещё 9: 18 при 10, и общий доход от него только падает.
  put(sim, 'matter', x + 9, y + 4)
  expect(economyOf(sim, 1).demand).toBe(18)
  expect(economyOf(sim, 1).income).toBeCloseTo(0.2 + 3 * 1.5 * (10 / 18))
})

test('здания держат зону и работают и без главного здания; оторванное от базы — без энергии', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y)
  put(sim, 'matter', x + 6, y + 3)
  // Далёкий генератор материи — своя зона без электростанции: энергии ему нет, и дохода он не даёт.
  put(sim, 'matter', x + 60, y)
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 6, income: 1.7, crowd: 2 })

  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  // Свёрнуто главное здание: нет только его дохода.
  expect(economyOf(sim, 1)).toEqual({ produced: 10, demand: 6, income: 1.5, crowd: 2 })
})

test('готовые здания расширяют зону строительства по цепочке, стройки — нет', () => {
  const { sim, x, y } = start()
  // Главное здание стоит у (x + 3.5, y + 3.5): радиус 12 кончается около x + 15.
  const far = x + 17
  expect(zoneOf(sim, 1).length).toBe(3)
  expect(canPlace(sim, 'khariteVault', far, y + 3)).toBe(true)
  expect(canBuild(sim, 1, 'khariteVault', far, y + 3)).toBe(false)

  // Площадка у края зоны её не расширяет, готовое здание — расширяет.
  sim.send(1, { type: 'build', building: 'khariteVault', x: x + 13, y: y + 3, builders: [] })
  sim.advance(TICK)
  expect(canBuild(sim, 1, 'khariteVault', far, y + 3)).toBe(false)
  put(sim, 'khariteVault', x + 13, y + 5)
  expect(zoneOf(sim, 1).length).toBe(6)
  expect(canBuild(sim, 1, 'khariteVault', far, y + 3)).toBe(true)

  // Здание, до которого цепочка не дотягивается, держит свою, отдельную зону; встанет звено между ними — зоны сольются.
  put(sim, 'khariteVault', x + 22, y + 5)
  expect(zonesOf(sim, 1).length).toBe(2)
  put(sim, 'khariteVault', x + 18, y + 5)
  expect(zonesOf(sim, 1).length).toBe(1)
  expect(zoneOf(sim, 1).length).toBe(12)

  // Без главного здания зона остаётся: её держат сами здания.
  sim.send(1, { type: 'pack', building: coreOf(sim) })
  seconds(sim, 10.1)
  expect(zoneOf(sim, 1).length).toBe(9)
})

test('здание разбирают строители в полтора раза быстрее стройки; половина цены возвращается в конце', () => {
  const { sim, x, y } = start()
  const plant = put(sim, 'generator', x + 6, y + 6)
  const link = put(sim, 'khariteVault', x + 13, y + 5)
  const core = coreOf(sim)
  const builders: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'builder') builders.push(entity)
  expect(refundOf('generator')).toBe(150)
  expect(canBuild(sim, 1, 'khariteVault', x + 17, y + 3)).toBe(true)

  // Чужое, главное и недостроенное под разбор не идут.
  sim.send(1, { type: 'build', building: 'khariteVault', x: x + 9, y: y + 9, builders: [] })
  sim.advance(TICK)
  const site = siteAt(sim, x + 9, y + 9)!
  sim.send(2, { type: 'demolish', building: plant, builders: [] })
  sim.send(1, { type: 'demolish', building: core, builders: [] })
  sim.send(1, { type: 'demolish', building: site, builders: [] })
  sim.advance(TICK)
  expect(sim.world.has(plant, Site) || sim.world.has(core, Site)).toBe(false)
  expect(sim.world.get(site, Site)!.demolish).toBe(false)

  // Пока строитель не подошёл, здание стоит целым, но уже не работает и зону не расширяет.
  sim.world.destroy(builders[1])
  sim.send(1, { type: 'demolish', building: plant, builders: [] })
  sim.send(1, { type: 'demolish', building: link, builders: [] })
  sim.advance(TICK)
  expect(sim.world.get(plant, Site)).toEqual({ type: 'generator', progress: 300, demolish: true })
  expect(economyOf(sim, 1).produced).toBe(0)
  expect(canBuild(sim, 1, 'khariteVault', x + 17, y + 3)).toBe(false)

  // Отмена разбора возвращает здание в строй, денег при этом не даёт.
  const credits = creditsOf(sim, 1)
  sim.send(1, { type: 'cancelBuild', site: link })
  sim.advance(TICK)
  expect(sim.world.has(link, Site)).toBe(false)
  expect(canBuild(sim, 1, 'khariteVault', x + 17, y + 3)).toBe(true)
  expect(creditsOf(sim, 1) - credits).toBeLessThan(2)

  // Свободный строитель рядом берётся за разбор сам. Один разбирает электростанцию за 15 / 1,5 = 10 секунд, не считая дороги.
  let ticks = 0
  let working = 0
  while (sim.world.alive(plant) && ticks++ < 1200) {
    if (sim.world.get(plant, Site)!.progress < 300) working++
    sim.advance(TICK)
  }
  expect(sim.world.alive(plant)).toBe(false)
  expect(working).toBe(199)
  expect(sim.occupancy.at(x + 6, y + 6)).toBeUndefined()
  // Строитель освобождается на следующем тике.
  sim.advance(TICK)
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  const gained = creditsOf(sim, 1) - credits
  expect(gained).toBeGreaterThanOrEqual(150)
  expect(gained).toBeLessThan(150 + 20)
})

test('энергия у каждой зоны своя: электростанция одной зоны не питает другую', () => {
  const { sim, x, y } = start()
  put(sim, 'generator', x + 6, y)
  put(sim, 'generator', x + 6, y + 3)
  put(sim, 'matter', x + 9, y)
  expect(zoneEconomies(sim, 1)).toEqual([{ produced: 20, demand: 3, income: 1.7, crowd: 1 }])

  // Второе главное здание далеко от первого — вторая зона. Её генератор материи без своей электростанции стоит.
  const far = x + 300
  put(sim, 'command', far, y)
  put(sim, 'matter', far + 4, y)
  expect(zonesOf(sim, 1).length).toBe(2)
  expect(zoneEconomies(sim, 1)[1]).toEqual({ produced: 0, demand: 3, income: 0.2, crowd: 1 })
  // Теснота тоже считается по зонам: в каждой генератор материи первый.
  expect(economyOf(sim, 1).income).toBeCloseTo(1.9)

  put(sim, 'generator', far + 4, y + 3)
  expect(zoneEconomies(sim, 1)[1].income).toBeCloseTo(1.7)

  // Главное здание внутри чужой зоны свою не начинает: зона у них общая.
  put(sim, 'command', x + 10, y + 6)
  expect(zonesOf(sim, 1).length).toBe(2)
})

test('в чужой зоне не строят и не разворачиваются', () => {
  const { sim, x, y } = start()
  // Главное здание игрока 2 — справа, зоны перекрываются между x + 11 и x + 15.
  placeBuilding(sim.world, 'command', x + 22, y + 2, 2)
  expect(canBuild(sim, 1, 'khariteVault', x + 6, y + 2)).toBe(true)
  // В перекрытии зон не строит ни один.
  expect(canBuild(sim, 1, 'khariteVault', x + 12, y + 3)).toBe(false)
  expect(canBuild(sim, 2, 'khariteVault', x + 12, y + 3)).toBe(false)
  expect(canBuild(sim, 2, 'khariteVault', x + 18, y + 3)).toBe(true)

  spawnUnit(sim, 'mcv', 2, x + 8, y + 8)
  spawnUnit(sim, 'mcv', 2, x + 20, y + 9)
  sim.advance(TICK)
  const mcvs: Entity[] = []
  for (const [entity, unit, owner] of sim.world.query(Unit, Owner)) if (unit.type === 'mcv' && owner.player === 2) mcvs.push(entity)
  expect(mcvs.map((mcv) => canDeploy(sim, 2, mcv))).toEqual([false, true])
})

test('перегруженная электростанция теряет прочность и разрушается; сама не восстанавливается', () => {
  const { sim, x, y } = start()
  // Строители починили бы станцию сами; здесь проверяется, что без них она не восстанавливается.
  const builders: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'builder') builders.push(entity)
  for (const builder of builders) sim.world.destroy(builder)
  const plant = put(sim, 'generator', x + 6, y + 4)
  const first = put(sim, 'matter', x + 6, y)
  const health = () => sim.world.get(plant, Health)!.value
  // Энергии хватает: никто не страдает.
  seconds(sim, 5)
  expect(health()).toBe(1)
  expect(powerStates(sim).size).toBe(0)

  // Просят 18 при 10: перегруз 0.8, станция под ударом, потребители замедлены.
  const second = put(sim, 'matter', x + 9, y)
  const third = put(sim, 'matter', x + 9, y + 4)
  expect(powerStates(sim)).toEqual(new Map([[plant, 'overload'], [first, 'starved'], [second, 'starved'], [third, 'starved']]))
  sim.advance(TICK)
  expect(health()).toBeCloseTo(1 - OVERLOAD_DAMAGE * 0.8 * TICK)
  // Повреждённая станция даёт меньше энергии, поэтому перегруз растёт сам и урон ускоряется.
  seconds(sim, 20)
  expect(health()).toBeLessThan(1 - OVERLOAD_DAMAGE * 0.8 * 20)
  expect(economyOf(sim, 1).produced).toBeCloseTo(10 * health())

  // Перегруз сняли — урон прекратился, но сама станция не чинится.
  // Снимать надо весь перегруз: битая станция даёт меньше десяти, и двух генераторов материи ей уже много.
  sim.world.destroy(second)
  sim.world.destroy(third)
  const damaged = health()
  seconds(sim, 4)
  expect(health()).toBe(damaged)
  expect(powerStates(sim).size).toBe(0)

  // Сильный перегруз доводит станцию до разрушения; дальше потребители стоят без энергии.
  put(sim, 'matter', x + 9, y)
  put(sim, 'matter', x + 9, y + 4)
  put(sim, 'matter', x + 12, y)
  seconds(sim, 1 / OVERLOAD_DAMAGE + 5)
  expect(sim.world.has(plant, Building)).toBe(false)
  expect(economyOf(sim, 1).produced).toBe(0)
  expect(economyOf(sim, 1).income).toBeCloseTo(0.2)
})

test('строители чинят повреждённое здание — по приказу и сами; перегруженную станцию — только по приказу', () => {
  const { sim, x, y } = start()
  const plant = put(sim, 'generator', x + 6, y + 4)
  put(sim, 'matter', x + 6, y)
  const builders: Entity[] = []
  for (const [entity, unit] of sim.world.query(Unit)) if (unit.type === 'builder') builders.push(entity)
  const health = () => sim.world.get(plant, Health)!.value

  // Целое здание работой не считается.
  sim.send(1, { type: 'assist', units: builders, site: plant })
  sim.advance(TICK)
  expect(sim.world.has(builders[0], Builds)).toBe(false)

  // Свободные строители рядом сами берутся за починку. Она идёт вдвое быстрее стройки и стоит половину цены за целое здание.
  sim.world.get(plant, Health)!.value = 0.2
  const credits = creditsOf(sim, 1)
  const repairTime = 5 + (0.8 * (BUILDINGS.generator.cost / 20)) / REPAIR_SPEED
  seconds(sim, 1)
  expect(sim.world.has(builders[0], Builds)).toBe(true)
  seconds(sim, repairTime - 1)
  expect(health()).toBeCloseTo(1)
  // Починка 80% станции стоила 120. Доход за это время — около 1,2 в секунду: чуть меньше, пока битая станция
  // недодавала энергии, — отсюда допуск.
  const paid = credits + 1.2 * repairTime - creditsOf(sim, 1)
  expect(Math.abs(paid - 0.8 * BUILDINGS.generator.cost * REPAIR_COST)).toBeLessThan(15)

  // Денег нет — починка идёт только на то, что капает доходом зоны (1,7 в секунду), а секунда полной работы
  // стоит 20 кредитов: за десять секунд наберётся десятая часть работы, не больше.
  sim.world.get(plant, Health)!.value = 0.5
  for (const [entity, player] of sim.world.query(Player)) if (player.id === 1) sim.world.set(entity, Player, { credits: 0, earned: 0 })
  seconds(sim, 10)
  expect(health()).toBeGreaterThan(0.5)
  expect(health()).toBeLessThan(0.65)
  sim.world.get(plant, Health)!.value = 1
  sim.advance(TICK)
  expect(sim.world.has(builders[0], Builds)).toBe(false)

  // Перегруженную станцию строители сами не чинят: она только теряет прочность.
  for (const [entity, player] of sim.world.query(Player)) if (player.id === 1) sim.world.set(entity, Player, { credits: 500 })
  put(sim, 'matter', x + 9, y)
  put(sim, 'matter', x + 9, y + 4)
  seconds(sim, 10)
  const worn = health()
  expect(worn).toBeLessThan(1)
  expect(sim.world.has(builders[0], Builds)).toBe(false)
  // По приказу — чинят, и починка обгоняет урон.
  sim.send(1, { type: 'assist', units: builders, site: plant })
  seconds(sim, 5)
  expect(sim.world.has(builders[0], Builds)).toBe(true)
  expect(health()).toBeGreaterThan(worn)
})

test('игроку не в сети — пятая часть дохода и не больше потолка за отсутствие; вернулся — снова полный', () => {
  const { sim } = start()
  const income = economyOf(sim, 1).income
  expect(income).toBeGreaterThan(0)
  const earned = (time: number) => {
    const before = creditsOf(sim, 1) + sim.world.get(playerOf(sim), Player)!.earned
    seconds(sim, time)
    return creditsOf(sim, 1) + sim.world.get(playerOf(sim), Player)!.earned - before
  }
  expect(earned(20)).toBeCloseTo(income * 20, 1)
  // Ушёл: доход — пятая часть.
  sim.online = new Set()
  expect(earned(20)).toBeCloseTo(income * 20 * sim.rules.offlineIncome, 1)
  // Потолок — секунда обычного дохода: он уже набран, больше не капает.
  sim.rules.offlineMinutes = 1 / 60
  expect(earned(20)).toBeCloseTo(0, 6)
  // Вернулся — полный доход, а потолок обнулён.
  sim.online = new Set([1])
  expect(earned(20)).toBeCloseTo(income * 20, 1)
  expect(sim.world.get(playerOf(sim), Player)!.away).toBe(0)
})

function playerOf(sim: Sim) {
  for (const [entity, player] of sim.world.query(Player)) if (player.id === 1) return entity
  throw new Error('Игрока нет')
}

test('выключенный потребитель энергии не просит её и не работает; электростанцию не выключить', () => {
  const { sim, x, y } = start()
  const matter = put(sim, 'matter', x + 6, y)
  const radar = put(sim, 'radar', x + 9, y)
  const generator = put(sim, 'generator', x + 6, y + 4)
  expect(economyOf(sim, 1).demand).toBe(6)

  sim.send(1, { type: 'work', building: matter, on: false })
  sim.send(1, { type: 'work', building: generator, on: false })
  seconds(sim, 0.1)
  expect(sim.world.has(matter, Off)).toBe(true)
  expect(sim.world.has(generator, Off)).toBe(false)
  expect(economyOf(sim, 1)).toMatchObject({ demand: 3, income: 0.2 })
  expect(powerSupply(sim).has(matter)).toBe(false)
  expect(powerSupply(sim).get(radar)).toBe(1)

  sim.send(1, { type: 'work', building: matter, on: true })
  seconds(sim, 0.1)
  expect(economyOf(sim, 1)).toMatchObject({ demand: 6, income: 1.7 })
})
