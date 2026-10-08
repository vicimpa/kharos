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
// Берег мглы: непроглядной она становится на 0..FRONT тайлов внутри карты, а перед этим на REACH_MIN..REACH_MAX
// тайлов редеет до прозрачной. Оба числа гуляют вдоль края, чтобы край не читался рамкой. За краем — сплошная
// мгла: местность за краем генератор тоже считает, но видно её быть не должно.
const float FRONT = 7.0;
const float REACH_MIN = 4.0;
const float REACH_MAX = 10.0;
// Мгла — того же тона, что неразведанный туман, поэтому граница между ними не видна.
const vec3 DARK = vec3(0.035, 0.03, 0.028);
// Клубы пыли в мгле: редкие и тусклые — заметны, только когда движутся.
const vec3 DUST = vec3(0.30, 0.23, 0.14);
const float DUST_ALPHA = 0.5;
// Ступени непрозрачности: пелена ложится полосами с дизерингом, как погода.
const float STEPS = 8.0;

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
  if (distance < -(FRONT + REACH_MAX + 2.0)) discard;

  // Пыль несёт ветер, а клубы ещё и медленно перекатываются сами.
  vec2 drifted = p - uDrift;
  float swirl = fbm(drifted / 14.0 + vec2(uTime * 0.03, -uTime * 0.02));
  float clouds = fbm(drifted / 7.0 + swirl * 1.6);
  // Берег — крупный медленный шум, не завязанный на ветер: у мглы свои мысы и заливы. Его растягивает сильнее,
  // чем разброс fbm вокруг середины, чтобы мысы доходили до краёв диапазона.
  float coast = clamp((fbm(p / 18.0 + vec2(uTime * 0.005)) - 0.5) * 2.2 + 0.5, 0.0, 1.0);
  float front = -FRONT * coast;
  float reach = mix(REACH_MIN, REACH_MAX, fbm(p / 30.0 + vec2(41.0, 7.0)));
  // Клубы немного раскачивают берег и вблизи.
  float edge = (distance - front + reach) / reach + (swirl - 0.5) * 0.5;

  float density = smoothstep(0.0, 1.0, edge);
  if (distance > 0.0) density = max(density, smoothstep(0.0, 2.0, distance));
  // Клубы — светлее мглы, у самого края и чуть за ним; глубже их не видно.
  float wisps = smoothstep(0.55, 0.85, clouds) * (1.0 - smoothstep(0.0, 14.0, distance)) * smoothstep(0.2, 0.8, edge);
  vec3 color = mix(DARK, DUST, wisps * DUST_ALPHA);

  float dither = mix(0.5, bayer(texel), detail);
  float alpha = clamp(floor(density * STEPS + dither) / STEPS, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  finalColor = vec4(color * uTint * alpha, alpha);
}
