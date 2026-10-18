//! Движок Kharos (docs/engine.md, §4): то, что не знает правил игры, а даёт им место и инструменты, — земля
//! (terrain), слои (docs/layers.md) и счёт, совпадающий с JS (math). Мир столбцами и хост — в `kharos-world`.

pub mod layers;
pub mod math;
pub mod terrain;

pub use layers::{Change, Channel, Item, LayerId, LayerSpec, Layers, Owner, Scope, Shape};
