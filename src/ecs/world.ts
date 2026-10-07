import type { Component, ComponentInput, Entity } from './component'

/** Данные компонентов запроса, в том же порядке. */
export type DataOf<C extends Component<any>[]> = { [K in keyof C]: C[K] extends Component<infer T> ? T : never }

/** Строка запроса: сущность и данные её компонентов. */
export type Row<C extends Component<any>[]> = [Entity, ...DataOf<C>]

/** То, что возвращает наблюдатель: необязательная функция очистки. */
export type Cleanup = void | (() => void)

export type ChangeListener = (entity: Entity) => void

/** Снимок мира в виде, пригодном для JSON: сущности с данными их компонентов по именам. */
export interface WorldSnapshot {
  /** Номер, который получит следующая новая сущность. */
  next: number
  entities: [id: number, components: Record<string, object>][]
}

/** Копия данных компонента. Данные сохраняемых компонентов обязаны переживать JSON. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

interface Observer {
  components: Component<any>[]
  enter: (entity: Entity, ...data: any[]) => Cleanup
  /** Сущности, для которых наблюдатель сейчас запущен, и их очистка. */
  active: Map<Entity, Cleanup>
}

/** Хранилище одного компонента: плотные массивы сущностей и данных плюс индекс «сущность → место». */
class Store<T extends object> {
  readonly entities: Entity[] = []
  readonly data: T[] = []
  private readonly index = new Map<Entity, number>()

  constructor(readonly component: Component<T>) {}

  get(entity: Entity): T | undefined {
    const at = this.index.get(entity)
    return at === undefined ? undefined : this.data[at]
  }

  has(entity: Entity) {
    return this.index.has(entity)
  }

  insert(entity: Entity, value: T) {
    this.index.set(entity, this.entities.length)
    this.entities.push(entity)
    this.data.push(value)
  }

  replace(entity: Entity, value: T) {
    this.data[this.index.get(entity)!] = value
  }

  /** На место удалённого встаёт последний: массивы остаются плотными. */
  remove(entity: Entity) {
    const at = this.index.get(entity)!
    const last = this.entities.length - 1
    if (at !== last) {
      const moved = this.entities[last]
      this.entities[at] = moved
      this.data[at] = this.data[last]
      this.index.set(moved, at)
    }
    this.entities.pop()
    this.data.pop()
    this.index.delete(entity)
  }
}

/**
 * Мир: сущности, их компоненты и подписки. Не знает ни про отрисовку, ни про сеть —
 * один и тот же код работает в браузере и на сервере.
 */
export class World {
  private nextEntity = 1
  private readonly entities = new Set<Entity>()
  /** Хранилища, наблюдатели и слушатели — по номеру компонента. */
  private readonly stores: (Store<any> | undefined)[] = []
  private readonly observers: (Observer[] | undefined)[] = []
  private readonly listeners: (Set<ChangeListener> | undefined)[] = []
  private changed = new Map<Component<any>, Set<Entity>>()
  /** Сколько запросов сейчас обходится. Пока идёт обход, состав сущностей не меняется. */
  private iterating = 0
  private deferred: (() => void)[] = []

  /** Все живые сущности. Только читать: менять — через spawn() и destroy(). */
  get all(): ReadonlySet<Entity> {
    return this.entities
  }

  /** Число живых сущностей. */
  get size() {
    return this.entities.size
  }

  spawn(...inputs: ComponentInput<any>[]): Entity {
    const entity = this.nextEntity++ as Entity
    this.entities.add(entity)
    for (const input of inputs) this.add(entity, input)
    return entity
  }

  alive(entity: Entity) {
    return this.entities.has(entity)
  }

  /** Уничтожает сущность со всеми компонентами. Во время обхода запроса откладывается до его конца. */
  destroy(entity: Entity) {
    if (this.iterating) {
      this.deferred.push(() => this.destroy(entity))
      return
    }
    if (!this.entities.has(entity)) return
    for (const store of this.stores) if (store?.has(entity)) this.remove(entity, store.component)
    this.entities.delete(entity)
  }

  /**
   * Добавляет компонент. Если он уже есть, начальные значения применяются как set().
   * Во время обхода запроса откладывается до его конца.
   */
  add<T extends object>(entity: Entity, input: ComponentInput<T>) {
    if (this.iterating) {
      this.deferred.push(() => this.add(entity, input))
      return
    }
    if (!this.entities.has(entity)) return
    const component = typeof input === 'function' ? input : input.component
    const init = typeof input === 'function' ? undefined : input.init

    const store = (this.stores[component.id] ??= new Store(component))
    if (store.has(entity)) {
      if (init) this.set(entity, component, init)
      return
    }
    store.insert(entity, component.create(init))
    this.mark(entity, component)

    const observers = this.observers[component.id]
    if (observers) for (const observer of observers) if (!observer.active.has(entity)) this.activate(observer, entity)
  }

