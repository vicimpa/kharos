//! Партия на клиенте: хост в том же процессе (одиночная игра), клиентская машина Luau и подача из модов. Кадр —
//! тики хоста по 50 мс с накоплением, потом скрипты подачи, звук и сборка кадра для рендера.

use crate::atlas::{self, Look};
use crate::audio::{Audio, Engine};
use crate::gui::{Fonts, Gui};
use crate::input::Input;
use crate::render::{Frame, View, LAYERS, SPRITE, TEAMS, TEXELS};
use crate::script::{fill_input, look_info, ClientState, Ctx, Particle};
use kharos_content::vm::function;
use kharos_content::{Content, Mod, Side};
use kharos_engine::terrain::{GeneratorConfig, Land, LandArea};
use kharos_world::{Entity, Host, Signal};
use mlua::{AnyUserData, Function, Table};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Длина тика хоста.
pub const STEP: f64 = 0.05;
/// С какой доли срока следы на земле растворяются: пиксель за пикселем, каждый в свой случайный момент.
const FADE_FROM: f32 = 0.25;
/// Сколько тиков догонять за кадр, если кадр затянулся.
const MAX_TICKS: u32 = 5;

/// Палитра по умолчанию — TEAMS из unitArt.ts: свои синие, чужие красные, союзники зелёные; ничьи — серые.
const TEAMS_DEFAULT: [[u32; 3]; TEAMS] = [[0x1f63d8, 0x5aa9ff, 0xe4f4ff], [0xb3261e, 0xff6b5a, 0xffe9e4], [0x1f7a3c, 0x4ec973, 0xe8fff0], [0x1f63d8, 0x5aa9ff, 0xe4f4ff]];

pub struct Game {
  pub host: Host,
  pub client: Content,
  pub state: Rc<RefCell<ClientState>>,
  ctx: Ctx,
  ctx_data: AnyUserData,
  camera: Option<(Table, Function)>,
  panels: Vec<(String, Function)>,
  controls: Vec<(String, Function)>,
  atmosphere: Vec<(String, Function)>,
  /// Что живёт только на экране (раздел `effects`): следы, пыль — раз в кадр.
  effects: Vec<(String, Function)>,
  /// Скрипты звука (раздел `audio`): моторы, фон, интерфейс — раз в кадр.
  sounds: Vec<(String, Function)>,
  music: Option<Table>,
  signals: HashMap<String, Vec<(String, Function)>>,
  pub looks: Vec<Look>,
  look_of: HashMap<u32, usize>,
  pub audio: Option<Rc<Audio>>,
  /// Музыка: номер следующего такта и когда он начнётся по часам звука.
  bar: u64,
  next_bar: f64,
  accumulator: f64,
  last: Option<f64>,
  pending: Vec<Signal>,
  palette: Vec<f32>,
  /// Общий атлас и земля — отдаются рендеру один раз.
  pub atlas: Option<(Vec<u8>, [usize; 2])>,
  pub land: Option<Land>,
  /// Картинка мини-карты: местность всей карты по пикселю на тайл.
  pub minimap: Option<(Vec<u8>, [usize; 2])>,
  /// Пройденный путь сущностей на экране: от него — кадр хода (колёса, гусеницы, ноги), как в unitsPass.ts.
  walked: HashMap<Entity, Walk>,
  /// Путь, пройденный ветром, — для осадков.
  drift: [f32; 2],
  /// С какой правкой обзора нарисован туман.
  fog_seen: Option<u64>,
}

/// Путь сущности: где её нарисовали в прошлый раз, сколько прошла и когда видели.
struct Walk {
  x: f32,
  y: f32,
  distance: f32,
  seen: f64,
}

fn rgb(value: u32) -> [f32; 3] {
  [((value >> 16) & 0xff) as f32 / 255.0, ((value >> 8) & 0xff) as f32 / 255.0, (value & 0xff) as f32 / 255.0]
}

fn error(what: impl std::fmt::Display) -> impl FnOnce(mlua::Error) -> String {
  move |error| format!("{what}: {error}")
}

