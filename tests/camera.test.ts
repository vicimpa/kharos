import { expect, test } from 'bun:test'
import { Camera } from '../src/game/camera'
import { CameraMotion } from '../src/game/cameraMotion'

const FRAME = 1 / 60

const setup = () => {
  const camera = new Camera()
  camera.width = 1280
  camera.height = 720
  return { camera, motion: new CameraMotion(camera) }
}

/** Гоняет кадры: seconds секунд по frame. */
const run = (motion: CameraMotion, seconds: number, thrustX = 0, thrustY = 0, frame = FRAME) => {
  for (let t = 0; t < seconds - 1e-9; t += frame) motion.update(frame, thrustX, thrustY)
}

test('клавиши разгоняют камеру постепенно, а отпущенные — она тормозит и встаёт', () => {
  const { camera, motion } = setup()
  motion.update(FRAME, 900, 0)
  expect(motion.velocityX).toBeGreaterThan(0)
  expect(motion.velocityX).toBeLessThan(200)
  run(motion, 1, 900, 0)
  expect(motion.velocityX).toBeGreaterThan(890)

  const released = camera.x
  run(motion, 0.1)
  // Ещё катится, но медленнее.
  expect(camera.x).toBeGreaterThan(released)
  expect(motion.velocityX).toBeLessThan(900)
  expect(motion.velocityX).toBeGreaterThan(0)
  run(motion, 3)
  expect(motion.velocityX).toBe(0)
  const stopped = camera.x
  run(motion, 1)
  expect(camera.x).toBe(stopped)
})

test('колесо меняет масштаб плавно, и точка под курсором остаётся на месте', () => {
  const { camera, motion } = setup()
  const anchor = { x: 900, y: 200 }
  const before = camera.screenToTile(anchor.x, anchor.y)
  motion.zoomBy(2, anchor.x, anchor.y)
  motion.update(FRAME)
  expect(camera.zoom).toBeGreaterThan(32)
  expect(camera.zoom).toBeLessThan(48)
  run(motion, 1)
  expect(camera.zoom).toBe(64)
  const after = camera.screenToTile(anchor.x, anchor.y)
  expect(after.x).toBeCloseTo(before.x, 6)
  expect(after.y).toBeCloseTo(before.y, 6)

  // Колесо копит цель: два щелчка подряд — вдвое дальше, но не за пределы.
  motion.zoomBy(0.5, anchor.x, anchor.y)
  motion.zoomBy(0.5, anchor.x, anchor.y)
  run(motion, 1)
  expect(camera.zoom).toBe(16)
  for (let i = 0; i < 20; i++) motion.zoomBy(0.5, anchor.x, anchor.y)
  run(motion, 1)
  expect(camera.zoom).toBe(camera.clampZoom(0))
  motion.zoomBy(2, anchor.x, anchor.y)
  run(motion, 1)
  expect(camera.zoom).toBe(camera.clampZoom(0) * 2)
})

test('полёт к точке: разгон, торможение без перелёта и остановка точно на цели — даже при длинных кадрах', () => {
  for (const frame of [FRAME, 0.25]) {
    const { camera, motion } = setup()
    motion.flyTo(500, -300)
    let distance = Infinity
    let steps = 0
    const speeds: number[] = []
    while (motion.flying && steps++ < 1000) {
      motion.update(frame)
      const focus = camera.focus
      const next = Math.hypot(focus.x - 500, focus.y + 300)
      expect(next).toBeLessThanOrEqual(distance + 1e-9)
      speeds.push(distance - next)
      distance = next
    }
    expect(motion.flying).toBe(false)
    expect(camera.focus.x).toBeCloseTo(500, 6)
    expect(camera.focus.y).toBeCloseTo(-300, 6)
    // Не скачок: сначала разгон, потом торможение.
    if (frame === FRAME) {
      const peak = speeds.indexOf(Math.max(...speeds.slice(1)))
      expect(peak).toBeGreaterThan(2)
      expect(speeds[speeds.length - 1]).toBeLessThan(speeds[peak] / 100)
    }
  }
})

test('клавиши прерывают полёт', () => {
  const { motion } = setup()
  motion.flyTo(500, 0)
  run(motion, 0.1)
  motion.update(FRAME, 0, 900)
  expect(motion.flying).toBe(false)
})

test('брошенная мышью камера катится дальше, а остановленная перед отпусканием — нет', () => {
  const { camera, motion } = setup()
  for (let i = 0; i < 10; i++) {
    motion.drag(-30, 0)
    motion.update(FRAME)
  }
  const dragged = camera.x
  expect(dragged).toBeCloseTo((30 * 10) / 32, 6)
  motion.release()
  expect(motion.velocityX).toBeGreaterThan(1000)
  run(motion, 0.5)
  expect(camera.x).toBeGreaterThan(dragged + 1)

  const still = setup()
  for (let i = 0; i < 10; i++) {
    still.motion.drag(-30, 0)
    still.motion.update(FRAME)
  }
  run(still.motion, 0.3)
  still.motion.release()
  expect(still.motion.velocityX).toBe(0)
})

test('замер скорости: полёт считается, а прыжок по мини-карте — нет', () => {
  const { motion } = setup()
  run(motion, 1, 900, 0)
  motion.measure(FRAME)
  motion.update(FRAME, 900, 0)
  motion.measure(FRAME)
  // 900 пикселей в секунду при 32 пикселях на тайл.
  expect(motion.speed).toBeCloseTo(900 / 32, 0)

  motion.jump(10000, 10000)
  motion.update(FRAME)
  motion.measure(FRAME)
  expect(motion.speed).toBe(0)
  expect(motion.velocityX).toBe(0)
})
