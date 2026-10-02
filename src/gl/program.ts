import type { Texture } from './texture'

export type UniformValue = number | ArrayLike<number> | Texture
export type Uniforms = Record<string, UniformValue>

export interface Program {
  readonly handle: WebGLProgram
  /**
   * Делает программу текущей и задаёт юниформы. Наборов может быть несколько: общие для кадра и свои.
   * Имена, которых в шейдере нет, пропускаются — один набор годится для разных шейдеров.
   */
  use(...uniforms: Uniforms[]): void
  destroy(): void
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? 'вершинного' : 'фрагментного'
    throw new Error(`Ошибка ${kind} шейдера:\n${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

/**
 * Собирает программу из исходников GLSL ES 3.00. Юниформы находит сама: use({ uZoom: 32, uMap: texture }).
 * Текстуры раскладываются по текстурным блокам автоматически. Атрибут aCorner всегда получает место 0 —
 * это угол единичного квадрата, общий для всех шейдеров (см. quads.ts).
 */
export function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const handle = gl.createProgram()!
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertex), compile(gl, gl.FRAGMENT_SHADER, fragment)]
  for (const shader of shaders) gl.attachShader(handle, shader)
  gl.bindAttribLocation(handle, 0, 'aCorner')
  gl.linkProgram(handle)
  for (const shader of shaders) gl.deleteShader(shader)
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    throw new Error(`Ошибка сборки шейдерной программы:\n${gl.getProgramInfoLog(handle)}`)
  }

  const setters = new Map<string, (value: any) => void>()
  let units = 0
  const count = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(handle, i)!
    const location = gl.getUniformLocation(handle, info.name)
    // Массивы шейдер называет «uName[0]».
    const name = info.name.replace(/\[0\]$/, '')
    const isArray = info.size > 1
    switch (info.type) {
      case gl.FLOAT:
        setters.set(name, isArray ? (value) => gl.uniform1fv(location, value) : (value) => gl.uniform1f(location, value))
        break
      case gl.FLOAT_VEC2:
        setters.set(name, (value) => gl.uniform2fv(location, value))
        break
      case gl.FLOAT_VEC3:
        setters.set(name, (value) => gl.uniform3fv(location, value))
        break
      case gl.FLOAT_VEC4:
        setters.set(name, (value) => gl.uniform4fv(location, value))
        break
      case gl.INT:
      case gl.BOOL:
        setters.set(name, (value) => gl.uniform1i(location, value))
        break
      case gl.SAMPLER_2D: {
        const unit = units++
        setters.set(name, (texture: Texture) => {
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, texture.handle)
          gl.uniform1i(location, unit)
        })
        break
      }
      default:
        throw new Error(`Юниформ ${name}: тип 0x${info.type.toString(16)} не поддерживается`)
    }
  }

  return {
    handle,
    use(...uniforms) {
      gl.useProgram(handle)
      for (const group of uniforms) {
        for (const name in group) setters.get(name)?.(group[name])
      }
    },
    destroy() {
      gl.deleteProgram(handle)
    },
  }
}
