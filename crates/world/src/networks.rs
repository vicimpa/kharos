//! Сети (zones.ts): связные группы сущностей со связью (`Link`) одного владельца и энергосети — сети, слитые по
//! касанию кругов. Движок не знает, что по ним течёт: энергию, груз или что-то ещё решает контент. Пересчитываются,
//! только когда сменился состав связанных — появилась, пропала, перешла к другому или сменила связь сущность.
//!
//! Связь (`Link`) у основания width × height с серединой в `Position`:
//! - `radius` — круг вокруг середины: из кругов складывается зона сети, по ним сети сливаются в энергосети;
//! - `group` — стык: стоящие вплотную, сторона к стороне, сущности одной группы связаны и без проводника;
//! - `conduit` — проводник (труба): связан со всеми связанными своего владельца, что стоят вплотную;
//! - `tunnel` — подземный отрезок: на столько тайлов по прямой вправо и вниз проводник ищет ближайший проводник своей
//!   группы с отрезком (колодец к колодцу);
//! - `core` — сеть с ней идёт первой у своего владельца, а она — первой в сети (главное здание);
//! - `leaf` — лист (стройка): входит в сеть первого проводника или сущности своей группы, к которой стоит вплотную,
//!   но сам сети не составляет, зону не расширяет, в энергосеть не входит, и пути по сети сквозь него не идут.
//!
//! Пути (`distances`, `route`) — кратчайшие по рёбрам сети, Дейкстрой; пересчитываются вместе с сетями.

use crate::motion::Occupancy;
use crate::world::{Entity, World};
use std::collections::HashMap;

/// Сеть или энергосеть.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Network {
  pub player: f64,
  /// Круги зоны: x, y и радиус подряд.
  pub circles: Vec<f64>,
  /// Связанные, начиная с ядра, если оно есть.
  pub members: Vec<Entity>,
  /// Граф сети: рёбра a, b и длина в тайлах подряд. У энергосети пуст.
  pub edges: Vec<f64>,
  /// Листья, вошедшие в сеть: стройки, к которым подведена труба. У энергосети пуст.
  pub leaves: Vec<Entity>,
}

/// Связанная сущность: основание тайлами и поля связи.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Member {
  entity: Entity,
  player: f64,
  x: f64,
  y: f64,
  left: i32,
  top: i32,
  right: i32,
  bottom: i32,
  radius: f64,
  group: f64,
  conduit: bool,
  tunnel: i32,
  core: bool,
  leaf: bool,
}

/// Кратчайшие пути от узла: длина до каждого узла сети и следующий шаг к началу.
#[derive(Clone, Debug, Default)]
pub struct Routes {
  pub dist: HashMap<Entity, f64>,
  pub next: HashMap<Entity, Entity>,
}

/// Посчитанные сети мира.
#[derive(Clone, Debug, Default)]
pub struct Networks {
  /// Состав, по которому посчитано: правка мира, и если она другая — связанные со всеми полями связи.
  revision: Option<u64>,
  seen: Vec<Member>,
  networks: Vec<Network>,
  grids: Vec<Network>,
  /// В какой сети каждый узел и лист; пути от узлов.
  index: HashMap<Entity, usize>,
  routes: HashMap<Entity, Routes>,
  /// Середины узлов: по ним путь пачки сжимается до поворотов.
  centers: HashMap<Entity, (f64, f64)>,
  /// Растёт с каждым пересчётом: по нему контент знает, что сети перестроились.
  pub version: u64,
}

impl Networks {
  /// Сети всех игроков: по порядку игроков (кто раньше появился), у каждого — сначала с ядром.
  pub fn networks(&mut self, world: &World) -> &[Network] {
    self.refresh(world);
    &self.networks
  }

  /// Энергосети всех игроков, в том же порядке.
  pub fn grids(&mut self, world: &World) -> &[Network] {
    self.refresh(world);
    &self.grids
  }

