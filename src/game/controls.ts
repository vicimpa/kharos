import { BUILDING_TYPES, canPlace } from '../sim'
import type { Scene } from './scene'

const KEY_SPEED = 900 // пикселей экрана в секунду

/**
 * Управление с холста и клавиатуры: камера (перетаскивание, колесо, WASD и стрелки), указатель мыши
 * и отладочные клавиши: G — сетка, B — поставить здание под мышью.
 */
export function createControls(canvas: HTMLCanvasElement, scene: Scene) {
  const { camera } = scene
  const keys = new Set<string>()
  let dragging = false
  /** Какое здание поставит следующее нажатие B: типы идут по кругу. */
  let nextType = 0

  const onPointerDown = (event: PointerEvent) => {
    dragging = true
    canvas.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent) => {
    camera.pointer = { x: event.offsetX, y: event.offsetY }
    if (dragging) camera.moveBy(-event.movementX / camera.zoom, -event.movementY / camera.zoom)
  }
  const onPointerUp = () => {
    dragging = false
  }
  const onPointerLeave = () => {
    camera.pointer = null
  }
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    // Точка под курсором остаётся на месте.
    camera.zoomTo(camera.zoom * Math.exp(-event.deltaY * 0.0015), event.offsetX, event.offsetY)
  }

  const placeUnderPointer = () => {
    const tile = camera.pointerTile
    if (!tile) return
    const type = BUILDING_TYPES[nextType % BUILDING_TYPES.length]
    // Проверка здесь — только чтобы не слать заведомо негодную команду; решает симуляция.
    if (!canPlace(scene.sim, type, tile.x, tile.y)) return
    scene.sim.send({ type: 'placeBuilding', building: type, x: tile.x, y: tile.y })
    nextType++
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Не трогаем игру, пока пользователь печатает или крутит ползунок в панели.
    if (event.target instanceof HTMLInputElement) return
    keys.add(event.code)
    if (event.code === 'KeyG') scene.grid = !scene.grid
    if (event.code === 'KeyB') placeUnderPointer()
  }
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code)
  const onBlur = () => keys.clear()

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  /** Раз в кадр: двигает камеру, пока зажаты клавиши. seconds — время с прошлого кадра. */
  const update = (seconds: number) => {
    const step = (KEY_SPEED * seconds) / camera.zoom
    const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'))
    const down = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'))
    if (right || down) camera.moveBy(right * step, down * step)
  }

  return {
    update,
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}
