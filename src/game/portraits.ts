import { Pixmap } from '../render/pixmap'
import { buildingSpec, unitSpec, type BuildingType, type MountSpec, type UnitType } from '../sim'
import { ART_TILE, BUILDING_ART } from './buildings/buildingArt'
import { TEAMS, TURRET_ART, UNIT_ART, UNIT_FRAME, type Team } from './units/unitArt'
import { PAVE_ART } from './pavingPass'

/** Юнит на портрете смотрит вправо-вверх: так видно и бок, и башню. */
const ANGLE = -Math.PI / 4
/** Поле вокруг здания на портрете, в пикселях чертежа. */
const PAD = 2

/** Башни на корпусе: у юнита — под его углом, у турели — на месте. */
function drawMounts(image: Pixmap, mounts: MountSpec[] | undefined, angle: number, team: Team = 'own') {
  for (const mount of mounts ?? []) {
    const x = (Math.cos(angle) * mount.along - Math.sin(angle) * mount.across) * 16
    const y = (Math.sin(angle) * mount.along + Math.cos(angle) * mount.across) * 16
    image.originX += x
    image.originY += y
    TURRET_ART[mount.turret](image, angle, TEAMS[team], 0)
    image.originX -= x
    image.originY -= y
  }
}

/** Пиксмап в адрес картинки для <img>. */
function toUrl(image: Pixmap) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')!
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
  return canvas.toDataURL()
}

const cache = new Map<string, string>()

/** Портрет юнита для панели выбранного: тот же спрайт, что на карте, в цветах стороны. Рисуется один раз. */
export function unitPortrait(type: UnitType, team: Team = 'own') {
  const key = `unit:${team}:${type}`
  let url = cache.get(key)
  if (!url) {
    const image = new Pixmap(UNIT_FRAME, UNIT_FRAME)
    image.originX = image.originY = UNIT_FRAME / 2
    UNIT_ART[type](image, ANGLE, TEAMS[team], 0)
    drawMounts(image, unitSpec(type).mounts, ANGLE, team)
    cache.set(key, (url = toUrl(image)))
  }
  return url
}

/** Портрет здания: первый кадр его анимации. */
export function buildingPortrait(type: BuildingType) {
  const key = `building:${type}`
  let url = cache.get(key)
  if (!url) {
    const art = BUILDING_ART[type]
    const image = new Pixmap(art.width * ART_TILE + PAD * 2, art.height * ART_TILE + PAD * 2)
    image.originX = image.originY = PAD
    art.draw(image, 0, () => {}, 0, true)
    const { mounts } = buildingSpec(type)
    if (mounts) {
      image.originX += (art.width * ART_TILE) / 2
      image.originY += (art.height * ART_TILE) / 2
      drawMounts(image, mounts, ANGLE)
    }
    cache.set(key, (url = toUrl(image)))
  }
  return url
}

/** Значок покрытия: как оно выглядит на карте. Снятие — фундамент с красным крестом. */
export type PaveIcon = 'foundation' | 'road' | 'bridge' | 'remove'

/** Плитки значка покрытия: вид и набор соседей каждой, рядами сверху вниз. */
const PAVE_TILES: Record<PaveIcon, ['foundation' | 'road' | 'bridge', number][][]> = {
  // Площадка 2×2: у каждой плитки соседи — две другие. Биты соседей: сверху 1, справа 2, снизу 4, слева 8.
  foundation: [[['foundation', 6], ['foundation', 12]], [['foundation', 3], ['foundation', 9]]],
  remove: [[['foundation', 6], ['foundation', 12]], [['foundation', 3], ['foundation', 9]]],
  road: [[['road', 2], ['road', 8]]],
  bridge: [[['bridge', 2], ['bridge', 8]]],
}

/** Значок покрытия для сетки команд. Рисуется один раз. */
export function pavePortrait(icon: PaveIcon) {
  const key = `pave:${icon}`
  let url = cache.get(key)
  if (!url) {
    const rows = PAVE_TILES[icon]
    const image = new Pixmap(32, 32)
    // Полоса дороги — посередине по высоте.
    const top = (32 - rows.length * 16) / 2
    rows.forEach((row, y) =>
      row.forEach(([look, mask], x) => {
        const tile = PAVE_ART[look](mask)
        for (let py = 0; py < 16; py++) {
          for (let px = 0; px < 16; px++) {
            const from = (py * 16 + px) * 4
            if (!tile.data[from + 3]) continue
            const to = ((top + y * 16 + py) * 32 + x * 16 + px) * 4
            image.data.set(tile.data.subarray(from, from + 4), to)
          }
        }
      }),
    )
    if (icon === 'remove') {
      image.line(7, 7, 25, 25, 4, 0x1a0806)
      image.line(25, 7, 7, 25, 4, 0x1a0806)
      image.line(7, 7, 25, 25, 2, 0xe0402c)
      image.line(25, 7, 7, 25, 2, 0xe0402c)
    }
    cache.set(key, (url = toUrl(image)))
  }
  return url
}
