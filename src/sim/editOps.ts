import type { Entity } from '../ecs'
import type { BuildingType } from './buildings'
import type { Command } from './commands'
import { depositAt, reserveLeft, type DepositKind } from './deposits'
import {
  addPlayer,
  clearTasks,
  erase,
  moveGroup,
  orderNow,
  paint,
  putBuilding,
  putDeposit,
  putUnit,
  removeDeposit,
  setCredits,
  setDeposit,
  setFacing,
  setHealth,
  setOwner,
  setPlayerCamera,
  setStock,
  setTurretFacing,
  type Brush,
} from './editor'
import type { Good } from './resources'
import type { Sim } from './sim'
import type { UnitType } from './units'

/**
 * Правка редактора как данные. Локальный редактор применяет её сразу, а в сетевой игре администратор шлёт её хосту,
 * и тот применяет её к живому миру, см. applyEdit. Сущности — номерами: у копии мира они те же, что у хоста.
 * Месторождения — левым верхним тайлом.
 */
export type EditOp =
  | { op: 'paint'; x: number; y: number; size: number; brush: Brush }
  | { op: 'building'; type: BuildingType; x: number; y: number; player: number }
  | { op: 'unit'; type: UnitType; x: number; y: number; player: number }
  | { op: 'deposit'; x: number; y: number; kind: DepositKind; reserve: number }
  | { op: 'setDeposit'; spots: { x: number; y: number }[]; kind?: DepositKind; left?: number }
  | { op: 'removeDeposit'; spots: { x: number; y: number }[] }
  | { op: 'erase'; entities: number[] }
  | { op: 'move'; entities: number[]; dx: number; dy: number; deposits: { x: number; y: number }[] }
  | { op: 'owner'; entities: number[]; player: number }
  | { op: 'health'; entities: number[]; share: number }
  | { op: 'facing'; entities: number[]; angle: number }
  | { op: 'turret'; entities: number[]; angle: number; index?: number }
  | { op: 'stock'; entity: number; good: Good; amount: number }
  | { op: 'clearTasks'; entities: number[] }
  | { op: 'order'; player: number; command: Command }
  | { op: 'credits'; player: number; amount: number }
  | { op: 'camera'; player: number; camera?: { x: number; y: number; zoom: number } }
  | { op: 'addPlayer' }

/** Что сказать о правке, которая не удалась; undefined — удалась. */
export type EditResult = string | undefined

/**
 * Применяет правку к миру. Ничего не проверяет о том, кто её прислал: это дело хоста. Негодные номера сущностей и
 * месторождений пропускаются.
 */
export function applyEdit(sim: Sim, edit: EditOp): EditResult {
  const { world } = sim
  const alive = (ids: number[]) => ids.map((id) => id as Entity).filter((entity) => world.alive(entity))
  const spots = (list: { x: number; y: number }[]) => list.map((at) => depositAt(sim, at.x, at.y)).filter((spot) => spot !== null)
  switch (edit.op) {
    case 'paint':
      paint(sim, edit.x, edit.y, edit.size, edit.brush)
      return
    case 'building':
      return putBuilding(sim, edit.type, edit.x, edit.y, edit.player) === undefined ? 'Здание сюда не встанет' : undefined
    case 'unit':
      return putUnit(sim, edit.type, edit.x, edit.y, edit.player) === undefined ? 'Юнит здесь не встанет' : undefined
    case 'deposit':
      return putDeposit(sim, edit.x, edit.y, edit.kind, edit.reserve) ? undefined : 'Месторождение ложится на скалу не у подножия обрыва и не внахлёст с другим'
    case 'setDeposit':
      for (const spot of spots(edit.spots)) setDeposit(sim, spot, edit.kind ?? spot.kind, edit.left ?? reserveLeft(sim, spot.x, spot.y))
      return
    case 'removeDeposit':
      for (const spot of spots(edit.spots)) removeDeposit(sim, spot)
      return
    case 'erase':
      for (const entity of alive(edit.entities)) erase(sim, entity)
      return
    case 'move':
      return moveGroup(sim, alive(edit.entities), edit.dx, edit.dy, spots(edit.deposits)) ? undefined : 'Сюда не сдвинуть'
    case 'owner':
      for (const entity of alive(edit.entities)) setOwner(sim, entity, edit.player)
      return
    case 'health':
      for (const entity of alive(edit.entities)) setHealth(sim, entity, edit.share)
      return
    case 'facing':
      for (const entity of alive(edit.entities)) setFacing(sim, entity, edit.angle)
      return
    case 'turret':
      for (const entity of alive(edit.entities)) setTurretFacing(sim, entity, edit.angle, edit.index)
      return
    case 'stock':
      if (world.alive(edit.entity as Entity)) setStock(sim, edit.entity as Entity, edit.good, edit.amount)
      return
    case 'clearTasks':
      for (const entity of alive(edit.entities)) clearTasks(sim, entity)
      return
    case 'order':
      return orderNow(sim, edit.player, edit.command) ? undefined : 'Приказ не принят'
    case 'credits':
      setCredits(sim, edit.player, edit.amount)
      return
    case 'camera':
      setPlayerCamera(sim, edit.player, edit.camera)
      return
    case 'addPlayer':
      addPlayer(sim)
      return
  }
}
