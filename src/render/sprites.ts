import { createProgram, createQuads, createTexture, type Program, type Quads } from '../gl'

const VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aRect;
in vec4 aFrame;
in vec4 aTint;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec2 vUV;
out vec4 vTint;

void main() {
  vec2 tile = aRect.xy + aCorner * aRect.zw + uOffset;
  vUV = aFrame.xy + aCorner * aFrame.zw;
  vTint = aTint;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec4 vTint;
uniform sampler2D uTexture;
out vec4 finalColor;

void main() {
  finalColor = texture(uTexture, vUV) * vTint;
}
`

/** Программа для спрайтов в координатах тайлов. Одна на все наборы спрайтов. */
export function createSpriteProgram(gl: WebGL2RenderingContext) {
  return createProgram(gl, VERTEX, FRAGMENT)
}

/**
 * Набор спрайтов. Один спрайт — двенадцать чисел:
 * x, y, ширина, высота в тайлах, причём x и y отсчитаны от камеры (так хватает точности вдали от начала мира);
 * u, v, ширина, высота кадра в долях текстуры (см. AtlasFrame);
 * цвет r, g, b, a с предумноженной альфой, на который умножается картинка: (1, 1, 1, 1) — без изменений.
 */
export function createSprites(gl: WebGL2RenderingContext, program: Program): Quads {
  return createQuads(gl, program, { aRect: 4, aFrame: 4, aTint: 4 })
}

/** Белая точка: спрайт с такой текстурой — просто прямоугольник цвета aTint. */
export function createWhiteTexture(gl: WebGL2RenderingContext) {
  return createTexture(gl, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) })
}
