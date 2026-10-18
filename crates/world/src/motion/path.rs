//! Поиск пути (path.ts): A* по тайлам в восемь сторон, не наискось мимо угла; спрямление пути. Точная копия TS — та же
//! куча, те же окна и та же норма поиска за тик: пути на Rust и в TS совпадают тайл в тайл.

use kharos_engine::math::js_hypot;
use std::collections::HashMap;

/// Сколько тайлов поиск осматривает, прежде чем сдаться и повести к ближайшему найденному, если не сказано иначе.
pub const SEARCH_LIMIT: f64 = 20000.0;
const DIAGONAL: f64 = std::f64::consts::SQRT_2;
/// Насколько по бокам от линии движения должно быть свободно, в тайлах.
const CLEARANCE: f64 = 0.3;
/// Сторона окна вокруг старта, внутри которого поиск хранит тайлы в массивах.
const WINDOW: i32 = 512;
const HALF: i32 = WINDOW / 2;

/// Местность для поиска: можно ли в тайл и во сколько раз шаг по нему дороже шага по ровному.
pub trait Grid {
  fn walkable(&mut self, x: i32, y: i32) -> bool;
  fn slowness(&mut self, _x: i32, _y: i32) -> f64 {
    1.0
  }
}

/// Куча с наименьшим приоритетом наверху — как Heap в path.ts, с тем же порядком равных.
struct Heap {
  items: Vec<i64>,
  priorities: Vec<f64>,
}

impl Heap {
  fn new() -> Self {
    Self { items: Vec::new(), priorities: Vec::new() }
  }

  fn push(&mut self, item: i64, priority: f64) {
    let mut at = self.items.len();
    self.items.push(item);
    self.priorities.push(priority);
    while at > 0 {
      let parent = (at - 1) >> 1;
      if self.priorities[parent] <= priority {
        break;
      }
      self.items[at] = self.items[parent];
      self.priorities[at] = self.priorities[parent];
      at = parent;
    }
    self.items[at] = item;
    self.priorities[at] = priority;
  }

  fn pop(&mut self) -> i64 {
    let top = self.items[0];
    let item = self.items.pop().unwrap();
    let priority = self.priorities.pop().unwrap();
    let size = self.items.len();
    if size > 0 {
      let mut at = 0;
      loop {
        let mut child = at * 2 + 1;
        if child >= size {
          break;
        }
        if child + 1 < size && self.priorities[child + 1] < self.priorities[child] {
          child += 1;
        }
        if self.priorities[child] >= priority {
          break;
        }
        self.items[at] = self.items[child];
        self.priorities[at] = self.priorities[child];
        at = child;
      }
      self.items[at] = item;
      self.priorities[at] = priority;
    }
    top
  }
}

/// Соседи тайла: смещение и цена шага.
const STEPS: [(i32, i32, f64); 8] = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, DIAGONAL), (1, -1, DIAGONAL), (-1, 1, DIAGONAL), (-1, -1, DIAGONAL)];

