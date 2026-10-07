import type { Entity } from '../ecs'
import { Biome, Terrain, biomeAt, terrainAt } from '../map/terrain'
import { isPaved } from './paved'
import { BUILDINGS, buildingSpec, isWall, type BuildingType } from './buildings'
import { NONE, isOwn, onTurn, ownerOf, rectDistance, turnToward, wrap } from './common'
import { Armed, Blast, Building, Converting, Health, Inventory, Owner, Path, Pave, Position, Shot, Site, Turret, Unit } from './components'
import { releaseHauler } from './hauling'
import { amountOf, take } from './inventory'
import { searchedTiles } from './path'
import type { Sim } from './sim'
import { TURRETS, carrierOf, turnerOf, turretsOf } from './turrets'
import { UNITS, flies, orderMove, unitSpec, type UnitSpec } from './units'
import { WEAPONS, type Armor, type ShotKind, type WeaponSpec, type WeaponType } from './weapons'

/** Сколько единиц прочности у здания на кредит его цены. */
export const BUILDING_HP = 2
/** Раз во сколько тиков свободный юнит высматривает врага, а гонящийся за целью прокладывает путь заново. */
const SCAN_TICKS = 5
const CHASE_TICKS = 20
/** На сколько тайлов ближе дальности выстрела подходит гонящийся: с запасом на то, что и он, и цель стоят не в центрах тайлов. */
const CHASE_MARGIN = 1.5
/**
 * Насколько дальше бьёт оружие, стоящее на здании: турель выше и устойчивее машины. Без надбавки враг с тем же
 * оружием бьёт здание рядом с турелью с дальности, считанной от края здания, и оказывается вне её досягаемости.
 */
export const TOWER_RANGE = 2
/** Сколько гонящихся за тик прокладывают путь и сколько тайлов они на это вместе осматривают; остальные ждут следующего раза. */
const CHASE_SEARCHES = 16
const CHASE_TILES = 15000
/** На сколько стрелков сдвигается начало обхода с каждым тиком. */
const SHOOTER_STRIDE = 17
/** Не нашедший пути гонящийся пробует снова вдвое реже с каждой неудачей, но не больше стольких удвоений. */
const STUCK_LIMIT = 3
/** Насколько точно юнит должен смотреть на цель, чтобы выстрелить, в радианах. */
const AIM = 0.12
/** Сколько тиков виден след лазера и разряда. */
const BEAM_TICKS = 3
/** На каком расстоянии разряд перескакивает на следующую цель, в тайлах, и какая доля урона остаётся после прыжка. */
const CHAIN_RANGE = 2.5
const CHAIN_DECAY = 0.6
/** Во сколько раз дальше дальности стрельбы наводящийся снаряд летит за целью, прежде чем сгореть. */
const OVERFLY = 1.5
/** У края взрыва достаётся такая доля урона. */
const SPLASH_EDGE = 0.5
/**
 * Что стена останавливает. Ракета летит поверх неё, разряд бьёт через неё: от электричества и ракет стена не укрывает.
 * Остальное — пули, ядро, лазер — в стену и попадает, а не в того, кто за ней.
 */
const STOPS_AT_WALL: Record<ShotKind, boolean> = { bullet: true, shell: true, laser: true, rocket: false, arc: false, flame: true }
/** Учебный противник: игрок, за которого никто не играет. Его юнитов создаёт отладочная команда spawnUnit. */
export const TRAINING_PLAYER = 9999

/** Сколько урона выдерживает здание этого вида. */
export const buildingHp = (type: BuildingType) => buildingSpec(type).hp ?? BUILDINGS[type].cost * BUILDING_HP

/** Враги ли игроки. Игрок 0 — ничей: он ни с кем не воюет. */
export const hostile = (a: number, b: number) => a !== b && a !== 0 && b !== 0

