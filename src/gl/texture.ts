export interface TextureOptions {
  width: number
  height: number
  /** Пиксели RGBA, по байту на канал, строки сверху вниз. Без них текстура пустая. */
  data?: Uint8Array
  /** nearest — чёткие пиксели (по умолчанию), linear — сглаживание. */
  filter?: 'nearest' | 'linear'
}

export interface Texture {
  readonly handle: WebGLTexture
  readonly width: number
  readonly height: number
  /** Записывает пиксели RGBA в прямоугольник; по умолчанию — во всю текстуру. */
  write(data: Uint8Array, x?: number, y?: number, width?: number, height?: number): void
  /** Меняет размер; содержимое теряется. */
  resize(width: number, height: number): void
  destroy(): void
}

/** Текстура RGBA8. Альфа не предумножается: что записано, то шейдер и прочитает. */
export function createTexture(gl: WebGL2RenderingContext, options: TextureOptions): Texture {
  const handle = gl.createTexture()!
  const filter = options.filter === 'linear' ? gl.LINEAR : gl.NEAREST
  let { width, height } = options

  const allocate = (data: Uint8Array | null) => {
    gl.bindTexture(gl.TEXTURE_2D, handle)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  }
  allocate(options.data ?? null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  return {
    handle,
    get width() {
      return width
    },
    get height() {
      return height
    },
    write(data, x = 0, y = 0, w = width, h = height) {
      gl.bindTexture(gl.TEXTURE_2D, handle)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
    },
    resize(nextWidth, nextHeight) {
      width = nextWidth
      height = nextHeight
      allocate(null)
    },
    destroy() {
      gl.deleteTexture(handle)
    },
  }
}

export interface Target {
  /** То, что нарисовано в цель. Первая строка текстуры — низ картинки. */
  readonly texture: Texture
  /** Дальнейшая отрисовка идёт в цель. Размер подгоняется под запрошенный. */
  bind(width: number, height: number): void
  destroy(): void
}

/** Цель отрисовки: текстура, в которую можно рисовать вместо экрана. */
export function createTarget(gl: WebGL2RenderingContext): Target {
  const texture = createTexture(gl, { width: 1, height: 1, filter: 'linear' })
  const framebuffer = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.handle, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  return {
    texture,
    bind(width, height) {
      if (texture.width !== width || texture.height !== height) texture.resize(width, height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, width, height)
    },
    destroy() {
      gl.deleteFramebuffer(framebuffer)
      texture.destroy()
    },
  }
}

/** Дальнейшая отрисовка идёт на экран. */
export function bindScreen(gl: WebGL2RenderingContext) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
}
