//! Синтетический замер подхода «движок на Rust, контент на Luau» (docs/content.md). Движок держит юнитов (по умолчанию 10 тыс.)
//! столбцами; ходовая `base/moves/wheels.luau` двигает их системой над столбцами, юнит `base/units/buggy.luau` даёт
//! данные и облик. Меряется: та же система на Rust, на Luau столбцами (с копированием в буферы и без), Luau с вызовом
//! на юнита — с нативной компиляцией Luau и без неё (на iOS её нет) — и чертёж юнита на 64 направления.

mod probe;

use content_bench::{bytes, floats, load, new_lua, Pixmap, TURN};
use mlua::{Buffer, Function, Table, Value};
use std::time::Instant;

const TICKS: u64 = 200;
const DT: f64 = 0.05;

/// Сколько юнитов: первый аргумент запуска, по умолчанию 10 тыс.
static UNITS: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| std::env::args().nth(1).and_then(|count| count.parse().ok()).unwrap_or(10_000));

/// Столбцы движка: у юнита место, поворот и цель.
#[derive(Clone)]
struct Columns {
  x: Vec<f64>,
  y: Vec<f64>,
  facing: Vec<f64>,
  tx: Vec<f64>,
  ty: Vec<f64>,
}

impl Columns {
  fn new() -> Self {
    let spread = |i: usize, salt: usize| ((i * 2654435761 + salt) % 500) as f64 + 0.5;
    Self {
      x: (0..*UNITS).map(|i| spread(i, 1)).collect(),
      y: (0..*UNITS).map(|i| spread(i, 7)).collect(),
      facing: vec![0.0; *UNITS],
      tx: (0..*UNITS).map(|i| spread(i, 13)).collect(),
      ty: (0..*UNITS).map(|i| spread(i, 29)).collect(),
    }
  }
}

fn wrap(angle: f64) -> f64 {
  angle - TURN * (angle / TURN + 0.5).floor()
}

fn retarget(i: usize, tick: u64) -> (f64, f64) {
  let seed = (i as u64 * 7919 + tick * 104729) % 1000003;
  ((seed % 500) as f64 + 0.5, ((seed / 500) % 500) as f64 + 0.5)
}

/// Та же ходовая, что в wheels.luau, на Rust: точка отсчёта.
fn move_rust(c: &mut Columns, speed: f64, turn: f64, tick: u64) {
  let (step, turn) = (speed * DT, turn * DT);
  for i in 0..*UNITS {
    let (px, py) = (c.x[i], c.y[i]);
    let (mut dx, mut dy) = (c.tx[i] - px, c.ty[i] - py);
    if dx * dx + dy * dy < 0.25 {
      let (gx, gy) = retarget(i, tick);
      c.tx[i] = gx;
      c.ty[i] = gy;
      dx = gx - px;
      dy = gy - py;
    }
    let mut face = c.facing[i];
    let off = wrap(dy.atan2(dx) - face);
    face += if off.abs() <= turn { off } else { turn.copysign(off) };
    let ahead = off.cos();
    if ahead > 0.0 {
      c.x[i] = px + face.cos() * step * ahead;
      c.y[i] = py + face.sin() * step * ahead;
    }
    c.facing[i] = face;
  }
}

/// Среднее время тика в миллисекундах.
fn per_tick(mut tick: impl FnMut(u64)) -> f64 {
  for t in 0..20 {
    tick(t);
  }
  let start = Instant::now();
  for t in 0..TICKS {
    tick(t + 20);
  }
  start.elapsed().as_secs_f64() * 1000.0 / TICKS as f64
}

