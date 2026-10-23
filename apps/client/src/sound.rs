// Воркер браузера: считает звуки экрана загрузки в своём потоке (loading.rs). На нативе потоки — свои, воркер пуст.

fn main() {
  #[cfg(target_arch = "wasm32")]
  kharos_client::sound_worker();
}
