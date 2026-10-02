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
  /** Указатель мыши в пикселях экрана; null — указатель вне холста. */
  pointer: Point | null = null

  /** Тайл под указателем мыши. */
  get pointerTile(): Point | null {
    if (!this.pointer) return null
    const { x, y } = this.screenToTile(this.pointer.x, this.pointer.y)
    return { x: Math.floor(x), y: Math.floor(y) }
  }

  /** Сдвиг в тайлах. */
  moveBy(dx: number, dy: number) {
    this.x += dx
    this.y += dy
  }

  /** Меняет масштаб; точка экрана (anchorX, anchorY) остаётся на месте. По умолчанию это центр экрана. */
  zoomTo(zoom: number, anchorX = this.width / 2, anchorY = this.height / 2) {
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
