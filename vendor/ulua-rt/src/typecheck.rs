//! Static type-checking of Luau source against the host surface (the
//! `typecheck` feature).
//!
//! This is the unique capability `mlua` cannot offer: because ulua ships
//! Luau's static type checker (`ulua-analysis`), a script you are about to run
//! can be type-checked against exactly the API the host exposes *before* it
//! runs. The Luau VM is dynamically typed, so the runtime does not need any of
//! this — but the *static* checker has no knowledge of the host surface unless
//! you tell it.
//!
//! Modelled exactly on the umbrella `ulua` crate's `check` helper (itself a
//! port of `ulua-web`'s `check_script`): build a [`Frontend`] over an in-memory
//! single-source file resolver, register the Luau builtins, optionally load host
//! type definitions into the same global scope, insert the source as the module
//! `"main"`, and type-check it on the validated **old** solver.
//!
//! The one difference from the umbrella's helper is the diagnostic shape: each
//! diagnostic is surfaced as a structured [`TypeDiagnostic`] carrying its source
//! location (line/column, 1-based) rather than a flat `"<line>: <message>"`
//! string.

/// One type-checker diagnostic with its source location (all 1-based).
///
/// Produced by [`check`] / [`check_with_definitions`] and carried inside
/// [`Error::TypeError`](crate::Error::TypeError). Unlike a flat error string,
/// the location fields let an editor / build tool point at the exact span.
use core::{fmt, result::Result};
use std::{
  cell::RefCell,
  panic::{AssertUnwindSafe, catch_unwind},
  rc::Rc,
};

use ulua_analysis::{
  enums::solver_mode::SolverMode,
  functions::{freeze::freeze, to_string_error::to_string_type_error, unfreeze::unfreeze},
  records::{
    config_resolver::ConfigResolver, file_resolver::FileResolver, frontend::Frontend,
    frontend_options::FrontendOptions, load_definition_file_result::LoadDefinitionFileResult,
    module_info::ModuleInfo, source_code::SourceCode, type_check_limits::TypeCheckLimits,
    type_error::TypeError,
  },
  type_aliases::module_name_type::ModuleName,
};
use ulua_ast::{
  records::{
    ast_expr::AstExpr, ast_expr_call::AstExprCall, ast_expr_constant_string::AstExprConstantString,
    ast_expr_global::AstExprGlobal, ast_expr_index_expr::AstExprIndexExpr,
    ast_expr_index_name::AstExprIndexName, node_handle::OptNode, position::Position,
  },
  rtti::{AstNodeClass, ast_node_try_as},
};
use ulua_common::{collections::HashMap, functions::c_str::cstr_cow};
use ulua_config::records::config::Config;

use crate::callback::panic_message;

/// 引用形态的 RTTI 下转：直接走 `ulua_ast` 的安全引用门面，寿命由入参借用继承。
///
/// 旧写法先 `ptr::from_ref(expr).cast_mut()` 拼回 cpp 的 `AstNode*` 再喂指针门面，
/// 等于从共享引用派生可变裸指针（review.md §2）；引用门面本就存在，无需这次往返，
/// 返回形态也随之从 `&'static T` 收敛成 `&T`。
#[inline]
fn ast_as<T: AstNodeClass>(expr: &AstExpr) -> Option<&T> {
  ast_node_try_as::<T>(expr)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeDiagnostic {
  /// The module that produced this diagnostic, when the checker had one.
  ///
  /// The simple [`check`] / [`check_with_definitions`] helpers preserve their
  /// historical display shape and leave this empty for the synthetic `"main"`
  /// module. Module-aware checks fill it for imported modules.
  pub module: Option<String>,
  /// 1-based start line.
  pub line: u32,
  /// 1-based start column.
  pub column: u32,
  /// 1-based end line.
  pub end_line: u32,
  /// 1-based end column.
  pub end_column: u32,
  /// The human-readable diagnostic message.
  pub message: String,
  /// True when the diagnostic comes from the host `declare` definitions rather
  /// than the checked script.
  pub in_definitions: bool,
}

impl fmt::Display for TypeDiagnostic {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    if self.in_definitions {
      write!(f, "(host definitions) ")?;
    }
    if let Some(module) = &self.module {
      write!(f, "{module}:")?;
    }
    write!(f, "{}:{}: {}", self.line, self.column, self.message)
  }
}

