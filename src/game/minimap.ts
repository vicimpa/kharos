import { biomeAt, terrainAt, type Land } from '../map/terrain'
import { Building, DEPOSIT_CELL, Owner, Position, Site, Unit, buildingSpec, depositsIn, type Sim } from '../sim'
import { ALERT_SECONDS } from './alerts'
import { cssColor } from './resourceColors'
import type { Scene } from './scene'

/** Сторона мини-карты в пикселях холста. Карта квадратная: один пиксель — несколько тайлов. */
export const MINIMAP_SIZE = 192
/** Сколько миллисекунд за кадр можно тратить на подготовку местности мини-карты. */
const BUDGET = 4

/**
 * Цвета местности по биомам, [песок, скала, болото, горы] — средние тона палитр terrain.frag.
 * Мини-карта — схема: детали шейдера ей не нужны.
 */
export const PALETTE: [number, number, number][][] = [
  [[194, 153, 69], [99, 69, 15], [54, 51, 26], [140, 104, 40]],
  [[209, 201, 179], [94, 92, 84], [77, 133, 133], [130, 128, 120]],
  [[179, 92, 41], [84, 36, 20], [69, 33, 18], [128, 64, 36]],
  [[133, 122, 56], [69, 64, 33], [26, 54, 33], [100, 95, 52]],
]

const OWN = '#5aa9ff'
const FOE = '#ff6b5a'
const NEUTRAL = '#c8c8c8'

/**
 * Мини-карта: местность всей карты, месторождения, здания и юниты точками и рамка того, что видно на экране.
 * Местность считается по кусочку за кадр, чтобы не подвесить игру: карта проявляется сверху вниз.
 */
/** Насколько тёмен туман на мини-карте, 0–255: не разведано, разведано, видно. */
const FOG_ALPHA = [235, 120, 0]

