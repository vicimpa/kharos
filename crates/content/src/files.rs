//! Файлы мода в памяти: путь от корня мода → текст. Моды маленькие, а так загрузка одна и та же для папки на диске,
//! архива и пакета, присланного по сети, и сумма содержимого считается без похода на диск.

use std::collections::BTreeMap;
use std::path::Path;

/// Файлы одного мода. Пути — через `/`, от корня мода: `units/buggy.luau`, `units/tank/init.luau`.
#[derive(Clone, Debug, Default)]
pub struct Files {
  pub files: BTreeMap<String, String>,
  /// Картинки мода (`.png`): облик может взять картинку вместо чертежа.
  pub assets: BTreeMap<String, Vec<u8>>,
}

impl Files {
  /// Все `.luau` и `.png` из папки мода, с подпапками.
  pub fn read_dir(root: &Path) -> std::io::Result<Self> {
    let mut files = BTreeMap::new();
    let mut assets = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
      for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.is_dir() {
          stack.push(path);
        } else if path.extension().is_some_and(|ext| ext == "luau") {
          let relative = path.strip_prefix(root).expect("файл внутри мода").components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
          files.insert(relative, std::fs::read_to_string(&path)?);
        } else if path.extension().is_some_and(|ext| ext == "png") {
          let relative = path.strip_prefix(root).expect("файл внутри мода").components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
          assets.insert(relative, std::fs::read(&path)?);
        }
      }
    }
    Ok(Self { files, assets })
  }

  pub fn get(&self, path: &str) -> Option<&str> {
    self.files.get(path).map(String::as_str)
  }

  /// Виды раздела: файл `раздел/имя.luau` или папка `раздел/имя/` с `init.luau`. Имя → путь файла, по имени.
  pub fn kinds(&self, section: &str) -> BTreeMap<String, String> {
    let prefix = format!("{section}/");
    let mut kinds = BTreeMap::new();
    for path in self.files.keys() {
      let Some(rest) = path.strip_prefix(&prefix) else { continue };
      let parts: Vec<&str> = rest.split('/').collect();
      match parts.as_slice() {
        [file] => {
          if let Some(name) = file.strip_suffix(".luau") {
            kinds.insert(name.to_string(), path.clone());
          }
        }
        [dir, "init.luau"] => {
          kinds.insert(dir.to_string(), path.clone());
        }
        _ => {}
      }
    }
    kinds
  }

  /// Разделы мода — папки первого уровня, кроме `lib` (общий код для `require`).
  pub fn sections(&self) -> Vec<String> {
    let sections: std::collections::BTreeSet<String> = self.files.keys().filter_map(|path| path.split_once('/').map(|(dir, _)| dir.to_string())).filter(|dir| dir != "lib").collect();
    sections.into_iter().collect()
  }

  /// Сумма содержимого (FNV-1a по путям и текстам): совпала у хоста и клиента — моды одни и те же.
  pub fn checksum(&self) -> u64 {
    let mut hash = Fnv::default();
    for (path, text) in &self.files {
      hash.write(path.as_bytes());
      hash.write(&[0]);
      hash.write(text.as_bytes());
      hash.write(&[0]);
    }
    for (path, bytes) in &self.assets {
      hash.write(path.as_bytes());
      hash.write(&[0]);
      hash.write(bytes);
    }
    hash.0
  }
}

/// FNV-1a, 64 бита: одинаковая на всех платформах, в отличие от `DefaultHasher`.
pub struct Fnv(pub u64);

impl Default for Fnv {
  fn default() -> Self {
    Self(0xcbf29ce484222325)
  }
}

impl Fnv {
  pub fn write(&mut self, bytes: &[u8]) {
    for &byte in bytes {
      self.0 ^= byte as u64;
      self.0 = self.0.wrapping_mul(0x100000001b3);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn kinds_are_files_or_folders_with_init() {
    let mut files = Files::default();
    for path in ["mod.luau", "units/buggy.luau", "units/tank/init.luau", "units/tank/look.luau", "lib/geom.luau", "sounds/motor.luau"] {
      files.files.insert(path.into(), String::new());
    }
    let units: Vec<_> = files.kinds("units").into_iter().collect();
    assert_eq!(units, [("buggy".to_string(), "units/buggy.luau".to_string()), ("tank".to_string(), "units/tank/init.luau".to_string())]);
    assert_eq!(files.sections(), ["sounds", "units"]);
  }
}
