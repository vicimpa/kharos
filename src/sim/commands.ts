import type { Entity } from '../ecs'
import { setWorking } from './assembly'
import type { DepositKind } from './deposits'
import { orderHarvest, orderSeek } from './harvesting'
import { BUILDINGS, type BuildingType } from './buildings'
import { orderAttack, stopAttack } from './combat'
import { NONE, isOwn } from './common'
import { Builds, Building, Harvester, Producer, Unit } from './components'
import { assignBuilders, cancelBuild, demolish, orderBuild } from './construction'
import { DEPLOY_SECONDS, PACK_SECONDS, canDeploy, canPack, cancelDeploy, startConverting } from './conversion'
import { assignHaulers, assignPickup, assignSupply, releaseHauler } from './hauling'
import { orderPave, removePave, type PaveKind } from './paving'
import { cancelUnit, orderUnit } from './production'
import { setFilter, setRoute, setServe } from './routes'
import { surrender } from './defeat'
import { clearTactics, orderPatrol, setStance, type Stance } from './tactics'
import type { Good, Resource } from './resources'
import type { Sim } from './sim'
import { buy, closeSale, sell } from './trade'
import { orderGroupMove, type UnitType } from './units'

/**
 * Команда — единственный способ игрока повлиять на мир. Клиент не правит сущности сам, а посылает команду;
 * симуляция проверяет её и выполняет в начале следующего тика. Поэтому одна и та же симуляция работает
 * и внутри клиента, и на сервере, которому команды приходят по сети.
 *
 * Команды — простые данные, пригодные для JSON. Чтобы добавить команду, допиши вариант сюда и ветку в apply().
 */
export type Command =
  /** Отправить своих юнитов к тайлу (x, y). */
  | { type: 'move'; units: number[]; x: number; y: number }
  /** Точка сбора своего производящего здания: готовые юниты едут к тайлу (x, y). */
  | { type: 'rally'; building: number; x: number; y: number }
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
  /** Грузовики вывозят дроп, где бы он ни лежал, пока он не опустеет. */
  | { type: 'pickup'; units: number[]; drop: number }
  /** Послать свои грузовики обеспечить грузом своё здание или стройку: возят по их заявкам, пока те не кончатся. */
  | { type: 'supply'; units: number[]; target: number }
  /** Послать своих харвестеров копать месторождение с левым верхним тайлом (x, y). */
  | { type: 'harvest'; units: number[]; x: number; y: number }
  /** Велеть своим харвестерам искать месторождение вида kind или любое (any): среди разведанных, а нет — разведать. */
  | { type: 'seek'; units: number[]; kind: DepositKind | 'any' }
  /** Послать своих вооружённых юнитов атаковать чужой юнит или здание: они гонятся за целью, пока она жива. */
  | { type: 'attack'; units: number[]; target: number }
  /** Заявка на продажу до amount единиц ресурса: грузовики свезут его в космопорт из хранилищ его зоны, потом придут кредиты. */
  | { type: 'sell'; port: number; resource: Resource; amount: number }
  /** Закупить amount единиц ресурса с орбиты через свой космопорт: кредиты сразу, груз — через полёт корабля. */
  | { type: 'buy'; port: number; resource: Resource; amount: number }
  /** Закрыть заявку раньше срока: корабль улетает с тем, что привезли; если ничего — заявка снимается. */
  | { type: 'closeSale'; port: number }
  /** Включить или выключить свой завод изделий. */
  | { type: 'work'; building: number; on: boolean }
  /** Отменить свою стройку и вернуть кредиты; для здания под разбор — отменить разбор. */
  | { type: 'cancelBuild'; site: number }
  /** Назначить своё готовое здание под разбор и послать к нему своих строителей. Отменяется через cancelBuild. */
  | { type: 'demolish'; building: number; builders: number[] }
  /** Дать своим грузовикам маршрут: свои здания-остановки по кругу. Меньше двух остановок — снять маршрут. */
  | { type: 'route'; units: number[]; stops: number[] }
  /** Своим грузовикам — возить только по заявкам этих своих зданий. Пусто — снять назначение. */
  | { type: 'serve'; units: number[]; buildings: number[] }
  /** Какие грузы возить своим грузовикам; пусто — любые. */
  | { type: 'filter'; units: number[]; goods: Good[] }
  /** Сдаться: проиграть сразу — все свои юниты и здания исчезают. */
  | { type: 'surrender' }
  /** Стойка своих вооружённых юнитов: как они воюют без приказа. */
  | { type: 'stance'; units: number[]; stance: Stance }
  /** Послать своих вооружённых юнитов в патруль: по кругу от их места через точки (x и y подряд) и обратно. */
  | { type: 'patrol'; units: number[]; points: number[]; append?: boolean }
  /** Заложить покрытие в тайлы (x и y подряд) и послать к нему своих строителей. Дорога по болоту — мост. */
  | { type: 'pave'; kind: PaveKind; tiles: number[]; builders: number[] }
  /** Снять своё покрытие с тайлов (x и y подряд) своими строителями: недостроенное — сразу с возвратом, готовое разберут. */
  | { type: 'unpave'; tiles: number[]; builders: number[] }

