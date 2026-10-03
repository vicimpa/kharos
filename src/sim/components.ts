import { component } from '../ecs'
import type { BuildingType } from './buildings'
import type { Amounts, Resource } from './resources'
import type { TurretType } from './turrets'
import type { UnitType } from './units'
import type { WeaponType } from './weapons'

/** Место на карте в тайлах. У здания — левый верхний тайл основания, у юнита — его центр. */
export const Position = component('Position', { x: 0, y: 0 })

/** Здание. phase — сдвиг анимации в кадрах, чтобы одинаковые здания не мигали в такт. */
export const Building = component('Building', { type: 'command' as BuildingType, phase: 0 })

/**
 * Прочность юнита или здания: value — от 1 до 0, в нуле юнит гибнет, а здание разрушается.
 * Сколько урона стоит за единицей, знает вид: см. UnitSpec.hp и buildingHp.
 * repairable — чинят ли это те, у кого есть Repair. regen — какую долю прочности в секунду оно восстанавливает само.
 */
export const Health = component('Health', { value: 1, repairable: true, regen: 0 })

/**
 * Ремонтник: строит, разбирает и чинит своё — стройки, повреждённые здания и юнитов с Health.repairable. Работа
 * у него одна за раз, и юнит работает, только повернувшись к ней. radius — на сколько тайлов от его центра до края
 * цели он дотягивается; rate — сколько работы вкладывает за тик: единица — один строитель. На ходу не работает.
 * target — над чем он работает в этот тик; NONE — ни над чем.
 */
export const Repair = component('Repair', { radius: 5, rate: 1, target: -1 })

/** Чьё это. Игрок 0 — ничей: такими сущностями никто не командует. */
export const Owner = component('Owner', { player: 0 })

/**
 * Юнит. prevX, prevY — где он был тик назад: клиент рисует его между прошлым и нынешним местом.
 * facing — куда смотрит, в радианах от -π до π: 0 — вправо, растёт по часовой стрелке. prevFacing — куда смотрел тик назад.
 */
export const Unit = component('Unit', {
  type: 'infantry' as UnitType,
  prevX: 0,
  prevY: 0,
  facing: Math.PI / 2,
  prevFacing: Math.PI / 2,
})

/**
 * Путь, по которому юнит идёт; компонент есть, только пока он в пути.
 * points — оставшиеся точки в тайлах, x, y подряд. goalX, goalY — тайл, куда он шёл изначально.
 * wait — сколько тиков подряд юнит не может сдвинуться; tries — сколько раз путь к этой точке уже прокладывался заново.
 * near — на сколько тайлов достаточно подойти к цели: так идут к тому, в кого собираются стрелять.
 */
export const Path = component('Path', () => ({ points: [] as number[], goalX: 0, goalY: 0, wait: 0, tries: 0, near: 0 }))

/**
 * Игрок: сущность без места на карте. Отслеживается, чтобы интерфейс узнавал о смене счёта.
 * earned — заработанная доля кредита, ещё не дошедшая до целого. rewards — какие награды игрок уже получил, по порядку.
 */
export const Player = component('Player', () => ({ id: 0, credits: 0, earned: 0, rewards: [] as string[] }), { tracked: true })

/**
 * Производство юнитов: есть у MCV и у главного здания.
 * queue — очередь заказов, первый строится сейчас; progress — сколько тиков он уже строится;
 * при нехватке энергии растёт медленнее, поэтому бывает дробным.
 */
export const Producer = component('Producer', () => ({ queue: [] as UnitType[], progress: 0 }))

/**
 * Превращение: MCV разворачивается в главное здание или здание сворачивается обратно.
 * Компонент есть, только пока оно идёт. left — сколько тиков осталось, total — сколько было всего.
 */
export const Converting = component('Converting', { left: 0, total: 0 })

/**
 * Стройка. Пока строитель не начал работу, это только площадка: у сущности нет компонента Building,
 * она не занимает тайлы и сквозь неё ходят. С началом работы появляется Building, а Site остаётся до конца стройки.
 * progress — сколько тиков работы одного строителя уже вложено. demolish — здание не строят, а разбирают:
 * progress идёт от полного к нулю, и в нуле здание исчезает.
 */
export const Site = component('Site', { type: 'generator' as BuildingType, progress: 0, demolish: false })

/** Ремонтник едет к работе site — стройке, разбору или тому, что надо починить, — чтобы она оказалась в его радиусе. */
export const Builds = component('Builds', { site: 0 })

/** Месторождение, из которого уже добывали: mined — сколько из него забрано. Место — левый верхний тайл месторождения. */
export const Deposit = component('Deposit', { mined: 0 })

