import type { Program } from './program'

/** Единичный квадрат, общий на весь контекст: углы (0,0), (1,0), (0,1), (1,1). Шейдеры получают их как aCorner. */
const corners = new WeakMap<WebGL2RenderingContext, { buffer: WebGLBuffer; screen: WebGLVertexArrayObject }>()

function cornersOf(gl: WebGL2RenderingContext) {
  let shared = corners.get(gl)
  if (!shared) {
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    const screen = gl.createVertexArray()!
    gl.bindVertexArray(screen)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    corners.set(gl, (shared = { buffer, screen }))
  }
  return shared
}

/** Забывает общие ресурсы контекста. Вызывать после его восстановления: старые буферы больше не действуют. */
export function forgetContext(gl: WebGL2RenderingContext) {
  corners.delete(gl)
}

/**
 * Вершинный шейдер полноэкранного прохода: растягивает квадрат на весь экран.
 * Фрагментный шейдер получает vUV от (0, 0) в левом верхнем углу до (1, 1) в правом нижнем.
 */
export const SCREEN_VERTEX = `#version 300 es
in vec2 aCorner;
out vec2 vUV;

void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner.x * 2.0 - 1.0, 1.0 - aCorner.y * 2.0, 0.0, 1.0);
}
`

/** Рисует один квадрат текущей программой. Для полноэкранных шейдеров: куда встанет квадрат, решает вершинный шейдер. */
export function drawQuad(gl: WebGL2RenderingContext) {
  gl.bindVertexArray(cornersOf(gl).screen)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

export interface Quads {
  /** Сколько квадратов набрано. */
  readonly count: number
  /** Добавляет квадрат. Значения идут подряд в порядке атрибутов из описания. */
  push(...values: number[]): void
  clear(): void
  /** Рисует все набранные квадраты текущей программой за один вызов. Набор при этом не очищается. */
  draw(): void
  destroy(): void
}

/**
 * Набор одинаковых квадратов с разными параметрами: спрайты, пятна света, рамки.
 * layout — атрибуты одного квадрата и число чисел в каждом: { aRect: 4, aColor: 4 }.
 * В шейдере это `in vec4 aRect; in vec4 aColor;` плюс общий `in vec2 aCorner`.
 */
export function createQuads(gl: WebGL2RenderingContext, program: Program, layout: Record<string, number>): Quads {
  const stride = Object.values(layout).reduce((sum, size) => sum + size, 0)
  let data = new Float32Array(stride * 64)
  let length = 0
  /** Сколько байт сейчас выделено под буфер на видеокарте. */
  let allocated = 0

  const { buffer: cornerBuffer } = cornersOf(gl)
  const buffer = gl.createBuffer()!
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  let offset = 0
  for (const [name, size] of Object.entries(layout)) {
    const location = gl.getAttribLocation(program.handle, name)
    // Атрибут, который шейдер не использует, компилятор выбрасывает — тогда его просто пропускаем.
    if (location >= 0) {
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset * 4)
      gl.vertexAttribDivisor(location, 1)
    }
    offset += size
  }
  gl.bindVertexArray(null)

  return {
    get count() {
      return length / stride
    },
    push(...values) {
      if (length + stride > data.length) {
        const grown = new Float32Array(data.length * 2)
        grown.set(data)
        data = grown
      }
      for (let i = 0; i < stride; i++) data[length + i] = values[i]
      length += stride
    },
    clear() {
      length = 0
    },
    draw() {
      if (!length) return
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      if (data.byteLength > allocated) {
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        allocated = data.byteLength
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, length)
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, length / stride)
    },
    destroy() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(buffer)
    },
  }
}
