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

/// Обзор одного игрока: тайлы карты построчно, по два бита — разведан и виден сейчас. Байт на тайл на карте 3072 стоил
/// бы 9,4 МБ на каждого игрока, биты — 2,4.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cells {
  explored: Vec<u64>,
  visible: Vec<u64>,
  size: usize,
}

impl Cells {
  pub fn new(size: usize) -> Self {
    let words = size.div_ceil(64);
    Self { explored: vec![0; words], visible: vec![0; words], size }
  }

  /// Из байтов (0 — не разведан, иначе разведан): видимое пересчитает обзор.
  pub fn from_bytes(bytes: &[u8]) -> Self {
    let mut cells = Self::new(bytes.len());
    for (index, &byte) in bytes.iter().enumerate() {
      if byte > 0 {
        cells.explored[index / 64] |= 1 << (index % 64);
      }
    }
    cells
  }

  pub fn len(&self) -> usize {
    self.size
  }

  pub fn is_empty(&self) -> bool {
    self.size == 0
  }

  /// 0 — не разведан, 1 — разведан, 2 — виден сейчас.
  #[inline]
  pub fn get(&self, index: usize) -> u8 {
    let (word, bit) = (index / 64, 1u64 << (index % 64));
    if self.visible.get(word).is_some_and(|value| value & bit != 0) {
      2
    } else if self.explored.get(word).is_some_and(|value| value & bit != 0) {
      1
    } else {
      0
    }
  }

  /// Всё байтами, как get: для сохранения и кадра.
  pub fn bytes(&self) -> Vec<u8> {
    (0..self.size).map(|index| self.get(index)).collect()
  }

  fn light(&mut self, index: usize) {
    let (word, bit) = (index / 64, 1u64 << (index % 64));
    self.explored[word] |= bit;
    self.visible[word] |= bit;
  }

  fn dim(&mut self, index: usize) {
    self.visible[index / 64] &= !(1u64 << (index % 64));
  }
}

/// Обзор игроков: что каждый видит сейчас и что разведал.
pub struct Vision {
  pub bounds: Bounds,
  /// Есть ли туман: без него всё видно всем.
  pub fog: bool,
  pub cells: BTreeMap<u32, Cells>,
  /// Растёт, когда у игрока поменялось видимое: клиенту — перерисовать туман.
  pub changed: BTreeMap<u32, u64>,
  /// Где поменялось в последний раз: тайлы [left, top, right, bottom) от угла карты. Клиент, пропустивший правку,
  /// перерисовывает туман целиком.
  pub rect: BTreeMap<u32, [i32; 4]>,
  /// Ячейки CELL, где игрок видит хоть один тайл.
  pub visible: BTreeMap<u32, BTreeSet<(i32, i32)>>,
  /// Чьи глаза считать; None — всех. Реплика клиента считает только своего игрока: чужие глаза в ней тоже есть.
  pub only: Option<u32>,
  /// Тайлы, зажжённые при прошлом пересчёте, по возрастанию: гасятся только они, а не вся карта.
  lit: BTreeMap<u32, Vec<u32>>,
}

impl Vision {
  pub fn new(bounds: Bounds, fog: bool) -> Self {
    Self { bounds, fog, cells: BTreeMap::new(), changed: BTreeMap::new(), rect: BTreeMap::new(), visible: BTreeMap::new(), only: None, lit: BTreeMap::new() }
  }

  fn index(&self, x: i32, y: i32) -> Option<usize> {
    self.bounds.contains(x, y).then(|| ((y - self.bounds.top) * self.bounds.width() + x - self.bounds.left) as usize)
  }

  /// Разведанное игрока из сохранения или от сервера: видимое пересчитается при следующем пересчёте.
  pub fn set_explored(&mut self, player: u32, cells: Vec<u8>) {
    self.cells.insert(player, Cells::from_bytes(&cells));
    self.lit.remove(&player);
    *self.changed.entry(player).or_default() += 1;
    self.rect.insert(player, [0, 0, self.bounds.width(), self.bounds.height()]);
  }