/// The fixed module name under which the checked source is registered, matching
/// the umbrella helper's `fileResolver.source["main"] = source`.
const MAIN_MODULE: &str = "main";

/// Minimal single-source in-memory [`FileResolver`] for a string check.
///
/// Holds exactly one module's source ("main"). `source` 经 `Rc<RefCell>` 共享：
/// 每次改写后 frontend 内独占实例与宿主句柄读到同一槽（cpp 宿主直写字段的
/// 等价形态），`Checker` 复用会话时无需第二把可变别名。
struct CheckFileResolver {
  source: Rc<RefCell<String>>,
}

impl CheckFileResolver {
  fn new(source: &str) -> Self {
    CheckFileResolver {
      source: Rc::new(RefCell::new(source.to_string())),
    }
  }
}

impl FileResolver for CheckFileResolver {
  /// `readSource` — returns the single source for the `"main"` module.
  fn read_source(&mut self, name: &ModuleName) -> Option<SourceCode> {
    if name != MAIN_MODULE {
      return None;
    }
    let source = self.source.borrow().clone();
    Some(SourceCode {
      source,
      r#type: SourceCode::MODULE,
    })
  }
}

/// In-memory [`FileResolver`] for module-aware checks.
///
/// Holds a complete module-name -> source map. The resolver supports the common
/// Luau require path shapes used by host-embedded scripts:
///
/// - `require("@alias")`
/// - `require("literal/module/name")`
/// - `require(game.Module)`
/// - `require(script.Parent.Module)`
/// - `require(game:GetService("Service").Module)`
struct CheckModuleFileResolver {
  sources: HashMap<ModuleName, String>,
}

impl FileResolver for CheckModuleFileResolver {
  /// `readSource` — map lookup, every module typed as `SourceCode::MODULE`.
  fn read_source(&mut self, name: &ModuleName) -> Option<SourceCode> {
    let source = self.sources.get(name)?.clone();
    Some(SourceCode {
      source,
      r#type: SourceCode::MODULE,
    })
  }

  /// `resolveModule` — delegates to the inherent require-path resolver.
  fn resolve_module(
    &mut self,
    context: Option<&ModuleInfo>,
    expr: &AstExpr,
    _limits: &TypeCheckLimits,
  ) -> Option<ModuleInfo> {
    Self::resolve_module(self, context, expr)
  }
}

impl CheckModuleFileResolver {
  fn new(modules: &[(&str, &str)]) -> Self {
    let sources = modules
      .iter()
      .map(|&(name, source)| (ModuleName::from(name), source.to_string()))
      .collect();

    CheckModuleFileResolver { sources }
  }

  fn resolve_module(&self, context: Option<&ModuleInfo>, expr: &AstExpr) -> Option<ModuleInfo> {
    // `ast_as` 与句柄上的 `try_as` 是带调用序契约的 safe 门面（本文件 RTTI
    // 下转的唯一收口点）：闸门按 class index 分派——未命中返回 `None`，命中即类型正确；
    // 读出的名字只经 `ast_name_to_string` /
    // `constant_string_to_string` 的判空/切片通道使用，不越界。
    if let Some(string) = ast_as::<AstExprConstantString>(expr) {
      return self.module_info_if_known(constant_string_to_string(string), false);
    }

    if let Some(global) = ast_as::<AstExprGlobal>(expr) {
      let name = ast_name_to_string(global.name.as_ptr());

      if name == "script" {
        return context.cloned();
      }

      return self.module_info_if_known(name, true);
    }

    if let Some(index) = ast_as::<AstExprIndexName>(expr) {
      let context = context?;
      let index_name = ast_name_to_string(index.index.as_ptr());

      if index_name == "Parent" {
        let last_separator = context.name.rfind('/')?;
        return Some(ModuleInfo {
          name: ModuleName::from(&context.name[..last_separator]),
          optional: context.optional,
        });
      }

      return self.module_info_if_known(format!("{}/{}", context.name, index_name), true);
    }

    if let Some(index) = ast_as::<AstExprIndexExpr>(expr) {
      let context = context?;
      // `index.index` 是 arena 子表达式句柄：判型下转走句柄上生命周期正确的
      // `try_as`，借用半径由 `index` 的借用供给，不再锻造假 'static。被索引的
      // 子表达式再过一次常量串闸门。
      if let Some(index_string) = index.index.try_as::<AstExprConstantString>() {
        return self.module_info_if_known(
          format!(
            "{}/{}",
            context.name,
            constant_string_to_string(index_string)
          ),
          true,
        );
      }
    }

    if let Some(call) = ast_as::<AstExprCall>(expr) {
      let context = context?;

      if call.self_ && !call.args.is_empty() && context.name == "game" {
        // `args[0]`/`func` 槽仍是裸指针：经句柄门面 `OptNode::from_ptr` 折叠
        // 可空性，首实参与被调表达式各过一次句柄 `try_as` RTTI 闸门，借用
        // 半径由本分支局部句柄供给。
        let arg_node = OptNode::from_ptr(call.args[0]);
        let func_node = OptNode::from_ptr(call.func);
        let index_string = arg_node.try_as::<AstExprConstantString>();
        let func = func_node.try_as::<AstExprIndexName>();
        if let (Some(index_string), Some(func)) = (index_string, func)
          && ast_name_to_string(func.index.as_ptr()) == "GetService"
        {
          return self.module_info_if_known(
            format!("game/{}", constant_string_to_string(index_string)),
            true,
          );
        }
      }
    }

    None
  }

