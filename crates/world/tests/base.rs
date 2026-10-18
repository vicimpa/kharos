//! Мод base на хосте: вход игрока, производство за кредиты, приказ ехать.

use kharos_content::discover;
use kharos_world::Host;
use serde_json::json;
use std::path::Path;

fn host() -> Host {
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut host = Host::new(mods, None, 7, &serde_json::Value::Null).unwrap();
  host.start().unwrap();
  host.join(1).unwrap();
  host
}

/// Сущности с компонентом и их значения.
fn all(host: &Host, component: &str) -> Vec<(u32, serde_json::Map<String, serde_json::Value>)> {
  let state = host.state.borrow();
  let id = state.world.schema.id(component).unwrap();
  state.world.query(&[id]).into_iter().map(|entity| (entity, state.world.get(entity, id).unwrap())).collect()
}

fn credits(host: &Host) -> f64 {
  all(host, "Player")[0].1["credits"].as_f64().unwrap()
}

/// Место сущности.
fn place(host: &Host, entity: u32) -> (f64, f64) {
  let state = host.state.borrow();
  let id = state.world.schema.id("Position").unwrap();
  let at = state.world.get(entity, id).unwrap();
  (at["x"].as_f64().unwrap(), at["y"].as_f64().unwrap())
}

/// Тайлы под заводом: середина и по тайлу во все стороны.
fn factory_tiles(host: &Host) -> Vec<(i32, i32)> {
  let (x, y) = place(host, all(host, "Building")[0].0);
  let (cx, cy) = (x.floor() as i32, y.floor() as i32);
  (-1..=1).flat_map(|dy| (-1..=1).map(move |dx| (cx + dx, cy + dy))).collect()
}

#[test]
fn player_starts_with_factory_buggies_and_credits() {
  let host = host();
  assert_eq!(all(&host, "Building").len(), 1);
  let buggies = all(&host, "Mover");
  assert_eq!(buggies.len(), 3);
  // У каждого багги — стрелок на месте за водителем.
  assert_eq!(all(&host, "Turret").len(), 3);
  assert_eq!(credits(&host), 1000.0);
  // Машины стоят на свободных тайлах вокруг завода, каждая посреди своего тайла, не под заводом.
  let under = factory_tiles(&host);
  for (entity, _) in &buggies {
    let (x, y) = place(&host, *entity);
    assert_eq!((x.fract().abs(), y.fract().abs()), (0.5, 0.5));
    assert!(!under.contains(&(x.floor() as i32, y.floor() as i32)), "{x} {y}");
  }
  assert!(host.system_names().contains(&"mechanics/movement.move".to_string()), "{:?}", host.system_names());
}

#[test]
fn factory_makes_a_buggy_for_credits_and_it_comes_out_beside_it() {
  let mut host = host();
  let factory = all(&host, "Building")[0].0;
  host.send(1, "produce", json!({ "building": factory, "unit": "buggy" }));
  // Чужой заказ и заказ того, чего завод не делает, не проходят.
  host.send(2, "produce", json!({ "building": factory, "unit": "buggy" }));
  host.send(1, "produce", json!({ "building": factory, "unit": "factory" }));
  host.send(1, "rally", json!({ "building": factory, "x": 6, "y": -8 }));
  host.tick(0.05).unwrap();
  assert_eq!(credits(&host), 750.0);
  // 7 секунд выпуска — 140 тиков; за них доход — 7 раз по 5.
  let mut produced = Vec::new();
  for _ in 0..140 {
    host.tick(0.05).unwrap();
    produced.extend(host.signals().into_iter().filter(|signal| signal.name == "produced"));
  }
  assert_eq!(produced.len(), 1);
  assert_eq!(produced[0].payload["unit"], json!("buggy"));
  assert_eq!(all(&host, "Mover").len(), 4);
  assert_eq!(all(&host, "Turret").len(), 4);
  assert_eq!(credits(&host), 785.0);
  // Новый — рядом с заводом, а не под ним, и едет к точке сбора.
  let made = produced[0].payload["entity"].as_f64().unwrap() as u32;
  let (x, y) = (produced[0].payload["x"].as_f64().unwrap(), produced[0].payload["y"].as_f64().unwrap());
  assert!(!factory_tiles(&host).contains(&(x.floor() as i32, y.floor() as i32)));
  assert!(all(&host, "Path").iter().any(|(entity, _)| *entity == made), "к точке сбора");
  for _ in 0..200 {
    host.tick(0.05).unwrap();
  }
  let (x, y) = place(&host, made);
  assert!((x - 6.5).abs() <= 2.5 && (y + 7.5).abs() <= 2.5, "{x} {y}");
}

