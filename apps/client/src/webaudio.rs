//! Web Audio для `audio.rs` — одни имена на обеих платформах: на нативе — крейт `web-audio-api` как есть, в браузере —
//! те же типы и методы поверх `AudioContext` страницы (web-sys). Здесь только то, чем пользуется синтезатор.

#[cfg(not(target_arch = "wasm32"))]
pub use web_audio_api::context::{AudioContext, BaseAudioContext};
#[cfg(not(target_arch = "wasm32"))]
pub use web_audio_api::node::{AnalyserNode, AudioBufferSourceNode, AudioNode, AudioScheduledSourceNode, BiquadFilterNode, BiquadFilterType, ConstantSourceNode, ConvolverNode, DelayNode, DynamicsCompressorNode, GainNode, OscillatorNode, OscillatorType, StereoPannerNode, WaveShaperNode};
#[cfg(not(target_arch = "wasm32"))]
pub use web_audio_api::{AudioBuffer, AudioParam};

/// Контекст звука или None, если звуку некуда выйти.
#[cfg(not(target_arch = "wasm32"))]
pub fn new_context() -> Option<AudioContext> {
  std::panic::catch_unwind(AudioContext::default).ok()
}

/// Браузер не играет звук, пока страницу не тронули: при первом касании или клавише контекст просыпается.
#[cfg(not(target_arch = "wasm32"))]
pub fn wake(_: &AudioContext) {}

#[cfg(target_arch = "wasm32")]
pub use web::*;

#[cfg(target_arch = "wasm32")]
mod web {
  use wasm_bindgen::closure::Closure;
  use wasm_bindgen::JsCast as _;

  pub fn new_context() -> Option<AudioContext> {
    web_sys::AudioContext::new().ok().map(|ctx| AudioContext { destination: AudioDestinationNode(ctx.destination()), ctx })
  }

  pub fn wake(ctx: &AudioContext) {
    if ctx.ctx.state() == web_sys::AudioContextState::Suspended {
      let _ = ctx.ctx.resume();
    }
  }

  /// Куда подключают: узел или параметр.
  pub enum Target {
    Node(web_sys::AudioNode),
    Param(web_sys::AudioParam),
  }

  pub trait AudioNode {
    fn target(&self) -> Target;

    fn connect(&self, destination: &dyn AudioNode) {
      let Target::Node(node) = self.target() else { return };
      let _ = match destination.target() {
        Target::Node(to) => node.connect_with_audio_node(&to).map(|_| ()),
        Target::Param(to) => node.connect_with_audio_param(&to),
      };
    }
  }

  pub trait AudioScheduledSourceNode {
    fn scheduled(&self) -> web_sys::AudioScheduledSourceNode;

    fn start(&mut self) {
      let _ = self.scheduled().start();
    }

    fn start_at(&mut self, at: f64) {
      let _ = self.scheduled().start_with_when(at);
    }

    fn stop_at(&mut self, at: f64) {
      let _ = self.scheduled().stop_with_when(at);
    }

