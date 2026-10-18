//! Звук: движок даёт Web Audio (крейт `web-audio-api` на нативе, в браузере — `AudioContext`), а что звучит —
//! решают моды. Как в TS-клиенте (`packages/client/src/audio`):
//!
//! - банк записей: разовые звуки и петли с вариантами — сэмплы считает Luau один раз при загрузке (`bank` в видах
//!   раздела `sounds`, перенос synth.ts, motorSynth.ts, worldSynth.ts);
//! - голоса: граф узлов, который строит Luau (`graph`), и его ручки (`update`) — генераторы, шум, фильтры, огибающие,
//!   задержка, записи из банка (`s:sample`), эхо (`s:reverb`);
//! - микшер: компрессор на выходе, общая громкость и группы `battle`, `world`, `interface`, `music`, не больше
//!   MAX_VOICES разовых звуков разом.
//!
//! Управление — скрипты раздела `audio` через `c.audio` (моторы, фон, интерфейс), см. docs/mods.md.

use mlua::{Function, Lua, MetaMethod, RegistryKey, Table, UserData, UserDataFields, UserDataMethods, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use web_audio_api::context::{AudioContext, BaseAudioContext};
use web_audio_api::node::{AudioBufferSourceNode, AudioNode, AudioScheduledSourceNode, BiquadFilterNode, BiquadFilterType, ConstantSourceNode, ConvolverNode, DelayNode, DynamicsCompressorNode, GainNode, OscillatorNode, OscillatorType, StereoPannerNode, WaveShaperNode};
use web_audio_api::{AudioBuffer, AudioParam};

/// Шины: всё сходится в общую громкость.
/// Группы громкости, как CHANNELS в audio.ts.
pub const BUSES: [&str; 4] = ["battle", "world", "interface", "music"];
/// Больше разовых звуков разом не звучит: в большом бою остальные пропускаются.
const MAX_VOICES: usize = 32;
/// Общая громкость.
const MASTER: f32 = 0.6;
/// Как быстро петля догоняет новую громкость, в секундах.
const GLIDE: f64 = 0.25;

enum Node {
  Osc(OscillatorNode),
  Source(AudioBufferSourceNode),
  Const(ConstantSourceNode),
  Filter(BiquadFilterNode),
  Gain(GainNode),
  Delay(DelayNode),
  Shaper(WaveShaperNode),
  Convolver(ConvolverNode),
  Pan(StereoPannerNode),
}

impl Node {
  fn node(&self) -> &dyn AudioNode {
    match self {
      Node::Osc(node) => node,
      Node::Source(node) => node,
      Node::Const(node) => node,
      Node::Filter(node) => node,
      Node::Gain(node) => node,
      Node::Delay(node) => node,
      Node::Shaper(node) => node,
      Node::Convolver(node) => node,
      Node::Pan(node) => node,
    }
  }

  fn param(&self, name: &str) -> Option<&AudioParam> {
    Some(match (self, name) {
      (Node::Osc(node), "frequency") => node.frequency(),
      (Node::Osc(node), "detune") => node.detune(),
      (Node::Source(node), "rate") => node.playback_rate(),
      (Node::Osc(node), "rate") => node.frequency(),
      (Node::Source(node), "detune") => node.detune(),
      (Node::Const(node), "offset") => node.offset(),
      (Node::Filter(node), "frequency") => node.frequency(),
      (Node::Filter(node), "q") => node.q(),
      (Node::Filter(node), "gain") => node.gain(),
      (Node::Filter(node), "detune") => node.detune(),
      (Node::Gain(node), "gain") => node.gain(),
      (Node::Delay(node), "time") => node.delay_time(),
      (Node::Pan(node), "pan") => node.pan(),
      _ => return None,
    })
  }

  fn start(&mut self, at: f64) {
    match self {
      Node::Osc(node) => node.start_at(at),
      Node::Source(node) => node.start_at(at),
      Node::Const(node) => node.start_at(at),
      _ => {}
    }
  }

  fn stop(&mut self, at: f64) {
    match self {
      Node::Osc(node) => node.stop_at(at),
      Node::Source(node) => node.stop_at(at),
      Node::Const(node) => node.stop_at(at),
      _ => {}
    }
  }
}

/// Записи банка: варианты и группа громкости.
pub struct Record {
  pub variants: Vec<AudioBuffer>,
  pub bus: String,
}

/// Общее у синтезатора и строителей голосов.
pub struct Engine {
  pub ctx: AudioContext,
  pub master: GainNode,
  _compressor: DynamicsCompressorNode,
  pub buses: HashMap<&'static str, GainNode>,
  /// Шум на две секунды по кругу: белый, розовый, коричневый.
  noise: [AudioBuffer; 3],
  pub bank: RefCell<HashMap<String, Record>>,
  /// Сколько разовых звуков звучит.
  voices: Arc<AtomicUsize>,
  /// Случайное для вариантов и разброса высоты.
  seed: std::cell::Cell<u32>,
  /// Замер уровня на выходе (KHAROS_AUDIO_LEVEL=1): проверить, что звук есть, не слушая его.
  meter: Option<RefCell<web_audio_api::node::AnalyserNode>>,
}

impl Engine {
  fn now(&self) -> f64 {
    self.ctx.current_time()
  }

  fn random(&self) -> f64 {
    let mut state = self.seed.get();
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    self.seed.set(state);
    state as f64 / u32::MAX as f64
  }

  fn record(&self, name: &str, variant: Option<usize>) -> Option<AudioBuffer> {
    let bank = self.bank.borrow();
    let record = bank.get(name)?;
    let index = variant.unwrap_or_else(|| (self.random() * record.variants.len() as f64) as usize).min(record.variants.len().saturating_sub(1));
    record.variants.get(index).cloned()
  }
}

/// Узлы одного звучания голоса.
struct Nodes {
  list: Vec<Node>,
  /// Когда отпущена огибающая и сколько звучит её затухание.
  release: f64,
  engine: Rc<Engine>,
  /// Узел, куда голос пишет свой выход: громкость звучания.
  out: usize,
}

/// Узел в Luau: номер в звучании.
#[derive(Clone)]
struct NodeRef {
  nodes: Rc<RefCell<Nodes>>,
  index: usize,
}

/// Параметр узла в Luau.
#[derive(Clone)]
struct ParamRef {
  node: NodeRef,
  name: String,
}

impl ParamRef {
  fn with<R>(&self, apply: impl FnOnce(&AudioParam, f64) -> R) -> mlua::Result<R> {
    let nodes = self.node.nodes.borrow();
    let now = nodes.engine.now();
    let param = nodes.list[self.node.index].param(&self.name).ok_or_else(|| mlua::Error::runtime(format!("у узла нет параметра {}", self.name)))?;
    Ok(apply(param, now))
  }
}

fn connect(from: &NodeRef, to: &Value) -> mlua::Result<()> {
  let nodes = from.nodes.borrow();
  let source = nodes.list[from.index].node();
  match to {
    Value::UserData(data) if data.is::<NodeRef>() => {
      let target = data.borrow::<NodeRef>()?;
      if Rc::ptr_eq(&target.nodes, &from.nodes) {
        source.connect(nodes.list[target.index].node());
      } else {
        // Узел другого голоса: нота подложки уходит в фильтр фона.
        let other = target.nodes.borrow();
        source.connect(other.list[target.index].node());
      }
    }
    Value::UserData(data) if data.is::<ParamRef>() => {
      let target = data.borrow::<ParamRef>()?;
      if Rc::ptr_eq(&target.node.nodes, &from.nodes) {
        let param = nodes.list[target.node.index].param(&target.name).ok_or_else(|| mlua::Error::runtime(format!("нет параметра {}", target.name)))?;
        source.connect(param);
      } else {
        let other = target.node.nodes.borrow();
        let param = other.list[target.node.index].param(&target.name).ok_or_else(|| mlua::Error::runtime(format!("нет параметра {}", target.name)))?;
        source.connect(param);
      }
    }
    _ => return Err(mlua::Error::runtime("to: нужен узел или его параметр")),
  }
  Ok(())
}

impl UserData for NodeRef {
  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // a:to(b) — соединить; возвращает b, чтобы строить цепочкой.
    methods.add_method("to", |_, node, target: Value| {
      connect(node, &target)?;
      Ok(target)
    });
    methods.add_meta_method(MetaMethod::Index, |_, node, name: String| Ok(ParamRef { node: node.clone(), name }));
    // node.frequency = 220 — плавно, за 20 мс: ручки меняются раз в кадр, без щелчков.
    methods.add_meta_method(MetaMethod::NewIndex, |_, node, (name, value): (String, f32)| {
      ParamRef { node: node.clone(), name }.with(|param, now| {
        param.set_target_at_time(value, now, 0.02);
      })
    });
  }
}