  /** Убирает компонент. Во время обхода запроса откладывается до его конца. */
  remove(entity: Entity, component: Component<any>) {
    if (this.iterating) {
      this.deferred.push(() => this.remove(entity, component))
      return
    }
    const store = this.stores[component.id]
    if (!store?.has(entity)) return

    const observers = this.observers[component.id]
    if (observers) {
      for (const observer of observers) {
        if (!observer.active.has(entity)) continue
        const cleanup = observer.active.get(entity)
        observer.active.delete(entity)
        cleanup?.()
      }
    }
    store.remove(entity)
    this.mark(entity, component)
  }

  has(entity: Entity, component: Component<any>) {
    return this.stores[component.id]?.has(entity) ?? false
  }

  /**
   * Данные компонента или undefined, если его нет. У отслеживаемого компонента это неизменяемый снимок:
   * после set() его нужно прочитать заново.
   */
  get<T extends object>(entity: Entity, component: Component<T>): T | undefined {
    return this.stores[component.id]?.get(entity)
  }

  /**
   * Меняет поля компонента и сообщает об этом подписчикам onChange(). Если значения те же, ничего не происходит.
   * Единственный способ изменить отслеживаемый компонент. Если компонента нет, добавляет его.
   */
  set<T extends object>(entity: Entity, component: Component<T>, patch: Partial<T>) {
    const store: Store<T> | undefined = this.stores[component.id]
    const current = store?.get(entity)
    if (!store || !current) {
      this.add(entity, component(patch))
      return
    }

    let same = true
    for (const key in patch) {
      if (patch[key] !== current[key]) {
        same = false
        break
      }
    }
    if (same) return

    if (component.tracked) store.replace(entity, Object.freeze({ ...current, ...patch }))
    else Object.assign(current, patch)
    this.mark(entity, component)
  }

  /** Сообщает подписчикам, что данные компонента поменяли на месте, в обход set(). */
  touch(entity: Entity, component: Component<any>) {
    if (this.has(entity, component)) this.mark(entity, component)
  }

  /** Сколько сущностей с этим компонентом. */
  count(component: Component<any>) {
    return this.stores[component.id]?.entities.length ?? 0
  }

  /**
   * Обходит сущности, у которых есть все перечисленные компоненты:
   * for (const [entity, position, velocity] of world.query(Position, Velocity)) { ... }
   *
   * Массив строки один на весь обход — не сохраняй его, бери из него значения сразу.
   * Пока обход не закончен, spawn() создаёт сущность, но её компоненты, а также add(), remove()
   * и destroy() применяются после обхода.
   */
  query<C extends Component<any>[]>(...components: C): IterableIterator<Row<C>> {
    const stores: Store<any>[] = []
    for (const component of components) {
      const store = this.stores[component.id]
      if (!store) return EMPTY
      stores.push(store)
    }
    if (!stores.length) return EMPTY
    // Идём по самому маленькому хранилищу, остальные только проверяем.
    let driver = stores[0]
    for (const store of stores) if (store.entities.length < driver.entities.length) driver = store
    // Обход — обычный объект-итератор, а не генератор: генератор на каждом шаге стоит в разы дороже, а обходов
    // в тике — по числу сущностей.
    return new Query<Row<C>>(this, stores, driver)
  }

  /** Обход начался: до его конца состав сущностей не меняется. Только для Query. */
  enter() {
    this.iterating++
  }

  /** Обход кончился: отложенные изменения применяются, когда кончится последний. Только для Query. */
  leave() {
    if (--this.iterating === 0) this.applyDeferred()
  }

  /**
   * Следит за сущностями с набором компонентов. enter вызывается, когда сущность его получила
   * (и сразу — для уже существующих), а возвращённая им функция — когда потеряла или была уничтожена:
   *
   * world.observe([Position, Sprite], (entity, position, sprite) => {
   *   const handle = sprites.add(sprite.art)
   *   return () => handle.remove()
   * })
   *
   * Возвращает отписку; она вызывает очистку для всех сущностей, за которыми наблюдатель ещё следит.
   */
  observe<C extends Component<any>[]>(components: [...C], enter: (entity: Entity, ...data: DataOf<C>) => Cleanup) {
    const observer: Observer = { components, enter: enter as Observer['enter'], active: new Map() }
    for (const component of components) (this.observers[component.id] ??= []).push(observer)
    for (const [entity] of this.query(...components)) this.activate(observer, entity)

    return () => {
      for (const component of components) {
        this.observers[component.id] = this.observers[component.id]?.filter((other) => other !== observer)
      }
      const cleanups = [...observer.active.values()]
      observer.active.clear()
      for (const cleanup of cleanups) cleanup?.()
    }
  }

