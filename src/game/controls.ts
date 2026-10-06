import type { Entity } from '../ecs'
import { DEPOSIT_SIZE, Harvester, depositNear, hasMine, type UnitType, Owner, Position, Repair, isOwn, UNITS, Unit, canAttack, canFight, canHaul, canRepair, siteAt } from '../sim'
import { placementOf, spawnGhostOf } from './placing'
import type { Scene, Spawn } from './scene'

const KEY_SPEED = 900 // пикселей экрана в секунду
/** Насколько близко к краю экрана указатель начинает двигать камеру, в пикселях. */
const EDGE = 6
/** Сколько миллисекунд между двумя нажатиями цифры считается повтором: камера едет к группе. */
const DOUBLE_TAP = 400
/** Если мышь с нажатой кнопкой сдвинулась меньше, это щелчок, а не перетаскивание. В пикселях экрана. */
const CLICK_SLOP = 4
/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно выбрать его. В пикселях экрана. */
const PICK_MARGIN = 6
const LEFT = 0
const RIGHT = 2

/**
 * Управление с холста и клавиатуры.
 * Левая кнопка — выделение: щелчок по юниту или своему зданию, рамка — по юнитам; с Shift — добавить к выбранным,
 * а Shift по уже выбранному юниту — снять его. Двойной щелчок или Ctrl+щелчок по юниту — все свои юниты этого вида на экране.
 * Правая кнопка — приказ выбранным идти в точку, строителям по своей стройке — строить её, вооружённым по врагу —
 * атаковать его; если её тянуть (или среднюю) — двигается камера.
 * Пока выбирается место под здание: левая кнопка закладывает его (с Shift — можно сразу следующее), правая и Esc — отмена.
 * Колесо — масштаб, WASD, стрелки и указатель у края экрана — камера. T Y U I / G H J K / B N M , — сетка команд
 * нижней панели (её ведёт интерфейс). Ctrl+цифра — запомнить выделенных группой, цифра — выбрать группу,
 * повторно — ещё и навести на неё камеру. Esc — отменить выбор места, затем снять выделение.
 * Пока выбран отладочный спавн (scene.spawning), под указателем виден его призрак; левая кнопка ставит выбранное,
 * правая и Esc — отмена. Alt+G — отладочная сетка.
 */