/// Земля партии и её мини-карта: генератор из вида `lands/` (data.land), карта — data.size тайлов от центра. Своя
/// копия генератора уходит в состояние клиента — для скриптов (c:terrain).
#[allow(clippy::type_complexity)]
fn land_of(client: &Content, game_table: &Table, state: &Rc<RefCell<ClientState>>) -> Result<(Option<Land>, Option<(Vec<u8>, [usize; 2])>), String> {
  let data = game_table.get::<Option<Table>>("data").map_err(error("data партии"))?;
  let Some(name) = data.as_ref().and_then(|data| data.get::<Option<String>>("land").ok().flatten()) else {
    state.borrow_mut().land = None;
    return Ok((None, None));
  };
  let kind = named(client, "lands", &name)?;
  let config: GeneratorConfig = kharos_world::land_config(client, data.as_ref().expect("data"))?.expect("местность");
  let size = data.as_ref().and_then(|data| data.get::<Option<i32>>("size").ok().flatten()).unwrap_or(64);
  let mut land = Land::new(config, LandArea::of(-size, -size, size, size));
  // Мини-карта: тайл — пиксель цветом своей местности и биома (палитра — minimap вида, как PALETTE в minimap.ts).
  let palette: Vec<Vec<Vec<u8>>> = kind.get::<Option<Vec<Vec<Vec<u8>>>>>("minimap").map_err(error(format!("lands/{name}.minimap")))?.unwrap_or_default();
  let side = (size * 2) as usize;
  let mut pixels = vec![0u8; side * side * 4];
  for y in 0..side {
    for x in 0..side {
      let tile = land.tile(x as i32 - size, y as i32 - size);
      let (terrain, biome) = (tile[0] as usize & 3, (tile[1] >> 6) as usize);
      let color = palette.get(biome).and_then(|row| row.get(terrain)).cloned().unwrap_or(vec![128, 128, 128]);
      pixels[(y * side + x) * 4..(y * side + x) * 4 + 4].copy_from_slice(&[color[0], color[1], color[2], 255]);
    }
  }
  state.borrow_mut().land = Some(RefCell::new(Land::new(land.config.clone(), land.area)));
  Ok((Some(land), Some((pixels, [side, side]))))
}

/// Вид раздела по имени из настроек партии.
fn named(content: &Content, section: &str, name: &str) -> Result<Table, String> {
  content.get(section, name).ok_or_else(|| format!("партия просит {section}/{name}, а его нет"))
}

