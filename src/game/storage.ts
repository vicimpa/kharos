import { SAVE_VERSION, type SimOptions, type SimSave } from '../sim'

const STORAGE_KEY = 'kharos.save'

/** Сохранение из браузера, если оно есть и сделано с теми же параметрами мира; иначе null. */
export function loadSave(options: SimOptions): SimSave | null {
  try {
    const save = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as SimSave | null
    if (save?.version !== SAVE_VERSION) return null
    // Другой генератор — другая местность: здания из сохранения оказались бы где попало.
    if (save.size !== options.size || JSON.stringify(save.generator) !== JSON.stringify(options.generator)) return null
    return save
  } catch {
    return null
  }
}

const CAMERA_KEY = 'kharos.camera'

/** Куда смотрела камера: центр экрана в тайлах и масштаб. */
export interface CameraSave {
  x: number
  y: number
  zoom: number
}

/** Сохранённое место камеры или null, если его нет или оно испорчено. */
export function loadCamera(): CameraSave | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? 'null') as Partial<CameraSave> | null
    if (!saved || ![saved.x, saved.y, saved.zoom].every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    return saved as CameraSave
  } catch {
    return null
  }
}

export function storeCamera({ x, y, zoom }: CameraSave) {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify({ x, y, zoom }))
  } catch {
    // Хранилище недоступно — камера просто начнёт с начала мира.
  }
}

export function storeSave(save: SimSave) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // Хранилище недоступно или переполнено — играем без сохранения.
  }
}
