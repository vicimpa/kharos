import { useEffect, useRef, useState } from 'preact/hooks'
import type { Scene } from '../game/scene'
import { createLandWindow, minZoom, type LandWindow } from '../map/landWindow'
import { DEFAULT_SETTINGS } from '../map/settings'
import { createLand } from '../map/terrain'
import { createTerrainPass } from '../map/terrainPass'
import { createRenderer } from '../render/renderer'

/** Скорость полёта клавишами: экранов в секунду. */
const KEY_SPEED = 0.8
const MAX_ZOOM = 96

/** Страница для отладки местности: открывается по /test или ?test. */
export const isTerrainTest = () => location.pathname.replace(/\/$/, '').endsWith('/test') || new URLSearchParams(location.search).has('test')

/**
 * Одна местность без симуляции: полёт над картой, чтобы посмотреть генератор и шейдер. Мышь тянет карту, колесо
 * меняет масштаб, WASD и стрелки — полёт, R — новое зерно, G — сетка.
 */
export function TerrainTest() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statsRef = useRef<HTMLSpanElement>(null)
  const [seed, setSeed] = useState(() => Number(new URLSearchParams(location.search).get('seed')) || DEFAULT_SETTINGS.generator.seed)

  useEffect(() => {
    const canvas = canvasRef.current!
    const land = createLand({ ...DEFAULT_SETTINGS.generator, seed })
    // Проходу местности из сцены нужны только настройки отрисовки и сетка.
    const scene = { settings: DEFAULT_SETTINGS, grid: false } as Scene
    const query = new URLSearchParams(location.search)
    const camera = { x: Number(query.get('x')) || 0, y: Number(query.get('y')) || 0, zoom: Number(query.get('zoom')) || 24 }
    let landWindow: LandWindow
    const renderer = createRenderer(canvas, (gl) => {
      landWindow = createLandWindow(gl)
      return [createTerrainPass(gl, scene, landWindow)]
    })

    const keys = new Set<string>()
    const onKey = (event: KeyboardEvent) => {
      if (event.type === 'keyup') return void keys.delete(event.code)
      keys.add(event.code)
      if (event.code === 'KeyG') scene.grid = !scene.grid
      if (event.code === 'KeyR') setSeed(Math.floor(Math.random() * 2 ** 31))
    }
    let drag: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
    }
    const onMove = (event: PointerEvent) => {
      if (!drag) return
      camera.x -= (event.clientX - drag.x) / camera.zoom
      camera.y -= (event.clientY - drag.y) / camera.zoom
      drag = { x: event.clientX, y: event.clientY }
    }
    const onUp = () => (drag = null)
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      // Точка под курсором остаётся на месте.
      const dx = event.clientX - rect.left - rect.width / 2
      const dy = event.clientY - rect.top - rect.height / 2
      const before = { x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom }
      camera.zoom = Math.min(MAX_ZOOM, Math.max(minZoom(rect.width, rect.height), camera.zoom * Math.exp(-event.deltaY * 0.002)))
      camera.x = before.x - dx / camera.zoom
      camera.y = before.y - dy / camera.zoom
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let frame = 0
    let last = performance.now()
    // Среднее время кадра за полсекунды: по нему видно, во что обходится шейдер.
    let frames = 0
    let measured = last
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const seconds = Math.min(0.1, (now - last) / 1000)
      last = now
      frames++
      if (now - measured > 500) {
        if (statsRef.current) statsRef.current.textContent = `${((now - measured) / frames).toFixed(1)} мс · зум ${camera.zoom.toFixed(1)}`
        frames = 0
        measured = now
      }
      const { width, height } = renderer.resize()
      camera.zoom = Math.max(camera.zoom, minZoom(width, height))
      const step = (KEY_SPEED * Math.max(width, height) * seconds) / camera.zoom
      if (keys.has('KeyA') || keys.has('ArrowLeft')) camera.x -= step
      if (keys.has('KeyD') || keys.has('ArrowRight')) camera.x += step
      if (keys.has('KeyW') || keys.has('ArrowUp')) camera.y -= step
      if (keys.has('KeyS') || keys.has('ArrowDown')) camera.y += step
      if (renderer.lost) return
      landWindow.update(land, camera, width, height)
      renderer.draw(camera, now / 1000, seconds)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      renderer.destroy()
    }
  }, [seed])

  return (
    <main class="game">
      <canvas ref={canvasRef} class="game__canvas" />
      <div class="terrain-test"><span ref={statsRef} /> · зерно {seed} · мышь, колесо, WASD · R — новое зерно · G — сетка</div>
    </main>
  )
}