  /// `name` 命中源表（或按需命中其子模块前缀 `name/...`）时返回 `ModuleInfo`。
  /// `allow_prefix` 控制是否额外检查子模块前缀（`require(game.Module)` 类
  /// require 路径需要，以便父模块也解析成功）。
  fn module_info_if_known(&self, name: String, allow_prefix: bool) -> Option<ModuleInfo> {
    let module_name = ModuleName::from(name);
    let known = self.sources.contains_key(module_name.as_str())
      || (allow_prefix && {
        // 仅前缀分支需要 "{name}/"：直接命中或禁止前缀时不分配
        let child_prefix = format!("{module_name}/");
        self.sources.keys().any(|m| m.starts_with(&child_prefix))
      });
    known.then_some(ModuleInfo {
      name: module_name,
      optional: false,
    })
  }
}

fn ast_name_to_string(name: *const u8) -> String {
  if name.is_null() {
    String::new()
  } else {
    // Safety: 上一分支已排除 null；AST 里的 name 指向 AstNameTable intern 的 NUL 结尾串，
    // 由 arena 持有且比 AST 长寿，from_ptr 读到 NUL 为止不越界。入参是 AstName 身份桥
    // 透出的 `*const u8`，cstr 门面按 cpp `const char*` 收参，cast 仅符号标记、字节域恒等。
    unsafe { cstr_cow(name.cast()).into_owned() }
  }
}

fn constant_string_to_string(expr: &AstExprConstantString) -> String {
  expr
    .value
    .as_slice()
    .iter()
    .copied()
    .map(char::from)
    .collect()
}

/// Minimal [`ConfigResolver`] returning a default [`Config`].
///
/// 单字符串检查会话用的常量配置：`get_config` 恒返回 `default_config`，所有权
/// 经 `Box<dyn ConfigResolver>` 移交 `Frontend` 独占持有。
struct CheckConfigResolver {
  default_config: Config,
}

impl CheckConfigResolver {
  fn new() -> Self {
    CheckConfigResolver {
      default_config: Config::default(),
    }
  }
}

impl ConfigResolver for CheckConfigResolver {
  /// 恒返回单一默认配置（cpp `getConfig` 忽略两实参、返回成员 `defaultConfig`）。
  fn get_config(&self, _name: &ModuleName, _limits: &TypeCheckLimits) -> &Config {
    &self.default_config
  }
}

/// The fixed package name under which host definitions are registered. Mirrors
/// `Fixture::loadDefinition`'s `"@test"`; `@`-prefixed names are the convention
/// for synthetic (non-file) modules.
const HOST_DEFINITIONS_PACKAGE: &str = "@host";

/// 把 Luau 0 基 `Location` 提升为 1 基诊断的共用样板（check 结果、definitions
/// 解析/类型错误共用）。
fn location_diagnostic(
  module: Option<String>,
  begin: Position,
  end: Position,
  message: String,
  in_definitions: bool,
) -> TypeDiagnostic {
  TypeDiagnostic {
    module,
    line: begin.line + 1,
    column: begin.column + 1,
    end_line: end.line + 1,
    end_column: end.column + 1,
    message,
    in_definitions,
  }
}

