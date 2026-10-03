import type { Entity } from '../ecs'
import { setBlend } from '../gl'
import { Biome, Terrain, biomeAt, terrainAt } from '../map/terrain'
import { createAtlas } from '../render/atlas'
import { createLineProgram, createLines } from '../render/lines'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { createSpriteProgram, createSprites } from '../render/sprites'
import { BUILDINGS, Beam, Blast, Building, Health, Position, Shot, UNITS, Unit, WEAPONS, activeRepairs, flies, type RepairLink, type WeaponSpec } from '../sim'
import { RESOURCE_COLORS } from './resourceColors'
import type { Scene } from './scene'
import { drawnPosition } from './units/unitsPass'

/** Сторона кадра взрыва в пикселях и число кадров от вспышки до дыма. */
const BLAST_FRAME = 48
const BLAST_FRAMES = 8
/** Во сколько раз картинка взрыва шире его радиуса. */
const BLAST_SCALE = 2.6
/** Во сколько раз пятно света взрыва шире его радиуса; ореол — вдвое уже. */
const BLAST_LIGHT = 5
/** Цвета взрыва по кадрам: от вспышки через огонь к дыму. */
const BLAST_COLORS = [0xfff6d0, 0xffe07a, 0xffb347, 0xff7a2a, 0xd9481c, 0x8a3a24, 0x55443e, 0x3a3432]

/** Длина следа пули и корпуса ракеты в тайлах. */
const BULLET_TAIL = 0.45
const ROCKET_BODY = 0.3
/** Сторона картинки клуба дыма в пикселях и число разных клубов. */
const PUFF_FRAME = 16
const PUFF_KINDS = 3
/** Больше клубов разом не бывает: самые старые уступают место новым. */
const PUFF_LIMIT = 700
/** Через сколько тайлов пути ракета и ядро оставляют за собой клуб дыма. */
const ROCKET_SMOKE_STEP = 0.22
const SHELL_SMOKE_STEP = 0.4
/** Какую долю скорости ветра набирает дым и с какой скоростью он всплывает, в тайлах в секунду. */
const SMOKE_WIND = 0.12
const SMOKE_RISE = 0.25
/** Какая доля яркости остаётся у дыма в полной темноте. */
const SMOKE_NIGHT = 0.75
/** Как высоко поднимается ядро в верхней точке дуги — доля от дальности выстрела. */
const SHELL_ARC = 0.3
/** Излом разряда: через сколько тайлов ломается линия, насколько отклоняется и сколько раз в секунду меняется. */
const ARC_STEP = 0.45
const ARC_SWAY = 0.28
const ARC_RATE = 30
/**
 * Размеры вспышек, лучей и снарядов заданы в точках: точка — пиксель экрана при таком масштабе (пикселей на тайл).
 * При другом масштабе они меняются вместе с миром, а не остаются прежними на экране.
 */
const EFFECT_ZOOM = 32
/** Сколько тиков после выстрела у ствола видна вспышка. */
const MUZZLE_TICKS = 1

/** Искры там, где ремонтник работает: сколько их разом, как далеко разлетаются в тайлах и сколько раз в секунду вспыхивают заново. */
const WELD_SPARKS = 4
const WELD_SPREAD = 0.35
const WELD_RATE = 12

/** Транспортный луч: через сколько тайлов по нему бегут комочки груза и с какой скоростью, в тайлах в секунду. */
const CARGO_STEP = 0.3
const CARGO_SPEED = 2.5
/** На сколько тайлов вглубь основания здания уходит транспортный луч. */
const BEAM_INSET = 0.4

/**
 * Пыль под летающими: сколько клубов в секунду на тайл радиуса юнита, с какого расстояния от его середины
 * (в радиусах) они поднимаются и с какой скоростью разлетаются, в тайлах в секунду. Пыли разом не больше DUST_LIMIT.
 */
const DUST_RATE = 30
const DUST_RING = 0.7
const DUST_SPEED = 1.6
const DUST_LIMIT = 500
/** Какую долю скорости ветра набирает пыль; вверх она не всплывает, а стелется. */
const DUST_WIND = 0.2
/** Цвет пыли — цвет земли под юнитом; над болотом вместо пыли водяная взвесь, она бледнее. */
const SAND_DUST: Record<Biome, number> = {
  [Biome.Erg]: 0xd9b57c,
  [Biome.SaltFlats]: 0xe6dfcf,
  [Biome.RedWastes]: 0xc98660,
  [Biome.Marsh]: 0xb3a679,
}
const ROCK_DUST = 0xaa9d89
const SPRAY = 0xc4d6cf

/** Высота полоски прочности в пикселях экрана и её отступ над юнитом в тайлах. */
const BAR_HEIGHT = 3
const BAR_GAP = 0.25

