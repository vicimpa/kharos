import { beforeEach, expect, test } from 'bun:test'
import { createSlot, deleteSave, exportSave, importSave, listSaves, loadCamera, loadSave, storeCamera, storeSave } from '../src/game/storage'
import { DEFAULT_SETTINGS } from '../src/map/settings'
import { createSim } from '../src/sim'

const memory = new Map<string, string>()
beforeEach(() => {
  memory.clear()
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  } as Storage
})

const save = () => createSim({ generator: DEFAULT_SETTINGS.generator, size: 256 }).save()

test('слоты: новый пуст, запись описывает его, удалённый не воскресает', () => {
  const slot = createSlot('Первая', 256, 7)
  expect(listSaves().map((other) => other.name)).toEqual(['Первая'])
  expect(loadSave(slot.id)).toBeNull()

  storeSave(slot.id, save())
  expect(loadSave(slot.id)?.size).toBe(256)
  expect(listSaves()[0].seed).toBe(DEFAULT_SETTINGS.generator.seed)
  storeCamera(slot.id, { x: 1, y: 2, zoom: 32 })
  expect(loadCamera(slot.id)).toEqual({ x: 1, y: 2, zoom: 32 })

  deleteSave(slot.id)
  storeSave(slot.id, save())
  expect(listSaves()).toEqual([])
  expect(loadSave(slot.id)).toBeNull()
  expect(loadCamera(slot.id)).toBeNull()
})

test('сохранение прежних версий становится слотом вместе с камерой', () => {
  memory.set('kharos.save', JSON.stringify(save()))
  memory.set('kharos.camera', JSON.stringify({ x: 5, y: 6, zoom: 20 }))
  const [slot] = listSaves()
  expect(slot.name).toBe('Прежняя игра')
  expect(loadSave(slot.id)).not.toBeNull()
  expect(loadCamera(slot.id)?.x).toBe(5)
  expect(memory.has('kharos.save')).toBe(false)
  expect(listSaves().length).toBe(1)
})

test('файл сохранения переносится в новый слот, чужой файл — ошибка', () => {
  const slot = createSlot('Перенос', 256, 1)
  storeSave(slot.id, save())
  const file = JSON.parse(JSON.stringify(exportSave(slot.id)))
  const copy = importSave(file)
  expect(copy.id).not.toBe(slot.id)
  expect(copy.name).toBe('Перенос')
  expect(loadSave(copy.id)).toEqual(loadSave(slot.id))
  expect(() => importSave({ name: 'x', save: { version: -1 } })).toThrow()
})
