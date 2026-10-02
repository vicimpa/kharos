import { useEffect, useState } from 'preact/hooks'
import type { Component, Entity, World } from '../ecs'

/**
 * Данные компонента сущности для интерфейса: перерисовывает компонент Preact, когда они меняются.
 * Возвращает undefined, если компонента у сущности нет. Рассчитан на отслеживаемые компоненты (tracked):
 * их данные — неизменяемый снимок, и каждое изменение даёт новый объект. Обычные компоненты правятся
 * на месте, и о перемене узнают только после world.touch().
 */
export function useComponent<T extends object>(world: World, entity: Entity, component: Component<T>): T | undefined {
  const [, setVersion] = useState(0)
  useEffect(
    () =>
      world.onChange(component, (changed) => {
        if (changed === entity) setVersion((version) => version + 1)
      }),
    [world, entity, component],
  )
  return world.get(entity, component)
}