  /// Номер пересчёта сетей.
  pub fn version(&mut self, world: &World) -> u64 {
    self.refresh(world);
    self.version
  }

  /// Сеть, в которую входит узел или лист.
  pub fn network_of(&mut self, world: &World, entity: Entity) -> Option<&Network> {
    self.refresh(world);
    let at = *self.index.get(&entity)?;
    self.networks.get(at)
  }

  /// Кратчайшие пути по рёбрам сети от узла start (routesFrom): сквозь листья путь не идёт.
  pub fn distances(&mut self, world: &World, start: Entity) -> Option<&Routes> {
    self.refresh(world);
    let at = *self.index.get(&start)?;
    if !self.routes.contains_key(&start) {
      let network = &self.networks[at];
      let mut links: HashMap<Entity, Vec<(Entity, f64)>> = HashMap::new();
      for edge in network.edges.chunks_exact(3) {
        let (a, b, length) = (edge[0] as Entity, edge[1] as Entity, edge[2]);
        links.entry(a).or_default().push((b, length));
        links.entry(b).or_default().push((a, length));
      }
      let leaves: std::collections::HashSet<Entity> = network.leaves.iter().copied().collect();
      let mut routes = Routes::default();
      routes.dist.insert(start, 0.0);
      let mut heap = std::collections::BinaryHeap::new();
      heap.push(Step(0.0, start));
      while let Some(Step(length, node)) = heap.pop() {
        if length > routes.dist[&node] {
          continue;
        }
        if node != start && leaves.contains(&node) {
          continue;
        }
        for &(other, step) in links.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
          let total = length + step;
          if total >= *routes.dist.get(&other).unwrap_or(&f64::INFINITY) {
            continue;
          }
          routes.dist.insert(other, total);
          routes.next.insert(other, node);
          heap.push(Step(total, other));
        }
      }
      self.routes.insert(start, routes);
    }
    self.routes.get(&start)
  }

  /// Путь пачки от from к to по кратчайшим путям (pathOf): узлы, где путь поворачивает, с началом и концом.
  pub fn route(&mut self, world: &World, from: Entity, to: Entity) -> Vec<Entity> {
    let Some(routes) = self.distances(world, to) else { return Vec::new() };
    if !routes.dist.contains_key(&from) {
      return Vec::new();
    }
    let mut nodes = vec![from];
    let mut node = from;
    while node != to {
      node = routes.next[&node];
      nodes.push(node);
    }
    if nodes.len() <= 2 {
      return nodes;
    }
    let direction = |a: Entity, b: Entity| {
      let (one, two) = (self.centers[&a], self.centers[&b]);
      ((two.0 - one.0).signum() as i32 * ((two.0 - one.0).abs() > 1e-9) as i32, (two.1 - one.1).signum() as i32 * ((two.1 - one.1).abs() > 1e-9) as i32)
    };
    let mut path = vec![from];
    for i in 1..nodes.len() - 1 {
      if direction(nodes[i - 1], nodes[i]) != direction(nodes[i], nodes[i + 1]) {
        path.push(nodes[i]);
      }
    }
    path.push(to);
    path
  }

  fn refresh(&mut self, world: &World) {
    if self.revision == Some(world.revision) {
      return;
    }
    self.revision = Some(world.revision);
    let members = members(world);
    if members == self.seen && self.version > 0 {
      return;
    }
    self.seen = members.clone();
    let (nodes, leaves): (Vec<Member>, Vec<Member>) = members.iter().partition(|member| !member.leaf);
    self.networks = compute(&nodes, &leaves);
    self.index.clear();
    self.routes.clear();
    self.centers = members.iter().map(|member| (member.entity, (member.x, member.y))).collect();
    for (at, network) in self.networks.iter().enumerate() {
      for &entity in network.members.iter().chain(&network.leaves) {
        self.index.insert(entity, at);
      }
    }
    let members = nodes;
    let mut players: Vec<f64> = Vec::new();
    for network in &self.networks {
      if !players.contains(&network.player) {
        players.push(network.player);
      }
    }
    let by_entity: HashMap<Entity, &Member> = members.iter().map(|member| (member.entity, member)).collect();
    self.grids = players
      .iter()
      .flat_map(|&player| {
        let list: Vec<&Network> = self.networks.iter().filter(|network| network.player == player).collect();
        merge_touching(&by_entity, &list)
      })
      .collect();
    self.version += 1;
  }
}

