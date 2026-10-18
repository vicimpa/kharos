//! FORN trace 层（阶段二 PoC）rt 级判别。
//!
//! 判别面：
//! 1. **逐位一致红线**——trace 执行（旗标开，jit 关）与解释器（旗标
//!    关）结果逐位一致：matmul 内层 j 环形态、`sum = sum + ci[j]` 累加形态、
//!    零跳、分数循环变量（入口守卫拒承）、step≠1（拒承）、环中途界外
//!    （逐迭代守卫 bail 快照回落，解释器续跑收尾）、整数域 FMA 双态一致。
//! 2. **命中判据**——forn_trace_stats 证明 trace 真实安装并原生执行
//!    （非「旗标开了但没走到」的假绿）。
//! 3. **matmul 形态粗测提速**——同负载旗标开关墙钟对比（rt 级粗测，全组
//!    A/B 留后续片）。

#![cfg(feature = "jit")]

use std::{sync::Mutex, time::Instant};

use ulua_code_gen::functions::trace_forn_registry::forn_trace_stats;
use ulua_common::records::f_value::FValue;
use ulua_rt::{Lua, Result};

/// 旗标为进程级全局：cargo test 默认并行，eval 段必须互斥（copatch 测试同款）。
static TRACE_FLAG_LOCK: Mutex<()> = Mutex::new(());

/// 旗标开（jit 关）= trace 形态；旗标关 = 纯解释器基线。
fn eval_trace(src: &str, trace: bool) -> Result<f64> {
  let _guard = TRACE_FLAG_LOCK.lock().unwrap();
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
  FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
  let lua = Lua::new();
  let v: f64 = lua.load(src).eval()?;
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
  Ok(v)
}

fn eval_trace_fma(src: &str, trace: bool, fma: bool) -> Result<f64> {
  let _guard = TRACE_FLAG_LOCK.lock().unwrap();
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
  FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", fma);
  let lua = Lua::new();
  let v: f64 = lua.load(src).eval()?;
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
  FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
  Ok(v)
}

/// 命中统计的互斥快照（与 eval 同锁，防并行用例串数）。
fn stats_with_lock() -> (u64, u64, u64, u64) {
  let _guard = TRACE_FLAG_LOCK.lock().unwrap();
  forn_trace_stats()
}

/// matmul 内层 j 环形态（闭体 5 指令：GETTABLE×2 + MUL + ADD + SETTABLE）。
const MATMUL_J_LOOP: &str = r#"
local n = 40
local a, b, c = {}, {}, {}
for i = 1, n do
  a[i], b[i], c[i] = {}, {}, {}
  for j = 1, n do
    a[i][j] = (i + j) % 7
    b[i][j] = (i * 2 + j) % 5
    c[i][j] = 0
  end
end
for i = 1, n do
  local ai, ci = a[i], c[i]
  for k = 1, n do
    local aik, bk = ai[k], b[k]
    for j = 1, n do
      ci[j] = ci[j] + aik * bk[j]
    end
  end
end
local sum = 0
for i = 1, n do
  local ci = c[i]
  for j = 1, n do sum = sum + ci[j] end
end
return sum
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_matches_interpreter_matmul_j_loop() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MATMUL_J_LOOP, false)?;
  let traced = eval_trace(MATMUL_J_LOOP, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "trace 执行必须与解释器逐位一致");
  assert!(after.0 > before.0, "trace 必须真实安装（compiled 增量）");
  assert!(
    after.1 > before.1,
    "trace 必须真实原生执行（executed 增量，防假绿）"
  );
  Ok(())
}

/// 累加形态：`sum = sum + t[j]`（回边 phi 槽 + ArrayLoad + ADD）。
/// 热环计数挂 FORNPREP 入口（每环一次）——单层环一次 load 仅 1 次问询，
/// 外层重复驱动使其越过 K_HEAT_THRESHOLD（安装后 r 余量轮次走原生）。
const ACC_SHAPE: &str = r#"
local t = {}
for i = 1, 1500 do t[i] = i % 13 + 0.5 end
local sum = 0
for r = 1, 1100 do
  for j = 1, 1500 do
    sum = sum + t[j]
  end
end
return sum
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_matches_interpreter_accumulator_shape() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(ACC_SHAPE, false)?;
  let traced = eval_trace(ACC_SHAPE, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "累加器 phi 形态必须与解释器逐位一致");
  assert!(after.1 > before.1, "累加形态 trace 必须命中执行");
  Ok(())
}

/// 环中途界外 bail：每轮独立 3 槽表、内环 1..10 → j=4 界守卫 bail，
/// 解释器从 SETTABLE 位点重做（该表扩容收尾）。热环计数挂 FORNPREP
/// 入口——安装约在第 1000 轮问询，此后轮次才走原生：表按轮新建，
/// 保证安装后的每轮 j=4 仍界外 bail（单表形态扩容后不再 bail，断言必空转）。
/// 表提取（ts[r]）必须在内环外：GETTABLE 下标为外环变量会被录制面拒收。
const MID_LOOP_BAIL: &str = r#"
local ts = {}
for i = 1, 1100 do ts[i] = {10, 20, 30} end
for r = 1, 1100 do
  local t = ts[r]
  for j = 1, 10 do
    t[j] = j
  end
end
return ts[1100][10]
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_bails_mid_loop_and_falls_back_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MID_LOOP_BAIL, false)?;
  let traced = eval_trace(MID_LOOP_BAIL, true)?;
  let after = stats_with_lock();
  println!("bail stats before={before:?} after={after:?}");
  assert_eq!(traced, interp, "环中途 bail 回落必须与解释器逐位一致");
  assert!(
    after.2 > before.2,
    "界外迭代必须走守卫 bail（bailed 增量证明快照回落被真实执行）"
  );
  Ok(())
}

/// 零跳：`for i = 1, 0`（FORNPREP 出口直落，idx 槽不动）。环体须可录
/// （SETTABLE 直线形态；全局读写会 GETGLOBAL 拒录），外层驱动 1100 轮
/// 问询越过热环阈值，安装后的余量轮次走 Rust 侧快回落。
const ZERO_TRIP: &str = r#"
local t = {}
for r = 1, 1100 do
  for i = 1, 0 do
    t[i] = i
  end
end
return 42
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_zero_trip_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(ZERO_TRIP, false)?;
  let traced = eval_trace(ZERO_TRIP, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp);
  assert!(
    after.3 > before.3,
    "零跳必须走 Rust 侧快回落（zero_trip 增量）"
  );
  Ok(())
}

