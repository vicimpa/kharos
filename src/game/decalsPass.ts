import { createProgram, createQuads, setBlend } from '../gl'
import { Terrain, terrainAt } from '../map/terrain'
import { createAtlas, type AtlasFrame } from '../render/atlas'
import { Pixmap } from '../render/pixmap'
import type { Pass } from '../render/renderer'
import { TURN, UNIT_TYPES, unitSpec, type UnitType } from '../sim'
import { TRACE_LIFE } from '../sim/traces'
import type { Scene } from './scene'
import { TEAMS, TURRET_ART, UNIT_ART, UNIT_FRAME, UNIT_GAITS, UNIT_TRACES } from './units/unitArt'

/** Через сколько тайлов пути пехотинец оставляет отпечаток ступни. */
const STEP_LENGTH = 0.3
/** Длина отпечатка ступни в тайлах. */
const FOOTPRINT = 0.1

/** С какой доли срока следы растворяются: пиксель за пикселем, каждый в свой случайный момент. Сроки — TRACE_LIFE. */
const FADE_FROM = 0.25
/** Точки пути одного юнита дальше этого друг от друга — не шаг, а скачок: колея между ними не тянется. */
const TRACK_LINK = 1.5
/** Больше разом не бывает: самые старые уступают место новым. */
const TRACE_LIMIT = 12000
const MARK_LIMIT = 3000
const WRECK_LIMIT = 800

/** Колея — тень вдавленного грунта; на скале она почти не видна, на болоте и горах её нет. */
const TRACE_COLOR = [0.16, 0.11, 0.06] as const
const TRACE_OPACITY: Record<Terrain, number> = {
  [Terrain.Sand]: 0.4,
  [Terrain.Rock]: 0.18,
  [Terrain.Swamp]: 0,
  [Terrain.Mountain]: 0,
}
/** Какая доля пикселей колеи закрашена: колея зернистая, как продавленный песок. */
const TRACE_DENSITY = 0.8
/** Насколько плотны гарь и остовы: гарь просвечивает грунтом, остов непрозрачен. */
const MARK_OPACITY = 0.7

/** Отметины: поперечники гари в пикселях — по одной картинке каждого размера на вариант — и сколько вариантов. */
const SCORCH_SIZES = [8, 16, 24, 32, 40, 48]
const VARIANTS = 3
/** Поперечник гари в тайлах на тайл размера взрыва. */
const SCORCH_SCALE = 1.5
/** Взрыв меньше этого — попадание пули: от неё остаются щербинки, а не гарь. */
const POCK_SIZE = 0.3
/** Направлений у картинок остовов. */
const WRECK_DIRECTIONS = 16

/** Простое воспроизводимое случайное число от 0 до 1 по трём целым. */
function noise(a: number, b: number, c = 0) {
  const value = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return value - Math.floor(value)
}

/** Гарь: тёмная сердцевина и рваный край, который к краю редеет — пиксели гари мешаются с грунтом. */
function drawScorch(size: number, variant: number) {
  const image = new Pixmap(size, size)
  const center = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center
      const dy = y + 0.5 - center
      // Край неровный: радиус гуляет по углу.
      const angle = Math.atan2(dy, dx)
      const wobble = 0.86 + 0.07 * Math.sin(angle * 3 + variant * 2.1) + 0.05 * Math.sin(angle * 5 + variant * 4.3) + 0.04 * Math.sin(angle * 11 + variant)
      const reach = Math.hypot(dx, dy) / (center * wobble)
      const grain = noise(x, y, variant + size)
      if (reach > 1 || grain > (1 - reach) * 2.2) continue
      const color = reach < 0.45 ? (grain < 0.3 ? 0x0c0a09 : 0x15110e) : grain < 0.5 ? 0x231b14 : 0x30251b
      image.rect(x - image.originX, y - image.originY, 1, 1, color)
    }
  }
  return image
}

/** Щербинки от пуль: несколько тёмных пикселей вразброс. */
function drawPock(variant: number) {
  const image = new Pixmap(6, 6)
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(1 + noise(i, variant, 3) * 4)
    const y = Math.floor(1 + noise(i, variant, 5) * 4)
    image.rect(x, y, 1, 1, i ? 0x241c15 : 0x120e0b)
  }
  return image
}

