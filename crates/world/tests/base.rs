//! Мод base на хосте: стартовый набор, разворачивание MCV и сворачивание, производство за кредиты, приказ ехать,
//! стройка, разбор и починка.

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
fn queued_orders_come_out_one_by_one_and_cancel_takes_the_last_back() {
  let mut host = host();
  let (core, _) = deployed(&mut host);
  let before = credits(&host);
  for _ in 0..3 {
    host.send(1, "produce", json!({ "building": core, "unit": "builder" }));
  }
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  host.tick(0.05).unwrap();
  let producer = get(&host, core, "Producer").unwrap();
  assert_eq!(producer["unit"], json!("builder"));
  assert_eq!(producer["queue"], json!(["builder", "builder", "truck"]));
  // Последний заказ снимается с возвратом его цены.
  let paid = credits(&host);
  host.send(1, "cancel", json!({ "building": core }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, core, "Producer").unwrap()["queue"], json!(["builder", "builder"]));
  assert!(credits(&host) > paid, "вернули цену грузовика");
  // Строители выходят по очереди: по одному за срок, все три — за три срока.
  let mut seen = Vec::new();
  for _ in 0..(3 * 5 * 20 + 10) {
    host.tick(0.05).unwrap();
    let count = kind(&host, "units", "builder").len();
    if seen.last() != Some(&count) {
      seen.push(count);
    }
  }
  assert_eq!(seen, vec![0, 1, 2, 3], "строители выходят по одному");
  assert_eq!(get(&host, core, "Producer").unwrap()["unit"], json!(""));
  assert!(credits(&host) < before);
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
  // Пушка сворачивающегося здания молчит.
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, core, "Throttle").unwrap()["share"].as_f64(), Some(0.0));
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
  // Мир сценки заводится в первом тике.
  host.tick(0.05).unwrap();
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

/// Значения компонента у сущности; нет — None.
fn get(host: &Host, entity: u32, component: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
  let state = host.state.borrow();
  let id = state.world.schema.id(component).unwrap();
  state.world.get(entity, id)
}

fn set(host: &Host, entity: u32, component: &str, values: serde_json::Value) {
  let mut state = host.state.borrow_mut();
  let id = state.world.schema.id(component).unwrap();
  state.world.set(entity, id, values.as_object().unwrap()).unwrap();
}

/// Скала size × size без подножий с левым верхним тайлом (x, y).
fn rocky_area(host: &Host, x: i32, y: i32, size: i32) -> bool {
  let mut state = host.state.borrow_mut();
  let land = state.land.as_mut().unwrap();
  (y..y + size).all(|ty| (x..x + size).all(|tx| {
    let tile = land.tile(tx, ty);
    tile[0] == ROCK && tile[3] & FOOT_BIT == 0
  }))
}

/// Главное здание и строитель из него.
fn base_with_builder(host: &mut Host) -> (u32, (i32, i32), u32) {
  let (core, site) = deployed(host);
  host.send(1, "produce", json!({ "building": core, "unit": "builder" }));
  ticks(host, 5 * 20 + 2);
  let builder = kind(host, "units", "builder")[0];
  (core, site, builder)
}

/// Место под электростанцию 2 × 2 в зоне главного здания: скала, в стороне от него и от юнитов.
fn generator_spot(host: &Host, (cx, cy): (i32, i32)) -> (i32, i32) {
  let units: Vec<(f64, f64)> = all(host, "Mover").into_iter().map(|(entity, _)| place(host, entity)).collect();
  for ring in 3i32..9 {
    for dy in -ring..=ring {
      for dx in -ring..=ring {
        let (x, y) = (cx + dx, cy + dy);
        if dx.abs().max(dy.abs()) != ring || !rocky_area(host, x, y, 2) {
          continue;
        }
        // Не вплотную к главному зданию и не на юнитах.
        let apart = x + 2 < cx - 1 || x > cx + 4 || y + 2 < cy - 1 || y > cy + 4;
        let empty = units.iter().all(|&(ux, uy)| ux < x as f64 - 1.0 || ux >= x as f64 + 3.0 || uy < y as f64 - 1.0 || uy >= y as f64 + 3.0);
        if apart && empty {
          return (x, y);
        }
      }
    }
  }
  panic!("нет места под электростанцию у {cx} {cy}");
}

fn tick_now(host: &Host) -> u64 {
  host.state.borrow().tick
}

/// Сколько дохода пришло между тиками: главное здание даёт 0,2 в секунду, пока у игрока не меньше 600 кредитов (иначе
/// подмога; в этих сценах их больше), остальное здесь дохода не даёт.
fn income_between(from: u64, to: u64) -> f64 {
  0.2 * 0.05 * (to - from) as f64
}

/// Сколько у игрока денег с дробной частью: кредиты и накопленные доли.
fn worth(host: &Host) -> f64 {
  let player = &all(host, "Player")[0].1;
  player["credits"].as_f64().unwrap() + player["earned"].as_f64().unwrap()
}

#[test]
fn builder_raises_a_generator_paying_as_it_goes() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  let (before, from) = (worth(&host), tick_now(&host));
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let generator = kind(&host, "buildings", "generator")[0];
  // Площадка: тайлов не занимает, пока к ней не приступили, и денег за неё ещё не брали.
  assert!(get(&host, generator, "Site").is_some());
  assert!(get(&host, generator, "Footprint").is_none());
  assert!((worth(&host) - before - income_between(from, tick_now(&host))).abs() < 1e-6);
  assert_eq!(get(&host, builder, "Builds").unwrap()["site"].as_f64(), Some(generator as f64));
  // Строитель доезжает и строит: 300 кредитов — 300 тиков работы одного строителя.
  let mut started = None;
  let mut half = false;
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if started.is_none() && get(&host, generator, "Footprint").is_some() {
      started = Some(tick_now(&host));
    }
    let Some(work) = get(&host, generator, "Site") else { break };
    if !half && work["progress"].as_f64().unwrap() >= 150.0 {
      half = true;
      // Платят по ходу: половина цены за половину стройки.
      let paid = before + income_between(from, tick_now(&host)) - worth(&host);
      assert!((paid - 150.0).abs() <= 2.0, "за половину уплачено {paid}");
      assert!(!all(&host, "Repair").iter().all(|(_, repair)| repair["target"] == json!(-1)), "луч работы");
    }
  }
  let started = started.expect("стройка не началась");
  assert!(get(&host, generator, "Site").is_none(), "не достроено");
  let built = tick_now(&host);
  assert!((built - started) as i64 - 300 <= 2, "строилось {} тиков", built - started);
  // Первая электростанция приносит награду.
  let paid = before + income_between(from, built) + 150.0 - worth(&host);
  assert!((paid - 300.0).abs() <= 1.0, "уплачено {paid}");
  let health = get(&host, generator, "Health").unwrap();
  assert_eq!(health["value"], health["max"]);
  assert!(get(&host, generator, "Footprint").is_some());
  assert_eq!(place(&host, generator), (x as f64 + 1.0, y as f64 + 1.0));
  // Работы больше нет: на следующем тике строитель её забывает.
  host.tick(0.05).unwrap();
  assert!(get(&host, builder, "Builds").is_none(), "работа кончилась — строитель свободен");
  assert_eq!(kind(&host, "turrets", "core").len(), 1, "у электростанции турелей нет");
}

#[test]
fn build_needs_own_zone_unlocked_kind_and_free_place() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  // Переработке нужно исследование — его ещё нет.
  host.send(1, "build", json!({ "building": "smelter", "x": x, "y": y, "builders": [builder] }));
  // Далеко от главного здания — вне зоны.
  let far = site_near(&host, site.0 + 30, site.1, |_, _| true);
  host.send(1, "build", json!({ "building": "generator", "x": far.0, "y": far.1, "builders": [builder] }));
  // Поверх главного здания.
  host.send(1, "build", json!({ "building": "generator", "x": site.0, "y": site.1, "builders": [builder] }));
  // Главное здание строители не возводят.
  host.send(1, "build", json!({ "building": "command", "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert!(all(&host, "Site").is_empty());
  // Годится — закладывается; второй поверх площадки — нет.
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  host.send(1, "build", json!({ "building": "generator", "x": x + 1, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert_eq!(all(&host, "Site").len(), 1);
}

#[test]
fn cancelled_site_returns_what_was_paid_and_demolish_returns_half() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  // Не начатую отменяют сразу и даром.
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [] }));
  host.tick(0.05).unwrap();
  let first = kind(&host, "buildings", "generator")[0];
  host.send(1, "cancelBuild", json!({ "site": first }));
  host.tick(0.05).unwrap();
  assert!(kind(&host, "buildings", "generator").is_empty());
  // Начатую — разбирают с возвратом уплаченного.
  let (before, from) = (worth(&host), tick_now(&host));
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let second = kind(&host, "buildings", "generator")[0];
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if get(&host, second, "Site").unwrap()["progress"].as_f64().unwrap() >= 100.0 {
      break;
    }
  }
  host.send(1, "cancelBuild", json!({ "site": second }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, second, "Site").unwrap()["undo"], json!(true));
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if kind(&host, "buildings", "generator").is_empty() {
      break;
    }
  }
  assert!(kind(&host, "buildings", "generator").is_empty(), "отменённая стройка не разобрана");
  let lost = before + income_between(from, tick_now(&host)) - worth(&host);
  assert!(lost.abs() <= 1.0, "отмена стоила {lost}");
  // Готовое разбирают за половину цены.
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  ticks(&mut host, 2);
  let third = kind(&host, "buildings", "generator")[0];
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if get(&host, third, "Site").is_none() {
      break;
    }
  }
  assert!(get(&host, third, "Site").is_none());
  let (before, from) = (worth(&host), tick_now(&host));
  host.send(1, "demolish", json!({ "building": third, "builders": [builder] }));
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if kind(&host, "buildings", "generator").is_empty() {
      break;
    }
  }
  assert!(kind(&host, "buildings", "generator").is_empty(), "не разобрано");
  let returned = worth(&host) - before - income_between(from, tick_now(&host));
  assert!((returned - 150.0).abs() < 1e-6, "разбор вернул {returned}");
}