/// 入口守卫拒承形态：分数循环变量 / step≠1 / 元表数组——全回解释器，逐位一致。
const GUARD_REFUSED: &str = r#"
local acc = 0
for i = 1.5, 3 do
  acc = acc + i
end
for i = 1, 6, 2 do
  acc = acc + i
end
local mt = setmetatable({}, { __index = function(_, k) return k * 2 end })
for i = 1, 4 do
  acc = acc + mt[i]
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_guard_refused_shapes_bit_exact() -> Result<()> {
  let interp = eval_trace(GUARD_REFUSED, false)?;
  let traced = eval_trace(GUARD_REFUSED, true)?;
  assert_eq!(traced, interp, "守卫拒承形态（分数/步长/元表）必须逐位一致");
  Ok(())
}

/// FMA 旗标隔离：整数域负载（乘积与累加和均 < 2^53，单舍入=精确）双态一致；
/// fmla 折叠面被真实生成（compiled 增量在 FMA 开时同样发生）。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_fma_flag_isolated_bit_exact_on_integer_domain() -> Result<()> {
  let interp = eval_trace(MATMUL_J_LOOP, false)?;
  let traced_fma_off = eval_trace_fma(MATMUL_J_LOOP, true, false)?;
  let traced_fma_on = eval_trace_fma(MATMUL_J_LOOP, true, true)?;
  assert_eq!(traced_fma_off, interp, "FMA 关 = 双舍入逐位一致");
  assert_eq!(
    traced_fma_on, interp,
    "整数域（全部中间值精确）下单舍入 = 双舍入，FMA 开仍逐位一致"
  );
  Ok(())
}

/// jit 开 + trace 旗标开：解释层问询不与 JIT 冲突，结果一致。
/// 基线先取（eval_trace 内部持同一把旗标锁）——锁不可重入，禁在持锁段内
/// 再走 eval_trace（前会话 WIP 的自死锁点）。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_flag_with_jit_enabled_sanity() -> Result<()> {
  let interp = eval_trace(MATMUL_J_LOOP, false)?;
  let _guard = TRACE_FLAG_LOCK.lock().unwrap();
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", true);
  let lua = Lua::new();
  lua.enable_jit(true)?;
  let v: f64 = lua.load(MATMUL_J_LOOP).eval()?;
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
  assert_eq!(v, interp, "jit 开 + trace 旗标开结果必须与解释器一致");
  Ok(())
}

/// matmul 形态粗测提速（rt 级）：旗标开（j/k 环走 trace 原生）vs 旗标关
///（纯解释器）。判据 = 轮次中位 trace 快 ≥ 20%（j 环为负载绝对主体，
/// 寄存器驻留 + 守卫外提的收益档；debug 解释器基线下余量充足）。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_matmul_shape_measurable_speedup() -> Result<()> {
  let src = r#"
local n = 60
local a, b, c = {}, {}, {}
for i = 1, n do
  a[i], b[i], c[i] = {}, {}, {}
  for j = 1, n do
    a[i][j] = (i + j) % 7
    b[i][j] = (i * 2 + j) % 5
    c[i][j] = 0
  end
end
for r = 1, 12 do
  for i = 1, n do
    local ai, ci = a[i], c[i]
    for k = 1, n do
      local aik, bk = ai[k], b[k]
      for j = 1, n do
        ci[j] = ci[j] + aik * bk[j]
      end
    end
  end
end
local sum = 0
for i = 1, n do
  local ci = c[i]
  for j = 1, n do sum = sum + ci[j] end
end
return sum
"#;

  let run_timed = |trace: bool| -> Result<(f64, f64)> {
    let _guard = TRACE_FLAG_LOCK.lock().unwrap();
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
    FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
    let lua = Lua::new();
    let t0 = Instant::now();
    let v: f64 = lua.load(src).eval()?;
    let dt = t0.elapsed().as_secs_f64() * 1000.0;
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
    Ok((dt, v))
  };

  // 预热（触发录制，避开计时段的编译税）
  let (_, v_warm) = run_timed(true)?;
  let (_, v_base) = run_timed(false)?;
  assert_eq!(v_warm, v_base, "粗测负载逐位一致前提");

  let mut base_times = Vec::new();
  let mut trace_times = Vec::new();
  for _ in 0..5 {
    let (t, v) = run_timed(false)?;
    base_times.push(t);
    assert_eq!(v, v_base);
    let (t, v) = run_timed(true)?;
    trace_times.push(t);
    assert_eq!(v, v_warm);
  }
  let med = |xs: &mut Vec<f64>| {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
  };
  let (mb, mt) = (med(&mut base_times), med(&mut trace_times));
  assert!(
    mt < mb * 0.80,
    "matmul 形态 trace 粗测应 ≥20% 提速：trace {mt:.1}ms vs interp {mb:.1}ms"
  );
  Ok(())
}

/// T3 MOD 族判别：`%`（MODK 常量形 + MOD 寄存器形）进环体——发射
/// `a - floor(a/b)*b` 四操作序列（fdiv→frintm→fmul→fsub）逐位对齐解释器
/// `luai_nummod`。覆盖：整数模（j % 48）、负被模数（(j - 13) % m，floormod
/// 符号修复面）、分数模（t[j] % 3.5，非整除商面）、链式多 MOD（micro_arith
/// 形态，配套放宽临时槽覆写——编译器跨指令复用临时寄存器是常态，覆写的
/// SSA 语义与解释器逐迭代覆写同构）。判据 = 逐位一致 + compiled/executed
/// 双增量。
const MOD_FAMILY: &str = r#"
local t = {}
for i = 1, 2000 do t[i] = i % 13 + 0.5 end
local m = 48
local sum, g, h, c = 0, 0.0, 0.0, 0
for r = 1, 1100 do
  for j = 1, 1500 do
    sum = sum + j % 48
  end
  for j = 1, 1500 do
    g = g + (j - 13) % m
  end
  for j = 1, 1500 do
    h = h + t[j] % 3.5
  end
  for j = 1, 1500 do
    c = c + j % 48 + (j + 7) % 48 + j * 7 + 13
  end
end
return sum + g + h + c
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_mod_family_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MOD_FAMILY, false)?;
  let traced = eval_trace(MOD_FAMILY, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "MOD 族（MODK/MOD/负数/分数）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "MOD 族必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "MOD 族必须真实原生执行（executed 增量，防假绿）"
  );
  Ok(())
}

