use crate::downloader;
use crate::manifest::{Manifest, ToolInfo};
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::SystemTime;
use tokio::sync::Mutex;

/// Default ESP32 package indexes. Keep both entries available: the official
/// index remains the fallback for normal releases, while the CN index exposes
/// explicitly suffixed `-cn` core packages such as `3.3.6-cn`.
pub const ESP32_OFFICIAL_PACKAGE_INDEX_URL: &str =
    "https://espressif.github.io/arduino-esp32/package_esp32_index.json";
pub const ESP32_CN_PACKAGE_INDEX_URL: &str = "https://jihulab.com/esp-mirror/espressif/arduino-esp32/-/raw/gh-pages/package_esp32_index_cn.json";

/// Add a package index to the `board_manager.additional_urls` YAML list while
/// preserving all existing URLs. This is intentionally a small text upgrade:
/// sysroot initialization must not parse/rewrite user configuration or remove
/// a vendor/private index merely because CK gained a new default mirror.
fn ensure_board_manager_additional_url(content: &str, url: &str) -> String {
    fn line_contains_url(line: &str, url: &str) -> bool {
        let trimmed = line.trim();
        if trimmed == url {
            return true;
        }
        trimmed
            .strip_prefix('-')
            .map(|value| value.split('#').next().unwrap_or(value).trim() == url)
            .unwrap_or(false)
    }

    if content.lines().any(|line| line_contains_url(line, url)) {
        return content.to_owned();
    }

    let crlf = content.contains("\r\n");
    let normalized = content.replace("\r\n", "\n");
    let had_trailing_newline = normalized.ends_with('\n');
    let mut lines: Vec<String> = normalized.lines().map(ToOwned::to_owned).collect();

    let board_manager_index = lines
        .iter()
        .position(|line| line.trim() == "board_manager:");

    if let Some(board_index) = board_manager_index {
        let mut additional_index = None;
        let mut cursor = board_index + 1;
        while cursor < lines.len() {
            let line = &lines[cursor];
            let trimmed = line.trim();
            // A non-indented key starts the next top-level YAML section.
            if !trimmed.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
                break;
            }
            if trimmed == "additional_urls:" || trimmed == "additional_urls: []" {
                additional_index = Some(cursor);
                break;
            }
            cursor += 1;
        }

        if let Some(index) = additional_index {
            // For an inline empty list, expand it before appending the URL.
            if lines[index].trim() == "additional_urls: []" {
                lines[index] = "  additional_urls:".to_owned();
            }
            let mut insert_at = index + 1;
            while insert_at < lines.len() {
                let line = &lines[insert_at];
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    insert_at += 1;
                    continue;
                }
                if (line.starts_with(' ') || line.starts_with('\t')) && trimmed.starts_with('-') {
                    insert_at += 1;
                    continue;
                }
                break;
            }
            lines.insert(insert_at, format!("    - {url}"));
        } else {
            lines.insert(board_index + 1, "  additional_urls:".to_owned());
            lines.insert(board_index + 2, format!("    - {url}"));
        }
    } else {
        let mut prefix = vec![
            "board_manager:".to_owned(),
            "  additional_urls:".to_owned(),
            format!("    - {url}"),
            String::new(),
        ];
        prefix.extend(lines);
        lines = prefix;
    }

    let mut updated = lines.join("\n");
    if had_trailing_newline {
        updated.push('\n');
    }
    if crlf {
        updated = updated.replace('\n', "\r\n");
    }
    updated
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CcacheShimReport {
    pub enabled: bool,
    pub compiler_count: usize,
    pub shim_count: usize,
    pub direct_tool_count: usize,
    pub direct_forwarder_count: usize,
    pub hardlinked: usize,
    pub copied: usize,
}

fn ccache_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ccache.exe"
    } else {
        "ccache"
    }
}

fn is_real_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn directory_is_empty(path: &Path) -> io::Result<bool> {
    if !path.exists() {
        return Ok(true);
    }
    if !is_real_directory(path) {
        return Ok(false);
    }
    Ok(std::fs::read_dir(path)?.next().is_none())
}

#[cfg(target_os = "windows")]
fn paths_share_volume(left: &Path, right: &Path) -> bool {
    use std::path::Component;

    fn volume(path: &Path) -> Option<OsString> {
        path.components().find_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
            _ => None,
        })
    }

    match (volume(left), volume(right)) {
        (Some(left), Some(right)) => left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()),
        _ => false,
    }
}

#[cfg(unix)]
fn paths_share_volume(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let left_device = std::fs::metadata(left).map(|metadata| metadata.dev());
    let right_device = std::fs::metadata(right).map(|metadata| metadata.dev());
    matches!((left_device, right_device), (Ok(left), Ok(right)) if left == right)
}

#[cfg(not(any(target_os = "windows", unix)))]
fn paths_share_volume(_left: &Path, _right: &Path) -> bool {
    false
}

fn prepare_prebuilt_cores_layout(root_dir: &Path) -> io::Result<()> {
    let canonical = root_dir.join("prebuilt_cores");
    if canonical.exists() && !is_real_directory(&canonical) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "canonical prebuilt-core root is not a real directory: {}",
                canonical.display()
            ),
        ));
    }
    let legacy = root_dir
        .parent()
        .map(|parent| parent.join("prebuilt_cores"));
    let legacy = legacy.filter(|path| path != &canonical && is_real_directory(path));

    // Older CK builds placed this large cache beside the sysroot. Move it only
    // when the canonical destination has no content and an atomic, same-volume
    // rename is possible. A failed rename never falls back to a 500+ MiB copy.
    if directory_is_empty(&canonical)?
        && let Some(legacy) = legacy.as_ref()
        && paths_share_volume(legacy, root_dir)
    {
        if canonical.exists() {
            std::fs::remove_dir(&canonical)?;
        }
        match std::fs::rename(legacy, &canonical) {
            Ok(()) => {
                log::info!(
                    "Migrated legacy prebuilt core cache from {:?} to {:?}",
                    legacy,
                    canonical
                );
                return Ok(());
            }
            Err(error) => {
                log::warn!(
                    "Could not atomically migrate legacy prebuilt core cache {:?}: {}. CK will read it in compatibility mode and write new snapshots to {:?}",
                    legacy,
                    error,
                    canonical
                );
            }
        }
    }

    std::fs::create_dir_all(&canonical)
}

