import { expect, test } from 'bun:test'
import { DISTANT_NAMES, DISTANT_SOUNDS, NOISE_LEVEL, SOUNDS, SOUND_NAMES, SOUND_VARIANTS, noiseLoop, reverbImpulse } from '../src/audio/synth'

const RATE = 44100

test('звуки синтезируются: конечные, не тишина, пик — единица, варианты различаются', () => {
  for (const name of SOUND_NAMES) {
    const variants = Array.from({ length: SOUND_VARIANTS }, (_, variant) => SOUNDS[name](RATE, variant))
    for (const data of variants) {
      expect(data.length).toBeGreaterThan(RATE * 0.05)
      expect(data.length).toBeLessThan(RATE * 2)
      let peak = 0
      let energy = 0
      for (const value of data) {
        peak = Math.max(peak, Math.abs(value))
        energy += value * value
      }
      expect(Number.isFinite(energy)).toBe(true)
      expect(peak).toBeCloseTo(1)
      expect(Math.sqrt(energy / data.length)).toBeGreaterThan(0.02)
      // Конец гаснет до нуля: без щелчка.
      expect(Math.abs(data[data.length - 1])).toBeLessThan(0.01)
    }
    expect(variants[0]).not.toEqual(variants[1])
  }
})

test('далёкие звуки фона: конечные, не тишина, пик — единица, варианты различаются', () => {
  for (const name of DISTANT_NAMES) {
    const variants = Array.from({ length: SOUND_VARIANTS }, (_, variant) => DISTANT_SOUNDS[name](RATE, variant))
    for (const data of variants) {
      expect(data.length).toBeGreaterThan(RATE)
      expect(data.length).toBeLessThan(RATE * 6)
      let peak = 0
      let energy = 0
      for (const value of data) {
        peak = Math.max(peak, Math.abs(value))
        energy += value * value
      }
      expect(Number.isFinite(energy)).toBe(true)
      expect(peak).toBeCloseTo(1)
      expect(Math.sqrt(energy / data.length)).toBeGreaterThan(0.01)
      expect(Math.abs(data[data.length - 1])).toBeLessThan(0.01)
    }
    expect(variants[0]).not.toEqual(variants[1])
  }
})

test('петли шума: заданная громкость, без постоянной составляющей и без шва на стыке', () => {
  for (const color of ['white', 'pink', 'brown'] as const) {
    const data = noiseLoop(RATE, 2, 1, color)
    expect(data.length).toBe(RATE * 2)
    let mean = 0
    let energy = 0
    let step = 0
    for (let i = 0; i < data.length; i++) {
      mean += data[i] / data.length
      energy += data[i] * data[i]
      if (i) step = Math.max(step, Math.abs(data[i] - data[i - 1]))
    }
    expect(Math.abs(mean)).toBeLessThan(1e-3)
    expect(Math.sqrt(energy / data.length)).toBeCloseTo(NOISE_LEVEL, 3)
    // Стык конца с началом — не резче, чем самый резкий шаг внутри петли.
    expect(Math.abs(data[0] - data[data.length - 1])).toBeLessThanOrEqual(step)
    expect(noiseLoop(RATE, 2, 2, color)).not.toEqual(data)
  }
  // Бурый шум глухой: соседние сэмплы почти равны, в отличие от белого.
  const smoothness = (data: Float32Array) => {
    let sum = 0
    for (let i = 1; i < data.length; i++) sum += Math.abs(data[i] - data[i - 1])
    return sum / data.length
  }
  expect(smoothness(noiseLoop(RATE, 1, 1, 'brown'))).toBeLessThan(smoothness(noiseLoop(RATE, 1, 1, 'white')) / 5)
})

test('отклик эха: стерео, разные уши, гаснет к концу', () => {
  const [left, right] = reverbImpulse(RATE, 3, 1)
  expect(left.length).toBe(RATE * 3)
  expect(right.length).toBe(RATE * 3)
  expect(left).not.toEqual(right)
  const energy = (data: Float32Array, from: number, to: number) => {
    let sum = 0
    for (let i = from; i < to; i++) sum += data[i] * data[i]
    return sum
  }
  const tenth = Math.floor(left.length / 10)
  expect(energy(left, left.length - tenth, left.length)).toBeLessThan(energy(left, 0, tenth) / 1000)
})
