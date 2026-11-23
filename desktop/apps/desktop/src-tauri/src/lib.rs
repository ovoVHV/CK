// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!(
        "娴ｇ姴銈? {}! 鏉╂瑦妲搁弶銉ㄥ殰 Rust 閸氬海顏惃鍕Х閹?",
        name
    )
}

use regex::Regex;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};

mod bounded_sse;
mod ai_utf8_stream;
mod ai_store;
mod ai_request_options;
mod ai_responses;
mod bundled_arduino;
mod ai_verification;
mod ai_library_source;
mod ai_storage_commands;
mod ai_library;
mod core_catalog;
mod prebuild_restore;

pub use prebuild_restore::{
    maybe_run_prebuild_restore_from_args, register_current_exe_as_prebuild_restore_helper,
};

/// Apply CREATE_NO_WINDOW on Windows to prevent console flash.
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000)
}
#[cfg(not(target_os = "windows"))]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}
// --- Smart Library Filtering Helpers ---

#[derive(Debug, Clone, PartialEq)]
enum LibSource {
    Global,               // Documents/CK/libraries/ (and legacy lib/)
    ArchitectureSpecific, // Documents/CK/libraries/<arch>/
    BoardSpecific, // Documents/CK/board-package-libraries/<board_id>/ or legacy board-scoped libs
}

#[derive(serde::Serialize, Clone)]
pub struct BoardDefinition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_graph: Option<serde_json::Value>,
    pub id: String,
    pub name: String,
    pub version: String,
    pub vendor: String,
    pub fqbn_base: String,
    pub pins: Vec<serde_json::Value>,
    pub icon: String,
    pub group: String,
    pub description: String,
    pub path: String, // Absolute path to the board folder
    pub arduino_core: Option<serde_json::Value>,
    pub config_options: Option<Vec<serde_json::Value>>,
    pub quality_report: Option<package_quality::PackageQualityReport>,
    pub core_status: Option<board_passport::CoreCompatibilityReport>,
    pub passport: Option<board_passport::BoardPassport>,
    pub usable: bool,
    pub availability_error: Option<String>,
}

#[derive(Debug, Clone)]
struct LibraryCandidate {
    path: std::path::PathBuf,
    headers: HashSet<String>,
    source: LibSource,
    meta: LibraryCandidateMeta,
}

#[derive(Debug, Clone)]
struct CandidateResolutionResult {
    final_libs: Vec<std::path::PathBuf>,
    include_resolved_to_ck: Vec<String>,
    include_not_in_ck: Vec<String>,
}

#[derive(Debug, Clone)]
struct ArduinoUserLibraryCandidate {
    library: LibraryCandidate,
    dependency_name_keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ArduinoUserLibraryResolution {
    /// Exact user-library roots, including declared transitive dependencies.
    final_libs: Vec<std::path::PathBuf>,
    /// Human-readable direct include matches for build reporting.
    include_matches: Vec<String>,
    /// Headers that are not provided by an Arduino user library. These remain
    /// available for the selected Core/platform to resolve (for example WiFi.h).
    include_unmatched: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct LibraryCandidateMeta {
    manifest_name_norm: Option<String>,
    manifest_id_norm: Option<String>,
    manifest_version: Option<VersionRank>,
    include_keys: HashSet<String>,
    architecture_keys: HashSet<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
struct VersionRank {
    major: u32,
    minor: u32,
    patch: u32,
    extra: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct CandidatePickScore {
    source_rank: u8,
    architecture_match: u8,
    manifest_include_match: u8,
    name_match: u8,
    header_match: u8,
    version_rank: VersionRank,
    shallower_depth_bias: u16,
}

// Extract #include "..." and <...>
fn get_required_headers(code: &str) -> HashSet<String> {
    let mut headers = HashSet::new();
    // Regex for: #include <header.h> or #include "header.h"
    // Handles subtle whitespace like #  include
    let re = Regex::new(r#"#\s*include\s*[<"]([^>"]+)[>"]"#).unwrap();

    for cap in re.captures_iter(code) {
        if let Some(header) = cap.get(1) {
            headers.insert(header.as_str().trim().to_string());
        }
    }
    headers
}

fn project_required_headers(code:&str)->HashSet<String>{
    let mut all=get_required_headers(code);
    if let Some(files)=ck_core::builder::demo::project_sources(){
        for bytes in files.values(){all.extend(get_required_headers(&String::from_utf8_lossy(bytes)));}
        all.retain(|header| !files.contains_key(header.as_str()));
    }
    all
}

fn header_lookup_keys(raw_header: &str) -> Vec<String> {
    let normalized = raw_header.trim().replace('\\', "/").to_ascii_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut keys: Vec<String> = Vec::new();
    keys.push(normalized.clone());

    if let Some(base) = normalized.rsplit('/').next() {
        let base = base.trim();
        if !base.is_empty() && !keys.iter().any(|k| k == base) {
            keys.push(base.to_string());
        }
    }

    keys
}

fn normalized_header_key(raw_header: &str) -> Option<String> {
    let normalized = raw_header.trim().replace('\\', "/").to_ascii_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn push_manifest_tokens(set: &mut HashSet<String>, raw: &str) {
    for token in raw.split([',', ';']) {
        let normalized = token.trim().to_ascii_lowercase();
        if !normalized.is_empty() {
            set.insert(normalized);
        }
    }
}

fn parse_version_rank(raw_version: &str) -> Option<VersionRank> {
    let mut parts = raw_version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty());
    let parse_part =
        |part: Option<&str>| -> u32 { part.and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) };
    let major = parse_part(parts.next());
    let minor = parse_part(parts.next());
    let patch = parse_part(parts.next());
    let extra = parse_part(parts.next());
    if major == 0 && minor == 0 && patch == 0 && extra == 0 {
        return None;
    }
    Some(VersionRank {
        major,
        minor,
        patch,
        extra,
    })
}

fn load_library_candidate_meta(lib_path: &std::path::Path) -> LibraryCandidateMeta {
    let mut meta = LibraryCandidateMeta::default();
    let json_path = lib_path.join("library.json");
    let Ok(content) = std::fs::read_to_string(json_path) else {
        return meta;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return meta;
    };

    meta.manifest_name_norm = json
        .get("name")
        .and_then(|v| v.as_str())
        .map(normalize_match_name)
        .filter(|v| !v.is_empty());
    meta.manifest_id_norm = json
        .get("id")
        .and_then(|v| v.as_str())
        .map(normalize_match_name)
        .filter(|v| !v.is_empty());
    meta.manifest_version = json
        .get("version")
        .and_then(|v| v.as_str())
        .and_then(parse_version_rank);

    if let Some(includes) = json.get("includes") {
        match includes {
            serde_json::Value::String(s) => {
                if let Some(key) = normalized_header_key(s) {
                    meta.include_keys.insert(key);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(s) = item.as_str() {
                        if let Some(key) = normalized_header_key(s) {
                            meta.include_keys.insert(key);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for field in ["architectures", "architecture", "platforms", "platform"] {
        let Some(value) = json.get(field) else {
            continue;
        };
        match value {
            serde_json::Value::String(s) => push_manifest_tokens(&mut meta.architecture_keys, s),
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(s) = item.as_str() {
                        push_manifest_tokens(&mut meta.architecture_keys, s);
                    }
                }
            }
            _ => {}
        }
    }

    meta
}

fn is_library_header(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "h" | "hh" | "hpp" | "hxx" | "inc" | "ipp" | "tpp"
            )
        })
        .unwrap_or(false)
}

fn scan_header_tree(
    root: &std::path::Path,
    current: &std::path::Path,
    depth: usize,
    headers: &mut HashSet<String>,
) {
    if depth > 64 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with('.'))
                .unwrap_or(false)
            {
                continue;
            }
            scan_header_tree(root, &path, depth + 1, headers);
        } else if file_type.is_file() && is_library_header(&path) {
            if let Ok(relative) = path.strip_prefix(root) {
                headers.insert(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Scan the headers that Arduino can actually expose for this library.
/// Modern libraries expose the `src/` root recursively, preserving paths such
/// as `drivers/sensor.h`. Legacy libraries expose root headers and `utility/`.
fn scan_library_headers(lib_path: &std::path::Path) -> HashSet<String> {
    let mut headers = HashSet::new();

    let lib_is_src = lib_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("src"))
        .unwrap_or(false);
    let modern_src = if lib_is_src {
        Some(lib_path.to_path_buf())
    } else {
        let src = lib_path.join("src");
        src.is_dir().then_some(src)
    };

    if let Some(src) = modern_src {
        scan_header_tree(&src, &src, 0, &mut headers);
        return headers;
    }

    if let Ok(entries) = std::fs::read_dir(lib_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && is_library_header(&path)
            {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    headers.insert(name.to_string());
                }
            }
        }
    }
    let utility = lib_path.join("utility");
    if utility.is_dir() {
        scan_header_tree(lib_path, &utility, 0, &mut headers);
    }

    headers
}

fn push_library_candidate(
    candidate_list: &mut Vec<LibraryCandidate>,
    lib_path: std::path::PathBuf,
    source: LibSource,
) {
    if !lib_path.is_dir() {
        return;
    }
    let headers = scan_library_headers_cached(&lib_path);
    if !headers.is_empty() {
        let (meta, _) = load_arduino_user_library_metadata(&lib_path);
        candidate_list.push(LibraryCandidate {
            path: lib_path,
            headers,
            source,
            meta,
        });
    }
}

fn is_candidate_scan_ignored_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "example" | "examples" | "test" | "tests" | "docs" | "doc" | "__macosx" | "src"
    )
}

fn looks_like_standalone_sub_library(path: &std::path::Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }
    let name_lower = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        name_lower.as_str(),
        "fl" | "fx"
            | "lib8tion"
            | "platforms"
            | "sensors"
            | "utility"
            | "extras"
            | "drivers"
            | "examples"
            | "docs"
    ) {
        return false;
    }

    if path.join("library.properties").exists() || path.join("library.json").exists() {
        return true;
    }

    let headers = scan_library_headers_cached(path);
    if headers.is_empty() {
        return false;
    }
    contains_compilable_sources(path, 4)
}

fn push_subfolder_library_candidates(
    candidate_list: &mut Vec<LibraryCandidate>,
    parent_path: &std::path::Path,
    source: LibSource,
) {
    if !parent_path.exists() || !parent_path.is_dir() {
        return;
    }
    // A CK wrapper can carry complete upstream Arduino folders. Preserve each
    // root and properties; never flatten them into the wrapper's src tree.
    if bundled_arduino::is_block_package(parent_path) {
        if let Ok(roots) = bundled_arduino::roots(parent_path) {
            for root in roots { push_library_candidate(candidate_list, root, source.clone()); }
        }
        return;
    }
    if looks_like_standalone_sub_library(parent_path) {
        // Parent already behaves like a proper library root.
        // Avoid pulling internal implementation subfolders as independent libraries.
        return;
    }

    let walker = walkdir::WalkDir::new(parent_path)
        .min_depth(1)
        .max_depth(2)
        .into_iter();
    for entry in walker.filter_entry(|e| {
        let name = e.file_name().to_str().unwrap_or("");
        !is_candidate_scan_ignored_dir(name)
    }) {
        if let Ok(entry) = entry {
            let sub_path = entry.path().to_path_buf();
            if !sub_path.is_dir() {
                continue;
            }
            if !looks_like_standalone_sub_library(&sub_path) {
                continue;
            }
            push_library_candidate(candidate_list, sub_path, source.clone());
        }
    }
}

fn lib_source_rank(source: &LibSource) -> u8 {
    match source {
        LibSource::BoardSpecific => 3,
        LibSource::ArchitectureSpecific => 2,
        LibSource::Global => 1,
    }
}

fn dedupe_library_candidates(candidates: Vec<LibraryCandidate>) -> Vec<LibraryCandidate> {
    let mut merged: HashMap<String, LibraryCandidate> = HashMap::new();
    for candidate in candidates {
        let key = normalize_path_key(&candidate.path);
        match merged.get(&key) {
            Some(existing) => {
                if lib_source_rank(&candidate.source) > lib_source_rank(&existing.source) {
                    merged.insert(key, candidate);
                }
            }
            None => {
                merged.insert(key, candidate);
            }
        }
    }

    let mut deduped: Vec<LibraryCandidate> = merged.into_values().collect();
    deduped.sort_by(|a, b| a.path.cmp(&b.path));
    deduped
}

fn candidate_match_name(path: &std::path::Path) -> Option<String> {
    let file_name = path.file_name().and_then(|n| n.to_str())?;
    if file_name.eq_ignore_ascii_case("lib") {
        return path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
    }
    Some(file_name.to_string())
}

fn normalize_match_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn candidate_name_keys(candidate: &LibraryCandidate) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(id_norm) = &candidate.meta.manifest_id_norm {
        keys.push(id_norm.clone());
    }
    if let Some(name_norm) = &candidate.meta.manifest_name_norm {
        if !keys.iter().any(|v| v == name_norm) {
            keys.push(name_norm.clone());
        }
    }
    if let Some(path_name) = candidate_match_name(&candidate.path) {
        let path_norm = normalize_match_name(&path_name);
        if !path_norm.is_empty() && !keys.iter().any(|v| v == &path_norm) {
            keys.push(path_norm);
        }
    }
    keys
}

fn candidate_header_match_score(candidate: &LibraryCandidate, required_header: &str) -> u8 {
    let modern_layout = candidate.path.join("src").is_dir()
        || candidate
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("src"))
            .unwrap_or(false);
    if modern_layout {
        let Some(required) = normalized_header_key(required_header) else {
            return 0;
        };
        return candidate
            .headers
            .iter()
            .filter_map(|header| normalized_header_key(header))
            .any(|header| header == required)
            .then_some(if required.contains('/') { 3 } else { 2 })
            .unwrap_or(0);
    }
    let lookup_keys = header_lookup_keys(required_header);
    for key in &lookup_keys {
        if candidate
            .headers
            .iter()
            .flat_map(|header| header_lookup_keys(header))
            .any(|candidate_key| candidate_key == *key)
        {
            if key.contains('/') {
                return 3;
            }
            return 2;
        }
    }
    0
}

fn candidate_manifest_include_score(candidate: &LibraryCandidate, required_header: &str) -> u8 {
    let lookup_keys = header_lookup_keys(required_header);
    for key in &lookup_keys {
        if candidate.meta.include_keys.contains(key) {
            if key.contains('/') {
                return 3;
            }
            return 2;
        }
    }
    0
}

fn candidate_name_match_score(candidate: &LibraryCandidate, required_header: &str) -> u8 {
    let req_stem = std::path::Path::new(required_header)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(required_header);
    let req_norm = normalize_match_name(req_stem);
    if req_norm.is_empty() {
        return 0;
    }

    let mut best = 0u8;
    for key in candidate_name_keys(candidate) {
        if key == req_norm {
            return 3;
        }
        if key.contains(&req_norm) || req_norm.contains(&key) {
            best = best.max(2);
        }
        let req_tokens = req_norm
            .split(|c: char| c.is_ascii_digit())
            .filter(|part| !part.is_empty());
        for token in req_tokens {
            if token.len() >= 4 && key.contains(token) {
                best = best.max(1);
            }
        }
    }
    best
}

fn candidate_architecture_match_score(candidate: &LibraryCandidate, board_arch: &str) -> u8 {
    let board_arch_norm = board_arch.trim().to_ascii_lowercase();
    if candidate.meta.architecture_keys.is_empty()
        || candidate.meta.architecture_keys.contains("*")
        || candidate.meta.architecture_keys.contains("all")
        || candidate.meta.architecture_keys.contains("any")
    {
        return 2;
    }
    if !board_arch_norm.is_empty() && candidate.meta.architecture_keys.contains(&board_arch_norm) {
        return 2;
    }
    0
}

fn candidate_path_depth_bias(path: &std::path::Path) -> u16 {
    let depth = path.components().count().min(u16::MAX as usize) as u16;
    u16::MAX.saturating_sub(depth)
}

fn pick_best_candidate_for_header(
    provider_indices: &[usize],
    candidates: &[LibraryCandidate],
    required_header: &str,
    board_arch: &str,
) -> usize {
    let mut best_idx = provider_indices[0];
    let mut best_score = CandidatePickScore {
        source_rank: lib_source_rank(&candidates[best_idx].source),
        architecture_match: candidate_architecture_match_score(&candidates[best_idx], board_arch),
        manifest_include_match: candidate_manifest_include_score(
            &candidates[best_idx],
            required_header,
        ),
        name_match: candidate_name_match_score(&candidates[best_idx], required_header),
        header_match: candidate_header_match_score(&candidates[best_idx], required_header),
        version_rank: candidates[best_idx]
            .meta
            .manifest_version
            .unwrap_or_default(),
        shallower_depth_bias: candidate_path_depth_bias(&candidates[best_idx].path),
    };

    for &idx in provider_indices.iter().skip(1) {
        let score = CandidatePickScore {
            source_rank: lib_source_rank(&candidates[idx].source),
            architecture_match: candidate_architecture_match_score(&candidates[idx], board_arch),
            manifest_include_match: candidate_manifest_include_score(
                &candidates[idx],
                required_header,
            ),
            name_match: candidate_name_match_score(&candidates[idx], required_header),
            header_match: candidate_header_match_score(&candidates[idx], required_header),
            version_rank: candidates[idx].meta.manifest_version.unwrap_or_default(),
            shallower_depth_bias: candidate_path_depth_bias(&candidates[idx].path),
        };
        if score > best_score {
            best_idx = idx;
            best_score = score;
        }
    }

    best_idx
}

fn finalize_candidate_path_for_cli(
    candidate_path: &std::path::Path,
    header_hint: Option<&str>,
) -> std::path::PathBuf {
    let mut final_path = candidate_path.to_path_buf();

    let ends_with_lib = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("lib"))
        .unwrap_or(false);

    if ends_with_lib {
        if let Some(shim_path) = create_legacy_lib_shim(&final_path) {
            final_path = shim_path;
        }
    } else {
        let canonical_modern_layout = final_path.join("src").is_dir()
            || final_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case("src"))
                .unwrap_or(false);
        if should_use_recursive_src_shim(&final_path) {
            if let Some(shim_path) = create_recursive_src_shim(&final_path) {
                final_path = shim_path;
            }
        } else if !canonical_modern_layout {
            if let Some(header) = header_hint {
                if let Some(nested_dir) = check_nested_src(&final_path, header) {
                    if let Some(shim_path) = shim_nested_src(&final_path, &nested_dir) {
                        final_path = shim_path;
                    }
                }
            }
        }
    }

    normalize_library_path_for_cli(&final_path)
}

fn is_dependency_scan_source_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "h" | "hpp" | "hh" | "hxx" | "c" | "cc" | "cpp" | "cxx" | "ino" | "ipp" | "tpp"
            )
        })
        .unwrap_or(false)
}

fn collect_library_internal_includes(lib_path: &std::path::Path) -> HashSet<String> {
    let mut includes: HashSet<String> = HashSet::new();
    if !lib_path.exists() || !lib_path.is_dir() {
        return includes;
    }

    let walker = walkdir::WalkDir::new(lib_path).max_depth(6).into_iter();
    for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.')) {
        let Ok(entry) = entry else {
            continue;
        };
        let file_path = entry.path();
        if !file_path.is_file() || !is_dependency_scan_source_file(file_path) {
            continue;
        }

        let Ok(raw) = std::fs::read(file_path) else {
            continue;
        };
        if raw.is_empty() || raw.len() > 2_000_000 {
            continue;
        }
        let text = String::from_utf8_lossy(&raw);
        for include in get_required_headers(&text) {
            includes.insert(include);
        }
    }

    includes
}

fn expand_candidate_dependencies_by_includes(
    _selected_candidate_indices: &mut HashSet<usize>,
    _selected_reason_headers: &mut HashMap<usize, String>,
    _candidates: &[LibraryCandidate],
    _header_provider_map: &HashMap<String, Vec<usize>>,
) {
    // [OPTIMIZATION]
    // Deliberately empty! We defer to arduino-cli to resolve transitive dependencies
    // using its built-in advanced library resolver.
    // Deep recursive text-based scanning of `#include` in all `.cpp` files is highly unsafe.
    // It ignores `#ifdef` guards and can pull in incompatible libraries causing massive
    // compile failures and severely slowing down the compiler by flooding it with
    // dozens of `--library` flags.
}

fn candidate_resolution_input_hash(
    required_headers_sorted: &[String],
    candidates: &[LibraryCandidate],
    board_arch: &str,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    board_arch.trim().to_ascii_lowercase().hash(&mut hasher);
    for header in required_headers_sorted {
        header.trim().to_ascii_lowercase().hash(&mut hasher);
    }
    for cand in candidates {
        normalize_path_key(&cand.path).hash(&mut hasher);
        library_scan_signature_ms(&cand.path).hash(&mut hasher);
        lib_source_rank(&cand.source).hash(&mut hasher);
    }
    hasher.finish()
}

fn resolve_ck_library_candidates(
    required_headers_sorted: &[String],
    candidates: &[LibraryCandidate],
    board_arch: &str,
) -> CandidateResolutionResult {
    let input_hash =
        candidate_resolution_input_hash(required_headers_sorted, candidates, board_arch);
    if let Ok(guard) = candidate_resolution_cache().lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.input_hash == input_hash
                && cached.result.final_libs.iter().all(|p| p.exists())
            {
                return cached.result.clone();
            }
        }
    }

    let mut final_libs: Vec<std::path::PathBuf> = Vec::new();
    let mut include_resolved_to_ck: Vec<String> = Vec::new();
    let mut include_not_in_ck: Vec<String> = Vec::new();
    let mut added_paths: HashSet<std::path::PathBuf> = HashSet::new();

    let mut header_provider_map: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, cand) in candidates.iter().enumerate() {
        for h in &cand.headers {
            for key in header_lookup_keys(h) {
                header_provider_map.entry(key).or_default().push(idx);
            }
        }
    }

    let mut selected_candidate_indices: HashSet<usize> = HashSet::new();
    let mut selected_reason_headers: HashMap<usize, String> = HashMap::new();

    for req in required_headers_sorted {
        let mut provider_indices_opt: Option<&Vec<usize>> = None;
        for lookup_key in header_lookup_keys(req) {
            if let Some(found) = header_provider_map.get(&lookup_key) {
                provider_indices_opt = Some(found);
                break;
            }
        }
        let Some(provider_indices) = provider_indices_opt else {
            include_not_in_ck.push(req.clone());
            continue;
        };

        let best_idx =
            pick_best_candidate_for_header(provider_indices, candidates, req, board_arch);
        selected_candidate_indices.insert(best_idx);
        selected_reason_headers
            .entry(best_idx)
            .or_insert_with(|| req.clone());

        let final_path = finalize_candidate_path_for_cli(&candidates[best_idx].path, Some(req));
        if added_paths.insert(final_path.clone()) {
            final_libs.push(final_path.clone());
        }
        include_resolved_to_ck.push(format!("{} -> {}", req, final_path.display()));
    }

    expand_candidate_dependencies_by_includes(
        &mut selected_candidate_indices,
        &mut selected_reason_headers,
        candidates,
        &header_provider_map,
    );

    let mut selected_sorted: Vec<usize> = selected_candidate_indices.into_iter().collect();
    selected_sorted.sort_unstable();

    for idx in selected_sorted {
        let header_hint = selected_reason_headers.get(&idx).map(|s| s.as_str());
        let final_path = finalize_candidate_path_for_cli(&candidates[idx].path, header_hint);
        if added_paths.insert(final_path.clone()) {
            final_libs.push(final_path.clone());
            if let Some(reason) = header_hint {
                include_resolved_to_ck.push(format!(
                    "(dep) {} -> {}",
                    reason,
                    final_path.display()
                ));
            } else {
                include_resolved_to_ck.push(format!(
                    "(dep) {} -> {}",
                    candidates[idx].path.display(),
                    final_path.display()
                ));
            }
        }
    }

    // Expose sibling bundled roots to the real preprocessor/CLI resolver so a
    // library's transitive dependencies remain available. Unused libraries are
    // only candidates; their sources are not forcibly compiled.
    let selected = final_libs.clone();
    for root in &selected {
        if let Some(owner) = bundled_arduino::owner(root) {
            if let Ok(roots) = bundled_arduino::roots(&owner) {
                for native in roots {
                    if added_paths.insert(native.clone()) { final_libs.push(native); }
                }
            }
        }
    }
    final_libs = ck_core::builder::signature::normalize_and_sort_paths(&final_libs);

    let result = CandidateResolutionResult {
        final_libs,
        include_resolved_to_ck,
        include_not_in_ck,
    };
    if let Ok(mut guard) = candidate_resolution_cache().lock() {
        *guard = Some(CachedCandidateResolutionEntry {
            input_hash,
            result: result.clone(),
        });
    }
    result
}

// --- End Helpers ---

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// --- 库扫描缓存（方案B：避免每次编译重复扫描所有库目录） ---
use std::sync::OnceLock;

/// Serializes managed Arduino Core/index mutations against every build that
/// reads those packages. Multiple builds may proceed together, while an
/// install, uninstall, or index update has exclusive access for its complete
/// transaction. Keeping the guard at the command boundary closes the gap
/// between CK Forge identity calculation and the compiler/uploader child
/// process consuming the same files.
fn managed_package_mutation_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

async fn acquire_managed_package_write_guard(
    app: &tauri::AppHandle,
    operation: &str,
) -> tokio::sync::RwLockWriteGuard<'static, ()> {
    let gate = managed_package_mutation_gate();
    if let Ok(guard) = gate.try_write() {
        // Invalidate before the first installer/index process can touch the
        // Core/toolchain tree. Builds hold the matching read guard until their
        // child process exits, so no active build can observe this generation
        // transition halfway through compilation.
        ck_core::builder::demo::invalidate_process_toolchain_identity_cache();
        return guard;
    }

    let _ = app.emit(
        "install-progress",
        format!(
            "CK Forge: waiting for the active compile or prewarm to finish before {operation}..."
        ),
    );
    // Warmups are disposable acceleration work. Ask them to stop instead of
    // making a user-requested Core transaction wait for a full background
    // build. Foreground builds are never cancelled here; the writer waits for
    // their read guard to release normally.
    compile_accel::cancel_running_warmup().await;
    let waiting_since = std::time::Instant::now();
    let guard = gate.write().await;
    ck_core::builder::demo::invalidate_process_toolchain_identity_cache();
    let _ = app.emit(
        "install-progress",
        format!(
            "CK Forge: managed package gate acquired for {operation} after {:.1}s.",
            waiting_since.elapsed().as_secs_f32()
        ),
    );
    guard
}

#[cfg(test)]
mod managed_package_mutation_gate_tests {
    use super::managed_package_mutation_gate;
    use tokio::sync::oneshot;
    use tokio::time::{Duration, timeout};

    #[tokio::test]
    async fn builds_share_the_gate_and_core_mutations_wait_in_both_directions() {
        let gate = managed_package_mutation_gate();

        // A Core install/update cannot enter while a build is consuming the
        // managed Core and toolchain tree.
        let active_build = gate.read().await;
        let (writer_attempted_tx, writer_attempted_rx) = oneshot::channel();
        let (writer_entered_tx, mut writer_entered_rx) = oneshot::channel();
        let waiting_install = tokio::spawn(async move {
            let _ = writer_attempted_tx.send(());
            let _install_guard = managed_package_mutation_gate().write().await;
            let _ = writer_entered_tx.send(());
        });
        writer_attempted_rx.await.expect("writer task started");
        assert!(
            timeout(Duration::from_millis(75), &mut writer_entered_rx)
                .await
                .is_err(),
            "managed Core mutation entered during an active build"
        );
        drop(active_build);
        timeout(Duration::from_secs(1), &mut writer_entered_rx)
            .await
            .expect("writer should enter after build exits")
            .expect("writer completion signal");
        waiting_install.await.expect("writer task joined");

        // Conversely, a build cannot begin its identity scan or child process
        // while a Core/index mutation transaction is active.
        let active_install = gate.write().await;
        let (reader_attempted_tx, reader_attempted_rx) = oneshot::channel();
        let (reader_entered_tx, mut reader_entered_rx) = oneshot::channel();
        let waiting_build = tokio::spawn(async move {
            let _ = reader_attempted_tx.send(());
            let _build_guard = managed_package_mutation_gate().read().await;
            let _ = reader_entered_tx.send(());
        });
        reader_attempted_rx.await.expect("reader task started");
        assert!(
            timeout(Duration::from_millis(75), &mut reader_entered_rx)
                .await
                .is_err(),
            "build entered during an active managed Core mutation"
        );
        drop(active_install);
        timeout(Duration::from_secs(1), &mut reader_entered_rx)
            .await
            .expect("reader should enter after install exits")
            .expect("reader completion signal");
        waiting_build.await.expect("reader task joined");

        // Read guards do not serialize independent compile/upload operations.
        let first_build = gate.read().await;
        let (parallel_reader_tx, parallel_reader_rx) = oneshot::channel();
        let parallel_build = tokio::spawn(async move {
            let _parallel_guard = managed_package_mutation_gate().read().await;
            let _ = parallel_reader_tx.send(());
        });
        timeout(Duration::from_secs(1), parallel_reader_rx)
            .await
            .expect("second build should enter while first build is active")
            .expect("parallel reader completion signal");
        drop(first_build);
        parallel_build.await.expect("parallel reader task joined");
    }
}

#[derive(Debug, Clone)]
struct CachedHeaderEntry {
    mtime_ms: u128,
    headers: HashSet<String>,
}

#[derive(Debug, Clone)]
struct CachedBusioScanEntry {
    mtime_ms: u128,
    busio_source_count: usize,
    has_non_busio_sources: bool,
}

#[derive(Debug, Clone)]
struct CachedCandidateResolutionEntry {
    input_hash: u64,
    result: CandidateResolutionResult,
}

#[derive(Debug, Clone)]
struct CachedBusioDedupeEntry {
    input_hash: u64,
    libs: Vec<std::path::PathBuf>,
    notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedLibraryCandidatesEntry {
    input_hash: u64,
    candidates: Arc<Vec<LibraryCandidate>>,
    candidate_signatures: Vec<(String, u128)>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct HeaderIndexEntryFile {
    mtime_ms: u128,
    headers: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct HeaderIndexFile {
    version: u32,
    entries: HashMap<String, HeaderIndexEntryFile>,
}

/// 全局库 header 扫描缓存: path -> cached headers + mtime
/// 在应用生命周期内有效，并同步到 Documents/CK/state/header_index_v1.json
static LIB_HEADER_CACHE: OnceLock<Mutex<HashMap<String, CachedHeaderEntry>>> = OnceLock::new();
static LIB_HEADER_CACHE_DIRTY: AtomicBool = AtomicBool::new(false);
static LIB_BUSIO_SCAN_CACHE: OnceLock<Mutex<HashMap<String, CachedBusioScanEntry>>> =
    OnceLock::new();
static LIB_RESOLUTION_CACHE: OnceLock<Mutex<Option<CachedCandidateResolutionEntry>>> =
    OnceLock::new();
static LIB_BUSIO_DEDUPE_CACHE: OnceLock<Mutex<Option<CachedBusioDedupeEntry>>> = OnceLock::new();
static LIB_CANDIDATES_CACHE: OnceLock<Mutex<Option<CachedLibraryCandidatesEntry>>> =
    OnceLock::new();

fn busio_scan_cache() -> &'static Mutex<HashMap<String, CachedBusioScanEntry>> {
    LIB_BUSIO_SCAN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn candidate_resolution_cache() -> &'static Mutex<Option<CachedCandidateResolutionEntry>> {
    LIB_RESOLUTION_CACHE.get_or_init(|| Mutex::new(None))
}

fn busio_dedupe_cache() -> &'static Mutex<Option<CachedBusioDedupeEntry>> {
    LIB_BUSIO_DEDUPE_CACHE.get_or_init(|| Mutex::new(None))
}

fn library_candidates_cache() -> &'static Mutex<Option<CachedLibraryCandidatesEntry>> {
    LIB_CANDIDATES_CACHE.get_or_init(|| Mutex::new(None))
}

fn header_index_file_path() -> Option<std::path::PathBuf> {
    let ck_root = ck_root_dir();
    Some(ck_core::builder::accel::header_index_path(&ck_root))
}

fn file_mtime_ms(path: &std::path::Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn is_library_signature_source(path: &std::path::Path) -> bool {
    is_library_header(path)
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "c" | "cc" | "cpp" | "cxx" | "s" | "ino"
                )
            })
            .unwrap_or(false)
}

fn hash_library_signature_file(
    hasher: &mut std::collections::hash_map::DefaultHasher,
    root: &std::path::Path,
    path: &std::path::Path,
) {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
        .hash(hasher);
    if let Ok(metadata) = std::fs::metadata(path) {
        metadata.len().hash(hasher);
        file_mtime_ms(path).hash(hasher);
    }
}

fn hash_library_signature_tree(
    hasher: &mut std::collections::hash_map::DefaultHasher,
    root: &std::path::Path,
    current: &std::path::Path,
    depth: usize,
) {
    if depth > 64 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with('.'))
                .unwrap_or(false)
            {
                continue;
            }
            hash_library_signature_tree(hasher, root, &path, depth + 1);
        } else if file_type.is_file() && is_library_signature_source(&path) {
            hash_library_signature_file(hasher, root, &path);
        }
    }
}

/// A stable recursive signature for all files that can affect Arduino library
/// discovery. Unlike a directory mtime, this changes when a deep source/header
/// is edited, added, removed or renamed.
fn library_scan_signature_ms(lib_path: &std::path::Path) -> u128 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    "ck-library-tree-signature-v2".hash(&mut hasher);
    normalize_path_key(lib_path).hash(&mut hasher);

    for manifest_name in ["library.json", "library.properties"] {
        let manifest = lib_path.join(manifest_name);
        manifest_name.hash(&mut hasher);
        manifest.exists().hash(&mut hasher);
        if manifest.is_file() {
            hash_library_signature_file(&mut hasher, lib_path, &manifest);
        }
    }

    let lib_is_src = lib_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("src"))
        .unwrap_or(false);
    let modern_src = if lib_is_src {
        Some(lib_path.to_path_buf())
    } else {
        let src = lib_path.join("src");
        src.is_dir().then_some(src)
    };
    if let Some(src) = modern_src {
        hash_library_signature_tree(&mut hasher, lib_path, &src, 0);
    } else {
        if let Ok(entries) = std::fs::read_dir(lib_path) {
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
            for entry in entries {
                let path = entry.path();
                if entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                    && is_library_signature_source(&path)
                {
                    hash_library_signature_file(&mut hasher, lib_path, &path);
                }
            }
        }
        let utility = lib_path.join("utility");
        if utility.is_dir() {
            hash_library_signature_tree(&mut hasher, lib_path, &utility, 0);
        }
    }
    hasher.finish() as u128
}

fn normalize_path_key(path: &std::path::Path) -> String {
    #[cfg(target_os = "windows")]
    {
        return path.to_string_lossy().replace('\\', "/").to_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().replace('\\', "/")
    }
}

fn hash_directory_children_snapshot(
    hasher: &mut std::collections::hash_map::DefaultHasher,
    dir: &std::path::Path,
    include_lib_probe: bool,
) {
    normalize_path_key(dir).hash(hasher);
    file_mtime_ms(dir).hash(hasher);
    if !dir.exists() || !dir.is_dir() {
        return;
    }
    let mut rows: Vec<(String, bool, u128, u128)> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let is_dir = path.is_dir();
            // A wrapper with no own C++ headers is absent from the candidate
            // list. Include its complete child-root namespace here as well,
            // otherwise dropping a new folder into libraries could stay stale.
            if bundled_arduino::is_block_package(&path) {
                match bundled_arduino::roots(&path) {
                    Ok(roots) => for native in roots {
                        normalize_path_key(&native).hash(hasher);
                        library_scan_signature_ms(&native).hash(hasher);
                    },
                    Err(error) => error.hash(hasher),
                }
            }
            let mtime = file_mtime_ms(&path);
            let lib_probe = if include_lib_probe {
                file_mtime_ms(&path.join("lib"))
            } else {
                0
            };
            rows.push((name, is_dir, mtime, lib_probe));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir, mtime, lib_probe) in rows {
        name.hash(hasher);
        is_dir.hash(hasher);
        mtime.hash(hasher);
        if include_lib_probe {
            lib_probe.hash(hasher);
        }
    }
}

fn hash_ck_root_library_containers_snapshot(
    hasher: &mut std::collections::hash_map::DefaultHasher,
    ck_dir: &std::path::Path,
) {
    normalize_path_key(ck_dir).hash(hasher);
    file_mtime_ms(ck_dir).hash(hasher);
    if !ck_dir.exists() || !ck_dir.is_dir() {
        return;
    }

    // Only track CK root entries that can affect candidate discovery:
    // 1) top-level "libraries" and "board-package-libraries" containers
    // 2) package-like roots that expose a direct "lib/" child
    // Ignore unrelated mutable dirs like "state/" to avoid cache thrash.
    let mut rows: Vec<(String, bool, u128, u128)> = Vec::new();
    if let Ok(entries) = fs::read_dir(ck_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let is_primary_container = name == "libraries" || name == "board-package-libraries";
            let lib_dir = path.join("lib");
            let has_lib_dir = lib_dir.exists() && lib_dir.is_dir();
            if !is_primary_container && !has_lib_dir {
                continue;
            }
            rows.push((
                name,
                has_lib_dir,
                file_mtime_ms(&path),
                if has_lib_dir {
                    file_mtime_ms(&lib_dir)
                } else {
                    0
                },
            ));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, has_lib_dir, mtime, lib_mtime) in rows {
        name.hash(hasher);
        has_lib_dir.hash(hasher);
        mtime.hash(hasher);
        lib_mtime.hash(hasher);
    }
}

fn library_candidates_input_hash(
    app: &tauri::AppHandle,
    fqbn: &str,
    board_arch: &str,
    safe_board: &str,
    board_library_scope: &str,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    fqbn.trim().to_ascii_lowercase().hash(&mut hasher);
    board_arch.trim().to_ascii_lowercase().hash(&mut hasher);
    safe_board.trim().to_ascii_lowercase().hash(&mut hasher);
    board_library_scope
        .trim()
        .to_ascii_lowercase()
        .hash(&mut hasher);

    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        let bundled = app_data
            .join("CK")
            .join("boards")
            .join(board_library_scope)
            .join("libraries");
        hash_directory_children_snapshot(&mut hasher, &bundled, false);
    }

    {
        let ck_dir = ck_root_dir();
        let global_libs = ck_dir.join("libraries");
        let arch_libs = global_libs.join(board_arch);
        let board_libs_legacy = global_libs.join(safe_board);
        let board_libs_pkg = ck_dir
            .join("board-package-libraries")
            .join(board_library_scope);
        hash_ck_root_library_containers_snapshot(&mut hasher, &ck_dir);
        hash_directory_children_snapshot(&mut hasher, &global_libs, false);
        hash_directory_children_snapshot(&mut hasher, &arch_libs, false);
        hash_directory_children_snapshot(&mut hasher, &board_libs_legacy, false);
        hash_directory_children_snapshot(&mut hasher, &board_libs_pkg, false);
    }

    hasher.finish()
}

fn compute_candidate_library_signatures(candidates: &[LibraryCandidate]) -> Vec<(String, u128)> {
    let mut out: Vec<(String, u128)> = candidates
        .iter()
        .map(|c| {
            (
                normalize_path_key(&c.path),
                library_scan_signature_ms(&c.path),
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn candidate_library_signatures_match(signatures: &[(String, u128)]) -> bool {
    for (path_key, sig) in signatures {
        #[cfg(target_os = "windows")]
        let path = std::path::PathBuf::from(path_key.replace('/', "\\"));
        #[cfg(not(target_os = "windows"))]
        let path = std::path::PathBuf::from(path_key);
        if !path.exists() || library_scan_signature_ms(&path) != *sig {
            return false;
        }
    }
    true
}

fn collect_library_candidates_uncached(
    app: &tauri::AppHandle,
    _fqbn: &str,
    safe_board: &str,
    board_arch: &str,
    board_library_scope: &str,
) -> Vec<LibraryCandidate> {
    let mut candidates: Vec<LibraryCandidate> = Vec::new();

    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        let bundled_libs = app_data
            .join("CK")
            .join("boards")
            .join(board_library_scope)
            .join("libraries");
        if bundled_libs.exists() {
            if let Ok(entries) = std::fs::read_dir(&bundled_libs) {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    push_library_candidate(
                        &mut candidates,
                        entry_path.clone(),
                        LibSource::BoardSpecific,
                    );
                    push_subfolder_library_candidates(
                        &mut candidates,
                        &entry_path,
                        LibSource::BoardSpecific,
                    );
                }
            }
        }
    }

    {
        let ck_dir = ck_root_dir();
        if ck_dir.exists() {
            let global_libs = ck_dir.join("libraries");
            if global_libs.exists() {
                if let Ok(entries) = std::fs::read_dir(&global_libs) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let dir_name = path.file_name().and_then(|n| n.to_str());
                        if path.is_dir()
                            && dir_name != Some(safe_board)
                            && dir_name != Some(board_library_scope)
                            && dir_name != Some(board_arch)
                        {
                            push_library_candidate(
                                &mut candidates,
                                path.clone(),
                                LibSource::Global,
                            );
                            push_subfolder_library_candidates(
                                &mut candidates,
                                &path,
                                LibSource::Global,
                            );
                        }
                    }
                }
            }

            let arch_libs_dir = ck_dir.join("libraries").join(board_arch);
            if arch_libs_dir.exists() && board_arch != "unknown" {
                if let Ok(entries) = std::fs::read_dir(&arch_libs_dir) {
                    for entry in entries.flatten() {
                        let entry_path = entry.path();
                        push_library_candidate(
                            &mut candidates,
                            entry_path.clone(),
                            LibSource::ArchitectureSpecific,
                        );
                        push_subfolder_library_candidates(
                            &mut candidates,
                            &entry_path,
                            LibSource::ArchitectureSpecific,
                        );
                    }
                }
            }

            if let Ok(entries) = std::fs::read_dir(&ck_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.file_name().map(|n| n == "libraries").unwrap_or(false) {
                        continue;
                    }
                    let lib_root = path.join("lib");
                    if lib_root.exists() && lib_root.is_dir() {
                        push_library_candidate(&mut candidates, lib_root, LibSource::Global);
                    }
                }
            }

            let board_lib_roots = [
                ck_dir
                    .join("board-package-libraries")
                    .join(board_library_scope),
                ck_dir.join("libraries").join(board_library_scope),
            ];
            for board_libs_dir in board_lib_roots {
                if !board_libs_dir.exists() {
                    continue;
                }
                if let Ok(entries) = std::fs::read_dir(&board_libs_dir) {
                    for entry in entries.flatten() {
                        let entry_path = entry.path();
                        push_library_candidate(
                            &mut candidates,
                            entry_path.clone(),
                            LibSource::BoardSpecific,
                        );
                        push_subfolder_library_candidates(
                            &mut candidates,
                            &entry_path,
                            LibSource::BoardSpecific,
                        );
                    }
                }
            }
        }
    }

    dedupe_library_candidates(candidates)
}

fn collect_library_candidates_cached(
    app: &tauri::AppHandle,
    fqbn: &str,
    safe_board: &str,
    board_arch: &str,
    board_library_scope: &str,
) -> Arc<Vec<LibraryCandidate>> {
    let input_hash =
        library_candidates_input_hash(app, fqbn, board_arch, safe_board, board_library_scope);
    let cached = library_candidates_cache().lock().ok().and_then(|guard| {
        guard.as_ref().map(|entry| {
            (
                entry.input_hash,
                entry.candidates.clone(),
                entry.candidate_signatures.clone(),
            )
        })
    });
    if let Some((cached_input_hash, cached_candidates, cached_signatures)) = cached {
        // The cheap container snapshot does not observe every nested src/
        // directory. Revalidate the stored deep signatures before returning a
        // hit so header additions, removals and in-place replacements cannot
        // leave library resolution on a stale candidate catalogue.
        if cached_input_hash == input_hash && candidate_library_signatures_match(&cached_signatures)
        {
            return cached_candidates;
        }
    }

    let candidates =
        collect_library_candidates_uncached(app, fqbn, safe_board, board_arch, board_library_scope);
    let candidate_signatures = compute_candidate_library_signatures(&candidates);
    let candidates_arc = Arc::new(candidates);
    if let Ok(mut guard) = library_candidates_cache().lock() {
        *guard = Some(CachedLibraryCandidatesEntry {
            input_hash,
            candidates: candidates_arc.clone(),
            candidate_signatures,
        });
    }
    candidates_arc
}

/// Resolve the exact library scope for one build without conflating an Arduino
/// compiler target with a third-party CK board-package identity. Custom scopes
/// are accepted only while the installed parent package, Core policy, lock and
/// content hash remain runtime-trusted.
fn board_library_scope_for_build(
    app: &tauri::AppHandle,
    fqbn: &str,
    board_package_id: Option<&str>,
) -> Result<String, String> {
    let base_fqbn = package_quality::base_fqbn_scope(fqbn)?;
    let built_in_scope = base_fqbn.replace(':', "_");
    let package_id = board_package_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(package_id) = package_id else {
        return Ok(built_in_scope);
    };
    if package_id == base_fqbn {
        return Ok(built_in_scope);
    }
    if !package_quality::valid_package_id(package_id, false) {
        return Err("板卡包身份包含不安全字符，已阻止构建。".to_string());
    }
    if !lib_custom_registry::custom_board_package_runtime_is_trusted(app, package_id, &base_fqbn) {
        return Err(format!(
            "板卡包 {} 缺失、认证失效、内容已变化或 Core 环境未就绪，已阻止构建。",
            package_id
        ));
    }
    let custom_library_roots = [
        ck_root_dir()
            .join("board-package-libraries")
            .join(package_id),
        ck_root_dir().join("libraries").join(package_id),
    ];
    for package_library_root in custom_library_roots {
        if !package_library_root.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&package_library_root).map_err(|error| {
            format!(
                "无法读取板卡包 {} 的依赖目录，已阻止构建：{}",
                package_id, error
            )
        })?;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dependency = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown");
            let report = package_quality::read_quality_report_with_integrity(&path);
            let trusted = report.as_ref().is_some_and(|report| {
                board_dependency_quality_report_is_trusted(report, dependency)
            });
            if !trusted {
                return Err(format!(
                    "板卡包 {} 的依赖 {} 缺少有效质量报告或内容已变化，已阻止构建。",
                    package_id, dependency
                ));
            }
        }
    }
    Ok(package_id.to_string())
}

/// A bundled board dependency is either a native Arduino library or a Blockly
/// library with native sources. `library` was never emitted by the current
/// inspector and accepting it here would hide a cross-component contract bug.
fn board_dependency_quality_report_is_trusted(
    report: &package_quality::PackageQualityReport,
    expected_package_id: &str,
) -> bool {
    matches!(
        report.package_kind.as_str(),
        "arduino-library" | "block-library"
    ) && report.package_id.as_deref() == Some(expected_package_id)
        && matches!(report.status.as_str(), "passed" | "passed_with_warnings")
        && report.enforce().is_ok()
}

#[cfg(test)]
mod board_dependency_quality_tests {
    use super::board_dependency_quality_report_is_trusted;
    use crate::package_quality::PackageQualityReport;

    fn passed_report(kind: &str) -> PackageQualityReport {
        let mut report = PackageQualityReport::new(kind);
        report.package_id = Some("acme-library".to_string());
        report.pass("fixture", "fixture passed");
        report.finalize();
        report
    }

    #[test]
    fn native_and_block_library_reports_are_valid_board_dependencies() {
        assert!(board_dependency_quality_report_is_trusted(
            &passed_report("arduino-library"),
            "acme-library"
        ));
        assert!(board_dependency_quality_report_is_trusted(
            &passed_report("block-library"),
            "acme-library"
        ));
    }

    #[test]
    fn unrelated_or_pending_reports_are_not_board_dependencies() {
        assert!(!board_dependency_quality_report_is_trusted(
            &passed_report("board"),
            "acme-library"
        ));
        assert!(!board_dependency_quality_report_is_trusted(
            &passed_report("library"),
            "acme-library"
        ));
        assert!(!board_dependency_quality_report_is_trusted(
            &passed_report("arduino-library"),
            "other-library"
        ));
        assert!(!board_dependency_quality_report_is_trusted(
            &PackageQualityReport::new("arduino-library"),
            "acme-library"
        ));
    }
}

fn parse_arduino_cli_user_dir(yaml_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let content = std::fs::read_to_string(yaml_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("user:") {
            continue;
        }
        let raw = trimmed.trim_start_matches("user:").trim();
        if raw.is_empty() {
            continue;
        }
        let cleaned = raw.trim_matches('"').trim_matches('\'').trim();
        if cleaned.is_empty() {
            continue;
        }
        let candidate = std::path::PathBuf::from(cleaned);
        if candidate.is_absolute() {
            return Some(candidate);
        }
        if let Some(parent) = yaml_path.parent() {
            return Some(parent.join(candidate));
        }
    }
    None
}

fn collect_arduino_user_library_dirs(sysroot_root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut push_unique = |path: std::path::PathBuf| {
        let key = normalize_path_key(&path);
        if seen.insert(key) {
            out.push(path);
        }
    };

    // Default directory from our generated arduino-cli.yaml template.
    push_unique(sysroot_root.join("sketchbook").join("libraries"));

    // Respect user override in arduino-cli.yaml if present.
    if let Some(user_dir) = parse_arduino_cli_user_dir(&sysroot_root.join("arduino-cli.yaml")) {
        push_unique(user_dir.join("libraries"));
    }

    // Keep CK isolated from the native Arduino IDE sketchbook.  A customer's
    // `%USERPROFILE%/Documents/Arduino/libraries` is owned by Arduino IDE and
    // must neither be modified nor implicitly injected into CK builds: a
    // generic library there (for example Arduino WiFi Shield's `WiFi.h`) can
    // otherwise shadow the selected board Core.  CK libraries belong in the
    // managed sysroot sketchbook above or in an explicitly configured path.

    out
}

/// Resolve the installed platform library directory for the complete target.
///
/// Arduino CLI gives a platform's built-in libraries precedence over a generic
/// sketchbook library with the same public name (for example ESP32's WiFi
/// library versus an Arduino WiFi Shield library).  CK's precise user-library
/// resolver passes selected roots explicitly, so it must know which roots are
/// platform-owned before it constructs that explicit list.  This helper is
/// deliberately read-only and bounded to the managed `packages` tree; an
/// invalid or out-of-tree path returns no result and leaves the native CLI to
/// perform its normal resolution.
fn installed_platform_root_for_library_precedence(
    sysroot_root: &std::path::Path,
    fqbn: &str,
) -> Option<std::path::PathBuf> {
    let mut parts = fqbn.split(':');
    let vendor = parts.next()?.trim();
    let architecture = parts.next()?.trim();
    let board = parts.next()?.trim();
    if !is_valid_fqbn_token(vendor)
        || !is_valid_fqbn_token(architecture)
        || !is_valid_fqbn_token(board)
    {
        return None;
    }

    let base = sysroot_root
        .join("packages")
        .join(vendor)
        .join("hardware")
        .join(architecture);
    let versions = std::fs::read_dir(&base)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect::<Vec<_>>();
    // Keep this precedence lookup aligned with the Core identity used by
    // Forge/board-passport.  In the normal CLI setup the selected Core is the
    // highest installed version, but using the shared installed-version
    // resolver first also handles suffixed mirror folders such as 3.3.6-cn
    // without inventing a version alias.
    let selected = forge_installed_core_version(sysroot_root, fqbn).or_else(|| {
        ck_core::builder::core_version::select_core_version(
            versions,
            ck_core::builder::core_version::CoreVersionSelectionStrategy::HighestInstalled,
        )
    })?;
    let platform = base.join(&selected);
    let packages_root = std::fs::canonicalize(sysroot_root.join("packages")).ok()?;
    let canonical_platform = std::fs::canonicalize(&platform).ok()?;
    (canonical_platform.is_dir() && canonical_platform.starts_with(&packages_root))
        .then_some(canonical_platform)
}

fn installed_platform_library_roots_for_precedence(
    sysroot_root: &std::path::Path,
    fqbn: &str,
) -> Vec<std::path::PathBuf> {
    let Some(platform_root) = installed_platform_root_for_library_precedence(sysroot_root, fqbn)
    else {
        return Vec::new();
    };
    let libraries = platform_root.join("libraries");
    let Ok(canonical_libraries) = std::fs::canonicalize(&libraries) else {
        return Vec::new();
    };
    if !canonical_libraries.is_dir() || !canonical_libraries.starts_with(&platform_root) {
        return Vec::new();
    }

    let mut roots = std::fs::read_dir(&canonical_libraries)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| std::fs::canonicalize(entry.path()).ok())
        .filter(|path| *path != canonical_libraries && path.starts_with(&canonical_libraries))
        .collect::<Vec<_>>();
    roots.sort_by_key(|path| normalize_path_key(path));
    roots.dedup_by(|left, right| normalize_path_key(left) == normalize_path_key(right));
    roots
}

fn arduino_library_identity_keys_for_precedence(library_root: &std::path::Path) -> HashSet<String> {
    let mut keys = HashSet::new();
    if let Some(folder_name) = candidate_match_name(library_root) {
        let normalized = normalize_match_name(&folder_name);
        if !normalized.is_empty() {
            keys.insert(normalized);
        }
    }

    let (metadata, _) = load_arduino_user_library_metadata(library_root);
    if let Some(name) = metadata.manifest_name_norm {
        if !name.is_empty() {
            keys.insert(name);
        }
    }
    if let Some(id) = metadata.manifest_id_norm {
        if !id.is_empty() {
            keys.insert(id);
        }
    }
    keys
}

/// Prevent a generic sketchbook provider from shadowing a selected Core
/// library.  We only remove a user root when all of the following are true:
/// - the current target's installed Core has a library with the same identity;
/// - the user root is actually selected for a header in this sketch; and
/// - the conflicting header is one the Core library exposes.
///
/// The user's Arduino sketchbook is never modified.  Other user libraries,
/// including a library that merely happens to be installed, remain untouched.
fn prune_user_libraries_shadowed_by_platform(
    user_libraries: Vec<std::path::PathBuf>,
    platform_libraries: &[std::path::PathBuf],
    required_headers: &[String],
) -> (Vec<std::path::PathBuf>, Vec<String>) {
    if user_libraries.is_empty() || platform_libraries.is_empty() || required_headers.is_empty() {
        return (user_libraries, Vec::new());
    }

    let mut platform_by_name = HashMap::<String, Vec<&std::path::PathBuf>>::new();
    for platform in platform_libraries {
        for name in arduino_library_identity_keys_for_precedence(platform) {
            platform_by_name.entry(name).or_default().push(platform);
        }
    }

    let required_keys = required_headers
        .iter()
        .flat_map(|header| header_lookup_keys(header))
        .collect::<HashSet<_>>();
    let mut kept = Vec::with_capacity(user_libraries.len());
    let mut dropped = Vec::new();
    for user_library in user_libraries {
        let user_names = arduino_library_identity_keys_for_precedence(&user_library);
        let matching_platforms = user_names
            .iter()
            .filter_map(|name| platform_by_name.get(name))
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let name_conflict = !matching_platforms.is_empty();
        let mut matching_platform_headers = HashSet::<String>::new();
        let mut seen_matching_platforms = HashSet::<String>::new();
        for platform in matching_platforms {
            if !seen_matching_platforms.insert(normalize_path_key(platform)) {
                continue;
            }
            for header in scan_library_headers_cached(platform) {
                matching_platform_headers.extend(header_lookup_keys(&header));
            }
        }
        let header_conflict = scan_library_headers_cached(&user_library)
            .into_iter()
            .flat_map(|header| header_lookup_keys(&header))
            .any(|header| {
                required_keys.contains(&header) && matching_platform_headers.contains(&header)
            });
        if name_conflict && header_conflict {
            dropped.push(user_library.to_string_lossy().to_string());
        } else {
            kept.push(user_library);
        }
    }
    (kept, dropped)
}

fn filter_arduino_include_matches_by_paths(
    include_matches: Vec<String>,
    kept_libraries: &[std::path::PathBuf],
) -> Vec<String> {
    let kept_keys = kept_libraries
        .iter()
        .map(|path| normalize_path_key(path))
        .collect::<HashSet<_>>();
    include_matches
        .into_iter()
        .filter(|line| {
            let Some((_, provider)) = line.rsplit_once(" -> ") else {
                return true;
            };
            kept_keys.contains(&normalize_path_key(std::path::Path::new(provider.trim())))
        })
        .collect()
}

fn split_arduino_dependency_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0u32;
    for ch in raw.chars() {
        match ch {
            '(' => {
                paren_depth = paren_depth.saturating_add(1);
                current.push(ch);
            }
            ')' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if paren_depth == 0 => {
                let name = current.split('(').next().unwrap_or("").trim();
                if !name.is_empty() {
                    out.push(name.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let name = current.split('(').next().unwrap_or("").trim();
    if !name.is_empty() {
        out.push(name.to_string());
    }
    out
}

fn push_arduino_json_dependency_names(out: &mut Vec<String>, value: &serde_json::Value) {
    match value {
        serde_json::Value::String(raw) => out.extend(split_arduino_dependency_list(raw)),
        serde_json::Value::Array(items) => {
            for item in items {
                match item {
                    serde_json::Value::String(raw) => {
                        out.extend(split_arduino_dependency_list(raw));
                    }
                    serde_json::Value::Object(map) => {
                        for field in ["name", "id"] {
                            if let Some(raw) = map.get(field).and_then(|v| v.as_str()) {
                                out.push(raw.to_string());
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        // PlatformIO-style dependency objects use the dependency name as the key.
        serde_json::Value::Object(map) => out.extend(map.keys().cloned()),
        _ => {}
    }
}

fn load_arduino_user_library_metadata(
    lib_path: &std::path::Path,
) -> (LibraryCandidateMeta, Vec<String>) {
    let mut meta = load_library_candidate_meta(lib_path);
    let mut dependency_names: Vec<String> = Vec::new();

    if let Ok(content) = std::fs::read_to_string(lib_path.join("library.properties")) {
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            let Some((raw_key, raw_value)) = line.split_once('=') else {
                continue;
            };
            let key = raw_key.trim().to_ascii_lowercase();
            let value = raw_value.trim();
            match key.as_str() {
                "name" if !value.is_empty() => {
                    meta.manifest_name_norm = Some(normalize_match_name(value));
                }
                "version" => meta.manifest_version = parse_version_rank(value),
                "architectures" | "architecture" => {
                    push_manifest_tokens(&mut meta.architecture_keys, value);
                }
                "includes" => {
                    for include in value.split([',', ';']) {
                        if let Some(normalized) = normalized_header_key(include) {
                            meta.include_keys.insert(normalized);
                        }
                    }
                }
                "depends" => dependency_names.extend(split_arduino_dependency_list(value)),
                _ => {}
            }
        }
    }

    if let Ok(content) = std::fs::read_to_string(lib_path.join("library.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            for field in ["depends", "dependencies"] {
                if let Some(value) = json.get(field) {
                    push_arduino_json_dependency_names(&mut dependency_names, value);
                }
            }
        }
    }

    let mut dependency_name_keys: Vec<String> = dependency_names
        .into_iter()
        .map(|name| normalize_match_name(&name))
        .filter(|name| !name.is_empty())
        .collect();
    dependency_name_keys.sort();
    dependency_name_keys.dedup();
    (meta, dependency_name_keys)
}

fn collect_arduino_user_library_candidates_from_roots(
    roots: &[std::path::PathBuf],
) -> Vec<ArduinoUserLibraryCandidate> {
    let mut root_list = roots.to_vec();
    root_list.sort_by_key(|path| normalize_path_key(path));
    let mut candidates: Vec<ArduinoUserLibraryCandidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for root in root_list {
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
        for entry in entries {
            let path = entry.path();
            if !path.is_dir() || !seen.insert(normalize_path_key(&path)) {
                continue;
            }
            let headers = scan_library_headers_cached(&path);
            if headers.is_empty() {
                continue;
            }
            let (meta, dependency_name_keys) = load_arduino_user_library_metadata(&path);
            candidates.push(ArduinoUserLibraryCandidate {
                library: LibraryCandidate {
                    path,
                    headers,
                    source: LibSource::Global,
                    meta,
                },
                dependency_name_keys,
            });
        }
    }
    candidates.sort_by_key(|candidate| normalize_path_key(&candidate.library.path));
    candidates
}

fn pick_best_arduino_dependency_candidate(
    provider_indices: &[usize],
    candidates: &[ArduinoUserLibraryCandidate],
    board_arch: &str,
) -> usize {
    let score = |idx: usize| {
        let candidate = &candidates[idx].library;
        (
            candidate_architecture_match_score(candidate, board_arch),
            candidate.meta.manifest_version.unwrap_or_default(),
            candidate_path_depth_bias(&candidate.path),
        )
    };
    let mut best_idx = provider_indices[0];
    let mut best_score = score(best_idx);
    for &idx in provider_indices.iter().skip(1) {
        let current_score = score(idx);
        if current_score > best_score {
            best_idx = idx;
            best_score = current_score;
        }
    }
    best_idx
}

fn resolve_arduino_user_library_candidates(
    required_headers: &[String],
    candidates: &[ArduinoUserLibraryCandidate],
    board_arch: &str,
) -> ArduinoUserLibraryResolution {
    let mut selected: HashSet<usize> = HashSet::new();
    let mut selected_queue: Vec<usize> = Vec::new();
    let mut include_matches: Vec<String> = Vec::new();
    let mut include_unmatched: Vec<String> = Vec::new();
    let libraries: Vec<LibraryCandidate> = candidates
        .iter()
        .map(|candidate| candidate.library.clone())
        .collect();

    for required_header in required_headers {
        let provider_indices: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter_map(|(idx, candidate)| {
                let library = &candidate.library;
                (candidate_architecture_match_score(library, board_arch) > 0
                    && candidate_header_match_score(library, required_header) > 0)
                    .then_some(idx)
            })
            .collect();
        if provider_indices.is_empty() {
            include_unmatched.push(required_header.clone());
            continue;
        }
        let best_idx = pick_best_candidate_for_header(
            &provider_indices,
            &libraries,
            required_header,
            board_arch,
        );
        if selected.insert(best_idx) {
            selected_queue.push(best_idx);
        }
        let final_path = finalize_candidate_path_for_cli(
            &candidates[best_idx].library.path,
            Some(required_header),
        );
        include_matches.push(format!("{} -> {}", required_header, final_path.display()));
    }

    // Arduino's `depends=` is part of the library discovery contract. Since
    // fast profiles no longer expose the complete sketchbook, explicitly add
    // each installed declared dependency (including transitive dependencies)
    // to the same stable shim as the direct provider.
    let mut candidate_name_map: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, candidate) in candidates.iter().enumerate() {
        if candidate_architecture_match_score(&candidate.library, board_arch) == 0 {
            continue;
        }
        for key in candidate_name_keys(&candidate.library) {
            candidate_name_map.entry(key).or_default().push(idx);
        }
    }
    let mut cursor = 0usize;
    while cursor < selected_queue.len() {
        let current_idx = selected_queue[cursor];
        cursor += 1;
        for dependency_key in &candidates[current_idx].dependency_name_keys {
            let Some(provider_indices) = candidate_name_map.get(dependency_key) else {
                continue;
            };
            let best_idx =
                pick_best_arduino_dependency_candidate(provider_indices, candidates, board_arch);
            if selected.insert(best_idx) {
                selected_queue.push(best_idx);
            }
        }
    }

    let mut final_libs: Vec<std::path::PathBuf> = selected
        .into_iter()
        .map(|idx| finalize_candidate_path_for_cli(&candidates[idx].library.path, None))
        .collect();
    final_libs = ck_core::builder::signature::normalize_and_sort_paths(&final_libs);
    include_matches.sort();
    include_unmatched.sort();
    ArduinoUserLibraryResolution {
        final_libs,
        include_matches,
        include_unmatched,
    }
}

fn resolve_arduino_user_libraries(
    sysroot_root: &std::path::Path,
    required_headers: &[String],
    board_arch: &str,
) -> ArduinoUserLibraryResolution {
    if required_headers.is_empty() {
        return ArduinoUserLibraryResolution::default();
    }
    let roots = collect_arduino_user_library_dirs(sysroot_root);
    let candidates = collect_arduino_user_library_candidates_from_roots(&roots);
    resolve_arduino_user_library_candidates(required_headers, &candidates, board_arch)
}

#[cfg(test)]
mod precise_arduino_user_library_tests {
    use super::{
        collect_arduino_user_library_candidates_from_roots, headers_not_provided_by_library_paths,
        installed_platform_library_roots_for_precedence, normalize_path_key,
        prune_user_libraries_shadowed_by_platform, resolve_arduino_user_library_candidates,
    };
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ck-precise-user-libs-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture directory");
        }
        std::fs::write(path, content).expect("write fixture file");
    }

    fn library(
        libraries_root: &Path,
        folder: &str,
        name: &str,
        depends: Option<&str>,
        header: &str,
    ) -> PathBuf {
        let root = libraries_root.join(folder);
        let depends_line = depends
            .map(|value| format!("depends={value}\n"))
            .unwrap_or_default();
        write(
            &root,
            "library.properties",
            &format!(
                "name={name}\nversion=1.0.0\narchitectures=*\nincludes={header}\n{depends_line}"
            ),
        );
        write(&root, &format!("src/{header}"), "#pragma once\n");
        root
    }

    #[test]
    fn core_wifi_header_remains_unmatched_when_no_user_library_provides_it() {
        let root = fixture_root("wifi-core");
        let libraries = root.join("libraries");
        library(&libraries, "Other", "Other", None, "Other.h");
        let candidates = collect_arduino_user_library_candidates_from_roots(&[libraries.clone()]);
        let resolved =
            resolve_arduino_user_library_candidates(&["WiFi.h".to_string()], &candidates, "esp32");

        assert!(resolved.final_libs.is_empty());
        assert_eq!(resolved.include_unmatched, vec!["WiFi.h"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sketch_without_includes_has_an_empty_precise_scope() {
        let root = fixture_root("no-include");
        let libraries = root.join("libraries");
        library(&libraries, "Unused", "Unused", None, "Unused.h");
        let candidates = collect_arduino_user_library_candidates_from_roots(&[libraries.clone()]);
        let resolved = resolve_arduino_user_library_candidates(&[], &candidates, "esp32");

        assert_eq!(resolved, Default::default());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn modern_top_level_and_recursive_src_headers_select_native_library_roots() {
        let root = fixture_root("native-src");
        let libraries = root.join("libraries");
        let top = library(&libraries, "TopNative", "Top Native", None, "TopNative.h");
        write(
            &top,
            "src/top_native.c",
            "int top_native(void) { return 1; }\n",
        );
        let deep = library(
            &libraries,
            "DeepNative",
            "Deep Native",
            None,
            "vendor/DeepNative.h",
        );
        write(
            &deep,
            "src/vendor/native/deep_native.c",
            "int deep_native(void) { return 2; }\n",
        );
        let candidates = collect_arduino_user_library_candidates_from_roots(&[libraries.clone()]);
        let resolved = resolve_arduino_user_library_candidates(
            &["TopNative.h".to_string(), "vendor/DeepNative.h".to_string()],
            &candidates,
            "esp32",
        );
        let selected: Vec<String> = resolved
            .final_libs
            .iter()
            .map(|path| normalize_path_key(path))
            .collect();

        assert!(selected.contains(&normalize_path_key(&top)));
        assert!(selected.contains(&normalize_path_key(&deep)));
        assert!(resolved.include_unmatched.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn equal_user_library_providers_have_a_stable_path_tiebreaker() {
        let root = fixture_root("stable-provider");
        let libraries = root.join("libraries");
        let z = library(
            &libraries,
            "z_provider",
            "Duplicate Provider",
            None,
            "Dupe.h",
        );
        let a = library(
            &libraries,
            "a_provider",
            "Duplicate Provider",
            None,
            "Dupe.h",
        );
        let candidates = collect_arduino_user_library_candidates_from_roots(&[
            libraries.clone(),
            libraries.clone(),
        ]);
        let resolved =
            resolve_arduino_user_library_candidates(&["Dupe.h".to_string()], &candidates, "esp32");

        assert_eq!(resolved.final_libs, vec![a]);
        assert!(!resolved.final_libs.contains(&z));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn board_scoped_ck_fallback_keeps_priority_over_same_header_user_library() {
        let root = fixture_root("ck-priority");
        let libraries = root.join("arduino-libraries");
        let ck_board_library = root.join("board-package-libraries/board-scope/Fallback");
        write(
            &ck_board_library,
            "library.json",
            r#"{"name":"Trusted board fallback","version":"1.0.0"}"#,
        );
        write(&ck_board_library, "src/Shared.h", "#pragma once\n");
        library(
            &libraries,
            "GlobalShared",
            "Global Shared",
            None,
            "Shared.h",
        );
        let required = vec!["Shared.h".to_string()];
        let remaining = headers_not_provided_by_library_paths(
            &required,
            std::slice::from_ref(&ck_board_library),
        );
        assert!(
            remaining.is_empty(),
            "trusted CK fallback must consume the header first"
        );

        let candidates = collect_arduino_user_library_candidates_from_roots(&[libraries.clone()]);
        let user_resolution =
            resolve_arduino_user_library_candidates(&remaining, &candidates, "esp32");
        assert!(user_resolution.final_libs.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn compile_and_upload_share_the_same_transitive_depends_scope() {
        let root = fixture_root("depends-chain");
        let libraries = root.join("libraries");
        let main = library(
            &libraries,
            "MainLib",
            "Main Library",
            Some("Dependency One (>=1.0.0)"),
            "Main.h",
        );
        let dependency_one = library(
            &libraries,
            "DependencyOne",
            "Dependency One",
            Some("Dependency Two (=1.0.0)"),
            "DependencyOne.h",
        );
        let dependency_two = library(
            &libraries,
            "DependencyTwo",
            "Dependency Two",
            None,
            "DependencyTwo.h",
        );
        let candidates = collect_arduino_user_library_candidates_from_roots(&[libraries.clone()]);
        let headers = vec!["Main.h".to_string()];

        // Both Tauri entry points call this exact shared resolver before their
        // respective build signatures are computed.
        let compile_scope = resolve_arduino_user_library_candidates(&headers, &candidates, "esp32");
        let upload_scope = resolve_arduino_user_library_candidates(&headers, &candidates, "esp32");
        assert_eq!(compile_scope, upload_scope);
        let selected: Vec<String> = compile_scope
            .final_libs
            .iter()
            .map(|path| normalize_path_key(path))
            .collect();
        for expected in [main, dependency_one, dependency_two] {
            assert!(selected.contains(&normalize_path_key(&expected)));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn platform_library_precedence_skips_only_same_named_user_provider() {
        let root = fixture_root("platform-precedence");
        let platform_wifi = root.join("packages/esp32/hardware/esp32/3.3.6/libraries/WiFi");
        write(
            &platform_wifi,
            "library.properties",
            "name=WiFi\nversion=3.3.0\narchitectures=esp32\nincludes=WiFi.h\n",
        );
        write(&platform_wifi, "src/WiFi.h", "#pragma once\n");

        let platform_other =
            root.join("packages/esp32/hardware/esp32/3.3.6/libraries/PlatformOnly");
        write(
            &platform_other,
            "library.properties",
            "name=PlatformOnly\nversion=1.0.0\narchitectures=esp32\nincludes=PlatformOnly.h\n",
        );
        write(&platform_other, "src/PlatformOnly.h", "#pragma once\n");

        let user_root = root.join("sketchbook/libraries");
        let user_wifi = library(&user_root, "WiFi", "WiFi", None, "WiFi.h");
        let user_unrelated = library(&user_root, "Unrelated", "Unrelated", None, "Unrelated.h");

        let platform_libraries =
            installed_platform_library_roots_for_precedence(&root, "esp32:esp32:esp32c6");
        let canonical_platform_wifi = std::fs::canonicalize(&platform_wifi).expect("platform WiFi");
        assert!(
            platform_libraries.iter().any(
                |path| normalize_path_key(path) == normalize_path_key(&canonical_platform_wifi)
            )
        );

        let (kept, dropped) = prune_user_libraries_shadowed_by_platform(
            vec![user_wifi.clone(), user_unrelated.clone()],
            &platform_libraries,
            &["WiFi.h".to_string(), "Unrelated.h".to_string()],
        );
        assert!(
            !kept
                .iter()
                .any(|path| normalize_path_key(path) == normalize_path_key(&user_wifi))
        );
        assert!(
            kept.iter()
                .any(|path| normalize_path_key(path) == normalize_path_key(&user_unrelated))
        );
        assert_eq!(dropped, vec![user_wifi.to_string_lossy().to_string()]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn platform_precedence_is_noop_without_a_matching_platform_library() {
        let root = fixture_root("platform-precedence-noop");
        let user_root = root.join("sketchbook/libraries");
        let user_wifi = library(&user_root, "WiFi", "WiFi", None, "WiFi.h");
        let (kept, dropped) = prune_user_libraries_shadowed_by_platform(
            vec![user_wifi.clone()],
            &[],
            &["WiFi.h".to_string()],
        );
        assert_eq!(kept, vec![user_wifi]);
        assert!(dropped.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}

fn collect_ck_fallback_search_roots(
    fqbn: &str,
    board_arch: &str,
) -> Vec<(std::path::PathBuf, LibSource)> {
    let mut out: Vec<(std::path::PathBuf, LibSource)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let push_unique_existing = |dst: &mut Vec<(std::path::PathBuf, LibSource)>,
                                seen_set: &mut HashSet<String>,
                                path: std::path::PathBuf,
                                source: LibSource| {
        if !path.exists() || !path.is_dir() {
            return;
        }
        let key = normalize_path_key(&path);
        if seen_set.insert(key) {
            dst.push((path, source));
        }
    };

    let safe_board = fqbn
        .split(':')
        .take_while(|part| !part.contains('='))
        .collect::<Vec<&str>>()
        .join(":")
        .replace(':', "_");

    {
        let ck_dir = ck_root_dir();
        push_unique_existing(
            &mut out,
            &mut seen,
            ck_dir.join("libraries").join(&safe_board),
            LibSource::BoardSpecific,
        );
        push_unique_existing(
            &mut out,
            &mut seen,
            ck_dir.join("board-package-libraries").join(&safe_board),
            LibSource::BoardSpecific,
        );
        if !board_arch.trim().is_empty() && board_arch != "unknown" {
            push_unique_existing(
                &mut out,
                &mut seen,
                ck_dir.join("libraries").join(board_arch),
                LibSource::ArchitectureSpecific,
            );
        }
    }

    out
}

fn is_header_like_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "h" | "hpp" | "hh" | "hxx"
            )
        })
        .unwrap_or(false)
}

fn fallback_file_matches_header(file_path: &std::path::Path, required_header: &str) -> bool {
    if !is_header_like_file(file_path) {
        return false;
    }
    let normalized_file = file_path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    for lookup_key in header_lookup_keys(required_header) {
        if lookup_key.contains('/') {
            if normalized_file.ends_with(&lookup_key) {
                return true;
            }
            continue;
        }
        if file_name == lookup_key {
            return true;
        }
    }
    false
}

fn infer_fallback_library_root(
    header_file: &std::path::Path,
    search_root: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let mut current = header_file.parent()?;
    loop {
        if current == search_root {
            return None;
        }
        let current_name = current.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if current_name.eq_ignore_ascii_case("src") || current_name.eq_ignore_ascii_case("lib") {
            return current.parent().map(|p| p.to_path_buf());
        }
        if current.join("library.json").exists() || current.join("library.properties").exists() {
            return Some(current.to_path_buf());
        }
        let parent = current.parent()?;
        if parent == search_root {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
}

fn collect_ck_library_fallback_matches(
    unresolved_headers: &[String],
    fqbn: &str,
    board_arch: &str,
) -> Vec<std::path::PathBuf> {
    if unresolved_headers.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (search_root, _) in collect_ck_fallback_search_roots(fqbn, board_arch) {
        let walker = walkdir::WalkDir::new(&search_root).max_depth(6).into_iter();
        for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.'))
        {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if !unresolved_headers
                .iter()
                .any(|header| fallback_file_matches_header(path, header))
            {
                continue;
            }
            let Some(lib_root) = infer_fallback_library_root(path, &search_root) else {
                continue;
            };
            if scan_library_headers_cached(&lib_root).is_empty() {
                continue;
            }
            let key = normalize_path_key(&lib_root);
            if seen.insert(key) {
                out.push(lib_root);
            }
        }
    }
    out
}

fn headers_not_provided_by_library_paths(
    headers: &[String],
    library_paths: &[std::path::PathBuf],
) -> Vec<String> {
    headers
        .iter()
        .filter(|required_header| {
            !library_paths.iter().any(|library_path| {
                let candidate = LibraryCandidate {
                    path: library_path.clone(),
                    headers: scan_library_headers_cached(library_path),
                    source: LibSource::BoardSpecific,
                    meta: load_library_candidate_meta(library_path),
                };
                candidate_header_match_score(&candidate, required_header) > 0
            })
        })
        .cloned()
        .collect()
}

fn is_likely_platform_or_toolchain_header(header: &str) -> bool {
    let normalized = header.trim().replace('\\', "/").to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let base = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    if normalized.starts_with("avr/")
        || normalized.starts_with("sys/")
        || normalized.starts_with("machine/")
    {
        return true;
    }
    matches!(
        base,
        "arduino.h"
            | "wprogram.h"
            | "wire.h"
            | "spi.h"
            | "stdint.h"
            | "stddef.h"
            | "stdbool.h"
            | "stdlib.h"
            | "string.h"
            | "strings.h"
            | "math.h"
            | "limits.h"
            | "float.h"
            | "ctype.h"
            | "stdio.h"
            | "time.h"
    )
}

fn filter_user_unresolved_headers(headers: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for h in headers {
        if is_likely_platform_or_toolchain_header(h) {
            continue;
        }
        let key = h.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            out.push(h.clone());
        }
    }
    out
}

fn path_looks_recursive_shim(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase().contains("_recursive_"))
        .unwrap_or(false)
}

fn is_busio_library_root(path: &std::path::Path) -> bool {
    let raw_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let name_norm = normalize_match_name(&raw_name);
    name_norm == "adafruitbusio" || name_norm == "busio"
}

fn is_legacy_busio_fragment_root(path: &std::path::Path) -> bool {
    let raw_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let name_norm = normalize_match_name(&raw_name);
    matches!(
        name_norm.as_str(),
        "i2cdevice" | "spidevice" | "genericdevice" | "adafruiti2cdevice" | "adafruitspidevice"
    )
}

fn library_contains_header(path: &std::path::Path, header_name: &str) -> bool {
    path.join(header_name).is_file() || path.join("src").join(header_name).is_file()
}

fn collect_installed_adafruit_busio_roots(
    sysroot_root: &std::path::Path,
) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push_unique = |path: std::path::PathBuf| {
        if !path.exists() || !path.is_dir() {
            return;
        }
        let key = normalize_path_key(&path);
        if seen.insert(key) {
            out.push(path);
        }
    };

    for root in collect_arduino_user_library_dirs(sysroot_root) {
        if !root.exists() || !root.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name_norm =
                    normalize_match_name(entry.file_name().to_str().unwrap_or_default());
                if name_norm == "adafruitbusio"
                    || name_norm == "busio"
                    || (library_contains_header(&path, "Adafruit_I2CDevice.h")
                        && library_contains_header(&path, "Adafruit_BusIO_Register.h"))
                {
                    push_unique(path);
                }
            }
        }
    }

    out
}

fn is_busio_source_file(path: &std::path::Path) -> bool {
    if !path.is_file() || !is_compilable_source_file(path) {
        return false;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        file_name.as_str(),
        "adafruit_busio_register.c"
            | "adafruit_busio_register.cc"
            | "adafruit_busio_register.cpp"
            | "adafruit_busio_register.cxx"
            | "adafruit_i2cdevice.c"
            | "adafruit_i2cdevice.cc"
            | "adafruit_i2cdevice.cpp"
            | "adafruit_i2cdevice.cxx"
            | "adafruit_spidevice.c"
            | "adafruit_spidevice.cc"
            | "adafruit_spidevice.cpp"
            | "adafruit_spidevice.cxx"
            | "adafruit_genericdevice.c"
            | "adafruit_genericdevice.cc"
            | "adafruit_genericdevice.cpp"
            | "adafruit_genericdevice.cxx"
    )
}

fn is_busio_header_file(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "h" | "hpp" | "hh" | "hxx") {
        return false;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        file_name.as_str(),
        "adafruit_busio_register.h"
            | "adafruit_busio_register.hpp"
            | "adafruit_i2cdevice.h"
            | "adafruit_i2cdevice.hpp"
            | "adafruit_spidevice.h"
            | "adafruit_spidevice.hpp"
            | "adafruit_genericdevice.h"
            | "adafruit_genericdevice.hpp"
    )
}

fn busio_source_count(lib_path: &std::path::Path) -> usize {
    get_or_scan_busio_stats(lib_path).0
}

fn scan_busio_stats_uncached(lib_path: &std::path::Path) -> (usize, bool) {
    if !lib_path.exists() || !lib_path.is_dir() {
        return (0, false);
    }
    let walker = walkdir::WalkDir::new(lib_path).max_depth(8).into_iter();
    let mut busio_count = 0usize;
    let mut has_non_busio = false;
    for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.')) {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if is_busio_source_file(path) {
            busio_count += 1;
            continue;
        }
        if !has_non_busio && is_compilable_source_file(path) {
            has_non_busio = true;
        }
    }
    (busio_count, has_non_busio)
}

fn get_or_scan_busio_stats(lib_path: &std::path::Path) -> (usize, bool) {
    if !lib_path.exists() || !lib_path.is_dir() {
        return (0, false);
    }
    let cache_key = normalize_path_key(lib_path);
    let mtime_ms = library_scan_signature_ms(lib_path);
    if let Ok(mut guard) = busio_scan_cache().lock() {
        if let Some(cached) = guard.get(&cache_key) {
            if cached.mtime_ms == mtime_ms {
                return (cached.busio_source_count, cached.has_non_busio_sources);
            }
        }
        let (busio_source_count, has_non_busio_sources) = scan_busio_stats_uncached(lib_path);
        guard.insert(
            cache_key,
            CachedBusioScanEntry {
                mtime_ms,
                busio_source_count,
                has_non_busio_sources,
            },
        );
        return (busio_source_count, has_non_busio_sources);
    }
    scan_busio_stats_uncached(lib_path)
}

fn path_provides_required_header(path: &std::path::Path, required_headers: &[String]) -> bool {
    let headers = scan_library_headers_cached(path);
    if headers.is_empty() {
        return false;
    }
    let modern_layout = path.join("src").is_dir()
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("src"))
            .unwrap_or(false);
    if modern_layout {
        let available: HashSet<String> = headers
            .iter()
            .filter_map(|header| normalized_header_key(header))
            .collect();
        return required_headers
            .iter()
            .filter_map(|header| normalized_header_key(header))
            .any(|header| available.contains(&header));
    }
    let req_keys: HashSet<String> = required_headers
        .iter()
        .map(|h| header_basename_lower(h))
        .collect();
    headers
        .iter()
        .flat_map(|header| header_lookup_keys(header))
        .any(|h| req_keys.contains(&h))
}

fn copy_dir_recursive_skip_busio_sources(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive_skip_busio_sources(&src_path, &dst_path)?;
        } else if ty.is_file() {
            // Remove both BusIO implementation and BusIO headers from non-provider shims,
            // so include resolution cannot accidentally bind to an incomplete shim.
            if is_busio_source_file(&src_path) || is_busio_header_file(&src_path) {
                continue;
            }
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn create_no_busio_shim(original_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let lib_name = original_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lib");
    let safe_name = lib_name.replace(' ', "_");
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    normalize_path_key(original_path).hash(&mut hasher);
    let path_hash = hasher.finish();

    let temp_dir = std::env::temp_dir()
        .join("CK_LibShim")
        .join(format!("{}_nobusio_{:x}", safe_name, path_hash));
    if temp_dir.exists() {
        return Some(temp_dir);
    }

    if copy_dir_recursive_skip_busio_sources(original_path, &temp_dir).is_err() {
        return None;
    }

    if !temp_dir.join("library.properties").exists() {
        let _ = fs::write(
            temp_dir.join("library.properties"),
            format!(
                "name=ck-nobusio-shim-{}\nversion=1.0.0\nauthor=CK\narchitectures=*\n",
                safe_name
            ),
        );
    }
    Some(temp_dir)
}

fn should_skip_source_for_arch(
    path: &std::path::Path,
    board_arch: &str,
    lib_root: &std::path::Path,
) -> bool {
    if !path.is_file() || !is_compilable_source_file(path) {
        return false;
    }
    if !board_arch.eq_ignore_ascii_case("avr") {
        return false;
    }
    // Conservative, library-specific pruning: Adafruit_NeoPixel contains platform-only files
    // that are never used on AVR but still cost compile time.
    if !library_contains_header(lib_root, "Adafruit_NeoPixel.h") {
        return false;
    }
    let file = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        file.as_str(),
        "adafruit_neopixel_rp2.cpp" | "esp.c" | "esp8266.c" | "kendyte_k210.c" | "psoc6.c"
    )
}

fn copy_dir_recursive_arch_pruned(
    src: &std::path::Path,
    dst: &std::path::Path,
    board_arch: &str,
    lib_root: &std::path::Path,
    skipped: &mut usize,
) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive_arch_pruned(&src_path, &dst_path, board_arch, lib_root, skipped)?;
        } else if ty.is_file() {
            if should_skip_source_for_arch(&src_path, board_arch, lib_root) {
                *skipped += 1;
                continue;
            }
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn create_arch_pruned_shim(
    original_path: &std::path::Path,
    board_arch: &str,
) -> Option<(std::path::PathBuf, usize)> {
    if !board_arch.eq_ignore_ascii_case("avr") {
        return None;
    }
    if !library_contains_header(original_path, "Adafruit_NeoPixel.h") {
        return None;
    }

    let lib_name = original_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lib");
    let safe_name = lib_name.replace(' ', "_");
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    normalize_path_key(original_path).hash(&mut hasher);
    board_arch.to_ascii_lowercase().hash(&mut hasher);
    library_scan_signature_ms(original_path).hash(&mut hasher);
    let key_hash = hasher.finish();

    let temp_dir = std::env::temp_dir()
        .join("CK_LibShim")
        .join(format!("{}_archprune_{:x}", safe_name, key_hash));
    if temp_dir.exists() {
        return Some((temp_dir, 0));
    }

    let mut skipped = 0usize;
    if copy_dir_recursive_arch_pruned(
        original_path,
        &temp_dir,
        board_arch,
        original_path,
        &mut skipped,
    )
    .is_err()
    {
        return None;
    }
    if skipped == 0 {
        return None;
    }
    Some((temp_dir, skipped))
}

fn busio_dedupe_input_hash(libs: &[std::path::PathBuf], required_headers: &[String]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for p in libs {
        normalize_path_key(p).hash(&mut hasher);
        library_scan_signature_ms(p).hash(&mut hasher);
    }
    for header in required_headers {
        header.trim().to_ascii_lowercase().hash(&mut hasher);
    }
    hasher.finish()
}

fn dedupe_busio_symbol_providers(
    libs: Vec<std::path::PathBuf>,
    required_headers: &[String],
) -> (Vec<std::path::PathBuf>, Vec<String>) {
    let input_hash = busio_dedupe_input_hash(&libs, required_headers);
    if let Ok(guard) = busio_dedupe_cache().lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.input_hash == input_hash && cached.libs.iter().all(|p| p.exists()) {
                return (cached.libs.clone(), cached.notes.clone());
            }
        }
    }

    let mut notes: Vec<String> = Vec::new();
    if libs.len() <= 1 {
        return (libs, notes);
    }

    let mut providers: Vec<(usize, usize)> = Vec::new(); // (index, busio_source_count)
    let mut provider_count_by_idx: HashMap<usize, usize> = HashMap::new();
    let mut provider_has_non_busio_by_idx: HashMap<usize, bool> = HashMap::new();
    for (idx, path) in libs.iter().enumerate() {
        let (count, has_non_busio) = get_or_scan_busio_stats(path);
        if count > 0 {
            providers.push((idx, count));
            provider_count_by_idx.insert(idx, count);
            provider_has_non_busio_by_idx.insert(idx, has_non_busio);
        }
    }
    if providers.len() <= 1 {
        return (libs, notes);
    }

    let mut preferred_provider_idx = providers[0].0;
    let mut best_score = i32::MIN;
    for (idx, count) in &providers {
        let path = &libs[*idx];
        let norm = normalize_path_key(path);
        let mut score = 0i32;
        if is_busio_library_root(path) {
            score += 100;
        }
        if is_legacy_busio_fragment_root(path) {
            score -= 80;
        }
        if norm.contains("/sketchbook/libraries/") {
            score += 60;
        }
        if !path_looks_recursive_shim(path) {
            score += 10;
        }
        score += (*count as i32) * 5;
        if score > best_score {
            best_score = score;
            preferred_provider_idx = *idx;
        }
    }

    notes.push(format!(
        "BusIO provider selected: {}",
        libs[preferred_provider_idx].display()
    ));

    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for (idx, path) in libs.into_iter().enumerate() {
        let count = *provider_count_by_idx.get(&idx).unwrap_or(&0);
        let has_non_busio_sources = *provider_has_non_busio_by_idx.get(&idx).unwrap_or(&false);

        if count == 0 || idx == preferred_provider_idx {
            out.push(path);
            continue;
        }

        let pure_busio_provider_like = is_busio_library_root(&path)
            || is_legacy_busio_fragment_root(&path)
            || (library_contains_header(&path, "Adafruit_BusIO_Register.h")
                && !has_non_busio_sources);
        if pure_busio_provider_like {
            notes.push(format!(
                "BusIO conflict dropped provider-like path: {}",
                path.display()
            ));
            continue;
        }

        let keep_non_busio_logic =
            has_non_busio_sources || path_provides_required_header(&path, required_headers);
        if keep_non_busio_logic {
            if let Some(shim) = create_no_busio_shim(&path) {
                notes.push(format!(
                    "BusIO conflict shimmed: {} -> {}",
                    path.display(),
                    shim.display()
                ));
                out.push(shim);
            } else {
                notes.push(format!(
                    "BusIO conflict shim failed, keeping original path: {}",
                    path.display()
                ));
                out.push(path);
            }
        } else {
            notes.push(format!("BusIO conflict dropped path: {}", path.display()));
        }
    }

    let mut deduped: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for p in out {
        let key = normalize_path_key(&p);
        if seen.insert(key) {
            deduped.push(p);
        }
    }

    let result = (deduped, notes);
    if let Ok(mut guard) = busio_dedupe_cache().lock() {
        *guard = Some(CachedBusioDedupeEntry {
            input_hash,
            libs: result.0.clone(),
            notes: result.1.clone(),
        });
    }
    result
}

fn prune_conflicting_embedded_libraries(
    libs: Vec<std::path::PathBuf>,
) -> (Vec<std::path::PathBuf>, Vec<String>) {
    // Conservative pruning only:
    // - remove exact duplicate paths
    // - remove explicit embedded BusIO sub-library paths that are already covered by the parent recursive shim
    // Do NOT drop standalone Adafruit_BusIO roots here; provider selection is handled in dedupe_busio_symbol_providers.
    let mut kept: Vec<std::path::PathBuf> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for p in libs {
        let key = normalize_path_key(&p);
        if !seen.insert(key.clone()) {
            dropped.push(p.to_string_lossy().to_string());
            continue;
        }
        if key.contains("_recursive_") && key.ends_with("/adafruit_busio") {
            dropped.push(p.to_string_lossy().to_string());
            continue;
        }
        kept.push(p);
    }
    (kept, dropped)
}

fn load_lib_cache_from_disk() -> HashMap<String, CachedHeaderEntry> {
    let mut out = HashMap::new();
    let Some(index_path) = header_index_file_path() else {
        return out;
    };
    let content = match std::fs::read_to_string(index_path) {
        Ok(c) => c,
        Err(_) => return out,
    };
    let parsed: HeaderIndexFile = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return out,
    };
    for (k, v) in parsed.entries {
        let key = {
            #[cfg(target_os = "windows")]
            {
                k.to_ascii_lowercase()
            }
            #[cfg(not(target_os = "windows"))]
            {
                k
            }
        };
        out.insert(
            key,
            CachedHeaderEntry {
                mtime_ms: v.mtime_ms,
                headers: v.headers.into_iter().collect(),
            },
        );
    }
    out
}

fn persist_lib_cache_to_disk(cache: &HashMap<String, CachedHeaderEntry>) {
    let Some(index_path) = header_index_file_path() else {
        return;
    };
    if let Some(parent) = index_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut entries = HashMap::new();
    for (path_key, entry) in cache {
        let mut headers: Vec<String> = entry.headers.iter().cloned().collect();
        headers.sort();
        entries.insert(
            path_key.clone(),
            HeaderIndexEntryFile {
                mtime_ms: entry.mtime_ms,
                headers,
            },
        );
    }
    let file = HeaderIndexFile {
        version: 1,
        entries,
    };
    if let Ok(data) = serde_json::to_string_pretty(&file) {
        let _ = std::fs::write(index_path, data);
    }
}

fn get_lib_cache() -> &'static Mutex<HashMap<String, CachedHeaderEntry>> {
    LIB_HEADER_CACHE.get_or_init(|| Mutex::new(load_lib_cache_from_disk()))
}

fn flush_lib_cache_to_disk_if_dirty() {
    if !LIB_HEADER_CACHE_DIRTY.swap(false, Ordering::AcqRel) {
        return;
    }
    if let Ok(guard) = get_lib_cache().lock() {
        persist_lib_cache_to_disk(&guard);
    }
}

/// Cached header scan with memory + disk index.
fn scan_library_headers_cached(lib_path: &std::path::Path) -> HashSet<String> {
    let cache_key = normalize_path_key(lib_path);
    let mtime_ms = library_scan_signature_ms(lib_path);
    let cache = get_lib_cache();
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(&cache_key) {
            if cached.mtime_ms == mtime_ms {
                return cached.headers.clone();
            }
        }
    }

    // Cache miss or stale: do actual scan.
    let headers = scan_library_headers(lib_path);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(
            cache_key,
            CachedHeaderEntry {
                mtime_ms,
                headers: headers.clone(),
            },
        );
        LIB_HEADER_CACHE_DIRTY.store(true, Ordering::Release);
    }
    headers
}

#[cfg(test)]
mod recursive_library_discovery_tests {
    use super::{
        LibSource, LibraryCandidate, candidate_header_match_score,
        candidate_library_signatures_match, candidate_manifest_include_score,
        finalize_candidate_path_for_cli, library_scan_signature_ms, load_library_candidate_meta,
        normalize_library_path_for_cli, normalize_path_key, scan_library_headers,
        scan_library_headers_cached,
    };

    fn fixture(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ck-library-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn write_fixture(root: &std::path::Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().expect("fixture parent")).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn modern_src_headers_keep_deep_relative_paths_and_same_named_files() {
        let root = fixture("modern-headers");
        write_fixture(&root, "src/Root.h", "#pragma once\n");
        write_fixture(&root, "src/internal/a/Common.h", "#define COMMON_A 1\n");
        write_fixture(&root, "src/internal/b/Common.h", "#define COMMON_B 1\n");
        write_fixture(
            &root,
            "src/one/two/three/four/five/Deep.hpp",
            "#pragma once\n",
        );
        write_fixture(&root, "examples/Ignored.h", "#error ignored\n");

        let headers = scan_library_headers(&root);
        assert!(headers.contains("Root.h"));
        assert!(headers.contains("internal/a/Common.h"));
        assert!(headers.contains("internal/b/Common.h"));
        assert!(headers.contains("one/two/three/four/five/Deep.hpp"));
        assert!(!headers.contains("Ignored.h"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recursive_signature_and_header_cache_change_for_deep_files() {
        let root = fixture("recursive-cache");
        write_fixture(&root, "src/public/Initial.h", "#pragma once\n");
        let before_signature = library_scan_signature_ms(&root);
        let before_headers = scan_library_headers_cached(&root);
        assert!(before_headers.contains("public/Initial.h"));

        write_fixture(
            &root,
            "src/vendor/driver/private/NewHeader.h",
            "#define NEW_HEADER 123456\n",
        );
        let after_signature = library_scan_signature_ms(&root);
        let after_headers = scan_library_headers_cached(&root);
        assert_ne!(before_signature, after_signature);
        assert!(after_headers.contains("vendor/driver/private/NewHeader.h"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn candidate_cache_signature_rejects_deep_add_delete_and_equal_length_replace() {
        let root = fixture("candidate-deep-invalidation");
        write_fixture(&root, "src/nested/Stable.h", "#define VALUE 111\n");

        let signatures = || vec![(normalize_path_key(&root), library_scan_signature_ms(&root))];
        let initial = signatures();
        assert!(candidate_library_signatures_match(&initial));

        write_fixture(&root, "src/nested/deeper/Added.h", "#pragma once\n");
        assert!(
            !candidate_library_signatures_match(&initial),
            "a deep header addition must invalidate a candidate-cache hit"
        );

        let after_add = signatures();
        std::fs::remove_file(root.join("src/nested/deeper/Added.h")).unwrap();
        assert!(
            !candidate_library_signatures_match(&after_add),
            "a deep header deletion must invalidate a candidate-cache hit"
        );

        let before_replace = signatures();
        write_fixture(&root, "src/nested/Stable.h", "#define VALUE 222\n");
        assert!(
            !candidate_library_signatures_match(&before_replace),
            "an equal-length in-place replacement must invalidate by content"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_headers_use_root_and_utility_only() {
        let root = fixture("legacy-headers");
        write_fixture(&root, "Legacy.h", "#pragma once\n");
        write_fixture(&root, "utility/deep/Helper.h", "#pragma once\n");
        write_fixture(&root, "vendor/NotArduino.h", "#error ignored\n");

        let headers = scan_library_headers(&root);
        assert!(headers.contains("Legacy.h"));
        assert!(headers.contains("utility/deep/Helper.h"));
        assert!(!headers.contains("vendor/NotArduino.h"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn json_only_library_keeps_package_root_for_recursive_compatibility_adapter() {
        let root = fixture("json-compat-root");
        write_fixture(
            &root,
            "library.json",
            r#"{"name":"Native source fixture","version":"1.0.0"}"#,
        );
        write_fixture(&root, "src/Public.h", "#pragma once\n");
        write_fixture(
            &root,
            "src/internal/native.c",
            "int native_value(void){return 1;}\n",
        );

        assert_eq!(normalize_library_path_for_cli(&root), root);
        assert_eq!(normalize_library_path_for_cli(&root.join("src")), root);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn modern_nested_headers_match_only_their_real_include_path() {
        let root = fixture("modern-header-path");
        write_fixture(&root, "src/Public.h", "#pragma once\n");
        write_fixture(&root, "src/internal/Common.h", "#pragma once\n");
        write_fixture(
            &root,
            "library.json",
            r#"{"name":"Header paths","version":"1.0.0","includes":["internal/Common.h"]}"#,
        );
        write_fixture(
            &root,
            "library.properties",
            "name=Header paths\nversion=1.0.0\narchitectures=*\nincludes=internal/Common.h\n",
        );
        let candidate = LibraryCandidate {
            path: root.clone(),
            headers: scan_library_headers(&root),
            source: LibSource::Global,
            meta: load_library_candidate_meta(&root),
        };

        assert_eq!(candidate_header_match_score(&candidate, "Common.h"), 0);
        assert_eq!(
            candidate_header_match_score(&candidate, "internal/Common.h"),
            3
        );
        assert_eq!(candidate_header_match_score(&candidate, "Public.h"), 2);
        assert_eq!(candidate_manifest_include_score(&candidate, "Common.h"), 0);
        assert_eq!(
            candidate_manifest_include_score(&candidate, "internal/Common.h"),
            3
        );
        assert_eq!(
            finalize_candidate_path_for_cli(&root, Some("internal/Common.h")),
            root,
            "a canonical src layout must not be rewritten into a nested legacy shim"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}

fn has_root_headers(lib_path: &std::path::Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(lib_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("h") || ext.eq_ignore_ascii_case("hpp") {
                    return true;
                }
            }
        }
    }
    false
}

fn has_headers_recursive(dir: &std::path::Path) -> bool {
    if !dir.exists() || !dir.is_dir() {
        return false;
    }
    for entry in walkdir::WalkDir::new(dir)
        .max_depth(6)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.'))
    {
        if let Ok(entry) = entry {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("h") || ext.eq_ignore_ascii_case("hpp") {
                    return true;
                }
            }
        }
    }
    false
}

fn looks_like_library_container_dir(path: &std::path::Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }
    if path.join("library.properties").exists() || path.join("library.json").exists() {
        return false;
    }
    if path.join("src").is_dir() || path.join("lib").is_dir() {
        return false;
    }

    let mut has_direct_source_or_header = false;
    let mut has_subdirs = false;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                has_subdirs = true;
                continue;
            }
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(
                ext.as_str(),
                "h" | "hpp" | "hh" | "hxx" | "c" | "cc" | "cpp" | "cxx" | "ino" | "s"
            ) {
                has_direct_source_or_header = true;
                break;
            }
        }
    }
    has_subdirs && !has_direct_source_or_header
}

fn normalize_library_path_for_cli(path: &std::path::Path) -> std::path::PathBuf {
    // Keep the package root for CK manifest libraries. ck_core uses library.json
    // to create a temporary library.properties + recursive src compatibility
    // adapter; returning src directly here would hide that manifest and make
    // Arduino treat nested sources as a flat legacy library.
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.eq_ignore_ascii_case("src"))
        .unwrap_or(false)
    {
        if let Some(parent) = path.parent() {
            if parent.join("library.properties").exists() || parent.join("library.json").exists() {
                return parent.to_path_buf();
            }
        }
        return path.to_path_buf();
    }

    // Some custom libraries only provide headers under src/ and have no library.properties.
    // Arduino CLI can reject the root as "no header files found", but accepts src directly.
    let src_path = path.join("src");
    if src_path.is_dir() {
        let has_discovery_manifest =
            path.join("library.properties").exists() || path.join("library.json").exists();
        if !has_discovery_manifest && !has_root_headers(path) && has_headers_recursive(&src_path) {
            return src_path;
        }
    }

    path.to_path_buf()
}

// Helpers for Shim
fn create_legacy_lib_shim(original_path: &std::path::Path) -> Option<std::path::PathBuf> {
    // 1. Determine safe library name from Parent of 'lib' folder
    // e.g. "C:\...\Adafruit_NeoPixel\lib" -> "Adafruit_NeoPixel"
    let lib_name = original_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())?;

    let safe_name = lib_name.replace(" ", "_");

    // 2. Resolve Temp Dir
    let temp_dir = std::env::temp_dir().join("CK_LibShim").join(&safe_name);

    // 3. Create structure: Temp/CK_LibShim/LibName/src
    let src_dir = temp_dir.join("src");

    // PERF: Reuse existing shim if already created (libraries don't change during session)
    if src_dir.exists() {
        println!("[LibShim] Reusing cached shim: {:?}", temp_dir);
        return Some(temp_dir);
    }

    if let Err(e) = fs::create_dir_all(&src_dir) {
        println!("[LibShim] Failed to create dir {:?}: {}", src_dir, e);
        return None;
    }

    // 4. Copy files from original 'lib' to 'src'
    // Flatten copy: we take all files from 'lib' and put them in 'src'
    // Deep recursive copy might be needed if user has subfolders in lib?
    // User requested "lib/Adafruit_NeoPixel.h", so it matches.
    if let Ok(entries) = fs::read_dir(original_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(fname) = path.file_name() {
                    let dest = src_dir.join(fname);
                    let _ = fs::copy(&path, &dest);
                }
            } else if path.is_dir() {
                // Recursive copy for subfolders in lib (e.g. utility)
                let dirname = path.file_name().unwrap();
                let dest_subdir = src_dir.join(dirname);
                let _ = copy_dir_recursive(&path, &dest_subdir);
            }
        }
    }

    println!("[LibShim] Shimmed {:?} -> {:?}", original_path, temp_dir);
    Some(temp_dir)
}

fn is_compilable_source_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "c" | "cc" | "cpp" | "cxx" | "ino" | "s"
            )
        })
        .unwrap_or(false)
}

fn contains_compilable_sources(dir: &std::path::Path, max_depth: usize) -> bool {
    if !dir.exists() || !dir.is_dir() {
        return false;
    }

    let walker = walkdir::WalkDir::new(dir).max_depth(max_depth).into_iter();
    for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.')) {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() && is_compilable_source_file(path) {
                return true;
            }
        }
    }
    false
}

fn should_use_recursive_src_shim(lib_path: &std::path::Path) -> bool {
    if !lib_path.exists() || !lib_path.is_dir() {
        return false;
    }

    if lib_path.join("src").is_dir() {
        return false;
    }

    if lib_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("lib"))
        .unwrap_or(false)
    {
        return false;
    }

    // Detect includes like "Adafruit_BusIO/Adafruit_I2CDevice.h" where the prefix points
    // to a sibling directory containing additional .cpp files that legacy mode won't compile.
    let Ok(entries) = fs::read_dir(lib_path) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_dependency_scan_source_file(&path) {
            continue;
        }
        let Ok(raw) = fs::read(&path) else {
            continue;
        };
        if raw.is_empty() || raw.len() > 2_000_000 {
            continue;
        }
        let text = String::from_utf8_lossy(&raw);
        for include in get_required_headers(&text) {
            let normalized = include.replace('\\', "/");
            let Some((prefix, _)) = normalized.split_once('/') else {
                continue;
            };
            let trimmed = prefix.trim();
            if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
                continue;
            }
            let nested_dir = lib_path.join(trimmed);
            if nested_dir.is_dir() && contains_compilable_sources(&nested_dir, 6) {
                return true;
            }
        }
    }

    false
}

fn create_recursive_src_shim(original_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let lib_name = original_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("lib");
    let safe_name = lib_name.replace(' ', "_");
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    normalize_path_key(original_path).hash(&mut hasher);
    let path_hash = hasher.finish();

    let temp_dir = std::env::temp_dir()
        .join("CK_LibShim")
        .join(format!("{}_recursive_{:x}", safe_name, path_hash));
    let src_dir = temp_dir.join("src");

    if src_dir.exists() {
        println!("[LibShim] Reusing recursive shim: {:?}", temp_dir);
        return Some(temp_dir);
    }

    if let Err(e) = fs::create_dir_all(&src_dir) {
        println!(
            "[LibShim] Failed to create recursive shim dir {:?}: {}",
            src_dir, e
        );
        return None;
    }

    if let Ok(entries) = fs::read_dir(original_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let dest = src_dir.join(&name);
            if path.is_dir() {
                if is_candidate_scan_ignored_dir(&name_str) {
                    continue;
                }
                let _ = copy_dir_recursive(&path, &dest);
            } else if path.is_file() {
                let is_archive = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "7z" | "zip" | "rar" | "tar" | "gz" | "bz2" | "xz"
                        )
                    })
                    .unwrap_or(false);
                if is_archive {
                    continue;
                }
                let _ = fs::copy(&path, &dest);
            }
        }
    }

    let _ = fs::write(
        temp_dir.join("library.properties"),
        format!(
            "name=ck-recursive-shim-{}\nversion=1.0.0\nauthor=CK\narchitectures=*\n",
            safe_name
        ),
    );

    println!(
        "[LibShim] Shimmed legacy recursive lib {:?} -> {:?}",
        original_path, temp_dir
    );
    Some(temp_dir)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(&entry.path(), &dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

// Helper to check if a header is nested inside src/SubDir/
fn check_nested_src(lib_path: &std::path::Path, header: &str) -> Option<std::path::PathBuf> {
    let src_path = lib_path.join("src");
    if !src_path.exists() {
        return None;
    }

    // Scan src recursively
    let walker = walkdir::WalkDir::new(&src_path).max_depth(3).into_iter();
    for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.')) {
        if let Ok(entry) = entry {
            if entry.path().is_file() {
                if let Some(name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    if name.eq_ignore_ascii_case(header) {
                        // Found header! Check if it's directly in src
                        if let Some(parent) = entry.path().parent() {
                            if parent != src_path {
                                // It is nested! Return the parent folder (e.g. src/Adafruit_NeoPixel)
                                return Some(parent.to_path_buf());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

// Helper to shim nested src
fn shim_nested_src(
    lib_root: &std::path::Path,
    nested_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    // 1. Determine safe library name
    let lib_name = lib_root.file_name().and_then(|n| n.to_str())?;
    let safe_name = lib_name.replace(" ", "_") + "_shim";

    // 2. Resolve Temp Dir
    let temp_dir = std::env::temp_dir().join("CK_LibShim").join(&safe_name);

    // Clean
    // PERF: Reuse existing shim if already created
    if temp_dir.exists() {
        println!("[LibShim] Reusing cached nested shim: {:?}", temp_dir);
        return Some(temp_dir);
    }

    // 3. Copy EVERYTHING from original lib to temp
    if let Err(e) = copy_dir_recursive(lib_root, &temp_dir) {
        println!("[LibShim] Failed to copy lib to temp: {}", e);
        return None;
    }

    // 4. Determine path of nested dir INSIDE temp
    if let Ok(rel_path) = nested_dir.strip_prefix(lib_root) {
        let temp_nested = temp_dir.join(rel_path);
        let temp_src = temp_dir.join("src");

        // 5. Move contents of temp_nested to temp_src
        if let Ok(entries) = std::fs::read_dir(&temp_nested) {
            for entry in entries.flatten() {
                let path = entry.path();
                let fname = path.file_name().unwrap();
                let dest = temp_src.join(fname);
                let _ = std::fs::rename(&path, &dest); // Move
            }
        }
    }

    println!("[LibShim] Shimmed Nested {:?} -> {:?}", lib_root, temp_dir);
    Some(temp_dir)
}

use tauri::{AppHandle, Emitter, Manager, State};

struct ActiveSerialMonitor {
    monitor: ck_core::executor::uploader::monitor::SerialMonitor,
    port: String,
    baud: u32,
    sample: Arc<Mutex<Option<Vec<u8>>>>,
    _serial_operation_guard: device_health::SerialOperationGuard,
}

impl ActiveSerialMonitor {
    fn close(self) -> Result<(), String> {
        let ActiveSerialMonitor {
            monitor,
            _serial_operation_guard,
            ..
        } = self;
        let close_result = monitor
            .close()
            .map_err(|error| format!("串口关闭失败，端口释放状态无法确认：{error:#}"));

        // Keep the global serial-operation lease until the reader has stopped
        // and both cloned OS port handles have been dropped. Upload/device
        // health may only acquire the port after close has really completed.
        drop(_serial_operation_guard);
        close_result
    }
}

struct MonitorState {
    monitor: Mutex<Option<ActiveSerialMonitor>>,
}

#[cfg(target_os = "windows")]
fn terminate_owned_process_tree_sync(process_id: u32) {
    let mut taskkill = std::process::Command::new("taskkill");
    taskkill
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    no_window(&mut taskkill);
    let _ = taskkill.status();
}

#[cfg(not(target_os = "windows"))]
fn terminate_owned_process_tree_sync(process_id: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &process_id.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[derive(Default)]
struct InstallProcessRegistry {
    active: HashMap<u64, InstallProcessEntry>,
    termination_requested: HashSet<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallProcessScope {
    CoreInstall,
    PackageTool,
}

struct InstallProcessEntry {
    process_id: u32,
    scope: InstallProcessScope,
    #[cfg(target_os = "windows")]
    process_keepalive: Option<Arc<std::os::windows::io::OwnedHandle>>,
}

#[derive(Clone)]
struct InstallProcessTarget {
    process_id: u32,
    #[cfg(target_os = "windows")]
    _process_keepalive: Option<Arc<std::os::windows::io::OwnedHandle>>,
}

struct InstallStateInner {
    registry: Mutex<InstallProcessRegistry>,
    next_generation: std::sync::atomic::AtomicU64,
    shutdown_requested: AtomicBool,
}

#[derive(Clone)]
struct InstallState {
    inner: Arc<InstallStateInner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InstallShutdownReport {
    initially_active: usize,
    remaining_active: usize,
    timed_out: bool,
}

struct InstallProcessGuard {
    inner: Arc<InstallStateInner>,
    generation: u64,
}

impl InstallState {
    fn new() -> Self {
        Self {
            inner: Arc::new(InstallStateInner {
                registry: Mutex::new(InstallProcessRegistry::default()),
                next_generation: std::sync::atomic::AtomicU64::new(1),
                shutdown_requested: AtomicBool::new(false),
            }),
        }
    }

    #[cfg(test)]
    fn register_process(&self, process_id: u32, scope: InstallProcessScope) -> InstallProcessGuard {
        let generation = self
            .inner
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut registry) = self.inner.registry.lock() {
            registry.active.insert(
                generation,
                InstallProcessEntry {
                    process_id,
                    scope,
                    #[cfg(target_os = "windows")]
                    process_keepalive: None,
                },
            );
        }
        let guard = InstallProcessGuard {
            inner: Arc::clone(&self.inner),
            generation,
        };

        // Close the race where shutdown starts between spawn() and registry
        // insertion. Only this newly registered PID is claimed and terminated.
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            guard.request_termination();
        }
        guard
    }

    fn spawn_registered_process(
        &self,
        command: &mut std::process::Command,
        description: &str,
        scope: InstallProcessScope,
    ) -> Result<(std::process::Child, InstallProcessGuard), String> {
        // Serialize the terminal transition with spawn + registration. The
        // shutdown coordinator therefore either sees this child, or this call
        // observes shutdown and never creates it.
        let mut registry = self
            .inner
            .registry
            .lock()
            .map_err(|_| "Failed to lock install process registry".to_string())?;
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return Err("Application shutdown is already in progress".to_string());
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start {description}: {error}"))?;
        #[cfg(target_os = "windows")]
        let process_keepalive = {
            use std::os::windows::io::AsHandle;
            match child.as_handle().try_clone_to_owned() {
                Ok(handle) => Some(Arc::new(handle)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Failed to retain process identity for {description}: {error}"
                    ));
                }
            }
        };
        let generation = self
            .inner
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        registry.active.insert(
            generation,
            InstallProcessEntry {
                process_id: child.id(),
                scope,
                #[cfg(target_os = "windows")]
                process_keepalive,
            },
        );
        drop(registry);
        Ok((
            child,
            InstallProcessGuard {
                inner: Arc::clone(&self.inner),
                generation,
            },
        ))
    }

    fn claim_unterminated(
        &self,
        scope_filter: Option<InstallProcessScope>,
    ) -> Vec<InstallProcessTarget> {
        let Ok(mut registry) = self.inner.registry.lock() else {
            return Vec::new();
        };
        let candidates = registry
            .active
            .iter()
            .filter_map(|(generation, process)| {
                (!registry.termination_requested.contains(generation)
                    && scope_filter.is_none_or(|scope| process.scope == scope))
                .then_some((
                    *generation,
                    InstallProcessTarget {
                        process_id: process.process_id,
                        #[cfg(target_os = "windows")]
                        _process_keepalive: process.process_keepalive.clone(),
                    },
                ))
            })
            .collect::<Vec<_>>();
        for (generation, _) in &candidates {
            registry.termination_requested.insert(*generation);
        }
        candidates.into_iter().map(|(_, process)| process).collect()
    }

    fn cancel_active_processes(&self) -> usize {
        let processes = self.claim_unterminated(None);
        for process in &processes {
            terminate_owned_process_tree_sync(process.process_id);
        }
        processes.len()
    }

    #[cfg(test)]
    fn cancel_active_processes_with(&self, terminate: impl Fn(u32)) -> usize {
        let processes = self.claim_unterminated(None);
        for process in &processes {
            terminate(process.process_id);
        }
        processes.len()
    }

    fn active_process_count(&self) -> usize {
        self.inner
            .registry
            .lock()
            .map(|registry| registry.active.len())
            .unwrap_or_default()
    }

    fn active_process_count_for_scope(&self, scope: InstallProcessScope) -> usize {
        self.inner
            .registry
            .lock()
            .map(|registry| {
                registry
                    .active
                    .values()
                    .filter(|process| process.scope == scope)
                    .count()
            })
            .unwrap_or_default()
    }

    fn cancel_core_install_processes(&self) -> usize {
        let processes = self.claim_unterminated(Some(InstallProcessScope::CoreInstall));
        for process in &processes {
            terminate_owned_process_tree_sync(process.process_id);
        }
        processes.len()
    }

    #[cfg(test)]
    fn cancel_core_install_processes_with(&self, terminate: impl Fn(u32)) -> usize {
        let processes = self.claim_unterminated(Some(InstallProcessScope::CoreInstall));
        for process in &processes {
            terminate(process.process_id);
        }
        processes.len()
    }

    fn cancel_and_wait(&self, timeout: std::time::Duration) -> InstallShutdownReport {
        let initially_active = self.active_process_count();
        self.cancel_active_processes();
        let started = std::time::Instant::now();
        loop {
            let remaining_active = self.active_process_count();
            if remaining_active == 0 {
                return InstallShutdownReport {
                    initially_active,
                    remaining_active: 0,
                    timed_out: false,
                };
            }
            self.cancel_active_processes();
            if started.elapsed() >= timeout {
                return InstallShutdownReport {
                    initially_active,
                    remaining_active,
                    timed_out: true,
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn cancel_core_install_and_wait(&self, timeout: std::time::Duration) -> InstallShutdownReport {
        let initially_active =
            self.active_process_count_for_scope(InstallProcessScope::CoreInstall);
        self.cancel_core_install_processes();
        let started = std::time::Instant::now();
        loop {
            let remaining_active =
                self.active_process_count_for_scope(InstallProcessScope::CoreInstall);
            if remaining_active == 0 {
                return InstallShutdownReport {
                    initially_active,
                    remaining_active: 0,
                    timed_out: false,
                };
            }
            self.cancel_core_install_processes();
            if started.elapsed() >= timeout {
                return InstallShutdownReport {
                    initially_active,
                    remaining_active,
                    timed_out: true,
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn shutdown_and_wait(&self, timeout: std::time::Duration) -> InstallShutdownReport {
        if let Ok(registry) = self.inner.registry.lock() {
            self.inner.shutdown_requested.store(true, Ordering::Release);
            drop(registry);
        } else {
            self.inner.shutdown_requested.store(true, Ordering::Release);
        }
        self.cancel_and_wait(timeout)
    }
}

const PACKAGE_TOOL_STDOUT_MAX_BYTES: usize = 8 * 1024 * 1024;
const PACKAGE_TOOL_STDERR_MAX_BYTES: usize = 2 * 1024 * 1024;
const PROCESS_STREAM_READ_CHUNK_BYTES: usize = 4 * 1024;
const PROCESS_STREAM_EVENT_MAX_BYTES: usize = 16 * 1024;
const PROCESS_OUTPUT_TRUNCATION_MARKER: &[u8] =
    b"\n[CK PROCESS OUTPUT TRUNCATED: middle bytes omitted]\n";

struct BoundedProcessCapture {
    head: Vec<u8>,
    tail: Vec<u8>,
    head_limit: usize,
    tail_limit: usize,
    total_bytes: u64,
}

impl BoundedProcessCapture {
    fn new(max_bytes: usize) -> Self {
        assert!(max_bytes >= PROCESS_OUTPUT_TRUNCATION_MARKER.len());
        let payload = max_bytes - PROCESS_OUTPUT_TRUNCATION_MARKER.len();
        let head_limit = payload / 4;
        Self {
            head: Vec::new(),
            tail: Vec::new(),
            head_limit,
            tail_limit: payload - head_limit,
            total_bytes: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);
        let head_remaining = self.head_limit.saturating_sub(self.head.len());
        let head_take = head_remaining.min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_take]);
        let remaining = &bytes[head_take..];
        if self.tail_limit == 0 || remaining.is_empty() {
            return;
        }
        if remaining.len() >= self.tail_limit {
            self.tail.clear();
            self.tail
                .extend_from_slice(&remaining[remaining.len() - self.tail_limit..]);
            return;
        }
        self.tail.extend_from_slice(remaining);
        if self.tail.len() > self.tail_limit {
            let overflow = self.tail.len() - self.tail_limit;
            self.tail.drain(..overflow);
        }
    }

    fn finish(self) -> Vec<u8> {
        let retained_payload = self.head_limit + self.tail_limit;
        let truncated = self.total_bytes > retained_payload as u64;
        let mut output = Vec::with_capacity(
            self.head.len()
                + self.tail.len()
                + usize::from(truncated) * PROCESS_OUTPUT_TRUNCATION_MARKER.len(),
        );
        output.extend_from_slice(&self.head);
        if truncated {
            output.extend_from_slice(PROCESS_OUTPUT_TRUNCATION_MARKER);
        }
        output.extend_from_slice(&self.tail);
        output
    }
}

fn drain_process_output_bounded(
    mut reader: impl std::io::Read,
    max_bytes: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut capture = BoundedProcessCapture::new(max_bytes);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(capture.finish());
        }
        capture.push(&buffer[..read]);
    }
}

fn read_process_stream_fixed_chunks(
    mut reader: impl std::io::Read,
    mut on_chunk: impl FnMut(&str),
) -> Result<(), std::io::Error> {
    let mut buffer = [0_u8; PROCESS_STREAM_READ_CHUNK_BYTES];
    let mut carry = Vec::<u8>::with_capacity(3);
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            if !carry.is_empty() {
                let trailing = String::from_utf8_lossy(&carry);
                debug_assert!(trailing.len() <= PROCESS_STREAM_EVENT_MAX_BYTES);
                on_chunk(&trailing);
            }
            return Ok(());
        }
        let mut pending = Vec::with_capacity(carry.len() + read);
        pending.append(&mut carry);
        pending.extend_from_slice(&buffer[..read]);
        let mut remaining = pending.as_slice();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    debug_assert!(valid.len() <= PROCESS_STREAM_EVENT_MAX_BYTES);
                    on_chunk(valid);
                    break;
                }
                Err(error) => {
                    let valid_bytes = error.valid_up_to();
                    if valid_bytes > 0 {
                        let valid = std::str::from_utf8(&remaining[..valid_bytes])
                            .expect("from_utf8 valid prefix");
                        debug_assert!(valid.len() <= PROCESS_STREAM_EVENT_MAX_BYTES);
                        on_chunk(valid);
                    }
                    remaining = &remaining[valid_bytes..];
                    if let Some(invalid_len) = error.error_len() {
                        let invalid = String::from_utf8_lossy(&remaining[..invalid_len]);
                        debug_assert!(invalid.len() <= PROCESS_STREAM_EVENT_MAX_BYTES);
                        on_chunk(&invalid);
                        remaining = &remaining[invalid_len..];
                    } else {
                        carry.extend_from_slice(remaining);
                        debug_assert!(carry.len() <= 3);
                        break;
                    }
                }
            }
        }
    }
}

fn run_registered_install_output_with_limits(
    state: &InstallState,
    command: &mut std::process::Command,
    description: &str,
    stdout_max_bytes: usize,
    stderr_max_bytes: usize,
    scope: InstallProcessScope,
) -> Result<std::process::Output, String> {
    if state.inner.shutdown_requested.load(Ordering::Acquire) {
        return Err("Application shutdown is already in progress".to_string());
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let (mut child, process_guard) = state.spawn_registered_process(command, description, scope)?;
    let stdout = child.stdout.take().ok_or_else(|| {
        process_guard.request_termination();
        let _ = child.wait();
        format!("Failed to capture stdout for {description}")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        process_guard.request_termination();
        let _ = child.wait();
        format!("Failed to capture stderr for {description}")
    })?;
    let stdout_reader =
        std::thread::spawn(move || drain_process_output_bounded(stdout, stdout_max_bytes));
    let stderr_reader =
        std::thread::spawn(move || drain_process_output_bounded(stderr, stderr_max_bytes));
    // Child ownership remains with this caller. Even when shutdown kills the
    // registered tree, wait() reaps it. Both pipes are drained concurrently so
    // neither a newline-free stream nor a full OS pipe can deadlock the child.
    let status = match child.wait() {
        Ok(status) => Ok(status),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("Failed to wait for {description}: {error}"))
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("stdout reader panicked for {description}"))?
        .map_err(|error| format!("Failed to read stdout for {description}: {error}"));
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("stderr reader panicked for {description}"))?
        .map_err(|error| format!("Failed to read stderr for {description}: {error}"));
    drop(process_guard);
    Ok(std::process::Output {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn run_registered_install_output(
    state: &InstallState,
    command: &mut std::process::Command,
    description: &str,
) -> Result<std::process::Output, String> {
    run_registered_install_output_with_limits(
        state,
        command,
        description,
        PACKAGE_TOOL_STDOUT_MAX_BYTES,
        PACKAGE_TOOL_STDERR_MAX_BYTES,
        InstallProcessScope::PackageTool,
    )
}

fn run_registered_core_install_output(
    state: &InstallState,
    command: &mut std::process::Command,
    description: &str,
) -> Result<std::process::Output, String> {
    run_registered_install_output_with_limits(
        state,
        command,
        description,
        PACKAGE_TOOL_STDOUT_MAX_BYTES,
        PACKAGE_TOOL_STDERR_MAX_BYTES,
        InstallProcessScope::CoreInstall,
    )
}

impl InstallProcessGuard {
    fn termination_requested(&self) -> bool {
        self.inner
            .registry
            .lock()
            .map(|registry| registry.termination_requested.contains(&self.generation))
            .unwrap_or(true)
    }

    fn request_termination(&self) -> bool {
        let process = {
            let Ok(mut registry) = self.inner.registry.lock() else {
                return false;
            };
            let Some(process) = registry.active.get(&self.generation) else {
                return false;
            };
            let target = InstallProcessTarget {
                process_id: process.process_id,
                #[cfg(target_os = "windows")]
                _process_keepalive: process.process_keepalive.clone(),
            };
            if !registry.termination_requested.insert(self.generation) {
                return false;
            }
            target
        };
        terminate_owned_process_tree_sync(process.process_id);
        true
    }
}

impl Drop for InstallProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.inner.registry.lock() {
            registry.active.remove(&self.generation);
            registry.termination_requested.remove(&self.generation);
        }
    }
}

struct ActiveUploadSession {
    generation: u64,
    cancel_tx: tokio::sync::watch::Sender<bool>,
}

struct UploadStateInner {
    session: Mutex<Option<ActiveUploadSession>>,
    next_generation: std::sync::atomic::AtomicU64,
    shutdown_requested: AtomicBool,
}

struct UploadState {
    inner: Arc<UploadStateInner>,
}

struct UploadSessionGuard {
    inner: Arc<UploadStateInner>,
    generation: u64,
}

impl UploadState {
    fn new() -> Self {
        Self {
            inner: Arc::new(UploadStateInner {
                session: Mutex::new(None),
                next_generation: std::sync::atomic::AtomicU64::new(1),
                shutdown_requested: AtomicBool::new(false),
            }),
        }
    }

    fn begin_session(
        &self,
    ) -> Result<(tokio::sync::watch::Receiver<bool>, UploadSessionGuard), String> {
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let mut session = self
            .inner
            .session
            .lock()
            .map_err(|error| error.to_string())?;
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return Err("Application shutdown is already in progress".to_string());
        }
        if session.is_some() {
            return Err("Another upload session is already active".to_string());
        }
        let generation = self
            .inner
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *session = Some(ActiveUploadSession {
            generation,
            cancel_tx,
        });
        drop(session);
        Ok((
            cancel_rx,
            UploadSessionGuard {
                inner: Arc::clone(&self.inner),
                generation,
            },
        ))
    }

    fn request_cancel(&self) {
        if let Ok(session) = self.inner.session.lock() {
            if let Some(session) = session.as_ref() {
                let _ = session.cancel_tx.send(true);
            }
        }
    }

    fn shutdown_and_wait(&self, timeout: std::time::Duration) -> bool {
        // Serialize the terminal gate with begin_session so a session is either
        // counted before shutdown waits, or rejected before it can start.
        if let Ok(session) = self.inner.session.lock() {
            self.inner.shutdown_requested.store(true, Ordering::Release);
            if let Some(session) = session.as_ref() {
                let _ = session.cancel_tx.send(true);
            }
            drop(session);
        } else {
            self.inner.shutdown_requested.store(true, Ordering::Release);
        }
        let started = std::time::Instant::now();
        loop {
            let active = self
                .inner
                .session
                .lock()
                .map(|session| session.is_some())
                .unwrap_or(true);
            if !active {
                return true;
            }
            self.request_cancel();
            if started.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}

impl Drop for UploadSessionGuard {
    fn drop(&mut self) {
        if let Ok(mut session) = self.inner.session.lock() {
            let owns_current = session
                .as_ref()
                .map(|active| active.generation == self.generation)
                .unwrap_or(false);
            if owns_current {
                *session = None;
            }
        }
    }
}

#[derive(Default)]
struct ApplicationShutdownState {
    started: AtomicBool,
    completed: AtomicBool,
}

impl ApplicationShutdownState {
    fn begin_once(&self) -> bool {
        !self.started.swap(true, Ordering::AcqRel)
    }

    fn mark_completed(&self) {
        self.completed.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
struct ActiveForegroundBuild {
    generation: u64,
    cancellation: ck_core::builder::demo::BuildCancellation,
    finished_rx: tokio::sync::watch::Receiver<bool>,
}

#[derive(Default)]
struct ForegroundBuildRegistry {
    active: HashMap<String, ActiveForegroundBuild>,
    recently_finished: HashMap<String, std::time::Instant>,
}

struct ForegroundBuildState {
    registry: Arc<Mutex<ForegroundBuildRegistry>>,
    next_generation: std::sync::atomic::AtomicU64,
    shutdown_requested: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ForegroundShutdownReport {
    initially_active: usize,
    remaining_active: usize,
    timed_out: bool,
}

impl ForegroundBuildState {
    fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(ForegroundBuildRegistry::default())),
            next_generation: std::sync::atomic::AtomicU64::new(1),
            shutdown_requested: AtomicBool::new(false),
        }
    }

    fn register(
        &self,
        run_id: &str,
    ) -> Result<
        (
            ForegroundBuildGuard,
            ck_core::builder::demo::BuildCancellation,
        ),
        String,
    > {
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err("Application shutdown is already in progress".to_string());
        }
        let run_id = normalize_foreground_build_run_id(run_id)?;
        let now = std::time::Instant::now();
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "Failed to lock foreground build registry".to_string())?;
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err("Application shutdown is already in progress".to_string());
        }
        prune_finished_build_runs(&mut registry.recently_finished, now);
        if registry.active.contains_key(&run_id) || registry.recently_finished.contains_key(&run_id)
        {
            return Err("Build runId is already active or was recently completed".to_string());
        }

        let generation = self
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cancellation = ck_core::builder::demo::BuildCancellation::new();
        let (finished_tx, finished_rx) = tokio::sync::watch::channel(false);
        registry.active.insert(
            run_id.clone(),
            ActiveForegroundBuild {
                generation,
                cancellation: cancellation.clone(),
                finished_rx,
            },
        );
        drop(registry);

        Ok((
            ForegroundBuildGuard {
                registry: Arc::clone(&self.registry),
                run_id,
                generation,
                finished_tx,
            },
            cancellation,
        ))
    }

    fn active_entry(&self, run_id: &str) -> Result<Option<ActiveForegroundBuild>, String> {
        let run_id = normalize_foreground_build_run_id(run_id)?;
        self.registry
            .lock()
            .map_err(|_| "Failed to lock foreground build registry".to_string())
            .map(|registry| registry.active.get(&run_id).cloned())
    }

    async fn shutdown_all_and_wait(
        &self,
        timeout: std::time::Duration,
    ) -> ForegroundShutdownReport {
        self.shutdown_requested.store(true, Ordering::Release);
        let entries = self
            .registry
            .lock()
            .map(|registry| registry.active.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let initially_active = entries.len();

        let cancellations = entries
            .iter()
            .map(|entry| entry.cancellation.clone())
            .collect::<Vec<_>>();
        let _ = tokio::task::spawn_blocking(move || {
            cancellations
                .into_iter()
                .map(|cancellation| cancellation.cancel())
                .sum::<usize>()
        })
        .await;

        let deadline = tokio::time::Instant::now() + timeout;
        for entry in entries {
            let mut finished_rx = entry.finished_rx;
            while !*finished_rx.borrow() {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let finished_signal = if remaining.is_zero() {
                    false
                } else {
                    matches!(
                        tokio::time::timeout(remaining, finished_rx.changed()).await,
                        Ok(Ok(()))
                    )
                };
                if !finished_signal {
                    let remaining_active = self
                        .registry
                        .lock()
                        .map(|registry| registry.active.len())
                        .unwrap_or(initially_active);
                    return ForegroundShutdownReport {
                        initially_active,
                        remaining_active,
                        timed_out: true,
                    };
                }
            }
        }

        let remaining_active = self
            .registry
            .lock()
            .map(|registry| registry.active.len())
            .unwrap_or_default();
        ForegroundShutdownReport {
            initially_active,
            remaining_active,
            timed_out: remaining_active != 0,
        }
    }
}

struct ForegroundBuildGuard {
    registry: Arc<Mutex<ForegroundBuildRegistry>>,
    run_id: String,
    generation: u64,
    finished_tx: tokio::sync::watch::Sender<bool>,
}

impl Drop for ForegroundBuildGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            let is_current_generation = registry
                .active
                .get(&self.run_id)
                .map(|entry| entry.generation == self.generation)
                .unwrap_or(false);
            if is_current_generation {
                registry.active.remove(&self.run_id);
                let now = std::time::Instant::now();
                registry.recently_finished.insert(self.run_id.clone(), now);
                prune_finished_build_runs(&mut registry.recently_finished, now);
            }
        }
        self.finished_tx.send_replace(true);
    }
}

fn shutdown_application_tasks(app: &AppHandle) {
    let shutdown_state = app.state::<ApplicationShutdownState>();
    if !shutdown_state.begin_once() {
        return;
    }

    log::info!("[SHUTDOWN] Cancelling active CK-owned tasks and waiting for child reaping...");
    let active_monitor = app
        .state::<MonitorState>()
        .monitor
        .lock()
        .ok()
        .and_then(|mut monitor| monitor.take());
    if let Some(active_monitor) = active_monitor {
        if let Err(error) = active_monitor.close() {
            log::error!("[SHUTDOWN] {error}");
        }
    }

    let foreground_state = app.state::<ForegroundBuildState>();
    let install_state = app.state::<InstallState>().inner().clone();
    let app_for_upload_shutdown = app.clone();
    let timeout = std::time::Duration::from_secs(15);

    let (foreground, warmups, installs, uploads) = tauri::async_runtime::block_on(async {
        let install_task =
            tauri::async_runtime::spawn_blocking(move || install_state.shutdown_and_wait(timeout));
        let upload_task = tauri::async_runtime::spawn_blocking(move || {
            app_for_upload_shutdown
                .state::<UploadState>()
                .shutdown_and_wait(timeout)
        });
        tokio::join!(
            foreground_state.shutdown_all_and_wait(timeout),
            compile_accel::shutdown_running_warmups(timeout),
            install_task,
            upload_task,
        )
    });

    match installs {
        Ok(report) if !report.timed_out => log::info!(
            "[SHUTDOWN] Install process registry drained (initially active: {}).",
            report.initially_active
        ),
        Ok(report) => log::error!(
            "[SHUTDOWN] Timed out with {} install process(es) still registered.",
            report.remaining_active
        ),
        Err(error) => log::error!("[SHUTDOWN] Install shutdown worker failed: {error}"),
    }
    if foreground.timed_out {
        log::error!(
            "[SHUTDOWN] Timed out with {} foreground build(s) still active.",
            foreground.remaining_active
        );
    }
    if warmups.timed_out {
        log::error!(
            "[SHUTDOWN] Timed out with {} warmup build(s) still active.",
            warmups.remaining_active
        );
    }
    match uploads {
        Ok(true) => {}
        Ok(false) => log::error!("[SHUTDOWN] Timed out waiting for active upload session(s)."),
        Err(error) => log::error!("[SHUTDOWN] Upload shutdown worker failed: {error}"),
    }

    shutdown_state.mark_completed();
    log::info!("[SHUTDOWN] CK-owned task shutdown coordinator completed.");
}

const FOREGROUND_BUILD_RUN_RETENTION: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const MAX_RECENT_FOREGROUND_BUILD_RUNS: usize = 512;

fn normalize_foreground_build_run_id(run_id: &str) -> Result<String, String> {
    let trimmed = run_id.trim();
    let parsed =
        uuid::Uuid::parse_str(trimmed).map_err(|_| "Build runId must be a UUID".to_string())?;
    Ok(parsed.hyphenated().to_string())
}

fn prune_finished_build_runs(
    recently_finished: &mut HashMap<String, std::time::Instant>,
    now: std::time::Instant,
) {
    recently_finished.retain(|_, finished_at| {
        now.saturating_duration_since(*finished_at) <= FOREGROUND_BUILD_RUN_RETENTION
    });
    while recently_finished.len() > MAX_RECENT_FOREGROUND_BUILD_RUNS {
        let Some(oldest) = recently_finished
            .iter()
            .min_by_key(|(_, finished_at)| **finished_at)
            .map(|(run_id, _)| run_id.clone())
        else {
            break;
        };
        recently_finished.remove(&oldest);
    }
}

async fn cancel_foreground_build_run(
    state: &ForegroundBuildState,
    run_id: &str,
) -> Result<String, String> {
    let run_id = normalize_foreground_build_run_id(run_id)?;
    let Some(entry) = state.active_entry(&run_id)? else {
        return Ok(format!("build run {} is no longer active", run_id));
    };
    let cancellation = entry.cancellation.clone();
    let killed_processes = tokio::task::spawn_blocking(move || cancellation.cancel())
        .await
        .map_err(|error| format!("Failed to request build cancellation: {error}"))?;

    let mut finished_rx = entry.finished_rx;
    while !*finished_rx.borrow() {
        finished_rx
            .changed()
            .await
            .map_err(|_| "Build cancellation completion channel closed".to_string())?;
    }
    Ok(format!(
        "build run {} cancelled; {} active process tree(s) terminated and waited",
        run_id, killed_processes
    ))
}

#[cfg(test)]
mod foreground_build_state_tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_is_run_scoped_and_waits_for_the_matching_guard() {
        let state = Arc::new(ForegroundBuildState::new());
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let (first_guard, first_cancellation) = state.register(&first_id).unwrap();
        let (second_guard, second_cancellation) = state.register(&second_id).unwrap();

        let cancel_state = Arc::clone(&state);
        let cancel_id = first_id.clone();
        let cancel_task =
            tokio::spawn(
                async move { cancel_foreground_build_run(&cancel_state, &cancel_id).await },
            );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !first_cancellation.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first run should receive cancellation");
        assert!(!second_cancellation.is_cancelled());
        assert!(
            !cancel_task.is_finished(),
            "cancel command must wait until the build owner drops its guard"
        );

        drop(first_guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), cancel_task)
            .await
            .expect("cancel command should finish after the owner is done")
            .expect("cancel task")
            .expect("cancel result");
        assert!(state.active_entry(&first_id).unwrap().is_none());
        assert!(state.active_entry(&second_id).unwrap().is_some());
        drop(second_guard);
    }

    #[test]
    fn recently_completed_run_ids_cannot_be_reused_and_history_is_bounded() {
        let state = ForegroundBuildState::new();
        let first_id = uuid::Uuid::new_v4().to_string();
        let (guard, _) = state.register(&first_id).unwrap();
        drop(guard);
        assert!(state.register(&first_id).is_err());

        for _ in 0..(MAX_RECENT_FOREGROUND_BUILD_RUNS + 100) {
            let run_id = uuid::Uuid::new_v4().to_string();
            let (guard, _) = state.register(&run_id).unwrap();
            drop(guard);
        }
        let registry = state.registry.lock().unwrap();
        assert!(registry.active.is_empty());
        assert!(registry.recently_finished.len() <= MAX_RECENT_FOREGROUND_BUILD_RUNS);
    }

    #[tokio::test]
    async fn terminal_shutdown_cancels_every_foreground_run_and_waits_for_owners() {
        let state = Arc::new(ForegroundBuildState::new());
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let (first_guard, first_cancellation) = state.register(&first_id).unwrap();
        let (second_guard, second_cancellation) = state.register(&second_id).unwrap();

        let shutdown_state = Arc::clone(&state);
        let shutdown = tokio::spawn(async move {
            shutdown_state
                .shutdown_all_and_wait(std::time::Duration::from_secs(2))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !(first_cancellation.is_cancelled() && second_cancellation.is_cancelled()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("all foreground runs should receive terminal cancellation");
        assert!(
            !shutdown.is_finished(),
            "shutdown must wait for each build owner to reap and drop its guard"
        );

        drop(first_guard);
        assert!(!shutdown.is_finished());
        drop(second_guard);
        let report = tokio::time::timeout(std::time::Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown should finish after both owners are done")
            .expect("shutdown task");
        assert_eq!(report.initially_active, 2);
        assert_eq!(report.remaining_active, 0);
        assert!(!report.timed_out);
        assert!(state.register(&uuid::Uuid::new_v4().to_string()).is_err());

        let repeated = state
            .shutdown_all_and_wait(std::time::Duration::from_millis(50))
            .await;
        assert_eq!(repeated.initially_active, 0);
        assert!(!repeated.timed_out);
    }

    #[test]
    fn install_registry_terminates_only_live_registered_generations_once() {
        let state = InstallState::new();
        let stale = state.register_process(10_001, InstallProcessScope::CoreInstall);
        let live = state.register_process(10_002, InstallProcessScope::CoreInstall);
        drop(stale);

        let terminated = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&terminated);
        assert_eq!(
            state.cancel_active_processes_with(move |pid| {
                observed.lock().unwrap().push(pid);
            }),
            1
        );
        assert_eq!(*terminated.lock().unwrap(), vec![10_002]);
        assert_eq!(
            state.cancel_active_processes_with(|_| panic!("duplicate kill")),
            0
        );
        drop(live);
        assert_eq!(state.active_process_count(), 0);
    }

    #[test]
    fn user_core_cancel_does_not_terminate_unrelated_package_tool_processes() {
        let state = InstallState::new();
        let core = state.register_process(20_001, InstallProcessScope::CoreInstall);
        let package = state.register_process(20_002, InstallProcessScope::PackageTool);
        let terminated = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&terminated);
        assert_eq!(
            state.cancel_core_install_processes_with(move |pid| {
                observed.lock().unwrap().push(pid);
            }),
            1
        );
        assert_eq!(*terminated.lock().unwrap(), vec![20_001]);
        assert_eq!(
            state.active_process_count_for_scope(InstallProcessScope::PackageTool),
            1
        );
        drop(core);
        drop(package);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn install_cancellation_kills_exact_child_tree_and_waits_for_reap() {
        let state = InstallState::new();
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "ping 127.0.0.1 -n 30 >NUL"]);
        no_window(&mut command);
        let (mut child, guard) = state
            .spawn_registered_process(
                &mut command,
                "test install child",
                InstallProcessScope::CoreInstall,
            )
            .expect("spawn owned install child");
        let (reaped_tx, reaped_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let status = child.wait();
            drop(guard);
            let _ = reaped_tx.send(status);
        });

        let report = state.cancel_and_wait(std::time::Duration::from_secs(5));
        assert_eq!(report.initially_active, 1);
        assert_eq!(report.remaining_active, 0);
        assert!(!report.timed_out);
        let status = reaped_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("child owner must finish wait/reap")
            .expect("wait status");
        assert!(!status.success());
        assert_eq!(state.active_process_count(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn package_tool_output_is_concurrently_drained_and_bounded_without_newlines() {
        let state = InstallState::new();
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$chunk='x'*262144; [Console]::Out.Write($chunk); [Console]::Error.Write($chunk)",
        ]);
        no_window(&mut command);
        let output = run_registered_install_output_with_limits(
            &state,
            &mut command,
            "bounded output regression child",
            4 * 1024,
            4 * 1024,
            InstallProcessScope::PackageTool,
        )
        .expect("newline-free stdout/stderr must drain without deadlock");
        assert!(output.status.success());
        assert!(output.stdout.len() <= 4 * 1024);
        assert!(output.stderr.len() <= 4 * 1024);
        assert!(
            output
                .stdout
                .windows(PROCESS_OUTPUT_TRUNCATION_MARKER.len())
                .any(|window| window == PROCESS_OUTPUT_TRUNCATION_MARKER)
        );
        assert!(
            output
                .stderr
                .windows(PROCESS_OUTPUT_TRUNCATION_MARKER.len())
                .any(|window| window == PROCESS_OUTPUT_TRUNCATION_MARKER)
        );
        assert_eq!(state.active_process_count(), 0);
    }

    #[test]
    fn realtime_process_stream_frames_newline_free_input_into_bounded_events() {
        let input = vec![b'x'; 256 * 1024];
        let mut event_sizes = Vec::new();
        let mut reconstructed = Vec::new();
        read_process_stream_fixed_chunks(std::io::Cursor::new(input.clone()), |chunk| {
            event_sizes.push(chunk.len());
            reconstructed.extend_from_slice(chunk.as_bytes());
        })
        .expect("fixed chunk reader");
        assert!(event_sizes.len() > 1);
        assert!(
            event_sizes
                .iter()
                .all(|size| *size <= PROCESS_STREAM_EVENT_MAX_BYTES)
        );
        assert_eq!(reconstructed, input);
    }

    #[test]
    fn realtime_process_stream_preserves_utf8_split_across_read_boundary() {
        let mut input = "a".repeat(PROCESS_STREAM_READ_CHUNK_BYTES - 1);
        input.push_str("中文边界");
        input.push_str(&"b".repeat(PROCESS_STREAM_READ_CHUNK_BYTES));
        let mut reconstructed = String::new();
        read_process_stream_fixed_chunks(std::io::Cursor::new(input.as_bytes()), |chunk| {
            reconstructed.push_str(chunk)
        })
        .expect("UTF-8 carry reader");
        assert_eq!(reconstructed, input);
        assert!(!reconstructed.contains('\u{fffd}'));
    }

    #[test]
    fn application_shutdown_gate_is_idempotent() {
        let state = ApplicationShutdownState::default();
        assert!(state.begin_once());
        assert!(!state.begin_once());
        assert!(!state.completed.load(Ordering::Acquire));
        state.mark_completed();
        assert!(state.completed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn upload_shutdown_signals_active_session_and_waits_for_guard() {
        let state = Arc::new(UploadState::new());
        let (mut cancel_rx, session_guard) = state.begin_session().unwrap();
        assert!(
            state.begin_session().is_err(),
            "1.0 upload policy must reject a concurrent second session"
        );
        let shutdown_state = Arc::clone(&state);
        let shutdown = tokio::task::spawn_blocking(move || {
            shutdown_state.shutdown_and_wait(std::time::Duration::from_secs(1))
        });
        tokio::time::timeout(std::time::Duration::from_millis(250), cancel_rx.changed())
            .await
            .expect("upload should receive shutdown cancellation")
            .expect("upload cancellation sender");
        assert!(*cancel_rx.borrow());
        assert!(!shutdown.is_finished());
        drop(session_guard);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), shutdown)
                .await
                .expect("upload shutdown should finish after owner cleanup")
                .expect("upload shutdown task")
        );
        assert!(state.begin_session().is_err());
    }

    #[tokio::test]
    async fn stale_upload_guard_cannot_clear_or_cancel_a_new_generation() {
        let state = UploadState::new();
        let (_old_rx, old_guard) = state.begin_session().unwrap();
        // Model an owner that finalized its registry slot while an old guard is
        // still queued for Drop; generation matching must protect its successor.
        *state.inner.session.lock().unwrap() = None;
        let (mut new_rx, new_guard) = state.begin_session().unwrap();
        let new_generation = state
            .inner
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .generation;
        drop(old_guard);
        assert_eq!(
            state
                .inner
                .session
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .generation,
            new_generation
        );
        state.request_cancel();
        tokio::time::timeout(std::time::Duration::from_millis(250), new_rx.changed())
            .await
            .expect("new session must retain its cancellation sender")
            .expect("new cancellation channel");
        assert!(*new_rx.borrow());
        drop(new_guard);
        assert!(state.inner.session.lock().unwrap().is_none());
    }
}

struct AgentLlmCancelState {
    canceled_run_ids: Mutex<HashMap<String, std::time::Instant>>,
}

const MAX_LLM_RUN_ID_BYTES: usize = 256;
const MAX_PENDING_LLM_CANCELLATIONS: usize = 256;
const LLM_CANCELLATION_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

fn normalize_llm_run_id(run_id: &str) -> Result<String, String> {
    let normalized = run_id.trim();
    if normalized.is_empty() {
        return Err("runId is empty".to_string());
    }
    if normalized.len() > MAX_LLM_RUN_ID_BYTES {
        return Err(format!(
            "runId is too long (maximum {} bytes)",
            MAX_LLM_RUN_ID_BYTES
        ));
    }
    if normalized.chars().any(char::is_control) {
        return Err("runId contains control characters".to_string());
    }
    Ok(normalized.to_string())
}

fn register_llm_cancellation(
    canceled_run_ids: &mut HashMap<String, std::time::Instant>,
    run_id: &str,
    now: std::time::Instant,
) -> Result<String, String> {
    let run_id = normalize_llm_run_id(run_id)?;
    canceled_run_ids.retain(|_, inserted_at| {
        now.saturating_duration_since(*inserted_at) <= LLM_CANCELLATION_TTL
    });

    if !canceled_run_ids.contains_key(&run_id)
        && canceled_run_ids.len() >= MAX_PENDING_LLM_CANCELLATIONS
    {
        if let Some(oldest_run_id) = canceled_run_ids
            .iter()
            .min_by_key(|(_, inserted_at)| **inserted_at)
            .map(|(run_id, _)| run_id.clone())
        {
            canceled_run_ids.remove(&oldest_run_id);
        }
    }
    canceled_run_ids.insert(run_id.clone(), now);
    Ok(run_id)
}

#[cfg(test)]
mod agent_llm_cancel_state_tests {
    use super::*;

    #[test]
    fn run_id_validation_rejects_empty_oversized_and_control_values() {
        assert!(normalize_llm_run_id("   ").is_err());
        assert!(normalize_llm_run_id(&"x".repeat(MAX_LLM_RUN_ID_BYTES + 1)).is_err());
        assert!(normalize_llm_run_id("run\n123").is_err());
        assert_eq!(normalize_llm_run_id("  run-123  ").unwrap(), "run-123");
    }

    #[test]
    fn cancellation_registry_is_capacity_bounded_and_evicts_oldest() {
        let start = std::time::Instant::now();
        let mut cancellations = HashMap::new();
        for index in 0..(MAX_PENDING_LLM_CANCELLATIONS + 100) {
            register_llm_cancellation(
                &mut cancellations,
                &format!("run-{index}"),
                start + std::time::Duration::from_millis(index as u64),
            )
            .unwrap();
        }

        assert_eq!(cancellations.len(), MAX_PENDING_LLM_CANCELLATIONS);
        assert!(!cancellations.contains_key("run-0"));
        assert!(cancellations.contains_key(&format!("run-{}", MAX_PENDING_LLM_CANCELLATIONS + 99)));
    }

    #[test]
    fn cancellation_registry_prunes_expired_requests_and_refreshes_duplicates() {
        let now = std::time::Instant::now();
        let mut cancellations = HashMap::from([(
            "expired".to_string(),
            now - LLM_CANCELLATION_TTL - std::time::Duration::from_secs(1),
        )]);

        register_llm_cancellation(&mut cancellations, "active", now).unwrap();
        assert!(!cancellations.contains_key("expired"));
        register_llm_cancellation(
            &mut cancellations,
            "active",
            now + std::time::Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(cancellations.len(), 1);
        assert_eq!(
            cancellations.get("active"),
            Some(&(now + std::time::Duration::from_secs(1)))
        );
    }
}

fn app_sysroot_cache() -> &'static tokio::sync::Mutex<Option<ck_core::sysroot::Sysroot>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<ck_core::sysroot::Sysroot>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn resolve_per_user_ck_root(
    document_dir: Option<std::path::PathBuf>,
    local_data_dir: Option<std::path::PathBuf>,
    home_dir: Option<std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    use std::io::Write;

    let candidates = [
        document_dir.map(|root| root.join("CK")),
        local_data_dir.map(|root| root.join("MakerBlockly").join("CK")),
        home_dir.map(|root| root.join(".ck")),
    ];
    let mut failures = Vec::new();

    for candidate in candidates.into_iter().flatten() {
        let existed = candidate.exists();
        let probe_result = (|| -> Result<(), String> {
            std::fs::create_dir_all(&candidate)
                .map_err(|error| format!("cannot create {}: {error}", candidate.display()))?;
            if !candidate.is_dir() {
                return Err(format!("{} is not a directory", candidate.display()));
            }
            let probe = candidate.join(format!(
                ".ck-write-probe-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&probe)
                .map_err(|error| format!("cannot write {}: {error}", candidate.display()))?;
            file.write_all(b"CK root write probe")
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("cannot sync {}: {error}", candidate.display()))?;
            drop(file);
            std::fs::remove_file(&probe).map_err(|error| {
                format!(
                    "cannot remove write probe in {}: {error}",
                    candidate.display()
                )
            })?;
            Ok(())
        })();

        match probe_result {
            Ok(()) => return Ok(candidate),
            Err(error) if existed => {
                // Never hide an existing CK environment by silently selecting
                // a new empty root elsewhere.
                return Err(format!("existing CK data root is not writable: {error}"));
            }
            Err(error) => failures.push(error),
        }
    }

    Err(format!(
        "no persistent writable CK data root is available{}",
        if failures.is_empty() {
            String::new()
        } else {
            format!(": {}", failures.join("; "))
        }
    ))
}

/// Central writable CK root directory.
///
/// CK historically stores Core packages, libraries and state in the current
/// user's Documents/CK directory. Installed builds must keep using that
/// per-user location: selecting the executable directory breaks under
/// Program Files and silently creates a second empty toolchain beside a
/// current Documents/CK environment. No multi-gigabyte first-run copy is
/// performed. Systems without a Documents directory fall back to local app
/// data and finally the user's home directory.
pub(crate) fn ck_root_dir() -> std::path::PathBuf {
    try_ck_root_dir().unwrap_or_else(|error| panic!("CK data root initialization failed: {error}"))
}

fn try_ck_root_dir() -> Result<std::path::PathBuf, String> {
    static CACHE: OnceLock<Result<std::path::PathBuf, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            // The V9.1 launcher selects an existing user-owned CK/Arduino
            // store, or creates a user-local one. Never write beside the EXE.
            if let Some(selected) = std::env::var_os("CK_V91_DATA_ROOT") {
                let root = std::path::PathBuf::from(selected);
                if !root.is_absolute() {
                    return Err("V9.1 asset store must be an absolute path".into());
                }
                std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
                log::info!("[CK_ROOT] V9.1 selected user asset store: {:?}", root);
                return Ok(root);
            }
            let root = resolve_per_user_ck_root(
                dirs::document_dir(),
                dirs::data_local_dir(),
                dirs::home_dir(),
            )?;
            log::info!("[CK_ROOT] Using per-user data root: {:?}", root);
            Ok(root)
        })
        .clone()
}

#[cfg(test)]
mod ck_root_dir_tests {
    use super::resolve_per_user_ck_root;

    #[test]
    fn existing_documents_root_remains_the_single_preferred_environment() {
        let temp = std::env::temp_dir().join(format!("ck-root-test-{}", uuid::Uuid::new_v4()));
        let documents = temp.join("Documents");
        let local = temp.join("Local");
        let root = resolve_per_user_ck_root(Some(documents.clone()), Some(local), None).unwrap();
        assert_eq!(root, documents.join("CK"));
        assert!(!root.join(".ck-write-probe").exists());
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn missing_documents_uses_writable_local_app_data_not_the_executable_parent() {
        let temp = std::env::temp_dir().join(format!("ck-root-test-{}", uuid::Uuid::new_v4()));
        let local = temp.join("Local");
        let root = resolve_per_user_ck_root(None, Some(local.clone()), None).unwrap();
        assert_eq!(root, local.join("MakerBlockly").join("CK"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn an_existing_unusable_root_is_not_hidden_by_a_second_environment() {
        let temp = std::env::temp_dir().join(format!("ck-root-test-{}", uuid::Uuid::new_v4()));
        let documents = temp.join("Documents");
        let local = temp.join("Local");
        std::fs::create_dir_all(&documents).unwrap();
        std::fs::write(documents.join("CK"), b"occupied by a file").unwrap();
        let error =
            resolve_per_user_ck_root(Some(documents), Some(local.clone()), None).unwrap_err();
        assert!(error.contains("existing CK data root is not writable"));
        assert!(!local.exists());
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn missing_all_persistent_user_directories_fails_instead_of_using_temp() {
        let error = resolve_per_user_ck_root(None, None, None).unwrap_err();
        assert!(error.contains("no persistent writable CK data root"));
    }
}

// Helper to get unified sysroot
async fn get_app_sysroot() -> Result<ck_core::sysroot::Sysroot, String> {
    {
        let guard = app_sysroot_cache().lock().await;
        if let Some(sysroot) = guard.as_ref() {
            return Ok(sysroot.clone());
        }
    }

    let ck_root = ck_root_dir();
    let sysroot = ck_core::sysroot::Sysroot::init(Some(ck_root), "CK")
        .await
        .map_err(|e| e.to_string())?;
    static LEGACY_PLATFORM_LOCAL_MIGRATION: OnceLock<usize> = OnceLock::new();
    let removed = *LEGACY_PLATFORM_LOCAL_MIGRATION.get_or_init(|| {
        ck_core::builder::demo::remove_legacy_ck_platform_local_overrides(&sysroot.root_dir)
    });
    if removed > 0 {
        log::info!(
            "[CK Forge] Removed {} legacy CK-generated platform.local.txt override(s); ccache is now command-scoped.",
            removed
        );
    }
    let mut guard = app_sysroot_cache().lock().await;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    *guard = Some(sysroot.clone());
    Ok(sysroot)
}

/// Return the managed Arduino CLI identity used by Fast/Forge signatures.
///
/// This deliberately does not fall back to `PATH`: a PATH CLI can remain a
/// valid executable for normal Arduino operations, but it must never stand in
/// for the managed executable that qualified an FLFE cache or Forge route.
fn fast_identity_cli_version(sysroot: &ck_core::sysroot::Sysroot) -> String {
    ck_core::builder::demo::canonical_prewarm_cli_version(sysroot)
}

fn derive_toolchain_key(sysroot: &ck_core::sysroot::Sysroot, fqbn: &str) -> String {
    derive_toolchain_identity(sysroot, fqbn).0
}

fn derive_toolchain_identity(
    sysroot: &ck_core::sysroot::Sysroot,
    fqbn: &str,
) -> (String, &'static str) {
    let (key, source) =
        ck_core::builder::demo::resolve_toolchain_cache_key_from_root(&sysroot.root_dir, fqbn);
    let source = match source {
        ck_core::builder::demo::ToolchainIdentityResolutionSource::ProcessMemory => {
            "process-memory"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::PersistentMetadata => {
            "persistent-metadata"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::StrongContent => {
            "strong-content"
        }
    };
    (key, source)
}

fn derive_toolchain_identity_lease(
    sysroot: &ck_core::sysroot::Sysroot,
    fqbn: &str,
) -> Result<(ck_core::builder::demo::ToolchainIdentityLease, &'static str), String> {
    let generation = ck_core::builder::demo::toolchain_identity_cache_generation();
    if let Some(entry) = cached_compile_target_preproof(fqbn, generation) {
        if forge_installed_core_version(&sysroot.root_dir, fqbn).as_deref()
            == Some(entry.core_version.as_str())
        {
            if let Some(lease) = entry.identity_lease {
                // The idle preproof holds the opaque, process-local lease rather
                // than reconstructing authority from the renderer-visible key.
                // Managed package changes advance `generation`; the builder
                // still performs its normal end-boundary identity revalidation
                // before returning Exact or committing fresh cache evidence.
                return Ok((lease, "target-preproof"));
            }
        }
    }
    let lease = ck_core::builder::demo::ToolchainIdentityLease::begin(&sysroot.root_dir, fqbn)
        .map_err(|error| error.to_string())?;
    let source = match lease.resolution_source() {
        ck_core::builder::demo::ToolchainIdentityResolutionSource::ProcessMemory => {
            "process-memory"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::PersistentMetadata => {
            "persistent-metadata"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::StrongContent => {
            "strong-content"
        }
    };
    if let Some(core_version) = forge_installed_core_version(&sysroot.root_dir, fqbn) {
        store_compile_target_preproof(
            fqbn.to_owned(),
            CompileTargetPreproofCacheEntry {
                core_version,
                toolchain_key: lease.toolchain_key().to_owned(),
                source: source.to_owned(),
                generation,
                resolved_at: std::time::Instant::now(),
                identity_lease: Some(lease.clone()),
            },
        );
    }
    Ok((lease, source))
}

// Keep the opaque proof for a normal classroom/work session. A 30-second TTL
// made the proof expire while a user was still arranging blocks, so the next
// Compile click paid the identity scan again. Managed package mutations still
// advance `generation`, the installed Core version is rechecked on lookup,
// and the builder retains its end-boundary strong identity revalidation.
const COMPILE_TARGET_PREPROOF_TTL: std::time::Duration =
    std::time::Duration::from_secs(8 * 60 * 60);
const COMPILE_TARGET_PREPROOF_CACHE_MAX: usize = 64;
const COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES: usize = 2_048;
const COMPILE_TARGET_PREPROOF_TOKEN_MAX_BYTES: usize = 256;
const COMPILE_TARGET_PREPROOF_OPTION_MAX: usize = 128;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileTargetPreproof {
    fqbn: String,
    core_version: String,
    toolchain_key: String,
    source: String,
    elapsed_ms: u64,
    cache_hit: bool,
}

#[derive(Clone)]
struct CompileTargetPreproofCacheEntry {
    core_version: String,
    toolchain_key: String,
    source: String,
    generation: u64,
    resolved_at: std::time::Instant,
    // Never serialized to the renderer.  A bare toolchain-key string is not an
    // authorization object; only this opaque lease may cross from idle proof to
    // the immediately following foreground request.
    identity_lease: Option<ck_core::builder::demo::ToolchainIdentityLease>,
}

fn compile_target_preproof_cache()
-> &'static Mutex<HashMap<String, CompileTargetPreproofCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CompileTargetPreproofCacheEntry>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

type CompileTargetPreproofLock = tokio::sync::Mutex<()>;

fn compile_target_preproof_locks()
-> &'static Mutex<HashMap<String, std::sync::Weak<CompileTargetPreproofLock>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Weak<CompileTargetPreproofLock>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn compile_target_preproof_lock(fqbn: &str) -> Arc<CompileTargetPreproofLock> {
    let Ok(mut locks) = compile_target_preproof_locks().lock() else {
        return Arc::new(CompileTargetPreproofLock::new(()));
    };
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(existing) = locks.get(fqbn).and_then(std::sync::Weak::upgrade) {
        return existing;
    }
    let lock = Arc::new(CompileTargetPreproofLock::new(()));
    locks.insert(fqbn.to_string(), Arc::downgrade(&lock));
    lock
}

fn parse_complete_compile_target_fqbn(fqbn: &str) -> Result<String, String> {
    let complete = normalize_complete_fqbn(fqbn).ok_or_else(|| {
        "Compile target must be a complete package:architecture:board FQBN".to_string()
    })?;
    if complete.len() > COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES {
        return Err(format!(
            "Compile target FQBN exceeds the {}-byte preproof limit",
            COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES
        ));
    }
    let mut parts = complete.splitn(4, ':');
    let package = parts.next().unwrap_or_default();
    let architecture = parts.next().unwrap_or_default();
    let board = parts.next().unwrap_or_default();
    let bounded_token = |value: &str| {
        value.len() <= COMPILE_TARGET_PREPROOF_TOKEN_MAX_BYTES && is_valid_fqbn_token(value)
    };
    if !bounded_token(package) || !bounded_token(architecture) || !bounded_token(board) {
        return Err(
            "Compile target FQBN contains an unsafe package, architecture, or board token"
                .to_string(),
        );
    }
    if let Some(options) = parts.next() {
        if options.is_empty() {
            return Err("Compile target FQBN has an empty board-option section".to_string());
        }
        let mut seen = HashSet::new();
        for (index, option) in options.split(',').enumerate() {
            if index >= COMPILE_TARGET_PREPROOF_OPTION_MAX {
                return Err(format!(
                    "Compile target FQBN exceeds the {}-option preproof limit",
                    COMPILE_TARGET_PREPROOF_OPTION_MAX
                ));
            }
            let Some((key, value)) = option.split_once('=') else {
                return Err(format!(
                    "Compile target FQBN has an invalid option: {option}"
                ));
            };
            if !bounded_token(key) || !bounded_token(value) || !seen.insert(key.to_string()) {
                return Err(format!(
                    "Compile target FQBN has an invalid option: {option}"
                ));
            }
        }
    }
    Ok(complete)
}

fn cached_compile_target_preproof(
    fqbn: &str,
    generation: u64,
) -> Option<CompileTargetPreproofCacheEntry> {
    let now = std::time::Instant::now();
    let mut cache = compile_target_preproof_cache().lock().ok()?;
    cache.retain(|_, entry| {
        entry.generation == generation
            && now.saturating_duration_since(entry.resolved_at) <= COMPILE_TARGET_PREPROOF_TTL
    });
    cache.get(fqbn).cloned()
}

fn store_compile_target_preproof(fqbn: String, entry: CompileTargetPreproofCacheEntry) {
    let Ok(mut cache) = compile_target_preproof_cache().lock() else {
        return;
    };
    if cache.len() >= COMPILE_TARGET_PREPROOF_CACHE_MAX && !cache.contains_key(&fqbn) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, value)| value.resolved_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(fqbn, entry);
}

fn compile_target_preproof_response(
    fqbn: String,
    entry: CompileTargetPreproofCacheEntry,
    elapsed: std::time::Duration,
    cache_hit: bool,
) -> CompileTargetPreproof {
    CompileTargetPreproof {
        fqbn,
        core_version: entry.core_version,
        toolchain_key: entry.toolchain_key,
        source: entry.source,
        elapsed_ms: elapsed.as_millis().min(u64::MAX as u128) as u64,
        cache_hit,
    }
}

fn resolve_compile_target_preproof_fqbn_local(
    sysroot_root: &std::path::Path,
    requested_fqbn: &str,
    custom_mapping: Option<&str>,
) -> Result<String, String> {
    let (requested_base, requested_options) = split_fqbn_base_and_options(requested_fqbn);
    let resolved_target = if normalize_base_fqbn(&requested_base).is_some() {
        requested_base
    } else {
        custom_mapping
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "Compile target preproof skipped: no strictly local mapping for {requested_base}"
                )
            })?
            .to_string()
    };
    let (resolved_base, embedded_options) = split_fqbn_base_and_options(&resolved_target);
    // Validate path-bearing tokens before reading packages/<vendor>/hardware.
    parse_complete_compile_target_fqbn(&resolved_base)?;
    let merged_options = match (embedded_options, requested_options) {
        (Some(defaults), Some(requested)) => Some(format!("{defaults},{requested}")),
        (Some(defaults), None) => Some(defaults),
        (None, requested) => requested,
    };
    let schema = installed_board_option_schema(sysroot_root, &resolved_base).ok_or_else(|| {
        format!(
            "Compile target preproof skipped: {resolved_base} is not declared by local installed boards.txt metadata"
        )
    })?;
    let resolved =
        finalize_resolved_fqbn_options(&resolved_base, merged_options.as_deref(), Some(&schema))?;
    parse_complete_compile_target_fqbn(&resolved)
}

fn local_custom_compile_target_mapping(
    app: &AppHandle,
    requested_fqbn: &str,
) -> Result<Option<String>, String> {
    let (base, _) = split_fqbn_base_and_options(requested_fqbn);
    if normalize_base_fqbn(&base).is_some() {
        return Ok(None);
    }
    if !package_quality::valid_package_id(&base, false) {
        return Err("Compile target preproof skipped: unsafe custom board identity".to_string());
    }
    Ok(resolve_custom_board_base(app, &base))
}

/// Proves the selected Core/toolchain identity while the board choice is idle.
/// This command is deliberately read-only: it never invokes Arduino CLI,
/// compiles a sketch, uploads firmware, or enqueues CK Forge warmup work.
#[tauri::command]
async fn preproof_compile_target(
    app: AppHandle,
    fqbn: String,
    board_package_id: Option<String>,
) -> Result<CompileTargetPreproof, String> {
    let started = std::time::Instant::now();
    // Bound renderer-controlled input before custom-board lookup, filesystem
    // joins, cache keys, or error formatting can amplify it.  The resolved
    // complete FQBN receives the stricter token/option validation below.
    let requested_fqbn = fqbn.trim();
    if requested_fqbn.is_empty() || requested_fqbn.len() > COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES {
        return Err(format!(
            "Compile target preproof requires a non-empty FQBN of at most {} bytes",
            COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES
        ));
    }
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    let sysroot = get_app_sysroot().await?;
    let custom_mapping = local_custom_compile_target_mapping(&app, requested_fqbn)?;
    let complete_fqbn = resolve_compile_target_preproof_fqbn_local(
        &sysroot.root_dir,
        requested_fqbn,
        custom_mapping.as_deref(),
    )?;
    // Keep custom/imported board trust checks aligned with the real build even
    // though only the Arduino Core/toolchain contributes to this proof.
    board_library_scope_for_build(&app, &complete_fqbn, board_package_id.as_deref())?;
    let core_version = forge_installed_core_version(&sysroot.root_dir, &complete_fqbn)
        .ok_or_else(|| format!("No installed Core found for {complete_fqbn}"))?;
    let generation = ck_core::builder::demo::toolchain_identity_cache_generation();
    let singleflight = compile_target_preproof_lock(&complete_fqbn);
    let _singleflight_guard = singleflight.lock().await;

    if let Some(entry) = cached_compile_target_preproof(&complete_fqbn, generation) {
        return Ok(compile_target_preproof_response(
            complete_fqbn,
            entry,
            started.elapsed(),
            true,
        ));
    }

    let identity_root = sysroot.root_dir.clone();
    let identity_fqbn = complete_fqbn.clone();
    let identity_lease = tauri::async_runtime::spawn_blocking(move || {
        ck_core::builder::demo::ToolchainIdentityLease::begin(&identity_root, &identity_fqbn)
    })
    .await
    .map_err(|error| format!("Compile target preproof task failed: {error}"))?
    .map_err(|error| format!("Compile target preproof failed: {error}"))?;
    let toolchain_key = identity_lease.toolchain_key().to_owned();
    let identity_source = identity_lease.resolution_source();
    let current_generation = ck_core::builder::demo::toolchain_identity_cache_generation();
    if current_generation != generation {
        return Err("Managed Core packages changed while proving the compile target".to_string());
    }
    let source = match identity_source {
        ck_core::builder::demo::ToolchainIdentityResolutionSource::ProcessMemory => {
            "process-memory"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::PersistentMetadata => {
            "persistent-metadata"
        }
        ck_core::builder::demo::ToolchainIdentityResolutionSource::StrongContent => {
            "strong-content"
        }
    }
    .to_string();
    let entry = CompileTargetPreproofCacheEntry {
        core_version,
        toolchain_key,
        source,
        generation,
        resolved_at: std::time::Instant::now(),
        identity_lease: Some(identity_lease),
    };
    store_compile_target_preproof(complete_fqbn.clone(), entry.clone());
    Ok(compile_target_preproof_response(
        complete_fqbn,
        entry,
        started.elapsed(),
        false,
    ))
}

#[cfg(test)]
mod compile_target_preproof_tests {
    use super::{
        CompileTargetPreproofCacheEntry, cached_compile_target_preproof,
        compile_target_preproof_lock, parse_complete_compile_target_fqbn,
        resolve_compile_target_preproof_fqbn_local, store_compile_target_preproof,
    };

    struct LocalBoardFixture(std::path::PathBuf);

    impl LocalBoardFixture {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for LocalBoardFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn local_board_fixture() -> LocalBoardFixture {
        let temp =
            std::env::temp_dir().join(format!("ck-preproof-local-board-{}", uuid::Uuid::new_v4()));
        let platform_parent = temp.join("packages/acme/hardware/demo");
        let old_platform = platform_parent.join("v1.9");
        std::fs::create_dir_all(&old_platform).expect("old platform directory");
        std::fs::write(
            old_platform.join("boards.txt"),
            "alpha.name=Acme Alpha old\n\
             alpha.menu.flash.small=Small\n",
        )
        .expect("old boards metadata");
        let platform = platform_parent.join("v1.10");
        std::fs::create_dir_all(&platform).expect("platform directory");
        std::fs::write(
            platform.join("boards.txt"),
            "alpha.name=Acme Alpha\n\
             alpha.menu.flash.small=Small\n\
             alpha.menu.flash.large=Large\n\
             alpha.menu.cpu.fast=Fast\n",
        )
        .expect("boards metadata");
        LocalBoardFixture(temp)
    }

    #[test]
    fn complete_fqbn_parser_preserves_valid_options_and_rejects_partial_or_duplicate_targets() {
        let full = "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi";
        assert_eq!(
            parse_complete_compile_target_fqbn(full).as_deref(),
            Ok(full)
        );
        assert!(parse_complete_compile_target_fqbn("esp32:esp32").is_err());
        assert!(
            parse_complete_compile_target_fqbn("esp32:esp32:esp32s3:FlashSize=8M,FlashSize=16M")
                .is_err()
        );
    }

    #[test]
    fn complete_fqbn_parser_is_bounded_before_identity_or_filesystem_work() {
        let oversized = format!(
            "acme:demo:{}",
            "board".repeat(super::COMPILE_TARGET_PREPROOF_FQBN_MAX_BYTES)
        );
        assert!(
            parse_complete_compile_target_fqbn(&oversized)
                .expect_err("oversized FQBN must be rejected")
                .contains("preproof limit")
        );

        let options = (0..=super::COMPILE_TARGET_PREPROOF_OPTION_MAX)
            .map(|index| format!("k{index}=v"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(
            parse_complete_compile_target_fqbn(&format!("acme:demo:board:{options}"))
                .expect_err("excessive option count must be rejected")
                .contains("option preproof limit")
        );
    }

    #[test]
    fn strictly_local_resolver_accepts_installed_board_metadata_and_custom_mapping() {
        let fixture = local_board_fixture();
        assert_eq!(
            resolve_compile_target_preproof_fqbn_local(
                fixture.path(),
                "acme:demo:alpha:flash=large,cpu=fast",
                None,
            )
            .as_deref(),
            Ok("acme:demo:alpha:cpu=fast,flash=large")
        );
        assert_eq!(
            resolve_compile_target_preproof_fqbn_local(
                fixture.path(),
                "acme-alpha:flash=small",
                Some("acme:demo:alpha:flash=large,cpu=fast"),
            )
            .as_deref(),
            Ok("acme:demo:alpha:cpu=fast,flash=small")
        );
    }

    #[test]
    fn strictly_local_resolver_fails_closed_when_cli_metadata_would_be_required() {
        let fixture = local_board_fixture();
        let unknown = resolve_compile_target_preproof_fqbn_local(
            fixture.path(),
            "acme:demo:not-installed",
            None,
        )
        .expect_err("unknown board must not fall back to Arduino CLI");
        assert!(unknown.contains("local installed boards.txt"));
        let missing_alias = resolve_compile_target_preproof_fqbn_local(
            fixture.path(),
            "unmapped-custom-board",
            None,
        )
        .expect_err("unmapped alias must remain opportunistic");
        assert!(missing_alias.contains("no strictly local mapping"));
        let unknown_option = resolve_compile_target_preproof_fqbn_local(
            fixture.path(),
            "acme:demo:alpha:upload=turbo",
            None,
        )
        .expect_err("unknown menu metadata must not use board details fallback");
        assert!(unknown_option.contains("upload=turbo"));
    }

    #[test]
    fn singleflight_is_scoped_to_the_complete_fqbn() {
        let first = compile_target_preproof_lock("esp32:esp32:esp32s3:FlashSize=8M,PSRAM=disabled");
        let same = compile_target_preproof_lock("esp32:esp32:esp32s3:FlashSize=8M,PSRAM=disabled");
        let option_changed =
            compile_target_preproof_lock("esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi");
        assert!(std::sync::Arc::ptr_eq(&first, &same));
        assert!(!std::sync::Arc::ptr_eq(&first, &option_changed));
    }

    #[test]
    fn short_memo_is_bound_to_the_existing_identity_generation() {
        let fqbn = format!("test:test:board:{}", uuid::Uuid::new_v4());
        let generation = ck_core::builder::demo::toolchain_identity_cache_generation();
        store_compile_target_preproof(
            fqbn.clone(),
            CompileTargetPreproofCacheEntry {
                core_version: "1.0.0".to_string(),
                toolchain_key: "test|test|1.0.0|hash".to_string(),
                source: "strong-content".to_string(),
                generation,
                resolved_at: std::time::Instant::now(),
                identity_lease: None,
            },
        );
        assert!(cached_compile_target_preproof(&fqbn, generation).is_some());
        assert!(cached_compile_target_preproof(&fqbn, generation + 1).is_none());
    }
}

fn forge_platform_from_fqbn(fqbn: &str) -> Option<String> {
    let mut parts = fqbn.trim().split(':');
    let package = parts.next()?.trim();
    let architecture = parts.next()?.trim();
    if package.is_empty() || architecture.is_empty() {
        return None;
    }
    Some(format!("{package}:{architecture}"))
}

fn forge_installed_core_version(sysroot: &std::path::Path, fqbn: &str) -> Option<String> {
    let platform = forge_platform_from_fqbn(fqbn)?;
    board_passport::installed_core_versions(sysroot, &platform)
        .into_iter()
        .last()
}

/// Read the package-manager receipt used by the narrowly scoped ESP32 CN
/// mirror proof.  This is provenance only: it does not authorize a fast
/// route until the normal Forge contract, CLI, host, FQBN and toolchain gates
/// also pass.
fn forge_core_package_identity(
    sysroot: &std::path::Path,
    fqbn: &str,
    core_version: &str,
) -> Option<(String, u64)> {
    if !fqbn.starts_with("esp32:esp32:") || core_version.trim() != "3.3.6-cn" {
        return None;
    }
    let version_root = sysroot
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32")
        .join(core_version.trim());
    let receipt = std::fs::read_to_string(version_root.join("installed.json"))
        .ok()
        .and_then(|bytes| serde_json::from_str::<serde_json::Value>(&bytes).ok());
    let platform = receipt
        .as_ref()
        .and_then(|document| document.get("packages"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|package| {
            package
                .get("platforms")
                .and_then(serde_json::Value::as_array)
        })
        .flatten()
        .find(|platform| {
            platform.get("name").and_then(serde_json::Value::as_str) == Some("esp32")
                && platform
                    .get("architecture")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.eq_ignore_ascii_case("esp32"))
                && platform.get("version").and_then(serde_json::Value::as_str)
                    == Some(core_version.trim())
        })?;
    let checksum = platform
        .get("checksum")
        .and_then(serde_json::Value::as_str)
        .map(|value| {
            value
                .trim()
                .strip_prefix("SHA-256:")
                .unwrap_or(value)
                .to_ascii_lowercase()
        })?;
    let size = platform
        .get("size")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))?;
    Some((checksum, size))
}

/// Reuse the canonical CN-mirror identity already proven by the opaque
/// request lease.  Calling the public CN resolver again would recursively hash
/// the same Core/tool trees even though `ToolchainIdentityLease::begin` just
/// produced this exact content-bound key.
fn verified_cn_mirror_key_from_lease<'a>(
    fqbn: &str,
    core_version: Option<&str>,
    package_identity: Option<&(String, u64)>,
    toolchain_key: Option<&'a str>,
) -> Option<&'a str> {
    if !fqbn.starts_with("esp32:esp32:")
        || core_version != Some("3.3.6-cn")
        || package_identity.is_none()
    {
        return None;
    }
    let key = toolchain_key?;
    key.strip_prefix("esp32|esp32|3.3.6|")
        .is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .then_some(key)
}

fn forge_compatibility_for_build(
    sysroot: &ck_core::sysroot::Sysroot,
    fqbn: &str,
    cli_version: Option<&str>,
    toolchain_key: Option<&str>,
    sketch_sha256: Option<&str>,
) -> ck_forge::ForgeCompatibilityDecision {
    let core_version = forge_installed_core_version(&sysroot.root_dir, fqbn);
    let host_identity = ck_forge::host_environment_fingerprint(&sysroot.root_dir);
    let package_identity = core_version
        .as_deref()
        .and_then(|version| forge_core_package_identity(&sysroot.root_dir, fqbn, version));
    // CN mirror packages keep their real build paths.  Their toolchain lease
    // is canonicalized only after the receipt and content-bound mirror
    // identity prove equivalence, so the qualification lookup and the Native
    // Relink target binding use the same key without aliasing an arbitrary
    // version suffix.
    let mirror_toolchain_key = verified_cn_mirror_key_from_lease(
        fqbn,
        core_version.as_deref(),
        package_identity.as_ref(),
        toolchain_key,
    );
    let forge_toolchain_key = mirror_toolchain_key.or(toolchain_key);
    let local_qualification = core_version.as_deref().and_then(|core_version| {
        Some(ck_forge::load_local_qualification(
            &sysroot.root_dir,
            fqbn,
            core_version,
            cli_version?,
            toolchain_key?,
            sketch_sha256?,
        ))
        .flatten()
    });
    let input = ck_forge::ForgeCompatibilityInput {
        fqbn,
        core_version: core_version.as_deref(),
        cli_version,
        toolchain_key: forge_toolchain_key,
        host_identity_sha256: Some(host_identity.as_str()),
        // Existing board-passport compile evidence proves that a sketch built,
        // not that skipped hooks and packaged artifacts are semantically equal
        // under the fast profile. Only a future dedicated Forge qualification
        // comparison may populate this capability input.
        qualification: local_qualification.as_ref(),
    };
    let package_identity_ref =
        package_identity
            .as_ref()
            .map(|(checksum, size)| ck_forge::ForgeCorePackageIdentity {
                archive_sha256: checksum.as_str(),
                archive_size: *size,
            });
    ck_forge::decide_forge_compatibility_with_core_package_identity(input, package_identity_ref)
}

fn forge_prewarm_candidate_allowed(sysroot: &ck_core::sysroot::Sysroot, fqbn: &str) -> bool {
    let core_version = forge_installed_core_version(&sysroot.root_dir, fqbn);
    let toolchain_key = derive_toolchain_key(sysroot, fqbn);
    let decision = forge_compatibility_for_build(
        sysroot,
        fqbn,
        Some(&fast_identity_cli_version(sysroot)),
        Some(&toolchain_key),
        None,
    );
    // Background work is itself a performance feature. Do not spend CPU or
    // disk unless the exact host/Core/toolchain/FQBN row (including a proven
    // CN mirror identity, when applicable) carries a valid certificate.
    core_version.is_some()
        && decision.allows(
            ck_forge::ForgePerformanceOperation::Compile,
            ck_forge::ForgePerformanceProfile::QuickFast,
        )
}

fn forge_prewarm_profile_plan(
    sysroot: &ck_core::sysroot::Sysroot,
    fqbn: &str,
) -> Vec<ck_core::builder::demo::CompileProfile> {
    if !forge_prewarm_candidate_allowed(sysroot, fqbn) {
        return Vec::new();
    }
    let cli_version = ck_core::builder::demo::canonical_prewarm_cli_version(sysroot);
    let toolchain_key = derive_toolchain_key(sysroot, fqbn);
    let decision = forge_compatibility_for_build(
        sysroot,
        fqbn,
        Some(cli_version.as_str()),
        Some(toolchain_key.as_str()),
        None,
    );
    if decision.decision != ck_forge::ForgeRouteDecision::AllowFast {
        return Vec::new();
    }
    let mut profiles = Vec::new();
    if decision.allows(
        ck_forge::ForgePerformanceOperation::Compile,
        ck_forge::ForgePerformanceProfile::QuickFast,
    ) || decision.allows(
        ck_forge::ForgePerformanceOperation::UploadReady,
        ck_forge::ForgePerformanceProfile::QuickFast,
    ) {
        profiles.push(ck_core::builder::demo::CompileProfile::QuickFast);
    }
    if decision.allows(
        ck_forge::ForgePerformanceOperation::UploadReady,
        ck_forge::ForgePerformanceProfile::SharedFast,
    ) {
        profiles.push(ck_core::builder::demo::CompileProfile::SharedFast);
    }
    profiles
}

fn forge_decision_label(decision: ck_forge::ForgeRouteDecision) -> &'static str {
    match decision {
        ck_forge::ForgeRouteDecision::AllowFast => "allow-fast",
        ck_forge::ForgeRouteDecision::ForcePlatform => "force-platform",
        ck_forge::ForgeRouteDecision::Block => "block",
    }
}

fn forge_source_label(source: ck_forge::ForgeDecisionSource) -> &'static str {
    match source {
        ck_forge::ForgeDecisionSource::BuiltinMatrix => "builtin-matrix",
        ck_forge::ForgeDecisionSource::LocalQualification => "local-qualification",
        ck_forge::ForgeDecisionSource::ConservativeFallback => "conservative-fallback",
    }
}

fn forge_reason_labels(decision: &ck_forge::ForgeCompatibilityDecision) -> String {
    serde_json::to_string(&decision.reason_codes).unwrap_or_else(|_| "[]".to_string())
}

fn forge_compile_profile(
    decision: &ck_forge::ForgeCompatibilityDecision,
) -> Result<ck_core::builder::demo::CompileProfile, String> {
    match decision.decision {
        ck_forge::ForgeRouteDecision::AllowFast
            if decision.allows(
                ck_forge::ForgePerformanceOperation::Compile,
                ck_forge::ForgePerformanceProfile::QuickFast,
            ) =>
        {
            Ok(ck_core::builder::demo::CompileProfile::QuickFast)
        }
        ck_forge::ForgeRouteDecision::AllowFast
            if decision.allows(
                ck_forge::ForgePerformanceOperation::Compile,
                ck_forge::ForgePerformanceProfile::PortableFast,
            ) =>
        {
            // PortableFast keeps the Core's native recipes and optimization
            // settings.  It is available only after the same exact target
            // passed the separate portable A/B certificate.
            Ok(ck_core::builder::demo::CompileProfile::PortableFast)
        }
        ck_forge::ForgeRouteDecision::AllowFast | ck_forge::ForgeRouteDecision::ForcePlatform => {
            Ok(ck_core::builder::demo::CompileProfile::Release)
        }
        ck_forge::ForgeRouteDecision::Block => Err(format!(
            "CK Forge blocked this target: {}",
            forge_reason_labels(decision)
        )),
    }
}

fn forge_compile_profile_for_intent(
    decision: &ck_forge::ForgeCompatibilityDecision,
    fqbn: &str,
    intent: ck_core::builder::demo::CompileIntent,
    native_relink_authorized: bool,
) -> Result<ck_core::builder::demo::CompileProfile, String> {
    if decision.decision != ck_forge::ForgeRouteDecision::Block
        && native_relink_authorized
        && intent == ck_core::builder::demo::CompileIntent::CompileOnly
        && ck_forge::native_relink_adapter_registered_for_fqbn(fqbn)
    {
        // NativeRelink is an independently authorized Release capability. It
        // must never masquerade as QuickFast or inherit that profile's altered
        // optimization/hook contract. Registration alone is not authorization:
        // an absent NativeRelink certificate must not suppress another profile
        // that already has exact-target qualification evidence.
        return Ok(ck_core::builder::demo::CompileProfile::Release);
    }
    forge_compile_profile(decision)
}

fn forge_exact_reuse_policy(
    decision: &ck_forge::ForgeCompatibilityDecision,
    qualification_mode: bool,
    operation: ck_forge::ForgePerformanceOperation,
) -> ck_core::builder::demo::CkExactReusePolicy {
    // Exact reuse is not the specialized Fast lane.  It is a content- and
    // artifact-authenticated replay of the last *complete native build* for
    // the same FQBN/Core/toolchain/library tree.  Keeping this available on
    // the conservative Release route is what makes repeated builds fast for
    // an arbitrary Arduino-compatible Core without pretending that the Core's
    // recipes were safely replaced by CK.  Qualification builds must still
    // execute the compiler, and a future operation-specific policy may opt out
    // explicitly; today both compile and upload use the same authenticated
    // exact contract.
    let _ = (decision, operation);
    if qualification_mode {
        ck_core::builder::demo::CkExactReusePolicy::Deny
    } else {
        ck_core::builder::demo::CkExactReusePolicy::Allow
    }
}

fn native_relink_qualification_probe_allowed(
    qualification_mode: bool,
    probe_authorized: bool,
    compile_intent: ck_core::builder::demo::CompileIntent,
    fqbn: &str,
) -> bool {
    qualification_mode
        && probe_authorized
        && compile_intent == ck_core::builder::demo::CompileIntent::CompileOnly
        && ck_forge::native_relink_adapter_registered_for_fqbn(fqbn)
}

fn compile_profile_label(profile: ck_core::builder::demo::CompileProfile) -> &'static str {
    match profile {
        ck_core::builder::demo::CompileProfile::QuickFast => "quick-fast",
        ck_core::builder::demo::CompileProfile::SharedFast => "shared-fast",
        ck_core::builder::demo::CompileProfile::PortableFast => "portable-fast",
        ck_core::builder::demo::CompileProfile::Release => "release",
    }
}

fn forge_qualification_probe_plan(
    probe: ck_forge::ForgeQualificationProbe,
) -> (
    ck_core::builder::demo::CompileIntent,
    ck_core::builder::demo::CompileProfile,
) {
    let intent = match probe.operation {
        ck_forge::ForgePerformanceOperation::Compile => {
            ck_core::builder::demo::CompileIntent::CompileOnly
        }
        ck_forge::ForgePerformanceOperation::UploadReady => {
            ck_core::builder::demo::CompileIntent::UploadReady
        }
    };
    let profile = match probe.profile {
        ck_forge::ForgePerformanceProfile::QuickFast => {
            ck_core::builder::demo::CompileProfile::QuickFast
        }
        ck_forge::ForgePerformanceProfile::SharedFast => {
            ck_core::builder::demo::CompileProfile::SharedFast
        }
        ck_forge::ForgePerformanceProfile::PortableFast => {
            ck_core::builder::demo::CompileProfile::PortableFast
        }
        ck_forge::ForgePerformanceProfile::NativeRelinkCompileOnly => {
            unreachable!("NativeRelink uses its dedicated qualification path")
        }
    };
    (intent, profile)
}

/// A process-local capability created only after the startup qualification
/// token has been verified.  Keep this distinct from the public probe shape:
/// a caller may describe a requested operation/profile, but only this private
/// context may select a candidate Fast profile or a NativeRelink probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthorizedForgeQualification {
    NativeRelink,
    ProfileProbe(ck_forge::ForgeQualificationProbe),
}

impl AuthorizedForgeQualification {
    fn profile_probe(self) -> Option<ck_forge::ForgeQualificationProbe> {
        match self {
            Self::ProfileProbe(probe) => Some(probe),
            Self::NativeRelink => None,
        }
    }

    fn native_relink_probe_authorized(self) -> bool {
        matches!(self, Self::NativeRelink)
    }
}

fn attach_forge_qualification_probe_diagnostics(
    diagnostics: &mut serde_json::Value,
    probe: Option<ck_forge::ForgeQualificationProbe>,
    recipe_capability: Option<&serde_json::Value>,
) {
    if let Some(probe) = probe {
        // `engine.decision` intentionally remains the ordinary product route:
        // an unqualified target must still say force-platform.  These fields
        // prove only that this token-bound measurement selected the candidate
        // profile and record what the compiler actually did.
        let observed_build_mode = diagnostics
            .get("buildMode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let fallback_used = diagnostics
            .pointer("/cache/fastRelinkFallback")
            .and_then(serde_json::Value::as_bool)
            // Missing route evidence is never eligible for certification.
            .unwrap_or(true);
        diagnostics["qualificationProbe"] = serde_json::json!({
            "authorized": true,
            "authorization": "startup-token",
            "candidateRoute": "qualification-token-probe",
            "operation": probe.operation_label(),
            "profile": probe.profile_label(),
            "selectedProfile": probe.profile_label(),
            "observedBuildMode": observed_build_mode,
            "fallbackUsed": fallback_used,
            "exactReuseDenied": true,
            "physicalUploadPerformed": false,
        });
        if let Some(recipe_capability) = recipe_capability {
            diagnostics["qualificationProbe"]["recipeCapability"] = recipe_capability.clone();
        }
    }
}

fn forge_upload_profile_plan(
    decision: &ck_forge::ForgeCompatibilityDecision,
    quick_fast_warm: bool,
) -> Result<Vec<ck_core::builder::demo::CompileProfile>, String> {
    if decision.decision == ck_forge::ForgeRouteDecision::Block {
        return Err(format!(
            "CK Forge blocked this target: {}",
            forge_reason_labels(decision)
        ));
    }
    let mut profiles = Vec::new();
    if quick_fast_warm
        && decision.allows(
            ck_forge::ForgePerformanceOperation::UploadReady,
            ck_forge::ForgePerformanceProfile::QuickFast,
        )
    {
        profiles.push(ck_core::builder::demo::CompileProfile::QuickFast);
    }
    if decision.allows(
        ck_forge::ForgePerformanceOperation::UploadReady,
        ck_forge::ForgePerformanceProfile::SharedFast,
    ) {
        profiles.push(ck_core::builder::demo::CompileProfile::SharedFast);
    }
    profiles.push(ck_core::builder::demo::CompileProfile::Release);
    Ok(profiles)
}

#[cfg(test)]
mod ck_forge_runtime_tests {
    use super::*;

    #[test]
    fn fast_identity_cli_version_requires_the_current_managed_cli() {
        let root = tempfile::tempdir().expect("temporary sysroot root");
        let sysroot = ck_core::sysroot::Sysroot {
            root_dir: root.path().to_path_buf(),
            manifest: std::sync::Arc::new(tokio::sync::Mutex::new(Default::default())),
        };

        // A PATH Arduino CLI, if one exists on the host, is intentionally not
        // eligible to authenticate Fast/Forge cache identity for this sysroot.
        assert_eq!(fast_identity_cli_version(&sysroot), "unknown_cli");
    }

    #[test]
    fn cn_mirror_reuses_only_a_canonical_content_bound_lease_key() {
        let package_identity = ("a".repeat(64), 27_532_204);
        let canonical_key = format!("esp32|esp32|3.3.6|{}", "b".repeat(64));
        assert_eq!(
            verified_cn_mirror_key_from_lease(
                "esp32:esp32:esp32s2",
                Some("3.3.6-cn"),
                Some(&package_identity),
                Some(&canonical_key),
            ),
            Some(canonical_key.as_str())
        );
        assert!(
            verified_cn_mirror_key_from_lease(
                "esp32:esp32:esp32s2",
                Some("3.3.6-cn"),
                Some(&package_identity),
                Some("esp32|esp32|3.3.6-cn|not-canonical"),
            )
            .is_none()
        );
        assert!(
            verified_cn_mirror_key_from_lease(
                "esp32:esp32:esp32s2",
                Some("3.3.6-cn"),
                None,
                Some(&canonical_key),
            )
            .is_none(),
            "a canonical-looking string without the exact package receipt is not authority"
        );
    }

    fn synthetic_fast_decision() -> ck_forge::ForgeCompatibilityDecision {
        let fqbn = "esp32:esp32:esp32c6:PartitionScheme=app3M_fat9M_16MB,FlashSize=16M";
        let expected = ck_forge::builtin_expected_toolchain_key(fqbn, "3.3.6")
            .expect("listed C6 16M identity");
        let mut decision =
            ck_forge::decide_forge_compatibility(ck_forge::ForgeCompatibilityInput {
                fqbn,
                core_version: Some("3.3.6"),
                cli_version: Some("arduino-cli Version: 1.4.1 Commit: local"),
                toolchain_key: Some(expected),
                host_identity_sha256: None,
                qualification: None,
            });
        decision.decision = ck_forge::ForgeRouteDecision::AllowFast;
        decision.capabilities = ck_forge::ForgeFastCapabilities {
            compile_quick_fast: true,
            compile_portable_fast: false,
            compile_native_relink_only: false,
            upload_quick_fast: true,
            upload_shared_fast: true,
        };
        decision
    }

    #[test]
    fn controlled_profile_probe_maps_operation_without_changing_product_routing() {
        let compile = ck_forge::ForgeQualificationProbe::parse("compile", "quick-fast")
            .expect("compile probe");
        assert_eq!(
            forge_qualification_probe_plan(compile),
            (
                ck_core::builder::demo::CompileIntent::CompileOnly,
                ck_core::builder::demo::CompileProfile::QuickFast,
            )
        );
        let upload_ready = ck_forge::ForgeQualificationProbe::parse("upload-ready", "shared-fast")
            .expect("upload-ready probe");
        assert_eq!(
            forge_qualification_probe_plan(upload_ready),
            (
                ck_core::builder::demo::CompileIntent::UploadReady,
                ck_core::builder::demo::CompileProfile::SharedFast,
            )
        );
        assert!(ck_forge::ForgeQualificationProbe::parse("compile", "shared-fast").is_err());

        let unqualified = ck_forge::decide_forge_compatibility(ck_forge::ForgeCompatibilityInput {
            fqbn: "esp32:esp32:esp32c6",
            core_version: Some("3.3.6"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("esp32|esp32|3.3.6|unqualified"),
            host_identity_sha256: None,
            qualification: None,
        });
        assert_eq!(
            forge_compile_profile(&unqualified).unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
            "adding a probe API must not widen the normal product route"
        );
    }

    #[test]
    fn registered_adapter_without_authority_preserves_qualified_compile_profiles() {
        use ck_core::builder::demo::{CompileIntent, CompileProfile};
        let mut decision = synthetic_fast_decision();
        for fqbn in ["arduino:avr:uno", "esp32:esp32:esp32s3", "esp32:esp32:esp32c6"] {
            assert_eq!(
                forge_compile_profile_for_intent(&decision, fqbn, CompileIntent::CompileOnly, false).unwrap(),
                CompileProfile::QuickFast,
            );
        }
        decision.capabilities.compile_quick_fast = false;
        decision.capabilities.compile_portable_fast = true;
        assert_eq!(
            forge_compile_profile_for_intent(&decision, "esp32:esp32:esp32s3", CompileIntent::CompileOnly, false).unwrap(),
            CompileProfile::PortableFast,
        );
        assert_eq!(
            forge_compile_profile_for_intent(&decision, "esp32:esp32:esp32s3", CompileIntent::CompileOnly, true).unwrap(),
            CompileProfile::Release,
            "authorized NativeRelink retains the native recipe contract",
        );
        assert_eq!(
            forge_compile_profile_for_intent(&decision, "esp32:esp32:esp32s3", CompileIntent::Background, true).unwrap(),
            CompileProfile::PortableFast,
            "compile-only evidence cannot authorize background NativeRelink",
        );
        decision.decision = ck_forge::ForgeRouteDecision::ForcePlatform;
        assert_eq!(
            forge_compile_profile_for_intent(&decision, "esp32:esp32:esp32s3", CompileIntent::CompileOnly, false).unwrap(),
            CompileProfile::Release,
            "missing qualification still fails closed",
        );
        decision.decision = ck_forge::ForgeRouteDecision::Block;
        assert!(forge_compile_profile_for_intent(&decision, "esp32:esp32:esp32s3", CompileIntent::CompileOnly, true).is_err());
    }

    #[test]
    fn recipe_capability_evidence_is_nested_only_under_a_controlled_probe() {
        let probe = ck_forge::ForgeQualificationProbe::parse("compile", "quick-fast")
            .expect("controlled probe");
        let recipe = serde_json::json!({
            "schemaVersion": 2,
            "observationOnly": true,
            "capabilityGatePassed": false,
            "missingCapabilities": ["core_archive_reuse"]
        });
        let mut diagnostics = serde_json::json!({
            "buildMode": "fast-relink",
            "cache": { "fastRelinkFallback": false }
        });
        attach_forge_qualification_probe_diagnostics(&mut diagnostics, Some(probe), Some(&recipe));
        assert_eq!(
            diagnostics["qualificationProbe"]["recipeCapability"],
            recipe
        );
        assert_eq!(
            diagnostics["qualificationProbe"]["recipeCapability"]["observationOnly"],
            true
        );
        assert_eq!(
            diagnostics["qualificationProbe"]["candidateRoute"],
            "qualification-token-probe"
        );
        assert_eq!(
            diagnostics["qualificationProbe"]["observedBuildMode"],
            "fast-relink"
        );
        assert_eq!(diagnostics["qualificationProbe"]["fallbackUsed"], false);
        assert_eq!(
            diagnostics["qualificationProbe"]["authorization"],
            "startup-token"
        );

        let mut fallback = serde_json::json!({
            "buildMode": "fast-relink",
            "cache": { "fastRelinkFallback": true }
        });
        attach_forge_qualification_probe_diagnostics(&mut fallback, Some(probe), None);
        assert_eq!(fallback["qualificationProbe"]["fallbackUsed"], true);

        let mut normal = serde_json::json!({});
        attach_forge_qualification_probe_diagnostics(&mut normal, None, Some(&recipe));
        assert!(normal.get("qualificationProbe").is_none());
    }

    #[test]
    fn authorized_native_relink_compile_only_keeps_native_release_profile() {
        let decision = synthetic_fast_decision();
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:avr:uno",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:avr:uno",
                ck_core::builder::demo::CompileIntent::Background,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast,
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "esp32:esp32:esp32c6",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
            "the authorized ESP32-C6 NativeRelink adapter pins the native Release baseline"
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "esp32:esp32:esp32s3",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
            "an authorized generic ESP32 family adapter pins the native Release baseline"
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "esp32:esp32:esp32wrover",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast,
            "unregistered ESP32 boards stay on the normal route"
        );
    }

    #[test]
    fn authorized_samd_mkrzero_compile_only_uses_native_release_but_clones_do_not() {
        let decision = synthetic_fast_decision();
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:samd:mkrzero",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:samd:mkrzero:USBMode=default,FlashSize=8M",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::Release,
            "registered menu options remain on the exact MKR Zero adapter lane"
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:samd:mkrzero_clone",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast,
            "a board-name clone must not inherit the MKR Zero adapter"
        );
        assert_eq!(
            forge_compile_profile_for_intent(
                &decision,
                "arduino:samd:mkrwifi1010",
                ck_core::builder::demo::CompileIntent::CompileOnly,
                true,
            )
            .unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast,
            "other SAMD boards remain on the normal route"
        );
    }

    #[test]
    fn installed_core_resolution_uses_the_resolved_fqbn_platform_and_highest_version() {
        let root = std::env::temp_dir().join(format!(
            "ck-forge-core-version-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for version in ["3.3.5", "3.3.6", "3.2.1"] {
            std::fs::create_dir_all(
                root.join("packages")
                    .join("esp32")
                    .join("hardware")
                    .join("esp32")
                    .join(version),
            )
            .unwrap();
        }
        assert_eq!(
            forge_installed_core_version(
                &root,
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default"
            )
            .as_deref(),
            Some("3.3.6")
        );
        assert_eq!(forge_installed_core_version(&root, "malformed"), None);
        let sysroot = ck_core::sysroot::Sysroot {
            root_dir: root.clone(),
            manifest: std::sync::Arc::new(tokio::sync::Mutex::new(Default::default())),
        };
        assert!(
            !forge_prewarm_candidate_allowed(
                &sysroot,
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB"
            ),
            "a correctness-only identity must not schedule background fast work"
        );
        assert!(
            forge_prewarm_profile_plan(
                &sysroot,
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB"
            )
            .is_empty()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn compile_and_upload_plans_keep_uncertified_targets_on_native_release() {
        if std::env::consts::OS != "windows" || std::env::consts::ARCH != "x86_64" {
            return;
        }
        let fast = synthetic_fast_decision();
        assert_eq!(
            forge_compile_profile(&fast).unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast
        );
        assert_eq!(
            forge_exact_reuse_policy(&fast, false, ck_forge::ForgePerformanceOperation::Compile,),
            ck_core::builder::demo::CkExactReusePolicy::Allow
        );
        assert_eq!(
            forge_exact_reuse_policy(&fast, true, ck_forge::ForgePerformanceOperation::Compile,),
            ck_core::builder::demo::CkExactReusePolicy::Deny,
            "qualification must execute the compiler instead of self-certifying an Exact hit"
        );
        assert_eq!(
            forge_upload_profile_plan(&fast, true).unwrap(),
            vec![
                ck_core::builder::demo::CompileProfile::QuickFast,
                ck_core::builder::demo::CompileProfile::SharedFast,
                ck_core::builder::demo::CompileProfile::Release,
            ]
        );
        assert_eq!(
            forge_upload_profile_plan(&fast, false).unwrap(),
            vec![
                ck_core::builder::demo::CompileProfile::SharedFast,
                ck_core::builder::demo::CompileProfile::Release,
            ]
        );

        let mut compile_only = fast.clone();
        compile_only.capabilities = ck_forge::ForgeFastCapabilities {
            compile_quick_fast: true,
            compile_portable_fast: false,
            compile_native_relink_only: false,
            upload_quick_fast: false,
            upload_shared_fast: false,
        };
        assert_eq!(
            forge_compile_profile(&compile_only).unwrap(),
            ck_core::builder::demo::CompileProfile::QuickFast
        );
        assert_eq!(
            forge_upload_profile_plan(&compile_only, true).unwrap(),
            vec![ck_core::builder::demo::CompileProfile::Release],
            "compile QuickFast evidence must never authorize an upload profile"
        );
        assert_eq!(
            forge_exact_reuse_policy(
                &compile_only,
                false,
                ck_forge::ForgePerformanceOperation::UploadReady,
            ),
            ck_core::builder::demo::CkExactReusePolicy::Allow,
            "compile-only Fast evidence still permits an authenticated native Exact replay for upload"
        );

        let mut portable_compile_only = fast.clone();
        portable_compile_only.capabilities = ck_forge::ForgeFastCapabilities {
            compile_portable_fast: true,
            compile_quick_fast: false,
            compile_native_relink_only: false,
            upload_quick_fast: false,
            upload_shared_fast: false,
        };
        assert_eq!(
            forge_compile_profile(&portable_compile_only).unwrap(),
            ck_core::builder::demo::CompileProfile::PortableFast,
            "a certified portable-native-recipe lane must not inherit QuickFast settings"
        );
        assert_eq!(
            forge_upload_profile_plan(&portable_compile_only, true).unwrap(),
            vec![ck_core::builder::demo::CompileProfile::Release],
            "PortableFast compile evidence must never authorize upload packaging"
        );

        let mut shared_upload_only = fast.clone();
        shared_upload_only.capabilities = ck_forge::ForgeFastCapabilities {
            compile_quick_fast: false,
            compile_portable_fast: false,
            compile_native_relink_only: false,
            upload_quick_fast: false,
            upload_shared_fast: true,
        };
        assert_eq!(
            forge_compile_profile(&shared_upload_only).unwrap(),
            ck_core::builder::demo::CompileProfile::Release
        );
        assert_eq!(
            forge_upload_profile_plan(&shared_upload_only, true).unwrap(),
            vec![
                ck_core::builder::demo::CompileProfile::SharedFast,
                ck_core::builder::demo::CompileProfile::Release,
            ]
        );

        let fallback = ck_forge::decide_forge_compatibility(ck_forge::ForgeCompatibilityInput {
            fqbn: "vendor:arch:custom",
            core_version: Some("1.0.0"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("vendor|arch|1.0.0|content"),
            host_identity_sha256: None,
            qualification: None,
        });
        assert_eq!(
            forge_compile_profile(&fallback).unwrap(),
            ck_core::builder::demo::CompileProfile::Release
        );
        assert_eq!(
            forge_exact_reuse_policy(
                &fallback,
                false,
                ck_forge::ForgePerformanceOperation::Compile,
            ),
            ck_core::builder::demo::CkExactReusePolicy::Allow,
            "unknown targets remain native Release, but may reuse a fully authenticated native result"
        );
        assert_eq!(
            forge_upload_profile_plan(&fallback, true).unwrap(),
            vec![ck_core::builder::demo::CompileProfile::Release]
        );
    }

    #[test]
    fn reserved_block_decision_is_an_error_not_a_silent_release_fallback() {
        let mut blocked = synthetic_fast_decision();
        blocked.decision = ck_forge::ForgeRouteDecision::Block;
        assert!(forge_compile_profile(&blocked).is_err());
        assert!(forge_upload_profile_plan(&blocked, true).is_err());
    }
}

const SYSTEM_PATH_LABELS: [&str; 20] = [
    "应用配置目录",
    "工程目录配置",
    "应用数据根目录 (Sysroot)",
    "Arduino CLI 可执行文件",
    "Arduino CLI 配置",
    "Arduino CLI 快速编译配置",
    "二进制工具目录 (bin)",
    "Arduino 核心与工具链",
    "用户 Sketchbook",
    "空 Sketchbook (快速编译)",
    "下载缓存",
    "Arduino 核心编译缓存",
    "CCache 编译缓存",
    "应用状态目录",
    "AI 设置",
    "预构建核心快照",
    "编译输出目录 (临时)",
    "编译元数据 (临时)",
    "库兼容层目录 (临时)",
    "用户库目录",
];

fn system_path_prebuilt_core_snapshot(sysroot: &std::path::Path) -> std::path::PathBuf {
    sysroot.join("prebuilt_cores")
}

#[tauri::command]
async fn get_system_paths(app: AppHandle) -> Result<Vec<(String, String, bool)>, String> {
    // Returns the key paths useful for support diagnostics. This is intentionally
    // a curated list rather than a promise to expose every transient file.
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = &sysroot_obj.root_dir;
    let temp_builds = std::env::temp_dir().join("CK_Builds");
    let temp_library_shim = std::env::temp_dir().join("CK_LibShim");
    let app_config_dir = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;

    // Resolve bundled CLI path
    let cli_display = if let Ok(guard) = bundled_cli_cache().lock() {
        guard.as_ref().map(|p| p.to_string_lossy().to_string())
    } else {
        None
    }
    .unwrap_or_else(|| find_arduino_cli(sysroot).to_string_lossy().to_string());

    let entries: Vec<(&str, std::path::PathBuf)> = vec![
        (SYSTEM_PATH_LABELS[0], app_config_dir.clone()),
        (SYSTEM_PATH_LABELS[1], app_config_dir.join("config.json")),
        (SYSTEM_PATH_LABELS[2], sysroot.clone()),
        (
            SYSTEM_PATH_LABELS[3],
            std::path::PathBuf::from(&cli_display),
        ),
        (SYSTEM_PATH_LABELS[4], sysroot.join("arduino-cli.yaml")),
        (SYSTEM_PATH_LABELS[5], sysroot.join("arduino-cli-fast.yaml")),
        (SYSTEM_PATH_LABELS[6], sysroot.join("bin")),
        (SYSTEM_PATH_LABELS[7], sysroot.join("packages")),
        (SYSTEM_PATH_LABELS[8], sysroot.join("sketchbook")),
        (SYSTEM_PATH_LABELS[9], sysroot.join("empty_sketchbook")),
        (SYSTEM_PATH_LABELS[10], sysroot.join("cache")),
        (
            SYSTEM_PATH_LABELS[11],
            sysroot.join("cache").join("arduino_cores"),
        ),
        (SYSTEM_PATH_LABELS[12], sysroot.join("cache").join("ccache")),
        (SYSTEM_PATH_LABELS[13], sysroot.join("state")),
        (
            SYSTEM_PATH_LABELS[14],
            sysroot.join("state").join("ai_settings.json"),
        ),
        (
            SYSTEM_PATH_LABELS[15],
            system_path_prebuilt_core_snapshot(sysroot),
        ),
        (SYSTEM_PATH_LABELS[16], temp_builds.clone()),
        (SYSTEM_PATH_LABELS[17], temp_builds.join("metadata")),
        (SYSTEM_PATH_LABELS[18], temp_library_shim),
        (SYSTEM_PATH_LABELS[19], sysroot.join("libraries")),
    ];

    // Also resolve docs-based library paths
    let result: Vec<(String, String, bool)> = entries
        .into_iter()
        .map(|(label, path)| {
            let exists = path.exists();
            (
                label.to_string(),
                path.to_string_lossy().to_string(),
                exists,
            )
        })
        .collect();

    Ok(result)
}

#[cfg(test)]
mod system_path_label_tests {
    use super::{SYSTEM_PATH_LABELS, system_path_prebuilt_core_snapshot};

    #[test]
    fn system_path_labels_are_complete_simplified_chinese_utf8() {
        assert_eq!(
            SYSTEM_PATH_LABELS,
            [
                "应用配置目录",
                "工程目录配置",
                "应用数据根目录 (Sysroot)",
                "Arduino CLI 可执行文件",
                "Arduino CLI 配置",
                "Arduino CLI 快速编译配置",
                "二进制工具目录 (bin)",
                "Arduino 核心与工具链",
                "用户 Sketchbook",
                "空 Sketchbook (快速编译)",
                "下载缓存",
                "Arduino 核心编译缓存",
                "CCache 编译缓存",
                "应用状态目录",
                "AI 设置",
                "预构建核心快照",
                "编译输出目录 (临时)",
                "编译元数据 (临时)",
                "库兼容层目录 (临时)",
                "用户库目录",
            ]
        );

        let joined = SYSTEM_PATH_LABELS.join("|");
        for mojibake in [
            "\u{6434}\u{65c2}\u{6564}",
            "\u{95b0}\u{5d87}\u{7586}",
            "\u{9429}\u{e1bc}\u{7d8d}",
            "\u{9359}\u{e21b}\u{58bd}\u{741b}\u{5c7e}\u{6783}\u{6d60}",
        ] {
            assert!(
                !joined.contains(mojibake),
                "system path labels contain known mojibake: {mojibake}"
            );
        }
        assert!(!joined.contains('\u{fffd}'));
    }

    #[test]
    fn prebuilt_core_snapshot_reports_the_canonical_sysroot_directory() {
        let sysroot = std::path::Path::new("test-user-data").join("CK");
        assert_eq!(
            system_path_prebuilt_core_snapshot(&sysroot),
            sysroot.join("prebuilt_cores")
        );
        assert_ne!(
            system_path_prebuilt_core_snapshot(&sysroot),
            sysroot.parent().unwrap().join("prebuilt_cores")
        );
    }
}

#[tauri::command]
async fn open_path_in_explorer(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let (target, select_file) = if p.is_file() {
        (p.to_path_buf(), true)
    } else if p.is_dir() {
        (p.to_path_buf(), false)
    } else if let Some(parent) = p.parent().filter(|parent| parent.exists()) {
        (parent.to_path_buf(), false)
    } else {
        return Err(format!("路径不存在：{}", path));
    };

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if select_file {
            command.arg("/select,");
        }
        command
            .arg(&target)
            .spawn()
            .map_err(|error| format!("无法打开资源管理器：{}", error))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if select_file {
            command.arg("-R");
        }
        command
            .arg(&target)
            .spawn()
            .map_err(|error| format!("无法打开 Finder：{}", error))?;
    }

    #[cfg(target_os = "linux")]
    {
        let open_target = if select_file {
            target.parent().unwrap_or(&target)
        } else {
            &target
        };
        std::process::Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|error| format!("无法打开文件管理器：{}", error))?;
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlmHistoryMessage {
    role: String,
    #[serde(default)]
    response_reasoning: Vec<ai_responses::Reasoning>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default, rename = "reasoning_content")]
    reasoning_content: Option<String>,
    #[serde(default)]
    content: String,
    /// Present for assistant messages that have function calls.
    #[serde(
        default,
        rename = "tool_calls",
        skip_serializing_if = "Option::is_none"
    )]
    tool_calls: Option<serde_json::Value>,
    /// Present for tool-result messages.
    #[serde(
        default,
        rename = "tool_call_id",
        skip_serializing_if = "Option::is_none"
    )]
    tool_call_id: Option<String>,
    /// Tool name, present for tool-result messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmToolFunctionDef {
    name: String,
    description: Option<String>,
    parameters: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmToolDef {
    #[serde(rename = "type")]
    tool_type: String,
    function: LlmToolFunctionDef,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmToolCallFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: LlmToolCallFunction,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlmChatRequest {
    api_protocol: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    reasoning_effort: Option<String>,
    reasoning_protocol: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    run_id: Option<String>,
    user_message: String,
    history_messages: Option<Vec<GlmHistoryMessage>>,
    system_prompt: Option<String>,
    context_json: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    timeout_ms: Option<u64>,
    tools: Option<Vec<LlmToolDef>>,
    tool_choice: Option<serde_json::Value>,
    /// Optional: override provider base URL from the frontend.
    base_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GlmChatResult {
    #[serde(skip_serializing_if="Vec::is_empty")]
    response_reasoning: Vec<ai_responses::Reasoning>,
    model: String,
    content: String,
    reasoning_content: Option<String>,
    finish_reason: Option<String>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
    raw_json: String,
    tool_calls: Option<Vec<LlmToolCall>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLlmDeltaPayload {
    run_id: String,
    delta: String,
    reasoning_delta: Option<String>,
    done: bool,
    model: Option<String>,
    finish_reason: Option<String>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

#[tauri::command]
fn cancel_glm_stream(
    run_id: String,
    cancel_state: State<'_, AgentLlmCancelState>,
) -> Result<String, String> {
    let mut guard = cancel_state
        .canceled_run_ids
        .lock()
        .map_err(|_| "Failed to lock Glm cancel state".to_string())?;
    let rid = register_llm_cancellation(&mut guard, &run_id, std::time::Instant::now())?;
    Ok(format!("cancel requested: {}", rid))
}

async fn wait_for_ai_cancellation(state: &AgentLlmCancelState, run_id: &str) -> String {
    loop {
        match state.canceled_run_ids.lock() {
            Ok(mut guard) => if guard.remove(run_id).is_some() { return "AI request cancelled".to_string(); },
            Err(_) => return "Failed to read AI cancellation state".to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Resolved provider configuration from ai_settings.json.
struct ResolvedProvider {
    base_url: String,
    default_model: String,
    provider_id: String,
}

/// Read ai_settings.json and resolve the active provider's base_url and default_model.
fn resolve_active_provider() -> Option<ResolvedProvider> {
    let settings_path = ck_root_dir().join("state").join("ai_settings.json");
    let content = std::fs::read_to_string(settings_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    let active_id = json
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("glm")
        .trim()
        .to_lowercase();

    if let Some(arr) = json.get("providers").and_then(|v| v.as_array()) {
        for item in arr {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if id == active_id {
                let base_url = item
                    .get("base_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let default_model = item
                    .get("default_model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                return Some(ResolvedProvider {
                    base_url,
                    default_model,
                    provider_id: active_id,
                });
            }
        }
    }
    None
}

/// Build the chat completions endpoint URL from a provider base_url.
fn build_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://open.bigmodel.cn/api/paas/v4/chat/completions".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    // If caller already provided a concrete completions endpoint, use as-is.
    if lower.contains("/chat/completions")
        || lower.ends_with("/completions")
        || lower.contains("chatcompletion_v2")
    {
        return trimmed.to_string();
    }
    // If it ends with /v1 or /v4 etc., append /chat/completions.
    if lower.ends_with("/v1") || lower.ends_with("/v4") || lower.ends_with("/v4/") {
        return format!("{}/chat/completions", trimmed);
    }
    // Otherwise append /chat/completions.
    format!("{}/chat/completions", trimmed)
}

fn ai_endpoint(base: &str, responses: bool) -> Result<String,String> {
    let full = build_completions_url(base);
    if !responses && !base.trim_end_matches('/').ends_with("/responses") { return Ok(full); }
    let mut url=url::Url::parse(if base.trim().is_empty() {&full} else {base.trim()}).map_err(|_|"API 地址无效")?;
    let suffix=if responses {"responses"} else {"chat/completions"};
    url.set_path(&format!("{}/{suffix}",ai_responses::base_path(url.path())));
    Ok(url.into())
}

fn ai_http_client(endpoint: &str, timeout_ms:u64) -> Result<reqwest::Client,String> {
    let mut builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(timeout_ms));
    if url::Url::parse(endpoint).ok().is_some_and(|url| match url.host() {
        Some(url::Host::Domain(h))=> h.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip))=>ip.is_loopback(),Some(url::Host::Ipv6(ip))=>ip.is_loopback(),None=>false,
    }) {builder=builder.no_proxy();}
    builder.build().map_err(|e|format!("Failed to create HTTP client: {e}"))
}

/// Legacy compat: read default model from settings (used as fallback).
fn read_default_model_from_settings() -> Option<String> {
    resolve_active_provider()
        .map(|p| p.default_model)
        .filter(|m| !m.is_empty())
}

fn infer_provider_from_base_url(base_url: &str) -> Option<&'static str> {
    let lower = base_url.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("deepseek") {
        return Some("deepseek");
    }
    if lower.contains("minimax") {
        return Some("minimax");
    }
    if lower.contains("bigmodel") || lower.contains("zhipu") || lower.contains("glm") {
        return Some("glm");
    }
    None
}

fn resolve_llm_api_key(
    request_key: Option<String>,
    provider_id: Option<&str>,
    provider_base_url: Option<&str>,
) -> Option<String> {
    let from_request = request_key.unwrap_or_default().trim().to_string();
    if !from_request.is_empty() {
        return Some(from_request);
    }

    let normalized_provider = provider_id
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            provider_base_url
                .and_then(infer_provider_from_base_url)
                .map(|v| v.to_string())
        })
        .unwrap_or_default();

    let provider_envs: &[&str] = match normalized_provider.as_str() {
        "deepseek" => &["DEEPSEEK_API_KEY", "CK_DEEPSEEK_API_KEY"],
        "minimax" => &["MINIMAX_API_KEY", "CK_MINIMAX_API_KEY"],
        "glm" => &["GLM_API_KEY", "CK_GLM_API_KEY"],
        _ => &[],
    };
    let generic_envs: &[&str] = &[
        "LLM_API_KEY",
        "CK_LLM_API_KEY",
        "OPENAI_API_KEY",
        "CK_OPENAI_API_KEY",
    ];
    let fallback_legacy_envs: &[&str] = &[
        "GLM_API_KEY",
        "CK_GLM_API_KEY",
        "DEEPSEEK_API_KEY",
        "CK_DEEPSEEK_API_KEY",
        "MINIMAX_API_KEY",
        "CK_MINIMAX_API_KEY",
    ];

    for env_key in provider_envs
        .iter()
        .chain(generic_envs.iter())
        .chain(fallback_legacy_envs.iter())
    {
        if let Ok(v) = std::env::var(env_key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn truncate_for_llm(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    out.push_str("\n...(truncated)...");
    out
}

fn normalize_glm_history_messages(
    history: Option<Vec<GlmHistoryMessage>>,
    responses: bool,
) -> Result<Vec<serde_json::Value>, String> {
    let mut cleaned: Vec<serde_json::Value> = Vec::new();
    let rows = history.unwrap_or_default();
    // Cutting the last N rows can orphan tool results and remove the original
    // task. Keep complete bounded history or reject it, never silently splice it.
    if rows.len() > 1024 { return Err("AI history exceeds 1024 messages; compact the conversation or start a new chat".to_string()); }
    for item in rows {
        let role_raw = item.role.trim().to_lowercase();
        match role_raw.as_str() {
            "system" => continue, // System prompt is managed by backend.
            "user" => {
                let content = item.content.trim().to_string();
                if !content.is_empty() {
                    cleaned.push(serde_json::json!({ "role": "user", "content": ai_request_options::image_content(&content, &item.images)? }));
                }
            }
            "assistant" => {
                // This could be a plain text response OR a tool-call response.
                // Glm reasoner models require `reasoning_content` field in all assistant messages.
                if let Some(tool_calls_val) = item.tool_calls {
                    // Assistant message with tool_calls (content may be empty/null for tool calls).
                    let content = item.content.trim().to_string();
                    let mut message = serde_json::json!({
                        "role": "assistant",
                        "content": if content.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(content) },
                        "tool_calls": tool_calls_val
                    });
                    if let Some(reasoning) = item.reasoning_content {
                        message["reasoning_content"] = serde_json::Value::String(reasoning);
                    }
                    if responses && !item.response_reasoning.is_empty() {
                        message["responseReasoning"] = serde_json::json!(item.response_reasoning);
                    }
                    cleaned.push(message);
                } else {
                    let content = item.content.trim().to_string();
                    if !content.is_empty() {
                        cleaned
                            .push(serde_json::json!({ "role": "assistant", "content": content }));
                    }
                }
            }
            "tool" => {
                // Tool result message — required by OpenAI Function Calling spec.
                // Structured tool data must not be cut inside a JSON object.
                // The CK agent bounds each result below this size and paginates.
                let content = if item.content.len() <= 128_000 {
                    item.content.trim().to_string()
                } else {
                    "{\"error\":\"Tool result too large; request a smaller page\"}".to_string()
                };
                let mut msg = serde_json::json!({ "role": "tool", "content": content });
                if let Some(id) = item.tool_call_id {
                    msg["tool_call_id"] = serde_json::json!(id);
                }
                if let Some(n) = item.name {
                    msg["name"] = serde_json::json!(n);
                }
                cleaned.push(msg);
            }
            _ => continue,
        }
    }
    if serde_json::to_vec(&cleaned).map_err(|e| e.to_string())?.len() > 12 * 1024 * 1024 {
        return Err("AI history exceeds the content budget; start a smaller request".to_string());
    }
    Ok(cleaned)
}

fn extract_glm_text_value(value: &serde_json::Value) -> String {
    if let Some(s) = value.as_str() {
        return s.trim().to_string();
    }
    if let Some(arr) = value.as_array() {
        let mut joined = String::new();
        for part in arr {
            if let Some(s) = part.as_str() {
                let text = s.trim();
                if text.is_empty() {
                    continue;
                }
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(text);
                continue;
            }
            let ty = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if ty == "text" {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    let clean = text.trim();
                    if clean.is_empty() {
                        continue;
                    }
                    if !joined.is_empty() {
                        joined.push('\n');
                    }
                    joined.push_str(clean);
                }
            }
        }
        if !joined.is_empty() {
            return joined;
        }
    }
    String::new()
}

fn extract_glm_content(message_value: &serde_json::Value) -> String {
    let null = serde_json::Value::Null;
    let content = extract_glm_text_value(message_value.get("content").unwrap_or(&null));
    if !content.is_empty() {
        return content;
    }
    // glm-reasoner occasionally returns reasoning_content only.
    let reasoning = extract_glm_text_value(message_value.get("reasoning_content").unwrap_or(&null));
    if !reasoning.is_empty() {
        return reasoning;
    }
    String::new()
}

fn extract_glm_stream_delta(choice_value: &serde_json::Value) -> (String, String) {
    let delta_obj = choice_value
        .get("delta")
        .unwrap_or(&serde_json::Value::Null);
    let reasoning = delta_obj
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut out = String::new();

    // Most models stream "delta.content" as string.
    if let Some(content_str) = delta_obj.get("content").and_then(|v| v.as_str()) {
        if !content_str.is_empty() {
            out.push_str(content_str);
        }
        return (out, reasoning);
    }

    // Fallback for array content chunks.
    if let Some(arr) = delta_obj.get("content").and_then(|v| v.as_array()) {
        for item in arr {
            let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if ty != "text" {
                continue;
            }
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if text.is_empty() {
                    continue;
                }
                out.push_str(text);
            }
        }
    }

    (out, reasoning)
}

#[tauri::command]
async fn ai_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let mut url=url::Url::parse(base_url.trim()).map_err(|_|"API 地址无效")?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || !(url.scheme()=="https" || (url.scheme()=="http" && matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]")))) {return Err("请使用 HTTPS API 地址，本机服务可用 HTTP".into());}
    if api_key.trim().is_empty() {return Err("请先填写 API 密钥".into());}
    let path=ai_responses::base_path(url.path()).to_string();
    url.set_path(&format!("{path}/models"));
    let mut builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(20));
    if matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]")){builder=builder.no_proxy();}
    let client=builder.build().map_err(|_|"无法初始化模型连接")?;
    let mut response=client.get(url).bearer_auth(api_key.trim()).send().await.map_err(|_|"无法获取模型列表，请检查地址、网络和密钥；也可手动填写模型")?;
    if !response.status().is_success(){return Err(format!("模型列表请求失败（HTTP {}）；可手动填写模型名称",response.status().as_u16()));}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"模型列表读取失败")? {if bytes.len()+chunk.len()>1024*1024{return Err("模型列表过大".into());}bytes.extend_from_slice(&chunk);}
    let value:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|"服务商没有返回有效的模型列表")?;
    let rows=value["data"].as_array().ok_or("模型列表格式不支持；请手动填写模型")?;
    let mut models:Vec<String>=rows.iter().filter_map(|v|v["id"].as_str()).filter(|s|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control)).take(500).map(str::to_owned).collect();
    models.sort();models.dedup();if models.is_empty(){return Err("模型列表为空；请手动填写模型名称".into());}Ok(models)
}

#[tauri::command]
async fn chat_with_glm(req: GlmChatRequest) -> Result<GlmChatResult, String> {
    let user_message = req.user_message.trim().to_string();
    // __TOOL_CONTINUE__ 是前端 Agent Engine 中间轮的特殊标记，表示不需要追加 user 消息
    let is_tool_continue = user_message == "__TOOL_CONTINUE__";
    if user_message.is_empty() {
        return Err("Empty user message".to_string());
    }

    let provider = resolve_active_provider();
    // Resolve provider settings dynamically.
    let provider_base_url = req
        .base_url
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| provider.as_ref().map(|p| p.base_url.clone()))
        .unwrap_or_default();
    let api_key = resolve_llm_api_key(
        req.api_key,
        provider.as_ref().map(|p| p.provider_id.as_str()),
        Some(&provider_base_url),
    )
    .ok_or(
        "API key is missing. Please provide key in UI or set provider-specific env (GLM_API_KEY / DEEPSEEK_API_KEY / MINIMAX_API_KEY).",
    )?;
    let responses=ai_responses::selected(req.api_protocol.as_deref())?;
    let completions_url = ai_endpoint(&provider_base_url,responses)?;

    let model = req
        .model
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            provider
                .as_ref()
                .map(|p| p.default_model.clone())
                .filter(|m| !m.is_empty())
        })
        .or_else(read_default_model_from_settings)
        .unwrap_or_else(|| "glm-4-flash".to_string());
    let is_reasoner_model = model.to_lowercase().contains("reasoner");
    let default_timeout_ms = if is_reasoner_model { 300_000 } else { 120_000 };
    let timeout_ms = req
        .timeout_ms
        .unwrap_or(default_timeout_ms)
        .clamp(20_000, 900_000);
    let temperature = req.temperature.unwrap_or(0.2).clamp(0.0, 1.2);
    let system_prompt = req.system_prompt.unwrap_or_else(|| {
        "你是 CK Blockly Agent。请基于用户提供的上下文，给出可执行、可验证、分步骤的中文建议；\
必要时指出缺少的积木/库/板卡限制，并给至少2种可选修复方案（含影响）。"
            .to_string()
    });

    let mut user_payload = String::new();
    user_payload.push_str("用户请求：\n");
    user_payload.push_str(&user_message);
    if let Some(ctx) = req.context_json {
        let trimmed = ctx.trim();
        if !trimmed.is_empty() {
            user_payload.push_str("\n\n当前上下文(JSON)：\n");
            user_payload.push_str(&truncate_for_llm(trimmed, 14_000));
        }
    }

    let normalized_history = normalize_glm_history_messages(req.history_messages,responses)?;
    log::info!(
        "LLM non-stream request: {} history rows, model={}, url={}",
        normalized_history.len(),
        model,
        completions_url
    );

    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "system",
        "content": system_prompt
    })];
    messages.extend(normalized_history);
    // 中间轮（tool continue）时不追加 user 消息，让 messages 末尾是 tool result
    if !is_tool_continue {
        messages.push(serde_json::json!({
            "role": "user",
            "content": ai_request_options::image_content(&user_payload, &req.images)?
        }));
    }

    let mut body = serde_json::json!({
        "model": model,
        "stream": false,
        "temperature": temperature,
        "messages": messages
    });
    if let Some(max_tokens) = req.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens.clamp(64, 32768));
    }

    if !responses { ai_request_options::apply_reasoning(&mut body, req.reasoning_protocol.as_deref(), req.reasoning_effort.as_deref(), &provider_base_url)?; }

    // Add function calling tools if provided.
    if let Some(ref tools) = req.tools {
        if !tools.is_empty() {
            let tools_json: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    let mut func_obj = serde_json::json!({
                        "name": t.function.name
                    });
                    if let Some(ref desc) = t.function.description {
                        func_obj["description"] = serde_json::json!(desc);
                    }
                    if let Some(ref params) = t.function.parameters {
                        func_obj["parameters"] = params.clone();
                    }
                    serde_json::json!({
                        "type": t.tool_type,
                        "function": func_obj
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tools_json);
        }
    }
    if let Some(ref tool_choice) = req.tool_choice {
        body["tool_choice"] = tool_choice.clone();
    }

    if responses {body=ai_responses::request(&body,req.reasoning_effort.as_deref())?;}
    let client=ai_http_client(&completions_url,timeout_ms)?;

    let response = client
        .post(&completions_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {}", e))?;

    let status = response.status();
    let limit=if status.is_success() {bounded_sse::AGENT_SSE_LIMITS.raw_stream_bytes} else {bounded_sse::ERROR_RESPONSE_MAX_BYTES};
    let raw=bounded_sse::read_response_text_bounded(response,limit,"LLM response").await?;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|x| x.get("message"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| truncate_for_llm(&raw, 500));
        return Err(format!("LLM API HTTP {}: {}", status.as_u16(), msg));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("LLM JSON parse failed: {}", e))?;
    if responses {return ai_responses::result(&parsed);}
    let choice0 = parsed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .ok_or("LLM response missing choices[0]")?;
    let finish_reason = choice0
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let message_obj = choice0.get("message").unwrap_or(&serde_json::Value::Null);
    let content = extract_glm_content(message_obj);

    // Parse tool_calls from response if present.
    let tool_calls: Option<Vec<LlmToolCall>> = message_obj
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let call_type = tc
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("function")
                        .to_string();
                    let func = tc.get("function")?;
                    let name = func
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments = func
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}")
                        .to_string();
                    Some(LlmToolCall {
                        id,
                        call_type,
                        function: LlmToolCallFunction { name, arguments },
                    })
                })
                .collect()
        });

    let has_tool_calls = tool_calls.as_ref().map_or(false, |tc| !tc.is_empty());

    // Allow empty content if tool_calls are present (LLM chose to call tools instead of text).
    if content.is_empty() && !has_tool_calls {
        return Err("LLM returned empty content".to_string());
    }

    let usage = parsed.get("usage").unwrap_or(&serde_json::Value::Null);
    let prompt_tokens = usage
        .get("prompt_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let completion_tokens = usage
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let used_model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(GlmChatResult {
        model: used_model,
        response_reasoning:Vec::new(),
        content,
        reasoning_content: message_obj.get("reasoning_content").and_then(|v| v.as_str()).map(str::to_owned),
        finish_reason,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        raw_json: raw,
        tool_calls,
    })
}

#[tauri::command]
async fn chat_with_glm_stream(
    app: AppHandle,
    req: GlmChatRequest,
    cancel_state: State<'_, AgentLlmCancelState>,
) -> Result<GlmChatResult, String> {
    use futures_util::StreamExt;

    let user_message = req.user_message.trim().to_string();
    // __TOOL_CONTINUE__ 是前端 Agent Engine 中间轮的特殊标记
    let is_tool_continue = user_message == "__TOOL_CONTINUE__";
    if user_message.is_empty() {
        return Err("Empty user message".to_string());
    }

    let requested_run_id = req.run_id.unwrap_or_default();
    let run_id = if requested_run_id.trim().is_empty() {
        format!("agent-{}", uuid::Uuid::new_v4())
    } else {
        normalize_llm_run_id(&requested_run_id)?
    };

    let provider = resolve_active_provider();
    // Resolve provider settings dynamically.
    let provider_base_url = req
        .base_url
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| provider.as_ref().map(|p| p.base_url.clone()))
        .unwrap_or_default();
    let api_key = resolve_llm_api_key(
        req.api_key,
        provider.as_ref().map(|p| p.provider_id.as_str()),
        Some(&provider_base_url),
    )
    .ok_or(
        "API key is missing. Please provide key in UI or set provider-specific env (GLM_API_KEY / DEEPSEEK_API_KEY / MINIMAX_API_KEY).",
    )?;
    let responses=ai_responses::selected(req.api_protocol.as_deref())?;
    let completions_url = ai_endpoint(&provider_base_url,responses)?;

    let model = req
        .model
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            provider
                .as_ref()
                .map(|p| p.default_model.clone())
                .filter(|m| !m.is_empty())
        })
        .or_else(read_default_model_from_settings)
        .unwrap_or_else(|| "glm-4-flash".to_string());
    let is_reasoner_model = model.to_lowercase().contains("reasoner");
    let default_timeout_ms = if is_reasoner_model { 420_000 } else { 180_000 };
    let timeout_ms = req
        .timeout_ms
        .unwrap_or(default_timeout_ms)
        .clamp(20_000, 900_000);
    let temperature = req.temperature.unwrap_or(0.2).clamp(0.0, 1.2);
    let system_prompt = req.system_prompt.unwrap_or_else(|| {
        "你是 CK Blockly Agent。请基于用户提供的上下文，给出可执行、可验证、分步骤的中文建议；\
必要时指出缺少的积木/库/板卡限制，并给至少2种可选修复方案（含影响）。"
            .to_string()
    });

    let mut user_payload = String::new();
    user_payload.push_str("用户请求：\n");
    user_payload.push_str(&user_message);
    if let Some(ctx) = req.context_json {
        let trimmed = ctx.trim();
        if !trimmed.is_empty() {
            user_payload.push_str("\n\n当前上下文(JSON)：\n");
            user_payload.push_str(&truncate_for_llm(trimmed, 14_000));
        }
    }

    let normalized_history = normalize_glm_history_messages(req.history_messages,responses)?;
    log::info!(
        "LLM stream request: {} history rows, model={}, url={}, run_id={}",
        normalized_history.len(),
        model,
        completions_url,
        run_id
    );

    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "system",
        "content": system_prompt
    })];
    messages.extend(normalized_history);
    // 中间轮（tool continue）时不追加 user 消息
    if !is_tool_continue {
        messages.push(serde_json::json!({
            "role": "user",
            "content": ai_request_options::image_content(&user_payload, &req.images)?
        }));
    }

    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "temperature": temperature,
        "messages": messages
    });

    let max_toks = req
        .max_tokens
        .unwrap_or(if is_reasoner_model { 8192 } else { 4096 });
    body["max_tokens"] = serde_json::json!(max_toks.clamp(64, 32768));

    if !responses { ai_request_options::apply_reasoning(&mut body, req.reasoning_protocol.as_deref(), req.reasoning_effort.as_deref(), &provider_base_url)?; }

    // Add function calling tools if provided.
    if let Some(ref tools) = req.tools {
        if !tools.is_empty() {
            let tools_json: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    let mut func_obj = serde_json::json!({
                        "name": t.function.name
                    });
                    if let Some(ref desc) = t.function.description {
                        func_obj["description"] = serde_json::json!(desc);
                    }
                    if let Some(ref params) = t.function.parameters {
                        func_obj["parameters"] = params.clone();
                    }
                    serde_json::json!({
                        "type": t.tool_type,
                        "function": func_obj
                    })
                })
                .collect();
            body["tools"] = serde_json::json!(tools_json);
        }
    }
    if let Some(ref tool_choice) = req.tool_choice {
        body["tool_choice"] = tool_choice.clone();
    }

    if responses { body=ai_responses::request(&body,req.reasoning_effort.as_deref())?; }
    let client=ai_http_client(&completions_url,timeout_ms)?;

    // Do not log prompts, tool content or user credentials.
    let sending = client
        .post(&completions_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send();
    let response = tokio::select! {
        result = sending => result.map_err(|e| format!("LLM request failed: {}", e))?,
        reason = wait_for_ai_cancellation(&cancel_state, &run_id) => return Err(reason),
    };

    let status = response.status();
    if !status.is_success() {
        let raw = bounded_sse::read_response_text_bounded(
            response,
            bounded_sse::ERROR_RESPONSE_MAX_BYTES,
            "LLM error response",
        )
        .await?;
        let msg = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|x| x.get("message"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| truncate_for_llm(&raw, 500));
        return Err(format!("LLM API HTTP {}: {}", status.as_u16(), msg));
    }

    if responses {
        return tokio::select! {
            result=ai_responses::stream(response,&app,&run_id)=>result,
            reason=wait_for_ai_cancellation(&cancel_state,&run_id)=>Err(reason)
        };
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_content = String::new();
    let mut full_reasoning = String::new();
    let mut finish_reason: Option<String> = None;
    let mut prompt_tokens: Option<u32> = None;
    let mut completion_tokens: Option<u32> = None;
    let mut total_tokens: Option<u32> = None;
    let mut used_model: Option<String> = None;
    let mut saw_done = false;
    let mut stream_budget = bounded_sse::SseBudget::new(bounded_sse::AGENT_SSE_LIMITS);

    // Track streaming tool calls.
    let mut utf8_stream = ai_utf8_stream::Utf8Stream::default();
    let mut stream_tool_calls: std::collections::HashMap<u64, LlmToolCall> =
        std::collections::HashMap::new();

    let resource_limit_error = |detail: String| -> String {
        if let Ok(mut guard) = cancel_state.canceled_run_ids.lock() {
            guard.remove(&run_id);
        }
        let _ = app.emit(
            "agent-llm-delta",
            AgentLlmDeltaPayload {
                run_id: run_id.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
                model: Some(model.clone()),
                finish_reason: Some("resource_limit".to_string()),
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
            },
        );
        format!(
            "模型响应超出本次接收上限（{detail}），未执行修改。请缩小单段方案或重试"
        )
    };

    loop {
        let chunk_result = tokio::select! {
            item = stream.next() => match item { Some(item) => item, None => break },
            reason = wait_for_ai_cancellation(&cancel_state, &run_id) => return Err(reason),
        };
        let cancel_requested = {
            let mut guard = cancel_state
                .canceled_run_ids
                .lock()
                .map_err(|_| "Failed to lock Glm cancel state".to_string())?;
            guard.remove(&run_id)
        };
        if cancel_requested.is_some() {
            let _ = app.emit(
                "agent-llm-delta",
                AgentLlmDeltaPayload {
                    run_id: run_id.clone(),
                    delta: String::new(),
                    reasoning_delta: None,
                    done: true,
                    model: Some(model.clone()),
                    finish_reason: Some("cancelled".to_string()),
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                },
            );
            return Err("LLM stream cancelled by user".to_string());
        }

        let chunk = match chunk_result {
            Ok(v) => v,
            Err(e) => {
                let err = format!("LLM stream read failed: {}", e);
                if full_content.trim().is_empty() && full_reasoning.trim().is_empty() {
                    if let Ok(mut guard) = cancel_state.canceled_run_ids.lock() {
                        guard.remove(&run_id);
                    }
                    return Err(err);
                }
                if finish_reason.is_none() {
                    finish_reason = Some("stream_error_partial".to_string());
                }
                log::warn!("{}; returning partial content (run_id={})", err, run_id);
                break;
            }
        };
        stream_budget
            .observe_chunk(chunk.len())
            .map_err(&resource_limit_error)?;
        let decoded = utf8_stream.push(&chunk)?;
        stream_budget
            .append_pending_text(&mut buffer, &decoded)
            .map_err(&resource_limit_error)?;

        while let Some(pos) = buffer.find('\n') {
            let mut line = buffer[..pos].trim().to_string();
            buffer = buffer[(pos + 1)..].to_string();

            if line.is_empty() {
                continue;
            }
            if let Some(stripped) = line.strip_prefix("data:") {
                line = stripped.trim().to_string();
            } else {
                continue;
            }
            if line.is_empty() {
                continue;
            }
            if line == "[DONE]" {
                saw_done = true;
                break;
            }

            stream_budget
                .record_event()
                .map_err(&resource_limit_error)?;
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if let Some(model_name) = parsed.get("model").and_then(|v| v.as_str()) {
                let clean = model_name.trim();
                if !clean.is_empty() {
                    used_model = Some(clean.to_string());
                }
            }

            let usage = parsed.get("usage").unwrap_or(&serde_json::Value::Null);
            if let Some(v) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                prompt_tokens = Some(v as u32);
            }
            if let Some(v) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                completion_tokens = Some(v as u32);
            }
            if let Some(v) = usage.get("total_tokens").and_then(|v| v.as_u64()) {
                total_tokens = Some(v as u32);
            }

            let choice0 = parsed
                .get("choices")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if let Some(reason) = choice0.get("finish_reason").and_then(|v| v.as_str()) {
                let clean = reason.trim();
                if !clean.is_empty() {
                    finish_reason = Some(clean.to_string());
                }
            }

            // Parse streaming tool_calls
            if let Some(delta_obj) = choice0.get("delta") {
                if let Some(tcs) = delta_obj.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tcs {
                        if let Some(index) = tc.get("index").and_then(|v| v.as_u64()) {
                            if !stream_tool_calls.contains_key(&index) {
                                stream_budget
                                    .record_tool_call()
                                    .map_err(&resource_limit_error)?;
                            }
                            let mut current =
                                stream_tool_calls
                                    .remove(&index)
                                    .unwrap_or_else(|| LlmToolCall {
                                        id: String::new(),
                                        call_type: "function".to_string(),
                                        function: LlmToolCallFunction {
                                            name: String::new(),
                                            arguments: String::new(),
                                        },
                                    });

                            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                if !id.is_empty() {
                                    current.id = id.to_string();
                                }
                            }
                            if let Some(ty) = tc.get("type").and_then(|v| v.as_str()) {
                                if !ty.is_empty() {
                                    current.call_type = ty.to_string();
                                }
                            }
                            if let Some(func) = tc.get("function") {
                                if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                    if !name.is_empty() {
                                        stream_budget
                                            .append_tool_name(&mut current.function.name, name)
                                            .map_err(&resource_limit_error)?;
                                    }
                                }
                                if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                    if !args.is_empty() {
                                        stream_budget
                                            .append_tool_arguments(
                                                &mut current.function.arguments,
                                                args,
                                            )
                                            .map_err(&resource_limit_error)?;
                                    }
                                }
                            }
                            stream_tool_calls.insert(index, current);
                        }
                    }
                }
            }

            let (delta, reasoning_delta) = extract_glm_stream_delta(&choice0);
            if delta.is_empty() && reasoning_delta.is_empty() {
                continue;
            }
            if !delta.is_empty() {
                stream_budget
                    .append_generated(&mut full_content, &delta, "LLM content")
                    .map_err(&resource_limit_error)?;
            }
            if !reasoning_delta.is_empty() {
                stream_budget
                    .append_generated(&mut full_reasoning, &reasoning_delta, "LLM reasoning")
                    .map_err(&resource_limit_error)?;
            }
            let _ = app.emit(
                "agent-llm-delta",
                AgentLlmDeltaPayload {
                    run_id: run_id.clone(),
                    delta: delta.clone(),
                    reasoning_delta: if reasoning_delta.is_empty() {
                        None
                    } else {
                        Some(reasoning_delta)
                    },
                    done: false,
                    model: used_model.clone(),
                    finish_reason: finish_reason.clone(),
                    prompt_tokens: None,
                    completion_tokens: None,
                    total_tokens: None,
                },
            );
        }

        if saw_done {
            break;
        }
    }

    utf8_stream.finish()?;
    let used_model = used_model.unwrap_or_else(|| model.clone());
    let mut final_content = full_content.trim().to_string();
    let mut content_source = "content";

    // Reconstruct tool_calls from hashmap.
    let mut final_tool_calls: Option<Vec<LlmToolCall>> = None;
    if !stream_tool_calls.is_empty() {
        let mut keys: Vec<u64> = stream_tool_calls.keys().copied().collect();
        keys.sort_unstable();
        let calls: Vec<LlmToolCall> = keys
            .into_iter()
            .filter_map(|k| stream_tool_calls.remove(&k))
            .collect();
        if !calls.is_empty() {
            final_tool_calls = Some(calls);
        }
    }

    let has_tool_calls = final_tool_calls.as_ref().map_or(false, |tc| !tc.is_empty());

    if final_content.is_empty() && !has_tool_calls {
        let reasoning_fallback = full_reasoning.trim().to_string();
        if !reasoning_fallback.is_empty() {
            final_content = reasoning_fallback;
            content_source = "reasoning";
            if finish_reason.is_none() {
                finish_reason = Some("reasoning_only_fallback".to_string());
            }
        } else {
            if let Ok(mut guard) = cancel_state.canceled_run_ids.lock() {
                guard.remove(&run_id);
            }
            return Err("LLM stream returned empty content".to_string());
        }
    }

    let _ = app.emit(
        "agent-llm-delta",
        AgentLlmDeltaPayload {
            run_id: run_id.clone(),
            delta: String::new(),
            reasoning_delta: None,
            done: true,
            model: Some(used_model.clone()),
            finish_reason: finish_reason.clone(),
            prompt_tokens,
            completion_tokens,
            total_tokens,
        },
    );

    let raw_json = serde_json::json!({
        "stream": true,
        "model": used_model,
        "finish_reason": finish_reason,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "event_count": stream_budget.event_count(),
        "content_source": content_source,
        "tool_calls": final_tool_calls
    })
    .to_string();

    if let Ok(mut guard) = cancel_state.canceled_run_ids.lock() {
        guard.remove(&run_id);
    }

    Ok(GlmChatResult {
        model: used_model,
        response_reasoning:Vec::new(),
        content: final_content,
        reasoning_content: if full_reasoning.is_empty() { None } else { Some(full_reasoning) },
        finish_reason,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        raw_json,
        tool_calls: final_tool_calls,
    })
}

#[tauri::command]
async fn arduino_board_list() -> Result<String, String> {
    // Use centralized sysroot helper
    let sysroot = get_app_sysroot().await?;
    let sysroot = std::sync::Arc::new(sysroot);

    let mut client = arduino::client::ArduinoClient::new(sysroot);

    // Init (download if needed)
    client.init().await.map_err(|e| e.to_string())?;

    // Run
    let output = client
        .run_command(vec!["board", "list", "--format", "json"])
        .await
        .map_err(|e| e.to_string())?;

    Ok(output)
}

#[tauri::command]
async fn list_serial_ports()
-> Result<Vec<ck_core::executor::uploader::serial::SerialPortInfo>, String> {
    ck_core::executor::uploader::serial::list_ports().map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect_device(
    app: AppHandle,
    request: device_health::InspectDeviceRequest,
) -> device_health::DeviceHealthReport {
    let started = std::time::Instant::now();
    let sysroot = match get_app_sysroot().await {
        Ok(sysroot) => sysroot,
        Err(_) => {
            return device_health::failed_report(
                request,
                None,
                started,
                "environment",
                "真机体检环境尚未就绪",
                "无法初始化本地板卡核心环境；未执行串口探测",
                None,
            );
        }
    };
    let resolved_fqbn = match resolve_board_fqbn(&app, &request.fqbn).await {
        Ok(fqbn) => fqbn,
        Err(_) => {
            return device_health::failed_report(
                request,
                None,
                started,
                "target-resolution",
                "未能解析当前板卡目标",
                "板卡或配置选项无效；未执行串口探测",
                Some("open_board_config"),
            );
        }
    };
    device_health::inspect_resolved_device(&sysroot, request, resolved_fqbn, started).await
}

#[derive(Clone, serde::Serialize)]
struct BuildProgress {
    percentage: f32,
    message: String,
}

fn has_file_with_suffix(dir: &std::path::Path, suffix: &str) -> bool {
    let entries = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(suffix) {
                return true;
            }
        }
    }
    false
}

fn is_firmware_artifact_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".hex")
        || lower.ends_with(".bin")
        || lower.ends_with(".uf2")
        || lower.ends_with(".elf")
        || lower.ends_with(".eep")
        || lower == "flash_args"
}

fn firmware_artifact_priority(path: &std::path::Path) -> u8 {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".hex") {
        0
    } else if name.ends_with(".bin") {
        1
    } else if name.ends_with(".uf2") {
        2
    } else if name.ends_with(".elf") {
        3
    } else if name.ends_with(".eep") {
        4
    } else if name == "flash_args" {
        5
    } else {
        9
    }
}

fn push_firmware_artifact_if_needed(
    path: std::path::PathBuf,
    seen: &mut HashSet<String>,
    out: &mut Vec<std::path::PathBuf>,
) {
    if !path.is_file() {
        return;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if !is_firmware_artifact_name(name) {
        return;
    }
    let key = normalize_path_key(&path);
    if seen.insert(key) {
        out.push(path);
    }
}

fn collect_firmware_artifacts(build_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    if !build_path.exists() || !build_path.is_dir() {
        return Vec::new();
    }

    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Ok(entries) = std::fs::read_dir(build_path) {
        for entry in entries.flatten() {
            push_firmware_artifact_if_needed(entry.path(), &mut seen, &mut out);
        }
    }

    // Fallback: some cores may place artifacts in nested output folders.
    if out.is_empty() {
        let walker = walkdir::WalkDir::new(build_path).max_depth(4).into_iter();
        for entry in walker.filter_entry(|e| !e.file_name().to_str().unwrap_or("").starts_with('.'))
        {
            if let Ok(entry) = entry {
                push_firmware_artifact_if_needed(entry.path().to_path_buf(), &mut seen, &mut out);
            }
        }
    }

    out.sort_by(|a, b| {
        firmware_artifact_priority(a)
            .cmp(&firmware_artifact_priority(b))
            .then_with(|| normalize_path_key(a).cmp(&normalize_path_key(b)))
    });
    out
}

fn extract_cli_usage_lines(full_log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for raw_line in full_log.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let is_usage_line = line.starts_with("Using library ")
            || line.starts_with("Used library ")
            || line.starts_with("Using platform ")
            || line.starts_with("Used platform ")
            || line.starts_with("Using core ")
            || line.starts_with("Used core ")
            || line.starts_with("Using board ");
        if !is_usage_line {
            continue;
        }
        if seen.insert(line.to_string()) {
            out.push(line.to_string());
        }
    }

    out
}

fn flash_args_bin_references(content: &str) -> Vec<String> {
    content
        .split_whitespace()
        .map(|token| token.trim_matches(['\'', '"']))
        .filter(|token| token.to_ascii_lowercase().ends_with(".bin"))
        .map(|token| {
            token
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(token)
                .to_string()
        })
        .collect()
}

fn validate_nonempty_regular_artifact(
    build_path: &std::path::Path,
    file_name: &str,
    label: &str,
) -> Result<std::fs::Metadata, String> {
    let path = build_path.join(file_name);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        format!(
            "Upload blocked: {} referenced by flash_args is missing: {}",
            label,
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Upload blocked: {} is not a regular file: {}",
            label,
            path.display()
        ));
    }
    if metadata.len() == 0 {
        return Err(format!(
            "Upload blocked: {} is empty: {}",
            label,
            path.display()
        ));
    }
    Ok(metadata)
}

fn fqbn_option_value<'a>(fqbn: &'a str, wanted_key: &str) -> Option<&'a str> {
    fqbn.splitn(4, ':').nth(3)?.split(',').find_map(|option| {
        let (key, value) = option.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case(wanted_key)
            .then_some(value.trim())
    })
}

fn flash_args_flag_value<'a>(content: &'a str, wanted_flag: &str) -> Option<&'a str> {
    let tokens = content.split_whitespace().collect::<Vec<_>>();
    let normalized_wanted = wanted_flag.replace('_', "-");
    for (index, raw_token) in tokens.iter().enumerate() {
        let token = raw_token.trim_matches(['\'', '"']);
        if let Some((flag, value)) = token.split_once('=') {
            if flag
                .replace('_', "-")
                .eq_ignore_ascii_case(&normalized_wanted)
            {
                let clean = value.trim_matches(['\'', '"']);
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        }
        if token
            .replace('_', "-")
            .eq_ignore_ascii_case(&normalized_wanted)
        {
            if let Some(value) = tokens.get(index + 1) {
                let clean = value.trim_matches(['\'', '"']);
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        }
    }
    None
}

fn normalize_flash_size_label(value: &str) -> String {
    let upper = value.trim().to_ascii_uppercase();
    if upper.ends_with('M') && !upper.ends_with("MB") {
        format!("{upper}B")
    } else {
        upper
    }
}

fn validate_esp32_upload_artifacts(build_path: &std::path::Path, fqbn: &str) -> Result<(), String> {
    let flash_args_path = build_path.join("flash_args");
    let flash_args_meta = std::fs::symlink_metadata(&flash_args_path).map_err(|_| {
        format!(
            "Upload blocked: missing required ESP32 artifact 'flash_args' in {}",
            build_path.display()
        )
    })?;
    if flash_args_meta.file_type().is_symlink()
        || !flash_args_meta.is_file()
        || flash_args_meta.len() == 0
    {
        return Err(format!(
            "Upload blocked: ESP32 flash_args is empty or not a regular file: {}",
            flash_args_path.display()
        ));
    }

    let content = std::fs::read_to_string(&flash_args_path)
        .map_err(|error| format!("Upload blocked: cannot read flash_args: {error}"))?;
    if let Some(selected_flash_size) = fqbn_option_value(fqbn, "FlashSize") {
        let actual_flash_size =
            flash_args_flag_value(&content, "--flash-size").ok_or_else(|| {
                "Upload blocked: ESP32 flash_args has no resolved --flash-size".to_string()
            })?;
        if normalize_flash_size_label(selected_flash_size)
            != normalize_flash_size_label(actual_flash_size)
        {
            return Err(format!(
                "Upload blocked: flash_args flash size {} does not match selected FQBN FlashSize={}",
                actual_flash_size, selected_flash_size
            ));
        }
    }
    let references = flash_args_bin_references(&content);
    let bootloaders = references
        .iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".bootloader.bin"))
        .collect::<Vec<_>>();
    let partitions = references
        .iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".partitions.bin"))
        .collect::<Vec<_>>();
    if bootloaders.len() != 1 || partitions.len() != 1 {
        return Err(
            "Upload blocked: flash_args must reference exactly one current bootloader and partition binary"
                .to_string(),
        );
    }

    let bootloader_name = bootloaders[0].as_str();
    let partitions_name = partitions[0].as_str();
    let project_name = bootloader_name
        .strip_suffix(".bootloader.bin")
        .ok_or_else(|| "Upload blocked: invalid bootloader artifact name".to_string())?;
    let expected_project_name =
        upload_artifact_manifest::arduino_project_name_from_build_path(build_path)?;
    if !project_name.eq_ignore_ascii_case(&expected_project_name) {
        return Err(format!(
            "Upload blocked: flash_args references stale ESP32 artifacts for {} (current build is {})",
            project_name, expected_project_name
        ));
    }
    let expected_partitions = format!("{project_name}.partitions.bin");
    let expected_app = format!("{project_name}.bin");
    if !partitions_name.eq_ignore_ascii_case(&expected_partitions) {
        return Err(format!(
            "Upload blocked: flash_args mixes ESP32 artifact sets (expected {}, got {})",
            expected_partitions, partitions_name
        ));
    }
    if references
        .iter()
        .filter(|name| name.eq_ignore_ascii_case(&expected_app))
        .count()
        != 1
    {
        return Err(format!(
            "Upload blocked: flash_args must reference current ESP32 application {} exactly once",
            expected_app
        ));
    }

    validate_nonempty_regular_artifact(build_path, bootloader_name, "ESP32 bootloader")?;
    validate_nonempty_regular_artifact(build_path, partitions_name, "ESP32 partition table")?;
    let app_metadata =
        validate_nonempty_regular_artifact(build_path, &expected_app, "ESP32 application")?;
    let expected_elf = format!("{project_name}.elf");
    let elf_metadata = validate_nonempty_regular_artifact(build_path, &expected_elf, "ESP32 ELF")?;
    let app_modified = app_metadata.modified().map_err(|error| {
        format!(
            "Upload blocked: cannot read ESP32 application modification time for {}: {}",
            build_path.join(&expected_app).display(),
            error
        )
    })?;
    let elf_modified = elf_metadata.modified().map_err(|error| {
        format!(
            "Upload blocked: cannot read ESP32 ELF modification time for {}: {}",
            build_path.join(&expected_elf).display(),
            error
        )
    })?;
    if app_modified < elf_modified {
        return Err(format!(
            "Upload blocked: stale ESP32 application {} is older than current ELF {}",
            expected_app, expected_elf
        ));
    }
    Ok(())
}

fn validate_upload_artifacts(build_path: &std::path::Path, fqbn: &str) -> Result<(), String> {
    if !build_path.exists() {
        return Err(format!(
            "Upload blocked: build path missing: {}",
            build_path.display()
        ));
    }

    if fqbn.starts_with("esp32:") {
        return validate_esp32_upload_artifacts(build_path, fqbn);
    }

    // AVR-specific validation: require .hex file (produced by objcopy)
    if fqbn.starts_with("arduino:avr:") {
        if !has_file_with_suffix(build_path, ".hex") {
            return Err(format!(
                "Upload blocked: missing *.hex firmware artifact in {}",
                build_path.display()
            ));
        }
        return Ok(());
    }

    // Generic fallback for other platforms.
    let has_payload = has_file_with_suffix(build_path, ".hex")
        || has_file_with_suffix(build_path, ".bin")
        || has_file_with_suffix(build_path, ".uf2")
        || has_file_with_suffix(build_path, ".elf");
    if !has_payload {
        return Err(format!(
            "Upload blocked: no firmware payload artifact found in {}",
            build_path.display()
        ));
    }
    Ok(())
}

fn seal_or_validate_upload_artifacts(
    build_path: &std::path::Path,
    fqbn: &str,
    build_signature: &str,
    compile_log: &str,
) -> Result<(), String> {
    validate_upload_artifacts(build_path, fqbn)?;
    if !upload_artifact_manifest::supports_manifest(fqbn) {
        return Ok(());
    }

    // An exact-match result did not rebuild the payload. Never bless the files
    // as new in that case: only a manifest issued by the original successful
    // build may authorize them. A real compile/relink may issue a fresh seal.
    if compile_log.contains("Cached build (Exact Match)") {
        upload_artifact_manifest::validate(build_path, fqbn, build_signature)
    } else {
        // `write` hashes the complete, structurally validated artifact set and
        // reads the installed manifest back. Do not immediately hash the same
        // firmware a second time; the full manifest is independently
        // revalidated immediately before transport below.
        upload_artifact_manifest::write(build_path, fqbn, build_signature).map(|_| ())
    }
}

fn validate_upload_artifacts_for_transport(
    build_path: &std::path::Path,
    fqbn: &str,
    build_signature: &str,
) -> Result<(), String> {
    validate_upload_artifacts(build_path, fqbn)?;
    if upload_artifact_manifest::supports_manifest(fqbn) {
        upload_artifact_manifest::validate(build_path, fqbn, build_signature)?;
    }
    Ok(())
}

async fn run_upload_transport_with_identity_gate<F, Fut, T>(
    identity_lease: &ck_core::builder::demo::ToolchainIdentityLease,
    sysroot_root: &std::path::Path,
    fqbn: &str,
    start_transport: F,
) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    identity_lease
        .revalidate_before_external_boundary(sysroot_root, fqbn)
        .map_err(|error| {
            format!(
                "Upload blocked before transport because Core/toolchain identity changed: {error}"
            )
        })?;
    start_transport().await
}

fn maintain_upload_manifest_after_compile(
    build_path: &std::path::Path,
    fqbn: &str,
    build_signature: &str,
    compile_log: &str,
) -> Result<Option<&'static str>, String> {
    if !upload_artifact_manifest::supports_manifest(fqbn) {
        return Ok(None);
    }
    if compile_log.contains("Cached build (Exact Match)") {
        upload_artifact_manifest::validate(build_path, fqbn, build_signature)?;
        return Ok(Some("validated existing exact-match manifest"));
    }

    if let Err(reason) = validate_upload_artifacts(build_path, fqbn) {
        upload_artifact_manifest::invalidate(build_path)?;
        return Err(format!("build is not upload-ready: {reason}"));
    }
    // A fresh compile seals the complete current set with one SHA-256 pass.
    // Future upload always calls `validate_upload_artifacts_for_transport`, so
    // removing an identical immediate second pass cannot bypass the gate.
    upload_artifact_manifest::write(build_path, fqbn, build_signature)?;
    Ok(Some("sealed upload-ready artifacts"))
}

#[cfg(test)]
mod upload_artifact_tests {
    use super::{
        maintain_upload_manifest_after_compile, run_upload_transport_with_identity_gate,
        seal_or_validate_upload_artifacts, validate_upload_artifacts,
        validate_upload_artifacts_for_transport,
    };
    use crate::upload_artifact_manifest::{reset_sha256_file_call_count, sha256_file_call_count};

    fn test_temp_dir(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("ck-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("test temp dir");
        path
    }

    fn write_esp32_set(build: &std::path::Path, project: &str, flash_size: &str) {
        std::fs::create_dir_all(build).expect("build dir");
        std::fs::write(build.join(format!("{project}.elf")), b"current elf").expect("ESP32 ELF");
        for (suffix, payload) in [
            (".bootloader.bin", b"bootloader".as_slice()),
            (".partitions.bin", b"partitions".as_slice()),
            (".bin", b"application".as_slice()),
        ] {
            std::fs::write(build.join(format!("{project}{suffix}")), payload)
                .expect("ESP32 artifact");
        }
        std::fs::write(
            build.join("flash_args"),
            format!(
                "--flash-mode dio --flash-size {flash_size}\n0x0 {project}.bootloader.bin\n0x8000 {project}.partitions.bin\n0xe000 boot_app0.bin\n0x10000 {project}.bin\n"
            ),
        )
        .expect("flash_args");
    }

    fn set_modified(path: &std::path::Path, modified: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("artifact for timestamp update");
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("set deterministic artifact timestamp");
    }

    fn upload_identity_fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = test_temp_dir("upload-toolchain-identity");
        let platform = root.join("packages/acme/hardware/demo/1.2.3");
        let core = platform.join("cores/demo/main.cpp");
        let variant = platform.join("variants/demo/pins.h");
        let tool = root.join(if cfg!(windows) {
            "packages/acme/tools/demo-gcc/9.1.0/bin/demo-gcc.exe"
        } else {
            "packages/acme/tools/demo-gcc/9.1.0/bin/demo-gcc"
        });
        for directory in [
            core.parent().expect("core parent"),
            variant.parent().expect("variant parent"),
            tool.parent().expect("tool parent"),
            &root.join("cache"),
        ] {
            std::fs::create_dir_all(directory).expect("upload identity fixture directory");
        }
        std::fs::write(platform.join("platform.txt"), "recipe.c.o.pattern=v1\n")
            .expect("platform fixture");
        std::fs::write(platform.join("boards.txt"), "board.name=Demo\n").expect("board fixture");
        std::fs::write(&core, "int core_v1;\n").expect("core fixture");
        std::fs::write(variant, "#define LED 1\n").expect("variant fixture");
        std::fs::write(tool, b"tool-v1").expect("tool fixture");
        (root, core)
    }

    #[cfg(any(windows, unix))]
    fn overwrite_equal_length_restoring_mtime(path: &std::path::Path, contents: &[u8]) {
        let before = std::fs::metadata(path).expect("identity metadata before edit");
        let modified = before.modified().expect("identity mtime before edit");
        assert_eq!(before.len(), contents.len() as u64);
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(path, contents).expect("external identity edit");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("edited identity file");
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("restore identity mtime");
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn normal_and_restore_upload_identity_gate_blocks_before_transport_boundary() {
        let (root, core) = upload_identity_fixture();
        let fqbn = "acme:demo:board";
        ck_core::builder::demo::invalidate_process_toolchain_identity_cache();
        let lease = ck_core::builder::demo::ToolchainIdentityLease::begin(&root, fqbn)
            .expect("upload request identity lease");
        overwrite_equal_length_restoring_mtime(&core, b"int core_v2;\n");

        let boundary = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let boundary_for_transport = std::sync::Arc::clone(&boundary);
        let result = run_upload_transport_with_identity_gate(&lease, &root, fqbn, || async move {
            boundary_for_transport.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, String>(())
        })
        .await;
        let error = result.expect_err("external toolchain edit must block upload transport");
        assert!(error.contains("blocked before transport"));
        assert_eq!(
            boundary.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "neither ordinary upload nor restore may resolve/start transport after identity failure"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn esp32_upload_gate_requires_current_complete_flash16_set() {
        let temp = test_temp_dir("esp32-upload-flash16");
        let project = "sketch_esp32s3_flash16_qfast2.ino";
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, project, "16MB");
        validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect("complete current 16MB Flash set");

        std::fs::remove_file(build.join(format!("{project}.bin"))).expect("remove app");
        let error = validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect_err("bootloader .bin must not impersonate the application binary");
        assert!(error.contains("application"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn esp32_upload_gate_accepts_legacy_and_out_of_tree_build_layouts() {
        for out_of_tree in [false, true] {
            let temp = test_temp_dir("esp32-upload-layout");
            let directory_name = "sketch_esp32s3_layout_rel";
            let project = format!("{directory_name}.ino");
            let build = if out_of_tree {
                temp.join("build").join(directory_name)
            } else {
                temp.join(directory_name).join("build")
            };
            write_esp32_set(&build, &project, "16MB");
            validate_upload_artifacts(
                &build,
                "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
            )
            .expect("current ESP32 artifact set in supported build layout");
            let _ = std::fs::remove_dir_all(temp);
        }
    }

    #[test]
    fn esp32_upload_gate_rejects_old_flash8_artifacts_in_flash16_build_directory() {
        let temp = test_temp_dir("esp32-upload-stale-flash8");
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, "sketch_esp32s3_flash8_qfast2.ino", "16MB");
        let error = validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect_err("old 8MB Flash four-piece set must not pass the 16MB Flash upload gate");
        assert!(error.contains("stale ESP32 artifacts"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn esp32_upload_gate_rejects_default_4m_flash_args_for_flash8_or_flash16() {
        let temp = test_temp_dir("esp32-upload-default-flash-size");
        let project = "sketch_esp32s3_flash16_qfast2.ino";
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, project, "4MB");
        let error = validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect_err("default 4MB flash_args must not pass a 16MB Flash target");
        assert!(error.contains("does not match selected FQBN FlashSize=16M"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn esp32_upload_gate_accepts_equals_and_legacy_flash_size_flags() {
        for flag in ["--flash-size=16MB", "--flash_size=16MB"] {
            let temp = test_temp_dir("esp32-upload-flash-size-spelling");
            let project = "sketch_esp32s3_flash16_qfast2.ino";
            let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
            write_esp32_set(&build, project, "16MB");
            std::fs::write(
                build.join("flash_args"),
                format!(
                    "{flag}\n0x0 {project}.bootloader.bin\n0x8000 {project}.partitions.bin\n0xe000 boot_app0.bin\n0x10000 {project}.bin\n"
                ),
            )
            .expect("flash_args spelling");
            validate_upload_artifacts(
                &build,
                "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
            )
            .expect("supported flash-size spelling");
            let _ = std::fs::remove_dir_all(temp);
        }
    }

    #[test]
    fn esp32_upload_gate_rejects_application_bin_older_than_current_elf() {
        let temp = test_temp_dir("esp32-upload-stale-app-bin");
        let project = "sketch_esp32s3_flash16_qfast2.ino";
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, project, "16MB");
        let baseline = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        set_modified(
            &build.join(format!("{project}.bin")),
            baseline + std::time::Duration::from_secs(1),
        );
        set_modified(
            &build.join(format!("{project}.elf")),
            baseline + std::time::Duration::from_secs(2),
        );

        let error = validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect_err("an application BIN older than the current ELF must be rejected");
        assert!(error.contains("stale ESP32 application"));
        assert!(error.contains("older than current ELF"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn esp32_upload_gate_accepts_application_bin_newer_than_current_elf() {
        let temp = test_temp_dir("esp32-upload-fresh-app-bin");
        let project = "sketch_esp32s3_flash16_qfast2.ino";
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, project, "16MB");
        let baseline = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        set_modified(
            &build.join(format!("{project}.elf")),
            baseline + std::time::Duration::from_secs(1),
        );
        set_modified(
            &build.join(format!("{project}.bin")),
            baseline + std::time::Duration::from_secs(2),
        );

        validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect("a freshly generated application BIN must be accepted");
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn esp32_upload_gate_accepts_application_bin_with_same_timestamp_as_current_elf() {
        let temp = test_temp_dir("esp32-upload-equal-app-bin");
        let project = "sketch_esp32s3_flash16_qfast2.ino";
        let build = temp.join("sketch_esp32s3_flash16_qfast2").join("build");
        write_esp32_set(&build, project, "16MB");
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        set_modified(&build.join(format!("{project}.elf")), modified);
        set_modified(&build.join(format!("{project}.bin")), modified);

        validate_upload_artifacts(
            &build,
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi",
        )
        .expect("equal Windows filesystem timestamps must be accepted");
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn exact_match_upload_never_self_seals_missing_or_tampered_avr_artifacts() {
        let temp = test_temp_dir("avr-upload-manifest-exact-match");
        let build = temp.join("build");
        std::fs::create_dir_all(&build).expect("AVR build dir");
        std::fs::write(build.join("blink.ino.hex"), b":00000001FF\n").expect("AVR HEX");
        let fqbn = "arduino:avr:nano:cpu=atmega328old";
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({ "fqbn": fqbn }).to_string(),
        )
        .expect("build options");

        let exact_log = "[INFO] Cached build (Exact Match) - skipping compilation.\n";
        let error = seal_or_validate_upload_artifacts(&build, fqbn, "signature", exact_log)
            .expect_err("an exact cache hit must not bless a missing manifest");
        assert!(error.contains("required artifact manifest"));

        seal_or_validate_upload_artifacts(&build, fqbn, "signature", "fresh compile\n")
            .expect("a fresh compile may seal its verified artifact");
        validate_upload_artifacts_for_transport(&build, fqbn, "signature")
            .expect("freshly sealed artifact must pass the final transport gate");

        std::fs::write(build.join("blink.ino.hex"), b":tampered\n").expect("tamper HEX");
        let error = seal_or_validate_upload_artifacts(&build, fqbn, "signature", exact_log)
            .expect_err("an exact cache hit must not re-seal a modified artifact");
        assert!(error.contains("artifact size mismatch") || error.contains("SHA-256 mismatch"));
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn fresh_seal_hashes_once_and_transport_gate_hashes_again() {
        let temp = test_temp_dir("avr-upload-manifest-hash-passes");
        let build = temp.join("build");
        std::fs::create_dir_all(&build).expect("AVR build dir");
        std::fs::write(build.join("blink.ino.hex"), b":00000001FF\n").expect("AVR HEX");
        let fqbn = "arduino:avr:uno";
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({ "fqbn": fqbn }).to_string(),
        )
        .expect("build options");

        reset_sha256_file_call_count();
        seal_or_validate_upload_artifacts(&build, fqbn, "signature", "fresh compile\n")
            .expect("fresh build seal");
        assert_eq!(
            sha256_file_call_count(),
            1,
            "fresh seal must hash the single firmware payload exactly once"
        );

        validate_upload_artifacts_for_transport(&build, fqbn, "signature").expect("transport gate");
        assert_eq!(
            sha256_file_call_count(),
            2,
            "transport gate must independently re-hash the payload"
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn compile_post_processing_seals_once_and_exact_match_revalidates() {
        let temp = test_temp_dir("avr-compile-post-hash-passes");
        let build = temp.join("build");
        std::fs::create_dir_all(&build).expect("AVR build dir");
        std::fs::write(build.join("blink.ino.hex"), b":00000001FF\n").expect("AVR HEX");
        let fqbn = "arduino:avr:uno";
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({ "fqbn": fqbn }).to_string(),
        )
        .expect("build options");

        reset_sha256_file_call_count();
        assert_eq!(
            maintain_upload_manifest_after_compile(&build, fqbn, "signature", "fresh compile\n",)
                .expect("fresh compile manifest"),
            Some("sealed upload-ready artifacts")
        );
        assert_eq!(
            sha256_file_call_count(),
            1,
            "compile post-processing must not duplicate the fresh artifact hash pass"
        );

        assert_eq!(
            maintain_upload_manifest_after_compile(
                &build,
                fqbn,
                "signature",
                "[INFO] Cached build (Exact Match) - skipping compilation.\n",
            )
            .expect("exact manifest validation"),
            Some("validated existing exact-match manifest")
        );
        assert_eq!(
            sha256_file_call_count(),
            2,
            "Exact reuse must still independently hash-check the existing payload"
        );
        let _ = std::fs::remove_dir_all(temp);
    }
}

fn board_fqbn_resolve_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

type BoardOptionSchema = HashMap<String, HashSet<String>>;

fn board_option_schema_cache() -> &'static Mutex<HashMap<String, BoardOptionSchema>> {
    static CACHE: OnceLock<Mutex<HashMap<String, BoardOptionSchema>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalidate_board_definition_caches() {
    if let Ok(mut cache) = board_fqbn_resolve_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = board_option_schema_cache().lock() {
        cache.clear();
    }
}

fn split_fqbn_base_and_options(fqbn: &str) -> (String, Option<String>) {
    let trimmed = fqbn.trim();
    if let Some(base) = normalize_base_fqbn(trimmed) {
        let parts: Vec<&str> = trimmed.split(':').collect();
        if parts.len() > 3 {
            return (base, Some(parts[3..].join(":")));
        }
        return (base, None);
    }
    if let Some(idx) = trimmed.find(':') {
        return (
            trimmed[..idx].to_string(),
            Some(trimmed[idx + 1..].to_string()),
        );
    }
    (trimmed.to_string(), None)
}

fn is_valid_fqbn_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn sanitize_fqbn_option_string(
    raw_options: Option<&str>,
    allowed_schema: Option<&BoardOptionSchema>,
) -> (Option<String>, Vec<String>) {
    let Some(raw) = raw_options else {
        return (None, Vec::new());
    };
    let trimmed = raw.trim().trim_start_matches(':');
    if trimmed.is_empty() {
        return (None, Vec::new());
    }

    let mut kept: BTreeMap<String, String> = BTreeMap::new();
    let mut dropped: Vec<String> = Vec::new();

    for item in trimmed.split(',') {
        let token = item.trim();
        if token.is_empty() {
            continue;
        }
        let Some(eq_idx) = token.find('=') else {
            dropped.push(token.to_string());
            continue;
        };
        let key = token[..eq_idx].trim();
        let value = token[eq_idx + 1..].trim();
        if !is_valid_fqbn_token(key) || !is_valid_fqbn_token(value) {
            dropped.push(token.to_string());
            continue;
        }
        if let Some(schema) = allowed_schema {
            let Some(allowed_values) = schema.get(key) else {
                dropped.push(token.to_string());
                continue;
            };
            if !allowed_values.contains(value) {
                dropped.push(token.to_string());
                continue;
            }
        }
        kept.insert(key.to_string(), value.to_string());
    }

    if kept.is_empty() {
        (None, dropped)
    } else {
        (
            Some(
                kept.into_iter()
                    .map(|(key, value)| format!("{}={}", key, value))
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            dropped,
        )
    }
}

fn installed_board_option_schema(
    sysroot_root: &std::path::Path,
    base_fqbn: &str,
) -> Option<BoardOptionSchema> {
    let parts = base_fqbn.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let platform_parent = sysroot_root
        .join("packages")
        .join(parts[0])
        .join("hardware")
        .join(parts[1]);
    let mut versions = std::fs::read_dir(&platform_parent)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    // Match the build engine/Core passport exactly. Arduino-compatible vendors
    // commonly publish v-prefixed or natural legacy folders such as v1.9 and
    // v1.10, where lexical ordering would inspect the wrong boards.txt.
    ck_core::builder::core_version::sort_core_versions(&mut versions);
    let platform_root = platform_parent.join(versions.pop()?);

    let board_prefix = format!("{}.", parts[2]);
    let menu_prefix = format!("{}menu.", board_prefix);
    let mut board_found = false;
    let mut schema: BoardOptionSchema = HashMap::new();
    for file_name in ["boards.txt", "boards.local.txt"] {
        let Ok(contents) = std::fs::read_to_string(platform_root.join(file_name)) else {
            continue;
        };
        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((full_key, _value)) = line.split_once('=') else {
                continue;
            };
            let full_key = full_key.trim();
            if full_key == format!("{}name", board_prefix) {
                board_found = true;
            }
            let Some(menu_rest) = full_key.strip_prefix(&menu_prefix) else {
                continue;
            };
            let mut menu_parts = menu_rest.split('.');
            let Some(menu_id) = menu_parts.next() else {
                continue;
            };
            let Some(selection_id) = menu_parts.next() else {
                continue;
            };
            if is_valid_fqbn_token(menu_id) && is_valid_fqbn_token(selection_id) {
                schema
                    .entry(menu_id.to_string())
                    .or_default()
                    .insert(selection_id.to_string());
            }
        }
    }
    board_found.then_some(schema)
}

fn board_option_schema_from_details(parsed: &serde_json::Value) -> BoardOptionSchema {
    let mut schema: BoardOptionSchema = HashMap::new();
    if let Some(options) = parsed
        .get("config_options")
        .and_then(serde_json::Value::as_array)
    {
        for option in options {
            let Some(key) = option
                .get("option")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|key| is_valid_fqbn_token(key))
            else {
                continue;
            };
            let values = option
                .get("values")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|value| value.get("value").and_then(serde_json::Value::as_str))
                .map(str::trim)
                .filter(|value| is_valid_fqbn_token(value))
                .map(str::to_string)
                .collect::<HashSet<_>>();
            schema.insert(key.to_string(), values);
        }
    }
    schema
}

async fn get_board_option_schema(app: &AppHandle, base_fqbn: &str) -> Option<BoardOptionSchema> {
    if !base_fqbn.contains(':') {
        return None;
    }

    if let Ok(cache) = board_option_schema_cache().lock() {
        if let Some(schema) = cache.get(base_fqbn) {
            return Some(schema.clone());
        }
    }

    // Installed platform metadata already contains the option menu keys. A
    // local parse takes sub-millisecond time and avoids launching Arduino CLI
    // `board details` (4-6 seconds on the first upload after app startup).
    if let Ok(sysroot) = get_app_sysroot().await {
        if let Some(schema) = installed_board_option_schema(&sysroot.root_dir, base_fqbn) {
            if let Ok(mut cache) = board_option_schema_cache().lock() {
                cache.insert(base_fqbn.to_string(), schema.clone());
            }
            return Some(schema);
        }
    }

    let details_json = get_board_details(app.clone(), base_fqbn.to_string())
        .await
        .ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&details_json).ok()?;
    let schema = board_option_schema_from_details(&parsed);

    if let Ok(mut cache) = board_option_schema_cache().lock() {
        cache.insert(base_fqbn.to_string(), schema.clone());
    }

    Some(schema)
}

#[cfg(test)]
mod fqbn_option_tests {
    use super::{
        board_fqbn_resolve_cache, board_option_schema_cache, board_option_schema_from_details,
        finalize_resolved_fqbn_options, installed_board_option_schema,
        invalidate_board_definition_caches, sanitize_fqbn_option_string,
    };
    use std::collections::{HashMap, HashSet};

    #[test]
    fn installed_board_options_are_read_without_spawning_arduino_cli() {
        let temp =
            std::env::temp_dir().join(format!("ck-fqbn-option-test-{}", uuid::Uuid::new_v4()));
        let platform = temp.join("packages/arduino/hardware/avr/1.8.6");
        std::fs::create_dir_all(&platform).expect("platform dir");
        std::fs::write(
            platform.join("boards.txt"),
            "nano.name=Arduino Nano\n\
             nano.menu.cpu.atmega328=ATmega328P\n\
             nano.menu.cpu.atmega328.upload.speed=115200\n\
             nano.menu.cpu.atmega328old=ATmega328P (Old Bootloader)\n\
             nano.menu.cpu.atmega328old.upload.speed=57600\n",
        )
        .expect("boards.txt");

        assert_eq!(
            installed_board_option_schema(&temp, "arduino:avr:nano"),
            Some(HashMap::from([(
                "cpu".to_string(),
                HashSet::from(["atmega328".to_string(), "atmega328old".to_string()])
            )]))
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn local_option_keys_preserve_valid_cpu_and_drop_unknown_values() {
        let allowed = HashMap::from([(
            "cpu".to_string(),
            HashSet::from(["atmega328".to_string(), "atmega328old".to_string()]),
        )]);
        let (kept, dropped) =
            sanitize_fqbn_option_string(Some("cpu=atmega328old,UploadSpeed=fast"), Some(&allowed));
        assert_eq!(kept.as_deref(), Some("cpu=atmega328old"));
        assert_eq!(dropped, vec!["UploadSpeed=fast"]);
    }

    #[test]
    fn esp32_option_schema_accepts_known_flash8_flash16_values_and_rejects_unknown_values() {
        let allowed = HashMap::from([
            (
                "FlashSize".to_string(),
                HashSet::from(["8M".to_string(), "16M".to_string()]),
            ),
            (
                "PartitionScheme".to_string(),
                HashSet::from(["default_8MB".to_string(), "fatflash".to_string()]),
            ),
            (
                "PSRAM".to_string(),
                HashSet::from(["disabled".to_string(), "opi".to_string()]),
            ),
        ]);

        let (kept, dropped) = sanitize_fqbn_option_string(
            Some("PSRAM=opi,FlashSize=16M,PartitionScheme=fatflash"),
            Some(&allowed),
        );
        assert_eq!(
            kept.as_deref(),
            Some("FlashSize=16M,PSRAM=opi,PartitionScheme=fatflash")
        );
        assert!(dropped.is_empty());

        let (kept, dropped) = sanitize_fqbn_option_string(
            Some("FlashSize=64M,PartitionScheme=unknown,PSRAM=qspi"),
            Some(&allowed),
        );
        assert!(kept.is_none());
        assert_eq!(
            dropped,
            vec!["FlashSize=64M", "PartitionScheme=unknown", "PSRAM=qspi"]
        );
    }

    #[test]
    fn core_or_board_change_invalidates_option_schema_and_alias_resolution_caches() {
        let key = format!("cache-invalidation-test-{}", uuid::Uuid::new_v4());
        board_fqbn_resolve_cache()
            .lock()
            .expect("resolve cache")
            .insert(key.clone(), "esp32:esp32:esp32s3".to_string());
        board_option_schema_cache()
            .lock()
            .expect("option cache")
            .insert(
                key.clone(),
                HashMap::from([("FlashSize".to_string(), HashSet::from(["4M".to_string()]))]),
            );

        invalidate_board_definition_caches();

        assert!(
            !board_fqbn_resolve_cache()
                .lock()
                .expect("resolve cache")
                .contains_key(&key)
        );
        assert!(
            !board_option_schema_cache()
                .lock()
                .expect("option cache")
                .contains_key(&key)
        );
    }

    #[test]
    fn board_details_fallback_extracts_third_party_option_values() {
        let details = serde_json::json!({
            "config_options": [
                {
                    "option": "FlashSize",
                    "values": [
                        { "value": "8M", "selected": true },
                        { "value": "16M", "selected": false }
                    ]
                },
                {
                    "option": "PSRAM",
                    "values": [
                        { "value": "disabled" },
                        { "value": "opi" }
                    ]
                }
            ]
        });
        let schema = board_option_schema_from_details(&details);
        assert_eq!(
            schema.get("FlashSize"),
            Some(&HashSet::from(["8M".to_string(), "16M".to_string()]))
        );
        assert_eq!(
            schema.get("PSRAM"),
            Some(&HashSet::from(["disabled".to_string(), "opi".to_string()]))
        );
    }

    #[test]
    fn rejected_explicit_flash_size_never_falls_back_to_default_board_fqbn() {
        let base = "esp32:esp32:esp32s3";
        let new_core_schema = HashMap::from([(
            "FlashSize".to_string(),
            HashSet::from(["4M".to_string(), "8M".to_string()]),
        )]);
        let error =
            finalize_resolved_fqbn_options(base, Some("FlashSize=16M"), Some(&new_core_schema))
                .expect_err("an unsupported explicit FlashSize must stop the build");
        assert!(error.contains("FlashSize=16M"));
        assert!(error.contains("refusing to fall back"));

        let unavailable = finalize_resolved_fqbn_options(base, Some("FlashSize=16M"), None)
            .expect_err("missing schema must also stop an optioned build");
        assert!(unavailable.contains("validation unavailable"));
        assert!(unavailable.contains("FlashSize=16M"));
    }
}

fn resolve_custom_board_base(app: &AppHandle, base_id: &str) -> Option<String> {
    let app_data = crate::app_storage::desktop_dir(&app).ok()?;
    let board_json_path = app_data
        .join("CK")
        .join("boards")
        .join(base_id)
        .join("board.json");
    if !board_json_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(board_json_path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    json["fqbn"]
        .as_str()
        .or_else(|| json["fqbn_base"].as_str())
        .map(|v| v.to_string())
}

// Helper to resolve FQBN (Custom vs Standard)
// Uses arduino-cli to verify if the board is known.
// If unknown, checks board.json for 'fqbn_base'.
fn finalize_resolved_fqbn_options(
    resolved_base: &str,
    raw_options: Option<&str>,
    allowed_schema: Option<&BoardOptionSchema>,
) -> Result<String, String> {
    let Some(raw_options) = raw_options else {
        return Ok(resolved_base.to_string());
    };
    if raw_options.trim().trim_start_matches(':').is_empty() {
        return Ok(resolved_base.to_string());
    }
    let Some(schema) = allowed_schema else {
        return Err(format!(
            "Board configuration validation unavailable for {}. Rejected explicit options: {}. Refusing to fall back to board defaults.",
            resolved_base, raw_options
        ));
    };
    let (sanitized_options, dropped_options) =
        sanitize_fqbn_option_string(Some(raw_options), Some(schema));
    if !dropped_options.is_empty() {
        return Err(format!(
            "Board configuration rejected for {}: {}. The installed core does not advertise these key/value selections; refusing to fall back to board defaults.",
            resolved_base,
            dropped_options.join(", ")
        ));
    }
    sanitized_options
        .map(|options| format!("{}:{}", resolved_base, options))
        .ok_or_else(|| {
            format!(
                "Board configuration rejected for {}: {}. Refusing to fall back to board defaults.",
                resolved_base, raw_options
            )
        })
}

async fn resolve_board_fqbn(app: &AppHandle, fqbn: &str) -> Result<String, String> {
    let (base_id, mut raw_options) = split_fqbn_base_and_options(fqbn);
    let is_standard = normalize_base_fqbn(&base_id).is_some();
    let mut resolved_base = base_id.clone();

    if !is_standard {
        if let Ok(cache) = board_fqbn_resolve_cache().lock() {
            if let Some(cached) = cache.get(&base_id) {
                resolved_base = cached.clone();
            }
        }

        if resolved_base == base_id {
            // 1) Custom board config first (cheap local lookup, avoids CLI process spawn).
            if let Some(custom_base) = resolve_custom_board_base(app, &base_id) {
                resolved_base = custom_base;
            } else if !base_id.contains(':') {
                // 2) Alias fallback from learned prewarm board list.
                // If user passes "esp32", map it to a known installed board under same package.
                if let Ok(sysroot) = get_app_sysroot().await {
                    let settings = compile_accel::load_settings(&sysroot.root_dir);
                    if let Some(mapped) = settings
                        .prewarm_boards
                        .iter()
                        .find(|candidate| candidate.split(':').next() == Some(base_id.as_str()))
                        .cloned()
                    {
                        resolved_base = mapped;
                    }
                }
            } else if let Ok(sysroot) = get_app_sysroot().await {
                // 3) Check if arduino-cli recognizes this base FQBN.
                let sysroot = std::sync::Arc::new(sysroot);
                let mut client = arduino::client::ArduinoClient::new(sysroot);
                if client.init().await.is_ok() {
                    if let Ok(output) = client
                        .run_command(vec!["board", "listall", base_id.as_str()])
                        .await
                    {
                        if output.contains(base_id.as_str()) {
                            resolved_base = base_id.clone();
                        }
                    }
                }
            }
        }

        if let Ok(mut cache) = board_fqbn_resolve_cache().lock() {
            cache.insert(base_id.clone(), resolved_base.clone());
        }
    }

    // A custom board manifest or learned alias may itself carry default menu
    // options. Normalize those back into the option stream so they receive the
    // same schema/value validation, with explicit request options taking
    // precedence when the same key appears twice.
    let (normalized_resolved_base, embedded_options) = split_fqbn_base_and_options(&resolved_base);
    if normalize_base_fqbn(&resolved_base).is_some() {
        resolved_base = normalized_resolved_base;
        raw_options = match (embedded_options, raw_options) {
            (Some(defaults), Some(requested)) => Some(format!("{defaults},{requested}")),
            (Some(defaults), None) => Some(defaults),
            (None, requested) => requested,
        };
    }

    // Only fetch board option keys when there are actually options to sanitize.
    // Installed boards are parsed locally; Arduino CLI is only the compatibility
    // fallback for unusual/custom platform layouts.
    if raw_options.is_some() {
        let allowed_schema = get_board_option_schema(app, &resolved_base).await;
        return finalize_resolved_fqbn_options(
            &resolved_base,
            raw_options.as_deref(),
            allowed_schema.as_ref(),
        );
    }

    Ok(resolved_base)
}

// Helper to get board architecture (e.g. "esp8266" or "avr")
async fn get_board_architecture(app: &AppHandle, fqbn: &str) -> String {
    // 1. Is it a Custom Board? Read board.json
    let (base_id, _) = split_fqbn_base_and_options(fqbn);

    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        let board_json_path = app_data
            .join("CK")
            .join("boards")
            .join(&base_id)
            .join("board.json");
        if board_json_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&board_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(arch) = json["architecture"].as_str() {
                        return arch.to_string();
                    }
                    // Fallback: Try to infer from fqbn_base inside json
                    if let Some(base) = json["fqbn_base"].as_str() {
                        let parts: Vec<&str> = base.split(':').collect();
                        if parts.len() >= 2 {
                            return parts[1].to_string();
                        }
                    }
                }
            }
        }
    }

    // 2. Standard FQBN (Vendor:Arch:Board)
    let parts: Vec<&str> = base_id.split(':').collect();
    if parts.len() >= 2 {
        return parts[1].to_string();
    }

    // 3. Fallback
    "unknown".to_string()
}

fn compile_cache_miss_reasons(trace: &str) -> Vec<String> {
    trace
        .lines()
        .filter_map(|line| {
            line.split_once("Exact-match cache MISS:")
                .map(|(_, value)| value)
        })
        .last()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

const DIAGNOSTIC_TRACE_MAX_BYTES: usize = 512 * 1024;
const DIAGNOSTIC_TRACE_EVIDENCE_RESERVE_BYTES: usize = 32 * 1024;
const DIAGNOSTIC_TRACE_HEAD_BYTES: usize = 128 * 1024;
const DIAGNOSTIC_EVIDENCE_LINE_MAX_BYTES: usize = 4096;
const COMPILE_FULL_BUILD_ROUTE_PREFIX: &str =
    "[INFO] Full Build: First-time compilation, building all dependencies";
const COMPILE_INCREMENTAL_ROUTE_PREFIX: &str = "[INFO] Build cache directory detected";
const COMPILE_FULL_BUILD_STRUCTURED_EVIDENCE: &str = "[DIAG] Compile route evidence: full-build";
const COMPILE_INCREMENTAL_STRUCTURED_EVIDENCE: &str =
    "[DIAG] Compile route evidence: arduino-cli-incremental";
const COMPILE_NATIVE_RELINK_STRUCTURED_EVIDENCE: &str =
    "[CK_BUILD_MODE] native-relink-compile-only";
const COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE: &str =
    "[CK_BUILD_MODE] native-relink-graph-transition";
const COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE: &str = "[CK_BUILD_MODE] arduino-cli-core-seeded";
const FAST_RELINK_FALLBACK_CODE_PREFIX: &str = "[CK_DIAG] fast_relink_fallback_code=";
const FAST_RELINK_FALLBACK_CODES: [&str; 8] = [
    "properties",
    "prebuild-hooks",
    "ccdb",
    "library-semantics",
    "core-identity",
    "compiler",
    "artifacts",
    "other",
];
const COMPILE_TIMING_EVIDENCE_PREFIXES: [&str; 6] = [
    ck_core::builder::demo::TIMING_RUNTIME_TOOL_PREFLIGHT_PREFIX,
    ck_core::builder::demo::TIMING_ARDUINO_CLI_CHILD_WALL_PREFIX,
    ck_core::builder::demo::TIMING_DEPENDENCY_ARTIFACT_SEAL_PREFIX,
    ck_core::builder::demo::TIMING_NATIVE_BASELINE_CAPTURE_COMMIT_PREFIX,
    ck_core::builder::demo::TIMING_BUILD_META_SNAPSHOT_PREFIX,
    ck_core::builder::demo::TIMING_POST_BUILD_SNAPSHOT_PREFIX,
];

fn compile_timing_line_ms(line: &str, prefix: &str) -> Option<u64> {
    let value = line.trim().strip_prefix(prefix)?.strip_suffix("ms")?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn compile_timing_evidence_ms(trace: &str, prefix: &str) -> Option<u64> {
    trace
        .lines()
        .filter_map(|line| compile_timing_line_ms(line, prefix))
        .last()
}

fn is_full_build_route_evidence(line: &str) -> bool {
    let line = line.trim();
    line.starts_with(COMPILE_FULL_BUILD_ROUTE_PREFIX)
        || line == COMPILE_FULL_BUILD_STRUCTURED_EVIDENCE
        // Preserve diagnostics produced by the previous bounded-trace format,
        // but do not treat arbitrary `Full Build:` summaries as route proof.
        || line == "[INFO] Full Build: retained structured evidence"
}

fn is_arduino_cli_incremental_route_evidence(line: &str) -> bool {
    let line = line.trim();
    line.starts_with(COMPILE_INCREMENTAL_ROUTE_PREFIX)
        || line == COMPILE_INCREMENTAL_STRUCTURED_EVIDENCE
        || line == "[INFO] Arduino CLI incremental build: retained structured evidence"
}

fn has_native_relink_build_mode_marker(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim() == COMPILE_NATIVE_RELINK_STRUCTURED_EVIDENCE)
}

fn has_native_relink_graph_transition_build_mode_marker(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim() == COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE)
}

fn has_core_seeded_build_mode_marker(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim() == COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE)
}

fn fast_relink_fallback_code_from_line(line: &str) -> Option<&'static str> {
    let code = line.trim().strip_prefix(FAST_RELINK_FALLBACK_CODE_PREFIX)?;
    FAST_RELINK_FALLBACK_CODES
        .iter()
        .copied()
        .find(|allowed| *allowed == code)
}

#[derive(Debug, Default)]
struct CompileDiagnosticEvidence {
    exact_match: bool,
    fast_relink: bool,
    native_relink_compile_only: bool,
    native_relink_graph_transition: bool,
    arduino_cli_core_seeded: bool,
    full_build: bool,
    arduino_cli_incremental: bool,
    fast_relink_fallback: bool,
    fast_relink_fallback_code: Option<&'static str>,
    core_cache: bool,
    ccache_enabled: bool,
    forced_rebuild: bool,
    warmup_reused: bool,
    miss_reason_line: Option<String>,
    flash_line: Option<String>,
    ram_line: Option<String>,
    warning_line: Option<String>,
    timing_lines: [Option<String>; COMPILE_TIMING_EVIDENCE_PREFIXES.len()],
    esp32_library_native_relink_evidence_lines: Vec<String>,
}

impl CompileDiagnosticEvidence {
    fn observe_line(&mut self, line: &str) {
        self.exact_match |= line.contains("Cached build (Exact Match)");
        self.fast_relink |= line.contains("Fast Relink path:");
        self.native_relink_compile_only |= line.trim() == COMPILE_NATIVE_RELINK_STRUCTURED_EVIDENCE;
        self.native_relink_graph_transition |=
            line.trim() == COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE;
        self.arduino_cli_core_seeded |= line.trim() == COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE;
        self.full_build |= is_full_build_route_evidence(line);
        self.arduino_cli_incremental |= is_arduino_cli_incremental_route_evidence(line);
        self.fast_relink_fallback |=
            line.contains("Fast Relink bypassed, falling back to arduino-cli compile");
        if let Some(code) = fast_relink_fallback_code_from_line(line) {
            self.fast_relink_fallback = true;
            self.fast_relink_fallback_code = Some(code);
        }
        self.core_cache |= line.contains("Core cache injected directly");
        self.ccache_enabled |= line.contains("ccache compile acceleration enabled");
        self.forced_rebuild |= line.contains("Forced rebuild");
        self.warmup_reused |= line.contains("Reusing compatible same-board warmup");
        if line.contains("Exact-match cache MISS:") {
            self.miss_reason_line = Some(bounded_diagnostic_line(line));
        }
        if line.contains("Sketch uses") {
            self.flash_line = Some(bounded_diagnostic_line(line));
        }
        if line.contains("Global variables use") {
            self.ram_line = Some(bounded_diagnostic_line(line));
        }
        if line.contains("[DIAG] Compile evidence:") {
            self.warning_line = Some(bounded_diagnostic_line(line));
        }
        for (index, prefix) in COMPILE_TIMING_EVIDENCE_PREFIXES.iter().enumerate() {
            if compile_timing_line_ms(line, prefix).is_some() {
                self.timing_lines[index] = Some(bounded_diagnostic_line(line.trim()));
            }
        }
        if line
            .trim()
            .starts_with(ck_core::builder::demo::ESP32_LIBRARY_RELINK_EVIDENCE_PREFIX)
        {
            let bounded = bounded_diagnostic_line(line.trim());
            if !self
                .esp32_library_native_relink_evidence_lines
                .contains(&bounded)
                && self.esp32_library_native_relink_evidence_lines.len() < 2
            {
                self.esp32_library_native_relink_evidence_lines
                    .push(bounded);
            }
        }
    }

    fn rendered(&self) -> String {
        let mut out = String::new();
        if self.exact_match {
            out.push_str("Cached build (Exact Match)\n");
        }
        if self.fast_relink {
            out.push_str("[INFO] Fast Relink path: retained structured evidence\n");
        }
        if self.native_relink_compile_only {
            out.push_str(COMPILE_NATIVE_RELINK_STRUCTURED_EVIDENCE);
            out.push('\n');
        }
        if self.native_relink_graph_transition {
            out.push_str(COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE);
            out.push('\n');
        }
        if self.arduino_cli_core_seeded {
            out.push_str(COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE);
            out.push('\n');
        }
        if self.full_build {
            out.push_str(COMPILE_FULL_BUILD_STRUCTURED_EVIDENCE);
            out.push('\n');
        }
        if self.arduino_cli_incremental {
            out.push_str(COMPILE_INCREMENTAL_STRUCTURED_EVIDENCE);
            out.push('\n');
        }
        if self.fast_relink_fallback {
            out.push_str("[INFO] Fast Relink fallback: retained structured evidence\n");
        }
        if let Some(code) = self.fast_relink_fallback_code {
            out.push_str(FAST_RELINK_FALLBACK_CODE_PREFIX);
            out.push_str(code);
            out.push('\n');
        }
        if self.core_cache {
            out.push_str("[INFO] Core cache injected directly\n");
        }
        if self.ccache_enabled {
            out.push_str("[INFO] ccache compile acceleration enabled\n");
        }
        if self.forced_rebuild {
            out.push_str("[INFO] Forced rebuild retained structured evidence\n");
        }
        if self.warmup_reused {
            out.push_str("[INFO] Reusing compatible same-board warmup\n");
        }
        for line in [
            self.miss_reason_line.as_deref(),
            self.flash_line.as_deref(),
            self.ram_line.as_deref(),
            self.warning_line.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            out.push_str(line);
            out.push('\n');
        }
        for line in self.timing_lines.iter().flatten() {
            out.push_str(line);
            out.push('\n');
        }
        for line in &self.esp32_library_native_relink_evidence_lines {
            out.push_str(line);
            out.push('\n');
        }
        debug_assert!(out.len() <= DIAGNOSTIC_TRACE_EVIDENCE_RESERVE_BYTES);
        out
    }
}

fn bounded_diagnostic_line(line: &str) -> String {
    let mut end = line.len().min(DIAGNOSTIC_EVIDENCE_LINE_MAX_BYTES);
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].to_string()
}

#[derive(Debug)]
struct CompileDiagnosticTrace {
    log: ck_core::builder::demo::BoundedLog,
    evidence: CompileDiagnosticEvidence,
}

impl CompileDiagnosticTrace {
    fn new() -> Self {
        Self {
            log: ck_core::builder::demo::BoundedLog::new(
                DIAGNOSTIC_TRACE_MAX_BYTES - DIAGNOSTIC_TRACE_EVIDENCE_RESERVE_BYTES,
                DIAGNOSTIC_TRACE_HEAD_BYTES,
            ),
            evidence: CompileDiagnosticEvidence::default(),
        }
    }

    fn push_str(&mut self, text: &str) {
        self.log.push_str(text);
        for line in text.lines() {
            self.evidence.observe_line(line);
        }
    }

    fn rendered(&self) -> String {
        let mut out = self.log.rendered();
        let evidence = self.evidence.rendered();
        if !evidence.is_empty() {
            const EVIDENCE_HEADER: &str = "\n[CK STRUCTURED COMPILE EVIDENCE]\n";
            debug_assert!(
                EVIDENCE_HEADER.len() + evidence.len() <= DIAGNOSTIC_TRACE_EVIDENCE_RESERVE_BYTES
            );
            out.push_str(EVIDENCE_HEADER);
            out.push_str(&evidence);
        }
        debug_assert!(out.len() <= DIAGNOSTIC_TRACE_MAX_BYTES);
        out
    }
}

fn attach_qualification_diagnostic_trace(
    result: &mut serde_json::Value,
    qualification_mode: bool,
    external_authorization_present: bool,
    diagnostic_trace_text: String,
) {
    if qualification_mode && external_authorization_present {
        result["qualificationDiagnosticTrace"] = serde_json::Value::String(diagnostic_trace_text);
    }
}

fn compile_size_evidence(log: &str) -> (Option<u64>, Option<u64>) {
    let standard_flash = Regex::new(r"(?i)Sketch\s+uses\s+(\d+)\s+bytes")
        .ok()
        .and_then(|regex| regex.captures_iter(log).last())
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse().ok());
    // ESP8266's native `sizes.py` heading named "Code in flash" reports only
    // the IROM segment. Arduino's program-size contract also includes IRAM,
    // initialized DATA and RODATA (see that Core's recipe.size.regex). Treating
    // the heading as the complete Flash usage silently under-reports it. Only
    // synthesize program usage when all four native segment rows are present;
    // incomplete cached/native summaries remain explicitly unknown.
    let esp8266_flash = [
        r"(?im)^[^\r\n]*\bIROM\s+(\d+)\s+code in flash\s*$",
        r"(?im)^[^\r\n]*\bIRAM\s+(\d+)\s+code in IRAM\s*$",
        r"(?im)^[^\r\n]*\bDATA\s+(\d+)\s+initialized variables\s*$",
        r"(?im)^[^\r\n]*\bRODATA\s+(\d+)\s+constants\s*$",
    ]
    .into_iter()
    .try_fold(0u64, |total, pattern| {
        let value = Regex::new(pattern)
            .ok()?
            .captures_iter(log)
            .last()?
            .get(1)?
            .as_str()
            .parse::<u64>()
            .ok()?;
        total.checked_add(value)
    });
    let standard_ram = Regex::new(r"(?i)Global\s+variables\s+use\s+(\d+)\s+bytes")
        .ok()
        .and_then(|regex| regex.captures_iter(log).last())
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse().ok());
    let esp8266_ram = Regex::new(r"(?im)^\.\s*Variables and constants in RAM.*?used\s+(\d+)\s*/")
        .ok()
        .and_then(|regex| regex.captures_iter(log).last())
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse().ok());
    (
        standard_flash.or(esp8266_flash),
        standard_ram.or(esp8266_ram),
    )
}

fn compile_warning_evidence(log: &str) -> Option<u64> {
    Regex::new(r"(?im)^\[DIAG\]\s+Compile evidence:\s+warning_count=(\d+)\s*$")
        .ok()
        .and_then(|regex| regex.captures_iter(log).last())
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse().ok())
}

fn compile_resource_evidence(
    trace: &str,
    returned_log: &str,
) -> (Option<u64>, Option<u64>, Option<u64>) {
    let (returned_flash, returned_ram) = compile_size_evidence(returned_log);
    let (trace_flash, trace_ram) = compile_size_evidence(trace);
    (
        returned_flash.or(trace_flash),
        returned_ram.or(trace_ram),
        compile_warning_evidence(returned_log).or_else(|| compile_warning_evidence(trace)),
    )
}

fn compile_native_relink_diagnostics(trace: &str) -> Vec<String> {
    trace
        .lines()
        .filter(|line| line.contains("NativeRelink"))
        .take(16)
        .map(|line| line.trim().to_string())
        .collect()
}

const ESP32_LIBRARY_NATIVE_RELINK_DIAGNOSTIC_SCHEMA_VERSION: u32 = 1;
const ESP32_LIBRARY_NATIVE_RELINK_MANIFEST_SCHEMA_VERSION: u32 = 4;
const ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT: &str = "ck-esp32-library-relink-evidence-v4";
const MAX_ESP32_LIBRARY_NATIVE_RELINK_MARKERS: usize = 4;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_ROOTS: usize = 16;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_FILES: usize = 16_384;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_RESPONSE_FILES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Esp32LibraryNativeRelinkEvidence {
    schema_version: u32,
    evidence_contract: String,
    manifest_schema_version: u32,
    manifest_sha256: String,
    property_contract_sha256: String,
    command_graph_sha256: String,
    library_tree_sha256: String,
    library_root_count: usize,
    library_file_count: usize,
    library_total_bytes: u64,
    ordered_link_inputs_sha256: String,
    native_link_argv_sha256: String,
    native_link_executable_sha256: String,
    native_link_response_graph_sha256: String,
    native_link_response_file_count: usize,
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_esp32_library_native_relink_evidence(
    evidence: &Esp32LibraryNativeRelinkEvidence,
) -> Result<(), &'static str> {
    if evidence.schema_version != ESP32_LIBRARY_NATIVE_RELINK_DIAGNOSTIC_SCHEMA_VERSION
        || evidence.evidence_contract != ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT
        || evidence.manifest_schema_version != ESP32_LIBRARY_NATIVE_RELINK_MANIFEST_SCHEMA_VERSION
    {
        return Err("contract-mismatch");
    }
    if [
        evidence.manifest_sha256.as_str(),
        evidence.property_contract_sha256.as_str(),
        evidence.command_graph_sha256.as_str(),
        evidence.library_tree_sha256.as_str(),
        evidence.ordered_link_inputs_sha256.as_str(),
        evidence.native_link_argv_sha256.as_str(),
        evidence.native_link_executable_sha256.as_str(),
        evidence.native_link_response_graph_sha256.as_str(),
    ]
    .into_iter()
    .any(|value| !is_lowercase_sha256(value))
    {
        return Err("malformed-sha256");
    }
    if evidence.library_root_count == 0
        || evidence.library_root_count > MAX_ESP32_LIBRARY_NATIVE_RELINK_ROOTS
        || evidence.library_file_count < evidence.library_root_count
        || evidence.library_file_count > MAX_ESP32_LIBRARY_NATIVE_RELINK_FILES
        || evidence.library_total_bytes > MAX_ESP32_LIBRARY_NATIVE_RELINK_BYTES
        || evidence.native_link_response_file_count > MAX_ESP32_LIBRARY_NATIVE_RELINK_RESPONSE_FILES
    {
        return Err("bounded-count-invalid");
    }
    Ok(())
}

fn compile_esp32_library_native_relink_evidence(
    trace: &str,
    returned_log: &str,
) -> serde_json::Value {
    let prefix = ck_core::builder::demo::ESP32_LIBRARY_RELINK_EVIDENCE_PREFIX;
    let mut payloads = BTreeSet::new();
    let mut observed_marker_count = 0usize;
    for line in trace.lines().chain(returned_log.lines()) {
        let Some(payload) = line.trim().strip_prefix(prefix) else {
            continue;
        };
        observed_marker_count = observed_marker_count.saturating_add(1);
        if payload.len() > DIAGNOSTIC_EVIDENCE_LINE_MAX_BYTES {
            return serde_json::json!({
                "status": "invalid",
                "markerCount": observed_marker_count,
                "reasonCode": "marker-too-large",
            });
        }
        payloads.insert(payload.to_string());
        if payloads.len() > MAX_ESP32_LIBRARY_NATIVE_RELINK_MARKERS {
            return serde_json::json!({
                "status": "invalid",
                "markerCount": observed_marker_count,
                "reasonCode": "too-many-distinct-markers",
            });
        }
    }
    if payloads.is_empty() {
        return serde_json::json!({
            "status": "not-present",
            "markerCount": 0,
        });
    }

    let mut parsed = Vec::with_capacity(payloads.len());
    for payload in payloads {
        let evidence = match serde_json::from_str::<Esp32LibraryNativeRelinkEvidence>(&payload) {
            Ok(evidence) => evidence,
            Err(_) => {
                return serde_json::json!({
                    "status": "invalid",
                    "markerCount": observed_marker_count,
                    "reasonCode": "malformed-json-or-fields",
                });
            }
        };
        if let Err(reason_code) = validate_esp32_library_native_relink_evidence(&evidence) {
            return serde_json::json!({
                "status": "invalid",
                "markerCount": observed_marker_count,
                "reasonCode": reason_code,
            });
        }
        parsed.push(evidence);
    }
    if parsed.windows(2).any(|pair| pair[0] != pair[1]) {
        return serde_json::json!({
            "status": "invalid",
            "markerCount": observed_marker_count,
            "reasonCode": "conflicting-markers",
        });
    }
    serde_json::json!({
        "status": "valid",
        "markerCount": observed_marker_count,
        "evidence": parsed.into_iter().next().expect("non-empty evidence"),
    })
}

fn compile_diagnostics_value_with_engine(
    trace: &str,
    returned_log: &str,
    fqbn: &str,
    cli_version: &str,
    toolchain_key: &str,
    toolchain_identity_source: &str,
    build_signature: &str,
    workspace_fingerprint: Option<&str>,
    required_headers: &[String],
    library_resolution_ms: u128,
    identity_resolution_ms: u128,
    precompile_ms: u128,
    lock_wait_ms: u128,
    cli_compile_ms: u128,
    total_ms: u128,
    profile: &str,
    forge_decision: &ck_forge::ForgeCompatibilityDecision,
) -> serde_json::Value {
    let exact_match = returned_log.contains("Cached build (Exact Match)")
        || trace.contains("Cached build (Exact Match)");
    let fast_relink = trace.contains("Fast Relink path:");
    let native_relink_compile_only = has_native_relink_build_mode_marker(trace)
        || has_native_relink_build_mode_marker(returned_log);
    let native_relink_graph_transition =
        has_native_relink_graph_transition_build_mode_marker(trace)
            || has_native_relink_graph_transition_build_mode_marker(returned_log);
    let arduino_cli_core_seeded =
        has_core_seeded_build_mode_marker(trace) || has_core_seeded_build_mode_marker(returned_log);
    let full_build = trace.lines().any(is_full_build_route_evidence);
    let arduino_cli_incremental = trace.lines().any(is_arduino_cli_incremental_route_evidence);
    let fast_relink_fallback = trace.contains("Fast Relink fallback:")
        || trace.contains("Fast Relink bypassed, falling back to arduino-cli compile");
    let fast_relink_fallback_code = trace
        .lines()
        .chain(returned_log.lines())
        .filter_map(fast_relink_fallback_code_from_line)
        .last()
        .unwrap_or("unknown");
    let build_mode = if exact_match {
        "exact-match"
    } else if native_relink_compile_only {
        "native-relink-compile-only"
    } else if native_relink_graph_transition {
        "native-relink-graph-transition"
    } else if arduino_cli_core_seeded {
        "arduino-cli-core-seeded"
    } else if fast_relink {
        "fast-relink"
    } else if arduino_cli_incremental && fast_relink_fallback {
        "arduino-cli-incremental-fallback"
    } else if arduino_cli_incremental {
        "arduino-cli-incremental"
    } else if full_build && fast_relink_fallback {
        "arduino-cli-full-fallback"
    } else if full_build {
        "full-build"
    } else {
        "unknown"
    };
    let (flash_used_bytes, ram_used_bytes, warning_count) =
        compile_resource_evidence(trace, returned_log);
    let esp32_library_native_relink_evidence =
        compile_esp32_library_native_relink_evidence(trace, returned_log);

    serde_json::json!({
        "schemaVersion": 1,
        "fqbn": fqbn,
        "profile": profile,
        "buildMode": build_mode,
        "engine": {
            "id": forge_decision.engine.id,
            "schemaVersion": forge_decision.engine.schema_version,
            "productVersion": forge_decision.engine.product_version,
            "contractId": forge_decision.engine.contract_id,
            "decision": forge_decision.decision,
            "source": forge_decision.source,
            "coreVersion": forge_decision.core_version,
            "reasonCodes": forge_decision.reason_codes,
        },
        "timing": {
            "libraryResolutionMs": u64::try_from(library_resolution_ms).unwrap_or(u64::MAX),
            "identityResolutionMs": u64::try_from(identity_resolution_ms).unwrap_or(u64::MAX),
            "precompileMs": u64::try_from(precompile_ms).unwrap_or(u64::MAX),
            "lockWaitMs": u64::try_from(lock_wait_ms).unwrap_or(u64::MAX),
            "cliCompileMs": u64::try_from(cli_compile_ms).unwrap_or(u64::MAX),
            "totalMs": u64::try_from(total_ms).unwrap_or(u64::MAX),
            "runtimeToolPreflightMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_RUNTIME_TOOL_PREFLIGHT_PREFIX,
            ),
            "arduinoCliChildWallMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_ARDUINO_CLI_CHILD_WALL_PREFIX,
            ),
            "dependencyArtifactSealMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_DEPENDENCY_ARTIFACT_SEAL_PREFIX,
            ),
            "nativeRelinkBaselineCaptureCommitMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_NATIVE_BASELINE_CAPTURE_COMMIT_PREFIX,
            ),
            "buildMetaSnapshotMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_BUILD_META_SNAPSHOT_PREFIX,
            ),
            "postBuildSnapshotMs": compile_timing_evidence_ms(
                trace,
                ck_core::builder::demo::TIMING_POST_BUILD_SNAPSHOT_PREFIX,
            ),
        },
        "cache": {
            "exactMatch": exact_match,
            "graphTransition": native_relink_graph_transition,
            "coreSeeded": arduino_cli_core_seeded,
            "coreCache": trace.contains("Core cache injected directly"),
            "ccacheEnabled": trace.contains("ccache compile acceleration enabled"),
            "forcedRebuild": trace.contains("Forced rebuild"),
            "warmupReused": trace.contains("Reusing compatible same-board warmup"),
            "fastRelinkFallback": fast_relink_fallback,
            "fastRelinkFallbackCode": fast_relink_fallback_code,
            "nativeRelinkCertificateMatched": trace.contains(
                "CK Forge NativeRelinkCompileOnly certificate matched"
            ) || returned_log.contains("CK Forge NativeRelinkCompileOnly certificate matched"),
            "missReasons": compile_cache_miss_reasons(trace),
            "nativeRelinkDiagnostics": compile_native_relink_diagnostics(trace),
            "nativeRelinkEvidence": esp32_library_native_relink_evidence,
        },
        "environment": {
            "cliVersion": cli_version,
            "toolchainKey": toolchain_key,
            "toolchainIdentitySource": toolchain_identity_source,
            "buildSignature": build_signature,
            "workspaceFingerprint": workspace_fingerprint,
            "includeHeaders": required_headers,
        },
        "resources": {
            "flashUsedBytes": flash_used_bytes,
            "ramUsedBytes": ram_used_bytes,
            "warningCount": warning_count,
            "evidenceComplete": flash_used_bytes.is_some()
                && ram_used_bytes.is_some()
                && warning_count.is_some(),
        }
    })
}

#[cfg(test)]
fn compile_diagnostics_value(
    trace: &str,
    returned_log: &str,
    fqbn: &str,
    cli_version: &str,
    toolchain_key: &str,
    build_signature: &str,
    workspace_fingerprint: Option<&str>,
    required_headers: &[String],
    library_resolution_ms: u128,
    lock_wait_ms: u128,
    cli_compile_ms: u128,
    total_ms: u128,
) -> serde_json::Value {
    let decision = ck_forge::decide_forge_compatibility(ck_forge::ForgeCompatibilityInput {
        fqbn,
        core_version: Some("3.3.6"),
        cli_version: Some(cli_version),
        toolchain_key: None,
        host_identity_sha256: None,
        qualification: None,
    });
    compile_diagnostics_value_with_engine(
        trace,
        returned_log,
        fqbn,
        cli_version,
        toolchain_key,
        "strong-content",
        build_signature,
        workspace_fingerprint,
        required_headers,
        library_resolution_ms,
        0,
        0,
        lock_wait_ms,
        cli_compile_ms,
        total_ms,
        "quick-fast",
        &decision,
    )
}

#[cfg(test)]
mod compile_diagnostics_tests {
    use super::{
        COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE,
        COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE, CompileDiagnosticTrace,
        DIAGNOSTIC_TRACE_MAX_BYTES, attach_qualification_diagnostic_trace,
        compile_cache_miss_reasons, compile_diagnostics_value,
        compile_diagnostics_value_with_engine, compile_timing_line_ms,
    };

    fn esp32_library_native_relink_marker(manifest_sha256: &str) -> String {
        format!(
            "{}{}\n",
            ck_core::builder::demo::ESP32_LIBRARY_RELINK_EVIDENCE_PREFIX,
            serde_json::json!({
                "schemaVersion": 1,
                "evidenceContract": "ck-esp32-library-relink-evidence-v4",
                "manifestSchemaVersion": 4,
                "manifestSha256": manifest_sha256,
                "propertyContractSha256": "b".repeat(64),
                "commandGraphSha256": "c".repeat(64),
                "libraryTreeSha256": "d".repeat(64),
                "libraryRootCount": 1,
                "libraryFileCount": 4,
                "libraryTotalBytes": 2048,
                "orderedLinkInputsSha256": "e".repeat(64),
                "nativeLinkArgvSha256": "f".repeat(64),
                "nativeLinkExecutableSha256": "1".repeat(64),
                "nativeLinkResponseGraphSha256": "2".repeat(64),
                "nativeLinkResponseFileCount": 3,
            })
        )
    }

    #[test]
    fn raw_diagnostic_trace_is_returned_only_for_an_authorized_qualification() {
        let mut qualification = serde_json::json!({ "diagnostics": {} });
        attach_qualification_diagnostic_trace(
            &mut qualification,
            true,
            true,
            "private local failure detail".to_string(),
        );
        assert_eq!(
            qualification["qualificationDiagnosticTrace"],
            "private local failure detail"
        );

        let mut internal_qualification_smoke = serde_json::json!({ "diagnostics": {} });
        attach_qualification_diagnostic_trace(
            &mut internal_qualification_smoke,
            true,
            false,
            "must not cross the normal response boundary".to_string(),
        );
        assert!(
            internal_qualification_smoke
                .get("qualificationDiagnosticTrace")
                .is_none()
        );

        let mut ordinary_silent = serde_json::json!({ "diagnostics": {} });
        attach_qualification_diagnostic_trace(
            &mut ordinary_silent,
            false,
            true,
            "authorization cannot upgrade a non-qualification call".to_string(),
        );
        assert!(
            ordinary_silent
                .get("qualificationDiagnosticTrace")
                .is_none()
        );
    }

    #[test]
    fn explains_fast_relink_and_cache_layers() {
        let trace = concat!(
            "[Timing DIAG] Exact-match cache MISS: code_changed, include_headers_changed\n",
            "[INFO] Core cache injected directly from prebuilt_cores repository\n",
            "[INFO] ccache compile acceleration enabled\n",
            "[INFO] Fast Relink path: sketch-only compile + direct link\n",
        );
        assert_eq!(
            compile_cache_miss_reasons(trace),
            vec!["code_changed", "include_headers_changed"]
        );

        let value = compile_diagnostics_value(
            trace,
            "compiler output",
            "esp32:esp32:esp32c5",
            "1.2.3",
            "esp32@3.3.0",
            "signature",
            Some("workspace"),
            &["WiFi.h".to_string()],
            100,
            0,
            10_000,
            10_150,
        );

        assert_eq!(value["buildMode"], "fast-relink");
        assert_eq!(value["cache"]["coreCache"], true);
        assert_eq!(value["cache"]["ccacheEnabled"], true);
        assert_eq!(value["timing"]["lockWaitMs"], 0);
        assert!(value["timing"]["arduinoCliChildWallMs"].is_null());
    }

    #[test]
    fn cold_phase_timing_evidence_is_exact_bounded_and_structured() {
        let child_prefix = ck_core::builder::demo::TIMING_ARDUINO_CLI_CHILD_WALL_PREFIX;
        assert_eq!(
            compile_timing_line_ms("[Timing DIAG] Arduino CLI child wall: 8123ms", child_prefix,),
            Some(8123)
        );
        for invalid in [
            "compiler: [Timing DIAG] Arduino CLI child wall: 8123ms",
            "[Timing DIAG] Arduino CLI child wall: -1ms",
            "[Timing DIAG] Arduino CLI child wall: 1.5ms",
            "[Timing DIAG] Arduino CLI child wall: 12ms trailing",
        ] {
            assert_eq!(compile_timing_line_ms(invalid, child_prefix), None);
        }

        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str(&"head-noise\n".repeat(40_000));
        trace.push_str(concat!(
            "[Timing DIAG] Runtime tool preflight: 17ms\n",
            "[Timing DIAG] Arduino CLI child wall: 8123ms\n",
            "[Timing DIAG] Dependency/artifact seal: 91ms\n",
            "[Timing DIAG] NativeRelink baseline capture+commit: 604ms\n",
            "[Timing DIAG] BuildMeta/core snapshot: 73ms\n",
            "[Timing DIAG] Post-build cache snapshot: 768ms\n",
        ));
        trace.push_str(&"tail-noise\n".repeat(100_000));
        let rendered = trace.rendered();
        for evidence in ["17ms", "8123ms", "91ms", "604ms", "73ms", "768ms"] {
            assert!(rendered.contains(evidence));
        }

        let value = compile_diagnostics_value(
            &rendered,
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            9_000,
            9_100,
        );
        assert_eq!(value["timing"]["runtimeToolPreflightMs"], 17);
        assert_eq!(value["timing"]["arduinoCliChildWallMs"], 8123);
        assert_eq!(value["timing"]["dependencyArtifactSealMs"], 91);
        assert_eq!(value["timing"]["nativeRelinkBaselineCaptureCommitMs"], 604);
        assert_eq!(value["timing"]["buildMetaSnapshotMs"], 73);
        assert_eq!(value["timing"]["postBuildSnapshotMs"], 768);
    }

    #[test]
    fn native_relink_marker_is_preserved_and_reported_as_its_own_build_mode() {
        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str(&"noise\n".repeat(100_000));
        trace.push_str("[CK_BUILD_MODE] native-relink-compile-only\n");
        trace.push_str(&"tail\n".repeat(100_000));
        let rendered = trace.rendered();
        assert!(rendered.contains("[CK_BUILD_MODE] native-relink-compile-only"));
        let value = compile_diagnostics_value(
            &rendered,
            concat!(
                "Sketch uses 1024 bytes (3%) of program storage space.\n",
                "Global variables use 64 bytes (2%) of dynamic memory.\n",
                "[DIAG] Compile evidence: warning_count=0\n",
            ),
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &["Arduino.h".to_string()],
            1,
            0,
            10,
            12,
        );
        assert_eq!(value["buildMode"], "native-relink-compile-only");
        assert_eq!(value["resources"]["evidenceComplete"], true);

        let spoofed = compile_diagnostics_value(
            concat!(
                "user source: [CK_BUILD_MODE] native-relink-compile-only trailing text\n",
                "[INFO] NativeRelinkCompileOnly path: user-authored message\n",
            ),
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(spoofed["buildMode"], "unknown");
    }

    #[test]
    fn esp32_library_native_relink_evidence_is_preserved_and_structured() {
        let marker = esp32_library_native_relink_marker(&"a".repeat(64));
        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str(&"head-noise\n".repeat(40_000));
        trace.push_str(&marker);
        trace.push_str(&"tail-noise\n".repeat(100_000));
        let rendered = trace.rendered();
        assert!(rendered.contains(ck_core::builder::demo::ESP32_LIBRARY_RELINK_EVIDENCE_PREFIX));

        let value = compile_diagnostics_value(
            &rendered,
            concat!(
                "Sketch uses 1024 bytes (3%) of program storage space.\n",
                "Global variables use 64 bytes (2%) of dynamic memory.\n",
                "[DIAG] Compile evidence: warning_count=0\n",
            ),
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32|esp32|3.3.6|content",
            "signature",
            None,
            &["SPI.h".to_string()],
            1,
            0,
            10,
            12,
        );
        let evidence = &value["cache"]["nativeRelinkEvidence"];
        assert_eq!(evidence["status"], "valid");
        assert_eq!(evidence["evidence"]["manifestSchemaVersion"], 4);
        assert_eq!(evidence["evidence"]["nativeLinkArgvSha256"], "f".repeat(64));
        assert_eq!(evidence["evidence"]["nativeLinkResponseFileCount"], 3);
    }

    #[test]
    fn esp32_library_native_relink_evidence_rejects_drift_and_malformed_fields() {
        let first = esp32_library_native_relink_marker(&"a".repeat(64));
        let changed = esp32_library_native_relink_marker(&"9".repeat(64));
        let conflicting = compile_diagnostics_value(
            &format!("{first}{changed}"),
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32|esp32|3.3.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(
            conflicting["cache"]["nativeRelinkEvidence"]["status"],
            "invalid"
        );
        assert_eq!(
            conflicting["cache"]["nativeRelinkEvidence"]["reasonCode"],
            "conflicting-markers"
        );

        let malformed = first.replacen(&"a".repeat(64), "NOT-A-SHA", 1);
        let malformed_value = compile_diagnostics_value(
            &malformed,
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32|esp32|3.3.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(
            malformed_value["cache"]["nativeRelinkEvidence"]["status"],
            "invalid"
        );
        assert_eq!(
            malformed_value["cache"]["nativeRelinkEvidence"]["reasonCode"],
            "malformed-sha256"
        );

        let spoofed = compile_diagnostics_value(
            &format!("user output: {first}"),
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32|esp32|3.3.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(
            spoofed["cache"]["nativeRelinkEvidence"]["status"],
            "not-present"
        );
    }

    #[test]
    fn native_relink_graph_transition_marker_is_exact_preserved_and_below_exact() {
        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str(&"head-noise\n".repeat(100_000));
        trace.push_str("[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n");
        trace.push_str("[CK_BUILD_MODE] native-relink-graph-transition\n");
        trace.push_str(&"tail-noise\n".repeat(100_000));
        let rendered = trace.rendered();
        assert!(rendered.contains(COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE));

        let value = compile_diagnostics_value(
            &rendered,
            concat!(
                "Sketch uses 1024 bytes (3%) of program storage space.\n",
                "Global variables use 64 bytes (2%) of dynamic memory.\n",
                "[DIAG] Compile evidence: warning_count=0\n",
            ),
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(value["buildMode"], "native-relink-graph-transition");
        assert_eq!(value["cache"]["graphTransition"], true);

        let spoofed = compile_diagnostics_value(
            "user source: [CK_BUILD_MODE] native-relink-graph-transition trailing text\n",
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(spoofed["buildMode"], "unknown");
        assert_eq!(spoofed["cache"]["graphTransition"], false);

        let exact = compile_diagnostics_value(
            COMPILE_NATIVE_RELINK_GRAPH_TRANSITION_STRUCTURED_EVIDENCE,
            "Cached build (Exact Match)",
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(exact["buildMode"], "exact-match");
        assert_eq!(exact["cache"]["graphTransition"], true);
    }

    #[test]
    fn authenticated_core_seed_marker_survives_bounded_trace_and_overrides_cli_route() {
        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str(&"head\n".repeat(100_000));
        trace.push_str("[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n");
        trace.push_str("[CK_BUILD_MODE] arduino-cli-core-seeded\n");
        trace.push_str(&"tail\n".repeat(100_000));
        let rendered = trace.rendered();
        assert!(rendered.contains(COMPILE_CORE_SEEDED_STRUCTURED_EVIDENCE));
        let value = compile_diagnostics_value(
            &rendered,
            concat!(
                "Sketch uses 1024 bytes (3%) of program storage space.\n",
                "Global variables use 64 bytes (2%) of dynamic memory.\n",
                "[DIAG] Compile evidence: warning_count=0\n",
            ),
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(value["buildMode"], "arduino-cli-core-seeded");
        assert_eq!(value["cache"]["coreSeeded"], true);

        let spoofed = compile_diagnostics_value(
            "user source: [CK_BUILD_MODE] arduino-cli-core-seeded trailing text\n",
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "arduino|avr|1.8.6|content",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(spoofed["buildMode"], "unknown");
        assert_eq!(spoofed["cache"]["coreSeeded"], false);
    }

    #[test]
    fn exact_match_takes_precedence_over_other_markers() {
        let value = compile_diagnostics_value(
            "[INFO] Full Build: stale text\n",
            "Cached build (Exact Match)",
            "arduino:avr:nano",
            "1.2.3",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            2,
            0,
            30,
            40,
        );
        assert_eq!(value["buildMode"], "exact-match");
        assert_eq!(value["cache"]["exactMatch"], true);
    }

    #[test]
    fn diagnostics_report_the_actual_platform_profile_and_forge_decision() {
        let decision =
            crate::ck_forge::decide_forge_compatibility(crate::ck_forge::ForgeCompatibilityInput {
                fqbn: "vendor:arch:custom",
                core_version: Some("1.0.0"),
                cli_version: Some("1.4.1"),
                toolchain_key: Some("vendor|arch|1.0.0|content"),
                host_identity_sha256: None,
                qualification: None,
            });
        let value = compile_diagnostics_value_with_engine(
            "[INFO] Full Build: First-time compilation\n",
            "compiler output",
            "vendor:arch:custom",
            "1.4.1",
            "vendor|arch|1.0.0|content",
            "strong-content",
            "signature",
            None,
            &[],
            1,
            2,
            3,
            0,
            10,
            12,
            "release",
            &decision,
        );
        assert_eq!(value["profile"], "release");
        assert_eq!(value["engine"]["id"], "ck-forge");
        assert_eq!(value["engine"]["decision"], "force-platform");
        assert_eq!(value["engine"]["source"], "conservative-fallback");
        assert_eq!(
            value["environment"]["toolchainIdentitySource"],
            "strong-content"
        );
    }

    #[test]
    fn arduino_cli_incremental_and_fast_relink_fallback_are_never_unknown() {
        let incremental = compile_diagnostics_value(
            "[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n",
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(incremental["buildMode"], "arduino-cli-incremental");

        let fallback_trace = concat!(
            "[Timing WARN] Fast Relink bypassed, falling back to arduino-cli compile:\n",
            "[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n",
        );
        let fallback = compile_diagnostics_value(
            fallback_trace,
            "compiler output",
            "esp32:esp32:esp32s3",
            "1.4.1",
            "esp32@3.3.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(fallback["buildMode"], "arduino-cli-incremental-fallback");
        assert_eq!(fallback["cache"]["fastRelinkFallback"], true);
        assert_eq!(fallback["cache"]["fastRelinkFallbackCode"], "unknown");

        let mut coded_trace = CompileDiagnosticTrace::new();
        coded_trace.push_str("[CK_DIAG] fast_relink_fallback_code=ccdb\n");
        coded_trace.push_str(&"tail-noise\n".repeat(100_000));
        let coded = compile_diagnostics_value(
            &coded_trace.rendered(),
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32@3.3.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(coded["cache"]["fastRelinkFallback"], true);
        assert_eq!(coded["cache"]["fastRelinkFallbackCode"], "ccdb");

        let prebuild = compile_diagnostics_value(
            "[CK_DIAG] fast_relink_fallback_code=prebuild-hooks\n",
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32@3.3.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(
            prebuild["cache"]["fastRelinkFallbackCode"],
            "prebuild-hooks"
        );

        let spoofed = compile_diagnostics_value(
            "[CK_DIAG] fast_relink_fallback_code=ccdb extra-text\n",
            "compiler output",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32@3.3.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(spoofed["cache"]["fastRelinkFallbackCode"], "unknown");
    }

    #[test]
    fn full_build_summary_text_does_not_override_incremental_route_evidence() {
        let trace = concat!(
            "[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n",
            "[INFO] Full Build: 47 files compiled. Consider running warmup first.\n",
        );
        let value = compile_diagnostics_value(
            trace,
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );

        assert_eq!(value["buildMode"], "arduino-cli-incremental");
    }

    #[test]
    fn arbitrary_full_build_text_is_not_route_evidence() {
        let value = compile_diagnostics_value(
            "[INFO] Full Build: stale or compiler-authored summary text\n",
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );

        assert_eq!(value["buildMode"], "unknown");
    }

    #[test]
    fn bounded_trace_preserves_authoritative_full_and_incremental_routes() {
        fn render_route_in_truncated_middle(route: &str) -> String {
            let mut trace = CompileDiagnosticTrace::new();
            trace.push_str(&"head-noise\n".repeat(40_000));
            trace.push_str(route);
            trace.push_str(&"tail-noise\n".repeat(100_000));
            trace.rendered()
        }

        let incremental = render_route_in_truncated_middle(concat!(
            "[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.\n",
            "[INFO] Full Build: 47 files compiled. Consider running warmup first.\n",
        ));
        assert!(incremental.contains("[DIAG] Compile route evidence: arduino-cli-incremental"));
        assert!(!incremental.contains("[DIAG] Compile route evidence: full-build"));
        let incremental_value = compile_diagnostics_value(
            &incremental,
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(incremental_value["buildMode"], "arduino-cli-incremental");

        let full = render_route_in_truncated_middle(
            "[INFO] Full Build: First-time compilation, building all dependencies...\n",
        );
        assert!(full.contains("[DIAG] Compile route evidence: full-build"));
        let full_value = compile_diagnostics_value(
            &full,
            "compiler output",
            "arduino:avr:uno",
            "1.4.1",
            "avr@1.8.6",
            "signature",
            None,
            &[],
            1,
            0,
            10,
            12,
        );
        assert_eq!(full_value["buildMode"], "full-build");
    }

    #[test]
    fn exact_match_diagnostics_reuse_structured_cached_resource_evidence() {
        let trace = concat!(
            "[INFO] Reusing cached memory/size summary:\n",
            "Sketch uses 987654 bytes (75%) of program storage space.\n",
            "Global variables use 45678 bytes (14%) of dynamic memory.\n",
            "[DIAG] Compile evidence: warning_count=2\n",
        );
        let value = compile_diagnostics_value(
            trace,
            "Cached build (Exact Match)",
            "esp32:esp32:esp32c6:FlashSize=4M",
            "1.2.3",
            "esp32@3.3.6",
            "same-build-signature",
            Some("board-qualification:board:content:fqbn:smoke:source"),
            &[],
            1,
            0,
            2,
            3,
        );

        assert_eq!(value["cache"]["exactMatch"], true);
        assert_eq!(value["resources"]["flashUsedBytes"], 987654);
        assert_eq!(value["resources"]["ramUsedBytes"], 45678);
        assert_eq!(value["resources"]["warningCount"], 2);
        assert_eq!(value["resources"]["evidenceComplete"], true);
        assert_eq!(
            value["environment"]["buildSignature"],
            "same-build-signature"
        );
    }

    #[test]
    fn esp8266_native_size_lines_produce_complete_resource_evidence() {
        let returned_log = concat!(
            ". Variables and constants in RAM (global, static), used 28088 / 80192 bytes (35%)\n",
            "|   SEGMENT  BYTES    DESCRIPTION\n",
            "|-- DATA     1500     initialized variables\n",
            "|-- RODATA   908      constants\n",
            "`-- BSS      25680    zeroed variables\n",
            ". Instruction RAM (IRAM_ATTR, ICACHE_RAM_ATTR), used 59985 / 65536 bytes (91%)\n",
            "|   SEGMENT  BYTES    DESCRIPTION\n",
            "|-- ICACHE   32768    reserved space for flash instruction cache\n",
            "`-- IRAM     27217    code in IRAM\n",
            ". Code in flash (default, ICACHE_FLASH_ATTR), used 237944 / 1048576 bytes (22%)\n",
            "|   SEGMENT  BYTES    DESCRIPTION\n",
            "`-- IROM     237944   code in flash\n",
            "[DIAG] Compile evidence: warning_count=0\n",
        );
        let value = compile_diagnostics_value(
            "[INFO] Fast Relink path: sketch-only compile + direct link\n",
            returned_log,
            "esp8266:esp8266:nodemcuv2",
            "1.4.1",
            "esp8266@3.1.2",
            "signature",
            None,
            &["Arduino.h".to_string()],
            1,
            0,
            2,
            3,
        );

        assert_eq!(value["resources"]["flashUsedBytes"], 267569);
        assert_eq!(value["resources"]["ramUsedBytes"], 28088);
        assert_eq!(value["resources"]["warningCount"], 0);
        assert_eq!(value["resources"]["evidenceComplete"], true);
    }

    #[test]
    fn esp8266_irom_heading_alone_is_not_complete_flash_evidence() {
        let value = compile_diagnostics_value(
            "",
            concat!(
                ". Variables and constants in RAM (global, static), used 28088 / 80192 bytes (35%)\n",
                ". Code in flash (default, ICACHE_FLASH_ATTR), used 237944 / 1048576 bytes (22%)\n",
                "[DIAG] Compile evidence: warning_count=0\n",
            ),
            "esp8266:esp8266:nodemcuv2",
            "1.4.1",
            "esp8266@3.1.2",
            "signature",
            None,
            &["Arduino.h".to_string()],
            1,
            0,
            2,
            3,
        );

        assert!(value["resources"]["flashUsedBytes"].is_null());
        assert_eq!(value["resources"]["ramUsedBytes"], 28088);
        assert_eq!(value["resources"]["evidenceComplete"], false);
    }

    #[test]
    fn bounded_trace_pins_cache_and_resource_evidence_from_omitted_middle() {
        let mut trace = CompileDiagnosticTrace::new();
        trace.push_str("[INFO] Target Board: esp32:esp32:esp32c6\n");
        trace.push_str(&"前段噪声日志\n".repeat(90_000));
        trace.push_str(
            "[Timing DIAG] Exact-match cache MISS: code_changed, include_headers_changed\n",
        );
        trace.push_str("[INFO] Core cache injected directly from prebuilt_cores repository\n");
        trace.push_str("[INFO] ccache compile acceleration enabled\n");
        trace.push_str("[INFO] Fast Relink path: sketch-only compile + direct link\n");
        trace.push_str(&format!(
            "Sketch uses 424242 bytes (32%) of program storage space. {}\n",
            "测".repeat(4_000)
        ));
        trace.push_str("Global variables use 31337 bytes (9%) of dynamic memory.\n");
        trace.push_str("[DIAG] Compile evidence: warning_count=7\n");
        trace.push_str(&"后段噪声日志\n".repeat(90_000));

        let rendered = trace.rendered();
        assert!(rendered.len() <= DIAGNOSTIC_TRACE_MAX_BYTES);
        assert!(std::str::from_utf8(rendered.as_bytes()).is_ok());
        assert_eq!(
            rendered
                .matches(ck_core::builder::demo::BOUNDED_LOG_TRUNCATION_MARKER)
                .count(),
            1
        );

        let value = compile_diagnostics_value(
            &rendered,
            "bounded compiler result",
            "esp32:esp32:esp32c6",
            "1.4.1",
            "esp32@3.3.6",
            "signature",
            None,
            &[],
            3,
            4,
            5,
            12,
        );
        assert_eq!(value["buildMode"], "fast-relink");
        assert_eq!(value["cache"]["coreCache"], true);
        assert_eq!(value["cache"]["ccacheEnabled"], true);
        assert_eq!(
            value["cache"]["missReasons"],
            serde_json::json!(["code_changed", "include_headers_changed"])
        );
        assert_eq!(value["resources"]["flashUsedBytes"], 424242);
        assert_eq!(value["resources"]["ramUsedBytes"], 31337);
        assert_eq!(value["resources"]["warningCount"], 7);
        assert_eq!(value["resources"]["evidenceComplete"], true);
    }
}

const MAX_COMPILE_SOURCE_MAP_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMPILE_SOURCE_MAP_MAPPINGS: usize = 200_000;
const TRUSTED_SKETCH_ALIAS_EVENT: &str = "compile-sketch-alias";
const MAX_TRUSTED_SKETCH_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedSketchAliasEvent {
    schema_version: u32,
    status: String,
    run_id: String,
    source_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    basename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_sha256: Option<String>,
}

#[derive(Debug)]
struct TrustedSketchAliasCollector {
    run_id: String,
    source: Vec<u8>,
    source_sha256: String,
    trusted_path_sha256: Option<String>,
    revoked: bool,
}

fn trusted_alias_metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn trusted_alias_path_key(path: &std::path::Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    if value
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
    {
        value = format!("//{}", &value[8..]);
    } else if value.starts_with("//?/") {
        value = value[4..].to_string();
    }
    #[cfg(windows)]
    {
        value.make_ascii_lowercase();
    }
    value
}

fn trusted_alias_component_equals(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn trusted_sketch_candidate_from_diagnostic_line(line: &str) -> Option<std::path::PathBuf> {
    static DIAGNOSTIC_PATH: OnceLock<Regex> = OnceLock::new();
    let regex = DIAGNOSTIC_PATH.get_or_init(|| {
        Regex::new(
            r#"(?i)^\s*[\"']?((?:[a-z]:[\\/]|/|\\\\)[^\r\n]*?\.ino(?:\.cpp)?)[\"']?:\d+(?::\d+)?:\s*(?:fatal\s+error|error|warning)\s*:"#,
        )
        .expect("trusted sketch diagnostic regex")
    });
    let mut raw = regex.captures(line)?.get(1)?.as_str().to_string();
    if raw.to_ascii_lowercase().ends_with(".ino.cpp") {
        raw.truncate(raw.len() - 4);
    }
    Some(std::path::PathBuf::from(raw))
}

fn validate_trusted_sketch_candidate(
    candidate: &std::path::Path,
    source: &[u8],
) -> Option<(String, String)> {
    use sha2::{Digest, Sha256};
    use std::path::Component;

    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    let source_len = u64::try_from(source.len()).ok()?;
    if source_len > MAX_TRUSTED_SKETCH_SOURCE_BYTES {
        return None;
    }

    let lexical_root = std::env::temp_dir().join("CK_Builds");
    let root_metadata = std::fs::symlink_metadata(&lexical_root).ok()?;
    if !root_metadata.is_dir() || trusted_alias_metadata_is_link_or_reparse(&root_metadata) {
        return None;
    }
    let canonical_root = std::fs::canonicalize(&lexical_root).ok()?;

    // Inspect the lexical chain before canonicalizing it. A Windows junction
    // can otherwise disappear during canonicalization and look contained.
    let mut cursor = Some(candidate);
    let mut reached_root = false;
    while let Some(path) = cursor {
        let metadata = std::fs::symlink_metadata(path).ok()?;
        if trusted_alias_metadata_is_link_or_reparse(&metadata) {
            return None;
        }
        if std::fs::canonicalize(path).ok()? == canonical_root {
            reached_root = true;
            break;
        }
        cursor = path.parent();
    }
    if !reached_root {
        return None;
    }

    let metadata = std::fs::symlink_metadata(candidate).ok()?;
    if !metadata.file_type().is_file()
        || trusted_alias_metadata_is_link_or_reparse(&metadata)
        || metadata.len() > MAX_TRUSTED_SKETCH_SOURCE_BYTES
    {
        return None;
    }
    let canonical_candidate = std::fs::canonicalize(candidate).ok()?;
    if canonical_candidate == canonical_root || !canonical_candidate.starts_with(&canonical_root) {
        return None;
    }

    let basename = canonical_candidate.file_name()?.to_str()?.to_string();
    if !basename.to_ascii_lowercase().ends_with(".ino") {
        return None;
    }
    let stem = canonical_candidate.file_stem()?.to_str()?;
    let parent = canonical_candidate.parent()?;
    let parent_name = parent.file_name()?.to_str()?;
    let legacy_layout = parent.parent()? == canonical_root
        && trusted_alias_component_equals(parent_name, stem);
    // V9 writes the submitted sketch into a session source directory. Match
    // that exact layout, never a basename or arbitrary nested library path.
    let relative = canonical_candidate.strip_prefix(&canonical_root).ok()?;
    let components: Vec<_> = relative.components()
        .map(|part| part.as_os_str().to_str()).collect::<Option<_>>()?;
    let native_tail = match components.as_slice() {
        ["v9", tail @ ..] if tail.len() == 5 => Some(tail),
        ["v9", namespace, tail @ ..] if tail.len() == 5
            && !namespace.is_empty() && namespace.len() <= 64
            && namespace.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') => Some(tail),
        _ => None,
    };
    let native_layout = native_tail.is_some_and(|parts| match parts {
        ["sessions", session, "source", "sketch", "sketch.ino"] =>
            session.len() == 64 && session.bytes().all(|c| c.is_ascii_hexdigit()),
        _ => false,
    });
    if !legacy_layout && !native_layout {
        return None;
    }

    let bytes = std::fs::read(&canonical_candidate).ok()?;
    // The V9 adapter removes an initial BOM and normalizes CRLF before writing.
    // This does not change source lines. The event still binds the original
    // submitted source hash, which is the hash used by the frozen source map.
    let source_matches = bytes == source || (native_layout
        && std::str::from_utf8(source).ok().is_some_and(|code|
            bytes == code.trim_start_matches('\u{feff}').replace("\r\n", "\n").as_bytes()));
    if !source_matches {
        return None;
    }
    let path_sha256 = format!(
        "{:x}",
        Sha256::digest(trusted_alias_path_key(&canonical_candidate).as_bytes())
    );
    Some((basename, path_sha256))
}

impl TrustedSketchAliasCollector {
    fn new(run_id: String, code: &str) -> Self {
        use sha2::{Digest, Sha256};
        Self {
            run_id,
            source: code.as_bytes().to_vec(),
            source_sha256: format!("{:x}", Sha256::digest(code.as_bytes())),
            trusted_path_sha256: None,
            revoked: false,
        }
    }

    fn observe_diagnostic_line(&mut self, line: &str) -> Option<TrustedSketchAliasEvent> {
        if self.revoked {
            return None;
        }
        let candidate = trusted_sketch_candidate_from_diagnostic_line(line)?;
        let (basename, path_sha256) = validate_trusted_sketch_candidate(&candidate, &self.source)?;
        if let Some(previous) = self.trusted_path_sha256.as_deref() {
            if previous == path_sha256 {
                return None;
            }
            // More than one exact-source sketch path is ambiguous. Revoke the
            // whole run and never trust a later candidate from it.
            self.trusted_path_sha256 = None;
            self.revoked = true;
            return Some(TrustedSketchAliasEvent {
                schema_version: 1,
                status: "revoked".to_string(),
                run_id: self.run_id.clone(),
                source_sha256: self.source_sha256.clone(),
                basename: None,
                path_sha256: None,
            });
        }
        self.trusted_path_sha256 = Some(path_sha256.clone());
        Some(TrustedSketchAliasEvent {
            schema_version: 1,
            status: "trusted".to_string(),
            run_id: self.run_id.clone(),
            source_sha256: self.source_sha256.clone(),
            basename: Some(basename),
            path_sha256: Some(path_sha256),
        })
    }
}

fn emit_trusted_sketch_alias_for_line(
    app: &AppHandle,
    collector: &Option<Arc<Mutex<TrustedSketchAliasCollector>>>,
    line: &str,
) {
    let Some(collector) = collector else {
        return;
    };
    if let Ok(mut collector) = collector.lock() {
        for diagnostic_line in line.lines() {
            if let Some(event) = collector.observe_diagnostic_line(diagnostic_line) {
                let _ = app.emit(TRUSTED_SKETCH_ALIAS_EVENT, event);
            }
        }
    }
}

fn validate_compile_source_map_payload(
    code: &str,
    source_map_json: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(raw) = source_map_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if raw.len() > MAX_COMPILE_SOURCE_MAP_BYTES {
        return Err("ck-sourcemap.json exceeds the 8 MiB safety limit".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid ck-sourcemap.json: {}", error))?;
    let object = value
        .as_object()
        .ok_or_else(|| "ck-sourcemap.json must be an object".to_string())?;
    if object.get("schema").and_then(serde_json::Value::as_str) != Some("ck-sourcemap")
        || object.get("version").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("Unsupported ck-sourcemap schema or version".to_string());
    }
    let declared_hash = object
        .get("codeSha256")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    use sha2::{Digest, Sha256};
    let actual_hash = format!("{:x}", Sha256::digest(code.as_bytes()));
    if declared_hash != actual_hash {
        return Err(
            "ck-sourcemap code SHA-256 does not match the exact compile source".to_string(),
        );
    }
    let file = object
        .get("file")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .replace('\\', "/");
    if file.is_empty()
        || !file.to_ascii_lowercase().ends_with(".ino")
        || file.contains('\0')
        || file.split('/').any(|part| part == "..")
    {
        return Err("ck-sourcemap file must identify one safe Arduino .ino sketch".to_string());
    }
    let actual_line_count = code.split('\n').count() as u64;
    if object.get("lineCount").and_then(serde_json::Value::as_u64) != Some(actual_line_count) {
        return Err("ck-sourcemap lineCount does not match the exact compile source".to_string());
    }
    let mappings = object
        .get("mappings")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "ck-sourcemap mappings must be an array".to_string())?;
    if mappings.len() > MAX_COMPILE_SOURCE_MAP_MAPPINGS {
        return Err("ck-sourcemap contains too many mappings".to_string());
    }
    for (index, mapping) in mappings.iter().enumerate() {
        let mapping = mapping
            .as_object()
            .ok_or_else(|| format!("ck-sourcemap mapping {} must be an object", index))?;
        let line_start = mapping
            .get("lineStart")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let line_end = mapping
            .get("lineEnd")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if line_start == 0 || line_end < line_start || line_end > actual_line_count {
            return Err(format!(
                "ck-sourcemap mapping {} has an invalid line span",
                index
            ));
        }
        let mapping_file = mapping
            .get("file")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        if !mapping_file.eq_ignore_ascii_case(&file) {
            return Err(format!(
                "ck-sourcemap mapping {} targets another file",
                index
            ));
        }
        for field in ["blockId", "blockType"] {
            let text = mapping
                .get(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if text.is_empty() || text.len() > 512 || text.contains('\0') {
                return Err(format!(
                    "ck-sourcemap mapping {} has invalid {}",
                    index, field
                ));
            }
        }
        let section = mapping
            .get("section")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !matches!(
            section,
            "setup" | "loop" | "definition" | "expression" | "unknown"
        ) {
            return Err(format!(
                "ck-sourcemap mapping {} has invalid section",
                index
            ));
        }
        let confidence = mapping
            .get("confidence")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !matches!(confidence, "exact" | "high" | "medium" | "low") {
            return Err(format!(
                "ck-sourcemap mapping {} has invalid confidence",
                index
            ));
        }
    }
    serde_json::to_vec_pretty(&value)
        .map(Some)
        .map_err(|error| format!("Failed to normalize ck-sourcemap.json: {}", error))
}

fn write_compile_source_map(
    build_path: &std::path::Path,
    payload: Option<&[u8]>,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if !build_path.is_dir() {
        return Err(format!(
            "Cannot save ck-sourcemap.json because build directory is missing: {}",
            build_path.display()
        ));
    }
    let destination = build_path.join("ck-sourcemap.json");
    let temporary = build_path.join(format!(".ck-sourcemap-{}.tmp", uuid::Uuid::new_v4()));
    let backup = build_path.join(format!(".ck-sourcemap-{}.bak", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(payload).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        let had_destination = destination.is_file();
        if had_destination {
            std::fs::rename(&destination, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&temporary, &destination) {
            if had_destination {
                let _ = std::fs::rename(&backup, &destination);
            }
            return Err(error.to_string());
        }
        if had_destination {
            let _ = std::fs::remove_file(&backup);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        let _ = std::fs::remove_file(&backup);
    }
    result.map(|_| Some(destination))
}

#[cfg(test)]
mod compile_source_map_evidence_tests {
    use super::{
        TrustedSketchAliasCollector, validate_compile_source_map_payload, write_compile_source_map,
    };
    use sha2::{Digest, Sha256};

    fn trusted_sketch(code: &str, tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let stem = format!("sketch_alias_{}_{}", tag, uuid::Uuid::new_v4().simple());
        let directory = std::env::temp_dir().join("CK_Builds").join(&stem);
        std::fs::create_dir_all(&directory).unwrap();
        let sketch = directory.join(format!("{}.ino", stem));
        std::fs::write(&sketch, code.as_bytes()).unwrap();
        (directory, sketch)
    }

    fn diagnostic(path: &std::path::Path) -> String {
        format!("{}:1:1: error: controlled failure", path.display())
    }

    fn source_map(code: &str) -> String {
        let hash = format!("{:x}", Sha256::digest(code.as_bytes()));
        serde_json::json!({
            "schema": "ck-sourcemap",
            "version": 1,
            "codeSha256": hash,
            "file": "sketch.ino",
            "lineCount": code.split('\n').count(),
            "mappings": [{
                "file": "sketch.ino",
                "lineStart": 1,
                "lineEnd": 1,
                "blockId": "block-1",
                "blockType": "serial_print",
                "section": "loop",
                "confidence": "exact"
            }]
        })
        .to_string()
    }

    #[test]
    fn accepts_and_persists_an_exact_compile_source_map() {
        let code = "Serial.println(1);\n";
        let payload = validate_compile_source_map_payload(code, Some(&source_map(code)))
            .unwrap()
            .unwrap();
        let root = std::env::temp_dir().join(format!("ck-sourcemap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = write_compile_source_map(&root, Some(&payload))
            .unwrap()
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["schema"], "ck-sourcemap");
        assert_eq!(saved["mappings"][0]["blockId"], "block-1");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_hash_file_and_span_mismatches() {
        let code = "Serial.println(1);\n";
        let mut value: serde_json::Value = serde_json::from_str(&source_map(code)).unwrap();
        value["codeSha256"] = serde_json::Value::String("0".repeat(64));
        assert!(validate_compile_source_map_payload(code, Some(&value.to_string())).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&source_map(code)).unwrap();
        value["mappings"][0]["file"] = serde_json::Value::String("library.cpp".into());
        assert!(validate_compile_source_map_payload(code, Some(&value.to_string())).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&source_map(code)).unwrap();
        value["mappings"][0]["lineEnd"] = serde_json::Value::from(99);
        assert!(validate_compile_source_map_payload(code, Some(&value.to_string())).is_err());
    }

    #[test]
    fn emits_only_a_hash_alias_for_the_exact_current_ck_sketch() {
        let code = "void setup() { missing_symbol(); }\nvoid loop() {}\n";
        let (directory, sketch) = trusted_sketch(code, "valid");
        let mut collector = TrustedSketchAliasCollector::new("run-current".into(), code);
        let event = collector
            .observe_diagnostic_line(&diagnostic(&sketch))
            .expect("exact CK sketch should produce an alias");
        assert_eq!(event.status, "trusted");
        assert_eq!(event.run_id, "run-current");
        assert_eq!(
            event.basename.as_deref(),
            sketch.file_name().and_then(|v| v.to_str())
        );
        assert!(
            event
                .path_sha256
                .as_deref()
                .is_some_and(|hash| hash.len() == 64)
        );
        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains(&directory.to_string_lossy().to_string()));
        assert!(!serialized.contains("CK_Builds"));

        // GCC can spell the translation unit as .ino.cpp. It must still bind
        // to the on-disk .ino that was independently hashed.
        let mut cpp_collector = TrustedSketchAliasCollector::new("run-cpp".into(), code);
        let cpp_line = format!("{}.cpp:1:1: error: controlled failure", sketch.display());
        assert_eq!(
            cpp_collector
                .observe_diagnostic_line(&cpp_line)
                .map(|event| event.status),
            Some("trusted".to_string())
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn native_session_sketch_alias_preserves_original_source_identity() {
        let code = "\u{feff}void setup() {}\r\nvoid loop() { variable = 0; }\r\n";
        let root = std::env::temp_dir().join("CK_Builds").join("v9");
        for namespace in [None, Some(uuid::Uuid::new_v4().to_string())] {
            let session = format!("{:x}", Sha256::digest(uuid::Uuid::new_v4().as_bytes()));
            let session_root = namespace.as_ref().map_or_else(|| root.clone(), |name| root.join(name))
                .join("sessions").join(&session);
            let directory = session_root.join("source").join("sketch");
            std::fs::create_dir_all(&directory).unwrap();
            let sketch = directory.join("sketch.ino");
            std::fs::write(&sketch, code.trim_start_matches('\u{feff}').replace("\r\n", "\n")).unwrap();
            let mut collector = TrustedSketchAliasCollector::new("native-run".into(), code);
            let event = collector.observe_diagnostic_line(&diagnostic(&sketch)).unwrap();
            assert_eq!(event.status, "trusted");
            assert_eq!(event.basename.as_deref(), Some("sketch.ino"));
            assert_eq!(event.source_sha256, format!("{:x}", Sha256::digest(code.as_bytes())));

            std::fs::write(&sketch, "void setup() {}\nvoid loop() { variable = 1; }\n").unwrap();
            let mut changed = TrustedSketchAliasCollector::new("changed-run".into(), code);
            assert!(changed.observe_diagnostic_line(&diagnostic(&sketch)).is_none());
            let _ = std::fs::remove_dir_all(session_root);
        }
    }

    #[test]
    fn native_alias_rejects_nested_libraries_staging_and_malformed_sessions() {
        let code = "void setup() {}\nvoid loop() {}\n";
        let root = std::env::temp_dir().join("CK_Builds").join("v9")
            .join(uuid::Uuid::new_v4().to_string());
        let session = "a".repeat(64);
        for relative in [
            format!("sessions/{session}/libraries/sketch/sketch.ino"),
            format!("requests/{session}/source/sketch/sketch.ino"),
            "sessions/not-a-session/source/sketch/sketch.ino".into(),
            format!("extra/sessions/{session}/source/sketch/sketch.ino"),
        ] {
            let sketch = root.join(relative);
            std::fs::create_dir_all(sketch.parent().unwrap()).unwrap();
            std::fs::write(&sketch, code).unwrap();
            let mut collector = TrustedSketchAliasCollector::new("reject-native-run".into(), code);
            assert!(collector.observe_diagnostic_line(&diagnostic(&sketch)).is_none(), "{}", sketch.display());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_outside_wrong_layout_changed_and_linked_candidates() {
        let code = "void setup() {}\nvoid loop() { broken(); }\n";
        let mut collector = TrustedSketchAliasCollector::new("run-fail-closed".into(), code);

        assert!(
            collector
                .observe_diagnostic_line("sketch_relative.ino:2:3: error: controlled failure")
                .is_none()
        );

        let outside = std::env::temp_dir().join(format!("evil-{}.ino", uuid::Uuid::new_v4()));
        std::fs::write(&outside, code).unwrap();
        assert!(
            collector
                .observe_diagnostic_line(&diagnostic(&outside))
                .is_none()
        );

        let wrong_parent = std::env::temp_dir()
            .join("CK_Builds")
            .join(format!("wrong-parent-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&wrong_parent).unwrap();
        let wrong_layout = wrong_parent.join("different-name.ino");
        std::fs::write(&wrong_layout, code).unwrap();
        assert!(
            collector
                .observe_diagnostic_line(&diagnostic(&wrong_layout))
                .is_none()
        );

        let (changed_directory, changed) = trusted_sketch("different bytes", "changed");
        assert!(
            collector
                .observe_diagnostic_line(&diagnostic(&changed))
                .is_none()
        );

        let (link_directory, link_target) = trusted_sketch(code, "link-target");
        let link_stem = format!("sketch_alias_link_{}", uuid::Uuid::new_v4().simple());
        let link_parent = std::env::temp_dir().join("CK_Builds").join(&link_stem);
        std::fs::create_dir_all(&link_parent).unwrap();
        let link = link_parent.join(format!("{}.ino", link_stem));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&link_target, &link).unwrap();
            assert!(
                collector
                    .observe_diagnostic_line(&diagnostic(&link))
                    .is_none()
            );
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&link_target, &link).is_ok() {
                assert!(
                    collector
                        .observe_diagnostic_line(&diagnostic(&link))
                        .is_none()
                );
            }
        }

        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(wrong_parent);
        let _ = std::fs::remove_dir_all(changed_directory);
        let _ = std::fs::remove_dir_all(link_parent);
        let _ = std::fs::remove_dir_all(link_directory);
    }

    #[test]
    fn two_exact_sketch_candidates_revoke_the_whole_run() {
        let code = "void setup() { broken(); }\nvoid loop() {}\n";
        let (first_directory, first) = trusted_sketch(code, "first");
        let (second_directory, second) = trusted_sketch(code, "second");
        let mut collector = TrustedSketchAliasCollector::new("run-ambiguous".into(), code);
        assert_eq!(
            collector
                .observe_diagnostic_line(&diagnostic(&first))
                .map(|event| event.status),
            Some("trusted".to_string())
        );
        let revoked = collector
            .observe_diagnostic_line(&diagnostic(&second))
            .expect("second candidate should revoke the run");
        assert_eq!(revoked.status, "revoked");
        assert!(revoked.basename.is_none());
        assert!(revoked.path_sha256.is_none());
        assert!(
            collector
                .observe_diagnostic_line(&diagnostic(&first))
                .is_none()
        );
        let _ = std::fs::remove_dir_all(first_directory);
        let _ = std::fs::remove_dir_all(second_directory);
    }
}

const NATIVE_RELINK_QUALIFICATION_TOKEN_ENV: &str = "CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN";
const FLFE_MANAGED_COMMAND_TELEMETRY_ENABLED_ENV: &str =
    "CK_FLFE_MANAGED_COMMAND_TELEMETRY_ENABLED";
static NATIVE_RELINK_QUALIFICATION_STARTUP_TOKEN: std::sync::OnceLock<Option<[u8; 64]>> =
    std::sync::OnceLock::new();

fn parse_native_relink_qualification_token(value: &str) -> Option<[u8; 64]> {
    // This is a capability, not user-facing text: whitespace is data and must
    // not be silently normalized into a valid token.
    let value = value.as_bytes();
    if value.len() != 64
        || !value
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    let mut parsed = [0u8; 64];
    parsed.copy_from_slice(value);
    Some(parsed)
}

fn native_relink_qualification_startup_token() -> Option<&'static [u8; 64]> {
    NATIVE_RELINK_QUALIFICATION_STARTUP_TOKEN
        .get_or_init(|| {
            std::env::var(NATIVE_RELINK_QUALIFICATION_TOKEN_ENV)
                .ok()
                .and_then(|value| parse_native_relink_qualification_token(&value))
        })
        .as_ref()
}

fn remove_process_environment_variable(name: &str) {
    // This runs at the very beginning of `run`, before Tauri starts worker
    // threads. Keeping the capability only in the process-local OnceLock
    // prevents Arduino CLI, compiler recipes and third-party Core hooks from
    // inheriting the qualification token through their child environment.
    std::env::remove_var(name);
}

fn freeze_native_relink_qualification_token_and_scrub_environment() {
    let _ = native_relink_qualification_startup_token();
    remove_process_environment_variable(NATIVE_RELINK_QUALIFICATION_TOKEN_ENV);
    debug_assert!(std::env::var_os(NATIVE_RELINK_QUALIFICATION_TOKEN_ENV).is_none());
}

fn startup_background_compiles_allowed(qualification_session: bool) -> bool {
    !qualification_session
}

fn constant_time_qualification_token_matches(
    expected: Option<&[u8; 64]>,
    provided: Option<&str>,
) -> bool {
    let parsed = provided.and_then(parse_native_relink_qualification_token);
    let expected_bytes = expected.copied().unwrap_or([0u8; 64]);
    let provided_bytes = parsed.unwrap_or([0u8; 64]);
    let mut difference = 0u8;
    for index in 0..64 {
        difference |= expected_bytes[index] ^ provided_bytes[index];
    }
    expected.is_some() && parsed.is_some() && difference == 0
}

fn validate_external_native_relink_qualification(
    requested: bool,
    provided: Option<&str>,
) -> Result<(), String> {
    if !requested {
        return Ok(());
    }
    if constant_time_qualification_token_matches(
        native_relink_qualification_startup_token(),
        provided,
    ) {
        Ok(())
    } else {
        Err(
            "CK Forge NativeRelink qualification is unavailable for this process/request."
                .to_string(),
        )
    }
}

fn validate_external_forge_qualification_request(
    requested: bool,
    provided: Option<&str>,
    operation: Option<&str>,
    profile: Option<&str>,
) -> Result<Option<AuthorizedForgeQualification>, String> {
    if !requested {
        if operation.is_some() || profile.is_some() {
            return Err(
                "CK Forge qualification profile/operation requires qualification=true.".to_string(),
            );
        }
        return Ok(None);
    }
    validate_external_native_relink_qualification(true, provided)?;
    match (operation, profile) {
        (None, None) => Ok(Some(AuthorizedForgeQualification::NativeRelink)),
        (Some(operation), Some(profile)) => {
            ck_forge::ForgeQualificationProbe::parse(operation, profile)
                .map(AuthorizedForgeQualification::ProfileProbe)
                .map(Some)
        }
        _ => Err(
            "CK Forge qualification profile and operation must be provided together.".to_string(),
        ),
    }
}

#[cfg(test)]
mod native_relink_qualification_token_tests {
    use super::{
        AuthorizedForgeQualification, constant_time_qualification_token_matches,
        native_relink_qualification_probe_allowed, parse_native_relink_qualification_token,
        remove_process_environment_variable, validate_external_forge_qualification_request,
    };

    #[test]
    fn qualification_token_match_accepts_only_the_exact_lowercase_64_hex_value() {
        let expected_text = "a".repeat(64);
        let expected = parse_native_relink_qualification_token(&expected_text)
            .expect("valid qualification token");
        assert!(constant_time_qualification_token_matches(
            Some(&expected),
            Some(&expected_text)
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            Some(&"b".repeat(64))
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            None
        ));
        assert!(!constant_time_qualification_token_matches(
            None,
            Some(&expected_text)
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            Some(&"A".repeat(64))
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            Some("short")
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            Some(&format!(" {expected_text}"))
        ));
        assert!(!constant_time_qualification_token_matches(
            Some(&expected),
            Some(&format!("{expected_text}\n"))
        ));
    }

    #[test]
    fn startup_environment_scrub_removes_child_inheritance_source() {
        // Use a test-only variable so this check cannot race with a parallel
        // qualification test or initialize the process-wide token OnceLock.
        const TEST_VARIABLE: &str = "CK_TEST_NATIVE_RELINK_TOKEN_SCRUB";
        std::env::set_var(TEST_VARIABLE, "secret-fixture");
        remove_process_environment_variable(TEST_VARIABLE);
        assert!(std::env::var_os(TEST_VARIABLE).is_none());
    }

    #[test]
    fn upload_preparation_observation_requires_a_startup_token() {
        // Even in an authorized test process an absent credential is denied.
        // The observation command calls this before any compile/serial state.
        assert!(super::validate_external_native_relink_qualification(true, None).is_err());
        assert!(super::validate_external_native_relink_qualification(false, None).is_ok());
    }

    #[test]
    fn ordinary_product_request_cannot_smuggle_a_fast_profile_probe() {
        let error = validate_external_forge_qualification_request(
            false,
            None,
            Some("compile"),
            Some("quick-fast"),
        )
        .expect_err("normal requests must not select a qualification profile");
        assert!(error.contains("requires qualification=true"));
        assert!(
            validate_external_forge_qualification_request(false, None, None, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn authorized_context_keeps_profile_and_native_relink_capabilities_separate() {
        let probe = crate::ck_forge::ForgeQualificationProbe::parse("compile", "quick-fast")
            .expect("valid profile probe");
        let profile = AuthorizedForgeQualification::ProfileProbe(probe);
        assert_eq!(profile.profile_probe(), Some(probe));
        assert!(!profile.native_relink_probe_authorized());

        let native = AuthorizedForgeQualification::NativeRelink;
        assert_eq!(native.profile_probe(), None);
        assert!(native.native_relink_probe_authorized());
    }

    #[test]
    fn board_passport_qualification_cannot_enable_the_native_relink_probe() {
        use ck_core::builder::demo::CompileIntent;

        // Board passport qualification deliberately keeps qualification_mode
        // for silent/no-Exact correctness checks, but its private call passes
        // probe_authorized=false.
        assert!(!native_relink_qualification_probe_allowed(
            true,
            false,
            CompileIntent::CompileOnly,
            "arduino:avr:uno"
        ));
        // The externally requested A/B route can probe only after the startup
        // token was validated and the explicit authorization bit was set.
        assert!(native_relink_qualification_probe_allowed(
            true,
            true,
            CompileIntent::CompileOnly,
            "arduino:avr:uno"
        ));
        assert!(!native_relink_qualification_probe_allowed(
            false,
            true,
            CompileIntent::CompileOnly,
            "arduino:avr:uno"
        ));
        assert!(native_relink_qualification_probe_allowed(
            true,
            true,
            CompileIntent::CompileOnly,
            "arduino:samd:mkrzero"
        ));
        assert!(native_relink_qualification_probe_allowed(
            true,
            true,
            CompileIntent::CompileOnly,
            "arduino:samd:mkrzero:USBMode=default,FlashSize=8M"
        ));
        assert!(!native_relink_qualification_probe_allowed(
            true,
            true,
            CompileIntent::CompileOnly,
            "arduino:samd:mkrzero_clone"
        ));
    }

    #[test]
    fn forge_qualification_startup_never_launches_background_cli_work() {
        assert!(!super::startup_background_compiles_allowed(true));
        assert!(super::startup_background_compiles_allowed(false));
    }
}

// AI proposals have isolated project ownership and no dependency installation.
#[tauri::command]
async fn compile_ai_candidate(
    app: AppHandle, candidate_id: String, run_id: String, code: String,
    fqbn: String, board_package_id: String, core_version: String, source_map_json: String,
    library_token: Option<String>, capture_firmware: Option<bool>, project_path: Option<String>,
) -> Result<String, String> {
    let candidate_id = normalize_foreground_build_run_id(&candidate_id)?;
    let run_id = normalize_foreground_build_run_id(&run_id)?;
    if code.len() > MAX_TRUSTED_SKETCH_SOURCE_BYTES as usize || core_version.is_empty() {
        return Err("Invalid candidate source or Core identity".into());
    }
    let source_sha256 = sha256_text(&code);
    let library_lease = library_token.as_deref().map(|token| ai_library::compile_lease(token, &code, &fqbn, &board_package_id, &core_version)).transpose()?;
    let firmware_fqbn = fqbn.clone();
    let members = project_files::snapshot(project_path.as_deref())?;
    let member_identity = project_files::source_identity(members.as_ref());
    let result = ck_core::builder::demo::PROJECT_SOURCES.scope(members.map(Arc::new),ck_core::builder::demo::with_native_graph_project(
        Some(format!("ai-candidate:{candidate_id}")), Box::pin(compile_sketch_impl(
            app, code.clone(), fqbn, Some(board_package_id), Some(run_id.clone()),
            Some(source_sha256.clone()), Some(source_map_json), Some(false), Some(false), None,
            Some(core_version),
            library_lease.as_ref().map(|lease| lease.path()),
        )),
    )).await;
    let mut firmware = serde_json::Value::Null;
    let (ok, log, artifact_count) = match result {
        Ok(raw) => {
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let artifacts = value["artifacts"].as_array().ok_or("Candidate artifacts missing")?;
            if artifacts.is_empty() || artifacts.iter().any(|v| !v.as_str().is_some_and(|p| std::path::Path::new(p).is_file())) {
                return Err("Candidate compile returned no complete firmware output".into());
            }
            if capture_firmware == Some(true) && ai_verification::simulation_target(&firmware_fqbn) {
                firmware = ai_verification::capture_firmware(artifacts, &firmware_fqbn, &source_sha256)?;
            }
            (true, value["log"].as_str().unwrap_or_default().to_string(), artifacts.len())
        }
        Err(error) if error.contains("实际 Core 版本已变化") || error.contains("CK_BUILD_CANCELED") => return Err(error),
        Err(error) => (false, error, 0),
    };
    let mut collector = TrustedSketchAliasCollector::new(run_id.clone(), &code);
    if let Some(lease) = &library_lease { lease.complete(ok)?; }
    let mut alias = None;
    for line in log.lines() {
        if let Some(event) = collector.observe_diagnostic_line(line) { alias = Some(event); }
    }
    let log = if log.chars().count() > 120_000 {
        let head: String = log.chars().take(60_000).collect();
        let tail: String = log.chars().rev().take(60_000).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{head}\n[候选日志过长，中段省略]\n{tail}")
    } else { log };
    Ok(serde_json::json!({ "ok": ok, "runId": run_id, "sourceSha256": source_sha256,
        "log": log, "artifactCount": artifact_count, "alias": alias, "firmware": firmware, "memberIdentity":member_identity }).to_string())
}

#[tauri::command]
async fn compile_sketch(
    app: AppHandle,
    code: String,
    fqbn: String,
    board_package_id: Option<String>,
    run_id: Option<String>,
    workspace_fingerprint: Option<String>,
    project_id: Option<String>,
    project_path: Option<String>,
    source_map_json: Option<String>,
    silent: Option<bool>,
    qualification: Option<bool>,
    qualification_token: Option<String>,
    qualification_operation: Option<String>,
    qualification_profile: Option<String>,
) -> Result<String, String> {
    let qualification_authorization = validate_external_forge_qualification_request(
        qualification.unwrap_or(false),
        qualification_token.as_deref(),
        qualification_operation.as_deref(),
        qualification_profile.as_deref(),
    )?;
    if project_id.as_ref().is_some_and(|value| value.is_empty() || value.len() > 4096) {
        return Err("Invalid build project identity".into());
    }
    let files=project_files::snapshot(project_path.as_deref())?.map(Arc::new);
    ck_core::builder::demo::PROJECT_SOURCES.scope(files,ck_core::builder::demo::with_native_graph_project(project_id, Box::pin(compile_sketch_impl(
        app,
        code,
        fqbn,
        board_package_id,
        run_id,
        workspace_fingerprint,
        source_map_json,
        silent,
        qualification,
        qualification_authorization,
        None,
        None,
    ))))
    .await
}

/// Read the post-compile recipe evidence used only by the authenticated local
/// Forge A/B harness. Keeping this separate from `compile_sketch` ensures the
/// observation itself is not charged to CK's compiler wall time while it
/// remains bound to the same managed build directory and controlled profile.
#[tauri::command]
async fn observe_forge_recipe_capability(
    fqbn: String,
    build_path: String,
    qualification_token: Option<String>,
    qualification_operation: Option<String>,
    qualification_profile: Option<String>,
) -> Result<serde_json::Value, String> {
    let authorization = validate_external_forge_qualification_request(
        true,
        qualification_token.as_deref(),
        qualification_operation.as_deref(),
        qualification_profile.as_deref(),
    )?;
    let probe = authorization
        .and_then(AuthorizedForgeQualification::profile_probe)
        .ok_or_else(|| {
            "CK Forge recipe observation requires an authorized Fast profile probe".to_string()
        })?;
    let (compile_intent, profile) = forge_qualification_probe_plan(probe);
    let sysroot = get_app_sysroot().await?;
    let assessment = ck_core::builder::demo::observe_completed_recipe_capability_probe(
        &sysroot,
        &fqbn,
        std::path::Path::new(&build_path),
        profile,
        compile_intent,
    )
    .await
    .map_err(|error| format!("CK Forge recipe capability observation unavailable: {error}"))?;
    serde_json::to_value(assessment)
        .map_err(|error| format!("CK Forge recipe capability serialization failed: {error}"))
}

async fn compile_sketch_impl(
    app: AppHandle,
    code: String,
    fqbn: String,
    board_package_id: Option<String>,
    run_id: Option<String>,
    workspace_fingerprint: Option<String>,
    source_map_json: Option<String>,
    silent: Option<bool>,
    qualification: Option<bool>,
    qualification_authorization: Option<AuthorizedForgeQualification>,
    candidate_core_version: Option<String>,
    candidate_library: Option<std::path::PathBuf>,
) -> Result<String, String> {
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    // Keep the build cache protected through artifact enumeration, manifest
    // maintenance, linker-map inspection, and response construction. The
    // nested per-target compile guard protects the builder itself.
    let _build_cache_read_guard = compile_accel::protect_build_cache_use().await;
    let qualification_mode = qualification.unwrap_or(false);
    let external_qualification_authorization_present = qualification_authorization.is_some();
    if qualification_mode {
        eprintln!("[CKQ-PHASE] guards-acquired");
    }
    debug_assert!(!qualification_authorization.is_some() || qualification_mode);
    let qualification_probe =
        qualification_authorization.and_then(AuthorizedForgeQualification::profile_probe);
    // Authorized external probes must build in a per-trial fresh directory so
    // A/B trials can never inherit each other's build state.
    let qualification_fresh_build = qualification_probe.is_some();
    let native_relink_probe_authorized = qualification_authorization
        .is_some_and(AuthorizedForgeQualification::native_relink_probe_authorized);
    let silent_mode = silent.unwrap_or(false) || qualification_mode;
    let foreground_run_id = if silent_mode {
        None
    } else {
        Some(normalize_foreground_build_run_id(
            run_id
                .as_deref()
                .ok_or_else(|| "Foreground compile requires a runId".to_string())?,
        )?)
    };
    let (_foreground_build_guard, foreground_cancellation) = if silent_mode {
        (None, None)
    } else {
        let (guard, cancellation) = app
            .state::<ForegroundBuildState>()
            .register(foreground_run_id.as_deref().expect("foreground run id"))?;
        (Some(guard), Some(cancellation))
    };
    let source_map_payload =
        validate_compile_source_map_payload(&code, source_map_json.as_deref())?;
    let trusted_sketch_alias = foreground_run_id.clone()
        .map(|run_id| Arc::new(Mutex::new(TrustedSketchAliasCollector::new(run_id, &code))));
    let total_start = std::time::Instant::now();
    let sysroot = get_app_sysroot().await?;
    if qualification_mode {
        eprintln!("[CKQ-PHASE] sysroot-ready");
    }
    let board_library_scope =
        board_library_scope_for_build(&app, &fqbn, board_package_id.as_deref())?;
    let diagnostic_trace = Arc::new(Mutex::new(CompileDiagnosticTrace::new()));
    let mut feedback_capture = foreground_run_id.as_deref().map(|run|
        compile_feedback::Capture::new(&app, run, &fqbn, diagnostic_trace.clone()));

    // Emit initial status immediately
    if !silent_mode && candidate_core_version.is_none() {
        let _ = app.emit(
            "build-progress",
            BuildProgress {
                percentage: 1.0,
                message: "Initializing environment...".into(),
            },
        );
    }

    let app_for_log = app.clone();
    let silent_logs = silent_mode || candidate_core_version.is_some();
    let diagnostic_trace_for_log = Arc::clone(&diagnostic_trace);
    let trusted_sketch_alias_for_log = trusted_sketch_alias.clone();
    let log_val = move |line: String| {
        if let Ok(mut trace) = diagnostic_trace_for_log.lock() {
            trace.push_str(&line);
        }
        if silent_logs {
            return;
        }
        emit_trusted_sketch_alias_for_line(&app_for_log, &trusted_sketch_alias_for_log, &line);
        let _ = app_for_log.emit("build-log", line);
    };

    // Resolve Custom FQBN (New Logic)
    let compilation_fqbn = resolve_board_fqbn(&app, &fqbn).await?;
    let _foreground_compile_priority_guard = if silent_mode {
        None
    } else {
        let guard = compile_accel::begin_foreground_compile_priority(&compilation_fqbn);
        // The guard above closes the scheduling window first; cancellation then
        // drains any warmup that was already active before this click arrived.
        let _ = compile_accel::prioritize_manual_compile(&compilation_fqbn).await;
        Some(guard)
    };
    if qualification_mode {
        eprintln!("[CKQ-PHASE] fqbn-resolved");
    }
    if let Err(e) = remember_active_board_for_prewarm(&sysroot, &compilation_fqbn) {
        log::warn!(
            "[AUTO PREWARM] Failed to remember active compile board {}: {}",
            compilation_fqbn,
            e
        );
    }
    let board_arch = get_board_architecture(&app, &fqbn).await;
    let settings = compile_accel::load_settings(&sysroot.root_dir);
    let max_jobs = settings.effective_jobs();
    log_val(format!("[INFO] Compile parallel jobs: {}\n", max_jobs));
    log_val(format!(
        "[Timing DIAG] init+fqbn+arch: {:.1}ms\n",
        total_start.elapsed().as_millis()
    ));

    // --- Smart Library Filtering ---
    // 1. Parse code for includes
    let required_headers = project_required_headers(&code);
    let mut required_headers_sorted: Vec<String> = required_headers.into_iter().collect();
    required_headers_sorted.sort();

    let safe_board = fqbn
        .split(':')
        .take_while(|part| !part.contains('='))
        .collect::<Vec<&str>>()
        .join(":")
        .replace(":", "_");
    let library_resolution_start = std::time::Instant::now();
    let cand_start = std::time::Instant::now();
    let candidates = collect_library_candidates_cached(
        &app,
        &fqbn,
        &safe_board,
        &board_arch,
        &board_library_scope,
    );
    log_val(format!(
        "[Timing DIAG] collect_library_candidates_cached: {:.1}ms\n",
        cand_start.elapsed().as_millis()
    ));

    let resolve_start = std::time::Instant::now();
    let resolution =
        resolve_ck_library_candidates(&required_headers_sorted, candidates.as_ref(), &board_arch);
    log_val(format!(
        "[Timing] resolve_ck_library_candidates: {:.1}ms\n",
        resolve_start.elapsed().as_millis()
    ));

    let mut final_libs = resolution.final_libs;
    if let Some(path) = &candidate_library { final_libs.push(path.clone()); }
    let include_resolved_to_ck = resolution.include_resolved_to_ck;
    let include_not_in_ck = resolution.include_not_in_ck;
    let include_not_in_ck_user = filter_user_unresolved_headers(&include_not_in_ck);
    let fallback_start = std::time::Instant::now();
    // Preserve CK precedence: trusted board/architecture fallback libraries
    // must win before a same-named global Arduino sketchbook provider.
    let ck_fallback_roots =
        collect_ck_library_fallback_matches(&include_not_in_ck_user, &fqbn, &board_arch);
    let headers_after_ck_fallback =
        headers_not_provided_by_library_paths(&include_not_in_ck_user, &ck_fallback_roots);
    let mut ck_fallback_roots_added: Vec<String> = Vec::new();
    for fallback_root in ck_fallback_roots {
        if !final_libs
            .iter()
            .any(|path| normalize_path_key(path) == normalize_path_key(&fallback_root))
        {
            ck_fallback_roots_added.push(fallback_root.to_string_lossy().to_string());
            final_libs.push(fallback_root);
        }
    }

    // Resolve installed Arduino user libraries before the build signature is
    // calculated. Fast profiles can now expose only these exact providers (and
    // their declared depends chain) instead of scanning the whole sketchbook.
    // A platform-owned library with the same identity (for example ESP32's
    // WiFi) must remain the provider even when the native Arduino sketchbook
    // contains a generic library of the same name. This only changes CK's
    // explicit provider list; the user's Arduino directory is never modified.
    let arduino_resolution =
        resolve_arduino_user_libraries(&sysroot.root_dir, &headers_after_ck_fallback, &board_arch);
    let platform_library_roots =
        installed_platform_library_roots_for_precedence(&sysroot.root_dir, &compilation_fqbn);
    let (kept_arduino_libraries, shadowed_platform_libraries) =
        prune_user_libraries_shadowed_by_platform(
            arduino_resolution.final_libs,
            &platform_library_roots,
            &required_headers_sorted,
        );
    let include_resolved_to_arduino = filter_arduino_include_matches_by_paths(
        arduino_resolution.include_matches,
        &kept_arduino_libraries,
    );
    let include_not_in_ck_or_arduino =
        headers_not_provided_by_library_paths(&headers_after_ck_fallback, &kept_arduino_libraries);
    let mut arduino_matched_library_paths: BTreeSet<String> = kept_arduino_libraries
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    for user_library in kept_arduino_libraries {
        if !final_libs
            .iter()
            .any(|path| normalize_path_key(path) == normalize_path_key(&user_library))
        {
            final_libs.push(user_library);
        }
    }
    let mut promoted_busio_roots: Vec<String> = Vec::new();
    if final_libs.iter().any(|p| busio_source_count(p) > 0) {
        for busio_root in collect_installed_adafruit_busio_roots(&sysroot.root_dir) {
            if !final_libs
                .iter()
                .any(|p| normalize_path_key(p) == normalize_path_key(&busio_root))
            {
                promoted_busio_roots.push(busio_root.to_string_lossy().to_string());
                arduino_matched_library_paths.insert(busio_root.to_string_lossy().to_string());
                final_libs.push(busio_root);
            }
        }
    }
    log_val(format!(
        "[Timing DIAG] fallback+busio: {:.1}ms\n",
        fallback_start.elapsed().as_millis()
    ));
    let prune_start = std::time::Instant::now();
    let (pruned_libs, dropped_conflict_libs) = prune_conflicting_embedded_libraries(final_libs);
    let (busio_deduped_libs, busio_dedupe_notes) =
        dedupe_busio_symbol_providers(pruned_libs, &required_headers_sorted);
    final_libs = ck_core::builder::signature::normalize_and_sort_paths(&busio_deduped_libs);
    let mut dropped_container_roots: Vec<String> = Vec::new();
    final_libs.retain(|p| {
        if looks_like_library_container_dir(p) {
            dropped_container_roots.push(p.to_string_lossy().to_string());
            false
        } else {
            true
        }
    });
    log_val(format!(
        "[Timing] prune & dedupe BusIO: {:.1}ms\n",
        prune_start.elapsed().as_millis()
    ));

    if !ck_fallback_roots_added.is_empty() {
        log_val(format!(
            "[LibShim] Added CK library fallback root(s): {}\n",
            ck_fallback_roots_added.join(", ")
        ));
    }
    if !dropped_conflict_libs.is_empty() {
        log_val(format!(
            "[LibShim] Dropped conflicting embedded dependency library path(s): {}\n",
            dropped_conflict_libs.join(", ")
        ));
    }
    if !shadowed_platform_libraries.is_empty() {
        log_val(format!(
            "[LibShim] Core platform library precedence: skipped shadowing user library path(s): {}\n",
            shadowed_platform_libraries.join(", ")
        ));
    }
    if !promoted_busio_roots.is_empty() {
        log_val(format!(
            "[LibShim] Added preferred Adafruit_BusIO root(s): {}\n",
            promoted_busio_roots.join(", ")
        ));
    }
    if !busio_dedupe_notes.is_empty() {
        log_val(format!(
            "[LibShim] BusIO dedupe actions: {}\n",
            busio_dedupe_notes.join(" | ")
        ));
    }
    if !dropped_container_roots.is_empty() {
        log_val(format!(
            "[LibShim] Dropped container-only library root(s): {}\n",
            dropped_container_roots.join(", ")
        ));
    }
    let arch_prune_start = std::time::Instant::now();
    let mut arch_pruned_notes: Vec<String> = Vec::new();
    if board_arch.eq_ignore_ascii_case("avr") {
        let mut remapped: Vec<std::path::PathBuf> = Vec::with_capacity(final_libs.len());
        for path in final_libs {
            if let Some((shim, skipped)) = create_arch_pruned_shim(&path, &board_arch) {
                if skipped > 0 {
                    arch_pruned_notes.push(format!(
                        "{} -> {} (skipped {} source file(s))",
                        path.display(),
                        shim.display(),
                        skipped
                    ));
                }
                remapped.push(shim);
            } else {
                remapped.push(path);
            }
        }
        final_libs = ck_core::builder::signature::normalize_and_sort_paths(&remapped);
    }
    if !arch_pruned_notes.is_empty() {
        log_val(format!(
            "[LibShim] Arch-pruned library source(s): {}\n",
            arch_pruned_notes.join(" | ")
        ));
    }
    log_val(format!(
        "[Timing DIAG] arch_prune+flush: {:.1}ms\n",
        arch_prune_start.elapsed().as_millis()
    ));
    flush_lib_cache_to_disk_if_dirty();
    if qualification_mode {
        eprintln!("[CKQ-PHASE] libraries-resolved");
    }
    let lib_scan_elapsed = library_resolution_start.elapsed();
    let sig_start = std::time::Instant::now();
    println!(
        "[LibShim] Final Libs passed to builder (sorted): {:?}",
        final_libs
    );

    let cli_identity_start = std::time::Instant::now();
    let cli_version = fast_identity_cli_version(&sysroot);
    log_val(format!(
        "[Timing DIAG] identity cli: {:.1}ms\n",
        cli_identity_start.elapsed().as_millis()
    ));
    let toolchain_lease_start = std::time::Instant::now();
    let (toolchain_identity_lease, toolchain_identity_source) =
        derive_toolchain_identity_lease(&sysroot, &compilation_fqbn)?;
    log_val(format!(
        "[Timing DIAG] identity toolchain lease ({}): {:.1}ms\n",
        toolchain_identity_source,
        toolchain_lease_start.elapsed().as_millis()
    ));
    if qualification_mode {
        eprintln!("[CKQ-PHASE] toolchain-identity-ready");
    }
    let toolchain_key = toolchain_identity_lease.toolchain_key().to_owned();
    let sorted_lib_strings: Vec<String> =
        final_libs.iter().map(|p| normalize_path_key(p)).collect();
    let build_signature_start = std::time::Instant::now();
    let build_signature = ck_core::builder::demo::compute_fast_build_signature(
        &compilation_fqbn,
        &cli_version,
        &toolchain_key,
        &sorted_lib_strings,
    );
    log_val(format!(
        "[Timing DIAG] identity build signature: {:.1}ms\n",
        build_signature_start.elapsed().as_millis()
    ));
    let forge_decision_start = std::time::Instant::now();
    let forge_decision = forge_compatibility_for_build(
        &sysroot,
        &compilation_fqbn,
        Some(&cli_version),
        Some(&toolchain_key),
        Some(&sha256_text(&code)),
    );
    log_val(format!(
        "[Timing DIAG] identity Forge decision: {:.1}ms\n",
        forge_decision_start.elapsed().as_millis()
    ));
    if let Some(expected) = candidate_core_version.as_deref() {
        if forge_decision.core_version.as_deref() != Some(expected) {
            return Err("候选编译的实际 Core 版本已变化，请重新加载板卡后重试".into());
        }
    }
    // Keep the real CN mirror paths for the build.  The common toolchain lease
    // resolver canonicalizes its key only after the independent exact-receipt
    // and content proof. Reuse that opaque lease result for the read-only
    // certificate lookup instead of recursively hashing the same trees again.
    let certificate_context_start = std::time::Instant::now();
    let core_package_identity = forge_decision
        .core_version
        .as_deref()
        .and_then(|core_version| {
            forge_core_package_identity(&sysroot.root_dir, &compilation_fqbn, core_version)
        });
    let canonical_mirror_toolchain_key = verified_cn_mirror_key_from_lease(
        &compilation_fqbn,
        forge_decision.core_version.as_deref(),
        core_package_identity.as_ref(),
        Some(&toolchain_key),
    )
    .map(str::to_owned);
    let core_package_identity_ref =
        core_package_identity
            .as_ref()
            .map(|(checksum, size)| ck_forge::ForgeCorePackageIdentity {
                archive_sha256: checksum.as_str(),
                archive_size: *size,
            });
    let compile_intent = if let Some(probe) = qualification_probe {
        forge_qualification_probe_plan(probe).0
    } else if silent_mode && !qualification_mode {
        ck_core::builder::demo::CompileIntent::Background
    } else {
        ck_core::builder::demo::CompileIntent::CompileOnly
    };
    let exact_reuse_policy = forge_exact_reuse_policy(
        &forge_decision,
        qualification_mode,
        qualification_probe
            .map(|probe| probe.operation)
            .unwrap_or(ck_forge::ForgePerformanceOperation::Compile),
    );
    let native_relink_certificate_evidence = if !qualification_mode
        && compile_intent == ck_core::builder::demo::CompileIntent::CompileOnly
        && ck_forge::native_relink_adapter_registered_for_fqbn(&compilation_fqbn)
    {
        forge_decision
            .core_version
            .as_deref()
            .and_then(|core_version| {
                ck_forge::load_local_native_relink_evidence_sha256_with_core_package_identity(
                    &sysroot.root_dir,
                    &compilation_fqbn,
                    core_version,
                    &cli_version,
                    &toolchain_key,
                    core_package_identity_ref,
                    canonical_mirror_toolchain_key.as_deref(),
                )
            })
    } else {
        None
    };
    log_val(format!(
        "[Timing DIAG] identity certificate context: {:.1}ms\n",
        certificate_context_start.elapsed().as_millis()
    ));
    let native_relink_cn_mirror_certificate = native_relink_certificate_evidence.is_some()
        && forge_decision.core_version.as_deref() == Some("3.3.6-cn")
        && canonical_mirror_toolchain_key.is_some();
    let native_relink_qualification_probe = qualification_probe.is_none()
        && native_relink_qualification_probe_allowed(
            qualification_mode,
            native_relink_probe_authorized,
            compile_intent,
            &compilation_fqbn,
        );
    let selected_compile_profile = if let Some(probe) = qualification_probe {
        forge_qualification_probe_plan(probe).1
    } else {
        forge_compile_profile_for_intent(
            &forge_decision,
            &compilation_fqbn,
            compile_intent,
            native_relink_certificate_evidence.is_some() || native_relink_qualification_probe,
        )?
    };
    let native_relink_access = if native_relink_qualification_probe {
        ck_core::builder::demo::NativeRelinkAccess::qualification_probe(
            &sysroot.root_dir,
            &compilation_fqbn,
            &toolchain_identity_lease,
        )
        .map_err(|error| error.to_string())?
    } else if let Some(evidence_sha256) = native_relink_certificate_evidence.as_deref() {
        ck_core::builder::demo::NativeRelinkAccess::certified(
            &sysroot.root_dir,
            &compilation_fqbn,
            &toolchain_identity_lease,
            evidence_sha256,
        )
        .map_err(|error| error.to_string())?
    } else {
        // No NativeRelink authority: retain the independently qualified profile
        // (or conservative Release) selected above.
        ck_core::builder::demo::NativeRelinkAccess::disabled()
    };
    if qualification_mode {
        eprintln!("[CKQ-PHASE] native-relink-access-ready");
    }
    let selected_compile_profile_label = compile_profile_label(selected_compile_profile);
    let engine_policy_label = if std::env::var_os("CK_V9_CONFIG").is_some() {
        "兼容后端策略（随后检查 V9 原生路由）"
    } else { "Build Engine" };
    log_val(format!(
        "[INFO] {engine_policy_label}: ck-forge/v1 decision={} source={} profile={} core={} identity-source={} reasons={}\n",
        forge_decision_label(forge_decision.decision),
        forge_source_label(forge_decision.source),
        selected_compile_profile_label,
        forge_decision.core_version.as_deref().unwrap_or("unknown"),
        toolchain_identity_source,
        forge_reason_labels(&forge_decision)
    ));
    if native_relink_certificate_evidence.is_some() {
        log_val(
            "[INFO] CK Forge NativeRelinkCompileOnly certificate matched this host/Core/toolchain/FQBN; this target may use the authenticated Release baseline.\n"
                .to_string(),
        );
        if native_relink_cn_mirror_certificate {
            log_val(
                "[INFO] Verified ESP32 3.3.6-cn mirror identity; reused the authenticated 3.3.6 NativeRelink evidence while compiling from the actual CN paths.\n"
                    .to_string(),
            );
        }
    } else if native_relink_qualification_probe {
        log_val(
            "[INFO] CK Forge NativeRelinkCompileOnly qualification probe enabled for this target Release request.\n"
                .to_string(),
        );
    } else if let Some(probe) = qualification_probe {
        log_val(format!(
            "[INFO] CK Forge controlled qualification probe: operation={} profile={}; this measurement does not grant the product a Fast route.\n",
            probe.operation_label(),
            probe.profile_label(),
        ));
    }
    if forge_decision.decision == ck_forge::ForgeRouteDecision::ForcePlatform
        && native_relink_certificate_evidence.is_none()
        && !qualification_mode
        && std::env::var_os("CK_V9_CONFIG").is_none()
    {
        log_val(
            "[INFO] CK Forge native route: this exact host/Core/toolchain/FQBN has no passing A/B performance certificate; using unmodified Arduino CLI Release.\n"
                .to_string(),
        );
    }
    let identity_resolution_elapsed = sig_start.elapsed();
    log_val(format!(
        "[Timing DIAG] cli_version+toolchain+signature: {:.1}ms\n",
        identity_resolution_elapsed.as_millis()
    ));

    println!(
        "[Timing] Library scan + shim: {:.1}s",
        lib_scan_elapsed.as_secs_f32()
    );
    log_val(format!(
        "[Timing] Library resolution: {:.1}s\n",
        lib_scan_elapsed.as_secs_f32()
    ));

    let code_hash_hint = compile_accel::stable_code_hash(&code);
    // 修复 hint mismatch：warmup 启动时 signature 为 None，现在 library scan 完成后
    // signature 已算出，主动补全到 active warmup，让后续 prioritize 比对能命中。
    if selected_compile_profile == ck_core::builder::demo::CompileProfile::QuickFast {
        compile_accel::update_active_warmup_hints(
            &compilation_fqbn,
            &code_hash_hint,
            &build_signature,
        )
        .await;
    }
    // Silent precompiles must not mark themselves as manual work. Doing so makes
    // with_compile_lock_for_silent observe its own pending flag and skip every run.
    // A foreground click must also not wait for a matching edit warmup: that
    // warmup can still be doing a full platform compile while the authenticated
    // foreground route only needs a short NativeRelink pass. Cancel it before
    // entering the per-target lock instead of spending a fixed 900 ms hoping it
    // finishes first.
    let warmup_priority_start = std::time::Instant::now();
    if !silent_mode && candidate_core_version.is_none() {
        let _ = compile_accel::prioritize_manual_compile_with_hints(
            &compilation_fqbn,
            Some(code_hash_hint),
            Some(build_signature.clone()),
        )
        .await;
    }
    log_val(format!(
        "[Timing DIAG] foreground warmup priority: {:.0}ms\n",
        warmup_priority_start.elapsed().as_millis()
    ));
    let precompile_elapsed = total_start.elapsed();
    log_val(format!(
        "[Timing DIAG] pre-compile total (from total_start): {:.0}ms\n",
        precompile_elapsed.as_millis()
    ));

    /*
    let log_val_timing = log_val.clone();
    let preflight_installs =
        auto_install_known_header_libraries(&sysroot.root_dir, &include_not_in_ck_user);
    if !preflight_installs.is_empty() {
        log_val_timing("[AutoFix] Preflight Arduino library dependency check:\n".to_string());
        for (reason, lib_name, result) in preflight_installs {
            match result {
                Ok(_) => log_val_timing(format!(
                    "[AutoFix] Installed/verified {} ({})\n",
                    lib_name, reason
                )),
                Err(err) => log_val_timing(format!(
                    "[AutoFix] Install skipped/failed {} ({}) -> {}\n",
                    lib_name, reason, err
                )),
            }
        }
    }
    */
    let log_val_timing = log_val.clone();

    let compile_phase_start = std::time::Instant::now();
    log_val(format!(
        "[Timing DIAG] compile_phase_start (from total_start): {:.0}ms\n",
        total_start.elapsed().as_millis()
    ));
    let mut cli_compile_elapsed = std::time::Duration::default();
    let mut compile_attempt: u32 = 1;
    let max_compile_attempts: u32 = if candidate_core_version.is_some() { 1 } else { 3 };
    let mut resource_board_identity;

    let (path, log) = loop {
        let app_for_progress_attempt = app.clone();
        let silent_progress_attempt = silent_mode;
        let candidate_progress_run = candidate_core_version.as_ref().and(run_id.clone());
        let progress_attempt = move |p: f32, msg: String| {
            if let Some(run) = candidate_progress_run.as_ref() {
                let _ = app_for_progress_attempt.emit("ai-candidate-progress", serde_json::json!({
                    "runId": run, "message": msg, "percentage": p
                }));
                return;
            }
            if silent_progress_attempt {
                return;
            }
            let _ = app_for_progress_attempt.emit(
                "build-progress",
                BuildProgress {
                    percentage: p,
                    message: msg,
                },
            );
        };

        let app_for_log_attempt = app.clone();
        let silent_logs_attempt = silent_mode || candidate_core_version.is_some();
        let diagnostic_trace_for_attempt = Arc::clone(&diagnostic_trace);
        let trusted_sketch_alias_for_attempt = trusted_sketch_alias.clone();
        let log_val_attempt = move |line: String| {
            if let Ok(mut trace) = diagnostic_trace_for_attempt.lock() {
                trace.push_str(&line);
            }
            if silent_logs_attempt {
                return;
            }
            emit_trusted_sketch_alias_for_line(
                &app_for_log_attempt,
                &trusted_sketch_alias_for_attempt,
                &line,
            );
            let _ = app_for_log_attempt.emit("build-log", line);
        };

        // For silent (background) precompile: use the non-blocking variant that yields immediately
        // if a real user compile is pending, preventing the 7.7s "compile lock wait" overhead.
        let toolchain_identity_lease_attempt = toolchain_identity_lease.clone();
        let native_relink_access_attempt = native_relink_access.clone();
        let (lock_result, observed_resource_identity) = ck_core::builder::resource_observation::capture(async {
        Ok::<_, String>(if silent_mode && !qualification_mode {
            compile_accel::with_compile_lock_for_silent(&compilation_fqbn, || async {
                let cli_start = std::time::Instant::now();
                let result = ck_core::builder::demo::compile_sketch_string_with_identity_lease_intent_and_native_relink_access(
                    &sysroot,
                    &code,
                    &compilation_fqbn,
                    &final_libs,
                    max_jobs,
                    &build_signature,
                    workspace_fingerprint.as_deref(),
                    selected_compile_profile,
                    exact_reuse_policy,
                    compile_intent,
                    toolchain_identity_lease_attempt,
                    native_relink_access_attempt,
                    qualification_fresh_build,
                    progress_attempt,
                    log_val_attempt,
                )
                .await;
                (result, cli_start.elapsed())
            })
            .await
        } else if let Some(cancellation_for_lock) = foreground_cancellation.clone() {
            let cancellation_for_compile = cancellation_for_lock.clone();
            let locked = compile_accel::with_compile_lock_for_cancellable(
                &compilation_fqbn,
                &cancellation_for_lock,
                || async {
                    let cli_start = std::time::Instant::now();
                    let result = ck_core::builder::demo::compile_sketch_string_cancellable_with_identity_lease_intent_and_native_relink_access(
                        &sysroot,
                        &code,
                        &compilation_fqbn,
                        &final_libs,
                        max_jobs,
                        &build_signature,
                        workspace_fingerprint.as_deref(),
                        selected_compile_profile,
                        exact_reuse_policy,
                        compile_intent,
                        toolchain_identity_lease_attempt,
                        native_relink_access_attempt,
                        qualification_fresh_build,
                        cancellation_for_compile,
                        progress_attempt,
                        log_val_attempt,
                    )
                    .await;
                    (result, cli_start.elapsed())
                },
            )
            .await;
            Some(locked?)
        } else {
            Some(
                compile_accel::with_compile_lock_for(&compilation_fqbn, || async {
                    if qualification_mode {
                        eprintln!("[CKQ-PHASE] compile-lock-acquired");
                    }
                    let cli_start = std::time::Instant::now();
                    let result = ck_core::builder::demo::compile_sketch_string_with_identity_lease_intent_and_native_relink_access(
                        &sysroot,
                        &code,
                        &compilation_fqbn,
                        &final_libs,
                        max_jobs,
                        &build_signature,
                        workspace_fingerprint.as_deref(),
                        selected_compile_profile,
                        exact_reuse_policy,
                        compile_intent,
                        toolchain_identity_lease_attempt,
                        native_relink_access_attempt,
                        qualification_fresh_build,
                        progress_attempt,
                        log_val_attempt,
                    )
                    .await;
                    (result, cli_start.elapsed())
                })
                .await,
            )
        })
        }).await;
        let lock_result = lock_result?;
        resource_board_identity = observed_resource_identity;

        // If the silent compile was skipped (lock contention), return a neutral success result.
        let (compile_result, attempt_cli_elapsed) = match lock_result {
            Some(inner) => inner,
            None => {
                log::info!("[SilentCompile] Skipped due to lock contention; returning neutral OK");
                return Ok(serde_json::json!({
                    "path": "",
                    "log": "[SilentCompile] Skipped: manual compile in progress.\n",
                    "artifacts": Vec::<String>::new(),
                    "customLibraries": Vec::<String>::new(),
                    "arduinoLibraries": Vec::<String>::new(),
                    "cliUsageLines": Vec::<String>::new()
                })
                .to_string());
            }
        };
        cli_compile_elapsed += attempt_cli_elapsed;

        match compile_result {
            Ok(ok) => break ok,
            Err(err) => {
                let err_text = err.to_string();
                // The compiler stream intentionally truncates very long lines
                // for UI/IPC performance. Re-observe the bounded full failure
                // before returning so a long dynamic sketch path can still be
                // authenticated. The emitted alias remains path-free.
                if !silent_mode && candidate_core_version.is_none() {
                    emit_trusted_sketch_alias_for_line(&app, &trusted_sketch_alias, &err_text);
                }
                if is_non_retriable_linker_conflict(&err_text) {
                    log_val_timing(
                        "[AutoFix] Non-retriable linker conflict (duplicate symbols) detected; skip dependency install retries.\n"
                            .to_string(),
                    );
                    return Err(err_text);
                }
                if compile_attempt >= max_compile_attempts {
                    return Err(err_text);
                }

                let mut install_pairs: Vec<(String, String)> = Vec::new();
                let missing_headers_from_error = extract_missing_headers_from_build_log(&err_text);
                for header in &missing_headers_from_error {
                    for lib_name in candidate_arduino_libraries_for_header(header) {
                        install_pairs.push((format!("header:{}", header), lib_name));
                    }
                }
                for lib_name in known_arduino_libraries_for_linker_log(&err_text) {
                    install_pairs.push((
                        "linker:undefined-reference".to_string(),
                        lib_name.to_string(),
                    ));
                }

                if install_pairs.is_empty() {
                    return Err(err_text);
                }

                log_val_timing(format!(
                    "[AutoFix] Compile attempt {} failed. Installing inferred dependencies before retry...\n",
                    compile_attempt
                ));
                let install_results = install_known_libraries_with_reasons(
                    app.state::<InstallState>().inner(),
                    &sysroot.root_dir,
                    &install_pairs,
                );
                if install_results.is_empty() {
                    return Err(err_text);
                }

                let mut has_success = false;
                for (reason, lib_name, result) in install_results {
                    match result {
                        Ok(_) => {
                            has_success = true;
                            log_val_timing(format!(
                                "[AutoFix] Installed/verified {} ({})\n",
                                lib_name, reason
                            ));
                        }
                        Err(install_err) => {
                            log_val_timing(format!(
                                "[AutoFix] Install failed {} ({}) -> {}\n",
                                lib_name, reason, install_err
                            ));
                        }
                    }
                }

                if !has_success {
                    return Err(err_text);
                }

                compile_attempt += 1;
            }
        }
    };

    let lock_plus_cli_elapsed = compile_phase_start.elapsed();
    let compile_lock_wait = lock_plus_cli_elapsed
        .checked_sub(cli_compile_elapsed)
        .unwrap_or_default();
    // Always report the lock value, including a real zero.  Omitting the line
    // made a healthy no-wait build indistinguishable from missing telemetry.
    log_val_timing(format!(
        "[Timing] Compile lock wait: {:.1}s\n",
        compile_lock_wait.as_secs_f32()
    ));
    log_val_timing(format!(
        "[Timing] CLI compile phase: {:.1}s\n",
        cli_compile_elapsed.as_secs_f32()
    ));
    let post_compile_details_start = std::time::Instant::now();

    match maintain_upload_manifest_after_compile(&path, &compilation_fqbn, &build_signature, &log) {
        Ok(Some(action)) => log_val_timing(format!("[INFO] Upload artifact manifest: {action}.\n")),
        Ok(None) => {}
        Err(reason) => log_val_timing(format!(
            "[INFO] Upload artifact manifest deferred: {reason}.\n"
        )),
    }

    if silent_mode {
        let total_elapsed = total_start.elapsed();
        let diagnostic_trace_text = diagnostic_trace
            .lock()
            .map(|trace| trace.rendered())
            .unwrap_or_default();
        let mut diagnostics = compile_diagnostics_value_with_engine(
            &diagnostic_trace_text,
            &log,
            &compilation_fqbn,
            &cli_version,
            &toolchain_key,
            toolchain_identity_source,
            &build_signature,
            workspace_fingerprint.as_deref(),
            &required_headers_sorted,
            lib_scan_elapsed.as_millis(),
            identity_resolution_elapsed.as_millis(),
            precompile_elapsed.as_millis(),
            compile_lock_wait.as_millis(),
            cli_compile_elapsed.as_millis(),
            total_elapsed.as_millis(),
            selected_compile_profile_label,
            &forge_decision,
        );
        attach_forge_qualification_probe_diagnostics(&mut diagnostics, qualification_probe, None);
        // Silent warmups and qualification builds are implementation work, not
        // evidence of a board the user chose. Recording them would let startup
        // prewarm or automated certification reinforce itself in the hotset.
        // Qualification compares CK against a native lane immediately after
        // this response. Never enqueue storage maintenance here: even a
        // correctly throttled background sweep would contaminate the native
        // side of the A/B pair with unrelated disk I/O.
        if !qualification_mode {
            compile_accel::maintain_cache_budget_after_success(
                settings.cache_limit_mb,
                false,
                &path,
                _build_cache_read_guard,
            );
        }
        // Silent precompile is itself a cache warm path; do not enqueue another warmup job here.

        let mut result = serde_json::json!({
            "path": path.to_string_lossy(),
            "log": log,
            "artifacts": Vec::<String>::new(),
            "customLibraries": Vec::<String>::new(),
            "arduinoLibraries": Vec::<String>::new(),
            "cliUsageLines": Vec::<String>::new(),
            "diagnostics": diagnostics
        });
        // The formal local A/B runner needs the bounded trace to diagnose a
        // failed Fast Relink attempt. Keep it behind the authenticated
        // qualification request; the runner stores it as local-only failure
        // evidence and never projects it into the qualification report.
        attach_qualification_diagnostic_trace(
            &mut result,
            qualification_mode,
            external_qualification_authorization_present,
            diagnostic_trace_text,
        );
        return Ok(result.to_string());
    }

    let arduino_matched_library_keys: HashSet<String> = arduino_matched_library_paths
        .iter()
        .map(|path| normalize_path_key(std::path::Path::new(path)))
        .collect();
    let ck_reported_libraries: Vec<&std::path::PathBuf> = final_libs
        .iter()
        .filter(|path| !arduino_matched_library_keys.contains(&normalize_path_key(path)))
        .collect();

    // Emit compile summary in one chunk to reduce IPC overhead on fast builds.
    let mut post_compile_summary = String::new();
    post_compile_summary.push_str(&format!("[INFO] Build Directory: {}\n", path.display()));

    let cli_usage_lines = extract_cli_usage_lines(&log);
    if !cli_usage_lines.is_empty() {
        post_compile_summary.push_str(&format!(
            "[INFO] Arduino CLI dependency summary ({} line(s)):\n",
            cli_usage_lines.len()
        ));
        for line in &cli_usage_lines {
            post_compile_summary.push_str(line);
            post_compile_summary.push('\n');
        }
    } else {
        post_compile_summary.push_str(
            "[INFO] Arduino CLI did not emit dependency summary lines in current output mode.\n",
        );
        if required_headers_sorted.is_empty() {
            post_compile_summary.push_str("[INFO] Sketch include headers: (none)\n");
        } else {
            post_compile_summary.push_str(&format!(
                "[INFO] Sketch include headers ({}):\n",
                required_headers_sorted.len()
            ));
            for header in &required_headers_sorted {
                post_compile_summary.push_str(&format!("[INFO] Include Header: {}\n", header));
            }
        }
        if !include_resolved_to_ck.is_empty() {
            post_compile_summary.push_str(&format!(
                "[INFO] Include headers resolved to CK libraries ({}):\n",
                include_resolved_to_ck.len()
            ));
            for line in &include_resolved_to_ck {
                post_compile_summary.push_str(&format!("[INFO] Include Match: {}\n", line));
            }
        }
        if !include_resolved_to_arduino.is_empty() {
            post_compile_summary.push_str(&format!(
                "[INFO] Include headers resolved to Arduino installed libraries ({}):\n",
                include_resolved_to_arduino.len()
            ));
            for line in &include_resolved_to_arduino {
                post_compile_summary.push_str(&format!("[INFO] Arduino Include Match: {}\n", line));
            }
        }
        if !include_not_in_ck_or_arduino.is_empty() {
            post_compile_summary.push_str(&format!(
                "[INFO] Include headers not matched in CK/Arduino user libraries (likely core/platform built-in) ({}):\n",
                include_not_in_ck_or_arduino.len()
            ));
            for header in &include_not_in_ck_or_arduino {
                post_compile_summary.push_str(&format!("[INFO] Include Unmatched: {}\n", header));
            }
        }
    }

    if !ck_reported_libraries.is_empty() {
        post_compile_summary.push_str(&format!(
            "[INFO] CK resolved custom libraries: {} path(s)\n",
            ck_reported_libraries.len()
        ));
        for lib_path in &ck_reported_libraries {
            post_compile_summary
                .push_str(&format!("[INFO] CK Library Path: {}\n", lib_path.display()));
        }
    } else {
        post_compile_summary.push_str("[INFO] CK resolved custom libraries: (none)\n");
    }

    if !arduino_matched_library_paths.is_empty() {
        post_compile_summary.push_str(&format!(
            "[INFO] Arduino installed library paths used ({}):\n",
            arduino_matched_library_paths.len()
        ));
        for lib_path in &arduino_matched_library_paths {
            post_compile_summary.push_str(&format!("[INFO] Arduino Library Path: {}\n", lib_path));
        }
    } else {
        post_compile_summary.push_str("[INFO] Arduino installed library paths used: (none)\n");
    }

    let artifact_paths = collect_firmware_artifacts(&path);
    if artifact_paths.is_empty() {
        post_compile_summary.push_str(&format!(
            "[WARN] No firmware artifact (*.hex/*.bin/*.uf2/*.elf) found in {}\n",
            path.display()
        ));
    } else {
        post_compile_summary.push_str(&format!(
            "[INFO] Firmware Artifacts ({}):\n",
            artifact_paths.len()
        ));
        for artifact in &artifact_paths {
            post_compile_summary.push_str(&format!("[INFO] Artifact: {}\n", artifact.display()));
        }
    }
    if !post_compile_summary.is_empty() {
        log_val_timing(post_compile_summary);
    }
    let post_compile_details_elapsed = post_compile_details_start.elapsed();
    log_val_timing(format!(
        "[Timing] Post-compile reporting: {:.1}s\n",
        post_compile_details_elapsed.as_secs_f32()
    ));

    let total_elapsed = total_start.elapsed();
    // A successful foreground compile has already populated the exact, core,
    // dependency and ccache layers it used. Starting another same-board warmup
    // here only creates lock contention when the user compiles again quickly.
    // Edit/startup warmups remain available and are canceled when foreground
    // work arrives.
    log_val_timing(
        "[INFO] Foreground compile finished; preserved cache state for the next build.\n"
            .to_string(),
    );

    let artifact_strings: Vec<String> = artifact_paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let custom_library_strings: Vec<String> = final_libs
        .iter()
        .filter(|path| !arduino_matched_library_keys.contains(&normalize_path_key(path)))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let arduino_library_strings: Vec<String> = arduino_matched_library_paths.into_iter().collect();
    let diagnostic_trace_text = diagnostic_trace
        .lock()
        .map(|trace| trace.rendered())
        .unwrap_or_default();
    let mut diagnostics = compile_diagnostics_value_with_engine(
        &diagnostic_trace_text,
        &log,
        &compilation_fqbn,
        &cli_version,
        &toolchain_key,
        toolchain_identity_source,
        &build_signature,
        workspace_fingerprint.as_deref(),
        &required_headers_sorted,
        lib_scan_elapsed.as_millis(),
        identity_resolution_elapsed.as_millis(),
        precompile_elapsed.as_millis(),
        compile_lock_wait.as_millis(),
        cli_compile_elapsed.as_millis(),
        total_elapsed.as_millis(),
        selected_compile_profile_label,
        &forge_decision,
    );
    attach_forge_qualification_probe_diagnostics(&mut diagnostics, qualification_probe, None);

    let source_map_path = write_compile_source_map(&path, source_map_payload.as_deref())?;
    // GNU linker-map evidence is read only from the build directory returned
    // by CK's compiler. The frontend never supplies a map path, so this cannot
    // become an arbitrary local-file reader.
    let linker_map_started = std::time::Instant::now();
    let (linker_map_summary, linker_map_warning) = if compilation_fqbn
        .to_ascii_lowercase()
        .starts_with("esp32:esp32:")
    {
        match resource_map::summarize_build_linker_map(
            &path,
            &compilation_fqbn,
            &chrono::Utc::now().to_rfc3339(),
        ) {
            Ok(summary) => (Some(summary), None),
            Err(error) => {
                log_val_timing(format!(
                    "[WARN] Linker map resource attribution unavailable: {}\n",
                    error
                ));
                (None, Some(error))
            }
        }
    } else {
        (
            None,
            Some("current platform has no supported linker-map classifier".to_string()),
        )
    };
    log_val_timing(format!(
        "[Timing DIAG] Linker map summary: {}ms\n",
        linker_map_started.elapsed().as_millis()
    ));

    // Optional observation ticket: no change to request, resolver, output or identity.
    // The WebView may consume it after success; failure never changes build status.
    if let (Some(run), Some(identity)) = (run_id.as_deref(), resource_board_identity.as_ref()) {
        if let Ok(identity) = serde_json::to_value(identity) {
            compiler_resource_capture::register(run, &path, &sysroot.root_dir, &code, &identity);
        }
    }
    // Include synchronous post-build consumers in the product latency metric.
    // The previous value stopped before linker-map parsing, hiding UI wait time.
    let total_elapsed = total_start.elapsed();
    diagnostics["timing"]["totalMs"] = serde_json::json!(total_elapsed.as_millis());
    println!("[Timing] Total compile_sketch: {:.1}s", total_elapsed.as_secs_f32());
    let cache_hit = log.contains("Cached build (Exact Match)");
    let metric = ck_core::builder::accel::CompileMetricRecord {
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        fqbn: compilation_fqbn.clone(),
        library_resolution_ms: lib_scan_elapsed.as_millis(),
        cli_compile_ms: cli_compile_elapsed.as_millis(),
        total_ms: total_elapsed.as_millis(),
        cache_hit,
        build_signature: build_signature.clone(),
    };
    compile_accel::push_metric(&sysroot.root_dir, &metric);
    compile_accel::record_board_activity(
        &sysroot.root_dir,
        &compilation_fqbn,
        Some(cli_compile_elapsed.as_millis()),
        Some(cache_hit),
        "compile",
    );
    if !silent_mode && candidate_core_version.is_none() {
        record_board_success(&app, board_package_id.as_deref(), &compilation_fqbn,
            forge_decision.core_version.as_deref(), board_activity::Operation::Compile);
    }
    // Return JSON with both path and log
    let result = serde_json::json!({
        "path": path.to_string_lossy(),
        "log": log,
        "artifacts": artifact_strings,
        "customLibraries": custom_library_strings,
        "arduinoLibraries": arduino_library_strings,
        "cliUsageLines": cli_usage_lines,
        "diagnostics": diagnostics,
        "sourceMapPath": source_map_path.map(|value| value.to_string_lossy().to_string()),
        "linkerMapSummary": linker_map_summary,
        "linkerMapWarning": linker_map_warning,
        "resourceBoardIdentity": resource_board_identity
    });

    // Storage maintenance starts only after every synchronous consumer has
    // finished reading the returned build directory. The delayed worker also
    // gives response serialization/IPC time to complete.
    compile_accel::maintain_cache_budget_after_success(
        settings.cache_limit_mb,
        false,
        &path,
        _build_cache_read_guard,
    );
    if let Some(capture) = feedback_capture.as_mut() { capture.success(); }
    Ok(result.to_string())
}

// Local activity is UI history only. Reading or recording it never authorizes a build.
#[tauri::command]
fn get_board_success_history(app: AppHandle) -> Result<Vec<board_activity::Success>, String> {
    let root = crate::app_storage::desktop_dir(&app).map_err(|e| e.to_string())?;
    Ok(board_activity::read(&root))
}

fn record_board_success(
    app: &AppHandle, package: Option<&str>, fqbn: &str, core: Option<&str>,
    operation: board_activity::Operation,
) {
    let Some(observation) = board_activity::Success::observed(package, fqbn, core, operation) else { return; };
    let result = crate::app_storage::desktop_dir(&app).map_err(|e| e.to_string())
        .and_then(|root| board_activity::record(&root, observation));
    match result {
        Ok(()) => { let _ = app.emit("board-success-history-changed", ()); },
        Err(error) => log::warn!("Board activity history could not be saved: {error}"),
    }
}

#[tauri::command]
async fn observe_compiled_resources(run_id: String) -> Result<serde_json::Value, String> {
    let ticket = compiler_resource_capture::take(&run_id)?;
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    let _cache_guard = compile_accel::protect_build_cache_use().await;
    tauri::async_runtime::spawn_blocking(move || compiler_resource_capture::capture(ticket))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upload_sketch(
    app: AppHandle,
    code: String,
    fqbn: String,
    board_package_id: Option<String>,
    run_id: String,
    port: String,
    workspace_fingerprint: Option<String>,
    project_id: Option<String>,
    project_path: Option<String>,
    source_map_json: Option<String>,
    probe_memory: Option<bool>,
    last_working_version: Option<last_working_version::LastWorkingVersionCapture>,
    structured_result: Option<bool>,
    expected_member_identity: Option<String>,
) -> Result<String, String> {
    if project_id.as_ref().is_some_and(|value| value.is_empty() || value.len() > 4096) {
        return Err("Invalid build project identity".into());
    }
    let files=project_files::snapshot(project_path.as_deref())?.map(Arc::new);
    if let Some(expected) = expected_member_identity {
        if expected != project_files::source_identity(files.as_deref()) {
            return Err("候选验证后的工程源码文件已变化，请重新验证；未上传。".into());
        }
    }
    // Locked rebuild currently captures only the main source.
    let last_working_version=last_working_version.filter(|_|files.as_ref().is_none_or(|s|s.is_empty()));
    ck_core::builder::demo::PROJECT_SOURCES.scope(files,ck_core::builder::demo::with_native_graph_project(project_id, Box::pin(upload_sketch_impl(
        app, code, fqbn, board_package_id, run_id, port, workspace_fingerprint,
        source_map_json, probe_memory, last_working_version, false, structured_result.unwrap_or(false),
    )))).await
}

/// Local diagnostic of the actual product upload-preparation path. It neither
/// selects a candidate profile nor grants NativeRelink upload authority. The
/// startup-token gate is shared with the existing local benchmark harness.
/// Returning before transport makes repeatable compile -> upload tests possible
/// without guessing a COM port or touching a connected user's board.
#[tauri::command]
async fn observe_upload_preparation(
    app: AppHandle,
    code: String,
    fqbn: String,
    board_package_id: Option<String>,
    run_id: String,
    workspace_fingerprint: Option<String>,
    project_path: Option<String>,
    project_id: Option<String>,
    qualification_token: String,
) -> Result<String, String> {
    validate_external_native_relink_qualification(true, Some(&qualification_token))?;
    let files=project_files::snapshot(project_path.as_deref())?.map(Arc::new);
    ck_core::builder::demo::PROJECT_SOURCES.scope(files,ck_core::builder::demo::with_native_graph_project(project_id, Box::pin(upload_sketch_impl(
        app, code, fqbn, board_package_id, run_id, String::new(),
        workspace_fingerprint, None, Some(false), None, true, false,
    )))).await
}

async fn upload_sketch_impl(
    app: AppHandle,
    code: String,
    fqbn: String,
    board_package_id: Option<String>,
    run_id: String,
    port: String,
    workspace_fingerprint: Option<String>,
    source_map_json: Option<String>,
    probe_memory: Option<bool>,
    last_working_version: Option<last_working_version::LastWorkingVersionCapture>,
    observe_preparation_only: bool,
    structured_result: bool,
) -> Result<String, String> {
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    let _build_cache_read_guard = compile_accel::protect_build_cache_use().await;
    let run_id = normalize_foreground_build_run_id(&run_id)?;
    let (_foreground_build_guard, foreground_cancellation) =
        app.state::<ForegroundBuildState>().register(&run_id)?;
    let source_map_payload =
        validate_compile_source_map_payload(&code, source_map_json.as_deref())?;
    let trusted_sketch_alias = Some(Arc::new(Mutex::new(TrustedSketchAliasCollector::new(
        run_id.clone(),
        &code,
    ))));
    let upload_request_started = std::time::Instant::now();
    let _serial_operation_guard = device_health::try_acquire_serial_operation().map_err(|_| {
        "上传未开始：串口监视器、真机体检或另一项上传正在使用串口，请稍后重试".to_string()
    })?;
    let sysroot = get_app_sysroot().await?;
    let board_library_scope =
        board_library_scope_for_build(&app, &fqbn, board_package_id.as_deref())?;

    let feedback_trace = Arc::new(Mutex::new(CompileDiagnosticTrace::new()));
    let mut feedback_capture = (!observe_preparation_only).then(||
        compile_feedback::Capture::new(&app, &run_id, &fqbn, feedback_trace.clone()));
    let app_for_log = app.clone();
    let trusted_sketch_alias_for_log = trusted_sketch_alias.clone();
    let log_val = move |line: String| {
        if let Ok(mut trace) = feedback_trace.lock() { trace.push_str(&line); }
        emit_trusted_sketch_alias_for_line(&app_for_log, &trusted_sketch_alias_for_log, &line);
        let _ = app_for_log.emit("build-log", line);
    };

    // Resolve Custom FQBN (New Logic)
    let compilation_fqbn = resolve_board_fqbn(&app, &fqbn).await?;
    // A user-triggered upload must have the same scheduling priority as a
    // foreground compile.  Publish this intent before library/toolchain
    // identity work so an optional warmup cannot consume the CPU or cache
    // gates while the upload route is preparing its authoritative build.
    let _foreground_upload_priority_guard =
        compile_accel::begin_foreground_compile_priority(&compilation_fqbn);
    let _ = compile_accel::prioritize_manual_compile(&compilation_fqbn).await;
    if let Err(e) = remember_active_board_for_prewarm(&sysroot, &compilation_fqbn) {
        log::warn!(
            "[AUTO PREWARM] Failed to remember active upload board {}: {}",
            compilation_fqbn,
            e
        );
    }
    let settings = compile_accel::load_settings(&sysroot.root_dir);
    let max_jobs = settings.effective_jobs();
    log_val(format!("[INFO] Compile parallel jobs: {}\n", max_jobs));

    // --- Smart Library Filtering ---
    // 1. Parse code for includes
    let required_headers = project_required_headers(&code);
    let mut required_headers_sorted: Vec<String> = required_headers.into_iter().collect();
    required_headers_sorted.sort();

    let safe_board = fqbn
        .split(':')
        .take_while(|part| !part.contains('='))
        .collect::<Vec<&str>>()
        .join(":")
        .replace(":", "_");

    let board_arch = get_board_architecture(&app, &fqbn).await;
    let candidates = collect_library_candidates_cached(
        &app,
        &fqbn,
        &safe_board,
        &board_arch,
        &board_library_scope,
    );
    let resolution =
        resolve_ck_library_candidates(&required_headers_sorted, candidates.as_ref(), &board_arch);
    let mut final_libs = resolution.final_libs;
    let include_not_in_ck = resolution.include_not_in_ck;
    let include_not_in_ck_user = filter_user_unresolved_headers(&include_not_in_ck);
    let ck_fallback_roots =
        collect_ck_library_fallback_matches(&include_not_in_ck_user, &fqbn, &board_arch);
    let headers_after_ck_fallback =
        headers_not_provided_by_library_paths(&include_not_in_ck_user, &ck_fallback_roots);
    let mut ck_fallback_roots_added: Vec<String> = Vec::new();
    for fallback_root in ck_fallback_roots {
        if !final_libs
            .iter()
            .any(|path| normalize_path_key(path) == normalize_path_key(&fallback_root))
        {
            ck_fallback_roots_added.push(fallback_root.to_string_lossy().to_string());
            final_libs.push(fallback_root);
        }
    }
    // Keep upload compilation on the identical precise-library scope used by
    // foreground compile, so a previously compiled signature cannot silently
    // change providers while preparing upload artifacts. Platform-owned
    // libraries (such as ESP32 WiFi) remain authoritative over a same-named
    // generic library in the native Arduino sketchbook; no user files are
    // changed.
    let arduino_resolution =
        resolve_arduino_user_libraries(&sysroot.root_dir, &headers_after_ck_fallback, &board_arch);
    let platform_library_roots =
        installed_platform_library_roots_for_precedence(&sysroot.root_dir, &compilation_fqbn);
    let (kept_arduino_libraries, shadowed_platform_libraries) =
        prune_user_libraries_shadowed_by_platform(
            arduino_resolution.final_libs,
            &platform_library_roots,
            &required_headers_sorted,
        );
    for user_library in kept_arduino_libraries {
        if !final_libs
            .iter()
            .any(|path| normalize_path_key(path) == normalize_path_key(&user_library))
        {
            final_libs.push(user_library);
        }
    }
    let mut promoted_busio_roots: Vec<String> = Vec::new();
    if final_libs.iter().any(|p| busio_source_count(p) > 0) {
        for busio_root in collect_installed_adafruit_busio_roots(&sysroot.root_dir) {
            if !final_libs
                .iter()
                .any(|p| normalize_path_key(p) == normalize_path_key(&busio_root))
            {
                promoted_busio_roots.push(busio_root.to_string_lossy().to_string());
                final_libs.push(busio_root);
            }
        }
    }
    let (pruned_libs, dropped_conflict_libs) = prune_conflicting_embedded_libraries(final_libs);
    let (busio_deduped_libs, busio_dedupe_notes) =
        dedupe_busio_symbol_providers(pruned_libs, &required_headers_sorted);
    final_libs = ck_core::builder::signature::normalize_and_sort_paths(&busio_deduped_libs);
    let mut dropped_container_roots: Vec<String> = Vec::new();
    final_libs.retain(|p| {
        if looks_like_library_container_dir(p) {
            dropped_container_roots.push(p.to_string_lossy().to_string());
            false
        } else {
            true
        }
    });
    if !ck_fallback_roots_added.is_empty() {
        log_val(format!(
            "[LibShim] Added CK library fallback root(s): {}\n",
            ck_fallback_roots_added.join(", ")
        ));
    }
    if !dropped_conflict_libs.is_empty() {
        log_val(format!(
            "[LibShim] Dropped conflicting embedded dependency library path(s): {}\n",
            dropped_conflict_libs.join(", ")
        ));
    }
    if !shadowed_platform_libraries.is_empty() {
        log_val(format!(
            "[LibShim] Core platform library precedence: skipped shadowing user library path(s): {}\n",
            shadowed_platform_libraries.join(", ")
        ));
    }
    if !promoted_busio_roots.is_empty() {
        log_val(format!(
            "[LibShim] Added preferred Adafruit_BusIO root(s): {}\n",
            promoted_busio_roots.join(", ")
        ));
    }
    if !busio_dedupe_notes.is_empty() {
        log_val(format!(
            "[LibShim] BusIO dedupe actions: {}\n",
            busio_dedupe_notes.join(" | ")
        ));
    }
    if !dropped_container_roots.is_empty() {
        log_val(format!(
            "[LibShim] Dropped container-only library root(s): {}\n",
            dropped_container_roots.join(", ")
        ));
    }
    let mut arch_pruned_notes: Vec<String> = Vec::new();
    if board_arch.eq_ignore_ascii_case("avr") {
        let mut remapped: Vec<std::path::PathBuf> = Vec::with_capacity(final_libs.len());
        for path in final_libs {
            if let Some((shim, skipped)) = create_arch_pruned_shim(&path, &board_arch) {
                if skipped > 0 {
                    arch_pruned_notes.push(format!(
                        "{} -> {} (skipped {} source file(s))",
                        path.display(),
                        shim.display(),
                        skipped
                    ));
                }
                remapped.push(shim);
            } else {
                remapped.push(path);
            }
        }
        final_libs = ck_core::builder::signature::normalize_and_sort_paths(&remapped);
    }
    if !arch_pruned_notes.is_empty() {
        log_val(format!(
            "[LibShim] Arch-pruned library source(s): {}\n",
            arch_pruned_notes.join(" | ")
        ));
    }
    flush_lib_cache_to_disk_if_dirty();
    /*
    let upload_preflight_installs =
        auto_install_known_header_libraries(&sysroot.root_dir, &include_not_in_ck_user);
    if !upload_preflight_installs.is_empty() {
        log_val("[AutoFix] Upload preflight Arduino library dependency check:\n".to_string());
        for (reason, lib_name, result) in upload_preflight_installs {
            match result {
                Ok(_) => log_val(format!(
                    "[AutoFix] Installed/verified {} ({})\n",
                    lib_name, reason
                )),
                Err(err) => log_val(format!(
                    "[AutoFix] Install skipped/failed {} ({}) -> {}\n",
                    lib_name, reason, err
                )),
            }
        }
    }
    */
    println!(
        "[LibShim] Final Libs passed to builder (sorted): {:?}",
        final_libs
    );

    let cli_version = fast_identity_cli_version(&sysroot);
    let (toolchain_identity_lease, toolchain_identity_source) =
        derive_toolchain_identity_lease(&sysroot, &compilation_fqbn)?;
    let toolchain_key = toolchain_identity_lease.toolchain_key().to_owned();
    let sorted_lib_strings: Vec<String> =
        final_libs.iter().map(|p| normalize_path_key(p)).collect();
    let build_signature = ck_core::builder::demo::compute_fast_build_signature(
        &compilation_fqbn,
        &cli_version,
        &toolchain_key,
        &sorted_lib_strings,
    );
    let forge_decision = forge_compatibility_for_build(
        &sysroot,
        &compilation_fqbn,
        Some(&cli_version),
        Some(&toolchain_key),
        Some(&sha256_text(&code)),
    );
    let upload_quick_fast_allowed = forge_decision.allows(
        ck_forge::ForgePerformanceOperation::UploadReady,
        ck_forge::ForgePerformanceProfile::QuickFast,
    );
    let upload_shared_fast_allowed = forge_decision.allows(
        ck_forge::ForgePerformanceOperation::UploadReady,
        ck_forge::ForgePerformanceProfile::SharedFast,
    );
    let forge_upload_allows_fast = upload_quick_fast_allowed || upload_shared_fast_allowed;
    let upload_exact_reuse_policy = forge_exact_reuse_policy(
        &forge_decision,
        false,
        ck_forge::ForgePerformanceOperation::UploadReady,
    );
    log_val(format!(
        "[INFO] Build Engine: ck-forge/v1 decision={} source={} profile-plan={} core={} identity-source={} reasons={}\n",
        forge_decision_label(forge_decision.decision),
        forge_source_label(forge_decision.source),
        match (upload_quick_fast_allowed, upload_shared_fast_allowed) {
            (true, true) => "quick-fast>shared-fast>release",
            (true, false) => "quick-fast>release",
            (false, true) => "shared-fast>release",
            (false, false) => "release",
        },
        forge_decision.core_version.as_deref().unwrap_or("unknown"),
        toolchain_identity_source,
        forge_reason_labels(&forge_decision)
    ));
    if !forge_upload_allows_fast {
        log_val(
            "[INFO] CK Forge native upload route: this exact host/Core/toolchain/FQBN has no upload-ready A/B certificate for QuickFast or SharedFast; upload compilation uses unmodified Arduino CLI Release.\n"
                .to_string(),
        );
    }

    let upload_code_hash = compile_accel::stable_code_hash(&code);
    let joining_compatible_warmup = compile_accel::prioritize_manual_compile_with_hints(
        &compilation_fqbn,
        Some(upload_code_hash),
        Some(build_signature.clone()),
    )
    .await;
    if joining_compatible_warmup {
        log_val(
            "[INFO] Upload is reusing compatible same-board warmup already in progress.\n".into(),
        );
    }

    // 1. Compile (prefer shared-fast cache; fallback to release if artifacts are incomplete)
    let log_val_upload_timing = log_val.clone();
    let sysroot_ref = &sysroot;
    let code_ref = code.as_str();
    let compilation_fqbn_ref = compilation_fqbn.as_str();
    let final_libs_ref = &final_libs;
    let build_signature_ref = build_signature.as_str();
    let workspace_fingerprint_ref = workspace_fingerprint.as_deref();

    let run_upload_compile_attempt = |profile: ck_core::builder::demo::CompileProfile,
                                      label: &str| {
        let app_for_compile_attempt = app.clone();
        let app_for_alias_attempt = app.clone();
        let trusted_sketch_alias_for_attempt = trusted_sketch_alias.clone();
        let log_val_compile_attempt = log_val.clone();
        let log_val_upload_timing_attempt = log_val_upload_timing.clone();
        let cancellation_for_lock = foreground_cancellation.clone();
        let cancellation_for_compile = cancellation_for_lock.clone();
        let toolchain_identity_lease_for_attempt = toolchain_identity_lease.clone();
        let label = label.to_string();
        async move {
            let progress_compile_attempt = move |p: f32, msg: String| {
                let _ = app_for_compile_attempt.emit(
                    "build-progress",
                    BuildProgress {
                        percentage: p,
                        message: msg,
                    },
                );
            };

            let upload_compile_phase_start = std::time::Instant::now();
            let locked = compile_accel::with_compile_lock_for_cancellable(
                compilation_fqbn_ref,
                &cancellation_for_lock,
                || async {
                    let cli_start = std::time::Instant::now();
                    let result = ck_core::builder::demo::compile_sketch_string_cancellable_with_identity_lease_and_intent(
                        sysroot_ref,
                        code_ref,
                        compilation_fqbn_ref,
                        final_libs_ref,
                        max_jobs,
                        build_signature_ref,
                        workspace_fingerprint_ref,
                        profile,
                        upload_exact_reuse_policy,
                        ck_core::builder::demo::CompileIntent::UploadReady,
                        toolchain_identity_lease_for_attempt,
                        cancellation_for_compile,
                        progress_compile_attempt,
                        log_val_compile_attempt,
                    )
                    .await;
                    (result, cli_start.elapsed())
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            let (compile_result, upload_cli_compile_elapsed) = locked;

            let upload_lock_plus_cli_elapsed = upload_compile_phase_start.elapsed();
            let upload_compile_lock_wait = upload_lock_plus_cli_elapsed
                .checked_sub(upload_cli_compile_elapsed)
                .unwrap_or_default();
            log_val_upload_timing_attempt(format!(
                "[Timing] Upload compile lock wait ({}): {:.1}s\n",
                label,
                upload_compile_lock_wait.as_secs_f32()
            ));
            log_val_upload_timing_attempt(format!(
                "[Timing] Upload CLI compile phase ({}): {:.1}s\n",
                label,
                upload_cli_compile_elapsed.as_secs_f32()
            ));

            if let Err(error) = &compile_result {
                emit_trusted_sketch_alias_for_line(
                    &app_for_alias_attempt,
                    &trusted_sketch_alias_for_attempt,
                    &error.to_string(),
                );
            }
            compile_result.map_err(|e| e.to_string())
        }
    };

    // Upload compile cascade: QuickFast → SharedFast → Release
    // QuickFast through fast-relink generates upload artifacts (objcopy/hex/bin/flash_args)
    // directly from resolved platform properties, bypassing expensive prebuild hooks.
    // SharedFast kept as intermediate fallback for cold-start when fast-relink cannot trigger.
    // Qualified targets use QuickFast -> SharedFast -> Release. Unknown/new or
    // performance-uncertified targets use Release directly: native recipes,
    // hooks, compiler paths, and Arduino CLI incremental behavior remain intact.
    let qfast_warm = upload_quick_fast_allowed
        && ck_core::builder::demo::has_warm_build_cache(
            &sysroot,
            &compilation_fqbn,
            ck_core::builder::demo::CompileProfile::QuickFast,
        );
    let _upload_profile_plan = forge_upload_profile_plan(&forge_decision, qfast_warm)?;
    let (build_path, compile_log, compile_profile, optimization) = 'upload_compile: {
        if !forge_upload_allows_fast {
            let (platform_path, platform_log) = run_upload_compile_attempt(
                ck_core::builder::demo::CompileProfile::Release,
                "release-native",
            )
            .await?;
            seal_or_validate_upload_artifacts(
                &platform_path,
                &compilation_fqbn,
                &build_signature,
                &platform_log,
            )?;
            log_val_upload_timing(
                "[INFO] Upload Profile: release-native (A/B performance gate, artifact manifest verified)\n"
                    .into(),
            );
            break 'upload_compile (platform_path, platform_log, "release", "platform-default");
        }
        // --- Tier 1: QuickFast (fastest, ~1-17s) — only if cache is warm ---
        if qfast_warm {
            match run_upload_compile_attempt(
                ck_core::builder::demo::CompileProfile::QuickFast,
                "quick-fast-upload",
            )
            .await
            {
                Ok((path, log)) => match seal_or_validate_upload_artifacts(
                    &path,
                    &compilation_fqbn,
                    &build_signature,
                    &log,
                ) {
                    Ok(()) => {
                        if foreground_cancellation.is_cancelled() {
                            return Err(format!(
                                "{}: upload cancelled before artifact selection",
                                ck_core::builder::demo::BUILD_CANCELED_MARKER
                            ));
                        }
                        log_val_upload_timing(
                            "[INFO] Upload Profile: quick-fast (fast relink, artifact manifest verified)\n"
                                .into(),
                        );
                        break 'upload_compile (path, log, "quick-fast", "-O1 -g0 -fno-lto");
                    }
                    Err(err) => {
                        if foreground_cancellation.is_cancelled() {
                            return Err(format!(
                                "{}: upload cancelled after quick-fast compile",
                                ck_core::builder::demo::BUILD_CANCELED_MARKER
                            ));
                        }
                        log_val_upload_timing(format!(
                            "[WARN] Quick-fast upload artifact gate rejected this cache: {}. Trying shared-fast.\n",
                            err
                        ));
                    }
                },
                Err(err) => {
                    if foreground_cancellation.is_cancelled() {
                        return Err(format!(
                            "{}: upload cancelled during quick-fast compile",
                            ck_core::builder::demo::BUILD_CANCELED_MARKER
                        ));
                    }
                    log_val_upload_timing(format!(
                        "[WARN] Quick-fast upload compile failed: {}. Trying shared-fast.\n",
                        err
                    ));
                }
            }
        } else if upload_quick_fast_allowed {
            if foreground_cancellation.is_cancelled() {
                return Err(format!(
                    "{}: upload cancelled before shared-fast compile",
                    ck_core::builder::demo::BUILD_CANCELED_MARKER
                ));
            }
            log_val_upload_timing(
                "[INFO] Upload: certified QuickFast upload cache is cold; trying the next independently certified upload-ready profile.\n"
                    .into(),
            );
        }

        // --- Tier 2: SharedFast (medium, keeps objcopy hooks) ---
        if upload_shared_fast_allowed {
            match run_upload_compile_attempt(
                ck_core::builder::demo::CompileProfile::SharedFast,
                "shared-fast",
            )
            .await
            {
                Ok((path, log)) => match seal_or_validate_upload_artifacts(
                    &path,
                    &compilation_fqbn,
                    &build_signature,
                    &log,
                ) {
                    Ok(()) => {
                        if foreground_cancellation.is_cancelled() {
                            return Err(format!(
                                "{}: upload cancelled before artifact selection",
                                ck_core::builder::demo::BUILD_CANCELED_MARKER
                            ));
                        }
                        log_val_upload_timing(
                            "[INFO] Upload Profile: shared-fast (artifact manifest verified)\n"
                                .into(),
                        );
                        break 'upload_compile (path, log, "shared-fast", "-O1 -g0 -fno-lto");
                    }
                    Err(err) => {
                        if foreground_cancellation.is_cancelled() {
                            return Err(format!(
                                "{}: upload cancelled after shared-fast compile",
                                ck_core::builder::demo::BUILD_CANCELED_MARKER
                            ));
                        }
                        log_val_upload_timing(format!(
                            "[WARN] Shared-fast upload artifact gate rejected this build: {}. Falling back to release.\n",
                            err
                        ));
                    }
                },
                Err(err) => {
                    if foreground_cancellation.is_cancelled() {
                        return Err(format!(
                            "{}: upload cancelled during shared-fast compile",
                            ck_core::builder::demo::BUILD_CANCELED_MARKER
                        ));
                    }
                    log_val_upload_timing(format!(
                        "[WARN] Shared-fast upload compile failed: {}. Falling back to release.\n",
                        err
                    ));
                }
            }
        }

        // --- Tier 3: Release (slowest, full pipeline) ---
        let (fallback_path, fallback_log) = run_upload_compile_attempt(
            ck_core::builder::demo::CompileProfile::Release,
            "release-fallback",
        )
        .await?;
        seal_or_validate_upload_artifacts(
            &fallback_path,
            &compilation_fqbn,
            &build_signature,
            &fallback_log,
        )?;
        log_val_upload_timing(
            "[INFO] Upload Profile: release (fallback, artifact manifest verified)\n".into(),
        );
        (fallback_path, fallback_log, "release", "platform-default")
    };
    if foreground_cancellation.is_cancelled() {
        return Err(format!(
            "{}: upload cancelled before transport preparation",
            ck_core::builder::demo::BUILD_CANCELED_MARKER
        ));
    }
    let source_map_path = write_compile_source_map(&build_path, source_map_payload.as_deref())?;
    if let Some(path) = source_map_path {
        log_val_upload_timing(format!(
            "[INFO] Compile source map verified and saved: {}\n",
            path.display()
        ));
    }

    let app_for_upload = app.clone();
    let progress_upload = move |p: f32, msg: String| {
        let _ = app_for_upload.emit(
            "build-progress",
            BuildProgress {
                percentage: p,
                message: msg,
            },
        );
    };

    let cancel_rx = foreground_cancellation.subscribe();

    // 2. Upload
    // Re-hash immediately before handing the path to the uploader. This closes
    // the gap between compile-tier selection and transport preparation.
    validate_upload_artifacts_for_transport(&build_path, &compilation_fqbn, &build_signature)?;
    if foreground_cancellation.is_cancelled() {
        return Err(format!(
            "{}: upload cancelled before writing Flash",
            ck_core::builder::demo::BUILD_CANCELED_MARKER
        ));
    }
    log_val_upload_timing("[INFO] Upload artifact manifest revalidated before transport.\n".into());
    if observe_preparation_only {
        // All production routing, compilation and artifact gates above ran
        // unchanged. Never enter transport or record a successful hardware
        // upload/last-working-version for this diagnostic observation.
        return run_upload_transport_with_identity_gate(
            &toolchain_identity_lease, &sysroot.root_dir, &compilation_fqbn,
            || async {
                Ok(serde_json::json!({
                    "boundary": "production upload preparation; transport not started",
                    "path": build_path,
                    "fqbn": compilation_fqbn,
                    "buildSignature": build_signature,
                    "profile": compile_profile,
                    "optimization": optimization,
                    "log": compile_log,
                    "preparationMs": upload_request_started.elapsed().as_millis(),
                    "uploadPerformed": false,
                    "artifactManifestValidated": true,
                    "toolchainIdentityRevalidated": true,
                }).to_string())
            },
        ).await;
    }
    log_val_upload_timing(format!(
        "[Timing] Upload preparation + compile: {:.3}s\n",
        upload_request_started.elapsed().as_secs_f64()
    ));
    let upload_transport_started = std::time::Instant::now();
    // Freeze compile-only diagnostics before any upload/serial content exists.
    if let Some(capture) = feedback_capture.as_mut() { capture.success(); }
    drop(feedback_capture);
    let upload_outcome = run_upload_transport_with_identity_gate(
        &toolchain_identity_lease,
        &sysroot.root_dir,
        &compilation_fqbn,
        || async {
            ck_core::builder::demo::upload_sketch_generic(
                &sysroot,
                &build_path,
                &compilation_fqbn,
                &port,
                probe_memory.unwrap_or(true),
                cancel_rx,
                progress_upload,
                log_val,
            )
            .await
            .map_err(|e| e.to_string())
        },
    )
    .await?;
    let mut log = upload_outcome.log;
    if compilation_fqbn
        .to_ascii_lowercase()
        .starts_with("esp32:esp32:")
    {
        match resource_map::summarize_build_linker_map(
            &build_path,
            &compilation_fqbn,
            &chrono::Utc::now().to_rfc3339(),
        ) {
            Ok(summary) => {
                let encoded = serde_json::to_string(&summary)
                    .map_err(|error| format!("cannot encode linker-map evidence: {error}"))?;
                log.push_str(&format!("\n[CK_LINKER_MAP_SUMMARY] {}\n", encoded));
            }
            Err(error) => log.push_str(&format!(
                "\n[WARN] Linker map resource attribution unavailable: {}\n",
                error
            )),
        }
    }
    log_val_upload_timing(format!(
        "[Timing] Upload transport phase: {:.3}s\n",
        upload_transport_started.elapsed().as_secs_f64()
    ));
    compile_accel::record_board_activity(
        &sysroot.root_dir,
        &compilation_fqbn,
        None,
        None,
        "upload",
    );
    // The foreground upload compile has already populated the exact/core/
    // dependency caches. Starting another same-board warmup here duplicates
    // work and can take the compile lock immediately before the user's next
    // edit/upload. Preserve the successful foreground cache as-is.
    log_val_upload_timing(format!(
        "[INFO] Upload finished; preserved foreground cache without redundant warmup: {}\n",
        compilation_fqbn
    ));
    log_val_upload_timing(format!(
        "[Timing] Upload request total: {:.3}s\n",
        upload_request_started.elapsed().as_secs_f64()
    ));

    let mut baseline_error: Option<String> = None;
    let mut baseline_id: Option<String> = None;
    if let Some(mut capture) = last_working_version {
        // The backend source is authoritative. A stale UI snapshot must never
        // label different code as the firmware that was just verified.
        capture.generated_code = code.clone();
        let context = last_working_version::SuccessfulUploadContext {
            build_path: &build_path,
            resolved_fqbn: &compilation_fqbn,
            build_signature: &build_signature,
            cli_version: &cli_version,
            toolchain_key: &toolchain_key,
            compile_profile,
            optimization,
            compile_log: &compile_log,
            upload_log: &log,
            library_paths: &final_libs,
            device: upload_outcome.device_observation.as_ref(),
        };
        match last_working_version::capture_successful_upload(&app, capture, context) {
            Ok(version) => {
                baseline_id = Some(version.id.clone());
                log_val_upload_timing(format!(
                "[INFO] 上一个可用版本已更新：{}（{} 个固件文件）\n",
                version.verified_at,
                version.firmware.artifacts.len()
                ));
            },
            Err(error) => {
                baseline_error = Some(error.clone());
                log_val_upload_timing(format!(
                "[WARN] 本次上传成功，但‘上一个可用版本’保存失败：{}\n",
                error
                ));
            },
        }
    }
    // Observation-only upload preparation returns earlier. Instrumented debug/trace
    // uploads explicitly disable probe_memory and must not label normal uploads.
    if probe_memory.unwrap_or(true) {
        record_board_success(&app, board_package_id.as_deref(), &compilation_fqbn,
            forge_decision.core_version.as_deref(), board_activity::Operation::Compile);
        record_board_success(&app, board_package_id.as_deref(), &compilation_fqbn,
            forge_decision.core_version.as_deref(), board_activity::Operation::Upload);
    }
    // Upload transport and optional baseline capture no longer consume the
    // build directory. Release the shared guard before scheduling eviction.
    compile_accel::maintain_cache_budget_after_success(
        settings.cache_limit_mb,
        false,
        &build_path,
        _build_cache_read_guard,
    );
    if structured_result {
        Ok(serde_json::json!({
            "kind": "ck-upload-result", "schemaVersion": 1, "success": true,
            "runId": run_id, "fqbn": compilation_fqbn,
            "compileLog": compile_log, "log": log,
            "baselineId": baseline_id, "baselineFailure": baseline_error,
        }).to_string())
    } else {
        Ok(log)
    }
}

#[tauri::command]
async fn restore_last_working_firmware(
    app: AppHandle,
    project_path: String,
    port: String,
    upload_state: State<'_, UploadState>,
) -> Result<String, String> {
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    let _build_cache_read_guard = compile_accel::protect_build_cache_use().await;
    let prepared = last_working_version::prepare_firmware_restore(&app, &project_path)?;
    let fqbn = prepared.version.environment.fqbn.clone();
    let build_signature = prepared.version.environment.build_signature.clone();

    // Re-run the immutable artifact/FQBN/partition/address/SHA-256 gate. The
    // recovery copy is never trusted merely because it lives in app data.
    validate_upload_artifacts_for_transport(&prepared.build_path, &fqbn, &build_signature)?;
    let sysroot = get_app_sysroot().await?;

    let app_for_log = app.clone();
    let log_val = move |line: String| {
        let _ = app_for_log.emit("build-log", line);
    };
    log_val(format!(
        "[INFO] 上一个可用版本：上传清单、完整 FQBN、分区、地址与 SHA-256 已重新通过门禁。\n[INFO] 恢复目标：{}\n",
        fqbn
    ));

    // ESP32 recovery is deliberately stricter than an ordinary upload: an
    // unknown chip or unknown physical Flash blocks the operation. AVR keeps
    // the existing manifest + avrdude signature/handshake gate.
    let _serial_guard = if fqbn.to_ascii_lowercase().starts_with("esp32:esp32:") {
        let (guard, evidence) =
            device_health::validate_firmware_restore_target(&sysroot, &fqbn, &port).await?;
        log_val(format!(
            "[INFO] 恢复真机门禁通过：芯片 {}，实体 Flash {} MiB，PSRAM {}。\n",
            evidence.chip,
            evidence.flash_bytes / 1024 / 1024,
            evidence
                .psram_bytes
                .map(|bytes| format!("{} MiB", bytes / 1024 / 1024))
                .unwrap_or_else(|| "未明确报告".to_string())
        ));
        guard
    } else {
        device_health::try_acquire_serial_operation()
            .map_err(|reason| format!("恢复固件未开始：{reason}"))?
    };

    let (restore_toolchain_identity_lease, _) = derive_toolchain_identity_lease(&sysroot, &fqbn)?;
    let current_toolchain_key = restore_toolchain_identity_lease.toolchain_key().to_owned();
    if current_toolchain_key != prepared.version.environment.toolchain_key {
        log_val(format!(
            "[WARN] 当前上传工具链与可用版本记录不同；固件本体保持原始哈希，上传仍使用当前已安装传输工具。\n"
        ));
    }

    let app_for_progress = app.clone();
    let progress = move |percentage: f32, message: String| {
        let _ = app_for_progress.emit(
            "build-progress",
            BuildProgress {
                percentage,
                message: format!("恢复上一个可用固件 · {message}"),
            },
        );
    };
    let (cancel_rx, _upload_session_guard) = upload_state.begin_session()?;
    let outcome = run_upload_transport_with_identity_gate(
        &restore_toolchain_identity_lease,
        &sysroot.root_dir,
        &fqbn,
        || async {
            ck_core::builder::demo::upload_sketch_generic(
                &sysroot,
                &prepared.build_path,
                &fqbn,
                &port,
                false,
                cancel_rx,
                progress,
                log_val,
            )
            .await
            .map_err(|error| error.to_string())
        },
    )
    .await?;
    compile_accel::record_board_activity(&sysroot.root_dir, &fqbn, None, None, "restore-upload");
    record_board_success(&app, Some(&prepared.version.project.board_package_id), &fqbn,
        prepared.version.environment.core_version.as_deref(), board_activity::Operation::Upload);
    Ok(outcome.log)
}

#[tauri::command]
async fn rebuild_last_working_version_locked(
    app: AppHandle,
    project_path: String,
) -> Result<String, String> {
    let _managed_package_read_guard = managed_package_mutation_gate().read().await;
    let _build_cache_read_guard = compile_accel::protect_build_cache_use().await;
    let rebuild_run_id = uuid::Uuid::new_v4().to_string();
    let (_foreground_build_guard, foreground_cancellation) = app
        .state::<ForegroundBuildState>()
        .register(&rebuild_run_id)?;
    let prepared = last_working_version::prepare_locked_build(&app, &project_path)?;
    let fqbn = prepared.version.environment.fqbn.clone();
    let sysroot = get_app_sysroot().await?;

    let resolved_fqbn = resolve_board_fqbn(&app, &prepared.version.project.board).await?;
    if resolved_fqbn != fqbn {
        return Err(format!(
            "锁定依赖复编译已阻止：当前板卡解析为 {}，可用版本记录为 {}",
            resolved_fqbn, fqbn
        ));
    }

    let cli_version = fast_identity_cli_version(&sysroot);
    if cli_version != prepared.version.environment.arduino_cli_version {
        return Err(format!(
            "锁定依赖复编译已阻止：Arduino CLI 已变化（记录：{}；当前：{}）",
            prepared.version.environment.arduino_cli_version, cli_version
        ));
    }
    let (toolchain_identity_lease, _) = derive_toolchain_identity_lease(&sysroot, &fqbn)?;
    let toolchain_key = toolchain_identity_lease.toolchain_key().to_owned();
    if toolchain_key != prepared.version.environment.toolchain_key {
        return Err(
            "锁定依赖复编译已阻止：Core、工具链或板卡配置内容已经变化。请先恢复对应环境，不能用当前全局环境冒充原基线。"
                .to_string(),
        );
    }

    let profile = match prepared.version.environment.compile_profile.as_str() {
        "quick-fast" => ck_core::builder::demo::CompileProfile::QuickFast,
        "shared-fast" => ck_core::builder::demo::CompileProfile::SharedFast,
        "portable-fast" => ck_core::builder::demo::CompileProfile::PortableFast,
        "release" => ck_core::builder::demo::CompileProfile::Release,
        other => {
            return Err(format!(
                "锁定依赖复编译已阻止：记录的编译档案不受支持 {}",
                other
            ));
        }
    };
    if matches!(
        profile,
        ck_core::builder::demo::CompileProfile::QuickFast
            | ck_core::builder::demo::CompileProfile::SharedFast
    ) {
        let current_forge = forge_compatibility_for_build(
            &sysroot,
            &fqbn,
            Some(&cli_version),
            Some(&toolchain_key),
            Some(&prepared.version.project.generated_code_sha256),
        );
        let profile_is_certified = match profile {
            ck_core::builder::demo::CompileProfile::QuickFast => current_forge.allows(
                ck_forge::ForgePerformanceOperation::Compile,
                ck_forge::ForgePerformanceProfile::QuickFast,
            ),
            ck_core::builder::demo::CompileProfile::SharedFast => current_forge.allows(
                ck_forge::ForgePerformanceOperation::UploadReady,
                ck_forge::ForgePerformanceProfile::SharedFast,
            ),
            _ => false,
        };
        if !profile_is_certified {
            return Err(format!(
                "锁定依赖复编译已阻止：记录使用快速档案，但当前目标没有该操作与档位对应的 CK Forge 资格（{}）。请恢复原环境或改用已验证的可用版本固件。",
                forge_reason_labels(&current_forge)
            ));
        }
    }
    let locked_library_paths =
        ck_core::builder::signature::normalize_and_sort_paths(&prepared.dependency_paths);
    let locked_library_strings = locked_library_paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let locked_build_signature = ck_core::builder::demo::compute_fast_build_signature(
        &fqbn,
        &cli_version,
        &toolchain_key,
        &locked_library_strings,
    );

    let app_for_log = app.clone();
    let log_val = move |line: String| {
        let _ = app_for_log.emit("build-log", line);
    };
    let app_for_progress = app.clone();
    let progress = move |percentage: f32, message: String| {
        let _ = app_for_progress.emit(
            "build-progress",
            BuildProgress {
                percentage,
                message: format!("锁定依赖复编译 · {message}"),
            },
        );
    };
    let compile_settings = compile_accel::load_settings(&sysroot.root_dir);
    let max_jobs = compile_settings.effective_jobs();
    let clean_compile_started = std::time::Instant::now();
    let cancellation_for_lock = foreground_cancellation.clone();
    let cancellation_for_compile = foreground_cancellation.clone();
    let compile_result =
        compile_accel::with_compile_lock_for_cancellable(&fqbn, &cancellation_for_lock, || async {
            ck_core::builder::demo::compile_sketch_string_locked_cancellable_with_identity_lease(
                &sysroot,
                &prepared.version.project.generated_code,
                &fqbn,
                &locked_library_paths,
                &prepared.lock_identity,
                max_jobs,
                &locked_build_signature,
                Some(&prepared.version.project.workspace_sha256),
                profile,
                ck_core::builder::demo::CkExactReusePolicy::Deny,
                toolchain_identity_lease,
                cancellation_for_compile,
                progress,
                log_val,
            )
            .await
        })
        .await
        .map_err(|error| error.to_string())?;
    let (build_path, log) = compile_result.map_err(|error| error.to_string())?;
    let artifact_gate = if profile == ck_core::builder::demo::CompileProfile::QuickFast {
        "compile-only: quick-fast baseline does not claim a newly packaged upload set"
    } else {
        maintain_upload_manifest_after_compile(&build_path, &fqbn, &locked_build_signature, &log)?
            .unwrap_or("platform does not use a CK upload manifest")
    };
    let elapsed_ms = clean_compile_started.elapsed().as_millis();

    let response = serde_json::json!({
        "status": "passed",
        "fqbn": fqbn,
        "lockSha256": prepared.version.lock.sha256,
        "dependencyCount": locked_library_paths.len(),
        "buildPath": build_path.to_string_lossy(),
        "compileProfile": prepared.version.environment.compile_profile,
        "optimization": prepared.version.environment.optimization,
        "log": log,
        "elapsedMs": elapsed_ms,
        "artifactGate": artifact_gate,
        "globalLibrariesUsed": false
    })
    .to_string();
    compile_accel::maintain_cache_budget_after_success(
        compile_settings.cache_limit_mb,
        false,
        &build_path,
        _build_cache_read_guard,
    );
    Ok(response)
}

#[tauri::command]
async fn cancel_upload(state: State<'_, UploadState>) -> Result<(), String> {
    state.request_cancel();
    Ok(())
}

#[tauri::command]
async fn cancel_foreground_build(
    run_id: String,
    state: State<'_, ForegroundBuildState>,
) -> Result<String, String> {
    cancel_foreground_build_run(&state, &run_id).await
}

#[tauri::command]
async fn open_serial_monitor(
    port: String,
    baud: u32,
    only_if_idle: Option<bool>,
    state: State<'_, MonitorState>,
    app: AppHandle,
) -> Result<(), String> {
    println!("[Rust] Opening Serial Monitor on {} @ {}", port, baud);
    let mut guard = state.monitor.lock().map_err(|e| e.to_string())?;
    if only_if_idle == Some(true) {
        if let Some(active) = guard.as_ref() {
            return if active.port == port && active.baud == baud && active.monitor.is_connected() { Ok(()) } else { Err("串口会话已断开或其他设备正在使用，未切换设备".into()) };
        }
    }

    // Close existing if any
    if let Some(active) = guard.take() {
        println!("[Rust] Closing existing monitor...");
        active.close()?;
    }

    let serial_operation_guard = device_health::try_acquire_serial_operation()
        .map_err(|_| "串口监视器未打开：真机体检、上传或另一串口监视器操作正在进行".to_string())?;

    let app_disconnect = app.clone();
    let sample = Arc::new(Mutex::new(None::<Vec<u8>>));
    let receive_sample = Arc::clone(&sample);
    let monitor = ck_core::executor::uploader::monitor::SerialMonitor::new(
        &port,
        baud,
        move |data| {
            if let Ok(mut slot) = receive_sample.lock() {
                if let Some(bytes) = slot.as_mut() {
                    let available = 4097usize.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&data[..data.len().min(available)]);
                }
            }
            let _ = app.emit("serial-data", data);
        },
        move |reason: String| {
            log::warn!("Serial port disconnected: {}", reason);
            let _ = app_disconnect.emit("serial-disconnected", reason);
        },
    )
    .map_err(|e| {
        println!("[Rust] Failed to open monitor: {}", e);
        e.to_string()
    })?;

    println!("[Rust] Serial Monitor started successfully.");
    *guard = Some(ActiveSerialMonitor {
        monitor,
        sample, port, baud,
        _serial_operation_guard: serial_operation_guard,
    });
    Ok(())
}

#[tauri::command]
async fn close_serial_monitor(state: State<'_, MonitorState>) -> Result<(), String> {
    // Remove the monitor from shared state first so new sends fail immediately,
    // then release the mutex before waiting for the read thread. The command
    // resolves only after the backend confirms the cloned reader and writer
    // handles have both been dropped.
    let active = {
        let mut guard = state.monitor.lock().map_err(|e| e.to_string())?;
        guard.take()
    };

    match active {
        Some(active) => active.close(),
        None => Ok(()),
    }
}

#[tauri::command]
async fn send_serial_data(data: Vec<u8>, state: State<'_, MonitorState>) -> Result<(), String> {
    let guard = state.monitor.lock().map_err(|e| e.to_string())?;
    if let Some(active) = guard.as_ref() {
        active.monitor.send(&data).map_err(|e| e.to_string())?;
    } else {
        return Err("Monitor not open".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn ai_serial_sample(port:String, baud:u32, text:Option<String>, wait_ms:u64, state:State<'_, MonitorState>) -> Result<serde_json::Value,String> {
    if !(100..=3000).contains(&wait_ms) || text.as_ref().is_some_and(|s| s.is_empty() || s.len()>256 || s.chars().any(|c| c.is_control() && !matches!(c,'\r'|'\n'|'\t'))) {
        return Err("串口采样参数无效".into());
    }
    let sample = {
        let guard=state.monitor.lock().map_err(|e|e.to_string())?;
        let active=guard.as_ref().filter(|a|a.port==port && a.baud==baud && a.monitor.is_connected()).ok_or("所选串口会话未连接")?;
        let mut slot=active.sample.lock().map_err(|e|e.to_string())?;
        if slot.is_some(){return Err("串口正在采样".into());}
        *slot=Some(Vec::new());
        if let Some(s)=&text {
            if let Err(e)=active.monitor.send(s.as_bytes()){*slot=None;return Err(e.to_string());}
        }
        Arc::clone(&active.sample)
    };
    tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
    let guard=state.monitor.lock().map_err(|e|e.to_string())?;
    let mut bytes=sample.lock().map_err(|e|e.to_string())?.take().unwrap_or_default();
    if !guard.as_ref().is_some_and(|a|Arc::ptr_eq(&a.sample,&sample) && a.monitor.is_connected()){return Err("采样期间串口已断开、关闭或切换，结果作废".into());}
    let truncated=bytes.len()>4096; bytes.truncate(4096);
    Ok(serde_json::json!({"port":port,"baud":baud,"observedMs":wait_ms,"sentBytes":text.as_deref().map_or(0,str::len),
        "receivedBytes":bytes.len(),"truncated":truncated,"text":String::from_utf8_lossy(&bytes)}))
}

const CORE_PIN_ALIAS_SCHEMA_VERSION: u64 = 1;
const MAX_VARIANT_PIN_HEADER_BYTES: u64 = 512 * 1024;

fn board_detail_build_property<'a>(
    details: &'a serde_json::Value,
    property: &str,
) -> Option<&'a str> {
    let prefix = format!("{property}=");
    details
        .get("build_properties")?
        .as_array()?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .find_map(|entry| entry.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum PinConstantExpr {
    Literal(u64),
    Alias(String),
}

fn scalar_pin_constant_expr(raw: &str) -> Option<PinConstantExpr> {
    let without_line_comment = raw.split_once("//").map_or(raw, |(head, _)| head);
    let mut value = without_line_comment
        .split_once("/*")
        .map_or(without_line_comment, |(head, _)| head)
        .trim();
    // Parentheses around one scalar are harmless. Casts, calls, arithmetic,
    // ternaries, array access and every other C expression remain rejected.
    for _ in 0..4 {
        if value.starts_with('(') && value.ends_with(')') {
            let inner = value[1..value.len() - 1].trim();
            if inner.is_empty() {
                return None;
            }
            value = inner;
        } else {
            break;
        }
    }
    let literal = Regex::new(r"^(0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)[uUlL]*$")
        .expect("integer literal regex");
    if let Some(captures) = literal.captures(value) {
        let literal = captures.get(1)?.as_str();
        let parsed = literal
            .strip_prefix("0x")
            .or_else(|| literal.strip_prefix("0X"))
            .map(|digits| (digits, 16))
            .or_else(|| {
                literal
                    .strip_prefix("0b")
                    .or_else(|| literal.strip_prefix("0B"))
                    .map(|digits| (digits, 2))
            })
            .map_or_else(
                || {
                    if literal.len() > 1 && literal.starts_with('0') {
                        u64::from_str_radix(&literal[1..], 8).ok()
                    } else {
                        literal.parse::<u64>().ok()
                    }
                },
                |(digits, radix)| u64::from_str_radix(digits, radix).ok(),
            )?;
        return Some(PinConstantExpr::Literal(parsed));
    }
    if Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
        .expect("identifier regex")
        .is_match(value)
    {
        return Some(PinConstantExpr::Alias(value.to_string()));
    }
    None
}

fn is_explicit_pin_macro_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("PIN_")
        || upper.ends_with("_PIN")
        || upper.ends_with("_GPIO")
        || upper.contains("BUILTIN")
        || Regex::new(r"^(?:A|D|T|DAC|ADC)[0-9]+$|^(?:SDA|SCL|TX|RX|SS|MOSI|MISO|SCK)[0-9]*$")
            .expect("well-known pin macro regex")
            .is_match(&upper)
}

fn resolve_pin_constant(
    name: &str,
    definitions: &BTreeMap<String, BTreeSet<PinConstantExpr>>,
    visiting: &mut BTreeSet<String>,
    depth: usize,
) -> Option<u64> {
    if depth > 16 || !visiting.insert(name.to_string()) {
        return None;
    }
    let expressions = definitions.get(name)?;
    // Multiple conditional definitions cannot be resolved without running the
    // platform preprocessor, so an ambiguous name is intentionally omitted.
    let expression = (expressions.len() == 1).then(|| expressions.first())??;
    let resolved = match expression {
        PinConstantExpr::Literal(value) => Some(*value),
        PinConstantExpr::Alias(alias) => {
            resolve_pin_constant(alias, definitions, visiting, depth + 1)
        }
    };
    visiting.remove(name);
    resolved
}

/// Remove C/C++ comments before looking for pin declarations while preserving
/// line boundaries. Parsing each line independently would otherwise accept a
/// convincing `#define` that only appears inside a multi-line comment. The
/// parser stays conservative: a comment marker in unrelated text may hide a
/// candidate, but it cannot manufacture a pin alias.
fn strip_pin_header_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            if ch == '\n' {
                output.push('\n');
                in_line_comment = false;
            }
            continue;
        }
        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
            } else if ch == '\n' {
                output.push('\n');
            }
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            in_line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block_comment = true;
            continue;
        }
        output.push(ch);
    }
    output
}

/// Recognize the common whole-file include guard so it does not hide every
/// declaration from the conservative conditional parser below. Any other
/// conditional region is treated as configuration-dependent and skipped.
fn pin_header_include_guard(source: &str) -> Option<String> {
    let mut meaningful = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("#pragma once"));
    let first = meaningful.next()?;
    let guard = Regex::new(r"^#\s*ifndef\s+([A-Za-z_][A-Za-z0-9_]*)\s*$")
        .expect("include guard regex")
        .captures(first)?
        .get(1)?
        .as_str()
        .to_string();
    let second = meaningful.next()?;
    let expected = Regex::new(r"^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*$")
        .expect("include guard define regex")
        .captures(second)?
        .get(1)?
        .as_str()
        .to_string();
    (guard == expected).then_some(guard)
}

/// Read only provable integer pin constants from a Core `pins_arduino.h`.
/// A bounded chain of scalar aliases is supported (for example AVR's
/// `A0 = PIN_A0`, `PIN_A0 = (14)`); arithmetic and conditional expressions
/// deliberately remain unresolved.
fn parse_static_integer_pin_aliases(source: &str) -> BTreeMap<u64, BTreeSet<String>> {
    let declaration = Regex::new(r"(?x)^\s*static\s+(?:const|constexpr)\s+(?:u?int(?:8|16|32|64)_t|pin_size_t|unsigned\s+int|int)\s+([A-Za-z_][A-Za-z0-9_]{0,63})\s*=\s*([^;]+)\s*;\s*(?://.*|/\*.*\*/\s*)?$")
        .expect("static integer pin alias regex");
    let macro_declaration =
        Regex::new(r"^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]{0,63})[ \t]+(.+?)\s*$")
            .expect("integer pin macro regex");
    let mut definitions = BTreeMap::<String, BTreeSet<PinConstantExpr>>::new();
    let mut exported_names = BTreeSet::<String>::new();
    let mut aliases = BTreeMap::<u64, BTreeSet<String>>::new();

    let uncommented_source = strip_pin_header_comments(source);
    let include_guard = pin_header_include_guard(&uncommented_source);
    let conditional_start =
        Regex::new(r"^#\s*(if|ifdef|ifndef)\b(?:\s+([A-Za-z_][A-Za-z0-9_]*))?.*$")
            .expect("preprocessor conditional regex");
    let conditional_branch =
        Regex::new(r"^#\s*(?:else|elif)\b").expect("preprocessor branch regex");
    let conditional_end = Regex::new(r"^#\s*endif\b").expect("preprocessor endif regex");
    let undef =
        Regex::new(r"^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)\b").expect("preprocessor undef regex");
    let mut conditional_stack = Vec::<bool>::new();
    let mut include_guard_consumed = false;
    let mut invalidated_names = BTreeSet::<String>::new();

    for line in uncommented_source.lines().take(4096) {
        let trimmed = line.trim();
        if let Some(captures) = conditional_start.captures(trimmed) {
            let directive = captures
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let name = captures
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let transparent_guard = conditional_stack.is_empty()
                && !include_guard_consumed
                && directive == "ifndef"
                && include_guard.as_deref() == Some(name);
            if transparent_guard {
                include_guard_consumed = true;
            }
            conditional_stack.push(transparent_guard);
            continue;
        }
        if conditional_branch.is_match(trimmed) {
            if let Some(active) = conditional_stack.last_mut() {
                // Even an `else` belonging to the recognized include guard is
                // no longer part of the normal guarded file body.
                *active = false;
            }
            continue;
        }
        if conditional_end.is_match(trimmed) {
            conditional_stack.pop();
            continue;
        }
        if let Some(captures) = undef.captures(trimmed) {
            if let Some(name) = captures.get(1).map(|value| value.as_str()) {
                // A conditional undef is still configuration-dependent, so
                // conservatively invalidate the name for every configuration.
                invalidated_names.insert(name.to_string());
            }
            continue;
        }
        if conditional_stack.iter().any(|transparent| !transparent) {
            continue;
        }
        if let Some(captures) = declaration.captures(line) {
            let Some(name) = captures.get(1).map(|value| value.as_str()) else {
                continue;
            };
            let Some(expression) = captures
                .get(2)
                .and_then(|value| scalar_pin_constant_expr(value.as_str()))
            else {
                continue;
            };
            definitions
                .entry(name.to_string())
                .or_default()
                .insert(expression);
            exported_names.insert(name.to_string());
            continue;
        }
        if let Some(captures) = macro_declaration.captures(line) {
            let Some(name) = captures.get(1).map(|value| value.as_str()) else {
                continue;
            };
            let Some(expression) = captures
                .get(2)
                .and_then(|value| scalar_pin_constant_expr(value.as_str()))
            else {
                continue;
            };
            // ESP32 headers sometimes add `#define LED_BUILTIN LED_BUILTIN`
            // after the typed constant solely for `#ifdef`; it must not make
            // the already parsed declaration ambiguous.
            if expression == PinConstantExpr::Alias(name.to_string()) {
                continue;
            }
            definitions
                .entry(name.to_string())
                .or_default()
                .insert(expression);
            if is_explicit_pin_macro_name(name) {
                exported_names.insert(name.to_string());
            }
        }
    }

    for name in invalidated_names {
        definitions.remove(&name);
        exported_names.remove(&name);
    }

    for name in exported_names {
        if let Some(value) = resolve_pin_constant(&name, &definitions, &mut BTreeSet::new(), 0) {
            aliases.entry(value).or_default().insert(name);
        }
    }
    aliases
}

fn installed_core_variant_dir(details: &serde_json::Value) -> Result<std::path::PathBuf, String> {
    let variant = board_detail_build_property(details, "build.variant")
        .ok_or_else(|| "board details did not expose build.variant".to_string())?;
    if variant == "."
        || variant == ".."
        || variant.contains("..")
        || !Regex::new(r"^[A-Za-z0-9_.-]{1,128}$")
            .expect("Core variant token regex")
            .is_match(variant)
    {
        return Err("board details exposed an unsafe build.variant".to_string());
    }
    let platform_path = board_detail_build_property(details, "runtime.platform.path")
        .or_else(|| board_detail_build_property(details, "build.board.platform.path"))
        .or_else(|| board_detail_build_property(details, "build.core.platform.path"))
        .ok_or_else(|| "board details did not expose an installed platform path".to_string())?;
    let platform_dir = std::fs::canonicalize(platform_path)
        .map_err(|error| format!("cannot resolve installed Core platform path: {error}"))?;
    let variants_dir = std::fs::canonicalize(platform_dir.join("variants"))
        .map_err(|error| format!("cannot resolve installed Core variants path: {error}"))?;
    if !variants_dir.starts_with(&platform_dir) {
        return Err("Core variants directory escaped the installed platform".to_string());
    }
    let requested = board_detail_build_property(details, "build.variant.path")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| variants_dir.join(variant));
    let variant_dir = std::fs::canonicalize(requested)
        .map_err(|error| format!("cannot resolve Core variant path: {error}"))?;
    if !variant_dir.starts_with(&variants_dir) {
        return Err("Core variant path escaped the installed variants directory".to_string());
    }
    Ok(variant_dir)
}

/// Enrich Arduino CLI's installed-board response with a machine-readable
/// alias snapshot tied to the exact Core variant file.  Failure is purposely
/// non-fatal: board configuration still works when a Core has no variant
/// header, uses generated headers, or stores aliases as expressions.
fn attach_installed_core_pin_aliases(
    details: &mut serde_json::Value,
    requested_fqbn: &str,
) -> Result<(), String> {
    let variant = board_detail_build_property(details, "build.variant")
        .unwrap_or_default()
        .to_string();
    let variant_dir = installed_core_variant_dir(details)?;
    let header_path = variant_dir.join("pins_arduino.h");
    let canonical_header = std::fs::canonicalize(&header_path)
        .map_err(|error| format!("cannot resolve pins_arduino.h: {error}"))?;
    if canonical_header.parent() != Some(variant_dir.as_path()) {
        return Err("pins_arduino.h escaped the resolved Core variant directory".to_string());
    }
    let metadata = std::fs::metadata(&canonical_header)
        .map_err(|error| format!("cannot inspect pins_arduino.h: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_VARIANT_PIN_HEADER_BYTES {
        return Err("pins_arduino.h is not a bounded regular file".to_string());
    }
    let source = std::fs::read_to_string(&canonical_header)
        .map_err(|error| format!("cannot read pins_arduino.h as UTF-8: {error}"))?;
    let aliases = parse_static_integer_pin_aliases(&source);
    if aliases.is_empty() {
        return Err("pins_arduino.h contained no provable integer pin aliases".to_string());
    }
    let sha256 = board_passport::hash_file(&canonical_header)?;
    let pins = aliases
        .into_iter()
        .map(|(value, aliases)| {
            serde_json::json!({
                "value": value.to_string(),
                "aliases": aliases.into_iter().collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let fqbn = requested_fqbn.to_string();
    let package = details
        .pointer("/package/name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let architecture = details
        .pointer("/platform/architecture")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let core_version = details
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let object = details
        .as_object_mut()
        .ok_or_else(|| "board details response is not a JSON object".to_string())?;
    object.insert(
        "ck_pin_alias_catalog".to_string(),
        serde_json::json!({
            "schema_version": CORE_PIN_ALIAS_SCHEMA_VERSION,
            "pins": pins,
            "source": {
                "kind": "installed-arduino-core-variant",
                "fqbn": fqbn,
                "package": package,
                "architecture": architecture,
                "core_version": core_version,
                "variant": variant,
                "file": "pins_arduino.h",
                "sha256": sha256,
            }
        }),
    );
    Ok(())
}

async fn arduino_cli_board_details(
    app: &AppHandle,
    fqbn: &str,
) -> Result<serde_json::Value, String> {
    let sysroot = get_app_sysroot().await?;
    let bin_path = sysroot.get_bin_path();
    let cli_path = bin_path.join("arduino-cli");
    let cli_exe = if cfg!(target_os = "windows") {
        cli_path.with_extension("exe")
    } else {
        cli_path
    };

    // Fallback logic: check if local bin exists, if not use global 'arduino-cli'
    let cmd_path = if cli_exe.exists() {
        cli_exe
    } else {
        std::path::PathBuf::from("arduino-cli")
    };

    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let install_state = app.state::<InstallState>().inner().clone();
    let fqbn = fqbn.to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut board_cmd = std::process::Command::new(&cmd_path);
        board_cmd
            .arg("--config-file")
            .arg(yaml_path)
            .arg("board")
            .arg("details")
            .arg("-b")
            .arg(fqbn)
            .arg("--format")
            .arg("json");
        no_window(&mut board_cmd);
        run_registered_install_output(&install_state, &mut board_cmd, "arduino-cli board details")
    })
    .await
    .map_err(|error| format!("Failed to join board details command: {error}"))??;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|error| format!("Arduino CLI returned invalid board details JSON: {error}"))
}

#[tauri::command]
async fn get_board_details(app: AppHandle, fqbn: String) -> Result<String, String> {
    // Resolve the legacy custom-board identifier for callers that still use
    // this command as the board-option schema source.
    let mut target_fqbn = fqbn.clone();
    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        let board_json_path = app_data
            .join("CK")
            .join("boards")
            .join(&fqbn)
            .join("board.json");
        if board_json_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&board_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(base) = json["fqbn_base"].as_str() {
                        target_fqbn = base.to_string();
                    }
                }
            }
        }
    }
    let details = arduino_cli_board_details(&app, &target_fqbn).await?;
    serde_json::to_string(&details).map_err(|error| error.to_string())
}

/// Unlike the option-schema command, this command intentionally receives the
/// complete resolved FQBN. Arduino menu options may select another variant,
/// so alias evidence must never be cached under the three-part base FQBN.
#[tauri::command]
async fn get_installed_core_pin_aliases(app: AppHandle, fqbn: String) -> Result<String, String> {
    let fqbn = fqbn.trim();
    if fqbn.len() > 1024
        || fqbn.split(':').count() < 3
        || fqbn.contains('\r')
        || fqbn.contains('\n')
    {
        return Err("Invalid resolved FQBN for Core pin aliases".to_string());
    }
    let mut details = arduino_cli_board_details(&app, fqbn).await?;
    attach_installed_core_pin_aliases(&mut details, fqbn)?;
    serde_json::to_string(&details["ck_pin_alias_catalog"]).map_err(|error| error.to_string())
}

#[cfg(test)]
mod installed_core_pin_alias_tests {
    use super::{attach_installed_core_pin_aliases, parse_static_integer_pin_aliases};

    #[test]
    fn parser_keeps_direct_integer_pin_constants_and_ignores_expressions() {
        let aliases = parse_static_integer_pin_aliases(
            r#"
                #ifndef Pins_Arduino_h
                #define Pins_Arduino_h
                static const uint8_t SDA = 23;
                static const uint8_t SCL = 0x16;
                static constexpr pin_size_t D2 = 2U;
                static const uint8_t D3 = 010; /* C octal literal */
                static const uint8_t D4 = 0b1001;
                #define PIN_A0 (14)
                static const uint8_t A0 = PIN_A0;
                #define LED_BUILTIN 13 // status LED is a real GPIO on this variant
                /* Documentation examples must never become aliases.
                #define D99 99
                static const uint8_t A42 = 42;
                */
                static const uint8_t LED_BUILTIN = SOC_GPIO_PIN_COUNT + PIN_RGB_LED;
                static const uint8_t INDIRECT = PIN_WIRE_SDA;
                #if defined(REVISION_A)
                #define D30 30
                #else
                #define D31 31
                #endif
                #define D32 32
                #undef D32
                #define RX 17
                const uint8_t NOT_STATIC = 4;
                #endif
            "#,
        );

        assert_eq!(
            aliases
                .get(&23)
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["SDA"]
        );
        assert_eq!(
            aliases
                .get(&22)
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["SCL"]
        );
        assert_eq!(
            aliases.get(&2).unwrap().iter().cloned().collect::<Vec<_>>(),
            vec!["D2"]
        );
        assert_eq!(
            aliases.get(&8).unwrap().iter().cloned().collect::<Vec<_>>(),
            vec!["D3"]
        );
        assert_eq!(
            aliases.get(&9).unwrap().iter().cloned().collect::<Vec<_>>(),
            vec!["D4"]
        );
        assert_eq!(
            aliases
                .get(&14)
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["A0", "PIN_A0"]
        );
        assert_eq!(
            aliases
                .get(&13)
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["LED_BUILTIN"]
        );
        assert!(!aliases.contains_key(&99));
        assert!(!aliases.contains_key(&42));
        assert!(!aliases.contains_key(&30));
        assert!(!aliases.contains_key(&31));
        assert!(!aliases.contains_key(&32));
        assert!(!aliases.values().any(|items| items.contains("INDIRECT")));
        assert_eq!(
            aliases
                .get(&17)
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["RX"]
        );
    }

    #[test]
    fn attached_catalog_records_exact_core_variant_and_header_hash() {
        let root =
            std::env::temp_dir().join(format!("ck-core-pin-alias-test-{}", uuid::Uuid::new_v4()));
        let variant = root.join("variants/esp32c6");
        std::fs::create_dir_all(&variant).expect("variant dir");
        std::fs::write(
            variant.join("pins_arduino.h"),
            "static const uint8_t A0 = 0;\nstatic const uint8_t SDA = 23;\n",
        )
        .expect("variant header");
        let mut details = serde_json::json!({
            "fqbn": "esp32:esp32:esp32c6",
            "version": "3.3.6",
            "package": { "name": "esp32" },
            "platform": { "architecture": "esp32" },
            "build_properties": [
                format!("runtime.platform.path={}", root.display()),
                "build.variant=esp32c6"
            ]
        });

        attach_installed_core_pin_aliases(&mut details, "esp32:esp32:esp32c6:FlashSize=16M")
            .expect("attach catalog");
        let catalog = &details["ck_pin_alias_catalog"];
        assert_eq!(catalog["schema_version"], 1);
        assert_eq!(
            catalog["source"]["fqbn"],
            "esp32:esp32:esp32c6:FlashSize=16M"
        );
        assert_eq!(catalog["source"]["core_version"], "3.3.6");
        assert_eq!(catalog["source"]["variant"], "esp32c6");
        assert_eq!(catalog["source"]["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(catalog["pins"][0]["aliases"][0], "A0");
        assert_eq!(catalog["pins"][1]["aliases"][0], "SDA");

        let _ = std::fs::remove_dir_all(root);
    }
}

fn strip_utf8_bom(input: &str) -> &str {
    input.strip_prefix('\u{feff}').unwrap_or(input)
}

fn resolve_zip_extract_root(temp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(temp_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    if entries.len() == 1 && entries[0].path().is_dir() {
        return Ok(entries[0].path());
    }
    Ok(temp_dir.to_path_buf())
}

fn discover_library_manifest_roots(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut discovered: Vec<std::path::PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some("library.json") {
            if let Some(parent) = path.parent() {
                discovered.push(parent.to_path_buf());
            }
        }
    }
    discovered.sort();
    discovered.dedup();
    discovered
}

fn resolve_board_package_source(
    temp_dir: &std::path::Path,
    preferred_subdir: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let extract_root = resolve_zip_extract_root(temp_dir)?;
    let library_manifest_roots = discover_library_manifest_roots(&extract_root);

    if let Some(subdir) = preferred_subdir {
        let candidate = package_quality::resolve_contained_existing_subdir(&extract_root, subdir)?;
        if candidate.exists() && candidate.join("board.json").exists() {
            return Ok(candidate);
        }
        if candidate.exists() && candidate.join("library.json").exists() {
            return Err(
                "Selected subdir is a library package (library.json). Please import it from Library Manager."
                    .to_string(),
            );
        }
        return Err(format!(
            "Board package subdir not found or missing board.json: {}",
            subdir
        ));
    }

    if extract_root.join("board.json").exists() {
        return Ok(extract_root);
    }

    if let Ok(entries) = std::fs::read_dir(&extract_root) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() && path.join("board.json").exists() {
                return Ok(path);
            }
        }
    }

    // Fallback: recursive discovery for monorepo-style board package layouts.
    let mut discovered: Vec<std::path::PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(&extract_root)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some("board.json") {
            if let Some(parent) = path.parent() {
                discovered.push(parent.to_path_buf());
            }
        }
    }
    discovered.sort();
    discovered.dedup();

    if discovered.len() == 1 {
        return Ok(discovered.remove(0));
    }
    if discovered.len() > 1 {
        return Err(
            "Multiple board packages found in repository. Please use a GitHub /tree/<branch>/<subdir> URL."
                .to_string(),
        );
    }

    if !library_manifest_roots.is_empty() {
        return Err(
            "Detected library package(s) (library.json). Please import via Library Manager, not Board Manager."
                .to_string(),
        );
    }

    Err("Invalid board package: 'board.json' not found at root or in top-level folder.".to_string())
}

fn commit_board_package_install(
    staged_board: &std::path::Path,
    target_board: &std::path::Path,
    staged_libraries: Option<&std::path::Path>,
    target_libraries: &std::path::Path,
) -> Result<(), String> {
    use std::fs;

    let board_parent = target_board
        .parent()
        .ok_or_else(|| format!("Invalid board target: {}", target_board.display()))?;
    let library_parent = target_libraries.parent().ok_or_else(|| {
        format!(
            "Invalid board library target: {}",
            target_libraries.display()
        )
    })?;
    fs::create_dir_all(board_parent).map_err(|e| e.to_string())?;
    fs::create_dir_all(library_parent).map_err(|e| e.to_string())?;

    let transaction_id = uuid::Uuid::new_v4();
    let board_backup = board_parent.join(format!(".ck-backup-board-{}", transaction_id));
    let library_backup = library_parent.join(format!(".ck-backup-libraries-{}", transaction_id));
    let had_board = target_board.exists();
    let had_libraries = target_libraries.exists();

    if had_board {
        fs::rename(target_board, &board_backup)
            .map_err(|e| format!("Failed to preserve existing board: {}", e))?;
    }
    if had_libraries {
        if let Err(error) = fs::rename(target_libraries, &library_backup) {
            if had_board {
                let _ = fs::rename(&board_backup, target_board);
            }
            return Err(format!(
                "Failed to preserve existing board libraries: {}",
                error
            ));
        }
    }

    if let Err(error) = fs::rename(staged_board, target_board) {
        if had_board {
            let _ = fs::rename(&board_backup, target_board);
        }
        if had_libraries {
            let _ = fs::rename(&library_backup, target_libraries);
        }
        return Err(format!("Failed to activate staged board: {}", error));
    }

    if let Some(staged) = staged_libraries {
        if let Err(error) = fs::rename(staged, target_libraries) {
            let _ = fs::remove_dir_all(target_board);
            let board_restore = if had_board {
                fs::rename(&board_backup, target_board).err()
            } else {
                None
            };
            let library_restore = if had_libraries {
                fs::rename(&library_backup, target_libraries).err()
            } else {
                None
            };
            return Err(format!(
                "Failed to activate bundled board libraries: {}{}{}",
                error,
                board_restore
                    .map(|e| format!("; board rollback failed: {}", e))
                    .unwrap_or_default(),
                library_restore
                    .map(|e| format!("; library rollback failed: {}", e))
                    .unwrap_or_default()
            ));
        }
    }

    if had_board {
        let _ = fs::remove_dir_all(board_backup);
    }
    if had_libraries {
        let _ = fs::remove_dir_all(library_backup);
    }
    Ok(())
}

fn inspect_board_package(root: &std::path::Path) -> package_quality::PackageQualityReport {
    let mut report = package_quality::PackageQualityReport::new("board");
    let manifest_path = root.join("board.json");
    let manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&raw)) {
            Ok(value) if value.is_object() => {
                report.pass("board-manifest", "board.json is valid JSON.");
                Some(value)
            }
            Ok(_) => {
                report.error(
                    "invalid-board-manifest",
                    "board.json must be a JSON object.",
                );
                None
            }
            Err(error) => {
                report.error(
                    "invalid-board-manifest",
                    format!("board.json is invalid: {}", error),
                );
                None
            }
        },
        Err(error) => {
            report.error(
                "missing-board-manifest",
                format!("Cannot read board.json: {}", error),
            );
            None
        }
    };

    if let Some(json) = manifest.as_ref() {
        let schema_version = json
            .get("schema_version")
            .and_then(serde_json::Value::as_u64);
        if schema_version == Some(1) {
            report.pass("schema-version", "Board package schema_version is 1.");
        } else {
            report.error(
                "invalid-schema-version",
                "board.json requires schema_version: 1.",
            );
        }

        let id = json
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        report.package_id = id.map(str::to_string);
        match id {
            Some(value) if package_quality::valid_package_id(value, false) => report.pass(
                "package-id",
                format!("Board package id '{}' is path-safe.", value),
            ),
            Some(value) => report.error(
                "invalid-package-id",
                format!(
                    "Board id '{}' must start with an ASCII letter or digit and contain only letters, digits, '_' or '-'.",
                    value
                ),
            ),
            None => report.error("missing-package-id", "board.json requires a non-empty id."),
        }

        for field in ["name", "version", "description"] {
            if json
                .get(field)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .is_none_or(str::is_empty)
            {
                report.error(
                    "missing-board-metadata",
                    format!("board.json requires a non-empty '{}'.", field),
                );
            }
        }
        if let Some(version) = json.get("version").and_then(serde_json::Value::as_str) {
            if package_quality::valid_semver(version) {
                report.pass(
                    "semantic-version",
                    format!("Version {} is valid SemVer.", version),
                );
            } else {
                report.error(
                    "invalid-version",
                    format!("board.json version '{}' is not valid SemVer.", version),
                );
            }
        }
        let has_owner = ["vendor", "author"].iter().any(|field| {
            json.get(*field)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        });
        if has_owner {
            report.pass("package-owner", "Board vendor or author is present.");
        } else {
            report.warn(
                "missing-owner",
                "Add vendor or author metadata so third-party ownership is traceable.",
            );
        }

        inspect_board_core_contract(json, &mut report);
        inspect_board_icon(root, json, &mut report);
        inspect_board_pins(json, &mut report);
        if let Some(graph) = json.get("resource_graph") {
            match resource_contract::validate_graph(graph) {
                Ok(()) => report.pass("resource-graph", "Resource graph passed the shared contract."),
                Err(error) => report.error("invalid-resource-graph", error),
            }
        }
        inspect_board_menus(json, &mut report);
        inspect_board_validation_contract(root, json, &mut report);
        inspect_board_extends(root, json, &mut report);
    }

    inspect_bundled_board_libraries(root, &mut report);
    if ["LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"]
        .iter()
        .any(|name| root.join(name).is_file())
    {
        report.pass("license", "A package license file is present.");
    } else {
        report.warn(
            "missing-license",
            "No LICENSE or COPYING file was found at the board package root.",
        );
    }
    match package_quality::hash_package_contents(root) {
        Ok(hash) => {
            report.source_content_sha256 = Some(hash);
            report.pass(
                "content-hash",
                "Board package contents were fingerprinted with SHA-256.",
            );
        }
        Err(error) => report.error("content-hash-failed", error),
    }
    report.finalize();
    report
}

fn inspect_board_core_contract(
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let fqbn = json
        .get("fqbn_base")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let fqbn_parts = fqbn.split(':').collect::<Vec<_>>();
    let valid_fqbn = fqbn_parts.len() == 3
        && fqbn_parts
            .iter()
            .all(|part| package_quality::valid_package_id(part, false));
    if valid_fqbn {
        report.pass("fqbn", format!("Base FQBN '{}' is well-formed.", fqbn));
    } else {
        report.error(
            "invalid-fqbn",
            "fqbn_base must be a base vendor:architecture:board FQBN without menu options.",
        );
    }

    if let Some(architecture) = json.get("architecture").and_then(serde_json::Value::as_str) {
        if valid_fqbn && fqbn_parts[1] != architecture {
            report.error(
                "architecture-mismatch",
                format!(
                    "Board architecture '{}' does not match FQBN architecture '{}'.",
                    architecture, fqbn_parts[1]
                ),
            );
        }
    }

    let Some(core) = json
        .get("arduino_core")
        .and_then(serde_json::Value::as_object)
    else {
        report.error(
            "missing-core-contract",
            "board.json requires an arduino_core object.",
        );
        return;
    };
    let package = core
        .get("package")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let expected_package = if valid_fqbn {
        format!("{}:{}", fqbn_parts[0], fqbn_parts[1])
    } else {
        String::new()
    };
    if package.is_empty() || (valid_fqbn && package != expected_package) {
        report.error(
            "core-package-mismatch",
            format!(
                "arduino_core.package '{}' must match FQBN package '{}'.",
                package, expected_package
            ),
        );
    } else {
        report.pass(
            "core-package",
            format!("Arduino core package '{}' matches the board FQBN.", package),
        );
    }

    let recommended = core
        .get("recommended_version")
        .or_else(|| core.get("version"))
        .and_then(serde_json::Value::as_str);
    if let (Some(legacy), Some(recommended)) = (
        core.get("version").and_then(serde_json::Value::as_str),
        core.get("recommended_version")
            .and_then(serde_json::Value::as_str),
    ) {
        if legacy != recommended {
            report.error(
                "core-version-alias-mismatch",
                "arduino_core.version and recommended_version must match when both are present.",
            );
        }
    }
    match recommended {
        Some(version) if package_quality::valid_semver(version) => report.pass(
            "core-recommended-version",
            format!(
                "Arduino core {} is the recommended version (not a hard lock).",
                version
            ),
        ),
        Some(version) => report.error(
            "invalid-core-recommended-version",
            format!(
                "Arduino core recommended version '{}' is not valid SemVer.",
                version
            ),
        ),
        None => report.error(
            "missing-core-recommended-version",
            "arduino_core must declare recommended_version or the legacy version alias so CK can present a best supported choice.",
        ),
    }

    for field in ["min_version", "max_version", "maximum_exclusive"] {
        if let Some(version) = core.get(field).and_then(serde_json::Value::as_str) {
            if package_quality::valid_semver(version) {
                report.pass(
                    &format!("core-{}", field.replace('_', "-")),
                    format!("Arduino core {} is valid SemVer: {}.", field, version),
                );
            } else {
                report.error(
                    &format!("invalid-core-{}", field.replace('_', "-")),
                    format!("arduino_core.{} '{}' is not valid SemVer.", field, version),
                );
            }
        }
    }
    if let Some(range) = core.get("version_range") {
        let valid = if let Some(range) = range.as_object() {
            !range.is_empty()
                && range
                    .keys()
                    .all(|key| matches!(key.as_str(), "minimum" | "maximum_exclusive"))
                && range
                    .values()
                    .all(|version| version.as_str().is_some_and(package_quality::valid_semver))
        } else {
            false
        };
        if valid {
            report.pass(
                "core-version-range",
                "Arduino core tested version range is valid.",
            );
        } else {
            report.error(
                "invalid-core-version-range",
                "arduino_core.version_range must be an object containing only minimum/maximum_exclusive SemVer values.",
            );
        }
    }
    if let Some(values) = core.get("tested_versions") {
        let valid = values.as_array().is_some_and(|values| {
            values
                .iter()
                .all(|value| value.as_str().is_some_and(package_quality::valid_semver))
        });
        if valid {
            report.pass(
                "core-tested-versions",
                "arduino_core.tested_versions contains valid SemVer values.",
            );
        } else {
            report.error(
                "invalid-core-tested-versions",
                "arduino_core.tested_versions must be an array of SemVer versions.",
            );
        }
    }
    if let Some(values) = core.get("known_incompatible") {
        let valid = values.as_array().is_some_and(|values| {
            values.iter().all(|value| {
                let Some(entry) = value.as_object() else {
                    return false;
                };
                if !entry.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "version" | "version_range" | "reason" | "reference_url"
                    )
                }) {
                    return false;
                }
                let reason_valid = entry
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|reason| !reason.trim().is_empty());
                let version_valid = entry
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(package_quality::valid_semver);
                let range_valid = entry
                    .get("version_range")
                    .and_then(serde_json::Value::as_object)
                    .is_some_and(|range| {
                        !range.is_empty()
                            && range
                                .keys()
                                .all(|key| matches!(key.as_str(), "minimum" | "maximum_exclusive"))
                            && range.values().all(|version| {
                                version.as_str().is_some_and(package_quality::valid_semver)
                            })
                    });
                reason_valid && (version_valid ^ range_valid)
            })
        });
        if valid {
            report.pass(
                "core-known-incompatible",
                "arduino_core.known_incompatible declarations are valid.",
            );
        } else {
            report.error(
                "invalid-core-known-incompatible",
                "known_incompatible entries require a version/range object and a concrete reason; unexplained version strings are not auditable.",
            );
        }
    }
    match board_passport::ArduinoCoreRequirement::from_manifest_value(&serde_json::Value::Object(
        core.clone(),
    )) {
        Ok(requirement) => {
            if let Some(recommended) = requirement.recommended_version.as_deref() {
                if let Some(reason) =
                    board_passport::declared_version_block_reason(&requirement, recommended)
                {
                    report.error(
                        "blocked-recommended-core-version",
                        format!(
                            "Recommended core version {} contradicts the compatibility policy: {}.",
                            recommended, reason
                        ),
                    );
                }
            }
        }
        Err(error) => report.error("invalid-core-compatibility-policy", error),
    }

    let index_url = core
        .get("index_url")
        .or_else(|| core.get("platform_index_url"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match index_url {
        Some(url) if url.starts_with("https://") => {
            report.pass("core-index-url", "Arduino core index URL is well-formed.");
        }
        Some(url) if url.starts_with("http://") => report.warn(
            "insecure-core-index-url",
            format!(
                "Arduino core index '{}' uses unencrypted HTTP; import remains available but HTTPS is recommended.",
                url
            ),
        ),
        Some(url) => report.error(
            "invalid-core-index-url",
            format!("Unsupported Arduino core index URL '{}'.", url),
        ),
        None if package.starts_with("arduino:") => report.pass(
            "core-index-url",
            "Official Arduino package uses the built-in package index.",
        ),
        None => report.error(
            "missing-core-index-url",
            "Third-party Arduino cores require index_url or platform_index_url.",
        ),
    }
}

fn inspect_board_icon(
    root: &std::path::Path,
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let Some(icon) = json
        .get("icon")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        report.warn("missing-icon", "No board icon is declared.");
        return;
    };
    if icon.starts_with("https://") || icon.starts_with("http://") {
        report.error(
            "remote-icon",
            "Remote board icons are not accepted by the offline package contract; bundle the asset and use a package-relative path.",
        );
        return;
    }
    let Some(relative) = package_quality::safe_relative_path(icon) else {
        report.error(
            "unsafe-icon-path",
            format!(
                "Board icon path '{}' is not a safe package-relative path.",
                icon
            ),
        );
        return;
    };
    if root.join(relative).is_file() {
        report.pass("board-icon", "Board icon exists inside the package.");
    } else {
        report.error(
            "missing-icon-file",
            format!("Board icon '{}' was not found in the package.", icon),
        );
    }
}

fn inspect_board_pins(
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let Some(pins) = json.get("pins").and_then(serde_json::Value::as_array) else {
        report.warn(
            "missing-pins",
            "No pins are declared; pin-aware blocks and AI selection will be limited.",
        );
        return;
    };
    if pins.is_empty() {
        report.warn("missing-pins", "The board pin catalog is empty.");
        return;
    }
    let mut catalog_errors = Vec::new();
    if pins.len() > 512 {
        record_pin_error(
            &mut catalog_errors,
            format!(
                "pins contains {} entries; the safety limit is 512.",
                pins.len()
            ),
        );
    }
    let mut pin_tokens = HashMap::<String, usize>::new();
    for (index, pin) in pins.iter().enumerate() {
        let Some(object) = pin.as_object() else {
            record_pin_error(
                &mut catalog_errors,
                format!("pins[{}] must be an object.", index),
            );
            continue;
        };
        const PIN_KEYS: &[&str] = &[
            "label",
            "value",
            "aliases",
            "capabilities",
            "risks",
            "reserved_by",
            "sharing",
            "connector",
            "source",
            "evidence",
        ];
        for key in object.keys() {
            if !PIN_KEYS.contains(&key.as_str()) {
                record_pin_error(
                    &mut catalog_errors,
                    format!("pins[{}] contains unsupported field '{}'.", index, key),
                );
            }
        }
        if bounded_pin_line(object.get("label"), 128).is_none() {
            record_pin_error(
                &mut catalog_errors,
                format!(
                    "pins[{}].label must be a non-empty line up to 128 characters.",
                    index
                ),
            );
        }
        let Some(value) = bounded_pin_line(object.get("value"), 128) else {
            record_pin_error(
                &mut catalog_errors,
                format!(
                    "pins[{}].value must be a non-empty line up to 128 characters.",
                    index
                ),
            );
            continue;
        };
        if !valid_pin_code_token(value) {
            record_pin_error(
                &mut catalog_errors,
                format!(
                    "pins[{}].value must be a non-negative canonical decimal integer or one C/C++ identifier.",
                    index
                ),
            );
            continue;
        }
        let token = value.to_lowercase();
        if let Some(previous) = pin_tokens.insert(token, index) {
            record_pin_error(
                &mut catalog_errors,
                format!(
                    "pins[{}].value duplicates pins[{}].value (case-insensitive).",
                    index, previous
                ),
            );
        }
    }
    if catalog_errors.is_empty() {
        report.pass(
            "pin-catalog",
            format!("{} unique pins are declared.", pins.len()),
        );
    } else {
        report.error(
            "invalid-pin-catalog",
            format!(
                "Every pin requires a bounded label, a unique bounded value and only standard fields. {}",
                catalog_errors.join(" ")
            ),
        );
    }

    let menu_values = board_menu_values(json);
    let mut metadata_errors = Vec::new();
    let mut alias_owners = pin_tokens;
    let mut connector_positions = HashSet::new();
    let mut detailed_count = 0usize;
    let mut capabilities_count = 0usize;
    let mut provenance_count = 0usize;
    let mut reserved_without_risk = 0usize;

    for (index, pin) in pins.iter().enumerate() {
        let Some(object) = pin.as_object() else {
            continue;
        };
        if [
            "aliases",
            "capabilities",
            "risks",
            "reserved_by",
            "sharing",
            "connector",
            "source",
            "evidence",
        ]
        .iter()
        .any(|key| object.contains_key(*key))
        {
            detailed_count += 1;
        }

        if let Some(aliases) = object.get("aliases") {
            match pin_string_array(aliases, 32, 128, false) {
                Ok(values) => {
                    for alias in values {
                        let token = alias.to_lowercase();
                        if let Some(owner) = alias_owners.insert(token, index) {
                            record_pin_error(
                                &mut metadata_errors,
                                format!(
                                    "pins[{}] alias '{}' conflicts with pin {} value or alias.",
                                    index, alias, owner
                                ),
                            );
                        }
                    }
                }
                Err(reason) => record_pin_error(
                    &mut metadata_errors,
                    format!("pins[{}].aliases {}", index, reason),
                ),
            }
        }

        if let Some(capabilities) = object.get("capabilities") {
            match pin_string_array(capabilities, 64, 64, true) {
                Ok(_) => capabilities_count += 1,
                Err(reason) => record_pin_error(
                    &mut metadata_errors,
                    format!("pins[{}].capabilities {}", index, reason),
                ),
            }
        }

        if let Some(sharing) = object.get("sharing") {
            if !sharing
                .as_str()
                .is_some_and(|value| matches!(value, "exclusive" | "shared" | "board-defined"))
            {
                record_pin_error(
                    &mut metadata_errors,
                    format!(
                        "pins[{}].sharing must be exclusive, shared or board-defined.",
                        index
                    ),
                );
            }
        }

        let has_reserved_by = object.contains_key("reserved_by");
        let reserved_by_valid = object.get("reserved_by").is_none_or(|value| {
            bounded_pin_line(Some(value), 128).is_some()
                || pin_string_array(value, 32, 128, false).is_ok()
        });
        if has_reserved_by && !reserved_by_valid {
            record_pin_error(
                &mut metadata_errors,
                format!(
                    "pins[{}].reserved_by must be a non-empty line or a unique non-empty string array (up to 32 entries and 128 characters each).",
                    index
                ),
            );
        }

        if let Some(connector) = object.get("connector") {
            validate_pin_connector(
                connector,
                index,
                &mut connector_positions,
                &mut metadata_errors,
            );
        }

        let has_source = if object.contains_key("source") {
            if bounded_pin_line(object.get("source"), 256).is_some() {
                true
            } else {
                record_pin_error(
                    &mut metadata_errors,
                    format!(
                        "pins[{}].source must be a non-empty line up to 256 characters.",
                        index
                    ),
                );
                false
            }
        } else {
            false
        };
        let has_evidence = if let Some(evidence) = object.get("evidence") {
            validate_pin_evidence(evidence, index, &mut metadata_errors)
        } else {
            false
        };
        if has_source || has_evidence {
            provenance_count += 1;
        }

        let has_risks = if let Some(risks) = object.get("risks") {
            validate_pin_risks(risks, index, &menu_values, &mut metadata_errors)
        } else {
            false
        };
        if has_reserved_by && !has_risks {
            reserved_without_risk += 1;
        }
    }

    if metadata_errors.is_empty() {
        if detailed_count > 0 {
            report.pass(
                "detailed-pin-metadata",
                format!(
                    "{}/{} pins declare structured capability, risk, connector or provenance metadata.",
                    detailed_count,
                    pins.len()
                ),
            );
        } else {
            report.warn(
                "missing-detailed-pin-metadata",
                "This legacy pin catalog has label/value pairs only. Import remains allowed, but capability and risk analysis cannot be considered complete.",
            );
        }
    } else {
        report.error(
            "invalid-pin-metadata",
            format!(
                "Declared detailed pin metadata is malformed. {}",
                metadata_errors.join(" ")
            ),
        );
    }
    if capabilities_count < pins.len() {
        report.warn(
            "incomplete-pin-capabilities",
            format!(
                "Only {}/{} pins declare a non-empty capabilities list; missing capabilities are treated as unknown, never inferred.",
                capabilities_count,
                pins.len()
            ),
        );
    }
    if provenance_count < pins.len() {
        report.warn(
            "incomplete-pin-provenance",
            format!(
                "Only {}/{} pins declare source or evidence metadata; missing provenance lowers confidence but does not block legacy packages.",
                provenance_count,
                pins.len()
            ),
        );
    }
    if reserved_without_risk > 0 {
        report.warn(
            "reserved-pin-without-risk",
            format!(
                "{} reserved pin(s) do not declare a structured risk severity; they remain reserved but cannot produce a precise role-aware diagnostic.",
                reserved_without_risk
            ),
        );
    }
}

fn record_pin_error(errors: &mut Vec<String>, message: impl Into<String>) {
    if errors.len() < 8 {
        errors.push(message.into());
    }
}

fn bounded_pin_text(
    value: Option<&serde_json::Value>,
    max_chars: usize,
    allow_newlines: bool,
) -> Option<&str> {
    let value = value?.as_str()?.trim();
    if value.is_empty()
        || value.chars().count() > max_chars
        || (!allow_newlines && (value.contains('\r') || value.contains('\n')))
    {
        None
    } else {
        Some(value)
    }
}

fn bounded_pin_line(value: Option<&serde_json::Value>, max_chars: usize) -> Option<&str> {
    bounded_pin_text(value, max_chars, false)
}

fn valid_pin_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'_' | b'.' | b'-')
        })
}

fn valid_pin_code_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || value == "__CK_PIN_UNDECLARED__" {
        return false;
    }
    if bytes.iter().all(u8::is_ascii_digit) {
        return bytes.len() == 1 || bytes[0] != b'0';
    }
    (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn pin_string_array(
    value: &serde_json::Value,
    max_items: usize,
    max_chars: usize,
    identifiers_only: bool,
) -> Result<Vec<String>, String> {
    let Some(values) = value.as_array() else {
        return Err("must be an array.".to_string());
    };
    if values.is_empty() || values.len() > max_items {
        return Err(format!("must contain between 1 and {} entries.", max_items));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(values.len());
    for entry in values {
        let Some(text) = bounded_pin_line(Some(entry), max_chars) else {
            return Err(format!(
                "contains an empty, multiline or over-{}-character entry.",
                max_chars
            ));
        };
        if identifiers_only && !valid_pin_identifier(text) {
            return Err(format!("contains invalid identifier '{}'.", text));
        }
        let token = text.to_lowercase();
        if !seen.insert(token) {
            return Err(format!("contains duplicate entry '{}'.", text));
        }
        result.push(text.to_string());
    }
    Ok(result)
}

fn board_menu_values(json: &serde_json::Value) -> HashMap<String, HashSet<String>> {
    let mut result = HashMap::new();
    let Some(menus) = json
        .get("custom_menus")
        .and_then(serde_json::Value::as_object)
    else {
        return result;
    };
    for (key, menu) in menus {
        let values = menu
            .get("options")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| option.get("value").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect::<HashSet<_>>();
        result.insert(key.clone(), values);
    }
    result
}

fn validate_pin_connector(
    value: &serde_json::Value,
    pin_index: usize,
    occupied: &mut HashSet<String>,
    errors: &mut Vec<String>,
) {
    let Some(connector) = value.as_object() else {
        record_pin_error(
            errors,
            format!("pins[{}].connector must be an object.", pin_index),
        );
        return;
    };
    if connector
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "side" | "position"))
    {
        record_pin_error(
            errors,
            format!(
                "pins[{}].connector contains an unsupported field.",
                pin_index
            ),
        );
    }
    let id = bounded_pin_line(connector.get("id"), 128);
    if !id.is_some_and(|id| package_quality::valid_package_id(id, false)) {
        record_pin_error(
            errors,
            format!(
                "pins[{}].connector.id must be a safe identifier.",
                pin_index
            ),
        );
    }
    let side = connector.get("side").and_then(serde_json::Value::as_str);
    if connector.contains_key("side")
        && !side.is_some_and(|value| matches!(value, "left" | "right" | "top" | "bottom"))
    {
        record_pin_error(
            errors,
            format!(
                "pins[{}].connector.side must be left, right, top or bottom.",
                pin_index
            ),
        );
    }
    let position = connector
        .get("position")
        .and_then(serde_json::Value::as_f64);
    if connector.contains_key("position")
        && !position.is_some_and(|value| value.is_finite() && (0.0..=10000.0).contains(&value))
    {
        record_pin_error(
            errors,
            format!(
                "pins[{}].connector.position must be between 0 and 10000.",
                pin_index
            ),
        );
    }
    if let (Some(id), Some(position)) = (id, position) {
        let location = format!("{}|{}|{}", id.to_lowercase(), side.unwrap_or(""), position);
        if !occupied.insert(location) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].connector duplicates another connector id/side/position.",
                    pin_index
                ),
            );
        }
    }
}

fn validate_pin_evidence(
    value: &serde_json::Value,
    pin_index: usize,
    errors: &mut Vec<String>,
) -> bool {
    let Some(entries) = value.as_array() else {
        record_pin_error(
            errors,
            format!("pins[{}].evidence must be an array.", pin_index),
        );
        return false;
    };
    if entries.is_empty() || entries.len() > 16 {
        record_pin_error(
            errors,
            format!(
                "pins[{}].evidence must contain between 1 and 16 entries.",
                pin_index
            ),
        );
        return false;
    }
    let mut seen = HashSet::new();
    let mut valid = true;
    for (evidence_index, entry) in entries.iter().enumerate() {
        let Some(evidence) = entry.as_object() else {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}] must be an object.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
            continue;
        };
        if evidence
            .keys()
            .any(|key| !matches!(key.as_str(), "kind" | "reference" | "locator" | "sha256"))
        {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}] contains an unsupported field.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
        let kind = evidence.get("kind").and_then(serde_json::Value::as_str);
        if !kind.is_some_and(|value| {
            matches!(
                value,
                "datasheet" | "schematic" | "board-definition" | "publisher-test" | "other"
            )
        }) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}].kind is not recognized.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
        let reference = bounded_pin_line(evidence.get("reference"), 1000);
        if reference.is_none() {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}].reference is required and limited to 1000 characters.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
        if evidence.contains_key("locator")
            && bounded_pin_line(evidence.get("locator"), 256).is_none()
        {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}].locator is invalid.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
        let sha256 = evidence.get("sha256").and_then(serde_json::Value::as_str);
        if evidence.contains_key("sha256")
            && !sha256.is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence[{}].sha256 must contain 64 hexadecimal characters.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
        let identity = format!(
            "{}|{}|{}|{}",
            kind.unwrap_or(""),
            reference.unwrap_or(""),
            evidence
                .get("locator")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            sha256.unwrap_or("")
        );
        if !seen.insert(identity) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].evidence contains a duplicate entry at index {}.",
                    pin_index, evidence_index
                ),
            );
            valid = false;
        }
    }
    valid
}

fn validate_pin_risks(
    value: &serde_json::Value,
    pin_index: usize,
    menu_values: &HashMap<String, HashSet<String>>,
    errors: &mut Vec<String>,
) -> bool {
    let Some(risks) = value.as_array() else {
        record_pin_error(
            errors,
            format!("pins[{}].risks must be an array.", pin_index),
        );
        return false;
    };
    if risks.is_empty() || risks.len() > 64 {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks must contain between 1 and 64 entries.",
                pin_index
            ),
        );
        return false;
    }
    let mut valid = true;
    let mut codes = HashSet::new();
    for (risk_index, risk) in risks.iter().enumerate() {
        let Some(risk) = risk.as_object() else {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}] must be an object.",
                    pin_index, risk_index
                ),
            );
            valid = false;
            continue;
        };
        if risk.keys().any(|key| {
            !matches!(
                key.as_str(),
                "code" | "severity" | "title" | "detail" | "roles" | "when"
            )
        }) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}] contains an unsupported field.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        let code = risk.get("code").and_then(serde_json::Value::as_str);
        if !code.is_some_and(valid_pin_identifier) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].code must be a lowercase identifier.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        } else if !codes.insert(code.unwrap().to_string()) {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks contains duplicate code '{}'.",
                    pin_index,
                    code.unwrap()
                ),
            );
            valid = false;
        }
        if !risk
            .get("severity")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| matches!(value, "blocker" | "warning" | "notice"))
        {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].severity must be blocker, warning or notice.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        if bounded_pin_line(risk.get("title"), 160).is_none() {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].title is required and limited to 160 characters.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        if risk.contains_key("detail") && bounded_pin_text(risk.get("detail"), 1000, true).is_none()
        {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].detail is empty or exceeds 1000 characters.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        if let Some(roles) = risk.get("roles") {
            if let Err(reason) = pin_string_array(roles, 32, 64, true) {
                record_pin_error(
                    errors,
                    format!("pins[{}].risks[{}].roles {}", pin_index, risk_index, reason),
                );
                valid = false;
            }
        }
        if let Some(condition) = risk.get("when") {
            if !validate_pin_risk_condition(condition, pin_index, risk_index, menu_values, errors) {
                valid = false;
            }
        }
    }
    valid
}

fn validate_pin_risk_condition(
    value: &serde_json::Value,
    pin_index: usize,
    risk_index: usize,
    menu_values: &HashMap<String, HashSet<String>>,
    errors: &mut Vec<String>,
) -> bool {
    let Some(condition) = value.as_object() else {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks[{}].when must be an object.",
                pin_index, risk_index
            ),
        );
        return false;
    };
    if condition
        .keys()
        .any(|key| key != "options" && key != "features")
    {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks[{}].when contains an unsupported field.",
                pin_index, risk_index
            ),
        );
        return false;
    }
    let options = condition
        .get("options")
        .and_then(serde_json::Value::as_object);
    let features = condition
        .get("features")
        .and_then(serde_json::Value::as_array);
    let mut valid = true;
    if condition.get("features").is_some() && features.is_none() {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks[{}].when.features must be an array.",
                pin_index, risk_index
            ),
        );
        valid = false;
    }
    if options.is_none() && features.is_none() {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks[{}].when must contain options or features.",
                pin_index, risk_index
            ),
        );
        return false;
    }
    if condition.get("options").is_some() && options.is_none() {
        record_pin_error(
            errors,
            format!(
                "pins[{}].risks[{}].when.options must be a non-empty object.",
                pin_index, risk_index
            ),
        );
        valid = false;
    }
    if let Some(options) = options {
        if options.is_empty() || options.len() > 16 {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].when.options must contain between 1 and 16 menus.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        for (menu, selected) in options {
            let Some(allowed) = menu_values.get(menu) else {
                record_pin_error(
                    errors,
                    format!(
                        "pins[{}].risks[{}].when references unknown custom menu '{}'.",
                        pin_index, risk_index, menu
                    ),
                );
                valid = false;
                continue;
            };
            let values = if let Some(value) = selected.as_str() {
                vec![value]
            } else if let Some(values) = selected.as_array() {
                if values.is_empty() || values.len() > 64 {
                    record_pin_error(
                        errors,
                        format!(
                            "pins[{}].risks[{}].when option '{}' must contain 1 to 64 values.",
                            pin_index, risk_index, menu
                        ),
                    );
                    valid = false;
                }
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            if values.is_empty()
                || (selected.is_array()
                    && selected
                        .as_array()
                        .is_some_and(|entries| entries.len() != values.len()))
            {
                record_pin_error(
                    errors,
                    format!(
                        "pins[{}].risks[{}].when option '{}' must be a value or value array.",
                        pin_index, risk_index, menu
                    ),
                );
                valid = false;
                continue;
            }
            let mut seen = HashSet::new();
            for selected_value in values {
                if !is_valid_fqbn_token(selected_value)
                    || !seen.insert(selected_value)
                    || !allowed.contains(selected_value)
                {
                    record_pin_error(
                        errors,
                        format!(
                            "pins[{}].risks[{}].when option '{}={}' is duplicate, unsafe or absent from custom_menus.",
                            pin_index, risk_index, menu, selected_value
                        ),
                    );
                    valid = false;
                }
            }
        }
    }
    if let Some(features) = features {
        const ALLOWED_FEATURES: &[&str] = &["wifi"];
        if features.is_empty() || features.len() > 16 {
            record_pin_error(
                errors,
                format!(
                    "pins[{}].risks[{}].when.features must contain between 1 and 16 features.",
                    pin_index, risk_index
                ),
            );
            valid = false;
        }
        let mut seen = HashSet::new();
        for feature in features {
            let Some(feature) = feature.as_str() else {
                record_pin_error(
                    errors,
                    format!(
                        "pins[{}].risks[{}].when.features must contain only identifiers.",
                        pin_index, risk_index
                    ),
                );
                valid = false;
                continue;
            };
            if !is_valid_fqbn_token(feature)
                || !seen.insert(feature)
                || !ALLOWED_FEATURES.contains(&feature)
            {
                record_pin_error(
                    errors,
                    format!(
                        "pins[{}].risks[{}].when.features entry '{}' is duplicate, unsafe or unsupported.",
                        pin_index, risk_index, feature
                    ),
                );
                valid = false;
            }
        }
    }
    valid
}

fn inspect_board_menus(
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let Some(menus) = json
        .get("custom_menus")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let mut valid = true;
    for (menu_key, menu) in menus {
        if !is_valid_fqbn_token(menu_key) {
            valid = false;
        }
        let options = menu
            .get("options")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut values = HashSet::new();
        for option in &options {
            let value = option
                .get("value")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim();
            if !is_valid_fqbn_token(value) || !values.insert(value.to_string()) {
                valid = false;
            }
        }
        if options.is_empty() {
            valid = false;
        }
        if let Some(selected) = menu.get("selected").and_then(serde_json::Value::as_str) {
            if !values.contains(selected) {
                valid = false;
            }
        }
    }
    if valid {
        report.pass(
            "custom-menus",
            "Custom board menu defaults and values are consistent.",
        );
    } else {
        report.error(
            "invalid-custom-menus",
            "Custom menus require non-empty unique values and a valid selected default.",
        );
    }
}

fn board_manifest_menu_values(json: &serde_json::Value) -> BoardOptionSchema {
    json.get("custom_menus")
        .and_then(serde_json::Value::as_object)
        .map(|menus| {
            menus
                .iter()
                .map(|(key, menu)| {
                    let values = menu
                        .get("options")
                        .and_then(serde_json::Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|option| option.get("value"))
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect::<HashSet<_>>();
                    (key.clone(), values)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn option_map_matches_manifest_menus(
    options: &serde_json::Map<String, serde_json::Value>,
    menus: &BoardOptionSchema,
    require_complete: bool,
) -> bool {
    (!require_complete || options.len() == menus.len())
        && options.iter().all(|(key, value)| {
            is_valid_fqbn_token(key)
                && value.as_str().is_some_and(|value| {
                    is_valid_fqbn_token(value)
                        && menus.get(key).is_some_and(|values| values.contains(value))
                })
        })
}

fn find_forbidden_smoke_key(value: &serde_json::Value) -> Option<String> {
    const FORBIDDEN: &[&str] = &[
        "command",
        "commands",
        "args",
        "env",
        "environment",
        "hook",
        "hooks",
        "script",
        "shell",
        "powershell",
    ];
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if FORBIDDEN
                    .iter()
                    .any(|forbidden| key.eq_ignore_ascii_case(forbidden))
                {
                    return Some(key.clone());
                }
                if let Some(found) = find_forbidden_smoke_key(child) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(values) => values.iter().find_map(find_forbidden_smoke_key),
        _ => None,
    }
}

fn inspect_board_validation_contract(
    root: &std::path::Path,
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let menus = board_manifest_menu_values(json);
    let variants = json
        .get("hardware_variants")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let profiles = json
        .get("validation_profiles")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let smokes = json
        .get("smoke_tests")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_passport_extension = [
        "hardware_variants",
        "validation_profiles",
        "smoke_tests",
        "validation_matrix",
    ]
    .iter()
    .any(|key| json.get(*key).is_some());
    let mut validation_ok = true;
    if has_passport_extension && (variants.is_empty() || profiles.is_empty() || smokes.is_empty()) {
        report.error(
            "incomplete-board-validation-contract",
            "Passport extensions require non-empty hardware_variants, validation_profiles, and smoke_tests together.",
        );
        validation_ok = false;
    }

    let collect_unique_ids = |values: &[serde_json::Value]| -> Option<HashSet<String>> {
        let mut ids = HashSet::new();
        for value in values {
            let id = value.get("id")?.as_str()?.trim();
            if !package_quality::valid_package_id(id, false) || !ids.insert(id.to_string()) {
                return None;
            }
        }
        Some(ids)
    };
    let variant_ids = collect_unique_ids(&variants);
    let profile_ids = collect_unique_ids(&profiles);
    let smoke_ids = collect_unique_ids(&smokes);
    for (kind, present, ids) in [
        ("hardware variant", !variants.is_empty(), &variant_ids),
        ("validation profile", !profiles.is_empty(), &profile_ids),
        ("smoke test", !smokes.is_empty(), &smoke_ids),
    ] {
        if present && ids.is_none() {
            report.error(
                "invalid-validation-id",
                format!("Every {} requires a unique path-safe id.", kind),
            );
            validation_ok = false;
        }
    }
    let variant_ids = variant_ids.unwrap_or_default();
    let profile_ids = profile_ids.unwrap_or_default();
    let smoke_ids = smoke_ids.unwrap_or_default();

    for profile in &profiles {
        let id = profile["id"].as_str().unwrap_or("<unknown>");
        let hardware = profile["hardware_variant"].as_str().unwrap_or_default();
        let options = profile["options"].as_object();
        if !variant_ids.contains(hardware)
            || profile["options_complete"].as_bool() != Some(true)
            || options
                .is_none_or(|options| !option_map_matches_manifest_menus(options, &menus, true))
        {
            report.error(
                "invalid-validation-profile",
                format!(
                    "Profile '{}' requires an existing hardware_variant, options_complete: true, and a complete valid menu option map.",
                    id
                ),
            );
            validation_ok = false;
        }
        let referenced_smokes = profile["smoke_tests"].as_array();
        if referenced_smokes.is_none_or(|values| {
            values.is_empty()
                || values.iter().any(|value| {
                    value
                        .as_str()
                        .is_none_or(|value| !smoke_ids.contains(value))
                })
        }) {
            report.error(
                "invalid-profile-smoke-reference",
                format!("Profile '{}' references missing or empty smoke tests.", id),
            );
            validation_ok = false;
        }
    }

    for variant in &variants {
        let id = variant["id"].as_str().unwrap_or("<unknown>");
        let default_profile = variant["default_profile"].as_str().unwrap_or_default();
        let default_matches = profiles.iter().any(|profile| {
            profile["id"].as_str() == Some(default_profile)
                && profile["hardware_variant"].as_str() == Some(id)
        });
        let expected_hardware_valid =
            variant["expected_hardware"]
                .as_object()
                .is_some_and(|expected| {
                    expected
                        .get("chip")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|chip| !chip.trim().is_empty())
                        && expected
                            .get("flash_bytes")
                            .and_then(serde_json::Value::as_u64)
                            .is_some_and(|bytes| bytes >= 1024)
                        && expected
                            .get("psram_bytes")
                            .is_none_or(|bytes| bytes.as_u64().is_some())
                });
        let fixed_valid = variant["fixed_options"].as_object().is_none_or(|fixed| {
            option_map_matches_manifest_menus(fixed, &menus, false)
                && profiles
                    .iter()
                    .filter(|profile| profile["hardware_variant"].as_str() == Some(id))
                    .all(|profile| {
                        profile["options"].as_object().is_some_and(|options| {
                            fixed
                                .iter()
                                .all(|(key, value)| options.get(key) == Some(value))
                        })
                    })
        });
        if !default_matches || !fixed_valid || !expected_hardware_valid {
            report.error(
                "invalid-hardware-variant",
                format!(
                    "Hardware variant '{}' has an invalid default profile or fixed_options mismatch.",
                    id
                ),
            );
            validation_ok = false;
        }
    }

    for smoke in &smokes {
        let id = smoke["id"].as_str().unwrap_or("<unknown>");
        let mode = smoke["mode"].as_str().unwrap_or_default();
        let mode_valid = matches!(mode, "compile-only" | "device-upload" | "serial-runtime");
        let consent_valid =
            mode == "compile-only" || smoke["requires_user_consent"].as_bool() == Some(true);
        let path_valid = smoke["sketch"]
            .as_str()
            .and_then(package_quality::safe_relative_path)
            .is_some_and(|relative| {
                relative
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("ino"))
                    && std::fs::symlink_metadata(root.join(relative))
                        .ok()
                        .is_some_and(|metadata| {
                            metadata.file_type().is_file()
                                && !metadata.file_type().is_symlink()
                                && metadata.len() > 0
                                && metadata.len() <= 1024 * 1024
                        })
            });
        let profile_refs_valid = smoke["profiles"].as_array().is_none_or(|values| {
            !values.is_empty()
                && values.iter().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|value| profile_ids.contains(value))
                })
        });
        let timeout_valid = smoke["timeout_seconds"]
            .as_u64()
            .is_some_and(|seconds| (1..=900).contains(&seconds));
        let resource_limits_valid = smoke["resource_limits"].as_object().is_none_or(|limits| {
            limits.iter().all(|(key, value)| match key.as_str() {
                "max_flash_bytes" | "max_ram_bytes" => {
                    value.as_u64().is_some_and(|bytes| bytes > 0)
                }
                "max_warnings" => value.as_u64().is_some_and(|count| count <= 10_000),
                _ => false,
            })
        });
        if !mode_valid
            || !consent_valid
            || !path_valid
            || !profile_refs_valid
            || !timeout_valid
            || !resource_limits_valid
            || find_forbidden_smoke_key(smoke).is_some()
        {
            report.error(
                "invalid-smoke-test",
                format!(
                    "Smoke test '{}' violates path, mode, consent, profile-reference, size, or no-command rules.",
                    id
                ),
            );
            validation_ok = false;
        }
    }

    if let Some(matrix) = json
        .get("validation_matrix")
        .and_then(serde_json::Value::as_object)
    {
        let max_cases_valid = matrix
            .get("max_cases")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|value| (1..=64).contains(&value));
        let required_profile_ref_valid = |value: &serde_json::Value| {
            value
                .as_str()
                .is_some_and(|value| profile_ids.contains(value))
        };
        let smoke_refs_valid = |value: Option<&serde_json::Value>| {
            value
                .and_then(serde_json::Value::as_array)
                .is_none_or(|values| {
                    !values.is_empty()
                        && values.iter().all(|value| {
                            value
                                .as_str()
                                .is_some_and(|value| smoke_ids.contains(value))
                        })
                })
        };
        let groups_valid = matrix
            .get("groups")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|groups| {
                groups.iter().all(|group| {
                    required_profile_ref_valid(&group["base_profile"])
                        && smoke_refs_valid(group.get("smoke_tests"))
                        && group["dimensions"].as_object().is_some_and(|dimensions| {
                            !dimensions.is_empty()
                                && dimensions.iter().all(|(key, values)| {
                                    values.as_array().is_some_and(|values| {
                                        !values.is_empty()
                                            && values.iter().all(|value| {
                                                value.as_str().is_some_and(|value| {
                                                    menus.get(key).is_some_and(|allowed| {
                                                        allowed.contains(value)
                                                    })
                                                })
                                            })
                                    })
                                })
                        })
                })
            });
        let include_valid = matrix
            .get("include")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|entries| {
                entries.iter().all(|entry| {
                    (required_profile_ref_valid(&entry["profile"])
                        || required_profile_ref_valid(&entry["base_profile"]))
                        && smoke_refs_valid(entry.get("smoke_tests"))
                        && entry["options"].as_object().is_none_or(|options| {
                            option_map_matches_manifest_menus(options, &menus, false)
                        })
                })
            });
        let exclude_valid = matrix
            .get("exclude")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|entries| {
                entries.iter().all(|entry| {
                    entry["base_profile"]
                        .as_str()
                        .is_none_or(|value| profile_ids.contains(value))
                        && entry["when"].as_object().is_some_and(|options| {
                            option_map_matches_manifest_menus(options, &menus, false)
                        })
                        && entry["reason"]
                            .as_str()
                            .is_some_and(|reason| !reason.trim().is_empty())
                })
            });
        let strategy_valid = matrix
            .get("strategy")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|strategy| matches!(strategy, "include-only" | "bounded-pairwise"));
        if !max_cases_valid || !strategy_valid || !groups_valid || !include_valid || !exclude_valid
        {
            report.error(
                "invalid-validation-matrix",
                "Validation matrix exceeds 64 cases or references unknown profiles/smoke tests.",
            );
            validation_ok = false;
        }
    }

    if validation_ok && (!profiles.is_empty() || !smokes.is_empty() || !variants.is_empty()) {
        report.pass(
            "board-validation-contract",
            format!(
                "{} hardware variant(s), {} profile(s), and {} controlled smoke test(s) passed the import gate.",
                variants.len(), profiles.len(), smokes.len()
            ),
        );
    }
}

fn inspect_board_extends(
    root: &std::path::Path,
    json: &serde_json::Value,
    report: &mut package_quality::PackageQualityReport,
) {
    let Some(extends) = json.get("extends").and_then(serde_json::Value::as_str) else {
        return;
    };
    let Some(relative) = package_quality::safe_relative_path(extends) else {
        report.error(
            "unsafe-extends-path",
            "Board extends must be a package-relative path and cannot contain '..'.",
        );
        return;
    };
    if root.join(relative).is_dir() {
        report.pass(
            "board-extends",
            "Extended board assets exist inside the package.",
        );
    } else {
        report.error(
            "missing-extends-path",
            format!("Board extends path '{}' does not exist.", extends),
        );
    }
}

fn inspect_bundled_board_libraries(
    root: &std::path::Path,
    report: &mut package_quality::PackageQualityReport,
) {
    let libraries = root.join("libraries");
    if !libraries.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(&libraries) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) => {
            report.error(
                "unreadable-bundled-libraries",
                format!("Cannot read bundled libraries: {}", error),
            );
            return;
        }
    };
    let mut count = 0usize;
    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        count += 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.join("library.json").is_file() {
            report.error(
                "invalid-bundled-library",
                format!("Bundled library '{}' is missing library.json.", name),
            );
            continue;
        }
        let child = lib_custom_registry::inspect_library_package(
            &path,
            path.join("ck-blocks.json").is_file(),
        );
        for check in child.checks {
            let code = format!("bundled-library/{}/{}", name, check.code);
            let message = format!("Bundled library '{}': {}", name, check.message);
            match check.status.as_str() {
                "error" => report.error(&code, message),
                "warning" => report.warn(&code, message),
                _ => {}
            }
        }
    }
    if count > 0 {
        report.pass(
            "bundled-libraries",
            format!("{} bundled library package(s) were inspected.", count),
        );
    }
}

#[cfg(test)]
mod board_package_quality_tests {
    use super::*;

    #[test]
    fn quality_gate_accepts_the_distributed_board_example() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_nano_board");
        let report = inspect_board_package(&root);
        assert_eq!(
            report.status, "passed_with_warnings",
            "{:#?}",
            report.checks
        );
        assert_eq!(report.error_count, 0);
        assert!(report.source_content_sha256.is_some());
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "missing-detailed-pin-metadata")
        );
    }

    #[test]
    fn quality_gate_accepts_the_c6_multi_profile_example() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_c6_board");
        let report = inspect_board_package(&root);
        assert_ne!(report.status, "failed", "{:#?}", report.checks);
        assert_eq!(report.error_count, 0, "{:#?}", report.checks);
        let manifest = board_passport::board_manifest(&root).unwrap();
        let profiles = board_passport::profiles_from_manifest(&manifest, "pending_compile")
            .expect("C6 validation profiles");
        assert_eq!(profiles.len(), 3);
        assert!(
            profiles
                .iter()
                .all(|profile| profile.fqbn.starts_with("esp32:esp32:esp32c6:"))
        );
    }

    #[test]
    fn pin_gate_accepts_precise_metadata_and_checked_menu_conditions() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({
                "custom_menus": {
                    "USBMode": {
                        "selected": "enabled",
                        "options": [
                            {"value": "enabled"},
                            {"value": "disabled"}
                        ]
                    }
                },
                "pins": [{
                    "label": "D12 / USB D-",
                    "value": "12",
                    "aliases": ["GPIO12", "IO12"],
                    "capabilities": ["digital", "usb"],
                    "risks": [{
                        "code": "usb-active",
                        "severity": "warning",
                        "title": "Native USB is active",
                        "detail": "GPIO output may interrupt the USB connection.",
                        "roles": ["digital-output"],
                        "when": {"options": {"USBMode": ["enabled"]}}
                    }],
                    "reserved_by": ["native-usb", "integrated-jtag"],
                    "sharing": "exclusive",
                    "connector": {"id": "J1", "side": "left", "position": 7.5},
                    "source": "publisher-declaration",
                    "evidence": [{
                        "kind": "board-definition",
                        "reference": "board.json#pins/0",
                        "locator": "J1.7"
                    }]
                }]
            }),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "passed", "{:#?}", report.checks);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "detailed-pin-metadata")
        );
    }

    #[test]
    fn pin_gate_rejects_duplicate_or_empty_reservation_lists() {
        for reserved_by in [
            serde_json::json!(["native-usb", "NATIVE-USB"]),
            serde_json::json!(["native-usb", ""]),
            serde_json::json!([]),
        ] {
            let mut report = package_quality::PackageQualityReport::new("board");
            inspect_board_pins(
                &serde_json::json!({
                    "pins": [{
                        "label": "D12 / USB D-",
                        "value": "12",
                        "capabilities": ["digital", "usb"],
                        "risks": [{
                            "code": "usb-active",
                            "severity": "warning",
                            "title": "Native USB is active"
                        }],
                        "reserved_by": reserved_by,
                        "source": "publisher-declaration"
                    }]
                }),
                &mut report,
            );
            report.finalize();
            assert_eq!(report.status, "failed", "{:#?}", report.checks);
            assert!(
                report
                    .checks
                    .iter()
                    .any(|check| check.code == "invalid-pin-metadata")
            );
        }
    }

    #[test]
    fn pin_gate_rejects_expressions_and_noncanonical_numeric_tokens() {
        for value in [
            "13); injected(); //",
            "-1",
            "01",
            "0x10",
            "GPIO 2",
            "PIN+1",
            "A0/*comment*/",
            "__CK_PIN_UNDECLARED__",
        ] {
            let mut report = package_quality::PackageQualityReport::new("board");
            inspect_board_pins(
                &serde_json::json!({"pins": [{"label": "Unsafe", "value": value}]}),
                &mut report,
            );
            report.finalize();
            assert_eq!(
                report.status, "failed",
                "value={value}: {:#?}",
                report.checks
            );
            assert!(
                report
                    .checks
                    .iter()
                    .any(|check| check.code == "invalid-pin-catalog")
            );
        }
    }

    #[test]
    fn pin_gate_accepts_decimal_or_identifier_code_tokens() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({
                "pins": [
                    {"label": "Zero", "value": "0"},
                    {"label": "GPIO 13", "value": "13"},
                    {"label": "Analog zero", "value": "A0"},
                    {"label": "Named pin", "value": "_LED_PIN"},
                    {"label": "ESP enum", "value": "GPIO_NUM_2"}
                ]
            }),
            &mut report,
        );
        report.finalize();
        assert_ne!(report.status, "failed", "{:#?}", report.checks);
        assert_eq!(report.error_count, 0, "{:#?}", report.checks);
    }

    #[test]
    fn pin_gate_rejects_ambiguous_aliases_and_unverified_risk_conditions() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({
                "custom_menus": {
                    "USBMode": {
                        "options": [{"value": "enabled"}]
                    }
                },
                "pins": [
                    {
                        "label": "D12",
                        "value": "12",
                        "aliases": ["GPIO12"],
                        "capabilities": ["digital"],
                        "source": "datasheet"
                    },
                    {
                        "label": "D13",
                        "value": "13",
                        "aliases": ["gpio12"],
                        "capabilities": ["digital"],
                        "risks": [{
                            "code": "usb-active",
                            "severity": "danger",
                            "title": "USB risk",
                            "when": {"options": {"USBMode": "missing"}}
                        }],
                        "source": "datasheet"
                    }
                ]
            }),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "failed", "{:#?}", report.checks);
        let error = report
            .checks
            .iter()
            .find(|check| check.code == "invalid-pin-metadata")
            .expect("invalid pin metadata check");
        assert!(error.message.contains("conflicts"));
        assert!(error.message.contains("severity"));
        assert!(error.message.contains("absent from custom_menus"));
    }

    #[test]
    fn pin_gate_accepts_supported_feature_risk_conditions_and_rejects_unknown_features() {
        let mut accepted = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({
                "pins": [{
                    "label": "ADC2",
                    "value": "4",
                    "capabilities": ["digital", "adc"],
                    "risks": [{
                        "code": "adc2-wifi-conflict",
                        "severity": "warning",
                        "title": "ADC2 is shared with WiFi",
                        "when": {"features": ["wifi"]}
                    }]
                }]
            }),
            &mut accepted,
        );
        accepted.finalize();
        assert_ne!(accepted.status, "failed", "{:#?}", accepted.checks);
        assert_eq!(accepted.error_count, 0, "{:#?}", accepted.checks);

        let mut rejected = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({
                "pins": [{
                    "label": "ADC2",
                    "value": "4",
                    "risks": [{
                        "code": "unknown-feature-risk",
                        "severity": "warning",
                        "title": "Unknown feature",
                        "when": {"features": ["future-radio"]}
                    }]
                }]
            }),
            &mut rejected,
        );
        rejected.finalize();
        assert_eq!(rejected.status, "failed", "{:#?}", rejected.checks);
        assert!(
            rejected
                .checks
                .iter()
                .any(|check| check.code == "invalid-pin-metadata")
        );
    }

    #[test]
    fn legacy_pin_catalog_is_warned_but_not_blocked() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_pins(
            &serde_json::json!({"pins": [{"label": "D13", "value": "13"}]}),
            &mut report,
        );
        report.finalize();
        assert_eq!(
            report.status, "passed_with_warnings",
            "{:#?}",
            report.checks
        );
        assert_eq!(report.error_count, 0);
        for code in [
            "missing-detailed-pin-metadata",
            "incomplete-pin-capabilities",
            "incomplete-pin-provenance",
        ] {
            assert!(report.checks.iter().any(|check| check.code == code));
        }
    }

    #[test]
    fn quality_gate_rejects_an_incompatible_core_contract() {
        let root =
            std::env::temp_dir().join(format!("ck_board_quality_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/board.png"), b"test").unwrap();
        std::fs::write(root.join("LICENSE"), b"test license").unwrap();
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": "quality_test_board",
            "name": "Quality test board",
            "version": "1.0.0",
            "description": "Tests board package quality checks",
            "vendor": "CK Tests",
            "architecture": "avr",
            "icon": "assets/board.png",
            "fqbn_base": "arduino:avr:nano",
            "arduino_core": {
                "package": "esp32:esp32",
                "version": "3.3.0",
                "index_url": "https://example.com/package.json"
            },
            "pins": [{ "label": "D13", "value": "13" }]
        });
        std::fs::write(
            root.join("board.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let report = inspect_board_package(&root);
        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "core-package-mismatch")
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn core_contract_requires_a_recommendation_and_explained_incompatibilities() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_core_contract(
            &serde_json::json!({
                "fqbn_base": "arduino:avr:nano",
                "architecture": "avr",
                "arduino_core": {
                    "package": "arduino:avr",
                    "version_range": ">=1.0.0",
                    "known_incompatible": ["1.8.6"]
                }
            }),
            &mut report,
        );
        report.finalize();

        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "missing-core-recommended-version")
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-core-known-incompatible")
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-core-version-range")
        );
    }

    #[test]
    fn board_icon_must_be_an_offline_package_asset() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_icon(
            std::path::Path::new("."),
            &serde_json::json!({ "icon": "https://example.com/board.png" }),
            &mut report,
        );
        report.finalize();

        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "remote-icon")
        );
    }

    #[test]
    fn quality_gate_rejects_executable_smoke_fields_and_unbounded_matrix() {
        let root =
            std::env::temp_dir().join(format!("ck_board_validation_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(root.join("smoke/basic")).unwrap();
        std::fs::write(root.join("assets/board.png"), b"test").unwrap();
        std::fs::write(
            root.join("smoke/basic/basic.ino"),
            b"void setup(){} void loop(){}",
        )
        .unwrap();
        std::fs::write(root.join("LICENSE"), b"test license").unwrap();
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": "unsafe_validation_board",
            "name": "Unsafe validation board",
            "version": "1.0.0",
            "description": "Exercises the Rust validation package gate",
            "vendor": "CK Tests",
            "architecture": "avr",
            "icon": "assets/board.png",
            "fqbn_base": "arduino:avr:nano",
            "arduino_core": {
                "package": "arduino:avr",
                "recommended_version": "1.8.6"
            },
            "pins": [{ "label": "D13", "value": "13" }],
            "custom_menus": {
                "cpu": {
                    "selected": "atmega328",
                    "options": [{"value": "atmega328"}]
                }
            },
            "hardware_variants": [{
                "id": "nano",
                "name": "Nano",
                "expected_hardware": {"chip": "ATmega328P", "flash_bytes": 512},
                "fixed_options": {"cpu": "atmega328"},
                "default_profile": "nano-default"
            }],
            "validation_profiles": [{
                "id": "nano-default",
                "name": "Nano default",
                "hardware_variant": "nano",
                "options_complete": true,
                "options": {"cpu": "atmega328"},
                "smoke_tests": ["basic"]
            }],
            "smoke_tests": [{
                "id": "basic",
                "name": "Basic",
                "sketch": "smoke/basic/basic.ino",
                "mode": "compile-only",
                "timeout_seconds": 60,
                "command": "powershell.exe"
            }],
            "validation_matrix": {
                "strategy": "include-only",
                "max_cases": 65,
                "include": [{"profile": "nano-default"}]
            }
        });
        std::fs::write(
            root.join("board.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let report = inspect_board_package(&root);
        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-smoke-test")
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-validation-matrix")
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-hardware-variant")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn passport_extension_requires_variants_profiles_and_smokes_together() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_validation_contract(
            std::path::Path::new("."),
            &serde_json::json!({"validation_profiles": []}),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "incomplete-board-validation-contract")
        );
    }

    #[test]
    fn core_gate_rejects_unknown_incompatibility_range_keys() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_core_contract(
            &serde_json::json!({
                "fqbn_base": "vendor:arch:board",
                "arduino_core": {
                    "package": "vendor:arch",
                    "recommended_version": "2.0.0",
                    "known_incompatible": [{
                        "version_range": {"bogus": "2.1.0"},
                        "reason": "Must not be silently discarded"
                    }],
                    "index_url": "https://example.com/package.json"
                }
            }),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-core-known-incompatible")
        );
    }

    #[test]
    fn validation_contract_allows_an_empty_complete_option_map_when_board_has_no_menus() {
        let root = std::env::temp_dir().join(format!(
            "ck_board_no_menu_validation_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("smoke")).unwrap();
        std::fs::write(root.join("smoke/basic.ino"), "void setup(){} void loop(){}").unwrap();
        let manifest = serde_json::json!({
            "hardware_variants": [{
                "id": "plain",
                "expected_hardware": {"chip": "MCU", "flash_bytes": 32768},
                "default_profile": "plain-default"
            }],
            "validation_profiles": [{
                "id": "plain-default",
                "name": "Plain",
                "hardware_variant": "plain",
                "options_complete": true,
                "options": {},
                "smoke_tests": ["basic"]
            }],
            "smoke_tests": [{
                "id": "basic",
                "mode": "compile-only",
                "sketch": "smoke/basic.ino",
                "timeout_seconds": 60
            }]
        });
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_validation_contract(&root, &manifest, &mut report);
        report.finalize();
        assert_ne!(report.status, "failed", "{:#?}", report.checks);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn menu_gate_rejects_fqbn_separator_characters() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_menus(
            &serde_json::json!({
                "custom_menus": {
                    "Flash Size": {
                        "selected": "4M,bad",
                        "options": [{"value": "4M,bad"}]
                    }
                }
            }),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "failed");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "invalid-custom-menus")
        );
    }

    #[test]
    fn http_core_index_is_an_explicit_warning_not_a_hard_block() {
        let mut report = package_quality::PackageQualityReport::new("board");
        inspect_board_core_contract(
            &serde_json::json!({
                "fqbn_base": "vendor:arch:board",
                "arduino_core": {
                    "package": "vendor:arch",
                    "recommended_version": "1.0.0",
                    "index_url": "http://intranet.example/package.json"
                }
            }),
            &mut report,
        );
        report.finalize();
        assert_eq!(report.status, "passed_with_warnings");
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "insecure-core-index-url")
        );
    }

    #[test]
    fn board_package_subdir_is_resolved_inside_the_extracted_repository() {
        let root =
            std::env::temp_dir().join(format!("ck_board_subdir_test_{}", uuid::Uuid::new_v4()));
        let repository = root.join("owner-repo-hash");
        let board = repository.join("packages/board-one");
        std::fs::create_dir_all(&board).unwrap();
        std::fs::write(board.join("board.json"), "{}").unwrap();

        assert_eq!(
            resolve_board_package_source(&root, Some("packages/board-one")).unwrap(),
            std::fs::canonicalize(&board).unwrap()
        );
        assert!(resolve_board_package_source(&root, Some("../outside")).is_err());
        assert!(resolve_board_package_source(&root, Some("packages/../../outside")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_repository_subdir_rejects_path_traversal() {
        assert_eq!(
            normalize_cloud_repo_subdir("packages/boards").unwrap(),
            Some("packages/boards".to_string())
        );
        assert_eq!(normalize_cloud_repo_subdir("/").unwrap(), None);
        assert!(normalize_cloud_repo_subdir("../outside").is_err());
        assert!(normalize_cloud_repo_subdir("packages/../../outside").is_err());
    }

    #[test]
    fn board_install_commit_replaces_board_and_bundled_libraries_together() {
        let root =
            std::env::temp_dir().join(format!("ck_board_commit_test_{}", uuid::Uuid::new_v4()));
        let target_board = root.join("boards/example");
        let target_libraries = root.join("board-libraries/example");
        let staged_board = root.join("staged-board");
        let staged_libraries = root.join("staged-libraries");
        for path in [
            &target_board,
            &target_libraries,
            &staged_board,
            &staged_libraries,
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(target_board.join("version.txt"), "old").unwrap();
        std::fs::write(target_libraries.join("version.txt"), "old").unwrap();
        std::fs::write(staged_board.join("version.txt"), "new").unwrap();
        std::fs::write(staged_libraries.join("version.txt"), "new").unwrap();

        commit_board_package_install(
            &staged_board,
            &target_board,
            Some(&staged_libraries),
            &target_libraries,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(target_board.join("version.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(target_libraries.join("version.txt")).unwrap(),
            "new"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}

fn install_board_package_from_zip(
    app: &AppHandle,
    zip_path: &std::path::Path,
    preferred_subdir: Option<&str>,
) -> Result<String, String> {
    use tauri::Manager;

    let app_data_dir = crate::app_storage::desktop_dir(&app)
        .map_err(|e| format!("Failed to resolve AppData: {}", e))?;
    let boards_dir = app_data_dir.join("CK").join("boards");
    install_board_package_archive_into(zip_path, preferred_subdir, &boards_dir, &ck_root_dir())
}

/// Install one already-downloaded board archive into explicit roots. Keeping
/// the roots injectable makes the complete ZIP -> quality reports -> staged
/// board/libraries -> atomic commit path testable without ever writing into a
/// developer's real AppData or Documents/CK directories.
fn install_board_package_archive_into(
    zip_path: &std::path::Path,
    preferred_subdir: Option<&str>,
    boards_dir: &std::path::Path,
    ck_runtime_root: &std::path::Path,
) -> Result<String, String> {
    use std::fs;

    let source_package_sha256 = board_passport::hash_file(zip_path)?;
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {}", e))?;
    package_quality::validate_zip_archive(
        &mut archive,
        10_000,
        128 * 1024 * 1024,
        512 * 1024 * 1024,
    )?;

    if !boards_dir.exists() {
        fs::create_dir_all(&boards_dir).map_err(|e| e.to_string())?;
    }

    let temp_dir = boards_dir.join(format!("_temp_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let mut staged_libraries_cleanup: Option<std::path::PathBuf> = None;

    let res = (|| -> Result<String, String> {
        archive
            .extract(&temp_dir)
            .map_err(|e| format!("Extraction failed: {}", e))?;

        let final_source = resolve_board_package_source(&temp_dir, preferred_subdir)?;
        let mut quality_report = inspect_board_package(&final_source);
        quality_report.enforce()?;
        let source_content_sha256 = quality_report
            .source_content_sha256
            .clone()
            .ok_or("Board package source content hash is missing")?;

        let json_content =
            fs::read_to_string(final_source.join("board.json")).map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(strip_utf8_bom(&json_content))
            .map_err(|e| format!("Invalid board.json: {}", e))?;

        let id = json["id"]
            .as_str()
            .ok_or("board.json missing 'id' field")?
            .to_string();
        let safe_id = id;

        let target_dir = boards_dir.join(&safe_id);
        // Board-package bundled libraries -> dedicated directory
        // Documents/CK/board-package-libraries/<board_id>/*
        let bundled_libs_path = final_source.join("libraries");
        let target_lib_root = ck_runtime_root
            .join("board-package-libraries")
            .join(&safe_id);
        if bundled_libs_path.exists() && bundled_libs_path.is_dir() {
            let staged_lib_root = target_lib_root
                .parent()
                .ok_or("Invalid board library install root")?
                .join(format!(".ck-staging-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&staged_lib_root).map_err(|e| e.to_string())?;
            staged_libraries_cleanup = Some(staged_lib_root.clone());
            let mut installed_ids = HashSet::new();
            let mut bundled_count = 0usize;

            for entry in fs::read_dir(&bundled_libs_path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let child_report = lib_custom_registry::inspect_library_package(
                    &path,
                    path.join("ck-blocks.json").is_file(),
                );
                child_report.enforce()?;
                package_quality::write_quality_report(&path, &child_report)?;
                let child_manifest_raw = fs::read_to_string(path.join("library.json"))
                    .map_err(|e| format!("Failed to read bundled library.json: {}", e))?;
                let child_manifest: serde_json::Value =
                    serde_json::from_str(strip_utf8_bom(&child_manifest_raw))
                        .map_err(|e| format!("Invalid bundled library.json: {}", e))?;
                let child_id = child_manifest["id"]
                    .as_str()
                    .ok_or("Bundled library.json missing 'id'")?;
                if !package_quality::valid_package_id(child_id, false) {
                    return Err(format!("Invalid bundled library id: {}", child_id));
                }
                if !installed_ids.insert(child_id.to_string()) {
                    return Err(format!("Duplicate bundled library id: {}", child_id));
                }
                let dest = staged_lib_root.join(child_id);
                options::dir::move_dir(&path, &dest).map_err(|e| {
                    format!(
                        "Failed to install bundled board-package library {}: {}",
                        child_id, e
                    )
                })?;
                bundled_count += 1;
            }
            if bundled_count == 0 {
                let _ = fs::remove_dir_all(&staged_lib_root);
                staged_libraries_cleanup = None;
            }
        }

        let installed_content_sha256 = board_passport::hash_installed_contents(
            &final_source,
            staged_libraries_cleanup.as_deref(),
        )?;
        quality_report.source_content_sha256 =
            Some(package_quality::hash_package_contents(&final_source)?);
        package_quality::write_quality_report(&final_source, &quality_report)?;
        let core_requirement = board_passport::ArduinoCoreRequirement::from_manifest_value(
            json.get("arduino_core")
                .ok_or("board.json missing 'arduino_core' field")?,
        )?;
        let core_status =
            board_passport::evaluate_core_compatibility(ck_runtime_root, &core_requirement);
        let passport = board_passport::create_passport(
            &json,
            source_package_sha256.clone(),
            source_content_sha256,
            installed_content_sha256,
            core_status.clone(),
        )?;
        board_passport::write_passport(&final_source, &passport)?;

        commit_board_package_install(
            &final_source,
            &target_dir,
            staged_libraries_cleanup.as_deref(),
            &target_lib_root,
        )?;
        staged_libraries_cleanup = None;

        let ret = serde_json::json!({
            "id": safe_id,
            "name": json["name"].as_str().unwrap_or(""),
            "version": json["version"].as_str().unwrap_or(""),
            "vendor": json["vendor"].as_str().or_else(|| json["author"].as_str()).unwrap_or(""),
            "fqbn_base": json["fqbn_base"].as_str().unwrap_or(""),
            "icon": json["icon"].as_str().unwrap_or(""),
            "pins": json["pins"].clone(),
            "arduino_core": json["arduino_core"],
            "quality_report": quality_report,
            "core_status": core_status,
            "passport": passport,
            "usable": core_status.usable
        });
        let mut ret = ret;
        if let Some(graph) = json.get("resource_graph") {
            ret["resource_graph"] = graph.clone();
        }
        Ok(ret.to_string())
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    if let Some(path) = staged_libraries_cleanup {
        let _ = fs::remove_dir_all(path);
    }
    res
}

#[cfg(test)]
mod distributed_board_package_fixture_tests {
    use super::*;

    #[test]
    fn c6_board_zip_installs_deep_native_library_into_exact_build_scope() {
        let fixture_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages");
        let archive = fixture_root.join("ck_example_c6_board.zip");
        assert!(
            archive.is_file(),
            "missing distributed fixture: {}",
            archive.display()
        );

        let temp_root =
            std::env::temp_dir().join(format!("ck-board-native-e2e-{}", uuid::Uuid::new_v4()));
        let boards_dir = temp_root.join("app-data/CK/boards");
        let ck_runtime_root = temp_root.join("ck-runtime");
        let board_id = "ck_example_c6_board";
        let library_id = "ck_example_c6_native";
        let installed_board = boards_dir.join(board_id);
        let installed_library = ck_runtime_root
            .join("board-package-libraries")
            .join(board_id)
            .join(library_id);

        // Prove that the same transaction replaces both halves and does not
        // leave a previous board-scoped dependency behind.
        std::fs::create_dir_all(&installed_board).unwrap();
        std::fs::write(installed_board.join("stale-board.txt"), "old").unwrap();
        std::fs::create_dir_all(installed_library.parent().unwrap().join("stale_library")).unwrap();
        std::fs::write(
            installed_library
                .parent()
                .unwrap()
                .join("stale_library/stale.txt"),
            "old",
        )
        .unwrap();

        let payload =
            install_board_package_archive_into(&archive, None, &boards_dir, &ck_runtime_root)
                .expect("distributed C6 board fixture must install into isolated roots");
        let installed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(installed["id"], board_id);

        assert!(installed_board.join("board.json").is_file());
        assert!(!installed_board.join("stale-board.txt").exists());
        assert!(installed_library.join("library.json").is_file());
        assert!(installed_library.join("library.properties").is_file());
        assert!(installed_library.join("src/CKExampleC6Native.c").is_file());
        assert!(
            installed_library
                .join("src/vendor/protocol/codec.c")
                .is_file()
        );
        assert!(
            !installed_library
                .parent()
                .unwrap()
                .join("stale_library")
                .exists()
        );
        assert!(
            !installed_board.join("libraries").join(library_id).exists(),
            "bundled libraries must be moved out of the board manifest directory"
        );

        let board_report = package_quality::read_quality_report_with_integrity(&installed_board)
            .expect("installed board quality report");
        assert_eq!(board_report.package_kind, "board");
        assert_eq!(board_report.package_id.as_deref(), Some(board_id));
        assert!(matches!(
            board_report.status.as_str(),
            "passed" | "passed_with_warnings"
        ));

        let library_report =
            package_quality::read_quality_report_with_integrity(&installed_library)
                .expect("installed child quality report");
        assert_eq!(library_report.package_kind, "arduino-library");
        assert_eq!(library_report.package_id.as_deref(), Some(library_id));
        assert!(matches!(
            library_report.status.as_str(),
            "passed" | "passed_with_warnings"
        ));
        assert!(
            library_report
                .validated_consumers
                .iter()
                .any(|consumer| consumer == "compile-resolver")
        );

        // Use the same header scan and candidate resolver as a foreground
        // build. Only the exact custom board directory is offered here; no
        // sibling sharing by the common esp32:esp32:esp32c6 FQBN is involved.
        let candidate = LibraryCandidate {
            path: installed_library.clone(),
            headers: scan_library_headers(&installed_library),
            source: LibSource::BoardSpecific,
            meta: load_library_candidate_meta(&installed_library),
        };
        assert!(candidate.headers.contains("CKExampleC6Native.h"));
        let resolved = resolve_ck_library_candidates(
            &["CKExampleC6Native.h".to_string()],
            &[candidate],
            "esp32",
        );
        assert_eq!(resolved.final_libs, vec![installed_library]);
        assert!(resolved.include_not_in_ck.is_empty());

        let _ = std::fs::remove_dir_all(temp_root);
    }
}

async fn post_import_board_prewarm(app: &AppHandle, payload: &str) {
    match get_app_sysroot().await {
        Ok(sysroot_obj) => {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                let usable = json["usable"].as_bool().unwrap_or(false);
                if usable {
                    if let Some(base_fqbn) =
                        json["fqbn_base"].as_str().and_then(normalize_base_fqbn)
                    {
                        if let Err(e) = remember_active_board_for_prewarm(&sysroot_obj, &base_fqbn)
                        {
                            log::warn!(
                                "[AUTO PREWARM] import_board remember_active_board_for_prewarm failed for {}: {}",
                                base_fqbn,
                                e
                            );
                        }
                        compile_accel::enqueue_default_prewarm(sysroot_obj.clone(), base_fqbn)
                            .await;
                    }
                } else {
                    log::info!(
                        "[AUTO PREWARM] Imported board is not environment-ready; prewarm deferred"
                    );
                }
            }

            if let Err(e) = sync_prewarm_boards_from_installed_internal(app, &sysroot_obj).await {
                log::warn!("[AUTO PREWARM] import_board sync failed: {}", e);
            }
        }
        Err(e) => {
            log::warn!("[AUTO PREWARM] import_board cannot load sysroot: {}", e);
        }
    }
}

#[derive(Debug, Clone)]
enum CloudRepoProvider {
    Github,
    Gitee,
}

#[derive(Debug, Clone)]
struct CloudRepoTarget {
    provider: CloudRepoProvider,
    owner: String,
    repo: String,
    branch: String,
    subdir: Option<String>,
}

#[derive(Debug, Clone)]
struct CloudBoardImportTarget {
    zip_url: String,
    subdir: Option<String>,
}

fn normalize_cloud_repo_subdir(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let relative = package_quality::safe_relative_path(trimmed)
        .filter(|path| {
            path.components()
                .any(|component| component != std::path::Component::CurDir)
        })
        .ok_or_else(|| format!("Unsafe cloud repository subdirectory: {}", raw))?;
    Ok(Some(relative.to_string_lossy().replace('\\', "/")))
}

fn resolve_cloud_provider(
    raw_url: &str,
    provider: Option<String>,
) -> Result<CloudRepoProvider, String> {
    let normalized = provider
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_lowercase();
    if normalized.is_empty() || normalized == "auto" {
        if raw_url.contains("gitee.com") {
            return Ok(CloudRepoProvider::Gitee);
        }
        return Ok(CloudRepoProvider::Github);
    }
    match normalized.as_str() {
        "github" => Ok(CloudRepoProvider::Github),
        "gitee" => Ok(CloudRepoProvider::Gitee),
        _ => Err("Unsupported provider. Use auto/github/gitee.".to_string()),
    }
}

async fn resolve_cloud_repo_target(
    url: &str,
    provider: Option<String>,
) -> Result<CloudRepoTarget, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("Cloud repository URL is empty".to_string());
    }
    if raw.ends_with(".zip") {
        return Err(
            "ZIP URL does not support package listing. Please use repository URL or /tree URL."
                .to_string(),
        );
    }

    let selected = resolve_cloud_provider(raw, provider)?;
    let client = reqwest::Client::builder()
        .user_agent("CK-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    match selected {
        CloudRepoProvider::Github => {
            let tree_re =
                Regex::new(r"^https?://github\.com/([^/]+)/([^/#?]+)/(?:tree)/([^/]+)(?:/(.*))?$")
                    .map_err(|e| e.to_string())?;
            if let Some(cap) = tree_re.captures(raw) {
                let owner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let repo = cap
                    .get(2)
                    .map(|m| m.as_str().trim_end_matches(".git"))
                    .unwrap_or("");
                let branch = cap.get(3).map(|m| m.as_str()).unwrap_or("main");
                let subdir = cap
                    .get(4)
                    .map(|m| normalize_cloud_repo_subdir(m.as_str()))
                    .transpose()?
                    .flatten();
                if owner.is_empty() || repo.is_empty() {
                    return Err("Invalid GitHub tree URL".to_string());
                }
                return Ok(CloudRepoTarget {
                    provider: CloudRepoProvider::Github,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    branch: branch.to_string(),
                    subdir,
                });
            }

            let repo_re =
                Regex::new(r"^https?://github\.com/([^/]+)/([^/#?]+?)(?:\.git)?/?(?:[#?].*)?$")
                    .map_err(|e| e.to_string())?;
            let cap = repo_re.captures(raw).ok_or(
                "Unsupported GitHub URL format. Use repository URL or /tree/<branch>/<path>.",
            )?;
            let owner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let repo = cap
                .get(2)
                .map(|m| m.as_str().trim_end_matches(".git"))
                .unwrap_or("");
            if owner.is_empty() || repo.is_empty() {
                return Err("Invalid GitHub repository URL".to_string());
            }

            let api_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
            let resp = client
                .get(&api_url)
                .send()
                .await
                .map_err(|e| format!("Failed to query GitHub repository: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "GitHub repository query failed: HTTP {}",
                    resp.status().as_u16()
                ));
            }
            let repo_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let branch = repo_json["default_branch"].as_str().unwrap_or("main");

            Ok(CloudRepoTarget {
                provider: CloudRepoProvider::Github,
                owner: owner.to_string(),
                repo: repo.to_string(),
                branch: branch.to_string(),
                subdir: None,
            })
        }
        CloudRepoProvider::Gitee => {
            let tree_re =
                Regex::new(r"^https?://gitee\.com/([^/]+)/([^/#?]+)/(?:tree)/([^/]+)(?:/(.*))?$")
                    .map_err(|e| e.to_string())?;
            if let Some(cap) = tree_re.captures(raw) {
                let owner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let repo = cap
                    .get(2)
                    .map(|m| m.as_str().trim_end_matches(".git"))
                    .unwrap_or("");
                let branch = cap.get(3).map(|m| m.as_str()).unwrap_or("master");
                let subdir = cap
                    .get(4)
                    .map(|m| normalize_cloud_repo_subdir(m.as_str()))
                    .transpose()?
                    .flatten();
                if owner.is_empty() || repo.is_empty() {
                    return Err("Invalid Gitee tree URL".to_string());
                }
                return Ok(CloudRepoTarget {
                    provider: CloudRepoProvider::Gitee,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    branch: branch.to_string(),
                    subdir,
                });
            }

            let repo_re =
                Regex::new(r"^https?://gitee\.com/([^/]+)/([^/#?]+?)(?:\.git)?/?(?:[#?].*)?$")
                    .map_err(|e| e.to_string())?;
            let cap = repo_re.captures(raw).ok_or(
                "Unsupported Gitee URL format. Use repository URL or /tree/<branch>/<path>.",
            )?;
            let owner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let repo = cap
                .get(2)
                .map(|m| m.as_str().trim_end_matches(".git"))
                .unwrap_or("");
            if owner.is_empty() || repo.is_empty() {
                return Err("Invalid Gitee repository URL".to_string());
            }

            let api_url = format!("https://gitee.com/api/v5/repos/{}/{}", owner, repo);
            let resp = client
                .get(&api_url)
                .send()
                .await
                .map_err(|e| format!("Failed to query Gitee repository: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "Gitee repository query failed: HTTP {}",
                    resp.status().as_u16()
                ));
            }
            let repo_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let branch = repo_json["default_branch"].as_str().unwrap_or("master");

            Ok(CloudRepoTarget {
                provider: CloudRepoProvider::Gitee,
                owner: owner.to_string(),
                repo: repo.to_string(),
                branch: branch.to_string(),
                subdir: None,
            })
        }
    }
}

async fn resolve_cloud_board_import_target(
    url: &str,
    provider: Option<String>,
) -> Result<CloudBoardImportTarget, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("Cloud repository URL is empty".to_string());
    }
    if raw.ends_with(".zip") {
        return Ok(CloudBoardImportTarget {
            zip_url: raw.to_string(),
            subdir: None,
        });
    }

    let repo_target = resolve_cloud_repo_target(raw, provider).await?;
    let zip_url = match repo_target.provider {
        CloudRepoProvider::Github => format!(
            "https://codeload.github.com/{}/{}/zip/refs/heads/{}",
            repo_target.owner, repo_target.repo, repo_target.branch
        ),
        CloudRepoProvider::Gitee => format!(
            "https://gitee.com/{}/{}/repository/archive/{}.zip",
            repo_target.owner, repo_target.repo, repo_target.branch
        ),
    };

    Ok(CloudBoardImportTarget {
        zip_url,
        subdir: repo_target.subdir,
    })
}

#[derive(serde::Serialize, Debug, Clone)]
struct CloudBoardRegistryEntry {
    id: String,
    name: String,
    description: String,
    fqbn_base: String,
    subdir: String,
    tree_url: String,
    source_repo_url: String,
}

#[tauri::command]
async fn search_board_packages_from_github(
    url: String,
    provider: Option<String>,
) -> Result<Vec<CloudBoardRegistryEntry>, String> {
    let target = resolve_cloud_repo_target(&url, provider).await?;

    let client = reqwest::Client::builder()
        .user_agent("CK-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let tree_url = match target.provider {
        CloudRepoProvider::Github => format!(
            "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
            target.owner, target.repo, target.branch
        ),
        CloudRepoProvider::Gitee => format!(
            "https://gitee.com/api/v5/repos/{}/{}/git/trees/{}?recursive=1",
            target.owner, target.repo, target.branch
        ),
    };

    let tree_resp = client
        .get(&tree_url)
        .send()
        .await
        .map_err(|e| format!("Failed to query cloud repository tree: {}", e))?;
    if !tree_resp.status().is_success() {
        return Err(format!(
            "Cloud repository tree query failed: HTTP {}",
            tree_resp.status().as_u16()
        ));
    }

    let tree_json: serde_json::Value = tree_resp.json().await.map_err(|e| e.to_string())?;
    let tree_arr = tree_json["tree"]
        .as_array()
        .ok_or("Cloud tree response missing 'tree' array")?;

    let subdir_filter = target
        .subdir
        .as_ref()
        .map(|s| s.trim_matches('/').replace('\\', "/"))
        .filter(|s| !s.is_empty());

    let mut board_manifest_paths: Vec<String> = Vec::new();
    for node in tree_arr {
        if node["type"].as_str() != Some("blob") {
            continue;
        }
        let Some(path) = node["path"].as_str() else {
            continue;
        };
        if !path.ends_with("board.json") {
            continue;
        }
        let normalized_path = path.trim_matches('/').replace('\\', "/");
        if let Some(filter) = &subdir_filter {
            if normalized_path != format!("{}/board.json", filter)
                && !normalized_path.starts_with(&format!("{}/", filter))
            {
                continue;
            }
        }
        board_manifest_paths.push(normalized_path);
    }

    board_manifest_paths.sort();
    board_manifest_paths.dedup();

    if board_manifest_paths.is_empty() {
        return Err("No board package found in repository (board.json not found).".to_string());
    }

    let mut entries: Vec<CloudBoardRegistryEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for manifest_path in board_manifest_paths {
        let raw_manifest_url = match target.provider {
            CloudRepoProvider::Github => format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                target.owner, target.repo, target.branch, manifest_path
            ),
            CloudRepoProvider::Gitee => format!(
                "https://gitee.com/{}/{}/raw/{}/{}",
                target.owner, target.repo, target.branch, manifest_path
            ),
        };

        let manifest_resp = match client.get(&raw_manifest_url).send().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !manifest_resp.status().is_success() {
            continue;
        }

        let manifest_text = match manifest_resp.text().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_str(strip_utf8_bom(&manifest_text)) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let subdir = std::path::Path::new(&manifest_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .trim_matches('/')
            .replace('\\', "/");
        let fallback_id = if subdir.is_empty() {
            target.repo.clone()
        } else {
            std::path::Path::new(&subdir)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&target.repo)
                .to_string()
        };

        let id = json["id"].as_str().unwrap_or(&fallback_id).to_string();
        let dedupe_key = format!("{}::{}", id.to_lowercase(), subdir.to_lowercase());
        if !seen.insert(dedupe_key) {
            continue;
        }

        let name = json["name"].as_str().unwrap_or(&id).to_string();
        let description = json["description"].as_str().unwrap_or("").to_string();
        let fqbn_base = json["fqbn_base"].as_str().unwrap_or("").to_string();
        let tree_url = if subdir.is_empty() {
            match target.provider {
                CloudRepoProvider::Github => format!(
                    "https://github.com/{}/{}/tree/{}",
                    target.owner, target.repo, target.branch
                ),
                CloudRepoProvider::Gitee => format!(
                    "https://gitee.com/{}/{}/tree/{}",
                    target.owner, target.repo, target.branch
                ),
            }
        } else {
            match target.provider {
                CloudRepoProvider::Github => format!(
                    "https://github.com/{}/{}/tree/{}/{}",
                    target.owner, target.repo, target.branch, subdir
                ),
                CloudRepoProvider::Gitee => format!(
                    "https://gitee.com/{}/{}/tree/{}/{}",
                    target.owner, target.repo, target.branch, subdir
                ),
            }
        };

        let source_repo_url = match target.provider {
            CloudRepoProvider::Github => {
                format!("https://github.com/{}/{}", target.owner, target.repo)
            }
            CloudRepoProvider::Gitee => {
                format!("https://gitee.com/{}/{}", target.owner, target.repo)
            }
        };

        entries.push(CloudBoardRegistryEntry {
            id,
            name,
            description,
            fqbn_base,
            subdir,
            tree_url,
            source_repo_url,
        });
    }

    if entries.is_empty() {
        return Err(
            "Found board.json files, but failed to parse valid board manifests.".to_string(),
        );
    }

    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.to_lowercase().cmp(&b.id.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
async fn import_board(app: AppHandle, path: String) -> Result<String, String> {
    let zip_path = std::path::PathBuf::from(path);
    let res = install_board_package_from_zip(&app, &zip_path, None);
    if let Ok(payload) = &res {
        invalidate_board_definition_caches();
        post_import_board_prewarm(&app, payload).await;
    }
    res
}

#[tauri::command]
async fn import_board_from_github(
    app: AppHandle,
    url: String,
    provider: Option<String>,
) -> Result<String, String> {
    use std::io::Write;

    let target = resolve_cloud_board_import_target(&url, provider).await?;
    let client = reqwest::Client::builder()
        .user_agent("CK-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&target.zip_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download board package zip: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Board package download failed: HTTP {}",
            resp.status().as_u16()
        ));
    }

    let temp_zip = std::env::temp_dir().join(format!("ck_board_{}.zip", uuid::Uuid::new_v4()));
    {
        let mut file = std::fs::File::create(&temp_zip)
            .map_err(|e| format!("Failed to create temp zip: {}", e))?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read downloaded zip bytes: {}", e))?;
        file.write_all(&bytes)
            .map_err(|e| format!("Failed to write temp zip: {}", e))?;
    }

    let res = install_board_package_from_zip(&app, &temp_zip, target.subdir.as_deref());
    let _ = std::fs::remove_file(&temp_zip);

    if let Ok(payload) = &res {
        invalidate_board_definition_caches();
        post_import_board_prewarm(&app, payload).await;
    }
    res
}

const BOARD_DELETE_ID_MAX_BYTES: usize = 128;

/// Resolve only one exact package directory under the board roots. FQBN is a
/// separate identity and must never be rewritten into a package ID because
/// that can collide with a legitimate underscore-containing package name.
fn normalize_board_delete_directory_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Board ID cannot be empty.".to_string());
    }
    if trimmed != value {
        return Err("Board ID must not contain leading or trailing whitespace.".to_string());
    }
    if trimmed.len() > BOARD_DELETE_ID_MAX_BYTES {
        return Err(format!(
            "Board ID exceeds the {} byte limit.",
            BOARD_DELETE_ID_MAX_BYTES
        ));
    }
    if package_quality::valid_package_id(trimmed, false) {
        return Ok(trimmed.to_string());
    }
    Err("Invalid board package ID.".to_string())
}

fn board_delete_target(
    root: &std::path::Path,
    value: &str,
) -> Result<(String, std::path::PathBuf), String> {
    let directory_id = normalize_board_delete_directory_id(value)?;
    let target = root.join(&directory_id);
    if target == root || target.parent() != Some(root) {
        return Err("Refusing to resolve a board deletion outside its root.".to_string());
    }
    Ok((directory_id, target))
}

fn deletion_metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    let mut reparse_or_symlink = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        reparse_or_symlink |= metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    reparse_or_symlink
}

fn absolute_deletion_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|current| current.join(path))
        .map_err(|error| format!("Failed to resolve deletion path: {}", error))
}

/// Validate every existing lexical ancestor before canonicalization. Checking
/// only the leaf is insufficient because `root/ordinary-child` can still live
/// outside the trusted tree when `root` or one of its parents is a junction.
fn canonical_plain_directory_chain(
    directory: &std::path::Path,
    label: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let absolute = absolute_deletion_path(directory)?;
    let mut ancestors = absolute.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    let mut missing_ancestor = false;
    for ancestor in ancestors {
        let metadata = match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_ancestor = true;
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect {} ancestor '{}': {}",
                    label,
                    ancestor.display(),
                    error
                ));
            }
        };
        if missing_ancestor {
            return Err(format!(
                "Refusing {} because a child exists below a missing ancestor.",
                label
            ));
        }
        // A filesystem/volume root is a trust anchor, not a deletable child.
        // Do not reject a legitimate Windows drive or Unix root as a reparse
        // point, but every descendant must be a plain directory.
        let is_volume_root = ancestor.parent().is_none();
        if !is_volume_root && deletion_metadata_is_link_or_reparse(&metadata) {
            return Err(format!(
                "Refusing {} because ancestor '{}' is a symlink or reparse point.",
                label,
                ancestor.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Refusing {} because ancestor '{}' is not a directory.",
                label,
                ancestor.display()
            ));
        }
    }
    if missing_ancestor {
        return Ok(None);
    }
    let canonical = std::fs::canonicalize(&absolute)
        .map_err(|error| format!("Failed to canonicalize {}: {}", label, error))?;
    Ok(Some(canonical))
}

fn validated_deletion_target_exists(
    root: &std::path::Path,
    target: &std::path::Path,
    label: &str,
) -> Result<bool, String> {
    let canonical_root = canonical_plain_directory_chain(root, &format!("{} root", label))?;
    let canonical_target = canonical_plain_directory_chain(target, label)?;
    match (canonical_root, canonical_target) {
        (_, None) => Ok(false),
        (None, Some(_)) => Err(format!(
            "Refusing {} because its root does not exist.",
            label
        )),
        (Some(root), Some(target)) => {
            if target == root || target.parent() != Some(root.as_path()) {
                return Err(format!(
                    "Refusing {} because its canonical path is not a strict direct child of its canonical root.",
                    label
                ));
            }
            Ok(true)
        }
    }
}

fn validate_plain_settings_path(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Compile acceleration settings path has no parent.")?;
    let canonical_parent = canonical_plain_directory_chain(parent, "compiler settings directory")?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect compiler settings file '{}': {}",
                path.display(),
                error
            ));
        }
    };
    if canonical_parent.is_none() {
        return Err("Compiler settings file exists below a missing directory.".to_string());
    }
    if deletion_metadata_is_link_or_reparse(&metadata) {
        return Err("Compiler settings file must not be a symlink or reparse point.".to_string());
    }
    if !metadata.is_file() {
        return Err("Compiler settings path must be a regular file.".to_string());
    }
    Ok(())
}

fn normalize_board_manifest_fqbn_base(value: &str) -> Option<String> {
    let parts = value.trim().split(':').map(str::trim).collect::<Vec<_>>();
    (parts.len() == 3
        && parts
            .iter()
            .all(|part| package_quality::valid_package_id(part, false)))
    .then(|| parts.join(":"))
}

fn normalize_legacy_board_manifest_fqbn_base(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.contains('/') || trimmed.contains('\\') {
        return None;
    }
    let parts = trimmed.split(':').map(str::trim).collect::<Vec<_>>();
    if parts.len() < 3
        || parts[..3]
            .iter()
            .any(|part| !package_quality::valid_package_id(part, false))
        || parts[3..].iter().any(|part| part.is_empty())
    {
        return None;
    }
    Some(parts[..3].join(":"))
}

fn read_installed_board_fqbn_base(
    board_dir: &std::path::Path,
    expected_directory_id: &str,
) -> Result<String, String> {
    let manifest_path = board_dir.join("board.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "Cannot read installed board manifest before deletion: {}",
            error
        )
    })?;
    let manifest: serde_json::Value = serde_json::from_str(strip_utf8_bom(&raw))
        .map_err(|error| format!("Invalid installed board.json: {}", error))?;
    let manifest_id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Installed board.json requires its package id before deletion.")?;
    let manifest_directory_id = normalize_board_delete_directory_id(manifest_id)
        .map_err(|_| "Installed board.json contains an invalid package id.".to_string())?;
    if manifest_directory_id != expected_directory_id {
        return Err(format!(
            "Installed board.json id '{}' does not match directory '{}'.",
            manifest_id, expected_directory_id
        ));
    }
    let modern_base = match manifest
        .get("fqbn_base")
        .and_then(serde_json::Value::as_str)
    {
        Some(value) => Some(normalize_board_manifest_fqbn_base(value).ok_or_else(|| {
            "Installed board.json fqbn_base must be a safe three-part base FQBN.".to_string()
        })?),
        None => None,
    };
    let legacy_base = match manifest.get("fqbn").and_then(serde_json::Value::as_str) {
        Some(value) => Some(
            normalize_legacy_board_manifest_fqbn_base(value)
                .ok_or_else(|| "Installed board.json legacy fqbn is invalid.".to_string())?,
        ),
        None => None,
    };
    match (modern_base, legacy_base) {
        (Some(modern), Some(legacy)) if modern != legacy => Err(format!(
            "Installed board.json fqbn_base '{}' conflicts with legacy fqbn base '{}'.",
            modern, legacy
        )),
        (Some(modern), _) => Ok(modern),
        (None, Some(legacy)) => Ok(legacy),
        (None, None) => Err("Installed board.json requires fqbn_base before deletion.".to_string()),
    }
}

#[derive(Debug)]
struct BoardPackageDeletionOutcome {
    fqbn_base: Option<String>,
    log: Vec<String>,
}

fn preflight_board_deletion_roots(
    boards_root: &std::path::Path,
    runtime_root: &std::path::Path,
    value: &str,
) -> Result<(), String> {
    let (directory_id, board_dir) = board_delete_target(boards_root, value)?;
    let package_root = runtime_root.join("board-package-libraries");
    let legacy_root = runtime_root.join("libraries");
    let (_, package_library_dir) = board_delete_target(&package_root, &directory_id)?;
    let (_, legacy_library_dir) = board_delete_target(&legacy_root, &directory_id)?;
    validated_deletion_target_exists(boards_root, &board_dir, "board package")?;
    validated_deletion_target_exists(
        &package_root,
        &package_library_dir,
        "board-package libraries",
    )?;
    validated_deletion_target_exists(&legacy_root, &legacy_library_dir, "legacy board libraries")?;
    Ok(())
}

/// Delete from injected roots so safety and cleanup behavior can be exercised
/// without ever touching the developer's real AppData or Documents/CK.
fn delete_board_package_from_roots(
    boards_root: &std::path::Path,
    runtime_root: &std::path::Path,
    value: &str,
    missing_is_error: bool,
) -> Result<BoardPackageDeletionOutcome, String> {
    preflight_board_deletion_roots(boards_root, runtime_root, value)?;
    let (directory_id, board_dir) = board_delete_target(boards_root, value)?;
    let (_, package_library_dir) =
        board_delete_target(&runtime_root.join("board-package-libraries"), &directory_id)?;
    let (_, legacy_library_dir) =
        board_delete_target(&runtime_root.join("libraries"), &directory_id)?;
    let mut log = Vec::new();

    // Inspect every recursive target before removing the first one. This keeps
    // a linked library path from turning an otherwise safe uninstall into a
    // partial deletion after the board directory has already disappeared.
    let board_exists = validated_deletion_target_exists(boards_root, &board_dir, "board package")?;
    let package_libraries_exist = validated_deletion_target_exists(
        &runtime_root.join("board-package-libraries"),
        &package_library_dir,
        "board-package libraries",
    )?;
    let legacy_libraries_exist = validated_deletion_target_exists(
        &runtime_root.join("libraries"),
        &legacy_library_dir,
        "legacy board libraries",
    )?;

    let fqbn_base = if board_exists {
        // Capture the package's own target identity while its signed-off
        // manifest still exists. A corrupt manifest is safer to leave in place
        // than to delete and lose the only deterministic cleanup identity.
        let fqbn_base = read_installed_board_fqbn_base(&board_dir, &directory_id)?;
        std::fs::remove_dir_all(&board_dir).map_err(|error| {
            format!(
                "Failed to remove board package '{}': {}",
                directory_id, error
            )
        })?;
        log.push(format!("Removed board package '{}'.", directory_id));
        Some(fqbn_base)
    } else if missing_is_error {
        return Err(format!("Board package '{}' was not found.", directory_id));
    } else {
        log.push(format!("Board package '{}' was not found.", directory_id));
        None
    };

    for (label, path, exists) in [
        (
            "board-package libraries",
            package_library_dir,
            package_libraries_exist,
        ),
        (
            "legacy board libraries",
            legacy_library_dir,
            legacy_libraries_exist,
        ),
    ] {
        if !exists {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => log.push(format!("Removed {} for '{}'.", label, directory_id)),
            Err(error) => log.push(format!(
                "Warning: board package was removed, but {} cleanup for '{}' failed: {}",
                label, directory_id, error
            )),
        }
    }

    Ok(BoardPackageDeletionOutcome { fqbn_base, log })
}

fn remove_learned_prewarm_targets_for_base(
    sysroot_root: &std::path::PathBuf,
    fqbn_base: &str,
) -> Result<usize, String> {
    let normalized_base = normalize_board_manifest_fqbn_base(fqbn_base)
        .ok_or("Cannot clean learned targets for an invalid base FQBN.")?;
    compile_accel::update_settings(sysroot_root, |settings| {
        let before = settings.prewarm_boards.len();
        settings.prewarm_boards.retain(|target| {
            normalize_base_fqbn(target).as_deref() != Some(normalized_base.as_str())
        });
        before.saturating_sub(settings.prewarm_boards.len())
    })
}

/// Inventory synchronization is useful but not authoritative for deletion.
/// The direct atomic settings update always runs afterwards, including when
/// Arduino CLI discovery failed.
fn finalize_deleted_board_prewarm_cleanup(
    sysroot_root: &std::path::PathBuf,
    fqbn_base: Option<&str>,
    sync_result: Result<Vec<String>, String>,
    log: &mut Vec<String>,
) -> Result<(), String> {
    if let Err(error) = sync_result {
        log.push(format!(
            "Warning: installed-board synchronization failed after deletion: {}",
            error
        ));
    }

    let Some(fqbn_base) = fqbn_base else {
        log.push(
            "Warning: no installed board manifest remained, so no package-specific learned target identity was available."
                .to_string(),
        );
        return Ok(());
    };
    match remove_learned_prewarm_targets_for_base(sysroot_root, fqbn_base) {
        Ok(removed) => {
            log.push(format!(
                "Removed {} learned compile target(s) for '{}'.",
                removed, fqbn_base
            ));
            Ok(())
        }
        Err(error) => {
            let warning = format!(
                "Warning: learned compile target cleanup for '{}' failed: {}",
                fqbn_base, error
            );
            log.push(warning.clone());
            Err(warning)
        }
    }
}

async fn delete_board_package_command(
    app: &AppHandle,
    value: &str,
    missing_is_error: bool,
) -> Result<String, String> {
    use tauri::Manager;

    // Validate before resolving or touching any filesystem root.
    normalize_board_delete_directory_id(value)?;
    let app_data_dir = crate::app_storage::desktop_dir(&app)
        .map_err(|error| format!("Failed to resolve AppData: {}", error))?;
    let boards_root = app_data_dir.join("CK").join("boards");
    let runtime_root = ck_root_dir();
    // This preflight runs before Sysroot::init, because initialization itself
    // may create files below the CK root. A linked ancestor must not receive
    // either cache writes or later recursive deletes.
    preflight_board_deletion_roots(&boards_root, &runtime_root, value)?;
    validate_plain_settings_path(&ck_core::builder::accel::compile_accel_path(&runtime_root))?;
    // Resolve the settings root before recursively deleting anything. This
    // avoids a partial success where the package identity is gone but its
    // learned complete targets can no longer be located deterministically.
    let sysroot = get_app_sysroot().await?;
    let canonical_runtime = canonical_plain_directory_chain(&runtime_root, "CK runtime root")?
        .ok_or("CK runtime root was not created by sysroot initialization.")?;
    let canonical_sysroot =
        canonical_plain_directory_chain(&sysroot.root_dir, "compiler sysroot root")?
            .ok_or("Compiler sysroot root does not exist.")?;
    if canonical_runtime != canonical_sysroot {
        return Err("Compiler sysroot does not match the validated CK runtime root.".to_string());
    }
    validate_plain_settings_path(&ck_core::builder::accel::compile_accel_path(
        &sysroot.root_dir,
    ))?;
    let mut outcome =
        delete_board_package_from_roots(&boards_root, &runtime_root, value, missing_is_error)?;

    invalidate_board_definition_caches();
    let sync_result = sync_prewarm_boards_from_installed_internal(app, &sysroot).await;
    if finalize_deleted_board_prewarm_cleanup(
        &sysroot.root_dir,
        outcome.fqbn_base.as_deref(),
        sync_result,
        &mut outcome.log,
    )
    .is_err()
    {
        return Err(outcome.log.join("\n"));
    }

    Ok(outcome.log.join("\n"))
}

#[tauri::command]
async fn uninstall_board(app: AppHandle, board_id: String) -> Result<String, String> {
    delete_board_package_command(&app, &board_id, false).await
}

#[cfg(test)]
mod board_deletion_safety_tests {
    use super::*;

    fn temporary_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "ck-board-delete-{}-{}-{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn deletion_id_accepts_only_an_exact_safe_package_id() {
        assert_eq!(
            normalize_board_delete_directory_id("vendor_board-1").as_deref(),
            Ok("vendor_board-1")
        );

        let oversized = "a".repeat(BOARD_DELETE_ID_MAX_BYTES + 1);
        for invalid in [
            "",
            "   ",
            " vendor_board ",
            ".",
            "..",
            "../board",
            "..\\board",
            "/absolute/board",
            "C:\\absolute\\board",
            "\\\\server\\share",
            "vendor/board",
            "vendor\\board",
            "vendor.board",
            "vendor:arch",
            "vendor:arch:board",
            "vendor:arch:../board",
            "vendor:arch:board:FlashSize=16M",
            oversized.as_str(),
        ] {
            assert!(
                normalize_board_delete_directory_id(invalid).is_err(),
                "unsafe ID was accepted: {invalid:?}"
            );
        }
    }

    #[test]
    fn invalid_id_can_never_resolve_to_or_delete_the_boards_root() {
        let root = temporary_root("root-guard");
        let boards = root.join("boards");
        std::fs::create_dir_all(boards.join("sentinel")).expect("sentinel");

        for invalid in ["", "   ", ".", "..", "../boards", "C:\\"] {
            assert!(board_delete_target(&boards, invalid).is_err());
            assert!(delete_board_package_from_roots(&boards, &root, invalid, true).is_err());
            assert!(boards.join("sentinel").is_dir());
        }

        let (id, target) = board_delete_target(&boards, "safe_board").expect("safe target");
        assert_eq!(id, "safe_board");
        assert_eq!(target.parent(), Some(boards.as_path()));
        assert_ne!(target, boards);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn injected_roots_delete_exact_package_and_capture_manifest_base_first() {
        let root = temporary_root("roots");
        let boards = root.join("app-data").join("CK").join("boards");
        let runtime = root.join("runtime");
        let board = boards.join("vendor_board");
        let sibling = boards.join("keep_me");
        let package_libraries = runtime.join("board-package-libraries").join("vendor_board");
        let legacy_libraries = runtime.join("libraries").join("vendor_board");
        std::fs::create_dir_all(&board).expect("board");
        std::fs::create_dir_all(&sibling).expect("sibling");
        std::fs::create_dir_all(&package_libraries).expect("package libraries");
        std::fs::create_dir_all(&legacy_libraries).expect("legacy libraries");
        std::fs::write(
            board.join("board.json"),
            r#"{"id":"vendor_board","fqbn_base":"vendor:arch:board"}"#,
        )
        .expect("manifest");
        std::fs::write(board.join("payload.txt"), "board").expect("payload");

        let outcome = delete_board_package_from_roots(&boards, &runtime, "vendor_board", true)
            .expect("delete exact package");
        assert_eq!(outcome.fqbn_base.as_deref(), Some("vendor:arch:board"));
        assert!(!board.exists());
        assert!(!package_libraries.exists());
        assert!(!legacy_libraries.exists());
        assert!(sibling.is_dir(), "sibling board must survive");
        assert!(
            outcome
                .log
                .iter()
                .any(|line| line.contains("Removed board package 'vendor_board'"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_manifest_blocks_deletion_before_identity_is_lost() {
        let root = temporary_root("manifest-guard");
        let boards = root.join("boards");
        let board = boards.join("vendor_board");
        std::fs::create_dir_all(&board).expect("board");
        std::fs::write(
            board.join("board.json"),
            r#"{"id":"vendor_board","fqbn_base":"../bad"}"#,
        )
        .expect("manifest");

        let error = delete_board_package_from_roots(&boards, &root, "vendor_board", true)
            .expect_err("invalid self identity must block deletion");
        assert!(error.contains("fqbn_base"));
        assert!(board.is_dir(), "package must remain recoverable");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mismatched_manifest_id_cannot_remove_another_bases_learned_targets() {
        let root = temporary_root("manifest-id-guard");
        let boards = root.join("boards");
        let board = boards.join("vendor_board");
        std::fs::create_dir_all(&board).expect("board");
        std::fs::write(
            board.join("board.json"),
            r#"{"id":"different_board","fqbn_base":"different:arch:board"}"#,
        )
        .expect("manifest");

        let error = delete_board_package_from_roots(&boards, &root, "vendor_board", true)
            .expect_err("mismatched self identity must block deletion");
        assert!(error.contains("does not match directory"));
        assert!(board.is_dir(), "selected package must remain recoverable");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_legacy_fqbn_is_normalized_but_conflicting_dual_identity_is_rejected() {
        let root = temporary_root("legacy-fqbn");
        let board = root.join("vendor_board");
        std::fs::create_dir_all(&board).expect("board");
        std::fs::write(
            board.join("board.json"),
            r#"{"id":"vendor_board","fqbn":"vendor:arch:board:FlashSize=16M"}"#,
        )
        .expect("legacy manifest");
        assert_eq!(
            read_installed_board_fqbn_base(&board, "vendor_board").as_deref(),
            Ok("vendor:arch:board")
        );

        std::fs::write(
            board.join("board.json"),
            r#"{"id":"vendor_board","fqbn_base":"vendor:arch:board","fqbn":"other:arch:board:Mode=default"}"#,
        )
        .expect("conflicting manifest");
        let error = read_installed_board_fqbn_base(&board, "vendor_board")
            .expect_err("conflicting identities must fail closed");
        assert!(error.contains("conflicts with legacy fqbn"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(any(windows, unix))]
    fn create_directory_link(
        target: &std::path::Path,
        link: &std::path::Path,
    ) -> Result<(), String> {
        #[cfg(windows)]
        {
            junction::create(target, link).map_err(|error| error.to_string())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).map_err(|error| error.to_string())
        }
    }

    #[cfg(any(windows, unix))]
    fn remove_directory_link(link: &std::path::Path) {
        #[cfg(windows)]
        {
            let _ = junction::delete(link);
        }
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(link);
        }
    }

    #[test]
    #[cfg(any(windows, unix))]
    fn board_and_library_links_are_rejected_before_external_sentinels_are_touched() {
        for linked_role in ["board", "package-library", "legacy-library"] {
            let root = temporary_root(linked_role);
            let boards = root.join("boards");
            let runtime = root.join("runtime");
            let board = boards.join("vendor_board");
            let package_library = runtime.join("board-package-libraries").join("vendor_board");
            let legacy_library = runtime.join("libraries").join("vendor_board");
            let external = root.join("external");
            std::fs::create_dir_all(&boards).expect("boards");
            std::fs::create_dir_all(package_library.parent().expect("package parent"))
                .expect("package parent");
            std::fs::create_dir_all(legacy_library.parent().expect("legacy parent"))
                .expect("legacy parent");
            std::fs::create_dir_all(&external).expect("external");
            std::fs::write(external.join("sentinel.txt"), "outside").expect("sentinel");

            if linked_role == "board" {
                create_directory_link(&external, &board).expect("board link");
            } else {
                std::fs::create_dir_all(&board).expect("board");
                std::fs::write(
                    board.join("board.json"),
                    r#"{"id":"vendor_board","fqbn_base":"vendor:arch:board"}"#,
                )
                .expect("manifest");
            }
            if linked_role == "package-library" {
                create_directory_link(&external, &package_library).expect("package library link");
            }
            if linked_role == "legacy-library" {
                create_directory_link(&external, &legacy_library).expect("legacy library link");
            }

            let error = delete_board_package_from_roots(&boards, &runtime, "vendor_board", true)
                .expect_err("linked recursive target must fail closed");
            assert!(error.contains("symlink or reparse point"));
            assert!(external.join("sentinel.txt").is_file());
            if linked_role != "board" {
                assert!(board.is_dir(), "preflight must prevent partial deletion");
            }

            for link in [&board, &package_library, &legacy_library] {
                if std::fs::symlink_metadata(link)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
                    || linked_role == "board" && link == &board
                    || linked_role == "package-library" && link == &package_library
                    || linked_role == "legacy-library" && link == &legacy_library
                {
                    remove_directory_link(link);
                }
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    #[cfg(any(windows, unix))]
    fn all_three_deletion_root_links_fail_before_any_target_is_removed() {
        for linked_root_role in ["boards-root", "package-root", "legacy-root"] {
            let root = temporary_root(linked_root_role);
            let boards_root = root.join("app-data").join("CK").join("boards");
            let runtime_root = root.join("runtime");
            let package_root = runtime_root.join("board-package-libraries");
            let legacy_root = runtime_root.join("libraries");
            let external_root = root.join("external-root");
            let external_target = external_root.join("vendor_board");
            std::fs::create_dir_all(&external_target).expect("external target");
            std::fs::write(external_target.join("sentinel.txt"), "outside").expect("sentinel");
            std::fs::write(
                external_target.join("board.json"),
                r#"{"id":"vendor_board","fqbn_base":"vendor:arch:board"}"#,
            )
            .expect("external manifest");

            for (role, deletion_root) in [
                ("boards-root", &boards_root),
                ("package-root", &package_root),
                ("legacy-root", &legacy_root),
            ] {
                std::fs::create_dir_all(deletion_root.parent().expect("root parent"))
                    .expect("root parent");
                if role == linked_root_role {
                    create_directory_link(&external_root, deletion_root).expect("root link");
                    continue;
                }
                let target = deletion_root.join("vendor_board");
                std::fs::create_dir_all(&target).expect("ordinary target");
                if role == "boards-root" {
                    std::fs::write(
                        target.join("board.json"),
                        r#"{"id":"vendor_board","fqbn_base":"vendor:arch:board"}"#,
                    )
                    .expect("ordinary manifest");
                }
                std::fs::write(target.join("ordinary-sentinel.txt"), "inside")
                    .expect("ordinary sentinel");
            }

            let error =
                delete_board_package_from_roots(&boards_root, &runtime_root, "vendor_board", true)
                    .expect_err("linked deletion root must fail closed");
            assert!(error.contains("symlink or reparse point"), "{error}");
            assert!(external_target.join("sentinel.txt").is_file());
            for (role, deletion_root) in [
                ("boards-root", &boards_root),
                ("package-root", &package_root),
                ("legacy-root", &legacy_root),
            ] {
                if role != linked_root_role {
                    assert!(
                        deletion_root
                            .join("vendor_board")
                            .join("ordinary-sentinel.txt")
                            .is_file()
                            || role == "boards-root" && deletion_root.join("vendor_board").is_dir(),
                        "preflight must preserve every ordinary sibling target"
                    );
                }
            }

            let linked_root = match linked_root_role {
                "boards-root" => &boards_root,
                "package-root" => &package_root,
                _ => &legacy_root,
            };
            remove_directory_link(linked_root);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    #[cfg(any(windows, unix))]
    fn linked_settings_ancestor_is_rejected_before_atomic_update() {
        let root = temporary_root("settings-root-link");
        let sysroot_root = root.join("sysroot");
        let external_state = root.join("external-state");
        let state_link = sysroot_root.join("state");
        std::fs::create_dir_all(&sysroot_root).expect("sysroot");
        std::fs::create_dir_all(&external_state).expect("external state");
        std::fs::write(external_state.join("sentinel.txt"), "outside").expect("sentinel");
        create_directory_link(&external_state, &state_link).expect("state link");

        let settings_path = ck_core::builder::accel::compile_accel_path(&sysroot_root);
        let error = validate_plain_settings_path(&settings_path)
            .expect_err("linked settings ancestor must fail closed");
        assert!(error.contains("symlink or reparse point"));
        assert!(external_state.join("sentinel.txt").is_file());

        remove_directory_link(&state_link);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cli_sync_failure_still_atomically_removes_only_matching_learned_targets() {
        let root = temporary_root("settings");
        let sysroot_root = root.join("sysroot");
        compile_accel::update_settings(&sysroot_root, |settings| {
            settings.prewarm_boards = vec![
                "vendor:arch:board:FlashSize=8M".to_string(),
                "vendor:arch:board:FlashSize=16M,PSRAM=enabled".to_string(),
                "vendor:arch:other:Mode=default".to_string(),
                "esp32:esp32:esp32c6:FlashSize=16M".to_string(),
            ];
        })
        .expect("seed settings");
        let mut log = Vec::new();

        finalize_deleted_board_prewarm_cleanup(
            &sysroot_root,
            Some("vendor:arch:board"),
            Err("Arduino CLI unavailable".to_string()),
            &mut log,
        )
        .expect("direct cleanup must still succeed");

        let settings = compile_accel::load_settings(&sysroot_root);
        assert_eq!(
            settings.prewarm_boards,
            vec![
                "vendor:arch:other:Mode=default".to_string(),
                "esp32:esp32:esp32c6:FlashSize=16M".to_string(),
            ]
        );
        assert!(log.iter().any(|line| {
            line.contains("Warning: installed-board synchronization failed after deletion")
        }));
        assert!(
            log.iter()
                .any(|line| line.contains("Removed 2 learned compile target(s)"))
        );
        assert!(ck_core::builder::accel::compile_accel_path(&sysroot_root).is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn settings_update_failure_is_reported_as_partial_not_complete_success() {
        let root = temporary_root("settings-failure");
        let sysroot_root = root.join("sysroot");
        let settings_path = ck_core::builder::accel::compile_accel_path(&sysroot_root);
        std::fs::create_dir_all(settings_path.parent().expect("state dir")).expect("state dir");
        std::fs::write(&settings_path, b"{broken settings").expect("corrupt settings");
        let mut log = vec!["Removed board package 'vendor_board'.".to_string()];

        assert!(
            finalize_deleted_board_prewarm_cleanup(
                &sysroot_root,
                Some("vendor:arch:board"),
                Ok(Vec::new()),
                &mut log,
            )
            .is_err()
        );
        assert!(
            log.iter()
                .any(|line| line.contains("Warning: learned compile target cleanup"))
        );
        assert_eq!(
            std::fs::read(&settings_path).expect("settings remain"),
            b"{broken settings",
            "atomic update must not overwrite corrupt settings on failure"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
async fn check_core_installed(package: String) -> Result<bool, String> {
    let sysroot = get_app_sysroot().await?;
    Ok(!board_passport::installed_core_versions(&sysroot.root_dir, &package).is_empty())
}

#[tauri::command]
async fn check_core_version_installed(package: String, version: String) -> Result<bool, String> {
    let sysroot = get_app_sysroot().await?;
    let expected = version.trim().trim_start_matches('v');
    Ok(
        board_passport::installed_core_versions(&sysroot.root_dir, &package)
            .iter()
            .any(|installed| installed.trim().trim_start_matches('v') == expected),
    )
}

#[tauri::command]
async fn check_core_compatibility(
    package: String,
    requirement: Option<serde_json::Value>,
) -> Result<board_passport::CoreCompatibilityReport, String> {
    let sysroot = get_app_sysroot().await?;
    let mut requirement = requirement.unwrap_or_else(|| serde_json::json!({}));
    let object = requirement
        .as_object_mut()
        .ok_or("Core compatibility requirement must be a JSON object")?;
    object.insert("package".to_string(), serde_json::Value::String(package));
    let parsed = board_passport::ArduinoCoreRequirement::from_manifest_value(&requirement)?;
    Ok(board_passport::evaluate_core_compatibility(
        &sysroot.root_dir,
        &parsed,
    ))
}

fn custom_board_roots(
    app: &AppHandle,
    board_id: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    if !package_quality::valid_package_id(board_id, false) {
        return Err("Invalid board id.".to_string());
    }
    let app_data_dir = crate::app_storage::desktop_dir(&app)
        .map_err(|error| format!("Failed to resolve AppData: {error}"))?;
    Ok((
        app_data_dir.join("CK").join("boards").join(board_id),
        ck_root_dir().join("board-package-libraries").join(board_id),
    ))
}

#[tauri::command]
async fn get_board_passport(
    app: AppHandle,
    board_id: String,
) -> Result<board_passport::BoardPassport, String> {
    let (board_root, library_root) = custom_board_roots(&app, &board_id)?;
    let manifest = board_passport::board_manifest(&board_root)?;
    let passport = board_passport::read_passport(&board_root)?;
    let sysroot = get_app_sysroot().await?;
    board_passport::evaluate_passport(
        passport,
        &manifest,
        &board_root,
        Some(&library_root),
        &sysroot.root_dir,
    )
}

#[derive(Debug, Clone, serde::Serialize)]
struct BoardQualificationProfileResult {
    profile_id: String,
    fqbn: String,
    resolved_fqbn: Option<String>,
    status: String,
    duration_ms: u64,
    message: String,
    evidence: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct BoardQualificationResult {
    board_id: String,
    status: String,
    core: board_passport::CoreCompatibilityReport,
    profiles: Vec<BoardQualificationProfileResult>,
    passport: board_passport::BoardPassport,
}

const BOARD_QUALIFICATION_SMOKE_CODE: &str = r#"#include <Arduino.h>

static volatile unsigned long ck_passport_probe = 0;

void setup() {
  ck_passport_probe = millis();
}

void loop() {
  ck_passport_probe ^= millis();
  delay(1);
}
"#;

fn sha256_text(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    hex::encode(digest.finalize())
}

fn qualification_partition_hash(build_path: &std::path::Path) -> Option<(String, String)> {
    walkdir::WalkDir::new(build_path)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .find(|entry| {
            entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("partitions.csv")
        })
        .and_then(|entry| {
            board_passport::hash_file(entry.path()).ok().map(|hash| {
                (
                    entry
                        .path()
                        .strip_prefix(build_path)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .replace('\\', "/"),
                    hash,
                )
            })
        })
}

#[derive(Debug, Clone)]
struct QualificationSmokeSource {
    id: String,
    code: String,
    declared: bool,
    max_flash_bytes: Option<u64>,
    max_ram_bytes: Option<u64>,
    max_warnings: Option<u64>,
    timeout_seconds: Option<u64>,
}

fn load_qualification_smokes(
    manifest: &serde_json::Value,
    board_root: &std::path::Path,
    profile: &board_passport::BoardPassportProfile,
) -> Result<(Vec<QualificationSmokeSource>, Vec<serde_json::Value>), String> {
    let declared = manifest
        .get("smoke_tests")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sources = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();
    for smoke_id in &profile.smoke_tests {
        if !seen.insert(smoke_id.clone()) {
            return Err(format!(
                "Validation profile '{}' repeats smoke test '{}'.",
                profile.id, smoke_id
            ));
        }
        let smoke = declared
            .iter()
            .find(|smoke| smoke["id"].as_str() == Some(smoke_id.as_str()))
            .ok_or_else(|| {
                format!(
                    "Validation profile '{}' references unknown smoke test '{}'.",
                    profile.id, smoke_id
                )
            })?;
        if let Some(profiles) = smoke["profiles"].as_array() {
            if !profiles
                .iter()
                .any(|value| value.as_str() == Some(profile.id.as_str()))
            {
                return Err(format!(
                    "Smoke test '{}' does not allow validation profile '{}'.",
                    smoke_id, profile.id
                ));
            }
        }
        let mode = smoke["mode"].as_str().unwrap_or_default();
        if mode != "compile-only" {
            if !matches!(mode, "device-upload" | "serial-runtime") {
                return Err(format!(
                    "Smoke test '{}' has unsupported mode '{}'.",
                    smoke_id, mode
                ));
            }
            skipped.push(serde_json::json!({
                "id": smoke_id,
                "mode": mode,
                "status": "skipped",
                "reason": "Explicit user consent and a selected physical device are required; qualification never auto-uploads.",
                "duration_ms": 0
            }));
            continue;
        }
        let relative_raw = smoke["sketch"]
            .as_str()
            .ok_or_else(|| format!("Smoke test '{}' has no sketch path.", smoke_id))?;
        let relative = package_quality::safe_relative_path(relative_raw).ok_or_else(|| {
            format!(
                "Smoke test '{}' sketch path '{}' is unsafe.",
                smoke_id, relative_raw
            )
        })?;
        if relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("ino"))
        {
            return Err(format!(
                "Smoke test '{}' must reference an Arduino .ino sketch.",
                smoke_id
            ));
        }
        let sketch_path = board_root.join(&relative);
        let metadata = std::fs::symlink_metadata(&sketch_path).map_err(|error| {
            format!(
                "Cannot inspect smoke test '{}' sketch {}: {}",
                smoke_id,
                sketch_path.display(),
                error
            )
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Smoke test '{}' sketch is not a regular package file.",
                smoke_id
            ));
        }
        if metadata.len() == 0 || metadata.len() > 1024 * 1024 {
            return Err(format!(
                "Smoke test '{}' sketch size {} is outside the 1..1048576 byte limit.",
                smoke_id,
                metadata.len()
            ));
        }
        let canonical_root = std::fs::canonicalize(board_root)
            .map_err(|error| format!("Cannot canonicalize board package: {error}"))?;
        let canonical_sketch = std::fs::canonicalize(&sketch_path)
            .map_err(|error| format!("Cannot canonicalize smoke sketch: {error}"))?;
        if !canonical_sketch.starts_with(&canonical_root) {
            return Err(format!(
                "Smoke test '{}' escapes the installed board package.",
                smoke_id
            ));
        }
        let code = std::fs::read_to_string(&canonical_sketch).map_err(|error| {
            format!(
                "Smoke test '{}' must be valid UTF-8 Arduino source: {}",
                smoke_id, error
            )
        })?;
        sources.push(QualificationSmokeSource {
            id: smoke_id.clone(),
            code,
            declared: true,
            max_flash_bytes: smoke
                .pointer("/resource_limits/max_flash_bytes")
                .and_then(serde_json::Value::as_u64),
            max_ram_bytes: smoke
                .pointer("/resource_limits/max_ram_bytes")
                .and_then(serde_json::Value::as_u64),
            max_warnings: smoke
                .pointer("/resource_limits/max_warnings")
                .and_then(serde_json::Value::as_u64),
            timeout_seconds: smoke["timeout_seconds"].as_u64(),
        });
    }

    if sources.is_empty() {
        sources.push(QualificationSmokeSource {
            id: "ck-controlled-minimal-v1".to_string(),
            code: BOARD_QUALIFICATION_SMOKE_CODE.to_string(),
            declared: false,
            max_flash_bytes: None,
            max_ram_bytes: None,
            max_warnings: None,
            timeout_seconds: None,
        });
    }
    Ok((sources, skipped))
}

fn qualification_resource_usage(
    compile_result: &serde_json::Value,
) -> (Option<u64>, Option<u64>, Option<u64>) {
    let log = compile_result["log"].as_str().unwrap_or_default();
    let (log_flash, log_ram) = compile_size_evidence(log);
    let flash = compile_result
        .pointer("/diagnostics/resources/flashUsedBytes")
        .and_then(serde_json::Value::as_u64)
        .or(log_flash);
    let ram = compile_result
        .pointer("/diagnostics/resources/ramUsedBytes")
        .and_then(serde_json::Value::as_u64)
        .or(log_ram);
    let warning_count = compile_result
        .pointer("/diagnostics/resources/warningCount")
        .and_then(serde_json::Value::as_u64);
    (flash, ram, warning_count)
}

fn qualification_budget_failures(
    smoke: &QualificationSmokeSource,
    flash_used_bytes: Option<u64>,
    ram_used_bytes: Option<u64>,
    warning_count: Option<u64>,
) -> Vec<String> {
    let mut failures = Vec::new();
    if let Some(limit) = smoke.max_flash_bytes {
        match flash_used_bytes {
            Some(used) if used <= limit => {}
            Some(used) => failures.push(format!(
                "Flash usage {} exceeds declared limit {}",
                used, limit
            )),
            None => failures.push(
                "Flash budget was declared but compiler output did not report usage".to_string(),
            ),
        }
    }
    if let Some(limit) = smoke.max_ram_bytes {
        match ram_used_bytes {
            Some(used) if used <= limit => {}
            Some(used) => failures.push(format!(
                "RAM usage {} exceeds declared limit {}",
                used, limit
            )),
            None => failures.push(
                "RAM budget was declared but compiler output did not report usage".to_string(),
            ),
        }
    }
    if let Some(limit) = smoke.max_warnings {
        match warning_count {
            Some(count) if count <= limit => {}
            Some(count) => failures.push(format!(
                "Compiler warning count {} exceeds declared limit {}",
                count, limit
            )),
            None => failures.push(
                "Warning budget was declared but compiler diagnostics did not report a count"
                    .to_string(),
            ),
        }
    }
    failures
}

async fn compile_qualification_smoke(
    app: &AppHandle,
    board_id: &str,
    installed_content_sha256: &str,
    resolved_fqbn: &str,
    smoke: &QualificationSmokeSource,
) -> Result<serde_json::Value, String> {
    let source_sha256 = sha256_text(&smoke.code);
    let workspace_fingerprint = format!(
        "board-qualification:{}:{}:{}:{}:{}",
        board_id, installed_content_sha256, resolved_fqbn, smoke.id, source_sha256
    );
    let payload = compile_sketch_impl(
        app.clone(),
        smoke.code.clone(),
        resolved_fqbn.to_string(),
        Some(board_id.to_string()),
        None,
        Some(workspace_fingerprint),
        None,
        Some(true),
        Some(true),
        None,
        None,
        None,
    )
    .await?;
    let parsed = serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|error| format!("Compile result JSON is invalid: {error}"))?;
    let path = parsed["path"].as_str().unwrap_or_default();
    if path.is_empty() || !std::path::Path::new(path).is_dir() {
        return Err("Qualification compile returned no verified build directory.".to_string());
    }
    let toolchain_key = parsed
        .pointer("/diagnostics/environment/toolchainKey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Qualification compile did not report a toolchain identity")?;
    let build_signature = parsed
        .pointer("/diagnostics/environment/buildSignature")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Qualification compile did not report a build signature")?;
    let log = parsed["log"].as_str().unwrap_or_default();
    let (flash_used_bytes, ram_used_bytes, warning_count) = qualification_resource_usage(&parsed);
    let mut result = serde_json::json!({
        "id": smoke.id,
        "mode": "compile-only",
        "status": "passed",
        "declared": smoke.declared,
        "source_sha256": source_sha256,
        "log_sha256": sha256_text(log),
        "toolchain_key": toolchain_key,
        "build_signature": build_signature,
        "timeout_enforced": false,
    });
    if let Some(value) = smoke.timeout_seconds {
        result["declared_timeout_seconds"] = value.into();
    }
    if let Some(value) = flash_used_bytes {
        result["flash_used_bytes"] = value.into();
    }
    if let Some(value) = ram_used_bytes {
        result["ram_used_bytes"] = value.into();
    }
    if let Some(value) = warning_count {
        result["warning_count"] = value.into();
    }
    let budget_failures =
        qualification_budget_failures(smoke, flash_used_bytes, ram_used_bytes, warning_count);
    if !budget_failures.is_empty() {
        result["status"] = "failed".into();
        result["failure_reason"] = budget_failures.join("; ").into();
    }
    let partition = qualification_partition_hash(std::path::Path::new(path));
    let requires_partition = resolved_fqbn.split(':').nth(1) == Some("esp32")
        || resolved_fqbn.contains("PartitionScheme=");
    if requires_partition && partition.is_none() {
        return Err(
            "ESP32 qualification build did not produce a hashable partitions.csv; refusing certification."
                .to_string(),
        );
    }
    if let Some((relative_path, hash)) = partition {
        if let Some(object) = result.as_object_mut() {
            object.insert("partition_path".to_string(), relative_path.into());
            object.insert("partition_sha256".to_string(), hash.into());
        }
    }
    Ok(result)
}

fn validate_complete_profile_option_keys(
    profile_id: &str,
    declared_options: &serde_json::Map<String, serde_json::Value>,
    installed_schema: &BoardOptionSchema,
) -> Result<(), String> {
    let declared_keys = declared_options.keys().cloned().collect::<HashSet<_>>();
    let installed_keys = installed_schema.keys().cloned().collect::<HashSet<_>>();
    if declared_keys == installed_keys {
        return Ok(());
    }
    let mut missing = installed_keys
        .difference(&declared_keys)
        .cloned()
        .collect::<Vec<_>>();
    let mut extra = declared_keys
        .difference(&installed_keys)
        .cloned()
        .collect::<Vec<_>>();
    missing.sort();
    extra.sort();
    Err(format!(
        "Validation profile '{}' is not a complete installed menu suffix (missing: {}; unknown: {}).",
        profile_id,
        if missing.is_empty() {
            "none".to_string()
        } else {
            missing.join(", ")
        },
        if extra.is_empty() {
            "none".to_string()
        } else {
            extra.join(", ")
        }
    ))
}

async fn resolve_qualification_profile_fqbn(
    app: &AppHandle,
    manifest: &serde_json::Value,
    profile: &board_passport::BoardPassportProfile,
) -> Result<String, String> {
    let resolved = resolve_board_fqbn(app, &profile.fqbn).await?;
    let Some(declared_profiles) = manifest
        .get("validation_profiles")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(resolved);
    };
    let declared = declared_profiles
        .iter()
        .find(|declared| declared["id"].as_str() == Some(profile.id.as_str()))
        .ok_or_else(|| format!("Validation profile '{}' is not declared.", profile.id))?;
    if declared["options_complete"].as_bool() != Some(true) {
        return Err(format!(
            "Validation profile '{}' must declare options_complete: true.",
            profile.id
        ));
    }
    let declared_options = declared["options"]
        .as_object()
        .ok_or_else(|| format!("Validation profile '{}' has no option map.", profile.id))?;
    let base = manifest["fqbn_base"]
        .as_str()
        .ok_or("Board manifest has no fqbn_base")?;
    let installed_schema = get_board_option_schema(app, base).await.ok_or_else(|| {
        format!(
            "Installed board menu schema is unavailable for '{}'; refusing profile fallback.",
            base
        )
    })?;
    validate_complete_profile_option_keys(&profile.id, declared_options, &installed_schema)?;
    Ok(resolved)
}

#[tauri::command]
async fn qualify_board_profiles(
    app: AppHandle,
    board_id: String,
) -> Result<BoardQualificationResult, String> {
    let (board_root, library_root) = custom_board_roots(&app, &board_id)?;
    let manifest = board_passport::board_manifest(&board_root)?;
    let sysroot = get_app_sysroot().await?;
    let stored = board_passport::read_passport(&board_root)?;
    let evaluated = board_passport::evaluate_passport(
        stored,
        &manifest,
        &board_root,
        Some(&library_root),
        &sysroot.root_dir,
    )?;
    if evaluated.invalidated_reasons.iter().any(|reason| {
        matches!(
            reason.as_str(),
            "installed_content_changed" | "menu_schema_changed" | "manifest_version_changed"
        )
    }) {
        return Err(format!(
            "Board passport content changed; re-import it before qualification: {}",
            evaluated.invalidated_reasons.join(", ")
        ));
    }

    let mut profile_results = Vec::new();
    let mut latest_passport = evaluated.clone();
    if !evaluated.core.usable {
        for profile in &evaluated.profiles {
            profile_results.push(BoardQualificationProfileResult {
                profile_id: profile.id.clone(),
                fqbn: profile.fqbn.clone(),
                resolved_fqbn: None,
                status: "blocked_core".to_string(),
                duration_ms: 0,
                message: evaluated.core.message.clone(),
                evidence: None,
            });
        }
        return Ok(BoardQualificationResult {
            board_id,
            status: "blocked_core".to_string(),
            core: evaluated.core,
            profiles: profile_results,
            passport: latest_passport,
        });
    }

    let total_profiles = evaluated.profiles.len();
    for (profile_index, profile) in evaluated.profiles.clone().into_iter().enumerate() {
        let _ = app.emit(
            "board-profile-qualification-progress",
            serde_json::json!({
                "boardId": board_id,
                "profileId": profile.id,
                "fqbn": profile.fqbn,
                "index": profile_index + 1,
                "total": total_profiles,
                "status": "running"
            }),
        );
        let started = std::time::Instant::now();
        let resolved = resolve_qualification_profile_fqbn(&app, &manifest, &profile).await;
        let (status, resolved_fqbn, message, evidence) = match resolved {
            Err(error) => (
                "failed".to_string(),
                None,
                error.clone(),
                Some(serde_json::json!({
                    "kind": "environment-result",
                    "provenance": "local",
                    "stage": "environment",
                    "error": error,
                })),
            ),
            Ok(resolved_fqbn) => {
                match load_qualification_smokes(&manifest, &board_root, &profile) {
                    Err(error) => (
                        "failed".to_string(),
                        Some(resolved_fqbn),
                        error.clone(),
                        Some(serde_json::json!({
                            "kind": "environment-result",
                            "provenance": "local",
                            "stage": "environment",
                            "error": error,
                            "matrix_executed": false
                        })),
                    ),
                    Ok((smokes, mut smoke_results)) => {
                        let declared_smoke_count =
                            smokes.iter().filter(|smoke| smoke.declared).count();
                        let mut all_compile_smokes_passed = true;
                        for smoke in &smokes {
                            let smoke_started = std::time::Instant::now();
                            let result = compile_qualification_smoke(
                                &app,
                                &board_id,
                                &latest_passport.installed_content_sha256,
                                &resolved_fqbn,
                                smoke,
                            )
                            .await;
                            let smoke_duration = u64::try_from(smoke_started.elapsed().as_millis())
                                .unwrap_or(u64::MAX);
                            match result {
                                Ok(mut result) => {
                                    if result["status"].as_str() != Some("passed") {
                                        all_compile_smokes_passed = false;
                                    }
                                    if let Some(object) = result.as_object_mut() {
                                        object.insert(
                                            "duration_ms".to_string(),
                                            smoke_duration.into(),
                                        );
                                    }
                                    smoke_results.push(result);
                                }
                                Err(error) => {
                                    all_compile_smokes_passed = false;
                                    smoke_results.push(serde_json::json!({
                                        "id": smoke.id,
                                        "mode": "compile-only",
                                        "status": "failed",
                                        "declared": smoke.declared,
                                        "duration_ms": smoke_duration,
                                        "error_sha256": sha256_text(&error)
                                    }));
                                }
                            }
                        }
                        let skipped_declared = smoke_results
                            .iter()
                            .any(|result| result["status"].as_str() == Some("skipped"));
                        let declared_smokes_executed = declared_smoke_count > 0
                            && !skipped_declared
                            && all_compile_smokes_passed;
                        let profile_status = if all_compile_smokes_passed {
                            "compile_passed"
                        } else {
                            "failed"
                        };
                        let profile_message = if all_compile_smokes_passed {
                            if declared_smoke_count > 0 {
                                format!(
                                    "{} declared compile-only smoke test(s) passed.",
                                    declared_smoke_count
                                )
                            } else {
                                "Legacy package passed the CK controlled minimal smoke sketch."
                                    .to_string()
                            }
                        } else {
                            "One or more compile-only smoke tests failed.".to_string()
                        };
                        let toolchain_keys = smoke_results
                            .iter()
                            .filter_map(|result| result["toolchain_key"].as_str())
                            .collect::<BTreeSet<_>>();
                        let build_signatures = smoke_results
                            .iter()
                            .filter_map(|result| result["build_signature"].as_str())
                            .collect::<BTreeSet<_>>();
                        (
                            profile_status.to_string(),
                            Some(resolved_fqbn),
                            profile_message,
                            Some(serde_json::json!({
                                "kind": "compile-result",
                                "provenance": "local",
                                "stage": "compile",
                                "certification_engine_contract":
                                    ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER,
                                "declared_smoke_tests_executed": declared_smokes_executed,
                                "matrix_executed": false,
                                "toolchain_keys": toolchain_keys,
                                "build_signatures": build_signatures,
                                "smoke_results": smoke_results
                            })),
                        )
                    }
                }
            }
        };
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut stored_evidence = evidence.clone().unwrap_or_else(|| serde_json::json!({}));
        if let Some(object) = stored_evidence.as_object_mut() {
            object.insert("duration_ms".to_string(), duration_ms.into());
            if let Some(resolved) = resolved_fqbn.as_ref() {
                object.insert(
                    "canonical_fqbn".to_string(),
                    serde_json::Value::String(resolved.clone()),
                );
            }
        }
        latest_passport = board_passport::record_profile_result(
            &board_root,
            Some(&library_root),
            &sysroot.root_dir,
            &manifest,
            &profile.fqbn,
            &status,
            Some(stored_evidence.clone()),
        )?;
        let _ = app.emit(
            "board-profile-qualification-progress",
            serde_json::json!({
                "boardId": board_id,
                "profileId": profile.id,
                "fqbn": profile.fqbn,
                "resolvedFqbn": resolved_fqbn,
                "index": profile_index + 1,
                "total": total_profiles,
                "status": status,
                "durationMs": duration_ms,
                "message": message
            }),
        );
        profile_results.push(BoardQualificationProfileResult {
            profile_id: profile.id,
            fqbn: profile.fqbn,
            resolved_fqbn,
            status,
            duration_ms,
            message,
            evidence: Some(stored_evidence),
        });
    }

    let overall_status = if profile_results
        .iter()
        .all(|profile| profile.status == "compile_passed")
    {
        "compile_certified"
    } else {
        "failed"
    };
    Ok(BoardQualificationResult {
        board_id,
        status: overall_status.to_string(),
        core: latest_passport.core.clone(),
        profiles: profile_results,
        passport: latest_passport,
    })
}

#[cfg(test)]
mod board_qualification_tests {
    use super::*;

    #[test]
    fn complete_profile_gate_rejects_missing_or_unknown_menu_keys() {
        let installed = HashMap::from([
            (
                "FlashSize".to_string(),
                HashSet::from(["4M".to_string(), "8M".to_string()]),
            ),
            (
                "PartitionScheme".to_string(),
                HashSet::from(["default".to_string()]),
            ),
        ]);
        let complete = serde_json::json!({
            "FlashSize": "4M",
            "PartitionScheme": "default"
        });
        assert!(
            validate_complete_profile_option_keys(
                "complete",
                complete.as_object().unwrap(),
                &installed
            )
            .is_ok()
        );

        let incomplete = serde_json::json!({"FlashSize": "4M"});
        let error = validate_complete_profile_option_keys(
            "incomplete",
            incomplete.as_object().unwrap(),
            &installed,
        )
        .unwrap_err();
        assert!(error.contains("PartitionScheme"));

        let unknown = serde_json::json!({
            "FlashSize": "4M",
            "PartitionScheme": "default",
            "MadeUp": "yes"
        });
        let error = validate_complete_profile_option_keys(
            "unknown",
            unknown.as_object().unwrap(),
            &installed,
        )
        .unwrap_err();
        assert!(error.contains("MadeUp"));
    }

    #[test]
    fn resource_budget_parser_rejects_over_limit_and_missing_measurements() {
        let log = "Sketch uses 1200 bytes (10%) of program storage space.\n\
                   Global variables use 300 bytes (5%) of dynamic memory.\n\
                   source.cpp:1: warning: test warning\n";
        let compile_result = serde_json::json!({
            "log": log,
            "diagnostics": {
                "resources": {
                    "flashUsedBytes": 1200,
                    "ramUsedBytes": 300,
                    "warningCount": 1
                }
            }
        });
        let (flash, ram, warnings) = qualification_resource_usage(&compile_result);
        assert_eq!(flash, Some(1200));
        assert_eq!(ram, Some(300));
        assert_eq!(warnings, Some(1));
        let smoke = QualificationSmokeSource {
            id: "budget".to_string(),
            code: "void setup(){} void loop(){}".to_string(),
            declared: true,
            max_flash_bytes: Some(1000),
            max_ram_bytes: Some(200),
            max_warnings: Some(0),
            timeout_seconds: Some(60),
        };
        let failures = qualification_budget_failures(&smoke, flash, ram, warnings);
        assert_eq!(failures.len(), 3);
        assert_eq!(
            qualification_budget_failures(&smoke, None, None, None).len(),
            3
        );
    }

    #[test]
    fn qualification_exact_cache_uses_structured_evidence_and_rejects_unknown_legacy_values() {
        let exact = serde_json::json!({
            "log": "Cached build (Exact Match)",
            "diagnostics": {
                "cache": {"exactMatch": true},
                "resources": {
                    "flashUsedBytes": 900,
                    "ramUsedBytes": 150,
                    "warningCount": 0
                }
            }
        });
        assert_eq!(
            qualification_resource_usage(&exact),
            (Some(900), Some(150), Some(0))
        );

        let legacy_exact = serde_json::json!({
            "log": "Cached build (Exact Match)",
            "diagnostics": {"cache": {"exactMatch": true}}
        });
        assert_eq!(
            qualification_resource_usage(&legacy_exact),
            (None, None, None)
        );
        let smoke = QualificationSmokeSource {
            id: "strict-budget".to_string(),
            code: "void setup(){} void loop(){}".to_string(),
            declared: true,
            max_flash_bytes: Some(1000),
            max_ram_bytes: Some(200),
            max_warnings: Some(0),
            timeout_seconds: Some(60),
        };
        let (flash, ram, warnings) = qualification_resource_usage(&legacy_exact);
        let failures = qualification_budget_failures(&smoke, flash, ram, warnings);
        assert_eq!(failures.len(), 3);
        assert!(
            failures
                .iter()
                .any(|failure| failure.contains("Warning budget"))
        );
    }

    #[test]
    fn c6_profile_loads_only_its_declared_safe_compile_smoke() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_c6_board");
        let manifest = board_passport::board_manifest(&root).unwrap();
        let profiles =
            board_passport::profiles_from_manifest(&manifest, "pending_compile").unwrap();
        let (smokes, skipped) = load_qualification_smokes(&manifest, &root, &profiles[0]).unwrap();
        assert_eq!(smokes.len(), 1);
        assert!(smokes[0].declared);
        assert!(smokes[0].code.contains("WiFi"));
        assert!(skipped.is_empty());
        assert!(smokes[0].max_flash_bytes.is_some());
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstalledCore {
    id: String,
    installed: String,
    name: String,
    latest: Option<String>,
}

#[tauri::command]
async fn get_installed_cores(_app: AppHandle) -> Result<Vec<InstalledCore>, String> {
    let sysroot_obj = get_app_sysroot().await?;
    let packages_dir = sysroot_obj.root_dir.join("packages");
    let mut cores = Vec::new();

    // Fast filesystem scan: packages/<vendor>/hardware/<arch>/<version>/
    if let Ok(vendors) = std::fs::read_dir(&packages_dir) {
        for vendor_entry in vendors.flatten() {
            let vendor = vendor_entry.path();
            if !vendor.is_dir() {
                continue;
            }
            let vendor_name = vendor
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let hw_dir = vendor.join("hardware");
            if !hw_dir.is_dir() {
                continue;
            }
            if let Ok(archs) = std::fs::read_dir(&hw_dir) {
                for arch_entry in archs.flatten() {
                    let arch_path = arch_entry.path();
                    if !arch_path.is_dir() {
                        continue;
                    }
                    let arch_name = arch_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    // Find version directories
                    if let Ok(versions) = std::fs::read_dir(&arch_path) {
                        let mut latest_version = String::new();
                        for ver_entry in versions.flatten() {
                            if ver_entry.path().is_dir() {
                                let v = ver_entry.file_name().to_string_lossy().to_string();
                                let is_newer = match (
                                    parse_version_rank(&v),
                                    parse_version_rank(&latest_version),
                                ) {
                                    (Some(current), Some(previous)) => current > previous,
                                    (Some(_), None) => true,
                                    _ => v > latest_version,
                                };
                                if is_newer {
                                    latest_version = v;
                                }
                            }
                        }
                        if !latest_version.is_empty() {
                            cores.push(InstalledCore {
                                id: format!("{}:{}", vendor_name, arch_name),
                                installed: latest_version.clone(),
                                name: format!("{}:{}", vendor_name, arch_name),
                                latest: None, // Installed versions do not prove the current remote version.
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(cores)
}

fn normalize_complete_fqbn(fqbn: &str) -> Option<String> {
    let parts = fqbn.trim().split(':').collect::<Vec<_>>();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    let valid_token = |token: &str| {
        !token.is_empty()
            && !token
                .chars()
                .any(|character| character.is_whitespace() || matches!(character, ':' | ',' | '='))
    };
    let base = parts[..3]
        .iter()
        .map(|part| part.trim())
        .collect::<Vec<_>>();
    if !base.iter().all(|part| valid_token(part)) {
        return None;
    }
    if parts.len() == 3 {
        return Some(base.join(":"));
    }

    let raw_options = parts[3].trim();
    if raw_options.is_empty() {
        return None;
    }
    let mut options = Vec::new();
    let mut normalized_keys = HashSet::new();
    for raw_option in raw_options.split(',') {
        let mut fields = raw_option.split('=');
        let key = fields.next()?.trim();
        let value = fields.next()?.trim();
        if fields.next().is_some() || !valid_token(key) || !valid_token(value) {
            return None;
        }
        let normalized_key = key.to_ascii_lowercase();
        if !normalized_keys.insert(normalized_key.clone()) {
            return None;
        }
        options.push((normalized_key, key, value));
    }
    options.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.2.cmp(right.2)));
    Some(format!(
        "{}:{}",
        base.join(":"),
        options
            .into_iter()
            .map(|(_, key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

fn normalize_base_fqbn(fqbn: &str) -> Option<String> {
    let complete = normalize_complete_fqbn(fqbn)?;
    Some(complete.split(':').take(3).collect::<Vec<_>>().join(":"))
}

#[cfg(test)]
fn normalize_unique_prewarm_boards(input: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for fqbn in input {
        if let Some(normalized) = normalize_complete_fqbn(fqbn) {
            if seen.insert(normalized.clone()) {
                out.push(normalized);
            }
        }
    }
    out
}

const PREWARM_TARGET_MAX: usize = 32;
const PREWARM_TARGET_PER_BASE_MAX: usize = 4;
const PREWARM_RECENT_EVIDENCE_SCAN_MAX: usize = PREWARM_TARGET_MAX * 4;

/// Keeps the most useful targets first while bounding both the settings file
/// and the amount of work exposed by manual/startup prewarm. Callers pass
/// targets in newest/highest-priority-first order.
fn bound_recent_prewarm_boards(input: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut per_base: HashMap<String, usize> = HashMap::new();
    for fqbn in input {
        let Some(normalized) = normalize_complete_fqbn(fqbn) else {
            continue;
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        let Some(base) = normalize_base_fqbn(&normalized) else {
            continue;
        };
        let count = per_base.entry(base).or_default();
        if *count >= PREWARM_TARGET_PER_BASE_MAX {
            continue;
        }
        *count += 1;
        out.push(normalized);
        if out.len() >= PREWARM_TARGET_MAX {
            break;
        }
    }
    out
}

/// Installed-board discovery is an eligibility filter, not a source of work.
/// Recent exact targets lead the list; existing settings are retained only
/// while their exact base board is still installed/imported.
fn reconcile_prewarm_targets(
    existing: &[String],
    recent: &[String],
    installed_bases: &HashSet<String>,
) -> Vec<String> {
    let eligible = |fqbn: &String| {
        normalize_base_fqbn(fqbn)
            .map(|base| installed_bases.contains(&base))
            .unwrap_or(false)
    };
    let mut preferred = recent
        .iter()
        .filter(|fqbn| eligible(fqbn))
        .cloned()
        .collect::<Vec<_>>();
    preferred.extend(existing.iter().filter(|fqbn| eligible(fqbn)).cloned());
    bound_recent_prewarm_boards(&preferred)
}

fn remember_active_board_for_prewarm(
    sysroot: &ck_core::sysroot::Sysroot,
    fqbn: &str,
) -> Result<bool, String> {
    let Some(complete_fqbn) = normalize_complete_fqbn(fqbn) else {
        return Ok(false);
    };

    let learned = compile_accel::update_settings(&sysroot.root_dir, |settings| {
        let existed = settings
            .prewarm_boards
            .iter()
            .filter_map(|value| normalize_complete_fqbn(value))
            .any(|value| value == complete_fqbn);
        let mut preferred = vec![complete_fqbn.clone()];
        preferred.extend(settings.prewarm_boards.iter().cloned());
        settings.prewarm_boards = bound_recent_prewarm_boards(&preferred);
        !existed
    })?;
    if learned {
        log::info!(
            "[AUTO PREWARM] Learned active board and added to bounded prewarm list: {}",
            complete_fqbn
        );
    }
    Ok(learned)
}

fn discover_custom_board_bases(app: &AppHandle) -> Vec<String> {
    let mut boards = Vec::new();
    let app_data_dir = match crate::app_storage::desktop_dir(&app) {
        Ok(dir) => dir,
        Err(_) => return boards,
    };
    let boards_dir = app_data_dir.join("CK").join("boards");
    let entries = match std::fs::read_dir(&boards_dir) {
        Ok(entries) => entries,
        Err(_) => return boards,
    };

    for entry in entries.flatten() {
        let board_json_path = entry.path().join("board.json");
        if !board_json_path.exists() {
            continue;
        }
        let content = match std::fs::read_to_string(&board_json_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(j) => j,
            Err(_) => continue,
        };
        let candidate = json["fqbn_base"].as_str().or_else(|| json["fqbn"].as_str());
        if let Some(base) = candidate.and_then(normalize_base_fqbn) {
            boards.push(base);
        }
    }

    boards
}

/// Parses the compact text output of `arduino-cli board listall`.
///
/// The JSON form includes every menu and platform field and can exceed the
/// registered process-output budget on an ordinary ESP32 installation.  The
/// text table is deliberately small and still ends every board row with the
/// authoritative installed base FQBN.  Accept exactly three safe FQBN tokens
/// so headers, diagnostics, and board display names cannot become preload work.
fn parse_installed_board_listall_text(output: &str) -> Vec<String> {
    let mut discovered = BTreeSet::new();
    for line in output.lines() {
        let Some(candidate) = line.split_whitespace().last() else {
            continue;
        };
        if candidate.split(':').count() != 3 {
            continue;
        }
        if let Some(base_fqbn) = normalize_base_fqbn(candidate) {
            discovered.insert(base_fqbn);
        }
    }
    discovered.into_iter().collect()
}

async fn discover_installed_board_fqbns(
    app: &AppHandle,
    sysroot: &ck_core::sysroot::Sysroot,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let install_state = app.state::<InstallState>().inner().clone();
    let mut binding = Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.root_dir.join("arduino-cli.yaml"))
        .arg("board")
        .arg("listall")
        .arg("--no-color")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let output = run_registered_install_output(
        &install_state,
        cmd,
        "arduino-cli board listall for prewarm discovery",
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut discovered: BTreeSet<String> = parse_installed_board_listall_text(&stdout)
        .into_iter()
        .collect();

    for custom_base in discover_custom_board_bases(app) {
        discovered.insert(custom_base);
    }

    Ok(discovered.into_iter().collect())
}

async fn sync_prewarm_boards_from_installed_internal(
    app: &AppHandle,
    sysroot: &ck_core::sysroot::Sysroot,
) -> Result<Vec<String>, String> {
    let discovered = discover_installed_board_fqbns(app, sysroot).await?;
    if discovered.is_empty() {
        log::warn!(
            "[AUTO PREWARM] No installed boards discovered; compacting but not eligibility-pruning existing targets"
        );
        let recent = compile_accel::recent_complete_prewarm_targets(
            &sysroot.root_dir,
            PREWARM_RECENT_EVIDENCE_SCAN_MAX,
        );
        return compile_accel::update_settings(&sysroot.root_dir, |settings| {
            let mut preferred = recent;
            preferred.extend(settings.prewarm_boards.iter().cloned());
            let compacted = bound_recent_prewarm_boards(&preferred);
            settings.prewarm_boards = compacted.clone();
            compacted
        });
    }

    let discovered_set: HashSet<String> = discovered.iter().cloned().collect();
    let recent = compile_accel::recent_complete_prewarm_targets(
        &sysroot.root_dir,
        PREWARM_RECENT_EVIDENCE_SCAN_MAX,
    );
    let merged = compile_accel::update_settings(&sysroot.root_dir, |settings| {
        let merged = reconcile_prewarm_targets(&settings.prewarm_boards, &recent, &discovered_set);
        settings.prewarm_boards = merged.clone();
        merged
    })?;
    log::info!(
        "[AUTO PREWARM] Retained {} recent prewarm target(s) across {} installed board base(s)",
        merged.len(),
        discovered_set.len()
    );
    Ok(merged)
}

#[cfg(test)]
mod prewarm_fqbn_identity_tests {
    use super::*;

    #[test]
    fn normalization_preserves_every_complete_fqbn_option() {
        let full =
            "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=disabled";
        assert_eq!(normalize_complete_fqbn(full).as_deref(), Some(full));
        assert_eq!(
            normalize_base_fqbn(full).as_deref(),
            Some("esp32:esp32:esp32c6")
        );
        assert_eq!(
            normalize_complete_fqbn(" vendor : arch : board : \u{00e9} = two , z = one ")
                .as_deref(),
            Some("vendor:arch:board:z=one,\u{00e9}=two")
        );
        assert_eq!(
            normalize_complete_fqbn("vendor:arch:board:Key=one,\u{212a}ey=two").as_deref(),
            Some("vendor:arch:board:Key=one,\u{212a}ey=two")
        );
        assert!(normalize_complete_fqbn("vendor:arch:board:Flash=8M,flash=16M").is_none());
        assert!(normalize_complete_fqbn("vendor:arch:board:mode=a=b").is_none());
    }

    #[test]
    fn compact_board_list_parser_keeps_only_authoritative_base_fqbns() {
        let text = concat!(
            "Board Name                                  FQBN\n",
            "ESP32-C6 开发板                            esp32:esp32:esp32c6\n",
            "Board With Spaces                           vendor:arch:board-name\n",
            "Duplicate                                  esp32:esp32:esp32c6\n",
            "diagnostic token                           not:a:board:option\n",
            "garbage                                     FQBN\n",
        );
        assert_eq!(
            parse_installed_board_listall_text(text),
            vec![
                "esp32:esp32:esp32c6".to_string(),
                "vendor:arch:board-name".to_string(),
            ]
        );
    }

    #[test]
    fn prewarm_candidates_deduplicate_exact_targets_without_collapsing_configurations() {
        let first = "esp32:esp32:esp32c6:FlashSize=8M".to_string();
        let second = "esp32:esp32:esp32c6:FlashSize=16M".to_string();
        assert_eq!(
            normalize_unique_prewarm_boards(&[
                format!("  {first}  "),
                first.clone(),
                second.clone(),
                "invalid".to_string(),
            ]),
            vec![first, second],
        );
    }

    #[test]
    fn prewarm_targets_are_bounded_globally_and_per_board_base() {
        let mut input = (0..8)
            .map(|index| format!("esp32:esp32:esp32c6:FlashSize={}M", index + 1))
            .collect::<Vec<_>>();
        input.extend((0..50).map(|index| format!("vendor:arch:board{index}:Mode=default")));

        let bounded = bound_recent_prewarm_boards(&input);
        assert_eq!(bounded.len(), PREWARM_TARGET_MAX);
        assert_eq!(
            bounded
                .iter()
                .filter(|fqbn| normalize_base_fqbn(fqbn).as_deref() == Some("esp32:esp32:esp32c6"))
                .count(),
            PREWARM_TARGET_PER_BASE_MAX
        );
        assert_eq!(bounded[0], input[0], "newest/highest priority target wins");
        assert_eq!(
            bounded[3], input[3],
            "the first four menu configurations survive"
        );
        assert!(
            !bounded.contains(&input[4]),
            "older fifth configuration is evicted"
        );
    }

    #[test]
    fn installed_inventory_filters_targets_without_becoming_preload_work() {
        let recent = vec![
            "esp32:esp32:esp32c6:FlashSize=16M".to_string(),
            "vendor:arch:removed:Mode=recent".to_string(),
        ];
        let existing = vec![
            "vendor:arch:kept:Mode=custom".to_string(),
            "vendor:arch:removed:Mode=old".to_string(),
            "esp32:esp32:esp32c6".to_string(),
        ];
        let installed = HashSet::from([
            "esp32:esp32:esp32c6".to_string(),
            "vendor:arch:kept".to_string(),
            // This installed board never appeared in recent/existing settings
            // and must not be injected as background work.
            "vendor:arch:inventory_only".to_string(),
        ]);

        assert_eq!(
            reconcile_prewarm_targets(&existing, &recent, &installed),
            vec![
                "esp32:esp32:esp32c6:FlashSize=16M".to_string(),
                "vendor:arch:kept:Mode=custom".to_string(),
                "esp32:esp32:esp32c6".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn remembering_an_active_target_is_transactional_recent_and_bounded() {
        let root = std::env::temp_dir().join(format!(
            "ck-prewarm-settings-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let sysroot =
            ck_core::sysroot::Sysroot::init(Some(root.join("sysroot")), "ck-prewarm-settings-test")
                .await
                .expect("sysroot");
        compile_accel::update_settings(&sysroot.root_dir, |settings| {
            settings.prewarm_boards = (0..50)
                .map(|index| format!("vendor:arch:board{index}:Mode=old"))
                .chain((0..8).map(|index| format!("esp32:esp32:esp32c6:FlashSize={}M", index + 1)))
                .collect();
        })
        .expect("seed settings");

        let newest = "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB";
        assert!(remember_active_board_for_prewarm(&sysroot, newest).expect("remember"));
        let settings = compile_accel::load_settings(&sysroot.root_dir);
        assert_eq!(
            settings.prewarm_boards.first().map(String::as_str),
            Some(newest)
        );
        assert!(settings.prewarm_boards.len() <= PREWARM_TARGET_MAX);
        assert!(
            settings
                .prewarm_boards
                .iter()
                .filter(|fqbn| normalize_base_fqbn(fqbn).as_deref() == Some("esp32:esp32:esp32c6"))
                .count()
                <= PREWARM_TARGET_PER_BASE_MAX
        );
        assert!(!remember_active_board_for_prewarm(&sysroot, newest).expect("remember again"));
        assert_eq!(
            compile_accel::load_settings(&sysroot.root_dir)
                .prewarm_boards
                .first()
                .map(String::as_str),
            Some(newest)
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

/// Global cache for the bundled CLI binary resolved from Tauri resource path.
fn bundled_cli_cache() -> &'static std::sync::Mutex<Option<std::path::PathBuf>> {
    static CACHE: OnceLock<std::sync::Mutex<Option<std::path::PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn bundled_resource_sidecar(
    target: &std::path::Path,
    suffix: &str,
) -> Result<std::path::PathBuf, String> {
    let mut name = target
        .file_name()
        .ok_or_else(|| {
            format!(
                "Bundled resource target has no file name: {}",
                target.display()
            )
        })?
        .to_os_string();
    name.push(suffix);
    Ok(target.with_file_name(name))
}

fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Install a bundled tool through same-directory staging and a recoverable
/// previous-file swap. An interrupted copy never truncates the working tool;
/// an interrupted swap is repaired on the next startup.
fn install_bundled_resource_atomic(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(bool, String), String> {
    if !source.is_file() {
        return Err(format!("Bundled resource is missing: {}", source.display()));
    }
    let parent = target.parent().ok_or_else(|| {
        format!(
            "Bundled resource target has no parent: {}",
            target.display()
        )
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let incoming = bundled_resource_sidecar(target, ".ck-incoming")?;
    let previous = bundled_resource_sidecar(target, ".ck-previous")?;

    // Recover the only crash state in which the previous file has already
    // moved but the incoming file has not become active yet.
    if !target.exists() && previous.is_file() {
        std::fs::rename(&previous, target).map_err(|error| {
            format!(
                "Failed to restore previous bundled resource {}: {error}",
                target.display()
            )
        })?;
    }
    if target.is_file() && previous.exists() {
        let _ = std::fs::remove_file(&previous);
    }
    if incoming.exists() {
        let _ = std::fs::remove_file(&incoming);
    }

    let source_hash = file_sha256(source)?;
    if target.is_file() && file_sha256(target)? == source_hash {
        return Ok((false, source_hash));
    }

    std::fs::copy(source, &incoming).map_err(|error| {
        format!(
            "Failed to stage bundled resource {}: {error}",
            target.display()
        )
    })?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&incoming)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            let _ = std::fs::remove_file(&incoming);
            format!(
                "Failed to sync bundled resource {}: {error}",
                target.display()
            )
        })?;
    if file_sha256(&incoming)? != source_hash {
        let _ = std::fs::remove_file(&incoming);
        return Err(format!(
            "Bundled resource staging hash mismatch: {}",
            target.display()
        ));
    }

    let had_target = target.is_file();
    if had_target {
        std::fs::rename(target, &previous).map_err(|error| {
            let _ = std::fs::remove_file(&incoming);
            format!(
                "Failed to preserve previous bundled resource {}: {error}",
                target.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(&incoming, target) {
        if had_target && previous.is_file() {
            let _ = std::fs::rename(&previous, target);
        }
        let _ = std::fs::remove_file(&incoming);
        return Err(format!(
            "Failed to activate bundled resource {}: {error}",
            target.display()
        ));
    }
    if file_sha256(target)? != source_hash {
        let _ = std::fs::remove_file(target);
        if had_target && previous.is_file() {
            let _ = std::fs::rename(&previous, target);
        }
        return Err(format!(
            "Activated bundled resource hash mismatch: {}",
            target.display()
        ));
    }
    if previous.exists() {
        std::fs::remove_file(&previous).map_err(|error| {
            format!(
                "Failed to remove previous bundled resource {}: {error}",
                previous.display()
            )
        })?;
    }
    Ok((true, source_hash))
}

/// Resolve and cache the bundled arduino-cli from Tauri resource directory.
/// Also copies it to the sysroot bin/ so that ck_core (demo.rs) can find it.
fn init_bundled_cli(app: &tauri::AppHandle) -> Result<(), String> {
    let identifier = if cfg!(target_os = "windows") {
        "arduino-cli.exe"
    } else {
        "arduino-cli"
    };
    let resource_path = app
        .path()
        .resolve(
            format!("bin/{}", identifier),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| format!("Failed to resolve bundled Arduino CLI: {error}"))?;
    let source = normalize_windows_command_path(resource_path);
    let target = ck_root_dir().join("bin").join(identifier);
    let (updated, hash) = install_bundled_resource_atomic(&source, &target)?;
    // install_bundled_resource_atomic has already hashed and then revalidated
    // the activated target bytes.  Hand that exact identity to CK Forge so a
    // foreground Compile click never rereads the large CLI executable merely
    // to rediscover the same SHA-256.
    ck_forge::register_managed_cli_executable_identity(&target, &hash)?;
    let mut guard = bundled_cli_cache()
        .lock()
        .map_err(|_| "Bundled Arduino CLI cache lock is poisoned".to_string())?;
    *guard = Some(target.clone());
    log::info!(
        "[CLI] Bundled Arduino CLI ready at {:?}; updated={}; sha256={}",
        target,
        updated,
        hash
    );
    Ok(())
}

fn init_bundled_ccache(app: &tauri::AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }
    let source = app
        .path()
        .resolve("bin/ccache.exe", tauri::path::BaseDirectory::Resource)
        .map(normalize_windows_command_path)
        .map_err(|error| format!("Failed to resolve bundled ccache: {error}"))?;
    let root = ck_root_dir();
    let tools_target = root.join("tools").join("ccache.exe");
    let bin_target = root.join("bin").join("ccache.exe");
    let (tools_updated, hash) = install_bundled_resource_atomic(&source, &tools_target)?;
    let (bin_updated, bin_hash) = install_bundled_resource_atomic(&source, &bin_target)?;
    if hash != bin_hash {
        return Err("Bundled ccache copies have inconsistent SHA-256 values".to_string());
    }
    log::info!(
        "[CCACHE] Bundled ccache ready; tools_updated={}; bin_updated={}; sha256={}",
        tools_updated,
        bin_updated,
        hash
    );
    Ok(())
}

fn find_arduino_cli(sysroot_path: &std::path::Path) -> std::path::PathBuf {
    // 0. Check bundled CLI cache (set from Tauri resource path at startup)
    if let Ok(guard) = bundled_cli_cache().lock() {
        if let Some(ref cached) = *guard {
            if cached.exists() {
                return cached.clone();
            }
        }
    }

    let exe_name = if cfg!(target_os = "windows") {
        "arduino-cli.exe"
    } else {
        "arduino-cli"
    };

    // 1. Check bin (User managed or symlinked)
    let bin_path = sysroot_path.join("bin").join(exe_name);
    if bin_path.exists() {
        return normalize_windows_command_path(bin_path);
    }

    // Never fall back to a second downloaded or PATH-provided CLI. Returning
    // the expected managed path makes a missing bundled tool fail explicitly.
    normalize_windows_command_path(bin_path)
}

#[cfg(test)]
mod bundled_resource_install_tests {
    use super::{bundled_resource_sidecar, file_sha256, install_bundled_resource_atomic};

    #[test]
    fn same_size_content_change_replaces_the_managed_tool_by_hash() {
        let root = std::env::temp_dir().join(format!("ck-tool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.exe");
        let target = root.join("bin/tool.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&source, b"new-content").unwrap();
        std::fs::write(&target, b"old-content").unwrap();

        let (updated, expected_hash) = install_bundled_resource_atomic(&source, &target).unwrap();
        assert!(updated);
        assert_eq!(file_sha256(&target).unwrap(), expected_hash);
        assert_eq!(std::fs::read(&target).unwrap(), b"new-content");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_swap_restores_the_previous_tool_before_installing() {
        let root = std::env::temp_dir().join(format!("ck-tool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.exe");
        let target = root.join("bin/tool.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&source, b"current").unwrap();
        let previous = bundled_resource_sidecar(&target, ".ck-previous").unwrap();
        std::fs::write(&previous, b"previous").unwrap();

        install_bundled_resource_atomic(&source, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"current");
        assert!(!previous.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(target_os = "windows")]
fn normalize_windows_command_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let raw = path.to_string_lossy();
    let s: &str = raw.as_ref();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn normalize_windows_command_path(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

fn cli_output_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "Unknown arduino-cli error".to_string()
    }
}

fn header_basename_lower(header: &str) -> String {
    header
        .trim()
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(header)
        .trim()
        .to_ascii_lowercase()
}

fn known_arduino_libraries_for_header(header: &str) -> &'static [&'static str] {
    let h = header_basename_lower(header);
    match h.as_str() {
        // BME/BMP families frequently require these companions.
        "adafruit_bme280.h" => &[
            "Adafruit BME280 Library",
            "Adafruit Unified Sensor",
            "Adafruit BusIO",
        ],
        "adafruit_bmp280.h" => &[
            "Adafruit BMP280 Library",
            "Adafruit Unified Sensor",
            "Adafruit BusIO",
        ],

        // Core shared dependencies.
        "adafruit_sensor.h" => &["Adafruit Unified Sensor"],
        "adafruit_busio_register.h"
        | "adafruit_i2cdevice.h"
        | "adafruit_spidevice.h"
        | "adafruit_genericdevice.h" => &["Adafruit BusIO"],

        // Common device libs with transitive requirements.
        "dht.h" | "dht_u.h" => &["DHT sensor library", "Adafruit Unified Sensor"],
        "adafruit_mpr121.h" => &["Adafruit MPR121", "Adafruit BusIO"],
        "adafruit_pn532.h" => &["Adafruit PN532", "Adafruit BusIO"],
        "adafruit_sgp30.h" => &[
            "Adafruit SGP30 Sensor",
            "Adafruit BusIO",
            "Adafruit Unified Sensor",
        ],
        "adafruit_sht31.h" => &["Adafruit SHT31 Library", "Adafruit BusIO"],
        "adafruit_shtc3.h" => &[
            "Adafruit SHTC3 Library",
            "Adafruit BusIO",
            "Adafruit Unified Sensor",
        ],
        "adafruit_sht4x.h" => &["Adafruit SHT4x Library", "Adafruit BusIO"],
        "adafruit_ina219.h" => &["Adafruit INA219", "Adafruit BusIO"],
        _ => &[],
    }
}

fn push_unique_library_name(dst: &mut Vec<String>, seen: &mut HashSet<String>, name: &str) {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return;
    }
    let key = trimmed.to_ascii_lowercase();
    if seen.insert(key) {
        dst.push(trimmed.to_string());
    }
}

fn format_heuristic_library_suffix(stem: &str) -> String {
    stem.split(['_', '-'])
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let p = part.trim();
            if p.chars().all(|c| c.is_ascii_digit()) {
                return p.to_string();
            }
            let mut chars = p.chars();
            match chars.next() {
                Some(first) => {
                    let mut out = String::new();
                    out.push(first.to_ascii_uppercase());
                    out.push_str(chars.as_str());
                    out
                }
                None => String::new(),
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn candidate_arduino_libraries_for_header(header: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for lib in known_arduino_libraries_for_header(header) {
        push_unique_library_name(&mut out, &mut seen, lib);
    }

    let base = header_basename_lower(header);
    let stem = std::path::Path::new(&base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(base.as_str());

    // Heuristic fallback for Adafruit-style headers:
    // Adafruit_SHTC3.h -> Adafruit SHTC3 Library (+ common dependencies)
    if let Some(rest) = stem.strip_prefix("adafruit_") {
        let suffix = format_heuristic_library_suffix(rest);
        if !suffix.is_empty() {
            push_unique_library_name(&mut out, &mut seen, &format!("Adafruit {} Library", suffix));
            push_unique_library_name(&mut out, &mut seen, &format!("Adafruit {}", suffix));
        }
        push_unique_library_name(&mut out, &mut seen, "Adafruit BusIO");
        push_unique_library_name(&mut out, &mut seen, "Adafruit Unified Sensor");
    }

    out
}

fn known_arduino_libraries_for_linker_log(build_log: &str) -> Vec<&'static str> {
    let lower = build_log.to_ascii_lowercase();
    let mut out: Vec<&'static str> = Vec::new();

    let push_unique = |dst: &mut Vec<&'static str>, lib: &'static str| {
        if !dst.iter().any(|v| *v == lib) {
            dst.push(lib);
        }
    };

    if lower.contains("adafruit_busio_register::")
        || lower.contains("adafruit_i2cdevice::")
        || lower.contains("adafruit_spidevice::")
        || lower.contains("adafruit_genericdevice::")
    {
        push_unique(&mut out, "Adafruit BusIO");
    }
    if lower.contains("adafruit_sensor::") || lower.contains("adafruit_unifiedsensor") {
        push_unique(&mut out, "Adafruit Unified Sensor");
    }
    if lower.contains("dht_unified") {
        push_unique(&mut out, "DHT sensor library");
        push_unique(&mut out, "Adafruit Unified Sensor");
    }

    out
}

fn is_non_retriable_linker_conflict(build_log: &str) -> bool {
    let lower = build_log.to_ascii_lowercase();
    lower.contains("multiple definition of")
        || (lower.contains("first defined here") && lower.contains("ld returned 1 exit status"))
}

fn extract_missing_headers_from_build_log(build_log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let re =
        Regex::new(r#"(?i)(?:fatal\s+error|error):\s*([^:\r\n]+):\s*no such file or directory"#)
            .unwrap();

    for cap in re.captures_iter(build_log) {
        let Some(m) = cap.get(1) else {
            continue;
        };
        let raw = m.as_str().trim().trim_matches('"').trim_matches('\'');
        if raw.is_empty() {
            continue;
        }
        let key = raw.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(raw.to_string());
        }
    }

    out
}

fn install_arduino_library_internal(
    install_state: &InstallState,
    sysroot_path: &std::path::Path,
    install_target: &str,
) -> Result<(), String> {
    let cmd_path = find_arduino_cli(sysroot_path);
    let yaml_path = sysroot_path.join("arduino-cli.yaml");

    let run_install = || -> Result<std::process::Output, String> {
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("install")
            .arg(install_target);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        run_registered_install_output(install_state, &mut cmd, "arduino-cli lib install")
    };

    let mut output = run_install()?;
    if !output.status.success() {
        // Retry once after updating index.
        let mut update_cmd = std::process::Command::new(&cmd_path);
        update_cmd
            .arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("update-index");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            update_cmd.creation_flags(0x08000000);
        }
        let _ = run_registered_install_output(
            install_state,
            &mut update_cmd,
            "arduino-cli lib update-index",
        );
        output = run_install()?;
    }

    if !output.status.success() {
        let err = cli_output_error(&output);
        let err_lower = err.to_ascii_lowercase();
        if !err_lower.contains("already installed") {
            return Err(err);
        }
    }
    Ok(())
}

fn install_known_libraries_with_reasons(
    install_state: &InstallState,
    sysroot_path: &std::path::Path,
    reason_lib_pairs: &[(String, String)],
) -> Vec<(String, String, Result<(), String>)> {
    let mut out: Vec<(String, String, Result<(), String>)> = Vec::new();
    let mut attempted_libs: HashSet<String> = HashSet::new();

    for (reason, lib_name) in reason_lib_pairs {
        let lib_name_owned = lib_name.trim().to_string();
        if lib_name_owned.is_empty() {
            continue;
        }
        if !attempted_libs.insert(lib_name_owned.to_ascii_lowercase()) {
            continue;
        }
        let result = install_arduino_library_internal(install_state, sysroot_path, &lib_name_owned);
        out.push((reason.clone(), lib_name_owned, result));
    }

    out
}

fn auto_install_known_header_libraries(
    install_state: &InstallState,
    sysroot_path: &std::path::Path,
    missing_headers: &[String],
) -> Vec<(String, String, Result<(), String>)> {
    let mut reasons: Vec<(String, String)> = Vec::new();
    for header in missing_headers {
        for lib_name in candidate_arduino_libraries_for_header(header) {
            reasons.push((format!("header:{}", header), lib_name));
        }
    }

    install_known_libraries_with_reasons(install_state, sysroot_path, &reasons)
}

#[tauri::command]
async fn search_arduino_libraries(app: AppHandle, query: String) -> Result<String, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok("{\"libraries\":[],\"status\":\"empty_query\"}".to_string());
    }

    let sysroot = get_app_sysroot().await?;
    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let install_state = app.state::<InstallState>().inner().clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("search")
            .arg(&q)
            .arg("--format")
            .arg("json");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output =
            run_registered_install_output(&install_state, &mut cmd, "arduino-cli lib search")?;
        if !output.status.success() {
            return Err(cli_output_error(&output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn lib_list_cache() -> &'static std::sync::Mutex<(String, std::time::Instant)> {
    static CACHE: OnceLock<std::sync::Mutex<(String, std::time::Instant)>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new((String::new(), std::time::Instant::now())))
}

#[tauri::command]
async fn list_arduino_libraries(app: AppHandle) -> Result<String, String> {
    // Return cached result if fresh (within 10 seconds)
    let cached_raw = if let Ok(cache) = lib_list_cache().lock() {
        if !cache.0.is_empty() && cache.1.elapsed().as_secs() < 10 {
            Some(cache.0.clone())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(cached_raw) = cached_raw {
        return tokio::task::spawn_blocking(move || {
            arduino_zip_quality::annotate_arduino_library_list_quality(&cached_raw)
        })
        .await
        .map_err(|error| format!("Task join error: {}", error))?;
    }

    let sysroot = get_app_sysroot().await?;
    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let install_state = app.state::<InstallState>().inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("list")
            .arg("--format")
            .arg("json");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output =
            run_registered_install_output(&install_state, &mut cmd, "arduino-cli lib list")?;
        if !output.status.success() {
            return Err(cli_output_error(&output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Update cache
    if let Ok(mut cache) = lib_list_cache().lock() {
        *cache = (result.clone(), std::time::Instant::now());
    }
    tokio::task::spawn_blocking(move || {
        arduino_zip_quality::annotate_arduino_library_list_quality(&result)
    })
    .await
    .map_err(|error| format!("Task join error: {}", error))?
}

#[tauri::command]
async fn update_arduino_library_index(app: AppHandle) -> Result<String, String> {
    let sysroot = get_app_sysroot().await?;
    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let install_state = app.state::<InstallState>().inner().clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("update-index");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output = run_registered_install_output(
            &install_state,
            &mut cmd,
            "arduino-cli lib update-index",
        )?;
        if !output.status.success() {
            return Err(cli_output_error(&output));
        }
        Ok("ok".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn install_arduino_library(
    app: AppHandle,
    name: String,
    version: Option<String>,
) -> Result<String, String> {
    let lib_name = name.trim().to_string();
    if lib_name.is_empty() {
        return Err("Library name is empty".to_string());
    }

    let install_target = if let Some(v) = version {
        let ver = v.trim().to_string();
        if ver.is_empty() {
            lib_name.clone()
        } else {
            format!("{}@{}", lib_name, ver)
        }
    } else {
        lib_name.clone()
    };

    let sysroot = get_app_sysroot().await?;
    let root_dir = sysroot.root_dir.clone();
    let target = install_target.clone();
    let install_state = app.state::<InstallState>().inner().clone();

    tokio::task::spawn_blocking(move || {
        install_arduino_library_internal(&install_state, &root_dir, &target)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Invalidate list cache after install
    if let Ok(mut cache) = lib_list_cache().lock() {
        cache.0.clear();
    }

    Ok(install_target)
}

#[tauri::command]
async fn install_arduino_library_zip(app: AppHandle, path: String) -> Result<String, String> {
    let zip_path = std::path::PathBuf::from(path.trim());
    if !zip_path.is_file() {
        return Err("Arduino library ZIP does not exist".to_string());
    }
    if !zip_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        return Err("Please select a .zip Arduino library package".to_string());
    }

    let sysroot = get_app_sysroot().await?;
    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let installed_path = zip_path.clone();
    let arduino_libraries_root = parse_arduino_cli_user_dir(&yaml_path)
        .unwrap_or_else(|| sysroot.root_dir.join("sketchbook"))
        .join("libraries");
    let install_state = app.state::<InstallState>().inner().clone();

    let certified_path = tokio::task::spawn_blocking(move || {
        // The CLI's unsafe-install switch is only an archive compatibility
        // mechanism. CK performs its own fail-closed gate before the CLI is
        // allowed to inspect or install any ZIP contents.
        let gate = arduino_zip_quality::inspect_arduino_library_zip(&installed_path)?;
        if gate.warning_count > 0 {
            log::warn!(
                "Arduino ZIP passed CK quality inspection with {} warning(s): {}",
                gate.warning_count,
                installed_path.display()
            );
        }
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("install")
            .arg("--zip-path")
            .arg(&installed_path)
            .env("ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL", "true");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output = run_registered_install_output(
            &install_state,
            &mut cmd,
            "arduino-cli lib install --zip-path",
        )?;
        if !output.status.success() {
            let err = cli_output_error(&output);
            if !err.to_ascii_lowercase().contains("already installed") {
                return Err(err);
            }
        }
        let installed_root =
            arduino_zip_quality::locate_installed_arduino_library(&arduino_libraries_root, &gate)?;
        arduino_zip_quality::certify_installed_arduino_library(
            &installed_root,
            &gate.source_archive_sha256,
            &gate.source_content_sha256,
        )?;
        Ok(installed_root)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if let Ok(mut cache) = lib_list_cache().lock() {
        cache.0.clear();
    }

    Ok(certified_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn uninstall_arduino_library(app: AppHandle, name: String) -> Result<String, String> {
    let lib_name = name.trim().to_string();
    if lib_name.is_empty() {
        return Err("Library name is empty".to_string());
    }

    let sysroot = get_app_sysroot().await?;
    let cmd_path = find_arduino_cli(&sysroot.root_dir);
    let yaml_path = sysroot.root_dir.join("arduino-cli.yaml");
    let lib_owned = lib_name.clone();
    let install_state = app.state::<InstallState>().inner().clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&cmd_path);
        cmd.arg("--config-file")
            .arg(&yaml_path)
            .arg("lib")
            .arg("uninstall")
            .arg(&lib_owned);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output =
            run_registered_install_output(&install_state, &mut cmd, "arduino-cli lib uninstall")?;
        if !output.status.success() {
            let err = cli_output_error(&output);
            let err_lower = err.to_ascii_lowercase();
            if !(err_lower.contains("not installed")
                || err_lower.contains("is not installed")
                || err_lower.contains("not found"))
            {
                return Err(err);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Invalidate list cache after uninstall
    if let Ok(mut cache) = lib_list_cache().lock() {
        cache.0.clear();
    }

    Ok(lib_name)
}

#[tauri::command]
async fn install_core(
    app: AppHandle,
    package: String,
    version: Option<String>,
    index_url: Option<String>,
) -> Result<String, String> {
    let _managed_package_write_guard =
        acquire_managed_package_write_guard(&app, "Core installation").await;
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = sysroot_obj.root_dir.clone();

    // Add imports
    use std::process::{Command, Stdio};
    use std::thread;
    use tauri::Manager;
    let install_state = app.state::<InstallState>().inner().clone();

    let emit_progress = |msg: &str| {
        let _ = app.emit("install-progress", msg);
    };

    // Resolve bundled arduino-cli from Tauri resources
    let identifier = if cfg!(target_os = "windows") {
        "arduino-cli.exe"
    } else {
        "arduino-cli"
    };
    let resource_path = normalize_windows_command_path(
        app.path()
            .resolve(
                format!("bin/{}", identifier),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| e.to_string())?,
    );

    emit_progress(&format!("DEBUG: Resolved CLI Path: {:?}", resource_path));

    let cmd_path = if resource_path.exists() {
        resource_path
    } else {
        emit_progress("WARNING: Resource path not found. Checking fallback...");
        // Fallback for Dev/Windows logic
        let cwd = std::env::current_dir().unwrap_or_default();
        let fallback = normalize_windows_command_path(cwd.join("bin").join(identifier));

        if fallback.exists() {
            emit_progress(&format!("DEBUG: Found at fallback: {:?}", fallback));
            fallback
        } else {
            // Try sysroot bin as last resort (if user manually put it there)
            let sys_bin = normalize_windows_command_path(sysroot.join("bin").join(identifier));
            if sys_bin.exists() {
                emit_progress(&format!("DEBUG: Found at sysroot: {:?}", sys_bin));
                sys_bin
            } else {
                resource_path // Return original to fail with that path
            }
        }
    };

    if !cmd_path.exists() {
        emit_progress(&format!("CRITICAL: executable not found at {:?}", cmd_path));
        return Err(format!("Executable not found at: {:?}", cmd_path));
    }

    // 1. Ensure URL is clean and Index is updated (Smart Clean)
    // Run as cancellable child processes stored in InstallState
    {
        if let Some(ref url) = index_url {
            emit_progress(&format!("Syncing Package Index for: {}", url));

            // Smart Clean: Remove conflicting URLs
            let yaml_path = sysroot.join("arduino-cli.yaml");
            if let Ok(content) = std::fs::read_to_string(&yaml_path) {
                let target_stem = get_url_stem(url);

                for line in content.lines() {
                    if line.trim().starts_with("-") {
                        let potential_url = line.trim().trim_start_matches('-').trim();
                        let potential_url = potential_url.trim_matches('\'').trim_matches('"');

                        if potential_url.is_empty() {
                            continue;
                        }

                        if let (Some(t_stem), Some(e_stem)) =
                            (&target_stem, get_url_stem(potential_url))
                        {
                            if *t_stem == e_stem && potential_url != url.as_str() {
                                emit_progress(&format!(
                                    "Removing conflicting URL: {}",
                                    potential_url
                                ));

                                let mut remove_url = Command::new(&cmd_path);
                                remove_url
                                    .arg("--config-file")
                                    .arg(&yaml_path)
                                    .arg("config")
                                    .arg("remove")
                                    .arg("board_manager.additional_urls")
                                    .arg(potential_url);
                                no_window(&mut remove_url);
                                let _ = run_registered_core_install_output(
                                    &install_state,
                                    &mut remove_url,
                                    "arduino-cli config remove board manager URL",
                                );
                            }
                        }
                    }
                }
            }

            // Add new URL
            emit_progress(&format!("Adding Board Manager URL: {}", url));
            let mut add_url = Command::new(&cmd_path);
            add_url
                .arg("--config-file")
                .arg(sysroot.join("arduino-cli.yaml"))
                .arg("config")
                .arg("add")
                .arg("board_manager.additional_urls")
                .arg(url);
            no_window(&mut add_url);
            run_registered_core_install_output(
                &install_state,
                &mut add_url,
                "arduino-cli config add board manager URL",
            )?;
        } else {
            emit_progress("Syncing Package Index...");
        }

        // Run update-index as a cancellable child process (stored in InstallState)
        emit_progress("Updating package index (this may take a while)...");

        let mut binding = Command::new(&cmd_path);
        let update_cmd = binding
            .arg("--config-file")
            .arg(sysroot.join("arduino-cli.yaml"))
            .arg("core")
            .arg("update-index")
            // Do not pipe here: update-index can emit enough output to fill the pipe
            // and deadlock if nobody drains it while we poll try_wait().
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            update_cmd.creation_flags(0x08000000);
        }

        let (mut update_child, update_process_guard) = install_state.spawn_registered_process(
            update_cmd,
            "arduino-cli core update-index",
            InstallProcessScope::CoreInstall,
        )?;

        // Keep ownership of Child here so cancellation can terminate the tree
        // while this task still performs the final wait/reap.
        loop {
            let finished_status = match update_child.try_wait() {
                Ok(Some(status)) => Some(Ok(status)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            };

            if let Some(result) = finished_status {
                let cancellation_requested = update_process_guard.termination_requested();
                drop(update_process_guard);
                match result {
                    Ok(status) => {
                        if cancellation_requested {
                            return Err("Index sync cancelled".to_string());
                        }
                        if !status.success() {
                            emit_progress(&format!(
                                "WARNING: Index update returned status: {}",
                                status
                            ));
                            // Don't fail completely, proceed with install attempt
                        } else {
                            emit_progress("Index sync completed.");
                        }
                        break;
                    }
                    Err(e) => {
                        let _ = update_child.kill();
                        let _ = update_child.wait();
                        if cancellation_requested {
                            return Err("Index sync cancelled".to_string());
                        }
                        emit_progress(&format!("WARNING: Index sync error: {}", e));
                        break; // Proceed anyway
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    // Determine target with version pinning
    let requested_version = version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let install_target = match requested_version.as_ref() {
        Some(v) => format!("{}@{}", package, v),
        _ => package.clone(),
    };

    // Use the already resolved cmd_path from the start of the function
    let log_msg = format!(
        "Installing core: {} (Index: {:?})",
        install_target, index_url
    );
    app.emit("install-progress", &log_msg)
        .map_err(|e| e.to_string())?;

    let mut binding = Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("core")
        .arg("install")
        .arg(&install_target)
        // .arg("--format") // Disable JSON for reliable text output
        // .arg("json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()); // Capture stderr too

    if let Some(url) = index_url {
        cmd.arg("--additional-urls").arg(url);
    }

    // Windows: CreateNoWindow flag to hide console window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (mut child, install_process_guard) = install_state.spawn_registered_process(
        cmd,
        "arduino-cli core install",
        InstallProcessScope::CoreInstall,
    )?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            install_process_guard.request_termination();
            let _ = child.wait();
            drop(install_process_guard);
            return Err("Failed to open stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            install_process_guard.request_termination();
            let _ = child.wait();
            drop(install_process_guard);
            return Err("Failed to open stderr".to_string());
        }
    };

    let app_handle_out = app.clone();
    let app_handle_err = app.clone();

    // Spawn thread to read stdout (Text progress)
    let stdout_thread = thread::spawn(move || {
        let _ = app_handle_out.emit("install-progress", "DEBUG: Log thread active");
        let _ = read_process_stream_fixed_chunks(stdout, |chunk| {
            let _ = app_handle_out.emit("install-progress", chunk);
            log::info!("[CLI STDOUT] {}", chunk);
        });
    });

    // Capture stderr for final error message
    let stderr_log = std::sync::Arc::new(std::sync::Mutex::new(
        ck_core::builder::demo::BoundedLog::new(256 * 1024, 64 * 1024),
    ));
    let stderr_log_thread = stderr_log.clone();

    // Spawn thread to read stderr (Errors)
    let stderr_thread = thread::spawn(move || {
        let _ = read_process_stream_fixed_chunks(stderr, |chunk| {
            let _ = app_handle_err.emit("install-progress", format!("Error: {}", chunk));
            log::error!("[CLI STDERR] {}", chunk);
            if let Ok(mut guard) = stderr_log_thread.lock() {
                guard.push_str(chunk);
            }
        });
    });

    // Poll the locally-owned Child. Shutdown/cancel only kills its registered
    // tree; this owner always observes completion and reaps it.
    loop {
        let finished_status = match child.try_wait() {
            Ok(Some(status)) => Some(Ok(status)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        };

        if let Some(result) = finished_status {
            let cancellation_requested = install_process_guard.termination_requested();
            drop(install_process_guard);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            match result {
                Ok(status) => {
                    if cancellation_requested {
                        return Err("Core installation cancelled".to_string());
                    }
                    if !status.success() {
                        let errors = stderr_log.lock().unwrap().rendered();
                        return Err(format!(
                            "Process finished with status: {}\nDetails:\n{}",
                            status, errors
                        ));
                    }
                    break; // Success
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    if cancellation_requested {
                        return Err("Core installation cancelled".to_string());
                    }
                    return Err(format!("Error waiting on process: {}", e));
                }
            }
        }

        // Sleep briefly to avoid busy loop
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if let Some(expected) = requested_version.as_deref() {
        let installed = board_passport::installed_core_versions(&sysroot, &package);
        if !installed.iter().any(|version| {
            version.trim().trim_start_matches('v') == expected.trim().trim_start_matches('v')
        }) {
            return Err(format!(
                "Arduino CLI reported success, but requested core {}@{} is not present (found: {}).",
                package,
                expected,
                if installed.is_empty() {
                    "none".to_string()
                } else {
                    installed.join(", ")
                }
            ));
        }
    }

    invalidate_board_definition_caches();
    if let Err(e) = sync_prewarm_boards_from_installed_internal(&app, &sysroot_obj).await {
        log::warn!(
            "[AUTO PREWARM] install_core succeeded but sync failed: {}",
            e
        );
    }
    let _ = app.emit("install-finished", ()); // Signal frontend to close progress
    Ok("Success".to_string())
}

#[tauri::command]
async fn cancel_core_install(app: AppHandle) -> Result<(), String> {
    let install_state = app.state::<InstallState>().inner().clone();
    let state_for_cancel = install_state.clone();
    let cancellation = tauri::async_runtime::spawn_blocking(move || {
        state_for_cancel.cancel_core_install_and_wait(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|error| format!("Failed to join core install cancellation: {error}"))?;
    if cancellation.timed_out {
        return Err(format!(
            "Core installation cancellation timed out with {} registered process(es) still active",
            cancellation.remaining_active
        ));
    }
    log::info!(
        "Core installation cancellation completed; {} process tree(s) were active.",
        cancellation.initially_active
    );

    // Cleanup: Run 'arduino-cli cache clean' to remove partial downloads
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = sysroot_obj.root_dir;
    let cmd_path = find_arduino_cli(&sysroot);

    // Run cleanup in blocking thread to avoid blocking async runtime
    tauri::async_runtime::spawn_blocking(move || {
        // Sleep briefly to ensure file locks are released by OS
        std::thread::sleep(std::time::Duration::from_millis(500));

        log::info!("Running cleanup after cancellation...");

        // 1. Run cache clean command
        let mut cache_clean = std::process::Command::new(&cmd_path);
        cache_clean
            .arg("--config-file")
            .arg(sysroot.join("arduino-cli.yaml"))
            .arg("cache")
            .arg("clean");
        no_window(&mut cache_clean);
        let _ = run_registered_install_output(
            &install_state,
            &mut cache_clean,
            "arduino-cli cache clean",
        );

        // 2. Clean staging directory (where partial installs are extracted)
        let staging_dir = sysroot.join("staging");
        if staging_dir.exists() {
            log::info!("Cleaning staging directory: {:?}", staging_dir);
            if let Err(e) = std::fs::remove_dir_all(&staging_dir) {
                log::warn!("Failed to remove staging directory: {}", e);
            }
        }

        // 3. Also clean tmp directory if it exists
        let tmp_dir = sysroot.join("tmp");
        if tmp_dir.exists() {
            log::info!("Cleaning tmp directory: {:?}", tmp_dir);
            if let Err(e) = std::fs::remove_dir_all(&tmp_dir) {
                log::warn!("Failed to remove tmp directory: {}", e);
            }
        }
    })
    .await
    .map_err(|error| format!("Failed to join core install cleanup: {error}"))?;

    Ok(())
}

#[tauri::command]
async fn uninstall_core(app: AppHandle, package: String) -> Result<String, String> {
    let _managed_package_write_guard =
        acquire_managed_package_write_guard(&app, "Core removal").await;
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = sysroot_obj.root_dir.clone();

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let cmd_path = find_arduino_cli(&sysroot);
    let install_state = app.state::<InstallState>().inner().clone();

    // Parse vendor from package (e.g., "esp32:esp32" -> "esp32")
    let vendor = package.split(':').next().unwrap_or(&package).to_string();

    let mut binding = Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("core")
        .arg("uninstall")
        .arg(&package)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = run_registered_install_output(&install_state, cmd, "arduino-cli core uninstall")?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let mut result_msg = String::from_utf8_lossy(&output.stdout).to_string();

    // Thorough cleanup: Check if vendor has any remaining cores
    // If not, delete the entire vendor directory (including tools)
    let packages_dir = sysroot.join("packages").join(&vendor);

    if packages_dir.exists() {
        let hardware_dir = packages_dir.join("hardware");

        // Check if hardware directory is empty or doesn't exist
        let has_remaining_cores = if hardware_dir.exists() {
            // Check if there are any subdirectories (architectures) with content
            std::fs::read_dir(&hardware_dir)
                .map(|entries| {
                    entries.filter_map(|e| e.ok()).any(|entry| {
                        // Check if this architecture dir has any version subdirs
                        if entry.path().is_dir() {
                            std::fs::read_dir(entry.path())
                                .map(|sub| sub.count() > 0)
                                .unwrap_or(false)
                        } else {
                            false
                        }
                    })
                })
                .unwrap_or(false)
        } else {
            false
        };

        if !has_remaining_cores {
            log::info!(
                "No remaining cores for vendor '{}', removing entire vendor directory including tools",
                vendor
            );

            // Delete entire vendor directory (includes tools/)
            if let Err(e) = std::fs::remove_dir_all(&packages_dir) {
                log::warn!(
                    "Failed to remove vendor directory {:?}: {}",
                    packages_dir,
                    e
                );
                // Don't fail the uninstall, just log warning
            } else {
                log::info!("Cleaned up {} GB of toolchain data", vendor);
                result_msg = format!("{}\n\n已彻底清理 {} 的工具链", result_msg, vendor);
            }
        }
    }

    invalidate_board_definition_caches();
    if let Err(e) = sync_prewarm_boards_from_installed_internal(&app, &sysroot_obj).await {
        log::warn!(
            "[AUTO PREWARM] uninstall_core succeeded but sync failed: {}",
            e
        );
    }

    Ok(result_msg)
}

#[tauri::command]
async fn clean_cache(app: AppHandle) -> Result<String, String> {
    use std::process::Command;
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = sysroot_obj.root_dir;

    let cmd_path = find_arduino_cli(&sysroot);
    let install_state = app.state::<InstallState>().inner().clone();
    let mut command = Command::new(&cmd_path);
    command
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("cache")
        .arg("clean");
    no_window(&mut command);
    run_registered_install_output(&install_state, &mut command, "arduino-cli cache clean")?;

    Ok("Cache Cleared".to_string())
}

// Helper to get URL stem
fn get_url_stem(url: &str) -> Option<String> {
    let filename = url.rsplit('/').next()?;
    std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

// SHARED HELPER: Ensures URL is added (cleaning conflicts) and Updates Index
// Returns OK message or Error string.
// This is synchronous logic intended to be run inside spawn_blocking.
fn ensure_index_url_and_sync(
    install_state: &InstallState,
    sysroot: &std::path::Path,
    cmd_path: &std::path::PathBuf,
    new_url: Option<String>,
) -> Result<String, String> {
    use std::process::Command;

    if let Some(url) = new_url {
        if !url.is_empty() {
            // 1. Direct File Scan to find conflicts
            let yaml_path = sysroot.join("arduino-cli.yaml");
            if let Ok(content) = std::fs::read_to_string(&yaml_path) {
                let target_stem = get_url_stem(&url);

                for line in content.lines() {
                    if line.trim().starts_with("-") {
                        let potential_url = line.trim().trim_start_matches('-').trim();
                        let potential_url = potential_url.trim_matches('\'').trim_matches('"');

                        if potential_url.is_empty() {
                            continue;
                        }

                        if let (Some(t_stem), Some(e_stem)) =
                            (&target_stem, get_url_stem(potential_url))
                        {
                            // Match by stem but diff URL -> Conflict -> Remove it
                            if *t_stem == e_stem && potential_url != url {
                                log::info!("Found conflicting URL in YAML: {}", potential_url);

                                let mut command = Command::new(cmd_path);
                                command
                                    .arg("--config-file")
                                    .arg(&yaml_path)
                                    .arg("config")
                                    .arg("remove")
                                    .arg("board_manager.additional_urls")
                                    .arg(potential_url);
                                no_window(&mut command);
                                let _ = run_registered_install_output(
                                    install_state,
                                    &mut command,
                                    "arduino-cli config remove board manager URL",
                                );
                            }
                        }
                    }
                }
            }

            // 2. Add New URL
            log::info!("Adding Board Manager URL: {}", url);
            let mut command = Command::new(cmd_path);
            command
                .arg("--config-file")
                .arg(sysroot.join("arduino-cli.yaml"))
                .arg("config")
                .arg("add")
                .arg("board_manager.additional_urls")
                .arg(&url);
            no_window(&mut command);
            run_registered_install_output(
                install_state,
                &mut command,
                "arduino-cli config add board manager URL",
            )?;
        }
    }

    log::info!("Updating package index...");

    // 3. Update Index
    let mut command = Command::new(cmd_path);
    command
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("core")
        .arg("update-index");
    no_window(&mut command);
    let output = run_registered_install_output(
        install_state,
        &mut command,
        "arduino-cli core update-index",
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok("Package Index Updated".to_string())
}

#[tauri::command]
async fn update_package_index(app: AppHandle, index_url: Option<String>) -> Result<String, String> {
    let _managed_package_write_guard =
        acquire_managed_package_write_guard(&app, "package-index update").await;
    let sysroot_obj = get_app_sysroot().await?;
    let sysroot = sysroot_obj.root_dir;
    let cmd_path = find_arduino_cli(&sysroot);
    let install_state = app.state::<InstallState>().inner().clone();

    let update_task = tauri::async_runtime::spawn_blocking(move || {
        ensure_index_url_and_sync(&install_state, &sysroot, &cmd_path, index_url)
    });

    match update_task.await {
        Ok(result) => result,
        Err(e) => Err(format!("Task join error: {}", e)),
    }
}

#[tauri::command]
async fn get_core_versions(core_id: String, index_url: String) -> Result<core_catalog::CoreVersions, String> {
    core_catalog::fetch(core_id, index_url).await
}

#[tauri::command]
async fn warmup_board(app: AppHandle, fqbn: String, code: Option<String>) -> Result<(), String> {
    // The qualification process must contain only the explicitly measured CK
    // and native lanes.  The React workspace can request a board warmup after
    // it mounts even though Rust startup prewarm is disabled; accepting that
    // request makes the next timed edit wait for an unrelated full compile.
    if !startup_background_compiles_allowed(native_relink_qualification_startup_token().is_some()) {
        log::info!("[CK Forge] Qualification session ignored a frontend board warmup request");
        return Ok(());
    }
    // Use the exact same strict resolver as foreground compile/upload. An old
    // or unknown explicit option must stop here instead of warming defaults and
    // polluting caches for a configuration the user did not request.
    let target_fqbn = resolve_board_fqbn(&app, &fqbn).await?;

    let sysroot_obj = get_app_sysroot().await?;
    // Prefer code-aware warmup when code is provided so first foreground compile
    // after include/library changes can reuse prebuilt dependency objects.
    let warmup_code = code
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty() && !c.contains("Generating code"));
    if let Some(code) = warmup_code {
        // build_signature 此时未知（library scan 还未运行），传 None。
        // compile_sketch 完成 library scan 后会调用 update_active_warmup_hints 补全 signature。
        compile_accel::enqueue_warmup_with_signature(sysroot_obj, target_fqbn, Some(code), None)
            .await;
    } else {
        // Board/config warmups use the canonical code and a real core/toolchain
        // signature, so foreground compilation can safely join instead of restart.
        compile_accel::enqueue_default_prewarm(sysroot_obj, target_fqbn).await;
    }
    Ok(())
}

#[tauri::command]
async fn clear_board_compile_cache(
    app: AppHandle,
    fqbn: String,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let sysroot = get_app_sysroot().await?;
    let resolved_fqbn = resolve_board_fqbn(&app, &fqbn).await?;
    compile_accel::clear_board_compile_cache(&sysroot, &resolved_fqbn).await
}

#[tauri::command]
async fn clear_board_first_project_compile_cache(
    app: AppHandle,
    fqbn: String,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let sysroot = get_app_sysroot().await?;
    let resolved_fqbn = resolve_board_fqbn(&app, &fqbn).await?;
    compile_accel::clear_board_first_project_compile_cache(&sysroot, &resolved_fqbn).await
}

#[tauri::command]
async fn clear_board_ready_install_project_compile_cache(
    app: AppHandle,
    fqbn: String,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let sysroot = get_app_sysroot().await?;
    let resolved_fqbn = resolve_board_fqbn(&app, &fqbn).await?;
    compile_accel::clear_board_ready_install_project_compile_cache(&sysroot, &resolved_fqbn).await
}

#[tauri::command]
async fn get_compile_accel_settings()
-> Result<ck_core::builder::accel::CompileAccelSettings, String> {
    let sysroot = get_app_sysroot().await?;
    Ok(compile_accel::load_settings(&sysroot.root_dir))
}

#[tauri::command]
async fn set_compile_accel_settings(
    mut settings: ck_core::builder::accel::CompileAccelSettings,
) -> Result<(), String> {
    let sysroot = get_app_sysroot().await?;
    if settings.prewarm_concurrency == 0 {
        settings.prewarm_concurrency = 1;
    }
    if settings.prewarm_debounce_ms < 200 {
        settings.prewarm_debounce_ms = 200;
    }
    settings.prewarm_boards = bound_recent_prewarm_boards(&settings.prewarm_boards);
    compile_accel::update_settings(&sysroot.root_dir, |current| {
        *current = settings;
    })?;
    Ok(())
}

#[tauri::command]
async fn run_prewarm_now(board: Option<String>) -> Result<(), String> {
    let sysroot = get_app_sysroot().await?;
    if let Some(fqbn) = board {
        compile_accel::enqueue_default_prewarm(sysroot, fqbn).await;
        return Ok(());
    }
    let settings = compile_accel::load_settings(&sysroot.root_dir);
    let targets =
        compile_accel::select_startup_prewarm_targets(&sysroot.root_dir, &settings.prewarm_boards);
    for fqbn in targets {
        compile_accel::enqueue_default_prewarm(sysroot.clone(), fqbn).await;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct PrewarmBoardSyncResult {
    count: usize,
    boards: Vec<String>,
}

#[tauri::command]
async fn sync_prewarm_boards_from_installed(
    app: AppHandle,
) -> Result<PrewarmBoardSyncResult, String> {
    let sysroot = get_app_sysroot().await?;
    let boards = sync_prewarm_boards_from_installed_internal(&app, &sysroot).await?;
    Ok(PrewarmBoardSyncResult {
        count: boards.len(),
        boards,
    })
}

#[tauri::command]
async fn get_compile_metrics() -> Result<String, String> {
    let sysroot = get_app_sysroot().await?;
    compile_accel::metrics_jsonl(&sysroot.root_dir)
}

#[tauri::command]
async fn delete_board(app: AppHandle, id: String) -> Result<String, String> {
    delete_board_package_command(&app, &id, true).await
}

// removed old commands
// [tauri::command]
// async fn import_library ... -> see lib_custom_registry.rs
// [tauri::command]
// async fn search_cloud_libraries ... -> removed
// [tauri::command]
// async fn update_library_index ... -> removed
// [tauri::command]
// async fn install_cloud_library ... -> removed

#[tauri::command]
async fn delete_library(
    app: AppHandle,
    id: String,
    board: String,
    path: Option<String>,
) -> Result<String, String> {
    use std::fs;
    use tauri::Manager;

    let has_explicit_path = path
        .as_deref()
        .map(str::trim)
        .map(|p| !p.is_empty())
        .unwrap_or(false);
    if !has_explicit_path && (id.contains(".") || id.contains("/") || id.contains("\\")) {
        return Err("Invalid library ID".to_string());
    }

    let ck_root = ck_root_dir();
    let target_dir =
        if let Some(requested_path) = path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            let raw_target = std::path::PathBuf::from(requested_path);
            if !raw_target.exists() || !raw_target.is_dir() {
                return Err("Library not found".to_string());
            }

            let target_dir = fs::canonicalize(&raw_target).unwrap_or(raw_target);
            let target_key = normalize_path_key(&target_dir);
            let mut allowed_roots = vec![
                ck_root.join("libraries"),
                ck_root.join("board-package-libraries"),
            ];
            if let Ok(app_data_dir) = crate::app_storage::desktop_dir(&app) {
                allowed_roots.push(app_data_dir.join("CK").join("boards"));
            }

            let allowed = allowed_roots.into_iter().any(|root| {
                if !root.exists() {
                    return false;
                }
                let root_key = normalize_path_key(&fs::canonicalize(&root).unwrap_or(root));
                target_key == root_key || target_key.starts_with(&(root_key + "/"))
            });

            if !allowed {
                return Err("Refusing to delete library outside managed roots".to_string());
            }
            target_dir
        } else {
            let safe_board = package_quality::base_fqbn_scope(&board)?.replace(':', "_");
            ck_root.join("libraries").join(&safe_board).join(&id)
        };

    if !target_dir.exists() {
        return Err("Library not found".to_string());
    }
    if !target_dir.join(".ck-user-installed.json").is_file() {
        return Err("This library belongs to the board or system and is protected".to_string());
    }

    fs::remove_dir_all(&target_dir).map_err(|e| format!("Failed to delete library: {}", e))?;
    Ok("Deleted".to_string())
}

// Minimal recursive move helper if fs::rename fails (cross-device) or basic rename
mod options {
    pub mod dir {
        use std::fs;
        use std::path::Path;
        pub fn move_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
            if fs::rename(src, dst).is_ok() {
                return Ok(());
            }
            // Fallback: Copy + Delete
            copy_dir_recursive(src, dst)?;
            fs::remove_dir_all(src)
        }

        fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
            fs::create_dir_all(dst)?;
            for entry in fs::read_dir(src)? {
                let entry = entry?;
                let ty = entry.file_type()?;
                let src_path = entry.path();
                let dst_path = dst.join(entry.file_name());
                if ty.is_dir() {
                    copy_dir_recursive(&src_path, &dst_path)?;
                } else {
                    fs::copy(&src_path, &dst_path)?;
                }
            }
            Ok(())
        }
    }
}

mod arduino_zip_quality;
mod block_package_migration_tx;
mod board_ops;
mod resource_contract;
#[cfg(test)]
mod resource_contract_e2e;
mod board_passport;
mod ck_forge;
mod compile_accel;
mod board_activity;
mod device_health;
mod diagnostic_bundle;
mod compile_feedback;
mod extensions;
mod last_working_version;
mod lib_custom_registry;
mod logging;
mod package_quality;
mod project;
mod project_build_target;
mod source_project;
mod project_files;
mod ipc_error;
mod project_open;
mod project_checkpoints;
mod project_submission;
mod recovery_drafts;
mod resource_map;
mod compiler_resource_capture;
mod runtime_trust;
mod upload_artifact_manifest;
mod app_update;
mod app_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Freeze the opt-in qualification capability before the WebView or any
    // command handler starts. Then erase its environment source so Arduino
    // CLI/toolchain/Core-hook child processes cannot inherit it. Later
    // environment mutation cannot create a probe.
    freeze_native_relink_qualification_token_and_scrub_environment();
    let qualification_session = native_relink_qualification_startup_token().is_some();
    if qualification_session {
        // Keep only a non-secret, process-local diagnostic capability after
        // the qualification token has been scrubbed. The token itself must
        // never reach Arduino CLI, compilers, or third-party hooks.
        std::env::set_var(FLFE_MANAGED_COMMAND_TELEMETRY_ENABLED_ENV, "1");
    } else {
        // NativeRelink binds certificates to this exact production binary.
        // Prime that read-only identity during normal startup so the first
        // customer compile does not pay the one-time executable SHA-256 read.
        // Qualification sessions intentionally skip this work to preserve
        // their measurement isolation.
        ck_forge::prime_current_production_executable_identity();
    }
    // WebView2 does not consume WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on its
    // own. Qualification harnesses provide that value only for an explicitly
    // token-authorized process; bind it to the generated Tauri window config
    // before the first WebView is created. Normal launches never receive
    // browser arguments from the environment.
    let mut context = tauri::generate_context!();
    if qualification_session {
        if let Some(browser_args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .ok()
            .filter(|args| !args.trim().is_empty())
        {
            for window in &mut context.config_mut().app.windows {
                window.additional_browser_args = Some(browser_args.clone());
            }
        }
    }
    let startup_project_open_state = project_open::ProjectOpenState::from_launch_args(
        std::env::args_os(),
        &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
    );
    let app = tauri::Builder::default()
        .manage(app_update::UpdateState::default())
        .manage(compile_feedback::FeedbackState::default())
        .manage(startup_project_open_state)
        // This must remain the first plugin: it owns the process rendezvous
        // used by Windows file associations while CK is already running.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            project_open::handle_second_instance(app, args, cwd);
        }))
        .setup(move |app| {
            // Initialize our IPC logger
            logging::init(app.handle().clone()).expect("failed to initialize logger");

            if let Err(error) = try_ck_root_dir() {
                log::error!("[CK_ROOT] Startup blocked: {}", error);
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("CK 无法初始化可写的本机数据目录：{error}"),
                )));
            }

            if let Err(error) =
                block_package_migration_tx::recover_block_package_migrations_on_startup(
                    app.handle(),
                )
            {
                log::error!(
                    "[BLOCK PACKAGE MIGRATION] Startup recovery failed; future migrations remain blocked: {}",
                    error
                );
            }

            if let Err(error) = ai_library::recover() { log::error!("[AI LIBRARY] Recovery: {error}"); }
            // Test log
            log::info!("Backend logger initialized successfully!");

            // Materialize exact bundled tools into the writable per-user root
            // before any compiler, package or warmup task can observe them.
            if let Ok(resource_dir) = app.path().resource_dir() {
                ck_forge::register_bundled_native_relink_resource_root(&resource_dir);
                log::info!("[CK Forge] Registered Tauri resource directory for portable qualifications: {:?}", resource_dir);
            }
            if let Err(error) = init_bundled_cli(app.handle()) {
                log::error!("[CLI] Startup blocked: {}", error);
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("CK 无法初始化内置 Arduino CLI：{error}"),
                )));
            }
            if let Err(error) = init_bundled_ccache(app.handle()) {
                log::error!("[CCACHE] Startup blocked: {}", error);
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("CK 无法初始化内置编译缓存工具：{error}"),
                )));
            }

            // Initialize sysroot
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match get_app_sysroot().await {
                    Ok(sys) => {

                        log::info!("Sysroot initialized at {:?}", sys.root_dir);

                        if startup_background_compiles_allowed(qualification_session) {
                            // Index only certificate/report hints while the dashboard is idle.
                            // This removes the multi-second foreground directory sweep; the
                            // actual certificate and all authorization gates are still fully
                            // re-read and recomputed by the compile request.
                            let hint_root = sys.root_dir.clone();
                            match tauri::async_runtime::spawn_blocking(move || {
                                ck_forge::prime_native_relink_hint_indexes(&hint_root)
                            })
                            .await
                            {
                                Ok(count) => log::info!(
                                    "[CK Forge] Primed {} NativeRelink qualification hint root(s)",
                                    count
                                ),
                                Err(error) => log::warn!(
                                    "[CK Forge] NativeRelink hint preindex failed; foreground authorization remains fail-closed: {}",
                                    error
                                ),
                            }
                            if let Err(e) = sync_prewarm_boards_from_installed_internal(&app_handle, &sys).await {
                                log::warn!("[AUTO PREWARM] Failed to sync prewarm boards from installed cores: {}", e);
                            }

                            // Trigger configurable prewarm queue.
                            let sys_clone = sys.clone();
                            tauri::async_runtime::spawn(async move {
                                compile_accel::startup_prewarm(sys_clone).await;
                            });
                        } else {
                            log::info!(
                                "[CK Forge] Qualification startup: background board discovery and prewarm are disabled for measurement isolation"
                            );
                        }

                    }
                    Err(e) => log::error!("Failed to init sysroot: {}", e),
                }
            });

            Ok(())
        })
        .manage(MonitorState { monitor: Mutex::new(None) })
        .manage(InstallState::new())
        .manage(UploadState::new())
        .manage(ForegroundBuildState::new())
        .manage(ApplicationShutdownState::default())
        .manage(AgentLlmCancelState {
            canceled_run_ids: Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            ai_storage_commands::ai_load_preferences,
            ai_storage_commands::ai_save_preferences,
            ai_storage_commands::ai_list_chats,
            ai_storage_commands::ai_load_chat,
            ai_storage_commands::ai_save_chat,
            ai_storage_commands::ai_delete_chat,
            app_storage::app_storage_status,
            app_storage::app_storage_plan,
            app_storage::app_storage_schedule,
            app_storage::app_storage_cancel,
            app_update::app_update_status,
            app_update::app_update_preferences,
            app_update::app_update_home,
            app_update::app_update_check,
            app_update::app_update_cancel,
            app_update::app_update_download,
            app_update::app_update_install,
            greet,
            chat_with_glm,
            chat_with_glm_stream,
            ai_list_models,
            cancel_glm_stream,
            arduino_board_list,
            preproof_compile_target,
            compile_sketch,
            compile_feedback::preview_compile_feedback,
            compile_feedback::submit_compile_feedback,
            compile_ai_candidate,
            ai_library_source::ai_read_library_source,
            ai_library::ai_prepare_library,
            ai_library::ai_install_library,
            ai_library::ai_finish_library,
            ai_library::ai_discard_library,
            ai_library::ai_export_library,
            observe_compiled_resources,
            get_board_success_history,
            observe_forge_recipe_capability,
            list_serial_ports,
            inspect_device,
            upload_sketch,
            observe_upload_preparation,
            cancel_foreground_build,
            cancel_upload,
            open_serial_monitor,
            ai_serial_sample,
            close_serial_monitor,
            send_serial_data,
            get_board_details,
            get_installed_core_pin_aliases,
            import_board,
            import_board_from_github,
            search_board_packages_from_github,
            uninstall_board,
            board_ops::get_custom_boards_v2,
            lib_custom_registry::get_all_libraries,
            runtime_trust::approve_block_package_runtime,
            runtime_trust::revoke_block_package_runtime,
            // Project Commands
            project::create_project,
            project::list_projects,
            project::list_community_examples,
            project::delete_project,
            project::rename_project,
            project::save_project,
            source_project::open_source_project,
            project_files::list_project_sources,
            project_files::project_source_identity,
            project_files::read_project_source,
            project_files::write_project_source,
            project_files::create_ai_project_sources,
            project_files::change_project_source,
            source_project::save_source_project,
            project::save_project_as,
            project::load_project,
            project::get_project_roots,
            project::set_project_roots,
            project::show_in_folder,
            project::get_community_examples_dir_cmd,
            project_open::prepare_project_open,
            project_open::prepare_project_open_v2,
            project_open::drain_pending_project_opens,
            project_open::acknowledge_project_open,
            project_checkpoints::create_project_checkpoint,
            project_checkpoints::list_project_checkpoints,
            project_checkpoints::load_project_checkpoint,
            project_checkpoints::delete_project_checkpoint,
            recovery_drafts::get_project_recovery_baseline,
            recovery_drafts::save_recovery_draft,
            recovery_drafts::list_recovery_drafts,
            recovery_drafts::load_recovery_draft,
            recovery_drafts::delete_recovery_draft,
            recovery_drafts::discard_project_recovery_drafts,
            block_package_migration_tx::prepare_block_library_migration,
            block_package_migration_tx::commit_prepared_block_library_migration,
            block_package_migration_tx::cancel_prepared_block_library_migration,
            last_working_version::get_last_working_version,
            last_working_version::delete_last_working_version,
            last_working_version::restore_last_working_dependencies,
            restore_last_working_firmware,
            rebuild_last_working_version_locked,
            diagnostic_bundle::export_diagnostic_bundle,
            diagnostic_bundle::inspect_diagnostic_bundle,
            project_submission::export_project_submission,
            project_submission::inspect_project_submission,
            // Core Mgmt
            check_core_installed,
            check_core_version_installed,
            check_core_compatibility,
            get_board_passport,
            qualify_board_profiles,
            install_core,
            clean_cache,
            delete_board,
            uninstall_core,
            get_installed_cores,
            get_core_versions,
            warmup_board,
            get_compile_accel_settings,
            set_compile_accel_settings,
            clear_board_compile_cache,
            clear_board_first_project_compile_cache,
            clear_board_ready_install_project_compile_cache,
            run_prewarm_now,
            sync_prewarm_boards_from_installed,
            get_compile_metrics,
            delete_library,
            search_arduino_libraries,
            list_arduino_libraries,
            update_arduino_library_index,
            install_arduino_library,
            install_arduino_library_zip,
            uninstall_arduino_library,
            cancel_core_install,
            update_package_index,
            update_package_index,
            clean_cache,
            // Custom Registry
            lib_custom_registry::import_library,
            lib_custom_registry::fetch_custom_registry,
            lib_custom_registry::install_library_from_url,
            lib_custom_registry::get_install_debug_log,
            get_system_paths,
            open_path_in_explorer,
            extensions::get_available_extensions,
            extensions::import_extension,
            extensions::import_extensions_batch,
            extensions::uninstall_extension,
            extensions::repair_extension_import
        ])
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            shutdown_application_tasks(app_handle);
        }
    });
}