impl Game {
  /// Партия game (None — по умолчанию) с настройками options (`Content::apply_options`); звук — в общий синтезатор
  /// sound, если он есть. app — просьбы скриптов к приложению (`c.app`).
  /// save — снимок партии из сохранения (`Host::snapshot`): тогда она продолжается, а не начинается.
  #[allow(clippy::too_many_arguments)]
  pub fn new(mods: Vec<Mod>, game: Option<&str>, options: &serde_json::Value, save: Option<&serde_json::Value>, player: u32, fonts: Fonts, sound: Option<Rc<Engine>>, app: crate::script::AppLink) -> Result<Self, String> {
    let seed = options.get("seed").and_then(serde_json::Value::as_f64).map_or(1, |seed| seed as u64);
    let mut host = Host::new(mods.clone(), game, seed, options)?;
    let game = host.game.clone();
    let game = game.as_str();
    match save {
      Some(snapshot) => host.restore(snapshot)?,
      None => {
        host.start()?;
        host.join(player)?;
      }
    }
    let client = Content::load(Side::Client, mods).map_err(|error| error.to_string())?;
    client.apply_options(game, options)?;
    if client.checksum() != host.content.checksum() {
      return Err("моды хоста и клиента разошлись: суммы данных видов не совпали".into());
    }
    let lua = &client.lua;
    let game_table = named(&client, "games", game)?;
    let config: Table = game_table.get::<Option<Table>>("client").map_err(error("client партии"))?.unwrap_or(lua.create_table());

    // Облики видов.
    let mut looks = Vec::new();
    let mut look_of = HashMap::new();
    for proto in &client.list {
      let table = client.by_id(proto.id).expect("вид");
      if let Some(look) = table.get::<Option<Table>>("look").map_err(error(format!("{}/{}.look", proto.section, proto.name)))? {
        // Картинка из мода вместо чертежа.
        if let Some(path) = look.get::<Option<String>>("image").map_err(error("look.image"))? {
          let png = client.asset(&path).ok_or_else(|| format!("{}/{}: нет картинки {path}", proto.section, proto.name))?;
          let built = atlas::picture(proto.id, look, png).map_err(|problem| format!("{}/{}: {path}: {problem}", proto.section, proto.name))?;
          look_of.insert(proto.id, looks.len());
          looks.push(built);
          continue;
        }
        if function(&look, "draw").map_err(error("look.draw"))?.is_none() {
          continue;
        }
        let built = atlas::build(lua, proto.id, look).map_err(error(format!("облик {}/{}", proto.section, proto.name)))?;
        look_of.insert(proto.id, looks.len());
        looks.push(built);
      }
    }
    let atlas = atlas::pack(&mut looks);

    let state = Rc::new(RefCell::new(ClientState { world: host.state.clone(), prev: HashMap::new(), alpha: 0.0, view: View { x: 0.0, y: 0.0, zoom: 32.0, screen: [1280.0, 800.0], scale: 1.0 }, input: Input::default(), time: 0.0, dt: 0.0, player, outbox: Vec::new(), sounds: Vec::new(), particles: Vec::new(), decals: Default::default(), draw: Default::default(), glow: Default::default(), lights: Vec::new(), gui: Gui::new(fonts), looks: looks.iter().map(|look| (look.proto, look_info(look))).collect(), audio: None, land: None, preview: crate::script::Preview::new(), dressed: HashMap::new(), shown: Vec::new(), protos: client.list.iter().map(|proto| client.by_id(proto.id).expect("вид")).collect() }));
    let table = || Ok::<_, String>(lua.create_table());
    let ctx = Ctx { state: state.clone(), input: table()?, camera: table()?, shared: table()?, atmosphere: table()?, music: table()?, protos: client.protos.clone(), game: game_table.clone(), app };
    ctx.camera.set("x", 0.0).map_err(error("камера"))?;
    ctx.camera.set("y", 0.0).map_err(error("камера"))?;
    ctx.camera.set("zoom", 32.0).map_err(error("камера"))?;
    ctx.music.set("mood", "calm").map_err(error("музыка"))?;
    ctx.music.set("volume", 0.6).map_err(error("музыка"))?;
    let ctx_data = lua.create_userdata(ctx.clone()).map_err(error("c"))?;

    // Что берёт партия.
    let camera = match config.get::<Option<String>>("camera").map_err(error("client.camera"))? {
      Some(name) => {
        let proto = named(&client, "cameras", &name)?;
        let update = function(&proto, "update").map_err(error(format!("cameras/{name}")))?.ok_or_else(|| format!("cameras/{name}: нет update"))?;
        if let Some(start) = function(&proto, "start").map_err(error(format!("cameras/{name}")))? {
          start.call::<()>((&ctx.camera, &ctx_data)).map_err(error(format!("cameras/{name}.start")))?;
        }
        Some((proto, update))
      }
      None => None,
    };
    let list = |key: &str, section: &str, entry: &str| -> Result<Vec<(String, Function)>, String> {
      let names: Vec<String> = config.get::<Option<Vec<String>>>(key).map_err(error(format!("client.{key}")))?.unwrap_or_default();
      names
        .into_iter()
        .map(|name| {
          let proto = named(&client, section, &name)?;
          let run = function(&proto, entry).map_err(error(format!("{section}/{name}")))?.ok_or_else(|| format!("{section}/{name}: нет {entry}"))?;
          Ok((format!("{section}/{name}"), run))
        })
        .collect()
    };
    let panels = list("ui", "ui", "draw")?;
    let controls = list("controls", "controls", "update")?;
    let effects = list("effects", "effects", "update")?;

    let audio = match sound {
      Some(engine) => {
        let kinds: Vec<(String, Table)> = client.section("sounds").map(|proto| (proto.name.clone(), client.by_id(proto.id).expect("вид"))).collect();
        let started = crate::clock::seconds();
        engine.bake(&kinds).map_err(error("звуки sounds/"))?;
        let elapsed = (crate::clock::seconds() - started) * 1000.0;
        if elapsed > 50.0 {
          eprintln!("звуки посчитаны за {elapsed:.0} мс");
        }
        Some(Rc::new(Audio::new(engine, &kinds).map_err(error("голоса sounds/"))?))
      }
      None => None,
    };
    state.borrow_mut().audio = audio.clone();
    let atmosphere = list("atmosphere", "atmosphere", "update")?;
    let sounds = list("audio", "audio", "update")?;
    let music = match config.get::<Option<String>>("music").map_err(error("client.music"))? {
      Some(name) => Some(named(&client, "music", &name)?),
      None => None,
    };

    // Обработчики сигналов хоста.
    let mut signals: HashMap<String, Vec<(String, Function)>> = HashMap::new();
    for proto in &client.list {
      let table = client.by_id(proto.id).expect("вид");
      if let Some(list) = table.get::<Option<Table>>("signals").map_err(error(format!("{}/{}.signals", proto.section, proto.name)))? {
        for pair in list.pairs::<String, Function>() {
          let (name, handler) = pair.map_err(error(format!("{}/{}.signals", proto.section, proto.name)))?;
          signals.entry(name).or_default().push((format!("{}/{}", proto.section, proto.name), handler));
        }
      }
    }

    // Палитра сторон: своя, чужая, союзная (`teams = { own, foe, ally }`), ничья — серым поверх своей.
    let mut teams = TEAMS_DEFAULT;
    if let Some(table) = config.get::<Option<Table>>("teams").map_err(error("client.teams"))? {
      for (slot, key) in teams.iter_mut().zip(["own", "foe", "ally"]) {
        if let Some(colors) = table.get::<Option<Vec<u32>>>(key).map_err(error(format!("client.teams.{key}")))? {
          for (tone, value) in slot.iter_mut().zip(colors) {
            *tone = value;
          }
        }
      }
    }
    teams[3] = teams[0];
    let palette: Vec<f32> = teams.iter().flat_map(|team| team.iter().flat_map(|&value| rgb(value))).collect();
    let pending = host.signals();

    let (land, minimap) = land_of(&client, &game_table, &state)?;

    Ok(Self { host, client, state, ctx, ctx_data, camera, panels, controls, atmosphere, effects, sounds, music, signals, looks, look_of, atlas: Some(atlas), land, minimap, audio, walked: HashMap::new(), drift: [0.0; 2], fog_seen: None, bar: 0, next_bar: 0.0, accumulator: 0.0, last: None, pending, palette })
  }

