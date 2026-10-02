export { createProgram } from './program'
export type { Program, Uniforms, UniformValue } from './program'
export { SCREEN_VERTEX, createQuads, drawQuad, forgetContext } from './quads'
export type { Quads } from './quads'
export { bindScreen, createTarget, createTexture } from './texture'
export type { Target, Texture, TextureOptions } from './texture'

/** Контекст WebGL 2 без сглаживания и буфера глубины: порядок отрисовки задают проходы. */
export function createContext(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
  if (!gl) throw new Error('Браузер не поддерживает WebGL 2')
  return gl
}

/**
 * Как новый цвет ложится на уже нарисованное. Цвета — с предумноженной альфой.
 * none — заменяет, alpha — обычная прозрачность, add — прибавляется (свет), multiply — умножается (тень, затемнение).
 */
export type Blend = 'none' | 'alpha' | 'add' | 'multiply'

export function setBlend(gl: WebGL2RenderingContext, blend: Blend) {
  if (blend === 'none') {
    gl.disable(gl.BLEND)
    return
  }
  gl.enable(gl.BLEND)
  if (blend === 'alpha') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  else if (blend === 'add') gl.blendFunc(gl.ONE, gl.ONE)
  else gl.blendFunc(gl.DST_COLOR, gl.ZERO)
}
