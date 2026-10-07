import type { HudState, Stack } from '../game/hud'
import type { PaveIcon } from '../game/portraits'
import type { PaveTool } from '../game/scene'
import { BRIDGE_COST, BUILDING_TYPES, DEPOSIT_TYPES, REQUIRES, FOUNDATION_COST, LEASH, ORES, ROAD_COST, WARES, type Stance, type BuildingType, type Command, type DepositKind, type Good } from '../sim'
import { BUILDING_INFO, BUILDING_NAMES, RESOURCE_NAMES, UNIT_NAMES, goodName } from './names'

/** Клавиши ячеек сетки команд по порядку: три ряда по четыре, как на клавиатуре, справа от WASD. */
export const GRID_KEYS = ['KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyB', 'KeyN', 'KeyM', 'Comma'] as const
/** Подпись клавиши на кнопке. */
export const keyLabel = (code: string) => (code === 'Comma' ? ',' : code.slice(3))
export const GRID_SIZE = GRID_KEYS.length
/** Постоянные места: превращение, отмена заказа, разбор, назад. Так рука привыкает к ним. */
const CONVERT = 8
const CANCEL = 9
const DEMOLISH = 10
const BACK = 11
/** Кнопки продажи и закупки космопорта: начало нижнего ряда. Отмена заказа техники у космопорта тогда — на месте «Назад». */
const TRADE = 8
/** Сколько ячеек сверху отдаётся под списки: заказы, здания, рецепты. */
const LIST = 8

/** Страница сетки строителя: корень с разделами или сами здания раздела. */
export type Page = 'root' | 'economy' | 'storage' | 'industry' | 'military' | 'defense' | 'paving' | 'filter' | 'sell' | 'buy'

/** Разделы строителя: в какой странице какое здание. Остальное — хозяйство: энергия, добыча, торговля. */
const SECTIONS: Partial<Record<Page, BuildingType[]>> = {
  storage: ['metalYard', 'siliconStore', 'fuelTank', 'khariteVault', 'blockYard', 'ammoBunker', 'partsLocker'],
  industry: ['smelter', 'siliconWorks', 'distillery', 'enricher', 'blockPlant', 'ammoPlant', 'partsPlant'],
  military: ['barracks', 'factory', 'airfield', 'techCenter'],
  defense: ['wall', 'turret', 'rocketTurret', 'cannonTurret', 'laserTurret', 'radar'],
}
/** Описание здания для карточки: что делает и какие здания открывает. */
function aboutOf(building: BuildingType) {
  const opens = BUILDING_TYPES.filter((type) => REQUIRES[type]?.includes(building))
  return opens.length ? `${BUILDING_INFO[building]}. Открывает: ${opens.map((type) => BUILDING_NAMES[type]).join(', ')}` : BUILDING_INFO[building]
}

const sectionOf = (building: BuildingType): Page =>
  (Object.keys(SECTIONS) as Page[]).find((page) => SECTIONS[page]!.includes(building)) ?? 'economy'

/** Ячейка сетки команд. */
export interface Slot {
  label: string
  /** Картинка: портрет здания или юнита, либо значок груза. */
  building?: BuildingType
  unit?: HudState['units'][number]['type']
  good?: Good
  /** Значок покрытия. */
  pave?: PaveIcon
  cost?: number
  /** cost — не трата, а доход: продажа, возврат за разбор. */
  gain?: boolean
  power?: number
  materials?: Stack[]
  disabled?: boolean
  active?: boolean
  /** Что это такое: описание на карточке. */
  about?: string
  /** Пояснение или почему кнопка недоступна. */
  title?: string
  run(): void
}

interface Actions {
  send: (command: Command) => void
  place: (building: BuildingType | null) => void
  pave: (tool: PaveTool | null) => void
  route: (start: boolean) => void
  patrol: (start: boolean) => void
  open: (page: Page) => void
}

/** Кнопки стоек: подпись и подсказка. */
const STANCE_SLOTS: { stance: Stance; label: string; title: string }[] = [
  { stance: 'aggressive', label: 'Агрессивно', title: 'Идти на любого врага, которого видно, и гнаться за ним' },
  { stance: 'defensive', label: 'Оборона', title: `Бить тех, кого достаёт; на огонь отвечать погоней не дальше ${LEASH} тайлов и возвращаться на место` },
  { stance: 'hold', label: 'Держать позицию', title: 'С места не сходить: бить только тех, кого достаёт, и под огнём тоже' },
  { stance: 'passive', label: 'Не стрелять', title: 'Огонь не открывать и не отвечать: стрелять только по приказу атаки' },
]