/// 注册 Luau builtins 与可选 host definitions（`run_check` / `run_check_modules`
/// 共用的 wire 后段）。
///
/// `Err(diagnostics)` = definitions 加载失败（诊断即返回值，调用方应直接交回——
/// 在半建表面上继续检查没有意义）。
///
/// 内置全局与 host definitions 两段均回到普通借用：目标表选择器闭包
/// （`load_definition_file` 收口后）在需要时才物化字段借用，无需拆借。
fn register_builtins_and_defs(
  frontend: &mut Frontend,
  definitions: Option<&str>,
) -> Result<(), Vec<TypeDiagnostic>> {
  // Luau::unfreeze / registerBuiltinGlobals / freeze（与 C++ 注册顺序一致）。
  // 重叠别名已收进 ulua-analysis 的 chokepoint，本段回到普通借用，免 unsafe。
  unfreeze(frontend.globals.global_types_mut());
  frontend.register_builtin_globals(false);
  freeze(frontend.globals.global_types_mut());

  // Register host type definitions, if any, into the same global scope the
  // builtins live in. A script then type-checks against the host-provided
  // surface (the Rust functions / userdata exposed to the runtime). Pattern
  // mirrors `Fixture::loadDefinition`: unfreeze -> loadDefinitionFile(globals,
  // globalScope, …) -> freeze.
  if let Some(defs) = definitions.filter(|defs| !defs.is_empty()) {
    unfreeze(frontend.globals.global_types_mut());
    let target_scope = frontend.globals.global_scope();
    let result = frontend.load_definition_file(
      |frontend| &mut frontend.globals,
      target_scope,
      defs,
      HOST_DEFINITIONS_PACKAGE,
      /* captureComments */ false,
      /* typeCheckForAutocomplete */ false,
    );
    freeze(frontend.globals.global_types_mut());

    // Malformed host definitions are a usage error, surfaced with
    // `in_definitions: true` so they are distinguishable from script
    // diagnostics.
    if !result.success {
      return Err(definition_diagnostics(&result));
    }
  }
  Ok(())
}

/// [`MAIN_MODULE`] 的 owned 形态（`Frontend::{check, mark_dirty}` 取 `&ModuleName`）。
fn main_module() -> ModuleName {
  ModuleName::from(MAIN_MODULE)
}

/// 无精确源位置的合成诊断（checker panic、definitions 加载失败、根模块缺失共用），
/// 定位固定为 1:1。
fn synthetic_diagnostic(
  module: Option<String>,
  message: String,
  in_definitions: bool,
) -> TypeDiagnostic {
  TypeDiagnostic {
    module,
    line: 1,
    column: 1,
    end_line: 1,
    end_column: 1,
    message,
    in_definitions,
  }
}

/// 单条 check 错误 → 诊断（`run_check` / [`Checker::check`] 共用：
/// 单源检查不带模块名，`in_definitions` 恒为 false）。
fn check_error_diagnostic(err: &TypeError) -> TypeDiagnostic {
  location_diagnostic(
    None,
    err.location.begin,
    err.location.end,
    to_string_type_error(err),
    false,
  )
}

/// 空诊断集 = 检查通过；[`checked`] 与 [`Checker::check`] 共用的折叠规则。
fn fold(diagnostics: Vec<TypeDiagnostic>) -> Result<(), Vec<TypeDiagnostic>> {
  if diagnostics.is_empty() {
    Ok(())
  } else {
    Err(diagnostics)
  }
}

