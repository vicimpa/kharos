//! Реплика по проводу совпадает с тем, что игрок видит на хосте: партия skirmish с туманом, два игрока, отряды
//! ездят друг к другу и обратно — сущности входят в обзор и уходят из него, остаются призраки.

use kharos_content::discover;
use kharos_net::{Frame, Replica, Rules, Shared, View};
use kharos_world::Host;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;
use std::rc::Rc;

fn mods() -> Vec<kharos_content::Mod> {
  discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap()
}

/// Сущности игрока вида units/name.
fn units(host: &Host, player: u32, name: &str) -> Vec<u32> {
  let proto = host.proto_id("units", name).unwrap() as f64;
  let state = host.state.borrow();
  let world = &state.world;
  let (owner, kind) = (world.schema.id("Owner").unwrap(), world.schema.id("Proto").unwrap());
  world.query(&[owner, kind]).into_iter().filter(|&e| world.num(e, owner, "player") == Some(player as f64) && world.num(e, kind, "id") == Some(proto)).collect()
}

/// Ближайшая к (x, y) скала под главное здание 3 × 3: левый верхний тайл.
fn rock_near(host: &Host, x: i32, y: i32) -> (i32, i32) {
  use kharos_engine::terrain::{FOOT_BIT, ROCK};
  let mut state = host.state.borrow_mut();
  let land = state.land.as_mut().unwrap();
  let mut rocky = |x: i32, y: i32| {
    (y..y + 3).all(|ty| {
      (x..x + 3).all(|tx| {
        let tile = land.tile(tx, ty);
        tile[0] == ROCK && tile[3] & FOOT_BIT == 0
      })
    })
  };
  for ring in 3i32..60 {
    for dy in -ring..=ring {
      for dx in -ring..=ring {
        if dx.abs().max(dy.abs()) == ring && rocky(x + dx, y + dy) {
          return (x + dx, y + dy);
        }
      }
    }
  }
  panic!("нет скалы рядом с {x} {y}");
}

/// Месторождение, ближайшее к (x, y).
fn deposit_near(host: &Host, x: f64, y: f64) -> (f64, f64) {
  let state = host.state.borrow();
  let deposit = state.world.schema.id("Deposit").unwrap();
  let list: Vec<u32> = state.world.query(&[deposit]);
  drop(state);
  list.into_iter().map(|e| place(host, e)).min_by(|a, b| ((a.0 - x).hypot(a.1 - y)).total_cmp(&(b.0 - x).hypot(b.1 - y))).unwrap()
}

fn place(host: &Host, entity: u32) -> (f64, f64) {
  let state = host.state.borrow();
  let position = state.world.schema.id("Position").unwrap();
  (state.world.num(entity, position, "x").unwrap(), state.world.num(entity, position, "y").unwrap())
}

/// Сверка: в реплике ровно то, что игрок видит на хосте, с теми же значениями; призраки, память слоёв и земля — те же.
fn check(host: &Host, replica: &Host, view: &View, shared: &Shared, player: u32, foreign: &mut usize) {
  let mut server = host.state.borrow_mut();
  let client = replica.state.borrow();
  let mut expected = BTreeSet::new();
  for entity in server.world.entities() {
    let Some(relation) = view.relation(&server, shared, entity) else { continue };
    expected.insert(entity);
    let seen = View::seen(&server.world, shared, entity, relation);
    assert_eq!(client.world.components(entity), seen, "тик {}: сущность {entity}", server.tick);
    // Тайны хозяина чужому не уходят: стойка, в кого целится стрелок.
    if relation == kharos_net::rules::Relation::Foreign {
      *foreign += 1;
      assert!(!seen.contains_key("Tactics"), "чужая стойка: {entity}");
      assert!(seen.get("Armed").is_none_or(|armed| armed["target"] == json!(-1.0)), "чужая цель: {entity}");
    }
  }
  let got: BTreeSet<u32> = client.world.entities().into_iter().collect();
  assert_eq!(got, expected, "тик {}: состав", server.tick);
  let ghosts = |state: &kharos_world::host::State| state.ghosts(player).into_iter().map(|(entity, record)| (entity, record.x, record.y)).collect::<Vec<_>>();
  assert_eq!(ghosts(&client), ghosts(&server), "тик {}: призраки", server.tick);
  for (mine, theirs) in client.memory.layers.iter().zip(&server.memory.layers) {
    let empty = Default::default();
    assert_eq!(mine.known.get(&player).unwrap_or(&empty), theirs.known.get(&player).unwrap_or(&empty), "тик {}: память слоя {}", server.tick, theirs.layer);
  }
  let fog = server.vision.as_ref().unwrap().fog;
  let kharos_world::host::State { memory, land, .. } = &mut *server;
  let known = memory.land.known_of(land.as_mut().unwrap(), player, fog);
  drop(client);
  let mut client = replica.state.borrow_mut();
  let kharos_world::host::State { memory, land, .. } = &mut *client;
  assert_eq!(memory.land.known_of(land.as_mut().unwrap(), player, fog), known, "земля");
}

