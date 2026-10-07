import { loop, type Noises } from './flight'
import { random, type DistantName } from './synth'

/** Каким фон должен быть сейчас: погода у игрока и высота камеры. */
export interface Mood {
  /** Ветер: 0 — штиль, 1 — сильный. */
  wind: number
  /** Осадки: 0 — ясно, 1 — буря. */
  precipitation: number
  /** Освещение: 0 — ночь, 1 — полдень. */
  light: number
  /** Высота камеры: 0 — у самой земли, 1 — выше всего. */
  altitude: number
}

/** Громкости слоёв фона. Все тихие: фон слышен, когда в игре затишье, и уходит под бой. */
const WIND_LEVEL = 0.14
const HOWL_LEVELS = [2.4, 1.5]
const HISS_LEVEL = 0.22
const PAD_LEVEL = 0.017
const DISTANT_LEVEL = 0.18
const REVERB_LEVEL = 0.55
/** За сколько секунд фон проявляется после первого нажатия игрока. */
const FADE_IN = 6
/** Как часто фон подстраивается под погоду, в секундах: параметры меняются плавно, чаще не нужно. */
const STEP = 0.1
/** Гулы ветра в развалинах: середина полосы в герцах и насколько она бродит, в долях. */
const HOWLS = [
  { frequency: 420, drift: 0.25, q: 9 },
  { frequency: 780, drift: 0.2, q: 14 },
]
/**
 * Аккорды подложки: ре минор — си-бемоль — до — ля минор, медленно и по кругу. Ноты — номера MIDI; первая — бас,
 * он держится весь аккорд, остальные по одной всплывают и тают.
 */
const CHORDS = [
  [38, 57, 62, 65, 69, 76],
  [34, 53, 57, 62, 65, 72],
  [36, 55, 60, 64, 67, 74],
  [33, 52, 57, 60, 64, 71],
]
/** Сколько секунд звучит аккорд. */
const CHORD_TIME = 24
/** Как часто всплывает нота подложки, в секундах: от и до. */
const NOTE_GAP = [2.5, 5]
/** Как часто случается что-то вдалеке, в секундах: от и до. */
const DISTANT_GAP = [9, 26]

const midi = (note: number) => 440 * Math.pow(2, (note - 69) / 12)
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** Плавное число от -1 до 1, которое медленно бродит: за единицу t — один шаг к новому случайному значению. */
function wander(seed: number) {
  const value = (step: number) => {
    const next = random(seed * 1000003 + step * 7919 + 1)
    next()
    return next() * 2 - 1
  }
  return (t: number) => {
    const step = Math.floor(t)
    const f = t - step
    const a = value(step)
    return a + (value(step + 1) - a) * f * f * (3 - 2 * f)
  }
}

export interface Ambience {
  /** Раз в кадр: фон подстраивается под погоду и высоту камеры. */
  update(seconds: number, mood: Mood): void
}

/**
 * Фон заброшенной пустой земли под низким небом. Всё время дует ветер, порывами; в развалинах то и дело гудит
 * и воет; в непогоду шуршат песок и дождь. Под этим — едва слышная медленная подложка в миноре, а вдалеке, сквозь
 * эхо, изредка скрипит ржавый металл, лязгает железо или, в бурю, рокочет гром.
 * Ветер крепнет вместе с погодой и с высотой камеры, подложка ночью темнее и ближе.
 */
