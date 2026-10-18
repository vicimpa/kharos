//! Замер хоста: мод base и мод-замер, в котором N багги ездят по полю (новая цель доехавшему). Сравнить с голым
//! замером crates/content-bench: там та же ходовая без движка вокруг.
//!
//!   cargo run -p kharos-world --release --example bench [юнитов]

use kharos_content::{discover, Files, Mod};
use kharos_world::Host;
use std::path::Path;
use std::rc::Rc;
use std::time::Instant;

const BENCH: &[(&str, &str)] = &[
  ("mod.luau", "return { requires = { 'base' } }"),
  (
    "games/bench.luau",
    r#"
local bench = { data = { units = 10000, size = 250 } }
function bench.start(ctx)
  local n, size = bench.data.units, bench.data.size
  for i = 1, n do
    local x, y = (i * 7919) % (size * 2) - size, (i * 104729) % (size * 2) - size
    ctx:spawn("units/buggy", { Position = { x = x, y = y }, Owner = { player = 1 }, Drive = { tx = -x, ty = -y, moving = true } })
  end
end
bench.systems = {
  retarget = {
    query = { "Drive" },
    write = { "Drive" },
    after = "drive",
    run = function(q, ctx)
      local d = q.Drive
      local size = bench.data.size
      for i = 0, q.n - 1 do
        local at = i * 8
        if buffer.readf64(d.moving, at) == 0 then
          buffer.writef64(d.tx, at, ctx:random() * size * 2 - size)
          buffer.writef64(d.ty, at, ctx:random() * size * 2 - size)
          buffer.writef64(d.moving, at, 1)
        end
      end
    end,
  },
}
return bench
"#,
  ),
];

fn main() {
  let units: usize = std::env::args().nth(1).and_then(|count| count.parse().ok()).unwrap_or(10_000);
  let mut mods = discover(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods")).unwrap();
  let mut files = Files::default();
  for (path, text) in BENCH {
    files.files.insert(path.to_string(), text.replace("units = 10000", &format!("units = {units}")));
  }
  mods.push(Mod { name: "bench".into(), files: Rc::new(files), dir: None });
  let started = Instant::now();
  let mut host = Host::new(mods, Some("bench"), 1, &serde_json::Value::Null).unwrap();
  println!("загрузка модов: {:.1} мс", started.elapsed().as_secs_f64() * 1000.0);
  let started = Instant::now();
  host.start().unwrap();
  println!("{units} юнитов создано за {:.1} мс", started.elapsed().as_secs_f64() * 1000.0);
  for _ in 0..20 {
    host.tick(0.05).unwrap();
  }
  let ticks = 200;
  let started = Instant::now();
  for _ in 0..ticks {
    host.tick(0.05).unwrap();
  }
  println!("тик: {:.3} мс", started.elapsed().as_secs_f64() * 1000.0 / ticks as f64);
  for (name, [build, run, write, settle]) in host.timings() {
    let per = |ms: f64| ms / (ticks + 20) as f64;
    println!("  {name}: столбцы {:.3}, Luau {:.3}, назад {:.3}, команды {:.3} мс", per(build), per(run), per(write), per(settle));
  }
}
