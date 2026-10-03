import type { Resource } from '../sim'

/** Цвет ресурса: значок в интерфейсе, груз на транспортном луче, месторождение на карте. */
export const RESOURCE_COLORS: Record<Resource, number> = {
  metal: 0xb8c4d0,
  silicon: 0x7f9cff,
  fuel: 0xffc93c,
  kharite: 0xc06bff,
}

/** Цвет ресурса для CSS. */
export const cssColor = (resource: Resource) => `#${RESOURCE_COLORS[resource].toString(16).padStart(6, '0')}`