/// 构造 + 自指针布线一步完成（经 [`Frontend::new_boxed`] 安全装箱构造器）。
///
/// dyn 保留：`Box<dyn FileResolver>` / `Box<dyn ConfigResolver>` 的形参形态由
/// `ulua_analysis::Frontend` 的构造器与字段类型锁死（`pub file_resolver: Box<dyn
/// FileResolver>` 等，见 `new_boxed` 的 9 个跨 crate 调用方），实现集合虽在本文件
/// 封闭（`CheckFileResolver`/`CheckModuleFileResolver`/`CheckConfigResolver`），
/// 但接口边界在 ulua-analysis crate 内，本 crate 侧仅装箱适配、无从单态化。
///
/// `new_boxed` 在 safe 边界内完成「构造 → 堆上落位 → 自指针布线」全序列，
/// 调用点不再有 unsafe 构造/`wire_self_pointers` 两步手写；返回的 `Box<Frontend>`
/// 只被按指针移动（pointee 留在堆上），自指针在其整个生命周期内恒有效。
/// `file_resolver` / `config` 所有权均移交 `Frontend` 独占。
fn make_wired_frontend(
  file_resolver: Box<dyn FileResolver>,
  config: Box<dyn ConfigResolver>,
) -> Box<Frontend> {
  let options = FrontendOptions::default();
  // 原三调用点均在构造后立刻 `set_luau_solver_mode(Old)` 覆写掉 fflag 派生值，
  // 故收口为构造期直接定 Old：可达状态等价。
  Frontend::new_boxed(SolverMode::Old, file_resolver, config, options)
}

/// The fallible body, run under `catch_unwind` so a panic in the type checker
/// surfaces as a diagnostic rather than unwinding into the caller. Returns the
/// collected [`TypeDiagnostic`]s, or an empty `Vec` when the source type-checks
/// clean.
///
/// `definitions`, when present and non-empty, is Luau definition-file syntax
/// (`declare function …`, `declare class …`, `declare x: T`) describing the host
/// surface; it is registered into the global scope *after* the builtins (so it
/// may reference them) and *before* the script is checked.
fn run_check(source: &str, definitions: Option<&str>) -> Vec<TypeDiagnostic> {
  // make_wired_frontend 经 Frontend::new_boxed 安全构造：两解析器所有权均移交
  // frontend 独占（file resolver 状态经 `source` 的 Rc 槽共享）；Box 使 Frontend
  // 地址恒定。
  let mut frontend = make_wired_frontend(
    Box::new(CheckFileResolver::new(source)),
    Box::new(CheckConfigResolver::new()),
  );

  // Register builtins + host definitions, then type-check the script.
  // （Old solver 路径已由 `make_wired_frontend` 在构造期定下。）
  if let Err(diagnostics) = register_builtins_and_defs(&mut frontend, definitions) {
    return diagnostics;
  }

  // Luau::CheckResult checkResult = frontend.check("main");
  let check_result = frontend.check_module_name_optional_frontend_options(&main_module(), None);

  check_result
    .errors
    .iter()
    .map(check_error_diagnostic)
    .collect()
}

/// definitions 加载失败时的诊断集（解析错误 + 模块类型错误；一条都没有时补合成
/// 诊断，保证失败必有可见原因）。全部以 `in_definitions: true` 标记。
fn definition_diagnostics(result: &LoadDefinitionFileResult) -> Vec<TypeDiagnostic> {
  let mut diagnostics: Vec<TypeDiagnostic> = Vec::new();
  for err in &result.parse_result.errors {
    diagnostics.push(location_diagnostic(
      None,
      err.get_location().begin,
      err.get_location().end,
      err.get_message().to_string(),
      true,
    ));
  }
  if let Some(module) = &result.module {
    for err in &module.errors {
      diagnostics.push(location_diagnostic(
        None,
        err.location.begin,
        err.location.end,
        to_string_type_error(err),
        true,
      ));
    }
  }
  if diagnostics.is_empty() {
    diagnostics.push(synthetic_diagnostic(
      None,
      "failed to load".to_string(),
      true,
    ));
  }
  diagnostics
}

/// 单条 check 错误 → 诊断（多源检查用：模块名缺失时回落到 `fallback_module`）。
fn type_error_diagnostic(err: &TypeError, fallback_module: Option<&str>) -> TypeDiagnostic {
  let module = if err.module_name.is_empty() {
    fallback_module.map(str::to_string)
  } else {
    Some(err.module_name.to_string())
  };
  location_diagnostic(
    module,
    err.location.begin,
    err.location.end,
    to_string_type_error(err),
    false,
  )
}

/// Type-check Luau `source`. Returns `Ok(())` if it type-checks clean, or `Err`
/// of the structured diagnostics on type errors.
///
/// ```
/// # #[cfg(feature = "typecheck")] {
/// ulua_rt::check("local x: number = 1").unwrap();
/// assert!(ulua_rt::check("local x: number = \"oops\"").is_err());
/// # }
/// ```
pub fn check(source: &str) -> Result<(), Vec<TypeDiagnostic>> {
  check_inner(source, None)
}