fn compiler_role_matches(stem: &str, role: &str) -> bool {
    if stem == role || stem.ends_with(&format!("-{role}")) {
        return true;
    }
    let version_marker = format!("-{role}-");
    stem.rfind(&version_marker).is_some_and(|index| {
        stem[index + version_marker.len()..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    })
}

fn is_ccache_compiler_filename(name: &OsStr) -> bool {
    let path = Path::new(name);
    if cfg!(target_os = "windows")
        && !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return false;
    }
    let Some(stem) = path.file_stem().and_then(OsStr::to_str) else {
        return false;
    };
    let stem = stem.to_ascii_lowercase();

    // These names contain "gcc" but are archive/inspection tools, never C/C++
    // compiler drivers. Routing them through ccache breaks linking and sizing.
    if ["ar", "nm", "ranlib", "objcopy", "objdump", "size"]
        .iter()
        .any(|tool| stem == *tool || stem.ends_with(&format!("-{tool}")))
    {
        return false;
    }

    ["gcc", "g++", "cc", "c++", "clang", "clang++"]
        .iter()
        .any(|role| compiler_role_matches(&stem, role))
}

fn is_direct_tool_filename(name: &OsStr) -> bool {
    let path = Path::new(name);
    if cfg!(target_os = "windows")
        && !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return false;
    }
    let Some(stem) = path.file_stem().and_then(OsStr::to_str) else {
        return false;
    };
    let stem = stem.to_ascii_lowercase();

    // Only mirror the architecture-prefixed binutils Arduino platform recipes
    // actually reference through compiler.path. Flattening every executable in
    // nested bin directories is unsafe: several installed toolchains contain
    // conflicting unprefixed ar/ld/objcopy binaries and unrelated gprof tools.
    ["objcopy", "objdump"]
        .iter()
        .any(|role| stem != *role && compiler_role_matches(&stem, role))
}