/** Инструменты раздела «Покрытие»: подпись, цена тайла и подсказка. */
const PAVE_TOOLS: { tool: PaveTool; label: string; cost?: number; title: string }[] = [
  { tool: 'foundation', label: 'Фундамент', cost: FOUNDATION_COST, title: 'Здания на нём строятся вдвое быстрее, на песке он разрешает стройку; полоса от зоны расширяет её на клетку вокруг — так соединяют зоны. Взрывы его разбивают. Тяни мышью прямоугольник' },
  { tool: 'road', label: 'Дорога', cost: ROAD_COST, title: `Наземные едут быстрее; по болоту — мост за ${BRIDGE_COST} за тайл. Тяни мышью линию` },
  { tool: 'remove', label: 'Снять', title: 'Строители разберут своё покрытие; недостроенное отменится с возвратом кредитов. Тяни мышью прямоугольник' },
]

/** Сетка команд для выбранного: GRID_SIZE ячеек, пустые — null. */
export function commandsOf(state: HudState, page: Page, { send, place, pave, route, patrol, open }: Actions): (Slot | null)[] {
  const slots: (Slot | null)[] = Array(GRID_SIZE).fill(null)
  const list = (items: Slot[]) => items.slice(0, LIST).forEach((slot, i) => (slots[i] = slot))
  const { construction, production, conversion, assembly, trade, site, demolish, credits } = state

  if (construction) {
    if (page === 'root') {
      // Раздел появляется, когда в нём открыто хоть одно здание; покрытие доступно всегда.
      const opened = (page: Page) => construction.options.some(({ building }) => sectionOf(building) === page)
      const sections: (Slot & { page: Page })[] = [
        { page: 'economy', label: 'Хозяйство', building: 'generator', title: 'Энергия, добыча и торговля', run: () => open('economy') },
        { page: 'storage', label: 'Склады', building: 'metalYard', title: 'Хранилища ресурсов и изделий', run: () => open('storage') },
        { page: 'industry', label: 'Переработка', building: 'smelter', title: 'Переработка руды и заводы изделий', run: () => open('industry') },
        { page: 'military', label: 'Военное', building: 'factory', title: 'Казармы, заводы, аэродром и техцентр', run: () => open('military') },
        { page: 'defense', label: 'Оборона', building: 'turret', title: 'Стены, турели и радар', run: () => open('defense') },
      ]
      list([
        ...sections.filter(({ page }) => opened(page)),
        { label: 'Покрытие', pave: 'road', title: 'Фундамент, дороги и мосты', run: () => open('paving') },
      ])
    } else if (page === 'paving') {
      PAVE_TOOLS.forEach(({ tool, label, cost, title }, i) => {
        const active = construction.paving?.tool === tool
        slots[i] = {
          label,
          pave: tool,
          cost: active && construction.paving!.tiles > 1 ? construction.paving!.cost : cost,
          active,
          disabled: tool !== 'remove' && cost !== undefined && credits < cost,
          title,
          run: () => pave(active ? null : tool),
        }
      })
      slots[BACK] = {
        label: 'Назад',
        title: 'К разделам; Esc отменяет укладку',
        run: () => {
          pave(null)
          open('root')
        },
      }
    } else {
      const wanted = construction.options.filter(({ building }) => sectionOf(building) === page)
      wanted.slice(0, BACK).forEach(({ building, cost, affordable, power, materials }, i) => {
        slots[i] = {
          label: BUILDING_NAMES[building],
          building,
          cost,
          power,
          materials,
          active: construction.placing === building,
          about: aboutOf(building),
          disabled: !affordable,
          title: affordable ? undefined : 'Не хватает кредитов',
          run: () => place(construction.placing === building ? null : building),
        }
      })
      slots[BACK] = {
        label: 'Назад',
        title: 'К разделам; Esc отменяет выбор места',
        run: () => {
          place(null)
          open('root')
        },
      }
    }
  }

  // Страницы торговли закрывают собой заказ техники и разбор.
  if (production && page === 'root') {
    list(
      production.options.map(({ unit, cost, affordable, materials, missing }) => ({
        label: UNIT_NAMES[unit],
        unit,
        cost,
        materials,
        disabled: !affordable || production.full || missing.length > 0,
        title: missing.length
          ? `Нужно построить: ${missing.map((type) => BUILDING_NAMES[type]).join(', ')}`
          : production.full ? 'Очередь заполнена' : affordable ? undefined : 'Не хватает кредитов',
        run: () => send({ type: 'produce', producer: production.producer, unit }),
      })),
    )
    if (production.queue.length) {
      slots[trade ? BACK : CANCEL] = {
        label: 'Отменить заказ',
        title: 'Последний в очереди; кредиты вернутся',
        run: () => send({ type: 'cancelProduction', producer: production.producer }),
      }
    }
  }

  if (conversion) {
    if (conversion.progress === null) {
      slots[CONVERT] = {
        label: conversion.kind === 'deploy' ? 'Развернуть' : 'Свернуть в MCV',
        building: 'command',
        about: conversion.kind === 'deploy' ? BUILDING_INFO.command : undefined,
        disabled: !conversion.possible,
        title: conversion.possible ? undefined : 'Нужна свободная скала или фундамент 3×3 под машиной',
        run: () => send(conversion.command),
      }
    } else if (conversion.cancel) {
      const cancel = conversion.cancel
      slots[CANCEL] = { label: 'Отменить', run: () => send(cancel) }
    }
  }

  const { tactics } = state
  if (tactics && !construction && page === 'root') {
    const { units } = tactics
    STANCE_SLOTS.forEach(({ stance, label, title }, i) => {
      slots[i] = { label, active: tactics.stance === stance, title, run: () => send({ type: 'stance', units, stance }) }
    })
    slots[4] = {
      label: 'Патруль',
      active: tactics.picking || tactics.patrolling > 0,
      title: 'P, потом щелчок по карте — бойцы ходят между своим местом и точкой; Shift+щелчок — ещё точка к патрулю',
      run: () => patrol(!tactics.picking),
    }
  }

  const { haul } = state
  if (haul && !construction) {
    const { units, filter } = haul
    if (page === 'root') {
      slots[0] = {
        label: haul.routing === null ? 'Маршрут' : `Маршрут: ${haul.routing}`,
        active: haul.routing !== null,
        title: 'Щёлкай по своим зданиям со складом по порядку; правая кнопка или Enter — готово, Esc — отмена',
        run: () => route(haul.routing === null),
      }
      if (haul.routed > 0) {
        slots[1] = { label: 'Снять маршрут', title: 'Грузовики вернутся к заявкам зон', run: () => send({ type: 'route', units, stops: [] }) }
      }
      slots[2] = {
        label: filter.length ? `Фильтр: ${filter.length}` : 'Фильтр',
        active: filter.length > 0,
        title: 'Какие грузы возить по заявкам и маршруту',
        run: () => open('filter'),
      }
    } else if (page === 'filter') {
      /** Руда в фильтре — вся сразу: по видам её различает месторождение, а не игрок. */
      const has = (goods: readonly Good[]) => goods.every((good) => filter.includes(good))
      const toggle = (goods: readonly Good[]) => {
        const next = has(goods) ? filter.filter((good) => !goods.includes(good)) : [...filter, ...goods.filter((good) => !filter.includes(good))]
        send({ type: 'filter', units, goods: next })
      }
      WARES.forEach((ware, i) => {
        slots[i] = { label: goodName(ware), good: ware, active: has([ware]), title: 'Возить или нет', run: () => toggle([ware]) }
      })
      slots[WARES.length] = { label: 'Руда', good: ORES[0], active: has(ORES), title: 'Возить руду или нет', run: () => toggle(ORES) }
      slots[CANCEL] = { label: 'Всё', active: !filter.length, title: 'Снять фильтр: возить любые грузы', run: () => send({ type: 'filter', units, goods: [] }) }
      slots[BACK] = { label: 'Назад', run: () => open('root') }
    }
  }

  const { harvest } = state
  if (harvest && page === 'root') {
    // Поиск месторождения: любого или своего вида, по столбцу на вид.
    const seek = (kind: DepositKind | 'any') => send({ type: 'seek', units: harvest.units, kind })
    slots[0] = { label: 'Искать любое', active: harvest.seek === 'any' && !harvest.parked, title: 'Ближайшее найденное месторождение; нет — разведать', run: () => seek('any') }
    DEPOSIT_TYPES.forEach((kind, i) => {
      slots[1 + i] = {
        label: `Искать: ${RESOURCE_NAMES[kind].toLowerCase()}`,
        good: kind,
        active: harvest.seek === kind && !harvest.parked,
        title: 'Ближайшее найденное месторождение этого вида; нет — разведать',
        run: () => seek(kind),
      }
    })
  }

  if (assembly) {
    slots[0] = {
      label: assembly.on ? 'Выключить' : 'Включить',
      good: assembly.recipe,
      active: assembly.on,
      title: assembly.on
        ? 'Начатая сборка доделается, новых не будет; сырьё увезут в хранилища'
        : 'Завод начнёт заказывать сырьё у зоны и собирать до нормы',
      run: () => send({ type: 'work', building: assembly.plant, on: !assembly.on }),
    }
  }

  if (trade) {
    const { port, order } = trade
    // Продажа и закупка — каждая на своей странице: верхний ряд корня космопорта занят заказом техники.
    if (page === 'root') {
      slots[TRADE] = {
        label: 'Продажа',
        building: 'spaceport',
        active: !!order,
        title: order ? 'Идёт продажа: открыть заявку' : 'Продать ресурсы с орбиты',
        run: () => open('sell'),
      }
      slots[TRADE + 1] = {
        label: 'Закупка',
        building: 'spaceport',
        disabled: !!order,
        title: order ? 'Космопорт занят продажей' : 'Заказать ресурсы с орбиты втрое дороже цены продажи',
        run: () => open('buy'),
      }
    } else if (!order && page === 'buy') {
      // Закупка: верхний ряд — по 10, второй — по 50; столбец на каждый ресурс.
      trade.purchases.slice(0, 4).forEach(({ resource, price, room }, i) => {
        for (const [row, amount] of [[0, 10], [1, 50]] as const) {
          const cost = amount * price
          slots[i + row * 4] = {
            label: `${RESOURCE_NAMES[resource]} ×${amount}`,
            good: resource,
            cost,
            disabled: credits < cost || room < amount,
            title: room < amount ? 'Не помещается в склад космопорта' : credits < cost ? 'Не хватает кредитов' : `По ${price} за единицу, корабль прилетит через 20 с`,
            run: () => send({ type: 'buy', port, resource, amount }),
          }
        }
      })
      slots[BACK] = { label: 'Назад', run: () => open('root') }
    } else if (!order) {
      // Верхний ряд — продать полсотни, второй — всё, что есть: столбец на каждый ресурс.
      trade.offers.slice(0, 4).forEach(({ resource, available, price }, i) => {
        const part = Math.min(50, available)
        slots[i] = {
          label: `${RESOURCE_NAMES[resource]} ×${part}`,
          good: resource,
          cost: part * price,
          gain: true,
          title: `По ${price} за единицу`,
          run: () => send({ type: 'sell', port, resource, amount: part }),
        }
        if (available > part) {
          slots[i + 4] = {
            label: `${RESOURCE_NAMES[resource]}: всё`,
            good: resource,
            cost: available * price,
            gain: true,
            title: `${available} по ${price}`,
            run: () => send({ type: 'sell', port, resource, amount: available }),
          }
        }
      })
      slots[BACK] = { label: 'Назад', run: () => open('root') }
    } else {
      if (order.flight === null) {
        slots[CANCEL] = {
          label: order.delivered > 0 ? 'Отправить' : 'Снять заявку',
          title: order.delivered > 0 ? 'Корабль улетит с тем, что уже привезли' : undefined,
          run: () => send({ type: 'closeSale', port }),
        }
      }
      slots[BACK] = { label: 'Назад', run: () => open('root') }
    }
  }

  if (site) {
    slots[DEMOLISH] = {
      label: site.demolish ? 'Отменить разбор' : 'Отменить стройку',
      run: () => send({ type: 'cancelBuild', site: site.entity }),
    }
  }
  if (demolish && page === 'root') {
    slots[DEMOLISH] = {
      label: 'Разобрать',
      cost: demolish.refund,
      gain: true,
      title: 'Здание разберут строители; когда закончат, вернётся половина цены',
      run: () => send({ type: 'demolish', building: demolish.building, builders: [] }),
    }
  }
  return slots
}