impl UserData for ParamRef {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("value", |_, param| param.with(|param, _| param.value()));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    // set(v, at?) — сразу или в миг at; ramp(v, at) — линейно к at; exp(v, at) — по экспоненте;
    // target(v, at, tau) — плавно с постоянной tau.
    methods.add_method("set", |_, param, (value, at): (f32, Option<f64>)| {
      param.with(|param, now| {
        param.set_value_at_time(value, at.unwrap_or(now));
      })
    });
    methods.add_method("ramp", |_, param, (value, at): (f32, f64)| {
      param.with(|param, _| {
        param.linear_ramp_to_value_at_time(value, at);
      })
    });
    methods.add_method("exp", |_, param, (value, at): (f32, f64)| {
      param.with(|param, _| {
        param.exponential_ramp_to_value_at_time(value.max(1e-4), at);
      })
    });
    // glide(v, tau) — плавно к v с постоянной tau начиная сейчас.
    methods.add_method("glide", |_, param, (value, tau): (f32, f64)| {
      param.with(|param, now| {
        param.set_target_at_time(value, now, tau.max(1e-4));
      })
    });
    methods.add_method("target", |_, param, (value, at, tau): (f32, f64, f64)| {
      param.with(|param, _| {
        param.set_target_at_time(value, at, tau.max(1e-4));
      })
    });
  }
}