/// T3 融合回边计数判别：环尾为 `ADDK → FORNLOOP`（尾融合边，micro_arith
/// 形态）且仅 2 次入口——入口面 2 < 1000 永不装机，装机只能来自
/// `fuse_succ_fornloop` 内的计数 tick（T3 修复：FORNLOOP 被前驱臂吃掉时
/// h_fornloop 不派发，T2 起该形态即盲区）。第 1 次入口内达阈装机，第 2 次
/// 入口整环原生。判据 = 逐位一致 + compiled/executed 双增量。
const FUSED_TAIL_BACKEDGE: &str = r#"
local sum = 0
for r = 1, 2 do
  for i = 1, 1000000 do
    sum = sum + i % 48 + (i + 7) % 48 + i * 7 + 13
  end
end
return sum
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_installs_fused_tail_loop_via_backedge_count() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(FUSED_TAIL_BACKEDGE, false)?;
  let traced = eval_trace(FUSED_TAIL_BACKEDGE, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "融合尾单层环必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "融合尾形态必须经回边面录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "第 2 次入口必须走原生（executed 增量——入口面 2 次 < 1000 永不装机，\
     增量只能来自融合回边 tick）"
  );
  Ok(())
}

/// T3 MOD 族粗测提速（rt 级，matmul 粗测同款协议）：同态多轮 ABBA，判据 =
/// 轮次中位 trace 快 ≥ 20%。负载 = micro_arith 环体形态（链式 MODK/MULK/
/// ADDK + MOD 族），同 state 多轮进入使装机后轮次整环走原生。注意：bench
/// 套件的 micro_arith 用例是单入口 × 2M 迭代形态，装机发生在回边 #1000——
/// 本次进入的剩余迭代仍走解释器，新状态单发测量无法收割（结构性边界入档）；
/// 本测试以同态多轮进入收割同款环体的原生收益。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_mod_shape_measurable_speedup() -> Result<()> {
  let src = r#"
local sum = 0
for r = 1, 60 do
  for i = 1, 60000 do
    sum = sum + i % 48 + (i + 7) % 48 + i * 7 + 13
  end
end
return sum
"#;

  let run_timed = |trace: bool| -> Result<(f64, f64)> {
    let _guard = TRACE_FLAG_LOCK.lock().unwrap();
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
    FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
    let lua = Lua::new();
    let t0 = Instant::now();
    let v: f64 = lua.load(src).eval()?;
    let dt = t0.elapsed().as_secs_f64() * 1000.0;
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
    Ok((dt, v))
  };

  // 预热（触发录制，避开计时段的编译税）
  let (_, v_warm) = run_timed(true)?;
  let (_, v_base) = run_timed(false)?;
  assert_eq!(v_warm, v_base, "粗测负载逐位一致前提");

  let mut base_times = Vec::new();
  let mut trace_times = Vec::new();
  for _ in 0..5 {
    let (t, v) = run_timed(false)?;
    base_times.push(t);
    assert_eq!(v, v_base);
    let (t, v) = run_timed(true)?;
    trace_times.push(t);
    assert_eq!(v, v_warm);
  }
  let med = |xs: &mut Vec<f64>| {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
  };
  let (mb, mt) = (med(&mut base_times), med(&mut trace_times));
  assert!(
    mt < mb * 0.80,
    "MOD 形态 trace 粗测应 ≥20% 提速：trace {mt:.1}ms vs interp {mb:.1}ms"
  );
  Ok(())
}

/// T2 回边计数判别：单层环（2 次进入 × 1500 迭代）——入口计数面永不达阈
///（2 < 1000），唯有回边面（1500 迭代 ≥ 阈值，首次进入内即装机）能解释
/// executed 增量。判据 = 逐位一致 + compiled/executed 双增量。
const SINGLE_LAYER_BACKEDGE: &str = r#"
local t = {}
for i = 1, 1500 do t[i] = i % 13 + 0.5 end
local sum = 0
for r = 1, 2 do
  for j = 1, 1500 do
    sum = sum + t[j]
  end
end
return sum
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_installs_single_layer_loop_via_backedge_count() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(SINGLE_LAYER_BACKEDGE, false)?;
  let traced = eval_trace(SINGLE_LAYER_BACKEDGE, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "单层环回边装机必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "回边计数必须触发录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "第 2 次进入必须走原生（executed 增量——入口计数面 2 次 < 1000 \
     永不装机，增量只能来自回边面）"
  );
  Ok(())
}

/// T2 同元素证明传播判别：同表双读（第二个 ArrayLoad 免界/tag 守卫直取）
/// 与累加器 phi 混合形态。形态取乘法右结合位（`t[j] * t[j]` 为外层 ADD 的
/// 右操作数，目标寄存器全新——左结合加法链会让 ADD 复用 GETTABLE 目标
/// 寄存器，触发录制面单写纪律拒录）。判据 = 逐位一致 + 真实安装执行。
const SAME_TABLE_DOUBLE_LOAD: &str = r#"
local t = {}
for i = 1, 2000 do t[i] = i % 17 + 0.5 end
local acc = 0
for r = 1, 2 do
  for j = 1, 2000 do
    acc = acc + t[j] * t[j]
  end
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_same_table_double_load_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(SAME_TABLE_DOUBLE_LOAD, false)?;
  let traced = eval_trace(SAME_TABLE_DOUBLE_LOAD, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "同表双读形态必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "同表双读形态必须真实录制（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "同表双读形态必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T4 族 3 判别（step≠1 泛化）：负步环 + PhiIdx 数组访问（逐迭代 fcvtzs
/// 往返精确性校验全程通过）+ 纯算术分数步环（非寻址形态，无精确性校验）。
/// 负步选向 = `limit <= idx`（GE），与 fornloop_step 逐位同式。单层双入口
/// 形态：装机只能来自回边面（入口计数 2 < 1000）。
const GENERAL_STEP: &str = r#"
local t = {}
for i = 1, 1200 do t[i] = i % 11 + 0.25 end
local s, f = 0.0, 0.0
for r = 1, 2 do
  for i = 1000, 1, -1 do
    s = s + t[i] * 3
  end
  for i = 1, 90000, 0.25 do
    f = f + i * 2 + 1
  end
end
return s + f
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_general_step_loops_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(GENERAL_STEP, false)?;
  let traced = eval_trace(GENERAL_STEP, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "负步/分数步环必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "step≠1 形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "step≠1 形态必须真实原生执行（executed 增量——入口面 2 次 < 1000 \
     永不装机，增量只能来自回边面）"
  );
  Ok(())
}

/// T4 族 3 判别（正步 step=2 泛 flavor + PhiIdx 数组访问 + 回边精确性校验）
/// 与零跳/NaN step 拒承形态：负向零跳（`limit <= idx` 首查即假）、NaN step
///（入口守卫拒承回解释器）。
const STEP2_AND_REFUSED: &str = r#"
local t = {}
for i = 1, 2010 do t[i] = i % 7 + 0.5 end
local s = 0.0
for r = 1, 2 do
  for i = 1, 2001, 2 do
    s = s + t[i]
  end
  for i = 10, 20, -1 do
    s = s + i
  end
  local nan = (0 / 0)
  for i = 1, 10, nan do
    s = s + i
  end