    fn set_onended<F: FnOnce(web_sys::Event) + 'static>(&mut self, callback: F) {
      let closure = Closure::once(callback);
      self.scheduled().set_onended(Some(closure.as_ref().unchecked_ref()));
      closure.forget();
    }
  }

  /// Параметр узла: значение и расписание его изменений.
  pub struct AudioParam(web_sys::AudioParam);

  impl AudioParam {
    pub fn value(&self) -> f32 {
      self.0.value()
    }

    pub fn set_value(&self, value: f32) -> &Self {
      self.0.set_value(value);
      self
    }

    pub fn set_value_at_time(&self, value: f32, at: f64) -> &Self {
      let _ = self.0.set_value_at_time(value, at);
      self
    }

    pub fn linear_ramp_to_value_at_time(&self, value: f32, at: f64) -> &Self {
      let _ = self.0.linear_ramp_to_value_at_time(value, at);
      self
    }

    pub fn exponential_ramp_to_value_at_time(&self, value: f32, at: f64) -> &Self {
      let _ = self.0.exponential_ramp_to_value_at_time(value, at);
      self
    }

    pub fn set_target_at_time(&self, value: f32, at: f64, tau: f64) -> &Self {
      let _ = self.0.set_target_at_time(value, at, tau);
      self
    }

    pub fn cancel_scheduled_values(&self, at: f64) -> &Self {
      let _ = self.0.cancel_scheduled_values(at);
      self
    }
  }

  impl AudioNode for AudioParam {
    fn target(&self) -> Target {
      Target::Param(self.0.clone())
    }
  }

  /// Запись: каналы отсчётов.
  #[derive(Clone)]
  pub struct AudioBuffer(web_sys::AudioBuffer);

  impl AudioBuffer {
    pub fn duration(&self) -> f64 {
      self.0.duration()
    }

    pub fn copy_to_channel(&mut self, samples: &[f32], channel: usize) {
      let mut copy = samples.to_vec();
      let _ = self.0.copy_to_channel(&mut copy, channel as i32);
    }
  }

  #[derive(Clone)]
  pub struct AudioDestinationNode(web_sys::AudioDestinationNode);

  impl AudioNode for AudioDestinationNode {
    fn target(&self) -> Target {
      Target::Node(self.0.clone().into())
    }
  }

  pub struct AudioContext {
    ctx: web_sys::AudioContext,
    destination: AudioDestinationNode,
  }

  /// Создание узлов — как BaseAudioContext у `web-audio-api`.
  pub trait BaseAudioContext {
    fn sample_rate(&self) -> f32;
    fn current_time(&self) -> f64;
    fn destination(&self) -> AudioDestinationNode;
    fn create_oscillator(&self) -> OscillatorNode;
    fn create_buffer_source(&self) -> AudioBufferSourceNode;
    fn create_constant_source(&self) -> ConstantSourceNode;
    fn create_biquad_filter(&self) -> BiquadFilterNode;
    fn create_gain(&self) -> GainNode;
    fn create_delay(&self, max: f64) -> DelayNode;
    fn create_wave_shaper(&self) -> WaveShaperNode;
    fn create_convolver(&self) -> ConvolverNode;
    fn create_stereo_panner(&self) -> StereoPannerNode;
    fn create_dynamics_compressor(&self) -> DynamicsCompressorNode;
    fn create_analyser(&self) -> AnalyserNode;
    fn create_buffer(&self, channels: usize, length: usize, rate: f32) -> AudioBuffer;
  }

  impl BaseAudioContext for AudioContext {
    fn sample_rate(&self) -> f32 {
      self.ctx.sample_rate()
    }

    fn current_time(&self) -> f64 {
      self.ctx.current_time()
    }

    fn destination(&self) -> AudioDestinationNode {
      self.destination.clone()
    }

    fn create_oscillator(&self) -> OscillatorNode {
      let node = self.ctx.create_oscillator().expect("узел");
      OscillatorNode { frequency: AudioParam(node.frequency()), detune: AudioParam(node.detune()), node }
    }

    fn create_buffer_source(&self) -> AudioBufferSourceNode {
      let node = self.ctx.create_buffer_source().expect("узел");
      AudioBufferSourceNode { playback_rate: AudioParam(node.playback_rate()), detune: AudioParam(node.detune()), node }
    }

    fn create_constant_source(&self) -> ConstantSourceNode {
      let node = self.ctx.create_constant_source().expect("узел");
      ConstantSourceNode { offset: AudioParam(node.offset()), node }
    }

    fn create_biquad_filter(&self) -> BiquadFilterNode {
      let node = self.ctx.create_biquad_filter().expect("узел");
      BiquadFilterNode { frequency: AudioParam(node.frequency()), q: AudioParam(node.q()), gain: AudioParam(node.gain()), detune: AudioParam(node.detune()), node }
    }

    fn create_gain(&self) -> GainNode {
      let node = self.ctx.create_gain().expect("узел");
      GainNode { gain: AudioParam(node.gain()), node }
    }

    fn create_delay(&self, max: f64) -> DelayNode {
      let node = self.ctx.create_delay_with_max_delay_time(max).expect("узел");
      DelayNode { delay_time: AudioParam(node.delay_time()), node }
    }

    fn create_wave_shaper(&self) -> WaveShaperNode {
      WaveShaperNode(self.ctx.create_wave_shaper().expect("узел"))
    }

    fn create_convolver(&self) -> ConvolverNode {
      ConvolverNode(self.ctx.create_convolver().expect("узел"))
    }

    fn create_stereo_panner(&self) -> StereoPannerNode {
      let node = self.ctx.create_stereo_panner().expect("узел");
      StereoPannerNode { pan: AudioParam(node.pan()), node }
    }

    fn create_dynamics_compressor(&self) -> DynamicsCompressorNode {
      let node = self.ctx.create_dynamics_compressor().expect("узел");
      DynamicsCompressorNode { threshold: AudioParam(node.threshold()), ratio: AudioParam(node.ratio()), node }
    }

    fn create_analyser(&self) -> AnalyserNode {
      AnalyserNode(self.ctx.create_analyser().expect("узел"))
    }

    fn create_buffer(&self, channels: usize, length: usize, rate: f32) -> AudioBuffer {
      AudioBuffer(self.ctx.create_buffer(channels as u32, length as u32, rate).expect("буфер"))
    }
  }

  /// Узел со своими параметрами: обёртка над узлом страницы, параметры — заранее, чтобы отдавать их ссылкой.
  macro_rules! node {
    ($name:ident, $raw:ty { $($param:ident),* }) => {
      pub struct $name {
        node: $raw,
        $($param: AudioParam,)*
      }

      impl $name {
        $(pub fn $param(&self) -> &AudioParam {
          &self.$param
        })*
      }

      impl AudioNode for $name {
        fn target(&self) -> Target {
          Target::Node(self.node.clone().into())
        }
      }
    };
  }

  node!(OscillatorNode, web_sys::OscillatorNode { frequency, detune });
  node!(AudioBufferSourceNode, web_sys::AudioBufferSourceNode { playback_rate, detune });
  node!(ConstantSourceNode, web_sys::ConstantSourceNode { offset });
  node!(BiquadFilterNode, web_sys::BiquadFilterNode { frequency, q, gain, detune });
  node!(GainNode, web_sys::GainNode { gain });
  node!(DelayNode, web_sys::DelayNode { delay_time });
  node!(StereoPannerNode, web_sys::StereoPannerNode { pan });
  node!(DynamicsCompressorNode, web_sys::DynamicsCompressorNode { threshold, ratio });

  pub use web_sys::{BiquadFilterType, OscillatorType};

  impl OscillatorNode {
    pub fn set_type(&mut self, kind: OscillatorType) {
      self.node.set_type(kind);
    }
  }

  impl AudioScheduledSourceNode for OscillatorNode {
    fn scheduled(&self) -> web_sys::AudioScheduledSourceNode {
      self.node.clone().into()
    }
  }

  impl AudioBufferSourceNode {
    pub fn set_buffer(&mut self, buffer: AudioBuffer) {
      self.node.set_buffer(Some(&buffer.0));
    }

    pub fn set_loop(&mut self, looping: bool) {
      self.node.set_loop(looping);
    }

    pub fn start_at_with_offset(&mut self, at: f64, offset: f64) {
      let _ = self.node.start_with_when_and_grain_offset(at, offset);
    }
  }

  impl AudioScheduledSourceNode for AudioBufferSourceNode {
    fn scheduled(&self) -> web_sys::AudioScheduledSourceNode {
      self.node.clone().into()
    }
  }

  impl AudioScheduledSourceNode for ConstantSourceNode {
    fn scheduled(&self) -> web_sys::AudioScheduledSourceNode {
      self.node.clone().into()
    }
  }

  impl BiquadFilterNode {
    pub fn set_type(&mut self, kind: BiquadFilterType) {
      self.node.set_type(kind);
    }
  }

  pub struct WaveShaperNode(web_sys::WaveShaperNode);

  impl WaveShaperNode {
    pub fn set_curve(&mut self, curve: Vec<f32>) {
      let mut curve = curve;
      #[allow(deprecated)]
      let _ = self.0.set_curve(Some(&mut curve));
    }
  }

  impl AudioNode for WaveShaperNode {
    fn target(&self) -> Target {
      Target::Node(self.0.clone().into())
    }
  }

  pub struct ConvolverNode(web_sys::ConvolverNode);

  impl ConvolverNode {
    pub fn set_buffer(&mut self, buffer: AudioBuffer) {
      self.0.set_buffer(Some(&buffer.0));
    }
  }

  impl AudioNode for ConvolverNode {
    fn target(&self) -> Target {
      Target::Node(self.0.clone().into())
    }
  }

  pub struct AnalyserNode(web_sys::AnalyserNode);

  impl AnalyserNode {
    pub fn set_fft_size(&mut self, size: usize) {
      self.0.set_fft_size(size as u32);
    }

    pub fn get_float_time_domain_data(&mut self, samples: &mut [f32]) {
      self.0.get_float_time_domain_data(samples);
    }
  }

  impl AudioNode for AnalyserNode {
    fn target(&self) -> Target {
      Target::Node(self.0.clone().into())
    }
  }
}