/// Лежит ли цель за окном поиска (`beyondWindow`).
pub fn beyond_window(from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> bool {
  (to_x - from_x).abs() >= HALF - 1 || (to_y - from_y).abs() >= HALF - 1
}

/// Поиски пути: счёт осмотренного, норма тика и память окна — одни на все поиски симуляции.
pub struct Search {
  searched: f64,
  cap: f64,
  cut: bool,
  stamps: Vec<u32>,
  costs: Vec<f64>,
  parents: Vec<i32>,
  passable: Vec<u8>,
  prices: Vec<f64>,
  generation: u32,
}

impl Default for Search {
  fn default() -> Self {
    Self { searched: 0.0, cap: f64::INFINITY, cut: false, stamps: Vec::new(), costs: Vec::new(), parents: Vec::new(), passable: Vec::new(), prices: Vec::new(), generation: 0 }
  }
}

impl Search {
  /// Сколько тайлов осмотрели все поиски (`searchedTiles`).
  pub fn searched(&self) -> f64 {
    self.searched
  }

  /// Оборвала ли норма последний поиск (`searchCut`).
  pub fn cut(&self) -> bool {
    self.cut
  }

  /// Норма: поиски внутри run вместе осматривают не больше tiles тайлов (`withSearchQuota`).
  pub fn with_quota<R>(&mut self, tiles: f64, run: impl FnOnce(&mut Self) -> R) -> R {
    let previous = self.cap;
    self.cap = self.cap.min(self.searched + tiles.max(0.0));
    self.cut = false;
    let result = run(self);
    self.cap = previous;
    result
  }

  /// Норма для run, который берёт поиск сам (через Sim): ставит и снимает её вокруг.
  pub fn open_quota(&mut self, tiles: f64) -> f64 {
    let previous = self.cap;
    self.cap = self.cap.min(self.searched + tiles.max(0.0));
    self.cut = false;
    previous
  }

  pub fn close_quota(&mut self, previous: f64) {
    self.cap = previous;
  }

  /// Кратчайший путь по тайлам (`findPath`): тайлы подряд x, y, без начального; не дойти — к ближайшему к цели.
  #[allow(clippy::too_many_arguments)]
  pub fn find_path(&mut self, grid: &mut dyn Grid, from_x: i32, from_y: i32, to_x: i32, to_y: i32, near: f64, limit: f64, fastest: f64) -> Vec<i32> {
    let narrowed = self.cap - self.searched < limit;
    self.cut = false;
    let limit = limit.min(self.cap - self.searched);
    if limit <= 0.0 {
      self.cut = true;
      return Vec::new();
    }
    let path = self.search(grid, from_x, from_y, to_x, to_y, near, limit, fastest);
    self.cut = narrowed && self.searched >= self.cap;
    path
  }

  #[allow(clippy::too_many_arguments)]
  fn search(&mut self, grid: &mut dyn Grid, from_x: i32, from_y: i32, to_x: i32, to_y: i32, near: f64, mut limit: f64, fastest: f64) -> Vec<i32> {
    if !beyond_window(from_x, from_y, to_x, to_y) {
      if let Some(path) = self.near_path(grid, from_x, from_y, to_x, to_y, near, limit, fastest, false) {
        return path;
      }
    } else if let Some(path) = self.near_path(grid, from_x, from_y, to_x, to_y, near, limit, fastest, true) {
      if !path.is_empty() {
        return path;
      }
    }
    limit = limit.min(self.cap - self.searched);
    if limit <= 0.0 {
      return Vec::new();
    }
    self.far_path(grid, from_x, from_y, to_x, to_y, near, limit, fastest)
  }

  /// Поиск внутри окна вокруг старта (`findNearPath`); None — цель не найдена, а поиск упёрся в край окна.
  #[allow(clippy::too_many_arguments)]
  fn near_path(&mut self, grid: &mut dyn Grid, from_x: i32, from_y: i32, to_x: i32, to_y: i32, near: f64, limit: f64, fastest: f64, partial: bool) -> Option<Vec<i32>> {
    let size = (WINDOW * WINDOW) as usize;
    if self.stamps.is_empty() {
      self.stamps = vec![0; size];
      self.costs = vec![0.0; size];
      self.parents = vec![0; size];
      self.passable = vec![0; size];
      self.prices = vec![0.0; size];
    }
    self.generation = self.generation.wrapping_add(1);
    let current = self.generation;
    let (origin_x, origin_y) = (from_x - HALF, from_y - HALF);
    let distance = |x: i32, y: i32| {
      let (dx, dy) = ((to_x - x).abs() as f64, (to_y - y).abs() as f64);
      (dx.max(dy) + (DIAGONAL - 1.0) * dx.min(dy)) * fastest
    };
    let start = (HALF * WINDOW + HALF) as usize;
    self.stamps[start] = current;
    self.costs[start] = 0.0;
    self.passable[start] = 1;
    let mut open = Heap::new();
    open.push(start as i64, distance(from_x, from_y));
    let (mut closest, mut closest_distance) = (start, distance(from_x, from_y));
    let (mut visited, mut found, mut edge) = (0.0, false, false);
    let free = |search: &mut Search, grid: &mut dyn Grid, index: usize, x: i32, y: i32| {
      if search.stamps[index] != current {
        search.stamps[index] = current;
        search.costs[index] = f64::INFINITY;
        search.passable[index] = grid.walkable(x, y) as u8;
        search.prices[index] = if search.passable[index] == 1 { grid.slowness(x, y) } else { f64::INFINITY };
      }
      search.passable[index] == 1
    };
    while !open.items.is_empty() && {
      let go = visited < limit;
      visited += 1.0;
      go
    } {
      let at = open.pop() as usize;
      let local_x = at as i32 % WINDOW;
      let local_y = (at as i32 - local_x) / WINDOW;
      let (x, y) = (local_x + origin_x, local_y + origin_y);
      let arrived = if near != 0.0 { (((x - to_x) * (x - to_x) + (y - to_y) * (y - to_y)) as f64) <= near * near } else { x == to_x && y == to_y };
      if arrived {
        closest = at;
        found = true;
        break;
      }
      let reached = self.costs[at];
      for (dx, dy, price) in STEPS {
        let (next_x, next_y) = (local_x + dx, local_y + dy);
        if next_x < 0 || next_y < 0 || next_x >= WINDOW || next_y >= WINDOW {
          edge = true;
          continue;
        }
        let next = (next_y * WINDOW + next_x) as usize;
        if !free(self, grid, next, x + dx, y + dy) {
          continue;
        }
        if dx != 0 && dy != 0 && (!free(self, grid, (at as i32 + dx) as usize, x + dx, y) || !free(self, grid, (at as i32 + dy * WINDOW) as usize, x, y + dy)) {
          continue;
        }
        let total = reached + price * self.prices[next];
        if total >= self.costs[next] {
          continue;
        }
        self.costs[next] = total;
        self.parents[next] = at as i32;
        let left = distance(x + dx, y + dy);
        if left < closest_distance {
          closest = next;
          closest_distance = left;
        }
        open.push(next as i64, total + left);
      }
    }
    self.searched += visited;
    if !found && edge && !partial {
      return None;
    }
    let mut path = Vec::new();
    let mut at = closest;
    while at != start {
      path.push(at as i32 / WINDOW + origin_y);
      path.push(at as i32 % WINDOW + origin_x);
      at = self.parents[at] as usize;
    }
    path.reverse();
    Some(path)
  }

  /// То же без окна: тайлы — в словарях (`findFarPath`).
  #[allow(clippy::too_many_arguments)]
  fn far_path(&mut self, grid: &mut dyn Grid, from_x: i32, from_y: i32, to_x: i32, to_y: i32, near: f64, limit: f64, fastest: f64) -> Vec<i32> {
    const SPAN: i64 = 1 << 15;
    let key = |x: i32, y: i32| (y as i64 - from_y as i64 + SPAN / 2) * SPAN + (x as i64 - from_x as i64 + SPAN / 2);
    let distance = |x: i32, y: i32| {
      let (dx, dy) = ((to_x - x).abs() as f64, (to_y - y).abs() as f64);
      (dx.max(dy) + (DIAGONAL - 1.0) * dx.min(dy)) * fastest
    };
    let mut cost: HashMap<i64, f64> = HashMap::new();
    let mut parent: HashMap<i64, i64> = HashMap::new();
    let mut open = Heap::new();
    let start = key(from_x, from_y);
    cost.insert(start, 0.0);
    open.push(start, distance(from_x, from_y));
    let (mut closest, mut closest_distance) = (start, distance(from_x, from_y));
    let mut visited = 0.0;
    while !open.items.is_empty() && {
      let go = visited < limit;
      visited += 1.0;
      go
    } {
      let current = open.pop();
      let x = (current % SPAN) as i32 + from_x - (SPAN / 2) as i32;
      let y = (current / SPAN) as i32 + from_y - (SPAN / 2) as i32;
      let arrived = if near != 0.0 { (((x - to_x) * (x - to_x) + (y - to_y) * (y - to_y)) as f64) <= near * near } else { x == to_x && y == to_y };
      if arrived {
        closest = current;
        break;
      }
      let reached = cost[&current];
      for (dx, dy, price) in STEPS {
        let (next_x, next_y) = (x + dx, y + dy);
        if !grid.walkable(next_x, next_y) {
          continue;
        }
        if dx != 0 && dy != 0 && (!grid.walkable(next_x, y) || !grid.walkable(x, next_y)) {
          continue;
        }
        let next = key(next_x, next_y);
        let total = reached + price * grid.slowness(next_x, next_y);
        if total >= cost.get(&next).copied().unwrap_or(f64::INFINITY) {
          continue;
        }
        cost.insert(next, total);
        parent.insert(next, current);
        let left = distance(next_x, next_y);
        if left < closest_distance {
          closest = next;
          closest_distance = left;
        }
        open.push(next, total + left);
      }
    }
    self.searched += visited;
    let mut path = Vec::new();
    let mut at = closest;
    while at != start {
      path.push((at / SPAN) as i32 + from_y - (SPAN / 2) as i32);
      path.push((at % SPAN) as i32 + from_x - (SPAN / 2) as i32);
      at = parent[&at];
    }
    path.reverse();
    path
  }
}

/// Свободен ли прямой путь между точками с запасом по бокам и не медленнее концов (`isClear`).
pub fn is_clear(grid: &mut dyn Grid, from_x: f64, from_y: f64, to_x: f64, to_y: f64) -> bool {
  let (dx, dy) = (to_x - from_x, to_y - from_y);
  let length = js_hypot(dx, dy);
  if length == 0.0 {
    return grid.walkable(from_x.floor() as i32, from_y.floor() as i32);
  }
  let side_x = (-dy / length) * CLEARANCE;
  let side_y = (dx / length) * CLEARANCE;
  let steps = (length / 0.2).ceil();
  let from = grid.slowness(from_x.floor() as i32, from_y.floor() as i32);
  let to = grid.slowness(to_x.floor() as i32, to_y.floor() as i32);
  // С дороги прямая не сходит: срезав по обочине, юнит ехал бы медленнее, чем по найденному пути.
  let slowest = if from.min(to) < 1.0 { from.min(to) } else { from.max(to) };
  let mut i = 0.0;
  while i <= steps {
    let x = from_x + (dx * i) / steps;
    let y = from_y + (dy * i) / steps;
    if !grid.walkable((x + side_x).floor() as i32, (y + side_y).floor() as i32) {
      return false;
    }
    if !grid.walkable((x - side_x).floor() as i32, (y - side_y).floor() as i32) {
      return false;
    }
    if grid.slowness(x.floor() as i32, y.floor() as i32) > slowest {
      return false;
    }
    i += 1.0;
  }
  true
}

/// Спрямляет путь (`smoothPath`): дальняя видная точка — скачками вдвое, потом делением пополам.
pub fn smooth_path(grid: &mut dyn Grid, from_x: f64, from_y: f64, points: &[f64]) -> Vec<f64> {
  let mut result = Vec::new();
  let (mut anchor_x, mut anchor_y) = (from_x, from_y);
  let mut at = 0usize;
  while at < points.len() {
    let visible = |grid: &mut dyn Grid, anchor_x: f64, anchor_y: f64, index: usize| is_clear(grid, anchor_x, anchor_y, points[index], points[index + 1]);
    let mut next = at;
    let mut step = 2usize;
    while next + step < points.len() && visible(grid, anchor_x, anchor_y, next + step) {
      next += step;
      step *= 2;
    }
    step >>= 1;
    while step >= 2 {
      let far = (next + step).min(points.len() - 2);
      if far > next && visible(grid, anchor_x, anchor_y, far) {
        next = far;
      }
      step >>= 1;
    }
    anchor_x = points[next];
    anchor_y = points[next + 1];
    result.push(anchor_x);
    result.push(anchor_y);
    at = next + 2;
  }
  result
}
