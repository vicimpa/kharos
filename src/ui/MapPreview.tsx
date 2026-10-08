import { useEffect, useRef, useState } from 'preact/hooks'
import { PALETTE } from '../game/minimap'
import { Terrain, sampleTerrain, type GeneratorConfig } from '../map/terrain'

/** Сторона предпросмотра в пикселях холста. */
const PREVIEW_SIZE = 256
/** Сколько миллисекунд за кадр можно считать: карта проявляется сверху вниз, а меню не подвисает. */
const BUDGET = 8
/** Пауза после последней правки, прежде чем считать карту заново: ползунок тянут — не пересчитывать на каждом шаге. */
const SETTLE = 120

/** Цвет превью вне карты, RGBA. */
const OUTSIDE = [8, 17, 28, 255]

/** Какая доля карты под скалами (на них строят и на них руда) и под болотами. */
export interface Shares {
  rock: number
  swamp: number
}

/**
 * Схема будущей карты стороной size тайлов с местностью config — как на мини-карте в игре, только без гор:
 * они мельче пикселя схемы.
 */
export function MapPreview({ config, size, height = size }: { config: GeneratorConfig; size: number; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [shares, setShares] = useState<Shares | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    setReady(false)
    const image = context.getImageData(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
    // Карта вписана в квадрат превью по большей стороне; что вне её — тёмное поле.
    const scale = Math.max(size, height) / PREVIEW_SIZE
    const counts = [0, 0, 0, 0]
    let inside = 0
    let row = 0
    let frame = 0
    const step = () => {
      const start = performance.now()
      while (row < PREVIEW_SIZE && performance.now() - start < BUDGET) {
        // Середина карты — в начале координат и в середине превью.
        const y = (row + 0.5 - PREVIEW_SIZE / 2) * scale
        for (let column = 0; column < PREVIEW_SIZE; column++) {
          const x = (column + 0.5 - PREVIEW_SIZE / 2) * scale
          const index = (row * PREVIEW_SIZE + column) * 4
          if (Math.abs(x) > size / 2 || Math.abs(y) > height / 2) {
            image.data.set(OUTSIDE, index)
            continue
          }
          const { terrain, biome } = sampleTerrain(config, x, y)
          counts[terrain]++
          inside++
          const [r, g, b] = PALETTE[biome][terrain]
          image.data[index] = r
          image.data[index + 1] = g
          image.data[index + 2] = b
          image.data[index + 3] = 255
        }
        row++
      }
      context.putImageData(image, 0, 0)
      if (row < PREVIEW_SIZE) {
        frame = requestAnimationFrame(step)
        return
      }
      const total = Math.max(1, inside)
      setShares({ rock: counts[Terrain.Rock] / total, swamp: counts[Terrain.Swamp] / total })
      setReady(true)
    }
    const timer = setTimeout(() => (frame = requestAnimationFrame(step)), SETTLE)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [config, size, height])

  return (
    <figure class="preview">
      <canvas ref={canvas} class={ready ? 'preview__map' : 'preview__map is-busy'} width={PREVIEW_SIZE} height={PREVIEW_SIZE} />
      <figcaption>
        {size}×{height} тайлов
        {shares && (
          <>
            {' · '}скалы {Math.round(shares.rock * 100)}% · болота {Math.round(shares.swamp * 100)}%
          </>
        )}
      </figcaption>
    </figure>
  )
}