/// Связанные сущности по возрастанию номеров.
fn members(world: &World) -> Vec<Member> {
  let schema = &world.schema;
  let (Some(link), Some(owner), Some(position)) = (schema.id("Link"), schema.id("Owner"), schema.id("Position")) else { return Vec::new() };
  let field = |component: usize, name: &str| schema.components[component].field(name).expect("поле движка").slot;
  let (radius, group, conduit, tunnel, core, leaf) = (field(link, "radius"), field(link, "group"), field(link, "conduit"), field(link, "tunnel"), field(link, "core"), field(link, "leaf"));
  let (width, height, player) = (field(link, "width"), field(link, "height"), field(owner, "player"));
  let store = &world.stores[link];
  let mut list = Vec::with_capacity(store.len());
  for (row, &entity) in store.entities.iter().enumerate() {
    let (Some(at), Some(own)) = (world.stores[position].row(entity), world.stores[owner].row(entity)) else { continue };
    let (x, y) = (world.stores[position].nums[0][at], world.stores[position].nums[1][at]);
    let (left, top, right, bottom) = Occupancy::tiles_of(x, y, store.nums[width][row], store.nums[height][row]);
    list.push(Member {
      entity,
      player: world.stores[owner].nums[player][own],
      x,
      y,
      left,
      top,
      right,
      bottom,
      radius: store.nums[radius][row],
      group: store.nums[group][row],
      conduit: store.nums[conduit][row] != 0.0,
      tunnel: store.nums[tunnel][row] as i32,
      core: store.nums[core][row] != 0.0,
      leaf: store.nums[leaf][row] != 0.0,
    });
  }
  list.sort_unstable_by_key(|member| member.entity);
  list
}

/// Корень множества с сокращением путей.
fn find(parent: &mut [usize], mut index: usize) -> usize {
  let mut root = index;
  while parent[root] != root {
    root = parent[root];
  }
  while parent[index] != root {
    let next = parent[index];
    parent[index] = root;
    index = next;
  }
  root
}

