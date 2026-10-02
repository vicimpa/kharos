import type { Entity } from '../ecs'
import { BUILDINGS, canPlace, placeBuilding, type BuildingType } from './buildings'
import { Owner, Unit } from './components'
import type { Sim } from './sim'
import { UNITS, isWalkable, orderGroupMove, spawnUnit, type UnitType } from './units'

/**
 * Команда — единственный способ игрока повлиять на мир. Клиент не правит сущности сам, а посылает команду;
 * симуляция проверяет её и выполняет в начале следующего тика. Поэтому одна и та же симуляция работает
 * и внутри клиента, и на сервере, которому команды приходят по сети.
 *
 * Команды — простые данные, пригодные для JSON. Чтобы добавить команду, допиши вариант сюда и ветку в apply().
 */
export type Command =
  | { type: 'placeBuilding'; building: BuildingType; x: number; y: number }
  /** Отправить своих юнитов к тайлу (x, y). */
  | { type: 'move'; units: number[]; x: number; y: number }
  /** Отладка: создать юнит в тайле. Уйдёт, когда юнитов начнёт производить главное здание. */
  | { type: 'spawnUnit'; unit: UnitType; x: number; y: number }

const isTile = (x: unknown, y: unknown) => Number.isInteger(x) && Number.isInteger(y)

/**
 * Выполняет команду игрока player. Команда приходит извне, поэтому проверяется заново, даже если клиент
 * уже проверил: негодная молча отбрасывается. Возвращает, выполнена ли она.
 */
export function apply(sim: Sim, player: number, command: Command): boolean {
  switch (command.type) {
    case 'placeBuilding': {
      if (!Object.hasOwn(BUILDINGS, command.building)) return false
      if (!canPlace(sim, command.building, command.x, command.y)) return false
      placeBuilding(sim.world, command.building, command.x, command.y, player)
      return true
    }
    case 'move': {
      if (!isTile(command.x, command.y) || !Array.isArray(command.units)) return false
      // Чужие, мёртвые и повторяющиеся юниты из списка выбрасываются.
      const units = [...new Set(command.units as Entity[])].filter((entity) => {
        return sim.world.has(entity, Unit) && sim.world.get(entity, Owner)?.player === player
      })
      if (!units.length) return false
      orderGroupMove(sim, units, command.x, command.y)
      return true
    }
    case 'spawnUnit': {
      if (!Object.hasOwn(UNITS, command.unit) || !isTile(command.x, command.y)) return false
      if (!isWalkable(sim, command.x, command.y)) return false
      spawnUnit(sim, command.unit, player, command.x, command.y)
      return true
    }
    default:
      return false
  }
}