/// Строитель схемы голоса.
struct Builder {
  nodes: Rc<RefCell<Nodes>>,
  at: f64,
  length: Option<f64>,
  note: f64,
  velocity: f64,
  /// Что передал тот, кто заводит голос (`args`): какой мотор, какие ноты.
  args: Value,
}

impl Builder {
  fn push(&self, node: Node) -> NodeRef {
    let mut nodes = self.nodes.borrow_mut();
    let mut node = node;
    node.start(self.at);
    nodes.list.push(node);
    NodeRef { nodes: self.nodes.clone(), index: nodes.list.len() - 1 }
  }

  fn engine(&self) -> Rc<Engine> {
    self.nodes.borrow().engine.clone()
  }
}

fn wave(name: &str) -> OscillatorType {
  match name {
    "square" => OscillatorType::Square,
    "sawtooth" | "saw" => OscillatorType::Sawtooth,
    "triangle" => OscillatorType::Triangle,
    _ => OscillatorType::Sine,
  }
}

fn filter_type(name: &str) -> BiquadFilterType {
  match name {
    "highpass" => BiquadFilterType::Highpass,
    "bandpass" => BiquadFilterType::Bandpass,
    "notch" => BiquadFilterType::Notch,
    "allpass" => BiquadFilterType::Allpass,
    "peaking" => BiquadFilterType::Peaking,
    "lowshelf" => BiquadFilterType::Lowshelf,
    "highshelf" => BiquadFilterType::Highshelf,
    _ => BiquadFilterType::Lowpass,
  }
}

