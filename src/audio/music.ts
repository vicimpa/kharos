import { loadMuted, loadVolume } from './audio'
import { SOUNDS, random, reverbImpulse, type SoundName } from './synth'

/** Громкость музыки при полной громкости игры. */
const LEVEL = 0.32
/** За сколько секунд музыка вступает и за сколько стихает, когда меню закрыли. */
const FADE_IN = 5
const FADE_OUT = 0.8
/** Сколько секунд длится эхо. */
const REVERB_SECONDS = 5
/** Сколько эха в музыке: она звучит как издалека, над пустой землёй. */
const WET = 0.7
/**
 * Аккорды: ре минор — си-бемоль — до — ля минор, как подложка игры (audio/ambience.ts), — музыка меню и фон игры
 * одного рода. Ноты — номера MIDI: первая — бас, остальные — пэд.
 */
const CHORDS = [
  [38, 57, 62, 65, 69],
  [34, 53, 58, 62, 65],
  [36, 55, 60, 64, 67],
  [33, 52, 57, 60, 64],
]
/** Сколько секунд звучит аккорд. */
const CHORD_TIME = 12
/** Мелодия — ре минорная пентатоника в верхней октаве: из неё любая нота ложится на любой аккорд. */
const MELODY = [74, 77, 79, 81, 84, 86]
/** Сколько секунд между нотами мелодии: от и до. Иногда она молчит дольше. */
const MELODY_GAP = [1.2, 3]
/** Насколько вперёд планируются ноты, в секундах: точное время — у звука, а не у таймера. */
const AHEAD = 0.6
/** Громкость звуков кнопок относительно громкости игры: те же, что у кнопок в игре. */
const CLICK_LEVEL = 0.35
const HOVER_LEVEL = 0.12
/** Что в меню звучит под пальцем: кнопки, ссылки, галочки и переключатели. */
const PRESSABLE = '.menu button, .menu a, .menu input[type=checkbox], .menu input[type=radio], .menu select'
/** Ползунок тикает, пока его тянут, но не чаще этого, в секундах: иначе трещал бы. */
const SLIDE_GAP = 0.06
/** Высота тика ползунка: у левого края — в столько раз ниже обычного, у правого — во столько выше. */
const SLIDE_LOW = 0.7
const SLIDE_HIGH = 1.5

const midi = (note: number) => 440 * Math.pow(2, (note - 69) / 12)

export interface MenuMusic {
  /** Громкость и выключение из настроек игрока поменялись. */
  refresh(): void
  /** Меню закрыли: музыка стихает и всё освобождает. */
  destroy(): void
}

/**
 * Музыка главного меню: медленные минорные аккорды под эхо и неспешная мелодия поверх, и звуки кнопок — те же, что
 * в игре. Браузер не даёт играть звук, пока игрок ничего не нажал, — музыка вступает с первым его действием, и этот
 * же щелчок уже звучит. Громкость и выключение — те же, что у игры.
 */
