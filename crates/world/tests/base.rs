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

/// Сколько дохода (5 кредитов раз в 20 тиков) пришло между тиками.
fn income_between(from: u64, to: u64) -> f64 {
  5.0 * (to / 20 - from / 20) as f64
}

#[test]
fn builder_raises_a_generator_paying_as_it_goes() {
  let mut host = host();
  let (_, site, builder) = base_with_builder(&mut host);
  let (x, y) = generator_spot(&host, site);
  let (before, from) = (credits(&host), tick_now(&host));
  host.send(1, "build", json!({ "building": "generator", "x": x, "y": y, "builders": [builder] }));
  host.tick(0.05).unwrap();
  let generator = kind(&host, "buildings", "generator")[0];
  // Площадка: тайлов не занимает, пока к ней не приступили, и денег за неё ещё не брали.
  assert!(get(&host, generator, "Site").is_some());
  assert!(get(&host, generator, "Footprint").is_none());
  assert_eq!(credits(&host), before + income_between(from, tick_now(&host)));
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
      let paid = before + income_between(from, tick_now(&host)) - credits(&host);
      assert!((paid - 150.0).abs() <= 2.0, "за половину уплачено {paid}");
      assert!(!all(&host, "Repair").iter().all(|(_, repair)| repair["target"] == json!(-1)), "луч работы");
    }
  }
  let started = started.expect("стройка не началась");
  assert!(get(&host, generator, "Site").is_none(), "не достроено");
  let built = tick_now(&host);
  assert!((built - started) as i64 - 300 <= 2, "строилось {} тиков", built - started);
  let paid = before + income_between(from, built) - credits(&host);
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
  let (before, from) = (credits(&host), tick_now(&host));
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
  let lost = before + income_between(from, tick_now(&host)) - credits(&host);
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
  let (before, from) = (credits(&host), tick_now(&host));
  host.send(1, "demolish", json!({ "building": third, "builders": [builder] }));
  for _ in 0..20 * 30 {
    host.tick(0.05).unwrap();
    if kind(&host, "buildings", "generator").is_empty() {
      break;
    }
  }
  assert!(kind(&host, "buildings", "generator").is_empty(), "не разобрано");
  assert_eq!(credits(&host), before + income_between(from, tick_now(&host)) + 150.0);
}

#[test]
fn builders_repair_what_is_damaged_for_credits_and_not_under_fire() {
  let mut host = host();
  let (core, _, _) = base_with_builder(&mut host);
  // Строитель стоит у главного здания: разбитое рядом он чинит сам.
  set(&host, core, "Health", json!({ "value": 0.5 }));
  let (before, from) = (credits(&host), tick_now(&host));
  for _ in 0..20 * 60 {
    host.tick(0.05).unwrap();
    if get(&host, core, "Health").unwrap()["value"].as_f64().unwrap() >= 1.0 {
      break;
    }
  }
  let health = get(&host, core, "Health").unwrap()["value"].as_f64().unwrap();
  assert!(health >= 1.0, "не дочинил: {health}");
  // Половина прочности за половину цены починки: 2000 × 0,5 × 0,5.
  let paid = before + income_between(from, tick_now(&host)) - credits(&host);
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
