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

#[test]
fn player_starts_with_factory_buggies_and_credits() {
  let host = host();
  assert_eq!(all(&host, "Building").len(), 1);
  assert_eq!(all(&host, "Drive").len(), 3);
  // У каждого багги — стрелок на месте за водителем.
  assert_eq!(all(&host, "Turret").len(), 3);
  assert_eq!(credits(&host), 1000.0);
  assert!(host.system_names().contains(&"moves/wheels.drive".to_string()), "{:?}", host.system_names());
}

#[test]
fn factory_makes_a_buggy_for_credits_and_it_drives_out() {
  let mut host = host();
  let factory = all(&host, "Building")[0].0;
  host.send(1, "produce", json!({ "building": factory, "unit": "buggy" }));
  // Чужой заказ и заказ того, чего завод не делает, не проходят.
  host.send(2, "produce", json!({ "building": factory, "unit": "buggy" }));
  host.send(1, "produce", json!({ "building": factory, "unit": "factory" }));
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
  let drives = all(&host, "Drive");
  assert_eq!(drives.len(), 4);
  assert!(drives.iter().any(|(_, drive)| drive["moving"] == json!(true)), "новый едет к точке");
  assert_eq!(all(&host, "Turret").len(), 4);
  assert_eq!(credits(&host), 785.0);
}

#[test]
fn ordered_buggies_spread_around_the_point_and_stop() {
  let mut host = host();
  let units: Vec<u32> = all(&host, "Drive").into_iter().map(|(entity, _)| entity).collect();
  host.send(1, "move", json!({ "units": units, "x": 10, "y": -6 }));
  for _ in 0..200 {
    host.tick(0.05).unwrap();
  }
  let positions: Vec<(f64, f64)> = all(&host, "Position").into_iter().filter(|(entity, _)| units.contains(entity)).map(|(_, at)| (at["x"].as_f64().unwrap(), at["y"].as_f64().unwrap())).collect();
  for (x, y) in &positions {
    assert!((x - 10.0).abs() <= 1.3 && (y + 6.0).abs() <= 1.3, "{positions:?}");
  }
  assert!(all(&host, "Drive").iter().all(|(_, drive)| drive["moving"] == json!(false)));
}

#[test]
fn snapshot_restores_the_same_game_and_it_goes_on_the_same() {
  let mut host = host();
  let factory = all(&host, "Producer")[0].0;
  host.send(1, "produce", json!({ "building": factory, "unit": "buggy" }));
  let buggies: Vec<u32> = all(&host, "Drive").into_iter().map(|(entity, _)| entity).collect();
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
  assert_eq!(all(&copy, "Drive").len(), 4);
}
