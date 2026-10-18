//! Сети (zones.ts): связные группы сущностей со связью (`Link`) одного владельца и энергосети — сети, слитые по
//! касанию кругов. Движок не знает, что по ним течёт: энергию, груз или что-то ещё решает контент. Пересчитываются,
//! только когда сменился состав связанных — появилась, пропала или перешла к другому сущность со связью.
//!
//! Связь (`Link`) у основания (`Footprint`) с серединой в `Position`:
//! - `radius` — круг вокруг середины: из кругов складывается зона сети, по ним сети сливаются в энергосети;
//! - `group` — стык: стоящие вплотную, сторона к стороне, сущности одной группы связаны и без проводника;
//! - `conduit` — проводник (труба): связан со всеми связанными своего владельца, что стоят вплотную;
//! - `tunnel` — подземный отрезок: на столько тайлов по прямой вправо и вниз проводник ищет ближайший проводник своей
//!   группы с отрезком (колодец к колодцу);
//! - `core` — сеть с ней идёт первой у своего владельца, а она — первой в сети (главное здание).

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
}

/// Посчитанные сети мира.
#[derive(Clone, Debug, Default)]
pub struct Networks {
  /// Состав, по которому посчитано: правка мира, и если она другая — связанные (сущность, владелец).
  revision: Option<u64>,
  seen: Vec<(Entity, f64)>,
  networks: Vec<Network>,
  grids: Vec<Network>,
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

  fn refresh(&mut self, world: &World) {
    if self.revision == Some(world.revision) {
      return;
    }
    self.revision = Some(world.revision);
    let members = members(world);
    let seen: Vec<(Entity, f64)> = members.iter().map(|member| (member.entity, member.player)).collect();
    if seen == self.seen && self.version > 0 {
      return;
    }
    self.seen = seen;
    self.networks = compute(&members);
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
  let (Some(link), Some(owner), Some(position), Some(footprint)) = (schema.id("Link"), schema.id("Owner"), schema.id("Position"), schema.id("Footprint")) else { return Vec::new() };
  let field = |component: usize, name: &str| schema.components[component].field(name).expect("поле движка").slot;
  let (radius, group, conduit, tunnel, core) = (field(link, "radius"), field(link, "group"), field(link, "conduit"), field(link, "tunnel"), field(link, "core"));
  let (player, width, height) = (field(owner, "player"), field(footprint, "width"), field(footprint, "height"));
  let store = &world.stores[link];
  let mut list = Vec::with_capacity(store.len());
  for (row, &entity) in store.entities.iter().enumerate() {
    let (Some(at), Some(own), Some(base)) = (world.stores[position].row(entity), world.stores[owner].row(entity), world.stores[footprint].row(entity)) else { continue };
    let (x, y) = (world.stores[position].nums[0][at], world.stores[position].nums[1][at]);
    let (left, top, right, bottom) = Occupancy::tiles_of(x, y, world.stores[footprint].nums[width][base], world.stores[footprint].nums[height][base]);
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

/// Сети по связанным (computeZones без строек: стройка в сеть войдёт с логистикой).
fn compute(members: &[Member]) -> Vec<Network> {
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
      None => merged.push((root, Network { player: network.player, circles: network.circles.clone(), members: network.members.clone(), edges: Vec::new() })),
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
    }
    list.raw_set(index + 1, table)?;
  }
  Ok(list)
}
