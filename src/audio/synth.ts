/**
 * Звуки игры, синтезированные в коде, как и графика: каждый — функция, заполняющая массив сэмплов от -1 до 1.
 * Работает без браузера. variant меняет зерно шума: несколько вариантов одного звука не звучат одинаково.
 */

/** Генератор случайных чисел от 0 до 1 с зерном: один вариант звука всегда одинаков. */
function random(seed: number) {
  let state = (seed * 2654435761) >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

/** Фильтр нижних частот с одним полюсом: срез cutoff в герцах. Возвращает функцию сэмпл → сэмпл. */
function lowpass(rate: number, cutoff: () => number) {
  let last = 0
  return (input: number) => {
    const k = 1 - Math.exp((-2 * Math.PI * cutoff()) / rate)
    last += (input - last) * k
    return last
  }
}

/** Фильтр верхних частот: вход минус его низы. */
function highpass(rate: number, cutoff: number) {
  const low = lowpass(rate, () => cutoff)
  return (input: number) => input - low(input)
}

/** Звук длиной seconds: sample(t, noise) — значение в момент t секунд; noise — белый шум этого варианта. */
function render(rate: number, seconds: number, variant: number, sample: (t: number, noise: () => number) => number) {
  const next = random(variant + 1)
  const noise = () => next() * 2 - 1
  const data = new Float32Array(Math.ceil(rate * seconds))
  for (let i = 0; i < data.length; i++) data[i] = sample(i / rate, noise)
  // Без щелчка в конце: последние миллисекунды гаснут.
  const tail = Math.min(data.length, Math.round(rate * 0.01))
  for (let i = 0; i < tail; i++) data[data.length - 1 - i] *= i / tail
  // Пик — единица: громкость звука задаёт тот, кто его играет.
  let peak = 0
  for (const value of data) peak = Math.max(peak, Math.abs(value))
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak
  return data
}

/** Затухание: за time секунд звук стихает в e раз. */
const decay = (t: number, time: number) => Math.exp(-t / time)
/** Быстрая атака за attack секунд, чтобы не щёлкало начало. */
const attack = (t: number, time: number) => Math.min(1, t / time)

/** Винтовка: сухой щелчок и короткий хлопок. */
function rifle(rate: number, variant: number) {
  const crack = highpass(rate, 2500)
  const body = lowpass(rate, () => 900)
  return render(rate, 0.2, variant, (t, noise) => {
    const n = noise()
    return crack(n) * decay(t, 0.01) * 0.9 + body(n) * decay(t, 0.05) * 1.6 + Math.sin(2 * Math.PI * 140 * t) * decay(t, 0.025) * 0.35
  })
}

/** Пулемёт: щелчок короче и легче винтовочного, чтобы очередь не сливалась в гул. */
function machinegun(rate: number, variant: number) {
  const crack = highpass(rate, 3000)
  const body = lowpass(rate, () => 1400)
  return render(rate, 0.12, variant, (t, noise) => {
    const n = noise()
    return crack(n) * decay(t, 0.007) * 0.7 + body(n) * decay(t, 0.03) * 1.2 + Math.sin(2 * Math.PI * 180 * t) * decay(t, 0.015) * 0.25
  })
}

/** Пушка: удар, глухой бас, уходящий вниз, и раскат. */
function cannon(rate: number, variant: number) {
  const crack = highpass(rate, 1500)
  const rumble = lowpass(rate, () => 320)
  let phase = 0
  return render(rate, 1.3, variant, (t, noise) => {
    const n = noise()
    phase += (2 * Math.PI * (40 + 60 * decay(t, 0.12))) / rate
    return crack(n) * decay(t, 0.012) * 0.8 + Math.sin(phase) * decay(t, 0.3) * 0.8 + rumble(n) * decay(t, 0.4) * 2.4
  })
}

/** Ракета: хлопок пуска и шипение уходящего двигателя. */
function launcher(rate: number, variant: number) {
  const hiss = highpass(rate, 500)
  let t = 0
  // Шипение темнеет: ракета уходит.
  const band = lowpass(rate, () => 1200 + 3000 * decay(t, 0.15))
  const pop = lowpass(rate, () => 600)
  return render(rate, 0.7, variant, (time, noise) => {
    t = time
    const n = noise()
    const whoosh = band(hiss(n)) * attack(t, 0.03) * decay(t, 0.25) * 1.4
    return whoosh + pop(n) * decay(t, 0.03) * 1.5
  })
}

/** Лазер: тон, падающий сверху вниз, с лёгким дребезгом. */
function laser(rate: number, variant: number) {
  let phase = variant * 0.7
  return render(rate, 0.35, variant, (t) => {
    const frequency = 500 + 1800 * decay(t, 0.06) + Math.sin(2 * Math.PI * 30 * t) * 25
    phase += (2 * Math.PI * frequency) / rate
    const tone = Math.sin(phase) * 0.7 + Math.sign(Math.sin(phase)) * 0.15
    return tone * attack(t, 0.004) * decay(t, 0.1) * 0.6
  })
}

/** Разряд: треск — шум, который рвётся на вспышки, поверх гудения. */
function arc(rate: number, variant: number) {
  const next = random(variant + 101)
  const crackle = highpass(rate, 1200)
  let gate = 0
  let until = 0
  return render(rate, 0.5, variant, (t, noise) => {
    if (t >= until) {
      gate = next() < 0.55 ? 0.4 + next() * 0.6 : 0
      until = t + 0.003 + next() * 0.012
    }
    const buzz = ((t * 110) % 1) * 2 - 1
    return crackle(noise()) * gate * decay(t, 0.18) * 1.1 + buzz * decay(t, 0.12) * 0.18
  })
}

/** Взрыв: удар и раскатистый шум, который глохнет, темнея. big — громадный: дольше и ниже. */
function explosion(rate: number, variant: number, big: boolean) {
  const length = big ? 1.9 : 0.9
  const fade = big ? 0.5 : 0.22
  let t = 0
  const body = lowpass(rate, () => 160 + 2200 * decay(t, big ? 0.18 : 0.1))
  let phase = 0
  return render(rate, length, variant, (time, noise) => {
    t = time
    phase += (2 * Math.PI * (big ? 38 : 60) * (1 + decay(time, 0.08))) / rate
    const thump = Math.sin(phase) * decay(time, big ? 0.25 : 0.12) * (big ? 0.9 : 0.6)
    return body(noise()) * attack(time, 0.004) * decay(time, fade) * 2.6 + thump
  })
}

/** Сигнал: тоны по очереди, каждый — tone секунд с паузой gap; квадратная примесь делает его слышным в бою. */
function signal(rate: number, variant: number, tones: number[], tone: number, gap: number) {
  let phase = 0
  return render(rate, tones.length * (tone + gap), variant, (t) => {
    const index = Math.floor(t / (tone + gap))
    const local = t - index * (tone + gap)
    if (index >= tones.length || local > tone) return 0
    // Варианты чуть разнятся высотой: один и тот же сигнал подряд не звучит как запись.
    phase += (2 * Math.PI * tones[index] * (1 + variant * 0.012)) / rate
    const wave = Math.sin(phase) * 0.8 + Math.sign(Math.sin(phase)) * 0.2
    return wave * attack(local, 0.005) * Math.min(1, (tone - local) / 0.02)
  })
}

/** Короткий тон интерфейса: частота скользит от from к to за length секунд, click — щелчок в начале. */
function blip(rate: number, variant: number, from: number, to: number, length: number, click = 0) {
  let phase = 0
  const tick = highpass(rate, 3000)
  return render(rate, length, variant, (t, noise) => {
    const frequency = from + (to - from) * Math.min(1, t / length)
    phase += (2 * Math.PI * frequency * (1 + variant * 0.01)) / rate
    const tone = (Math.sin(phase) * 0.85 + Math.sign(Math.sin(phase)) * 0.15) * attack(t, 0.003) * decay(t, length / 3)
    return tone + tick(noise()) * decay(t, 0.004) * click
  })
}

export const SOUNDS = {
  rifle,
  machinegun,
  cannon,
  launcher,
  laser,
  arc,
  blast: (rate: number, variant: number) => explosion(rate, variant, false),
  bigBlast: (rate: number, variant: number) => explosion(rate, variant, true),
  /** Тревога: нас атакуют — два спуска вниз. */
  attacked: (rate: number, variant: number) => signal(rate, variant, [880, 660, 880, 660], 0.11, 0.03),
  /** Интерфейс: щелчок кнопки, касание ячейки при наведении, вход в раздел, отказ. */
  click: (rate: number, variant: number) => blip(rate, variant, 1400, 1100, 0.05, 0.6),
  hover: (rate: number, variant: number) => blip(rate, variant, 2200, 2200, 0.025, 0.3),
  open: (rate: number, variant: number) => blip(rate, variant, 700, 1300, 0.09, 0.3),
  deny: (rate: number, variant: number) => blip(rate, variant, 220, 160, 0.16, 0.2),
  /** Приказы: закладка здания, движение, атака. */
  place: (rate: number, variant: number) => signal(rate, variant, [520, 780], 0.05, 0.02),
  order: (rate: number, variant: number) => blip(rate, variant, 900, 1250, 0.07, 0.4),
  attackOrder: (rate: number, variant: number) => signal(rate, variant, [1050, 700], 0.045, 0.015),
  /** Замечен противник: два коротких восходящих тона. */
  spotted: (rate: number, variant: number) => signal(rate, variant, [620, 930], 0.09, 0.05),
} satisfies Record<string, (rate: number, variant: number) => Float32Array>

export type SoundName = keyof typeof SOUNDS
export const SOUND_NAMES = Object.keys(SOUNDS) as SoundName[]
/** Вариантов у каждого звука. */
export const SOUND_VARIANTS = 3

/**
 * Петля длиной seconds: как render, но конец плавно переходит в начало — сэмплы последних FADE секунд
 * подмешиваются к первым, и петля звучит без щелчка на стыке.
 */
function loop(rate: number, seconds: number, sample: (t: number, noise: () => number) => number) {
  const fade = Math.round(rate * 0.25)
  const length = Math.ceil(rate * seconds)
  const next = random(7)
  const noise = () => next() * 2 - 1
  const raw = new Float32Array(length + fade)
  for (let i = 0; i < raw.length; i++) raw[i] = sample(i / rate, noise)
  const data = raw.slice(0, length)
  for (let i = 0; i < fade; i++) {
    const k = i / fade
    data[i] = data[i] * k + raw[length + i] * (1 - k)
  }
  let peak = 0
  for (const value of data) peak = Math.max(peak, Math.abs(value))
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak
  return data
}

/** Удары раз в period секунд со сдвигом offset: огибающая каждого гаснет за time. */
const pulse = (t: number, period: number, time: number, offset = 0) => decay((((t - offset) % period) + period) % period, time)

/** Гул электростанции: сеть и её гармоники, чуть дышащие. */
function hum(rate: number) {
  const air = lowpass(rate, () => 400)
  return loop(rate, 4, (t, noise) => {
    const breath = 1 + Math.sin(2 * Math.PI * 0.5 * t) * 0.15
    return (Math.sin(2 * Math.PI * 50 * t) * 0.6 + Math.sin(2 * Math.PI * 100 * t) * 0.35 + Math.sin(2 * Math.PI * 150 * t) * 0.12) * breath + air(noise()) * 0.25
  })
}

/** Цех и переработка: мерный стук пресса и звон металла поверх шипения. */
function machinery(rate: number) {
  const thud = lowpass(rate, () => 300)
  const hiss = highpass(rate, 2500)
  return loop(rate, 2, (t, noise) => {
    const n = noise()
    const press = thud(n) * pulse(t, 0.5, 0.06) * 2.2
    const ring = Math.sin(2 * Math.PI * 760 * t) * pulse(t, 1, 0.12, 0.25) * 0.35
    return press + ring + hiss(n) * 0.08 + Math.sin(2 * Math.PI * 60 * t) * 0.15
  })
}

/** Шахта: бур — жужжание, которое дрожит. */
function drill(rate: number) {
  const grit = lowpass(rate, () => 900)
  return loop(rate, 2, (t, noise) => {
    const wobble = 1 + Math.sin(2 * Math.PI * 7 * t) * 0.3
    const buzz = (((t * 95) % 1) * 2 - 1) * 0.4
    return (buzz + grit(noise()) * 1.4) * wobble
  })
}

/** Колёсная техника: мотор — пила с подвыванием. */
function engine(rate: number) {
  const body = lowpass(rate, () => 500)
  let phase = 0
  return loop(rate, 2, (t, noise) => {
    phase += (2 * Math.PI * (72 + Math.sin(2 * Math.PI * 0.5 * t) * 6)) / rate
    const saw = (phase / (2 * Math.PI)) % 1
    return body((saw * 2 - 1) * 0.9 + noise() * 0.3) * 1.6
  })
}

/** Гусеничная: низкий рокот и лязг траков. */
function tracks(rate: number) {
  const rumble = lowpass(rate, () => 140)
  const clank = highpass(rate, 1800)
  return loop(rate, 2, (t, noise) => {
    const n = noise()
    return rumble(n) * 3 + clank(n) * pulse(t, 1 / 9, 0.012) * 0.6 + Math.sin(2 * Math.PI * 38 * t) * 0.3
  })
}

/** Пехота: шаги вразнобой — глухие шорохи. */
function steps(rate: number) {
  const scuff = lowpass(rate, () => 1200)
  return loop(rate, 2, (t, noise) => {
    const n = noise()
    const beat = pulse(t, 0.5, 0.03) + pulse(t, 0.5, 0.03, 0.23) * 0.8 + pulse(t, 0.66, 0.025, 0.1) * 0.6
    return scuff(n) * beat * 2
  })
}

/** Летающие: винты — шум, рубленый на лопасти. */
function rotor(rate: number) {
  const wash = lowpass(rate, () => 700)
  return loop(rate, 2, (t, noise) => wash(noise()) * (0.35 + pulse(t, 1 / 14, 0.025) * 1.4))
}

/** Ветер: тёмный шум, который то крепчает, то стихает. */
function wind(rate: number) {
  let t = 0
  const gust = lowpass(rate, () => 250 + 350 * (0.5 + Math.sin(2 * Math.PI * 0.13 * t) * 0.5))
  return loop(rate, 8, (time, noise) => {
    t = time
    const swell = 0.55 + Math.sin(2 * Math.PI * 0.125 * time) * 0.25 + Math.sin(2 * Math.PI * 0.375 * time) * 0.12
    return gust(noise()) * swell
  })
}

/** Фоновые петли: здания, техника на ходу, погода. Каждая звучит одним голосом, громкость задаёт ambience.ts. */
export const LOOPS = { hum, machinery, drill, engine, tracks, steps, rotor, wind } satisfies Record<string, (rate: number) => Float32Array>
export type LoopName = keyof typeof LOOPS
export const LOOP_NAMES = Object.keys(LOOPS) as LoopName[]
