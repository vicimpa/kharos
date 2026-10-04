/**
 * Что симуляция знает о грузе. Как он называется и выглядит, знает клиент: см. ui/names.ts.
 * Груз лежит на складах (Inventory) и возится грузовиками; см. inventory.ts и logistics.ts.
 *
 * Груз бывает двух родов. Руда — то, что даёт шахта: её не продают и в рецепты она не идёт, только в переработку.
 * Готовый ресурс — то, что выходит с переработки: его продают, из него строят и делают юнитов.
 */
export interface ResourceSpec {
  /** Цена единицы при продаже через космопорт, в кредитах. */
  price: number
}

/**
 * Готовые ресурсы: их продают через космопорт, из них строят здание и делают технику. Продажа — основной источник
 * кредитов, поэтому сырьё стоит дорого. Цены подняты вдвое (§4.3 шаг 1): линия добычи приносит вдвое больше,
 * а доля материалов в цене техники становится заметной.
 */
export const RESOURCE_SPECS = {
  metal: { price: 10 },
  silicon: { price: 10 },
  fuel: { price: 12 },
  // Харит редок и дорог: месторождения его малы, а добыча медленная.
  kharite: { price: 60 },
} satisfies Record<string, ResourceSpec>

export type Resource = keyof typeof RESOURCE_SPECS
export const RESOURCES = Object.keys(RESOURCE_SPECS) as Resource[]

/** Виды руды и то, что из них выходит на переработке. */
export const ORE_SPECS = {
  metalOre: { resource: 'metal' },
  siliconOre: { resource: 'silicon' },
  fuelOre: { resource: 'fuel' },
  khariteOre: { resource: 'kharite' },
} satisfies Record<string, { resource: Resource }>

export type Ore = keyof typeof ORE_SPECS
export const ORES = Object.keys(ORE_SPECS) as Ore[]

/** Что выходит из этого вида руды: переработка делает из руды металла металл. */
export const resourceOf = (ore: Ore): Resource => ORE_SPECS[ore].resource

/** Чем добывают этот ресурс: месторождение металла даёт металлическую руду. */
export const ORE_OF = Object.fromEntries(ORES.map((ore) => [ORE_SPECS[ore].resource, ore])) as Record<Resource, Ore>

/** Всё, что лежит на складах, — и руда, и готовое. */
export type Good = Resource | Ore
export const GOODS: Good[] = [...RESOURCES, ...ORES]

/** Руда это или готовый ресурс: руду в рецепты не берут, готовое в переработку не кладут. */
export const isOre = (good: Good): good is Ore => ORES.includes(good as Ore)

/** Сколько чего угодно: например, цена в материалах, рецепт или содержимое склада. */
export type Amounts = Partial<Record<Good, number>>

/** Что лежит в amounts, парами груз — количество, без нулей. */
export const entriesOf = (amounts: Amounts) =>
  (Object.entries(amounts) as [Good, number][]).filter(([, amount]) => amount > 0)

/** Сколько всего в amounts, всего груза вместе. */
export const totalOf = (amounts: Amounts) => entriesOf(amounts).reduce((sum, [, amount]) => sum + amount, 0)
