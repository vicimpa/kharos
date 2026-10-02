#version 300 es
precision highp float;

in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uMap; // окно мира вокруг камеры, свёрнутое в тор: r = тип местности, g = биом, b = глубина в песках (у гор — радиус вершины), a = смещение до центра вершины
// Размер экрана в CSS-пикселях.
uniform vec2 uScreenSize;
uniform vec2 uCamera; // центр экрана в тайлах, по модулю WINDOW
uniform float uZoom; // пикселей на тайл
uniform float uTime;
uniform float uGrid;
uniform vec3 uDunes; // порог полей барханов в эрге, в красных пустошах и их отступ от других зон

const int SWAMP = 0;
const int SAND = 1;
const int ROCK = 2;
const int MOUNTAIN = 3;

// Размер окна в тайлах (степень двойки). Координаты в шейдере живут по модулю WINDOW,
// поэтому точности float хватает на любом удалении от начала мира.
const int WINDOW = 512;
const float PERIOD = float(WINDOW);

// Сколько «пикселей» пиксель-арта приходится на сторону тайла. Должно совпадать с размером тайла у спрайтов.
const float TEXELS_PER_TILE = 16.0;
// Когда тексель становится мельче стольких пикселей экрана, включается сглаживание: иначе сетка текселей
// спорит с сеткой экрана и даёт рябь.
const float SMOOTH_BELOW_PIXELS = 2.0;

const int ERG = 0;
const int SALT_FLATS = 1;
const int RED_WASTES = 2;
const int MARSH = 3;

// Палитры от тёмного к светлому, по пять цветов на биом: эрг, солончаки, красные пустоши, топи.
// Цвета не смешиваются: каждый тексель получает ровно один цвет из набора.
const vec3 SAND_RAMP[20] = vec3[20](
  vec3(0.40, 0.27, 0.08), vec3(0.60, 0.44, 0.16), vec3(0.76, 0.60, 0.27), vec3(0.80, 0.65, 0.31), vec3(0.93, 0.82, 0.52),
  vec3(0.55, 0.52, 0.45), vec3(0.70, 0.67, 0.58), vec3(0.82, 0.79, 0.70), vec3(0.86, 0.83, 0.75), vec3(0.95, 0.93, 0.87),
  vec3(0.36, 0.15, 0.07), vec3(0.55, 0.26, 0.11), vec3(0.70, 0.36, 0.16), vec3(0.75, 0.41, 0.19), vec3(0.90, 0.60, 0.33),
  vec3(0.27, 0.25, 0.10), vec3(0.40, 0.37, 0.16), vec3(0.52, 0.48, 0.22), vec3(0.56, 0.52, 0.25), vec3(0.72, 0.68, 0.38)
);
const vec3 ROCK_RAMP[20] = vec3[20](
  vec3(0.22, 0.14, 0.03), vec3(0.31, 0.21, 0.04), vec3(0.39, 0.27, 0.06), vec3(0.45, 0.32, 0.08), vec3(0.54, 0.40, 0.13),
  vec3(0.20, 0.19, 0.18), vec3(0.29, 0.28, 0.26), vec3(0.37, 0.36, 0.33), vec3(0.44, 0.43, 0.39), vec3(0.54, 0.52, 0.47),
  vec3(0.16, 0.06, 0.04), vec3(0.25, 0.10, 0.06), vec3(0.33, 0.14, 0.08), vec3(0.40, 0.18, 0.10), vec3(0.50, 0.25, 0.14),
  vec3(0.13, 0.12, 0.07), vec3(0.20, 0.19, 0.10), vec3(0.27, 0.25, 0.13), vec3(0.33, 0.31, 0.16), vec3(0.42, 0.40, 0.22)
);
const vec3 SWAMP_RAMP[20] = vec3[20](
  vec3(0.10, 0.09, 0.05), vec3(0.15, 0.14, 0.07), vec3(0.21, 0.20, 0.10), vec3(0.32, 0.31, 0.13), vec3(0.43, 0.42, 0.18),
  vec3(0.16, 0.30, 0.32), vec3(0.22, 0.40, 0.42), vec3(0.30, 0.52, 0.52), vec3(0.55, 0.72, 0.70), vec3(0.85, 0.90, 0.86),
  vec3(0.12, 0.06, 0.04), vec3(0.19, 0.09, 0.05), vec3(0.27, 0.13, 0.07), vec3(0.40, 0.24, 0.10), vec3(0.52, 0.33, 0.14),
  vec3(0.04, 0.09, 0.06), vec3(0.07, 0.14, 0.09), vec3(0.10, 0.21, 0.13), vec3(0.24, 0.36, 0.14), vec3(0.38, 0.50, 0.20)
);
const vec3 MUD_RAMP[5] = vec3[5](
  vec3(0.16, 0.11, 0.07), vec3(0.22, 0.16, 0.10), vec3(0.28, 0.21, 0.13), vec3(0.34, 0.26, 0.16), vec3(0.40, 0.31, 0.20)
);

