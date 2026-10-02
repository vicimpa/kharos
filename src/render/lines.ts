import { createProgram, createQuads, type Program, type Quads } from '../gl'

const VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aLine;
in float aWidth;
in vec4 aTint;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec4 vTint;

void main() {
  vec2 span = aLine.zw - aLine.xy;
  float size = length(span);
  vec2 along = size > 0.0 ? span / size : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  vec2 tile = aLine.xy + span * aCorner.x + across * (aCorner.y - 0.5) * aWidth + uOffset;
  vTint = aTint;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 vTint;
out vec4 finalColor;

void main() {
  finalColor = vTint;
}
`

/** Программа для отрезков в координатах тайлов: лучи, следы, полоски. Одна на все наборы отрезков. */
export function createLineProgram(gl: WebGL2RenderingContext) {
  return createProgram(gl, VERTEX, FRAGMENT)
}

/**
 * Набор отрезков. Один отрезок — девять чисел:
 * x и y начала и конца в тайлах от камеры; толщина в тайлах;
 * цвет r, g, b, a с предумноженной альфой. Концы у отрезка прямые, без скруглений.
 */
export function createLines(gl: WebGL2RenderingContext, program: Program): Quads {
  return createQuads(gl, program, { aLine: 4, aWidth: 1, aTint: 4 })
}
