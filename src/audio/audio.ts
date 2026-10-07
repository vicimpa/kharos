import { createAmbience, type Ambience, type Mood } from './ambience'
import { createFlight, type Flight, type Noises } from './flight'
import { DISTANT_NAMES, DISTANT_SOUNDS, SOUNDS, SOUND_NAMES, SOUND_VARIANTS, noiseLoop, reverbImpulse, type DistantName, type NoiseColor, type SoundName } from './synth'

/** Больше звуков разом не звучит: в большом бою остальные пропускаются. */
const MAX_VOICES = 32
/** Общая громкость. */
const MASTER = 0.6
/** На сколько звук случайно выше или ниже: одинаковые выстрелы подряд не звучат как запись. */
const DETUNE = 0.08
/** Сколько секунд длится эхо фона. */
const REVERB_SECONDS = 4
/** Петли шума для ветра: какого цвета и сколько секунд. Короче — слышно, что петля повторяется. */
const NOISE_SECONDS: [NoiseColor, number][] = [
  ['white', 3],
  ['pink', 8],
  ['brown', 8],
]
const STORAGE_KEY = 'kharos.muted'
const VOLUME_KEY = 'kharos.volume'

export interface Audio {
  /** Звучит звук name громкостью volume (0..1) и в стороне pan: -1 — слева, 1 — справа. */
  play(name: SoundName, volume: number, pan: number): void
  /** Раз в кадр: ветер полёта камеры, speed — от 0 (стоит) до 1 (несётся во весь опор). */
  flight(seconds: number, speed: number): void
  /** Раз в кадр: фон мира под погоду и высоту камеры. */
  ambience(seconds: number, mood: Mood): void
  /** Включён ли звук: выбор игрока хранится в браузере. */
  muted: boolean
  /** Громкость от 0 до 1, тоже из браузера. */
  volume: number
  destroy(): void
}

/** Выключен ли звук по выбору игрока. Меню читает и меняет его до того, как звук создан. */
export const loadMuted = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export const storeMuted = (value: boolean) => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Без хранилища выбор живёт до перезагрузки.
  }
}

/** Громкость по выбору игрока, от 0 до 1. */
export const loadVolume = () => {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY) ?? 1)
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  } catch {
    return 1
  }
}

export const storeVolume = (value: number) => {
  try {
    localStorage.setItem(VOLUME_KEY, String(value))
  } catch {
    // Без хранилища выбор живёт до перезагрузки.
  }
}

/**
 * Звук игры. Браузер не даёт играть звук, пока игрок ничего не нажал, поэтому всё готовится при первом его
 * действии: тогда же синтезируются звуки (см. synth.ts) и заводятся ветер полёта (flight.ts) и фон (ambience.ts).
 * До этого play, flight и ambience ничего не делают. Пока вкладка скрыта, звук стоит.
 */
export function createAudio(): Audio {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  const buffers = new Map<SoundName, AudioBuffer[]>()
  let flight: Flight | null = null
  let ambience: Ambience | null = null
  let voices = 0
  let muted = loadMuted()
  let volume = loadVolume()
  const level = () => (muted ? 0 : MASTER * volume)

  const start = () => {
    if (context) {
      if (context.state === 'suspended') void context.resume()
      return
    }
    const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return
    context = new Context()
    // Компрессор не даёт залпу перегрузить звук.
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -18
    compressor.ratio.value = 6
    compressor.connect(context.destination)
    master = context.createGain()
    master.gain.value = level()
    master.connect(compressor)
    const rate = context.sampleRate
    const toBuffer = (channels: Float32Array<ArrayBuffer>[]) => {
      const buffer = context!.createBuffer(channels.length, channels[0].length, rate)
      channels.forEach((data, channel) => buffer.copyToChannel(data, channel))
      return buffer
    }
    for (const name of SOUND_NAMES) {
      buffers.set(name, Array.from({ length: SOUND_VARIANTS }, (_, variant) => toBuffer([SOUNDS[name](rate, variant)])))
    }
    // Ветер полёта и фон синтезируются дольше, а нужны не сразу: по куску за задачу, чтобы игра не замирала.
    // Петли шума — в стерео: у каждого уха своя, и ветер обступает со всех сторон.
    const noises: Partial<Noises> = {}
    const distant = new Map<DistantName, AudioBuffer[]>()
    let impulse: AudioBuffer
    const steps = [
      ...NOISE_SECONDS.map(([color, seconds]) => () => {
        noises[color] = toBuffer([noiseLoop(rate, seconds, 1, color), noiseLoop(rate, seconds, 2, color)])
      }),
      () => (flight = createFlight(context!, master!, noises as Noises)),
      () => (impulse = toBuffer(reverbImpulse(rate, REVERB_SECONDS, 1))),
      ...DISTANT_NAMES.map((name) => () => {
        distant.set(name, Array.from({ length: SOUND_VARIANTS }, (_, variant) => toBuffer([DISTANT_SOUNDS[name](rate, variant)])))
      }),
      () => (ambience = createAmbience(context!, master!, noises as Noises, impulse, distant)),
    ]
    const work = () => {
      if (!context) return
      steps.shift()!()
      if (steps.length) setTimeout(work)
    }
    setTimeout(work)
  }
  const events = ['pointerdown', 'keydown'] as const
  for (const event of events) window.addEventListener(event, start)
  // Скрытая вкладка не рисует кадров, и звук замер бы на полуслове: ветер свистел бы без конца.
  const onVisibility = () => {
    if (!context) return
    if (document.hidden) void context.suspend()
    else void context.resume()
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    play(name, volume, pan) {
      if (!context || !master || muted || context.state !== 'running' || voices >= MAX_VOICES || volume <= 0.01) return
      const variants = buffers.get(name)!
      const source = context.createBufferSource()
      source.buffer = variants[Math.floor(Math.random() * variants.length)]
      source.playbackRate.value = 1 + (Math.random() * 2 - 1) * DETUNE
      const gain = context.createGain()
      gain.gain.value = volume
      const panner = context.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      source.connect(gain).connect(panner).connect(master)
      voices++
      source.onended = () => {
        voices--
        source.disconnect()
        gain.disconnect()
        panner.disconnect()
      }
      source.start()
    },
    flight(seconds, speed) {
      if (context?.state === 'running') flight?.update(seconds, speed)
    },
    ambience(seconds, mood) {
      if (context?.state === 'running') ambience?.update(seconds, mood)
    },
    get muted() {
      return muted
    },
    set muted(value) {
      muted = value
      storeMuted(value)
      if (master) master.gain.value = level()
    },
    get volume() {
      return volume
    },
    set volume(value) {
      volume = value
      storeVolume(value)
      if (master) master.gain.value = level()
    },
    destroy() {
      for (const event of events) window.removeEventListener(event, start)
      document.removeEventListener('visibilitychange', onVisibility)
      void context?.close()
      context = null
    },
  }
}