/// Type-check Luau `source` with extra host type `definitions` in scope.
///
/// `definitions` is Luau **definition-file syntax** describing the host-provided
/// globals — the Rust functions, values, and userdata you expose to the runtime
/// (e.g. via [`Lua::create_function`](crate::Lua::create_function) /
/// [`UserData`](crate::UserData)):
///
/// ```text
/// declare function add(a: number, b: number): number
/// declare config: { name: string, retries: number }
/// declare class Vec2
///     x: number
///     y: number
///     function magnitude(self): number
/// end
/// ```
///
/// Returns `Ok(())` when the source type-checks clean against the builtins plus
/// the host definitions, or `Err` of the structured diagnostics. Errors in the
/// definitions themselves are reported with `in_definitions == true`.
///
/// ```
/// # #[cfg(feature = "typecheck")] {
/// // The script references a host function the checker would otherwise reject:
/// ulua_rt::check("local n: number = add(1, 2)").unwrap_err();
/// ulua_rt::check_with_definitions(
///     "local n: number = add(1, 2)",
///     "declare function add(a: number, b: number): number",
/// )
/// .unwrap();
/// # }
/// ```
pub fn check_with_definitions(source: &str, definitions: &str) -> Result<(), Vec<TypeDiagnostic>> {
  check_inner(source, Some(definitions))
}

/// Type-check a graph of Luau modules.
///
/// `root_module` is the module name to check first. `modules` must contain a
/// `(module_name, source)` pair for `root_module`; any modules reachable through
/// supported `require(...)` paths are checked and their exported type surfaces
/// are used for the requiring script.
///
/// Supported require paths are the common embedded-script forms:
///
/// ```text
/// require("@alias")
/// require("literal/module/name")
/// require(game.Module)
/// require(script.Parent.Module)
/// require(game:GetService("Service").Module)
/// ```
pub fn check_modules(
  root_module: &str,
  modules: &[(&str, &str)],
) -> Result<(), Vec<TypeDiagnostic>> {
  check_modules_inner(root_module, modules, None)
}

/// Type-check a graph of Luau modules with extra host type `definitions` in
/// scope. See [`check_modules`] and [`check_with_definitions`].
pub fn check_modules_with_definitions(
  root_module: &str,
  modules: &[(&str, &str)],
  definitions: &str,
) -> Result<(), Vec<TypeDiagnostic>> {
  check_modules_inner(root_module, modules, Some(definitions))
}

/// Shared body of [`check`] / [`check_with_definitions`]: run the checker under
/// `catch_unwind` (so a panic in the type checker becomes a diagnostic rather
/// than unwinding into the caller) and fold the diagnostics into a `Result`.
fn check_inner(source: &str, definitions: Option<&str>) -> Result<(), Vec<TypeDiagnostic>> {
  // A panic inside the checker becomes a single diagnostic.
  let owned = source.to_string();
  let owned_defs = definitions.map(|d| d.to_string());
  checked(None, move || run_check(&owned, owned_defs.as_deref()))
}

/// 跑 `f` 并把 panic 折叠为单条诊断；空诊断集折叠为 `Ok(())`。
/// [`check_inner`] / [`check_modules_inner`] 共用。
fn checked(
  module: Option<String>,
  f: impl FnOnce() -> Vec<TypeDiagnostic>,
) -> Result<(), Vec<TypeDiagnostic>> {
  let diagnostics = match catch_unwind(AssertUnwindSafe(f)) {
    Ok(diagnostics) => diagnostics,
    Err(payload) => vec![synthetic_diagnostic(
      module,
      panic_message(&*payload).into_owned(),
      false,
    )],
  };
  fold(diagnostics)
}

fn check_modules_inner(
  root_module: &str,
  modules: &[(&str, &str)],
  definitions: Option<&str>,
) -> Result<(), Vec<TypeDiagnostic>> {
  let owned_root = root_module.to_string();
  let owned_modules: Vec<(String, String)> = modules
    .iter()
    .map(|&(name, source)| (name.to_string(), source.to_string()))
    .collect();
  let owned_defs = definitions.map(|d| d.to_string());

  checked(Some(root_module.to_string()), move || {
    let borrowed: Vec<(&str, &str)> = owned_modules
      .iter()
      .map(|(name, source)| (name.as_str(), source.as_str()))
      .collect();
    run_check_modules(&owned_root, &borrowed, owned_defs.as_deref())
  })
}

