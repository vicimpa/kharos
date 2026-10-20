// Сборка сервера: моды из папки `mods` зашиваются в бинарь — сервер одним файлом совпадает со страницей игры из того же
// коммита (сумма модов при входе). build.rs пишет список с `include_bytes!` в OUT_DIR/mods.rs, как у клиента.
use std::path::{Path, PathBuf};

fn main() {
  println!("cargo:rerun-if-changed=build.rs");
  let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("mods.rs");
  let mut code = String::from("&[\n");
  {
    let root = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../mods").canonicalize().expect("папка mods");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut mods: Vec<PathBuf> = std::fs::read_dir(&root).unwrap().filter_map(|entry| entry.ok().map(|entry| entry.path())).filter(|path| path.join("mod.luau").is_file()).collect();
    mods.sort();
    for dir in mods {
      let name = dir.file_name().unwrap().to_string_lossy().to_string();
      code.push_str(&format!("  ({name:?}, &[\n"));
      let mut files = Vec::new();
      walk(&dir, &mut files);
      files.sort();
      for file in files {
        let relative = file.strip_prefix(&dir).unwrap().components().map(|part| part.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/");
        code.push_str(&format!("    ({relative:?}, include_bytes!({:?})),\n", file.display().to_string()));
      }
      code.push_str("  ]),\n");
    }
  }
  code.push(']');
  std::fs::write(out, code).unwrap();
}

/// Файлы модов, которые читает клиент: тексты Luau и картинки (те же, что у страницы).
fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
  for entry in std::fs::read_dir(dir).unwrap().filter_map(Result::ok) {
    let path = entry.path();
    if path.is_dir() {
      walk(&path, files);
    } else if path.extension().is_some_and(|ext| ext == "luau" || ext == "png") {
      println!("cargo:rerun-if-changed={}", path.display());
      files.push(path);
    }
  }
}