vec3 sandColor(int biome, int index) { return SAND_RAMP[biome * 5 + index]; }
vec3 rockColor(int biome, int index) { return ROCK_RAMP[biome * 5 + index]; }
vec3 swampColor(int biome, int index) { return SWAMP_RAMP[biome * 5 + index]; }

// Горы красятся в цвета своего биома: тени от скал, свет от песка.
vec3 mountainColor(int biome, int index) {
  if (index <= 1) return rockColor(biome, index) * 0.75;
  if (index == 2) return rockColor(biome, 4);
  return sandColor(biome, index == 3 ? 1 : 4) * 0.92;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Шум, периодичный с периодом WINDOW тайлов: при переходе камеры через границу окна картинка не дёргается.
// scale * PERIOD должно быть целым.
float noise(vec2 p, vec2 scale) {
  vec2 period = PERIOD * scale;
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

float fbm(vec2 p, float scale) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * noise(p + float(i) * 17.0, vec2(scale));
    scale *= 2.0;
    amplitude *= 0.5;
  }
  return sum;
}

vec4 tile(ivec2 cell) {
  return texelFetch(uMap, cell & (WINDOW - 1), 0);
}

// Упорядоченный дизеринг 4×4: вместо плавных переходов между цветами палитры даёт шахматные узоры.
float bayer(ivec2 texel) {
  const float matrix[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (matrix[(texel.y & 3) * 4 + (texel.x & 3)] + 0.5) / 16.0;
}

int shade(float value, float dither) {
  return clamp(int(floor(value * 4.0 + dither)), 0, 4);
}

// x — доля скал (вместе с горами), y — доля болота, z — глубина в песках (0 у границы зоны, 1 вдали
// от скал и болот). Границы зон идут между тайлами и слегка искривлены шумом.
vec3 zones(vec2 p, vec2 warp) {
  vec2 q = p - 0.5 + warp;
  ivec2 cell = ivec2(floor(q));
  vec2 linear = fract(q);
  vec2 f = smoothstep(0.3, 0.7, linear);
  vec4 weights = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  vec4 t00 = tile(cell);
  vec4 t10 = tile(cell + ivec2(1, 0));
  vec4 t01 = tile(cell + ivec2(0, 1));
  vec4 t11 = tile(cell + ivec2(1, 1));
  ivec4 types = ivec4(vec4(t00.r, t10.r, t01.r, t11.r) * 255.0 + 0.5);
  return vec3(
    dot(weights, vec4(greaterThanEqual(types, ivec4(ROCK)))),
    dot(weights, vec4(equal(types, ivec4(SWAMP)))),
    mix(mix(t00.b, t10.b, linear.x), mix(t01.b, t11.b, linear.x), linear.y)
  );
}

// Поля барханов в духе Dune II: короткие волнистые гребни со светлой кромкой и тенью под ней.
// Возвращает индекс цвета в палитре песка или -1, если гребня в этом текселе нет.
// threshold — насколько редки поля барханов: чем выше, тем их меньше.
int duneRidge(vec2 p, float coarse, float sandDepth, float threshold) {
  // Два масштаба шума и сдвиг дают полям неровные края.
  float field = noise(p + 53.0 + (coarse - 0.5) * 8.0, vec2(0.125)) * 0.75 + noise(p + 11.0, vec2(0.5)) * 0.25;
  // Рядом со скалами и болотами барханов нет.
  field -= 1.0 - smoothstep(uDunes.z, uDunes.z + 0.3, sandDepth);
  if (field < threshold) return -1;

  // Множители при p подобраны так, чтобы узор был периодичен с периодом WINDOW.
  float phase = p.y * 1.5 + p.x * 0.375 + noise(p, vec2(0.75)) * 1.2;
  float ridge = floor(phase);
  float across = phase - ridge;

  // Каждый гребень рвётся на отрезки и сужается к концам; к краю поля гребни сходят на нет.
  // Сдвиг на ridge * 8 тоже сохраняет период WINDOW: с множителем 3 узор менялся на границе окна.
  float along = noise(vec2(p.x + ridge * 8.0, mod(ridge, 64.0)), vec2(0.5, 1.0));
  float width = smoothstep(0.3, 0.55, along) * smoothstep(threshold, threshold + 0.06, field);

  if (across < 0.2 * width) return 4;
  if (across < 0.55 * width) return 0;
  if (across < 0.7 * width) return 1;
  return -1;
}

// Солончаки: расстояние до ближайшей трещины между многоугольными плитами корки.
float saltCracks(vec2 p) {
  const float scale = 0.75;
  vec2 q = p * scale;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float nearest = 8.0;
  float second = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(x, y);
      vec2 id = mod(cell + neighbor, PERIOD * scale);
      float d = length(neighbor + vec2(hash(id), hash(id + 19.3)) - f);
      if (d < nearest) {
        second = nearest;
        nearest = d;
      } else if (d < second) {
        second = d;
      }
    }
  }
  return second - nearest;
}