fn run_check_modules(
  root_module: &str,
  modules: &[(&str, &str)],
  definitions: Option<&str>,
) -> Vec<TypeDiagnostic> {
  if !modules.iter().any(|(name, _)| *name == root_module) {
    return vec![synthetic_diagnostic(
      Some(root_module.to_string()),
      format!("root module '{root_module}' is not present in module sources"),
      false,
    )];
  }

  // 同 run_check——两解析器所有权均移交 frontend 独占（file resolver 内部持克隆
  // 的 owned String，不借用 `modules`）；Box 固定 Frontend 堆地址。
  let mut frontend = make_wired_frontend(
    Box::new(CheckModuleFileResolver::new(modules)),
    Box::new(CheckConfigResolver::new()),
  );

  if let Err(diagnostics) = register_builtins_and_defs(&mut frontend, definitions) {
    return diagnostics;
  }

  let check_result =
    frontend.check_module_name_optional_frontend_options(&ModuleName::from(root_module), None);

  check_result
    .errors
    .iter()
    .map(|err| type_error_diagnostic(err, Some(root_module)))
    .collect()
}

/// A reusable type checker: registers the Luau builtins **once** and checks many
/// sources against the shared global environment.
///
/// A one-shot [`check`] rebuilds the whole frontend and re-parses + re-checks the
/// entire `@luau` builtin definition file on every call — that setup dominates the
/// cost. `Checker` pays it once at construction, so each [`Checker::check`] only
/// parses and checks the input itself (orders of magnitude faster across many
/// snippets — fuzzers, language servers, batch linters).
///
/// Host definitions are not supported here: they mutate the global environment and
/// so can't be cached this way — use [`check_with_definitions`] for those.
pub struct Checker {
  // 单槽源码共享句柄：构造期从 `CheckFileResolver` 克隆，frontend 独占持有
  // 解析器本体后，[`Checker::check`] 经本槽改写 "main" 源码仍对读方可见
  // （等价 cpp 宿主直写 `fileResolver->source`）。
  source_slot: Rc<RefCell<String>>,
  // `Frontend` 独占持有 config resolver（`Box<dyn ConfigResolver>` 所有权已移交），
  // 且 `wire_self_pointers` 使 frontend 自引用；`Checker` 移动只搬 `Box` 句柄，
  // pointee 恒留堆上，自指针在其整个生命周期内恒有效。
  frontend: Box<Frontend>,
}

impl Checker {
  /// Build a checker with the Luau builtins registered (the expensive,
  /// once-only step).
  pub fn new() -> Self {
    let file_resolver = CheckFileResolver::new("");
    let source_slot = file_resolver.source.clone();
    // 经 [`make_wired_frontend`]（→ Frontend::new_boxed）安全构造：两解析器所有权
    // 随 Box 移交 frontend 独占；Box 使 Frontend 堆地址恒定，自指针在 checker
    // 整个生命周期内恒有效。
    let mut frontend = make_wired_frontend(
      Box::new(file_resolver),
      Box::new(CheckConfigResolver::new()),
    );

    // Register the Luau builtins into the global scope once (the cost we're
    // amortizing). `definitions == None` 时 [`register_builtins_and_defs`]
    // 恒成功，只做 builtin 注册。
    let registered = register_builtins_and_defs(&mut frontend, None);
    debug_assert!(registered.is_ok());

    Checker {
      source_slot,
      frontend,
    }
  }

  /// Type-check `source` against the cached global environment. `Ok(())` when it
  /// checks clean, otherwise the diagnostics. Never panics on malformed input
  /// (the checker returns errors).
  pub fn check(&mut self, source: &str) -> Result<(), Vec<TypeDiagnostic>> {
    // Point the single "main" module at the new source and force a re-check.
    *self.source_slot.borrow_mut() = source.to_string();
    self.frontend.mark_dirty(&main_module(), None);

    let check_result = self
      .frontend
      .check_module_name_optional_frontend_options(&main_module(), None);

    fold(
      check_result
        .errors
        .iter()
        .map(check_error_diagnostic)
        .collect(),
    )
  }
}

impl Default for Checker {
  fn default() -> Self {
    Self::new()
  }
}