  /// Новый мир той же партии с новыми настройками (`c.app:reset`): хост — заново, а клиентская машина, её панели и
  /// звук остаются. Так витрина меню меняет сценку под окнами меню, не трогая их.
  pub fn reset(&mut self, mods: Vec<Mod>, options: &serde_json::Value, player: u32) -> Result<(), String> {
    let seed = options.get("seed").and_then(serde_json::Value::as_f64).map_or(1, |seed| seed as u64);
    let game = self.host.game.clone();
    let mut host = Host::new(mods, Some(&game), seed, options)?;
    host.start()?;
    host.join(player)?;
    self.host = host;
    self.client.apply_options(&game, options)?;
    {
      let mut state = self.state.borrow_mut();
      state.world = self.host.state.clone();
      state.prev.clear();
      for list in &mut state.decals {
        list.clear();
      }
      state.particles.clear();
    }
    let game_table = named(&self.client, "games", &game)?;
    let (land, minimap) = land_of(&self.client, &game_table, &self.state)?;
    self.land = land;
    self.minimap = minimap;
    self.walked.clear();
    self.fog_seen = None;
    // Сигналы старта (сценка не встала и т. п.) — до первого тика: он их стирает.
    self.pending = self.host.signals();
    self.accumulator = 0.0;
    Ok(())
  }

  /// Кадр: тики, подача, звук. Возвращает, что рисовать.
  pub fn frame(&mut self, input: &Input) -> Result<(Frame, View), String> {
    let dt = self.last.map_or(1.0 / 60.0, |last| (input.time - last).clamp(0.0, 0.25));
    self.last = Some(input.time);
    self.accumulator += dt;
    let mut ticks = 0;
    while self.accumulator >= STEP {
      if ticks == MAX_TICKS {
        self.accumulator = 0.0;
        break;
      }
      self.state.borrow_mut().remember();
      self.host.tick(STEP)?;
      self.pending.extend(self.host.signals());
      self.accumulator -= STEP;
      ticks += 1;
    }
    {
      let mut state = self.state.borrow_mut();
      state.alpha = self.accumulator / STEP;
      state.time = input.time;
      state.dt = dt;
      state.input = input.clone();
      state.view.screen = input.screen;
      state.view.scale = input.scale;
      state.draw.clear();
      state.glow.clear();
      state.lights.clear();
      state.dressed.clear();
      state.shown.clear();
      state.gui.begin(input);
    }
    let lua = self.client.lua.clone();
    let over_ui = self.state.borrow().gui.covered;
    // Поле ввода в фокусе забирает клавиши: игра их не видит (держать остаются только Shift, Ctrl, Alt).
    let typing = self.state.borrow().gui.typing();
    let filtered;
    let input = if typing {
      let mut copy = input.clone();
      copy.hits.clear();
      copy.presses.clear();
      copy.text.clear();
      copy.keys.retain(|key| matches!(key.as_str(), "shift" | "ctrl" | "alt" | "meta"));
      filtered = copy;
      &filtered
    } else {
      input
    };
    fill_input(&lua, &self.ctx.input, input, &self.state.borrow().view, over_ui).map_err(error("ввод"))?;
    self.ctx.input.set("typing", typing).map_err(error("ввод"))?;

    // Сигналы хоста.
    for signal in std::mem::take(&mut self.pending) {
      let Some(handlers) = self.signals.get(&signal.name) else { continue };
      let payload = kharos_content::vm::to_lua(&lua, &signal.payload).map_err(error(&signal.name))?;
      for (label, handler) in handlers {
        handler.call::<()>((&self.ctx_data, payload.clone())).map_err(error(format!("{label}.signals.{}", signal.name)))?;
      }
    }

    // Камера.
    if let Some((_, update)) = &self.camera {
      update.call::<()>((&self.ctx.camera, &self.ctx_data)).map_err(error("камера"))?;
    }
    {
      let camera = &self.ctx.camera;
      let mut state = self.state.borrow_mut();
      state.view.x = camera.get::<f32>("x").unwrap_or(0.0);
      state.view.y = camera.get::<f32>("y").unwrap_or(0.0);
      state.view.zoom = camera.get::<f32>("zoom").unwrap_or(32.0).clamp(2.0, 256.0);
    }
    let view = self.state.borrow().view;
    fill_input(&lua, &self.ctx.input, input, &view, over_ui).map_err(error("ввод"))?;

    // Панели, потом управление: указатель над панелью этого кадра миру не достаётся.
    for (label, draw) in &self.panels {
      draw.call::<()>(&self.ctx_data).map_err(error(label))?;
    }
    let captured = over_ui;
    self.ctx.input.set("over_ui", captured).map_err(error("ввод"))?;
    for (label, update) in &self.controls {
      update.call::<()>(&self.ctx_data).map_err(error(label))?;
    }

    for (label, update) in &self.effects {
      update.call::<()>(&self.ctx_data).map_err(error(label))?;
    }
    // Атмосфера.
    for (label, update) in &self.atmosphere {
      update.call::<()>((&self.ctx.atmosphere, &self.ctx_data)).map_err(error(label))?;
    }
    for (label, update) in &self.sounds {
      update.call::<()>(&self.ctx_data).map_err(error(label))?;
    }
    self.sound()?;
    self.particles(dt as f32);
    self.state.borrow_mut().gui.finish();

    let (player, outbox) = {
      let mut state = self.state.borrow_mut();
      (state.player, std::mem::take(&mut state.outbox))
    };
    for (name, args) in outbox {
      self.host.send(player, &name, args);
    }
    Ok((self.build(&view, input.time)?, view))
  }

