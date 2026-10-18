//! Мир Kharos столбцами и хост правил (docs/mods.md, «Хост»). Компоненты объявляет контент, системы модов получают
//! столбцы буферами, меняют мир командами, говорят друг с другом событиями, а клиентам шлют сигналы.

pub mod combat;
pub mod host;
pub mod motion;
pub mod networks;
pub mod schema;
pub mod tools;
pub mod vision;
pub mod world;

pub use host::{land_config, Host, Signal};
pub use schema::{ComponentId, Kind, Schema};
pub use world::{Entity, World};