#[derive(Debug, Clone)]
enum CcacheDirectoryEntry {
    Compiler {
        name: OsString,
        source: PathBuf,
    },
    Direct {
        name: OsString,
        source: PathBuf,
        // Keep every same-named source that was proven byte-identical during
        // the full scan. A later replacement of just one source must force a
        // new scan so an ambiguous flat forwarder is never silently reused.
        equivalent_sources: Vec<PathBuf>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CcacheDirectoryStamp {
    modified: SystemTime,
    created: Option<SystemTime>,
}

#[derive(Debug, Clone)]
struct CcacheShimTopology {
    // This deliberately contains only the inexpensive package topology and
    // discovered bin directories, never every file below packages/*/tools.
    // A changed directory entry changes its directory timestamp; known source
    // and target bytes are separately verified below.
    watched_directories: BTreeMap<PathBuf, CcacheDirectoryStamp>,
}

#[derive(Debug, Clone)]
struct CcacheShimCache {
    entries: BTreeMap<String, CcacheDirectoryEntry>,
    topology: CcacheShimTopology,
}

static CCACHE_SHIM_CACHE: OnceLock<StdMutex<BTreeMap<PathBuf, CcacheShimCache>>> = OnceLock::new();

#[cfg(test)]
static CCACHE_SHIM_FULL_SCAN_COUNTS: OnceLock<StdMutex<BTreeMap<PathBuf, usize>>> = OnceLock::new();

fn ccache_shim_cache() -> &'static StdMutex<BTreeMap<PathBuf, CcacheShimCache>> {
    CCACHE_SHIM_CACHE.get_or_init(|| StdMutex::new(BTreeMap::new()))
}

fn ccache_shim_cache_key(root_dir: &Path) -> PathBuf {
    std::fs::canonicalize(root_dir).unwrap_or_else(|_| root_dir.to_path_buf())
}

#[cfg(test)]
fn record_ccache_shim_full_scan(root_dir: &Path) {
    let key = ccache_shim_cache_key(root_dir);
    let mut counts = CCACHE_SHIM_FULL_SCAN_COUNTS
        .get_or_init(|| StdMutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *counts.entry(key).or_default() += 1;
}

#[cfg(test)]
fn ccache_shim_full_scan_count(root_dir: &Path) -> usize {
    let key = ccache_shim_cache_key(root_dir);
    CCACHE_SHIM_FULL_SCAN_COUNTS
        .get_or_init(|| StdMutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .copied()
        .unwrap_or_default()
}

/// Drop the process-local ccache shim inventory after CK itself installs or
/// removes a Core/toolchain. External package changes are also detected by the
/// topology probe, but controlled mutations should invalidate immediately.
pub(crate) fn invalidate_ccache_shim_cache(root_dir: &Path) {
    let key = ccache_shim_cache_key(root_dir);
    let mut cache = ccache_shim_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.remove(&key);
}

fn ccache_directory_stamp(path: &Path) -> Option<CcacheDirectoryStamp> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    Some(CcacheDirectoryStamp {
        // A filesystem that cannot provide modification timestamps cannot
        // safely support this cache. The caller will retain the full scan.
        modified: metadata.modified().ok()?,
        created: metadata.created().ok(),
    })
}

impl CcacheShimTopology {
    fn matches(&self) -> bool {
        self.watched_directories
            .iter()
            .all(|(path, expected)| ccache_directory_stamp(path).as_ref() == Some(expected))
    }
}

fn watch_ccache_directory(
    watched: &mut BTreeMap<PathBuf, CcacheDirectoryStamp>,
    path: &Path,
) -> Option<()> {
    watched.insert(path.to_path_buf(), ccache_directory_stamp(path)?);
    Some(())
}

/// Capture the stable, shallow Arduino package hierarchy plus every discovered
/// bin directory. This catches controlled Core/tool installation/removal and
/// additions/removals of tools in an existing bin without repeating the costly
/// recursive file walk on every compile.
fn capture_ccache_shim_topology(
    root_dir: &Path,
    bin_directories: &BTreeSet<PathBuf>,
) -> Option<CcacheShimTopology> {
    let packages = root_dir.join("packages");
    let mut watched = BTreeMap::new();
    watch_ccache_directory(&mut watched, &packages)?;

    let vendors = std::fs::read_dir(&packages).ok()?;
    for vendor in vendors {
        let vendor = vendor.ok()?;
        let vendor_path = vendor.path();
        if !is_real_directory(&vendor_path) {
            continue;
        }
        watch_ccache_directory(&mut watched, &vendor_path)?;

        let tools = vendor_path.join("tools");
        if !tools.exists() {
            continue;
        }
        if !is_real_directory(&tools) {
            // A symlink or non-directory tools path is intentionally excluded
            // by the scanner. Do not cache an environment whose topology we
            // cannot prove from the same rules.
            return None;
        }
        watch_ccache_directory(&mut watched, &tools)?;

        let tool_entries = std::fs::read_dir(&tools).ok()?;
        for tool in tool_entries {
            let tool = tool.ok()?;
            let tool_path = tool.path();
            if !is_real_directory(&tool_path) {
                continue;
            }
            watch_ccache_directory(&mut watched, &tool_path)?;

            let versions = std::fs::read_dir(&tool_path).ok()?;
            for version in versions {
                let version = version.ok()?;
                let version_path = version.path();
                if is_real_directory(&version_path) {
                    watch_ccache_directory(&mut watched, &version_path)?;
                }
            }
        }
    }

    for bin in bin_directories {
        watch_ccache_directory(&mut watched, bin)?;
    }
    Some(CcacheShimTopology {
        watched_directories: watched,
    })
}

fn is_toolchain_executable(name: &OsStr, metadata: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = metadata;
        return Path::new(name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }

    #[cfg(not(any(target_os = "windows", unix)))]
    {
        // Toolchain drivers on other supported hosts conventionally have no
        // extension. Avoid mirroring DLLs/data files into the executable path.
        Path::new(name).extension().is_none()
    }
}

/// Collect the complete flat tool directory needed after `compiler.path` is
/// redirected to CK's ccache directory. Compiler drivers masquerade as ccache;
/// only objcopy and debug objdump receive direct real-tool forwarders. Archive,
/// link and size recipes are rewritten to the exact `compiler.path.nocache`
/// instead: wrappers such as avr-gcc-ar can depend on their original directory.
/// AVR's objcopy recipe is the important fallback consumer here because objcopy
/// must never be invoked through ccache.
fn collect_ccache_directory_entries(
    root_dir: &Path,
) -> (BTreeMap<String, CcacheDirectoryEntry>, BTreeSet<PathBuf>) {
    #[cfg(test)]
    record_ccache_shim_full_scan(root_dir);

    let packages = root_dir.join("packages");
    let mut candidates = Vec::new();
    let mut bin_directories = BTreeSet::new();
    let Ok(vendors) = std::fs::read_dir(packages) else {
        return (BTreeMap::new(), bin_directories);
    };

    for vendor in vendors.flatten() {
        let tools = vendor.path().join("tools");
        if !is_real_directory(&tools) {
            continue;
        }
        let mut pending = vec![tools];
        while let Some(directory) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    continue;
                };
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("bin")
                    {
                        bin_directories.insert(path.clone());
                    }
                    pending.push(path);
                    continue;
                }
                if path
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|parent| parent.eq_ignore_ascii_case("bin"))
                    && is_toolchain_executable(&entry.file_name(), &metadata)
                    && (is_ccache_compiler_filename(&entry.file_name())
                        || is_direct_tool_filename(&entry.file_name()))
                {
                    candidates.push(path);
                }
            }
        }
    }

    // read_dir order is OS-dependent. Sort first so duplicate basenames from
    // multiple installed toolchain versions resolve reproducibly. Prefixed
    // binutils are normally unique; when they are not, the stable first source
    // is used and refreshed whenever that source changes.
    candidates.sort_by(|left, right| {
        left.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.to_string_lossy().to_ascii_lowercase())
            .then_with(|| left.as_os_str().cmp(right.as_os_str()))
    });

    let mut grouped = BTreeMap::<String, Vec<PathBuf>>::new();
    for source in candidates {
        let Some(name) = source.file_name().map(OsStr::to_os_string) else {
            continue;
        };
        if name.eq_ignore_ascii_case(ccache_binary_name()) {
            continue;
        }
        let key = name.to_string_lossy().to_ascii_lowercase();
        grouped.entry(key).or_default().push(source);
    }

    let mut entries = BTreeMap::new();
    for (key, sources) in grouped {
        let Some(first) = sources.first() else {
            continue;
        };
        let Some(name) = first.file_name().map(OsStr::to_os_string) else {
            continue;
        };
        if is_ccache_compiler_filename(&name) {
            entries.insert(
                key,
                CcacheDirectoryEntry::Compiler {
                    name,
                    source: first.clone(),
                },
            );
            continue;
        }

        // A flat compiler.path cannot safely represent two different binaries
        // with the same basename. Identical duplicates are harmless; conflicting
        // ones are deliberately omitted rather than silently routing one Core to
        // another Core's tool. platform.local nocache recipes retain the exact
        // source path for normal archive/link/objcopy/size operations.
        if sources
            .iter()
            .skip(1)
            .all(|source| files_have_equal_content(first, source))
        {
            entries.insert(
                key,
                CcacheDirectoryEntry::Direct {
                    name,
                    source: first.clone(),
                    equivalent_sources: sources,
                },
            );
        } else {
            log::warn!(
                "Skipping ambiguous ccache direct-tool forwarder {:?}: conflicting sources {:?}",
                name,
                sources
            );
        }
    }
    (entries, bin_directories)
}

fn files_have_equal_content(left: &Path, right: &Path) -> bool {
    use std::io::Read;

    let (Ok(left_metadata), Ok(right_metadata)) =
        (std::fs::metadata(left), std::fs::metadata(right))
    else {
        return false;
    };
    if !left_metadata.is_file()
        || !right_metadata.is_file()
        || left_metadata.len() != right_metadata.len()
    {
        return false;
    }
    let (Ok(mut left_file), Ok(mut right_file)) =
        (std::fs::File::open(left), std::fs::File::open(right))
    else {
        return false;
    };
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let (Ok(left_read), Ok(right_read)) = (
            left_file.read(&mut left_buffer),
            right_file.read(&mut right_buffer),
        ) else {
            return false;
        };
        if left_read != right_read {
            return false;
        }
        if left_read == 0 {
            return true;
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return false;
        }
    }
}