end
return s
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_step2_and_refused_shapes_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(STEP2_AND_REFUSED, false)?;
  let traced = eval_trace(STEP2_AND_REFUSED, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "正步泛 flavor 与拒承形态必须逐位一致");
  assert!(
    after.1 > before.1,
    "step=2 环必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T4 族 1 判别（嵌套表载 `ts[r][j]`）：外层 GETTABLE（下标 r = 外环变量
/// InvNum）结果驻派生表 x7/w13，内层 GETTABLE/SETTABLE 穿透派生表；附临时
/// 下标形态（`t[(j % 50) + 1]`，逐迭代 fcvtzs 往返精确性校验全程通过）。
/// 派生表逐迭代重读全守卫（界/tag==ttable/元表缺席），免别名论证。单层双
/// 入口形态：装机只能来自回边面。
const NESTED_TABLE_ACCESS: &str = r#"
local ts = {}
for i = 1, 1002 do
  local row = {}
  for j = 1, 1200 do row[j] = j % 23 + 0.5 end
  ts[i] = row
end
local s, w = 0.0, 0.0
for r = 1, 2 do
  for j = 1, 1200 do
    s = s + ts[r][j] * 2
  end
  for j = 1, 1200 do
    ts[r][j] = j * 2 + r
  end
  for j = 1, 1200 do
    w = w + ts[r][(j % 50) + 1]
  end
end
return s + w
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_nested_table_access_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(NESTED_TABLE_ACCESS, false)?;
  let traced = eval_trace(NESTED_TABLE_ACCESS, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "嵌套表载（ts[r][j] 读/写 + 临时下标）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "嵌套表载形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "嵌套表载形态必须真实原生执行（executed 增量——入口面 2 次 < 1000 \
     永不装机，增量只能来自回边面）"
  );
  Ok(())
}

/// T4 族 1 bail 面（泛化下标）：临时下标写环中段越界（行 8 槽、
/// `(j % 10) + 1` 触达 9/10 → 界守卫 bail，解释器从 SETTABLE 位点重做并
/// 扩容收尾，同 MID_LOOP_BAIL 模式但界守卫走逐迭代精确性校验新路径）。
/// 判据 = 逐位一致 + bailed 增量（快照回落被真实执行）。
const GEN_INDEX_BAIL: &str = r#"
local ts = {}
for i = 1, 1100 do ts[i] = {1, 2, 3, 4, 5, 6, 7, 8} end
for r = 1, 1100 do
  local row = ts[r]
  for j = 1, 10 do
    row[(j % 10) + 1] = j
  end
end
return #ts[1100]
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_gen_index_bail_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(GEN_INDEX_BAIL, false)?;
  let traced = eval_trace(GEN_INDEX_BAIL, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "临时下标界外 bail 回落必须与解释器逐位一致");
  assert!(
    after.2 > before.2,
    "泛化下标界守卫必须走 bail 快照回落（bailed 增量）"
  );
  Ok(())
}

/// T4 族 2 判别（直线体条件跳转·菱形双径直译）：布尔载 truthiness 面
/// （CondLoad 界守卫 only + tag 驻 W9 + 区域 acc 直写 d_acc，行外提单表）。
/// 真/假两侧多次采样（j%3==0 → 400 真/800 假每入口），跳转未走区域 acc
/// 自然保持。单层双入口形态：装机只能来自回边面。
const COND_BOOL: &str = r#"
local rows = {}
for i = 1, 3 do
  local row = {}
  for j = 1, 1200 do row[j] = j % 3 == 0 end
  rows[i] = row
end
local alive = 0
for r = 1, 2 do
  local row = rows[r]
  for j = 1, 1200 do
    if row[j] then alive = alive + 1 end
  end
end
return alive
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_cond_bool_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(COND_BOOL, false)?;
  let traced = eval_trace(COND_BOOL, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "布尔载条件环必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "条件环必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "条件环必须真实原生执行（executed 增量——入口面 2 次 < 1000 永不装机）"
  );
  Ok(())
}

/// T4 族 2 判别（数值比较三形）：JUMPIFLE（半区采样）、JUMPIFEQ（偶数
/// 采样，真/假交替）、JUMPIFLT × NaN（无序永假——arm 零执行，区域 acc
/// 保持零）。判据 = 逐位一致 + 真实安装执行。
const COND_CMP_FAMILIES: &str = r#"
local t = {}
for i = 1, 2000 do t[i] = i % 17 + 0.5 end
local s, c, n = 0.0, 0.0, 0.0
local nan = 0 / 0
for r = 1, 2 do
  for j = 1, 1200 do
    if j <= 600 then s = s + t[j] end
  end
  for j = 1, 1200 do
    if j % 2 == 0 then c = c + 1 end
  end
  for j = 1, 1200 do
    if t[j] < nan then n = n + t[j] end
  end
end
return s + c + n
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_cond_cmp_families_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(COND_CMP_FAMILIES, false)?;
  let traced = eval_trace(COND_CMP_FAMILIES, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "数值比较条件环（LE/EQ/LT×NaN）必须与解释器逐位一致"
  );
  assert!(
    after.1 > before.1,
    "比较条件环必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T4 族 2 bail 面：CondLoad 界外（行 2 元素、j 到 4 → j=3 界守卫 bail，
/// 解释器从 CondLoad 位点重做——nil 落 JUMPIFNOT 假臂收尾）。
const COND_BOOL_BAIL: &str = r#"
local ts = {}
for i = 1, 1100 do ts[i] = {true, true} end
local alive = 0
for r = 1, 1100 do
  local row = ts[r]
  for j = 1, 4 do
    if row[j] then alive = alive + 1 end
  end
end
return alive
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_cond_bool_bail_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(COND_BOOL_BAIL, false)?;
  let traced = eval_trace(COND_BOOL_BAIL, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "布尔载界外 bail 回落必须与解释器逐位一致");
  assert!(
    after.2 > before.2,
    "CondLoad 界守卫必须走 bail 快照回落（bailed 增量）"
  );
  Ok(())
}

