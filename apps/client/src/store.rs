//! Где клиент хранит настройки и сохранения: ключ → текст. На нативе ключ — путь файла в папке настроек
//! (`KHAROS_CONFIG`, иначе `~/.config/kharos`, на Windows — `%APPDATA%\Kharos`), запись — через временный файл, чтобы
//! оборванная не испортила прежнюю. В браузере — `localStorage` страницы, ключи с приставкой `kharos/`.

#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

/// Папка настроек и сохранений.
#[cfg(not(target_arch = "wasm32"))]
pub fn config_dir() -> Option<PathBuf> {
  std::env::var_os("KHAROS_CONFIG").map(PathBuf::from).or_else(|| if cfg!(windows) { std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Kharos")) } else { std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("kharos")) })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn read(key: &str) -> Option<String> {
  std::fs::read_to_string(config_dir()?.join(key)).ok()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn write(key: &str, text: &str) -> Result<(), String> {
  let path = config_dir().ok_or("нет папки настроек")?.join(key);
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
  }
  let temporary = path.with_extension("part");
  std::fs::write(&temporary, text).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn remove(key: &str) {
  if let Some(dir) = config_dir() {
    let _ = std::fs::remove_file(dir.join(key));
  }
}

#[cfg(target_arch = "wasm32")]
fn storage() -> Option<web_sys::Storage> {
  web_sys::window()?.local_storage().ok().flatten()
}

#[cfg(target_arch = "wasm32")]
pub fn read(key: &str) -> Option<String> {
  storage()?.get_item(&format!("kharos/{key}")).ok().flatten()
}

#[cfg(target_arch = "wasm32")]
pub fn write(key: &str, text: &str) -> Result<(), String> {
  storage().ok_or("нет localStorage")?.set_item(&format!("kharos/{key}"), text).map_err(|error| format!("{key}: {error:?}"))
}

#[cfg(target_arch = "wasm32")]
pub fn remove(key: &str) {
  if let Some(storage) = storage() {
    let _ = storage.remove_item(&format!("kharos/{key}"));
  }
}