#[test]
fn builders_repair_what_is_damaged_for_credits_and_not_under_fire() {
  let mut host = host();
  let (core, _, _) = base_with_builder(&mut host);
  // Строитель стоит у главного здания: разбитое рядом он чинит сам.
  set(&host, core, "Health", json!({ "value": 0.5 }));
  let (before, from) = (worth(&host), tick_now(&host));
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if get(&host, core, "Health").unwrap()["value"].as_f64().unwrap() >= 1.0 {
      break;
    }
  }
  let health = get(&host, core, "Health").unwrap()["value"].as_f64().unwrap();
  assert!(health >= 1.0, "не дочинил: {health}");
  // Половина прочности за половину цены починки: 2000 × 0,5 × 0,5.
  let paid = before + income_between(from, tick_now(&host)) - worth(&host);
  assert!((paid - 500.0).abs() <= 2.0, "починка стоила {paid}");
  // По тому, во что только что попали, не работают.
  set(&host, core, "Health", json!({ "value": 0.5 }));
  let tick = tick_now(&host);
  set(&host, core, "Health", json!({ "hit": tick }));
  ticks(&mut host, 40);
  assert_eq!(get(&host, core, "Health").unwrap()["value"].as_f64().unwrap(), 0.5);
}

#[test]
fn point_order_sends_builders_to_own_site() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [] }));
  host.send(1, "stop", json!({ "units": [builder] }));
  host.tick(0.05).unwrap();
  let generator = kind(&host, "buildings", "generator")[0];
  host.send(1, "order", json!({ "units": [builder], "x": x as f64 + 0.5, "y": y as f64 + 0.5 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, builder, "Builds").unwrap()["site"].as_f64(), Some(generator as f64));
  // Мимо стройки — просто едет.
  host.send(1, "order", json!({ "units": [builder], "x": site.0 as f64 - 6.0, "y": site.1 as f64 + 1.5 }));
  host.tick(0.05).unwrap();
  assert!(get(&host, builder, "Builds").is_none());
}

#[test]
fn second_building_from_the_menu_waits_in_the_busy_builders_queue() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let first = kind(&host, "buildings", "generator")[0];
  let (x2, y2) = free_spot(&host, site, 2);
  host.send(1, "build", json!({ "building": "generator", "x": x2, "y": y2, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let second = *kind(&host, "buildings", "generator").iter().find(|&&entity| entity != first).unwrap();
  // Стройка из меню не отнимает строителя у первой: вторая ждёт в его очереди.
  assert_eq!(get(&host, builder, "Builds").unwrap()["site"].as_f64(), Some(first as f64));
  let orders = get(&host, builder, "Orders").unwrap();
  assert_eq!(orders["list"][0]["name"], json!("assist"));
  assert_eq!(orders["list"][0]["args"]["site"].as_f64(), Some(second as f64));
  // Достроив первую, он берётся за вторую и строит её.
  let mut moved = false;
  for _ in 0..20 * 120 {
    host.tick(0.05).unwrap();
    if get(&host, first, "Site").is_none() && !moved {
      // Следующий приказ раздают в начале тика, а стройку снимают в конце: строитель берётся за неё тиком позже.
      ticks(&mut host, 2);
      assert_eq!(get(&host, builder, "Builds").map(|builds| builds["site"].as_f64()), Some(Some(second as f64)), "взялся за вторую");
      moved = true;
    }
    if moved && get(&host, second, "Site").is_none() {
      break;
    }
  }
  assert!(moved, "первая не достроена");
  assert!(get(&host, second, "Site").is_none(), "вторая не достроена");
  assert_eq!(queued(&host, builder), 0);
  // Приказ идти с Shift встаёт в очередь, без Shift — забывает её.
  host.send(1, "move", json!({ "units": [builder], "x": site.0 - 6, "y": site.1, "queue": true }));
  host.send(1, "move", json!({ "units": [builder], "x": site.0 - 8, "y": site.1, "queue": true }));
  host.tick(0.05).unwrap();
  host.tick(0.05).unwrap();
  assert_eq!(queued(&host, builder), 1, "первый взят, второй ждёт");
  host.send(1, "stop", json!({ "units": [builder] }));
  host.tick(0.05).unwrap();
  assert_eq!(queued(&host, builder), 0);
}

/// Сколько приказов ждёт в очереди юнита. Пустой список Luau приходит и объектом.
fn queued(host: &Host, entity: u32) -> usize {
  get(host, entity, "Orders").map_or(0, |orders| match &orders["list"] {
    serde_json::Value::Array(list) => list.len(),
    serde_json::Value::Object(map) => map.len(),
    _ => 0,
  })
}

/// Свободное место size × size в зоне главного здания: скала, ни зданий, ни юнитов на тайл вокруг.
fn free_spot(host: &Host, (cx, cy): (i32, i32), size: i32) -> (i32, i32) {
  let units: Vec<(f64, f64)> = all(host, "Mover").into_iter().map(|(entity, _)| place(host, entity)).collect();
  for ring in 3i32..10 {
    for dy in -ring..=ring {
      for dx in -ring..=ring {
        let (x, y) = (cx + 1 + dx, cy + 1 + dy);
        if dx.abs().max(dy.abs()) != ring || !rocky_area(host, x, y, size) {
          continue;
        }
        let taken = {
          let mut state = host.state.borrow_mut();
          let mut scene = state.scene();
          (y - 1..y + size + 1).any(|ty| (x - 1..x + size + 1).any(|tx| scene.occupant(tx, ty).is_some()))
        };
        let crowded = units.iter().any(|&(ux, uy)| ux >= x as f64 - 1.0 && ux < (x + size + 1) as f64 && uy >= y as f64 - 1.0 && uy < (y + size + 1) as f64);
        if !taken && !crowded && all(host, "Site").iter().all(|(site, _)| {
          let (sx, sy) = place(host, *site);
          (sx - (x as f64 + size as f64 / 2.0)).abs() > 3.0 || (sy - (y as f64 + size as f64 / 2.0)).abs() > 3.0
        }) {
          return (x, y);
        }
      }
    }
  }
  panic!("нет места {size}×{size} у {cx} {cy}");
}

/// Строит здание строителем и ждёт, пока достроят.
fn raise(host: &mut Host, building: &str, (x, y): (i32, i32), builder: u32) -> u32 {
  // Достроивший прошлое забывает работу на следующем тике: занятых приказ из меню не берёт.
  ticks(host, 2);
  host.send(1, "build", json!({ "building": building, "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let entity = *kind(host, "buildings", building).iter().max().unwrap();
  // Материалы — как уже привезённые: их подвоз проверяют свои тесты.
  if let Some(stock) = get(host, entity, "Inventory") {
    set(host, entity, "Inventory", json!({ "items": stock["limits"] }));
  }
  for _ in 0..20 * 180 {
    host.tick(0.05).unwrap();
    if get(host, entity, "Site").is_none() {
      return entity;
    }
  }
  panic!("{building} не достроен: {:?}, кредиты {}, строитель {:?} у {:?}, площадка у {:?}", get(host, entity, "Site"), credits(host), get(host, builder, "Builds"), place(host, builder), place(host, entity));
}

/// Энергосети игрока: (члены сети) по порядку.
fn grids(host: &Host) -> Vec<Vec<u32>> {
  let mut state = host.state.borrow_mut();
  let kharos_world::host::State { world, networks, .. } = &mut *state;
  networks.grids(world).iter().map(|grid| grid.members.clone()).collect()
}

/// Сколько денег прибавилось за count тиков.
fn earned_over(host: &mut Host, count: usize) -> f64 {
  let before = worth(host);
  ticks(host, count);
  worth(host) - before
}

#[test]
fn power_plant_feeds_matter_income_follows_power_and_accumulator_covers_the_gap() {
  // Без дерева технологий: накопитель открыт и без исследования; остальные правила — как в игре.
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let rules = json!({ "techTree": false, "repairSpeed": 2, "repairCost": 0.5, "repairPause": 3, "vehicleSand": 0.1, "vehicleSwamp": 0.8, "heavySand": 0, "heavySwamp": 0.5, "infantrySand": 0, "infantrySwamp": 0.5, "infantryCliff": 0.7, "frozenSwamp": 0.25, "toxicSwamp": 0.01, "surface": "paving", "surfaceSpeeds": [1.2, 1.5] });
  let mut host = Host::new(mods, None, 7, &json!({ "rules": rules })).unwrap();
  host.start().unwrap();
  host.join(1).unwrap();
  let (core, site, builder) = base_with_builder(&mut host);
  // Первое развёрнутое главное здание и первый юнит — награды.
  assert_eq!(all(&host, "Player")[0].1["rewards"], json!(["deploy", "unit"]));
  // Одно главное здание: 0,2 в секунду.
  assert!((earned_over(&mut host, 100) - 1.0).abs() < 1e-6);

  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  let matter = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "matter", spot, builder)
  };
  // Всё в зоне главного здания — одна энергосеть, главное здание первым.
  let all_grids = grids(&host);
  assert_eq!(all_grids.len(), 1, "сети {all_grids:?}");
  assert_eq!(all_grids[0][0], core);
  assert!(all_grids[0].contains(&generator) && all_grids[0].contains(&matter));
  // Генератор материи на полной энергии: 1,5 и 0,2 главного здания.
  assert!((earned_over(&mut host, 100) - 8.5).abs() < 1e-6);

  // Выключенный не просит энергии и не приносит дохода.
  host.send(1, "work", json!({ "building": matter, "on": false }));
  host.tick(0.05).unwrap();
  assert!(get(&host, matter, "Off").is_some());
  assert!((earned_over(&mut host, 100) - 1.0).abs() < 1e-6);
  host.send(1, "work", json!({ "building": matter, "on": true }));
  host.tick(0.05).unwrap();
  assert!(get(&host, matter, "Off").is_none());

  // Строитель больше не нужен: иначе он чинил бы станцию.
  host.state.borrow_mut().world.destroy(builder);
  // Разбитая станция даёт пятую часть: 2 из 3 нужных — генератор на две трети, станция перегружена и разрушается.
  set(&host, generator, "Health", json!({ "value": 0.2 }));
  host.tick(0.05).unwrap();
  // По тикам: станция изнашивается, и выработка падает вместе с прочностью.
  let (mut income, mut wear) = (0.0, 0.0);
  let before = worth(&host);
  for _ in 0..100 {
    let health = get(&host, generator, "Health").unwrap()["value"].as_f64().unwrap();
    let produced = 10.0 * health;
    income += (0.2 + 1.5 * (produced / 3.0).min(1.0)) * 0.05;
    wear += 0.01 * (3.0 / produced - 1.0).min(1.0) * 0.05;
    host.tick(0.05).unwrap();
    let after = get(&host, generator, "Health").unwrap()["value"].as_f64().unwrap();
    assert!((health - after - 0.01 * (3.0 / produced - 1.0).min(1.0) * 0.05).abs() < 1e-9, "износ за тик {}", health - after);
  }
  let gained = worth(&host) - before;
  assert!((gained - income).abs() < 1e-6, "доход при нехватке {gained}, а не {income}");
  assert!(wear > 0.0);
  set(&host, generator, "Health", json!({ "value": 1 }));

  // Накопитель копит излишек: 10 выработки, 3 спроса — берёт 7 в секунду.
  let rebuilt = kind(&host, "units", "builder");
  let builder = match rebuilt.first() {
    Some(&builder) => builder,
    None => {
      host.send(1, "produce", json!({ "building": core, "unit": "builder" }));
      ticks(&mut host, 5 * 20 + 2);
      kind(&host, "units", "builder")[0]
    }
  };
  let accumulator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "accumulator", spot, builder)
  };
  host.state.borrow_mut().world.destroy(builder);
  ticks(&mut host, 20);
  let cell = get(&host, accumulator, "Accumulator").unwrap();
  assert!((cell["flow"].as_f64().unwrap() + 7.0).abs() < 1e-9, "накопитель {cell:?}, связь {:?}, сети {:?}", get(&host, accumulator, "Link"), grids(&host));
  assert!(cell["charge"].as_f64().unwrap() > 0.0);
  // Станции нет — накопитель отдаёт недостающее, и генератор материи работает в полную силу.
  host.state.borrow_mut().world.destroy(generator);
  host.tick(0.05).unwrap();
  let gained = earned_over(&mut host, 20);
  assert!((gained - 1.7).abs() < 1e-6, "доход на накопителе {gained}");
  let cell = get(&host, accumulator, "Accumulator").unwrap();
  assert!((cell["flow"].as_f64().unwrap() - 3.0).abs() < 1e-9, "накопитель {cell:?}");
}

/// Хост без дерева технологий: шахта и плавильня открыты без исследований.
fn host_without_tech() -> Host {
  let mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let rules = json!({ "techTree": false, "repairSpeed": 2, "repairCost": 0.5, "repairPause": 3, "vehicleSand": 0.1, "vehicleSwamp": 0.8, "heavySand": 0, "heavySwamp": 0.5, "infantrySand": 0, "infantrySwamp": 0.5, "infantryCliff": 0.7, "frozenSwamp": 0.25, "toxicSwamp": 0.01, "surface": "paving", "surfaceSpeeds": [1.2, 1.5] });
  let mut host = Host::new(mods, None, 7, &json!({ "rules": rules })).unwrap();
  host.start().unwrap();
  host.join(1).unwrap();
  host
}

/// Груз на складе сущности.
fn stocked(host: &Host, entity: u32, good: &str) -> f64 {
  get(host, entity, "Inventory").map_or(0.0, |stock| stock["items"][good].as_f64().unwrap_or(0.0))
}

#[test]
fn mine_ore_goes_by_truck_to_the_smelter_and_metal_to_the_yard() {
  let mut host = host_without_tech();
  let (core, site, builder) = base_with_builder(&mut host);
  // Ближайшее к базе металлическое месторождение.
  let metal = host.proto_id("deposits", "metal").unwrap() as f64;
  let deposit = all(&host, "Deposit")
    .into_iter()
    .filter(|(entity, _)| get(&host, *entity, "Proto").unwrap()["id"].as_f64() == Some(metal))
    .min_by(|a, b| {
      let (ax, ay) = place(&host, a.0);
      let (bx, by) = place(&host, b.0);
      let far = |x: f64, y: f64| (x - site.0 as f64).hypot(y - site.1 as f64);
      far(ax, ay).total_cmp(&far(bx, by))
    })
    .unwrap()
    .0;
  let (dx, dy) = place(&host, deposit);
  let reserve = get(&host, deposit, "Deposit").unwrap()["reserve"].as_f64().unwrap();
  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  let smelter = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "smelter", spot, builder)
  };
  let yard = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "metalYard", spot, builder)
  };
  let mine = raise(&mut host, "mine", (dx as i32 - 1, dy as i32 - 1), builder);
  assert!(get(&host, generator, "Footprint").is_some());
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  // Шахта добывает, грузовик возит руду на переработку, переработанное увозит в хранилище.
  let mut delivered = false;
  for _ in 0..20 * 240 {
    host.tick(0.05).unwrap();
    if stocked(&host, yard, "metal") >= 10.0 {
      delivered = true;
      break;
    }
  }
  let truck = kind(&host, "units", "truck")[0];
  assert!(delivered, "металл не доехал: шахта {:?}, плавильня {:?}, грузовик {:?}", get(&host, mine, "Inventory"), get(&host, smelter, "Inventory"), get(&host, truck, "Hauler"));
  assert!(get(&host, deposit, "Deposit").unwrap()["reserve"].as_f64().unwrap() < reserve);
  // Привязанный к шахте возит только её руду.
  host.send(1, "haul", json!({ "mine": mine, "units": [truck] }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, truck, "Hauler").unwrap()["mine"].as_f64(), Some(mine as f64));
}