type Color = readonly [number, number, number]
const BULLET: Color = [1, 0.9, 0.55]
const TRACER: Color = [0.75, 0.4, 0.05]
const ROCKET: Color = [0.85, 0.87, 0.9]
const FLAME: Color = [1, 0.6, 0.2]
const SHELL: Color = [0.12, 0.12, 0.14]
const LASER: Color = [1, 0.15, 0.3]
const SPARK: Color = [0.3, 0.6, 1]
const CORE: Color = [1, 1, 1]
/** Луч стройки и починки и луч разбора. */
const MEND: Color = [0.3, 1, 0.55]
const WRECK: Color = [1, 0.22, 0.1]
/** Транспортный луч и груз на нём. */
const TRACTOR: Color = [0.25, 0.95, 0.85]
/** Цвет груза на луче — цвет ресурса. */
const rgb = (color: number): Color => [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255]
const cargoColor = rgb
const BAR_BACK: Color = [0.03, 0.05, 0.08]
const BAR_GOOD: Color = [0.45, 0.9, 0.55]
const BAR_BAD: Color = [1, 0.35, 0.25]

/** Простое воспроизводимое случайное число от 0 до 1 по двум целым. */
function noise(a: number, b: number) {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Рисует кадр взрыва: огненный шар из клубов растёт, темнеет и расходится кольцом дыма. */
function drawBlast(frame: number) {
  const image = new Pixmap(BLAST_FRAME, BLAST_FRAME)
  const center = BLAST_FRAME / 2
  const progress = frame / (BLAST_FRAMES - 1)
  const radius = (center - 2) * (0.3 + 0.7 * Math.sqrt(progress))
  const CLOUDS = 7
  /** Клубы по кругу: чем дальше взрыв, тем дальше от центра и мельче. */
  const clouds = (share: number, size: number, color: number) => {
    for (let i = 0; i < CLOUDS; i++) {
      const angle = (i / CLOUDS) * Math.PI * 2 + noise(i, 3) * 0.8
      const reach = radius * share * (0.75 + noise(i, 5) * 0.25)
      image.circle(Math.round(center + Math.cos(angle) * reach), Math.round(center + Math.sin(angle) * reach), radius * size, color)
    }
  }
  if (progress < 0.6) {
    // Огненный шар: тёмная кайма, огонь, светлая сердцевина.
    image.circle(center, center, radius * 0.8, BLAST_COLORS[Math.min(frame + 2, BLAST_FRAMES - 1)])
    clouds(0.6, 0.42, BLAST_COLORS[Math.min(frame + 2, BLAST_FRAMES - 1)])
    image.circle(center, center, radius * 0.68, BLAST_COLORS[frame + 1])
    clouds(0.45, 0.32, BLAST_COLORS[frame + 1])
    image.circle(center, center, radius * 0.45, BLAST_COLORS[frame])
  } else {
    // Дым: клубы расходятся, середина пустеет.
    clouds(0.75, 0.34 * (1.4 - progress), BLAST_COLORS[frame])
    clouds(0.55, 0.2 * (1.4 - progress), BLAST_COLORS[frame - 1])
  }
  return image
}

/** Рисует клуб дыма: несколько кругов вразброс, светлые сверху и тёмные снизу. Цвет задаёт оттенок спрайта. */
function drawPuff(kind: number) {
  const image = new Pixmap(PUFF_FRAME, PUFF_FRAME)
  const center = PUFF_FRAME / 2
  const LOBES = 5
  for (const [shift, color] of [[1, 0xa8a8ae], [0, 0xe6e6ea]] as const) {
    image.circle(center, center + shift, 3.5, color)
    for (let i = 0; i < LOBES; i++) {
      const angle = (i / LOBES) * Math.PI * 2 + noise(i, kind) * 1.2
      const reach = 2.2 + noise(i, kind + 7) * 1.4
      image.circle(Math.round(center + Math.cos(angle) * reach), Math.round(center + Math.sin(angle) * reach) + shift, 2 + noise(i, kind + 13) * 1.2, color)
    }
  }
  return image
}

/**
 * Клуб дыма. Живёт только на экране, в симуляции его нет: x, y и скорость — в тайлах, age и life — в секундах,
 * size — начальный поперечник в тайлах, grow — во сколько раз он вырастет к концу, shade — яркость, level — плотность.
 * Пыль хранит свой цвет в color, у дыма он серый.
 */
interface Puff {
  x: number
  y: number
  speedX: number
  speedY: number
  age: number
  life: number
  size: number
  grow: number
  shade: number
  level: number
  kind: number
  color?: Color
}

/**
 * Проходы боя. lights ставится до освещения: добавляет огни — взрывы, лучи и вспышки выстрелов светят
 * в темноте — и двигает дым. effects ставится после освещения, чтобы ночью не темнело: рисует дым, снаряды, лучи,
 * взрывы и полоски прочности над повреждёнными юнитами. Дым темнеет к ночи сам, но не дочерна: иначе его не видно.
 * dust ставится под летающими: рисует пыль, которую их винты поднимают с земли.
 */
export function createCombatPasses(gl: WebGL2RenderingContext, scene: Scene): { dust: Pass; lights: Pass; effects: Pass } {
  const atlas = createAtlas(gl, [
    ...Array.from({ length: BLAST_FRAMES }, (_, i) => drawBlast(i)),
    ...Array.from({ length: PUFF_KINDS }, (_, i) => drawPuff(i)),
  ])
  const spriteProgram = createSpriteProgram(gl)
  const blasts = createSprites(gl, spriteProgram)
  const smoke = createSprites(gl, spriteProgram)
  const dustSprites = createSprites(gl, spriteProgram)
  const lineProgram = createLineProgram(gl)
  /** Светящееся складывается с картинкой, тёмное и полоски — ложатся поверх. */
  const glow = createLines(gl, lineProgram)
  const solid = createLines(gl, lineProgram)

  /** Доля отпущенного срока, которую выстрел или взрыв уже прожил, с учётом доли тика. */
  const ageOf = (thing: { age: number; life: number }, alpha: number) => Math.min(1, (thing.age + alpha) / Math.max(1, thing.life))

  const puffs: Puff[] = []
  const dust: Puff[] = []
  /** Где был каждый летающий в прошлом кадре: пыль от быстрого юнита ложится вдоль пути, а не кучками. */
  const flyers = new Map<Entity, { x: number; y: number; seen: number }>()
  let dustFrame = 0
  /** Где снаряд оставил последний клуб дыма; по этому же списку видно, какие выстрелы и взрывы уже дымили. */
  const trails = new Map<Entity, { x: number; y: number }>()
  const alive = new Set<Entity>()
  const spread = (size: number) => (Math.random() - 0.5) * size

  /** Кто над чем работает в этом кадре: считается раз, в проходе света, и рисуется в обоих. */
  let repairs: RepairLink[] = []
  /** Концы луча работы в этом кадре: от края ремонтника до цели; движущийся юнит — там, где он нарисован. */
  const beamOf = (link: RepairLink, alpha: number) => {
    const { world } = scene.sim
    let { fromX, fromY, toX, toY } = link
    const target = world.get(link.to, Unit)
    const position = world.get(link.to, Position)
    if (target && position) ({ x: toX, y: toY } = drawnPosition(position, target, alpha))
    const tool = world.get(link.from, Unit)
    const length = Math.hypot(toX - fromX, toY - fromY)
    if (tool && length) {
      const reach = Math.min(UNITS[tool.type].radius, length) / length
      fromX += (toX - fromX) * reach
      fromY += (toY - fromY) * reach
    }
    return { fromX, fromY, toX, toY }
  }

  /** Где на сущности конец транспортного луча, протянутого к точке (x, y): юнит — где нарисован, здание — ближняя к точке часть основания. */
  const endOf = (entity: Entity, x: number, y: number, alpha: number) => {
    const { world } = scene.sim
    const position = world.get(entity, Position)
    if (!position) return undefined
    const unit = world.get(entity, Unit)
    if (unit) return drawnPosition(position, unit, alpha)
    const type = world.get(entity, Building)?.type
    if (type === undefined) return { x: position.x, y: position.y }
    const { width, height } = BUILDINGS[type]
    const insetX = Math.min(BEAM_INSET, width / 2)
    const insetY = Math.min(BEAM_INSET, height / 2)
    return {
      x: Math.min(position.x + width - insetX, Math.max(position.x + insetX, x)),
      y: Math.min(position.y + height - insetY, Math.max(position.y + insetY, y)),
    }
  }
  /** Центр сущности: от него тянется луч к другой. */
  const centerOf = (entity: Entity, alpha: number) => {
    const { world } = scene.sim
    const position = world.get(entity, Position)
    if (!position) return undefined
    const unit = world.get(entity, Unit)
    if (unit) return drawnPosition(position, unit, alpha)
    const type = world.get(entity, Building)?.type
    return type === undefined ? position : { x: position.x + BUILDINGS[type].width / 2, y: position.y + BUILDINGS[type].height / 2 }
  }
  /** Концы транспортного луча этого кадра: откуда груз уходит и куда приходит. */
  const tractorOf = (entity: Entity, target: Entity, pulling: boolean, alpha: number) => {
    const ownCenter = centerOf(entity, alpha)
    const otherCenter = centerOf(target, alpha)
    if (!ownCenter || !otherCenter) return undefined
    const own = endOf(entity, otherCenter.x, otherCenter.y, alpha)!
    const other = endOf(target, ownCenter.x, ownCenter.y, alpha)!
    const [from, to] = pulling ? [other, own] : [own, other]
    return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }
  }

  const puff = (x: number, y: number, size: number, life: number, shade: number, level: number, speedX = 0, speedY = 0) => {
    if (puffs.length >= PUFF_LIMIT) puffs.shift()
    puffs.push({
      x, y, speedX, speedY, age: 0, life: life * (0.75 + Math.random() * 0.5), size, grow: 1.2 + Math.random(),
      shade, level, kind: Math.floor(Math.random() * PUFF_KINDS),
    })
  }

  /** Новые клубы от выстрелов и взрывов этого кадра. */
  const emitSmoke = () => {
    const { world, time } = scene.sim
    alive.clear()
    for (const [entity, blast, position] of world.query(Blast, Position)) {
      alive.add(entity)
      if (trails.has(entity)) continue
      trails.set(entity, { x: position.x, y: position.y })
      // После взрыва остаётся тёмный дым: чем больше взрыв, тем его больше и тем дольше он висит.
      const count = Math.round(3 + blast.size * 4)
      for (let i = 0; i < count; i++) {
        puff(position.x + spread(blast.size), position.y + spread(blast.size), blast.size * (0.5 + Math.random() * 0.4), 1.4 + blast.size, 0.3, 0.75, spread(0.5), spread(0.5))
      }
    }
    for (const [entity, shot, position] of world.query(Shot, Position)) {
      alive.add(entity)
      const weapon: WeaponSpec = WEAPONS[shot.weapon]
      const last = trails.get(entity)
      if (!last) {
        trails.set(entity, { x: shot.fromX, y: shot.fromY })
        if (!weapon.speed) {
          // Лазер и разряд дымят там, куда попали.
          puff(shot.toX, shot.toY, 0.3, 0.7, 0.45, 0.5, spread(0.3), spread(0.3))
          continue
        }
        // Дым у ствола летит вслед за снарядом: у пули — облачко, у ядра и ракеты — целое облако.
        const reach = Math.hypot(shot.toX - shot.fromX, shot.toY - shot.fromY) || 1
        const headingX = (shot.toX - shot.fromX) / reach
        const headingY = (shot.toY - shot.fromY) / reach
        const heavy = weapon.shot !== 'bullet'
        for (let i = 0; i < (heavy ? 5 : 1); i++) {
          const push = heavy ? 0.6 + Math.random() * 1.6 : 0.8
          puff(shot.fromX, shot.fromY, heavy ? 0.4 : 0.2, heavy ? 1.1 : 0.4, 0.55, heavy ? 0.7 : 0.45, headingX * push + spread(0.6), headingY * push + spread(0.6))
        }
        continue
      }
      if (weapon.shot !== 'rocket' && weapon.shot !== 'shell') continue
      const rocket = weapon.shot === 'rocket'
      const step = rocket ? ROCKET_SMOKE_STEP : SHELL_SMOKE_STEP
      const x = shot.prevX + (position.x - shot.prevX) * time.alpha
      const y = shot.prevY + (position.y - shot.prevY) * time.alpha
      // Дым ядра остаётся в воздухе, на высоте дуги.
      const lift = rocket ? 0 : shellLift(shot, time.alpha)
      const distance = Math.hypot(x - last.x, y - last.y)
      const count = Math.min(16, Math.floor(distance / step))
      for (let i = 1; i <= count; i++) {
        const share = (i * step) / distance
        const atX = last.x + (x - last.x) * share
        const atY = last.y + (y - last.y) * share
        if (rocket) puff(atX + spread(0.08), atY + spread(0.08), 0.32, 1.3, 0.55, 0.75, spread(0.25), spread(0.25))
        else puff(atX, atY - lift, 0.18, 0.7, 0.5, 0.55, spread(0.15), spread(0.15))
      }
      if (count) {
        const share = (count * step) / distance
        last.x += (x - last.x) * share
        last.y += (y - last.y) * share
      }
    }
    for (const entity of trails.keys()) if (!alive.has(entity)) trails.delete(entity)
  }

  /** Как высоко над землёй ядро сейчас, в тайлах. */
  const shellLift = (shot: { age: number; life: number; fromX: number; fromY: number; toX: number; toY: number }, alpha: number) =>
    Math.sin(Math.PI * ageOf(shot, alpha)) * Math.hypot(shot.toX - shot.fromX, shot.toY - shot.fromY) * SHELL_ARC

  /** Цвет пыли над тайлом. */
  const dustColor = (x: number, y: number): { color: Color; level: number } => {
    const { land } = scene.sim
    const terrain = terrainAt(land, Math.floor(x), Math.floor(y))
    if (terrain === Terrain.Swamp) return { color: rgb(SPRAY), level: 0.3 }
    if (terrain === Terrain.Sand) return { color: rgb(SAND_DUST[biomeAt(land, Math.floor(x), Math.floor(y))]), level: 0.5 }
    return { color: rgb(ROCK_DUST), level: 0.4 }
  }

  /** Новая пыль под летающими: клубы поднимаются кольцом вокруг юнита и разлетаются от него. */
  const emitDust = (delta: number, camera: { x: number; y: number }, halfWidth: number, halfHeight: number) => {
    const { world, time } = scene.sim
    dustFrame++
    for (const [entity, position, unit] of world.query(Position, Unit)) {
      if (!flies(unit.type)) continue
      const { x, y } = drawnPosition(position, unit, time.alpha)
      if (Math.abs(x - camera.x) > halfWidth || Math.abs(y - camera.y) > halfHeight) continue
      const last = flyers.get(entity)
      flyers.set(entity, { x, y, seen: dustFrame })
      const { radius } = UNITS[unit.type]
      const expected = DUST_RATE * radius * delta
      const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0)
      for (let i = 0; i < count; i++) {
        // Клуб — в случайной точке пути за кадр, чтобы след быстрого юнита был сплошным.
        const share = last && Math.hypot(x - last.x, y - last.y) < 1 ? Math.random() : 1
        const atX = last ? last.x + (x - last.x) * share : x
        const atY = last ? last.y + (y - last.y) * share : y
        const angle = Math.random() * Math.PI * 2
        const reach = radius * DUST_RING * (0.7 + Math.random() * 0.6)
        const groundX = atX + Math.cos(angle) * reach
        const groundY = atY + Math.sin(angle) * reach
        const { color, level } = dustColor(groundX, groundY)
        const speed = DUST_SPEED * (0.6 + Math.random() * 0.8)
        if (dust.length >= DUST_LIMIT) dust.shift()
        dust.push({
          x: groundX, y: groundY, speedX: Math.cos(angle) * speed, speedY: Math.sin(angle) * speed, age: 0, life: 0.6 + Math.random() * 0.5,
          size: radius * (0.6 + Math.random() * 0.4), grow: 1.8 + Math.random(), shade: 1, level, kind: Math.floor(Math.random() * PUFF_KINDS), color,
        })
      }
    }
    if (dustFrame % 120 === 0) for (const [entity, flyer] of flyers) if (dustFrame - flyer.seen > 120) flyers.delete(entity)
  }

  return {
    dust: {
      draw({ camera, width, height, delta, view }) {
        const halfWidth = width / 2 / camera.zoom + 2
        const halfHeight = height / 2 / camera.zoom + 2
        emitDust(delta, camera, halfWidth, halfHeight)
        // Пыль быстро тормозит, сносится ветром и тает. Её освещает проход освещения, как землю под ней.
        const { windX, windY } = scene.settings.weather
        const drag = Math.exp(-delta * 3.5)
        dustSprites.clear()
        let kept = 0
        for (const item of dust) {
          item.age += delta
          if (item.age >= item.life) continue
          dust[kept++] = item
          item.speedX = windX * DUST_WIND + (item.speedX - windX * DUST_WIND) * drag
          item.speedY = windY * DUST_WIND + (item.speedY - windY * DUST_WIND) * drag
          item.x += item.speedX * delta
          item.y += item.speedY * delta
          if (Math.abs(item.x - camera.x) > halfWidth || Math.abs(item.y - camera.y) > halfHeight) continue
          const age = item.age / item.life
          const size = item.size * (1 + (item.grow - 1) * age)
          const level = item.level * Math.min(1, age * 6) * (1 - age)
          const frame = atlas.frames[BLAST_FRAMES + item.kind]
          const [r, g, b] = item.color!
          dustSprites.push(item.x - camera.x - size / 2, item.y - camera.y - size / 2, size, size, frame.u, frame.v, frame.width, frame.height, r * level, g * level, b * level, level)
        }
        dust.length = kept
        if (!dustSprites.count) return
        setBlend(gl, 'alpha')
        spriteProgram.use(view, { uTexture: atlas.texture })
        dustSprites.draw()
      },
      destroy() {
        dustSprites.destroy()
      },
    },
    lights: {
      draw({ lights, camera, width, height, delta }) {
        const { world, time } = scene.sim
        for (const [, blast, position] of world.query(Blast, Position)) {
          const left = 1 - ageOf(blast, time.alpha)
          const reach = blast.size * 16
          lights.add(position.x, position.y, reach * BLAST_LIGHT * left, reach * (BLAST_LIGHT / 2) * left, left)
        }
        for (const [, shot, position] of world.query(Shot, Position)) {
          const weapon: WeaponSpec = WEAPONS[shot.weapon]
          if (!weapon.speed) {
            const left = 1 - ageOf(shot, time.alpha)
            lights.add(shot.fromX, shot.fromY, 14, 6, left)
            lights.add(shot.toX, shot.toY, 20, 9, left)
          } else {
            if (shot.age <= MUZZLE_TICKS) lights.add(shot.fromX, shot.fromY, 14, 6, 1)
            if (weapon.shot === 'rocket') lights.add(position.x, position.y, 10, 4, 0.8)
          }
        }

        repairs = activeRepairs(scene.sim)
        for (const link of repairs) {
          const { toX, toY } = beamOf(link, time.alpha)
          // Свет сварки мерцает.
          lights.add(toX, toY, 12, 5, 0.5 + 0.5 * noise(link.from + link.to, Math.floor(time.elapsed * WELD_RATE * 2)))
        }

        for (const [entity, beam] of world.query(Beam)) {
          for (const link of beam.links) {
            const ends = tractorOf(entity, link.target as Entity, link.pulling, time.alpha)
            if (ends) lights.add((ends.fromX + ends.toX) / 2, (ends.fromY + ends.toY) / 2, 10, 4, 0.5)
          }
        }

        emitSmoke()
        // Дым тормозит, набирает скорость ветра и понемногу всплывает; клубы растут и тают.
        const { windX, windY, light } = scene.settings.weather
        // Ночью дым темнее и синее, как всё вокруг.
        const day = SMOKE_NIGHT + (1 - SMOKE_NIGHT) * light
        const warm = day * (0.8 + 0.2 * light)
        const drag = Math.exp(-delta * 2.5)
        const halfWidth = width / 2 / camera.zoom + 2
        const halfHeight = height / 2 / camera.zoom + 2
        smoke.clear()
        let kept = 0
        for (const item of puffs) {
          item.age += delta
          if (item.age >= item.life) continue
          puffs[kept++] = item
          item.speedX = windX * SMOKE_WIND + (item.speedX - windX * SMOKE_WIND) * drag
          item.speedY = windY * SMOKE_WIND - SMOKE_RISE + (item.speedY - windY * SMOKE_WIND + SMOKE_RISE) * drag
          item.x += item.speedX * delta
          item.y += item.speedY * delta
          if (Math.abs(item.x - camera.x) > halfWidth || Math.abs(item.y - camera.y) > halfHeight) continue
          const age = item.age / item.life
          const size = item.size * (1 + (item.grow - 1) * age)
          const level = item.level * Math.min(1, age * 8) * (1 - age)
          const frame = atlas.frames[BLAST_FRAMES + item.kind]
          smoke.push(
            item.x - camera.x - size / 2, item.y - camera.y - size / 2, size, size,
            frame.u, frame.v, frame.width, frame.height,
            item.shade * level * warm, item.shade * level * warm, item.shade * level * day, level,
          )
        }
        puffs.length = kept
      },
      destroy() {
        smoke.destroy()
      },
    },
    effects: {
      draw({ camera, width, height, time, view }) {
        const { world } = scene.sim
        const { alpha } = scene.sim.time
        const pixel = 1 / camera.zoom
        const point = 1 / EFFECT_ZOOM
        const halfWidth = width / 2 / camera.zoom + 3
        const halfHeight = height / 2 / camera.zoom + 3
        const visible = (x: number, y: number) => Math.abs(x - camera.x) < halfWidth && Math.abs(y - camera.y) < halfHeight
        /** Отрезок в тайлах мира; толщина — тоже в тайлах. */
        const strip = (lines: typeof glow, fromX: number, fromY: number, toX: number, toY: number, width: number, [r, g, b]: Color, level = 1) =>
          lines.push(fromX - camera.x, fromY - camera.y, toX - camera.x, toY - camera.y, width, r * level, g * level, b * level, level)
        /** Размер эффекта в тайлах по его размеру в точках: уменьшается и растёт вместе с миром, но не тоньше пикселя экрана. */
        const sized = (points: number) => Math.max(points * point, pixel)
        /** Отрезок эффекта в тайлах мира; толщина — в точках эффектов. */
        const line = (lines: typeof glow, fromX: number, fromY: number, toX: number, toY: number, thickness: number, color: Color, level = 1) =>
          strip(lines, fromX, fromY, toX, toY, sized(thickness), color, level)
        /** Квадрат со стороной в точках эффектов вокруг точки. */
        const dot = (lines: typeof glow, x: number, y: number, size: number, color: Color, level = 1) =>
          strip(lines, x - sized(size) / 2, y, x + sized(size) / 2, y, sized(size), color, level)

        blasts.clear()
        glow.clear()
        solid.clear()

        for (const [, blast, position] of world.query(Blast, Position)) {
          if (!visible(position.x, position.y)) continue
          const age = ageOf(blast, alpha)
          const frame = atlas.frames[Math.min(BLAST_FRAMES - 1, Math.floor(age * BLAST_FRAMES))]
          const size = blast.size * BLAST_SCALE
          // К концу дым тает.
          const level = Math.min(1, (1 - age) * 3)
          blasts.push(
            position.x - camera.x - size / 2, position.y - camera.y - size / 2, size, size,
            frame.u, frame.v, frame.width, frame.height,
            level, level, level, level,
          )
        }

        for (const [entity, shot, position] of world.query(Shot, Position)) {
          const weapon: WeaponSpec = WEAPONS[shot.weapon]
          if (!visible(position.x, position.y) && !visible(shot.toX, shot.toY)) continue

          if (!weapon.speed) {
            const left = 1 - ageOf(shot, alpha)
            if (weapon.shot === 'laser') {
              line(glow, shot.fromX, shot.fromY, shot.toX, shot.toY, 6, LASER, left * 0.7)
              line(glow, shot.fromX, shot.fromY, shot.toX, shot.toY, 2, CORE, left)
              dot(glow, shot.toX, shot.toY, 8, LASER, left)
              continue
            }
            // Разряд — ломаная, которая дрожит: изломы меняются много раз в секунду.
            const dx = shot.toX - shot.fromX
            const dy = shot.toY - shot.fromY
            const length = Math.hypot(dx, dy) || 1
            const joints = Math.max(2, Math.ceil(length / ARC_STEP))
            const seed = entity * 13 + Math.floor(time * ARC_RATE)
            let lastX = shot.fromX
            let lastY = shot.fromY
            for (let i = 1; i <= joints; i++) {
              const sway = i === joints ? 0 : (noise(seed, i) - 0.5) * 2 * ARC_SWAY
              const x = shot.fromX + (dx * i) / joints + (-dy / length) * sway
              const y = shot.fromY + (dy * i) / joints + (dx / length) * sway
              line(glow, lastX, lastY, x, y, 5, SPARK, left * 0.8)
              line(glow, lastX, lastY, x, y, 1.5, CORE, left)
              lastX = x
              lastY = y
            }
            dot(glow, shot.toX, shot.toY, 9, SPARK, left)
            continue
          }

          const x = shot.prevX + (position.x - shot.prevX) * alpha
          const y = shot.prevY + (position.y - shot.prevY) * alpha
          if (shot.age <= MUZZLE_TICKS) dot(glow, shot.fromX, shot.fromY, weapon.shot === 'bullet' ? 5 : 9, BULLET)

          // Куда летит: по движению за тик, а пока не сдвинулся — к цели.
          let headingX = position.x - shot.prevX
          let headingY = position.y - shot.prevY
          if (!headingX && !headingY) {
            headingX = shot.toX - position.x
            headingY = shot.toY - position.y
          }
          const speed = Math.hypot(headingX, headingY) || 1
          headingX /= speed
          headingY /= speed

          if (weapon.shot === 'bullet') {
            // След не длиннее пройденного: у самого ствола пуля ещё короткая.
            const tail = Math.min(BULLET_TAIL, Math.hypot(x - shot.fromX, y - shot.fromY))
            // Тёмная подложка: на светлом песке одно свечение не видно.
            line(solid, x - headingX * tail, y - headingY * tail, x, y, 2, TRACER)
            line(glow, x - headingX * tail, y - headingY * tail, x, y, 2, BULLET)
          } else if (weapon.shot === 'rocket') {
            line(glow, x - headingX * (ROCKET_BODY + 0.2), y - headingY * (ROCKET_BODY + 0.2), x - headingX * ROCKET_BODY, y - headingY * ROCKET_BODY, 3, FLAME)
            line(solid, x - headingX * ROCKET_BODY, y - headingY * ROCKET_BODY, x, y, 3, ROCKET)
          } else {
            // Ядро летит по дуге: чем выше, тем крупнее и тем дальше от своей тени на земле.
            const lift = shellLift(shot, alpha)
            dot(solid, x, y, 4, SHELL, 0.35)
            dot(solid, x, y - lift, 5 + lift * 2, SHELL)
            dot(solid, x - point, y - lift - point, 2, ROCKET)
          }
        }

        // Работа ремонтников: луч от того, кто строит или чинит, к тому, что он строит или чинит; у разбора луч красный.
        for (const link of repairs) {
          const { fromX, fromY, toX, toY } = beamOf(link, alpha)
          if (!visible(fromX, fromY) && !visible(toX, toY)) continue
          const color = link.demolish ? WRECK : MEND
          const seed = link.from * 31 + link.to
          const flicker = 0.55 + 0.45 * noise(seed, Math.floor(time * WELD_RATE * 2))
          line(glow, fromX, fromY, toX, toY, 4, color, 0.35 * flicker)
          line(glow, fromX, fromY, toX, toY, 1.5, color, flicker)
          dot(glow, fromX, fromY, 4, color, 0.8)
          dot(glow, toX, toY, 7, color, flicker)
          dot(glow, toX, toY, 3, CORE, flicker)
          // Искры разлетаются от места работы и гаснут; каждая вспышка — в новые стороны.
          const beat = time * WELD_RATE
          const phase = beat - Math.floor(beat)
          for (let i = 0; i < WELD_SPARKS; i++) {
            const angle = noise(seed + i * 7, Math.floor(beat)) * Math.PI * 2
            const reach = WELD_SPREAD * (0.4 + 0.6 * noise(seed + i * 13, Math.floor(beat))) * phase
            // Искра падает: чем дальше улетела, тем ниже.
            dot(glow, toX + Math.cos(angle) * reach, toY + Math.sin(angle) * reach + reach * phase * 0.6, 2, i % 2 ? CORE : color, 1 - phase)
          }
        }

        // Транспортный луч: бирюзовая полоса, по которой груз бежит от того, кто отдаёт, к тому, кто забирает.
        for (const [entity, beam] of world.query(Beam)) for (const link of beam.links) {
          const ends = tractorOf(entity, link.target as Entity, link.pulling, alpha)
          if (!ends) continue
          const { fromX, fromY, toX, toY } = ends
          if (!visible(fromX, fromY) && !visible(toX, toY)) continue
          const shimmer = 0.75 + 0.25 * Math.sin(time * 9 + entity + link.target)
          line(glow, fromX, fromY, toX, toY, 7, TRACTOR, 0.18 * shimmer)
          line(glow, fromX, fromY, toX, toY, 2, TRACTOR, 0.55 * shimmer)
          dot(glow, fromX, fromY, 6, TRACTOR, 0.7)
          dot(glow, toX, toY, 6, TRACTOR, 0.7)
          const length = Math.hypot(toX - fromX, toY - fromY)
          const CARGO = cargoColor(RESOURCE_COLORS[link.resource])
          const count = Math.floor(length / CARGO_STEP)
          const shift = ((time * CARGO_SPEED) / CARGO_STEP) % 1
          for (let i = 0; i < count; i++) {
            const share = ((i + shift) * CARGO_STEP) / length
            // У концов груз проявляется и тает.
            const level = Math.min(1, share * 4, (1 - share) * 4)
            dot(solid, fromX + (toX - fromX) * share, fromY + (toY - fromY) * share, 3, CARGO, level)
            dot(glow, fromX + (toX - fromX) * share, fromY + (toY - fromY) * share, 2, CARGO, level * 0.6)
          }
        }

        // Полоски прочности над повреждёнными юнитами — своими и чужими.
        for (const [, { value: health }, unit, position] of world.query(Health, Unit, Position)) {
          if (health >= 1 || !visible(position.x, position.y)) continue
          const { x, y } = drawnPosition(position, unit, alpha)
          const { radius } = UNITS[unit.type]
          const half = radius + 0.1
          // Летающий нарисован над землёй там же, где стоит, поэтому полоска на том же месте.
          const top = y - radius - BAR_GAP - (flies(unit.type) ? 0.1 : 0)
          strip(solid, x - half - pixel, top, x + half + pixel, top, (BAR_HEIGHT + 2) * pixel, BAR_BACK)
          strip(solid, x - half, top, x - half + half * 2 * Math.max(0, health), top, BAR_HEIGHT * pixel, health > 0.5 ? BAR_GOOD : BAR_BAD)
        }

        if (smoke.count || blasts.count) {
          setBlend(gl, 'alpha')
          spriteProgram.use(view, { uTexture: atlas.texture })
          smoke.draw()
          blasts.draw()
        }
        if (solid.count || glow.count) {
          lineProgram.use(view)
          setBlend(gl, 'alpha')
          solid.draw()
          setBlend(gl, 'add')
          glow.draw()
        }
      },
      destroy() {
        blasts.destroy()
        glow.destroy()
        solid.destroy()
        spriteProgram.destroy()
        lineProgram.destroy()
        atlas.texture.destroy()
      },
    },
  }
}
