//! Языки интерфейса (packages/i18n в TS). Словарь языка — вид раздела `lang` модов (`lang/ru.luau`): название языка
//! на нём самом, место в списке и вложенные разделы строк; ключ строки — путь через точку, «menu.title». В строке
//! подстановки в фигурных скобках — «{name}», а «{name:lower}» — строчными. Чего в словаре нет, отдаётся как есть: так
//! мод, написавший текст без словаря, всё равно его покажет.

use mlua::{Table, Value};
use std::collections::HashMap;

/// Язык: код (имя вида), название на нём самом и строки по ключам.
pub struct Language {
  pub id: String,
  pub name: String,
  strings: HashMap<String, String>,
}

/// Словари всех языков модов, по месту в списке.
#[derive(Default)]
pub struct Strings {
  pub languages: Vec<Language>,
}

/// Язык, если словаря выбранного нет (preferredLang в TS).
const FALLBACK: &str = "en";

impl Strings {
  /// Словари из `protos.lang`.
  pub fn load(protos: &Table) -> Self {
    let Ok(Some(section)) = protos.get::<Option<Table>>("lang") else { return Self::default() };
    let mut languages: Vec<(f64, Language)> = Vec::new();
    for (id, proto) in section.pairs::<String, Table>().flatten() {
      let mut strings = HashMap::new();
      if let Ok(Some(table)) = proto.get::<Option<Table>>("strings") {
        flatten(&table, "", &mut strings);
      }
      let name = proto.get::<Option<String>>("language").ok().flatten().unwrap_or_else(|| id.clone());
      let order = proto.get::<Option<f64>>("order").ok().flatten().unwrap_or(f64::MAX);
      languages.push((order, Language { id, name, strings }));
    }
    languages.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    Self { languages: languages.into_iter().map(|(_, language)| language).collect() }
  }

  /// Язык, которым говорит интерфейс: выбранный, если у модов есть его словарь, иначе английский, иначе первый.
  pub fn resolve(&self, wanted: &str) -> Option<&Language> {
    let find = |id: &str| self.languages.iter().find(|language| language.id == id);
    find(wanted).or_else(|| find(FALLBACK)).or_else(|| self.languages.first())
  }

  /// Язык игрока: выбранный раньше, иначе первый подходящий из языков системы, иначе английский (preferredLang).
  pub fn pick(&self, saved: Option<&str>, system: &[String]) -> Option<&Language> {
    let has = |id: &str| self.languages.iter().any(|language| language.id == id);
    let wanted = saved.filter(|id| has(id)).or_else(|| system.iter().map(String::as_str).find(|id| has(id))).unwrap_or(FALLBACK);
    self.resolve(wanted)
  }
}

impl Language {
  #[cfg(test)]
  pub fn strings(&self) -> &HashMap<String, String> {
    &self.strings
  }

  /// Строка ключа; нет такой — сам ключ.
  pub fn text<'a>(&'a self, key: &'a str) -> &'a str {
    self.strings.get(key).map_or(key, String::as_str)
  }
}

fn flatten(table: &Table, prefix: &str, out: &mut HashMap<String, String>) {
  for (key, value) in table.pairs::<String, Value>().flatten() {
    match value {
      Value::String(text) => {
        out.insert(format!("{prefix}{key}"), text.to_string_lossy());
      }
      Value::Table(inner) => flatten(&inner, &format!("{prefix}{key}."), out),
      _ => {}
    }
  }
}

