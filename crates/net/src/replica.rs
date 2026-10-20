//! Реплика (replica.ts): `State` клиента по сети. Мир в ней — только то, что прислал сервер, с теми же номерами
//! сущностей; память (призраки, слои, земля) — какой её знает свой игрок; обзор реплика считает сама по своим глазам.

use crate::frame::{cells_of, Frame, Value};
use kharos_world::host::{Signal, State};
use kharos_world::memory::Remembered;
use kharos_world::Kind;
use serde_json::Map;
use std::collections::HashMap;
use std::rc::Rc;

pub struct Replica {
  pub player: u32,
  /// Номер строки сервера → номер в реплике.
  strings: HashMap<u32, u32>,
}

impl Replica {
  /// Делает `state` (хост тех же модов и партии, не запущенный) репликой игрока player.
  pub fn new(state: &mut State, player: u32) -> Self {
    state.replica = true;
    if let Some(vision) = state.vision.as_mut() {
      vision.only = Some(player);
    }
    Self { player, strings: HashMap::new() }
  }

  /// Кладёт кадр в реплику; отдаёт сигналы тика.
  pub fn apply(&mut self, state: &mut State, frame: Frame) -> Result<Vec<Signal>, String> {
    let player = self.player;
    state.tick = frame.tick;
    let State { world, memory, layers, land, vision, .. } = state;
    for (id, text) in &frame.strings {
      self.strings.insert(*id, world.strings.id(text));
    }
    for &entity in &frame.removed {
      world.destroy(entity);
    }
    let schema = world.schema.clone();
    for change in &frame.changes {
      let entity = change.entity;
      if !world.alive(entity) {
        world.set_next(entity + 1);
        world.revive(entity);
      }
      for &component in &change.unset {
        world.remove(entity, component);
      }
      for part in &change.parts {
        let component = part.component;
        // Новый компонент приходит отличиями от значений по умолчанию.
        if part.added {
          world.remove(entity, component);
        }
        if !world.has(entity, component) {
          world.add(entity, component, &Map::new())?;
        }
        let fields = &schema.components[component].fields;
        let row = world.stores[component].row(entity).expect("компонент только что есть");
        for (index, value) in &part.fields {
          let field = &fields[*index];
          match (field.kind, value) {
            (Kind::Any, Value::Any(json)) => world.stores[component].anys[field.slot][row] = json.clone(),
            (Kind::Str, Value::Num(number)) => {
              let local = self.strings.get(&(*number as u32)).copied().ok_or_else(|| format!("{}.{}: строки {number} сервер не присылал", schema.components[component].name, field.name))?;
              world.stores[component].nums[field.slot][row] = local as f64;
            }
            (Kind::Any, _) | (_, Value::Any(_)) => return Err(format!("{}.{}: не тот вид значения", schema.components[component].name, field.name)),
            (_, Value::Num(number)) => world.stores[component].nums[field.slot][row] = *number,
          }
        }
      }
    }
    let ghosts = memory.known.entry(player).or_default();
    for (entity, ghost) in frame.ghosts {
      match ghost {
        Some(ghost) => {
          ghosts.insert(entity, Rc::new(Remembered { x: ghost.x, y: ghost.y, width: ghost.width, height: ghost.height, parts: ghost.parts }));
        }
        None => {
          ghosts.remove(&entity);
        }
      }
    }
    for change in &frame.layers {
      layers.apply(change)?;
    }
    for tile in &frame.recalled {
      let Some(recall) = memory.layers.iter_mut().find(|recall| recall.layer == tile.layer) else { return Err(format!("слой {} не запоминается", tile.layer)) };
      let known = recall.known.entry(player).or_default();
      if tile.values.is_empty() {
        known.remove(&(tile.y, tile.x));
      } else {
        known.insert((tile.y, tile.x), tile.values.clone());
      }
      recall.edits += 1;
    }
    if !frame.land.is_empty() {
      if let Some(land) = land.as_mut() {
        land.begin_batch();
        for &(x, y, bytes) in &frame.land {
          memory.land.original.insert((x, y), bytes);
          land.write_tile(x, y, bytes);
        }
        land.end_batch();
      }
      *memory.land.version.entry(player).or_default() += 1;
      memory.land.edits += 1;
    }
    if let Some(vision) = vision.as_mut() {
      if let Some(runs) = &frame.explored {
        let size = (vision.bounds.width() * vision.bounds.height()).max(0) as usize;
        vision.cells.insert(player, cells_of(runs, size));
      }
      if vision.fog && (frame.explored.is_some() || frame.tick % kharos_world::vision::TICKS == 1) {
        vision.update(world);
      }
    }
    Ok(frame.signals.into_iter().map(|(name, payload)| Signal { name, payload }).collect())
  }
}
