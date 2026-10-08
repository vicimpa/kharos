import type { Entity } from '../ecs'
import { Building, DEPOSIT_SIZE, Harvester, Producer, Hauler, depositNear, hasMine, type UnitType, Owner, Position, Repair, isOwn, UNITS, Unit, canAttack, canFight, canHaul, canRepair, canSupply, dropAt, isStop, siteAt, BUILDINGS, BRIDGE_COST, FOUNDATION_COST, ROAD_COST, creditsOf } from '../sim'
import type { CameraMotion } from './cameraMotion'
import { paveStrokeOf, placementOf } from './placing'
import type { Scene } from './scene'

const KEY_SPEED = 900 // пикселей экрана в секунду
/** Во сколько раз быстрее камера с зажатым Shift. */
const KEY_BOOST = 3
/** Насколько близко к краю экрана указатель начинает двигать камеру, в пикселях. */
const EDGE = 6
/** Сколько миллисекунд между двумя нажатиями цифры считается повтором: камера едет к группе. */
const DOUBLE_TAP = 400
/** Если мышь с нажатой кнопкой сдвинулась меньше, это щелчок, а не перетаскивание. В пикселях экрана. */
const CLICK_SLOP = 4
/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно выбрать его. В пикселях экрана. */
const PICK_MARGIN = 6
const LEFT = 0
/** Почём тайл покрытия бывает: дорога по болоту — мост — дороже. Режим держится, пока хватает на самый дешёвый. */
const PAVE_COSTS = { foundation: [FOUNDATION_COST], road: [ROAD_COST, BRIDGE_COST] } as const
const RIGHT = 2

/**
 * Управление с холста и клавиатуры.
 * Левая кнопка — выделение: щелчок по юниту или своему зданию, рамка — по юнитам; с Shift — добавить к выбранным,
 * а Shift по уже выбранному юниту — снять его. Двойной щелчок или Ctrl+щелчок по юниту — все свои юниты этого вида на экране.
 * Правая кнопка — приказ выбранным идти в точку, строителям по своей стройке — строить её, вооружённым по врагу —
 * атаковать его; если её тянуть (или среднюю) — двигается камера.
 * Пока выбирается место под здание: левая кнопка закладывает его, и можно сразу следующее; правая и Esc — отмена.
 * Так же с покрытием: левую кнопку тянут от тайла к тайлу.
 * Колесо — масштаб, WASD, стрелки и указатель у края экрана — камера, с Shift — втрое быстрее; камера разгоняется
 * и тормозит, а брошенная мышью катится дальше (см. cameraMotion.ts). T Y U I / G H J K / B N M , — сетка команд
 * нижней панели (её ведёт интерфейс). Ctrl+цифра — запомнить выделенных группой, цифра — выбрать группу,
 * повторно — ещё и навести на неё камеру. Esc — отменить выбор места, затем снять выделение.
 * Alt+G — сетка тайлов.
 */
