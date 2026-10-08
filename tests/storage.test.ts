import { beforeEach, expect, test } from 'bun:test'
import { createSlot, deleteSave, exportSave, importSave, listSaves, loadCamera, loadSave, resetSaveFiles, storeCamera, storeSave } from '../src/game/storage'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim } from '../src/sim'

const memory = new Map<string, string>()
beforeEach(() => {
  memory.clear()
  resetSaveFiles()
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  } as Storage
})

const save = () => createSim({ generator: DEFAULT_SETTINGS.generator, size: 256 }).save()

test('слоты: новый пуст, запись описывает его, удалённый не воскресает', async () => {
  const slot = createSlot('Первая', 256, 7)
  expect(listSaves().map((other) => other.name)).toEqual(['Первая'])
  expect(await loadSave(slot.id)).toBeNull()

  await storeSave(slot.id, save())
  expect((await loadSave(slot.id))?.size).toBe(256)
  expect(listSaves()[0].seed).toBe(DEFAULT_SETTINGS.generator.seed)
  storeCamera(slot.id, { x: 1, y: 2, zoom: 32 })
  expect(loadCamera(slot.id)).toEqual({ x: 1, y: 2, zoom: 32 })

  deleteSave(slot.id)
  await storeSave(slot.id, save())
  expect(listSaves()).toEqual([])
  expect(await loadSave(slot.id)).toBeNull()
  expect(loadCamera(slot.id)).toBeNull()
})

test('сохранения прежнего формата (JSON) не переносятся: их слоты пропадают, пустые слоты остаются', () => {
  memory.set('kharos.save', JSON.stringify(save()))
  memory.set('kharos.camera', JSON.stringify({ x: 5, y: 6, zoom: 20 }))
  memory.set('kharos.saves', JSON.stringify([
    { id: 'old', name: 'Старая', created: 1, updated: 1, tick: 5, size: 256, seed: 1 },
    { id: 'empty', name: 'Пустая', created: 1, updated: 1, tick: 0, size: 256, seed: 1 },
  ]))
  memory.set('kharos.save.old', JSON.stringify(save()))
  memory.set('kharos.camera.old', JSON.stringify({ x: 1, y: 1, zoom: 20 }))
  expect(listSaves().map((slot) => slot.id)).toEqual(['empty'])
  expect([...memory.keys()].sort()).toEqual(['kharos.saves'])
})

test('файл сохранения переносится в новый слот, чужой файл — ошибка', async () => {
  const slot = createSlot('Перенос', 256, 1)
  await storeSave(slot.id, save())
  const file = await exportSave(slot.id)
  const copy = await importSave(file!)
  expect(copy.id).not.toBe(slot.id)
  expect(copy.name).toBe('Перенос')
  expect(await loadSave(copy.id)).toEqual(await loadSave(slot.id))
  await expect(importSave(new TextEncoder().encode('{"version":19}'))).rejects.toThrow()
})