/**
 * Остов: юнит, нарисованный как обычно, обгорает до угля с ржавчиной и копотью, а края его обломаны.
 * Турели лежат на своих местах, повёрнутые как попало.
 */
function drawWreck(type: UnitType, direction: number, variant: number) {
  const image = new Pixmap(UNIT_FRAME, UNIT_FRAME)
  image.originX = image.originY = UNIT_FRAME / 2
  const angle = (direction / WRECK_DIRECTIONS) * TURN
  UNIT_ART[type](image, angle, TEAMS.foe, 0)
  for (const [i, mount] of (unitSpec(type).mounts ?? []).entries()) {
    // Стрелок багги не обгорает в остов.
    if (mount.turret === 'gunner') continue
    const x = (Math.cos(angle) * mount.along - Math.sin(angle) * mount.across) * 16
    const y = (Math.sin(angle) * mount.along + Math.cos(angle) * mount.across) * 16
    image.originX += x
    image.originY += y
    TURRET_ART[mount.turret](image, angle + (noise(i, variant, 9) - 0.5) * 2.5, TEAMS.foe, 0)
    image.originX -= x
    image.originY -= y
  }
  const { data, width, height } = image
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] > 0
  const edge: boolean[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) edge.push(solid(x, y) && (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)))
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      if (!data[at + 3]) continue
      const grain = noise(x, y, variant * 31 + direction)
      if (edge[y * width + x] && grain < 0.25) {
        data[at + 3] = 0
        continue
      }
      // Светлое обгорает до серого угля, тёмное — до чёрного; кое-где ржавчина и копоть.
      const light = (data[at] + data[at + 1] + data[at + 2]) / (3 * 255)
      let [r, g, b] = [0x22 + light * 0x58, 0x1e + light * 0x4c, 0x1a + light * 0x40]
      // Пятна ржавчины и копоти — крупные, по три пикселя: мелкая рябь съела бы силуэт.
      const spot = noise(Math.floor(x / 3), Math.floor(y / 3), variant + direction * 7)
      if (spot > 0.9) [r, g, b] = [0x6a, 0x3c, 0x22]
      else if (spot < 0.1) [r, g, b] = [0x10, 0x0d, 0x0b]
      data[at] = r
      data[at + 1] = g
      data[at + 2] = b
    }
  }
  return image
}

const VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aLine;
in float aWidth;
in vec4 aFrame;
in vec4 aTint;
in vec3 aFade;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform vec2 uCameraPixels;
out vec2 vLocal;
out vec2 vWorld;
out vec4 vFrame;
out vec4 vTint;
out vec3 vFade;

