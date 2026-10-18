//! Сохранения одиночной игры — как `game/storage.ts` у TS: несколько слотов, у каждого своё место. Список с
//! названиями и временем лежит отдельно от самих миров (`saves/index.json`), чтобы меню не разбирало миры целиком;
//! мир слота — `saves/<id>.json`, снимок хоста (`Host::snapshot`) с камерой. Где лежат — store.rs (файлы на нативе,
//! `localStorage` в браузере).

use crate::store;
use serde_json::{json, Map, Value as Json};

/// Миллисекунды эпохи.
pub fn now() -> f64 {
  crate::clock::epoch_millis()
}

/// Слоты: список — объекты JSON `{ id, name, created, updated, tick, game, options, camera? }`.
pub struct Saves {
  index: Vec<Map<String, Json>>,
}

impl Saves {
  pub fn load() -> Self {
    let index = store::read("saves/index.json").and_then(|text| serde_json::from_str::<Vec<Json>>(&text).ok()).unwrap_or_default();
    let index = index.into_iter().filter_map(|slot| match slot {
      Json::Object(map) if map.get("id").is_some_and(Json::is_string) => Some(map),
      _ => None,
    });
    Self { index: index.collect() }
  }

  /// Слоты, свежие первыми.
  pub fn list(&self) -> Vec<Map<String, Json>> {
    let mut list = self.index.clone();
    list.sort_by(|a, b| b.get("updated").and_then(Json::as_f64).unwrap_or(0.0).total_cmp(&a.get("updated").and_then(Json::as_f64).unwrap_or(0.0)));
    list
  }

  pub fn get(&self, id: &str) -> Option<&Map<String, Json>> {
    self.index.iter().find(|slot| slot.get("id").and_then(Json::as_str) == Some(id))
  }

  fn get_mut(&mut self, id: &str) -> Option<&mut Map<String, Json>> {
    self.index.iter_mut().find(|slot| slot.get("id").and_then(Json::as_str) == Some(id))
  }

  /// Новый слот: мира ещё нет, он заведётся по партии и настройкам.
  pub fn create(&mut self, name: &str, game: &str, options: Json) -> String {
    let time = now();
    let id = format!("{:x}", (time as u64) ^ ((self.index.len() as u64 + 1) << 44));
    let slot = json!({ "id": id, "name": name, "created": time, "updated": time, "tick": 0, "game": game, "options": options });
    if let Json::Object(map) = slot {
      self.index.push(map);
    }
    self.write_index();
    id
  }

  pub fn rename(&mut self, id: &str, name: &str) {
    if let Some(slot) = self.get_mut(id) {
      slot.insert("name".into(), Json::from(name));
    }
    self.write_index();
  }

  pub fn remove(&mut self, id: &str) {
    self.index.retain(|slot| slot.get("id").and_then(Json::as_str) != Some(id));
    store::remove(&format!("saves/{id}.json"));
    self.write_index();
  }

  /// Мир слота; None — ещё не сохранён.
  pub fn world(&self, id: &str) -> Option<Json> {
    serde_json::from_str(&store::read(&format!("saves/{id}.json"))?).ok()
  }

  /// Пишет мир слота и отмечает время и тик в списке.
  pub fn store(&mut self, id: &str, tick: u64, camera: Json, world: &Json) {
    if let Some(slot) = self.get_mut(id) {
      slot.insert("updated".into(), Json::from(now()));
      slot.insert("tick".into(), Json::from(tick));
      slot.insert("camera".into(), camera);
    }
    if let Err(error) = store::write(&format!("saves/{id}.json"), &serde_json::to_string(world).unwrap_or_default()) {
      eprintln!("сохранение: {error}");
    }
    self.write_index();
  }

  fn write_index(&self) {
    if let Err(error) = store::write("saves/index.json", &serde_json::to_string_pretty(&self.index).unwrap_or_default()) {
      eprintln!("список сохранений: {error}");
    }
  }
}

const MONTHS: [&str; 12] = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];

/// Дата как у страницы (`toLocaleString` с днём, коротким месяцем, часами и минутами): «18 окт., 06:41».
pub fn date(millis: f64) -> String {
  let seconds = (millis / 1000.0) as i64;
  #[cfg(unix)]
  {
    let time = seconds as libc::time_t;
    let mut parts: libc::tm = unsafe { std::mem::zeroed() };
    if !unsafe { libc::localtime_r(&time, &mut parts) }.is_null() {
      return format!("{} {}, {:02}:{:02}", parts.tm_mday, MONTHS[parts.tm_mon.clamp(0, 11) as usize], parts.tm_hour, parts.tm_min);
    }
  }
  // Без часового пояса — по Гринвичу.
  let days = seconds.div_euclid(86_400);
  let rest = seconds.rem_euclid(86_400);
  let (year_day, month) = civil(days);
  format!("{year_day} {}, {:02}:{:02}", MONTHS[month], rest / 3600, rest % 3600 / 60)
}

/// День месяца и месяц (с нуля) по дням от эпохи.
fn civil(days: i64) -> (i64, usize) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 2 } else { mp - 10 };
  (day, month as usize)
}
