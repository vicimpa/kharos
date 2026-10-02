import type { Entity } from '../ecs'
import { BUILDING_TYPES, Owner, Position, UNITS, UNIT_TYPES, Unit, canPlace, isWalkable } from '../sim'
import type { Scene } from './scene'

const KEY_SPEED = 900 // пикселей экрана в секунду
/** Если мышь с нажатой кнопкой сдвинулась меньше, это щелчок, а не перетаскивание. В пикселях экрана. */
const CLICK_SLOP = 4
/** Насколько мимо юнита можно щёлкнуть, чтобы всё равно выбрать его. В пикселях экрана. */
const PICK_MARGIN = 6
const LEFT = 0
const RIGHT = 2

/**
 * Управление с холста и клавиатуры.
 * Левая кнопка — выделение: щелчок по юниту или рамка; с Shift — добавить к выбранным.
 * Правая кнопка — приказ выбранным идти в точку; если её тянуть (или среднюю) — двигается камера.
 * Колесо — масштаб, WASD и стрелки — камера.
 * Отладочные клавиши: G — сетка, B — поставить здание под мышью, U — создать юнит под мышью.
 */
export function createControls(canvas: HTMLCanvasElement, scene: Scene) {
  const { camera } = scene
  const keys = new Set<string>()
  /** Какая кнопка сейчас зажата на холсте и где её нажали, в пикселях экрана. */
  let pressed: { button: number; x: number; y: number; dragged: boolean } | null = null
  /** Какое здание и какой юнит создаст следующее нажатие B и U: виды идут по кругу. */
  let nextBuilding = 0
  let nextUnit = 0

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

  /** Свой юнит под точкой в тайлах: ближайший из тех, в чей круг она попала. */
  const unitAt = (x: number, y: number) => {
    const { world } = scene.sim
    const margin = PICK_MARGIN / camera.zoom
    let best: Entity | undefined
    let bestDistance = Infinity
    for (const [entity, position, unit, owner] of world.query(Position, Unit, Owner)) {
      if (owner.player !== scene.player) continue
      const distance = Math.hypot(position.x - x, position.y - y)
      if (distance > UNITS[unit.type].radius + margin || distance >= bestDistance) continue
      best = entity
      bestDistance = distance
    }
    return best
  }

  const select = (units: Entity[], add: boolean) => {
    if (!add) scene.selection.clear()
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
      if (!pressed.dragged) return
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

    if (button === LEFT) {
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
        select(unit === undefined ? [] : [unit], event.shiftKey)
      }
    } else if (button === RIGHT && !dragged && scene.selection.size) {
      scene.sim.send(scene.player, {
        type: 'move',
        units: [...scene.selection],
        x: Math.floor(point.x),
        y: Math.floor(point.y),
      })
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

  // Проверки здесь — только чтобы не слать заведомо негодную команду; решает симуляция.
  const placeUnderPointer = () => {
    const tile = camera.pointerTile
    if (!tile) return
    const building = BUILDING_TYPES[nextBuilding % BUILDING_TYPES.length]
    if (!canPlace(scene.sim, building, tile.x, tile.y)) return
    scene.sim.send(scene.player, { type: 'placeBuilding', building, x: tile.x, y: tile.y })
    nextBuilding++
  }
  const spawnUnderPointer = () => {
    const tile = camera.pointerTile
    if (!tile || !isWalkable(scene.sim, tile.x, tile.y)) return
    scene.sim.send(scene.player, { type: 'spawnUnit', unit: UNIT_TYPES[nextUnit % UNIT_TYPES.length], x: tile.x, y: tile.y })
    nextUnit++
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Не трогаем игру, пока пользователь печатает или крутит ползунок в панели.
    if (event.target instanceof HTMLInputElement) return
    keys.add(event.code)
    if (event.code === 'KeyG') scene.grid = !scene.grid
    if (event.code === 'KeyB') placeUnderPointer()
    if (event.code === 'KeyU') spawnUnderPointer()
    if (event.code === 'Escape') scene.selection.clear()
  }
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code)
  const onBlur = () => keys.clear()

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

  /** Раз в кадр: двигает камеру, пока зажаты клавиши. seconds — время с прошлого кадра. */
  const update = (seconds: number) => {
    const step = (KEY_SPEED * seconds) / camera.zoom
    const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'))
    const down = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'))
    if (right || down) camera.moveBy(right * step, down * step)

    // Погибшие и исчезнувшие юниты выпадают из выделения.
    for (const entity of scene.selection) if (!scene.sim.world.has(entity, Unit)) scene.selection.delete(entity)
  }

  return {
    update,
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
    },
  }
}