/** Всё, во что можно попасть: юнит или здание. Собирается раз в тик. */
interface Mark {
  entity: Entity
  player: number
  /** Центр. */
  x: number
  y: number
  /** Прямоугольник основания у здания; у юнита — нулевой, в его центре. */
  left: number
  top: number
  width: number
  height: number
  /** Радиус юнита; у здания ноль. */
  radius: number
  air: boolean
  armor: Armor
  /** Стена: остановленный ею выстрел достаётся только стенам. */
  wall: boolean
  hp: number
  /** Компонент прочности: урон пишется прямо в него, туда же — тик попадания. */
  health: { value: number; hit: number }
}

/** Расстояние от точки до края цели в тайлах. */
function distanceTo(mark: Mark, x: number, y: number) {
  return Math.max(0, rectDistance(mark.left, mark.top, mark.width, mark.height, x, y) - mark.radius)
}

function collectMarks(sim: Sim) {
  const marks = new Map<Entity, Mark>()
  for (const [entity, position, unit, owner, health] of sim.world.query(Position, Unit, Owner, Health)) {
    const spec: UnitSpec = UNITS[unit.type]
    marks.set(entity, {
      entity, player: owner.player, x: position.x, y: position.y, left: position.x, top: position.y, width: 0, height: 0,
      radius: spec.radius, air: spec.kind === 'air', armor: spec.kind, wall: false, hp: spec.hp, health,
    })
  }
  for (const [entity, position, building, owner, health] of sim.world.query(Position, Building, Owner, Health)) {
    const { width, height } = BUILDINGS[building.type]
    marks.set(entity, {
      entity, player: owner.player, x: position.x + width / 2, y: position.y + height / 2, left: position.x, top: position.y, width, height,
      radius: 0, air: false, armor: 'building', wall: building.type === 'wall', hp: buildingHp(building.type), health,
    })
  }
  return marks
}

/**
 * Первая чужая стена на отрезке выстрела и точка, где снаряд в неё входит; undefined — путь свободен.
 * Своя стена не мешает: через неё стреляют, как через бруствер. Отрезок задан в тайлах, от стрелка к цели.
 */
function wallOnPath(sim: Sim, player: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0
  const dy = y1 - y0
  if (!dx && !dy) return undefined
  const lastX = Math.floor(x1)
  const lastY = Math.floor(y1)
  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  /** Через сколько долей отрезка снаряд пересекает следующую границу тайла по этой оси. */
  const deltaX = dx ? Math.abs(1 / dx) : Infinity
  const deltaY = dy ? Math.abs(1 / dy) : Infinity
  let tileX = Math.floor(x0)
  let tileY = Math.floor(y0)
  let crossX = dx ? (dx > 0 ? tileX + 1 - x0 : x0 - tileX) / Math.abs(dx) : Infinity
  let crossY = dy ? (dy > 0 ? tileY + 1 - y0 : y0 - tileY) / Math.abs(dy) : Infinity
  /** Доля отрезка, на которой снаряд вошёл в текущий тайл. */
  let t = 0
  // Отрезок короткий: снаряд за тик пролетает тайл-другой. Запас нужен лишь на вырожденный случай.
  for (let tile = 0; tile < 64; tile++) {
    const building = sim.occupancy.at(tileX, tileY)
    if (building !== undefined && isWall(sim, building) && !isOwn(sim, player, building)) {
      return { wall: building, x: x0 + dx * t, y: y0 + dy * t }
    }
    if (tileX === lastX && tileY === lastY) return undefined
    if (crossX < crossY) {
      t = crossX
      tileX += stepX
      crossX += deltaX
    } else {
      t = crossY
      tileY += stepY
      crossY += deltaY
    }
  }
  return undefined
}

/** Раз в тик: те, чья прочность восстанавливается сама (Health.regen), понемногу поправляются — кроме задетых в этот тик. */
export function recover(sim: Sim) {
  for (const [, health] of sim.world.query(Health)) {
    if (health.regen > 0 && health.hit !== sim.time.tick && health.value < health.max) health.value = Math.min(health.max, health.value + health.regen * sim.time.step)
  }
}

