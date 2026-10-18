//! Мод base на хосте: стартовый набор, разворачивание MCV и сворачивание, производство за кредиты, приказ ехать.

use kharos_content::discover;
use kharos_engine::terrain::{FOOT_BIT, ROCK};
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

/// Сущности вида раздел/имя.
fn kind(host: &Host, section: &str, name: &str) -> Vec<u32> {
  let id = host.proto_id(section, name).unwrap();
  all(host, "Proto").into_iter().filter(|(_, proto)| proto["id"].as_f64() == Some(id as f64)).map(|(entity, _)| entity).collect()
}

fn mcv(host: &Host) -> u32 {
  kind(host, "units", "mcv")[0]
}

fn ticks(host: &mut Host, count: usize) {
  for _ in 0..count {
    host.tick(0.05).unwrap();
  }
}

/// Годится ли под главное здание 3 × 3 с левым верхним тайлом (x, y): скала без подножий обрыва.
fn rocky(host: &Host, x: i32, y: i32) -> bool {
  let mut state = host.state.borrow_mut();
  let land = state.land.as_mut().unwrap();
  (y..y + 3).all(|ty| (x..x + 3).all(|tx| {
    let tile = land.tile(tx, ty);
    tile[0] == ROCK && tile[3] & FOOT_BIT == 0
  }))
}

/// Ближайшее к (x, y) место под главное здание, которому подходит test: кольцами наружу.
fn site_near(host: &Host, x: i32, y: i32, test: impl Fn(i32, i32) -> bool) -> (i32, i32) {
  for ring in 0i32..60 {
    for dy in -ring..=ring {
      for dx in -ring..=ring {
        if dx.abs().max(dy.abs()) == ring && rocky(host, x + dx, y + dy) && test(x + dx, y + dy) {
          return (x + dx, y + dy);
        }
      }
    }
  }
  panic!("нет скалы рядом с {x} {y}");
}

/// Разворачивает MCV на ближайшей скале в стороне от стартового набора; отдаёт главное здание и его место.
fn deployed(host: &mut Host) -> (u32, (i32, i32)) {
  let (x, y) = place(host, mcv(host));
  let units: Vec<(f64, f64)> = all(host, "Mover").into_iter().map(|(entity, _)| place(host, entity)).collect();
  let clear = |sx: i32, sy: i32| units.iter().all(|&(ux, uy)| ux < sx as f64 - 1.0 || ux >= sx as f64 + 4.0 || uy < sy as f64 - 1.0 || uy >= sy as f64 + 4.0);
  let site = site_near(host, x as i32, y as i32, clear);
  host.send(1, "deploy", json!({ "unit": mcv(host), "x": site.0, "y": site.1 }));
  for _ in 0..20 * 40 {
    host.tick(0.05).unwrap();
    if let Some(&core) = kind(host, "buildings", "command").first() {
      return (core, site);
    }
  }
  panic!("MCV не развернулся на {site:?}");
}

#[test]
fn player_starts_with_mcv_buggies_infantry_and_credits() {
  let host = host();
  assert!(all(&host, "Building").is_empty());
  assert_eq!(kind(&host, "units", "mcv").len(), 1);
  assert_eq!(kind(&host, "units", "buggy").len(), 2);
  assert_eq!(kind(&host, "units", "infantry").len(), 3);
  // Пушка будущего главного здания на MCV и стрелки на багги.
  assert_eq!(all(&host, "Turret").len(), 3);
  assert_eq!(credits(&host), 1500.0);
  // Каждый — посреди своего тайла.
  let tiles: std::collections::HashSet<(i64, i64)> = all(&host, "Mover").into_iter().map(|(entity, _)| {
    let (x, y) = place(&host, entity);
    assert_eq!((x.fract().abs(), y.fract().abs()), (0.5, 0.5));
    (x.floor() as i64, y.floor() as i64)
  }).collect();
  assert_eq!(tiles.len(), 6);
  // Свёрнутая база: очередь у MCV есть, но заказать в ней нельзя.
  assert!(all(&host, "Producer").iter().any(|(entity, _)| *entity == mcv(&host)));
  assert!(host.system_names().contains(&"mechanics/movement.move".to_string()), "{:?}", host.system_names());
}

#[test]
fn mcv_drives_to_the_site_and_deploys_into_the_core_that_makes_builders() {
  let mut host = host();
  let truck = mcv(&host);
  let (core, (x, y)) = deployed(&mut host);
  assert!(kind(&host, "units", "mcv").is_empty(), "MCV стал зданием");
  assert!(!all(&host, "Mover").iter().any(|(entity, _)| *entity == truck));
  assert_eq!(place(&host, core), (x as f64 + 1.5, y as f64 + 1.5));
  // Пушка MCV пропала, на крыше — пушка главного здания.
  assert_eq!(all(&host, "Turret").len(), 3);
  assert_eq!(kind(&host, "turrets", "core").len(), 1);
  host.send(1, "produce", json!({ "building": core, "unit": "builder" }));
  host.tick(0.05).unwrap();
  assert_eq!(kind(&host, "units", "builder").len(), 0);
  ticks(&mut host, 5 * 20 + 1);
  assert_eq!(kind(&host, "units", "builder").len(), 1);
}

