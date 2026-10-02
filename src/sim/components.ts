import { component } from '../ecs'
import type { BuildingType } from './buildings'
import type { UnitType } from './units'
import type { WeaponType } from './weapons'

/** Место на карте в тайлах. У здания — левый верхний тайл основания, у юнита — его центр. */
export const Position = component('Position', { x: 0, y: 0 })

/**
 * Здание. phase — сдвиг анимации в кадрах, чтобы одинаковые здания не мигали в такт.
 * health — прочность от 1 до 0: в нуле здание разрушается. ore — сколько руды лежит в здании, если оно её хранит.
 */
export const Building = component('Building', { type: 'command' as BuildingType, phase: 0, health: 1, ore: 0 })

/** Чьё это. Игрок 0 — ничей: такими сущностями никто не командует. */
export const Owner = component('Owner', { player: 0 })

/**
 * Юнит. prevX, prevY — где он был тик назад: клиент рисует его между прошлым и нынешним местом.
 * facing — куда смотрит, в радианах от -π до π: 0 — вправо, растёт по часовой стрелке. prevFacing — куда смотрел тик назад.
 * health — прочность от 1 до 0: в нуле юнит гибнет.
 */
export const Unit = component('Unit', {
  type: 'infantry' as UnitType,
  prevX: 0,
  prevY: 0,
  facing: Math.PI / 2,
  prevFacing: Math.PI / 2,
  health: 1,
})

/**
 * Путь, по которому юнит идёт; компонент есть, только пока он в пути.
 * points — оставшиеся точки в тайлах, x, y подряд. goalX, goalY — тайл, куда он шёл изначально.
 * wait — сколько тиков подряд юнит не может сдвинуться; tries — сколько раз путь к этой точке уже прокладывался заново.
 */
export const Path = component('Path', () => ({ points: [] as number[], goalX: 0, goalY: 0, wait: 0, tries: 0 }))

/**
 * Игрок: сущность без места на карте. Отслеживается, чтобы интерфейс узнавал о смене счёта.
 * earned — заработанная доля кредита, ещё не дошедшая до целого. rewards — какие награды игрок уже получил, по порядку.
 */
export const Player = component('Player', () => ({ id: 0, credits: 0, earned: 0, rewards: [] as string[] }), { tracked: true })

/**
 * Производство юнитов: есть у MCV и у главного здания.
 * queue — очередь заказов, первый строится сейчас; progress — сколько тиков он уже строится.
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

/** Строитель занят стройкой: едет к площадке site или работает на ней. */
export const Builds = component('Builds', { site: 0 })

/** Месторождение, из которого уже добывали: mined — сколько руды забрано. Место — левый верхний тайл месторождения. */
export const Deposit = component('Deposit', { mined: 0 })

/**
 * Грузовик. ore — руда в кузове. Работ у него две, и занят он одной: возит руду из шахты mine в главное здание base
 * или из хранилища source в космопорт port; -1 — нет. full — кузов надо везти к получателю; docked — стоит
 * на коннекторе задом к зданию, идёт погрузка или выгрузка; waiting — уже получил приказ ехать к коннектору
 * и ждёт очереди.
 */
export const Hauler = component('Hauler', { ore: 0, mine: -1, base: -1, port: -1, source: -1, full: false, docked: false, waiting: false })

/**
 * Заявка на продажу руды: есть у космопорта от заявки до денег. wanted — сколько руды продаётся, delivered — сколько
 * грузовики уже привезли в космопорт, claimed — сколько едет к нему в кузовах. Когда привезено всё, корабль улетает:
 * left и total — сколько тиков ему лететь; пока руду везут, они нулевые.
 */
export const Trade = component('Trade', { wanted: 0, delivered: 0, claimed: 0, left: 0, total: 0 })

/**
 * Вооружённый юнит. target — кого он атакует, -1 — никого. chase — гнаться ли за целью, когда она вне дальности:
 * так ведёт себя юнит, которому цель указал игрок или который отвечает на огонь; иначе он бьёт только тех, до кого
 * достаёт с места. cooldown — сколько тиков до следующего выстрела.
 */
export const Armed = component('Armed', { target: -1, chase: false, cooldown: 0 })

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

/** Компоненты, которые попадают в сохранение и в сеть. Новый компонент симуляции добавляй сюда. */
export const SAVED = [Position, Building, Owner, Unit, Path, Player, Producer, Converting, Site, Builds, Deposit, Hauler, Trade, Armed, Shot, Blast]
