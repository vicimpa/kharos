const MIN_ZOOM = 4
const MAX_ZOOM = 96

export interface Point {
  x: number
  y: number
}

/** Камера игры: куда смотрим и в каком масштабе. Заодно помнит, где указатель мыши. */
export class Camera {
  /** Центр экрана в тайлах. */
  x = 0
  y = 0
  /** Пикселей на тайл. Менять через zoomTo(): он держит масштаб в допустимых пределах. */
  zoom = 32
  /** Нижняя граница масштаба. Её поднимает карта: слишком мелкий экран не помещается в окно местности. */
  minZoom = MIN_ZOOM
  /** Размер экрана в пикселях CSS. */
  width = 1
  height = 1
  /**
   * Сколько пикселей холста по краям закрыто интерфейсом: верхней полосой и нижней панелью. Видимая часть мира —
   * между ними; её середина — то, на что «смотрит» камера: туда наводят, её держат в границах карты.
   */
  inset = { top: 0, right: 0, bottom: 0, left: 0 }
  /** Указатель мыши в пикселях экрана; null — указатель вне холста. */
  pointer: Point | null = null

  /** Тайл под указателем мыши. */
  get pointerTile(): Point | null {
    if (!this.pointer) return null
    const { x, y } = this.screenToTile(this.pointer.x, this.pointer.y)
    return { x: Math.floor(x), y: Math.floor(y) }
  }

  /** Середина видимой части холста в пикселях экрана. */
  get viewCenter(): Point {
    return {
      x: (this.inset.left + this.width - this.inset.right) / 2,
      y: (this.inset.top + this.height - this.inset.bottom) / 2,
    }
  }

  /** Тайл в середине видимой части. */
  get focus(): Point {
    const { x, y } = this.viewCenter
    return this.screenToTile(x, y)
  }

  /** Ставит камеру так, чтобы точка (x, y) в тайлах оказалась в середине видимой части. */
  centerOn(x: number, y: number) {
    const focus = this.focus
    this.x += x - focus.x
    this.y += y - focus.y
  }

  /** Видимая часть в тайлах: левый верхний и правый нижний углы. */
  get visible() {
    return {
      from: this.screenToTile(this.inset.left, this.inset.top),
      to: this.screenToTile(this.width - this.inset.right, this.height - this.inset.bottom),
    }
  }

  /** Сдвиг в тайлах. */
  moveBy(dx: number, dy: number) {
    this.x += dx
    this.y += dy
  }

  /** Меняет масштаб; точка экрана (anchorX, anchorY) остаётся на месте. По умолчанию это середина видимой части. */
  zoomTo(zoom: number, anchorX = this.viewCenter.x, anchorY = this.viewCenter.y) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.minZoom, zoom))
    const offsetX = anchorX - this.width / 2
    const offsetY = anchorY - this.height / 2
    this.x += offsetX / this.zoom - offsetX / next
    this.y += offsetY / this.zoom - offsetY / next
    this.zoom = next
  }

  /** Пиксели экрана → тайлы (дробные). */
  screenToTile(screenX: number, screenY: number): Point {
    return {
      x: this.x + (screenX - this.width / 2) / this.zoom,
      y: this.y + (screenY - this.height / 2) / this.zoom,
    }
  }

  /** Тайлы → пиксели экрана. */
  tileToScreen(tileX: number, tileY: number): Point {
    return {
      x: this.width / 2 + (tileX - this.x) * this.zoom,
      y: this.height / 2 + (tileY - this.y) * this.zoom,
    }
  }
}