/**
 * Хватит ли носителю боеприпасов на выстрел этим оружием. Стреляют боеприпасами только турели зданий с
 * BuildingSpec.ammo; юнитам и прочим зданиям хватает всегда.
 */
export function hasAmmo(sim: Sim, carrier: Entity, weapon: WeaponSpec) {
  const type = sim.world.get(carrier, Building)?.type
  if (type === undefined || !buildingSpec(type).ammo || !weapon.ammo) return true
  const store = sim.world.get(carrier, Inventory)
  return !!store && amountOf(store, 'ammo') >= weapon.ammo - 1e-9
}

/** Оружие юнита или турели; undefined — безоружен. */
export const weaponOf = (sim: Sim, entity: Entity): WeaponType | undefined => {
  const type = sim.world.get(entity, Unit)?.type
  if (type) return unitSpec(type).weapon
  const turret = sim.world.get(entity, Turret)?.type
  return turret && (TURRETS[turret] as { weapon?: WeaponType }).weapon
}

/** Может ли игрок приказать своим юнитам атаковать это: чужой юнит или чужое здание. */
export function canAttack(sim: Sim, player: number, target: Entity) {
  const { world } = sim
  if (!world.has(target, Position) || (!world.has(target, Unit) && !world.has(target, Building))) return false
  return hostile(player, ownerOf(sim, target))
}

/**
 * Приказывает юнитам игрока атаковать цель: они подходят на выстрел и бьют, пока цель жива. Турели носителя
 * берут цель вместе с ним, а сам носитель подъезжает к ней на выстрел турелей.
 * Чужие, безоружные и те, чьё оружие до цели не достаёт (по летающим), из списка выбрасываются.
 */
export function orderAttack(sim: Sim, player: number, units: Entity[], target: Entity) {
  const { world } = sim
  if (!canAttack(sim, player, target)) return false
  const unit = world.get(target, Unit)
  const air = !!unit && flies(unit.type)
  /** Берёт ли цель этот стрелок; возвращает дальность его оружия или 0. */
  const aim = (entity: Entity) => {
    const armed = world.get(entity, Armed)
    const weapon = weaponOf(sim, entity)
    const spec: WeaponSpec | undefined = weapon && WEAPONS[weapon]
    if (!armed || !spec || (air ? !spec.air : spec.onlyAir)) return 0
    armed.target = target
    armed.chase = true
    armed.stuck = 0
    return spec.range
  }
  let ordered = false
  for (const entity of new Set(units)) {
    if (!isOwn(sim, player, entity)) continue
    if (aim(entity)) {
      // Прежний путь больше не нужен: к цели юнит тронется сам в ближайший тик.
      world.remove(entity, Path)
      ordered = true
      continue
    }
    // Безоружный носитель подвозит турели на выстрел: путь к цели ему проложит бой, как гонящемуся.
    if (!turretsOf(sim, entity).map(aim).some(Boolean)) continue
    world.remove(entity, Path)
    ordered = true
  }
  return ordered
}

/** Снимает с юнита и его турелей цель: они снова бьют только тех, до кого достают с места. */
export function stopAttack(sim: Sim, entity: Entity) {
  for (const gunner of [entity, ...turretsOf(sim, entity)]) {
    const armed = sim.world.get(gunner, Armed)
    if (!armed) continue
    armed.target = NONE
    armed.chase = false
  }
}

/**
 * Раз в тик: бой. Вооружённые юниты бьют врагов — чужих юнитов и здания. Свободный юнит сам стреляет в тех, до кого
 * достаёт с места; получив приказ атаковать или попав под огонь, гонится за целью. Стреляет он только стоя
 * и повернувшись к цели. Снаряды летят и бьют, долетев; прочность, упавшая до нуля, — гибель.
 */
