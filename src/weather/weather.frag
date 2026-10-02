#version 300 es
precision highp float;

in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uMap; // то же окно мира, что и у местности: g = биом
uniform vec2 uScreenSize;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uTime;
uniform vec2 uWind; // тайлов в секунду
uniform vec2 uDrift; // путь, пройденный ветром, по модулю WINDOW
uniform float uPrecipitation; // 0 — ясно, 1 — буря

// Должны совпадать с terrain.frag.
const int WINDOW = 512;
const float PERIOD = float(WINDOW);
const float TEXELS_PER_TILE = 16.0;

// Что выпадает в каждом биоме: эрг, солончаки, красные пустоши, топи.
// В пустынях ветер несёт пыль цвета местного песка, в топях идёт дождь и стоит туман.
const vec3 DUST_COLOR[4] = vec3[4](
  vec3(0.80, 0.65, 0.31), vec3(0.90, 0.88, 0.80), vec3(0.70, 0.36, 0.16), vec3(0.0)
);
const vec4 DUST_AMOUNT = vec4(1.0, 0.6, 1.0, 0.0);
const vec4 RAIN_AMOUNT = vec4(0.0, 0.0, 0.0, 1.0);
const vec3 FOG_COLOR = vec3(0.30, 0.37, 0.40);
const vec3 RAIN_COLOR = vec3(0.75, 0.85, 0.95);
// Непрозрачность капель и дымки под дождём.
const float RAIN_ALPHA = 0.45;
const float FOG_ALPHA = 0.55;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Шум с периодом WINDOW тайлов; scale * PERIOD должно быть целым.
float noise(vec2 p, float scale) {
  float period = PERIOD * scale;
  p *= scale;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(mod(i, period)), hash(mod(i + vec2(1.0, 0.0), period)), f.x),
    mix(hash(mod(i + vec2(0.0, 1.0), period)), hash(mod(i + vec2(1.0, 1.0), period)), f.x),
    f.y
  );
}

float bayer(ivec2 texel) {
  const float matrix[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (matrix[(texel.y & 3) * 4 + (texel.x & 3)] + 0.5) / 16.0;
}

// Доли четырёх биомов в точке, плавно интерполированные между тайлами: погода на стыке не идёт ступеньками.
vec4 biomeWeights(vec2 p) {
  vec2 q = p - 0.5;
  ivec2 cell = ivec2(floor(q));
  vec2 f = fract(q);
  vec4 sum = vec4(0.0);
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      float weight = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
      int packed = int(texelFetch(uMap, (cell + ivec2(x, y)) & (WINDOW - 1), 0).g * 255.0 + 0.5);
      float share = float(packed & 15) / 30.0;
      sum[packed >> 6] += weight * (1.0 - share);
      sum[(packed >> 4) & 3] += weight * share;
    }
  }
  return sum;
}

// Прозрачность ступенями с дизерингом, чтобы пелена не выбивалась из пиксель-арта.
float stepped(float alpha, float dither) {
  return clamp(floor(alpha * 6.0 + dither) / 6.0, 0.0, 1.0);
}

// Сторона клетки с одной каплей, в текселях. Окно мира должно делиться на клетки нацело.
const float DROP_CELL = 8.0;
// Сколько секунд живёт капля: сначала короткий полёт, потом след на земле.
const float DROP_LIFE = 0.7;
const float DROP_FALL = 0.4; // доля жизни, уходящая на полёт