#[test]
fn builder_fetches_materials_and_plant_assembles_blocks_from_delivered_goods() {
  let mut host = host_without_tech();
  let (core, site, builder) = base_with_builder(&mut host);
  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  assert!(get(&host, generator, "Footprint").is_some());
  // Хранилище с литием, металлом и кремнием: пусть принимает любое — так проще дать ему груз.
  let yard = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "metalYard", spot, builder)
  };
  set(&host, yard, "Inventory", json!({ "accepts": [], "items": { "lithium": 30, "metal": 40, "silicon": 20 } }));
  // Накопитель ждёт 20 лития: строитель сам возит его со склада, по 10 за раз.
  ticks(&mut host, 2);
  let spot = free_spot(&host, site, 2);
  host.send(1, "build", json!({ "building": "accumulator", "x": spot.0, "y": spot.1, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let accumulator = kind(&host, "buildings", "accumulator")[0];
  let mut fetched = false;
  for _ in 0..20 * 120 {
    host.tick(0.05).unwrap();
    fetched |= get(&host, builder, "Fetch").is_some();
    if get(&host, accumulator, "Site").is_none() {
      break;
    }
  }
  assert!(fetched, "строитель не возил материал");
  assert!(get(&host, accumulator, "Site").is_none(), "накопитель не достроен: {:?}", get(&host, accumulator, "Inventory"));
  assert!(stocked(&host, yard, "lithium") <= 10.0 + 1e-6);
  // Склад готового накопителя — свой: материалы ушли в здание.
  assert!(get(&host, accumulator, "Inventory").is_none());

  // Цех стройблоков: включили — грузовик везёт сырьё, цех собирает, блоки уезжают в хранилище.
  let plant = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "blockPlant", spot, builder)
  };
  assert_eq!(get(&host, plant, "Assembly").unwrap()["on"], json!(false));
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  host.send(1, "work", json!({ "building": plant, "on": true }));
  let mut assembled = false;
  for _ in 0..20 * 180 {
    host.tick(0.05).unwrap();
    if stocked(&host, yard, "blocks") >= 1.0 {
      assembled = true;
      break;
    }
  }
  assert!(assembled, "блоки не доехали: цех {:?} {:?}", get(&host, plant, "Inventory"), get(&host, plant, "Assembly"));
  assert!(stocked(&host, yard, "metal") < 40.0);
}

/// Список строк поля игрока: пустой список хранится и как {}.
fn player_list(host: &Host, field: &str) -> Vec<String> {
  all(host, "Player")[0].1[field].as_array().map_or(Vec::new(), |list| list.iter().filter_map(|topic| topic.as_str().map(String::from)).collect())
}

/// Открытые игроку темы.
fn researched(host: &Host) -> Vec<String> {
  player_list(host, "research")
}

#[test]
fn lab_opens_science_and_researches_the_planned_topic_for_credits() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  assert!(get(&host, generator, "Footprint").is_some());
  // Без открытия «Научный метод» тему в план не поставить: её предшественник не случился.
  host.send(1, "research", json!({ "topic": "walls" }));
  host.tick(0.05).unwrap();
  assert!(player_list(&host, "plan").is_empty());
  let lab = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "lab", spot, builder)
  };
  ticks(&mut host, 25);
  assert!(researched(&host).contains(&"science".to_string()), "открытия: {:?}", researched(&host));
  let before = worth(&host);
  let from = tick_now(&host);
  host.send(1, "research", json!({ "topic": "walls" }));
  host.tick(0.05).unwrap();
  assert_eq!(player_list(&host, "plan"), vec!["walls".to_string()]);
  // Тема первого яруса: 100 кредитов и 20 секунд одной лаборатории на полной энергии.
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if researched(&host).contains(&"walls".to_string()) {
      break;
    }
  }
  assert!(researched(&host).contains(&"walls".to_string()), "не исследовано: {:?}, лаборатория {:?}", all(&host, "Player")[0].1, get(&host, lab, "Research"));
  let spent = tick_now(&host) - from;
  assert!((spent as i64 - 400).abs() <= 2, "исследовалось {spent} тиков");
  let paid = before + income_between(from, tick_now(&host)) - worth(&host);
  assert!((paid - 100.0).abs() < 1e-6, "уплачено {paid}");
  assert!(player_list(&host, "plan").is_empty());
}

#[test]
fn pipe_carries_materials_from_the_store_to_a_site_in_batches() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  assert!(get(&host, generator, "Footprint").is_some());
  // Хранилище 3 × 2, за ним тайл трубы и накопитель 2 × 2: место на шесть тайлов в ряд.
  let (x, y) = free_spot(&host, site, 6);
  let yard = raise(&mut host, "metalYard", (x, y), builder);
  set(&host, yard, "Inventory", json!({ "accepts": [], "items": { "lithium": 30 } }));
  ticks(&mut host, 2);
  host.send(1, "pipes", json!({ "tiles": [x + 3, y], "builders": [builder] }));
  host.tick(0.05).unwrap();
  let pipe = kind(&host, "buildings", "pipe")[0];
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if get(&host, pipe, "Site").is_none() {
      break;
    }
  }
  assert!(get(&host, pipe, "Site").is_none(), "труба не достроена");
  ticks(&mut host, 2);
  host.send(1, "build", json!({ "building": "accumulator", "x": x + 4, "y": y, "builders": [] }));
  host.tick(0.05).unwrap();
  let accumulator = kind(&host, "buildings", "accumulator")[0];
  // Площадка — лист сети хранилища: материалы идут к ней пачками по трубе.
  let mut batches = 0;
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    batches = batches.max(all(&host, "Batch").len());
    if stocked(&host, accumulator, "lithium") >= 20.0 - 1e-6 {
      break;
    }
  }
  assert!(batches > 0, "пачек не было");
  assert!(stocked(&host, accumulator, "lithium") >= 20.0 - 1e-6, "на стройке {:?}", get(&host, accumulator, "Inventory"));
  assert!((stocked(&host, yard, "lithium") - 10.0).abs() < 1e-6);
}