impl UserData for Builder {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("at", |_, s| Ok(s.at));
    fields.add_field_method_get("length", |_, s| Ok(s.length));
    fields.add_field_method_get("note", |_, s| Ok(s.note));
    fields.add_field_method_get("velocity", |_, s| Ok(s.velocity));
    fields.add_field_method_get("args", |_, s| Ok(s.args.clone()));
    fields.add_field_method_get("rate", |_, s| Ok(s.engine().ctx.sample_rate()));
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("osc", |_, s, (kind, frequency): (Option<String>, Option<f32>)| {
      let mut osc = s.engine().ctx.create_oscillator();
      osc.set_type(wave(kind.as_deref().unwrap_or("sine")));
      osc.frequency().set_value(frequency.unwrap_or(s.note as f32));
      Ok(s.push(Node::Osc(osc)))
    });
    // Шум по кругу: "white", "pink", "brown".
    methods.add_method("noise", |_, s, color: Option<String>| {
      let engine = s.engine();
      let mut source = engine.ctx.create_buffer_source();
      let index = match color.as_deref() {
        Some("pink") => 1,
        Some("brown") => 2,
        _ => 0,
      };
      source.set_buffer(engine.noise[index].clone());
      source.set_loop(true);
      Ok(s.push(Node::Source(source)))
    });
    methods.add_method("const", |_, s, value: Option<f32>| {
      let node = s.engine().ctx.create_constant_source();
      node.offset().set_value(value.unwrap_or(1.0));
      Ok(s.push(Node::Const(node)))
    });
    methods.add_method("filter", |_, s, (kind, frequency, q): (Option<String>, Option<f32>, Option<f32>)| {
      let mut filter = s.engine().ctx.create_biquad_filter();
      filter.set_type(filter_type(kind.as_deref().unwrap_or("lowpass")));
      filter.frequency().set_value(frequency.unwrap_or(1000.0));
      filter.q().set_value(q.unwrap_or(1.0));
      Ok(s.push(Node::Filter(filter)))
    });
    methods.add_method("gain", |_, s, value: Option<f32>| {
      let gain = s.engine().ctx.create_gain();
      gain.gain().set_value(value.unwrap_or(1.0));
      Ok(s.push(Node::Gain(gain)))
    });
    methods.add_method("delay", |_, s, (time, max): (Option<f64>, Option<f64>)| {
      let delay = s.engine().ctx.create_delay(max.unwrap_or(2.0));
      delay.delay_time().set_value(time.unwrap_or(0.25) as f32);
      Ok(s.push(Node::Delay(delay)))
    });
    // Искажение: amount 0..1 и больше — насколько жёстко срезаются пики.
    methods.add_method("shape", |_, s, amount: Option<f32>| {
      let mut shaper = s.engine().ctx.create_wave_shaper();
      let k = amount.unwrap_or(0.5) * 50.0;
      let curve: Vec<f32> = (0..1024).map(|i| i as f32 / 511.5 - 1.0).map(|x| (1.0 + k) * x / (1.0 + k * x.abs())).collect();
      shaper.set_curve(curve);
      Ok(s.push(Node::Shaper(shaper)))
    });
    methods.add_method("pan", |_, s, value: Option<f32>| {
      let pan = s.engine().ctx.create_stereo_panner();
      pan.pan().set_value(value.unwrap_or(0.0));
      Ok(s.push(Node::Pan(pan)))
    });
    // Колебание для параметра: синус частоты frequency размахом depth — s:lfo(5, 20):to(osc.frequency).
    methods.add_method("lfo", |_, s, (frequency, depth, kind): (f32, f32, Option<String>)| {
      let engine = s.engine();
      let mut osc = engine.ctx.create_oscillator();
      osc.set_type(wave(kind.as_deref().unwrap_or("sine")));
      osc.frequency().set_value(frequency);
      let gain = engine.ctx.create_gain();
      gain.gain().set_value(depth);
      osc.connect(&gain);
      s.push(Node::Osc(osc));
      Ok(s.push(Node::Gain(gain)))
    });
    // Огибающая: усилитель, который в s.at поднимается до peak · velocity за attack, спадает к sustain за decay, а
    // в s.at + s.length затухает за release.
    methods.add_method("env", |_, s, spec: Option<Table>| {
      let get = |key: &str, default: f64| spec.as_ref().and_then(|spec| spec.get::<Option<f64>>(key).ok().flatten()).unwrap_or(default);
      let (attack, decay, sustain, release, peak) = (get("attack", 0.01), get("decay", 0.1), get("sustain", 0.7), get("release", 0.2), get("peak", 1.0) * s.velocity);
      let gain = s.engine().ctx.create_gain();
      let param = gain.gain();
      param.set_value_at_time(0.0, s.at).linear_ramp_to_value_at_time(peak as f32, s.at + attack).linear_ramp_to_value_at_time((peak * sustain) as f32, s.at + attack + decay);
      if let Some(length) = s.length {
        let end = s.at + length.max(attack + decay);
        param.set_value_at_time((peak * sustain) as f32, end).linear_ramp_to_value_at_time(0.0, end + release);
        let mut nodes = s.nodes.borrow_mut();
        nodes.release = nodes.release.max(release);
      }
      Ok(s.push(Node::Gain(gain)))
    });
    // Запись из банка: s:sample("motor:petrol:idle", { loop = true, offset = 0.3, variant = 0 }). Без offset петля
    // начинается со случайного места: одинаковые петли не звучат в такт. Параметр rate — скорость.
    methods.add_method("sample", |_, s, (name, options): (String, Option<Table>)| {
      let engine = s.engine();
      let get = |key: &str| options.as_ref().map_or(Ok(None), |table| table.get::<Option<f64>>(key));
      let Some(buffer) = engine.record(&name, get("variant")?.map(|variant| variant as usize)) else { return Err(mlua::Error::runtime(format!("нет записи {name}"))) };
      let looping = options.as_ref().map_or(Ok(None), |table| table.get::<Option<bool>>("loop"))?.unwrap_or(false);
      let mut source = engine.ctx.create_buffer_source();
      let duration = buffer.duration();
      source.set_buffer(buffer);
      source.set_loop(looping);
      let offset = get("offset")?.unwrap_or_else(|| if looping { engine.random() * duration } else { 0.0 });
      source.start_at_with_offset(s.at, offset % duration.max(1e-6));
      let mut nodes = s.nodes.borrow_mut();
      nodes.list.push(Node::Source(source));
      Ok(NodeRef { nodes: s.nodes.clone(), index: nodes.list.len() - 1 })
    });
    // Эхо: свёртка с откликом из банка (стерео-запись).
    methods.add_method("reverb", |_, s, name: String| {
      let engine = s.engine();
      let Some(buffer) = engine.record(&name, Some(0)) else { return Err(mlua::Error::runtime(format!("нет записи {name}"))) };
      let mut convolver = engine.ctx.create_convolver();
      convolver.set_buffer(buffer);
      let mut nodes = s.nodes.borrow_mut();
      nodes.list.push(Node::Convolver(convolver));
      Ok(NodeRef { nodes: s.nodes.clone(), index: nodes.list.len() - 1 })
    });
    // Выход голоса: к нему подключают последний узел — s:out() или a:to(s:out()).
    methods.add_method("out", |_, s, ()| Ok(NodeRef { nodes: s.nodes.clone(), index: s.nodes.borrow().out }));
  }
}