#[test]
fn deploying_mcv_sends_own_units_off_the_site() {
  let mut host = host();
  // Сначала на место скалы рядом встаёт своя багги, потом туда посылают MCV.
  let buggy = kind(&host, "units", "buggy")[0];
  let (bx, by) = place(&host, buggy);
  let (x, y) = site_near(&host, bx as i32 + 3, by as i32 + 3, |_, _| true);
  // В угол: в середину MCV не поедет — там стоят, и он ищет тайл рядом (orderMove).
  host.send(1, "move", json!({ "units": [buggy], "x": x, "y": y }));
  ticks(&mut host, 400);
  let (ux, uy) = place(&host, buggy);
  assert!((x as f64..x as f64 + 3.0).contains(&ux) && (y as f64..y as f64 + 3.0).contains(&uy), "багги не на месте: {ux} {uy}");
  host.send(1, "deploy", json!({ "unit": mcv(&host), "x": x, "y": y }));
  let mut core = None;
  for _ in 0..20 * 40 {
    host.tick(0.05).unwrap();
    core = kind(&host, "buildings", "command").first().copied();
    if core.is_some() {
      break;
    }
  }
  assert!(core.is_some(), "не развернулся");
  for (entity, _) in all(&host, "Mover") {
    let (ux, uy) = place(&host, entity);
    assert!(!((x as f64..x as f64 + 3.0).contains(&ux) && (y as f64..y as f64 + 3.0).contains(&uy)), "{entity} остался под зданием: {ux} {uy}");
  }
}

#[test]
fn core_packs_back_into_mcv_with_its_queue_and_health() {
  let mut host = host();
  let (core, (x, y)) = deployed(&mut host);
  host.send(1, "produce", json!({ "building": core, "unit": "builder" }));
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  host.tick(0.05).unwrap();
  host.send(1, "pack", json!({ "building": core }));
  // Чужой не свернёт.
  host.send(2, "pack", json!({ "building": core }));
  host.tick(0.05).unwrap();
  assert!(all(&host, "Converting").iter().any(|(entity, _)| *entity == core));
  ticks(&mut host, 10 * 20);
  assert!(kind(&host, "buildings", "command").is_empty());
  let truck = mcv(&host);
  assert_eq!(place(&host, truck), (x as f64 + 1.5, y as f64 + 1.5));
  let queue = all(&host, "Producer").into_iter().find(|(entity, _)| *entity == truck).unwrap().1;
  assert_eq!(queue["unit"], json!("builder"));
  assert_eq!(queue["queue"], json!(["truck"]));
  // Свёрнутая база не производит: строитель так и не выходит.
  ticks(&mut host, 10 * 20);
  assert!(kind(&host, "units", "builder").is_empty());
}

#[test]
fn deploy_can_be_cancelled_and_a_move_forgets_the_trip() {
  let mut host = host();
  let truck = mcv(&host);
  let (x, y) = place(&host, truck);
  let site = site_near(&host, x as i32 + 6, y as i32 + 6, |_, _| true);
  host.send(1, "deploy", json!({ "unit": truck, "x": site.0, "y": site.1 }));
  host.tick(0.05).unwrap();
  assert_eq!(all(&host, "Deploys").len(), 1);
  host.send(1, "move", json!({ "units": [truck], "x": x as i32, "y": y as i32 - 6 }));
  host.tick(0.05).unwrap();
  assert!(all(&host, "Deploys").is_empty(), "поездка забыта");
  host.send(1, "deploy", json!({ "unit": truck, "x": site.0, "y": site.1 }));
  host.tick(0.05).unwrap();
  host.send(1, "cancelDeploy", json!({ "unit": truck }));
  host.tick(0.05).unwrap();
  assert!(all(&host, "Deploys").is_empty() && all(&host, "Converting").is_empty());
  assert!(!all(&host, "Path").iter().any(|(entity, _)| *entity == truck), "стоит");
}

#[test]
fn ordered_units_take_their_own_tiles_near_the_point_and_stop() {
  let mut host = host();
  let units: Vec<u32> = kind(&host, "units", "buggy");
  host.send(1, "move", json!({ "units": units, "x": 10, "y": -6 }));
  host.tick(0.05).unwrap();
  // Каждому — свой тайл: через тайл друг от друга вокруг цели.
  let goals: Vec<(i64, i64)> = all(&host, "Path").into_iter().map(|(_, path)| (path["goalX"].as_f64().unwrap() as i64, path["goalY"].as_f64().unwrap() as i64)).collect();
  assert_eq!(goals.len(), 2);
  let unique: std::collections::HashSet<_> = goals.iter().collect();
  assert_eq!(unique.len(), 2, "{goals:?}");
  ticks(&mut host, 400);
  assert!(all(&host, "Path").is_empty(), "доехали и встали");
  for &entity in &units {
    let (x, y) = place(&host, entity);
    assert!((x - 10.5).abs() <= 3.0 && (y + 5.5).abs() <= 3.0, "{x} {y}");
  }
}