/// Сети по связанным (computeZones) и листья в них.
fn compute(members: &[Member], leaves: &[Member]) -> Vec<Network> {
  // Тайл → номер связанного.
  let mut tiles: HashMap<(i32, i32), usize> = HashMap::new();
  for (index, member) in members.iter().enumerate() {
    for y in member.top..member.bottom {
      for x in member.left..member.right {
        tiles.insert((x, y), index);
      }
    }
  }
  let mut parent: Vec<usize> = (0..members.len()).collect();
  let mut edges: Vec<(usize, usize, f64)> = Vec::new();
  let mut link = |parent: &mut Vec<usize>, a: usize, b: usize, length: f64| {
    edges.push((a, b, length));
    let (one, two) = (find(parent, a), find(parent, b));
    if one != two {
      parent[two] = one;
    }
  };
  // Соседи по сторонам основания, каждый раз (neighbours): по углу соседом не считаются.
  let neighbours = |member: &Member, index: usize| -> Vec<usize> {
    let mut found: Vec<usize> = Vec::new();
    let mut see = |x: i32, y: i32| {
      if let Some(&other) = tiles.get(&(x, y)) {
        if other != index && !found.contains(&other) {
          found.push(other);
        }
      }
    };
    for x in member.left..member.right {
      see(x, member.top - 1);
      see(x, member.bottom);
    }
    for y in member.top..member.bottom {
      see(member.left - 1, y);
      see(member.right, y);
    }
    found
  };
  for (index, member) in members.iter().enumerate() {
    if !member.conduit {
      continue;
    }
    for other in neighbours(member, index) {
      let there = &members[other];
      if there.player != member.player {
        continue;
      }
      // Два соседних проводника видят друг друга дважды: ребро — от меньшего.
      if there.conduit && there.entity < member.entity {
        continue;
      }
      link(&mut parent, index, other, 1.0);
    }
    if member.tunnel < 2 {
      continue;
    }
    // Подземный отрезок — к ближайшему своему проводнику с отрезком вправо и вниз: влево и вверх его найдёт тот.
    for (dx, dy) in [(1, 0), (0, 1)] {
      for step in 2..=member.tunnel {
        let Some(&other) = tiles.get(&(member.left + dx * step, member.top + dy * step)) else { continue };
        let there = &members[other];
        if there.player != member.player || !there.conduit || there.tunnel < 2 || there.group != member.group {
          continue;
        }
        link(&mut parent, index, other, step as f64);
        break;
      }
    }
  }
  // Стоящие вплотную: стык — от меньшего к большему, только в одной группе, длина — путь между серединами по сторонам.
  for (index, member) in members.iter().enumerate() {
    if member.conduit || member.group == 0.0 {
      continue;
    }
    for other in neighbours(member, index) {
      let there = &members[other];
      if there.entity < member.entity || there.player != member.player || there.conduit || there.group != member.group {
        continue;
      }
      let length = (there.x - member.x).abs() + (there.y - member.y).abs();
      link(&mut parent, index, other, length.round().max(1.0));
    }
  }

  let mut by_root: HashMap<usize, usize> = HashMap::new();
  let mut networks: Vec<Network> = Vec::new();
  let mut players: Vec<f64> = Vec::new();
  for (index, member) in members.iter().enumerate() {
    let root = find(&mut parent, index);
    let at = *by_root.entry(root).or_insert_with(|| {
      networks.push(Network { player: member.player, ..Default::default() });
      networks.len() - 1
    });
    if !players.contains(&member.player) {
      players.push(member.player);
    }
    let network = &mut networks[at];
    network.circles.extend_from_slice(&[member.x, member.y, member.radius]);
    if member.core {
      network.members.insert(0, member.entity);
    } else {
      network.members.push(member.entity);
    }
  }
  for (a, b, length) in edges {
    let at = by_root[&find(&mut parent, a)];
    networks[at].edges.extend_from_slice(&[members[a].entity as f64, members[b].entity as f64, length]);
  }
  // По игрокам, у каждого — сети с ядром первыми: по первой сети подача показывает его энергию.
  let is_core: HashMap<Entity, bool> = members.iter().map(|member| (member.entity, member.core)).collect();
  let led = |network: &Network| network.members.first().is_some_and(|entity| is_core[entity]);
  let mut ordered = Vec::with_capacity(networks.len());
  for player in players {
    let (cores, rest): (Vec<Network>, Vec<Network>) = networks.iter().filter(|network| network.player == player).cloned().partition(|network| led(network));
    ordered.extend(cores);
    ordered.extend(rest);
  }
  // Лист входит в сеть первого проводника или сущности своей группы, к которой стоит сбоку; касается двух разных
  // сетей — первой.
  let network_of: HashMap<Entity, usize> = ordered.iter().enumerate().flat_map(|(at, network)| network.members.iter().map(move |&entity| (entity, at))).collect();
  for leaf in leaves {
    let mut joined: Option<usize> = None;
    let mut touches: Vec<Entity> = Vec::new();
    let mut touch = |x: i32, y: i32| {
      let Some(&index) = tiles.get(&(x, y)) else { return };
      let other = &members[index];
      if other.player != leaf.player || !(other.conduit || (other.group == leaf.group && leaf.group != 0.0)) {
        return;
      }
      let at = network_of[&other.entity];
      if joined.is_some_and(|joined| joined != at) {
        return;
      }
      joined = Some(at);
      touches.push(other.entity);
    };
    for x in leaf.left..leaf.right {
      touch(x, leaf.top - 1);
      touch(x, leaf.bottom);
    }
    for y in leaf.top..leaf.bottom {
      touch(leaf.left - 1, y);
      touch(leaf.right, y);
    }
    if let Some(at) = joined {
      let network = &mut ordered[at];
      network.leaves.push(leaf.entity);
      for other in touches {
        network.edges.extend_from_slice(&[leaf.entity as f64, other as f64, 1.0]);
      }
    }
  }
  ordered
}

