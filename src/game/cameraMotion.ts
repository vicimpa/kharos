import type { Camera, Point } from './camera'

/** Разгон от клавиш: за столько секунд камера набирает две трети скорости. */
const ACCELERATION = 0.15
/** Торможение: отпущенная камера катится ещё немного и за несколько таких отрезков встаёт. */
const DECELERATION = 0.25
/** Медленнее этого, пикселей экрана в секунду, камера уже стоит. */
const REST = 4
/** Масштаб догоняет колесо: за столько секунд он проходит две трети пути. */
const ZOOM_SMOOTHING = 0.09
/** Ближе этого к цели масштаб встаёт на неё, в долях масштаба. */
const ZOOM_ARRIVED = 0.001
/** Полёт к точке: пружина без перелёта. Чем больше, тем быстрее: почти на месте камера через 5 / FLIGHT секунд. */
const FLIGHT = 6
/** Ближе этого к цели, в пикселях экрана, полёт закончен. */
const FLIGHT_ARRIVED = 0.5
/** Скорость мыши, которой тянут камеру, сглаживается за столько секунд: случайный рывок не бросает камеру. */
const DRAG_SMOOTHING = 0.05
/** Если мышь стояла дольше этого перед тем, как её отпустили, — камеру остановили, а не бросили. В секундах. */
const FLING_WINDOW = 0.08

/**
 * Движение камеры с разгоном и торможением. Клавиши задают скорость, к которой камера разгоняется, а отпущенные —
 * камера плавно тормозит. Тянут мышью — камера идёт за ней точно, а брошенная катится дальше. Колесо задаёт
 * масштаб, который камера плавно догоняет, держа на месте точку под курсором. Полёт к точке — разгон и торможение
 * без перелёта. Мини-карта переставляет камеру сразу (jump), и это гасит всё движение.
 *
 * Заодно меряет, как быстро камера несётся над картой: от этого зависит звук полёта.
 */
export class CameraMotion {
  /** Скорость камеры, пикселей экрана в секунду. */
  velocityX = 0
  velocityY = 0
  /** Как быстро камера неслась над картой в прошлом кадре, тайлов в секунду: сдвиг и то, как разбегались углы экрана от зума. */
  speed = 0
  /** Масштаб, к которому идёт камера; null — масштаб не меняется. */
  private zoomTarget: number | null = null
  /** Точка экрана, которая стоит на месте, пока меняется масштаб. */
  private zoomAnchor: Point = { x: 0, y: 0 }
  /** Куда камера летит сама, в тайлах, и её скорость в полёте, тайлов в секунду. null — не летит. */
  private flight: Point | null = null
  private flightVelocityX = 0
  private flightVelocityY = 0
  /** Тянут ли камеру мышью, на сколько пикселей с прошлого кадра, с какой скоростью и сколько секунд назад был сдвиг. */
  private dragging = false
  private draggedX = 0
  private draggedY = 0
  private dragVelocityX = 0
  private dragVelocityY = 0
  private sinceDrag = Infinity
  /** Где камера была на прошлом замере; null — её переставили, и скачок не считается полётом. */
  private last: { x: number; y: number; zoom: number } | null = null

  /** Простое управление, для редактора: без разгона, инерции, полёта и плавного масштаба — всё сразу. */
  simple = false

  constructor(readonly camera: Camera) {}

  /** Летит ли камера сама к точке. */
  get flying() {
    return this.flight !== null
  }

  /** Колесо: масштаб в factor раз от того, к которому камера уже идёт. Точка экрана (x, y) остаётся на месте. */
  zoomBy(factor: number, x: number, y: number) {
    if (this.simple) return this.camera.zoomTo(this.camera.clampZoom(this.camera.zoom * factor), x, y)
    this.zoomTarget = this.camera.clampZoom((this.zoomTarget ?? this.camera.zoom) * factor)
    this.zoomAnchor = { x, y }
  }

  /** Камеру тянут мышью на (dx, dy) пикселей экрана: она идёт за мышью сразу, без разгона. */
  drag(dx: number, dy: number) {
    const { camera } = this
    camera.moveBy(-dx / camera.zoom, -dy / camera.zoom)
    this.dragging = true
    this.draggedX += dx
    this.draggedY += dy
    this.sinceDrag = 0
    this.flight = null
    this.velocityX = this.velocityY = 0
  }

  /** Мышь отпустили: если её ещё тянули в последний миг, камера катится дальше с той же скоростью. */
  release() {
    if (!this.dragging) return
    this.dragging = false
    if (this.sinceDrag <= FLING_WINDOW && !this.simple) {
      this.velocityX = -this.dragVelocityX
      this.velocityY = -this.dragVelocityY
    }
    this.draggedX = this.draggedY = this.dragVelocityX = this.dragVelocityY = 0
  }

