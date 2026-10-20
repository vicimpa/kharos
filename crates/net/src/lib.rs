//! Сеть Kharos (docs/net.md): сервер считает мир, клиент держит реплику того, что видит его игрок. Здесь — без
//! сокетов: что уходит подключению (`view`), кадр и провод (`frame`, `codec`), кому что видно (`rules`), реплика,
//! сообщения (`protocol`) и хост с подключениями (`server`).

pub mod codec;
pub mod frame;
pub mod protocol;
pub mod replica;
pub mod rules;
pub mod server;
pub mod view;

pub use frame::Frame;
pub use replica::Replica;
pub use protocol::{ClientMessage, Message, ServerMessage};
pub use rules::Rules;
pub use server::Server;
pub use view::{Shared, View};
