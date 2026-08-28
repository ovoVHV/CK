//! Direct Compilation Engine — bypasses arduino-cli entirely.
//!
//! Instead of calling `arduino-cli compile` (which takes 300-400s just for library
//! scanning and property expansion), this engine:
//!
//! 1. Resolves all build properties by parsing platform.txt + boards.txt + installed.json (~10ms)
//! 2. Discovers source files by walking library/sketch/core directories (~50ms)
//! 3. Generates compile commands from recipe templates (~1ms)
//! 4. Executes compilation in parallel with ccache (~30s with cache hits)
//! 5. Archives core objects into core.a
//! 6. Links to produce .elf
//! 7. Generates upload artifacts (bootloader, partitions, merged bin)
//!
//! Total: ~35-60s (vs 300-400s with arduino-cli) for a hot compile.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// Apply CREATE_NO_WINDOW flag on Windows to prevent console popups.
#[cfg(target_os = "windows")]
fn hide_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000)
}

#[cfg(not(target_os = "windows"))]
fn hide_window(cmd: &mut Command) -> &mut Command {
    cmd
}
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// Result of a direct engine compilation.
#[derive(Debug)]
pub struct DirectCompileResult {
    pub elf_path: PathBuf,
    pub build_path: PathBuf,
    pub elapsed_secs: f64,
    pub summary_lines: Vec<String>,
    pub full_log: String,
}

/// Fully resolved build properties — replaces `arduino-cli --show-properties=expanded`.
#[derive(Debug, Clone)]
pub struct ResolvedProps {
    pub props: HashMap<String, String>,
}

/// Deterministic evidence that an installed board definition cannot reach its
/// compiler/firmware tools. `board_hidden` is explanatory only: hidden boards
/// are allowed when every required tool and artifact is present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeToolPreflightReport {
    pub board_hidden: bool,
    pub unresolved_runtime_tool_paths: Vec<String>,
    pub missing_critical_paths: Vec<PathBuf>,
}

impl RuntimeToolPreflightReport {
    pub fn is_blocked(&self) -> bool {
        !self.unresolved_runtime_tool_paths.is_empty() || !self.missing_critical_paths.is_empty()
    }

