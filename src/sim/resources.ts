/**
 * Что симуляция знает о ресурсе. Как он называется и выглядит, знает клиент: см. ui/names.ts.
 * Ресурсы лежат на складах (Inventory) и возятся грузовиками; см. inventory.ts и logistics.ts.
 */
export interface ResourceSpec {
  /** Цена единицы при продаже через космопорт, в кредитах. */
  price: number
}

/**
 * Ресурсы добываются сразу в готовом виде: шахта на месторождении даёт металл, кремний, топливо или харит —
 * смотря что в нём лежит. Переработки пока нет.
 */
export const RESOURCE_SPECS = {
  metal: { price: 4 },
  silicon: { price: 4 },
  fuel: { price: 5 },
  // Харит редок и дорог: месторождения его малы, а добыча медленная.
  kharite: { price: 30 },
} satisfies Record<string, ResourceSpec>

export type Resource = keyof typeof RESOURCE_SPECS
export const RESOURCES = Object.keys(RESOURCE_SPECS) as Resource[]

/** Сколько каких ресурсов: например, цена в материалах или рецепт. */
export type Amounts = Partial<Record<Resource, number>>

/** Что лежит в amounts, парами ресурс — количество, без нулей. */
export const entriesOf = (amounts: Amounts) =>
  (Object.entries(amounts) as [Resource, number][]).filter(([, amount]) => amount > 0)

/** Сколько всего в amounts, всех ресурсов вместе. */
export const totalOf = (amounts: Amounts) => entriesOf(amounts).reduce((sum, [, amount]) => sum + amount, 0)
