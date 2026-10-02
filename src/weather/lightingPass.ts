import { SCREEN_VERTEX, bindScreen, createProgram, createQuads, createTarget, drawQuad, setBlend } from '../gl'
import type { Scene } from '../game/scene'
import type { Pass, View } from '../render/renderer'

/** Цвет, которым огни освещают землю, и цвет их ореола. */
const LIGHT_COLOR = [0xa8 / 255, 0xd0 / 255, 0xff / 255]
const BLOOM_COLOR = [0x5a / 255, 0xa9 / 255, 0xff / 255]
/** Яркость ореолов огней днём; к ночи растёт до 1. */
const DAY_BLOOM = 0.35
/** Пикселей местности на тайл. */
const TEXELS_PER_TILE = 16
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
uniform vec2 uOffset;
out vec2 vTexel;
flat out float vRadius;
flat out float vLevel;

const float TEXELS_PER_TILE = 16.0;

void main() {
  vRadius = aSpot.z;
  vLevel = aSpot.w;
  vTexel = aCorner * vRadius * 2.0;
  vec2 tile = aSpot.xy + (vTexel - vRadius) / TEXELS_PER_TILE + uOffset;
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

// Луч: квадрат вокруг источника, в котором светится только конус по направлению луча. Тень считается
// на каждый пиксель местности: от него к источнику идём по карте силуэтов и смотрим, нет ли преграды.
const BEAM_VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aBeam; // x, y источника в тайлах от камеры; длина в пикселях местности; яркость
in vec4 aCone; // направление (cos, sin); полуширина у источника; расширение на пиксель длины
uniform vec2 uScale;
uniform vec2 uOffset;
out vec2 vTexel;
flat out vec4 vBeam;
flat out vec4 vCone;

const float TEXELS_PER_TILE = 16.0;

void main() {
  vBeam = aBeam;
  vCone = aCone;
  vTexel = (aCorner * 2.0 - 1.0) * aBeam.z;
  vec2 tile = aBeam.xy + vTexel / TEXELS_PER_TILE + uOffset;
  gl_Position = vec4(tile.x * uScale.x, -tile.y * uScale.y, 0.0, 1.0);
}
`

const BEAM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTexel;
flat in vec4 vBeam;
flat in vec4 vCone;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform vec3 uColor;
uniform sampler2D uOccluders;
out vec4 finalColor;

const float TEXELS_PER_TILE = 16.0;
const float LEVELS = 5.0;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
// Сколько раз луч зрения проверяется на преграду и на сколько пикселей от источника проверка не доходит:
// источник стоит у самого края своего юнита, и тот не должен затенять собственный свет.
const int STEPS = 40;
const float SKIP = 1.5;

void main() {
  ivec2 cell = ivec2(floor(vTexel));
  vec2 texel = vec2(cell) + 0.5;
  vec2 direction = vCone.xy;
  float along = dot(texel, direction);
  float across = abs(dot(texel, vec2(-direction.y, direction.x)));
  float side = across / (vCone.z + max(along, 0.0) * vCone.w);
  float value = pow(max(0.0, 1.0 - length(texel) / vBeam.z), 1.5) * max(0.0, 1.0 - side * side);
  if (along <= 0.0 || value <= 0.0) discard;

  // От пикселя к источнику. Преграда, внутри которой лежит сам пиксель, не в счёт: луч освещает то, во что упёрся.
  vec2 from = vBeam.xy + uOffset + texel / TEXELS_PER_TILE;
  vec2 to = vBeam.xy + uOffset + direction * SKIP / TEXELS_PER_TILE;
  bool outside = false;
  for (int i = 0; i < STEPS; i++) {
    vec2 tile = mix(from, to, (float(i) + 0.5) / float(STEPS));
    vec2 uv = vec2(tile.x * uScale.x, -tile.y * uScale.y) * 0.5 + 0.5;
    bool solid = texture(uOccluders, uv).a > 0.5;
    if (!solid) outside = true;
    else if (outside) discard;
  }

  float dither = (BAYER[(cell.y & 3) * 4 + (cell.x & 3)] + 0.5) / 16.0;
  float stepped = min(1.0, floor(value * LEVELS + dither) / LEVELS);
  float texelPixels = 1.0 / max(fwidth(vTexel.x), 0.0001);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  float alpha = mix(value, stepped, detail) * vBeam.w;
  finalColor = vec4(uColor * alpha, alpha);
}
`

const BLIT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTexture;
uniform vec2 uSpan;   // сколько тайлов помещается на экране
uniform vec2 uScale;  // как карта освещённости переводит тайлы в свои координаты
uniform vec2 uOffset;
out vec4 finalColor;

void main() {
  // Карта освещённости меньше экрана: в ней один пиксель на пиксель местности. Берём ближайший, без сглаживания.
  vec2 tile = (vUV - 0.5) * uSpan + uOffset;
  vec2 uv = vec2(tile.x * uScale.x, -tile.y * uScale.y) * 0.5 + 0.5;
  ivec2 size = textureSize(uTexture, 0);
  finalColor = texelFetch(uTexture, clamp(ivec2(floor(uv * vec2(size))), ivec2(0), size - 1), 0);
}
`

/**
 * Проход освещения. Затемнение — умножение картинки на карту освещённости: цвет времени суток плюс пятна
 * от огней, которые возвращают земле её дневной цвет. Поверх — ореолы самих огней.
 * Огни берёт из frame.lights, поэтому ставится после всех проходов, которые их добавляют.
 * casters — проходы, чьи силуэты (drawOccluders) отбрасывают тень от лучей.
 */
export function createLightingPass(gl: WebGL2RenderingContext, scene: Scene, casters: Pass[] = []): Pass {
  const spotProgram = createProgram(gl, SPOT_VERTEX, SPOT_FRAGMENT)
  const blitProgram = createProgram(gl, SCREEN_VERTEX, BLIT_FRAGMENT)
  const cut = createQuads(gl, spotProgram, { aSpot: 4 })
  const bloom = createQuads(gl, spotProgram, { aSpot: 4 })
  const lightmap = createTarget(gl)
  const beamProgram = createProgram(gl, BEAM_VERTEX, BEAM_FRAGMENT)
  const beams = createQuads(gl, beamProgram, { aBeam: 4, aCone: 4 })
  const occluders = createTarget(gl)
  /** Юниформы для карт освещённости и силуэтов: у них свой размер и свой сдвиг. */
  const mapView: View = { uScreenSize: new Float32Array(2), uScale: new Float32Array(2), uOffset: new Float32Array(2), uZoom: 1, uTime: 0 }

  return {
    draw(frame) {
      const { camera, view, lights } = frame
      const { light } = scene.settings.weather

      cut.clear()
      bloom.clear()
      const { data } = lights
      for (let i = 0; i < data.length; i += 5) {
        const level = data[i + 4]
        if (level <= MIN_LEVEL) continue
        const x = data[i] - camera.x
        const y = data[i + 1] - camera.y
        // Нулевой радиус — огонь без пятна или без ореола.
        if (data[i + 2] > 0) cut.push(x, y, data[i + 2], level)
        if (data[i + 3] > 0) bloom.push(x, y, data[i + 3], level)
      }

      beams.clear()
      const rays = lights.beams
      for (let i = 0; i < rays.length; i += 8) {
        beams.push(rays[i] - camera.x, rays[i + 1] - camera.y, rays[i + 2], rays[i + 3], rays[i + 4], rays[i + 5], rays[i + 6], rays[i + 7])
      }

      // Свет одинаков в пределах пикселя местности, поэтому карты освещённости и силуэтов рисуются в сетке местности:
      // вблизи это в десятки раз меньше пикселей, чем на экране. Издалека, когда пиксель местности мельче
      // экранного, карты совпадают с экраном.
      const density = gl.drawingBufferWidth / frame.width
      const close = camera.zoom * density > TEXELS_PER_TILE
      const perTile = close ? TEXELS_PER_TILE : camera.zoom * density
      const mapWidth = close ? 2 * (Math.ceil((frame.width / 2 / camera.zoom) * perTile) + 1) : gl.drawingBufferWidth
      const mapHeight = close ? 2 * (Math.ceil((frame.height / 2 / camera.zoom) * perTile) + 1) : gl.drawingBufferHeight
      // Центр карты встаёт на узел сетки местности, чтобы её пиксели совпали с пикселями земли.
      const snap = (value: number) => (close ? value - Math.round(value * perTile) / perTile : 0)
      mapView.uScreenSize[0] = mapWidth
      mapView.uScreenSize[1] = mapHeight
      mapView.uScale[0] = (perTile * 2) / mapWidth
      mapView.uScale[1] = (perTile * 2) / mapHeight
      mapView.uOffset[0] = snap(camera.x)
      mapView.uOffset[1] = snap(camera.y)
      mapView.uZoom = perTile
      mapView.uTime = view.uTime

      if (light < 1 && beams.count) {
        // Карта силуэтов: по ней лучи узнают, что им загораживает землю.
        occluders.bind(mapWidth, mapHeight)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        for (const caster of casters) caster.drawOccluders?.(mapView)
      }

      setBlend(gl, 'add')
      if (light < 1) {
        // Карта освещённости рисуется заново каждый кадр.
        const [red, green, blue] = lightTint(light)
        lightmap.bind(mapWidth, mapHeight)
        gl.clearColor(red, green, blue, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        spotProgram.use(mapView, { uColor: LIGHT_COLOR, uStrength: 1 })
        cut.draw()
        if (beams.count) {
          beamProgram.use(mapView, { uColor: LIGHT_COLOR, uOccluders: occluders.texture })
          beams.draw()
        }

        bindScreen(gl)
        setBlend(gl, 'multiply')
        const span = [frame.width / camera.zoom, frame.height / camera.zoom]
        blitProgram.use({ uTexture: lightmap.texture, uSpan: span, uScale: mapView.uScale, uOffset: mapView.uOffset })
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
      beams.destroy()
      occluders.destroy()
      beamProgram.destroy()
      spotProgram.destroy()
      blitProgram.destroy()
    },
  }
}
