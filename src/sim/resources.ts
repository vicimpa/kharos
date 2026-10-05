/**
 * Что симуляция знает о грузе. Как он называется и выглядит, знает клиент: см. ui/names.ts.
 * Груз лежит на складах (Inventory) и возится грузовиками; см. inventory.ts и logistics.ts.
 *
 * Груз бывает трёх родов. Руда — то, что даёт шахта: её не продают и в рецепты она не идёт, только в переработку.
 * Ресурс — то, что выходит с переработки: его продают, из него строят и делают юнитов. Изделие — то, что собирает
 * из ресурсов сборочный цех: его не продают, оно идёт на стройку, в турели и на верхний тир (см. assembly.ts).
 * Ресурсы и изделия вместе — готовое: оно лежит в хранилищах.
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

/**
 * Рецепт изделия: что уходит на одну сборку и сколько штук она даёт. stock — норма: цех собирает, пока изделий
 * в хранилищах его зоны и на складах цехов меньше её. Без нормы цех съел бы всё сырьё зоны и забил хранилища.
 */
export interface ProductSpec {
  recipe: Partial<Record<Resource, number>>
  yield: number
  stock: number
}

/**
 * Изделия сборочного цеха — по одному на каждую петлю игры (§3.7 design.md): стройблоки — стройке, боеприпасы —
 * турелям, компоненты — верхнему тиру. Их не продают: космопорт торгует только ресурсами. Нормы — на два машинных
 * завода, на полную перезарядку одной турели (цех делает 10 патронов в секунду и быстро её восполнит) и на два
 * разрядника.
 */
export const PRODUCT_SPECS = {
  blocks: { recipe: { metal: 2, silicon: 1 }, yield: 1, stock: 20 },
  ammo: { recipe: { metal: 1 }, yield: 10, stock: 120 },
  parts: { recipe: { silicon: 2, kharite: 1 }, yield: 1, stock: 6 },
} satisfies Record<string, ProductSpec>

export type Product = keyof typeof PRODUCT_SPECS
export const PRODUCTS = Object.keys(PRODUCT_SPECS) as Product[]
export const productSpec = (product: Product): ProductSpec => PRODUCT_SPECS[product]

/** На сколько сборок цех держит сырьё про запас: больше он у зоны не просит. */
const STOCKED_CYCLES = 4

/** Сколько какого сырья цех держит под рецепт: столько он и заказывает у зоны. */
export const stockedFor = (product: Product): Amounts =>
  Object.fromEntries(Object.entries(productSpec(product).recipe).map(([resource, amount]) => [resource, amount * STOCKED_CYCLES]))

/** Готовое: ресурсы и изделия. Его хранят хранилища и тратят стройки и производство. */
export type Ware = Resource | Product
export const WARES: Ware[] = [...RESOURCES, ...PRODUCTS]

/** Всё, что лежит на складах, — и руда, и готовое. */
export type Good = Ware | Ore
export const GOODS: Good[] = [...WARES, ...ORES]

/** Руда это или готовое: руду в рецепты не берут, готовое в переработку не кладут. */
export const isOre = (good: Good): good is Ore => ORES.includes(good as Ore)

/** Изделие ли это: его собирает цех и не продаёт космопорт. */
export const isProduct = (good: Good): good is Product => PRODUCTS.includes(good as Product)

/** Сколько чего угодно: например, цена в материалах, рецепт или содержимое склада. */
export type Amounts = Partial<Record<Good, number>>

/** Что лежит в amounts, парами груз — количество, без нулей. */
export const entriesOf = (amounts: Amounts) =>
  (Object.entries(amounts) as [Good, number][]).filter(([, amount]) => amount > 0)

/** Сколько всего в amounts, всего груза вместе. */
export const totalOf = (amounts: Amounts) => entriesOf(amounts).reduce((sum, [, amount]) => sum + amount, 0)