  /// Звук кадра: заказанные скриптами разовые звуки и музыка по тактам, если её задала партия.
  fn sound(&mut self) -> Result<(), String> {
    let lua = self.client.lua.clone();
    let orders = std::mem::take(&mut self.state.borrow_mut().sounds);
    let Some(audio) = self.audio.clone() else { return Ok(()) };
    for order in &orders {
      audio.play(&order.voice, order.gain, order.pan, order.rate);
    }
    if let Some(level) = audio.level() {
      let tick = self.state.borrow().world.borrow().tick;
      if tick % 20 == 0 || !orders.is_empty() {
        let names: Vec<&str> = orders.iter().map(|order| order.voice.as_str()).collect();
        eprintln!("звук: тик {tick}, уровень {level:.4} {names:?}");
      }
    }
    // Музыка: сочинитель — раз в такт, ноты расписываются наперёд по часам звука.
    if let Some(music) = &self.music {
      let now = audio.now();
      if self.next_bar < now {
        self.next_bar = now + 0.2;
      }
      if self.next_bar - now < 0.5 {
        let tempo = music.get::<Option<f64>>("tempo").ok().flatten().unwrap_or(90.0);
        let beats = music.get::<Option<f64>>("beats").ok().flatten().unwrap_or(4.0);
        let beat = 60.0 / tempo;
        if let Some(compose) = function(music, "compose").map_err(error("music.compose"))? {
          let notes: Option<Vec<Table>> = compose.call((self.bar, &self.ctx_data)).map_err(error("music.compose"))?;
          for note in notes.unwrap_or_default() {
            let get = |key: &str, default: f64| note.get::<Option<f64>>(key).ok().flatten().unwrap_or(default);
            let voice: String = note.get("voice").map_err(error("нота: voice"))?;
            let at = self.next_bar + get("beat", 0.0) * beat;
            let length = get("length", 1.0) * beat;
            let pitch = 440.0 * 2f64.powf((get("note", 69.0) - 69.0) / 12.0);
            let name = mlua::Value::String(lua.create_string(&voice));
            if let Some(sound) = audio.start(&lua, &name, "music", None, Some(at), Some(length), pitch, get("velocity", 0.7), mlua::Value::Nil).map_err(error(format!("нота {voice}")))? {
              sound.place(get("gain", 1.0) as f32, get("pan", 0.0) as f32);
            }
          }
        }
        self.bar += 1;
        self.next_bar += beats * beat;
      }
    }
    Ok(())
  }

  /// Частицы: ход, снос ветром из атмосферы, отмирание; рисуются в слой поверх мира.
  fn particles(&mut self, dt: f32) {
    let wind = self.ctx.atmosphere.get::<Option<Table>>("wind").ok().flatten();
    let (wx, wy) = wind.map_or((0.0, 0.0), |wind| (wind.get::<f32>("x").unwrap_or(0.0), wind.get::<f32>("y").unwrap_or(0.0)));
    let mut state = self.state.borrow_mut();
    let mut particles = std::mem::take(&mut state.particles);
    particles.retain_mut(|particle: &mut Particle| {
      particle.age += dt;
      let drift = if particle.drift { 1.0 } else { 0.0 };
      particle.x += (particle.vx + wx * drift) * dt;
      particle.y += (particle.vy + wy * drift) * dt;
      particle.age < particle.life
    });
    for particle in &particles {
      let fade = 1.0 - particle.age / particle.life;
      let size = particle.size / TEXELS;
      let x = (particle.x * TEXELS).floor() / TEXELS;
      let y = (particle.y * TEXELS).floor() / TEXELS;
      let color = crate::script::color(particle.color, Some(fade.min(1.0)));
      state.draw.rect([x, y], [x + size, y + size], color);
    }
    state.particles = particles;
  }

