import type { Entity } from '../ecs'
import { type BuildingType, Building, Site, Harvester, Producer, Hauler, type UnitType, Owner, Position, isOwn, UNITS, Unit, canFight, isStop, siteAt, BUILDINGS, BRIDGE_COST, FOUNDATION_COST, ROAD_COST, creditsOf } from '../sim'
import type { CameraMotion } from './cameraMotion'
import { paveStrokeOf, placementOf } from './placing'
import type { Scene } from './scene'

const KEY_SPEED = 900 // пикселей экрана в секунду
/** Во сколько раз быстрее камера с зажатым Shift. */
const KEY_BOOST = 3
/** Насколько близко к краю экрана указатель двигает камеру, пока тянут рамку выделения, в пикселях. */
const EDGE = 6
/** Сколько миллисекунд между двумя нажатиями цифры считается повтором: камера едет к группе. */
const DOUBLE_TAP = 400
/** Если мышь с нажатой кнопкой сдвинулась меньше, это щелчок, а не перетаскивание. В пикселях экрана. */
const CLICK_SLOP = 4
/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно выбрать его. В пикселях экрана. */
const PICK_MARGIN = 6
const LEFT = 0
/** Почём тайл покрытия бывает: дорога по болоту — мост — дороже. Режим держится, пока хватает на самый дешёвый. */
const PAVE_COSTS = { foundation: [FOUNDATION_COST], road: [ROAD_COST, BRIDGE_COST], pipe: [BUILDINGS.pipe.cost], well: [BUILDINGS.well.cost] } as const
const RIGHT = 2