#[test]
fn patrol_goes_there_and_back_and_a_move_ends_it() {
  let mut host = host();
  let buggy = kind(&host, "units", "buggy")[0];
  let (sx, sy) = place(&host, buggy);
  let home = (sx.floor(), sy.floor());
  host.send(1, "patrol", json!({ "units": [buggy], "points": [10, -6] }));
  host.tick(0.05).unwrap();
  let tactics = get(&host, buggy, "Tactics").unwrap();
  let patrol: Vec<f64> = tactics["patrol"].as_array().unwrap().iter().map(|value| value.as_f64().unwrap()).collect();
  assert_eq!(patrol, [home.0, home.1, 10.0, -6.0], "от своего места до точки");
  // Доехал до точки — и обратно, к месту, откуда начал.
  let (mut there, mut back) = (false, false);
  for _ in 0..2000 {
    host.tick(0.05).unwrap();
    let (x, y) = place(&host, buggy);
    there |= (x - 10.5).abs() <= 1.5 && (y + 5.5).abs() <= 1.5;
    back |= there && (x - home.0 - 0.5).abs() <= 1.5 && (y - home.1 - 0.5).abs() <= 1.5;
    if back {
      break;
    }
  }
  assert!(there && back, "там {there}, обратно {back}");
  // Приказ идти снимает патруль.
  host.send(1, "move", json!({ "units": [buggy], "x": 4, "y": 4 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, buggy, "Tactics").unwrap()["patrol"], json!([]));
  assert!(get(&host, buggy, "Path").is_some(), "едет");
}

#[test]
fn aggressive_march_remembers_the_goal_and_point_order_on_an_enemy_attacks() {
  let mut host = host();
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  let buggies: Vec<u32> = kind(&host, "units", "buggy");
  let own: Vec<u32> = buggies.iter().copied().filter(|&e| get(&host, e, "Owner").unwrap()["player"].as_f64() == Some(1.0)).collect();
  let enemy = buggies.iter().copied().find(|&e| get(&host, e, "Owner").unwrap()["player"].as_f64() == Some(2.0)).unwrap();
  let buggy = own[0];
  // Агрессивный, посланный идти, идёт походом: помнит, куда шёл; дошёл — помнить нечего.
  host.send(1, "stance", json!({ "units": [buggy], "stance": "aggressive" }));
  host.tick(0.05).unwrap();
  host.send(1, "move", json!({ "units": [buggy], "x": 10, "y": -6 }));
  host.tick(0.05).unwrap();
  let tactics = get(&host, buggy, "Tactics").unwrap();
  let path = get(&host, buggy, "Path").unwrap();
  assert_eq!(tactics["away"], json!(true));
  assert_eq!((tactics["homeX"].clone(), tactics["homeY"].clone()), (path["goalX"].clone(), path["goalY"].clone()));
  for _ in 0..600 {
    host.tick(0.05).unwrap();
    if get(&host, buggy, "Tactics").unwrap()["away"] == json!(false) {
      break;
    }
  }
  assert_eq!(get(&host, buggy, "Tactics").unwrap()["away"], json!(false), "дошёл");
  // Не стреляющий сам по врагу рядом не бьёт; приказ точкой по нему — атака.
  host.send(1, "stance", json!({ "units": [buggy], "stance": "passive" }));
  let (x, y) = place(&host, buggy);
  set(&host, enemy, "Position", json!({ "x": x + 3.0, "y": y }));
  ticks(&mut host, 2);
  // Стреляет багги турелью на корпусе.
  let gun = all(&host, "Attached").into_iter().find(|(_, attached)| attached["parent"].as_f64() == Some(buggy as f64)).map(|(entity, _)| entity).unwrap();
  assert_eq!(get(&host, gun, "Armed").unwrap()["target"], json!(-1.0), "сам не стреляет");
  let (ex, ey) = place(&host, enemy);
  host.send(1, "order", json!({ "units": [buggy], "x": ex, "y": ey }));
  host.tick(0.05).unwrap();
  let armed = get(&host, gun, "Armed").unwrap();
  assert_eq!(armed["target"], json!(enemy as f64));
  assert_eq!(armed["ordered"], json!(true));
  // Стоп — бросает цель.
  host.send(1, "stop", json!({ "units": [buggy] }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, gun, "Armed").unwrap()["target"], json!(-1.0));
}

#[test]
fn gates_rise_before_a_stranger_and_not_under_one_who_stands_in_them() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = free_spot(&host, site, 2);
  let left = raise(&mut host, "gate", (x, y), builder);
  let right = raise(&mut host, "gate", (x + 1, y), builder);
  let open = |host: &Host, gate: u32| get(host, gate, "Footprint").unwrap()["passable"] == json!(true);
  ticks(&mut host, 4);
  assert!(open(&host, left) && open(&host, right), "достроенные опущены");
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  let buggies = kind(&host, "units", "buggy");
  let owner = |host: &Host, e: u32| get(host, e, "Owner").unwrap()["player"].as_f64();
  let enemy = buggies.iter().copied().find(|&e| owner(&host, e) == Some(2.0)).unwrap();
  let own = buggies.iter().copied().find(|&e| owner(&host, e) == Some(1.0)).unwrap();
  host.send(2, "stance", json!({ "units": [enemy], "stance": "passive" }));
  host.send(1, "stance", json!({ "units": [own], "stance": "passive" }));
  // Свой стоит в проёме правой секции, чужой подходит: левая поднимается, правая ждёт, пока свой съедет.
  set(&host, own, "Position", json!({ "x": x as f64 + 1.5, "y": y as f64 + 0.5 }));
  set(&host, enemy, "Position", json!({ "x": x as f64 + 0.5, "y": y as f64 + 4.5 }));
  ticks(&mut host, 5);
  assert!(!open(&host, left), "перед чужим поднялась");
  assert!(open(&host, right), "под своим не поднимается");
  set(&host, own, "Position", json!({ "x": x as f64 + 1.5, "y": y as f64 - 2.5 }));
  ticks(&mut host, 5);
  assert!(!open(&host, right), "свой съехал — поднялась");
  // Чужой ушёл дальше порога открытия — плиты опускаются.
  set(&host, enemy, "Position", json!({ "x": x as f64 + 0.5, "y": y as f64 + 9.5 }));
  ticks(&mut host, 5);
  assert!(open(&host, left) && open(&host, right), "чужих нет — опущены");
}

#[test]
fn radar_flashes_where_it_has_not_looked_and_sees_little_when_switched_off() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let spot = free_spot(&host, site, 2);
  raise(&mut host, "generator", spot, builder);
  let spot = free_spot(&host, site, 2);
  let radar = raise(&mut host, "radar", spot, builder);
  // Первая вспышка — через полный срок; глаз вспышки — сущность без вида, гаснет через 30 тиков.
  let mut flash = None;
  for _ in 0..20 * 12 {
    host.tick(0.05).unwrap();
    if let Some((entity, _)) = all(&host, "Flash").first() {
      flash = Some(*entity);
      break;
    }
  }
  let flash = flash.expect("радар не вспыхнул");
  assert_eq!(get(&host, flash, "Sight").unwrap()["radius"], json!(6.0));
  assert_eq!(get(&host, flash, "Owner").unwrap()["player"], json!(1.0));
  let scan = get(&host, radar, "Scan").unwrap();
  let (rx, ry) = place(&host, radar);
  let (fx, fy) = place(&host, flash);
  assert_eq!((scan["x"].as_f64().unwrap(), scan["y"].as_f64().unwrap()), (fx, fy));
  assert!(((fx - rx).powi(2) + (fy - ry).powi(2)).sqrt() <= 60.0 + 0.1, "в радиусе радара");
  assert_eq!(get(&host, radar, "Sight").unwrap()["radius"], json!(14.0));
  ticks(&mut host, 31);
  assert!(get(&host, flash, "Flash").is_none(), "вспышка погасла");
  // Выключенный видит как обычное здание и не вспыхивает.
  host.send(1, "work", json!({ "building": radar, "on": false }));
  ticks(&mut host, 20 * 15);
  assert_eq!(get(&host, radar, "Sight").unwrap()["radius"], json!(5.0));
  assert!(all(&host, "Flash").is_empty());
}

/// Новая сущность с компонентами движка или мода.
fn spawn_with(host: &Host, parts: serde_json::Value) -> u32 {
  let mut state = host.state.borrow_mut();
  let entity = state.world.spawn();
  for (component, values) in parts.as_object().unwrap() {
    let id = state.world.schema.id(component).unwrap();
    state.world.add(entity, id, values.as_object().unwrap()).unwrap();
  }
  entity
}

#[test]
fn reactor_burns_rods_and_blows_up_when_destroyed_with_fuel() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 10000 }));
  let spot = free_spot(&host, site, 3);
  let reactor = raise(&mut host, "reactor", spot, builder);
  assert!(get(&host, reactor, "Meltdown").is_none(), "пустой не взорвётся");
  set(&host, reactor, "Inventory", json!({ "items": { "rods": 2 } }));
  ticks(&mut host, 2);
  // Взял стержень: горит минуту; с топливом — взорвётся.
  let left = get(&host, reactor, "Reactor").unwrap()["left"].as_f64().unwrap();
  assert!(left > 1150.0 && left <= 1200.0, "горит {left}");
  assert!((stocked(&host, reactor, "rods") - 1.0).abs() < 1e-9);
  assert_eq!(get(&host, reactor, "Meltdown").unwrap()["radius"], json!(4.0));
  // Выключенный стержень бережёт.
  host.send(1, "work", json!({ "building": reactor, "on": false }));
  ticks(&mut host, 2);
  let paused = get(&host, reactor, "Reactor").unwrap()["left"].clone();
  ticks(&mut host, 10);
  assert_eq!(get(&host, reactor, "Reactor").unwrap()["left"], paused);
  // Разбитый с топливом оставляет взрыв: он бьёт всех вокруг в следующем бою и пропадает.
  let (x, y) = place(&host, reactor);
  spawn_with(&host, json!({ "Position": { "x": x, "y": y }, "Burst": { "radius": 2, "damage": 1e9 } }));
  host.tick(0.05).unwrap();
  assert!(get(&host, reactor, "Reactor").is_none(), "реактор разбит");
  let bursts = all(&host, "Burst");
  assert_eq!(bursts.len(), 1, "авария");
  assert_eq!(bursts[0].1["radius"], json!(4.0));
  assert_eq!(place(&host, bursts[0].0), (x, y));
  host.tick(0.05).unwrap();
  assert!(all(&host, "Burst").is_empty(), "взрыв прошёл");
}

