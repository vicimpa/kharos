#version 300 es
precision highp float;

in vec2 vUV;
out vec4 finalColor;

uniform vec2 uScreenSize;
uniform vec2 uCamera; // центр экрана в тайлах мира
uniform float uZoom;
uniform float uTime;
uniform vec4 uBounds; // left, top, right, bottom в тайлах
uniform vec2 uDrift; // путь, пройденный ветром, в тайлах
uniform vec3 uTint; // освещение: ночью буря темнеет вместе с миром

const float TEXELS_PER_TILE = 16.0;
// Насколько далеко внутрь карты заходит дымка и где за краем буря становится непроглядной: местность за краем
// генератор тоже считает, но видно её быть не должно.
const float INSIDE = 5.0;
// Насколько шум гнёт край бури, в тайлах: внутрь и наружу от края.
const float WOBBLE = 2.5;
// За сколько тайлов от края пыль у края темнеет до мглы.
const float DEPTH = 18.0;
// Пыль у края — цвета песка, глубже — бурая мгла.
const vec3 DUST = vec3(0.62, 0.48, 0.27);
const vec3 HAZE = vec3(0.30, 0.22, 0.14);
const vec3 DEEP = vec3(0.05, 0.035, 0.03);
// Ступени непрозрачности: пелена ложится полосами с дизерингом, как погода.
const float STEPS = 6.0;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Клубы пыли: несколько слоёв шума, каждый мельче и быстрее предыдущего.
float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += noise(p) * amplitude;
    p = p * 2.03 + vec2(17.1, 9.7);
    amplitude *= 0.5;
  }
  return sum;
}

float bayer(ivec2 texel) {
  const float matrix[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  ivec2 at = texel & 3;
  return (matrix[at.y * 4 + at.x] + 0.5) / 16.0;
}

void main() {
  vec2 screenP = uCamera + (vUV - 0.5) * uScreenSize / uZoom;
  // Издалека тексели мельче пикселя экрана: дизеринг там дал бы рябь.
  float texelPixels = 1.0 / (dFdx(screenP).x * TEXELS_PER_TILE);
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
  ivec2 texel = ivec2(floor(screenP * TEXELS_PER_TILE));
  vec2 p = (vec2(texel) + 0.5) / TEXELS_PER_TILE;

  // Расстояние за край карты: снаружи — плюс, внутри — минус.
  vec2 outside = max(vec2(uBounds.x - p.x, uBounds.y - p.y), vec2(p.x - uBounds.z, p.y - uBounds.w));
  float distance = length(max(outside, 0.0)) + min(max(outside.x, outside.y), 0.0);
  if (distance < -(INSIDE + WOBBLE)) discard;

  // Пыль несёт ветер, а клубы ещё и медленно перекатываются сами.
  vec2 drifted = p - uDrift;
  float swirl = fbm(drifted / 14.0 + vec2(uTime * 0.03, -uTime * 0.02));
  float clouds = fbm(drifted / 6.0 + swirl * 1.6);
  // Стена бури встаёт чуть внутри карты, где-то на 0..2·WOBBLE тайлов от края: так она всегда закрывает и прямой
  // край тумана, и местность за краем.
  float edge = distance + WOBBLE + (swirl - 0.5) * 2.0 * WOBBLE;

  float density = smoothstep(-INSIDE, 0.0, edge);
  // В дымке перед стеной видны полосы и разрывы.
  density = clamp(density + (clouds - 0.5) * 0.6 * (1.0 - density), 0.0, 1.0);
  if (edge >= 0.0) density = 1.0;
  // Пыль клубами: светлые пятна песка в бурой мгле, а глубже — только мгла.
  float depth = smoothstep(0.0, DEPTH, distance + (clouds - 0.5) * 10.0);
  float lit = smoothstep(0.45, 0.8, clouds) * (1.0 - depth);
  vec3 color = mix(mix(HAZE, DUST, lit), DEEP, smoothstep(0.3, 1.0, depth));

  float dither = mix(0.5, bayer(texel), detail);
  float alpha = clamp(floor(density * STEPS + dither) / STEPS, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  finalColor = vec4(color * uTint * alpha, alpha);
}