/// T5-A GC 压力面：行表逐外轮重建 + 嵌套读写——traced 内环之间插入大量
/// 分配（churn 驱动自然 GC 步进），派生驻留（x7 array 指针/w13 sizearray）
/// 与写回槽（Table TValue）必须跨 GC 步进保持逐位一致（旧形态 checkliveness
/// 崩的定向压力位；环体无分配，GC 步进只落环间，符合录制无调用约束）。
const NESTED_TABLE_GC: &str = r#"
local ts = {}
local s = 0.0
for r = 1, 40 do
  local row = {}
  for j = 1, 2000 do row[j] = j * 1.5 end
  ts[r] = row
  local sink = {}
  for k = 1, 200 do sink[k] = {k, k + 1.5} end
  for j = 1, 2000 do
    s = s + ts[r][j]
  end
  for j = 1, 2000 do
    ts[r][j] = j + r
  end
  s = s + sink[200][1]
end
return s
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_nested_table_gc_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(NESTED_TABLE_GC, false)?;
  let traced = eval_trace(NESTED_TABLE_GC, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "嵌套读 + GC 压力必须与解释器逐位一致");
  assert!(after.0 > before.0, "GC 压力形态必须真实录制安装");
  assert!(after.1 > before.1, "GC 压力形态必须真实原生执行");
  Ok(())
}

/// T5-A bail 面：派生表内层越界（每轮独立 3 槽行、j 到 10 → 派生表界守卫
/// bail，解释器从 SETTABLE 位点重做并扩容收尾）与元表行（TableLoad 元表缺
/// 席守卫 bail，解释器慢路 rawget 等值收尾）。判据 = 逐位一致 + bailed 增量
///（快照回落被真实执行）。
const NESTED_TABLE_BAIL: &str = r#"
local ts, ms = {}, {}
local mt = {}
for i = 1, 1100 do
  ts[i] = {10, 20, 30}
  ms[i] = setmetatable({7, 8, 9}, mt)
end
for r = 1, 1100 do
  for j = 1, 10 do
    ts[r][j] = j
  end
  for j = 1, 3 do
    ms[r][j] = j
  end
end
return ts[1100][10] + ms[1100][3]
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_nested_table_bail_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(NESTED_TABLE_BAIL, false)?;
  let traced = eval_trace(NESTED_TABLE_BAIL, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "派生表界外/元表 bail 回落必须与解释器逐位一致"
  );
  assert!(
    after.2 > before.2,
    "派生表守卫必须走 bail 快照回落（bailed 增量）"
  );
  Ok(())
}

/// T5-B 判别（3 存多槽体，nbody 位置环形态）：`bi[k] = bi[k] + dt * bi[k+3]`
/// ×3 每迭代 12 个临时（旧 K_MAX_TEMPS=8 容量拒录，扩 d28..d31 后解锁）。
/// 装机面 = 入口计数（60000 入口 ≥ 1000）。判据 = 逐位一致 + compiled/executed
/// 增量。注：5 迭代短环端到端为负收益（入口问询+调用开销 > 环体收益，release
/// 实测 -175%），本判别钉的是形态解锁面而非提速面。
const MULTI_STORE_BODY: &str = r#"
local b = {}
for i = 1, 5 do
  b[i] = {i * 1.0, i * 2.0, i * 3.0, 0.1 * i, 0.2 * i, 0.3 * i, 1.0 / (i + 1)}
end
local n = #b
local dt = 0.01
for _ = 1, 60000 do
  for i = 1, n do
    local bi = b[i]
    bi[1] = bi[1] + dt * bi[4]
    bi[2] = bi[2] + dt * bi[5]
    bi[3] = bi[3] + dt * bi[6]
  end
end
local s = 0.0
for i = 1, n do s = s + b[i][1] end
return s
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_multi_store_body_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MULTI_STORE_BODY, false)?;
  let traced = eval_trace(MULTI_STORE_BODY, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "3 存多槽体必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "多槽体必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "多槽体必须真实原生执行（executed 增量——60000 入口 ≥ 1000 装机）"
  );
  Ok(())
}

/// T6 族 1 判别（GETIMPORT 环体全局读）：`local s = string`（GETIMPORT）+
/// `if s ~= nil`（JUMPXEQKNIL）+ AccArith 组合环。GETIMPORT 安全双守卫
/// （safeenv + k[D] 非 nil——沙箱启用置 safeenv）提至入口，prologue 全
/// TValue 常量拷贝（位对齐解释器 fast-path `setobj(ra, kv)`），环内零
/// 代码；k[D] 位型进身份面（import 缓存改写即重录）。嵌套驱动环保证
/// 装机后有再入入口（单入口环装机后无收割面，结构性边界）。
const GETIMPORT_NIL_LOOP: &str = r#"
local acc = 0
for _ = 1, 4 do
  for _ = 1, 600 do
    local s = string
    if s ~= nil then acc = acc + 1 end
  end
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_getimport_nil_loop_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", true);
  let lua = Lua::new();
  lua.sandbox(true)?;
  let vi: f64 = {
    let li = Lua::new();
    li.sandbox(true)?;
    li.load(GETIMPORT_NIL_LOOP).eval()?
  };
  let vt: f64 = lua.load(GETIMPORT_NIL_LOOP).eval()?;
  FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
  let after = stats_with_lock();
  assert_eq!(vt, vi, "GETIMPORT 环必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "GETIMPORT 环必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "GETIMPORT 环必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T6 族 2 判别（CALL 特化：math.sqrt → fsqrt 直译）：`local sqrt =
/// math.sqrt`（GETIMPORT 环外局部）+ 内环 `sqrt(dist2)` 单参单返回 CALL
/// （nbody j 环形态）。守卫三层：sqrt 槽跨环不变（体无写，入口复检槽值
/// 仍为 math_sqrt C 函数）、参数/返回皆 number 特化面（特化不变量，非
/// number 参数在解释器同执行路径先抛 check_number）。fsqrt IEEE 正确
/// 舍入逐位对齐 f64::sqrt。嵌套驱动环保证装机后有再入入口。
const SQRT_CALL_LOOP: &str = r#"
local sqrt = math.sqrt
local acc = 0.0
for _ = 1, 4 do
  for i = 1, 600 do
    local d2 = i * i + 1
    local r = sqrt(d2)
    acc = acc + r * 2 - d2
  end
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_sqrt_call_loop_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(SQRT_CALL_LOOP, false)?;
  let traced = eval_trace(SQRT_CALL_LOOP, true)?;
  let after = stats_with_lock();
  assert_eq!(traced, interp, "sqrt CALL 特化环必须与解释器逐位一致");
  assert!(
    after.0 > before.0,
    "sqrt 特化环必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "sqrt 特化环必须真实原生执行（executed 增量——装机后 3 个再入入口原生）"
  );
  Ok(())
}

