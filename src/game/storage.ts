import type { GeneratorConfig } from '../map/terrain'
import type { SimSave, WeatherOptions } from '../sim'
import { decodeSave, encodeSave, readJson } from '../save/file'

/**
 * Сохранения локальной игры в браузере. Их несколько, у каждого своё место (слот): список с названиями и
 * временем лежит в localStorage отдельно от самих миров, чтобы меню не разбирало их целиком; миры — двоичными
 * файлами (см. src/save/file.ts) в IndexedDB. Камера помнится для каждого слота.
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
/** Мир слота в прежнем формате (JSON в localStorage): такие не переносятся и при первом чтении списка удаляются. */
const jsonSlotKey = (id: string) => `kharos.save.${id}`
const cameraKey = (id: string) => `kharos.camera.${id}`
/** Единственное сохранение самых старых версий — тоже JSON, тоже удаляется. */
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

const has = (key: string) => {
  try {
    return localStorage.getItem(key) !== null
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

/**
 * Где лежат файлы миров: двоичные, по слоту на запись. В браузере — IndexedDB (localStorage строковый и мал для
 * карты); где IndexedDB нет (тесты, сервер), — память процесса.
 */
interface Files {
  get(id: string): Promise<Uint8Array | null>
  put(id: string, file: Uint8Array): Promise<void>
  delete(id: string): Promise<void>
}

function memoryFiles(): Files {
  const files = new Map<string, Uint8Array>()
  return {
    get: async (id) => files.get(id) ?? null,
    put: async (id, file) => void files.set(id, file),
    delete: async (id) => void files.delete(id),
  }
}

function indexedFiles(): Files {
  const STORE = 'saves'
  let opened: Promise<IDBDatabase> | null = null
  const open = () =>
    (opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('kharos', 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }))
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => reject(request.error)
    })
  }
  return {
    get: async (id) => (await run<Uint8Array | undefined>('readonly', (store) => store.get(id))) ?? null,
    put: async (id, file) => void (await run('readwrite', (store) => store.put(file, id))),
    delete: async (id) => void (await run('readwrite', (store) => store.delete(id))),
  }
}

let files: Files | null = null
const store = () => (files ??= typeof indexedDB === 'undefined' ? memoryFiles() : indexedFiles())

/** Тесты подменяют хранилище файлов: каждый начинает с пустого. */
export function resetSaveFiles() {
  files = memoryFiles()
}

const describe = (slot: SaveSlot, save: SimSave): SaveSlot => ({ ...slot, updated: Date.now(), tick: save.tick, size: save.size, seed: save.generator.seed })

/** Слоты от последнего сыгранного к давнему. */
export function listSaves(): SaveSlot[] {
  dropJson()
  const slots = read<SaveSlot[]>(INDEX_KEY)
  return Array.isArray(slots) ? [...slots].sort((a, b) => b.updated - a.updated) : []
}

const storeIndex = (slots: SaveSlot[]) => write(INDEX_KEY, slots)

/** Мир слота id, поднятый до этой версии игры; null — его нет или файл не читается. */
export async function loadSave(id: string): Promise<SimSave | null> {
  try {
    const file = await store().get(id)
    return file ? (await decodeSave(file)).save : null
  } catch {
    return null
  }
}

/** Новый пустой слот: мир в него положит первая присланная воркером запись. */
export function createSlot(name: string, size: number, seed: number, weather?: Partial<WeatherOptions>, generator?: Partial<GeneratorConfig>): SaveSlot {
  const now = Date.now()
  const slot: SaveSlot = { id: crypto.randomUUID(), name, created: now, updated: now, tick: 0, size, seed, ...(weather && { weather }), ...(generator && { generator }) }
  storeIndex([...listSaves(), slot])
  return slot
}

/** Записи по слотам идут по очереди: иначе ранняя, дольше сжимавшаяся, могла бы лечь поверх поздней. */
const writing = new Map<string, Promise<void>>()

/** Кладёт мир в слот id. Слот, удалённый, пока в нём играли, не воскресает. */
export function storeSave(id: string, save: SimSave): Promise<void> {
  const next = (writing.get(id) ?? Promise.resolve()).then(async () => {
    if (!listSaves().some((slot) => slot.id === id)) return
    const file = await encodeSave(save)
    // Пока сжимали, слот могли удалить.
    const slots = listSaves()
    const slot = slots.find((slot) => slot.id === id)
    if (!slot) return
    try {
      await store().put(id, file)
    } catch {
      return
    }
    storeIndex(slots.map((other) => (other === slot ? describe(slot, save) : other)))
  })
  writing.set(id, next)
  return next
}

export function renameSave(id: string, name: string) {
  storeIndex(listSaves().map((slot) => (slot.id === id ? { ...slot, name } : slot)))
}

export function deleteSave(id: string) {
  storeIndex(listSaves().filter((slot) => slot.id !== id))
  remove(cameraKey(id))
  void store().delete(id).catch(() => {})
}

/** Файл для переноса сохранения в другой браузер: тот же двоичный мир, и в нём раздел с названием слота. */
export async function exportSave(id: string): Promise<Uint8Array | null> {
  const slot = listSaves().find((slot) => slot.id === id)
  const save = await loadSave(id)
  return slot && save ? encodeSave(save, { NAME: slot.name }) : null
}

/** Кладёт файл сохранения в новый слот. Бросает ошибку, если файл не сохранение или не читается. */
export async function importSave(file: Uint8Array): Promise<SaveSlot> {
  const { save, sections } = await decodeSave(file)
  const name = readJson<unknown>(sections.get('NAME'))
  const slot = createSlot(typeof name === 'string' && name ? name : 'Загруженная игра', save.size, save.generator.seed)
  await storeSave(slot.id, save)
  return listSaves().find((other) => other.id === slot.id) ?? slot
}

/**
 * Сохранения в прежнем формате — JSON в localStorage — не переносятся: их слоты пропадают из списка вместе с
 * камерой. Слоты, в которые ещё ничего не записано, остаются.
 */
function dropJson() {
  if (has(LEGACY_KEY)) {
    remove(LEGACY_KEY)
    remove(LEGACY_CAMERA_KEY)
  }
  const slots = read<SaveSlot[]>(INDEX_KEY)
  if (!Array.isArray(slots) || !slots.some((slot) => has(jsonSlotKey(slot.id)))) return
  const kept = slots.filter((slot) => {
    if (!has(jsonSlotKey(slot.id))) return true
    remove(jsonSlotKey(slot.id))
    remove(cameraKey(slot.id))
    return false
  })
  storeIndex(kept)
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