/// Звучание голоса: его узлы и что получит update. В Luau — `c.audio:voice(…)`: `set(ручки)`, `place(громкость,
/// сторона)`, `release(секунды)`, `nodes` — узлы, которые вернула схема.
pub struct Sound {
  nodes: Rc<RefCell<Nodes>>,
  pan: StereoPannerNode,
  gain: GainNode,
  handles: Option<RegistryKey>,
  update: Option<Function>,
  released: bool,
}

impl Sound {
  /// Громкость и панорама — плавно.
  pub fn place(&self, gain: f32, pan: f32) {
    let now = self.nodes.borrow().engine.now();
    self.gain.gain().set_target_at_time(gain.max(0.0), now, 0.05);
    self.pan.pan().set_target_at_time(pan.clamp(-1.0, 1.0), now, 0.05);
  }

  /// Ручки голоса: update(узлы, knobs).
  pub fn knobs(&self, lua: &Lua, knobs: &Value) -> mlua::Result<()> {
    if let (Some(update), Some(handles)) = (&self.update, &self.handles) {
      update.call::<()>((lua.registry_value::<Value>(handles)?, knobs.clone()))?;
    }
    Ok(())
  }

  /// Отпустить: затихает за fade секунд и останавливается.
  pub fn release(&mut self, fade: f64) {
    if std::mem::replace(&mut self.released, true) {
      return;
    }
    let mut nodes = self.nodes.borrow_mut();
    let now = nodes.engine.now();
    self.gain.gain().cancel_scheduled_values(now).set_target_at_time(0.0, now, (fade / 3.0).max(0.005));
    for node in &mut nodes.list {
      node.stop(now + fade * 2.0 + 0.05);
    }
  }
}

impl UserData for Sound {
  fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
    fields.add_field_method_get("nodes", |lua, sound| match &sound.handles {
      Some(handles) => lua.registry_value::<Value>(handles),
      None => Ok(Value::Nil),
    });
  }

  fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
    methods.add_method("set", |lua, sound, knobs: Value| sound.knobs(lua, &knobs));
    methods.add_method("place", |_, sound, (gain, pan): (f32, Option<f32>)| {
      sound.place(gain, pan.unwrap_or(0.0));
      Ok(())
    });
    methods.add_method_mut("release", |_, sound, fade: Option<f64>| {
      sound.release(fade.unwrap_or(0.25));
      Ok(())
    });
  }
}