/// T7 族 3 判别（math 单参内建族 FASTCALL1 形态）：floor/ceil/abs/round
/// 四族同环（`local b = math.floor` 绑定 + `b(d)` 直调形态），负/正/分数
/// 下标全覆盖（d = i - 300.75 触 -299.75..299.25）。发射 = 单指令直译
///（frintm/frintp/fabs/frinta），IEEE roundToIntegral 族与 Rust f64 方法
/// 语义规格逐一对应，逐位一致构造性成立。参数/返回皆 number 特化面（非
/// number 参数在解释器同执行路径先抛 check_number）。嵌套驱动环保证装机
/// 后有再入入口。
const MATH_UNARY_FASTCALL_LOOP: &str = r#"
local floor = math.floor
local ceil = math.ceil
local abs = math.abs
local round = math.round
local acc = 0.0
for _ = 1, 4 do
  for i = 1, 600 do
    local d = i - 300.75
    acc = acc + floor(d) + ceil(d) + abs(d) + round(d)
  end
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_math_unary_fastcall_loop_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MATH_UNARY_FASTCALL_LOOP, false)?;
  let traced = eval_trace(MATH_UNARY_FASTCALL_LOOP, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "math 单参内建族（FASTCALL1 形态）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "math 单参内建族必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "math 单参内建族必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T7 族 3 判别（CALL func 槽形态 + 跨内建种入口拒承）：f 经函数参数槽
/// 传递（apply(floor,…) 一次、apply(abs,…) 一次）——func 槽在录制期按帧
/// 实测标定为 Cfn{slot, kind}，入口守卫按 (槽, 种) 复检：apply(abs) 对
/// floor 特化环必须整环拒承回解释器（防跨内建重赋值错特化），位一致由
/// 解释器重做保证。
const MATH_UNARY_CALL_VIA_ARG: &str = r#"
local function apply(f, acc, n)
  for j = 1, n do
    acc = acc + f(j - 150.5)
  end
  return acc
end
local floor = math.floor
local s = 0.0
for _ = 1, 4 do
  s = apply(floor, s, 600)
end
for _ = 1, 2 do
  s = apply(math.abs, s, 600)
end
return s
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_math_unary_call_via_arg_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(MATH_UNARY_CALL_VIA_ARG, false)?;
  let traced = eval_trace(MATH_UNARY_CALL_VIA_ARG, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "math 内建 CALL 形态（func 参数槽）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "CALL 形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "CALL 形态必须真实原生执行（executed 增量——floor 次入口装机后原生）"
  );
  Ok(())
}

/// T7 族 3 非 number 参数面：环中途元素变 string——特化环 ArrayLoad 的
/// tag==number 守卫 bail，解释器从载入位点重做后在 floor 的 check_number
/// 抛错。两态错误必须一致（位一致红线含错误传播面）。
const MATH_UNARY_NON_NUMBER: &str = r#"
local floor = math.floor
local t = {}
for i = 1, 2000 do t[i] = i * 1.5 end
local acc = 0.0
for r = 1, 2 do
  for j = 1, 1200 do
    acc = acc + floor(t[j])
  end
end
t[800] = "bad"
for j = 1, 1200 do
  acc = acc + floor(t[j])
end
return acc
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_math_unary_non_number_bails_consistently() -> Result<()> {
  let interp_err = format!("{}", eval_trace(MATH_UNARY_NON_NUMBER, false).unwrap_err());
  let traced_err = format!("{}", eval_trace(MATH_UNARY_NON_NUMBER, true).unwrap_err());
  assert_eq!(
    traced_err, interp_err,
    "非 number 参数的 check_number 抛错必须两态一致"
  );
  Ok(())
}

/// T7 族 3 A/B 配对（rt 级，≥5 轮 med，AB 交替，位一致前提断言）：
/// floor 环微负载（fasta 内环形态 `floor(x + dx)`）同 state 多轮进入，
/// 判据 = 轮次中位 trace 快 ≥ 5%。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_math_unary_measurable_speedup() -> Result<()> {
  let src = r#"
local floor = math.floor
local sum = 0.0
for r = 1, 60 do
  for i = 1, 60000 do
    sum = sum + floor(i * 0.75) + floor(i - 13)
  end
end
return sum
"#;

  let run_timed = |trace: bool| -> Result<(f64, f64)> {
    let _guard = TRACE_FLAG_LOCK.lock().unwrap();
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
    FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
    let lua = Lua::new();
    let t0 = Instant::now();
    let v: f64 = lua.load(src).eval()?;
    let dt = t0.elapsed().as_secs_f64() * 1000.0;
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
    Ok((dt, v))
  };

  // 预热（触发录制，避开计时段的编译税）
  let (_, v_warm) = run_timed(true)?;
  let (_, v_base) = run_timed(false)?;
  assert_eq!(v_warm, v_base, "粗测负载逐位一致前提");

  let mut base_times = Vec::new();
  let mut trace_times = Vec::new();
  for _ in 0..5 {
    let (t, v) = run_timed(false)?;
    base_times.push(t);
    assert_eq!(v, v_base);
    let (t, v) = run_timed(true)?;
    trace_times.push(t);
    assert_eq!(v, v_warm);
  }
  let med = |xs: &mut Vec<f64>| {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
  };
  let (mb, mt) = (med(&mut base_times), med(&mut trace_times));
  println!("floor 环 A/B：trace {mt:.1}ms vs interp {mb:.1}ms");
  assert!(
    mt < mb * 0.95,
    "floor 环 trace 应 ≥5% 提速：trace {mt:.1}ms vs interp {mb:.1}ms"
  );
  Ok(())
}

/// T7 任务 2 判别（派生表写形态·gc 对象覆盖 + churn + 环间读写混合）：
/// 行表元素先持 `{}`（gc 指针），派生写（TableStore{Derived}，x7 array
/// 指针寻址）以 number 覆盖——写面语义与解释器写值快路同构：luaC_barriert
/// 谓词 iscollectable(v) 对 number 恒假 → 屏障零动作（fuse_succ_settable
/// 同款前提直写），界守卫限制在 array 段不触 hash/rehash；行表逐外轮重建，
/// churn 分配驱动自然 GC 步进，覆盖后的旧对象在两态下经同一 sweep 面
/// 回收——若写面漏语义（T4 时代炸 checkliveness 的病灶），本判别会在
/// set_obj/gc 断言处两态分化。读环（s 累加）与写环（覆盖）及复读环（total
/// 收尾）构成环间读写混合。判据 = 逐位一致 + compiled/executed 双增量。
const DERIVED_STORE_OVER_GC: &str = r#"
local ts = {}
for r = 1, 40 do
  local row = {}
  for j = 1, 300 do row[j] = {} end
  ts[r] = row
  local sink = {}
  for k = 1, 100 do sink[k] = {k, k + 0.5} end
  for j = 1, 300 do
    ts[r][j] = j * 1.5
  end
  local s = 0.0
  for j = 1, 300 do
    s = s + ts[r][j]
  end