/**
 * Управление с холста и клавиатуры.
 * Левая кнопка — выделение: щелчок по юниту или своему зданию, рамка — по юнитам; с Shift — добавить к выбранным,
 * а Shift по уже выбранному юниту — снять его. Двойной щелчок или Ctrl+щелчок по юниту — все свои юниты этого вида на экране.
 * Правая кнопка — приказ выбранным идти в точку, строителям по своей стройке — строить её, вооружённым по врагу —
 * атаковать его; с Shift приказ встаёт в очередь (см. orders.ts); если её тянуть (или среднюю) — двигается камера.
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

  /** Свои здания и площадки, середина которых попала в прямоугольник в тайлах; type — только этого вида. */
  const buildingsInBox = (left: number, top: number, right: number, bottom: number, type?: BuildingType) => {
    const { world } = scene.sim
    const found: Entity[] = []
    for (const [entity, position, owner] of world.query(Position, Owner)) {
      if (owner.player !== scene.player) continue
      const kind = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type
      if (!kind || (type && kind !== type)) continue
      const x = position.x + BUILDINGS[kind].width / 2
      const y = position.y + BUILDINGS[kind].height / 2
      if (x >= left && x <= right && y >= top && y <= bottom) found.push(entity)
    }
    return found
  }
  /** Кого выбирает рамка с углами (fromX, fromY) и (toX, toY): юниты в ней главнее, здания — только если юнитов нет. */
  const boxHits = (fromX: number, fromY: number, toX: number, toY: number) => {
    const left = Math.min(fromX, toX)
    const top = Math.min(fromY, toY)
    const right = Math.max(fromX, toX)
    const bottom = Math.max(fromY, toY)
    const units = unitsInBox(left, top, right, bottom)
    return units.length ? units : buildingsInBox(left, top, right, bottom)
  }
  const typeOf = (entity: Entity) => scene.sim.world.get(entity, Building)?.type ?? scene.sim.world.get(entity, Site)?.type
  /** Прошлый щелчок по зданию: для двойного щелчка. */
  let lastBuildingClick: { building: Entity; at: number } | null = null

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

  /** Выбраны только свои производящие здания: правый щелчок задаёт им всем точку сбора. */
  const rallying = () => {
    const { world } = scene.sim
    if (!scene.selection.size) return false
    for (const entity of scene.selection) {
      if (!world.has(entity, Building) || !world.has(entity, Producer) || !isOwn(scene.sim, scene.player, entity)) return false
    }
    return true
  }

  /** Выбирает units — юнитов или здания; add — добавить к выбранным. Здания с юнитами вместе не выбираются. */
  const select = (units: Entity[], add: boolean) => {
    if (!add) scene.selection.clear()
    const { world } = scene.sim
    const buildings = units.length > 0 && !world.has(units[0], Unit)
    for (const entity of scene.selection) if (world.has(entity, Unit) === buildings) scene.selection.delete(entity)
    for (const entity of units) scene.selection.add(entity)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (pressed) return
    pressed = { button: event.button, x: event.offsetX, y: event.offsetY, dragged: false }
    anchor = event.button === LEFT ? camera.screenToTile(event.offsetX, event.offsetY) : null
    // В редакторе левая кнопка — инструмент редактора, см. Scene.edit.
    if (scene.edit && event.button === LEFT) {
      anchor = null
      scene.edit.press(camera.screenToTile(event.offsetX, event.offsetY), 'down', event.shiftKey)
      canvas.setPointerCapture(event.pointerId)
      return
    }
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
      if (scene.edit) scene.edit.press(camera.screenToTile(event.offsetX, event.offsetY), 'drag', event.shiftKey)
      else if (pressed.dragged) stretchBox()
    } else {
      motion.drag(event.movementX, event.movementY)
    }
  }
  /** Тянет рамку от угла на карте до указателя. */
  const stretchBox = () => {
    if (!pressed?.dragged || !anchor || !camera.pointer || scene.placing || scene.paving) return
    const to = camera.screenToTile(camera.pointer.x, camera.pointer.y)
    scene.selectionBox = { fromX: anchor.x, fromY: anchor.y, toX: to.x, toY: to.y, hits: boxHits(anchor.x, anchor.y, to.x, to.y) }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!pressed || event.button !== pressed.button) return
    const { button, dragged } = pressed
    pressed = null
    if (button !== LEFT) motion.release()
    const point = camera.screenToTile(event.offsetX, event.offsetY)
    // В редакторе правая кнопка — его же: протяжка двигает камеру, щелчок — см. SceneEdit.secondary.
    if (scene.edit) {
      if (button === LEFT) scene.edit.press(point, 'up', event.shiftKey)
      else if (button === RIGHT && !dragged) scene.edit.secondary(point)
      return
    }
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
          const { tool } = stroke
          if (tool === 'well') {
            if (tiles.length === stroke.tiles.length) scene.sim.send(scene.player, { type: 'wells', tiles, builders })
          } else scene.sim.send(scene.player, tool === 'remove' ? { type: 'unpave', tiles, builders } : tool === 'pipe' ? { type: 'pipes', tiles, builders } : { type: 'pave', kind: tool, tiles, builders })
        }
      }
    } else if (scene.placing) {
      if (button === RIGHT && !dragged) scene.placing = null
      const placement = button === LEFT && !dragged ? placementOf(scene) : null
      if (placement?.allowed) {
        const { type, x, y } = placement
        scene.sim.send(scene.player, { type: 'build', building: type, x, y, builders: [...scene.selection], queue: event.shiftKey })
      }
    } else if (button === LEFT) {
      const box = scene.selectionBox
      scene.selectionBox = null
      if (dragged && box) {
        select(boxHits(box.fromX, box.fromY, box.toX, box.toY), event.shiftKey)
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
          // Не юнит — тогда, может быть, своё здание или площадка: с Shift — добавить или снять, двойной щелчок
          // или Ctrl — все свои здания этого вида на экране.
          const tileX = Math.floor(point.x)
          const tileY = Math.floor(point.y)
          const building = scene.sim.occupancy.at(tileX, tileY) ?? siteAt(scene.sim, tileX, tileY)
          const own = building !== undefined && isOwn(scene.sim, scene.player, building)
          const twice = own && lastBuildingClick?.building === building && now - lastBuildingClick.at < DOUBLE_TAP
          lastBuildingClick = own ? { building, at: now } : null
          if (own && (twice || event.ctrlKey || event.metaKey)) {
            const { from, to } = camera.visible
            select(buildingsInBox(from.x, from.y, to.x, to.y, typeOf(building)), event.shiftKey)
          } else if (own && event.shiftKey && scene.selection.has(building)) scene.selection.delete(building)
          else if (own) select([building], event.shiftKey)
          else if (!event.shiftKey) select([], false)
        }
      }
    } else if (button === RIGHT && !dragged && rallying()) {
      // Выбраны свои производящие здания: правый щелчок ставит им точку сбора.
      for (const building of scene.selection) scene.sim.send(scene.player, { type: 'rally', building, x: Math.floor(point.x), y: Math.floor(point.y) })
    } else if (button === RIGHT && !dragged && scene.selection.size) {
      // С Shift приказ встаёт в очередь: юниты возьмутся за него, когда закончат нынешнее.
      scene.sim.send(scene.player, { type: 'order', units: [...scene.selection], x: point.x, y: point.y, queue: event.shiftKey })
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
    // Не трогаем игру, пока пользователь печатает или крутит ползунок в панели, и пока открыто меню.
    if (event.target instanceof HTMLInputElement || paused) return
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
      else if (scene.selection.size) scene.selection.clear()
      // Отменять нечего — Escape открывает меню игры.
      else onMenu()
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
  /** Открыть меню игры: его рисует интерфейс, см. Game.onMenu. */
  let onMenu = () => {}
  /** Открыто меню поверх игры: клавиши и край экрана камеру не двигают. Мышь меню и так закрывает. */
  let paused = false
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
    // Указатель у края экрана двигает камеру только пока тянут рамку выделения: она растёт за край.
    const pointer = paused || !scene.selectionBox ? null : screenPointer
    // Края — у видимой части карты, а не окна: верхняя полоса и нижняя панель закрывают свои края.
    const { inset } = camera
    const edgeX = pointer ? Number(pointer.x >= camera.width - inset.right - EDGE) - Number(pointer.x <= inset.left + EDGE) : 0
    const edgeY = pointer ? Number(pointer.y >= camera.height - inset.bottom - EDGE) - Number(pointer.y <= inset.top + EDGE) : 0
    const right = Math.sign(Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + edgeX)
    const down = Math.sign(Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp')) + edgeY)
    motion.update(seconds, right * speed, down * speed)
    if (scene.edit) {
      // Редактор сам решает, что показать под указателем; выбора места и приказов игрока в нём нет.
      scene.edit.hover(camera.pointerTile)
      for (const entity of scene.selection) if (!scene.sim.world.alive(entity)) scene.selection.delete(entity)
      return
    }
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
    set onMenu(value: () => void) {
      onMenu = value
    },
    get paused() {
      return paused
    },
    set paused(value: boolean) {
      paused = value
      if (value) onBlur()
    },
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