    pub fn blocking_message(&self, fqbn: &str) -> String {
        let mut evidence = Vec::new();
        if !self.unresolved_runtime_tool_paths.is_empty() {
            evidence.push(format!(
                "unresolved runtime tool path(s): {}",
                self.unresolved_runtime_tool_paths.join(", ")
            ));
        }
        if !self.missing_critical_paths.is_empty() {
            evidence.push(format!(
                "missing critical tool/artifact path(s): {}",
                self.missing_critical_paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let hidden = if self.board_hidden {
            " The installed Core marks this board definition as hidden; that flag is explanatory evidence, not the blocking condition."
        } else {
            ""
        };
        format!(
            "Board runtime preflight blocked {fqbn} before Arduino CLI: {}.{hidden} Install a Core/tool package that provides the selected board's runtime files, or select a supported board/Core version.",
            evidence.join("; ")
        )
    }
}

/// Source file to compile.
#[derive(Debug, Clone)]
struct SourceFile {
    path: PathBuf,
    /// recipe key: "recipe.c.o.pattern", "recipe.cpp.o.pattern", or "recipe.S.o.pattern"
    recipe_key: &'static str,
    /// object file output path
    object_path: PathBuf,
    /// category for progress reporting
    category: SourceCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceCategory {
    Core,
    Library,
    Sketch,
}

// ========================== Property Resolution ==========================

/// Parse an FQBN string like "esp32:esp32:esp32s3:PartitionScheme=huge_app"
/// Returns (package, architecture, board_id, options_map)
fn parse_fqbn(fqbn: &str) -> Result<(&str, &str, &str, HashMap<&str, &str>)> {
    let mut parts = fqbn.splitn(4, ':');
    let package = parts.next().context("FQBN missing package")?;
    let arch = parts.next().context("FQBN missing architecture")?;
    let board_id = parts.next().context("FQBN missing board ID")?;
    let mut options = HashMap::new();
    if let Some(opts_str) = parts.next() {
        for pair in opts_str.split(',') {
            if let Some((k, v)) = pair.split_once('=') {
                options.insert(k.trim(), v.trim());
            }
        }
    }
    Ok((package, arch, board_id, options))
}

/// Resolve all build properties from platform.txt, boards.txt, platform.local.txt,
/// and runtime paths — without calling arduino-cli.
///
/// This replaces `arduino-cli compile --show-properties=expanded` which takes 40-60s.
/// Direct parsing takes ~10ms.
pub async fn resolve_properties(
    sysroot: &Path,
    fqbn: &str,
    build_path: &Path,
    sketch_dir: &Path,
    sketch_name: &str,
    extra_build_props: &[(String, String)],
) -> Result<ResolvedProps> {
    let (package, arch, board_id, board_options) = parse_fqbn(fqbn)?;

    // Locate platform directory
    let hw_dir = sysroot
        .join("packages")
        .join(package)
        .join("hardware")
        .join(arch);
    let platform_dir = find_latest_version_dir(&hw_dir)
        .with_context(|| format!("No platform found at {}", hw_dir.display()))?;

    let tools_dir = sysroot.join("packages").join(package).join("tools");

    // Parse platform.txt
    let platform_txt = platform_dir.join("platform.txt");
    let mut props = parse_properties_file(&platform_txt).await?;

    // Parse platform.local.txt (overrides)
    let platform_local = platform_dir.join("platform.local.txt");
    if platform_local.exists() {
        let local_props = parse_properties_file(&platform_local).await?;
        props.extend(local_props);
    }

    // Parse boards.txt and extract board + menu option properties
    let boards_txt = platform_dir.join("boards.txt");
    let board_props = parse_board_properties(&boards_txt, board_id, &board_options).await?;
    props.extend(board_props);

    // Inject runtime properties
    let platform_path = platform_dir.to_string_lossy().replace('\\', "/");
    props.insert("runtime.platform.path".into(), platform_path.clone());
    // Arduino CLI currently expands this compatibility property as 10607.
    // Keep the direct resolver byte-for-byte aligned with CLI-generated
    // recipes; some platform definitions branch on the value.
    props.insert("runtime.ide.version".into(), "10607".into());
    props.insert(
        "runtime.os".into(),
        if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
        .into(),
    );
    props.insert("build.fqbn".into(), fqbn.into());
    props.insert("build.arch".into(), arch.to_ascii_uppercase());
    props.insert(
        "build.path".into(),
        build_path.to_string_lossy().replace('\\', "/"),
    );
    props.insert(
        "build.source.path".into(),
        sketch_dir.to_string_lossy().replace('\\', "/"),
    );
    props.insert("build.project_name".into(), sketch_name.into());
    // Arduino CLI exposes both resolved paths to compile recipes. The direct
    // resolver must do the same: a fresh synthetic compilation database uses
    // `build.core.path` to make <Arduino.h> visible to the sketch and to
    // transitive platform libraries such as ESP32 Network.
    if let Some(core) = props.get("build.core").cloned() {
        let core_path = format!("{}/cores/{}", platform_path, core);
        props.insert("build.core.path".into(), core_path);
    }
    // build.variant.path
    if let Some(variant) = props.get("build.variant").cloned() {
        let variant_path = format!("{}/variants/{}", platform_path, variant);
        props.insert("build.variant.path".into(), variant_path);
    }
    // build.opt.path
    props.insert(
        "build.opt.path".into(),
        format!(
            "{}/build_opt.h",
            build_path.to_string_lossy().replace('\\', "/")
        ),
    );

    // Resolve tool paths from installed.json or directory scanning
    resolve_tool_paths(&mut props, &tools_dir, &platform_dir).await?;

    // Arduino platform properties may provide host-specific values such as
    // `tools.gen_esp32part.cmd.windows`. Project those onto their base keys
    // before explicit build-property overrides and placeholder expansion.
    apply_host_property_overrides(&mut props);

    // Apply extra build properties (speed flags, skip props, etc.)
    for (k, v) in extra_build_props {
        props.insert(k.clone(), v.clone());
    }

    // Do iterative variable expansion on all values
    expand_all_properties(&mut props);

    Ok(ResolvedProps { props })
}

fn is_compile_recipe_property(key: &str) -> bool {
    if matches!(key, "compiler.path" | "compiler.sdk.path") {
        return true;
    }
    key.starts_with("recipe.")
        && key.ends_with(".pattern")
        && !key.starts_with("recipe.upload.")
        && !key.starts_with("recipe.program.")
        && !key.starts_with("recipe.erase.")
        && !key.starts_with("recipe.network_upload.")
}

fn collect_unresolved_runtime_tool_paths(value: &str, target: &mut BTreeSet<String>) {
    let matcher = regex::Regex::new(r"\{runtime\.tools\.([^{}\s]+)\.path\}")
        .expect("runtime tool placeholder regex");
    for capture in matcher.captures_iter(value) {
        if let Some(tool) = capture.get(1) {
            target.insert(format!("runtime.tools.{}.path", tool.as_str()));
        }
    }
}

fn resolved_absolute_path(value: Option<&String>) -> Option<PathBuf> {
    let value = value?.trim().trim_matches(['"', '\'']);
    if value.is_empty() || value.contains('{') || value.contains('}') {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

fn runtime_tool_preflight_from_props(
    props: &HashMap<String, String>,
) -> RuntimeToolPreflightReport {
    let mut unresolved = BTreeSet::new();
    for (key, value) in props {
        if is_compile_recipe_property(key) {
            collect_unresolved_runtime_tool_paths(value, &mut unresolved);
        }
    }

    let mut missing = BTreeSet::new();
    for key in ["compiler.path", "compiler.sdk.path"] {
        if let Some(path) = resolved_absolute_path(props.get(key)) {
            if !path.is_dir() {
                missing.insert(path);
            }
        }
    }

    // ESP32 prebuild recipes transform a Core-provided bootloader ELF into the
    // upload artifact. Arduino CLI otherwise discovers a missing SDK package
    // only after preprocessing and esptool startup, so authenticate this input
    // explicitly whenever the selected recipe advertises it.
    let recipe_uses_core_bootloader = props.iter().any(|(key, value)| {
        is_compile_recipe_property(key) && value.contains("bootloader_") && value.contains(".elf")
    });
    if recipe_uses_core_bootloader {
        if let (Some(sdk), Some(boot), Some(freq)) = (
            resolved_absolute_path(props.get("compiler.sdk.path")),
            props.get("build.boot").map(|value| value.trim()),
            props.get("build.boot_freq").map(|value| value.trim()),
        ) {
            if !boot.is_empty()
                && !freq.is_empty()
                && !boot.contains(['{', '}'])
                && !freq.contains(['{', '}'])
            {
                let bootloader = sdk
                    .join("bin")
                    .join(format!("bootloader_{boot}_{freq}.elf"));
                if !bootloader.is_file() {
                    missing.insert(bootloader);
                }
            }
        }
    }

    RuntimeToolPreflightReport {
        board_hidden: props
            .get("hide")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("true")),
        unresolved_runtime_tool_paths: unresolved.into_iter().collect(),
        missing_critical_paths: missing.into_iter().collect(),
    }
}

/// Re-check the concrete compiler/SDK/firmware paths in an already-expanded
/// property set.
///
/// CK Forge may reuse the expensive board/Core property expansion inside one
/// authenticated toolchain generation, but it must never cache the result of
/// these filesystem checks. A tool directory can be removed by another
/// process between two compile requests even when the expanded strings are
/// unchanged.
pub(crate) fn runtime_tool_preflight_from_resolved_props(
    resolved: &ResolvedProps,
) -> RuntimeToolPreflightReport {
    runtime_tool_preflight_from_props(&resolved.props)
}

/// Resolve only the selected board's active compile properties and verify that
/// they point at installed runtime packages before launching Arduino CLI.
///
/// A resolver error is deliberately distinct from a blocked report: callers
/// may conservatively continue through the native Core for unfamiliar third-
/// party platforms, while definite missing runtime evidence must be blocked.
pub async fn preflight_runtime_tools(
    sysroot: &Path,
    fqbn: &str,
    build_path: &Path,
    sketch_dir: &Path,
    sketch_name: &str,
    extra_build_props: &[(String, String)],
) -> Result<RuntimeToolPreflightReport> {
    let resolved = resolve_properties(
        sysroot,
        fqbn,
        build_path,
        sketch_dir,
        sketch_name,
        extra_build_props,
    )
    .await?;
    Ok(runtime_tool_preflight_from_resolved_props(&resolved))
}

/// Find latest version directory (e.g., 3.3.6 in packages/esp32/hardware/esp32/)
fn find_latest_version_dir(parent: &Path) -> Result<PathBuf> {
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    let entries =
        std::fs::read_dir(parent).with_context(|| format!("Cannot read {}", parent.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let parts: Vec<u32> = name.split('.').filter_map(|s| s.parse().ok()).collect();
        if parts.is_empty() {
            // Non-version dir, still use  if it's the only one
            if best.is_none() {
                best = Some((vec![0], p));
            }
            continue;
        }
        if best.is_none() || parts > best.as_ref().unwrap().0 {
            best = Some((parts, p));
        }
    }
    best.map(|(_, p)| p).context("No version directories found")
}

/// Parse a properties file (key=value format).
async fn parse_properties_file(path: &Path) -> Result<HashMap<String, String>> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read {}", path.display()))?;
    let mut props = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            props.insert(key.trim().to_string(), value.to_string());
        }
    }
    Ok(props)
}

/// Parse board properties from boards.txt and boards.local.txt, including menu selections.
async fn parse_board_properties(
    boards_txt: &Path,
    board_id: &str,
    options: &HashMap<&str, &str>,
) -> Result<HashMap<String, String>> {
    let base_content = tokio::fs::read_to_string(boards_txt)
        .await
        .with_context(|| format!("Failed to read {}", boards_txt.display()))?;
    let boards_local_txt = boards_txt.with_file_name("boards.local.txt");
    let local_content = if boards_local_txt.exists() {
        Some(
            tokio::fs::read_to_string(&boards_local_txt)
                .await
                .with_context(|| format!("Failed to read {}", boards_local_txt.display()))?,
        )
    } else {
        None
    };

    let prefix = format!("{}.", board_id);
    let mut board_props = HashMap::new();
    let mut menu_props: HashMap<String, HashMap<String, HashMap<String, String>>> = HashMap::new();
    // Track the first option ID seen for each menu (for default selection)
    let mut menu_first_option: HashMap<String, String> = HashMap::new();

    // Arduino merges boards.local.txt after boards.txt. Parsing in that order
    // preserves the original menu order/default while allowing local board and
    // menu properties to replace the packaged definitions.
    for content in std::iter::once(base_content.as_str()).chain(local_content.as_deref()) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((full_key, value)) = trimmed.split_once('=') {
                let full_key = full_key.trim();
                if let Some(prop_key) = full_key.strip_prefix(&prefix) {
                    // Check if this is a menu option: menu.MenuId.OptionId.prop
                    if let Some(menu_rest) = prop_key.strip_prefix("menu.") {
                        let parts: Vec<&str> = menu_rest.splitn(3, '.').collect();
                        if parts.len() == 3 {
                            let menu_id = parts[0].to_string();
                            let option_id = parts[1].to_string();
                            // Track first option seen per menu (boards.txt order = default)
                            menu_first_option
                                .entry(menu_id.clone())
                                .or_insert_with(|| option_id.clone());
                            menu_props
                                .entry(menu_id)
                                .or_default()
                                .entry(option_id)
                                .or_default()
                                .insert(parts[2].to_string(), value.to_string());
                        }
                    } else {
                        board_props.insert(prop_key.to_string(), value.to_string());
                    }
                }
            }
        }
    }

    // Apply selected menu options
    for (menu_id, option_id) in options {
        if let Some(menu) = menu_props.get(*menu_id) {
            if let Some(selected) = menu.get(*option_id) {
                for (k, v) in selected {
                    board_props.insert(k.clone(), v.clone());
                }
            }
        }
    }

    // Also apply default menu values for menus not explicitly selected
    // arduino-cli uses the first menu option as default
    for (menu_id, _selections) in &menu_props {
        if options.contains_key(menu_id.as_str()) {
            continue; // Already applied
        }
        // Use the first option that appeared in boards.txt (tracked in menu_first_option)
        if let Some(default_option) = menu_first_option.get(menu_id) {
            if let Some(selected) = _selections.get(default_option) {
                for (k, v) in selected {
                    board_props.insert(k.clone(), v.clone());
                }
            }
        }
    }

    Ok(board_props)
}

/// Resolve tool paths by scanning the tools directory.
async fn resolve_tool_paths(
    props: &mut HashMap<String, String>,
    tools_dir: &Path,
    platform_dir: &Path,
) -> Result<()> {
    if !tools_dir.exists() {
        return Ok(());
    }

    // Scan installed.json for exact tool version mappings
    let installed_json = platform_dir.join("installed.json");
    let mut tool_versions: HashMap<String, String> = HashMap::new();

    if installed_json.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&installed_json).await {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(packages) = parsed.get("packages").and_then(|p| p.as_array()) {
                    for pkg in packages {
                        if let Some(platforms) = pkg.get("platforms").and_then(|p| p.as_array()) {
                            for platform in platforms {
                                if let Some(deps) =
                                    platform.get("toolsDependencies").and_then(|d| d.as_array())
                                {
                                    for dep in deps {
                                        let name =
                                            dep.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                        let version = dep
                                            .get("version")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        if !name.is_empty() && !version.is_empty() {
                                            tool_versions
                                                .insert(name.to_string(), version.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // For each tool, find its path and inject runtime.tools.{name}.path
    if let Ok(entries) = std::fs::read_dir(tools_dir) {
        for entry in entries.flatten() {
            let tool_name = entry.file_name().to_string_lossy().to_string();
            let tool_dir = entry.path();
            if !tool_dir.is_dir() {
                continue;
            }

            // Find the right version directory. Arduino CLI exposes both the
            // unversioned runtime.tools.<name>.path alias and the exact
            // runtime.tools.<name>-<version>.path alias requested by the
            // platform. Only publish the versioned alias when that exact
            // directory exists: silently pointing a versioned property at a
            // different installed tool would defeat the runtime preflight.
            let requested_version_dir = tool_versions
                .get(&tool_name)
                .map(|version| (version, tool_dir.join(version)));
            let version_dir = requested_version_dir
                .as_ref()
                .filter(|(_, specific)| specific.is_dir())
                .map(|(_, specific)| specific.clone())
                .unwrap_or_else(|| find_latest_version_dir(&tool_dir).unwrap_or(tool_dir.clone()));

            let tool_path = version_dir.to_string_lossy().replace('\\', "/");
            props.insert(
                format!("runtime.tools.{}.path", tool_name),
                tool_path.clone(),
            );
            if let Some((version, specific)) = requested_version_dir
                && specific.is_dir()
            {
                props.insert(
                    format!("runtime.tools.{}-{}.path", tool_name, version),
                    tool_path.clone(),
                );
            }

            // Also set aliases used by platform.txt
            // e.g., runtime.tools.esp-x32.path, runtime.tools.esp-rv32.path
            // and chip-variant-libs via tools.esp32-arduino-libs.path
        }
    }

    // Resolve chip variant libs: the platform.txt uses
    // tools.esp32-arduino-libs.path={runtime.tools.{build.chip_variant}-libs.path}
    // The platform default is build.chip_variant={build.mcu}, but a board entry
    // or ChipVariant menu may pin a different SDK tree (esp32p4 defaults to the
    // esp32p4_es engineering-sample SDK, whose bootloader and libraries differ
    // from esp32p4-libs). compiler.sdk.path has no host-suffixed variant, so a
    // value pre-resolved from the wrong tree survives expansion; honor the
    // concrete board/menu chip variant before falling back to build.mcu.
    let chip_variant = props
        .get("build.chip_variant")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.contains('{'))
        .or_else(|| props.get("build.mcu").cloned());
    if let Some(chip_variant) = chip_variant {
        let libs_tool = format!("{}-libs", chip_variant);
        if let Some(libs_path) = props
            .get(&format!("runtime.tools.{}.path", libs_tool))
            .cloned()
        {
            props.insert("tools.esp32-arduino-libs.path".into(), libs_path.clone());
            props.insert("compiler.sdk.path".into(), libs_path);
        }
    }

    // Resolve compiler path based on architecture
    if let Some(tarch) = props.get("build.tarch").cloned() {
        let gcc_tool = format!("esp-{}", if tarch == "xtensa" { "x32" } else { "rv32" });
        if let Some(gcc_path) = props
            .get(&format!("runtime.tools.{}.path", gcc_tool))
            .cloned()
        {
            // Set the path that platform.txt references
            props.insert(format!("tools.{}-esp-elf-gcc.path", tarch), gcc_path);
        }
    }

    Ok(())
}

/// Project host-specific platform properties onto their base property names.
///
/// Arduino's platform resolver performs this step before placeholder expansion.
/// Keeping the suffixed property as well as the projected base property matches
/// the expanded property map exposed by arduino-cli.
fn apply_host_property_overrides(props: &mut HashMap<String, String>) {
    #[cfg(target_os = "windows")]
    apply_property_overrides_for_suffix(props, "windows");
}

#[cfg(any(target_os = "windows", test))]
fn apply_property_overrides_for_suffix(props: &mut HashMap<String, String>, suffix: &str) {
    let suffix = format!(".{suffix}");
    let overrides: Vec<(String, String)> = props
        .iter()
        .filter_map(|(key, value)| {
            key.strip_suffix(&suffix)
                .filter(|base_key| !base_key.is_empty())
                .map(|base_key| (base_key.to_string(), value.clone()))
        })
        .collect();

    for (base_key, value) in overrides {
        props.insert(base_key, value);
    }
}

/// Iteratively expand all {variable} references in property values.
fn expand_all_properties(props: &mut HashMap<String, String>) {
    let var_re = regex::Regex::new(r"\{([\w\-\.]+)\}").unwrap();
    for _ in 0..25 {
        let mut changed = false;
        let snapshot: Vec<(String, String)> =
            props.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (key, old_val) in &snapshot {
            if !old_val.contains('{') {
                continue;
            }
            let new_val = var_re
                .replace_all(old_val, |caps: &regex::Captures| {
                    let var = &caps[1];
                    if var == key {
                        // avoid self-reference
                        return caps[0].to_string();
                    }
                    match props.get(var) {
                        Some(v) if !v.contains(&format!("{{{}}}", key)) => v.clone(), // avoid cycles
                        _ => caps[0].to_string(),
                    }
                })
                .to_string();
            if new_val != *old_val {
                props.insert(key.clone(), new_val);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

// ========================== Source Discovery ==========================

/// Discover all source files that need compilation.
fn discover_sources(
    core_dir: &Path,
    variant_dir: &Path,
    library_dirs: &[PathBuf],
    sketch_cpp_path: &Path,
    build_path: &Path,
) -> Vec<SourceFile> {
    let mut sources = Vec::new();

    // 1. Core sources
    if core_dir.exists() {
        walk_sources(
            core_dir,
            &build_path.join("core"),
            SourceCategory::Core,
            &mut sources,
        );
    }
    // Variant sources (if any)
    if variant_dir.exists() {
        walk_sources(
            variant_dir,
            &build_path.join("core"),
            SourceCategory::Core,
            &mut sources,
        );
    }

    // 2. Library sources
    for lib_dir in library_dirs {
        let raw_lib_name = lib_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let lib_is_src = raw_lib_name.eq_ignore_ascii_case("src");
        let lib_name = if lib_is_src {
            lib_dir
                .parent()
                .and_then(|parent| parent.file_name())
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        } else {
            raw_lib_name
        };
        let obj_base = build_path.join("libraries").join(&lib_name);

        // Check src/ first (1.5 layout → recursive), then root (1.0 layout → root only, no recursion)
        let src_dir = if lib_is_src {
            lib_dir.to_path_buf()
        } else {
            lib_dir.join("src")
        };
        if src_dir.is_dir() {
            walk_sources(&src_dir, &obj_base, SourceCategory::Library, &mut sources);
        } else {
            walk_sources_flat(lib_dir, &obj_base, SourceCategory::Library, &mut sources);
        }
    }

    // 3. Sketch source
    if sketch_cpp_path.exists() {
        let obj_path = build_path.join("sketch").join(format!(
            "{}.o",
            sketch_cpp_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        ));
        sources.push(SourceFile {
            path: sketch_cpp_path.to_path_buf(),
            recipe_key: "recipe.cpp.o.pattern",
            object_path: obj_path,
            category: SourceCategory::Sketch,
        });
    }

    sources
}

/// Recursively walk a directory for .c/.cpp/.S files.
fn walk_sources(
    dir: &Path,
    obj_base: &Path,
    category: SourceCategory,
    sources: &mut Vec<SourceFile>,
) {
    walk_sources_from_root(dir, dir, obj_base, category, sources);
}

/// Recursively walk `dir` while keeping object paths relative to the original
/// source root. Passing the current directory to `strip_prefix` at every level
/// would flatten nested sources and make paths such as `a/foo.c` and `b/foo.c`
/// collide at the same `foo.o` destination.
fn walk_sources_from_root(
    source_root: &Path,
    dir: &Path,
    obj_base: &Path,
    category: SourceCategory,
    sources: &mut Vec<SourceFile>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let p = entry.path();
        if p.is_dir() {
            walk_sources_from_root(source_root, &p, obj_base, category, sources);
            continue;
        }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let recipe_key = match ext {
            "c" => "recipe.c.o.pattern",
            "cpp" | "cc" | "cxx" => "recipe.cpp.o.pattern",
            "S" | "s" => "recipe.S.o.pattern",
            _ => continue,
        };
        // Compute object path relative to the fixed source root mapped into obj_base.
        let rel = p.strip_prefix(source_root).unwrap_or(&p);
        let obj_path = obj_base.join(rel).with_extension("o");
        sources.push(SourceFile {
            path: p,
            recipe_key,
            object_path: obj_path,
            category,
        });
    }
}

/// Walk root-level files + utility/ subdirectory (Arduino 1.0 flat library layout).
/// Per Arduino Library Specification 1.0: compile root .c/.cpp/.S and utility/*.c/*.cpp/*.S.
fn walk_sources_flat(
    dir: &Path,
    obj_base: &Path,
    category: SourceCategory,
    sources: &mut Vec<SourceFile>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            // Only recurse into utility/ per Arduino 1.0 spec
            if p.file_name().unwrap_or_default() == "utility" {
                walk_sources_from_root(dir, &p, obj_base, category, sources);
            }
            continue;
        }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let recipe_key = match ext {
            "c" => "recipe.c.o.pattern",
            "cpp" | "cc" | "cxx" => "recipe.cpp.o.pattern",
            "S" | "s" => "recipe.S.o.pattern",
            _ => continue,
        };
        let rel = p.strip_prefix(dir).unwrap_or(&p);
        let obj_path = obj_base.join(rel).with_extension("o");
        sources.push(SourceFile {
            path: p,
            recipe_key,
            object_path: obj_path,
            category,
        });
    }
}

// ========================== Arduino Preprocessing ==========================

/// Convert .ino file to .cpp with Arduino function prototypes.
/// Mimics Arduino IDE behavior: insert prototypes just before the first function definition
/// so that type declarations (enum, struct, class, typedef) above are already visible.
pub fn preprocess_ino(code: &str, fqbn: &str) -> String {
    // Extract potential function declarations to generate prototypes
    // Match any return type (including custom types like Page, TFT_eSPI, etc.)
    // Note: Rust regex crate does not support lookahead, so we filter keywords post-match
    let func_re = regex::Regex::new(
        r"(?m)^[ \t]*((?:unsigned\s+|signed\s+|const\s+|static\s+|inline\s+|volatile\s+)*(?:[A-Za-z_]\w*(?:::\w+)*)\s*[\*&]*\s+(\w+)\s*\([^)]*\))\s*\{"
    ).unwrap();

    let keywords: std::collections::HashSet<&str> = [
        "if", "else", "while", "for", "switch", "return", "case", "do",
    ]
    .iter()
    .copied()
    .collect();

    let mut prototypes = Vec::new();
    let mut first_func_byte_offset: Option<usize> = None;
    for caps in func_re.captures_iter(code) {
        let func_name = &caps[2];
        // Skip control flow keywords that look like function calls
        if keywords.contains(func_name) {
            continue;
        }
        let sig = caps[1].trim();
        if sig.contains("setup(") || sig.contains("loop(") {
            continue;
        }
        prototypes.push(format!("{};", strip_default_args(sig)));
        if first_func_byte_offset.is_none() {
            first_func_byte_offset = Some(caps.get(0).unwrap().start());
        }
    }

    let mut out = String::new();
    out.push_str("#include <Arduino.h>\n");

    if prototypes.is_empty() || first_func_byte_offset.is_none() {
        // No functions found, just prepend Arduino.h
        out.push_str("#line 1\n");
        out.push_str(code);
        return out;
    }

    let insert_pos = first_func_byte_offset.unwrap();
    // Count lines before insert_pos for correct #line directive
    let lines_before = code[..insert_pos].matches('\n').count();

    // Emit code before first function (includes, defines, enums, structs, globals)
    out.push_str("#line 1\n");
    out.push_str(&code[..insert_pos]);

    // Insert prototypes
    out.push_str("\n// Auto-generated prototypes\n");
    for proto in &prototypes {
        out.push_str(proto);
        out.push('\n');
    }
    // Reset line numbering for remaining code
    out.push_str(&format!("#line {}\n", lines_before + 1));
    out.push_str(&code[insert_pos..]);
    out
}

/// Strip default argument values from a function signature.
/// Handles nested parentheses: `void foo(int x = sizeof(int))` → `void foo(int x)`
fn strip_default_args(sig: &str) -> String {
    let Some(paren_start) = sig.find('(') else {
        return sig.to_string();
    };
    let Some(paren_end) = sig.rfind(')') else {
        return sig.to_string();
    };
    let prefix = &sig[..paren_start + 1];
    let params_str = &sig[paren_start + 1..paren_end];
    let suffix = &sig[paren_end..];

    // Split params respecting nested parentheses
    let mut params = Vec::new();
    let mut depth = 0;
    let mut current = String::new();
    for ch in params_str.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                params.push(current.clone());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        params.push(current);
    }

    let cleaned: Vec<String> = params
        .iter()
        .map(|p| {
            // Find '=' at depth 0
            let mut d = 0;
            for (i, ch) in p.char_indices() {
                match ch {
                    '(' => d += 1,
                    ')' => d -= 1,
                    '=' if d == 0 => return p[..i].trim_end().to_string(),
                    _ => {}
                }
            }
            p.to_string()
        })
        .collect();

    format!("{}{}{}", prefix, cleaned.join(", "), suffix)
}

// ========================== Compile Command Generation ==========================

/// Expand a recipe pattern with source/object file substitution.
fn expand_recipe_for_file(
    recipe_pattern: &str,
    source_file: &Path,
    object_file: &Path,
    includes: &str,
) -> String {
    let mut cmd = recipe_pattern.to_string();
    cmd = cmd.replace(
        "{source_file}",
        &source_file.to_string_lossy().replace('\\', "/"),
    );
    cmd = cmd.replace(
        "{object_file}",
        &object_file.to_string_lossy().replace('\\', "/"),
    );
    cmd = cmd.replace("{includes}", includes);
    cmd
}

// ========================== Compilation Execution ==========================

/// Run a compile command string. Returns Ok on success, Err on failure.
async fn execute_compile_command(cmd_str: &str) -> Result<()> {
    let tokens = tokenize_recipe_command(cmd_str);
    if tokens.is_empty() {
        return Err(anyhow::anyhow!("Empty compile command"));
    }
    let mut cmd = Command::new(&tokens[0]);
    hide_window(&mut cmd);
    if tokens.len() > 1 {
        cmd.args(&tokens[1..]);
    }
    let output = cmd
        .output()
        .await
        .with_context(|| format!("Failed to spawn: {}", &tokens[0]))?;
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "Compile failed: {}\nSTDERR: {}",
            cmd_str,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Tokenize an Arduino recipe command string.
///
/// Unlike shlex (which strips all quotes), this preserves internal quotes
/// that are semantically meaningful to GCC (e.g., -DARDUINO_BOARD="ESP32S3_DEV").
///
/// Rules:
/// - Tokens starting AND ending with " are fully-quoted: strip outer quotes
/// - Other tokens may contain " which are preserved as-is
/// - Whitespace separates tokens (unless inside a fully-quoted region)
fn tokenize_recipe_command(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = cmd.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }

        if ch == '"' {
            // Fully-quoted token: read until closing "
            chars.next(); // consume opening "
            let mut token = String::new();
            while let Some(&c) = chars.peek() {
                if c == '"' {
                    chars.next(); // consume closing "
                    // Check if more non-whitespace follows (e.g., mid-arg quotes)
                    // In that case, this was just part of a larger token
                    if chars.peek().is_some_and(|&c| !c.is_whitespace()) {
                        // Continue reading the rest as unquoted
                        token = format!("\"{}\"", token);
                        while let Some(&c) = chars.peek() {
                            if c.is_whitespace() {
                                break;
                            }
                            if c == '"' {
                                // Another quoted section
                                chars.next();
                                token.push('"');
                                while let Some(&ic) = chars.peek() {
                                    if ic == '"' {
                                        chars.next();
                                        token.push('"');
                                        break;
                                    }
                                    token.push(ic);
                                    chars.next();
                                }
                            } else {
                                token.push(c);
                                chars.next();
                            }
                        }
                        tokens.push(token);
                    } else {
                        // Pure quoted token: strip outer quotes
                        tokens.push(token);
                    }
                    break;
                }
                token.push(c);
                chars.next();
            }
        } else {
            // Unquoted token: read until whitespace, but handle embedded quotes
            let mut token = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                if c == '"' {
                    // Embedded quote - preserve it and read the quoted part
                    token.push('"');
                    chars.next();
                    while let Some(&ic) = chars.peek() {
                        if ic == '"' {
                            token.push('"');
                            chars.next();
                            break;
                        }
                        token.push(ic);
                        chars.next();
                    }
                } else {
                    token.push(c);
                    chars.next();
                }
            }
            tokens.push(token);
        }
    }

    tokens
}

/// Split a command string respecting quotes (uses shlex).
fn split_command_tokens(cmd: &str) -> Vec<String> {
    if let Some(tokens) = shlex::split(cmd) {
        tokens
    } else {
        cmd.split_whitespace().map(String::from).collect()
    }
}

// ========================== Main Entry Point ==========================

/// Compile a sketch directly without arduino-cli.
///
/// # Arguments
/// * `sysroot` - Root of the CK workspace (contains packages/, bin/, etc.)
/// * `fqbn` - Fully Qualified Board Name (e.g., "esp32:esp32:esp32s3:PartitionScheme=huge_app")
/// * `sketch_code` - The .ino source code
/// * `sketch_dir` - Directory containing the sketch
/// * `sketch_name` - Name of the sketch (e.g., "my_sketch.ino")
/// * `extra_libs` - Additional library directories
/// * `build_path` - Where to put build outputs
/// * `max_jobs` - Maximum parallel compilation jobs
/// * `generate_artifacts` - Whether to generate upload artifacts (bin, partitions, merged)
/// * `log_callback` - Callback for progress messages
pub async fn direct_compile<L>(
    sysroot: &Path,
    fqbn: &str,
    sketch_code: &str,
    sketch_dir: &Path,
    sketch_name: &str,
    extra_libs: &[PathBuf],
    build_path: &Path,
    max_jobs: u32,
    generate_artifacts: bool,
    log_callback: &L,
) -> Result<DirectCompileResult>
where
    L: Fn(String) + Send + Sync + 'static,
{
    let start = std::time::Instant::now();
    let mut full_log = String::new();

    log_callback("[DCE] Direct Compilation Engine starting...\n".into());

    // ========== Phase 1: Resolve Properties ==========
    let t1 = std::time::Instant::now();

    let speed_props = vec![
        ("compiler.optimization_flags".to_string(), "-O1".to_string()),
        (
            "compiler.c.extra_flags".to_string(),
            "-pipe -g0 -O1 -fno-lto".to_string(),
        ),
        (
            "compiler.cpp.extra_flags".to_string(),
            "-pipe -g0 -O1 -fno-lto".to_string(),
        ),
        (
            "compiler.S.extra_flags".to_string(),
            "-pipe -fno-lto".to_string(),
        ),
        (
            "compiler.c.elf.extra_flags".to_string(),
            "-O1 -g0 -fno-lto".to_string(),
        ),
        (
            "compiler.ck.final_flags".to_string(),
            "-O1 -g0 -fno-lto".to_string(),
        ),
    ];

    let resolved = resolve_properties(
        sysroot,
        fqbn,
        build_path,
        sketch_dir,
        sketch_name,
        &speed_props,
    )
    .await?;
    let props = &resolved.props;

    let msg = format!(
        "[DCE] Phase 1: Properties resolved in {:.1}ms ({} keys)\n",
        t1.elapsed().as_secs_f64() * 1000.0,
        props.len()
    );
    log_callback(msg.clone());
    full_log.push_str(&msg);

    // ========== Phase 2: Prepare build directories & sketch ==========
    let t2 = std::time::Instant::now();

    tokio::fs::create_dir_all(build_path.join("core")).await?;
    tokio::fs::create_dir_all(build_path.join("sketch")).await?;
    tokio::fs::create_dir_all(build_path.join("libraries")).await?;

    // Ensure build_opt.h exists
    let build_opt = build_path.join("build_opt.h");
    if !build_opt.exists() {
        // Check if sketch has build_opt.h
        let sketch_build_opt = PathBuf::from(sketch_dir).join("build_opt.h");
        if sketch_build_opt.exists() {
            tokio::fs::copy(&sketch_build_opt, &build_opt).await?;
        } else {
            tokio::fs::write(&build_opt, "").await?;
        }
    }

    // Ensure file_opts exists
    let file_opts = build_path.join("file_opts");
    if !file_opts.exists() {
        tokio::fs::write(&file_opts, "").await?;
    }

    // Preprocess .ino → .cpp (only write if content changed)
    // Arduino IDE concatenates all .ino files in alphabetical order (main sketch first)
    let mut full_sketch_code = sketch_code.to_string();
    if let Ok(entries) = std::fs::read_dir(sketch_dir) {
        let mut extra_inos: Vec<PathBuf> = entries
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|e| e.to_str()) == Some("ino")
                    && p.file_name().unwrap_or_default().to_string_lossy() != sketch_name
                {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        extra_inos.sort();
        for ino in &extra_inos {
            if let Ok(extra_code) = std::fs::read_to_string(ino) {
                full_sketch_code.push_str("\n// === Concatenated from: ");
                full_sketch_code.push_str(&ino.file_name().unwrap_or_default().to_string_lossy());
                full_sketch_code.push_str(" ===\n");
                full_sketch_code.push_str(&extra_code);
            }
        }
    }
    let sketch_cpp_name = format!("{}.cpp", sketch_name);
    let sketch_cpp_path = build_path.join("sketch").join(&sketch_cpp_name);
    let preprocessed = preprocess_ino(&full_sketch_code, fqbn);
    let existing = tokio::fs::read_to_string(&sketch_cpp_path)
        .await
        .unwrap_or_default();
    if existing != preprocessed {
        tokio::fs::write(&sketch_cpp_path, &preprocessed).await?;
    }

    // Copy sdkconfig if exists
    if let Some(sdk_path) = props.get("compiler.sdk.path") {
        let sdkconfig_src = PathBuf::from(sdk_path).join("sdkconfig");
        let sdkconfig_dst = build_path.join("sdkconfig");
        if sdkconfig_src.exists() && !sdkconfig_dst.exists() {
            let _ = tokio::fs::copy(&sdkconfig_src, &sdkconfig_dst).await;
        }
    }

    let msg = format!(
        "[DCE] Phase 2: Build dirs prepared in {:.1}ms\n",
        t2.elapsed().as_secs_f64() * 1000.0
    );
    log_callback(msg.clone());
    full_log.push_str(&msg);

    // ========== Phase 3: Discover source files ==========
    let t3 = std::time::Instant::now();

    let core_dir = props
        .get("runtime.platform.path")
        .map(|p| {
            PathBuf::from(p).join("cores").join(
                props
                    .get("build.core")
                    .map(|s| s.as_str())
                    .unwrap_or("esp32"),
            )
        })
        .unwrap_or_default();

    let variant_dir = props
        .get("build.variant.path")
        .map(PathBuf::from)
        .unwrap_or_default();

    let sources = discover_sources(
        &core_dir,
        &variant_dir,
        extra_libs,
        &sketch_cpp_path,
        build_path,
    );

    let core_count = sources
        .iter()
        .filter(|s| s.category == SourceCategory::Core)
        .count();
    let lib_count = sources
        .iter()
        .filter(|s| s.category == SourceCategory::Library)
        .count();
    let sketch_count = sources
        .iter()
        .filter(|s| s.category == SourceCategory::Sketch)
        .count();

    let msg = format!(
        "[DCE] Phase 3: Discovered {} sources (core={}, lib={}, sketch={}) in {:.1}ms\n",
        sources.len(),
        core_count,
        lib_count,
        sketch_count,
        t3.elapsed().as_secs_f64() * 1000.0
    );
    log_callback(msg.clone());
    full_log.push_str(&msg);

    // ========== Phase 4: Build include paths ==========
    let mut include_dirs: Vec<String> = Vec::new();

    // Core includes
    if core_dir.exists() {
        include_dirs.push(format!(
            "-I{}",
            core_dir.to_string_lossy().replace('\\', "/")
        ));
    }
    if variant_dir.exists() {
        include_dirs.push(format!(
            "-I{}",
            variant_dir.to_string_lossy().replace('\\', "/")
        ));
    }

    // Library includes
    for lib_dir in extra_libs {
        let lib_path = lib_dir.to_string_lossy().replace('\\', "/");
        include_dirs.push(format!("-I{}", lib_path));
        let src = lib_dir.join("src");
        if src.exists() {
            include_dirs.push(format!("-I{}", src.to_string_lossy().replace('\\', "/")));
            // Recursively add ALL src subfolders (for libraries with nested headers)
            fn add_subdirs_recursive(dir: &Path, include_dirs: &mut Vec<String>) {
                let Ok(entries) = std::fs::read_dir(dir) else {
                    return;
                };
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        include_dirs.push(format!(
                            "-I{}",
                            entry.path().to_string_lossy().replace('\\', "/")
                        ));
                        add_subdirs_recursive(&entry.path(), include_dirs);
                    }
                }
            }
            add_subdirs_recursive(&src, &mut include_dirs);
        }
        // For flat layout, also add utility/ to include path
        let utility = lib_dir.join("utility");
        if utility.exists() {
            include_dirs.push(format!(
                "-I{}",
                utility.to_string_lossy().replace('\\', "/")
            ));
        }
    }

    let includes_str = include_dirs.join(" ");

    // ========== Core Archive Cache ==========
    // Compute a cache key for the core archive based on FQBN, core directory, and compiler settings.
    // If a cached core.a exists, skip compiling all core source files.
    let core_cache_dir = {
        let mut hasher = Sha256::new();
        hasher.update(fqbn.as_bytes());
        hasher.update(core_dir.to_string_lossy().as_bytes());
        if let Some(v) = props.get("recipe.c.o.pattern") {
            hasher.update(v.as_bytes());
        }
        if let Some(v) = props.get("recipe.cpp.o.pattern") {
            hasher.update(v.as_bytes());
        }
        if let Some(v) = props.get("recipe.S.o.pattern") {
            hasher.update(v.as_bytes());
        }
        if let Some(v) = props.get("recipe.ar.pattern") {
            hasher.update(v.as_bytes());
        }
        let hash = format!("{:x}", hasher.finalize());
        sysroot.join("cache").join("cores").join(&hash[..16])
    };

    // Determine archive path early (needed for cache check)
    let archive_file = props
        .get("archive_file")
        .map(|s| s.as_str())
        .unwrap_or("core.a");
    let archive_path = if let Some(afp) = props.get("archive_file_path") {
        PathBuf::from(
            afp.replace("{archive_file}", archive_file)
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        )
    } else {
        build_path.join(archive_file)
    };
    if let Some(parent) = archive_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let cached_core_a = core_cache_dir.join("core.a");
    let core_cache_hit = cached_core_a.exists();

    if core_cache_hit {
        // Copy cached core.a to build directory
        let _ = std::fs::copy(&cached_core_a, &archive_path);
    }

    // ========== Library Object Cache ==========
    let lib_cache_base = {
        let mut hasher = Sha256::new();
        hasher.update(b"libcache_v1");
        hasher.update(fqbn.as_bytes());
        if let Some(v) = props.get("recipe.c.o.pattern") {
            hasher.update(v.as_bytes());
        }
        if let Some(v) = props.get("recipe.cpp.o.pattern") {
            hasher.update(v.as_bytes());
        }
        if let Some(v) = props.get("recipe.S.o.pattern") {
            hasher.update(v.as_bytes());
        }
        let hash = format!("{:x}", hasher.finalize());
        sysroot.join("cache").join("lib_objects").join(&hash[..16])
    };

    let libs_build_dir = build_path.join("libraries");
    let _ = std::fs::create_dir_all(&libs_build_dir);
    let mut lib_cache_hits = std::collections::HashSet::<String>::new();

    for lib_dir in extra_libs {
        let lib_name = lib_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let cache_dir = lib_cache_base.join(&lib_name);
        let marker = cache_dir.join(".t");
        if !marker.exists() {
            continue;
        }

        let cache_time = file_mtime_ms(&marker);
        let newest_src = newest_source_mtime_recursive(lib_dir);
        if cache_time >= newest_src && cache_time > 0 {
            let target = libs_build_dir.join(&lib_name);
            let _ = std::fs::create_dir_all(&target);
            restore_cached_objects(&cache_dir, &target);
            lib_cache_hits.insert(lib_name);
        }
    }

    // ========== Phase 5: Parallel Compilation ==========
    let t5 = std::time::Instant::now();

    // Setup ccache environment
    let ccache_env = build_ccache_env(sysroot);

    // Filter sources that need recompilation
    // Check both source mtime AND dependency file (.d) for header changes
    let mut to_compile: Vec<&SourceFile> = Vec::new();
    let mut up_to_date = 0usize;
    for src in &sources {
        // Skip core sources entirely if core cache hit
        if core_cache_hit && src.category == SourceCategory::Core {
            up_to_date += 1;
            continue;
        }
        // Skip library sources if library cache hit
        if src.category == SourceCategory::Library {
            if let Some(lib_name) = src
                .object_path
                .strip_prefix(&libs_build_dir)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().to_string())
            {
                if lib_cache_hits.contains(&lib_name) {
                    up_to_date += 1;
                    continue;
                }
            }
        }
        if src.object_path.exists() {
            let obj_mtime = file_mtime_ms(&src.object_path);
            let src_mtime = file_mtime_ms(&src.path);
            if obj_mtime >= src_mtime {
                // Also check .d dependency file for header changes
                let dep_file = src.object_path.with_extension("d");
                if !dep_file.exists() || !any_dep_newer(&dep_file, obj_mtime) {
                    up_to_date += 1;
                    continue;
                }
            }
        }
        to_compile.push(src);
    }

    let msg = format!(
        "[DCE] Phase 5: Compiling {} files ({} up-to-date, {} jobs)\n",
        to_compile.len(),
        up_to_date,
        max_jobs
    );
    log_callback(msg.clone());
    full_log.push_str(&msg);

    if !to_compile.is_empty() {
        let parallel = max_jobs.max(1).min(16) as usize;
        let sem = std::sync::Arc::new(Semaphore::new(parallel));
        let mut join_set: JoinSet<Result<()>> = JoinSet::new();

        for src in &to_compile {
            let recipe_pattern = props
                .get(src.recipe_key)
                .cloned()
                .with_context(|| format!("Missing recipe: {}", src.recipe_key))?;
            let cmd_str =
                expand_recipe_for_file(&recipe_pattern, &src.path, &src.object_path, &includes_str);

            // Ensure parent dir exists
            if let Some(parent) = src.object_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let sem = sem.clone();
            let ccache_env = ccache_env.clone();

            join_set.spawn(async move {
                let _permit = sem
                    .acquire_owned()
                    .await
                    .map_err(|e| anyhow::anyhow!("semaphore: {}", e))?;
                execute_compile_with_env(&cmd_str, &ccache_env).await
            });
        }

        let mut compiled = 0usize;
        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(())) => compiled += 1,
                Ok(Err(e)) => {
                    join_set.abort_all();
                    return Err(e.context("Compilation failed"));
                }
                Err(e) => {
                    join_set.abort_all();
                    return Err(anyhow::anyhow!("Task join failed: {}", e));
                }
            }
        }

        let msg = format!(
            "[DCE] Phase 5: Compiled {} files in {:.1}s\n",
            compiled,
            t5.elapsed().as_secs_f64()
        );
        log_callback(msg.clone());
        full_log.push_str(&msg);

        // Save newly compiled library objects to cache
        for lib_dir in extra_libs {
            let lib_name = lib_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if lib_cache_hits.contains(&lib_name) {
                continue;
            }
            let lib_build = libs_build_dir.join(&lib_name);
            if !lib_build.exists() {
                continue;
            }
            let cache_dir = lib_cache_base.join(&lib_name);
            let _ = std::fs::create_dir_all(&cache_dir);
            copy_object_files_recursive(&lib_build, &cache_dir);
            let _ = std::fs::write(cache_dir.join(".t"), "");
        }
    }