#[test]
fn shield_charges_on_power_and_stops_a_shell_at_its_edge() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 10000 }));
  let spot = free_spot(&host, site, 2);
  raise(&mut host, "generator", spot, builder);
  let spot = free_spot(&host, site, 2);
  let dome = raise(&mut host, "shieldGenerator", spot, builder);
  // Запас растёт на энергии: 100 в секунду.
  ticks(&mut host, 20);
  let charge = get(&host, dome, "Shield").unwrap()["charge"].as_f64().unwrap();
  assert!(charge > 50.0 && charge <= 110.0 + 1e-9, "запас {charge}");
  // Чужое ядро, летящее к генератору снаружи, рвётся на краю купола; урон берёт запас.
  let (x, y) = place(&host, dome);
  let health = get(&host, dome, "Health").unwrap()["value"].clone();
  let before = get(&host, dome, "Shield").unwrap()["charge"].as_f64().unwrap();
  let shell = spawn_with(&host, json!({
    "Position": { "x": x + 10.0, "y": y },
    "Shot": { "weapon": "artillery", "player": 2, "source": -1, "target": dome, "fromX": x + 10.0, "fromY": y, "toX": x, "toY": y, "life": 100 },
  }));
  let mut stopped = None;
  for _ in 0..40 {
    let at = place(&host, shell);
    host.tick(0.05).unwrap();
    if get(&host, shell, "Shot").is_none() {
      stopped = Some(at);
      break;
    }
  }
  assert!(stopped.is_some(), "ядро не остановилось");
  let shield = get(&host, dome, "Shield").unwrap();
  assert!(shield["charge"].as_f64().unwrap() < before, "запас не тронут: {shield:?}");
  assert!(shield["hit"].as_f64().unwrap() >= 0.0);
  assert_eq!(get(&host, dome, "Health").unwrap()["value"], health, "генератор цел");
  // Выключенный купол гаснет.
  host.send(1, "work", json!({ "building": dome, "on": false }));
  ticks(&mut host, 2);
  assert_eq!(get(&host, dome, "Shield").unwrap()["charge"], json!(0.0));
}

/// Турель на носителе.
fn gun_of(host: &Host, carrier: u32) -> u32 {
  all(host, "Attached").into_iter().find(|(_, attached)| attached["parent"].as_f64() == Some(carrier as f64)).map(|(entity, _)| entity).unwrap()
}

fn ammo(host: &Host, entity: u32) -> f64 {
  get(host, entity, "Magazine").unwrap()["ammo"].as_f64().unwrap()
}

#[test]
fn magazines_empty_in_fire_refill_in_the_network_and_empty_units_go_for_ammo() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  let buggies = kind(&host, "units", "buggy");
  let owner = |host: &Host, e: u32| get(host, e, "Owner").unwrap()["player"].as_f64();
  let own: Vec<u32> = buggies.iter().copied().filter(|&e| owner(&host, e) == Some(1.0)).collect();
  let enemy = buggies.iter().copied().find(|&e| owner(&host, e) == Some(2.0)).unwrap();
  let buggy = own[0];
  // Полный магазин с завода; выстрел пулемёта стоит его доли.
  assert_eq!(ammo(&host, buggy), 30.0);
  let cost = get(&host, gun_of(&host, buggy), "Armed").unwrap()["cost"].as_f64().unwrap();
  assert!(cost > 0.0, "выстрел бесплатный");
  // Стреляет — тратит.
  host.send(2, "stance", json!({ "units": [enemy], "stance": "passive" }));
  let (x, y) = place(&host, buggy);
  set(&host, enemy, "Position", json!({ "x": x + 3.0, "y": y }));
  ticks(&mut host, 40);
  let left = ammo(&host, buggy);
  assert!(left < 30.0, "не стрелял");
  // Пустой молчит: цель бросает.
  set(&host, buggy, "Magazine", json!({ "ammo": 0 }));
  ticks(&mut host, 2);
  assert_eq!(get(&host, gun_of(&host, buggy), "Armed").unwrap()["target"], json!(-1.0), "пустой стреляет");
  set(&host, enemy, "Position", json!({ "x": x + 60.0, "y": y + 60.0 }));
  // В своей сети магазин пополняется из хранилищ: 10 в секунду.
  let spot = free_spot(&host, site, 2);
  let bunker = raise(&mut host, "ammoBunker", spot, builder);
  set(&host, bunker, "Inventory", json!({ "items": { "ammo": 100 } }));
  let (cx, cy) = place(&host, bunker);
  set(&host, buggy, "Position", json!({ "x": cx + 2.5, "y": cy }));
  set(&host, buggy, "Magazine", json!({ "ammo": 0 }));
  ticks(&mut host, 21);
  let refilled = ammo(&host, buggy);
  assert!(refilled >= 9.9 && refilled <= 10.1 + 1e-9, "пополнено {refilled}");
  assert!((stocked(&host, bunker, "ammo") - (100.0 - refilled)).abs() < 1e-6, "взято из хранилища");
  // Пустой вне сети сам идёт за боеприпасами и запоминает, куда вернуться.
  let far = own[1];
  let (fx, fy) = place(&host, far);
  set(&host, far, "Magazine", json!({ "ammo": 0 }));
  let mut going = false;
  for _ in 0..100 {
    host.tick(0.05).unwrap();
    if get(&host, far, "Tactics").is_some_and(|tactics| tactics["resupply"] == json!(true)) {
      going = true;
      break;
    }
  }
  assert!(going, "не пошёл за боеприпасами");
  let tactics = get(&host, far, "Tactics").unwrap();
  assert_eq!((tactics["homeX"].as_f64().unwrap(), tactics["homeY"].as_f64().unwrap()), (fx.floor(), fy.floor()));
  assert!(get(&host, far, "Path").is_some());
}

#[test]
fn building_turret_fires_only_with_ammo_in_its_store() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  let spot = free_spot(&host, site, 1);
  let turret = raise(&mut host, "turret", spot, builder);
  let gun = gun_of(&host, turret);
  assert!(get(&host, gun, "Armed").unwrap()["cost"].as_f64().unwrap() > 0.0);
  let enemy = kind(&host, "units", "buggy").into_iter().find(|&e| get(&host, e, "Owner").unwrap()["player"].as_f64() == Some(2.0)).unwrap();
  host.send(2, "stance", json!({ "units": [enemy], "stance": "passive" }));
  let (x, y) = place(&host, turret);
  set(&host, enemy, "Position", json!({ "x": x + 3.0, "y": y }));
  // Выстрелы этой турели за count тиков (бьёт и пушка главного здания — её не считаем).
  let shots = |host: &mut Host, count: usize| {
    let mut fired = 0;
    for _ in 0..count {
      host.tick(0.05).unwrap();
      fired += all(host, "Shot").iter().filter(|(_, shot)| shot["source"].as_f64() == Some(turret as f64) && shot["age"].as_f64() == Some(0.0)).count();
    }
    fired
  };
  assert_eq!(shots(&mut host, 40), 0, "пустая турель стреляет");
  set(&host, turret, "Inventory", json!({ "items": { "ammo": 20 } }));
  assert!(shots(&mut host, 40) > 0, "с боеприпасами не стреляет");
  assert!(stocked(&host, turret, "ammo") < 20.0, "не потратила");
}

#[test]
fn spaceport_sells_from_stores_and_buys_from_orbit() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 5000 }));
  let spot = free_spot(&host, site, 2);
  raise(&mut host, "generator", spot, builder);
  // Хранилище 3 × 2, тайл трубы и космопорт 3 × 3 в ряд: одна сеть, товар идёт по трубе.
  let (x, y) = free_spot(&host, site, 7);
  let yard = raise(&mut host, "metalYard", (x, y), builder);
  set(&host, yard, "Inventory", json!({ "accepts": [], "items": { "metal": 50 } }));
  ticks(&mut host, 2);
  host.send(1, "pipes", json!({ "tiles": [x + 3, y], "builders": [builder] }));
  host.tick(0.05).unwrap();
  let pipe = kind(&host, "buildings", "pipe")[0];
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if get(&host, pipe, "Site").is_none() {
      break;
    }
  }
  let port = raise(&mut host, "spaceport", (x + 4, y), builder);
  // Продажа: товар свозят в трюм, корабль улетает и через 20 с приносит выручку — и награду за первую продажу.
  ticks(&mut host, 2);
  host.send(1, "sell", json!({ "port": port, "resource": "metal", "amount": 30 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, port, "Trade").unwrap()["wanted"], json!(30.0));
  let mut launched = false;
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if get(&host, port, "Trade").is_some_and(|order| order["total"].as_f64().unwrap() > 0.0) {
      launched = true;
      break;
    }
  }
  assert!(launched, "корабль не улетел: {:?}, в трюме {}", get(&host, port, "Trade"), stocked(&host, port, "metal"));
  assert!((stocked(&host, yard, "metal") - 20.0).abs() < 1e-6, "взято со склада");
  let before = credits(&host);
  ticks(&mut host, 20 * 20 + 2);
  assert!(get(&host, port, "Trade").is_none(), "рейс не кончился");
  // Выручка 30 × 10 и награда 100; сверху — доход главного здания за рейс, 0,2 в секунду.
  assert_eq!(credits(&host) - before, 300.0 + 100.0 + 4.0, "выручка и награда");
  assert!(stocked(&host, port, "metal") < 1e-6, "товар улетел");
  // Закупка: втридорога сразу, груз — через 20 с в склад космопорта.
  let before = credits(&host);
  host.send(1, "buy", json!({ "port": port, "resource": "silicon", "amount": 10 }));
  host.tick(0.05).unwrap();
  assert_eq!(before - credits(&host), 10.0 * 10.0 * 3.0);
  // Пока корабль в пути, новой сделки не начать.
  host.send(1, "sell", json!({ "port": port, "resource": "metal", "amount": 5 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, port, "Trade").unwrap()["buy"], json!(true));
  ticks(&mut host, 20 * 20 + 2);
  assert!(get(&host, port, "Trade").is_none());
  // Привезённое грузовики и трубы развезут по хранилищам — оно уже не в заявке.
  let moving: f64 = all(&host, "Batch").iter().filter(|(_, batch)| batch["resource"] == json!("silicon")).map(|(_, batch)| batch["amount"].as_f64().unwrap()).sum();
  let landed = stocked(&host, port, "silicon") + stocked(&host, yard, "silicon") + moving;
  assert!((landed - 10.0).abs() < 1e-6, "привезено {landed}");
}

