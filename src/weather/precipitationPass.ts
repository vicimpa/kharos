import { SCREEN_VERTEX, createProgram, drawQuad, setBlend } from '../gl'
import type { Scene } from '../game/scene'
import { WINDOW, wrap, type LandWindow } from '../map/landWindow'
import type { Pass } from '../render/renderer'
import fragment from './weather.frag?raw'

/**
 * Проход осадков: пыль и дождь по биомам. Биомы берёт из того же окна местности, что и шейдер карты.
 * Ставить выше игровых слоёв, но ниже освещения: ночью осадки темнеют вместе со всем остальным.
 */
export function createPrecipitationPass(gl: WebGL2RenderingContext, scene: Scene, landWindow: LandWindow): Pass {
  const program = createProgram(gl, SCREEN_VERTEX, fragment)
  const uniforms = { uWind: new Float32Array(2), uDrift: new Float32Array(2), uPrecipitation: 0 }

  return {
    draw({ view, delta }) {
      const weather = scene.settings.weather
      uniforms.uWind[0] = weather.windX
      uniforms.uWind[1] = weather.windY
      // Снос копится здесь, а не считается в шейдере как ветер × время: иначе смена ветра дёргала бы всю пелену.
      uniforms.uDrift[0] = wrap(uniforms.uDrift[0] + weather.windX * delta, WINDOW)
      uniforms.uDrift[1] = wrap(uniforms.uDrift[1] + weather.windY * delta, WINDOW)
      uniforms.uPrecipitation = weather.precipitation
      if (weather.precipitation <= 0) return

      setBlend(gl, 'alpha')
      program.use(view, landWindow.uniforms, uniforms)
      drawQuad(gl)
    },
    destroy() {
      program.destroy()
    },
  }
}