const isTile = (x: unknown, y: unknown) => Number.isInteger(x) && Number.isInteger(y)

/**
 * Выполняет команду игрока player. Команда приходит извне, поэтому проверяется заново, даже если клиент
 * уже проверил: негодная молча отбрасывается. Возвращает, выполнена ли она.
 */
export function apply(sim: Sim, player: number, command: Command): boolean {
  switch (command.type) {
    case 'move': {
      if (!isTile(command.x, command.y) || !Array.isArray(command.units)) return false
      // Чужие, мёртвые и повторяющиеся юниты из списка выбрасываются.
      const units = [...new Set(command.units as Entity[])].filter((entity) => {
        return sim.world.has(entity, Unit) && isOwn(sim, player, entity)
      })
      if (!units.length) return false
      // Приказ идти снимает строителя со стройки, грузовик — с маршрута, бойца — с цели, а харвестера —
      // с месторождения: он ждёт команды.
      for (const entity of units) {
        sim.world.remove(entity, Builds)
        const harvester = sim.world.get(entity, Harvester)
        if (harvester) Object.assign(harvester, { x: NONE, y: NONE, ordered: false, parked: true, seek: '' })
        releaseHauler(sim, entity)
        stopAttack(sim, entity)
        clearTactics(sim, entity)
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
    case 'pickup':
      return Array.isArray(command.units) && assignPickup(sim, player, command.drop as Entity, command.units as Entity[])
    case 'supply':
      return Array.isArray(command.units) && assignSupply(sim, player, command.target as Entity, command.units as Entity[])
    case 'harvest': {
      if (!Array.isArray(command.units)) return false
      return orderHarvest(sim, player, command.units as Entity[], Math.floor(command.x), Math.floor(command.y))
    }
    case 'seek': {
      if (!Array.isArray(command.units)) return false
      return orderSeek(sim, player, command.units as Entity[], command.kind)
    }
    case 'attack': {
      if (!Array.isArray(command.units)) return false
      return orderAttack(sim, player, command.units as Entity[], command.target as Entity)
    }
    case 'sell':
      return sell(sim, player, command.port as Entity, command.resource, command.amount)
    case 'buy':
      return buy(sim, player, command.port as Entity, command.resource, command.amount)
    case 'closeSale':
      return closeSale(sim, player, command.port as Entity)
    case 'work':
      return setWorking(sim, player, command.building as Entity, !!command.on)
    case 'cancelBuild':
      return cancelBuild(sim, player, command.site as Entity)
    case 'surrender':
      return surrender(sim, player)
    case 'stance':
      return Array.isArray(command.units) && setStance(sim, player, command.units as Entity[], command.stance)
    case 'patrol':
      return Array.isArray(command.units) && Array.isArray(command.points) && orderPatrol(sim, player, command.units as Entity[], command.points, !!command.append)
    case 'route':
      return Array.isArray(command.units) && Array.isArray(command.stops) && setRoute(sim, player, command.units as Entity[], command.stops as Entity[])
    case 'serve':
      return Array.isArray(command.units) && Array.isArray(command.buildings) && setServe(sim, player, command.units as Entity[], command.buildings as Entity[])
    case 'filter':
      return Array.isArray(command.units) && Array.isArray(command.goods) && setFilter(sim, player, command.units as Entity[], command.goods)
    case 'pave': {
      if (!Array.isArray(command.tiles) || !Array.isArray(command.builders)) return false
      return orderPave(sim, player, command.kind, command.tiles, command.builders as Entity[]) > 0
    }
    case 'unpave':
      return Array.isArray(command.tiles) && Array.isArray(command.builders) && removePave(sim, player, command.tiles, command.builders as Entity[])
    case 'demolish': {
      const builders = Array.isArray(command.builders) ? (command.builders as Entity[]) : []
      return demolish(sim, player, command.building as Entity, builders)
    }
    case 'rally': {
      const building = command.building as Entity
      const producer = sim.world.get(building, Producer)
      if (!isTile(command.x, command.y) || !producer || !sim.world.has(building, Building) || !isOwn(sim, player, building)) return false
      producer.rally = [command.x, command.y]
      return true
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
    default:
      return false
  }
}
