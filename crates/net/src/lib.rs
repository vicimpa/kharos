//! Сеть Kharos (docs/net.md): сервер считает мир, клиент держит реплику того, что видит его игрок. Здесь — без
//! сокетов: что уходит подключению (`view`), кадр и провод (`frame`, `codec`), кому что видно (`rules`) и реплика.

pub mod codec;
pub mod frame;
pub mod replica;
pub mod rules;
pub mod view;

pub use frame::Frame;
pub use replica::Replica;
pub use rules::Rules;
pub use view::{Shared, View};