/**
 * Грузовик. Груз лежит в его складе (Inventory). mine — шахта, к которой его привязал игрок; -1 — свободен:
 * тогда работу ему даёт диспетчер зон (см. logistics.ts). Работа — перевезти до amount ресурса resource со склада
 * from на склад to; from = -1 — работы нет, to = -1 — куда везти, решится, когда наберёт груз. full — груз набран
 * и едет к to; loading — в этот тик идёт погрузка или выгрузка; waiting — уже получил приказ подъехать к лучу.
 */
export const Hauler = component('Hauler', {
  mine: -1,
  from: -1,
  to: -1,
  resource: 'metal' as Resource,
  amount: 0,
  full: false,
  loading: false,
  waiting: false,
})

/**
 * Склад: ресурсы, которые лежат в здании или едут в юните. items — сколько какого ресурса; capacity — сколько
 * помещается всего, всех ресурсов вместе; accepts — какие ресурсы сюда кладут, пусто — любые; limits — сколько
 * каждого ресурса помещается самое большее: так стройка принимает ровно свои материалы.
 * Между складами ресурсы переносит транспортный луч: см. Beam и inventory.ts.
 */
export const Inventory = component('Inventory', () => ({ items: {} as Amounts, capacity: 0, accepts: [] as Resource[], limits: {} as Amounts }))

/**
 * Транспортный луч: переносит ресурсы между своим складом и чужим, если между их краями не больше radius тайлов.
 * give — умеет отдавать, take — забирать; rate — сколько единиц в секунду на каждый склад. Очереди нет: луч
 * работает со всеми, кто в радиусе, сразу. links — с кем он работал в этот тик: target — чей склад, pulling —
 * забирал он с него или отдавал на него, resource — что переносил.
 */
export const Beam = component('Beam', () => ({ radius: 2, rate: 10, give: true, take: true, links: [] as { target: number; pulling: boolean; resource: Resource }[] }))

/**
 * Заявка на продажу: есть у космопорта от заявки до денег. resource — что продаётся, wanted — сколько;
 * привезённое лежит в складе космопорта. Когда привезено всё, корабль улетает: left и total — сколько тиков
 * ему лететь; пока товар везут, они нулевые.
 */
export const Trade = component('Trade', { resource: 'metal' as Resource, wanted: 0, left: 0, total: 0 })

/**
 * Вооружённый юнит. target — кого он атакует, -1 — никого. chase — гнаться ли за целью, когда она вне дальности:
 * так ведёт себя юнит, которому цель указал игрок или который отвечает на огонь; иначе он бьёт только тех, до кого
 * достаёт с места. cooldown — сколько тиков до следующего выстрела. stuck — сколько раз подряд гонящийся не нашёл,
 * куда идти: чем больше, тем реже он пробует снова.
 */
export const Armed = component('Armed', { target: -1, chase: false, cooldown: 0, stuck: 0 })

/**
 * Выстрел. Position — где снаряд сейчас, prevX и prevY — где был тик назад. Пуля, ракета и ядро летят из (fromX, fromY)
 * в (toX, toY); пуля и ракета следят за целью target, ядро падает туда, где цель была при выстреле. Лазер и разряд
 * бьют сразу, и сущность — только след от них: линия из from в to. age — сколько тиков выстрел живёт, life — сколько
 * ему отпущено. player и source — чей выстрел и кто стрелял.
 */
export const Shot = component('Shot', {
  weapon: 'rifle' as WeaponType,
  player: 0,
  source: -1,
  target: -1,
  fromX: 0,
  fromY: 0,
  toX: 0,
  toY: 0,
  prevX: 0,
  prevY: 0,
  age: 0,
  life: 0,
})

/** Взрыв: только картинка, урон уже нанесён. size — радиус в тайлах; age и life — как у выстрела. */
export const Blast = component('Blast', { size: 1, age: 0, life: 0 })

/**
 * Турель: отдельная сущность на юните-носителе, см. turrets.ts. angle — её поворот относительно носителя, в радианах
 * от -π до π: 0 — туда же, куда носитель; поворачиваясь, носитель несёт её с собой. Куда она смотрит в мире — см. turnerOf.
 * prevAngle, prevX и prevY — каким был поворот и где она была тик назад: клиент рисует её между прошлым и нынешним.
 */
export const Turret = component('Turret', { type: 'rocket' as TurretType, angle: 0, prevAngle: 0, prevX: 0, prevY: 0 })

/** Прикреплён к сущности parent: стоит на ней в along тайлов вперёд и across вправо от её центра. */
export const Attached = component('Attached', { parent: -1, along: 0, across: 0 })

/** Носитель турелей: какие турели на нём стоят. */
export const Carrier = component('Carrier', () => ({ turrets: [] as number[] }))

/** Компоненты, которые попадают в сохранение и в сеть. Новый компонент симуляции добавляй сюда. */
export const SAVED = [Position, Building, Health, Repair, Turret, Attached, Carrier, Owner, Unit, Path, Player, Producer, Converting, Site, Builds, Deposit, Hauler, Inventory, Beam, Trade, Armed, Shot, Blast]