end
local total = 0.0
for r = 1, 40 do
  local row = ts[r]
  for j = 1, 300 do total = total + row[j] end
end
return total
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_derived_store_over_gc_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(DERIVED_STORE_OVER_GC, false)?;
  let traced = eval_trace(DERIVED_STORE_OVER_GC, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "派生写覆盖 gc 对象 + churn + 读写混合必须与解释器逐位一致"
  );
  assert!(after.0 > before.0, "派生写覆盖形态必须真实录制安装");
  assert!(after.1 > before.1, "派生写覆盖形态必须真实原生执行");
  Ok(())
}

/// T8 族 1 判别（变更载体 upvalue 累加，open/closed 双态同 trace + trace
/// 内外读写混合 + GC churn）：`sum` 被内层闭包读改写（SETUPVAL 强制
/// LCT_REF 捕获 → 真 UpVal cell）——环体 GETUPVAL+GETTABLE+ADD+SETUPVAL
/// 四元形态，跨迭代累加经 cell 传递（逐访问穿 cell 读 + 写，无 phi 依赖）。
/// 开态段（mk 帧存活，cell 指向 mk 栈槽）装机（入口计数 #1000），闭态段
/// （mk 返回 → luaF_close 升级 storage）同一 trace 逐入口重解 cell 承接；
/// bump 为解释器写同一 cell（trace 内外读写混合），每轮 churn 分配驱动
/// 自然 GC 步进。判据 = 逐位一致（含手算期望值钉死累加真发生）+
/// compiled/executed 双增量。
const UPVAL_MUTABLE_ACC: &str = r#"
local function mk()
  local sum = 0.0
  local function inner(t, n)
    for j = 1, n do
      sum = sum + t[j]
    end
  end
  local function bump(x)
    sum = sum + x
    return sum
  end
  local t = {}
  for i = 1, 1500 do t[i] = i % 13 + 0.5 end
  for r = 1, 1100 do
    local sink = {}
    for k = 1, 20 do sink[k] = {k, k + 0.5} end
    inner(t, 1500)
    bump(0.5)
  end
  return inner, bump, t
end
local inner, bump, t = mk()
for r = 1, 1100 do
  local sink = {}
  for k = 1, 20 do sink[k] = {k, k + 0.5} end
  inner(t, 1500)
  bump(0.5)
end
return bump(0)
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_mutable_acc_bit_exact() -> Result<()> {
  // 手算期望：inner 单轮 Σ(j%13+0.5) = 8985 + 750 = 9735，2200 轮 +
  // bump 2200×0.5 = 21418100.0——钉死累加真发生（GETUPVAL 读到 SETUPVAL
  // 上一迭代写穿 cell 的新值），防 get 捕获陈值的两态一致假绿
  let expected = 21_418_100.0_f64;
  let before = stats_with_lock();
  let interp = eval_trace(UPVAL_MUTABLE_ACC, false)?;
  let traced = eval_trace(UPVAL_MUTABLE_ACC, true)?;
  let after = stats_with_lock();
  assert_eq!(interp, expected, "解释器基线须命中手算期望（形态自检）");
  assert_eq!(
    traced, interp,
    "变更载体 upvalue 累加（open/closed 双态 + 混合读写）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "upvalue 累加形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "upvalue 累加形态必须真实原生执行（executed 增量——开态段装机后余量 + \
     闭态段全量原生，双态同 trace 承接）"
  );
  Ok(())
}

/// T8 族 2 判别（只读载体分态内联）：`scale` 环体只读——LCT_VAL 值内联
/// upref（捕获后不再变，cell=false：prologue 直载 upref 本体）与 LCT_REF
/// 真 UpVal（被 set_scale 闭包共享写，cell=true：prologue 经 (*UpVal).v
/// 一级间接载值）两形态。环内零代码（区别于变更载体的逐访问穿 cell），
/// 入口守卫钉 cell 源 tnumber。判据 = 逐位一致 + compiled/executed 双增量。
const UPVAL_READONLY_SHAPES: &str = r#"
local function mk_val(scale)
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + t[j] * scale
    end
    return acc
  end
  return inner
end
local function mk_ref()
  local scale = 1.5
  local function set_scale(s) scale = s end
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + t[j] * scale
    end
    return acc
  end
  set_scale(2.0)
  return inner
end
local t = {}
for i = 1, 1500 do t[i] = i % 13 + 0.5 end
local inner_v = mk_val(1.5)
local inner_r = mk_ref()
local tv, tr = 0.0, 0.0
for r = 1, 1100 do
  tv = inner_v(t, 1500)
  tr = inner_r(t, 1500)