fn run(native: bool) -> mlua::Result<()> {
  let lua = new_lua(native)?;
  if native {
    println!("  машинный код Luau здесь: {}", if mlua::Lua::new().enable_jit(true).is_ok() { "есть" } else { "нет" });
  }
  let started = Instant::now();
  let wheels = load(&lua, "moves/wheels.luau")?;
  let buggy = load(&lua, "units/buggy.luau")?;
  println!("  загрузка двух видов: {:.2} мс", started.elapsed().as_secs_f64() * 1000.0);
  let data: Table = buggy.get("data")?;
  let (speed, turn): (f64, f64) = (data.get("speed")?, data.get("turn")?);
  let system: Function = wheels.get::<Table>("systems")?.get("move")?;

  // Столбцы — буферы Luau. С копированием: движок пишет свои столбцы в буферы и читает обратно каждый тик.
  let mut columns = Columns::new();
  let make = |column: &[f64]| lua.create_buffer(bytes(column));
  let (x, y, facing, tx, ty) = (make(&columns.x)?, make(&columns.y)?, make(&columns.facing)?, make(&columns.tx)?, make(&columns.ty)?);
  let ctx = lua.create_table();
  for (name, buffer) in [("x", &x), ("y", &y), ("facing", &facing), ("tx", &tx), ("ty", &ty)] {
    ctx.set(name, buffer.clone())?;
  }
  ctx.set("n", *UNITS)?;
  ctx.set("speed", speed)?;
  ctx.set("turn", turn)?;
  ctx.set("dt", DT)?;
  let pairs: [(&Buffer, fn(&mut Columns) -> &mut Vec<f64>); 5] = [(&x, |c| &mut c.x), (&y, |c| &mut c.y), (&facing, |c| &mut c.facing), (&tx, |c| &mut c.tx), (&ty, |c| &mut c.ty)];
  let copied = per_tick(|tick| {
    for (buffer, column) in &pairs {
      (*buffer).clone().write_bytes(0, &bytes(column(&mut columns)));
    }
    ctx.set("tick", tick).unwrap();
    system.call::<()>(&ctx).unwrap();
    for (buffer, column) in &pairs {
      *column(&mut columns) = floats(&buffer.to_vec());
    }
  });
  // Без копирования: столбцы живут в буферах, движок читает их на месте.
  let resident = per_tick(|tick| {
    ctx.set("tick", tick).unwrap();
    system.call::<()>(&ctx).unwrap();
  });
  println!("  Luau столбцами: {resident:.3} мс на тик, с копированием столбцов туда и обратно — {copied:.3} мс");

  // Вызов на юнита: движок зовёт функцию ходовой для каждого.
  let step: Function = wheels.get("step")?;
  let mut columns = Columns::new();
  let each = per_tick(|_| {
    for i in 0..*UNITS {
      let (px, py, face): (f64, f64, f64) = step.call((columns.x[i], columns.y[i], columns.facing[i], columns.tx[i], columns.ty[i], speed * DT, turn * DT)).unwrap();
      columns.x[i] = px;
      columns.y[i] = py;
      columns.facing[i] = face;
    }
  });
  println!("  Luau вызовом на юнита: {each:.3} мс на тик");

  // Облик: чертёж на все направления.
  let look: Table = buggy.get("look")?;
  let draw: Function = look.get("draw")?;
  let (frame, directions): (usize, usize) = (look.get("frame")?, look.get("directions")?);
  let start = Instant::now();
  let mut filled = 0;
  for phase in 0..2 {
    for direction in 0..directions {
      let canvas = lua.create_userdata(Pixmap { size: frame, data: vec![0; frame * frame] })?;
      draw.call::<()>((&canvas, direction as f64 / directions as f64 * TURN, phase))?;
      filled += canvas.borrow::<Pixmap>()?.data.iter().filter(|&&pixel| pixel != 0).count();
    }
  }
  println!("  чертёж багги: {} кадров {frame}×{frame} за {:.2} мс (закрашено {filled} пикселей)", directions * 2, start.elapsed().as_secs_f64() * 1000.0);
  let sound: Table = look.get("sound")?;
  let voice: String = sound.get("voice")?;
  let _: Value = sound.get("pitch")?;
  println!("  звук: голос «{voice}», синтез по параметрам вида");
  Ok(())
}

fn main() -> mlua::Result<()> {
  println!("{} юнитов, {TICKS} тиков по {DT} с", *UNITS);
  let mut columns = Columns::new();
  let rust = per_tick(|tick| move_rust(&mut columns, 4.0, 3.0, tick));
  println!("Rust (точка отсчёта): {rust:.3} мс на тик");
  println!("Пробы, машинный код:");
  probe::probe(true)?;
  println!("Пробы, без него:");
  probe::probe(false)?;
  println!("Luau с нативной компиляцией:");
  run(true)?;
  println!("Luau без неё (как на iOS):");
  run(false)?;
  Ok(())
}
