/**
 * Что симуляция знает о ресурсе. Как он называется и выглядит, знает клиент: см. ui/names.ts.
 * Ресурсы лежат на складах (Inventory) и возятся грузовиками; см. inventory.ts и logistics.ts.
 */
export interface ResourceSpec {
  /** Цена единицы при продаже через космопорт, в кредитах. */
  price: number
}

/**
 * Сырьё добывают шахты из месторождений (руду, кремнезём, нефть, харит) и ветряные ловушки из воздуха (воду).
 * Остальное получают переработкой, см. BuildingSpec.recipe. Переработанное продаётся дороже, чем стоило сырьё,
 * ушедшее на него: переработка выгоднее продажи сырья, но требует зданий, энергии и подвоза.
 */
export const RESOURCE_SPECS = {
  ore: { price: 4 },
  silica: { price: 3 },
  oil: { price: 5 },
  // Харит редок и дорог: месторождения его малы, а добыча медленная.
  kharite: { price: 30 },
  water: { price: 1 },
  // 2 руды (8) → металл.
  metal: { price: 12 },
  // 2 кремнезёма и вода (7) → кремний.
  silicon: { price: 12 },
  // 2 нефти и вода (11) → топливо.
  fuel: { price: 15 },
  // 2 металла и кремний (36) → компоненты.
  components: { price: 45 },
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