/// Подстановки «{name}» и «{name:lower}»: value отдаёт, что подставить; чего нет — остаётся как было.
pub fn substitute(text: &str, mut value: impl FnMut(&str) -> Option<String>) -> String {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(open) = rest.find('{') {
    out.push_str(&rest[..open]);
    let after = &rest[open + 1..];
    let close = after.find('}');
    let inner = close.map(|close| &after[..close]);
    let parsed = inner.and_then(|inner| {
      let (name, modifier) = inner.split_once(':').map_or((inner, None), |(name, modifier)| (name, Some(modifier)));
      let word = |part: &str| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
      (word(name) && modifier.is_none_or(word)).then_some((name, modifier))
    });
    match (parsed, close) {
      (Some((name, modifier)), Some(close)) => {
        match value(name) {
          Some(text) if modifier == Some("lower") => out.push_str(&text.to_lowercase()),
          Some(text) => out.push_str(&text),
          None => out.push_str(&rest[open..open + close + 2]),
        }
        rest = &after[close + 1..];
      }
      _ => {
        out.push('{');
        rest = after;
      }
    }
  }
  out.push_str(rest);
  out
}

/// Языки системы по предпочтению — коды без страны: «ru», «en».
pub fn system() -> Vec<String> {
  #[cfg(not(target_arch = "wasm32"))]
  let tags: Vec<String> = sys_locale::get_locales().collect();
  #[cfg(target_arch = "wasm32")]
  let tags: Vec<String> = web_sys::window().map(|window| window.navigator().languages().iter().filter_map(|tag| tag.as_string()).collect()).unwrap_or_default();
  tags.iter().filter_map(|tag| tag.split(['-', '_']).next()).map(str::to_lowercase).filter(|code| !code.is_empty()).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Словари мода base.
  fn base() -> Strings {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods");
    let mods = kharos_content::mods::discover(&root).expect("моды");
    let content = kharos_content::Content::load(kharos_content::Side::Client, mods).expect("загрузка");
    Strings::load(&content.protos)
  }

  /// Что подставляется в строку: имена без «:lower» — строчными язык пишет по своим правилам.
  fn placeholders(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    substitute(text, |name| {
      names.push(name.to_string());
      None
    });
    names.sort();
    names
  }

  #[test]
  fn dictionaries_match_russian() {
    let strings = base();
    let source = strings.languages.iter().find(|language| language.id == "ru").expect("русский словарь").strings();
    assert!(strings.languages.len() >= 8, "языков: {}", strings.languages.len());
    for language in &strings.languages {
      let mut missing: Vec<&String> = source.keys().filter(|key| !language.strings().contains_key(*key)).collect();
      let mut extra: Vec<&String> = language.strings().keys().filter(|key| !source.contains_key(*key)).collect();
      missing.sort();
      extra.sort();
      assert!(missing.is_empty() && extra.is_empty(), "{}: нет {missing:?}, лишние {extra:?}", language.id);
      for (key, text) in source {
        assert_eq!(placeholders(&language.strings()[key]), placeholders(text), "{}: {key}", language.id);
      }
    }
  }

  #[test]
  fn fonts_draw_every_letter_of_every_language() {
    let faces: Vec<fontdue::Font> = crate::FONTS.iter().map(|bytes| fontdue::Font::from_bytes(*bytes, fontdue::FontSettings::default()).expect("шрифт")).collect();
    for language in &base().languages {
      let mut absent: Vec<char> = language.strings().values().chain(std::iter::once(&language.name)).flat_map(|text| text.chars()).filter(|ch| !ch.is_whitespace() && !crate::gui::FALLBACK.iter().any(|(drawn, _)| drawn == ch) && faces.iter().any(|face| face.lookup_glyph_index(*ch) == 0)).collect();
      absent.sort();
      absent.dedup();
      assert!(absent.is_empty(), "{}: шрифтам не хватает {absent:?}", language.id);
    }
  }

  #[test]
  fn placeholders_take_values_lowercase_and_stay_when_missing() {
    let values = |name: &str| match name {
      "name" => Some("Металл".to_string()),
      "count" => Some("5".to_string()),
      _ => None,
    };
    assert_eq!(substitute("Месторождение: {name:lower}", values), "Месторождение: металл");
    assert_eq!(substitute("{name} ×{count}", values), "Металл ×5");
    assert_eq!(substitute("{other} и {", values), "{other} и {");
    assert_eq!(substitute("{a b}", values), "{a b}");
  }
}