export function createMenuMusic(): MenuMusic {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  /** Звуки кнопок: мимо музыки и её эха, сразу на выход. */
  let clicks: GainNode | null = null
  const buffers = new Map<SoundName, AudioBuffer>()
  const next = random(Date.now() % 100000)
  const between = ([from, to]: number[]) => from + next() * (to - from)
  const level = () => (loadMuted() ? 0 : LEVEL * loadVolume())

  const start = () => {
    if (context) return
    const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return
    const audio = new Context()
    context = audio
    const rate = audio.sampleRate
    master = audio.createGain()
    master.gain.setValueAtTime(0, audio.currentTime)
    master.gain.linearRampToValueAtTime(level(), audio.currentTime + FADE_IN)
    master.connect(audio.destination)
    clicks = audio.createGain()
    clicks.gain.value = loadMuted() ? 0 : loadVolume()
    clicks.connect(audio.destination)
    for (const name of ['click', 'hover', 'deny'] as const) {
      const data = SOUNDS[name](rate, 0)
      const buffer = audio.createBuffer(1, data.length, rate)
      buffer.copyToChannel(data, 0)
      buffers.set(name, buffer)
    }

    const reverb = audio.createConvolver()
    const channels = reverbImpulse(rate, REVERB_SECONDS, 3)
    const impulse = audio.createBuffer(2, channels[0].length, rate)
    channels.forEach((data, channel) => impulse.copyToChannel(data, channel))
    reverb.buffer = impulse
    const wet = audio.createGain()
    wet.gain.value = WET
    reverb.connect(wet).connect(master)
    const dry = audio.createGain()
    dry.gain.value = 1 - WET * 0.5
    dry.connect(master)
    const bus = audio.createBiquadFilter()
    bus.type = 'lowpass'
    bus.frequency.value = 2400
    bus.connect(dry)
    bus.connect(reverb)

    /** Нота: всплывает за rise, держится hold, тает за fade. Две чуть разные волны — звук тёплый. pan — сторона. */
    const note = (frequency: number, at: number, rise: number, hold: number, fade: number, volume: number, pan = 0, bright = false) => {
      const envelope = audio.createGain()
      envelope.gain.setValueAtTime(0, at)
      envelope.gain.linearRampToValueAtTime(volume, at + rise)
      envelope.gain.setValueAtTime(volume, at + rise + hold)
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + rise + hold + fade)
      const panner = audio.createStereoPanner()
      panner.pan.value = pan
      envelope.connect(panner).connect(bus)
      const end = at + rise + hold + fade + 0.1
      const voices = [
        { type: bright ? ('triangle' as const) : ('sine' as const), detune: -5, level: 1 },
        { type: 'triangle' as const, detune: 6, level: bright ? 0.25 : 0.4 },
      ].map(({ type, detune, level }) => {
        const oscillator = audio.createOscillator()
        oscillator.type = type
        oscillator.frequency.value = frequency
        oscillator.detune.value = detune
        const mix = audio.createGain()
        mix.gain.value = level
        oscillator.connect(mix).connect(envelope)
        oscillator.start(at)
        oscillator.stop(end)
        return { oscillator, mix }
      })
      voices[0].oscillator.onended = () => {
        for (const { oscillator, mix } of voices) {
          oscillator.disconnect()
          mix.disconnect()
        }
        envelope.disconnect()
        panner.disconnect()
      }
    }

    let chord = -1
    let chordAt = audio.currentTime + 0.3
    let melodyAt = chordAt + 4
    let last = -1
    const schedule = () => {
      const ahead = audio.currentTime + AHEAD
      // Вкладку усыпляли — не догоняем упущенное, а продолжаем с этого мига.
      if (chordAt < audio.currentTime - CHORD_TIME) chordAt = audio.currentTime
      while (chordAt <= ahead) {
        chord = (chord + 1) % CHORDS.length
        const [bass, ...pad] = CHORDS[chord]
        note(midi(bass), chordAt, 2, CHORD_TIME - 2, 4, 0.22)
        note(midi(bass + 12), chordAt, 3, CHORD_TIME - 3, 4, 0.06)
        pad.forEach((pitch, i) => note(midi(pitch), chordAt + i * 0.35, 3, CHORD_TIME - 4, 5, 0.05, (i / (pad.length - 1)) * 1.2 - 0.6))
        chordAt += CHORD_TIME
      }
      if (melodyAt < audio.currentTime - 5) melodyAt = audio.currentTime
      while (melodyAt <= ahead) {
        // Мелодия ходит шагами, а не скачет: следующая нота — рядом с прошлой.
        last = last < 0 ? Math.floor(next() * MELODY.length) : Math.max(0, Math.min(MELODY.length - 1, last + Math.round((next() * 2 - 1) * 2)))
        note(midi(MELODY[last]), melodyAt, 0.02, 0.15, between([1.5, 3]), 0.07, (next() * 2 - 1) * 0.5, true)
        melodyAt += between(MELODY_GAP) * (next() < 0.15 ? 3 : 1)
      }
    }
    schedule()
    timer = setInterval(schedule, 200)
  }

  const play = (name: SoundName, volume: number, pitch = 1) => {
    const buffer = buffers.get(name)
    if (!context || !clicks || !buffer || context.state !== 'running') return
    const source = context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = pitch
    const gain = context.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(clicks)
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
    }
    source.start()
  }
  let slidAt = -Infinity
  /** Ползунок сдвинули: тик тем выше, чем он правее. Громкость он берёт уже новую — у ползунка громкости так её и слышно. */
  const slide = (event: Event) => {
    const range = event.target
    if (!(range instanceof HTMLInputElement) || range.type !== 'range' || !range.closest('.menu') || !context) return
    if (context.currentTime - slidAt < SLIDE_GAP) return
    slidAt = context.currentTime
    const min = Number(range.min || 0)
    const max = Number(range.max || 100)
    const share = max > min ? (Number(range.value) - min) / (max - min) : 0.5
    play('hover', CLICK_LEVEL, SLIDE_LOW + (SLIDE_HIGH - SLIDE_LOW) * share)
  }
  const pressable = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(PRESSABLE) : null)
  const down = (event: PointerEvent) => {
    // Первый щелчок сам заводит звук и уже звучит.
    start()
    const pressed = pressable(event.target)
    if (!pressed) return
    play((pressed as HTMLButtonElement).disabled ? 'deny' : 'click', CLICK_LEVEL)
  }
  let hovered: Element | null = null
  const over = (event: PointerEvent) => {
    const target = pressable(event.target)
    if (target === hovered) return
    hovered = target
    if (target && !(target as HTMLButtonElement).disabled) play('hover', HOVER_LEVEL)
  }
  const events = ['pointerdown', 'keydown'] as const
  for (const event of events) window.addEventListener(event, start)
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointerover', over)
  // После обработчиков меню: громкость к этому времени уже новая.
  document.addEventListener('input', slide)

  return {
    refresh() {
      if (context && master) master.gain.setTargetAtTime(level(), context.currentTime, 0.1)
      if (context && clicks) clicks.gain.setTargetAtTime(loadMuted() ? 0 : loadVolume(), context.currentTime, 0.05)
    },
    destroy() {
      for (const event of events) window.removeEventListener(event, start)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('input', slide)
      clearInterval(timer)
      if (!context || !master) return
      const closing = context
      master.gain.cancelScheduledValues(closing.currentTime)
      master.gain.setTargetAtTime(0, closing.currentTime, FADE_OUT / 4)
      setTimeout(() => void closing.close(), FADE_OUT * 1000 + 200)
      context = null
    },
  }
}