void main() {
  vec2 span = aLine.zw - aLine.xy;
  float size = max(length(span), 1e-4);
  vec2 along = span / size;
  vec2 across = vec2(-along.y, along.x);
  // Четырёхугольник шире на пиксель мира с каждой стороны: пиксель, чей центр внутри, закрашивается целиком.
  float pad = 1.0 / 16.0;
  vec2 local = vec2(mix(-pad / size, 1.0 + pad / size, aCorner.x), mix(-pad / aWidth, 1.0 + pad / aWidth, aCorner.y));
  vec2 tile = aLine.xy + span * local.x + across * (local.y - 0.5) * aWidth;
  vLocal = local;
  vWorld = tile * 16.0 + uCameraPixels;
  vFrame = aFrame;
  vTint = aTint;
  vFade = aFade;
  tile += uOffset;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
in vec4 vFrame;
in vec4 vTint;
in vec3 vFade;
uniform sampler2D uTexture;
out vec4 finalColor;

/** Случайное число от 0 до 1 для пикселя мира и зерна: у каждого следа пиксели гаснут в свой черёд. */
float grain(vec2 cell, float seed) {
  vec3 p = fract(vec3(cell.xyx + seed) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  // Всё решается для пикселя мира целиком, по его центру: и повёрнутая колея остаётся пиксель-артом.
  vec2 cell = floor(vWorld);
  mat2 toLocal = mat2(dFdx(vLocal), dFdy(vLocal)) * inverse(mat2(dFdx(vWorld), dFdy(vWorld)));
  vec2 local = vLocal + toLocal * (cell + 0.5 - vWorld);
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) discard;
  vec4 texel = texture(uTexture, vFrame.xy + local * vFrame.zw);
  if (texel.a < 0.5) discard;
  // Дизеринг шумом: доля закрашенных пикселей — плотность, умноженная на то, сколько осталось до исчезновения.
  // Ступеней у него нет, и узор неправильный, как зерно песка.
  if (vFade.x * vFade.y <= grain(cell, vFade.z)) discard;
  finalColor = vec4(texel.rgb * vTint.rgb, 1.0) * vTint.a;
}
`

/**
 * Что лежит на земле: отрезок в тайлах мира, ширина в тайлах, кадр атласа, цвет и непрозрачность, плотность
 * пикселей, возраст и срок в секундах.
 */
/** Точка пути юнита, как её прислал хост. foot — какой ногой пехотинец шагнёт от неё. */
interface TrackPoint {
  tick: number
  x: number
  y: number
  facing: number
  type: UnitType
  foot: number
}

interface Decal {
  fromX: number
  fromY: number
  toX: number
  toY: number
  width: number
  frame: AtlasFrame
  color: readonly [number, number, number]
  opacity: number
  density: number
  /** Зерно шума, по которому растворяется след. */
  seed: number
  age: number
  life: number
}

const WHITE = [1, 1, 1] as const

/**
 * Проход следов на земле: колеи от колёс и гусениц, отпечатки ног, гарь от взрывов, щербинки от пуль и остовы
 * погибшей техники. Всё это живёт только на экране, в симуляции его нет, и со временем растворяется. Ставится
 * над землёй и под юнитами, до освещения: ночью следы темнеют вместе с землёй.
 */
export function createDecalsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const white = new Pixmap(1, 1).rect(0, 0, 1, 1, 0xffffff)
  const scorches = SCORCH_SIZES.flatMap((size) => Array.from({ length: VARIANTS }, (_, variant) => drawScorch(size, variant)))
  const pocks = Array.from({ length: VARIANTS }, (_, variant) => drawPock(variant))
  const wrecks = UNIT_TYPES.flatMap((type) => Array.from({ length: WRECK_DIRECTIONS }, (_, direction) => drawWreck(type, direction, direction % VARIANTS)))
  const atlas = createAtlas(gl, [white, ...scorches, ...pocks, ...wrecks])
  // Колея берёт цвет из середины белого пикселя, чтобы не задеть соседей по атласу.
  const white0 = atlas.frames[0]
  const whiteFrame: AtlasFrame = { u: white0.u + white0.width / 2, v: white0.v + white0.height / 2, width: 0, height: 0 }
  /** Гарь size-го размера из SCORCH_SIZES. */
  const scorchFrame = (size: number, variant: number) => atlas.frames[1 + size * VARIANTS + variant]
  const pockFrame = (variant: number) => atlas.frames[1 + scorches.length + variant]
  const wreckFrame = (type: UnitType, direction: number) =>
    atlas.frames[1 + scorches.length + pocks.length + UNIT_TYPES.indexOf(type) * WRECK_DIRECTIONS + direction]

  const program = createProgram(gl, VERTEX, FRAGMENT)
  const quads = createQuads(gl, program, { aLine: 4, aWidth: 1, aFrame: 4, aTint: 4, aFade: 3 })
  const cameraPixels = new Float32Array(2)

  let watched = scene.sim
  const traces: Decal[] = []
  const marks: Decal[] = []
  const remains: Decal[] = []
  /** Возраст следа, который сейчас разбирается: он мог быть оставлен задолго до того, как его увидели. */
  let age = 0
  const add = (list: Decal[], limit: number, decal: Omit<Decal, 'age' | 'seed'>) => {
    if (decal.opacity <= 0 || age >= decal.life) return
    if (list.length >= limit) list.shift()
    list.push({ ...decal, age, seed: Math.random() * 1000 })
  }
  /** Картинка size × size пикселей с серединой в (x, y), ровно по сетке пикселей мира. */
  const stamp = (list: Decal[], limit: number, x: number, y: number, size: number, frame: AtlasFrame, opacity: number, life: number) => {
    const left = Math.round((x - size / 32) * 16) / 16
    const top = Math.round((y - size / 32) * 16) / 16
    const half = size / 32
    add(list, limit, {
      fromX: left, fromY: top + half, toX: left + size / 16, toY: top + half, width: size / 16, frame, color: WHITE, opacity, density: 1, life,
    })
  }
  const onGround = (x: number, y: number) => {
    const terrain = terrainAt(scene.sim.land, Math.floor(x), Math.floor(y))
    return terrain !== Terrain.Swamp
  }

  /** Отметина от взрыва размера size: гарь, а от пули — щербинки. */
  const scar = (x: number, y: number, size: number, variant: number) => {
    if (!onGround(x, y)) return
    if (size < POCK_SIZE) {
      stamp(marks, MARK_LIMIT, x, y, 6, pockFrame(variant), MARK_OPACITY, TRACE_LIFE.scar)
      return
    }
    const pixels = size * SCORCH_SCALE * 16
    let index = 0
    for (let i = 1; i < SCORCH_SIZES.length; i++) if (Math.abs(SCORCH_SIZES[i] - pixels) < Math.abs(SCORCH_SIZES[index] - pixels)) index = i
    stamp(marks, MARK_LIMIT, x, y, SCORCH_SIZES[index], scorchFrame(index, variant), MARK_OPACITY, TRACE_LIFE.scar)
  }

  const opacityAt = (x: number, y: number) => TRACE_OPACITY[terrainAt(scene.sim.land, Math.floor(x), Math.floor(y))]

  /** Колея или шаги от точки пути from до to одного юнита. */
  const walk = (from: TrackPoint, to: TrackPoint) => {
    const trace = UNIT_TRACES[to.type]
    if (!trace) return
    const base = { width: trace.width / 16, frame: whiteFrame, color: TRACE_COLOR, density: TRACE_DENSITY, life: TRACE_LIFE.track }
    const endsOf = (point: TrackPoint) => {
      const acrossX = -Math.sin(point.facing) / 16
      const acrossY = Math.cos(point.facing) / 16
      return trace.sides.map((side) => ({ x: point.x + acrossX * side, y: point.y + acrossY * side }))
    }
    const ends = endsOf(to)
    if (UNIT_GAITS[to.type] !== 'legs') {
      endsOf(from).forEach((start, i) => {
        const end = ends[i]
        add(traces, TRACE_LIMIT, { ...base, fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, opacity: opacityAt(end.x, end.y) })
      })
      return
    }
    // Ноги шагают по очереди: отпечатки ступней вдоль хода, через полшага, то одной, то другой.
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const alongX = (Math.cos(to.facing) * FOOTPRINT) / 2
    const alongY = (Math.sin(to.facing) * FOOTPRINT) / 2
    const acrossX = -Math.sin(to.facing) / 16
    const acrossY = Math.cos(to.facing) / 16
    for (let step = 0; step * (STEP_LENGTH / 2) < length; step++) {
      const share = (step * (STEP_LENGTH / 2)) / length
      const side = trace.sides[(from.foot + step) % trace.sides.length]
      const x = from.x + (to.x - from.x) * share + acrossX * side
      const y = from.y + (to.y - from.y) * share + acrossY * side
      add(traces, TRACE_LIMIT, { ...base, fromX: x - alongX, fromY: y - alongY, toX: x + alongX, toY: y + alongY, opacity: opacityAt(x, y) })
      to.foot = from.foot + step + 1
    }
  }

  /** Точки пути каждого юнита, по времени: новая точка соединяется с соседними по времени, если те рядом. */
  const paths = new Map<number, TrackPoint[]>()
  let cursor = 0

  /** Разбирает следы, пришедшие с прошлого кадра. */
  const consume = () => {
    const { sim } = scene
    const found = sim.traces.since(cursor)
    cursor = found.cursor
    for (const trace of found.traces) {
      age = (sim.time.tick - trace.tick) * sim.time.step
      const variant = trace.id % VARIANTS
      if (trace.kind === 'scar') scar(trace.x, trace.y, trace.size, variant)
      else if (trace.kind === 'burn') {
        if (onGround(trace.x, trace.y)) stamp(marks, MARK_LIMIT, trace.x, trace.y, 8, scorchFrame(0, variant), MARK_OPACITY, TRACE_LIFE.burn)
      } else if (trace.kind === 'wreck') {
        const direction = ((Math.round((trace.facing / TURN) * WRECK_DIRECTIONS) % WRECK_DIRECTIONS) + WRECK_DIRECTIONS) % WRECK_DIRECTIONS
        stamp(remains, WRECK_LIMIT, trace.x, trace.y, UNIT_FRAME, wreckFrame(trace.type, direction), 1, TRACE_LIFE.wreck)
      } else {
        const point: TrackPoint = { tick: trace.tick, x: trace.x, y: trace.y, facing: trace.facing, type: trace.type, foot: 0 }
        let path = paths.get(trace.entity)
        if (!path) paths.set(trace.entity, (path = []))
        let at = path.length
        while (at > 0 && path[at - 1].tick > point.tick) at--
        const before = path[at - 1]
        const after = path[at]
        path.splice(at, 0, point)
        if (before && Math.hypot(point.x - before.x, point.y - before.y) <= TRACK_LINK) walk(before, point)
        if (after && Math.hypot(after.x - point.x, after.y - point.y) <= TRACK_LINK) walk(point, after)
      }
    }
    age = 0
    // Точки, чей след уже растворился, больше ни с чем не соединятся.
    const oldest = sim.time.tick - TRACE_LIFE.track / sim.time.step
    for (const [entity, path] of paths) {
      let drop = 0
      while (drop < path.length && path[drop].tick < oldest) drop++
      if (drop === path.length) paths.delete(entity)
      else if (drop) path.splice(0, drop)
    }
  }

  return {
    draw({ camera, width, height, delta, view }) {
      const halfWidth = width / 2 / camera.zoom + 2
      const halfHeight = height / 2 / camera.zoom + 2
      if (scene.sim !== watched) {
        // Мир начали заново: прежние следы — из другого мира.
        watched = scene.sim
        cursor = 0
        paths.clear()
        traces.length = marks.length = remains.length = 0
      }
      consume()
      const { vision } = scene.sim
      quads.clear()
      // Снизу вверх: колеи, отметины, остовы.
      for (const list of [traces, marks, remains]) {
        let kept = 0
        for (const decal of list) {
          decal.age += delta
          if (decal.age >= decal.life) continue
          list[kept++] = decal
          if (Math.abs(decal.toX - camera.x) > halfWidth || Math.abs(decal.toY - camera.y) > halfHeight) continue
          // След виден только в обзоре: ушли свои — в тумане его не разглядеть, даже на разведанном.
          if (!vision.sees(scene.player, decal.toX, decal.toY)) continue
          const share = Math.max(0, (decal.age / decal.life - FADE_FROM) / (1 - FADE_FROM))
          const left = 1 - share * share * (3 - 2 * share)
          const { u, v, width: frameWidth, height: frameHeight } = decal.frame
          const [r, g, b] = decal.color
          quads.push(
            decal.fromX - camera.x, decal.fromY - camera.y, decal.toX - camera.x, decal.toY - camera.y, decal.width,
            u, v, frameWidth, frameHeight, r, g, b, decal.opacity, left, decal.density, decal.seed,
          )
        }
        list.length = kept
      }
      if (!quads.count) return
      // Шум дизеринга привязан к пикселям мира, а не экрана: при прокрутке он не плывёт.
      cameraPixels[0] = camera.x * 16
      cameraPixels[1] = camera.y * 16
      setBlend(gl, 'alpha')
      program.use(view, { uTexture: atlas.texture, uCameraPixels: cameraPixels })
      quads.draw()
    },
    destroy() {
      quads.destroy()
      program.destroy()
      atlas.texture.destroy()
    },
  }
}
