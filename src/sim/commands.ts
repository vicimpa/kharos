import { BUILDINGS, canPlace, placeBuilding, type BuildingType } from './buildings'
import type { Sim } from './sim'

/**
 * Команда — единственный способ игрока повлиять на мир. Клиент не правит сущности сам, а посылает команду;
 * симуляция проверяет её и выполняет в начале следующего тика. Поэтому одна и та же симуляция работает
 * и внутри клиента, и на сервере, которому команды приходят по сети.
 *
 * Команды — простые данные, пригодные для JSON. Чтобы добавить команду, допиши вариант сюда и ветку в apply().
 */
export type Command = { type: 'placeBuilding'; building: BuildingType; x: number; y: number }

/**
 * Выполняет команду. Команда приходит извне, поэтому проверяется заново, даже если клиент уже проверил:
 * негодная молча отбрасывается. Возвращает, выполнена ли она.
 */
export function apply(sim: Sim, command: Command): boolean {
  switch (command.type) {
    case 'placeBuilding': {
      if (!Object.hasOwn(BUILDINGS, command.building)) return false
      if (!canPlace(sim, command.building, command.x, command.y)) return false
      placeBuilding(sim.world, command.building, command.x, command.y)
      return true
    }
    default:
      return false
  }
}