#[test]
fn silo_launches_a_missile_that_strikes_and_an_interceptor_downs_the_next() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 20000 }));
  let spot = free_spot(&host, site, 2);
  raise(&mut host, "generator", spot, builder);
  let spot = free_spot(&host, site, 3);
  let silo = raise(&mut host, "silo", spot, builder);
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  let enemy = kind(&host, "units", "buggy").into_iter().find(|&e| get(&host, e, "Owner").unwrap()["player"].as_f64() == Some(2.0)).unwrap();
  let (sx, sy) = place(&host, silo);
  // Цель — в 20 тайлах: ракета летит 8 тайлов в секунду.
  let (tx, ty) = ((sx + 20.0).floor(), sy.floor());
  set(&host, enemy, "Position", json!({ "x": tx + 0.5, "y": ty + 0.5 }));
  host.send(2, "stance", json!({ "units": [enemy], "stance": "passive" }));
  // Боеголовка готова — пуск: через 30 с ракета стартует, шахта пустеет.
  set(&host, silo, "Silo", json!({ "ready": true }));
  ticks(&mut host, 2);
  assert!(get(&host, silo, "Meltdown").is_some(), "с боеголовкой взорвётся");
  host.send(1, "launch", json!({ "silo": silo, "x": tx, "y": ty }));
  host.tick(0.05).unwrap();
  assert!(get(&host, silo, "Silo").unwrap()["start"].as_f64().unwrap() >= 0.0);
  ticks(&mut host, 20 * 30);
  let missiles = all(&host, "Missile");
  assert_eq!(missiles.len(), 1, "ракета не стартовала");
  assert_eq!(get(&host, silo, "Silo").unwrap()["ready"], json!(false));
  let marks: Vec<String> = all(&host, "Mark").iter().map(|(_, mark)| mark["kind"].as_str().unwrap().to_owned()).collect();
  assert!(marks.contains(&"strike".to_owned()) && marks.contains(&"launch".to_owned()), "метки {marks:?}");
  // Точку удара видит тот, чьё под ней.
  let strike = all(&host, "Mark").into_iter().find(|(_, mark)| mark["kind"] == json!("strike")).unwrap().1;
  assert_eq!(strike["viewers"], json!([2]));
  // Долетела — взрыв: багги под ним погибает, вспышка открывает круг всем.
  ticks(&mut host, 20 * 4);
  assert!(all(&host, "Missile").is_empty(), "не долетела");
  assert!(get(&host, enemy, "Unit").is_none(), "цель цела");
  assert!(all(&host, "Mark").iter().all(|(_, mark)| mark["kind"] != json!("strike")), "метка удара осталась");
  // Вторая ракета — на перехватчик чужого игрока с готовой ракетой: её сбивают, не долетает.
  let spot = free_spot(&host, site, 2);
  let guard = raise(&mut host, "interceptor", spot, builder);
  set(&host, guard, "Owner", json!({ "player": 2 }));
  set(&host, guard, "Interceptor", json!({ "missiles": 1 }));
  set(&host, silo, "Silo", json!({ "ready": true }));
  let (gx, gy) = place(&host, guard);
  host.send(1, "launch", json!({ "silo": silo, "x": gx.floor(), "y": gy.floor() }));
  let mut chased = false;
  for _ in 0..20 * 40 {
    host.tick(0.05).unwrap();
    chased |= !all(&host, "Chaser").is_empty();
    if chased && all(&host, "Missile").is_empty() {
      break;
    }
  }
  assert!(chased, "перехватчик не выстрелил");
  assert!(all(&host, "Missile").is_empty(), "ракету не сбили");
  assert_eq!(get(&host, guard, "Interceptor").unwrap()["missiles"], json!(0.0));
  assert!(get(&host, guard, "Building").is_some(), "перехватчик разбит");
}

/// Свои юниты и здания игрока.
fn owned(host: &Host, player: f64) -> Vec<u32> {
  let has = |e: u32, component: &str| get(host, e, component).is_some();
  all(host, "Owner").into_iter().filter(|(e, owner)| owner["player"].as_f64() == Some(player) && (has(*e, "Unit") || has(*e, "Building"))).map(|(e, _)| e).collect()
}

#[test]
fn surrender_blows_up_the_base_in_a_wave_from_the_core_and_scuttle_kills_one_unit() {
  let mut host = host();
  let (core, _) = deployed(&mut host);
  host.join(2).unwrap();
  host.tick(0.05).unwrap();
  // Уничтожить своего: в ближайшем бою гибнет, чужого не тронуть.
  let buggies = kind(&host, "units", "buggy");
  let owner = |host: &Host, e: u32| get(host, e, "Owner").unwrap()["player"].as_f64();
  let own = buggies.iter().copied().find(|&e| owner(&host, e) == Some(1.0)).unwrap();
  let enemy = buggies.iter().copied().find(|&e| owner(&host, e) == Some(2.0)).unwrap();
  host.send(1, "scuttle", json!({ "units": [own, enemy] }));
  ticks(&mut host, 2);
  assert!(get(&host, own, "Unit").is_none(), "своя багги цела");
  assert!(get(&host, enemy, "Unit").is_some(), "чужую уничтожили");
  // Сдача: кредиты в ноль, главное здание рвётся первым, дальние — позже.
  let before = owned(&host, 1.0).len();
  assert!(before > 1);
  host.send(1, "surrender", json!({}));
  host.tick(0.05).unwrap();
  assert_eq!(credits(&host), 0.0);
  let left = |host: &Host, e: u32| get(host, e, "Doomed").unwrap()["left"].as_f64().unwrap();
  let first = left(&host, core);
  assert!(owned(&host, 1.0).iter().all(|&e| left(&host, e) >= first - 10.0), "волна не от главного здания");
  ticks(&mut host, 200);
  assert!(owned(&host, 1.0).is_empty(), "база цела: {:?}", owned(&host, 1.0));
  assert!(!owned(&host, 2.0).is_empty(), "задело чужого");
}

/// Дропы: место (тайл) и груз.
fn drops(host: &Host) -> Vec<((i32, i32), serde_json::Map<String, serde_json::Value>)> {
  all(host, "Drop").into_iter().map(|(entity, _)| {
    let (x, y) = place(host, entity);
    ((x.floor() as i32, y.floor() as i32), get(host, entity, "Inventory").unwrap()["items"].as_object().cloned().unwrap_or_default())
  }).collect()
}

#[test]
fn cancelled_site_leaves_materials_on_the_ground_and_a_new_site_crushes_them() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  host.send(1, "build", json!({ "building": "accumulator", "x": x, "y": y, "builders": [] }));
  host.tick(0.05).unwrap();
  let accumulator = kind(&host, "buildings", "accumulator")[0];
  set(&host, accumulator, "Inventory", json!({ "items": { "lithium": 20 } }));
  host.send(1, "cancelBuild", json!({ "site": accumulator }));
  host.tick(0.05).unwrap();
  assert!(kind(&host, "buildings", "accumulator").is_empty());
  // Привезённое лежит на тайле в середине основания.
  let lying = drops(&host);
  assert_eq!(lying.len(), 1, "{lying:?}");
  assert_eq!(lying[0].0, (x + 1, y + 1));
  assert_eq!(lying[0].1["lithium"].as_f64(), Some(20.0));
  // Начатая поверх стройка давит его.
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if all(&host, "Drop").is_empty() {
      break;
    }
  }
  assert!(all(&host, "Drop").is_empty(), "груз под стройкой цел");
  let generator = kind(&host, "buildings", "generator")[0];
  assert!(get(&host, generator, "Footprint").is_some());
}

#[test]
fn killed_truck_drops_its_cargo_and_another_truck_takes_it_to_the_yard() {
  let mut host = host_without_tech();
  let (core, site, builder) = base_with_builder(&mut host);
  let yard = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "metalYard", spot, builder)
  };
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  for _ in 0..20 * 120 {
    host.tick(0.05).unwrap();
    if kind(&host, "units", "truck").len() == 2 {
      break;
    }
  }
  let trucks = kind(&host, "units", "truck");
  assert_eq!(trucks.len(), 2);
  let (lost, other) = (trucks[0], trucks[1]);
  // Погибший грузовик оставляет кузов на земле.
  set(&host, lost, "Inventory", json!({ "items": { "metal": 20 } }));
  host.send(1, "scuttle", json!({ "units": [lost] }));
  ticks(&mut host, 2);
  assert!(kind(&host, "units", "truck").len() == 1, "грузовик цел");
  let lying = drops(&host);
  assert_eq!(lying.len(), 1, "{lying:?}");
  assert!((lying[0].1["metal"].as_f64().unwrap() - 20.0).abs() < 1e-9, "{lying:?}");
  // Приказ точкой по дропу — вывезти его.
  let (dx, dy) = lying[0].0;
  host.send(1, "order", json!({ "units": [other], "x": dx as f64 + 0.5, "y": dy as f64 + 0.5 }));
  host.tick(0.05).unwrap();
  let drop = all(&host, "Drop")[0].0;
  assert_eq!(get(&host, other, "Hauler").unwrap()["pickup"].as_f64(), Some(drop as f64));
  for _ in 0..20 * 120 {
    host.tick(0.05).unwrap();
    if all(&host, "Drop").is_empty() && stocked(&host, yard, "metal") >= 20.0 - 1e-6 {
      break;
    }
  }
  assert!(all(&host, "Drop").is_empty(), "дроп лежит: {:?}, грузовик {:?}", drops(&host), get(&host, other, "Hauler"));
  assert!(stocked(&host, yard, "metal") >= 20.0 - 1e-6, "в хранилище {}", stocked(&host, yard, "metal"));
  // Вывез — свободен.
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, other, "Hauler").unwrap()["pickup"].as_f64(), Some(-1.0));
}

