import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { FIRST_BINARY_VERSION, decodeSave, encodeSave, jsonSection, packSections, readJson, unpackSections } from '../src/save/file'
import { SAVE_VERSION, createSim, spawnStartingUnits } from '../src/sim'

const world = () => {
  const sim = createSim({ generator: DEFAULT_SETTINGS.generator, size: 256, weather: { startHour: 9 } })
  spawnStartingUnits(sim, 1, 0, 0)
  sim.advance(1)
  return sim.save()
}

test('мир переживает файл без потерь, и из файла продолжается тот же', async () => {
  const save = world()
  const { save: loaded } = await decodeSave(await encodeSave(save))
  expect(loaded).toEqual(save)
  expect(createSim(loaded).save()).toEqual(save)
})

test('свои разделы вызывающего доходят, незнакомые не мешают', async () => {
  const { sections } = await decodeSave(await encodeSave(world(), { HOST: { players: { a: 1 } }, ZZZZ: 'потом' }))
  expect(readJson(sections.get('HOST'))).toEqual({ players: { a: 1 } })
})

test('не сохранение, прежний JSON и версия новее игры — ошибки', async () => {
  await expect(decodeSave(new TextEncoder().encode(JSON.stringify(world())))).rejects.toThrow('не файл сохранения')
  const sections = new Map([['META', jsonSection({})]])
  await expect(unpackSections(await packSections(sections, FIRST_BINARY_VERSION - 1))).rejects.toThrow('старой')
  await expect(unpackSections(await packSections(sections, SAVE_VERSION + 1))).rejects.toThrow('новой')
})

test('повреждённое тело — ошибка, а не мусорный мир', async () => {
  const file = await encodeSave(world())
  await expect(decodeSave(file.subarray(0, file.length >> 1))).rejects.toThrow()
})