    // ========== Phase 6: Archive core objects ==========
    let t6 = std::time::Instant::now();

    if core_cache_hit {
        // Core archive was restored from cache before Phase 5
        log_callback(format!(
            "[DCE] Phase 6: core.a from cache in {:.1}ms\n",
            t6.elapsed().as_secs_f64() * 1000.0
        ));
    } else {
        let core_objects: Vec<&SourceFile> = sources
            .iter()
            .filter(|s| s.category == SourceCategory::Core && s.object_path.exists())
            .collect();

        if !core_objects.is_empty() {
            // Check if archive needs updating
            let archive_mtime = file_mtime_ms(&archive_path);
            let newest_obj = core_objects
                .iter()
                .map(|s| file_mtime_ms(&s.object_path))
                .max()
                .unwrap_or(0);

            if newest_obj > archive_mtime || !archive_path.exists() {
                // Remove old archive
                let _ = tokio::fs::remove_file(&archive_path).await;

                let ar_pattern = props
                    .get("recipe.ar.pattern")
                    .context("Missing recipe.ar.pattern")?;

                // Batch ar: pass all .o files at once instead of invoking ar N times.
                let all_objs: Vec<String> = core_objects
                    .iter()
                    .map(|o| format!("\"{}\"", o.object_path.to_string_lossy().replace('\\', "/")))
                    .collect();

                const MAX_CMD_LEN: usize = 30_000;
                let base_cmd = ar_pattern
                    .replace(
                        "{archive_file_path}",
                        &archive_path.to_string_lossy().replace('\\', "/"),
                    )
                    .replace("{archive_file}", "core.a")
                    .replace("{object_file}", "");
                let base_len = base_cmd.len();

                let mut batch = Vec::new();
                let mut batch_len = base_len;
                for obj_str in &all_objs {
                    if batch_len + obj_str.len() + 1 > MAX_CMD_LEN && !batch.is_empty() {
                        let joined = batch.join(" ");
                        let cmd_str = ar_pattern
                            .replace(
                                "{archive_file_path}",
                                &archive_path.to_string_lossy().replace('\\', "/"),
                            )
                            .replace("{archive_file}", "core.a")
                            .replace("\"{object_file}\"", &joined)
                            .replace("{object_file}", &joined);
                        execute_compile_command(&cmd_str)
                            .await
                            .context("ar batch failed")?;
                        batch.clear();
                        batch_len = base_len;
                    }
                    batch_len += obj_str.len() + 1;
                    batch.push(obj_str.as_str());
                }
                if !batch.is_empty() {
                    let joined = batch.join(" ");
                    let cmd_str = ar_pattern
                        .replace(
                            "{archive_file_path}",
                            &archive_path.to_string_lossy().replace('\\', "/"),
                        )
                        .replace("{archive_file}", "core.a")
                        .replace("\"{object_file}\"", &joined)
                        .replace("{object_file}", &joined);
                    execute_compile_command(&cmd_str)
                        .await
                        .context("ar batch failed")?;
                }

                // Save to core cache for future builds
                let _ = std::fs::create_dir_all(&core_cache_dir);
                match std::fs::copy(&archive_path, &cached_core_a) {
                    Ok(bytes) => {
                        let msg = format!(
                            "[DCE] Phase 6: Archived {} core objects in {:.1}s (saved {}B to cache)\n",
                            core_objects.len(),
                            t6.elapsed().as_secs_f64(),
                            bytes
                        );
                        log_callback(msg.clone());
                        full_log.push_str(&msg);
                    }
                    Err(e) => {
                        let msg = format!(
                            "[DCE] Phase 6: Archived {} core objects in {:.1}s (cache save failed: {})\n",
                            core_objects.len(),
                            t6.elapsed().as_secs_f64(),
                            e
                        );
                        log_callback(msg.clone());
                        full_log.push_str(&msg);
                    }
                }
            } else {
                log_callback("[DCE] Phase 6: core.a up-to-date, skipped\n".into());
            }
        }
    } // end !core_cache_hit