#[test]
fn replica_matches_what_the_player_sees() {
  let mut host = Host::new(mods(), Some("skirmish"), 7, &serde_json::Value::Null).unwrap();
  host.start().unwrap();
  host.join(1).unwrap();
  host.join(2).unwrap();
  let replica = Host::new(mods(), Some("skirmish"), 7, &serde_json::Value::Null).unwrap();
  let mut link = Replica::new(&mut replica.state.borrow_mut(), 1);
  let schema = host.state.borrow().world.schema.clone();
  let rules = Rc::new(Rules::of(&host.content, &schema).unwrap());
  let mut view = View::new(1);
  let (home, away) = (place(&host, units(&host, 1, "mcv")[0]), place(&host, units(&host, 2, "mcv")[0]));
  let (site, other) = (rock_near(&host, home.0 as i32, home.1 as i32), rock_near(&host, away.0 as i32, away.1 as i32));
  let ore = deposit_near(&host, home.0, home.1);
  let scouts = |host: &Host, player| [units(host, player, "buggy"), units(host, player, "infantry")].concat();
  let (mut removed, mut ghosts, mut bytes, mut biggest, mut foreign) = (0, 0, 0usize, 0usize, 0usize);
  let ticks = 1200;
  for tick in 1..=ticks {
    match tick {
      2 => {
        host.send(1, "deploy", json!({ "unit": units(&host, 1, "mcv")[0], "x": site.0, "y": site.1 }));
        host.send(2, "deploy", json!({ "unit": units(&host, 2, "mcv")[0], "x": other.0, "y": other.1 }));
      }
      // Разведка игрока 1 — к месторождению, потом к базе игрока 2 и за неё, потом домой: увиденное уходит в туман
      // призраками.
      20 => host.send(1, "move", json!({ "units": scouts(&host, 1), "x": ore.0, "y": ore.1 })),
      300 => host.send(1, "move", json!({ "units": scouts(&host, 1), "x": away.0 + 40.0, "y": away.1 })),
      600 => host.send(1, "move", json!({ "units": scouts(&host, 1), "x": home.0 - 30.0, "y": home.1 })),
      // Отряд игрока 2 — к базе игрока 1.
      700 => host.send(2, "move", json!({ "units": scouts(&host, 2), "x": home.0, "y": home.1 + 6.0 })),
      _ => {}
    }
    host.tick(0.05).unwrap();
    let signals = host.signals();
    let shared = Shared::after_tick(&mut host.state.borrow_mut(), rules.clone(), signals);
    let frame = view.frame(&mut host.state.borrow_mut(), &shared);
    let wire = frame.encode(&schema);
    let decoded = Frame::decode(&wire, &schema).unwrap();
    assert_eq!(decoded.encode(&schema), wire, "провод туда и обратно");
    removed += frame.removed.len();
    ghosts += frame.ghosts.len();
    bytes += wire.len();
    biggest = biggest.max(wire.len());
    link.apply(&mut replica.state.borrow_mut(), decoded).unwrap();
    check(&host, &replica, &view, &shared, 1, &mut foreign);
  }
  println!("{ticks} тиков: {bytes} байт, в среднем {} на тик, самый большой кадр {biggest}; ушло из виду {removed}, призраков {ghosts}", bytes / ticks);
  assert!(removed > 0 && ghosts > 0 && foreign > 0, "проверка должна видеть уход из обзора, призраков и чужих: ушло {removed}, призраков {ghosts}, чужих {foreign}");
}
