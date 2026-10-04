import type { Entity } from '../ecs'
import { BUILDINGS, canPlace, durabilityOf, placeBuilding, type BuildingType } from './buildings'
import { TRAINING_PLAYER, orderAttack, stopAttack } from './combat'
import { isOwn } from './common'
import { Builds, Unit } from './components'
import { assignBuilders, cancelBuild, demolish, orderBuild } from './construction'
import { DEPLOY_SECONDS, PACK_SECONDS, canDeploy, canPack, cancelDeploy, startConverting } from './conversion'
import { assignHaulers, releaseHauler } from './hauling'
import { cancelUnit, orderUnit } from './production'
import type { Resource } from './resources'
import type { Sim } from './sim'
import { closeSale, sell } from './trade'
import { UNITS, isWalkable, orderGroupMove, spawnUnit, type UnitType } from './units'

/**
 * Команда — единственный способ игрока повлиять на мир. Клиент не правит сущности сам, а посылает команду;
 * симуляция проверяет её и выполняет в начале следующего тика. Поэтому одна и та же симуляция работает
 * и внутри клиента, и на сервере, которому команды приходят по сети.
 *
 * Команды — простые данные, пригодные для JSON. Чтобы добавить команду, допиши вариант сюда и ветку в apply().
 */
export type Command =
  /** Отладка: поставить готовое здание бесплатно и где угодно. */
  | { type: 'placeBuilding'; building: BuildingType; x: number; y: number }
  /** Отправить своих юнитов к тайлу (x, y). */
  | { type: 'move'; units: number[]; x: number; y: number }
  /** Развернуть свой MCV в главное здание на месте. */
  | { type: 'deploy'; unit: number }
  | { type: 'cancelDeploy'; unit: number }
  /** Свернуть своё главное здание обратно в MCV. */
  | { type: 'pack'; building: number }
  /** Заказать юнит у своего MCV или главного здания. */
  | { type: 'produce'; producer: number; unit: UnitType }
  /** Отменить последний заказ в очереди производителя. */
  | { type: 'cancelProduction'; producer: number }
  /** Заложить здание левым верхним углом основания в тайл (x, y) и послать строить своих строителей. */
  | { type: 'build'; building: BuildingType; x: number; y: number; builders: number[] }
  /** Послать своих строителей на свою стройку. */
  | { type: 'assist'; units: number[]; site: number }
  /** Привязать свои грузовики к своей шахте: они будут возить добытое из неё в хранилища, а не работать на заявки зон. */
  | { type: 'haul'; units: number[]; mine: number }
  /** Послать своих вооружённых юнитов атаковать чужой юнит или здание: они гонятся за целью, пока она жива. */
  | { type: 'attack'; units: number[]; target: number }
  /** Заявка на продажу до amount единиц ресурса: грузовики свезут его в космопорт из хранилищ его зоны, потом придут кредиты. */
  | { type: 'sell'; port: number; resource: Resource; amount: number }
  /** Закрыть заявку раньше срока: корабль улетает с тем, что привезли; если ничего — заявка снимается. */
  | { type: 'closeSale'; port: number }
  /** Отменить свою стройку и вернуть кредиты; для здания под разбор — отменить разбор. */
  | { type: 'cancelBuild'; site: number }
  /** Назначить своё готовое здание под разбор и послать к нему своих строителей. Отменяется через cancelBuild. */
  | { type: 'demolish'; building: number; builders: number[] }
  /** Отладка: создать юнит в тайле. enemy — отдать его учебному противнику: с ним можно повоевать. */
  | { type: 'spawnUnit'; unit: UnitType; x: number; y: number; enemy?: boolean }

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
      const durability = durabilityOf(sim, command.building, command.x, command.y)
      placeBuilding(sim.world, command.building, command.x, command.y, player, durability)
      return true
    }
    case 'move': {
      if (!isTile(command.x, command.y) || !Array.isArray(command.units)) return false
      // Чужие, мёртвые и повторяющиеся юниты из списка выбрасываются.
      const units = [...new Set(command.units as Entity[])].filter((entity) => {
        return sim.world.has(entity, Unit) && isOwn(sim, player, entity)
      })
      if (!units.length) return false
      // Приказ идти снимает строителя со стройки, грузовик — с маршрута, а бойца — с цели.
      for (const entity of units) {
        sim.world.remove(entity, Builds)
        releaseHauler(sim, entity)
        stopAttack(sim, entity)
      }
      orderGroupMove(sim, units, command.x, command.y)
      return true
    }
    case 'build': {
      if (!Object.hasOwn(BUILDINGS, command.building) || !Array.isArray(command.builders)) return false
      return orderBuild(sim, player, command.building, command.x, command.y, command.builders as Entity[]) !== undefined
    }
    case 'assist': {
      if (!Array.isArray(command.units)) return false
      return assignBuilders(sim, player, command.site as Entity, command.units as Entity[])
    }
    case 'haul': {
      if (!Array.isArray(command.units)) return false
      return assignHaulers(sim, player, command.mine as Entity, command.units as Entity[])
    }
    case 'attack': {
      if (!Array.isArray(command.units)) return false
      return orderAttack(sim, player, command.units as Entity[], command.target as Entity)
    }
    case 'sell':
      return sell(sim, player, command.port as Entity, command.resource, command.amount)
    case 'closeSale':
      return closeSale(sim, player, command.port as Entity)
    case 'cancelBuild':
      return cancelBuild(sim, player, command.site as Entity)
    case 'demolish': {
      const builders = Array.isArray(command.builders) ? (command.builders as Entity[]) : []
      return demolish(sim, player, command.building as Entity, builders)
    }
    case 'deploy': {
      const unit = command.unit as Entity
      if (!canDeploy(sim, player, unit)) return false
      startConverting(sim, unit, DEPLOY_SECONDS)
      return true
    }
    case 'cancelDeploy':
      return cancelDeploy(sim, player, command.unit as Entity)
    case 'pack': {
      const building = command.building as Entity
      if (!canPack(sim, player, building)) return false
      startConverting(sim, building, PACK_SECONDS)
      return true
    }
    case 'produce':
      return orderUnit(sim, player, command.producer as Entity, command.unit)
    case 'cancelProduction':
      return cancelUnit(sim, player, command.producer as Entity)
    case 'spawnUnit': {
      if (!Object.hasOwn(UNITS, command.unit) || !isTile(command.x, command.y)) return false
      if (!isWalkable(sim, command.x, command.y)) return false
      spawnUnit(sim, command.unit, command.enemy ? TRAINING_PLAYER : player, command.x, command.y)
      return true
    }
    default:
      return false
  }
}
