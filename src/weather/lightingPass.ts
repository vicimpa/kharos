import { SCREEN_VERTEX, bindScreen, createProgram, createQuads, createTarget, drawQuad, setBlend } from '../gl'
import type { Scene } from '../game/scene'
import type { Pass } from '../render/renderer'

/** Цвет, которым огни освещают землю, и цвет их ореола. */
const LIGHT_COLOR = [0xa8 / 255, 0xd0 / 255, 0xff / 255]
const BLOOM_COLOR = [0x5a / 255, 0xa9 / 255, 0xff / 255]
/** Яркость ореолов огней днём; к ночи растёт до 1. */
const DAY_BLOOM = 0.35
/** Огни слабее этого не рисуются. */
const MIN_LEVEL = 0.02

// Оттенки освещения: ночь, сумерки (добавка в середине шкалы) и полдень — белый, то есть без изменений.
const NIGHT = [0.16, 0.2, 0.42]
const DUSK = [0.1, 0.0, -0.1]

/** Цвет, на который умножается картинка при данном уровне освещения. */
function lightTint(light: number) {
  const dusk = 1 - Math.abs(light * 2 - 1)
  return NIGHT.map((night, i) => Math.min(1, Math.max(0, night + (1 - night) * light + DUSK[i] * dusk)))
}

// Пятно света: квадрат в пикселях местности, яркость спадает от центра к краю ступенями с дизерингом,
// как пелена погоды. Сетка пятна совпадает с сеткой пиксель-арта, если центр огня стоит на её узле.
const SPOT_VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aSpot; // x, y центра в тайлах от камеры; радиус в пикселях местности; яркость
uniform vec2 uScale;
out vec2 vTexel;
flat out float vRadius;
flat out float vLevel;

const float TEXELS_PER_TILE = 16.0;

void main() {
  vRadius = aSpot.z;
  vLevel = aSpot.w;
  vTexel = aCorner * vRadius * 2.0;
  vec2 tile = aSpot.xy + (vTexel - vRadius) / TEXELS_PER_TILE;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
`

const SPOT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTexel;
flat in float vRadius;
flat in float vLevel;
uniform vec3 uColor;
uniform float uStrength;
out vec4 finalColor;

// Ступеней яркости в пятне.
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

void main() {
  ivec2 texel = ivec2(floor(vTexel));
  float falloff = length(vec2(texel) + 0.5 - vRadius) / vRadius;
  float value = pow(max(0.0, 1.0 - falloff), 2.0);
  float dither = (BAYER[(texel.y & 3) * 4 + (texel.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);

  // Издалека пиксели пятна мельче пикселя экрана: дизеринг там дал бы рябь, поэтому переходим к плавному спаду.
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vLevel * uStrength;
  finalColor = vec4(uColor * alpha, alpha);
}
`

const BLIT_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTexture;
out vec4 finalColor;

void main() {
  // Первая строка текстуры-цели — низ картинки.
  finalColor = texture(uTexture, vec2(vUV.x, 1.0 - vUV.y));
}
`

/**
 * Проход освещения. Затемнение — умножение картинки на карту освещённости: цвет времени суток плюс пятна
 * от огней, которые возвращают земле её дневной цвет. Поверх — ореолы самих огней.
 * Огни берёт из frame.lights, поэтому ставится после всех проходов, которые их добавляют.
 */
export function createLightingPass(gl: WebGL2RenderingContext, scene: Scene): Pass {
  const spotProgram = createProgram(gl, SPOT_VERTEX, SPOT_FRAGMENT)
  const blitProgram = createProgram(gl, SCREEN_VERTEX, BLIT_FRAGMENT)
  const cut = createQuads(gl, spotProgram, { aSpot: 4 })
  const bloom = createQuads(gl, spotProgram, { aSpot: 4 })
  const lightmap = createTarget(gl)

  return {
    draw({ camera, view, lights }) {
      const { light } = scene.settings.weather

      cut.clear()
      bloom.clear()
      const { data } = lights
      for (let i = 0; i < data.length; i += 5) {
        const level = data[i + 4]
        if (level <= MIN_LEVEL) continue
        const x = data[i] - camera.x
        const y = data[i + 1] - camera.y
        cut.push(x, y, data[i + 2], level)
        bloom.push(x, y, data[i + 3], level)
      }

      setBlend(gl, 'add')
      if (light < 1) {
        // Карта освещённости рисуется заново каждый кадр.
        const [red, green, blue] = lightTint(light)
        lightmap.bind(gl.drawingBufferWidth, gl.drawingBufferHeight)
        gl.clearColor(red, green, blue, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        spotProgram.use(view, { uColor: LIGHT_COLOR, uStrength: 1 })
        cut.draw()

        bindScreen(gl)
        setBlend(gl, 'multiply')
        blitProgram.use({ uTexture: lightmap.texture })
        drawQuad(gl)
        setBlend(gl, 'add')
      }

      spotProgram.use(view, { uColor: BLOOM_COLOR, uStrength: DAY_BLOOM + (1 - DAY_BLOOM) * (1 - light) })
      bloom.draw()
    },
    destroy() {
      cut.destroy()
      bloom.destroy()
      lightmap.destroy()
      spotProgram.destroy()
      blitProgram.destroy()
    },
  }
}
