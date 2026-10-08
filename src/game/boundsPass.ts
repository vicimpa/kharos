import { SCREEN_VERTEX, createProgram, drawQuad, setBlend } from '../gl'
import type { Pass } from '../render/renderer'
import type { Scene } from './scene'
import fragment from './storm.frag?raw'

// Оттенок ночи — как у освещения мира: буря рисуется поверх него и темнеет сама.
const NIGHT = [0.16, 0.2, 0.42]

/**
 * Край мира — стена вечной бури: за границей карты клубится пыль, у края она редкая и цвета песка, а дальше
 * густеет в непроглядную бурую мглу. Пелена заходит на несколько тайлов внутрь карты, край её гнёт шум, пыль несёт
 * ветер мира. Рисуется поверх тумана войны: границу мира видно и там, где ещё не бывали.
 */
export function createBoundsPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const program = createProgram(gl, SCREEN_VERTEX, fragment)
  const uniforms = { uCamera: new Float32Array(2), uBounds: new Float32Array(4), uDrift: new Float32Array(2), uTint: new Float32Array(3) }

  return {
    draw({ camera, view, delta }) {
      const { bounds } = scene.sim
      const { weather } = scene
      uniforms.uCamera[0] = camera.x
      uniforms.uCamera[1] = camera.y
      uniforms.uBounds.set([bounds.left, bounds.top, bounds.right, bounds.bottom])
      // Снос копится здесь, а не считается в шейдере как ветер × время: иначе смена ветра дёргала бы всю бурю.
      uniforms.uDrift[0] += weather.windX * delta
      uniforms.uDrift[1] += weather.windY * delta
      for (let i = 0; i < 3; i++) uniforms.uTint[i] = NIGHT[i] + (1 - NIGHT[i]) * weather.light

      setBlend(gl, 'alpha')
      program.use(view, uniforms)
      drawQuad(gl)
    },
    destroy() {
      program.destroy()
    },
  }
}