/// Звук партии поверх общего синтезатора: голоса по имени (виды раздела `sounds` её машины Luau), свои шины, петли и
/// звучания. Кончилась партия — её звук стихает и останавливается, а банк записей остаётся на следующую.
pub struct Audio {
  pub engine: Rc<Engine>,
  voices: HashMap<String, Table>,
  /// Шины партии — в шины синтезатора (их громкость — настройки игрока).
  buses: HashMap<&'static str, GainNode>,
  /// Петли банка, которые уже звучат: громкость и сторона.
  loops: RefCell<HashMap<String, (AudioBufferSourceNode, GainNode, StereoPannerNode)>>,
  /// Звучания голосов — чтобы остановить их с концом партии.
  sounds: RefCell<Vec<std::rc::Weak<RefCell<Nodes>>>>,
}

impl Drop for Audio {
  fn drop(&mut self) {
    let now = self.engine.now();
    for bus in self.buses.values() {
      bus.gain().cancel_scheduled_values(now).set_target_at_time(0.0, now, 0.03);
    }
    for (source, ..) in self.loops.borrow_mut().values_mut() {
      source.stop_at(now + 0.2);
    }
    for nodes in self.sounds.borrow().iter().filter_map(std::rc::Weak::upgrade) {
      for node in &mut nodes.borrow_mut().list {
        node.stop(now + 0.2);
      }
    }
  }
}

fn noise(ctx: &AudioContext, color: usize) -> AudioBuffer {
  let rate = ctx.sample_rate();
  let length = (rate * 2.0) as usize;
  let mut buffer = ctx.create_buffer(1, length, rate);
  let data = buffer.get_channel_data_mut(0);
  let mut seed: u32 = 0x9e3779b9 ^ color as u32;
  let mut white = || {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed as f32 / u32::MAX as f32 * 2.0 - 1.0
  };
  let (mut b0, mut b1, mut b2, mut last) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
  for sample in data.iter_mut() {
    let w = white();
    *sample = match color {
      1 => {
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        (b0 + b1 + b2 + w * 0.1848) * 0.18
      }
      2 => {
        last = (last + 0.02 * w) / 1.02;
        last * 3.5
      }
      _ => w * 0.5,
    };
  }
  buffer
}

/// Сэмплы из Luau: буфер f32 (моно) или таблица буферов (каналы).
fn channels(value: Value) -> mlua::Result<Vec<Vec<f32>>> {
  let read = |buffer: mlua::Buffer| buffer.to_vec().chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().expect("4 байта"))).collect::<Vec<f32>>();
  match value {
    Value::Buffer(buffer) => Ok(vec![read(buffer)]),
    Value::Table(list) => list.sequence_values::<mlua::Buffer>().map(|buffer| buffer.map(read)).collect(),
    other => Err(mlua::Error::runtime(format!("запись — буфер f32 или таблица буферов, а не {}", other.type_name()))),
  }
}

impl Engine {
  /// Синтезатор или None, если звуку некуда выйти.
  pub fn new() -> Option<Rc<Self>> {
    let ctx = std::panic::catch_unwind(AudioContext::default).ok()?;
    // Компрессор не даёт залпу перегрузить звук.
    let compressor = ctx.create_dynamics_compressor();
    compressor.threshold().set_value(-18.0);
    compressor.ratio().set_value(6.0);
    compressor.connect(&ctx.destination());
    let master = ctx.create_gain();
    master.gain().set_value(MASTER);
    master.connect(&compressor);
    let mut buses = HashMap::new();
    for name in BUSES {
      let bus = ctx.create_gain();
      bus.connect(&master);
      buses.insert(name, bus);
    }
    let noise = [noise(&ctx, 0), noise(&ctx, 1), noise(&ctx, 2)];
    let meter = std::env::var("KHAROS_AUDIO_LEVEL").is_ok().then(|| {
      let mut analyser = ctx.create_analyser();
      analyser.set_fft_size(2048);
      compressor.connect(&analyser);
      RefCell::new(analyser)
    });
    let seed = (crate::clock::epoch_millis() as u64 as u32).wrapping_mul(1_000_003) | 1;
    Some(Rc::new(Engine { ctx, master, _compressor: compressor, buses, noise, bank: RefCell::new(HashMap::new()), voices: Arc::new(AtomicUsize::new(0)), seed: std::cell::Cell::new(seed), meter }))
  }

