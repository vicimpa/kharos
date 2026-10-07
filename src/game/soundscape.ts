import type { Audio } from '../audio/audio'
import type { SoundName } from '../audio/synth'
import type { Entity } from '../ecs'
import { Blast, Position, Shot, type WeaponType } from '../sim'
import type { Scene } from './scene'
import type { createShake } from './shake'

/** Какой звук у выстрела каждого оружия и насколько он громок. */
const SHOT_SOUNDS: Record<WeaponType, { name: SoundName; volume: number }> = {
  rifle: { name: 'rifle', volume: 0.35 },
  machinegun: { name: 'machinegun', volume: 0.25 },
  cannon: { name: 'cannon', volume: 0.8 },
  artillery: { name: 'cannon', volume: 1 },
  bomb: { name: 'launcher', volume: 0.5 },
  launcher: { name: 'launcher', volume: 0.45 },
  laser: { name: 'laser', volume: 0.35 },
  arc: { name: 'arc', volume: 0.5 },
  flame: { name: 'arc', volume: 0.3 },
  flak: { name: 'machinegun', volume: 0.4 },
  coreGun: { name: 'laser', volume: 0.6 },
}
/** Взрывы: меньше SMALL_BLAST — попадание пули, оно не звучит; от BIG_BLAST — гибель техники или здания. */
const SMALL_BLAST = 0.3
const BIG_BLAST = 1.3
/** Громкость взрыва: base и сколько добавляет каждый тайл его размера. Взрывы громче выстрелов — выше единицы. */
const BLAST_VOLUME = 1
const BLAST_VOLUME_PER_SIZE = 0.6
/** Тряска от взрыва на тайл его размера и самая сильная от одного взрыва; выстрел пушки — как взрыв такого размера. */
const BLAST_SHAKE = 0.3
const MAX_BLAST_SHAKE = 0.8
const CANNON_SHAKE_SIZE = 0.3
/**
 * Докуда достаёт тряска от взрыва, в тайлах от середины экрана: SHAKE_REACH и ещё SHAKE_REACH_PER_SIZE на тайл
 * размера — большой взрыв чувствуется дальше. К краю досягаемости тряска слабеет как квадрат.
 */
const SHAKE_REACH = 6
const SHAKE_REACH_PER_SIZE = 8
/** Чаще этого, в секундах, один и тот же звук не повторяется: сотня винтовок звучит как одна очередь, а не как гул. */
const MIN_GAP: Partial<Record<SoundName, number>> = {
  rifle: 0.04, machinegun: 0.035, cannon: 0.08, launcher: 0.06, laser: 0.06, arc: 0.08, blast: 0.05, bigBlast: 0.1,
}
/** За краем экрана звук стихает на этом расстоянии, в долях полуширины экрана. */
const HEARING = 0.8
/** Издалека слышно тише: при таком масштабе (пикселей на тайл) громкость полная, при вдвое меньшем — вдвое тише. */
const NEAR_ZOOM = 32

/**
 * Звуки боя. Раз в кадр смотрит, какие выстрелы и взрывы появились в мире, и даёт им голос: громкость — по тому,
 * насколько они далеко от середины экрана, сторона — по тому, левее они или правее. Взрывы и выстрелы пушек
 * ещё и трясут камеру: тем сильнее, чем взрыв больше и ближе к середине экрана, а на экране — чем крупнее зум.
 */
export function createSoundscape(scene: Scene, audio: Audio, shake: ReturnType<typeof createShake>) {
  let shots = new Map<Entity, number>()
  let blasts = new Map<Entity, number>()
  const last = new Map<SoundName, number>()
  let clock = 0

  /** Насколько слышно то, что случилось в (x, y): 1 — на экране вблизи, 0 — далеко за краем или с большой высоты. */
  const nearness = (x: number, y: number) => {
    const { camera } = scene
    const halfWidth = camera.width / 2 / camera.zoom
    const halfHeight = camera.height / 2 / camera.zoom
    // За краем экрана — тише и тише, пока не стихнет.
    const outside = Math.max(0, Math.abs(x - camera.x) - halfWidth, Math.abs(y - camera.y) - halfHeight)
    return Math.max(0, 1 - outside / (halfWidth * HEARING)) * Math.min(1, camera.zoom / NEAR_ZOOM)
  }

  /** Толчок от взрыва размера size в (x, y): чем больше и ближе к середине экрана, тем сильнее. */
  const jolt = (size: number, x: number, y: number) => {
    const distance = Math.hypot(x - scene.camera.x, y - scene.camera.y)
    const near = Math.max(0, 1 - distance / (SHAKE_REACH + size * SHAKE_REACH_PER_SIZE))
    shake.add(Math.min(MAX_BLAST_SHAKE, size * BLAST_SHAKE) * near * near)
  }

  const play = (name: SoundName, volume: number, x: number, y: number) => {
    const { camera } = scene
    const level = volume * nearness(x, y)
    if (level <= 0.01 || clock - (last.get(name) ?? -Infinity) < (MIN_GAP[name] ?? 0)) return
    last.set(name, clock)
    audio.play(name, level, ((x - camera.x) / (camera.width / 2 / camera.zoom)) * 0.8)
  }

  return {
    update(seconds: number) {
      clock += seconds
      const { world } = scene.sim
      // Новое — то, чего не было в прошлом кадре, или что моложе прежнего с тем же номером.
      const nextShots = new Map<Entity, number>()
      for (const [entity, shot] of world.query(Shot)) {
        const age = shots.get(entity)
        nextShots.set(entity, shot.age)
        // Перескоки разряда — те же выстрелы в тот же миг: их глушит MIN_GAP.
        if (age !== undefined && shot.age >= age) continue
        const sound = SHOT_SOUNDS[shot.weapon]
        play(sound.name, sound.volume, shot.fromX, shot.fromY)
        if (shot.weapon === 'cannon') jolt(CANNON_SHAKE_SIZE, shot.fromX, shot.fromY)
      }
      shots = nextShots

      const nextBlasts = new Map<Entity, number>()
      for (const [entity, blast, position] of world.query(Blast, Position)) {
        const age = blasts.get(entity)
        nextBlasts.set(entity, blast.age)
        if ((age !== undefined && blast.age >= age) || blast.size < SMALL_BLAST) continue
        const big = blast.size >= BIG_BLAST
        play(big ? 'bigBlast' : 'blast', BLAST_VOLUME + blast.size * BLAST_VOLUME_PER_SIZE, position.x, position.y)
        jolt(blast.size, position.x, position.y)
      }
      blasts = nextBlasts
    },
  }
}