export function createMinimap(scene: Scene) {
  const fog = new ImageData(MINIMAP_SIZE, MINIMAP_SIZE)
  const fogCanvas = new OffscreenCanvas(MINIMAP_SIZE, MINIMAP_SIZE)
  let fogChanged = -1
  let fogCells: Uint8Array | null = null
  let sim: Sim | null = null
  let terrain: ImageData | null = null
  let canvas: OffscreenCanvas | null = null
  let row = 0
  /** С какой картой и правкой рисуется местность: клиенту настоящая карта приходит после приветствия, а правки — по ходу игры. */
  let land: Land | null = null
  let revision = 0
  let deposits: { x: number; y: number; color: string }[] = []

  /**
   * Как карта ложится на квадрат мини-карты: вписана по большей стороне, по центру. scale — пикселей на тайл,
   * (left, top) — тайл в левом верхнем углу мини-карты, span — сколько тайлов в её стороне.
   */
  const fit = ({ left, top, right, bottom }: Sim['bounds']) => {
    const span = Math.max(right - left, bottom - top)
    return { span, scale: MINIMAP_SIZE / span, left: left - (span - (right - left)) / 2, top: top - (span - (bottom - top)) / 2 }
  }

  /** Мир сменился — местность считается заново. */
  const reset = () => {
    sim = scene.sim
    terrain = new ImageData(MINIMAP_SIZE, MINIMAP_SIZE)
    canvas = new OffscreenCanvas(MINIMAP_SIZE, MINIMAP_SIZE)
    row = 0
    const { left, top, right, bottom } = sim.bounds
    deposits = []
    for (let cellY = Math.floor(top / DEPOSIT_CELL); cellY * DEPOSIT_CELL < bottom; cellY++) {
      for (let cellX = Math.floor(left / DEPOSIT_CELL); cellX * DEPOSIT_CELL < right; cellX++) {
        for (const spot of depositsIn(sim, cellX, cellY)) deposits.push({ x: spot.x + 1, y: spot.y + 1, color: cssColor(spot.kind) })
      }
    }
  }

  /** Досчитывает строки местности, пока не выйдет время кадра. */
  const prepare = () => {
    if (!sim || !terrain || row >= MINIMAP_SIZE) return
    const { bounds } = sim
    const view = fit(bounds)
    const start = performance.now()
    while (row < MINIMAP_SIZE && performance.now() - start < BUDGET) {
      const y = view.top + (row + 0.5) / view.scale
      for (let column = 0; column < MINIMAP_SIZE; column++) {
        const x = view.left + (column + 0.5) / view.scale
        const index = (row * MINIMAP_SIZE + column) * 4
        // Вне карты — прозрачно: там фон мини-карты.
        if (x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom) {
          terrain.data[index + 3] = 0
          continue
        }
        const [r, g, b] = PALETTE[biomeAt(sim.land, x, y)][terrainAt(sim.land, x, y)]
        terrain.data[index] = r
        terrain.data[index + 1] = g
        terrain.data[index + 2] = b
        terrain.data[index + 3] = 255
      }
      row++
    }
    canvas!.getContext('2d')!.putImageData(terrain, 0, 0)
  }

  return {
    /** Рисует мини-карту на холст размером MINIMAP_SIZE. */
    draw(context: CanvasRenderingContext2D) {
      if (sim !== scene.sim) reset()
      if (land !== scene.sim.land || revision !== scene.sim.land.revision) {
        land = scene.sim.land
        revision = land.revision
        row = 0
      }
      prepare()
      const { world, bounds } = scene.sim
      const view = fit(bounds)
      const { scale } = view
      const toX = (x: number) => (x - view.left) * scale
      const toY = (y: number) => (y - view.top) * scale

      context.fillStyle = '#05090f'
      context.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE)
      context.drawImage(canvas!, 0, 0)

      for (const { x, y, color } of deposits) {
        if (!scene.sim.vision.explored(scene.player, x, y)) continue
        context.fillStyle = color
        context.fillRect(toX(x) - 1, toY(y) - 1, 2, 2)
      }
      // Туман: как на карте, только пиксель — несколько тайлов.
      const { cells, changed } = scene.sim.vision.cells(scene.player)
      if (changed !== fogChanged || cells !== fogCells) {
        fogChanged = changed
        fogCells = cells
        const width = bounds.right - bounds.left
        const height = bounds.bottom - bounds.top
        for (let y = 0; y < MINIMAP_SIZE; y++) {
          const tileY = Math.floor(view.top + y / scale) - bounds.top
          for (let x = 0; x < MINIMAP_SIZE; x++) {
            const tileX = Math.floor(view.left + x / scale) - bounds.left
            const inside = tileX >= 0 && tileY >= 0 && tileX < width && tileY < height
            fog.data[(y * MINIMAP_SIZE + x) * 4 + 3] = inside ? FOG_ALPHA[cells[tileY * width + tileX]] : 0
          }
        }
        fogCanvas.getContext('2d')!.putImageData(fog, 0, 0)
      }
      context.drawImage(fogCanvas, 0, 0)

      const colorOf = (player: number) => (player === scene.player ? OWN : player === 0 ? NEUTRAL : FOE)
      for (const [entity, position, owner] of world.query(Position, Owner)) {
        const type = world.get(entity, Building)?.type ?? world.get(entity, Site)?.type
        if (type !== undefined) {
          const spec = buildingSpec(type)
          context.fillStyle = colorOf(owner.player)
          context.fillRect(toX(position.x), toY(position.y), Math.max(2, spec.width * scale), Math.max(2, spec.height * scale))
        } else if (world.has(entity, Unit)) {
          context.fillStyle = colorOf(owner.player)
          context.fillRect(toX(position.x) - 1, toY(position.y) - 1, 2, 2)
        }
      }

      // Уведомления: мигающее кольцо там, где напали или заметили врага.
      for (const alert of scene.alerts?.current() ?? []) {
        if (alert.age > ALERT_SECONDS) continue
        const pulse = (alert.age * 2) % 1
        context.strokeStyle = alert.kind === 'attacked' ? FOE : '#ffd27a'
        context.globalAlpha = 1 - pulse
        context.lineWidth = 2
        context.beginPath()
        context.arc(toX(alert.x), toY(alert.y), 3 + pulse * 12, 0, Math.PI * 2)
        context.stroke()
        context.globalAlpha = 1
      }

      // Рамка экрана.
      const { camera } = scene
      // Только видимая часть: то, что закрыто панелями, на экране не видно.
      const { from, to } = camera.visible
      context.strokeStyle = '#e4f4ff'
      context.lineWidth = 1
      context.strokeRect(
        Math.round(toX(from.x)) + 0.5,
        Math.round(toY(from.y)) + 0.5,
        Math.round((to.x - from.x) * scale),
        Math.round((to.y - from.y) * scale),
      )
    },
    /** Тайл под точкой мини-карты; координаты — доли стороны от 0 до 1. */
    tileAt(u: number, v: number) {
      const view = fit(scene.sim.bounds)
      return { x: view.left + u * view.span, y: view.top + v * view.span }
    },
  }
}

export type Minimap = ReturnType<typeof createMinimap>
