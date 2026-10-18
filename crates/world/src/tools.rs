//! Системы движка, которые вид ставит в тик по имени: `follow = { engine = "follow", after = { "drive" } }`. Порядок
//! решает контент, а работу делает Rust — то, что горячее и общее для разных механик (docs/content.md, §3).

use crate::host::State;
use crate::world::{Entity, World};

/// Системы движка по именам.
pub fn find(name: &str) -> Option<fn(&mut State)> {
  match name {
    "follow" => Some(|state| follow(&mut state.world)),
    // Ход (motion): пути упёршимся и движение по путям — в том месте тика, где их поставил вид.
    "plan_paths" => Some(|state| state.scene().plan_paths()),
    "move_units" => Some(|state| {
      let step = state.dt;
      state.scene().move_units(step)
    }),
    _ => None,
  }
}

/// Носители (`followCarriers` в sim-ts): закреплённое (`Attached`) встаёт на своё место на носителе — вперёд и вправо
/// от его центра — и смотрит, куда он, плюс свой поворот; закреплённое на погибшем исчезает.
fn follow(world: &mut World) {
  let schema = world.schema.clone();
  let (Some(attached), Some(position), Some(facing)) = (schema.id("Attached"), schema.id("Position"), schema.id("Facing")) else { return };
  let mut orphans: Vec<Entity> = Vec::new();
  let rows = world.stores[attached].entities.clone();
  for (row, entity) in rows.into_iter().enumerate() {
    let store = &world.stores[attached];
    let [parent, along, across, angle] = [0, 1, 2, 3].map(|slot| store.nums[slot][row]);
    let parent = parent as Entity;
    let Some(place) = world.stores[position].row(parent) else {
      orphans.push(entity);
      continue;
    };
    let (cx, cy) = (world.stores[position].nums[0][place], world.stores[position].nums[1][place]);
    let turn = world.stores[facing].row(parent).map_or(0.0, |row| world.stores[facing].nums[0][row]);
    let (cos, sin) = (turn.cos(), turn.sin());
    if let Some(own) = world.stores[position].row(entity) {
      world.stores[position].nums[0][own] = cx + along * cos - across * sin;
      world.stores[position].nums[1][own] = cy + along * sin + across * cos;
    }
    if let Some(own) = world.stores[facing].row(entity) {
      world.stores[facing].nums[0][own] = turn + angle;
    }
  }
  for entity in orphans {
    world.destroy(entity);
  }
}
