//! Обзор игроков — инструмент движка, как vision.ts / crates/sim/src/vision.rs: что игрок видит сейчас и что разведал.
//! Глаз — компонент движка `Sight { radius }` у сущности с `Owner` и `Position`: круг в radius тайлов от неё (тайл
//! виден, если его середина в круге). Сколько видит вид — решает мод в своём `entity`. Пересчёт — раз в TICKS тиков.

use crate::world::World;
use std::collections::{BTreeMap, BTreeSet};

/// Раз во сколько тиков пересчитывается обзор.
pub const TICKS: u64 = 4;
/// Сторона ячейки видимого (`seenCells` в vision.ts): по ним память сверяет только то, что игрок видит.
pub const CELL: i32 = 16;

/// Прямоугольник карты в тайлах: [left, right) × [top, bottom).
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
  pub left: i32,
  pub top: i32,
  pub right: i32,
  pub bottom: i32,
}

impl Bounds {
  pub fn width(&self) -> i32 {
    self.right - self.left
  }

  pub fn height(&self) -> i32 {
    self.bottom - self.top
  }

  pub fn contains(&self, x: i32, y: i32) -> bool {
    x >= self.left && x < self.right && y >= self.top && y < self.bottom
  }
}

/// Обзор: по игроку — тайлы карты построчно: 0 — не разведан, 1 — разведан, 2 — виден сейчас.
pub struct Vision {
  pub bounds: Bounds,
  /// Есть ли туман: без него всё видно всем.
  pub fog: bool,
  pub cells: BTreeMap<u32, Vec<u8>>,
  /// Растёт, когда у игрока поменялось видимое: клиенту — перерисовать туман.
  pub changed: BTreeMap<u32, u64>,
  /// Ячейки CELL, где игрок видит хоть один тайл.
  pub visible: BTreeMap<u32, BTreeSet<(i32, i32)>>,
  /// Чьи глаза считать; None — всех. Реплика клиента считает только своего игрока: чужие глаза в ней тоже есть.
  pub only: Option<u32>,
}

impl Vision {
  pub fn new(bounds: Bounds, fog: bool) -> Self {
    Self { bounds, fog, cells: BTreeMap::new(), changed: BTreeMap::new(), visible: BTreeMap::new(), only: None }
  }

  fn index(&self, x: i32, y: i32) -> Option<usize> {
    self.bounds.contains(x, y).then(|| ((y - self.bounds.top) * self.bounds.width() + x - self.bounds.left) as usize)
  }

  /// Пересчёт: видимое гаснет до разведанного, глаза каждого игрока зажигают свои круги.
  pub fn update(&mut self, world: &World) {
    let (Some(sight), Some(owner), Some(position)) = (world.schema.id("Sight"), world.schema.id("Owner"), world.schema.id("Position")) else { return };
    let size = (self.bounds.width() * self.bounds.height()).max(0) as usize;
    let mut fresh: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut visible: BTreeMap<u32, BTreeSet<(i32, i32)>> = BTreeMap::new();
    let store = &world.stores[sight];
    for (row, &entity) in store.entities.iter().enumerate() {
      let radius = store.nums[0][row];
      let (Some(player), Some(x), Some(y)) = (world.num(entity, owner, "player"), world.num(entity, position, "x"), world.num(entity, position, "y")) else { continue };
      if player <= 0.0 || radius <= 0.0 || self.only.is_some_and(|only| only != player as u32) {
        continue;
      }
      let player = player as u32;
      let cells = fresh.entry(player).or_insert_with(|| self.cells.get(&player).map_or_else(|| vec![0; size], |old| old.iter().map(|&cell| cell.min(1)).collect()));
      let seen = visible.entry(player).or_default();
      let reach = radius * radius;
      let bounds = self.bounds;
      let from_y = bounds.top.max((y - radius).floor() as i32);
      let to_y = (bounds.bottom - 1).min((y + radius).floor() as i32);
      for tile_y in from_y..=to_y {
        let dy = tile_y as f64 + 0.5 - y;
        let span = (reach - dy * dy).max(0.0).sqrt();
        let from_x = bounds.left.max((x - span).floor() as i32);
        let to_x = (bounds.right - 1).min((x + span).floor() as i32);
        for cell_x in from_x.div_euclid(CELL)..=to_x.div_euclid(CELL) {
          if from_x <= to_x {
            seen.insert((cell_x, tile_y.div_euclid(CELL)));
          }
        }
        for tile_x in from_x..=to_x {
          cells[((tile_y - bounds.top) * bounds.width() + tile_x - bounds.left) as usize] = 2;
        }
      }
    }
    // Игрок без глаз: видимое гаснет, разведанное остаётся.
    for (player, old) in &self.cells {
      fresh.entry(*player).or_insert_with(|| old.iter().map(|&cell| cell.min(1)).collect());
    }
    self.visible = visible;
    for (player, cells) in fresh {
      if self.cells.get(&player) != Some(&cells) {
        *self.changed.entry(player).or_insert(0) += 1;
        self.cells.insert(player, cells);
      }
    }
  }

  /// Видит ли игрок тайл сейчас.
  pub fn sees(&self, player: u32, x: f64, y: f64) -> bool {
    if !self.fog {
      return true;
    }
    let Some(index) = self.index(x.floor() as i32, y.floor() as i32) else { return false };
    self.cells.get(&player).is_some_and(|cells| cells[index] == 2)
  }

  /// Бывал ли тайл в виду игрока.
  pub fn explored(&self, player: u32, x: f64, y: f64) -> bool {
    if !self.fog {
      return true;
    }
    let Some(index) = self.index(x.floor() as i32, y.floor() as i32) else { return false };
    self.cells.get(&player).is_some_and(|cells| cells[index] >= 1)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::schema::Schema;
  use serde_json::json;
  use std::rc::Rc;

  #[test]
  fn sight_lights_a_circle_and_leaves_explored_behind() {
    let mut world = World::new(Rc::new(Schema::new()));
    let (sight, owner, position) = (world.schema.id("Sight").unwrap(), world.schema.id("Owner").unwrap(), world.schema.id("Position").unwrap());
    let eye = world.spawn();
    world.add(eye, owner, json!({ "player": 1 }).as_object().unwrap()).unwrap();
    world.add(eye, position, json!({ "x": 0.5, "y": 0.5 }).as_object().unwrap()).unwrap();
    world.add(eye, sight, json!({ "radius": 2 }).as_object().unwrap()).unwrap();
    let mut vision = Vision::new(Bounds { left: -8, top: -8, right: 8, bottom: 8 }, true);
    vision.update(&world);
    assert!(vision.sees(1, 2.5, 0.5) && !vision.sees(1, 3.5, 0.5) && !vision.sees(2, 0.5, 0.5));
    world.set(eye, position, json!({ "x": 5.5 }).as_object().unwrap()).unwrap();
    vision.update(&world);
    assert!(!vision.sees(1, 0.5, 0.5) && vision.explored(1, 0.5, 0.5) && vision.sees(1, 5.5, 0.5));
    assert_eq!(vision.changed[&1], 2);
  }
}
