//! Звук в браузерной сборке — пока молчит: тот же API, что у `audio.rs`, но синтезатора нет (`Engine::new` — None),
//! и партия идёт без звука. Web Audio браузера (`AudioContext`) — следующий шаг.

#![allow(dead_code)]

use mlua::{Lua, Table, UserData, Value};
use std::rc::Rc;

/// Группы громкости, как CHANNELS в audio.ts.
pub const BUSES: [&str; 4] = ["battle", "world", "interface", "music"];

pub struct Engine;

impl Engine {
  pub fn new() -> Option<Rc<Self>> {
    None
  }

  pub fn bake(&self, _: &[(String, Table)]) -> mlua::Result<()> {
    Ok(())
  }

  pub fn set_volume(&self, _: &str, _: f32) {}
}

pub struct Sound;

impl Sound {
  pub fn place(&self, _: f32, _: f32) {}

  pub fn knobs(&self, _: &Lua, _: &Value) -> mlua::Result<()> {
    Ok(())
  }

  pub fn release(&mut self, _: f64) {}
}

impl UserData for Sound {}

pub struct Audio {
  pub engine: Rc<Engine>,
}

impl Audio {
  pub fn new(engine: Rc<Engine>, _: &[(String, Table)]) -> mlua::Result<Self> {
    Ok(Self { engine })
  }

  pub fn now(&self) -> f64 {
    0.0
  }

  #[allow(clippy::too_many_arguments)]
  pub fn start(&self, _: &Lua, _: &Value, _: &str, _: Option<&NodeTarget>, _: Option<f64>, _: Option<f64>, _: f64, _: f64, _: Value) -> mlua::Result<Option<Sound>> {
    Ok(None)
  }

  pub fn play(&self, _: &str, _: f32, _: f32, _: f32) {}

  pub fn loop_level(&self, _: &str, _: f32, _: f32) {}

  pub fn set_volume(&self, _: &str, _: f32) {}

  pub fn random(&self) -> f64 {
    0.5
  }

  pub fn level(&self) -> Option<f32> {
    None
  }
}

pub struct NodeTarget;

impl NodeTarget {
  pub fn from_value(_: &Value) -> mlua::Result<Option<Self>> {
    Ok(None)
  }
}