  /**
   * Подписка на изменения компонента: set(), touch(), добавление и удаление. Слушатель получает сущность
   * и сам читает её состояние. Вызывается из flush(), не больше раза на сущность за один flush(). Возвращает отписку.
   */
  onChange(component: Component<any>, listener: ChangeListener) {
    const listeners = (this.listeners[component.id] ??= new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Раздаёт накопленные изменения подписчикам onChange(). Игровой цикл вызывает это в конце каждого тика. */
  flush() {
    if (!this.changed.size) return
    const changed = this.changed
    this.changed = new Map()
    for (const [component, entities] of changed) {
      const listeners = this.listeners[component.id]
      if (!listeners) continue
      for (const entity of entities) for (const listener of listeners) listener(entity)
    }
  }

  /** Уничтожает все сущности. Подписки и наблюдатели остаются. */
  clear() {
    for (const entity of [...this.entities]) this.destroy(entity)
  }

  /**
   * Снимок перечисленных компонентов. Сущности, у которых нет ни одного из них, в снимок не попадают:
   * так в нём не оказывается то, что живёт только на клиенте. keep — какие сущности брать: так хост шлёт
   * игроку только то, что тот видит.
   */
  snapshot(components: Component<any>[], keep?: (entity: Entity) => boolean): WorldSnapshot {
    const entities: WorldSnapshot['entities'] = []
    for (const entity of this.entities) {
      if (keep && !keep(entity)) continue
      const data: Record<string, object> = {}
      let found = false
      for (const component of components) {
        const value = this.stores[component.id]?.get(entity)
        if (value === undefined) continue
        data[component.key] = copy(value)
        found = true
      }
      if (found) entities.push([entity, data])
    }
    return { next: this.nextEntity, entities }
  }

  /**
   * Заменяет содержимое мира снимком: сущности получают прежние номера, поэтому ссылки между ними остаются верными.
   * Компоненты снимка, которых нет в списке, пропускаются. Наблюдатели и подписки срабатывают как обычно.
   */
  restore(snapshot: WorldSnapshot, components: Component<any>[]) {
    if (this.iterating) throw new Error('Нельзя восстанавливать мир во время обхода запроса')
    this.clear()
    const byKey = new Map(components.map((component) => [component.key, component]))
    for (const [id, data] of snapshot.entities) this.insert(id, data, byKey)
    if (snapshot.next > this.nextEntity) this.nextEntity = snapshot.next
  }

  /**
   * Добавляет одну сущность из снимка под её прежним номером, не трогая остальные. Так клиент дополняет
   * присланный мир тем, что помнит сам.
   */
  insert(id: number, data: Record<string, object>, components: Component<any>[] | Map<string, Component<any>>) {
    if (this.iterating) throw new Error('Нельзя добавлять сущности во время обхода запроса')
    const byKey = components instanceof Map ? components : new Map(components.map((component) => [component.key, component]))
    const entity = id as Entity
    this.entities.add(entity)
    for (const key in data) {
      const component = byKey.get(key)
      if (component) this.add(entity, component(copy(data[key])))
    }
    if (id >= this.nextEntity) this.nextEntity = id + 1
  }

  private mark(entity: Entity, component: Component<any>) {
    // Без слушателей копить изменения незачем.
    if (!this.listeners[component.id]?.size) return
    let entities = this.changed.get(component)
    if (!entities) this.changed.set(component, (entities = new Set()))
    entities.add(entity)
  }

  private activate(observer: Observer, entity: Entity) {
    const data: object[] = []
    for (const component of observer.components) {
      const value = this.stores[component.id]?.get(entity)
      if (value === undefined) return
      data.push(value)
    }
    observer.active.set(entity, observer.enter(entity, ...data))
  }

  private applyDeferred() {
    while (this.deferred.length) {
      const commands = this.deferred
      this.deferred = []
      for (const command of commands) command()
    }
  }
}

const EMPTY: IterableIterator<never> = {
  next: () => ({ done: true, value: undefined }),
  [Symbol.iterator]() {
    return this
  },
}

/** Обход запроса. Массив строки и объект результата одни на весь обход. */
class Query<R extends unknown[]> implements IterableIterator<R> {
  private at = 0
  private started = false
  private done = false
  private readonly row: R
  private readonly result: IteratorResult<R> & { value: R }
  private readonly data: unknown[]
  private readonly entities: Entity[]

  constructor(
    private readonly world: World,
    private readonly stores: Store<any>[],
    private readonly driver: Store<any>,
  ) {
    this.row = new Array(stores.length + 1) as unknown as R
    this.result = { done: false, value: this.row }
    this.entities = driver.entities
    this.data = driver.data
  }

  [Symbol.iterator]() {
    return this
  }

  next(): IteratorResult<R> {
    const { entities, data, stores, driver, row } = this
    // Как у генератора: обход начинается с первого шага, а не когда запрос создан.
    if (!this.started && !this.done) {
      this.started = true
      this.world.enter()
    }
    next: while (!this.done && this.at < entities.length) {
      const i = this.at++
      const entity = entities[i]
      row[0] = entity
      for (let j = 0; j < stores.length; j++) {
        const store = stores[j]
        const value = store === driver ? data[i] : store.get(entity)
        if (value === undefined) continue next
        row[j + 1] = value
      }
      return this.result
    }
    return this.finish()
  }

  /** Обход прерван (break, return, исключение): тоже конец. */
  return(): IteratorResult<R> {
    return this.finish()
  }

  private finish(): IteratorResult<R> {
    if (!this.done) {
      this.done = true
      if (this.started) this.world.leave()
    }
    return { done: true, value: undefined }
  }
}
