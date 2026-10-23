//! Экран загрузки — перенос экрана загрузки из packages/client/src/gui/app.ts: название игры, полоса и «Готовим
//! графику и звук… N%». Пока он на экране, считаются записи звукового банка (audio::Engine::bake): на нативе — в
//! нескольких потоках, у каждого своя машина Luau с теми же модами; в браузере — в воркерах (бинарь `kharos-sound`,
//! моды им шлёт страница) и по кусочку за кадр в самой странице. Партия потом берёт банк готовым.

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
  /// Подпись хода на языке игрока (`game.loadingAssets`), с «{percent}».
  progress: String,
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
  /// В браузере считает и сам экран: машина Luau с модами, её виды и номер следующего задания.
  #[cfg(target_arch = "wasm32")]
  inline: (Content, Vec<(String, Table)>, usize),
  /// Воркеры браузера; задания упавшего — снова в очередь.
  #[cfg(target_arch = "wasm32")]
  pool: Option<web::Pool>,
  #[cfg(target_arch = "wasm32")]
  retry: Vec<(String, usize)>,
}

impl Loading {
  /// Экран для модов mods и синтезатора engine; None — считать нечего.
  pub fn new(mods: &[Mod], engine: Rc<Engine>, fonts: Fonts, language: Option<&str>, system: &[String]) -> Result<Option<Self>, String> {
    let content = Content::load(Side::Client, mods.to_vec()).map_err(|error| error.to_string())?;
    let strings = crate::lang::Strings::load(&content.protos);
    let progress = strings.pick(language, system).map_or("{percent}%", |language| language.text("game.loadingAssets")).to_string();
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
      Ok(Some(Self { gui: Gui::new(fonts), title, progress, engine, parts, total, done: 0, results }))
    }
    #[cfg(target_arch = "wasm32")]
    {
      let pool = web::Pool::new(mods, jobs.len());
      Ok(Some(Self { gui: Gui::new(fonts), title, progress, engine, jobs, parts, total, done: 0, inline: (content, kinds, 0), pool, retry: Vec::new() }))
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
      let rate = self.engine.sample_rate();
      // Воркеры: что пришло — в банк, свободным — следующие задания.
      if let Some(mut pool) = self.pool.take() {
        for event in pool.events() {
          match event {
            web::Event::Done(part) => self.take(part),
            web::Event::Failed(job) => self.retry.extend(job),
            web::Event::Error(error) => return Err(format!("звуки sounds/: {error}")),
          }
        }
        while let Some(slot) = pool.idle() {
          let Some(job) = self.next_job() else { break };
          pool.give(slot, job, rate);
        }
        if !self.finished() {
          self.pool = Some(pool);
        }
      }
      // И сама страница — в пределах бюджета кадра.
      let started = crate::clock::seconds();
      while !self.finished() && (wait || crate::clock::seconds() - started < BUDGET) {
        let Some((key, variant)) = self.next_job() else { break };
        let data = audio::render_record(&self.inline.1, &key, variant, rate).map_err(|error| format!("звуки sounds/: {error}"))?;
        self.take((key, variant, data));
      }
    }
    Ok(())
  }

  /// Следующее задание: сначала задания упавших воркеров, потом очередь.
  #[cfg(target_arch = "wasm32")]
  fn next_job(&mut self) -> Option<(String, usize)> {
    if let Some(job) = self.retry.pop() {
      return Some(job);
    }
    let job = self.jobs.get(self.inline.2).cloned()?;
    self.inline.2 += 1;
    Some(job)
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
    gui.leaf(Style::default(), text(crate::lang::substitute(&self.progress, |name| (name == "percent").then(|| (share * 100.0).floor().to_string())), FontName::Body, SOFT, true));
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

/// Воркер звуков (бинарь `kharos-sound`): первое сообщение — моды (JSON: [[имя, { путь: текст }]]), дальше — задания
/// (JSON: [запись, вариант, частота]); отвечает «ready», каналами варианта [запись, вариант, Float32Array…] или
/// ["error", текст].
#[cfg(target_arch = "wasm32")]
pub fn worker() {
  use std::cell::RefCell;
  use wasm_bindgen::{closure::Closure, JsCast, JsValue};
  let scope: web_sys::DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
  let machine: Rc<RefCell<Option<(Content, Vec<(String, Table)>)>>> = Rc::new(RefCell::new(None));
  let reply = scope.clone();
  let handler = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
    let fail = |error: String| {
      let message = js_sys::Array::of2(&"error".into(), &error.into());
      let _ = reply.post_message(&message);
    };
    let text = event.data().as_string().unwrap_or_default();
    let request: serde_json::Value = match serde_json::from_str(&text) {
      Ok(value) => value,
      Err(error) => return fail(error.to_string()),
    };
    let mut machine = machine.borrow_mut();
    let Some((_, kinds)) = machine.as_ref() else {
      // Моды: тексты Luau — звукам картинки не нужны.
      let mut mods = Vec::new();
      for entry in request.as_array().into_iter().flatten() {
        let mut files = kharos_content::Files::default();
        for (path, text) in entry[1].as_object().into_iter().flatten() {
          files.files.insert(path.clone(), text.as_str().unwrap_or_default().to_string());
        }
        mods.push(Mod { name: entry[0].as_str().unwrap_or_default().to_string(), files: Rc::new(files), dir: None });
      }
      match Content::load(Side::Client, mods) {
        Ok(content) => {
          let kinds = kinds_of(&content);
          *machine = Some((content, kinds));
          let _ = reply.post_message(&"ready".into());
        }
        Err(error) => fail(error.to_string()),
      }
      return;
    };
    let key = request[0].as_str().unwrap_or_default();
    let variant = request[1].as_u64().unwrap_or(0) as usize;
    let rate = request[2].as_f64().unwrap_or(48000.0) as f32;
    match audio::render_record(kinds, key, variant, rate) {
      Ok(channels) => {
        let message = js_sys::Array::of2(&key.into(), &JsValue::from(variant as u32));
        let transfer = js_sys::Array::new();
        for channel in &channels {
          let samples = js_sys::Float32Array::from(channel.as_slice());
          transfer.push(&samples.buffer());
          message.push(&samples);
        }
        let _ = reply.post_message_with_transfer(&message, &transfer);
      }
      Err(error) => fail(format!("{key}: {error}")),
    }
  });
  scope.set_onmessage(Some(handler.as_ref().unchecked_ref()));
  handler.forget();
  // Wasm загружен и слушает: страница пришлёт моды.
  let _ = scope.post_message(&"ready".into());
}