    // ========== Phase 7: Link ==========
    let project_name = props
        .get("build.project_name")
        .map(|s| s.as_str())
        .unwrap_or(sketch_name);
    let elf_path = build_path.join(format!("{}.elf", project_name));

    // Skip link if nothing was compiled and ELF exists
    let need_link = !to_compile.is_empty() || !elf_path.exists();

    if need_link {
        let t7 = std::time::Instant::now();

        let link_pattern = props
            .get("recipe.c.combine.pattern")
            .context("Missing recipe.c.combine.pattern")?;

        // Collect all non-core object files
        let object_files: Vec<String> = sources
            .iter()
            .filter(|s| s.category != SourceCategory::Core && s.object_path.exists())
            .map(|s| format!("\"{}\"", s.object_path.to_string_lossy().replace('\\', "/")))
            .collect();
        let object_files_str = object_files.join(" ");

        let mut link_cmd = link_pattern.clone();
        link_cmd = link_cmd.replace("{object_files}", &object_files_str);
        link_cmd = link_cmd.replace(
            "{archive_file_path}",
            &archive_path.to_string_lossy().replace('\\', "/"),
        );
        link_cmd = link_cmd.replace("{archive_file}", archive_file);

        // Run link and Phase 8 prep in parallel (prep doesn't depend on ELF)
        if generate_artifacts {
            let (link_result, _) = tokio::join!(execute_compile_command(&link_cmd), async {
                let _ = ensure_partitions_csv(props, build_path, sketch_dir).await;
                let _ = generate_bootloader(props, build_path).await;
            });
            link_result.context("Link failed")?;
        } else {
            execute_compile_command(&link_cmd)
                .await
                .context("Link failed")?;
        }

        let msg = format!(
            "[DCE] Phase 7: Linked in {:.1}s -> {}\n",
            t7.elapsed().as_secs_f64(),
            elf_path.display()
        );
        log_callback(msg.clone());
        full_log.push_str(&msg);

        if !elf_path.exists() {
            return Err(anyhow::anyhow!(
                "ELF output not found: {}",
                elf_path.display()
            ));
        }

        // ========== Phase 8: Upload Artifacts ==========
        if generate_artifacts {
            let t8 = std::time::Instant::now();

            // Prep was already done in parallel with Phase 7 link above.

            // --- Parallel artifact generation ---
            let mut artifact_set: JoinSet<Result<()>> = JoinSet::new();

            // Partitions.bin
            if let Some(cmd_str) =
                select_platform_cmd(props, "recipe.objcopy.partitions.bin.pattern")
            {
                artifact_set.spawn(async move {
                    let _ = execute_compile_command(&cmd_str).await;
                    Ok(())
                });
            }
            // .eep (AVR)
            if let Some(cmd_str) = select_platform_cmd(props, "recipe.objcopy.eep.pattern") {
                artifact_set.spawn(async move {
                    let _ = execute_compile_command(&cmd_str).await;
                    Ok(())
                });
            }
            // .hex (AVR) or .bin (ESP32)
            if let Some(cmd_str) = select_platform_cmd(props, "recipe.objcopy.hex.pattern") {
                artifact_set.spawn(async move {
                    let _ = execute_compile_command(&cmd_str).await;
                    Ok(())
                });
            }
            if let Some(cmd_str) = select_platform_cmd(props, "recipe.objcopy.bin.pattern") {
                artifact_set.spawn(async move {
                    let _ = execute_compile_command(&cmd_str).await;
                    Ok(())
                });
            }

            // Wait for all parallel artifacts
            while let Some(res) = artifact_set.join_next().await {
                if let Ok(Err(e)) = res {
                    log_callback(format!("[DCE] Phase 8 artifact warning: {}\n", e));
                }
            }

            // --- Post-objcopy hooks (must run after objcopy, run serially) ---
            for i in 1..=5 {
                let key = format!("recipe.hooks.objcopy.postobjcopy.{}.pattern", i);
                if let Some(cmd_str) = select_platform_cmd(props, &key) {
                    let _ = execute_compile_command(&cmd_str).await;
                }
            }

            // Generate flash_args (ESP32 only, safe no-op for others)
            generate_flash_args(props, build_path, project_name).await?;

            let msg = format!(
                "[DCE] Phase 8: Artifacts generated in {:.1}s\n",
                t8.elapsed().as_secs_f64()
            );
            log_callback(msg.clone());
            full_log.push_str(&msg);
        }
    } else {
        log_callback("[DCE] Phase 7-8: Everything up-to-date, skipped link\n".into());
    } // end if need_link

