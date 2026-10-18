//! Офлайновый звук режима сценария: граф считается кадр в кадр с картинкой, а не в реальном времени.
//!
//! OfflineAudioContext крейта `web-audio-api` считает звук на своём потоке и останавливается в заранее заданных точках
//! (`suspend_sync`). Точка — каждый кадр: поток звука сообщает «дошёл до кадра k» и ждёт, пока главный поток посчитает
//! кадр игры (скрипты заводят голоса и крутят ручки через клон базового контекста — у него та же очередь сообщений).
//! Длина счёта — предел заранее; когда сценарий кончился, остаток досчитывается без остановок.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use web_audio_api::context::{BaseAudioContext as _, ConcreteBaseAudioContext, OfflineAudioContext};

/// Частота счёта: как у устройств по умолчанию.
pub const RATE: f32 = 48000.0;

pub struct Offline {
  pub ctx: ConcreteBaseAudioContext,
  thread: Option<JoinHandle<web_audio_api::AudioBuffer>>,
  reached: Receiver<u64>,
  go: Sender<()>,
  /// Счёт отпущен: дальше точки не ждут главный поток.
  released: Arc<AtomicBool>,
  /// Кадр, на котором поток звука стоит и ждёт.
  waiting: Option<u64>,
  frames: u64,
}

impl Offline {
  /// Счёт на seconds секунд при fps кадрах в секунду: точка остановки — на каждом кадре.
  pub fn new(seconds: f64, fps: f64) -> Self {
    let frames = (seconds * fps).ceil().max(1.0) as u64;
    let length = ((frames as f64 / fps) * RATE as f64).ceil() as usize + 1;
    let mut context = OfflineAudioContext::new(2, length, RATE);
    let ctx = context.base().clone();
    let (reached_tx, reached) = channel::<u64>();
    let (go, go_rx) = channel::<()>();
    let go_rx = Arc::new(Mutex::new(go_rx));
    let released = Arc::new(AtomicBool::new(false));
    for frame in 0..frames {
      let reached = reached_tx.clone();
      let go = go_rx.clone();
      let released = released.clone();
      context.suspend_sync(frame as f64 / fps, move |_| {
        if released.load(Ordering::Acquire) {
          return;
        }
        if reached.send(frame).is_ok() {
          let _ = go.lock().expect("канал звука").recv();
        }
      });
    }
    let thread = std::thread::spawn(move || context.start_rendering_sync());
    Self { ctx, thread: Some(thread), reached, go, released, waiting: None, frames }
  }

  /// Перед кадром frame: дождаться, пока поток звука дойдёт до него и встанет.
  pub fn begin(&mut self, frame: u64) {
    if frame >= self.frames || self.released.load(Ordering::Acquire) {
      return;
    }
    while self.waiting.is_none_or(|waiting| waiting < frame) {
      match self.reached.recv() {
        Ok(reached) => self.waiting = Some(reached),
        Err(_) => return,
      }
      // Кадр, до которого главный поток не дошёл (такого быть не должно), — дальше.
      if self.waiting.is_some_and(|waiting| waiting < frame) {
        let _ = self.go.send(());
      }
    }
  }

  /// После кадра: поток звука идёт дальше, до следующего кадра.
  pub fn end(&mut self) {
    if self.waiting.take().is_some() {
      let _ = self.go.send(());
    }
  }

  /// Конец: остаток досчитывается без остановок; звук всего счёта — каналами.
  pub fn finish(mut self) -> Result<Vec<Vec<f32>>, String> {
    self.released.store(true, Ordering::Release);
    // Поток мог встать в точке до того, как узнал, что его отпустили.
    for _ in 0..2 {
      let _ = self.go.send(());
    }
    let buffer = self.thread.take().expect("поток звука").join().map_err(|_| "поток звука упал".to_string())?;
    Ok((0..buffer.number_of_channels()).map(|channel| buffer.get_channel_data(channel).to_vec()).collect())
  }
}