end
return tv + tr
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_readonly_shapes_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(UPVAL_READONLY_SHAPES, false)?;
  let traced = eval_trace(UPVAL_READONLY_SHAPES, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "只读载体两形态（值内联/真 UpVal）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "只读载体形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "只读载体形态必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T8 族 2b 判别（Cfn 载体单次 GETUPVAL 端到端）：`sqrt` upvalue 环体只读
/// 一次（单 GETUPVAL 位点）——首现分类必须即定 Cfn（若落 Num，入口守卫
/// tnumber 永拒承 = 装机即死轨），CALL 经 func 槽形态特化执行。判据 =
/// 逐位一致 + compiled/executed 双增量（钉「零装载 prologue + CALL 特化」
/// 真实装机，防死轨假绿）。
const UPVAL_CFN_SINGLE_READ: &str = r#"
local function mk()
  local sqrt = math.sqrt
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + sqrt(t[j] * t[j])
    end
    return acc
  end
  return inner
end
local t = {}
for i = 1, 1500 do t[i] = i % 13 + 0.5 end
local inner = mk()
local tv = 0.0
for r = 1, 1100 do tv = inner(t, 1500) end
return tv
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_cfn_single_read_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(UPVAL_CFN_SINGLE_READ, false)?;
  let traced = eval_trace(UPVAL_CFN_SINGLE_READ, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "Cfn 载体单次 GETUPVAL 形态必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "Cfn 载体形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "Cfn 载体形态必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T8b 族 2c 判别（Cfn 影子分类全族覆盖）：Abs/Floor/Ceil/Round 四族
/// upvalue 载体影子形态端到端——rt 2b 只钉了 Sqrt 一族，其余四族影子
/// 分类无判别（复审指出的缺口）。四族共环体形态（`f(t[j])` 单参影子
/// FASTCALL1 + 影子 GETUPVAL），样本含负数与 x.5 半整数（floor/ceil/
/// round 的 tie 面齐备）。判据 = 逐位一致 + compiled/executed 双增量。
/// 解释器侧 Abs/Floor/Ceil/Round 不在 F 表（仅 Sqrt 装 LbfMathSqrt），
/// 每迭代走 fastcall 失败回退 full call——两态语义同面（check_number +
/// 单返回写槽），位一致照钉。
const UPVAL_CFN_SHADOW_FAMILIES: &str = r#"
-- 各族独立 mk：编译器内建追踪只认 GETIMPORT 直赋局部（参数传入会切断
-- 追踪 → 无 FASTCALL1 影子 → 退回普通 CALL 形态）
local function mk_abs()
  local g = math.abs
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + g(t[j])
    end
    return acc
  end
  return inner
end
local function mk_floor()
  local g = math.floor
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + g(t[j])
    end
    return acc
  end
  return inner
end
local function mk_ceil()
  local g = math.ceil
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + g(t[j])
    end
    return acc
  end
  return inner
end
local function mk_round()
  local g = math.round
  local function inner(t, n)
    local acc = 0.0
    for j = 1, n do
      acc = acc + g(t[j])
    end
    return acc
  end
  return inner
end
local t = {}
for i = 1, 1500 do t[i] = i % 21 - 10.5 end
local in_abs, in_floor, in_ceil, in_round =
  mk_abs(), mk_floor(), mk_ceil(), mk_round()
local a, f, c, r = 0.0, 0.0, 0.0, 0.0
for k = 1, 1100 do
  a = in_abs(t, 1500)
  f = in_floor(t, 1500)
  c = in_ceil(t, 1500)
  r = in_round(t, 1500)
end
return a + f * 3 + c * 5 + r * 7
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_cfn_shadow_families_bit_exact() -> Result<()> {
  let before = stats_with_lock();
  let interp = eval_trace(UPVAL_CFN_SHADOW_FAMILIES, false)?;
  let traced = eval_trace(UPVAL_CFN_SHADOW_FAMILIES, true)?;
  let after = stats_with_lock();
  assert_eq!(
    traced, interp,
    "Cfn 影子形态四族（abs/floor/ceil/round）必须与解释器逐位一致"
  );
  assert!(
    after.0 > before.0,
    "影子形态必须真实录制安装（compiled 增量）"
  );
  assert!(
    after.1 > before.1,
    "影子形态必须真实原生执行（executed 增量）"
  );
  Ok(())
}

/// T8 族 3 判别（变更载体 tag 守卫 bail 面）：热段 number 累加装机并原生
/// 执行后，环外把 upvalue 重赋为非 number（字符串 "x"）——下一次入口
/// UpvalLoad 的 tag==tnumber 守卫 bail（类别 6），savedpc 落 GETUPVAL 位点，
/// 解释器重做后在 ADD 臂抛字符串算术错。两态错误必须一致（位一致红线含
/// 错误传播面），bailed 增量钉守卫真实执行。
const UPVAL_TAG_BAIL: &str = r#"
local function mk(t, n)
  local sum = 0.0
  local function inner(t2, n2)
    for j = 1, n2 do
      sum = sum + t2[j]
    end
  end
  for r = 1, 1100 do inner(t, n) end
  sum = "x"
  inner(t, n)
  return sum
end
local t = {}
for i = 1, 1500 do t[i] = i % 13 + 0.5 end
return mk(t, 1500)
"#;

#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_tag_guard_bails_consistently() -> Result<()> {
  let before = stats_with_lock();
  let interp_err = format!("{}", eval_trace(UPVAL_TAG_BAIL, false).unwrap_err());
  let traced_err = format!("{}", eval_trace(UPVAL_TAG_BAIL, true).unwrap_err());
  let after = stats_with_lock();
  assert_eq!(
    traced_err, interp_err,
    "非 number upvalue 的 tag 守卫 bail 后错误传播必须两态一致"
  );
  assert!(
    after.2 > before.2,
    "tag 守卫必须走 bail 快照回落（bailed 增量）"
  );
  Ok(())
}

/// T8 族 4 A/B 配对（rt 级，≥5 轮 med，AB 交替，位一致前提断言）：
/// upvalue 累加环微负载——装机面 = 回边计数（单入口 × 60000 迭代，回边
/// #1000 装机，本次进入剩余迭代原生），判据 = 轮次中位 trace 快 ≥ 5%。
#[test]
#[cfg_attr(miri, ignore)]
fn trace_upval_acc_measurable_speedup() -> Result<()> {
  // 终值读出借 bump 的写捕获面（LCT_REF）——`sum = sum + 0` 幂等读回
  let src = r#"
local function mk()
  local sum = 0.0
  local function inner(t, n)
    for j = 1, n do
      sum = sum + t[j]
    end
  end
  local function bump(x)
    sum = sum + x
    return sum
  end
  local t = {}
  for i = 1, 60000 do t[i] = i % 13 + 0.5 end
  for r = 1, 60 do
    inner(t, 60000)
  end
  return bump(0)
end
return mk()
"#;

  let run_timed = |trace: bool| -> Result<(f64, f64)> {
    let _guard = TRACE_FLAG_LOCK.lock().unwrap();
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", trace);
    FValue::<bool>::set_flag_by_name("LuauTraceFmaFold", false);
    let lua = Lua::new();
    let t0 = Instant::now();
    let v: f64 = lua.load(src).eval()?;
    let dt = t0.elapsed().as_secs_f64() * 1000.0;
    FValue::<bool>::set_flag_by_name("LuauJitFornTrace", false);
    Ok((dt, v))
  };

  // 预热（触发录制，避开计时段的编译税）
  let (_, v_warm) = run_timed(true)?;
  let (_, v_base) = run_timed(false)?;
  assert_eq!(v_warm, v_base, "A/B 负载逐位一致前提");

  let mut base_times = Vec::new();
  let mut trace_times = Vec::new();
  for _ in 0..5 {
    let (t, v) = run_timed(false)?;
    base_times.push(t);
    assert_eq!(v, v_base);
    let (t, v) = run_timed(true)?;
    trace_times.push(t);
    assert_eq!(v, v_warm);
  }
  let med = |xs: &mut Vec<f64>| {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
  };
  let (mb, mt) = (med(&mut base_times), med(&mut trace_times));
  println!("upvalue 累加环 A/B：trace {mt:.1}ms vs interp {mb:.1}ms");
  assert!(
    mt < mb * 0.95,
    "upvalue 累加环 trace 应 ≥5% 提速：trace {mt:.1}ms vs interp {mb:.1}ms"
  );
  Ok(())
}