export function createControls(canvas: HTMLCanvasElement, scene: Scene) {
  const { camera } = scene
  const keys = new Set<string>()
  /** Какая кнопка сейчас зажата на холсте и где её нажали, в пикселях экрана. */
  let pressed: { button: number; x: number; y: number; dragged: boolean } | null = null
  /** Группы по цифрам 1–9 и 0. */
  const groups = new Map<string, Entity[]>()
  let lastGroup: { digit: string; at: number } | null = null
  /** Где указатель в окне, даже над панелями интерфейса: для прокрутки краем экрана. null — вне окна. */
  let screenPointer: { x: number; y: number } | null = null
  const onWindowPointer = (event: PointerEvent) => (screenPointer = { x: event.clientX, y: event.clientY })
  const onWindowLeave = () => (screenPointer = null)

  /** Свои юниты, центр которых попал в прямоугольник в тайлах. */
  const unitsInBox = (left: number, top: number, right: number, bottom: number) => {
    const { world } = scene.sim
    const found: Entity[] = []
    for (const [entity, position, , owner] of world.query(Position, Unit, Owner)) {
      if (owner.player !== scene.player) continue
      if (position.x >= left && position.x <= right && position.y >= top && position.y <= bottom) found.push(entity)
    }
    return found
  }

  /** Юнит под точкой в тайлах: ближайший из тех, в чей круг она попала. own — искать среди своих или среди чужих. */
  const unitAt = (x: number, y: number, own = true) => {
    const { world } = scene.sim
    const margin = PICK_MARGIN / camera.zoom
    let best: Entity | undefined
    let bestDistance = Infinity
    for (const [entity, position, unit, owner] of world.query(Position, Unit, Owner)) {
      if ((owner.player === scene.player) !== own) continue
      const distance = Math.hypot(position.x - x, position.y - y)
      if (distance > UNITS[unit.type].radius + margin || distance >= bestDistance) continue
      best = entity
      bestDistance = distance
    }
    return best
  }

  /** Свои юниты вида type, которые видны на экране. */
  const visibleOfType = (type: UnitType) => {
    const { from, to } = camera.visible
    return unitsInBox(from.x, from.y, to.x, to.y).filter((entity) => scene.sim.world.get(entity, Unit)?.type === type)
  }
  /** Прошлый щелчок по юниту: для двойного щелчка. */
  let lastClick: { unit: Entity; at: number } | null = null

  const select = (units: Entity[], add: boolean) => {
    if (!add) scene.selection.clear()
    // Здание с юнитами вместе не выбирается.
    for (const entity of scene.selection) if (!scene.sim.world.has(entity, Unit)) scene.selection.delete(entity)
    for (const entity of units) scene.selection.add(entity)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (pressed) return
    pressed = { button: event.button, x: event.offsetX, y: event.offsetY, dragged: false }
    canvas.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent) => {
    camera.pointer = { x: event.offsetX, y: event.offsetY }
    if (!pressed) return
    if (Math.hypot(event.offsetX - pressed.x, event.offsetY - pressed.y) > CLICK_SLOP) pressed.dragged = true
    if (pressed.button === LEFT) {
      if (!pressed.dragged || scene.placing || scene.spawning) return
      const from = camera.screenToTile(pressed.x, pressed.y)
      const to = camera.screenToTile(event.offsetX, event.offsetY)
      scene.selectionBox = { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }
    } else {
      camera.moveBy(-event.movementX / camera.zoom, -event.movementY / camera.zoom)
    }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!pressed || event.button !== pressed.button) return
    const { button, dragged } = pressed
    pressed = null
    const point = camera.screenToTile(event.offsetX, event.offsetY)

    if (scene.spawning) {
      if (button === LEFT && !dragged) spawnAt(scene.spawning)
      if (button === RIGHT && !dragged) scene.spawning = null
    } else if (scene.placing) {
      if (button === RIGHT && !dragged) scene.placing = null
      const placement = button === LEFT && !dragged ? placementOf(scene) : null
      if (placement?.allowed) {
        const { type, x, y } = placement
        scene.sim.send(scene.player, { type: 'build', building: type, x, y, builders: [...scene.selection] })
        if (!event.shiftKey) scene.placing = null
      }
    } else if (button === LEFT) {
      const box = scene.selectionBox
      scene.selectionBox = null
      if (dragged && box) {
        const found = unitsInBox(
          Math.min(box.fromX, box.toX),
          Math.min(box.fromY, box.toY),
          Math.max(box.fromX, box.toX),
          Math.max(box.fromY, box.toY),
        )
        select(found, event.shiftKey)
      } else {
        const unit = unitAt(point.x, point.y)
        const now = performance.now()
        const double = unit !== undefined && lastClick?.unit === unit && now - lastClick.at < DOUBLE_TAP
        lastClick = unit !== undefined ? { unit, at: now } : null
        if (unit !== undefined && (double || event.ctrlKey || event.metaKey)) {
          // Двойной щелчок или Ctrl — все свои юниты этого вида на экране.
          select(visibleOfType(scene.sim.world.get(unit, Unit)!.type), event.shiftKey)
        } else if (unit !== undefined && event.shiftKey && scene.selection.has(unit)) {
          // Shift по уже выбранному — снять с него выделение.
          scene.selection.delete(unit)
        } else if (unit !== undefined) select([unit], event.shiftKey)
        else {
          // Не юнит — тогда, может быть, своё здание или площадка. Здание выбирается только одно и без юнитов.
          const tileX = Math.floor(point.x)
          const tileY = Math.floor(point.y)
          const building = scene.sim.occupancy.at(tileX, tileY) ?? siteAt(scene.sim, tileX, tileY)
          const own = building !== undefined && isOwn(scene.sim, scene.player, building)
          select(own ? [building] : [], false)
        }
      }
    } else if (button === RIGHT && !dragged && scene.selection.size) {
      const { sim } = scene
      const x = Math.floor(point.x)
      const y = Math.floor(point.y)
      const units = [...scene.selection]
      // Работа для строителей: стройка, разбор или своё повреждённое — здание или юнит.
      const damaged = sim.occupancy.at(x, y)
      const broken = unitAt(point.x, point.y) ?? damaged
      const site = siteAt(sim, x, y) ?? (broken !== undefined && canRepair(sim, scene.player, broken) ? broken : undefined)
      const builders = units.some((entity) => sim.world.has(entity, Repair))
      // Строители по своей стройке — строят, по повреждённому зданию или юниту — чинят; остальные выбранные при этом стоят.
      const trucks = units.some((entity) => sim.world.get(entity, Unit)?.type === 'truck')
      // Вооружённые по врагу — атакуют: по чужому юниту или зданию под курсором.
      const enemy = unitAt(point.x, point.y, false) ?? damaged
      const fighters = units.some((entity) => canFight(sim, entity))
      // Харвестеры по месторождению — копают его, если на нём нет шахты.
      const harvesters = units.some((entity) => sim.world.has(entity, Harvester))
      const found = harvesters ? depositNear(sim, point.x, point.y, DEPOSIT_SIZE) : null
      const known = found && sim.vision.exploredIn(scene.player, found.x, found.y, DEPOSIT_SIZE, DEPOSIT_SIZE)
      const deposit = found && known && !hasMine(sim, found) ? found : null
      const onDeposit = deposit && x >= deposit.x && x < deposit.x + DEPOSIT_SIZE && y >= deposit.y && y < deposit.y + DEPOSIT_SIZE
      // Грузовики по своей шахте — привязываются к ней и возят добытое.
      if (fighters && enemy !== undefined && canAttack(sim, scene.player, enemy)) {
        sim.send(scene.player, { type: 'attack', units, target: enemy })
      } else if (deposit && onDeposit) {
        sim.send(scene.player, { type: 'harvest', units, x: deposit.x, y: deposit.y })
      } else if (trucks && damaged !== undefined && canHaul(sim, scene.player, damaged)) {
        sim.send(scene.player, { type: 'haul', units, mine: damaged })
      } else if (site !== undefined && builders && isOwn(sim, scene.player, site)) {
        sim.send(scene.player, { type: 'assist', units, site })
      } else {
        sim.send(scene.player, { type: 'move', units, x, y })
      }
    }
  }
  const onPointerCancel = () => {
    pressed = null
    scene.selectionBox = null
  }
  const onPointerLeave = () => {
    camera.pointer = null
  }
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    // Точка под курсором остаётся на месте.
    camera.zoomTo(camera.zoom * Math.exp(-event.deltaY * 0.0015), event.offsetX, event.offsetY)
  }
  // Правая кнопка занята приказами: меню браузера на холсте не нужно.
  const onContextMenu = (event: Event) => event.preventDefault()

  /** Отладочный спавн под указателем — там же, где его призрак. Проверки — только чтобы не слать заведомо негодную команду. */
  const spawnAt = (spawn: Spawn) => {
    const ghost = spawnGhostOf(scene)
    if (!ghost?.allowed) return
    const { x, y } = ghost
    if (spawn.kind === 'building') scene.sim.send(scene.player, { type: 'placeBuilding', building: spawn.type, x, y })
    else scene.sim.send(scene.player, { type: 'spawnUnit', unit: spawn.type, x, y, enemy: spawn.kind === 'enemy' })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Не трогаем игру, пока пользователь печатает или крутит ползунок в панели.
    if (event.target instanceof HTMLInputElement) return
    keys.add(event.code)
    if (event.altKey) {
      if (event.code === 'KeyG') scene.grid = !scene.grid
      event.preventDefault()
      return
    }
    const digit = /^Digit(\d)$/.exec(event.code)?.[1]
    if (digit !== undefined) {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        groups.set(digit, [...scene.selection])
        return
      }
      const group = (groups.get(digit) ?? []).filter((entity) => scene.sim.world.alive(entity))
      if (!group.length) return
      select(group, event.shiftKey)
      const now = performance.now()
      if (lastGroup?.digit === digit && now - lastGroup.at < DOUBLE_TAP) lookAtSelection()
      lastGroup = { digit, at: now }
    }
    if (event.code === 'Escape') {
      // Сначала отменяется выбор места, и только следующим нажатием — выделение.
      if (scene.spawning) scene.spawning = null
      else if (scene.placing) scene.placing = null
      else scene.selection.clear()
    }
  }
  /** Наводит камеру на середину выделенного. */
  const lookAtSelection = () => {
    let x = 0
    let y = 0
    let count = 0
    for (const entity of scene.selection) {
      const position = scene.sim.world.get(entity, Position)
      if (!position) continue
      x += position.x
      y += position.y
      count++
    }
    if (!count) return
    camera.centerOn(x / count, y / count)
  }
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code)
  const onBlur = () => {
    keys.clear()
    screenPointer = null
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pointermove', onWindowPointer)
  document.documentElement.addEventListener('pointerleave', onWindowLeave)

  /** Раз в кадр: двигает камеру, пока зажаты клавиши. seconds — время с прошлого кадра. */
  const update = (seconds: number) => {
    const step = (KEY_SPEED * seconds) / camera.zoom
    // Указатель у края экрана двигает камеру, пока не тянут рамку и камеру мышью.
    const pointer = pressed ? null : screenPointer
    const edgeX = pointer ? Number(pointer.x >= camera.width - EDGE) - Number(pointer.x <= EDGE) : 0
    const edgeY = pointer ? Number(pointer.y >= camera.height - EDGE) - Number(pointer.y <= EDGE) : 0
    const right = Math.sign(Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + edgeX)
    const down = Math.sign(Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp')) + edgeY)
    if (right || down) camera.moveBy(right * step, down * step)

    // Погибшие и исчезнувшие выпадают из выделения.
    for (const entity of scene.selection) if (!scene.sim.world.alive(entity)) scene.selection.delete(entity)
    // Место под здание выбирают строителями: без них выбор отменяется.
    if (scene.placing) {
      let builders = false
      for (const entity of scene.selection) builders ||= scene.sim.world.get(entity, Unit)?.type === 'builder'
      if (!builders) scene.placing = null
    }
  }

  return {
    update,
    lookAtSelection,
    /** Оставляет в выделении только юнитов вида type; remove — наоборот, убирает их. */
    narrow(type: UnitType, remove: boolean) {
      for (const entity of scene.selection) {
        const same = scene.sim.world.get(entity, Unit)?.type === type
        if (same === remove) scene.selection.delete(entity)
      }
    },
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointermove', onWindowPointer)
      document.documentElement.removeEventListener('pointerleave', onWindowLeave)
    },
  }
}