    // ========== Phase 9: Size Report ==========
    let mut summary_lines = Vec::new();
    if let Some(size_cmd) = select_platform_cmd(props, "recipe.size.pattern") {
        let tokens = tokenize_recipe_command(&size_cmd);
        if !tokens.is_empty() {
            let mut cmd = Command::new(&tokens[0]);
            hide_window(&mut cmd);
            if tokens.len() > 1 {
                cmd.args(&tokens[1..]);
            }
            if let Ok(output) = cmd.output().await {
                if output.status.success() {
                    let raw = String::from_utf8_lossy(&output.stdout);
                    for line in raw.lines() {
                        summary_lines.push(line.to_string());
                    }
                }
            }
        }
    }

    let total_elapsed = start.elapsed().as_secs_f64();
    let msg = format!("[DCE] TOTAL: {:.1}s\n", total_elapsed);
    log_callback(msg.clone());
    full_log.push_str(&msg);

    Ok(DirectCompileResult {
        elf_path,
        build_path: build_path.to_path_buf(),
        elapsed_secs: total_elapsed,
        summary_lines,
        full_log,
    })
}

// ========================== Helper Functions ==========================

/// Select the correct platform command (prefer .windows on Windows).
fn select_platform_cmd(props: &HashMap<String, String>, key: &str) -> Option<String> {
    if cfg!(target_os = "windows") {
        let win_key = format!("{}.windows", key);
        if let Some(cmd) = props.get(&win_key) {
            if !cmd.trim().is_empty() {
                return Some(cmd.clone());
            }
        }
    }
    props.get(key).filter(|v| !v.trim().is_empty()).cloned()
}

