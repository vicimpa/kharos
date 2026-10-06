import type { GeneratorConfig } from '../map/terrain'
import { SAVE_VERSION, type SimSave, type WeatherOptions } from '../sim'

/**
 * Сохранения локальной игры в браузере. Их несколько, у каждого своё место (слот): список с названиями и
 * временем лежит отдельно от самих миров, чтобы меню не разбирало их целиком. Камера помнится для каждого слота.
 */
export interface SaveSlot {
  id: string
  name: string
  /** Когда слот создан и когда в него последний раз писали, в миллисекундах эпохи. */
  created: number
  updated: number
  /** Сколько тиков прошло в мире: по нему меню показывает время игры. */
  tick: number
  /** Сторона карты и зерно местности — чтобы отличать миры в списке. */
  size: number
  seed: number
  /** Погода нового мира: пока мир слота не сохранён, он заводится с ней. Дальше она лежит в самом сохранении. */
  weather?: Partial<WeatherOptions>
  /** Местность нового мира, отличия от генератора по умолчанию; зерно — в seed. Как и погода, нужна до первого сохранения. */
  generator?: Partial<GeneratorConfig>
}

const INDEX_KEY = 'kharos.saves'
const slotKey = (id: string) => `kharos.save.${id}`
const cameraKey = (id: string) => `kharos.camera.${id}`
/** Единственное сохранение старых версий: при первом чтении списка оно становится слотом. */
const LEGACY_KEY = 'kharos.save'
const LEGACY_CAMERA_KEY = 'kharos.camera'

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

/** Пишет значение; false — хранилище недоступно или переполнено. */
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

const remove = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // Недоступное хранилище и так пусто.
  }
}

const describe = (slot: SaveSlot, save: SimSave): SaveSlot => ({ ...slot, updated: Date.now(), tick: save.tick, size: save.size, seed: save.generator.seed })

/** Слоты от последнего сыгранного к давнему. */
export function listSaves(): SaveSlot[] {
  migrate()
  const slots = read<SaveSlot[]>(INDEX_KEY)
  return Array.isArray(slots) ? [...slots].sort((a, b) => b.updated - a.updated) : []
}

const storeIndex = (slots: SaveSlot[]) => write(INDEX_KEY, slots)

/** Мир слота id, если он есть и подходит этой версии игры; иначе null. */
export function loadSave(id: string): SimSave | null {
  const save = read<SimSave>(slotKey(id))
  return save?.version === SAVE_VERSION ? save : null
}

/** Новый пустой слот: мир в него положит первая присланная воркером запись. */
export function createSlot(name: string, size: number, seed: number, weather?: Partial<WeatherOptions>, generator?: Partial<GeneratorConfig>): SaveSlot {
  const now = Date.now()
  const slot: SaveSlot = { id: crypto.randomUUID(), name, created: now, updated: now, tick: 0, size, seed, ...(weather && { weather }), ...(generator && { generator }) }
  storeIndex([...listSaves(), slot])
  return slot
}

/** Кладёт мир в слот id. Слот, удалённый, пока в нём играли, не воскресает. */
export function storeSave(id: string, save: SimSave) {
  const slots = listSaves()
  const slot = slots.find((slot) => slot.id === id)
  if (!slot) return
  if (!write(slotKey(id), save)) return
  storeIndex(slots.map((other) => (other === slot ? describe(slot, save) : other)))
}

export function renameSave(id: string, name: string) {
  storeIndex(listSaves().map((slot) => (slot.id === id ? { ...slot, name } : slot)))
}

export function deleteSave(id: string) {
  storeIndex(listSaves().filter((slot) => slot.id !== id))
  remove(slotKey(id))
  remove(cameraKey(id))
}

/** Файл для переноса сохранения в другой браузер: название слота и сам мир. */
export interface SaveFile {
  name: string
  save: SimSave
}

export function exportSave(id: string): SaveFile | null {
  const slot = listSaves().find((slot) => slot.id === id)
  const save = loadSave(id)
  return slot && save ? { name: slot.name, save } : null
}

/** Кладёт файл сохранения в новый слот. Бросает ошибку, если файл не сохранение этой версии. */
export function importSave(file: unknown): SaveSlot {
  const { name, save } = (file ?? {}) as Partial<SaveFile>
  if (!save || save.version !== SAVE_VERSION) throw new Error('Это не сохранение или оно от другой версии игры')
  const slot = createSlot(typeof name === 'string' && name ? name : 'Загруженная игра', save.size, save.generator.seed)
  storeSave(slot.id, save)
  return listSaves().find((other) => other.id === slot.id) ?? slot
}

function migrate() {
  const legacy = read<SimSave>(LEGACY_KEY)
  if (!legacy) return
  remove(LEGACY_KEY)
  if (legacy.version !== SAVE_VERSION) return
  const now = Date.now()
  const slot: SaveSlot = describe({ id: crypto.randomUUID(), name: 'Прежняя игра', created: now, updated: now, tick: 0, size: 0, seed: 0 }, legacy)
  const slots = read<SaveSlot[]>(INDEX_KEY) ?? []
  if (!write(slotKey(slot.id), legacy)) return
  storeIndex([...slots, slot])
  const camera = read<CameraSave>(LEGACY_CAMERA_KEY)
  if (camera) write(cameraKey(slot.id), camera)
  remove(LEGACY_CAMERA_KEY)
}

/** Куда смотрела камера: центр экрана в тайлах и масштаб. */
export interface CameraSave {
  x: number
  y: number
  zoom: number
}

/** Сохранённое место камеры в слоте id или null, если его нет или оно испорчено. */
export function loadCamera(id: string): CameraSave | null {
  const saved = read<Partial<CameraSave>>(cameraKey(id))
  if (!saved || ![saved.x, saved.y, saved.zoom].every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  return saved as CameraSave
}

export function storeCamera(id: string, { x, y, zoom }: CameraSave) {
  write(cameraKey(id), { x, y, zoom })
}