/// Воркеры страницы: по одному на ядро (одно остаётся странице), не больше восьми.
#[cfg(target_arch = "wasm32")]
mod web {
  use super::Part;
  use kharos_content::Mod;
  use std::cell::RefCell;
  use std::rc::Rc;
  use wasm_bindgen::{closure::Closure, JsCast, JsValue};

  pub enum Event {
    Done(Part),
    /// Воркер упал: его задание, если было.
    Failed(Option<(String, usize)>),
    Error(String),
  }

  /// Воркер: грузит wasm, грузит моды, свободен, считает задание, упал.
  enum State {
    Booting,
    Loading,
    Idle,
    Busy((String, usize)),
    Dead,
  }

  pub struct Pool {
    workers: Vec<(web_sys::Worker, State)>,
    /// Моды для воркеров (JSON): шлются, когда воркер загрузил wasm.
    files: String,
    /// Пришедшее: номер воркера и сообщение (None — воркер упал).
    inbox: Rc<RefCell<Vec<(usize, Option<JsValue>)>>>,
    _handlers: Vec<Closure<dyn FnMut(JsValue)>>,
  }

  impl Pool {
    /// None — воркеров нет (не завелись или заданий нет): считает только страница.
    pub fn new(mods: &[Mod], jobs: usize) -> Option<Self> {
      let window = web_sys::window()?;
      let cores = window.navigator().hardware_concurrency() as usize;
      let count = cores.saturating_sub(1).clamp(1, 8).min(jobs);
      let base = window.document()?.base_uri().ok().flatten()?;
      let url = |file: &str| web_sys::Url::new_with_base(file, &base).ok().map(|url| url.href());
      let (script, wasm) = (url("kharos-sound.js")?, url("kharos-sound_bg.wasm")?);
      // Воркер — из Blob: так его адрес не зависит от того, в какой папке живёт страница.
      let loader = js_sys::Array::of1(&format!("importScripts({script:?});wasm_bindgen({wasm:?});").into());
      let options = web_sys::BlobPropertyBag::new();
      options.set_type("text/javascript");
      let blob = web_sys::Blob::new_with_str_sequence_and_options(&loader, &options).ok()?;
      let loader = web_sys::Url::create_object_url_with_blob(&blob).ok()?;
      let files = serde_json::Value::Array(mods.iter().map(|one| serde_json::json!([one.name, one.files.files])).collect()).to_string();
      let inbox = Rc::new(RefCell::new(Vec::new()));
      let mut workers = Vec::new();
      let mut handlers = Vec::new();
      for index in 0..count {
        let Ok(worker) = web_sys::Worker::new(&loader) else { break };
        let (messages, errors) = (inbox.clone(), inbox.clone());
        let message = Closure::<dyn FnMut(JsValue)>::new(move |event: JsValue| {
          messages.borrow_mut().push((index, Some(event.unchecked_into::<web_sys::MessageEvent>().data())));
        });
        let error = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| errors.borrow_mut().push((index, None)));
        worker.set_onmessage(Some(message.as_ref().unchecked_ref()));
        worker.set_onerror(Some(error.as_ref().unchecked_ref()));
        handlers.push(message);
        handlers.push(error);
        workers.push((worker, State::Booting));
      }
      (!workers.is_empty()).then(|| Self { workers, files, inbox, _handlers: handlers })
    }