/// Build ccache environment variables.
fn build_ccache_env(sysroot: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let cache_dir = sysroot.join("cache").join("ccache");
    let _ = std::fs::create_dir_all(&cache_dir);

    env.insert("CCACHE_DIR".into(), cache_dir.to_string_lossy().into());
    // CCACHE_BASEDIR changes the source path observed by `__FILE__`. Leaving
    // it unset preserves CLI-identical Core and third-party library objects.
    env.insert("CCACHE_MAXSIZE".into(), "5G".into());
    env.insert("CCACHE_DEPEND".into(), "true".into());
    env.insert("CCACHE_NOHASHDIR".into(), "true".into());
    env.insert("CCACHE_COMPILERCHECK".into(), "mtime".into());
    env.insert("CCACHE_HARDLINK".into(), "true".into());
    env.insert("CCACHE_INODECACHE".into(), "true".into());
    env.insert(
        "CCACHE_SLOPPINESS".into(),
        "pch_defines,include_file_mtime,include_file_ctime,system_headers,locale".into(),
    );

    // Build CCACHE_PATH
    let packages_dir = sysroot.join("packages");
    let mut tool_paths = Vec::new();
    if let Ok(vendors) = std::fs::read_dir(&packages_dir) {
        for vendor in vendors.flatten() {
            let tools = vendor.path().join("tools");
            if !tools.is_dir() {
                continue;
            }
            if let Ok(tool_entries) = std::fs::read_dir(&tools) {
                for tool in tool_entries.flatten() {
                    if let Ok(versions) = std::fs::read_dir(tool.path()) {
                        for ver in versions.flatten() {
                            let bin = ver.path().join("bin");
                            if bin.is_dir() {
                                tool_paths.push(bin.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    env.insert("CCACHE_PATH".into(), tool_paths.join(sep));

    env
}

/// Execute a compile command with ccache environment.
async fn execute_compile_with_env(
    cmd_str: &str,
    ccache_env: &HashMap<String, String>,
) -> Result<()> {
    let tokens = tokenize_recipe_command(cmd_str);
    if tokens.is_empty() {
        return Err(anyhow::anyhow!("Empty command"));
    }
    let mut cmd = Command::new(&tokens[0]);
    hide_window(&mut cmd);
    if tokens.len() > 1 {
        cmd.args(&tokens[1..]);
    }
    // Never inherit a launcher-provided base directory: ccache would rewrite
    // `__FILE__` paths and produce objects that differ from native Arduino CLI.
    cmd.env_remove("CCACHE_BASEDIR");
    for (k, v) in ccache_env {
        cmd.env(k, v);
    }
    let output = cmd
        .output()
        .await
        .with_context(|| format!("Failed to spawn: {}", &tokens[0]))?;
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "Compile error: {}\n{}",
            cmd_str,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Get file modification time in milliseconds. Returns 0 if file doesn't exist.
fn file_mtime_ms(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        })
        .unwrap_or(0)
}

/// Return the newest source/header mtime in a directory tree (recursive).
fn newest_source_mtime_recursive(dir: &Path) -> u128 {
    fn walk(dir: &Path, newest: &mut u128) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, newest);
            } else {
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                match ext {
                    "c" | "cpp" | "cc" | "cxx" | "S" | "s" | "h" | "hpp" | "hh" | "hxx" | "ino" => {
                        let mt = file_mtime_ms(&p);
                        if mt > *newest {
                            *newest = mt;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let mut newest = 0u128;
    walk(dir, &mut newest);
    newest
}

/// Restore cached .o files from cache_dir to target_dir (recursive).
fn restore_cached_objects(cache_dir: &Path, target_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().unwrap_or_default();
        if name == ".t" {
            continue;
        }
        if p.is_dir() {
            let sub_target = target_dir.join(name);
            let _ = std::fs::create_dir_all(&sub_target);
            restore_cached_objects(&p, &sub_target);
        } else {
            let _ = std::fs::copy(&p, target_dir.join(name));
        }
    }
}

/// Copy .o files from src_dir to dst_dir (recursive).
fn copy_object_files_recursive(src_dir: &Path, dst_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(src_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().unwrap_or_default();
        if p.is_dir() {
            let sub_dst = dst_dir.join(name);
            let _ = std::fs::create_dir_all(&sub_dst);
            copy_object_files_recursive(&p, &sub_dst);
        } else {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "o" {
                let _ = std::fs::copy(&p, dst_dir.join(name));
            }
        }
    }
}

/// Check if any dependency listed in a GCC .d file is newer than obj_mtime.
/// Returns true if recompilation is needed due to header changes.
fn any_dep_newer(dep_file: &Path, obj_mtime: u128) -> bool {
    let Ok(content) = std::fs::read_to_string(dep_file) else {
        return false;
    };
    // GCC .d format: target: dep1 dep2 dep3 \
    //   dep4 dep5
    // Remove line continuations, then parse dependencies
    let joined = content
        .replace("\\\r\n", " ")
        .replace("\\\n", " ")
        // Handle escaped spaces in paths like C:/Program\ Files/...
        .replace("\\ ", " ");
    for line in joined.lines() {
        // Skip target prefix. Prefer ": " separator to avoid breaking on drive-colon in Windows paths.
        let deps_part = if let Some(idx) = line.find(": ") {
            &line[idx + 2..]
        } else {
            line.split_once(':').map(|(_, d)| d).unwrap_or(line)
        };
        for dep in deps_part.split_whitespace() {
            let dep_path = Path::new(dep);
            if dep_path.exists() && file_mtime_ms(dep_path) > obj_mtime {
                return true;
            }
        }
    }
    false
}

/// Ensure partitions.csv exists in build dir.
async fn ensure_partitions_csv(
    props: &HashMap<String, String>,
    build_path: &Path,
    sketch_dir: &Path,
) -> Result<()> {
    let target = build_path.join("partitions.csv");
    if target.exists() {
        return Ok(());
    }

    // Try source dir first
    let src_csv = PathBuf::from(sketch_dir).join("partitions.csv");
    if src_csv.exists() {
        tokio::fs::copy(&src_csv, &target).await?;
        return Ok(());
    }

    // Try variant
    if let Some(variant_path) = props.get("build.variant.path") {
        let custom = props
            .get("build.custom_partitions")
            .map(|s| s.as_str())
            .unwrap_or("partitions");
        let variant_csv = PathBuf::from(variant_path).join(format!("{}.csv", custom));
        if variant_csv.exists() {
            tokio::fs::copy(&variant_csv, &target).await?;
            return Ok(());
        }
    }

    // Use default from platform
    if let (Some(platform_path), Some(partitions)) = (
        props.get("runtime.platform.path"),
        props.get("build.partitions"),
    ) {
        let default_csv = PathBuf::from(platform_path)
            .join("tools")
            .join("partitions")
            .join(format!("{}.csv", partitions));
        if default_csv.exists() {
            tokio::fs::copy(&default_csv, &target).await?;
            return Ok(());
        }
    }

    Ok(()) // Not critical if missing
}

/// Generate bootloader binary.
async fn generate_bootloader(props: &HashMap<String, String>, build_path: &Path) -> Result<()> {
    let project_name = props
        .get("build.project_name")
        .map(|s| s.as_str())
        .unwrap_or("sketch");
    let bootloader_bin = build_path.join(format!("{}.bootloader.bin", project_name));
    if bootloader_bin.exists() {
        return Ok(());
    }

    // Try variant bootloader
    if let Some(variant_path) = props.get("build.variant.path") {
        let custom = props
            .get("build.custom_bootloader")
            .map(|s| s.as_str())
            .unwrap_or("bootloader");
        let variant_bl = PathBuf::from(variant_path).join(format!("{}.bin", custom));
        if variant_bl.exists() {
            tokio::fs::copy(&variant_bl, &bootloader_bin).await?;
            return Ok(());
        }
    }

    // Generate from elf using esptool
    if let Some(sdk_path) = props.get("compiler.sdk.path") {
        let boot = props.get("build.boot").map(|s| s.as_str()).unwrap_or("qio");
        let boot_freq = props
            .get("build.boot_freq")
            .map(|s| s.as_str())
            .unwrap_or("80m");
        let bl_elf = PathBuf::from(sdk_path)
            .join("bin")
            .join(format!("bootloader_{}_{}.elf", boot, boot_freq));
        if bl_elf.exists() {
            if let Some(esptool_cmd_str) =
                select_platform_cmd(props, "recipe.hooks.prebuild.4.pattern")
            {
                let _ = execute_compile_command(&esptool_cmd_str).await;
                return Ok(());
            }
        }
    }

    Ok(())
}

/// Generate flash_args file.
async fn generate_flash_args(
    props: &HashMap<String, String>,
    build_path: &Path,
    project_name: &str,
) -> Result<()> {
    let flash_mode = props
        .get("build.flash_mode")
        .map(|s| s.as_str())
        .unwrap_or("dio");
    let flash_freq = props
        .get("build.img_freq")
        .map(|s| s.as_str())
        .unwrap_or("80m");
    let flash_size = props
        .get("build.flash_size")
        .map(|s| s.as_str())
        .unwrap_or("4MB");
    let bootloader_addr = props
        .get("build.bootloader_addr")
        .map(|s| s.as_str())
        .unwrap_or("0x0");

    let content = format!(
        "--flash-mode {} --flash-freq {} --flash-size {}\n\
         {} {}.bootloader.bin\n\
         0x8000 {}.partitions.bin\n\
         0xe000 boot_app0.bin\n\
         0x10000 {}.bin\n",
        flash_mode,
        flash_freq,
        flash_size,
        bootloader_addr,
        project_name,
        project_name,
        project_name,
    );
    tokio::fs::write(build_path.join("flash_args"), content).await?;
    Ok(())
}

// ========================== Cache Integration ==========================

/// Save resolved properties to a cache file for reuse.
pub async fn cache_resolved_props(props: &ResolvedProps, cache_path: &Path) -> Result<()> {
    let json = serde_json::to_string(&props.props)?;
    tokio::fs::write(cache_path, json).await?;
    Ok(())
}

/// Load cached resolved properties.
pub async fn load_cached_props(cache_path: &Path) -> Option<ResolvedProps> {
    let content = tokio::fs::read_to_string(cache_path).await.ok()?;
    let props: HashMap<String, String> = serde_json::from_str(&content).ok()?;
    Some(ResolvedProps { props })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_property_overrides_for_suffix, build_ccache_env, discover_sources,
        expand_all_properties, generate_flash_args, preflight_runtime_tools, resolve_properties,
    };
    use std::collections::HashMap;

    #[test]
    fn direct_engine_ccache_environment_does_not_ignore_time_macros() {
        let temp = tempfile::tempdir().expect("tempdir");
        let env = build_ccache_env(temp.path());
        let sloppiness = env
            .get("CCACHE_SLOPPINESS")
            .expect("ccache sloppiness must be configured");

        assert!(
            !sloppiness.split(',').any(|value| value == "time_macros"),
            "__DATE__/__TIME__ must remain part of ccache identity"
        );
        assert!(
            sloppiness.split(',').any(|value| value == "system_headers"),
            "the direct engine must retain its existing system-header policy"
        );
        assert!(
            !env.contains_key("CCACHE_BASEDIR"),
            "the direct engine must preserve native paths used by __FILE__"
        );
    }

    #[test]
    fn nested_library_sources_keep_distinct_stable_object_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let library = temp.path().join("Demo");
        let src = library.join("src");
        let source_a = src.join("a").join("foo.c");
        let source_b = src.join("b").join("foo.c");
        let source_root = src.join("root.cpp");
        for source in [&source_a, &source_b, &source_root] {
            std::fs::create_dir_all(source.parent().expect("source parent"))
                .expect("source directory");
            std::fs::write(source, "// fixture\n").expect("source fixture");
        }

        let build = temp.path().join("build");
        let discover = || {
            discover_sources(
                &temp.path().join("missing-core"),
                &temp.path().join("missing-variant"),
                std::slice::from_ref(&library),
                &temp.path().join("missing-sketch.ino.cpp"),
                &build,
            )
        };
        let first = discover();
        let second = discover();
        let direct_src = discover_sources(
            &temp.path().join("missing-core"),
            &temp.path().join("missing-variant"),
            std::slice::from_ref(&src),
            &temp.path().join("missing-sketch.ino.cpp"),
            &build,
        );

        let object_for = |sources: &[super::SourceFile], source: &std::path::Path| {
            sources
                .iter()
                .find(|item| item.path == source)
                .map(|item| item.object_path.clone())
                .expect("discovered source")
        };
        let object_a = object_for(&first, &source_a);
        let object_b = object_for(&first, &source_b);

        assert_eq!(
            object_a,
            build.join("libraries").join("Demo").join("a").join("foo.o")
        );
        assert_eq!(
            object_b,
            build.join("libraries").join("Demo").join("b").join("foo.o")
        );
        assert_ne!(
            object_a, object_b,
            "nested sources must not overwrite each other"
        );
        assert_eq!(
            object_for(&first, &source_root),
            build.join("libraries").join("Demo").join("root.o")
        );
        assert_eq!(
            object_for(&direct_src, &source_a),
            build.join("libraries").join("Demo").join("a").join("foo.o"),
            "a direct src/ path must remain recursive and use its parent library name"
        );
        assert_eq!(
            first
                .iter()
                .map(|source| (&source.path, &source.object_path))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|source| (&source.path, &source.object_path))
                .collect::<Vec<_>>(),
            "source discovery and object mapping must be stable"
        );
    }

    #[test]
    fn legacy_utility_sources_keep_utility_in_object_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let library = temp.path().join("Legacy");
        let root_source = library.join("legacy.c");
        let utility_source = library.join("utility").join("helper.cpp");
        let ignored_source = library.join("internal").join("ignored.c");
        for source in [&root_source, &utility_source, &ignored_source] {
            std::fs::create_dir_all(source.parent().expect("source parent"))
                .expect("source directory");
            std::fs::write(source, "// fixture\n").expect("source fixture");
        }

        let build = temp.path().join("build");
        let sources = discover_sources(
            &temp.path().join("missing-core"),
            &temp.path().join("missing-variant"),
            std::slice::from_ref(&library),
            &temp.path().join("missing-sketch.ino.cpp"),
            &build,
        );
        let object_for = |source: &std::path::Path| {
            sources
                .iter()
                .find(|item| item.path == source)
                .map(|item| item.object_path.clone())
        };

        assert_eq!(
            object_for(&root_source),
            Some(build.join("libraries").join("Legacy").join("legacy.o"))
        );
        assert_eq!(
            object_for(&utility_source),
            Some(
                build
                    .join("libraries")
                    .join("Legacy")
                    .join("utility")
                    .join("helper.o")
            )
        );
        assert_eq!(object_for(&ignored_source), None);
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn windows_tool_property_overrides_base_before_recipe_expansion() {
        let mut props = HashMap::from([
            (
                "runtime.platform.path".to_string(),
                "C:/CK/packages/esp32/hardware/esp32/3.3.6".to_string(),
            ),
            (
                "tools.gen_esp32part.cmd".to_string(),
                "python3 \"{runtime.platform.path}/tools/gen_esp32part.py\"".to_string(),
            ),
            (
                "tools.gen_esp32part.cmd.windows".to_string(),
                r#""{runtime.platform.path}\tools\gen_esp32part.exe""#.to_string(),
            ),
            (
                "recipe.objcopy.partitions.bin.pattern".to_string(),
                "{tools.gen_esp32part.cmd} -q \"{build.path}/partitions.csv\" \"{build.path}/{build.project_name}.partitions.bin\""
                    .to_string(),
            ),
            ("build.path".to_string(), "C:/CK/build".to_string()),
            ("build.project_name".to_string(), "wifi_test.ino".to_string()),
        ]);

        apply_property_overrides_for_suffix(&mut props, "windows");
        expand_all_properties(&mut props);

        let expected_command =
            r#""C:/CK/packages/esp32/hardware/esp32/3.3.6\tools\gen_esp32part.exe""#;
        assert_eq!(
            props.get("tools.gen_esp32part.cmd").map(String::as_str),
            Some(expected_command)
        );
        assert_eq!(
            props
                .get("tools.gen_esp32part.cmd.windows")
                .map(String::as_str),
            Some(expected_command)
        );
        assert_eq!(
            props
                .get("recipe.objcopy.partitions.bin.pattern")
                .map(String::as_str),
            Some(
                r#""C:/CK/packages/esp32/hardware/esp32/3.3.6\tools\gen_esp32part.exe" -q "C:/CK/build/partitions.csv" "C:/CK/build/wifi_test.ino.partitions.bin""#
            )
        );
        assert!(
            !props
                .get("recipe.objcopy.partitions.bin.pattern")
                .is_some_and(|recipe| recipe.contains("python3"))
        );
    }

    #[tokio::test]
    async fn direct_resolver_uses_the_arduino_cli_runtime_ide_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/acme/hardware/demo/1.0.0");
        let project = temp.path().join("project");
        let build = temp.path().join("build");
        for path in [&platform, &project, &build] {
            std::fs::create_dir_all(path).expect("fixture directory");
        }
        std::fs::write(platform.join("platform.txt"), "name=Demo platform\n")
            .expect("platform.txt");
        std::fs::write(
            platform.join("boards.txt"),
            "board.name=Demo board\nboard.build.core=core\n",
        )
        .expect("boards.txt");

        let resolved = resolve_properties(
            &sysroot,
            "acme:demo:board",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve direct properties");
        assert_eq!(
            resolved
                .props
                .get("runtime.ide.version")
                .map(String::as_str),
            Some("10607")
        );
    }

    #[tokio::test]
    async fn direct_resolver_honors_board_chip_variant_for_the_sdk_tree() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/acme/hardware/demo/1.0.0");
        let project = temp.path().join("project");
        let build = temp.path().join("build");
        let es_sdk = sysroot.join("packages/acme/tools/chip_es-libs/1.0.0");
        let postv3_sdk = sysroot.join("packages/acme/tools/chip-libs/1.0.0");
        for path in [&platform, &project, &build, &es_sdk, &postv3_sdk] {
            std::fs::create_dir_all(path).expect("fixture directory");
        }
        std::fs::write(
            platform.join("platform.txt"),
            "build.chip_variant={build.mcu}\n\
             tools.esp32-arduino-libs.path={runtime.tools.{build.chip_variant}-libs.path}\n\
             compiler.sdk.path={tools.esp32-arduino-libs.path}\n",
        )
        .expect("platform.txt");
        // Mirrors esp32p4: the board pins the engineering-sample SDK as its
        // default and the ChipVariant menu (first option = default) agrees;
        // only an explicit postv3 selection may switch trees.
        std::fs::write(
            platform.join("boards.txt"),
            "board.name=Variant board\n\
             board.build.mcu=chip\n\
             board.build.chip_variant=chip_es\n\
             board.menu.ChipVariant.prev3=Before v3.00\n\
             board.menu.ChipVariant.prev3.build.chip_variant=chip_es\n\
             board.menu.ChipVariant.postv3=v3.00 or newer\n\
             board.menu.ChipVariant.postv3.build.chip_variant=chip\n\
             plain.name=Mcu-default board\n\
             plain.build.mcu=chip\n",
        )
        .expect("boards.txt");

        let es_path = es_sdk.to_string_lossy().replace('\\', "/");
        let postv3_path = postv3_sdk.to_string_lossy().replace('\\', "/");

        for (fqbn, expected) in [
            ("acme:demo:board", es_path.as_str()),
            ("acme:demo:board:ChipVariant=postv3", postv3_path.as_str()),
            // Without a board/menu override the platform default
            // build.chip_variant={build.mcu} must keep resolving via the MCU.
            ("acme:demo:plain", postv3_path.as_str()),
        ] {
            let resolved = resolve_properties(&sysroot, fqbn, &build, &project, "project.ino", &[])
                .await
                .expect("resolve direct properties");
            assert_eq!(
                resolved.props.get("compiler.sdk.path").map(String::as_str),
                Some(expected),
                "compiler.sdk.path for {fqbn}"
            );
            assert_eq!(
                resolved
                    .props
                    .get("tools.esp32-arduino-libs.path")
                    .map(String::as_str),
                Some(expected),
                "tools.esp32-arduino-libs.path for {fqbn}"
            );
        }
    }

    #[tokio::test]
    async fn runtime_tool_preflight_blocks_missing_hidden_sdk_but_not_a_complete_hidden_board() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/acme/hardware/demo/1.0.0");
        let project = temp.path().join("project");
        let build = temp.path().join("build");
        for path in [&platform, &project, &build] {
            std::fs::create_dir_all(path).expect("fixture directory");
        }
        std::fs::write(
            platform.join("platform.txt"),
            "compiler.sdk.path={runtime.tools.{build.mcu}-libs.path}\n\
             recipe.hooks.prebuild.1.pattern=tool --input \"{compiler.sdk.path}/bin/bootloader_{build.boot}_{build.boot_freq}.elf\"\n",
        )
        .expect("platform.txt");
        std::fs::write(
            platform.join("boards.txt"),
            "hidden.name=Hidden but potentially usable board\n\
             hidden.hide=true\n\
             hidden.build.mcu=chip\n\
             hidden.build.boot=qio\n\
             hidden.build.boot_freq=60m\n",
        )
        .expect("boards.txt");

        let missing = preflight_runtime_tools(
            &sysroot,
            "acme:demo:hidden",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve missing runtime evidence");
        assert!(missing.board_hidden);
        assert!(missing.is_blocked());
        assert_eq!(
            missing.unresolved_runtime_tool_paths,
            vec!["runtime.tools.chip-libs.path"]
        );
        assert!(missing.missing_critical_paths.is_empty());
        let message = missing.blocking_message("acme:demo:hidden");
        assert!(message.contains("blocked acme:demo:hidden before Arduino CLI"));
        assert!(message.contains("marks this board definition as hidden"));

        let sdk = sysroot.join("packages/acme/tools/chip-libs/1.0.0");
        let bootloader = sdk.join("bin/bootloader_qio_60m.elf");
        std::fs::create_dir_all(bootloader.parent().expect("bootloader parent"))
            .expect("SDK bin directory");
        std::fs::write(&bootloader, b"fixture").expect("bootloader fixture");

        let complete = preflight_runtime_tools(
            &sysroot,
            "acme:demo:hidden",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve complete runtime evidence");
        assert!(
            complete.board_hidden,
            "hide=true remains explanatory evidence"
        );
        assert!(complete.unresolved_runtime_tool_paths.is_empty());
        assert!(complete.missing_critical_paths.is_empty());
        assert!(
            !complete.is_blocked(),
            "a hidden board with complete runtime files must remain usable"
        );

        std::fs::remove_file(&bootloader).expect("remove bootloader fixture");
        let missing_bootloader = preflight_runtime_tools(
            &sysroot,
            "acme:demo:hidden",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve missing bootloader evidence");
        assert!(missing_bootloader.is_blocked());
        assert!(missing_bootloader.unresolved_runtime_tool_paths.is_empty());
        assert_eq!(missing_bootloader.missing_critical_paths, vec![bootloader]);
    }

    #[tokio::test]
    async fn runtime_tool_preflight_resolves_only_the_exact_versioned_tool_alias() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/acme/hardware/demo/1.0.0");
        let project = temp.path().join("project");
        let build = temp.path().join("build");
        let requested_tool = sysroot.join("packages/acme/tools/compiler/1.2.3");
        for path in [
            &platform,
            &project,
            &build,
            &requested_tool,
            &requested_tool.join("bin"),
        ] {
            std::fs::create_dir_all(path).expect("fixture directory");
        }
        std::fs::write(
            platform.join("platform.txt"),
            "compiler.path={runtime.tools.compiler-1.2.3.path}/bin/\n\
             recipe.cpp.o.pattern=\"{compiler.path}compiler\" -c \"{source_file}\" -o \"{object_file}\"\n",
        )
        .expect("platform.txt");
        std::fs::write(
            platform.join("boards.txt"),
            "board.name=Versioned tool board\nboard.build.core=core\n",
        )
        .expect("boards.txt");
        std::fs::write(
            platform.join("installed.json"),
            serde_json::to_vec(&serde_json::json!({
                "packages": [{
                    "platforms": [{
                        "toolsDependencies": [{
                            "name": "compiler",
                            "version": "1.2.3"
                        }]
                    }]
                }]
            }))
            .expect("installed.json payload"),
        )
        .expect("installed.json");

        let complete = preflight_runtime_tools(
            &sysroot,
            "acme:demo:board",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve exact versioned tool alias");
        assert!(!complete.is_blocked());

        std::fs::remove_dir_all(&requested_tool).expect("remove requested tool version");
        std::fs::create_dir_all(sysroot.join("packages/acme/tools/compiler/9.9.9"))
            .expect("different installed version");
        let wrong_version = preflight_runtime_tools(
            &sysroot,
            "acme:demo:board",
            &build,
            &project,
            "project.ino",
            &[],
        )
        .await
        .expect("resolve missing exact tool version");
        assert!(wrong_version.is_blocked());
        assert_eq!(
            wrong_version.unresolved_runtime_tool_paths,
            vec!["runtime.tools.compiler-1.2.3.path"]
        );
    }

    #[tokio::test]
    async fn esp32s3_flash8_and_flash16_options_resolve_distinct_upload_properties() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/esp32/hardware/esp32/3.3.6");
        let core = platform.join("cores/esp32");
        let variant = platform.join("variants/esp32s3");
        for path in [&platform, &core, &variant] {
            std::fs::create_dir_all(path).expect("platform fixture dir");
        }
        std::fs::write(platform.join("platform.txt"), "name=ESP32 test platform\n")
            .expect("platform.txt");
        std::fs::write(
            platform.join("boards.txt"),
            "esp32s3.name=ESP32-S3\n\
             esp32s3.build.core=esp32\n\
             esp32s3.build.variant=esp32s3\n\
             esp32s3.build.flash_size=4MB\n\
             esp32s3.build.partitions=default\n\
             esp32s3.build.psram_type=qspi\n\
             esp32s3.build.usb_mode=0\n\
             esp32s3.menu.FlashSize.8M=8MB Flash\n\
             esp32s3.menu.FlashSize.8M.build.flash_size=8MB\n\
             esp32s3.menu.FlashSize.16M=16MB Flash\n\
             esp32s3.menu.FlashSize.16M.build.flash_size=16MB\n\
             esp32s3.menu.PartitionScheme.default_8MB=Default 8MB\n\
             esp32s3.menu.PartitionScheme.default_8MB.build.partitions=default_8MB\n\
             esp32s3.menu.PartitionScheme.fatflash=FAT Flash\n\
             esp32s3.menu.PartitionScheme.fatflash.build.partitions=ffat\n\
             esp32s3.menu.PSRAM.disabled=Disabled\n\
             esp32s3.menu.PSRAM.disabled.build.psram_type=qspi\n\
             esp32s3.menu.PSRAM.opi=OPI PSRAM\n\
             esp32s3.menu.PSRAM.opi.build.psram_type=opi\n\
             esp32s3.menu.USBMode.default=Default USB\n\
             esp32s3.menu.USBMode.default.build.usb_mode=0\n\
             esp32s3.menu.USBMode.hwcdc=Hardware CDC\n\
             esp32s3.menu.USBMode.hwcdc.build.usb_mode=1\n",
        )
        .expect("boards.txt");

        let flash8_fqbn =
            "esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,USBMode=hwcdc";
        let flash16_fqbn =
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi,USBMode=hwcdc";
        let flash8_project = temp.path().join("flash8-project");
        let flash16_project = temp.path().join("flash16-project");
        let flash8_build = temp.path().join("flash8-build");
        let flash16_build = temp.path().join("flash16-build");
        for path in [
            &flash8_project,
            &flash16_project,
            &flash8_build,
            &flash16_build,
        ] {
            std::fs::create_dir_all(path).expect("test path");
        }

        let flash8 = resolve_properties(
            &sysroot,
            flash8_fqbn,
            &flash8_build,
            &flash8_project,
            "flash8.ino",
            &[],
        )
        .await
        .expect("resolve 8MB Flash properties");
        let flash16 = resolve_properties(
            &sysroot,
            flash16_fqbn,
            &flash16_build,
            &flash16_project,
            "flash16.ino",
            &[],
        )
        .await
        .expect("resolve 16MB Flash properties");

        for (props, flash, partitions, psram) in [
            (&flash8.props, "8MB", "default_8MB", "opi"),
            (&flash16.props, "16MB", "ffat", "opi"),
        ] {
            assert_eq!(
                props.get("build.flash_size").map(String::as_str),
                Some(flash)
            );
            assert_eq!(
                props.get("build.partitions").map(String::as_str),
                Some(partitions)
            );
            assert_eq!(
                props.get("build.psram_type").map(String::as_str),
                Some(psram)
            );
            assert_eq!(props.get("build.usb_mode").map(String::as_str), Some("1"));
            assert_eq!(
                props.get("build.core.path").map(String::as_str),
                Some(core.to_string_lossy().replace('\\', "/").as_str())
            );
            assert_eq!(
                props.get("build.variant.path").map(String::as_str),
                Some(variant.to_string_lossy().replace('\\', "/").as_str())
            );
        }
        assert_ne!(
            flash8.props.get("build.flash_size"),
            flash16.props.get("build.flash_size")
        );
        assert_ne!(
            flash8.props.get("build.partitions"),
            flash16.props.get("build.partitions")
        );

        generate_flash_args(&flash8.props, &flash8_build, "flash8.ino")
            .await
            .expect("8MB Flash flash_args");
        generate_flash_args(&flash16.props, &flash16_build, "flash16.ino")
            .await
            .expect("16MB Flash flash_args");
        let flash8_args =
            std::fs::read_to_string(flash8_build.join("flash_args")).expect("8MB args");
        let flash16_args =
            std::fs::read_to_string(flash16_build.join("flash_args")).expect("16MB args");
        assert!(flash8_args.contains("--flash-size 8MB"));
        assert!(flash8_args.contains("flash8.ino.partitions.bin"));
        assert!(!flash8_args.contains("--flash-size 4MB"));
        assert!(flash16_args.contains("--flash-size 16MB"));
        assert!(flash16_args.contains("flash16.ino.partitions.bin"));
        assert!(!flash16_args.contains("--flash-size 4MB"));
        assert_ne!(flash8_args, flash16_args);
    }

    #[tokio::test]
    async fn boards_local_overrides_every_esp32_memory_and_usb_menu_property() {
        let temp = tempfile::tempdir().expect("tempdir");
        let sysroot = temp.path().join("sysroot");
        let platform = sysroot.join("packages/esp32/hardware/esp32/3.3.6");
        let project = temp.path().join("local-override-project");
        let build = temp.path().join("local-override-build");
        for path in [&platform, &project, &build] {
            std::fs::create_dir_all(path).expect("test path");
        }
        std::fs::write(platform.join("platform.txt"), "name=ESP32 test platform\n")
            .expect("platform.txt");
        std::fs::write(
            platform.join("boards.txt"),
            "esp32s3.name=ESP32-S3\n\
             esp32s3.menu.FlashSize.16M=16MB Flash\n\
             esp32s3.menu.FlashSize.16M.build.flash_size=8MB\n\
             esp32s3.menu.PartitionScheme.fatflash=FAT Flash\n\
             esp32s3.menu.PartitionScheme.fatflash.build.partitions=default\n\
             esp32s3.menu.PSRAM.opi=OPI PSRAM\n\
             esp32s3.menu.PSRAM.opi.build.psram_type=qspi\n\
             esp32s3.menu.USBMode.hwcdc=Hardware CDC\n\
             esp32s3.menu.USBMode.hwcdc.build.usb_mode=0\n\
             esp32s3.menu.Module.N16R8=ESP32-S3 N16R8\n\
             esp32s3.menu.Module.N16R8.build.module=N8R8\n",
        )
        .expect("boards.txt");
        std::fs::write(
            platform.join("boards.local.txt"),
            "esp32s3.menu.FlashSize.16M.build.flash_size=16MB\n\
             esp32s3.menu.PartitionScheme.fatflash.build.partitions=ffat\n\
             esp32s3.menu.PSRAM.opi.build.psram_type=opi\n\
             esp32s3.menu.USBMode.hwcdc.build.usb_mode=1\n\
             esp32s3.menu.Module.N16R8.build.module=N16R8\n",
        )
        .expect("boards.local.txt");

        let fqbn = "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi,USBMode=hwcdc,Module=N16R8";
        let resolved =
            resolve_properties(&sysroot, fqbn, &build, &project, "local_override.ino", &[])
                .await
                .expect("resolve boards.local.txt overrides");

        for (key, expected) in [
            ("build.flash_size", "16MB"),
            ("build.partitions", "ffat"),
            ("build.psram_type", "opi"),
            ("build.usb_mode", "1"),
            ("build.module", "N16R8"),
        ] {
            assert_eq!(
                resolved.props.get(key).map(String::as_str),
                Some(expected),
                "boards.local.txt must override {key}",
            );
        }
    }
}