export function createAmbience(
  context: BaseAudioContext,
  output: AudioNode,
  noises: Noises,
  impulse: AudioBuffer,
  distant: Map<DistantName, AudioBuffer[]>,
): Ambience {
  const next = random(Date.now() % 100000)
  const between = ([from, to]: number[]) => from + next() * (to - from)

  const bus = context.createGain()
  bus.gain.setValueAtTime(0, context.currentTime)
  bus.gain.linearRampToValueAtTime(1, context.currentTime + FADE_IN)
  bus.connect(output)
  // Эхо простора: туда уходят подложка, гулы и всё далёкое.
  const reverb = context.createConvolver()
  reverb.buffer = impulse
  const reverbGain = context.createGain()
  reverbGain.gain.value = REVERB_LEVEL
  reverb.connect(reverbGain).connect(bus)

  const filter = (type: BiquadFilterType, frequency: number, q = 0.7) => {
    const node = context.createBiquadFilter()
    node.type = type
    node.frequency.value = frequency
    node.Q.value = q
    return node
  }
  const gain = (value = 0) => {
    const node = context.createGain()
    node.gain.value = value
    return node
  }

  // Ветер — бурый шум, у которого порывами то открываются, то закрываются верха.
  const windFilter = filter('lowpass', 400)
  const windGain = gain()
  loop(context, noises.brown, 0).connect(windFilter).connect(windGain).connect(bus)

  // Гулы — розовый шум сквозь узкую полосу: ветер воет в пустых коробках зданий.
  const howls = HOWLS.map((howl, i) => {
    const band = filter('bandpass', howl.frequency, howl.q)
    const level = gain()
    const panner = context.createStereoPanner()
    loop(context, noises.pink, 2.1 + i * 3.3).connect(band).connect(level).connect(panner)
    panner.connect(bus)
    panner.connect(reverb)
    return { ...howl, band, level, panner }
  })

  // Шорох непогоды — белый шум без низов и самых верхов: песок по железу или дождь.
  const hissGain = gain()
  loop(context, noises.white, 0.7).connect(filter('highpass', 1500)).connect(filter('lowpass', 6500)).connect(hissGain).connect(bus)

  // Подложка: ноты всплывают и тают, сквозь мягкий фильтр, в основном через эхо.
  const padFilter = filter('lowpass', 900)
  const padGain = gain(PAD_LEVEL)
  padFilter.connect(padGain)
  padGain.connect(bus)
  padGain.connect(reverb)

  /** Нота подложки: всплывает за rise секунд, держится hold и тает за fade. */
  const note = (frequency: number, at: number, rise: number, hold: number, fade: number, level: number) => {
    const envelope = context.createGain()
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(level, at + rise)
    envelope.gain.setValueAtTime(level, at + rise + hold)
    envelope.gain.linearRampToValueAtTime(0, at + rise + hold + fade)
    envelope.connect(padFilter)
    // Две чуть разные волны — нота живая и тёплая.
    const voices = [
      { type: 'sine' as const, detune: -4, level: 1 },
      { type: 'triangle' as const, detune: 5, level: 0.45 },
    ].map((voice) => {
      const oscillator = context.createOscillator()
      oscillator.type = voice.type
      oscillator.frequency.value = frequency
      oscillator.detune.value = voice.detune
      const mix = gain(voice.level)
      oscillator.connect(mix).connect(envelope)
      oscillator.start(at)
      oscillator.stop(at + rise + hold + fade + 0.1)
      return { oscillator, mix }
    })
    voices[0].oscillator.onended = () => {
      for (const { oscillator, mix } of voices) {
        oscillator.disconnect()
        mix.disconnect()
      }
      envelope.disconnect()
    }
  }

  /** Что-то далеко: звук name сквозь даль — глухо, в стороне и больше эхом, чем напрямую. */
  const far = (name: DistantName, level: number) => {
    const variants = distant.get(name)!
    const source = context.createBufferSource()
    source.buffer = variants[Math.floor(next() * variants.length)]
    source.playbackRate.value = 0.85 + next() * 0.3
    const muffle = filter('lowpass', name === 'thunder' ? 400 : 1200 + next() * 1500)
    const panner = context.createStereoPanner()
    panner.pan.value = (next() * 2 - 1) * 0.8
    const dry = gain(level * (name === 'thunder' ? 0.8 : 0.3))
    const wet = gain(level)
    source.connect(muffle).connect(panner)
    panner.connect(dry).connect(bus)
    panner.connect(wet).connect(reverb)
    source.onended = () => {
      for (const node of [source, muffle, panner, dry, wet]) node.disconnect()
    }
    source.start()
  }

  const gust = [wander(1), wander(2)]
  const howlSwell = HOWLS.map((_, i) => wander(10 + i))
  const howlPitch = HOWLS.map((_, i) => wander(20 + i))
  const howlPan = HOWLS.map((_, i) => wander(30 + i))
  let time = 0
  let sinceStep = STEP
  let chord = 0
  let chordAt = context.currentTime
  let noteAt = context.currentTime + 1
  let distantAt = context.currentTime + between(DISTANT_GAP)
  // Бас первого аккорда.
  note(midi(CHORDS[0][0]), context.currentTime + 0.5, 6, CHORD_TIME - 6, 8, 0.8)

  return {
    update(seconds, mood) {
      time += seconds
      sinceStep += seconds
      if (sinceStep < STEP) return
      sinceStep = 0
      const now = context.currentTime
      const wind = clamp01(mood.wind)
      const precipitation = clamp01(mood.precipitation)
      const light = clamp01(mood.light)
      const altitude = clamp01(mood.altitude)

      // Ветер дует всегда: и в штиль на пустой земле что-то шелестит. Порыв — два медленных колебания разом.
      const strength = 0.3 + 0.7 * Math.max(wind, precipitation)
      const gusting = clamp01(0.5 + 0.35 * gust[0](time / 7) + 0.25 * gust[1](time / 2.3))
      const blow = WIND_LEVEL * (0.4 + 0.6 * strength) * (0.6 + 0.8 * gusting) * (0.75 + 0.5 * altitude)
      windGain.gain.setTargetAtTime(blow, now, 0.3)
      windFilter.frequency.setTargetAtTime(200 + (500 + 400 * altitude) * strength * (0.5 + gusting), now, 0.3)

      // Гулы накатывают и уходят; в сильный ветер чаще и громче, у земли слышнее, чем с высоты.
      howls.forEach((howl, i) => {
        const swell = Math.pow(clamp01(howlSwell[i](time / 9) + 0.15 * strength), 1.5)
        const level = HOWL_LEVELS[i] * swell * (0.25 + 0.75 * strength) * (1 - 0.4 * altitude)
        howl.level.gain.setTargetAtTime(level, now, 0.5)
        howl.band.frequency.setTargetAtTime(howl.frequency * (1 + howl.drift * howlPitch[i](time / 5) + 0.15 * gusting), now, 0.5)
        howl.panner.pan.setTargetAtTime(0.7 * howlPan[i](time / 13), now, 0.5)
      })

      hissGain.gain.setTargetAtTime(HISS_LEVEL * Math.pow(precipitation, 1.2) * (0.7 + 0.6 * gusting), now, 0.4)

      // Подложка: днём светлее, ночью темнее и чуть громче; в бурю отступает за ветер.
      padFilter.frequency.setTargetAtTime(450 + 900 * light * (1 - 0.5 * precipitation), now, 1)
      padGain.gain.setTargetAtTime(PAD_LEVEL * (1 + 0.4 * (1 - light)) * (1 - 0.5 * precipitation), now, 1)

      // Ноты подложки планируются чуть вперёд: точное время — у звука, не у кадров.
      const ahead = now + 0.5
      if (ahead >= chordAt + CHORD_TIME) {
        chordAt += CHORD_TIME
        // Вкладка спала — аккорды не догоняют упущенное.
        if (chordAt + CHORD_TIME < now) chordAt = now
        chord = (chord + 1) % CHORDS.length
        note(midi(CHORDS[chord][0]), Math.max(now, chordAt), 6, CHORD_TIME - 6, 8, 0.8)
      }
      if (ahead >= noteAt) {
        noteAt = Math.max(noteAt, now)
        const notes = CHORDS[chord]
        const pitch = notes[1 + Math.floor(next() * (notes.length - 1))]
        note(midi(pitch), noteAt, between([2.5, 5]), between([1, 4]), between([4, 7]), 0.35 + next() * 0.3)
        noteAt += between(NOTE_GAP)
      }

      // Вдалеке: в бурю — чаще гром, иначе скрип или лязг. С высоты земля дальше и тише.
      if (now >= distantAt) {
        const name: DistantName = next() < precipitation * 0.8 ? 'thunder' : next() < 0.55 ? 'creak' : 'clank'
        far(name, DISTANT_LEVEL * (0.5 + 0.5 * next()) * (1 - 0.5 * altitude) * (name === 'thunder' ? 0.7 + precipitation : 1))
        distantAt = now + between(DISTANT_GAP) * (1 - 0.4 * precipitation)
      }
    },
  }
}