/// Расстояние от точки до основания (linkGap): так меряют, задевает ли основание круг.
fn link_gap(cx: f64, cy: f64, member: &Member) -> f64 {
  let (x, y) = (member.left as f64, member.top as f64);
  let (width, height) = ((member.right - member.left) as f64, (member.bottom - member.top) as f64);
  (x - cx).max(0.0).max(cx - x - width).hypot((y - cy).max(0.0).max(cy - y - height))
}

/// Сливает сети одного игрока, задевающие друг друга, в энергосети (mergeTouching): основание связанного одной сети
/// задевает круг другой. Порядок — как у сетей, ядро — первым.
fn merge_touching(members: &HashMap<Entity, &Member>, networks: &[&Network]) -> Vec<Network> {
  let mut parent: Vec<usize> = (0..networks.len()).collect();
  let touches = |base: &Network, circles: &[f64]| {
    base.members.iter().any(|entity| {
      let member = members[entity];
      circles.chunks_exact(3).any(|circle| link_gap(circle[0], circle[1], member) <= circle[2])
    })
  };
  for a in 0..networks.len() {
    for b in a + 1..networks.len() {
      if find(&mut parent, a) == find(&mut parent, b) {
        continue;
      }
      if touches(networks[a], &networks[b].circles) || touches(networks[b], &networks[a].circles) {
        let (one, two) = (find(&mut parent, a), find(&mut parent, b));
        parent[two] = one;
      }
    }
  }
  let is_core = |network: &Network| network.members.first().is_some_and(|entity| members[entity].core);
  let mut merged: Vec<(usize, Network)> = Vec::new();
  for (index, network) in networks.iter().enumerate() {
    let root = find(&mut parent, index);
    match merged.iter_mut().find(|(other, _)| *other == root) {
      None => merged.push((root, Network { player: network.player, circles: network.circles.clone(), members: network.members.clone(), ..Default::default() })),
      Some((_, grid)) => {
        grid.circles.extend_from_slice(&network.circles);
        if is_core(network) && !is_core(grid) {
          grid.members.splice(0..0, network.members.iter().copied());
        } else {
          grid.members.extend_from_slice(&network.members);
        }
      }
    }
  }
  merged.into_iter().map(|(_, grid)| grid).collect()
}

/// Сети таблицами Luau: { player, members, circles[, edges] } списком.
pub fn to_lua(lua: &mlua::Lua, networks: &[Network], edges: bool) -> mlua::Result<mlua::Table> {
  let list = lua.create_table();
  for (index, network) in networks.iter().enumerate() {
    let table = lua.create_table();
    table.raw_set("player", network.player)?;
    table.raw_set("members", lua.create_sequence_from(network.members.iter().copied())?)?;
    table.raw_set("circles", lua.create_sequence_from(network.circles.iter().copied())?)?;
    if edges {
      table.raw_set("edges", lua.create_sequence_from(network.edges.iter().copied())?)?;
      table.raw_set("leaves", lua.create_sequence_from(network.leaves.iter().copied())?)?;
    }
    list.raw_set(index + 1, table)?;
  }
  Ok(list)
}

/// Шаг поиска: длина и узел, меньшая длина — раньше; при равной — меньший номер.
#[derive(PartialEq)]
struct Step(f64, Entity);

impl Eq for Step {}

impl PartialOrd for Step {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

impl Ord for Step {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    other.0.total_cmp(&self.0).then(other.1.cmp(&self.1))
  }
}