export function fight(sim: Sim) {
  const { world, time } = sim
  const marks = collectMarks(sim)
  const dead = new Set<Entity>()
  /** Взрывы тика. ground — пришёлся в землю, а не в летающего: такой оставляет гарь. */
  const blasts: { x: number; y: number; size: number; ground: boolean }[] = []

  const canHit = (weapon: WeaponSpec, player: number, mark: Mark) =>
    hostile(player, mark.player) && (mark.air ? weapon.air : !weapon.onlyAir) && !dead.has(mark.entity)

  /** Наносит урон. source — кто стрелял: уцелевший свободный юнит отвечает ему огнём. */
  const hit = (mark: Mark, amount: number, weapon: WeaponSpec, source: Entity) => {
    if (dead.has(mark.entity)) return
    // Тик попадания помнит ремонт: под огнём не чинят, см. REPAIR_PAUSE.
    mark.health.hit = time.tick
    mark.health.value -= (amount * (weapon.vs?.[mark.armor] ?? 1)) / mark.hp
    if (mark.health.value <= 0) {
      dead.add(mark.entity)
      return
    }
    const from = marks.get(source)
    if (!from || world.has(mark.entity, Path)) return
    // Отвечают и сам юнит, и его турели.
    for (const gunner of [mark.entity, ...turretsOf(sim, mark.entity)]) {
      const armed = world.get(gunner, Armed)
      const own = weaponOf(sim, gunner)
      if (!armed || !own || armed.target !== NONE || !canHit(WEAPONS[own], mark.player, from)) continue
      armed.target = source
      // Здание отвечает, только если само достаёт до стрелка: гнаться за ним может лишь носитель-юнит.
      armed.chase = world.has(mark.entity, Unit)
      armed.stuck = 0
    }
  }

  /**
   * Попадание в точку: урон цели или всем врагам в радиусе взрыва. blocked — выстрел остановила стена:
   * тогда взрыв достаётся только стенам, а всё, что за ними, укрыто.
   */
  const impact = (weapon: WeaponSpec, player: number, source: Entity, target: Entity, x: number, y: number, blocked = false) => {
    if (!weapon.splash) {
      const mark = marks.get(target)
      if (mark && canHit(weapon, player, mark)) hit(mark, weapon.damage, weapon, source)
      return
    }
    for (const mark of marks.values()) {
      if (blocked && !mark.wall) continue
      if (!canHit(weapon, player, mark)) continue
      const distance = distanceTo(mark, x, y)
      if (distance > weapon.splash) continue
      hit(mark, weapon.damage * (1 - (1 - SPLASH_EDGE) * (distance / weapon.splash)), weapon, source)
    }
  }

  /** Списывает боеприпасы на выстрел со склада носителя. Юниты стреляют бесплатно; false — стрелять нечем. */
  const spend = (carrier: Entity, weapon: WeaponSpec) => {
    if (!hasAmmo(sim, carrier, weapon)) return false
    const store = world.get(carrier, Inventory)
    if (store && weapon.ammo) take(store, 'ammo', weapon.ammo)
    return true
  }

  // Взрывы и следы лучей доживают свой срок.
  const gone: Entity[] = []
  for (const [entity, blast] of world.query(Blast)) if (++blast.age >= blast.life) gone.push(entity)

  // Снаряды летят. Попадания — после обхода.
  const landed: { entity: Entity; weapon: WeaponSpec; player: number; source: Entity; target: Entity; x: number; y: number; blocked: boolean }[] = []
  for (const [entity, shot, position] of world.query(Shot, Position)) {
    const weapon: WeaponSpec = WEAPONS[shot.weapon]
    shot.age++
    if (!weapon.speed) {
      if (shot.age >= shot.life) gone.push(entity)
      continue
    }
    shot.prevX = position.x
    shot.prevY = position.y
    // Пуля и ракета следят за целью, пока она жива; ядро летит, куда выпущено.
    const mark = weapon.shot === 'shell' ? undefined : marks.get(shot.target as Entity)
    if (mark) {
      shot.toX = mark.x
      shot.toY = mark.y
    }
    const dx = shot.toX - position.x
    const dy = shot.toY - position.y
    const distance = Math.hypot(dx, dy)
    const move = weapon.speed * time.step
    if (distance <= move || shot.age >= shot.life) {
      // Не догнавший цель снаряд сгорает там, где оказался.
      const reached = distance <= move
      if (reached) {
        position.x = shot.toX
        position.y = shot.toY
      }
      if (reached || weapon.splash) {
        landed.push({ entity, weapon, player: shot.player, source: shot.source as Entity, target: shot.target as Entity, x: position.x, y: position.y, blocked: shot.blocked })
      } else gone.push(entity)
      continue
    }
    position.x += (dx / distance) * move
    position.y += (dy / distance) * move
  }
  for (const { entity, weapon, player, source, target, x, y, blocked } of landed) {
    impact(weapon, player, source, target, x, y, blocked)
    // Попадание в летающего земли не касается.
    blasts.push({ x, y, size: weapon.splash ?? 0.2, ground: !marks.get(target)?.air })
    gone.push(entity)
  }
  for (const entity of gone) world.destroy(entity)

  // Стрелки. Список собирается заранее: дальше мир и обходится заново, и меняется.
  const shooters: { entity: Entity; armed: { target: number; chase: boolean; cooldown: number; stuck: number } }[] = []
  for (const [entity, armed] of world.query(Armed)) shooters.push({ entity, armed })

  let searches = 0
  /** Носители, которым в этот тик уже проложен путь к цели. */
  const chasing = new Set<Entity>()
  const searchedBefore = searchedTiles()
  // Обход каждый тик начинается с нового места: иначе норма поисков пути всегда доставалась бы одним и тем же.
  const first = shooters.length ? (time.tick * SHOOTER_STRIDE) % shooters.length : 0
  for (let index = 0; index < shooters.length; index++) {
    const { entity, armed } = shooters[(first + index) % shooters.length]
    if (armed.cooldown > 0) armed.cooldown--
    // Турель стреляет с носителя: её место — своё, а чей выстрел и кому отвечать огнём — носителя.
    const carrier = carrierOf(sim, entity)
    const mounted = carrier !== entity
    const body = marks.get(carrier)
    const position = world.get(entity, Position)
    const turner = turnerOf(sim, entity)
    const weaponType = weaponOf(sim, entity)
    if (!body || !position || !turner || !weaponType || world.has(carrier, Converting) || world.has(carrier, Site)) continue
    const self = { x: position.x, y: position.y, player: body.player }
    const weapon: WeaponSpec = WEAPONS[weaponType]
    const range = weapon.range + (world.has(carrier, Building) ? TOWER_RANGE : 0)

    let target = marks.get(armed.target as Entity)
    if (target && !canHit(weapon, self.player, target)) target = undefined
    // Гонится за целью тот, кто ездит: юнит сам, турель — на своём носителе. Стреляет турель и на ходу.
    const mover = carrier
    const moving = world.has(mover, Path)
    if (!target) {
      armed.target = NONE
      armed.chase = false
      // Свободный юнит высматривает врага в пределах выстрела: сперва юнитов, потом здания.
      if ((moving && !mounted) || !onTurn(time, entity, SCAN_TICKS)) continue
      let best = Infinity
      for (const mark of marks.values()) {
        if (!canHit(weapon, self.player, mark)) continue
        const distance = distanceTo(mark, self.x, self.y)
        if (distance > range || distance < (weapon.minRange ?? 0)) continue
        const order = distance + (mark.armor === 'building' ? range : 0)
        if (order >= best) continue
        best = order
        target = mark
      }
      if (!target) continue
      armed.target = target.entity
    }

    if (distanceTo(target, self.x, self.y) > range) {
      if (!armed.chase || !world.has(mover, Unit)) armed.target = NONE
      // Носитель везёт к цели одна его турель за тик: остальным ехать с ним же.
      else if (mounted && chasing.has(mover)) continue
      // Вставший трогается снова не каждый тик, а не нашедший пути — всё реже: искать его без конца слишком дорого.
      else if (onTurn(time, entity, moving ? CHASE_TICKS : SCAN_TICKS << Math.min(armed.stuck, STUCK_LIMIT))) {
        const goalX = Math.floor(target.x)
        const goalY = Math.floor(target.y)
        // Цель с места не сошла — прежний путь годится.
        const path = world.get(mover, Path)
        if (path && Math.abs(path.goalX - goalX) <= 1 && Math.abs(path.goalY - goalY) <= 1) continue
        // Остальные дождутся своей очереди: сотня поисков пути за тик — заметная запинка.
        if (searches++ >= CHASE_SEARCHES || searchedTiles() - searchedBefore >= CHASE_TILES) continue
        // Идти надо не в саму цель, а на выстрел от неё: цель занята, а к зданию или в гущу врагов и не подойти.
        const near = Math.max(0, weapon.range - CHASE_MARGIN) + Math.max(target.width, target.height) / 2
        chasing.add(mover)
        orderMove(sim, mover, goalX, goalY, undefined, 0, near)
        armed.stuck = world.has(mover, Path) ? 0 : armed.stuck + 1
      }
      continue
    }
    // В мёртвой зоне оружие молчит. Сам выбранную цель стрелок бросает: найдёт другую, подальше.
    if (distanceTo(target, self.x, self.y) < (weapon.minRange ?? 0)) {
      if (!armed.chase) armed.target = NONE
      continue
    }
    // На выстреле: гнавшийся встаёт. Идущий по приказу игрока не стреляет — цели у него нет; турель на едущем
    // по приказу носителе стреляет, но носитель не останавливает.
    if (moving && (!mounted || armed.chase)) world.remove(mover, Path)

    const wanted = Math.atan2(target.y - self.y, target.x - self.x)
    const { body: aimer } = turner
    aimer.facing = turnToward(aimer.facing, wanted, turner.turn * time.step)
    if (armed.cooldown > 0 || Math.abs(wrap(wanted - aimer.facing)) > AIM) continue
    // Турель здания стреляет боеприпасами с его склада: кончились — молчит, пока не подвезут.
    if (!spend(carrier, weapon)) continue
    armed.cooldown = Math.max(1, Math.round(weapon.reload / time.step))

    // Выстрел — из точки перед стрелком.
    const fromX = self.x + Math.cos(aimer.facing) * turner.radius
    const fromY = self.y + Math.sin(aimer.facing) * turner.radius
    const shot = { weapon: weaponType, player: self.player, source: carrier, fromX, fromY, prevX: fromX, prevY: fromY }
    // Стена на линии огня принимает выстрел на себя: за ней укрытие. Турели зданий стоят выше стены и бьют поверх.
    const wall = !world.has(carrier, Building) && STOPS_AT_WALL[weapon.shot] && !weapon.lob ? wallOnPath(sim, self.player, self.x, self.y, target.x, target.y) : undefined
    const hitX = wall ? wall.x : target.x
    const hitY = wall ? wall.y : target.y
    if (weapon.speed) {
      // Ядру отпущено время до точки падения, наводящимся — пока не улетят слишком далеко.
      const reach = weapon.shot === 'shell' ? Math.hypot(hitX - fromX, hitY - fromY) : range * OVERFLY
      const life = Math.max(1, Math.ceil(reach / weapon.speed / time.step))
      const targetEntity = wall ? wall.wall : target.entity
      world.spawn(Position({ x: fromX, y: fromY }), Shot({ ...shot, target: targetEntity, toX: hitX, toY: hitY, blocked: wall !== undefined, life }))
      continue
    }
    // Луч стены не обходит: лазер бьёт в неё, а не в цель за ней. Разряду стена не помеха — он бьёт через неё.
    if (wall) {
      world.spawn(Position({ x: fromX, y: fromY }), Shot({ ...shot, target: wall.wall, toX: hitX, toY: hitY, life: BEAM_TICKS }))
      sim.traces.add({ kind: 'burn', x: hitX, y: hitY })
      const mark = marks.get(wall.wall)
      if (mark) hit(mark, weapon.damage, weapon, carrier)
      continue
    }
    // Лазер, разряд и огонь бьют сразу; разряд и огонь перескакивают дальше на ближайших врагов.
    let damage = weapon.damage
    let from = { x: fromX, y: fromY }
    let next: Mark | undefined = target
    const struck = new Set<Entity>()
    for (let jump = 0; next && jump <= (weapon.chain ?? 0); jump++) {
      const current: Mark = next
      struck.add(current.entity)
      world.spawn(
        Position({ x: from.x, y: from.y }),
        Shot({ ...shot, fromX: from.x, fromY: from.y, target: current.entity, toX: current.x, toY: current.y, life: BEAM_TICKS }),
      )
      hit(current, damage, weapon, carrier)
      // Луч прожигает землю там, куда попал.
      if (!current.air) sim.traces.add({ kind: 'burn', x: current.x, y: current.y })
      damage *= CHAIN_DECAY
      from = current
      next = undefined
      let nearest = CHAIN_RANGE
      for (const mark of marks.values()) {
        if (struck.has(mark.entity) || !canHit(weapon, self.player, mark)) continue
        const distance = distanceTo(mark, current.x, current.y)
        if (distance >= nearest) continue
        nearest = distance
        next = mark
      }
    }
  }

  // Болото красных пустошей едкое: жжёт стоящих в нём наземных юнитов.
  const burn = sim.rules.toxicSwamp * time.step
  if (burn > 0) {
    for (const mark of marks.values()) {
      if (mark.air || mark.radius === 0 || dead.has(mark.entity)) continue
      const x = Math.floor(mark.x)
      const y = Math.floor(mark.y)
      if (terrainAt(sim.land, x, y) !== Terrain.Swamp || biomeAt(sim.land, x, y) !== Biome.RedWastes) continue
      // Мост над болотом не жжёт.
      if (isPaved(sim, 'road', x, y)) continue
      // Отметка попадания: пока стоит в болоте, не чинится и сам не залечивается.
      mark.health.hit = time.tick
      mark.health.value -= burn
      if (mark.health.value <= 0) dead.add(mark.entity)
    }
  }

  for (const entity of dead) {
    const mark = marks.get(entity)!
    blasts.push({ x: mark.x, y: mark.y, size: mark.radius ? mark.radius * 2 : Math.max(mark.width, mark.height) * 0.7, ground: !mark.air })
    // От техники остаётся остов, от пехоты — только гарь.
    const unit = world.get(entity, Unit)
    if (unit && !mark.air && unitSpec(unit.type).kind !== 'infantry') {
      sim.traces.add({ kind: 'wreck', type: unit.type, facing: unit.facing, x: mark.x, y: mark.y })
    }
    releaseHauler(sim, entity)
    world.destroy(entity)
  }
  for (const { x, y, size, ground } of blasts) {
    world.spawn(Position({ x, y }), Blast({ size, life: Math.round((0.25 + size * 0.2) / time.step) }))
    if (ground) sim.traces.add({ kind: 'scar', x, y, size })
    if (ground) breakSlabs(sim, x, y, size)
  }
}

/** Взрыв меньше этого — пуля: фундамент от неё не трескается. */
const SLAB_BLAST = 0.5

/** Наземный взрыв разбивает фундамент: плиты, чьи центры в его радиусе, и ту, на которую он пришёлся. Пуля — нет. */
export function breakSlabs(sim: Sim, x: number, y: number, size: number) {
  if (size < SLAB_BLAST) return
  const radius = size / 2
  const broken: Entity[] = []
  for (let tileY = Math.floor(y - radius); tileY <= Math.floor(y + radius); tileY++) {
    for (let tileX = Math.floor(x - radius); tileX <= Math.floor(x + radius); tileX++) {
      const entity = sim.paving.at(tileX, tileY)
      if (entity === undefined || sim.world.get(entity, Pave)?.kind !== 'foundation') continue
      const hit = tileX === Math.floor(x) && tileY === Math.floor(y)
      if (hit || Math.hypot(tileX + 0.5 - x, tileY + 0.5 - y) <= radius) broken.push(entity)
    }
  }
  for (const entity of broken) sim.world.destroy(entity)
}
