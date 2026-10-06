import { useEffect, useRef, useState } from 'preact/hooks'
import { PALETTE } from '../game/minimap'
import { Terrain, sampleTerrain, type GeneratorConfig } from '../map/terrain'

/** Сторона предпросмотра в пикселях холста. */
const PREVIEW_SIZE = 256
/** Сколько миллисекунд за кадр можно считать: карта проявляется сверху вниз, а меню не подвисает. */
const BUDGET = 8
/** Пауза после последней правки, прежде чем считать карту заново: ползунок тянут — не пересчитывать на каждом шаге. */
const SETTLE = 120

/** Какая доля карты под скалами (на них строят и на них руда) и под болотами. */
export interface Shares {
  rock: number
  swamp: number
}

/**
 * Схема будущей карты стороной size тайлов с местностью config — как на мини-карте в игре, только без гор:
 * они мельче пикселя схемы.
 */
export function MapPreview({ config, size }: { config: GeneratorConfig; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [shares, setShares] = useState<Shares | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    setReady(false)
    const image = context.getImageData(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
    const scale = size / PREVIEW_SIZE
    const counts = [0, 0, 0, 0]
    let row = 0
    let frame = 0
    const step = () => {
      const start = performance.now()
      while (row < PREVIEW_SIZE && performance.now() - start < BUDGET) {
        // Карта — квадрат с центром в начале координат.
        const y = (row + 0.5) * scale - size / 2
        for (let column = 0; column < PREVIEW_SIZE; column++) {
          const { terrain, biome } = sampleTerrain(config, (column + 0.5) * scale - size / 2, y)
          counts[terrain]++
          const [r, g, b] = PALETTE[biome][terrain]
          const index = (row * PREVIEW_SIZE + column) * 4
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
      const total = PREVIEW_SIZE * PREVIEW_SIZE
      setShares({ rock: counts[Terrain.Rock] / total, swamp: counts[Terrain.Swamp] / total })
      setReady(true)
    }
    const timer = setTimeout(() => (frame = requestAnimationFrame(step)), SETTLE)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [config, size])

  return (
    <figure class="preview">
      <canvas ref={canvas} class={ready ? 'preview__map' : 'preview__map is-busy'} width={PREVIEW_SIZE} height={PREVIEW_SIZE} />
      <figcaption>
        {size}×{size} тайлов
        {shares && (
          <>
            {' · '}скалы {Math.round(shares.rock * 100)}% · болота {Math.round(shares.swamp * 100)}%
          </>
        )}
      </figcaption>
    </figure>
  )
}
