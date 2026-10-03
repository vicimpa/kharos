import type { Resource } from '../sim'

/** Цвет ресурса: значок в интерфейсе, груз на транспортном луче, месторождение на карте. */
export const RESOURCE_COLORS: Record<Resource, number> = {
  ore: 0xe58a4a,
  silica: 0xe8e2c8,
  oil: 0x6b5f7d,
  kharite: 0xc06bff,
  water: 0x5ab8ff,
  metal: 0xb8c4d0,
  silicon: 0x7f9cff,
  fuel: 0xffc93c,
  components: 0x6ee08a,
}

/** Цвет ресурса для CSS. */
export const cssColor = (resource: Resource) => `#${RESOURCE_COLORS[resource].toString(16).padStart(6, '0')}`
