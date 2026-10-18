//! Экран загрузки — перенос экрана загрузки из packages/client/src/gui/app.ts: название игры, полоса и «Готовим
//! графику и звук… N%». Пока он на экране, считаются записи звукового банка (audio::Engine::bake): на нативе — в
//! нескольких потоках, у каждого своя машина Luau с теми же модами; в браузере потоков нет — по кусочку за кадр.
//! Партия потом берёт банк готовым.

use crate::audio::{self, Engine};
use crate::gui::{Align, Anchor, Direction, FontName, Fonts, Gui, Leaf, Skin, Style};
use crate::input::Input;
use crate::render::{Renderer, View};
use kharos_content::{Content, Mod, Side};
use mlua::Table;
use std::collections::HashMap;
use std::rc::Rc;

/// Цвета экрана: фон, название, подпись и заполнение полосы (как у TS: '#08111c', bright, soft, teamMid).
const BACKGROUND: [u8; 4] = [0x08, 0x11, 0x1c, 255];
const BRIGHT: [u8; 4] = [0xee, 0xf6, 0xff, 255];
const SOFT: [u8; 4] = [0xb4, 0xc9, 0xdd, 255];
const INK: [u8; 4] = [0x0b, 0x11, 0x1b, 255];
const FILL: [u8; 4] = [0x1f, 0x63, 0xd8, 255];
/// Сколько секунд кадра отдавать расчёту там, где он идёт в том же потоке.
#[cfg(target_arch = "wasm32")]
const BUDGET: f64 = 0.03;

/// Посчитанный вариант записи: имя, номер варианта и каналы сэмплов.
type Part = (String, usize, Vec<Vec<f32>>);

/// Записи банка видов раздела `sounds` в машине Luau content.
fn kinds_of(content: &Content) -> Vec<(String, Table)> {
  content.section("sounds").map(|proto| (proto.name.clone(), content.by_id(proto.id).expect("вид"))).collect()
}

pub struct Loading {
  gui: Gui,
  title: String,
  engine: Rc<Engine>,
  /// Что считать: имя записи, номер варианта (в браузере — по порядку, на нативе их разбирают потоки).
  #[cfg(target_arch = "wasm32")]
  jobs: Vec<(String, usize)>,
  /// Записи, пока у них пришли не все варианты: шина и варианты.
  parts: HashMap<String, (String, Vec<Option<Vec<Vec<f32>>>>)>,
  total: usize,
  done: usize,
  #[cfg(not(target_arch = "wasm32"))]
  results: std::sync::mpsc::Receiver<Result<Part, String>>,
  /// В браузере считает сам экран: машина Luau с модами и её виды.
  #[cfg(target_arch = "wasm32")]
  inline: (Content, Vec<(String, Table)>, usize),
}

impl Loading {
  /// Экран для модов mods и синтезатора engine; None — считать нечего.
  pub fn new(mods: &[Mod], engine: Rc<Engine>, fonts: Fonts) -> Result<Option<Self>, String> {
    let content = Content::load(Side::Client, mods.to_vec()).map_err(|error| error.to_string())?;
    let title = content.manifests.iter().rev().find_map(|manifest| manifest.get::<Option<String>>("title").ok().flatten()).unwrap_or_default();
    let kinds = kinds_of(&content);
    let records = audio::bank_records(&kinds).map_err(|error| format!("звуки sounds/: {error}"))?;
    let mut jobs = Vec::new();
    let mut parts = HashMap::new();
    for (key, variants, bus) in records {
      if engine.has(&key) {
        continue;
      }
      jobs.extend((0..variants).map(|variant| (key.clone(), variant)));
      parts.insert(key, (bus, vec![None; variants]));
    }
    if jobs.is_empty() {
      return Ok(None);
    }
    let total = jobs.len();
    #[cfg(not(target_arch = "wasm32"))]
    {
      let results = spawn(mods, engine.sample_rate(), jobs);
      Ok(Some(Self { gui: Gui::new(fonts), title, engine, parts, total, done: 0, results }))
    }
    #[cfg(target_arch = "wasm32")]
    {
      Ok(Some(Self { gui: Gui::new(fonts), title, engine, jobs, parts, total, done: 0, inline: (content, kinds, 0) }))
    }
  }

  /// Доля посчитанного.
  pub fn share(&self) -> f32 {
    self.done as f32 / self.total.max(1) as f32
  }

  pub fn finished(&self) -> bool {
    self.done >= self.total
  }