// Дождь, падающий на землю: каждая капля пролетает короткий путь до своей точки и оставляет след —
// расходящийся круг на воде болота или мелкий всплеск на суше. Возвращает прозрачность в текселе.
float rainDrops(ivec2 texel, float amount) {
  vec2 t = vec2(texel) + 0.5;
  vec2 cell = floor(t / DROP_CELL);
  // Капля видна с высоты: она подлетает сверху экрана, а ветер сносит её вбок.
  vec2 approach = vec2(0.0, -9.0) - clamp(uWind, -6.0, 6.0) * 0.9;
  vec2 direction = normalize(approach);

  float alpha = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 id = mod(cell + vec2(x, y), PERIOD * TEXELS_PER_TILE / DROP_CELL);
      float phase = uTime / DROP_LIFE + hash(id + 0.31) * 13.0;
      float cycle = mod(floor(phase), 256.0);
      if (hash(id + cycle * vec2(7.13, 3.71)) > amount * 0.7) continue;

      float life = fract(phase);
      vec2 landing = (cell + vec2(x, y) + 0.15 + 0.7 * vec2(hash(id + cycle + 1.7), hash(id + cycle + 5.3))) * DROP_CELL;
      vec2 delta = t - landing;

      if (life < DROP_FALL) {
        // Короткий штрих вдоль направления полёта.
        vec2 head = delta - approach * (1.0 - life / DROP_FALL);
        float along = clamp(dot(head, direction), 0.0, 3.0);
        if (length(head - direction * along) < 0.6) alpha = max(alpha, 0.6);
        continue;
      }

      float fade = (life - DROP_FALL) / (1.0 - DROP_FALL);
      int type = int(texelFetch(uMap, ivec2(floor(landing / TEXELS_PER_TILE)) & (WINDOW - 1), 0).r * 255.0 + 0.5);
      if (type == 0) {
        // Круг на воде.
        if (abs(length(delta) - (0.8 + fade * 3.2)) < 0.5) alpha = max(alpha, 0.6 * (1.0 - fade));
      } else if (fade < 0.5 && length(delta) < 0.6 + fade * 1.6) {
        // Всплеск на суше.
        alpha = max(alpha, 0.45 * (1.0 - fade * 2.0));
      }
    }
  }
  return alpha;
}

void over(inout vec4 result, vec3 color, float alpha) {
  result = vec4(result.rgb * (1.0 - alpha) + color * alpha, result.a * (1.0 - alpha) + alpha);
}

void main() {
  vec2 screenP = uCamera + (vUV - 0.5) * uScreenSize / uZoom;
  float texelPixels = 1.0 / (dFdx(screenP).x * TEXELS_PER_TILE);
  // Издалека тексели мельче пикселя экрана: дизеринг и штрихи дождя там дали бы рябь.
  float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);

  ivec2 texel = ivec2(floor(screenP * TEXELS_PER_TILE));
  vec2 p = (vec2(texel) + 0.5) / TEXELS_PER_TILE;
  float dither = mix(0.5, bayer(texel), detail);

  vec4 biomes = biomeWeights(p);
  float dust = dot(biomes, DUST_AMOUNT);
  float rain = dot(biomes, RAIN_AMOUNT);

  // Клубы плывут по ветру; мелкий слой идёт вдвое быстрее крупного. Множители целые, чтобы шум не терял период.
  float clouds = noise(p - uDrift, 0.125) * 0.6 + noise(p - uDrift * 2.0, 1.0) * 0.4;
  float cover = smoothstep(0.75 - uPrecipitation * 0.7, 1.05 - uPrecipitation * 0.5, clouds);

  // Результат — с предумноженной альфой.
  vec4 result = vec4(0.0);
  if (rain > 0.001) {
    over(result, FOG_COLOR, stepped((0.15 + cover * 0.3) * uPrecipitation * rain * FOG_ALPHA, dither));
    over(result, RAIN_COLOR, rainDrops(texel, uPrecipitation * rain) * detail * RAIN_ALPHA);
  }
  if (dust > 0.001) {
    vec3 color = (biomes.x * DUST_AMOUNT.x * DUST_COLOR[0] + biomes.y * DUST_AMOUNT.y * DUST_COLOR[1]
      + biomes.z * DUST_AMOUNT.z * DUST_COLOR[2]) / dust;
    over(result, color, stepped(cover * uPrecipitation * 0.85 * dust, dither));
  }
  finalColor = result;
}
