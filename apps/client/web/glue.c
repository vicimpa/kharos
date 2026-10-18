// Браузерная оболочка клиента (src/web.rs): контекст WebGL 2 на #canvas и размер холста в пикселях экрана — через
// html5.h Emscripten, чтобы Rust не повторял раскладку его структур.

#include <emscripten/html5.h>

// Контекст WebGL 2 без глубины и сглаживания, с альфой, — текущий. 0 — не вышло.
int kharos_gl_context(void) {
  EmscriptenWebGLContextAttributes attributes;
  emscripten_webgl_init_context_attributes(&attributes);
  attributes.majorVersion = 2;
  attributes.minorVersion = 0;
  attributes.alpha = 1;
  attributes.depth = 0;
  attributes.stencil = 0;
  attributes.antialias = 0;
  attributes.premultipliedAlpha = 1;
  attributes.preserveDrawingBuffer = 1;
  EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = emscripten_webgl_create_context("#canvas", &attributes);
  if (context <= 0) return 0;
  emscripten_webgl_make_context_current(context);
  return 1;
}

// Размер холста на странице в пикселях CSS и пикселей экрана на пиксель CSS; буфер холста — в пикселях экрана.
void kharos_canvas_size(double *width, double *height, double *scale) {
  emscripten_get_element_css_size("#canvas", width, height);
  *scale = emscripten_get_device_pixel_ratio();
  int pixelsWidth = (int)(*width * *scale + 0.5), pixelsHeight = (int)(*height * *scale + 0.5), oldWidth, oldHeight;
  emscripten_get_canvas_element_size("#canvas", &oldWidth, &oldHeight);
  if (oldWidth != pixelsWidth || oldHeight != pixelsHeight) emscripten_set_canvas_element_size("#canvas", pixelsWidth, pixelsHeight);
}