fn cached_tool_source_is_valid(source: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(source) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    let Some(name) = source.file_name() else {
        return false;
    };
    source
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|parent| parent.eq_ignore_ascii_case("bin"))
        && is_toolchain_executable(name, &metadata)
}

/// A cache hit is allowed only while every source that informed the original
/// ambiguity decision is still usable and equivalent. This is particularly
/// important for direct objcopy/objdump forwarders: a changed duplicate must
/// be rejected by the full scanner rather than silently routing one Core to
/// another Core's binary.
fn cached_directory_entries_are_usable(
    directory_entries: &BTreeMap<String, CcacheDirectoryEntry>,
) -> bool {
    directory_entries.values().all(|entry| match entry {
        CcacheDirectoryEntry::Compiler { source, .. } => cached_tool_source_is_valid(source),
        CcacheDirectoryEntry::Direct {
            source,
            equivalent_sources,
            ..
        } => {
            let Some(first) = equivalent_sources.first() else {
                return false;
            };
            first == source
                && equivalent_sources.iter().all(|candidate| {
                    cached_tool_source_is_valid(candidate)
                        && files_have_equal_content(first, candidate)
                })
        }
    })
}

fn remove_shim_file_if_present(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            std::fs::remove_file(path)
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("ccache shim target is not a file: {}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sync_ccache_shim_entries(
    bin_dir: &Path,
    installed: &Path,
    directory_entries: &BTreeMap<String, CcacheDirectoryEntry>,
) -> io::Result<CcacheShimReport> {
    let compiler_count = directory_entries
        .values()
        .filter(|entry| matches!(entry, CcacheDirectoryEntry::Compiler { .. }))
        .count();
    let direct_tool_count = directory_entries.len().saturating_sub(compiler_count);
    let shim_dir = bin_dir.join("ccache");
    if compiler_count == 0 {
        if is_real_directory(&shim_dir) {
            for entry in std::fs::read_dir(&shim_dir)?.flatten() {
                let _ = remove_shim_file_if_present(&entry.path());
            }
        }
        return Ok(CcacheShimReport::default());
    }
    std::fs::create_dir_all(&shim_dir)?;

    let desired = directory_entries.keys().cloned().collect::<BTreeSet<_>>();
    for entry in std::fs::read_dir(&shim_dir)?.flatten() {
        let key = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !desired.contains(&key) {
            remove_shim_file_if_present(&entry.path())?;
        }
    }

    let mut report = CcacheShimReport {
        compiler_count,
        direct_tool_count,
        ..CcacheShimReport::default()
    };
    for entry in directory_entries.values() {
        let (name, source, is_compiler) = match entry {
            CcacheDirectoryEntry::Compiler { name, .. } => (name, installed, true),
            CcacheDirectoryEntry::Direct { name, source, .. } => (name, source.as_path(), false),
        };
        let target = shim_dir.join(name);
        if files_have_equal_content(source, &target) {
            if is_compiler {
                report.shim_count += 1;
            } else {
                report.direct_forwarder_count += 1;
            }
            continue;
        }
        remove_shim_file_if_present(&target)?;
        match std::fs::hard_link(source, &target) {
            Ok(()) => report.hardlinked += 1,
            Err(_) => {
                std::fs::copy(source, &target)?;
                report.copied += 1;
            }
        }
        if is_compiler {
            report.shim_count += 1;
        } else {
            report.direct_forwarder_count += 1;
        }
    }
    report.enabled = report.shim_count > 0 && report.shim_count == report.compiler_count;
    Ok(report)
}

/// Install/refresh ccache compiler masquerade shims for the toolchains that are
/// actually present under this sysroot. The first pass performs the complete
/// safety scan; subsequent passes validate a compact topology/source proof and
/// repair known outputs without recursively walking every installed toolchain.
pub(crate) fn ensure_ccache_shims(root_dir: &Path) -> io::Result<CcacheShimReport> {
    let bin_dir = root_dir.join("bin");
    let bundled = root_dir.join("tools").join(ccache_binary_name());
    let installed = bin_dir.join(ccache_binary_name());
    std::fs::create_dir_all(&bin_dir)?;

    if bundled.is_file() && !files_have_equal_content(&bundled, &installed) {
        let temporary = bin_dir.join(format!("{}.installing", ccache_binary_name()));
        let _ = std::fs::remove_file(&temporary);
        std::fs::copy(&bundled, &temporary)?;
        if installed.exists() {
            std::fs::remove_file(&installed)?;
        }
        std::fs::rename(temporary, &installed)?;
    }

    if !installed.is_file() {
        invalidate_ccache_shim_cache(root_dir);
        return Ok(CcacheShimReport::default());
    }

    let cache_key = ccache_shim_cache_key(root_dir);
    let mut cache = ccache_shim_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.get(&cache_key) {
        if cached.topology.matches() && cached_directory_entries_are_usable(&cached.entries) {
            return sync_ccache_shim_entries(&bin_dir, &installed, &cached.entries);
        }
    }
    cache.remove(&cache_key);

    let (directory_entries, bin_directories) = collect_ccache_directory_entries(root_dir);
    let report = sync_ccache_shim_entries(&bin_dir, &installed, &directory_entries)?;

    // Do not cache a scan whose directory state changed while it was running.
    // The next request will conservatively rescan instead.
    if let Some(topology) = capture_ccache_shim_topology(root_dir, &bin_directories)
        && topology.matches()
        && cached_directory_entries_are_usable(&directory_entries)
    {
        cache.insert(
            cache_key,
            CcacheShimCache {
                entries: directory_entries,
                topology,
            },
        );
    }
    Ok(report)
}

#[derive(Clone)]
pub struct Sysroot {
    pub root_dir: PathBuf,
    pub manifest: Arc<Mutex<Manifest>>,
}

impl Sysroot {
    pub async fn init(custom_root: Option<PathBuf>, app_name: &str) -> Result<Self> {
        let root_dir = if let Some(path) = custom_root {
            path
        } else {
            dirs::data_local_dir()
                .context("Could not find data_local_dir")?
                .join(app_name)
                .join("sysroot")
        };

        tokio::fs::create_dir_all(&root_dir.join("bin")).await?;
        tokio::fs::create_dir_all(&root_dir.join("packages")).await?;
        tokio::fs::create_dir_all(&root_dir.join("state")).await?;
        tokio::fs::create_dir_all(&root_dir.join("cache")).await?;
        tokio::fs::create_dir_all(&root_dir.join("cache").join("ccache")).await?;
        tokio::fs::create_dir_all(&root_dir.join("libraries")).await?;
        tokio::fs::create_dir_all(&root_dir.join("sketchbook")).await?;
        prepare_prebuilt_cores_layout(&root_dir)?;

        // Optional acceleration must never make sysroot initialization fail.
        // With no bundled/installed ccache, or before a Core installs its real
        // compiler, the report remains disabled and compilation stays honest.
        match ensure_ccache_shims(&root_dir) {
            Ok(report) if report.enabled => log::info!(
                "ccache ready with {} compiler shim(s) and {} direct tool forwarder(s) ({} linked, {} copied)",
                report.shim_count,
                report.direct_forwarder_count,
                report.hardlinked,
                report.copied
            ),
            Ok(_) => log::info!("ccache acceleration is not available for this sysroot yet"),
            Err(error) => log::warn!("ccache setup skipped: {}", error),
        }

        // Generate/update arduino-cli.yaml for explicit path configuration
        let config_path = root_dir.join("arduino-cli.yaml");
        if !config_path.exists() {
            // Create new config from template
            let config_content = format!(
                r#"board_manager:
  additional_urls:
    - {ESP32_OFFICIAL_PACKAGE_INDEX_URL}
    - {ESP32_CN_PACKAGE_INDEX_URL}
directories:
  data: {}
  downloads: {}
  user: {}
build_cache:
  compilations_before_purge: 0
  ttl: 87600h
"#,
                root_dir.to_string_lossy().replace("\\", "/"),
                root_dir.join("cache").to_string_lossy().replace("\\", "/"),
                root_dir
                    .join("sketchbook")
                    .to_string_lossy()
                    .replace("\\", "/")
            );
            tokio::fs::write(&config_path, config_content).await?;
            log::info!("Created arduino-cli.yaml at {:?}", config_path);
        } else {
            // Existing file: retain all user/vendor URLs, add the CN mirror
            // once, and ensure build_cache section is present.
            let existing = tokio::fs::read_to_string(&config_path)
                .await
                .unwrap_or_default();
            let mut updated =
                ensure_board_manager_additional_url(&existing, ESP32_CN_PACKAGE_INDEX_URL);
            if !updated.contains("build_cache:") {
                let append = "\nbuild_cache:\n  compilations_before_purge: 0\n  ttl: 87600h\n";
                updated = format!("{}{}", updated.trim_end(), append);
            }
            if updated != existing {
                tokio::fs::write(&config_path, updated).await?;
                log::info!(
                    "Updated arduino-cli.yaml with default ESP32 mirror/build_cache settings"
                );
            }
        }

        // Generate arduino-cli-fast.yaml (fast compile config with empty sketchbook)
        let fast_config_path = root_dir.join("arduino-cli-fast.yaml");
        let empty_sketchbook = root_dir.join("empty_sketchbook");
        tokio::fs::create_dir_all(&empty_sketchbook).await?;
        // Also create empty libraries dir inside empty_sketchbook
        tokio::fs::create_dir_all(&empty_sketchbook.join("libraries")).await?;
        {
            // Always regenerate to keep paths in sync
            let fast_config_content = format!(
                r#"board_manager:
  additional_urls:
    - {ESP32_OFFICIAL_PACKAGE_INDEX_URL}
    - {ESP32_CN_PACKAGE_INDEX_URL}
directories:
  data: {}
  downloads: {}
  user: {}
build_cache:
  path: {}
  compilations_before_purge: 10
  ttl: 87600h
"#,
                root_dir.to_string_lossy().replace("\\", "/"),
                root_dir.join("cache").to_string_lossy().replace("\\", "/"),
                empty_sketchbook.to_string_lossy().replace("\\", "/"),
                root_dir
                    .join("cache")
                    .join("arduino_cores")
                    .to_string_lossy()
                    .replace("\\", "/"),
            );
            tokio::fs::write(&fast_config_path, fast_config_content).await?;
            log::info!("Created arduino-cli-fast.yaml at {:?}", fast_config_path);
        }

        let manifest_path = root_dir.join("state").join("manifest.json");
        let manifest = if manifest_path.exists() {
            let content = tokio::fs::read_to_string(&manifest_path).await?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            Manifest::default()
        };

        log::info!("Sysroot initialized at {:?}", root_dir);

        Ok(Self {
            root_dir,
            manifest: Arc::new(Mutex::new(manifest)),
        })
    }

    pub async fn save_manifest(&self) -> Result<()> {
        let manifest_path = self.root_dir.join("state").join("manifest.json");
        let guard = self.manifest.lock().await;
        let content = serde_json::to_string_pretty(&*guard)?;
        tokio::fs::write(manifest_path, content).await?;
        Ok(())
    }

    pub fn get_bin_path(&self) -> PathBuf {
        self.root_dir.join("bin")
    }

    /// Canonical destination for all new prebuilt-core snapshots.
    pub(crate) fn prebuilt_cores_write_root(&self) -> io::Result<PathBuf> {
        let canonical = self.root_dir.join("prebuilt_cores");
        if !canonical.exists() {
            std::fs::create_dir_all(&canonical)?;
        }
        if !is_real_directory(&canonical) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "canonical prebuilt-core root is not a real directory: {}",
                    canonical.display()
                ),
            ));
        }
        Ok(canonical)
    }

    /// Ordered cache roots for compatibility reads and exact-target cleanup.
    /// The legacy sibling is accepted only when it is a real directory at the
    /// one historical location; arbitrary paths and symlink escapes are never
    /// traversed.
    pub(crate) fn prebuilt_cores_read_roots(&self) -> Vec<PathBuf> {
        let canonical = self.root_dir.join("prebuilt_cores");
        let mut roots = Vec::new();
        if is_real_directory(&canonical) {
            roots.push(canonical.clone());
        }
        if let Some(legacy) = self
            .root_dir
            .parent()
            .map(|parent| parent.join("prebuilt_cores"))
            .filter(|path| path != &canonical && is_real_directory(path))
        {
            roots.push(legacy);
        }
        roots
    }

    pub async fn ensure_tool(&self, name: &str, info: ToolInfo) -> Result<()> {
        // Logic to check if installed, if not download and extract
        let tool_dir = self
            .root_dir
            .join("packages")
            .join(name)
            .join(&info.version);
        if tool_dir.exists() {
            log::info!("Tool {}@{} already exists", name, info.version);
            return Ok(());
        }

        log::info!("Installing {}@{}...", name, info.version);
        let cache_dir = self.root_dir.join("cache");
        let archive_path = cache_dir.join(&info.filename);

        downloader::download_file(&info.download_url, &archive_path, Some(&info.sha256)).await?;
        downloader::extract_archive(&archive_path, &tool_dir).await?;
        invalidate_ccache_shim_cache(&self.root_dir);

        // Update manifest (skipped logic for brevity, would act here)

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ESP32_CN_PACKAGE_INDEX_URL, ESP32_OFFICIAL_PACKAGE_INDEX_URL, Sysroot, ccache_binary_name,
        ccache_shim_full_scan_count, ensure_board_manager_additional_url, ensure_ccache_shims,
        invalidate_ccache_shim_cache, is_ccache_compiler_filename, is_direct_tool_filename,
    };

    fn compiler_name(prefix: &str, role: &str) -> String {
        if cfg!(target_os = "windows") {
            format!("{prefix}-{role}.exe")
        } else {
            format!("{prefix}-{role}")
        }
    }

    #[test]
    fn default_esp32_indexes_preserve_official_fallback_and_add_cn_mirror_once() {
        let existing = format!(
            "board_manager:\n  additional_urls:\n    - {ESP32_OFFICIAL_PACKAGE_INDEX_URL}\n"
        );
        let updated = ensure_board_manager_additional_url(&existing, ESP32_CN_PACKAGE_INDEX_URL);
        assert!(updated.contains(ESP32_OFFICIAL_PACKAGE_INDEX_URL));
        assert_eq!(
            updated.matches(ESP32_CN_PACKAGE_INDEX_URL).count(),
            1,
            "CN mirror should be added exactly once"
        );
        assert_eq!(
            ensure_board_manager_additional_url(&updated, ESP32_CN_PACKAGE_INDEX_URL),
            updated,
            "sysroot init must be idempotent"
        );

        let inline_empty = "board_manager:\n  additional_urls: []\n";
        let expanded =
            ensure_board_manager_additional_url(inline_empty, ESP32_CN_PACKAGE_INDEX_URL);
        assert!(expanded.contains("  additional_urls:\n"));
        assert!(expanded.contains(ESP32_CN_PACKAGE_INDEX_URL));
    }

    fn install_fake_tool_at(root: &std::path::Path, toolchain: &str, name: &str, body: &[u8]) {
        let bin = root.join("packages/acme/tools").join(toolchain).join("bin");
        std::fs::create_dir_all(&bin).expect("toolchain bin");
        let path = bin.join(name);
        std::fs::write(&path, body).expect("tool fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("executable tool fixture");
        }
    }

    fn install_fake_tool(root: &std::path::Path, name: &str, body: &[u8]) {
        install_fake_tool_at(root, "demo-gcc/1.0", name, body);
    }

    #[test]
    fn compiler_shim_filter_accepts_drivers_and_rejects_binutils() {
        for role in ["gcc", "g++", "cc", "c++", "clang", "clang++"] {
            let name = compiler_name("riscv32-demo-elf", role);
            assert!(
                is_ccache_compiler_filename(std::ffi::OsStr::new(&name)),
                "{name} must be recognized as a compiler driver"
            );
        }
        let versioned = if cfg!(target_os = "windows") {
            "riscv32-demo-elf-gcc-14.2.0.exe"
        } else {
            "riscv32-demo-elf-gcc-14.2.0"
        };
        assert!(is_ccache_compiler_filename(std::ffi::OsStr::new(versioned)));
        for role in ["ar", "nm", "ranlib", "objcopy", "size"] {
            let name = compiler_name("riscv32-demo-elf-gcc", role);
            assert!(
                !is_ccache_compiler_filename(std::ffi::OsStr::new(&name)),
                "{name} must bypass ccache"
            );
        }
        for role in ["objcopy", "objdump"] {
            let name = compiler_name("riscv32-demo-elf", role);
            assert!(
                is_direct_tool_filename(std::ffi::OsStr::new(&name)),
                "{name} must be available as a direct real-tool forwarder"
            );
            let unprefixed = if cfg!(target_os = "windows") {
                format!("{role}.exe")
            } else {
                role.to_string()
            };
            assert!(
                !is_direct_tool_filename(std::ffi::OsStr::new(&unprefixed)),
                "unprefixed {unprefixed} must not be flattened across toolchains"
            );
        }
        for role in ["ar", "nm", "ranlib", "size"] {
            let name = compiler_name("riscv32-demo-elf", role);
            assert!(
                !is_direct_tool_filename(std::ffi::OsStr::new(&name)),
                "{name} is covered by a nocache recipe and must stay at its real path"
            );
        }
        let unrelated = compiler_name("riscv32-demo-elf", "gprof");
        assert!(!is_direct_tool_filename(std::ffi::OsStr::new(&unrelated)));
    }

    #[tokio::test]
    async fn empty_sysroot_keeps_ccache_honestly_disabled() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        let sysroot = Sysroot::init(Some(root.clone()), "ck-empty-sysroot-test")
            .await
            .expect("sysroot");
        let report = ensure_ccache_shims(&root).expect("optional ccache setup");
        assert!(!report.enabled);
        assert_eq!(report.compiler_count, 0);
        assert_eq!(report.shim_count, 0);
        assert_eq!(
            sysroot.prebuilt_cores_write_root().expect("canonical root"),
            root.join("prebuilt_cores")
        );
        assert!(
            sysroot
                .prebuilt_cores_write_root()
                .expect("canonical root")
                .is_dir()
        );
        let config = std::fs::read_to_string(root.join("arduino-cli.yaml")).expect("cli config");
        let fast_config =
            std::fs::read_to_string(root.join("arduino-cli-fast.yaml")).expect("fast config");
        for content in [&config, &fast_config] {
            assert!(content.contains(ESP32_OFFICIAL_PACKAGE_INDEX_URL));
            assert!(content.contains(ESP32_CN_PACKAGE_INDEX_URL));
        }
    }

    #[tokio::test]
    async fn existing_sysroot_config_adds_cn_mirror_and_keeps_official_url() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        std::fs::create_dir_all(&root).expect("sysroot parent");
        let existing = format!(
            "board_manager:\n  additional_urls:\n    - {ESP32_OFFICIAL_PACKAGE_INDEX_URL}\nbuild_cache:\n  compilations_before_purge: 0\n"
        );
        std::fs::write(root.join("arduino-cli.yaml"), existing).expect("legacy config");

        Sysroot::init(Some(root.clone()), "ck-existing-config-test")
            .await
            .expect("sysroot");
        let updated =
            std::fs::read_to_string(root.join("arduino-cli.yaml")).expect("updated cli config");
        assert!(updated.contains(ESP32_OFFICIAL_PACKAGE_INDEX_URL));
        assert_eq!(
            updated.matches(ESP32_CN_PACKAGE_INDEX_URL).count(),
            1,
            "initializing an existing sysroot should add the mirror only once"
        );
    }

    #[tokio::test]
    async fn ccache_directory_accelerates_compilers_and_forwards_binutils_directly() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        std::fs::create_dir_all(root.join("tools")).expect("tools");
        std::fs::write(
            root.join("tools").join(ccache_binary_name()),
            b"fake-ccache",
        )
        .expect("ccache fixture");
        let gcc = compiler_name("demo", "gcc");
        let archive = compiler_name("demo-gcc", "ar");
        let objcopy = compiler_name("demo", "objcopy");
        let nm = compiler_name("demo", "nm");
        let ranlib = compiler_name("demo", "ranlib");
        let objdump = compiler_name("demo", "objdump");
        let size = compiler_name("demo", "size");
        let versioned_objcopy = if cfg!(target_os = "windows") {
            "demo-objcopy-2.1.exe"
        } else {
            "demo-objcopy-2.1"
        };
        install_fake_tool(&root, &gcc, b"real-compiler");
        for (name, body) in [
            (archive.as_str(), b"real-ar".as_slice()),
            (objcopy.as_str(), b"real-objcopy".as_slice()),
            (nm.as_str(), b"real-nm".as_slice()),
            (ranlib.as_str(), b"real-ranlib".as_slice()),
            (objdump.as_str(), b"real-objdump".as_slice()),
            (size.as_str(), b"real-size".as_slice()),
            (versioned_objcopy, b"versioned-objcopy".as_slice()),
        ] {
            install_fake_tool(&root, name, body);
        }

        Sysroot::init(Some(root.clone()), "ck-ccache-shim-test")
            .await
            .expect("sysroot");
        let first = ensure_ccache_shims(&root).expect("first shim pass");
        assert!(first.enabled);
        assert_eq!(first.compiler_count, 1);
        assert_eq!(first.shim_count, 1);
        assert_eq!(first.direct_tool_count, 3);
        assert_eq!(first.direct_forwarder_count, 3);
        assert!(root.join("bin/ccache").join(&gcc).is_file());
        assert_eq!(
            std::fs::read(root.join("bin/ccache").join(&gcc)).expect("compiler shim"),
            b"fake-ccache",
            "compiler drivers must masquerade as ccache"
        );
        for (name, expected) in [
            (objcopy.as_str(), b"real-objcopy".as_slice()),
            (objdump.as_str(), b"real-objdump".as_slice()),
            (versioned_objcopy, b"versioned-objcopy".as_slice()),
        ] {
            assert_eq!(
                std::fs::read(root.join("bin/ccache").join(name)).expect("direct forwarder"),
                expected,
                "{name} must execute the real tool and never ccache"
            );
        }
        for name in [&archive, &nm, &ranlib, &size] {
            assert!(
                !root.join("bin/ccache").join(name).exists(),
                "{name} must remain on the exact nocache toolchain path"
            );
        }

        let clang = compiler_name("demo", "clang");
        install_fake_tool(&root, &clang, b"real-clang");
        let second = ensure_ccache_shims(&root).expect("post-install shim pass");
        assert!(second.enabled);
        assert_eq!(second.compiler_count, 2);
        assert_eq!(second.shim_count, 2);
        assert!(root.join("bin/ccache").join(clang).is_file());

        // Size-only checks are insufficient: upstream tools can be replaced
        // by a different build with the same byte length.
        std::fs::write(
            root.join("tools").join(ccache_binary_name()),
            b"other-cache",
        )
        .expect("same-size ccache update");
        ensure_ccache_shims(&root).expect("refresh same-size ccache update");
        assert_eq!(
            std::fs::read(root.join("bin/ccache").join(&gcc)).expect("updated shim"),
            b"other-cache"
        );

        // Replacing a real binutil with same-length different content must
        // refresh the direct forwarder even when the old one was a hardlink.
        let objcopy_source = root
            .join("packages/acme/tools/demo-gcc/1.0/bin")
            .join(&objcopy);
        std::fs::remove_file(&objcopy_source).expect("replace objcopy source");
        install_fake_tool(&root, &objcopy, b"next-objcopy");
        ensure_ccache_shims(&root).expect("refresh direct forwarder");
        assert_eq!(
            std::fs::read(root.join("bin/ccache").join(&objcopy)).expect("updated objcopy"),
            b"next-objcopy"
        );

        std::fs::remove_file(
            root.join("packages/acme/tools/demo-gcc/1.0/bin")
                .join(&objdump),
        )
        .expect("remove objdump source");
        ensure_ccache_shims(&root).expect("prune missing direct tool");
        assert!(
            !root.join("bin/ccache").join(&objdump).exists(),
            "a removed toolchain binary must not leave a stale executable behind"
        );
    }

    #[test]
    fn ccache_shim_cache_repairs_known_outputs_without_a_second_recursive_scan() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        std::fs::create_dir_all(root.join("tools")).expect("tools");
        std::fs::write(
            root.join("tools").join(ccache_binary_name()),
            b"fake-ccache",
        )
        .expect("ccache fixture");
        let gcc = compiler_name("demo", "gcc");
        let objcopy = compiler_name("demo", "objcopy");
        install_fake_tool(&root, &gcc, b"real-compiler");
        install_fake_tool(&root, &objcopy, b"real-objcopy");

        ensure_ccache_shims(&root).expect("initial full scan");
        let initial_scans = ccache_shim_full_scan_count(&root);
        assert!(
            initial_scans > 0,
            "the initial setup must inspect toolchains"
        );

        let shim_dir = root.join("bin/ccache");
        let compiler_target = shim_dir.join(&gcc);
        let direct_target = shim_dir.join(&objcopy);
        std::fs::remove_file(&compiler_target).expect("remove compiler shim");
        std::fs::write(&compiler_target, b"tampered-ccache").expect("tamper compiler shim");
        std::fs::remove_file(&direct_target).expect("remove direct forwarder");
        std::fs::write(&direct_target, b"tampered-tool").expect("tamper direct forwarder");

        let repaired = ensure_ccache_shims(&root).expect("repair cached outputs");
        assert!(repaired.enabled);
        assert_eq!(
            ccache_shim_full_scan_count(&root),
            initial_scans,
            "known output repairs must reuse the verified inventory"
        );
        assert_eq!(
            std::fs::read(&compiler_target).expect("restored compiler shim"),
            b"fake-ccache"
        );
        assert_eq!(
            std::fs::read(&direct_target).expect("restored direct forwarder"),
            b"real-objcopy"
        );

        invalidate_ccache_shim_cache(&root);
        ensure_ccache_shims(&root).expect("explicitly invalidated setup");
        assert_eq!(
            ccache_shim_full_scan_count(&root),
            initial_scans + 1,
            "controlled Core/tool changes must be able to force a fresh inventory"
        );
    }

    #[tokio::test]
    async fn conflicting_same_named_direct_tools_are_refused_until_unambiguous() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        std::fs::create_dir_all(root.join("tools")).expect("tools");
        std::fs::write(
            root.join("tools").join(ccache_binary_name()),
            b"fake-ccache",
        )
        .expect("ccache fixture");
        let gcc = compiler_name("demo", "gcc");
        let objcopy = compiler_name("demo", "objcopy");
        install_fake_tool_at(&root, "a-toolchain/1.0", &gcc, b"compiler-a");
        install_fake_tool_at(&root, "a-toolchain/1.0", &objcopy, b"objcopy-a");
        install_fake_tool_at(&root, "z-toolchain/9.0", &objcopy, b"objcopy-z");

        let first = ensure_ccache_shims(&root).expect("first setup");
        assert!(first.enabled);
        assert!(
            !root.join("bin/ccache").join(&objcopy).exists(),
            "different binaries with one basename must be refused instead of first-wins routing"
        );
        let second = ensure_ccache_shims(&root).expect("idempotent setup");
        assert!(second.enabled);
        assert_eq!(second.compiler_count, first.compiler_count);
        assert_eq!(second.shim_count, first.shim_count);
        assert_eq!(second.direct_tool_count, 0);
        assert_eq!(second.direct_forwarder_count, 0);
        assert_eq!(second.hardlinked, 0, "idempotent reruns must not relink");
        assert_eq!(second.copied, 0, "idempotent reruns must not recopy");

        // Once both versions contain the same binary, either source is
        // semantically equivalent and the deterministic first source is safe.
        let alternate = root
            .join("packages/acme/tools/z-toolchain/9.0/bin")
            .join(&objcopy);
        std::fs::remove_file(&alternate).expect("replace conflicting source");
        install_fake_tool_at(&root, "z-toolchain/9.0", &objcopy, b"objcopy-a");
        let resolved = ensure_ccache_shims(&root).expect("resolve identical sources");
        assert_eq!(resolved.direct_tool_count, 1);
        assert_eq!(resolved.direct_forwarder_count, 1);
        assert_eq!(
            std::fs::read(root.join("bin/ccache").join(&objcopy)).expect("resolved objcopy"),
            b"objcopy-a"
        );
    }

    #[tokio::test]
    async fn legacy_prebuilt_cache_is_atomically_migrated_without_copying() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        let legacy = temp.path().join("prebuilt_cores");
        std::fs::create_dir_all(&legacy).expect("legacy root");
        std::fs::write(legacy.join("large-cache-marker"), b"preserve-me").expect("legacy marker");

        let sysroot = Sysroot::init(Some(root.clone()), "ck-prebuilt-migration-test")
            .await
            .expect("sysroot");
        assert!(
            root.join("prebuilt_cores/large-cache-marker").is_file(),
            "same-volume legacy content must arrive at the canonical root"
        );
        assert!(!legacy.exists());
        assert_eq!(
            sysroot.prebuilt_cores_read_roots(),
            vec![root.join("prebuilt_cores")]
        );
    }

    #[tokio::test]
    async fn nonempty_canonical_cache_preserves_scoped_legacy_compatibility_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("sysroot");
        let canonical = root.join("prebuilt_cores");
        let legacy = temp.path().join("prebuilt_cores");
        let unrelated = temp.path().join("other/prebuilt_cores");
        for directory in [&canonical, &legacy, &unrelated] {
            std::fs::create_dir_all(directory).expect("cache root");
        }
        std::fs::write(canonical.join("new"), b"canonical").expect("canonical marker");
        std::fs::write(legacy.join("old"), b"legacy").expect("legacy marker");
        std::fs::write(unrelated.join("outside"), b"unrelated").expect("outside marker");

        let sysroot = Sysroot::init(Some(root.clone()), "ck-prebuilt-compat-test")
            .await
            .expect("sysroot");
        assert!(canonical.join("new").is_file());
        assert!(legacy.join("old").is_file());
        assert_eq!(
            sysroot.prebuilt_cores_write_root().expect("canonical root"),
            canonical
        );
        assert_eq!(
            sysroot.prebuilt_cores_read_roots(),
            vec![root.join("prebuilt_cores"), legacy]
        );
        assert!(unrelated.join("outside").is_file());
        assert!(
            !sysroot.prebuilt_cores_read_roots().contains(&unrelated),
            "compatibility reads must not cross into arbitrary roots"
        );
    }
}