// Редкие мелкие пятна (камни, кочки): не больше одного на клетку. Возвращает 0, если пятна нет,
// 1 для его освещённой половины и 2 для теневой.
int speck(vec2 p, float scale, float density) {
  vec2 q = p * scale;
  vec2 id = mod(floor(q), PERIOD * scale);
  if (hash(id) > density) return 0;
  vec2 delta = fract(q) - (0.25 + 0.5 * vec2(hash(id + 7.1), hash(id + 3.3)));
  if (length(delta) > 0.1 + 0.14 * hash(id + 1.7)) return 0;
  return delta.x + delta.y < 0.0 ? 1 : 2;
}

// Совпадает с PEAK_RADIUS_SCALE в terrain.ts.
const float PEAK_RADIUS_SCALE = 4.0;
// На сколько тайлов вокруг искать вершины. Должно быть не меньше PEAK_MAX_RADIUS из terrain.ts.
const int PEAK_SEARCH = 2;

// Горы в духе Dune II: круглые холмы с лучами от центра, светлые со стороны света и тёмные с обратной.
// Вершины различаются размером, числом лучей, крутизной и кратером, а соседние срастаются в двойные и тройные.
// Возвращает индекс цвета в палитре гор или -1, если в этом текселе горы нет.
int peakShade(vec2 p, float grain, float dither) {
  ivec2 cell = ivec2(floor(p));
  if (int(tile(cell).r * 255.0 + 0.5) != MOUNTAIN) return -1;

  // Среди вершин, накрывающих тексель, рисуем ту, что в этой точке выше.
  float bestHeight = 0.0;
  float value = 0.0;
  for (int y = -PEAK_SEARCH; y <= PEAK_SEARCH; y++) {
    for (int x = -PEAK_SEARCH; x <= PEAK_SEARCH; x++) {
      ivec2 other = cell + ivec2(x, y);
      vec4 data = tile(other);
      if (int(data.r * 255.0 + 0.5) != MOUNTAIN) continue;

      int offset = int(data.a * 255.0 + 0.5);
      vec2 center = vec2(other) + 0.5 + (vec2(offset >> 4, offset & 15) - 8.0) * 0.5;
      float radius = data.b * PEAK_RADIUS_SCALE;
      vec2 delta = p - center;
      float dist = length(delta);
      if (dist > radius) continue;

      // Случайные свойства этой вершины.
      vec2 seed = mod(center, PERIOD);
      float kind = hash(seed + 3.1);
      float steep = hash(seed + 5.7);

      // Лучи разной длины и яркости расходятся от центра и дают рваный контур.
      float streaks = floor(14.0 + radius * 8.0 + kind * 8.0);
      float angle = atan(delta.y, delta.x) / 6.2831853 + 0.5;
      float streak = hash(vec2(floor(angle * streaks), seed.x + seed.y * 7.0) + 0.37);
      float d = dist / (radius * (0.75 + 0.25 * streak));
      if (d > 1.0) continue;

      float height = (1.0 - d) * radius;
      if (height <= bestHeight) continue;
      bestHeight = height;

      // Свет падает слева сверху.
      float lit = dot(delta / max(dist, 0.001), vec2(-0.6, -0.8));
      // У части вершин кратер разного размера, остальные — острые пики.
      float crater = kind > 0.45 ? 0.25 + (kind - 0.45) * 0.5 : 0.0;
      if (d < crater) lit = -lit * 0.9;

      value = 0.5 + lit * (0.28 + steep * 0.2) + (streak - 0.5) * 0.4 + (grain - 0.5) * 0.15;
      // Светлая кромка кратера или светлая макушка пика.
      value += (1.0 - smoothstep(0.0, 0.07, abs(d - crater))) * (crater > 0.0 ? 0.3 : 0.2);
      // Тёмное подножие.
      value -= smoothstep(0.8, 1.0, d) * 0.3;
    }
  }
  return bestHeight > 0.0 ? shade(value, dither) : -1;
}