    /// Что пришло с прошлого кадра.
    pub fn events(&mut self) -> Vec<Event> {
      let mut events = Vec::new();
      for (index, data) in std::mem::take(&mut *self.inbox.borrow_mut()) {
        let (worker, state) = &mut self.workers[index];
        let Some(data) = data else {
          let job = match std::mem::replace(state, State::Dead) {
            State::Busy(job) => Some(job),
            _ => None,
          };
          events.push(Event::Failed(job));
          continue;
        };
        // «ready»: сначала — wasm загружен (слушать он начинает только тогда), шлём моды; потом — моды загружены.
        if data.as_string().as_deref() == Some("ready") {
          *state = match state {
            State::Booting if worker.post_message(&self.files.as_str().into()).is_ok() => State::Loading,
            State::Booting => State::Dead,
            _ => State::Idle,
          };
          continue;
        }
        let array: js_sys::Array = data.unchecked_into();
        let head = array.get(0).as_string().unwrap_or_default();
        if head == "error" {
          events.push(Event::Error(array.get(1).as_string().unwrap_or_default()));
          continue;
        }
        let variant = array.get(1).as_f64().unwrap_or(0.0) as usize;
        let channels = (2..array.length()).map(|at| array.get(at).unchecked_into::<js_sys::Float32Array>().to_vec()).collect();
        *state = State::Idle;
        events.push(Event::Done((head, variant, channels)));
      }
      events
    }

    /// Свободный воркер с загруженными модами.
    pub fn idle(&self) -> Option<usize> {
      self.workers.iter().position(|(_, state)| matches!(state, State::Idle))
    }

    pub fn give(&mut self, index: usize, job: (String, usize), rate: f32) {
      let (worker, state) = &mut self.workers[index];
      let request = serde_json::json!([job.0, job.1, rate]).to_string();
      *state = if worker.post_message(&request.into()).is_ok() { State::Busy(job) } else { State::Dead };
    }
  }

  impl Drop for Pool {
    fn drop(&mut self) {
      for (worker, _) in &self.workers {
        worker.terminate();
      }
    }
  }
}