  /// Кадр для рендера: спрайты видимых сущностей по слоям, огни, свет атмосферы.
  fn build(&mut self, view: &View, time: f64) -> Result<Frame, String> {
    let mut frame = Frame { layers: vec![Vec::new(); LAYERS], palette: self.palette.clone(), time: time as f32, ..Default::default() };
    let atmosphere = &self.ctx.atmosphere;
    frame.light = atmosphere.get::<Option<f32>>("light").ok().flatten().unwrap_or(1.0).clamp(0.0, 1.0);
    frame.precipitation = atmosphere.get::<Option<f32>>("precipitation").ok().flatten().unwrap_or(0.0).clamp(0.0, 1.0);
    if let Some(wind) = atmosphere.get::<Option<Table>>("wind").ok().flatten() {
      frame.wind = [wind.get::<f32>("x").unwrap_or(0.0), wind.get::<f32>("y").unwrap_or(0.0)];
    }
    // Снос копится, а не считается как ветер × время: иначе смена ветра дёргала бы всю пелену (precipitationPass.ts).
    let dt = self.state.borrow().dt as f32;
    for axis in 0..2 {
      self.drift[axis] = (self.drift[axis] + frame.wind[axis] * dt).rem_euclid(512.0);
    }
    frame.drift = self.drift;
    self.decals(&mut frame, view, dt);
    let state = self.state.borrow();
    let world = state.world.borrow();
    // Туман войны: тайл — 0,94 неразведанный, 0,5 разведанный, 0 видимый (fogPass.ts); рамка в тайл — неразведанная.
    if let Some(vision) = world.vision.as_ref().filter(|vision| vision.fog) {
      let bounds = vision.bounds;
      frame.fog = Some([(bounds.left - 1) as f32, (bounds.top - 1) as f32]);
      let changed = vision.changed.get(&state.player).copied().unwrap_or(0);
      if self.fog_seen != Some(changed) {
        self.fog_seen = Some(changed);
        let (w, h) = (bounds.width() + 2, bounds.height() + 2);
        let mut pixels = vec![(0.94f32 * 255.0).round() as u8; (w * h) as usize];
        if let Some(cells) = vision.cells.get(&state.player) {
          for y in 0..bounds.height() {
            for x in 0..bounds.width() {
              let cell = cells[(y * bounds.width() + x) as usize];
              pixels[((y + 1) * w + x + 1) as usize] = [240u8, 128, 0][cell as usize];
            }
          }
        }
        frame.fog_update = Some((pixels, [w, h]));
      }
    }
    let schema = &world.world.schema;
    let (Some(position), Some(proto), Some(owner)) = (schema.id("Position"), schema.id("Proto"), schema.id("Owner")) else { return Ok(frame) };
    let attached = schema.id("Attached");
    let bounds = view.bounds(7.0);
    let snap = |value: f32| (value * TEXELS).round() / TEXELS;
    let lights = true;
    // Слой и порядок внутри слоя (здания — по нижнему краю: нижние перекрывают верхние).
    let mut sorted: Vec<(usize, f32, [f32; SPRITE])> = Vec::new();
    let layer_of = |entity: Entity| -> Option<usize> {
      let id = world.world.num(entity, proto, "id")?;
      let look = &self.looks[*self.look_of.get(&(id as u32))?];
      Some(look.layer as usize)
    };
    for &entity in &world.world.stores[position].entities {
      let Some(id) = world.world.num(entity, proto, "id") else { continue };
      let Some(&index) = self.look_of.get(&(id as u32)) else { continue };
      let Some([x, y, angle]) = state.pose(entity) else { continue };
      let (x, y) = (x as f32, y as f32);
      if x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3] {
        continue;
      }
      let look = &self.looks[index];
      // Чужое вне обзора не видно: хост TS его и не прислал бы.
      let player_of = world.world.num(entity, owner, "player").unwrap_or(0.0) as u32;
      let hidden = |vision: &kharos_world::vision::Vision| if look.memory { !vision.explored(state.player, x as f64, y as f64) } else { !vision.sees(state.player, x as f64, y as f64) };
      if player_of != state.player && world.vision.as_ref().is_some_and(hidden) {
        continue;
      }
      // Турель — слоем выше своего носителя.
      let parent = attached.and_then(|id| world.world.num(entity, id, "parent")).filter(|&parent| parent >= 1.0);
      let layer = match parent {
        Some(parent) => layer_of(parent as Entity).unwrap_or(0) + 1,
        None => look.layer as usize,
      };
      let dress = state.dressed.get(&entity).copied().unwrap_or_default();
      // Кадр: у ходовых — по пройденному пути, у остальных — по времени; у облика с работой — из своей половины,
      // у выключенного — первый.
      let phase = match look.step {
        Some(step) if look.phases > 1 => {
          let walk = self.walked.entry(entity).or_insert(Walk { x, y, distance: 0.0, seen: time });
          let moved = (x - walk.x).hypot(y - walk.y);
          if moved < 1.0 {
            walk.distance += moved;
          }
          walk.x = x;
          walk.y = y;
          walk.seen = time;
          (walk.distance / step) as usize % look.phases
        }
        _ if look.working => {
          let half = look.phases / 2;
          let frame = if dress.off { 0 } else { (time * look.fps as f64) as usize % half };
          frame + if dress.working && !dress.off { half } else { 0 }
        }
        _ if look.phases > 1 && !dress.off => (time * look.fps as f64) as usize % look.phases,
        _ => 0,
      };
      let player = world.world.num(entity, owner, "player").unwrap_or(0.0) as u32;
      let (team, grey) = if player == 0 {
        (3.0, 1.0)
      } else if player == state.player {
        (0.0, 0.0)
      } else {
        (1.0, 0.0)
      };
      let cell = look.cell(angle, phase);
      let [w, h] = look.tiles();
      let (left, top) = (x + look.offset[0] - view.x, y + look.offset[1] - view.y);
      let sprite = [left, top, w, h, team, look.shadow[0], look.shadow[1], grey];
      let bottom = y + look.offset[1] + h;
      // Показанная не целиком (стройка, сворачивание) — без тени и огней; тающая — бледнее вместе с тенью;
      // выключенная — темнее и без огней (SWITCHED_OFF в buildingsPass.ts).
      let (built, fade) = (dress.built, dress.fade);
      if built < 1.0 {
        for piece in revealed(sprite, look.cells[cell], built) {
          sorted.push((layer, bottom, piece));
        }
        continue;
      }
      let tint = if dress.off { SWITCHED_OFF } else { WHOLE };
      let mut whole = instance(sprite, look.cells[cell], tint.map(|channel| channel * fade));
      whole[10] *= fade;
      sorted.push((layer, bottom, whole));
      if !lights || dress.off {
        continue;
      }
      let (cos, sin) = ((angle as f32).cos(), (angle as f32).sin());
      let (forward_x, forward_y) = (cos / TEXELS, sin / TEXELS);
      for &[along, across, glow] in &look.lights.lamps {
        let (lx, ly) = (snap(x + along * forward_x - across * forward_y), snap(y + along * forward_y + across * forward_x));
        frame.spots.extend_from_slice(&[lx, ly, glow * 2.0, 1.0]);
        frame.blooms.extend_from_slice(&[lx, ly, glow, 1.0]);
      }
      if let Some([along, length, near, spread, level]) = look.lights.beam {
        frame.beams.extend_from_slice(&[snap(x + along * forward_x), snap(y + along * forward_y), length, level, cos, sin, near, spread]);
      }
      // Огни кадра (здания): как lights.add в buildingsPass.ts — пятно в 16 радиусов лампы, ореол в 3 + 2.
      for &[lx, ly, size, level] in &look.frame_lights[cell] {
        if level <= crate::render::MIN_LEVEL {
          continue;
        }
        frame.spots.extend_from_slice(&[x + lx, y + ly, size * 16.0, level]);
        frame.blooms.extend_from_slice(&[x + lx, y + ly, size * 3.0 + 2.0, level]);
      }
    }
    // Облики вне сущностей (c:show): в своём слое по нижнему краю, призраки — поверх зданий.
    for shown in &state.shown {
      let Some(&index) = self.look_of.get(&shown.proto) else { continue };
      let look = &self.looks[index];
      let phase = if look.phases > 1 { (time * look.fps as f64) as usize % look.phases } else { 0 };
      let cell = look.cells[look.cell(0.0, phase)];
      let [w, h] = look.tiles();
      let team = if shown.player == 0 { 3.0 } else if shown.player == state.player { 0.0 } else { 1.0 };
      let sprite = [shown.x + look.offset[0] - view.x, shown.y + look.offset[1] - view.y, w, h, team, look.shadow[0], 0.0, if shown.player == 0 { 1.0 } else { 0.0 }];
      if shown.over {
        frame.ghosts.extend_from_slice(&instance(sprite, cell, shown.tint));
        continue;
      }
      let bottom = shown.y + look.offset[1] + h;
      if shown.built < 1.0 {
        for piece in revealed(sprite, cell, shown.built) {
          sorted.push((look.layer as usize, bottom, piece));
        }
      } else {
        sorted.push((look.layer as usize, bottom, instance([sprite[0], sprite[1], w, h, team, look.shadow[0], look.shadow[1], sprite[7]], cell, shown.tint)));
      }
    }
    let buildings = crate::atlas::Layer::Building as usize;
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then(if a.0 == buildings { a.1.total_cmp(&b.1) } else { std::cmp::Ordering::Equal }));
    for (layer, _, sprite) in sorted {
      frame.layers[layer.min(LAYERS - 1)].extend_from_slice(&sprite);
    }
    // Огни скриптов (c:light): вспышки выстрелов, взрывы.
    for &[x, y, cut, bloom, level] in &state.lights {
      if cut > 0.0 {
        frame.spots.extend_from_slice(&[x, y, cut, level]);
      }
      if bloom > 0.0 {
        frame.blooms.extend_from_slice(&[x, y, bloom, level]);
      }
    }
    drop(world);
    drop(state);
    self.walked.retain(|_, walk| time - walk.seen < 2.0);
    Ok(frame)
  }

  /// Следы на земле: стареют, с FADE_FROM срока растворяются (доля оставшихся пикселей — плавная ступень), вне
  /// обзора своего игрока забываются; что в кадре — в frame.decals (decalsPass.ts).
  fn decals(&mut self, frame: &mut Frame, view: &View, dt: f32) {
    let mut state = self.state.borrow_mut();
    let state = &mut *state;
    let world = state.world.borrow();
    let player = state.player;
    let bounds = view.bounds(2.0);
    // Снизу вверх: колеи, отметины, остовы.
    for list in &mut state.decals {
      list.retain_mut(|decal| {
        decal.age += dt;
        let [_, _, x, y] = decal.line;
        if decal.age >= decal.life || world.vision.as_ref().is_some_and(|vision| !vision.sees(player, x as f64, y as f64)) {
          return false;
        }
        if x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3] {
          return true;
        }
        let share = ((decal.age / decal.life - FADE_FROM) / (1.0 - FADE_FROM)).max(0.0);
        let left = 1.0 - share * share * (3.0 - 2.0 * share);
        let [r, g, b] = decal.color;
        let [u, v, w, h] = decal.frame;
        frame.decals.extend_from_slice(&[decal.line[0], decal.line[1], decal.line[2], decal.line[3], decal.width, u, v, w, h, r, g, b, decal.opacity, left, decal.density, decal.seed]);
        true
      });
    }
  }

  /// Снимок партии для слота: мир, камера и тик.
  pub fn save(&self) -> Result<(serde_json::Value, serde_json::Value, u64), String> {
    let world = self.host.snapshot()?;
    let camera = &self.ctx.camera;
    let get = |key: &str| camera.get::<f64>(key).unwrap_or(0.0);
    let tick = self.host.state.borrow().tick;
    Ok((world, serde_json::json!({ "x": get("x"), "y": get("y"), "zoom": get("zoom") }), tick))
  }

  /// Камера из сохранения.
  pub fn set_camera(&mut self, saved: &serde_json::Value) {
    for key in ["x", "y", "zoom"] {
      if let Some(value) = saved.get(key).and_then(serde_json::Value::as_f64) {
        let _ = self.ctx.camera.set(key, value);
      }
    }
  }

  pub fn palette(&self) -> &[f32] {
    &self.palette
  }
}

