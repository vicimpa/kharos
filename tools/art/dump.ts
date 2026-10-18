/**
 * Кадры чертежей TS сырыми RGBA — образец для переноса графики в моды (apps/client, `cargo run --example looks`).
 *
 *   bun tools/art/dump.ts <файл> раздел/вид…
 *
 * Виды: units/<тип> (фазы хода × 64 направления), turrets/<тип> (64), buildings/<тип> (фазы — 16 кадров простоя и,
 * если здание работает, ещё 16 кадров работы; направления — варианты соседства), sprites/<картинка> (взрыв и дым —
 * combatSprites, гарь, щербинки и остовы — decalsSprites; картинка меньше кадра мода — посреди него). Порядок кадров — как у облика в
 * моде: фаза за фазой, внутри — направления. Рядом, в <файл>.json, — сколько кадров у каждого вида и их размер.
 */
import { Pixmap } from '../../packages/client/src/render/pixmap'
import { MASK_TEAM, TURRET_ART, UNIT_ART, UNIT_FRAME, UNIT_GAITS } from '../../packages/client/src/game/units/unitArt'
import { ART_FRAMES, ART_TILE, BUILDING_ART } from '../../packages/client/src/game/buildings/buildingArt'
import { combatSprites } from '../../packages/client/src/game/combatPass'
import { decalsSprites } from '../../packages/client/src/game/decalsPass'

const TURN = Math.PI * 2
const DIRECTIONS = 64
const PHASES = 4
const PAD = 16
const [file, ...kinds] = process.argv.slice(2)
if (!file) throw new Error('bun tools/art/dump.ts <файл> раздел/вид…')

const out: Uint8Array[] = []
const sizes: { kind: string; frames: number; bytes: number }[] = []
for (const kind of kinds) {
  const [section, name] = kind.split('/')
  const before = out.length
  let bytes = 0
  if (section === 'units' || section === 'turrets') {
    const art = section === 'units' ? UNIT_ART[name as keyof typeof UNIT_ART] : TURRET_ART[name as keyof typeof TURRET_ART]
    if (!art) throw new Error(`нет чертежа ${kind}`)
    const phases = section === 'units' && UNIT_GAITS[name as keyof typeof UNIT_GAITS] !== 'air' ? PHASES : 1
    for (let phase = 0; phase < phases; phase++) {
      for (let direction = 0; direction < DIRECTIONS; direction++) {
        const image = new Pixmap(UNIT_FRAME, UNIT_FRAME)
        image.originX = image.originY = UNIT_FRAME / 2
        art(image, (direction / DIRECTIONS) * TURN, MASK_TEAM, phase)
        out.push(image.data)
        bytes = image.data.length
      }
    }
  } else if (section === 'buildings') {
    const art = BUILDING_ART[name as keyof typeof BUILDING_ART]
    if (!art) throw new Error(`нет чертежа ${kind}`)
    const variants = art.variants ?? 1
    const sets = art.working ? 2 : 1
    for (let phase = 0; phase < ART_FRAMES * sets; phase++) {
      for (let variant = 0; variant < variants; variant++) {
        const image = new Pixmap(art.width * ART_TILE + PAD * 2, art.height * ART_TILE + PAD * 2)
        image.originX = image.originY = PAD
        art.draw(image, (phase % ART_FRAMES) / ART_FRAMES, () => {}, variant, phase >= ART_FRAMES)
        out.push(image.data)
        bytes = image.data.length
      }
    }
  } else if (section === 'sprites') {
    // Картинки подачи: какие кадры из наборов TS и сторона кадра мода.
    const combat = combatSprites()
    const decals = decalsSprites()
    const sets: Record<string, [typeof combat, number]> = {
      blast: [combat.slice(0, 8), 48],
      puff: [combat.slice(8, 11), 16],
      scorch: [decals.slice(1, 19), 48],
      pock: [decals.slice(19, 22), 6],
      wreck: [decals.slice(22), 32],
    }
    const set = sets[name]
    if (!set) throw new Error(`нет картинки ${kind}`)
    const [sprites, frame] = set
    for (const sprite of sprites) {
      const own = new Pixmap(sprite.width, sprite.height)
      sprite.draw(own)
      const image = new Pixmap(frame, frame)
      const shift = (frame - sprite.width) / 2
      for (let y = 0; y < sprite.height; y++) image.data.set(own.data.subarray(y * sprite.width * 4, (y + 1) * sprite.width * 4), ((y + shift) * frame + shift) * 4)
      out.push(image.data)
      bytes = image.data.length
    }
  } else throw new Error(`не знаю раздела ${section}`)
  sizes.push({ kind, frames: out.length - before, bytes })
}
await Bun.write(file, Buffer.concat(out))
await Bun.write(`${file}.json`, JSON.stringify(sizes))
