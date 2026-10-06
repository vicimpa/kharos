import { expect, test } from 'bun:test'
import { defaultSettings, mergeSettings } from '../server/settings'
import { needsRenewal, sslipName } from '../server/tls'

test('настройки сервера: известное берётся, опечатки и чужие типы пропускаются с предупреждением', () => {
  const defaults = defaultSettings()
  const warnings: string[] = []
  const settings = mergeSettings(
    defaults,
    { save: 'arena.json', size: 512, fog: false, generator: { seed: 42, zoneScale: 'big' }, rules: { repairSpeed: 2, nope: 1 }, prot: 1 },
    warnings,
  )
  expect(settings.save).toBe('arena.json')
  expect(settings.size).toBe(512)
  expect(settings.fog).toBe(false)
  expect(settings.generator.seed).toBe(42)
  expect(settings.generator.zoneScale).toBe(defaults.generator.zoneScale)
  expect(settings.port).toBe(defaults.port)
  expect(settings.rules.repairSpeed).toBe(2)
  expect(warnings).toEqual(['generator.zoneScale: ожидалось number', 'rules.nope: неизвестный параметр', 'prot: неизвестный параметр'])
  // Значения по умолчанию не тронуты.
  expect(defaults.save).toBe('save.json')
})

test('не объект вместо настроек — всё по умолчанию', () => {
  const defaults = defaultSettings()
  const warnings: string[] = []
  expect(mergeSettings(defaults, [1, 2], warnings)).toEqual(defaults)
  expect(warnings).toEqual(['настройки: ожидался объект'])
})

test('tls: имя sslip.io по IP и срок продления', () => {
  expect(sslipName('1.2.3.4')).toBe('1-2-3-4.sslip.io')
  const now = new Date('2026-01-01')
  expect(needsRenewal(new Date('2026-03-01'), now)).toBe(false)
  expect(needsRenewal(new Date('2026-01-20'), now)).toBe(true)
})