  /// Пересчёт: глаза каждого игрока зажигают свои круги; что было видно в прошлый раз и не видно теперь, гаснет до
  /// разведанного. Работа — по зажжённым тайлам, а не по всей карте: на карте 3072 у каждого игрока девять миллионов
  /// тайлов, а видит он десятки тысяч.
  pub fn update(&mut self, world: &World) {
    let (Some(sight), Some(owner), Some(position)) = (world.schema.id("Sight"), world.schema.id("Owner"), world.schema.id("Position")) else { return };
    let size = (self.bounds.width() * self.bounds.height()).max(0) as usize;
    let bounds = self.bounds;
    let width = bounds.width();
    let mut lit: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut visible: BTreeMap<u32, BTreeSet<(i32, i32)>> = BTreeMap::new();
    let store = &world.stores[sight];
    for (row, &entity) in store.entities.iter().enumerate() {
      let radius = store.nums[0][row];
      let (Some(player), Some(x), Some(y)) = (world.num(entity, owner, "player"), world.num(entity, position, "x"), world.num(entity, position, "y")) else { continue };
      if player <= 0.0 || radius <= 0.0 || self.only.is_some_and(|only| only != player as u32) {
        continue;
      }
      let player = player as u32;
      let tiles = lit.entry(player).or_default();
      let seen = visible.entry(player).or_default();
      let reach = radius * radius;
      let from_y = bounds.top.max((y - radius).floor() as i32);
      let to_y = (bounds.bottom - 1).min((y + radius).floor() as i32);
      for tile_y in from_y..=to_y {
        let dy = tile_y as f64 + 0.5 - y;
        let span = (reach - dy * dy).max(0.0).sqrt();
        let from_x = bounds.left.max((x - span).floor() as i32);
        let to_x = (bounds.right - 1).min((x + span).floor() as i32);
        if from_x > to_x {
          continue;
        }
        for cell_x in from_x.div_euclid(CELL)..=to_x.div_euclid(CELL) {
          seen.insert((cell_x, tile_y.div_euclid(CELL)));
        }
        let row = (tile_y - bounds.top) * width - bounds.left;
        tiles.extend((from_x..=to_x).map(|tile_x| (row + tile_x) as u32));
      }
    }
    self.visible = visible;
    // Игроки с глазами сейчас и те, у кого видимое было: у последних оно гаснет.
    let players: BTreeSet<u32> = lit.keys().chain(self.lit.keys()).copied().collect();
    for player in players {
      let mut new = lit.remove(&player).unwrap_or_default();
      new.sort_unstable();
      new.dedup();
      let old = self.lit.remove(&player).unwrap_or_default();
      let cells = self.cells.entry(player).or_insert_with(|| Cells::new(size));
      if new == old {
        if !new.is_empty() {
          self.lit.insert(player, new);
        }
        continue;
      }
      let (mut left, mut top, mut right, mut bottom) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
      for &index in old.iter().chain(&new) {
        let (x, y) = (index as i32 % width, index as i32 / width);
        (left, top, right, bottom) = (left.min(x), top.min(y), right.max(x + 1), bottom.max(y + 1));
      }
      for &index in &old {
        cells.dim(index as usize);
      }
      for &index in &new {
        cells.light(index as usize);
      }
      *self.changed.entry(player).or_insert(0) += 1;
      self.rect.insert(player, [left, top, right, bottom]);
      if !new.is_empty() {
        self.lit.insert(player, new);
      }
    }
  }

  /// Видит ли игрок тайл сейчас.
  pub fn sees(&self, player: u32, x: f64, y: f64) -> bool {
    if !self.fog {
      return true;
    }
    let Some(index) = self.index(x.floor() as i32, y.floor() as i32) else { return false };
    self.cells.get(&player).is_some_and(|cells| cells.get(index) == 2)
  }

  /// Бывал ли тайл в виду игрока.
  pub fn explored(&self, player: u32, x: f64, y: f64) -> bool {
    if !self.fog {
      return true;
    }
    let Some(index) = self.index(x.floor() as i32, y.floor() as i32) else { return false };
    self.cells.get(&player).is_some_and(|cells| cells.get(index) >= 1)
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