// Цвет карты в точке мира. detail гасит зерно и дизеринг: 1 — в полную силу, 0 — ровная заливка.
vec3 terrainColor(vec2 worldP, float detail) {
  // Всё считается в центре текселя пиксель-арта, а не в точке экрана.
  ivec2 texel = ivec2(floor(worldP * TEXELS_PER_TILE));
  vec2 p = (vec2(texel) + 0.5) / TEXELS_PER_TILE;
  float dither = mix(0.5, bayer(texel), detail);
  // Случайное зерно на каждый тексель.
  float grain = mix(0.5, fract(sin(dot(mod(vec2(texel), 1024.0), vec2(12.9898, 78.233))) * 43758.5453), detail);

  float coarse = fbm(p, 1.0);
  float fine = noise(p, vec2(8.0));

  vec2 warp = (vec2(noise(p, vec2(2.25)), noise(p + 31.0, vec2(2.25))) - 0.5) * 0.6;
  vec3 zone = zones(p, warp);
  float rock = zone.x;
  float swamp = zone.y;

  // Биом тайла: основной, соседний и доля соседнего. На стыке биомы перемешиваются пятнами.
  int packed = int(tile(ivec2(floor(p))).g * 255.0 + 0.5);
  int biome = packed >> 6;
  if (coarse * 0.6 + grain * 0.4 < float(packed & 15) / 30.0) biome = (packed >> 4) & 3;

  int peak = peakShade(p, grain, dither);

  vec3 color;
  if (peak >= 0) {
    color = mountainColor(biome, peak);
  } else if (rock > 0.5) {
    float value = 0.45 + (coarse - 0.5) * 0.7 + (grain - 0.5) * 0.45;
    // Тёмная кайма по краю плато.
    value -= (1.0 - smoothstep(0.5, 0.85, rock)) * 0.5;
    color = rockColor(biome, shade(value, dither));
  } else if (swamp > 0.5) {
    // Анимация шагами, как покадровая.
    float time = floor(uTime * 5.0) / 5.0;
    float ripple = noise(p + vec2(time * 0.12, time * 0.07), vec2(2.5)) * 0.6
      + noise(p - vec2(time * 0.15, 0.0), vec2(6.0)) * 0.4;
    float scum = smoothstep(0.5, 0.62, coarse);
    float value = ripple * 0.55 + scum * 0.5;
    // Тёмная кромка воды у берега.
    value -= (1.0 - smoothstep(0.5, 0.7, swamp)) * 0.3;
    color = swampColor(biome, shade(value, dither));
  } else if (swamp > 0.04) {
    // Берег: мокрая грязь, а на солончаках — потемневшая соляная корка.
    int index = shade(fine * 0.5 + (0.5 - swamp) * 1.0, dither);
    color = biome == SALT_FLATS ? sandColor(biome, index / 2) : MUD_RAMP[index];
  } else {
    // Ровный песок с мелким зерном: два соседних цвета палитры.
    color = sandColor(biome, grain < 0.3 ? 3 : 2);

    if (biome == SALT_FLATS) {
      // Растрескавшаяся соляная корка.
      float crack = saltCracks(p + (coarse - 0.5) * 0.8);
      if (crack < 0.07) color = sandColor(biome, crack < 0.03 ? 0 : 1);
    } else if (biome == MARSH) {
      // Кочки с растительностью, гуще у воды.
      int tuft = speck(p, 2.0, 0.55 - zone.z * 0.4);
      if (tuft > 0) color = swampColor(biome, tuft == 1 ? 4 : 3);
    } else {
      // Барханы: в эрге их много, в красных пустошах почти нет, зато там разбросаны камни.
      int ridge = duneRidge(p, coarse, zone.z, biome == ERG ? uDunes.x : uDunes.y);
      int stone = biome == RED_WASTES ? speck(p, 1.0, 0.22) : 0;
      if (stone > 0) color = rockColor(biome, stone == 1 ? 4 : 1);
      else if (ridge >= 0) color = sandColor(biome, ridge);
    }
  }
  return color;
}

