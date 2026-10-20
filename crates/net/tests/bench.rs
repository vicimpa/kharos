//! Замер рассылки: показательный бой (две армии у начала мира), что весит кадр игроку и сколько стоит его собрать.
//! `cargo test --release -p kharos-net --test bench -- --ignored --nocapture`.

use kharos_content::discover;
use kharos_net::{Rules, Shared, View};
use kharos_world::Host;
use std::path::Path;
use std::rc::Rc;
use std::time::Instant;

#[test]
#[ignore]
fn battle_frames() {
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut host = Host::new(mods, Some("battle"), 7, &serde_json::Value::Null).unwrap();
  host.start().unwrap();
  for player in 1..=20 {
    host.join(player).unwrap();
  }
  let schema = host.state.borrow().world.schema.clone();
  let rules = Rc::new(Rules::of(&host.content, &schema).unwrap());
  let mut views: Vec<View> = (1..=3).map(View::new).collect();
  let (mut bytes, mut biggest, mut tick_time, mut frame_time) = (0usize, 0usize, 0.0, 0.0);
  let ticks = 400;
  let mut early = Vec::new();
  for tick in 0..ticks {
    let started = Instant::now();
    host.tick(0.05).unwrap();
    tick_time += started.elapsed().as_secs_f64();
    let started = Instant::now();
    let signals = host.signals();
    let shared = Shared::after_tick(&mut host.state.borrow_mut(), rules.clone(), signals);
    for view in &mut views {
      let frame = view.frame(&mut host.state.borrow_mut(), &shared);
      let size = frame.encode(&schema).len();
      if view.player == 1 && tick > 0 {
        bytes += size;
        biggest = biggest.max(size);
        if tick <= 100 {
          early.push((size, frame.changes.len(), frame.removed.len()));
        }
      }
    }
    frame_time += started.elapsed().as_secs_f64();
  }
  let entities = host.state.borrow().world.count();
  let first: usize = early.iter().map(|e| e.0).sum::<usize>() / early.len().max(1);
  println!("тики 1–100: {first} Б на тик ({:.0} КБ/с), сущностей с правками в кадре в среднем {}", first as f64 * 20.0 / 1024.0, early.iter().map(|e| e.1).sum::<usize>() / early.len().max(1));
  println!("сущностей {entities}; игроку 1: {} Б на тик в среднем ({:.0} КБ/с), самый большой кадр {biggest} Б; тик {:.2} мс, кадры трём игрокам {:.2} мс", bytes / ticks, bytes as f64 / ticks as f64 * 20.0 / 1024.0, tick_time * 1000.0 / ticks as f64, frame_time * 1000.0 / ticks as f64);
}

/// Мир побольше: тестовая база у каждого из десяти игроков на карте 512, у всех тумана нет — каждый видит всё.
#[test]
#[ignore]
fn bases_frames() {
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut host = Host::new(mods, Some("sandbox"), 7, &serde_json::json!({ "size": 256, "fog": false })).unwrap();
  host.start().unwrap();
  for player in 1..=10 {
    host.join(player).unwrap();
  }
  let schema = host.state.borrow().world.schema.clone();
  let rules = Rc::new(Rules::of(&host.content, &schema).unwrap());
  let mut views: Vec<View> = (1..=10).map(View::new).collect();
  let (mut bytes, mut tick_time, mut frame_time) = (0usize, 0.0, 0.0);
  let ticks = 200;
  for tick in 0..ticks {
    let started = Instant::now();
    host.tick(0.05).unwrap();
    tick_time += started.elapsed().as_secs_f64();
    let started = Instant::now();
    let signals = host.signals();
    let shared = Shared::after_tick(&mut host.state.borrow_mut(), rules.clone(), signals);
    for view in &mut views {
      let size = view.frame(&mut host.state.borrow_mut(), &shared).encode(&schema).len();
      if view.player == 1 && tick > 0 {
        bytes += size;
      }
    }
    frame_time += started.elapsed().as_secs_f64();
  }
  let entities = host.state.borrow().world.count();
  let mut timings = host.timings();
  timings.sort_by(|a, b| b.1.iter().sum::<f64>().total_cmp(&a.1.iter().sum::<f64>()));
  for (name, parts) in timings.iter().take(12) {
    println!("{name}: {:.2} мс на тик ({:.2} столбцы, {:.2} Luau, {:.2} возврат, {:.2} команды)", parts.iter().sum::<f64>() / ticks as f64, parts[0] / ticks as f64, parts[1] / ticks as f64, parts[2] / ticks as f64, parts[3] / ticks as f64);
  }
  println!("сущностей {entities}; игроку 1: {} Б на тик ({:.0} КБ/с); тик {:.2} мс, кадры десяти игрокам {:.2} мс", bytes / ticks, bytes as f64 / ticks as f64 * 20.0 / 1024.0, tick_time * 1000.0 / ticks as f64, frame_time * 1000.0 / ticks as f64);
}