  /// Забирает посчитанное; wait — дождаться всего (снимки кадров: им нужен один и тот же счёт кадров).
  pub fn pump(&mut self, wait: bool) -> Result<(), String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
      while !self.finished() {
        let next = if wait { self.results.recv().map_err(|_| "расчёт звуков оборвался".to_string()) } else { self.results.try_recv().map_err(|_| String::new()) };
        match next {
          Ok(part) => self.take(part?),
          Err(error) if error.is_empty() => break,
          Err(error) => return Err(error),
        }
      }
    }
    #[cfg(target_arch = "wasm32")]
    {
      let started = crate::clock::seconds();
      let rate = self.engine.sample_rate();
      while !self.finished() && (wait || crate::clock::seconds() - started < BUDGET) {
        let (key, variant) = self.jobs[self.inline.2].clone();
        self.inline.2 += 1;
        let data = audio::render_record(&self.inline.1, &key, variant, rate).map_err(|error| format!("звуки sounds/: {error}"))?;
        self.take((key, variant, data));
      }
    }
    Ok(())
  }

  /// Вариант пришёл; пришли все варианты записи — она в банк.
  fn take(&mut self, (key, variant, data): Part) {
    self.done += 1;
    let Some((_, list)) = self.parts.get_mut(&key) else { return };
    list[variant] = Some(data);
    if list.iter().all(Option::is_some) {
      let (bus, list) = self.parts.remove(&key).expect("запись");
      self.engine.store(key, bus, list.into_iter().map(Option::unwrap).collect());
    }
  }

  /// Кадр экрана: название, полоса из отрезков, как индикаторы на зданиях, и сколько готово.
  pub fn draw(&mut self, renderer: &mut Renderer, input: &Input, size: [u32; 2]) {
    let share = self.share();
    let gui = &mut self.gui;
    gui.begin(input);
    let width = (input.screen[0] - 32.0).min(320.0);
    let text = |text: String, font: FontName, color: [u8; 4], shadow: bool| Leaf::Text { text, font, color, shadow: shadow.then_some(INK), lift: 2.0, wrap: None, ellipsis: false, lines: Vec::new() };
    let anchor = Anchor { left: Some(0.0), right: Some(0.0), top: Some(0.0), bottom: Some(0.0), ..Default::default() };
    gui.open(Style { anchor: Some(anchor), background: Some(BACKGROUND), direction: Direction::Column, align: Align::Center, justify: Align::Center, gap: 16.0, padding: [0.0, 16.0, 0.0, 16.0], ..Default::default() }, None);
    if !self.title.is_empty() {
      gui.leaf(Style::default(), text(self.title.clone(), FontName::Logo, BRIGHT, true));
    }
    gui.open(Style { skin: Some(Skin::Well), width: Some(width), height: Some(24.0), padding: [4.0; 4], direction: Direction::Row, ..Default::default() }, None);
    gui.open(Style { direction: Direction::Row, gap: 2.0, ..Default::default() }, None);
    let fill = ((width - 8.0) * share).floor();
    let mut x = 0.0;
    while x < fill {
      gui.open(Style { width: Some((fill - x).min(6.0)), height: Some(16.0), background: Some(FILL), ..Default::default() }, None);
      gui.close();
      x += 8.0;
    }
    gui.close();
    gui.close();
    gui.open(Style { height: Some(40.0), direction: Direction::Row, align: Align::Center, ..Default::default() }, None);
    gui.leaf(Style::default(), text(format!("Готовим графику и звук… {}%", (share * 100.0).floor()), FontName::Body, SOFT, true));
    gui.close();
    gui.close();
    gui.finish();
    renderer.clear(size, BACKGROUND);
    let view = View { x: 0.0, y: 0.0, zoom: 1.0, screen: input.screen, scale: input.scale };
    renderer.draw_batch(&gui.batch, &gui.fonts.atlas, &view, false, &[0.0; 12]);
  }
}

/// Потоки расчёта: каждый грузит моды в свою машину Luau и берёт задания по очереди, пока они не кончатся.
#[cfg(not(target_arch = "wasm32"))]
fn spawn(mods: &[Mod], rate: f32, jobs: Vec<(String, usize)>) -> std::sync::mpsc::Receiver<Result<Part, String>> {
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::Arc;
  let (sender, receiver) = std::sync::mpsc::channel();
  let files: Arc<Vec<(String, kharos_content::Files, Option<std::path::PathBuf>)>> = Arc::new(mods.iter().map(|one| (one.name.clone(), (*one.files).clone(), one.dir.clone())).collect());
  let jobs = Arc::new(jobs);
  let next = Arc::new(AtomicUsize::new(0));
  let threads = std::thread::available_parallelism().map_or(4, |count| count.get()).clamp(1, 8).min(jobs.len());
  for _ in 0..threads {
    let (files, jobs, next, sender) = (files.clone(), jobs.clone(), next.clone(), sender.clone());
    std::thread::spawn(move || {
      let mods = files.iter().map(|(name, files, dir)| Mod { name: name.clone(), files: Rc::new(files.clone()), dir: dir.clone() }).collect();
      let content = match Content::load(Side::Client, mods) {
        Ok(content) => content,
        Err(error) => {
          let _ = sender.send(Err(error.to_string()));
          return;
        }
      };
      let kinds = kinds_of(&content);
      loop {
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some((key, variant)) = jobs.get(index) else { break };
        let part = audio::render_record(&kinds, key, *variant, rate).map(|data| (key.clone(), *variant, data)).map_err(|error| format!("звуки sounds/: {error}"));
        if sender.send(part).is_err() {
          break;
        }
      }
    });
  }
  receiver
}
