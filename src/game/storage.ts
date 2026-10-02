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

export function storeSave(save: SimSave) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // Хранилище недоступно или переполнено — играем без сохранения.
  }
}
