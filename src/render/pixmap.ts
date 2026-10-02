/**
 * Растровый холст в памяти: простые фигуры без сглаживания. Пиксель закрашивается, если его центр попал в фигуру,
 * поэтому векторный чертёж выходит пиксель-артом. Работает без браузера и видеокарты.
 * Цвета — числа вида 0xRRGGBB, фигуры непрозрачные.
 */
export class Pixmap {
  /** Пиксели RGBA, строки сверху вниз. */
  readonly data: Uint8Array
  /** Начало координат фигур в пикселях холста. */
  originX = 0
  originY = 0

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4)
  }

  clear() {
    this.data.fill(0)
    return this
  }

  rect(x: number, y: number, width: number, height: number, color: number) {
    return this.fill(x, y, x + width, y + height, color, () => true)
  }

  circle(centerX: number, centerY: number, radius: number, color: number) {
    return this.fill(centerX - radius, centerY - radius, centerX + radius, centerY + radius, color, (x, y) => {
      return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2
    })
  }

  /** Окружность линией толщиной width. */
  ring(centerX: number, centerY: number, radius: number, width: number, color: number) {
    const outer = radius + width / 2
    return this.fill(centerX - outer, centerY - outer, centerX + outer, centerY + outer, color, (x, y) => {
      return Math.abs(Math.hypot(x - centerX, y - centerY) - radius) <= width / 2
    })
  }

  /** Отрезок толщиной width с прямыми торцами. */
  line(fromX: number, fromY: number, toX: number, toY: number, width: number, color: number) {
    const dx = toX - fromX
    const dy = toY - fromY
    const length = Math.hypot(dx, dy)
    if (!length) return this
    const half = width / 2
    return this.fill(
      Math.min(fromX, toX) - half,
      Math.min(fromY, toY) - half,
      Math.max(fromX, toX) + half,
      Math.max(fromY, toY) + half,
      color,
      (x, y) => {
        const along = ((x - fromX) * dx + (y - fromY) * dy) / length
        const across = ((x - fromX) * dy - (y - fromY) * dx) / length
        return along >= 0 && along <= length && Math.abs(across) <= half
      },
    )
  }

  /** Закрашивает пиксели в границах (left, top) — (right, bottom), центр которых проходит проверку inside. */
  private fill(
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: number,
    inside: (x: number, y: number) => boolean,
  ) {
    const { data, width, height, originX, originY } = this
    // Пиксель с номером i занимает отрезок [i, i + 1), его центр — i + 0.5.
    const fromX = Math.max(0, Math.ceil(left + originX - 0.5))
    const toX = Math.min(width - 1, Math.ceil(right + originX - 0.5) - 1)
    const fromY = Math.max(0, Math.ceil(top + originY - 0.5))
    const toY = Math.min(height - 1, Math.ceil(bottom + originY - 0.5) - 1)
    for (let pixelY = fromY; pixelY <= toY; pixelY++) {
      for (let pixelX = fromX; pixelX <= toX; pixelX++) {
        if (!inside(pixelX + 0.5 - originX, pixelY + 0.5 - originY)) continue
        const offset = (pixelY * width + pixelX) * 4
        data[offset] = color >> 16
        data[offset + 1] = (color >> 8) & 255
        data[offset + 2] = color & 255
        data[offset + 3] = 255
      }
    }
    return this
  }
}
