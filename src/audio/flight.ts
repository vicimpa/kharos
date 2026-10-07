/** Петли шума, общие для звука полёта и фона: стерео, по цвету. */
export interface Noises {
  white: AudioBuffer
  pink: AudioBuffer
  brown: AudioBuffer
}

/** Громкость ветра на полной скорости. */
const LEVEL = 0.9
/** Как быстро ветер нарастает при разгоне и стихает при торможении: за столько секунд — на две трети. */
const RISE = 0.08
const FALL = 0.35
/** Полоса свиста: на месте глухая, на полной скорости светлая. В герцах. */
const BAND_LOW = 450
const BAND_HIGH = 4200
/** Трепет: так часто дрожит поток, в герцах, — на месте и на полной скорости. */
const FLUTTER_LOW = 5
const FLUTTER_HIGH = 13

/** Крутит петлю buffer без конца, начиная с offset секунд: один шум с разных мест не звучит одинаково. */
export function loop(context: BaseAudioContext, buffer: AudioBuffer, offset: number) {
  const source = context.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.start(0, offset % buffer.duration)
  return source
}

export interface Flight {
  /** Раз в кадр: speed — как быстро несётся камера, от 0 (стоит) до 1 (во весь опор). */
  update(seconds: number, speed: number): void
}

/**
 * Ветер полёта, как у элитр: камера несётся над картой — в ушах свистит поток. Чем быстрее, тем громче и выше свист,
 * а поток дрожит и рвётся. Это шум через полосу, которая светлеет с разгоном, и глухой гул под ним.
 */
export function createFlight(context: BaseAudioContext, output: AudioNode, noises: Noises): Flight {
  const bus = context.createGain()
  bus.gain.value = 0
  bus.connect(output)

  // Свист — розовый шум через полосу.
  const rush = loop(context, noises.pink, 1.3)
  const low = context.createBiquadFilter()
  low.type = 'highpass'
  low.frequency.value = 160
  const band = context.createBiquadFilter()
  band.type = 'lowpass'
  band.frequency.value = BAND_LOW
  band.Q.value = 1.5
  const rushGain = context.createGain()
  rushGain.gain.value = 1
  rush.connect(low).connect(band).connect(rushGain).connect(bus)

  // Гул — тело потока: бурый шум, только низы.
  const rumble = loop(context, noises.brown, 2.7)
  const rumbleFilter = context.createBiquadFilter()
  rumbleFilter.type = 'lowpass'
  rumbleFilter.frequency.value = 240
  const rumbleGain = context.createGain()
  rumbleGain.gain.value = 0.9
  rumble.connect(rumbleFilter).connect(rumbleGain).connect(bus)

  // Трепет — свист дрожит часто и неглубоко; раскачка — весь ветер медленно накатывает.
  const flutter = context.createOscillator()
  flutter.frequency.value = FLUTTER_LOW
  const flutterDepth = context.createGain()
  flutterDepth.gain.value = 0
  flutter.connect(flutterDepth).connect(rushGain.gain)
  flutter.start()
  const sway = context.createOscillator()
  sway.frequency.value = 0.6
  const swayDepth = context.createGain()
  swayDepth.gain.value = 0
  sway.connect(swayDepth).connect(bus.gain)
  sway.start()

  let level = 0
  return {
    update(seconds, speed) {
      const target = Math.max(0, Math.min(1, speed))
      level += (target - level) * (1 - Math.exp(-seconds / (target > level ? RISE : FALL)))
      const now = context.currentTime
      // Тихий ветер слышен еле-еле, громким становится только быстрый.
      const loudness = LEVEL * Math.pow(level, 1.5)
      bus.gain.setTargetAtTime(loudness, now, 0.03)
      swayDepth.gain.setTargetAtTime(loudness * 0.2, now, 0.03)
      band.frequency.setTargetAtTime(BAND_LOW * Math.pow(BAND_HIGH / BAND_LOW, level), now, 0.05)
      rush.playbackRate.setTargetAtTime(0.8 + 0.5 * level, now, 0.05)
      flutter.frequency.setTargetAtTime(FLUTTER_LOW + (FLUTTER_HIGH - FLUTTER_LOW) * level, now, 0.05)
      flutterDepth.gain.setTargetAtTime(0.3 * level, now, 0.05)
    },
  }
}
