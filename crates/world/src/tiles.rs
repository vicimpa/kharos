//! Слои карты партии (docs/layers.md): то, что лежит по тайлам и не сущность, — покрытие и прочее. Слой объявляет мод
//! видом раздела `layers/` (`data = { scope = "world", shape = "grid", channels = { "u8", … }, save = true }`), хранит
//! движок (`kharos_engine::layers`): чанки 32×32 заводятся при первой записи, пустой слой ничего не весит. Механики
//! читают и пишут слой `ctx:layer`, `ctx:set_layer`, `ctx:layer_in`, подача — `c:layer`, `c:layer_in`.

use kharos_content::Content;
use kharos_engine::layers::{LayerId, LayerSpec, Layers, Owner, Shape, CHUNK};
use mlua::{Table, Value};
use serde_json::{Map, Value as Json};

/// Слои из раздела `layers/` модов: имя вида — имя слоя, `data` — объявление.
pub fn of(content: &Content) -> Result<Layers, String> {
  let mut table = Map::new();
  for proto in content.list.iter().filter(|proto| proto.section == "layers") {
    let data = content.by_id(proto.id).and_then(|kind| kind.get::<Option<Table>>("data").ok().flatten()).ok_or_else(|| format!("layers/{}: нет data", proto.name))?;
    let spec: Json = content.lua.from_value(Value::Table(data)).map_err(|error| format!("layers/{}.data: {error}", proto.name))?;
    table.insert(proto.name.clone(), spec);
  }
  let specs = LayerSpec::parse_all(&Json::Object(table).to_string()).map_err(|error| format!("layers/{error}"))?;
  Ok(Layers::new(specs))
}

/// Слой по имени; нет — ошибка скрипту.
pub fn id(layers: &Layers, name: &str) -> mlua::Result<LayerId> {
  layers.id(name).ok_or_else(|| mlua::Error::runtime(format!("нет слоя layers/{name}")))
}

fn channels(layers: &Layers, id: LayerId) -> usize {
  match &layers.spec(id).shape {
    Shape::Grid { channels } => channels.len(),
    Shape::Items { .. } => 0,
  }
}

/// Канал тайла: номер с нуля; вне слоя — ошибка скрипту.
pub fn channel(layers: &Layers, id: LayerId, channel: Option<usize>) -> mlua::Result<usize> {
  let channel = channel.unwrap_or(0);
  if channel >= channels(layers, id) {
    return Err(mlua::Error::runtime(format!("у слоя {} нет канала {channel}", layers.spec(id).name)));
  }
  Ok(channel)
}

/// Непустые тайлы в прямоугольнике [left, right) × [top, bottom): x, y и значение канала подряд, по строкам.
pub fn within(layers: &Layers, id: LayerId, channel: usize, left: i32, top: i32, right: i32, bottom: i32) -> Vec<f64> {
  let mut found = Vec::new();
  for (cx, cy) in layers.cells(id, Owner::World) {
    let (x0, y0) = (cx * CHUNK, cy * CHUNK);
    if x0 >= right || y0 >= bottom || x0 + CHUNK <= left || y0 + CHUNK <= top {
      continue;
    }
    for y in y0.max(top)..(y0 + CHUNK).min(bottom) {
      for x in x0.max(left)..(x0 + CHUNK).min(right) {
        let value = layers.get(id, Owner::World, x, y, channel);
        if value != 0.0 {
          found.extend([x as f64, y as f64, value]);
        }
      }
    }
  }
  found
}

/// Сохраняемые слои мира: { имя = { x, y, каналы…, x, y, … } } — только непустые тайлы.
pub fn save(layers: &Layers) -> Json {
  let mut saved = Map::new();
  for (id, spec) in layers.specs().enumerate() {
    if !spec.save || matches!(spec.shape, Shape::Items { .. }) {
      continue;
    }
    let count = channels(layers, id);
    let mut flat = Vec::new();
    for (cx, cy) in layers.cells(id, Owner::World) {
      for y in cy * CHUNK..(cy + 1) * CHUNK {
        for x in cx * CHUNK..(cx + 1) * CHUNK {
          let values: Vec<f64> = (0..count).map(|channel| layers.get(id, Owner::World, x, y, channel)).collect();
          if values.iter().any(|&value| value != 0.0) {
            flat.extend([Json::from(x), Json::from(y)]);
            flat.extend(values.into_iter().map(Json::from));
          }
        }
      }
    }
    saved.insert(spec.name.clone(), Json::Array(flat));
  }
  Json::Object(saved)
}

/// Слои из сохранения (`save`) — поверх пустых. Слоя больше нет в модах — его тайлы теряются.
pub fn load(layers: &mut Layers, saved: &Json) {
  let Json::Object(saved) = saved else { return };
  for (name, flat) in saved {
    let (Some(id), Some(flat)) = (layers.id(name), flat.as_array()) else { continue };
    let count = channels(layers, id);
    for tile in flat.chunks(count + 2) {
      if tile.len() < count + 2 {
        break;
      }
      let (Some(x), Some(y)) = (tile[0].as_i64(), tile[1].as_i64()) else { continue };
      for channel in 0..count {
        layers.set(id, Owner::World, x as i32, y as i32, channel, tile[channel + 2].as_f64().unwrap_or(0.0));
      }
    }
  }
}
