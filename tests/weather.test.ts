import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim, weatherAt, type SimOptions } from '../src/sim'

const options: SimOptions = { generator: DEFAULT_SETTINGS.generator, size: 128 }

test('сутки: в полдень светло, в полночь темно; начальный час и длина суток — параметры мира', () => {
  const world = { ...options, weather: { startHour: 0, dayLength: 240 } }
  expect(weatherAt(world, 0).hour).toBe(0)
  expect(weatherAt(world, 120).hour).toBeCloseTo(12)
  expect(weatherAt(world, 240).hour).toBeCloseTo(0)
  const calm = { ...world, weather: { ...world.weather, changes: false } }
  expect(weatherAt(calm, 120).light).toBeGreaterThan(0.95)
  expect(weatherAt(calm, 0).light).toBeLessThan(0.15)
  // Время стоит.
  expect(weatherAt({ ...options, weather: { startHour: 15, dayLength: 0 } }, 5000).hour).toBe(15)
})

test('непогода бродит медленно и одинаково у всех, а без перемен всегда ясно', () => {
  const samples = Array.from({ length: 2000 }, (_, i) => weatherAt(options, i * 10))
  expect(samples.some((weather) => weather.precipitation > 0.2)).toBe(true)
  expect(samples.some((weather) => weather.precipitation === 0)).toBe(true)
  for (let i = 1; i < samples.length; i++) {
    expect(Math.abs(samples[i].precipitation - samples[i - 1].precipitation)).toBeLessThan(0.1)
    expect(Math.abs(samples[i].windX - samples[i - 1].windX)).toBeLessThan(0.5)
  }
  expect(weatherAt(options, 777)).toEqual(weatherAt({ ...options }, 777))
  const other = { ...options, generator: { ...options.generator, seed: options.generator.seed + 1 } }
  expect(weatherAt(other, 777).windX).not.toBe(weatherAt(options, 777).windX)
  expect(Array.from({ length: 500 }, (_, i) => weatherAt({ ...options, weather: { changes: false } }, i * 40).precipitation).every((value) => value === 0)).toBe(true)
})

test('параметры погоды переживают сохранение', () => {
  const sim = createSim({ ...options, weather: { startHour: 21, dayLength: 600 } })
  expect(createSim(JSON.parse(JSON.stringify(sim.save()))).options.weather).toEqual({ startHour: 21, dayLength: 600 })
})
