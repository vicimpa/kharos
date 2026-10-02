declare const entityBrand: unique symbol

/** Сущность — просто номер. Номера не переиспользуются: устаревшая ссылка никогда не укажет на чужую сущность. */
export type Entity = number & { readonly [entityBrand]: true }

export interface ComponentOptions {
  /**
   * Отслеживаемый компонент: его данные неизменяемы и меняются только через world.set(),
   * а каждое изменение доходит до подписчиков world.onChange(). Для редкого состояния,
   * которое читают интерфейс и сеть. Без флага данные — обычный объект, который системы правят на месте.
   */
  tracked?: boolean
}

/** Компонент с начальными значениями: то, что принимают world.spawn() и world.add(). */
export interface ComponentInit<T extends object = object> {
  component: Component<T>
  init?: Partial<T>
}

export interface Component<T extends object = object> {
  /** Position({ x: 1 }) — заготовка компонента с начальными значениями. */
  (init?: Partial<T>): ComponentInit<T>
  readonly id: number
  /** Имя для отладки и сохранения. */
  readonly key: string
  readonly tracked: boolean
  /** Данные для новой сущности: значения по умолчанию плюс init. */
  create(init?: Partial<T>): T
}

export type ComponentInput<T extends object = object> = Component<T> | ComponentInit<T>

/** Данные компонентов-меток общие: хранить в них нечего. */
const TAG = Object.freeze({})

let nextId = 0

/** Метка без данных: component('Selected'). */
export function component(key: string): Component<{}>
/** Отслеживаемый компонент: данные неизменяемы, см. ComponentOptions.tracked. */
export function component<T extends object>(
  key: string,
  defaults: T | (() => T),
  options: ComponentOptions & { tracked: true },
): Component<Readonly<T>>
/**
 * Компонент с данными. defaults — значения по умолчанию; если среди них есть массивы или объекты,
 * передавай функцию, чтобы у каждой сущности был свой экземпляр.
 */
export function component<T extends object>(key: string, defaults: T | (() => T), options?: ComponentOptions): Component<T>
export function component(key: string, defaults?: object | (() => object), options: ComponentOptions = {}): Component {
  const tracked = options.tracked ?? false

  const create = (init?: object): object => {
    if (defaults === undefined) return TAG
    const data = typeof defaults === 'function' ? Object.assign(defaults(), init) : { ...defaults, ...init }
    return tracked ? Object.freeze(data) : data
  }

  const result: Component = Object.assign((init?: object): ComponentInit => ({ component: result, init }), {
    id: nextId++,
    key,
    tracked,
    create,
  })
  return result
}
