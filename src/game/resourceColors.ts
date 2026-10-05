import type { Good } from '../sim'

/**
 * Цвет груза: значок в интерфейсе, груз на транспортном луче, месторождение на карте. У руды те же цвета,
 * что у её ресурса, только приглушённые: руда — сырьё, готовое — ярче. Изделия цветом не повторяют ресурсы:
 * стройблоки — бетон, боеприпасы — латунь, компоненты — зелень плат.
 */
export const GOOD_COLORS: Record<Good, number> = {
  metal: 0xb8c4d0,
  silicon: 0x7f9cff,
  fuel: 0xffc93c,
  kharite: 0xc06bff,
  blocks: 0xd8b98a,
  ammo: 0xe0803a,
  parts: 0x4fd6a2,
  metalOre: 0x8d7a5f,
  siliconOre: 0x5a6a8a,
  fuelOre: 0x8a7a2a,
  khariteOre: 0x7a4a9a,
}

/** Цвет груза для CSS. */
export const cssColor = (resource: Good) => `#${GOOD_COLORS[resource].toString(16).padStart(6, '0')}`
