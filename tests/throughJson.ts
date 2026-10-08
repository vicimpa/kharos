import type { SimSave } from '../src/sim'

/**
 * Сохранение, пропущенное через JSON, — проверка, что данные переживают диск и сеть. Карта мира двоичная (в файле
 * она — свой раздел, см. src/save/file.ts), её не трогаем.
 */
export function throughJson<T extends SimSave | { sim: SimSave }>(save: T): T {
  const sim = 'sim' in save ? save.sim : save
  const copy = JSON.parse(JSON.stringify(save, (key, value) => (value === sim.land ? undefined : value)))
  if ('sim' in copy) copy.sim.land = sim.land.slice()
  else copy.land = sim.land.slice()
  return copy
}