  /// Банки записей видов раздела `sounds` (`bank = { имя = { variants, bus, render = function(rate, variant) } }`):
  /// считаются один раз на запуск — уже посчитанные пропускаются.
  pub fn bake(&self, kinds: &[(String, Table)]) -> mlua::Result<()> {
    let rate = self.ctx.sample_rate();
    for (_, kind) in kinds {
      if let Some(bank) = kind.get::<Option<Table>>("bank")? {
        for pair in bank.pairs::<String, Table>() {
          let (key, record) = pair?;
          if self.bank.borrow().contains_key(&key) {
            continue;
          }
          let render: Function = record.get("render")?;
          let variants = record.get::<Option<usize>>("variants")?.unwrap_or(1).max(1);
          let bus = record.get::<Option<String>>("bus")?.unwrap_or_else(|| "world".into());
          let mut list = Vec::new();
          for variant in 0..variants {
            let data = channels(render.call::<Value>((rate, variant)).map_err(|error| mlua::Error::runtime(format!("{key}: {error}")))?)?;
            let length = data.first().map_or(1, Vec::len).max(1);
            let mut buffer = self.ctx.create_buffer(data.len().max(1), length, rate);
            for (channel, samples) in data.iter().enumerate() {
              buffer.copy_to_channel(samples, channel);
            }
            list.push(buffer);
          }
          self.bank.borrow_mut().insert(key, Record { variants: list, bus });
        }
      }
    }
    Ok(())
  }

  pub fn set_volume(&self, bus: &str, volume: f32) {
    let node = if bus == "master" { Some(&self.master) } else { self.buses.get(bus) };
    if let Some(node) = node {
      let value = if bus == "master" { MASTER * volume } else { volume };
      node.gain().set_target_at_time(value, self.now(), 0.05);
    }
  }
}

impl Audio {
  /// Звук партии: голоса (`graph`) видов раздела `sounds` её машины запоминаются по имени вида.
  pub fn new(engine: Rc<Engine>, kinds: &[(String, Table)]) -> mlua::Result<Self> {
    let mut voices = HashMap::new();
    for (name, kind) in kinds {
      if kind.contains_key("graph")? {
        voices.insert(name.clone(), kind.clone());
      }
    }
    let mut buses = HashMap::new();
    for name in BUSES {
      let bus = engine.ctx.create_gain();
      bus.connect(&engine.buses[name]);
      buses.insert(name, bus);
    }
    Ok(Self { engine, voices, buses, loops: RefCell::new(HashMap::new()), sounds: RefCell::new(Vec::new()) })
  }

  pub fn now(&self) -> f64 {
    self.engine.now()
  }

  fn bus(&self, name: &str) -> &GainNode {
    self.buses.get(name).unwrap_or(&self.buses["world"])
  }

  /// Звучание голоса voice на шине bus (или в узел into другого голоса): с at на length секунд (None — пока не
  /// отпустят), нота note Гц.
  #[allow(clippy::too_many_arguments)]
  pub fn start(&self, lua: &Lua, voice: &Value, bus: &str, into: Option<&NodeTarget>, at: Option<f64>, length: Option<f64>, note: f64, velocity: f64, args: Value) -> mlua::Result<Option<Sound>> {
    let table = match voice {
      Value::Table(table) => table.clone(),
      Value::String(name) => match self.voices.get(&*name.to_str()?) {
        Some(table) => table.clone(),
        None => return Ok(None),
      },
      _ => return Err(mlua::Error::runtime("голос — имя вида из sounds/ или таблица { graph, update }")),
    };
    let engine = self.engine.clone();
    let at = at.unwrap_or_else(|| engine.now());
    let gain = engine.ctx.create_gain();
    let pan = engine.ctx.create_stereo_panner();
    gain.connect(&pan);
    match into {
      Some(target) => target.connect(&pan),
      None => {
        pan.connect(self.bus(bus));
      }
    }
    // Выход голоса — усилитель громкости звучания; узел 0 в списке.
    let out = engine.ctx.create_gain();
    out.connect(&gain);
    let nodes = Rc::new(RefCell::new(Nodes { list: vec![Node::Gain(out)], release: 0.0, engine: engine.clone(), out: 0 }));
    {
      let mut sounds = self.sounds.borrow_mut();
      sounds.retain(|sound| sound.strong_count() > 0);
      sounds.push(Rc::downgrade(&nodes));
    }
    let graph: Function = table.get("graph")?;
    let builder = Builder { nodes: nodes.clone(), at, length, note, velocity, args };
    let handles: Value = graph.call(builder)?;
    if let Some(length) = length {
      let mut borrowed = nodes.borrow_mut();
      let end = at + length + borrowed.release + 0.05;
      for node in &mut borrowed.list {
        node.stop(end);
      }
    }
    let update = table.get::<Option<Function>>("update")?;
    let handles = if handles.is_nil() { None } else { Some(lua.create_registry_value(handles)?) };
    Ok(Some(Sound { nodes, pan, gain, handles, update, released: false }))
  }