export function createControls(canvas: HTMLCanvasElement, scene: Scene, motion: CameraMotion) {
  const { camera } = scene
  const keys = new Set<string>()
  /** Какая кнопка сейчас зажата на холсте и где её нажали, в пикселях экрана. */
  let pressed: { button: number; x: number; y: number; dragged: boolean } | null = null
  /** Угол рамки выделения на карте, в тайлах: камера может уехать, пока рамку тянут, а угол остаётся на месте. */
  let anchor: { x: number; y: number } | null = null
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

  /** Выбрано одно своё производящее здание: правый щелчок задаёт ему точку сбора. */
  const rallying = () => {
    const { world } = scene.sim
    if (scene.selection.size !== 1) return false
    const [entity] = scene.selection
    return world.has(entity, Building) && world.has(entity, Producer) && isOwn(scene.sim, scene.player, entity)
  }

  const select = (units: Entity[], add: boolean) => {
    if (!add) scene.selection.clear()
    // Здание с юнитами вместе не выбирается.
    for (const entity of scene.selection) if (!scene.sim.world.has(entity, Unit)) scene.selection.delete(entity)
    for (const entity of units) scene.selection.add(entity)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (pressed) return
    pressed = { button: event.button, x: event.offsetX, y: event.offsetY, dragged: false }
    anchor = event.button === LEFT ? camera.screenToTile(event.offsetX, event.offsetY) : null
    // Покрытие тянут от тайла, где зажали левую кнопку.
    if (scene.paving && event.button === LEFT) {
      const { x, y } = camera.screenToTile(event.offsetX, event.offsetY)
      scene.paveFrom = { x: Math.floor(x), y: Math.floor(y) }
    }
    canvas.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent) => {
    camera.pointer = { x: event.offsetX, y: event.offsetY }
    if (!pressed) return
    if (Math.hypot(event.offsetX - pressed.x, event.offsetY - pressed.y) > CLICK_SLOP) pressed.dragged = true
    if (pressed.button === LEFT) {
      if (pressed.dragged) stretchBox()
    } else {
      motion.drag(event.movementX, event.movementY)
    }
  }
  /** Тянет рамку от угла на карте до указателя. */
  const stretchBox = () => {
    if (!pressed?.dragged || !anchor || !camera.pointer || scene.placing || scene.paving) return
    const to = camera.screenToTile(camera.pointer.x, camera.pointer.y)
    scene.selectionBox = { fromX: anchor.x, fromY: anchor.y, toX: to.x, toY: to.y }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!pressed || event.button !== pressed.button) return
    const { button, dragged } = pressed
    pressed = null
    if (button !== LEFT) motion.release()
    const point = camera.screenToTile(event.offsetX, event.offsetY)
    // Рамка в наборе патруля — обычное выделение: набор кончается.
    // Так же и щелчок по своему невыбранному юниту — выбрать его.
    if (scene.patrolling && button === LEFT) {
      const unit = dragged ? undefined : unitAt(point.x, point.y)
      if (dragged || (unit !== undefined && !scene.selection.has(unit))) scene.patrolling = false
    }

    if (scene.patrolling) {
      // Щелчок — патруль до точки, и выбор кончается; Shift+щелчок — ещё точка к патрулю, выбор продолжается.
      if (button === LEFT && !dragged) {
        const units = [...scene.selection]
        scene.sim.send(scene.player, { type: 'patrol', units, points: [Math.floor(point.x), Math.floor(point.y)], append: event.shiftKey })
        if (!event.shiftKey) scene.patrolling = false
      }
      if (button === RIGHT && !dragged) scene.patrolling = false
    } else if (scene.routing) {
      // Левый щелчок по своему зданию со складом — ещё остановка; правый — маршрут готов.
      if (button === LEFT && !dragged) {
        const building = scene.sim.occupancy.at(Math.floor(point.x), Math.floor(point.y))
        const last = scene.routing[scene.routing.length - 1]
        if (building !== undefined && building !== last && isStop(scene.sim, scene.player, building)) scene.routing.push(building)
      }
      if (button === RIGHT && !dragged) finishRoute()
    } else if (scene.serving) {
      // Левый щелчок по своему зданию со складом — отметить его или снять отметку; правый — готово.
      if (button === LEFT && !dragged) {
        const building = scene.sim.occupancy.at(Math.floor(point.x), Math.floor(point.y))
        if (building !== undefined && isStop(scene.sim, scene.player, building)) {
          const at = scene.serving.indexOf(building)
          if (at >= 0) scene.serving.splice(at, 1)
          else scene.serving.push(building)
        }
      }
      if (button === RIGHT && !dragged) finishServe()
    } else if (scene.paving) {
      if (button === RIGHT && !dragged) scene.paving = null
      const stroke = button === LEFT ? paveStrokeOf(scene) : null
      scene.paveFrom = null
      if (stroke) {
        const tiles = stroke.tiles.filter((_, i) => stroke.allowed[i >> 1])
        if (tiles.length) {
          const builders = [...scene.selection]
          scene.sim.send(scene.player, stroke.tool === 'remove' ? { type: 'unpave', tiles, builders } : { type: 'pave', kind: stroke.tool, tiles, builders })
        }
      }
    } else if (scene.placing) {
      if (button === RIGHT && !dragged) scene.placing = null
      const placement = button === LEFT && !dragged ? placementOf(scene) : null
      if (placement?.allowed) {
        const { type, x, y } = placement
        scene.sim.send(scene.player, { type: 'build', building: type, x, y, builders: [...scene.selection] })
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
    } else if (button === RIGHT && !dragged && rallying()) {
      // Выбрано своё производящее здание: правый щелчок ставит ему точку сбора.
      const [building] = scene.selection
      scene.sim.send(scene.player, { type: 'rally', building, x: Math.floor(point.x), y: Math.floor(point.y) })
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
      // То, чему грузовики могут привезти груз: своя стройка или здание под курсором.
      const needy = siteAt(sim, x, y) ?? damaged
      // Строители по своей стройке — строят, по повреждённому зданию или юниту — чинят; остальные выбранные при этом стоят.
      const trucks = units.some((entity) => sim.world.has(entity, Hauler) && !sim.world.has(entity, Harvester))
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
      } else if (trucks && dropAt(sim, x, y) !== undefined) {
        // Грузовики по дропу — вывозят его.
        sim.send(scene.player, { type: 'pickup', units, drop: dropAt(sim, x, y)! })
      } else if (trucks && needy !== undefined && canSupply(sim, scene.player, needy)) {
        // Грузовики по своему зданию или стройке, которым нужен груз, — обеспечивают их; строители при этом строят.
        const haulers = units.filter((entity) => sim.world.has(entity, Hauler) && !sim.world.has(entity, Harvester))
        sim.send(scene.player, { type: 'supply', units: haulers, target: needy })
        const rest = units.filter((entity) => !haulers.includes(entity) && sim.world.has(entity, Repair))
        if (rest.length && siteAt(sim, x, y) === needy) sim.send(scene.player, { type: 'assist', units: rest, site: needy })
      } else if (site !== undefined && builders && isOwn(sim, scene.player, site)) {
        sim.send(scene.player, { type: 'assist', units, site })
      } else {
        sim.send(scene.player, { type: 'move', units, x, y })
      }
    }
  }
  const onPointerCancel = () => {
    pressed = null
    anchor = null
    motion.release()
    scene.selectionBox = null
  }
  const onPointerLeave = () => {
    camera.pointer = null
  }
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    // Точка под курсором остаётся на месте.
    motion.zoomBy(Math.exp(-event.deltaY * 0.0015), event.offsetX, event.offsetY)
  }
  // Правая кнопка занята приказами: меню браузера на холсте не нужно.
  const onContextMenu = (event: Event) => event.preventDefault()

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
    if ((event.code === 'Enter' || event.code === 'NumpadEnter') && scene.routing) finishRoute()
    if ((event.code === 'Enter' || event.code === 'NumpadEnter') && scene.serving) finishServe()
    // P — патруль, как в StarCraft: дальше щелчок по карте.
    if (event.code === 'KeyP' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      let fighters = false
      for (const entity of scene.selection) fighters ||= canFight(scene.sim, entity)
      if (fighters) {
        scene.patrolling = true
        scene.placing = scene.paving = scene.routing = scene.serving = null
      }
    }
    if (event.code === 'Escape') {
      // Сначала отменяется выбор места, и только следующим нажатием — выделение.
      if (scene.patrolling) scene.patrolling = false
      else if (scene.routing) scene.routing = null
      else if (scene.serving) scene.serving = null
      else if (scene.paving) {
        scene.paving = null
        scene.paveFrom = null
      } else if (scene.placing) scene.placing = null
      else scene.selection.clear()
    }
  }
  /** Отдаёт набранный маршрут выбранным грузовикам; меньше двух остановок — набор просто кончается. */
  const finishRoute = () => {
    const stops = scene.routing ?? []
    scene.routing = null
    if (stops.length > 1) scene.sim.send(scene.player, { type: 'route', units: [...scene.selection], stops })
  }
  /** Назначает выбранным грузовикам отмеченные здания; ничего не отмечено — набор просто кончается. */
  const finishServe = () => {
    const buildings = scene.serving ?? []
    scene.serving = null
    if (buildings.length) scene.sim.send(scene.player, { type: 'serve', units: [...scene.selection], buildings })
  }
  /** Камера летит к середине выделенного. */
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
    motion.flyTo(x / count, y / count)
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
    const speed = KEY_SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? KEY_BOOST : 1)
    // Указатель у края экрана двигает камеру, пока камеру не тянут мышью; рамку тянуть можно — она растёт за край.
    const pointer = pressed && pressed.button !== LEFT ? null : screenPointer
    const edgeX = pointer ? Number(pointer.x >= camera.width - EDGE) - Number(pointer.x <= EDGE) : 0
    const edgeY = pointer ? Number(pointer.y >= camera.height - EDGE) - Number(pointer.y <= EDGE) : 0
    const right = Math.sign(Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + edgeX)
    const down = Math.sign(Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp')) + edgeY)
    motion.update(seconds, right * speed, down * speed)
    stretchBox()

    // Погибшие и исчезнувшие выпадают из выделения.
    for (const entity of scene.selection) if (!scene.sim.world.alive(entity)) scene.selection.delete(entity)
    // Место под здание выбирают строителями: без них выбор отменяется.
    if (scene.placing) {
      let builders = false
      for (const entity of scene.selection) builders ||= scene.sim.world.get(entity, Unit)?.type === 'builder'
      if (!builders) scene.placing = null
    }
    // Не хватает кредитов даже на одно здание или тайл покрытия — режим выбора выключается.
    const credits = creditsOf(scene.sim, scene.player)
    if (scene.placing && credits < BUILDINGS[scene.placing].cost) scene.placing = null
    if (scene.paving && scene.paving !== 'remove' && credits < Math.min(...PAVE_COSTS[scene.paving])) scene.paving = null
    // Патруль набирают бойцам: без них набор отменяется.
    if (scene.patrolling) {
      let fighters = false
      for (const entity of scene.selection) fighters ||= canFight(scene.sim, entity)
      if (!fighters) scene.patrolling = false
    }
    // Маршрут набирают грузовикам: без них набор отменяется.
    if (scene.routing) {
      let trucks = false
      for (const entity of scene.selection) trucks ||= scene.sim.world.has(entity, Hauler) && !scene.sim.world.has(entity, Harvester)
      if (!trucks) scene.routing = null
    }
    if (scene.serving) {
      let trucks = false
      for (const entity of scene.selection) trucks ||= scene.sim.world.has(entity, Hauler) && !scene.sim.world.has(entity, Harvester)
      if (!trucks) scene.serving = null
    }
    // Покрытие кладут и снимают строители.
    if (scene.paving) {
      let builders = false
      for (const entity of scene.selection) builders ||= scene.sim.world.get(entity, Unit)?.type === 'builder'
      if (!builders) scene.paving = null
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
