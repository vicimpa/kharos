import { SCREEN_VERTEX, createProgram, drawQuad, setBlend } from '../gl'
import type { Scene } from '../game/scene'
import type { Pass } from '../render/renderer'
import type { LandWindow } from './landWindow'
import fragment from './terrain.frag?raw'

/** Проход местности: полноэкранный шейдер сам считает, какая точка мира попала в пиксель. */
export function createTerrainPass(gl: WebGL2RenderingContext, scene: Scene, landWindow: LandWindow): Pass {
  const program = createProgram(gl, SCREEN_VERTEX, fragment)
  const uniforms = { uGrid: 0, uDunes: new Float32Array(3) }

  return {
    draw({ view }) {
      // Параметры отрисовки читаются каждый кадр, поэтому их смена не пересоздаёт карту.
      const { ergDunes, redDunes, duneMargin } = scene.settings.render
      // Частота барханов переводится в порог шума: чем чаще, тем ниже порог.
      uniforms.uDunes[0] = 0.9 - ergDunes * 0.6
      uniforms.uDunes[1] = 0.9 - redDunes * 0.6
      uniforms.uDunes[2] = duneMargin
      uniforms.uGrid = scene.grid ? 1 : 0

      setBlend(gl, 'none')
      program.use(view, landWindow.uniforms, uniforms)
      drawQuad(gl)
    },
    destroy() {
      program.destroy()
    },
  }
}