void main() {
  vec2 screenP = uCamera + (vUV - 0.5) * uScreenSize / uZoom;
  // Шаг в мире на один физический пиксель экрана.
  vec2 pixelX = dFdx(screenP);
  vec2 pixelY = dFdy(screenP);
  float texelPixels = 1.0 / (pixelX.x * TEXELS_PER_TILE);

  vec3 color;
  if (texelPixels >= SMOOTH_BELOW_PIXELS) {
    // Вблизи — чёткий пиксель-арт.
    color = terrainColor(screenP, 1.0);
  } else {
    // Издалека усредняем четыре точки внутри пикселя экрана, а зерно, которое мельче пикселя, гасим.
    float detail = clamp(texelPixels * 2.0 - 1.0, 0.0, 1.0);
    color = 0.25 * (
      terrainColor(screenP + pixelX * 0.125 + pixelY * 0.375, detail)
      + terrainColor(screenP - pixelX * 0.375 + pixelY * 0.125, detail)
      + terrainColor(screenP + pixelX * 0.375 - pixelY * 0.125, detail)
      + terrainColor(screenP - pixelX * 0.125 - pixelY * 0.375, detail)
    );
  }

  vec2 edge = abs(fract(screenP) - 0.5);
  float line = smoothstep(0.5 - 1.5 / uZoom, 0.5, max(edge.x, edge.y));
  color *= 1.0 - 0.3 * line * uGrid * smoothstep(10.0, 24.0, uZoom);

  finalColor = vec4(color, 1.0);
}