  /** Камера летит так, чтобы точка (x, y) в тайлах оказалась в середине видимой части. */
  flyTo(x: number, y: number) {
    if (this.simple) return this.jump(x, y)
    if (!this.flight) this.flightVelocityX = this.flightVelocityY = 0
    this.flight = { x, y }
    this.velocityX = this.velocityY = 0
  }

  /** Сразу ставит точку (x, y) в тайлах в середину видимой части: без полёта, разгона и звука. */
  jump(x: number, y: number) {
    this.camera.centerOn(x, y)
    this.flight = null
    this.velocityX = this.velocityY = 0
    this.last = null
  }

  /**
   * Раз в кадр двигает камеру. (thrustX, thrustY) — скорость, которую просят клавиши, пикселей экрана в секунду:
   * к ней камера разгоняется, а без неё тормозит. Клавиши прерывают полёт.
   */
  update(seconds: number, thrustX = 0, thrustY = 0) {
    const { camera } = this
    if (seconds <= 0) return

    // Скорость мыши — за кадр, сглаженная: по ней камеру бросают.
    const drag = 1 - Math.exp(-seconds / DRAG_SMOOTHING)
    this.dragVelocityX += (this.draggedX / seconds - this.dragVelocityX) * drag
    this.dragVelocityY += (this.draggedY / seconds - this.dragVelocityY) * drag
    this.draggedX = this.draggedY = 0
    this.sinceDrag += seconds

    const thrust = thrustX !== 0 || thrustY !== 0
    if (thrust) this.flight = null
    // Простое управление: скорость — ровно та, что просят клавиши.
    const blend = this.simple ? 1 : 1 - Math.exp(-seconds / (thrust ? ACCELERATION : DECELERATION))
    this.velocityX += (thrustX - this.velocityX) * blend
    this.velocityY += (thrustY - this.velocityY) * blend
    if (!thrust && Math.hypot(this.velocityX, this.velocityY) < REST) this.velocityX = this.velocityY = 0
    if (this.velocityX || this.velocityY) camera.moveBy((this.velocityX * seconds) / camera.zoom, (this.velocityY * seconds) / camera.zoom)

    if (this.flight) {
      // Пружина без перелёта, решённая точно: шаг устойчив при любой длине кадра.
      // Сдвиг от цели x(t) = (x0 + (v0 + ωx0)t)e^(-ωt), скорость v(t) = (v0 - ω(v0 + ωx0)t)e^(-ωt).
      const focus = camera.focus
      const fade = Math.exp(-FLIGHT * seconds)
      const pullX = this.flightVelocityX + FLIGHT * (focus.x - this.flight.x)
      const pullY = this.flightVelocityY + FLIGHT * (focus.y - this.flight.y)
      const offsetX = (focus.x - this.flight.x + pullX * seconds) * fade
      const offsetY = (focus.y - this.flight.y + pullY * seconds) * fade
      this.flightVelocityX = (this.flightVelocityX - FLIGHT * pullX * seconds) * fade
      this.flightVelocityY = (this.flightVelocityY - FLIGHT * pullY * seconds) * fade
      const arrived =
        Math.hypot(offsetX, offsetY) * camera.zoom < FLIGHT_ARRIVED &&
        Math.hypot(this.flightVelocityX, this.flightVelocityY) * camera.zoom < FLIGHT_ARRIVED * FLIGHT
      camera.centerOn(this.flight.x + (arrived ? 0 : offsetX), this.flight.y + (arrived ? 0 : offsetY))
      if (arrived) {
        this.flight = null
        this.flightVelocityX = this.flightVelocityY = 0
      }
    }

    if (this.zoomTarget !== null) {
      const target = camera.clampZoom(this.zoomTarget)
      const next = camera.zoom * Math.pow(target / camera.zoom, 1 - Math.exp(-seconds / ZOOM_SMOOTHING))
      const arrived = Math.abs(Math.log(target / next)) < ZOOM_ARRIVED
      // В полёте масштаб меняется вокруг середины экрана: туда камера и летит.
      const anchor = this.flight ? camera.viewCenter : this.zoomAnchor
      camera.zoomTo(arrived ? target : next, anchor.x, anchor.y)
      if (arrived) this.zoomTarget = null
    }
  }

  /** Замер после всех сдвигов кадра, включая упор в границы карты: сколько камера на самом деле пролетела. */
  measure(seconds: number) {
    const { camera } = this
    const last = this.last
    this.last = { x: camera.x, y: camera.y, zoom: camera.zoom }
    if (!last || seconds <= 0) {
      this.speed = 0
      return
    }
    const pan = Math.hypot(camera.x - last.x, camera.y - last.y)
    // Зум — как быстро уходят к краям или набегают из-за них углы экрана.
    const halfDiagonal = Math.hypot(camera.width, camera.height) / 2
    const dive = Math.abs(halfDiagonal / camera.zoom - halfDiagonal / last.zoom)
    this.speed = (pan + dive) / seconds
  }
}