#[test]
fn buggy_drives_around_the_core_not_through_it() {
  let mut host = host();
  let (_, (sx, sy)) = deployed(&mut host);
  let under: Vec<(i32, i32)> = (sy..sy + 3).flat_map(|y| (sx..sx + 3).map(move |x| (x, y))).collect();
  // Ближняя багги — на ту сторону здания.
  let buggy = kind(&host, "units", "buggy")[0];
  let (bx, by) = place(&host, buggy);
  let (gx, gy) = (sx as f64 + 1.0 + (sx as f64 + 1.5 - bx).signum() * 4.0, sy as f64 + 1.0 + (sy as f64 + 1.5 - by).signum() * 4.0);
  host.send(1, "move", json!({ "units": [buggy], "x": gx, "y": gy }));
  for _ in 0..400 {
    host.tick(0.05).unwrap();
    let (x, y) = place(&host, buggy);
    assert!(!under.contains(&(x.floor() as i32, y.floor() as i32)), "въехал в здание: {x} {y}");
  }
}

#[test]
fn snapshot_restores_the_same_game_and_it_goes_on_the_same() {
  let mut host = host();
  let truck = mcv(&host);
  let (x, y) = place(&host, truck);
  let site = site_near(&host, x as i32 + 4, y as i32 - 4, |_, _| true);
  host.send(1, "deploy", json!({ "unit": truck, "x": site.0, "y": site.1 }));
  let buggies = kind(&host, "units", "buggy");
  host.send(1, "move", json!({ "units": buggies, "x": 10, "y": 6 }));
  ticks(&mut host, 30);
  let snapshot = host.snapshot().unwrap();
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut copy = Host::new(mods, None, 7, &serde_json::Value::Null).unwrap();
  copy.restore(&snapshot).unwrap();
  assert_eq!(copy.snapshot().unwrap(), snapshot);
  // Дальше обе партии идут одинаково: MCV доезжает и разворачивается, приказ доезжает.
  for _ in 0..400 {
    host.tick(0.05).unwrap();
    copy.tick(0.05).unwrap();
  }
  assert_eq!(copy.snapshot().unwrap(), host.snapshot().unwrap());
  assert_eq!(kind(&copy, "buildings", "command").len(), 1);
}

/// Витрина: партия меню со сценкой.
fn showcase(scene: &str, seed: u64) -> Host {
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut host = Host::new(mods, Some("menu"), seed, &json!({ "scene": scene, "seed": seed })).unwrap();
  host.start().unwrap();
  host.join(1).unwrap();
  host
}

/// Игроки, у которых остались юниты.
fn sides(host: &Host) -> Vec<f64> {
  let mut players: Vec<f64> = all(host, "Owner").into_iter().filter(|(entity, _)| all(host, "Mover").iter().any(|(unit, _)| unit == entity)).map(|(_, owner)| owner["player"].as_f64().unwrap()).collect();
  players.sort_by(f64::total_cmp);
  players.dedup();
  players
}

#[test]
fn battle_scenes_fight_until_one_side_is_gone() {
  for scene in ["battle", "armor", "infantry", "air"] {
    for seed in [3, 11] {
      let mut host = showcase(scene, seed);
      assert_eq!(sides(&host), [1.0, 9999.0], "{scene} {seed}");
      let start = all(&host, "Mover").len();
      let (mut shots, mut over) = (0, None);
      for tick in 0..20 * 180 {
        host.tick(0.05).unwrap();
        shots = shots.max(all(&host, "Shot").len());
        if host.signals().iter().any(|signal| signal.name == "scene_over") {
          over = Some(tick);
          break;
        }
      }
      let left = all(&host, "Mover").len();
      eprintln!("{scene} {seed}: {start} юнитов, осталось {left}, выстрелов разом до {shots}, конец на тике {over:?}, стороны {:?}", sides(&host));
      assert!(shots > 0, "{scene} {seed}: никто не стрелял");
      assert!(over.is_some(), "{scene} {seed}: бой не кончился за 3 минуты");
    }
  }
}

/// Партия кончилась — её машина Luau освобождается: витрина и новые партии не копят машины в памяти.
#[test]
fn dropped_host_frees_its_lua() {
  let host = showcase("battle", 3);
  let weak = host.lua().weak();
  drop(host);
  assert!(weak.try_upgrade().is_none(), "машина Luau пережила свой хост");
}
