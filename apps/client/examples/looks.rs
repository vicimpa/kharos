//! Кадры и портреты обликов из модов сырыми RGBA — сверить, что правка чертежей не сдвинула ни пикселя:
//!
//!   cargo run -p kharos-client --release --example looks <файл> раздел/вид…

use kharos_content::{discover, Content, Side};
use std::path::Path;

fn main() {
  let mut args = std::env::args().skip(1);
  let path = args.next().expect("файл");
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let content = Content::load(Side::Client, mods).unwrap();
  let mut out = Vec::new();
  for kind in args {
    let (section, name) = kind.split_once('/').expect("раздел/вид");
    let id = content.id(section, name).expect("вид");
    let look = content.get(section, name).unwrap().get::<mlua::Table>("look").unwrap();
    let built = kharos_client::atlas::build(&content.lua, id, look).unwrap();
    for image in &built.images {
      out.extend_from_slice(image);
    }
    if let Some((pixels, _)) = &built.portrait {
      out.extend_from_slice(pixels);
    }
  }
  std::fs::write(path, out).unwrap();
}