  /// Разовая запись банка: случайный вариант, громкость, сторона и скорость (высота), как play в audio.ts.
  pub fn play(&self, name: &str, volume: f32, pan: f32, rate: f32) {
    let engine = &self.engine;
    if volume <= 0.01 || engine.voices.load(Ordering::Relaxed) >= MAX_VOICES {
      return;
    }
    let bus = match engine.bank.borrow().get(name) {
      Some(record) => record.bus.clone(),
      None => return,
    };
    let Some(buffer) = engine.record(name, None) else { return };
    let mut source = engine.ctx.create_buffer_source();
    source.set_buffer(buffer);
    source.playback_rate().set_value(rate);
    let gain = engine.ctx.create_gain();
    gain.gain().set_value(volume);
    let panner = engine.ctx.create_stereo_panner();
    panner.pan().set_value(pan.clamp(-1.0, 1.0));
    source.connect(&gain);
    gain.connect(&panner);
    panner.connect(self.bus(&bus));
    engine.voices.fetch_add(1, Ordering::Relaxed);
    let voices = engine.voices.clone();
    source.set_onended(move |_| {
      voices.fetch_sub(1, Ordering::Relaxed);
    });
    source.start();
  }

  /// Фоновая петля банка: громкость и сторона меняются плавно; первая просьба заводит её со случайного места.
  pub fn loop_level(&self, name: &str, volume: f32, pan: f32) {
    let engine = &self.engine;
    let mut loops = self.loops.borrow_mut();
    if !loops.contains_key(name) {
      if volume <= 0.0 {
        return;
      }
      let bus = match engine.bank.borrow().get(name) {
        Some(record) => record.bus.clone(),
        None => return,
      };
      let Some(buffer) = engine.record(name, Some(0)) else { return };
      let mut source = engine.ctx.create_buffer_source();
      let duration = buffer.duration();
      source.set_buffer(buffer);
      source.set_loop(true);
      let gain = engine.ctx.create_gain();
      gain.gain().set_value(0.0);
      let panner = engine.ctx.create_stereo_panner();
      source.connect(&gain);
      gain.connect(&panner);
      panner.connect(self.bus(&bus));
      source.start_at_with_offset(0.0, engine.random() * duration);
      loops.insert(name.to_string(), (source, gain, panner));
    }
    let (_, gain, panner) = &loops[name];
    let now = engine.now();
    gain.gain().set_target_at_time(volume.max(0.0), now, GLIDE);
    panner.pan().set_target_at_time(pan.clamp(-1.0, 1.0), now, GLIDE);
  }

  pub fn set_volume(&self, bus: &str, volume: f32) {
    self.engine.set_volume(bus, volume);
  }

  pub fn random(&self) -> f64 {
    self.engine.random()
  }

  /// Средний уровень на выходе за последние 2048 отсчётов (RMS), если замер включён.
  pub fn level(&self) -> Option<f32> {
    let meter = self.engine.meter.as_ref()?;
    let mut samples = vec![0.0f32; 2048];
    meter.borrow_mut().get_float_time_domain_data(&mut samples);
    Some((samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt())
  }
}

/// Узел чужого голоса, куда подключить новый.
pub struct NodeTarget(NodeRef);

impl NodeTarget {
  pub fn from_value(value: &Value) -> mlua::Result<Option<Self>> {
    match value {
      Value::UserData(data) if data.is::<NodeRef>() => Ok(Some(Self(data.borrow::<NodeRef>()?.clone()))),
      Value::Nil => Ok(None),
      _ => Err(mlua::Error::runtime("into: нужен узел другого голоса")),
    }
  }

  fn connect(&self, from: &dyn AudioNode) {
    let nodes = self.0.nodes.borrow();
    from.connect(nodes.list[self.0.index].node());
  }
}