#[test]
fn builders_raise_building_levels_for_credits_and_blocks_from_the_grid() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 5000 }));
  let spot = free_spot(&host, site, 2);
  let generator = raise(&mut host, "generator", spot, builder);
  // Склад стройблоков — в той же энергосети, но не на трубе генератора: уровни берут готовое со всей энергосети.
  let spot = free_spot(&host, site, 3);
  let yard = raise(&mut host, "blockYard", spot, builder);
  set(&host, yard, "Inventory", json!({ "items": { "blocks": 50 } }));
  let level = |host: &Host, entity: u32| get(host, entity, "Building").unwrap()["level"].as_f64().unwrap();
  let finish = |host: &mut Host, entity: u32| {
    for _ in 0..20 * 60 {
      host.tick(0.05).unwrap();
      if get(host, entity, "Upgrade").is_none() {
        return;
      }
    }
    panic!("улучшение не закончено: {:?}", get(host, entity, "Upgrade"));
  };
  // Генератор за 300: подъём стоит 150 кредитов и 10 стройблоков сразу, работу делает свободный строитель рядом.
  ticks(&mut host, 2);
  let before = credits(&host);
  host.send(1, "upgrade", json!({ "building": generator, "builders": [] }));
  host.tick(0.05).unwrap();
  assert!(get(&host, generator, "Upgrade").is_some(), "заказ не принят");
  assert!((before - credits(&host) - 150.0).abs() <= 1.0, "списано {}", before - credits(&host));
  assert!((stocked(&host, yard, "blocks") - 40.0).abs() < 1e-6, "стройблоки со склада энергосети");
  finish(&mut host, generator);
  assert_eq!(level(&host, generator), 2.0);
  // Третий уровень просит ещё и компоненты: их нет — заказ не принят.
  ticks(&mut host, 2);
  host.send(1, "upgrade", json!({ "building": generator, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert!(get(&host, generator, "Upgrade").is_none(), "без компонентов не поднять");
  // Отмена возвращает цену целиком: кредиты и стройблоки.
  let before = credits(&host);
  host.send(1, "upgrade", json!({ "building": yard, "builders": [] }));
  host.tick(0.05).unwrap();
  assert!((stocked(&host, yard, "blocks") - 35.0).abs() < 1e-6);
  host.send(1, "cancelUpgrade", json!({ "building": yard }));
  host.tick(0.05).unwrap();
  assert!(get(&host, yard, "Upgrade").is_none());
  assert!((credits(&host) - before).abs() <= 1.0, "кредиты вернулись");
  assert!((stocked(&host, yard, "blocks") - 40.0).abs() < 1e-6, "стройблоки вернулись");
  // Склад второго уровня вмещает в полтора раза больше.
  host.send(1, "upgrade", json!({ "building": yard, "builders": [builder] }));
  host.tick(0.05).unwrap();
  finish(&mut host, yard);
  assert_eq!(level(&host, yard), 2.0);
  assert_eq!(get(&host, yard, "Inventory").unwrap()["capacity"], json!(300.0));
}

/// Канал тайла слоя карты.
fn layer(host: &Host, name: &str, x: i32, y: i32, channel: usize) -> f64 {
  let state = host.state.borrow();
  let id = state.layers.id(name).unwrap();
  state.layers.get(id, kharos_engine::layers::Owner::World, x, y, channel)
}

/// Тикает, пока работы над покрытием не кончатся.
fn paved_out(host: &mut Host) {
  for _ in 0..20 * 120 {
    host.tick(0.05).unwrap();
    if all(host, "Pave").is_empty() {
      return;
    }
  }
  panic!("покрытие не доделано: {:?}", all(host, "Pave"));
}

#[test]
fn builders_lay_road_and_foundation_that_speed_units_and_take_them_up_again() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 5000 }));
  let (x, y) = free_spot(&host, site, 5);
  // Дорога линией в пять тайлов: платят сразу по 5 за тайл, повтор тайла в протяжке не кладут дважды.
  ticks(&mut host, 2);
  let before = credits(&host);
  let road: Vec<i32> = (0..5).flat_map(|i| [x + i, y]).chain([x, y]).collect();
  host.send(1, "pave", json!({ "kind": "road", "tiles": road, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert_eq!(all(&host, "Pave").len(), 5, "{:?} {:?}", all(&host, "Pave"), (x, y));
  assert!((before - credits(&host) - 25.0).abs() < 1e-9, "списано {}", before - credits(&host));
  paved_out(&mut host);
  assert!((0..5).all(|i| layer(&host, "paving", x + i, y, 0) == 2.0 && layer(&host, "paving", x + i, y, 1) == 1.0), "дорога в слое");
  // По дороге колёсные быстрее в полтора раза, а широкому полосы в тайл мало; гусеничным всё равно.
  {
    let mut state = host.state.borrow_mut();
    let mut scene = state.scene();
    assert_eq!(scene.terrain_speed("vehicle", 0.4, x + 2, y), 1.5);
    assert_eq!(scene.terrain_speed("vehicle", 0.7, x + 2, y), 1.0);
    assert_eq!(scene.terrain_speed("heavy", 0.4, x + 2, y), 1.0);
  }
  // На дороге не строят.
  let sites = all(&host, "Site").len();
  host.send(1, "build", json!({ "building": "wall", "x": x + 1, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert_eq!(all(&host, "Site").len(), sites, "стена на дороге");
  // Фундамент прямоугольником 2 × 2: вместо своей дороги тоже кладут, прежняя действует, пока новое не готово.
  let slab = vec![x, y, x + 1, y, x, y + 1, x + 1, y + 1];
  host.send(1, "pave", json!({ "kind": "foundation", "tiles": slab, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert_eq!(all(&host, "Pave").len(), 4);
  assert_eq!(layer(&host, "paving", x, y, 0), 2.0, "дорога, пока кладут фундамент");
  paved_out(&mut host);
  assert!([(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)].iter().all(|&(tx, ty)| layer(&host, "paving", tx, ty, 0) == 1.0));
  assert_eq!(layer(&host, "paving", x + 2, y, 0), 2.0);
  // Сохранение уносит слой.
  let snapshot = host.snapshot().unwrap();
  let mut copy = host_without_tech();
  copy.restore(&snapshot).unwrap();
  assert_eq!(layer(&copy, "paving", x + 3, y, 0), 2.0);
  assert_eq!(layer(&copy, "paving", x + 1, y + 1, 0), 1.0);
  // Наземный взрыв разбивает плиты в своём радиусе, дорогу — нет.
  host.emit("blast", json!({ "x": x as f64 + 0.5, "y": y as f64 + 0.5, "size": 1.0 })).unwrap();
  assert_eq!(layer(&host, "paving", x, y, 0), 0.0, "плита разбита");
  assert_eq!(layer(&host, "paving", x + 1, y + 1, 0), 1.0, "дальняя цела");
  // «Снять» рамкой: строители разбирают готовое покрытие без возврата; недостроенное отменяется с возвратом.
  host.send(1, "pave", json!({ "kind": "road", "tiles": [x, y + 3], "builders": [] }));
  host.tick(0.05).unwrap();
  let before = credits(&host);
  let frame: Vec<i32> = (0..4).flat_map(|ty| (0..5).flat_map(move |tx| [x + tx, y + ty])).collect();
  host.send(1, "remove", json!({ "tiles": frame, "builders": [builder] }));
  host.tick(0.05).unwrap();
  assert!((credits(&host) - before - 5.0).abs() < 1e-9, "недостроенная дорога вернула цену");
  assert!(all(&host, "Pave").iter().all(|(_, pave)| pave["remove"] == json!(true)));
  assert_eq!(layer(&host, "paving", x + 4, y, 0), 2.0, "покрытие действует, пока его разбирают");
  paved_out(&mut host);
  assert!((0..5).all(|i| layer(&host, "paving", x + i, y, 0) == 0.0 && layer(&host, "paving", x + i, y + 1, 0) == 0.0), "разобрано");
  assert!((credits(&host) - before - 5.0).abs() < 1e-9, "за готовое покрытие не возвращают");
}

/// Ставит все глаза игрока в (x, y).
fn eyes_to(host: &Host, player: f64, x: f64, y: f64) {
  let eyes: Vec<u32> = all(host, "Sight").into_iter().map(|(entity, _)| entity).filter(|&entity| get(host, entity, "Owner").is_some_and(|owner| owner["player"].as_f64() == Some(player))).collect();
  for eye in eyes {
    set(host, eye, "Position", json!({ "x": x, "y": y }));
  }
}

#[test]
fn foreign_buildings_and_paving_are_remembered_as_last_seen() {
  let mut host = self::host();
  host.join(2).unwrap();
  let (core, (cx, cy)) = deployed(&mut host);
  let (x, y) = place(&host, core);
  // Второй игрок видит главное здание первого, отходит — оно у него призраком.
  eyes_to(&host, 2.0, x, y);
  ticks(&mut host, 8);
  assert!(host.state.borrow().memory.sees(2, core));
  eyes_to(&host, 2.0, x + 60.0, y);
  ticks(&mut host, 8);
  {
    let state = host.state.borrow();
    assert!(!state.memory.sees(2, core) && !state.shows(2, core));
    assert!(state.memory.remembered(2, core).is_some_and(|record| record.x == x && record.y == y));
    assert!(state.memory.remembered(1, core).is_none(), "своё не помнят");
  }
  // Дорога первого вдали от второго: свой знает сразу, чужой — нет.
  {
    let mut state = host.state.borrow_mut();
    let paving = state.layers.id("paving").unwrap();
    state.layers.set(paving, kharos_engine::layers::Owner::World, cx, cy - 3, 0, 2.0);
    state.layers.set(paving, kharos_engine::layers::Owner::World, cx, cy - 3, 1, 1.0);
    state.memory.touch(paving, cx, cy - 3);
  }
  ticks(&mut host, 4);
  {
    let state = host.state.borrow();
    let paving = state.layers.id("paving").unwrap();
    assert_eq!(state.known_layer(1, paving, cx, cy - 3, 0), 2.0);
    assert_eq!(state.known_layer(2, paving, cx, cy - 3, 0), 0.0);
  }
  // Сохранение уносит память.
  let snapshot = host.snapshot().unwrap();
  let mut copy = self::host();
  copy.join(2).unwrap();
  copy.restore(&snapshot).unwrap();
  assert!(copy.state.borrow().memory.remembered(2, core).is_some());
  // Снесли в тумане — помнит; увидел пустое место — забыл. Увидел и дорогу.
  host.state.borrow_mut().world.destroy(core);
  ticks(&mut host, 8);
  assert!(host.state.borrow().memory.remembered(2, core).is_some(), "снесённое в тумане");
  eyes_to(&host, 2.0, x, y);
  ticks(&mut host, 8);
  let state = host.state.borrow();
  assert!(state.memory.remembered(2, core).is_none(), "место в обзоре");
  let paving = state.layers.id("paving").unwrap();
  assert_eq!(state.known_layer(2, paving, cx, cy - 3, 1), 1.0, "увидел дорогу");
}

#[test]
fn spent_deposit_leaves_and_a_new_one_appears_elsewhere_after_renewal() {
  let mut host = self::host();
  // Смена через 3 секунды, а не 15 минут.
  {
    let game = host.content.get("games", &host.game).unwrap();
    let data: mlua::Table = game.get("data").unwrap();
    let rules: mlua::Table = data.get("rules").unwrap();
    rules.set("depositRenewal", 0.05).unwrap();
  }
  let count = all(&host, "Deposit").len();
  let (spent, _) = all(&host, "Deposit")[0].clone();
  let at = place(&host, spent);
  set(&host, spent, "Deposit", json!({ "reserve": 0 }));
  ticks(&mut host, 21);
  assert!(get(&host, spent, "Deposit").is_none(), "выработанное ушло");
  assert_eq!(all(&host, "Deposit").len(), count - 1);
  ticks(&mut host, 40);
  assert_eq!(all(&host, "Deposit").len(), count - 1, "срок не подошёл");
  ticks(&mut host, 30);
  assert_eq!(all(&host, "Deposit").len(), count, "новое появилось");
  assert!(all(&host, "Deposit").iter().all(|&(entity, _)| place(&host, entity) != at), "не на прежнем месте");
  // Под шахтой выработанное остаётся, пока она стоит.
  let (mined, _) = all(&host, "Deposit")[1].clone();
  let (x, y) = place(&host, mined);
  let mine_kind = host.proto_id("buildings", "mine").unwrap();
  let mine = spawn_with(&host, json!({ "Position": { "x": x, "y": y }, "Proto": { "id": mine_kind }, "Building": { "width": 2, "height": 2 }, "Owner": { "player": 1 } }));
  set(&host, mined, "Deposit", json!({ "reserve": 0 }));
  ticks(&mut host, 41);
  assert!(get(&host, mined, "Deposit").is_some_and(|deposit| deposit["spent"] == json!(true)), "под шахтой осталось");
  host.state.borrow_mut().world.destroy(mine);
  ticks(&mut host, 21);
  assert!(get(&host, mined, "Deposit").is_none(), "шахты нет — ушло");
}

/// Тикает, пока test не станет правдой; не стало за seconds секунд — false.
fn until(host: &mut Host, seconds: f64, test: impl Fn(&Host) -> bool) -> bool {
  for _ in 0..(seconds * 20.0) as usize {
    host.tick(0.05).unwrap();
    if test(host) {
      return true;
    }
  }
  false
}

#[test]
fn trucks_carry_by_hand_ride_routes_and_fill_request_stations() {
  let mut host = host_without_tech();
  let (core, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 20000 }));
  let generator = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "generator", spot, builder)
  };
  assert!(get(&host, generator, "Footprint").is_some());
  let from = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "metalYard", spot, builder)
  };
  let to = {
    let spot = free_spot(&host, site, 3);
    raise(&mut host, "metalYard", spot, builder)
  };
  set(&host, from, "Inventory", json!({ "items": { "metal": 60 } }));
  host.send(1, "produce", json!({ "building": core, "unit": "truck" }));
  assert!(until(&mut host, 60.0, |host| !kind(host, "units", "truck").is_empty()), "грузовик не вышел");
  let truck = kind(&host, "units", "truck")[0];
  // Резерв: не больше вместимости.
  host.send(1, "reserve", json!({ "buildings": [from], "amount": 10 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, from, "Inventory").unwrap()["reserve"].as_f64(), Some(10.0));
  host.send(1, "reserve", json!({ "buildings": [from], "amount": 0 }));
  // Ручная перевозка: 20 металла из одного хранилища в другое, потом приказ кончается сам.
  host.send(1, "carry", json!({ "units": [truck], "from": from, "to": to, "resource": "metal", "amount": 20 }));
  host.tick(0.05).unwrap();
  assert!(get(&host, truck, "Carry").is_some(), "приказ не принят");
  assert!(until(&mut host, 120.0, |host| get(host, truck, "Carry").is_none()), "приказ не кончился: {:?}", get(&host, truck, "Carry"));
  assert!((stocked(&host, to, "metal") - 20.0).abs() < 1e-6, "привезено {}", stocked(&host, to, "metal"));
  // Маршрут по двум хранилищам: свои готовые здания, подряд одинаковые склеиваются.
  host.send(1, "route", json!({ "units": [truck], "stops": [from, from, to] }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, truck, "Hauler").unwrap()["route"], json!([from, to]));
  assert!(until(&mut host, 120.0, |host| stocked(host, to, "metal") >= 30.0), "по маршруту не возит: {:?}", get(&host, truck, "Hauler"));
  // Фильтр — только известные грузы.
  host.send(1, "filter", json!({ "units": [truck], "goods": ["silicon", "nothing"] }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, truck, "Hauler").unwrap()["filter"], json!(["silicon"]));
  host.send(1, "filter", json!({ "units": [truck], "goods": [] }));
  // Приказ идти снимает маршрут.
  let (x, y) = place(&host, truck);
  host.send(1, "move", json!({ "units": [truck], "x": x, "y": y + 2.0 }));
  host.tick(0.05).unwrap();
  assert!(get(&host, truck, "Hauler").unwrap()["route"].as_array().is_none_or(|list| list.is_empty()));
  // Станция запроса держит заказанное: недостающее довозят.
  let station = {
    let spot = free_spot(&host, site, 2);
    raise(&mut host, "requestStation", spot, builder)
  };
  host.send(1, "want", json!({ "buildings": [station], "resource": "metal", "amount": 15 }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, station, "Wanted").unwrap()["items"]["metal"].as_f64(), Some(15.0));
  assert!(until(&mut host, 180.0, |host| stocked(host, station, "metal") >= 15.0 - 1e-6), "станция пуста: {:?}", get(&host, station, "Inventory"));
  // «Обеспечить»: стройке нужен литий — грузовик возит только ей.
  set(&host, from, "Inventory", json!({ "accepts": [], "items": { "metal": 30, "lithium": 30 } }));
  let spot = free_spot(&host, site, 2);
  host.send(1, "build", json!({ "building": "accumulator", "x": spot.0, "y": spot.1, "builders": [] }));
  host.tick(0.05).unwrap();
  let accumulator = kind(&host, "buildings", "accumulator")[0];
  host.send(1, "supply", json!({ "units": [truck], "target": accumulator }));
  host.tick(0.05).unwrap();
  assert_eq!(get(&host, truck, "Hauler").unwrap()["supply"].as_f64(), Some(accumulator as f64));
}

#[test]
fn builders_raze_a_mountain_into_rock_and_the_land_keeps_it() {
  let mut host = host_without_tech();
  let (_, site, builder) = base_with_builder(&mut host);
  let player = all(&host, "Player")[0].0;
  set(&host, player, "Player", json!({ "credits": 20000 }));
  // Ближайшая к базе гора.
  let peak = {
    let mut state = host.state.borrow_mut();
    let land = state.land.as_mut().unwrap();
    let mut found = None;
    'search: for ring in 0..60 {
      for dy in -ring..=ring {
        for dx in -ring..=ring {
          if dx.max(-dx).max(dy).max(-dy) == ring && land.peak_of(site.0 + dx, site.1 + dy).is_some() {
            found = Some((site.0 + dx, site.1 + dy));
            break 'search;
          }
        }
      }
    }
    found.expect("гора рядом")
  };
  let before = credits(&host);
  host.send(1, "dig", json!({ "kind": "peak", "tiles": [peak.0, peak.1], "builders": [builder] }));
  host.tick(0.05).unwrap();
  let digs = all(&host, "Dig");
  assert_eq!(digs.len(), 1, "работа не заказана");
  let cost = digs[0].1["cost"].as_f64().unwrap();
  assert!(cost >= 40.0 && (before - credits(&host) - cost).abs() < 1e-6, "плата сразу: {cost}");
  assert!(until(&mut host, 300.0, |host| all(host, "Dig").is_empty()), "гору не сорвали");
  {
    let mut state = host.state.borrow_mut();
    let land = state.land.as_mut().unwrap();
    assert!(land.peak_of(peak.0, peak.1).is_none(), "гора осталась");
    assert_eq!(land.stored(peak.0, peak.1)[0], kharos_engine::terrain::ROCK);
  }
  // Сохранение уносит правку земли.
  let snapshot = host.snapshot().unwrap();
  let mut copy = host_without_tech();
  copy.restore(&snapshot).unwrap();
  let mut state = copy.state.borrow_mut();
  assert_eq!(state.land.as_mut().unwrap().stored(peak.0, peak.1)[0], kharos_engine::terrain::ROCK);
  assert!(!state.memory.land.original.is_empty());
}

#[test]
fn base_scenes_raise_a_working_base_build_and_hold_the_line() {
  // Добыча: готовая база у металла — шахта, главное здание, хранилища, всё в одной сети. Встаёт не на каждой
  // местности: металл нужен близко к началу мира.
  let seed = (1..40).find(|&seed| !showcase("mining", seed).signals().iter().any(|signal| signal.name == "scene_failed")).expect("добыча не встала ни на одной местности");
  let mut host = showcase("mining", seed);
  let buildings = all(&host, "Building").len();
  assert!(buildings > 15, "база не встала: {buildings} зданий");
  assert!(!kind(&host, "buildings", "mine").is_empty() && !kind(&host, "buildings", "command").is_empty());
  assert!(kind(&host, "units", "truck").len() >= 2, "грузовики");
  ticks(&mut host, 20 * 20);
  // Стройка: бригада поднимает здание за зданием.
  let mut host = showcase("construction", 7);
  let before = all(&host, "Building").len();
  let mut sites = 0;
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    sites = sites.max(all(&host, "Site").len());
  }
  assert!(sites > 0, "стройку не заложили");
  assert!(all(&host, "Building").len() > before + 1, "не построили: {} из {before}", all(&host, "Building").len());
  // Оборона: турели и стены перед главным зданием, волны идут и бьются.
  let mut host = showcase("defense", 7);
  assert!(all(&host, "Building").iter().filter(|(entity, _)| get(&host, *entity, "Armed").is_some() || get(&host, *entity, "Footprint").is_some_and(|footprint| footprint["wall"] == json!(true))).count() > 3, "укрепления нет");
  let mut shots = 0;
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    shots = shots.max(all(&host, "Shot").len());
  }
  assert!(shots > 0, "волна не пришла или не стреляли");
}
