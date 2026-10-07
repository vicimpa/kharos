import { expect, test } from 'bun:test'
import { SOUNDS, SOUND_NAMES, SOUND_VARIANTS } from '../src/audio/synth'

const RATE = 44100

test('звуки синтезируются: конечные, не тишина, пик — единица, варианты различаются', () => {
  for (const name of SOUND_NAMES) {
    const variants = Array.from({ length: SOUND_VARIANTS }, (_, variant) => SOUNDS[name](RATE, variant))
    for (const data of variants) {
      // Щелчки интерфейса — сотые доли секунды; короче — уже не звук, а треск.
      expect(data.length).toBeGreaterThan(RATE * 0.02)
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
