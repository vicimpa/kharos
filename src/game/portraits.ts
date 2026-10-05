import { Pixmap } from '../render/pixmap'
import { buildingSpec, unitSpec, type BuildingType, type MountSpec, type UnitType } from '../sim'
import { ART_TILE, BUILDING_ART } from './buildings/buildingArt'
import { TEAMS, TURRET_ART, UNIT_ART, UNIT_FRAME, type Team } from './units/unitArt'

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