#[test]
fn ordered_buggies_take_their_own_tiles_near_the_point_and_stop() {
  let mut host = host();
  let units: Vec<u32> = all(&host, "Mover").into_iter().map(|(entity, _)| entity).collect();
  host.send(1, "move", json!({ "units": units, "x": 10, "y": -6 }));
  host.tick(0.05).unwrap();
  // Каждому — свой тайл: через тайл друг от друга вокруг цели.
  let goals: Vec<(i64, i64)> = all(&host, "Path").into_iter().map(|(_, path)| (path["goalX"].as_f64().unwrap() as i64, path["goalY"].as_f64().unwrap() as i64)).collect();
  assert_eq!(goals.len(), 3);
  let unique: std::collections::HashSet<_> = goals.iter().collect();
  assert_eq!(unique.len(), 3, "{goals:?}");
  for _ in 0..300 {
    host.tick(0.05).unwrap();
  }
  assert!(all(&host, "Path").is_empty(), "доехали и встали");
  for &entity in &units {
    let (x, y) = place(&host, entity);
    assert!((x - 10.5).abs() <= 3.0 && (y + 5.5).abs() <= 3.0, "{x} {y}");
  }
}

#[test]
fn buggy_drives_around_the_factory_not_through_it() {
  let mut host = host();
  let under = factory_tiles(&host);
  let (fx, fy) = place(&host, all(&host, "Building")[0].0);
  // Самая южная машина — на ту сторону завода, к северу.
  let buggy = all(&host, "Mover").into_iter().map(|(entity, _)| entity).max_by(|a, b| place(&host, *a).1.total_cmp(&place(&host, *b).1)).unwrap();
  let (gx, gy) = (fx.floor(), fy.floor() - 4.0);
  host.send(1, "move", json!({ "units": [buggy], "x": gx, "y": gy }));
  for _ in 0..300 {
    host.tick(0.05).unwrap();
    let (x, y) = place(&host, buggy);
    assert!(!under.contains(&(x.floor() as i32, y.floor() as i32)), "въехал в завод: {x} {y}");
  }
  let (x, y) = place(&host, buggy);
  assert!((x - gx - 0.5).abs() <= 1.5 && (y - gy - 0.5).abs() <= 1.5, "{x} {y}");
}

#[test]
fn snapshot_restores_the_same_game_and_it_goes_on_the_same() {
  let mut host = host();
  let factory = all(&host, "Producer")[0].0;
  host.send(1, "produce", json!({ "building": factory, "unit": "buggy" }));
  let buggies: Vec<u32> = all(&host, "Mover").into_iter().map(|(entity, _)| entity).collect();
  host.send(1, "move", json!({ "units": buggies, "x": 10, "y": 6 }));
  for _ in 0..60 {
    host.tick(0.05).unwrap();
  }
  let snapshot = host.snapshot().unwrap();
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut copy = Host::new(mods, None, 7, &serde_json::Value::Null).unwrap();
  copy.restore(&snapshot).unwrap();
  assert_eq!(copy.snapshot().unwrap(), snapshot);
  // Дальше обе партии идут одинаково: производство доделывает багги, приказ доезжает.
  for _ in 0..140 {
    host.tick(0.05).unwrap();
    copy.tick(0.05).unwrap();
  }
  assert_eq!(copy.snapshot().unwrap(), host.snapshot().unwrap());
  assert_eq!(all(&copy, "Mover").len(), 4);
}
