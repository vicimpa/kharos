//! Сценарии tests/scenarios/*.luau: клиент проходит каждый в невидимом окне (`kharos --scenario`), код выхода 0 —
//! сценарий дошёл до конца. Нужен GPU: окно невидимое, но настоящее.

use std::path::Path;
use std::process::Command;

#[test]
fn scenarios_pass() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
  let mut paths: Vec<_> = std::fs::read_dir(root.join("tests/scenarios")).expect("tests/scenarios").filter_map(|entry| entry.ok().map(|entry| entry.path())).filter(|path| path.extension().is_some_and(|ext| ext == "luau")).collect();
  paths.sort();
  assert!(!paths.is_empty(), "сценариев нет");
  let mut failed = Vec::new();
  for path in &paths {
    let output = Command::new(env!("CARGO_BIN_EXE_kharos")).current_dir(&root).arg("--scenario").arg(path).args(["--timeout", "300"]).output().expect("клиент");
    if !output.status.success() {
      failed.push(format!("{}:\n{}{}", path.display(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)));
    }
  }
  assert!(failed.is_empty(), "не прошли:\n{}", failed.join("\n"));
}
