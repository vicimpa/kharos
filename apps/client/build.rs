// Сборка клиента: под Emscripten (браузер, tools/web/build.sh) — склейка с html5.h и настройки компоновщика.
fn main() {
  println!("cargo:rerun-if-changed=build.rs");
  println!("cargo:rerun-if-changed=web/glue.c");
  println!("cargo:rerun-if-changed=web/shell.js");
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("emscripten") {
    return;
  }
  cc::Build::new().file("web/glue.c").compile("kharos_glue");
  let shell = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("web/shell.js");
  for arg in [
    "-sMIN_WEBGL_VERSION=2",
    "-sMAX_WEBGL_VERSION=2",
    "-sALLOW_MEMORY_GROWTH=1",
    // Luau и мир глубоко рекурсивны: стек побольше.
    "-sSTACK_SIZE=8388608",
    "-sFORCE_FILESYSTEM=1",
    // Luau — на C++: его рантайм и исключения.
    "-sDEFAULT_TO_CXX",
    "-sEXPORTED_FUNCTIONS=_main,_kharos_pointer,_kharos_leave,_kharos_button,_kharos_wheel,_kharos_key,_kharos_text,_kharos_focus,_kharos_save",
    "-sEXPORTED_RUNTIME_METHODS=ccall,FS",
    "-lidbfs.js",
  ] {
    println!("cargo:rustc-link-arg={arg}");
  }
  println!("cargo:rustc-link-arg=--pre-js={}", shell.display());
}