/// Оттенок «как есть» и чертёж недостроенного (BLUEPRINT в buildingsPass.ts), с предумноженной альфой.
const WHOLE: [f32; 4] = [1.0, 1.0, 1.0, 1.0];
const BLUEPRINT: [f32; 4] = [0.3, 0.6, 1.0, 0.4];
/// Своё выключенное здание — темнее.
const SWITCHED_OFF: [f32; 4] = [0.55, 0.57, 0.62, 1.0];

/// Спрайт: место, размер, сторона, тень и серость (sprite), кадр атласа и оттенок.
fn instance(sprite: [f32; 8], [u0, v0, u1, v1]: [f32; 4], tint: [f32; 4]) -> [f32; SPRITE] {
  let [left, top, w, h, team, shift, shadow, grey] = sprite;
  [left, top, w, h, u0, v0, u1, v1, team, shift, shadow, grey, tint[0], tint[1], tint[2], tint[3]]
}

/// Показанное снизу на долю built: весь облик чертежом и поверх — готовая часть, нижние строки спрайта целым числом
/// пикселей (buildingsPass.ts). Без тени.
fn revealed(sprite: [f32; 8], cell: [f32; 4], built: f32) -> [[f32; SPRITE]; 2] {
  let [left, top, w, h, team, shift, _, grey] = sprite;
  let [u0, v0, u1, v1] = cell;
  let rows = (h * TEXELS).round();
  let hidden = (rows - (rows * built).floor()) / rows;
  [instance([left, top, w, h, team, shift, 0.0, grey], cell, BLUEPRINT), instance([left, top + h * hidden, w, h * (1.0 - hidden), team, shift, 0.0, grey], [u0, v0 + (v1 - v0) * hidden, u1, v1], WHOLE)]
}
