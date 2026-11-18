use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const BLOCK_PACKAGE_INVENTORY_SCHEMA_VERSION: u64 = 1;
const MAX_ENABLED_BLOCK_PACKAGE_INVENTORY: usize = 256;
const CK_PROJECT_FORMAT: &str = "ck-project";
const CK_PROJECT_SCHEMA_VERSION: u64 = 1;
const CK_PROJECT_MIGRATION_VERSION: u64 = 1;

/// Upgrade an in-memory legacy project document without executing project code,
/// resolving dependencies or consulting the host environment. Unknown fields are
/// intentionally retained so an older CK editor does not erase extension data.
fn validate_project_document_fields(
    root: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    for field in ["name", "board", "xml"] {
        let value = root
            .get(field)
            .ok_or_else(|| format!("CK project is missing required field '{}'", field))?;
        let text = value
            .as_str()
            .ok_or_else(|| format!("CK project field '{}' must be a string", field))?;
        if field != "xml" && text.trim().is_empty() {
            return Err(format!("CK project field '{}' must not be empty", field));
        }
    }

    for field in ["board_package_id", "created_at", "code", "options"] {
        if root.get(field).is_some_and(|value| !value.is_string()) {
            return Err(format!("CK project field '{}' must be a string", field));
        }
    }
    if root
        .get("ck_block_packages")
        .is_some_and(|value| !value.is_object())
    {
        return Err("CK project field 'ck_block_packages' must be an object".to_string());
    }
    read_project_build_target(&serde_json::Value::Object(root.clone()))?;
    Ok(())
}

fn migrate_project_document_v0_to_v1(
    mut document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let root = document
        .as_object()
        .ok_or_else(|| "CK project root must be a JSON object".to_string())?;

    let identity_presence = ["format", "schema_version", "migration_version"]
        .into_iter()
        .filter(|field| root.contains_key(*field))
        .count();
    if identity_presence != 0 && identity_presence != 3 {
        return Err(
            "Incomplete CK Project Format identity; format, schema_version and migration_version must appear together"
                .to_string(),
        );
    }

    if identity_presence == 3 {
        let format = root.get("format").and_then(serde_json::Value::as_str);
        if format != Some(CK_PROJECT_FORMAT) {
            return Err(format!(
                "Unsupported project format {}; expected {}",
                root.get("format")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| "(non-string)".to_string()),
                CK_PROJECT_FORMAT
            ));
        }

        let declared_schema = root
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "CK project schema_version must be a positive integer".to_string())?;
        if declared_schema != CK_PROJECT_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported CK Project Format schema_version {}; this CK build supports exactly {}",
                declared_schema, CK_PROJECT_SCHEMA_VERSION
            ));
        }

        let declared_migration = root
            .get("migration_version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "CK project migration_version must be a positive integer".to_string())?;
        if declared_migration != CK_PROJECT_MIGRATION_VERSION {
            return Err(format!(
                "Unsupported CK Project Format migration_version {}; this CK build supports exactly {}",
                declared_migration, CK_PROJECT_MIGRATION_VERSION
            ));
        }
    }

    validate_project_document_fields(root)?;

    // A historical .maker/.ck representation has none of the three reserved
    // identity fields. No existing key other than those reserved keys changes.
    let root = document
        .as_object_mut()
        .expect("project root was validated as an object");
    root.insert(
        "format".to_string(),
        serde_json::Value::String(CK_PROJECT_FORMAT.to_string()),
    );
    root.insert(
        "schema_version".to_string(),
        serde_json::Value::from(CK_PROJECT_SCHEMA_VERSION),
    );
    root.insert(
        "migration_version".to_string(),
        serde_json::Value::from(CK_PROJECT_MIGRATION_VERSION),
    );
    Ok(document)
}

#[cfg(target_os = "windows")]
fn replace_project_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_project_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

/// Write a single-file project through a same-directory temporary file and an
/// atomic replacement. Keeping the temporary file beside the destination is
/// required: a rename across filesystems is not atomic.
pub(crate) fn atomic_write_project_file(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(format!(
            "Project destination directory does not exist: {}",
            parent.display()
        ));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project.ck");
    let temporary = parent.join(format!(
        ".{}.ck-write-{}.tmp",
        filename,
        uuid::Uuid::new_v4()
    ));

    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        replace_project_file(&temporary, path)?;
        #[cfg(unix)]
        {
            // Persist the directory entry where the platform permits it.
            let directory = fs::File::open(parent)?;
            directory.sync_all()?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Failed to atomically save '{}': {}", path.display(), error))
}

fn serialize_project_document(document: serde_json::Value) -> Result<Vec<u8>, String> {
    let migrated = migrate_project_document_v0_to_v1(document)?;
    serde_json::to_vec_pretty(&migrated).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPackageInventoryInput {
    pub package_id: String,
    pub version: String,
    pub content_sha256: String,
    pub package_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlockPackageInventoryEntry {
    package_id: String,
    version: String,
    content_sha256: String,
}

fn normalize_block_package_hash(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let digest = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Enabled block package content hash must be SHA-256".to_string());
    }
    Ok(digest.to_ascii_lowercase())
}

fn validate_enabled_block_package_inventory(
    input: Vec<BlockPackageInventoryInput>,
) -> Result<Vec<ValidatedBlockPackageInventoryEntry>, String> {
    if input.len() > MAX_ENABLED_BLOCK_PACKAGE_INVENTORY {
        return Err(format!(
            "Enabled block package inventory exceeds {} entries",
            MAX_ENABLED_BLOCK_PACKAGE_INVENTORY
        ));
    }
    let mut by_id: BTreeMap<String, ValidatedBlockPackageInventoryEntry> = BTreeMap::new();
    for item in input {
        let package_id = item.package_id.trim().to_string();
        let version = item.version.trim().to_string();
        if !crate::package_quality::valid_package_id(&package_id, true) {
            return Err(format!(
                "Enabled block package id '{}' is unsafe",
                package_id
            ));
        }
        semver::Version::parse(&version).map_err(|_| {
            format!(
                "Enabled block package {} has invalid SemVer '{}'",
                package_id, version
            )
        })?;
        let content_sha256 = normalize_block_package_hash(&item.content_sha256)?;
        let package_root =
            fs::canonicalize(Path::new(item.package_path.trim())).map_err(|error| {
                format!(
                    "Enabled block package {} is unavailable: {}",
                    package_id, error
                )
            })?;
        if !package_root.is_dir() {
            return Err(format!(
                "Enabled block package {} path is not a directory",
                package_id
            ));
        }
        let manifest_raw =
            fs::read_to_string(package_root.join("library.json")).map_err(|error| {
                format!(
                    "Cannot verify enabled block package {} manifest: {}",
                    package_id, error
                )
            })?;
        let manifest: serde_json::Value =
            serde_json::from_str(manifest_raw.trim_start_matches('\u{feff}')).map_err(|error| {
                format!(
                    "Enabled block package {} manifest is invalid: {}",
                    package_id, error
                )
            })?;
        if manifest.get("id").and_then(serde_json::Value::as_str) != Some(package_id.as_str())
            || manifest.get("version").and_then(serde_json::Value::as_str) != Some(version.as_str())
        {
            return Err(format!(
                "Enabled block package {} identity/version changed before save",
                package_id
            ));
        }
        let block_manifest_raw =
            fs::read_to_string(package_root.join("ck-blocks.json")).map_err(|error| {
                format!(
                    "Cannot verify enabled block package {} declarative manifest: {}",
                    package_id, error
                )
            })?;
        let block_manifest: serde_json::Value = serde_json::from_str(
            block_manifest_raw.trim_start_matches('\u{feff}'),
        )
        .map_err(|error| {
            format!(
                "Enabled block package {} declarative manifest is invalid: {}",
                package_id, error
            )
        })?;
        let entrypoints = block_manifest
            .get("entrypoints")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| {
                format!(
                    "Enabled block package {} has no declarative entrypoints",
                    package_id
                )
            })?;
        if block_manifest.get("id").and_then(serde_json::Value::as_str) != Some(package_id.as_str())
            || ["blocks", "generator", "toolbox"].iter().any(|label| {
                entrypoints
                    .get(*label)
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|value| {
                        !crate::lib_custom_registry::declarative_entrypoint_allowed(label, value)
                    })
            })
        {
            return Err(format!(
                "Enabled block package {} is not a complete data-only declarative runtime",
                package_id
            ));
        }
        let quality = crate::package_quality::read_quality_report_with_integrity(&package_root)
            .ok_or_else(|| {
                format!(
                    "Enabled block package {} has no intact quality report",
                    package_id
                )
            })?;
        if !crate::package_quality::runtime_quality_report_is_trusted_for_package(
            Some(&quality),
            "block-library",
            &package_id,
        ) {
            return Err(format!(
                "Enabled block package {} no longer passes the declarative runtime quality gate",
                package_id
            ));
        }
        let certified_hash = quality
            .source_content_sha256
            .as_deref()
            .ok_or_else(|| format!("Enabled block package {} has no certified hash", package_id))?;
        if normalize_block_package_hash(certified_hash)? != content_sha256 {
            return Err(format!(
                "Enabled block package {} content changed before save",
                package_id
            ));
        }
        let validated = ValidatedBlockPackageInventoryEntry {
            package_id: package_id.clone(),
            version,
            content_sha256,
        };
        if let Some(previous) = by_id.get(&package_id) {
            if previous != &validated {
                return Err(format!(
                    "Enabled block package inventory has conflicting entries for {}",
                    package_id
                ));
            }
        } else {
            by_id.insert(package_id, validated);
        }
    }
    Ok(by_id.into_values().collect())
}

fn apply_enabled_block_package_inventory(
    project: &mut serde_json::Value,
    input: Option<Vec<BlockPackageInventoryInput>>,
) -> Result<(), String> {
    let Some(input) = input else {
        return Ok(());
    };
    let inventory = validate_enabled_block_package_inventory(input)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let existing_root = match project.get("ck_block_packages") {
        Some(serde_json::Value::Object(root)) => root.clone(),
        Some(_) => return Err("Project ck_block_packages record is malformed".to_string()),
        None => serde_json::Map::new(),
    };
    if let Some(version) = existing_root.get("schema_version") {
        if version.as_u64() != Some(BLOCK_PACKAGE_INVENTORY_SCHEMA_VERSION) {
            return Err("Project ck_block_packages schema is unsupported".to_string());
        }
    }
    let existing_packages = match existing_root.get("packages") {
        Some(serde_json::Value::Object(packages)) => packages.clone(),
        Some(_) => return Err("Project ck_block_packages.packages record is malformed".to_string()),
        None => serde_json::Map::new(),
    };
    let mut packages = serde_json::Map::new();
    for item in inventory {
        let mut record = existing_packages
            .get(&item.package_id)
            .and_then(serde_json::Value::as_object)
            .filter(|record| {
                record.get("version").and_then(serde_json::Value::as_str)
                    == Some(item.version.as_str())
                    && record
                        .get("content_sha256")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|hash| normalize_block_package_hash(hash).ok())
                        .as_deref()
                        == Some(item.content_sha256.as_str())
            })
            .cloned()
            .unwrap_or_default();
        record.insert(
            "version".to_string(),
            serde_json::Value::String(item.version),
        );
        record.insert(
            "content_sha256".to_string(),
            serde_json::Value::String(item.content_sha256),
        );
        if !record.contains_key("recorded_at") {
            record.insert(
                "recorded_at".to_string(),
                serde_json::Value::String(now.clone()),
            );
            record.insert(
                "provenance".to_string(),
                serde_json::Value::String("enabled-runtime-inventory".to_string()),
            );
        }
        record.insert(
            "last_inventory_observed_at".to_string(),
            serde_json::Value::String(now.clone()),
        );
        packages.insert(item.package_id, serde_json::Value::Object(record));
    }
    let mut root = existing_root;
    root.insert(
        "schema_version".to_string(),
        serde_json::Value::from(BLOCK_PACKAGE_INVENTORY_SCHEMA_VERSION),
    );
    root.insert(
        "inventory_semantics".to_string(),
        serde_json::Value::String("enabled-declarative-runtime-packages".to_string()),
    );
    root.insert(
        "inventory_recorded_at".to_string(),
        serde_json::Value::String(now),
    );
    root.insert("packages".to_string(), serde_json::Value::Object(packages));
    project["ck_block_packages"] = serde_json::Value::Object(root);
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub board: String, // "Arduino Uno", "ESP32", etc.
    pub board_package_id: String,
    pub last_modified: String, // ISO 8601 or similar localized string
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_count: Option<usize>,
    pub options: String,       // JSON string for additional options (forceBoard etc)
}

// Count visible Blockly nodes in the saved workspace, not backup shadows or
// objects in fields and plugin data. Older formats without a count stay unknown.
fn dashboard_block_count(project: &serde_json::Value) -> Option<usize> {
    let raw = project.get("xml")?.as_str()?.trim();
    if raw.is_empty() { return Some(0); }
    let state: serde_json::Value = serde_json::from_str(raw).ok()?;
    let roots = state.get("blocks")?.get("blocks")?.as_array()?;
    let mut pending: Vec<_> = roots.iter().collect();
    let mut count = 0;
    while let Some(node) = pending.pop() {
        node.get("type")?.as_str()?;
        count += 1;
        for connection in node.get("inputs").and_then(|v| v.as_object())
            .into_iter().flat_map(|inputs| inputs.values()).chain(node.get("next")) {
            if let Some(child) = connection.get("block").or_else(|| connection.get("shadow")) {
                pending.push(child);
            }
        }
    }
    Some(count)
}

// Config Struct with Migration Support
#[derive(Debug, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    project_roots: Vec<String>,
    // Legacy support
    project_root: Option<String>,
}

/// Get config file path
fn get_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = crate::app_storage::desktop_dir(&app).map_err(|e| e.to_string())?;
    if !config_dir.exists() {
        let _ = fs::create_dir_all(&config_dir);
    }
    Ok(config_dir.join("config.json"))
}

fn default_project_dir(app: &AppHandle) -> PathBuf {
    std::env::var_os("CK_V91_PROJECTS_ROOT").map(PathBuf::from).unwrap_or_else(||
        app.path().document_dir().unwrap_or_else(|_| PathBuf::from(".")).join("RoboFlow/Projects"))
}

/// Load config or return default
fn load_config(app: &AppHandle) -> AppConfig {
    if let Ok(path) = get_config_path(app) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                // Attempt to parse
                if let Ok(mut cfg) = serde_json::from_str::<AppConfig>(&content) {
                    // Migration: If roots is empty but root is set, migrate it
                    if cfg.project_roots.is_empty() {
                        if let Some(old) = cfg.project_root.take() {
                            cfg.project_roots.push(old);
                            // We could save back here, but better to wait for explicit save
                        }
                    }
                    // If still empty (new install), add default
                    if cfg.project_roots.is_empty() {
                        let docs_dir = default_project_dir(app);
                        cfg.project_roots.push(
                            docs_dir
                                .to_string_lossy()
                                .to_string(),
                        );
                    }
                    return cfg;
                }
            }
        }
    }

    // Default from scratch
    let docs_dir = default_project_dir(app);
    AppConfig {
        project_roots: vec![
            docs_dir
                .to_string_lossy()
                .to_string(),
        ],
        project_root: None,
    }
}

/// Helper to get all configured project directories
fn get_project_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let config = load_config(app);
    let docs_dir = default_project_dir(app);
    resolve_project_dirs(config.project_roots, docs_dir)
}

/// Resolve configured roots in their saved order, creating missing directories when possible.
/// Kept independent from Tauri's path resolver so the project-root contract can be tested in
/// isolated temporary directories without touching the user's application configuration.
fn resolve_project_dirs(project_roots: Vec<String>, fallback: PathBuf) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    for root in project_roots {
        let p = PathBuf::from(root);
        if !p.exists() {
            let _ = fs::create_dir_all(&p);
        }
        if p.is_dir() && seen.insert(project_root_identity(&p)) {
            paths.push(p);
        }
    }

    // Fallback if empty
    if paths.is_empty() {
        let _ = fs::create_dir_all(&fallback);
        if fallback.is_dir() {
            paths.push(fallback);
        }
    }

    paths
}

fn project_root_identity(path: &PathBuf) -> String {
    let identity_path = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
    let mut identity = identity_path.to_string_lossy().replace('\\', "/");
    while identity.len() > 1 && identity.ends_with('/') {
        identity.pop();
    }
    #[cfg(target_os = "windows")]
    {
        identity.make_ascii_lowercase();
    }
    identity
}

fn validate_project_roots(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut validated = Vec::new();
    let mut seen = HashSet::new();

    for raw in paths {
        let cleaned = raw.trim();
        if cleaned.is_empty() {
            continue;
        }

        let path = PathBuf::from(cleaned);
        if !path.exists() {
            fs::create_dir_all(&path)
                .map_err(|error| format!("无法创建工程目录 '{}': {}", path.display(), error))?;
        }
        if !path.is_dir() {
            return Err(format!("工程目录不是文件夹: '{}'", path.display()));
        }

        if seen.insert(project_root_identity(&path)) {
            validated.push(path.to_string_lossy().to_string());
        }
    }

    if validated.is_empty() {
        return Err("至少需要一个有效的工程目录".to_string());
    }

    Ok(validated)
}

/// Community examples folder (English naming, auto-create).
fn get_community_examples_dir(app: &AppHandle) -> PathBuf {
    let docs_dir = default_project_dir(app);
    let dir = std::env::var_os("CK_V91_EXAMPLES_ROOT").map(PathBuf::from).unwrap_or_else(|| docs_dir.parent().unwrap_or(&docs_dir).join("Examples"));
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn verify_saved_project_options(project_path: &PathBuf, expected: &str) -> Result<(), String> {
    let meta_path = if project_path.is_dir() {
        project_path.join("project.json")
    } else {
        project_path.clone()
    };
    let content = fs::read_to_string(&meta_path).map_err(|e| {
        format!(
            "Save verification failed: cannot read '{}': {}",
            meta_path.display(),
            e
        )
    })?;
    let json = serde_json::from_str::<serde_json::Value>(&content).map_err(|e| {
        format!(
            "Save verification failed: invalid JSON in '{}': {}",
            meta_path.display(),
            e
        )
    })?;
    let actual = json
        .get("options")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            format!(
                "Save verification failed: missing 'options' in '{}'",
                meta_path.display()
            )
        })?;

    if actual != expected {
        return Err(format!(
            "Save verification failed: options mismatch in '{}'",
            meta_path.display()
        ));
    }
    Ok(())
}

fn is_project_name_taken(target_dir: &PathBuf, name: &str) -> bool {
    let maker = target_dir.join(format!("{}.maker", name));
    let ck = target_dir.join(format!("{}.ck", name));
    let legacy_dir = target_dir.join(name);
    maker.exists() || ck.exists() || legacy_dir.exists()
}

fn resolve_unique_project_name(target_dir: &PathBuf, preferred_name: &str) -> String {
    if !is_project_name_taken(target_dir, preferred_name) {
        return preferred_name.to_string();
    }

    for i in 1..10000 {
        let candidate = format!("{}_{}", preferred_name, i);
        if !is_project_name_taken(target_dir, &candidate) {
            return candidate;
        }
    }

    // Extreme fallback: timestamp suffix
    format!("{}_{}", preferred_name, chrono::Utc::now().timestamp())
}

#[tauri::command]
pub async fn get_project_roots(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(get_project_dirs(&app)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub async fn set_project_roots(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let cfg_path = get_config_path(&app)?;
    let paths = validate_project_roots(paths)?;

    // Fix: Explicitly initialize all fields to satisfy E0063
    let config = AppConfig {
        project_roots: paths,
        project_root: None,
    };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;

    fs::write(cfg_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    name: String,
    board: String,
    board_package_id: Option<String>,
    template_id: Option<String>,
) -> Result<ProjectInfo, String> {
    let dirs = get_project_dirs(&app);
    let target_dir = dirs.first().ok_or("No project directory configured")?;

    create_project_in_dir(target_dir, name, board, board_package_id, template_id)
}

fn create_project_in_dir(
    target_dir: &PathBuf,
    name: String,
    board: String,
    board_package_id: Option<String>,
    template_id: Option<String>,
) -> Result<ProjectInfo, String> {
    // Sanitize name (basic)
    let safe_name = name.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
    if safe_name.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }

    // Auto-resolve duplicate names to keep create flow smooth.
    // Example: uno -> uno_1 -> uno_2 ...
    let final_name = resolve_unique_project_name(target_dir, &safe_name);
    let project_filename = format!("{}.ck", final_name);
    let project_path = target_dir.join(&project_filename);

    // Template content
    let code = match template_id.as_deref() {
        Some("blink") => BLINK_TEMPLATE,
        Some("servo") => SERVO_TEMPLATE,
        _ => EMPTY_TEMPLATE,
    };

    let concrete_package_id = board_package_id.unwrap_or_else(|| board.clone());

    // Create Metadata Content
    let meta = serde_json::json!({
        "format": CK_PROJECT_FORMAT,
        "schema_version": CK_PROJECT_SCHEMA_VERSION,
        "migration_version": CK_PROJECT_MIGRATION_VERSION,
        "name": final_name,
        "board": board,
        "board_package_id": concrete_package_id.clone(),
        "created_at": chrono::Utc::now().to_rfc3339(),
        "xml": "", // Empty start
        "code": code
    });

    let json = serialize_project_document(meta)?;
    atomic_write_project_file(&project_path, &json)
        .map_err(|error| format!("Failed to create project file: {}", error))?;

    Ok(ProjectInfo {
        name: final_name,
        path: project_path.to_string_lossy().to_string(),
        board,
        board_package_id: concrete_package_id,
        last_modified: "Now".to_string(),
        block_count: Some(0),
        options: "{}".to_string(),
    })
}

#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let dirs = get_project_dirs(&app);
    Ok(list_projects_in_dirs(&dirs))
}

fn list_projects_in_dirs(dirs: &[PathBuf]) -> Vec<ProjectInfo> {
    let mut projects = Vec::new();

    for dir in dirs {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();

                // Strict Mode: Only show Native Compatible Formats (.ck / .maker)
                // Legacy folder projects (workspace.xml) are excluded as per user request.
                if path.is_file() {
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if ext == "maker" || ext == "ck" {
                        let name = path
                            .file_stem()
                            .and_then(|n| n.to_str())
                            .unwrap_or("Untitled")
                            .to_string();

                        let metadata = fs::metadata(&path).ok();
                        let modified = metadata.and_then(|m| m.modified().ok());
                        let modified_str = if let Some(time) = modified {
                            let datetime: chrono::DateTime<chrono::Local> = time.into();
                            datetime.format("%Y-%m-%d %H:%M").to_string()
                        } else {
                            "Unknown".to_string()
                        };

                        let mut board = "Arduino Uno".to_string();
                        let mut board_package_id = String::new();
                        let mut block_count = None;
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                block_count = dashboard_block_count(&json);
                                if let Some(b) = json.get("board").and_then(|v| v.as_str()) {
                                    board = b.to_string();
                                }
                                if let Some(package_id) =
                                    json.get("board_package_id").and_then(|v| v.as_str())
                                {
                                    board_package_id = package_id.trim().to_string();
                                }
                            }
                        }
                        if board_package_id.is_empty() {
                            board_package_id = board.clone();
                        }

                        projects.push(ProjectInfo {
                            name,
                            path: path.to_string_lossy().to_string(),
                            board,
                            board_package_id,
                            last_modified: modified_str,
                            block_count,
                            options: "{}".to_string(),
                        });
                    }
                }
            }
        }
    }

    // Sort by modified desc
    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    projects
}

#[tauri::command]
pub async fn get_community_examples_dir_cmd(app: AppHandle) -> Result<String, String> {
    Ok(get_community_examples_dir(&app)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub async fn list_community_examples(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let dir = get_community_examples_dir(&app);
    let mut projects = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "maker" && ext != "ck" {
                continue;
            }

            let name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("Untitled")
                .to_string();

            let metadata = fs::metadata(&path).ok();
            let modified = metadata.and_then(|m| m.modified().ok());
            let modified_str = if let Some(time) = modified {
                let datetime: chrono::DateTime<chrono::Local> = time.into();
                datetime.format("%Y-%m-%d %H:%M").to_string()
            } else {
                "Unknown".to_string()
            };

            let mut board = "Arduino Uno".to_string();
            let mut board_package_id = String::new();
            let mut block_count = None;
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    block_count = dashboard_block_count(&json);
                    if let Some(b) = json.get("board").and_then(|v| v.as_str()) {
                        board = b.to_string();
                    }
                    if let Some(package_id) = json.get("board_package_id").and_then(|v| v.as_str())
                    {
                        board_package_id = package_id.trim().to_string();
                    }
                }
            }
            if board_package_id.is_empty() {
                board_package_id = board.clone();
            }

            projects.push(ProjectInfo {
                name,
                path: path.to_string_lossy().to_string(),
                board,
                board_package_id,
                last_modified: modified_str,
                block_count,
                options: "{}".to_string(),
            });
        }
    }

    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(projects)
}

#[tauri::command]
pub async fn delete_project(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("Project path not found".to_string());
    }

    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())?;
    } else if p.is_file() {
        // Single File (ZIP)
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    } else {
        return Err("Invalid path type".to_string());
    }

    Ok(())
}

fn validate_project_leaf_name(value: &str) -> Result<&str, String> {
    let name = value.trim();
    if name.is_empty() || name != value {
        return Err(
            "Project name must not be empty or have leading/trailing whitespace".to_string(),
        );
    }
    if name.chars().count() > 128 {
        return Err("Project name is too long (maximum 128 characters)".to_string());
    }
    if name == "."
        || name == ".."
        || name.ends_with('.')
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(
            "Project name must be a safe single filename without path separators".to_string(),
        );
    }
    let windows_stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let windows_reserved = matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (windows_stem.len() == 4
            && (windows_stem.starts_with("COM") || windows_stem.starts_with("LPT"))
            && matches!(windows_stem.as_bytes()[3], b'1'..=b'9'));
    if windows_reserved {
        return Err("Project name is reserved by Windows".to_string());
    }
    Ok(name)
}

#[tauri::command]
pub async fn rename_project(path: String, new_name: String) -> Result<String, String> {
    let old_path = PathBuf::from(&path);
    if !old_path.exists() {
        return Err("Project path not found".to_string());
    }

    let parent = old_path.parent().ok_or("Invalid path".to_string())?;
    let new_name = validate_project_leaf_name(&new_name)?.to_string();

    // --- Directory Mode ---
    if old_path.is_dir() {
        let new_path = parent.join(&new_name);
        if new_path.exists() {
            return Err("Project name already taken".to_string());
        }

        fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

        // Also rename the .ino file inside
        let old_name = old_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let old_ino = new_path.join(format!("{}.ino", old_name));
        let new_ino = new_path.join(format!("{}.ino", new_name));

        if old_ino.exists() {
            let _ = fs::rename(old_ino, new_ino);
        }

        // Update project.json if exists
        let meta_path = new_path.join("project.json");
        if meta_path.exists() {
            if let Ok(content) = fs::read_to_string(&meta_path) {
                if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
                    json["name"] = serde_json::Value::String(new_name.clone());
                    let _ = fs::write(
                        &meta_path,
                        serde_json::to_string_pretty(&json).unwrap_or_default(),
                    );
                }
            }
        }
        Ok(new_path.to_string_lossy().to_string())
    } else {
        // --- Single File Mode (.maker / .ck) ---
        let ext = old_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "maker" && ext != "ck" {
            return Err("Cannot rename this file type".to_string());
        }

        let new_filename = format!("{}.{}", new_name, ext);
        let new_path = parent.join(&new_filename);

        if new_path.exists() {
            return Err("File name already taken".to_string());
        }

        // Validate and migrate before touching either path. In particular, a
        // project from a future CK release must not be renamed and partially
        // rewritten by this older editor.
        let raw = fs::read_to_string(&old_path)
            .map_err(|error| format!("Failed to read project before rename: {}", error))?;
        let parsed: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Cannot rename an invalid single-file project: {}", error))?;
        let mut document = migrate_project_document_v0_to_v1(parsed)?;
        document["name"] = serde_json::Value::String(new_name.clone());
        let encoded = serialize_project_document(document)?;

        // Publish a complete new document before removing the old one. A
        // process interruption can therefore leave two individually valid
        // files, never a moved file whose internal name still belongs to the
        // old path. Ordinary I/O failure removes the new copy when possible.
        atomic_write_project_file(&new_path, &encoded)?;
        if let Err(error) = fs::remove_file(&old_path) {
            let rollback = fs::remove_file(&new_path);
            return Err(match rollback {
                Ok(()) => format!("Failed to remove original project after rename: {}", error),
                Err(rollback_error) => format!(
                    "Failed to remove original project after rename: {}; additionally failed to remove the complete new copy: {}",
                    error, rollback_error
                ),
            });
        }

        Ok(new_path.to_string_lossy().to_string())
    }
}

// ... existing code ...

// ... (omitted)

fn read_project_build_target(document: &serde_json::Value) -> Result<Option<String>, String> {
    let Some(value) = document.get("build_target").filter(|v| !v.is_null()) else { return Ok(None); };
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    crate::project_build_target::validate(&raw,
        document["board"].as_str().unwrap_or(""),
        document["board_package_id"].as_str().unwrap_or(""),
        document["options"].as_str().unwrap_or("{}"))?;
    Ok(Some(raw))
}

fn apply_project_build_target(document: &mut serde_json::Value, raw: Option<String>) -> Result<(), String> {
    if let Some(raw) = raw {
        document["build_target"] = serde_json::from_str(&raw).map_err(|e| format!("Invalid build target: {e}"))?;
        read_project_build_target(document)?;
    } else if read_project_build_target(document).is_err() {
        // A legacy caller changed the target without a snapshot. Do not retain stale provenance.
        document.as_object_mut().ok_or("Project must be an object")?.remove("build_target");
    }
    Ok(())
}

#[tauri::command]
pub async fn save_project(
    path: String,
    blockly_xml: String,
    code: String,
    options: Option<String>,
    board_package_id: Option<String>,
    block_package_inventory: Option<Vec<BlockPackageInventoryInput>>,
    board: Option<String>,
    build_target: Option<String>,
) -> Result<(), String> {
    let project_path = PathBuf::from(&path);
    if !project_path.exists() {
        return Err("Project not found".to_string());
    }
    let expected_options = options.clone();

    if project_path.is_dir() {
        let meta_path = project_path.join("project.json");
        let mut json = if meta_path.exists() {
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&meta_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid project metadata; refusing overwrite: {e}"))?
        } else { serde_json::json!({}) };
        if !json.is_object() { return Err("Project metadata must be an object".into()); }
        if let Some(board) = board { json["board"] = board.into(); }
        if let Some(opts) = options { json["options"] = opts.into(); }
        if let Some(package) = board_package_id { json["board_package_id"] = package.into(); }
        apply_project_build_target(&mut json, build_target)?;
        apply_enabled_block_package_inventory(&mut json, block_package_inventory)?;
        let name = project_path.file_name().and_then(|n| n.to_str()).unwrap_or("sketch");
        atomic_write_project_file(&project_path.join("workspace.xml"), blockly_xml.as_bytes())?;
        atomic_write_project_file(&project_path.join(format!("{name}.ino")), code.as_bytes())?;
        atomic_write_project_file(&meta_path, &serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?)?;
    } else {
        // --- Single File JSON Mode ---
        let content = fs::read_to_string(&project_path).map_err(|e| e.to_string())?;
        let parsed: serde_json::Value =
            serde_json::from_str(content.trim_start_matches('\u{feff}'))
                .map_err(|e| e.to_string())?;
        let mut json = migrate_project_document_v0_to_v1(parsed)?;

        if let Some(board) = board { json["board"] = board.into(); }
        // 2. Update fields
        json["xml"] = serde_json::Value::String(blockly_xml);
        json["code"] = serde_json::Value::String(code);
        if let Some(opts) = options {
            json["options"] = serde_json::Value::String(opts);
        }
        if let Some(package_id) = board_package_id {
            json["board_package_id"] = serde_json::Value::String(package_id);
        }
        apply_project_build_target(&mut json, build_target)?;
        apply_enabled_block_package_inventory(&mut json, block_package_inventory)?;

        // 3. Write back
        let new_content = serialize_project_document(json)?;
        atomic_write_project_file(&project_path, &new_content)?;
    }
    if let Some(opts) = expected_options {
        verify_saved_project_options(&project_path, &opts)?;
    }

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ProjectData {
    pub xml: String,
    pub board: String,
    pub name: String,
    pub options: String, // JSON string
    pub board_package_id: String,
    pub build_target: Option<String>,
}

fn map_mixly_board_to_ck(raw_board: &str) -> String {
    let trimmed = raw_board.trim();
    if trimmed.is_empty() {
        return "arduino:avr:uno".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();

    if lower.contains("esp8266") {
        if lower.contains("d1") {
            return "esp8266:esp8266:d1_mini".to_string();
        }
        return "esp8266:esp8266:nodemcuv2".to_string();
    }
    if lower.contains("esp32")
        && (lower.contains("s3") || lower.contains("esp32-s3") || lower.contains("esp32s3"))
    {
        return "esp32:esp32:esp32s3".to_string();
    }
    if lower.contains("esp32")
        && (lower.contains("c3") || lower.contains("esp32-c3") || lower.contains("esp32c3"))
    {
        return "esp32:esp32:esp32c3".to_string();
    }
    if lower.contains("esp32") {
        return "esp32:esp32:esp32".to_string();
    }
    if lower.contains("uno") {
        return "arduino:avr:uno".to_string();
    }
    if lower.contains("nano") {
        return "arduino:avr:nano".to_string();
    }
    if lower.contains("mega") {
        return "arduino:avr:mega".to_string();
    }
    trimmed.to_string()
}

fn parse_mixly_project(content: &str, default_name: String) -> Result<ProjectData, String> {
    let text = content.trim_start_matches('\u{FEFF}').trim();
    let xml_re = Regex::new(r"(?is)<xml\b[\s\S]*?</xml>")
        .map_err(|e| format!("Failed to build Mixly xml parser: {}", e))?;
    let board_re = Regex::new(r#"(?is)\bboard\s*=\s*["']([^"']+)["']"#)
        .map_err(|e| format!("Failed to build Mixly board parser: {}", e))?;
    let config_re = Regex::new(r"(?is)<config\b[^>]*>([\s\S]*?)</config>")
        .map_err(|e| format!("Failed to build Mixly config parser: {}", e))?;

    let xml_match = xml_re
        .find(text)
        .ok_or_else(|| "Invalid .mix file: missing <xml>...</xml> payload".to_string())?;
    let xml = xml_match.as_str().trim().to_string();

    let board = board_re
        .captures(&xml)
        .and_then(|caps| caps.get(1))
        .map(|m| map_mixly_board_to_ck(m.as_str()))
        .unwrap_or_else(|| "arduino:avr:uno".to_string());

    let options = config_re
        .captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|raw| serde_json::from_str::<serde_json::Value>(raw).is_ok())
        .unwrap_or_else(|| "{}".to_string());

    Ok(ProjectData {
        build_target: None,
        xml,
        board,
        name: default_name,
        options,
        board_package_id: String::new(),
    })
}

fn extract_relaxed_json_string_field(content: &str, key: &str) -> Option<String> {
    let quoted_key = format!("\"{}\"", key);
    let bytes = content.as_bytes();
    let mut search_from = 0usize;

    while let Some(rel_pos) = content[search_from..].find(&quoted_key) {
        let key_pos = search_from + rel_pos;
        let mut idx = key_pos + quoted_key.len();

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b':' {
            search_from = key_pos + quoted_key.len();
            continue;
        }
        idx += 1;

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b'"' {
            search_from = key_pos + quoted_key.len();
            continue;
        }

        let mut end = idx + 1;
        let mut escaped = false;
        while end < bytes.len() {
            let b = bytes[end];
            if escaped {
                escaped = false;
                end += 1;
                continue;
            }
            if b == b'\\' {
                escaped = true;
                end += 1;
                continue;
            }
            if b == b'"' {
                let quoted_value = &content[idx..=end];
                return serde_json::from_str::<String>(quoted_value).ok();
            }
            end += 1;
        }

        return None;
    }

    None
}

fn read_editable_project_document(path: &Path, purpose: &str) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Err(format!(
            "{} project is not an existing single-file .ck/.maker document: {}",
            purpose,
            path.display()
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "ck" && extension != "maker" {
        return Err(format!(
            "{} project must use .ck or .maker: {}",
            purpose,
            path.display()
        ));
    }
    let raw = fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read {} project '{}': {}",
            purpose,
            path.display(),
            error
        )
    })?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| {
            format!(
                "{} project '{}' is invalid JSON: {}",
                purpose,
                path.display(),
                error
            )
        })?;
    migrate_project_document_v0_to_v1(parsed).map_err(|error| {
        format!(
            "{} project '{}' is invalid: {}",
            purpose,
            path.display(),
            error
        )
    })
}

/// Strictly validate an editable project selected outside CK (for example by
/// Windows file association) before the frontend changes its active project.
/// The actual load still goes through `load_project`; this preflight only
/// prevents an invalid path, a future schema, or corrupt JSON from looking like
/// a successful navigation to an empty workspace.
pub(crate) fn validate_external_project_document(path: &Path) -> Result<(), String> {
    read_editable_project_document(path, "External-open").map(|_| ())
}

fn paths_refer_to_same_project(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[tauri::command]
pub async fn save_project_as(
    target_path: String,
    xml: String,
    code: String,
    board: String,
    options: Option<String>,
    board_package_id: Option<String>,
    block_package_inventory: Option<Vec<BlockPackageInventoryInput>>,
    source_path: Option<String>,
    build_target: Option<String>,
) -> Result<ProjectInfo, String> {
    let path = PathBuf::from(&target_path);

    // Validate extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "maker" && ext != "ck" {
        return Err("File must have .maker or .ck extension".to_string());
    }

    // Determine project name from filename
    let project_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let concrete_package_id = board_package_id.unwrap_or_else(|| board.clone());

    // Save As clones the source document, not the destination. This preserves
    // source extension data while preventing stale/foreign destination fields
    // from being mixed into the project being saved. An existing destination
    // is still parsed and version-checked before it can be replaced.
    let source = source_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let source_is_target = source
        .as_deref()
        .is_some_and(|source| paths_refer_to_same_project(source, &path));

    let mut content = if let Some(source) = source.as_deref() {
        read_editable_project_document(source, "Source")?
    } else {
        serde_json::json!({
            "format": CK_PROJECT_FORMAT,
            "schema_version": CK_PROJECT_SCHEMA_VERSION,
            "migration_version": CK_PROJECT_MIGRATION_VERSION
        })
    };
    if path.exists() && !path.is_file() {
        return Err("Destination is not a regular project file; refusing overwrite".to_string());
    }
    if path.is_file() && !source_is_target {
        // Validation is deliberately detached from `content`: destination data
        // must never become the base of a different source project.
        let _ = read_editable_project_document(&path, "Destination")?;
    }
    content["name"] = serde_json::Value::String(project_name.clone());
    content["board"] = serde_json::Value::String(board.clone());
    content["board_package_id"] = serde_json::Value::String(concrete_package_id.clone());
    if content.get("created_at").is_none() {
        content["created_at"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
    }
    content["xml"] = serde_json::Value::String(xml);
    content["code"] = serde_json::Value::String(code);

    if let Some(ref opts) = options {
        content["options"] = serde_json::Value::String(opts.clone());
    }
    apply_project_build_target(&mut content, build_target)?;
    apply_enabled_block_package_inventory(&mut content, block_package_inventory)?;

    let json = serialize_project_document(content)?;
    atomic_write_project_file(&path, &json)?;
    if let Some(ref opts) = options {
        verify_saved_project_options(&path, opts)?;
    }

    Ok(ProjectInfo {
        name: project_name,
        path: path.to_string_lossy().to_string(),
        board,
        board_package_id: concrete_package_id,
        last_modified: "Now".to_string(),
        block_count: None,
        options: options.unwrap_or_else(|| "{}".to_string()),
    })
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    // Resolve absolute path to ensure accurate parent resolution
    let _ = fs::canonicalize(p);

    #[cfg(target_os = "windows")]
    {
        // Normalize slashes for Windows Command Line reliability
        let clean_path = path.replace("/", "\\");
        let path_obj = std::path::Path::new(&clean_path);

        if path_obj.is_dir() {
            std::process::Command::new("explorer")
                .arg(&clean_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            // User prefers entering the directory containing the file
            if let Some(parent) = path_obj.parent() {
                std::process::Command::new("explorer")
                    .arg(parent)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            } else {
                // Fallback if no parent (root?)
                std::process::Command::new("explorer")
                    .arg("/select,")
                    .arg(&clean_path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if p.is_dir() {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            // macOS -R is usually good (Reveal), usually equates to opening folder and highlighting.
            // If user wants to enter, we can also use parent logic, but Finder handles Reveal well.
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if p.is_dir() {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            let parent = p.parent().unwrap_or(std::path::Path::new("/"));
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn load_project(path: String) -> Result<ProjectData, String> {
    let entry_path = PathBuf::from(&path);

    // Check if it's a directory (Old "Managed" Project) or a File (.maker / .ck)
    if entry_path.is_dir() {
        // ... (Legacy code omitted for brevity but should be kept) ...
        // Re-implementing legacy load briefly for context correctness in tool call
        let xml_path = entry_path.join("workspace.xml");
        let meta_path = entry_path.join("project.json");

        let mut board = "Arduino Uno".to_string();
        let mut name = "Unknown".to_string();
        let mut options = "{}".to_string();
        let mut board_package_id = String::new();
        let mut build_target = None;

        if meta_path.exists() {
            let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
            let json = serde_json::from_str::<serde_json::Value>(&content)
                .map_err(|e| format!("Project metadata is damaged; original file preserved: {e}"))?;
                    build_target = read_project_build_target(&json)?;
                    if let Some(b) = json.get("board").and_then(|v| v.as_str()) {
                        board = b.to_string();
                    }
                    if let Some(n) = json.get("name").and_then(|v| v.as_str()) {
                        name = n.to_string();
                    }
                    if let Some(o) = json.get("options").and_then(|v| v.as_str()) {
                        options = o.to_string();
                    }
                    if let Some(package_id) = json.get("board_package_id").and_then(|v| v.as_str())
                    {
                        board_package_id = package_id.to_string();
                    }
        }

        let named_xml_path = entry_path.join(format!("{}.xml", name));
        let xml = if xml_path.exists() {
            fs::read_to_string(&xml_path).map_err(|e| e.to_string())?
        } else if named_xml_path.exists() {
            fs::read_to_string(&named_xml_path).map_err(|e| e.to_string())?
        } else {
            String::new()
        };

        Ok(ProjectData {
            build_target,
            xml,
            board,
            name,
            options,
            board_package_id,
        })
    } else {
        // --- Single File Support (.maker / .ck) ---
        let ext = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "maker" && ext != "ck" && ext != "mix" {
            return Err("Unsupported file type. Use .maker, .ck, or .mix".to_string());
        }

        let content =
            fs::read_to_string(&entry_path).map_err(|e| format!("Failed to read file: {}", e))?;

        if ext == "mix" {
            let default_name = entry_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            return parse_mixly_project(&content, default_name);
        }

        let mut xml = String::new();
        let mut board = "Arduino Uno".to_string();
        let mut name = entry_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let mut options = "{}".to_string();
        let mut board_package_id = String::new();
        let mut build_target = None;

        if let Ok(parsed) =
            serde_json::from_str::<serde_json::Value>(content.trim_start_matches('\u{feff}'))
        {
            let json = migrate_project_document_v0_to_v1(parsed)?;
            build_target = read_project_build_target(&json)?;
            if let Some(n) = json.get("name").and_then(|v| v.as_str()) {
                name = n.to_string();
            }
            if let Some(b) = json.get("board").and_then(|v| v.as_str()) {
                board = b.to_string();
            }
            if let Some(x) = json.get("xml").and_then(|v| v.as_str()) {
                xml = x.to_string();
            }
            if let Some(o) = json.get("options").and_then(|v| v.as_str()) {
                options = o.to_string();
            }
            if let Some(package_id) = json.get("board_package_id").and_then(|v| v.as_str()) {
                board_package_id = package_id.to_string();
            }
        } else {
            if content.contains("\"build_target\"") {
                return Err("Project configuration cannot be recovered from malformed JSON; original file preserved".into());
            }
            // Salvage malformed .maker/.ck content by extracting key string fields directly.
            if let Some(n) = extract_relaxed_json_string_field(&content, "name") {
                if !n.trim().is_empty() {
                    name = n;
                }
            }
            if let Some(b) = extract_relaxed_json_string_field(&content, "board") {
                if !b.trim().is_empty() {
                    board = b;
                }
            }
            if let Some(x) = extract_relaxed_json_string_field(&content, "xml") {
                if !x.trim().is_empty() {
                    xml = x;
                }
            }
            if let Some(o) = extract_relaxed_json_string_field(&content, "options") {
                if !o.trim().is_empty() {
                    options = o;
                }
            }
            if let Some(package_id) =
                extract_relaxed_json_string_field(&content, "board_package_id")
            {
                board_package_id = package_id;
            }

            // Last fallback: accept raw XML payload inside malformed text.
            if xml.trim().is_empty() {
                if let Ok(xml_re) = Regex::new(r"(?is)<xml\b[\s\S]*?</xml>") {
                    if let Some(xml_match) = xml_re.find(&content) {
                        xml = xml_match.as_str().trim().to_string();
                    }
                }
            }
        }

        Ok(ProjectData {
            build_target,
            xml,
            board,
            name,
            options,
            board_package_id,
        })
    }
}

// Templates
#[cfg(test)]
mod build_target_tests {
    use super::*;

    fn target(board: &str, options: &str) -> String {
        let options: serde_json::Value = serde_json::from_str(options).unwrap();
        let suffix = options.as_object().unwrap().iter().map(|(k,v)| format!("{}={}", k, v.as_str().unwrap())).collect::<Vec<_>>().join(",");
        serde_json::json!({ "schemaVersion": 1, "board": board, "boardPackageId": board,
            "coreId": board.split(':').take(2).collect::<Vec<_>>().join(":"), "coreVersion": "3.3.6-cn",
            "options": options, "optionsComplete": true, "fqbn": format!("{board}:{suffix}") }).to_string()
    }

    #[test]
    fn save_load_and_save_as_preserve_full_board_environment() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let first = root.path().join("默认参数.ck");
            let second = root.path().join("副本.ck");
            let board = "esp32:esp32:esp32s3";
            let options = r#"{"PSRAM":"disabled","USBMode":"hwcdc","PartitionScheme":"default","FlashSize":"8M"}"#;
            let snapshot = target(board, options);
            save_project_as(first.to_string_lossy().into(), "{}".into(), "void setup() {}".into(), board.into(),
                Some(options.into()), Some(board.into()), None, None, Some(snapshot.clone())).await.unwrap();
            let loaded = load_project(first.to_string_lossy().into()).await.unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&loaded.build_target.unwrap()).unwrap(),
                serde_json::from_str::<serde_json::Value>(&snapshot).unwrap());
            save_project_as(second.to_string_lossy().into(), "{}".into(), "void loop() {}".into(), board.into(),
                Some(options.into()), Some(board.into()), None, Some(first.to_string_lossy().into()), Some(snapshot.clone())).await.unwrap();
            assert_eq!(load_project(second.to_string_lossy().into()).await.unwrap().options, options);
            let before = fs::read(&second).unwrap();
            let invalid = snapshot.replace("3.3.6-cn", "");
            assert!(save_project_as(second.to_string_lossy().into(), "{}".into(), "bad".into(), board.into(),
                Some(options.into()), Some(board.into()), None, Some(second.to_string_lossy().into()), Some(invalid)).await.is_err());
            assert_eq!(fs::read(&second).unwrap(), before);
        });
    }

    #[test]
    fn folder_save_updates_board_and_rejects_bad_target_before_any_write() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let folder = root.path().join("legacy"); fs::create_dir(&folder).unwrap();
            fs::write(folder.join("project.json"), r#"{"name":"legacy","board":"arduino:avr:uno"}"#).unwrap();
            let board = "arduino:avr:nano";
            let options = r#"{"cpu":"atmega328old"}"#;
            let snapshot = target(board, options).replace("3.3.6-cn", "1.8.6");
            save_project(folder.to_string_lossy().into(), "{}".into(), "old bootloader".into(), Some(options.into()),
                Some(board.into()), None, Some(board.into()), Some(snapshot.clone())).await.unwrap();
            let loaded = load_project(folder.to_string_lossy().into()).await.unwrap();
            assert_eq!(loaded.board, board); assert_eq!(loaded.options, options);
            assert!(loaded.build_target.unwrap().contains("1.8.6"));
            assert!(save_project(folder.to_string_lossy().into(), "bad".into(), "bad".into(), Some("{}".into()),
                Some(board.into()), None, Some(board.into()), Some(snapshot)).await.is_err());
            assert_eq!(fs::read_to_string(folder.join("legacy.ino")).unwrap(), "old bootloader");
        });
    }
}

const EMPTY_TEMPLATE: &str = r#"void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your main code here, to run repeatedly:

}
"#;

const BLINK_TEMPLATE: &str = r#"void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);   // turn the LED on (HIGH is the voltage level)
  delay(1000);                       // wait for a second
  digitalWrite(LED_BUILTIN, LOW);    // turn the LED off by making the voltage LOW
  delay(1000);                       // wait for a second
}
"#;

const SERVO_TEMPLATE: &str = r#"#include <Servo.h>

Servo myservo;  // create servo object to control a servo

void setup() {
  myservo.attach(9);  // attaches the servo on pin 9 to the servo object
}

void loop() {
  myservo.write(0);
  delay(1000);
  myservo.write(90);
  delay(1000);
  myservo.write(180);
  delay(1000);
}
"#;

const SERIAL_TEST_TEMPLATE: &str = r#"void setup() {
  Serial.begin(115200);
  while (!Serial) {
    ; // wait for serial port to connect. Needed for native USB port only
  }
}

void loop() {
  // High speed printing test
  Serial.println("Testing High Speed Serial: " + String(millis()));
  Serial.println("The quick brown fox jumps over the lazy dog.");
  Serial.print("Part 1...");
  delay(10);
  Serial.println("Part 2 (Completed line)");
  delay(50); // Small delay to prevent complete flooding, but fast enough to test
}
"#;

#[cfg(test)]
mod project_roots_tests {
    use super::*;

    struct TestSandbox {
        path: PathBuf,
    }

    impl TestSandbox {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("ck-project-roots-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create isolated project-root sandbox");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestSandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_project(path: &PathBuf, name: &str, board: &str) {
        let content = serde_json::json!({
            "name": name,
            "board": board,
            "xml": "",
            "code": ""
        });
        fs::write(path, serde_json::to_string_pretty(&content).unwrap())
            .expect("write fixture project");
    }

    fn copy_tree(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let destination = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &destination);
            } else {
                fs::copy(entry.path(), destination).unwrap();
            }
        }
    }

    fn certified_declarative_package(sandbox: &TestSandbox) -> (PathBuf, String) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_serial_blocks");
        let package = sandbox.child("ck_example_serial_blocks");
        copy_tree(&source, &package);
        let report = crate::lib_custom_registry::inspect_library_package(&package, true);
        report.enforce().unwrap();
        assert!(
            crate::package_quality::runtime_quality_report_is_trusted_for_package(
                Some(&report),
                "block-library",
                "ck_example_serial_blocks",
            )
        );
        let hash = report.source_content_sha256.clone().unwrap();
        crate::package_quality::write_quality_report(&package, &report).unwrap();
        (package, hash)
    }

    #[test]
    fn configured_roots_are_created_and_keep_saved_order() {
        let sandbox = TestSandbox::new();
        let first = sandbox.child("first");
        let second = sandbox.child("second");
        let fallback = sandbox.child("fallback");

        let resolved = resolve_project_dirs(
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            fallback,
        );

        assert_eq!(resolved, vec![first.clone(), second.clone()]);
        assert!(first.is_dir());
        assert!(second.is_dir());
    }

    #[test]
    fn saved_roots_create_missing_directories_and_remove_duplicates() {
        let sandbox = TestSandbox::new();
        let first = sandbox.child("first");
        let second = sandbox.child("second");

        let validated = validate_project_roots(vec![
            format!("  {}  ", first.to_string_lossy()),
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
        ])
        .expect("validate project roots");

        assert_eq!(
            validated,
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string()
            ]
        );
        assert!(first.is_dir());
        assert!(second.is_dir());
    }

    #[test]
    fn saved_roots_reject_file_paths() {
        let sandbox = TestSandbox::new();
        let file_path = sandbox.child("not-a-directory");
        fs::write(&file_path, "fixture").unwrap();

        let error = validate_project_roots(vec![file_path.to_string_lossy().to_string()])
            .expect_err("file path must not be accepted as a project root");

        assert!(error.contains("不是文件夹"));
    }

    #[test]
    fn legacy_duplicate_roots_do_not_duplicate_project_cards() {
        let sandbox = TestSandbox::new();
        let root = sandbox.child("projects");
        fs::create_dir_all(&root).unwrap();
        write_project(&root.join("single.maker"), "single", "arduino:avr:uno");

        let resolved = resolve_project_dirs(
            vec![
                root.to_string_lossy().to_string(),
                root.to_string_lossy().to_string(),
            ],
            sandbox.child("fallback"),
        );
        let projects = list_projects_in_dirs(&resolved);

        assert_eq!(resolved.len(), 1);
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn legacy_file_root_is_skipped_before_selecting_default_root() {
        let sandbox = TestSandbox::new();
        let invalid_file = sandbox.child("invalid-root");
        let valid_root = sandbox.child("valid-root");
        fs::write(&invalid_file, "not a directory").unwrap();

        let resolved = resolve_project_dirs(
            vec![
                invalid_file.to_string_lossy().to_string(),
                valid_root.to_string_lossy().to_string(),
            ],
            sandbox.child("fallback"),
        );

        assert_eq!(resolved, vec![valid_root]);
    }

    #[test]
    fn project_creation_targets_first_resolved_root() {
        let sandbox = TestSandbox::new();
        let first = sandbox.child("first");
        let second = sandbox.child("second");
        let resolved = resolve_project_dirs(
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            sandbox.child("fallback"),
        );

        let created = create_project_in_dir(
            resolved.first().unwrap(),
            "root-contract".to_string(),
            "arduino:avr:uno".to_string(),
            Some("vendor-uno-carrier".to_string()),
            Some("empty".to_string()),
        )
        .expect("create project in first root");

        assert_eq!(PathBuf::from(created.path), first.join("root-contract.ck"));
        assert!(first.join("root-contract.ck").is_file());
        assert!(!second.join("root-contract.ck").exists());
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(first.join("root-contract.ck")).unwrap())
                .unwrap();
        assert_eq!(saved["format"], CK_PROJECT_FORMAT);
        assert_eq!(saved["schema_version"], CK_PROJECT_SCHEMA_VERSION);
        assert_eq!(saved["migration_version"], CK_PROJECT_MIGRATION_VERSION);
        assert_eq!(saved["board"], "arduino:avr:uno");
        assert_eq!(saved["board_package_id"], "vendor-uno-carrier");
    }

    #[test]
    fn v0_migration_is_data_only_and_preserves_unknown_fields() {
        let legacy = serde_json::json!({
            "name": "legacy",
            "board": "arduino:avr:uno",
            "xml": "<xml />",
            "code": "void setup() {}",
            "vendor_extension": {
                "opaque": true,
                "items": [1, 2, { "future": "kept" }]
            }
        });
        let migrated = migrate_project_document_v0_to_v1(legacy.clone()).unwrap();

        assert_eq!(migrated["format"], CK_PROJECT_FORMAT);
        assert_eq!(migrated["schema_version"], CK_PROJECT_SCHEMA_VERSION);
        assert_eq!(migrated["migration_version"], CK_PROJECT_MIGRATION_VERSION);
        assert_eq!(migrated["vendor_extension"], legacy["vendor_extension"]);
        assert_eq!(migrated["name"], legacy["name"]);
        assert_eq!(migrated["xml"], legacy["xml"]);
        assert_eq!(migrated["code"], legacy["code"]);
    }

    #[test]
    fn legacy_maker_load_is_non_mutating_and_next_save_upgrades_in_place() {
        let sandbox = TestSandbox::new();
        let path = sandbox.child("legacy-preserved.maker");
        let legacy = serde_json::json!({
            "name": "legacy-preserved",
            "board": "arduino:avr:uno",
            "xml": "<xml />",
            "code": "void setup() {}",
            "options": "{}",
            "unknown_extension": { "nested": ["kept", 7] }
        });
        let original = serde_json::to_vec_pretty(&legacy).unwrap();
        fs::write(&path, &original).unwrap();

        let loaded =
            tauri::async_runtime::block_on(load_project(path.to_string_lossy().to_string()))
                .unwrap();
        assert_eq!(loaded.name, "legacy-preserved");
        assert_eq!(
            fs::read(&path).unwrap(),
            original,
            "load must not rewrite v0"
        );

        tauri::async_runtime::block_on(save_project(
            path.to_string_lossy().to_string(),
            "<xml id=\"saved\" />".to_string(),
            "void setup() { pinMode(13, OUTPUT); }".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            None,
            None, None,
        ))
        .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("maker")
        );
        assert_eq!(saved["format"], CK_PROJECT_FORMAT);
        assert_eq!(saved["schema_version"], CK_PROJECT_SCHEMA_VERSION);
        assert_eq!(saved["migration_version"], CK_PROJECT_MIGRATION_VERSION);
        assert_eq!(saved["unknown_extension"], legacy["unknown_extension"]);
        assert_eq!(saved["xml"], "<xml id=\"saved\" />");
    }

    #[test]
    fn unversioned_ck_save_preserves_nested_extension_data() {
        let sandbox = TestSandbox::new();
        let path = sandbox.child("unversioned.ck");
        let legacy = serde_json::json!({
            "name": "unversioned",
            "board": "esp32:esp32:esp32c6",
            "xml": "old workspace",
            "code": "old source",
            "options": "{}",
            "third_party": {
                "contract": { "revision": 7 },
                "values": [false, null, "opaque"]
            }
        });
        fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        tauri::async_runtime::block_on(save_project(
            path.to_string_lossy().to_string(),
            "new workspace".to_string(),
            "new source".to_string(),
            None,
            None,
            None,
            None, None,
        ))
        .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["format"], CK_PROJECT_FORMAT);
        assert_eq!(saved["schema_version"], CK_PROJECT_SCHEMA_VERSION);
        assert_eq!(saved["migration_version"], CK_PROJECT_MIGRATION_VERSION);
        assert_eq!(saved["third_party"], legacy["third_party"]);
        assert_eq!(saved["xml"], "new workspace");
        assert_eq!(saved["code"], "new source");
    }

    #[test]
    fn save_as_new_path_clones_source_unknown_fields_without_mutating_source() {
        let sandbox = TestSandbox::new();
        let source = sandbox.child("source.ck");
        let target = sandbox.child("copy.ck");
        let source_document = serde_json::json!({
            "format": CK_PROJECT_FORMAT,
            "schema_version": CK_PROJECT_SCHEMA_VERSION,
            "migration_version": CK_PROJECT_MIGRATION_VERSION,
            "name": "source",
            "board": "arduino:avr:uno",
            "board_package_id": "arduino:avr:uno",
            "xml": "old workspace",
            "code": "old source",
            "options": "{}",
            "vendor_extension": {
                "opaque": [1, { "kept": true }]
            },
            "ck_block_packages": {
                "schema_version": 1,
                "packages": {}
            }
        });
        let source_bytes = serde_json::to_vec_pretty(&source_document).unwrap();
        fs::write(&source, &source_bytes).unwrap();

        tauri::async_runtime::block_on(save_project_as(
            target.to_string_lossy().to_string(),
            "new workspace".to_string(),
            "new source".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            None,
            Some(source.to_string_lossy().to_string()),
            None,
        ))
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(saved["name"], "copy");
        assert_eq!(saved["xml"], "new workspace");
        assert_eq!(
            saved["vendor_extension"],
            source_document["vendor_extension"]
        );
        assert_eq!(
            saved["ck_block_packages"],
            source_document["ck_block_packages"]
        );
    }

    #[test]
    fn save_as_existing_target_never_mixes_target_extension_fields_into_source() {
        let sandbox = TestSandbox::new();
        let source = sandbox.child("source.ck");
        let target = sandbox.child("target.ck");
        fs::write(
            &source,
            serde_json::to_vec_pretty(&serde_json::json!({
                "name": "source",
                "board": "arduino:avr:uno",
                "xml": "source workspace",
                "code": "",
                "source_extension": { "owner": "source" }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            &target,
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": CK_PROJECT_FORMAT,
                "schema_version": CK_PROJECT_SCHEMA_VERSION,
                "migration_version": CK_PROJECT_MIGRATION_VERSION,
                "name": "target",
                "board": "arduino:avr:uno",
                "xml": "target workspace",
                "code": "",
                "target_extension": { "owner": "target" }
            }))
            .unwrap(),
        )
        .unwrap();

        tauri::async_runtime::block_on(save_project_as(
            target.to_string_lossy().to_string(),
            "saved workspace".to_string(),
            "saved source".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            None,
            Some(source.to_string_lossy().to_string()),
            None,
        ))
        .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(saved["source_extension"]["owner"], "source");
        assert!(saved.get("target_extension").is_none());
        assert_eq!(saved["xml"], "saved workspace");
    }

    #[test]
    fn source_less_recovery_save_starts_from_a_clean_v1_document() {
        let sandbox = TestSandbox::new();
        let target = sandbox.child("recovered.ck");
        fs::write(
            &target,
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": CK_PROJECT_FORMAT,
                "schema_version": CK_PROJECT_SCHEMA_VERSION,
                "migration_version": CK_PROJECT_MIGRATION_VERSION,
                "name": "old-target",
                "board": "arduino:avr:uno",
                "xml": "old target workspace",
                "code": "",
                "target_only_extension": { "must_not_leak": true }
            }))
            .unwrap(),
        )
        .unwrap();

        tauri::async_runtime::block_on(save_project_as(
            target.to_string_lossy().to_string(),
            "recovered workspace".to_string(),
            "recovered source".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            None,
            None,
            None,
        ))
        .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(saved["format"], CK_PROJECT_FORMAT);
        assert_eq!(saved["schema_version"], CK_PROJECT_SCHEMA_VERSION);
        assert_eq!(saved["migration_version"], CK_PROJECT_MIGRATION_VERSION);
        assert_eq!(saved["xml"], "recovered workspace");
        assert!(saved.get("target_only_extension").is_none());
    }

    #[test]
    fn invalid_known_fields_and_partial_or_zero_identity_fail_closed() {
        let valid_payload = serde_json::json!({
            "name": "invalid-fixture",
            "board": "arduino:avr:uno",
            "xml": "<xml />",
            "code": ""
        });
        let cases = [
            ("legacy-missing-xml", {
                let mut value = valid_payload.clone();
                value.as_object_mut().unwrap().remove("xml");
                value
            }),
            ("legacy-object-xml", {
                let mut value = valid_payload.clone();
                value["xml"] = serde_json::json!({ "not": "workspace text" });
                value
            }),
            ("partial-identity", {
                let mut value = valid_payload.clone();
                value["format"] = serde_json::Value::String(CK_PROJECT_FORMAT.to_string());
                value["schema_version"] = serde_json::Value::from(CK_PROJECT_SCHEMA_VERSION);
                value
            }),
            ("zero-schema", {
                let mut value = valid_payload.clone();
                value["format"] = serde_json::Value::String(CK_PROJECT_FORMAT.to_string());
                value["schema_version"] = serde_json::Value::from(0);
                value["migration_version"] = serde_json::Value::from(CK_PROJECT_MIGRATION_VERSION);
                value
            }),
            ("zero-migration", {
                let mut value = valid_payload.clone();
                value["format"] = serde_json::Value::String(CK_PROJECT_FORMAT.to_string());
                value["schema_version"] = serde_json::Value::from(CK_PROJECT_SCHEMA_VERSION);
                value["migration_version"] = serde_json::Value::from(0);
                value
            }),
            ("v1-object-xml", {
                let mut value = valid_payload.clone();
                value["format"] = serde_json::Value::String(CK_PROJECT_FORMAT.to_string());
                value["schema_version"] = serde_json::Value::from(CK_PROJECT_SCHEMA_VERSION);
                value["migration_version"] = serde_json::Value::from(CK_PROJECT_MIGRATION_VERSION);
                value["xml"] = serde_json::json!(["not", "workspace text"]);
                value
            }),
        ];

        for (label, document) in cases {
            let sandbox = TestSandbox::new();
            let path = sandbox.child(&format!("{}.ck", label));
            let original = serde_json::to_vec_pretty(&document).unwrap();
            fs::write(&path, &original).unwrap();

            let load_error =
                tauri::async_runtime::block_on(load_project(path.to_string_lossy().to_string()))
                    .expect_err("invalid project must not open as an empty editable project");
            assert!(
                !load_error.trim().is_empty(),
                "{} must report a reason",
                label
            );

            let save_error = tauri::async_runtime::block_on(save_project(
                path.to_string_lossy().to_string(),
                "replacement".to_string(),
                "replacement".to_string(),
                None,
                None,
                None,
            None, None,
        ))
            .expect_err("invalid project must not be overwritten");
            assert!(
                !save_error.trim().is_empty(),
                "{} save must report a reason",
                label
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                original,
                "{} changed on failure",
                label
            );
        }
    }

    #[test]
    fn future_project_versions_are_rejected_without_rewrite() {
        let sandbox = TestSandbox::new();
        for (field, version) in [
            ("schema_version", CK_PROJECT_SCHEMA_VERSION + 1),
            ("migration_version", CK_PROJECT_MIGRATION_VERSION + 1),
        ] {
            let path = sandbox.child(&format!("future-{}.ck", field));
            let mut future = serde_json::json!({
                "format": CK_PROJECT_FORMAT,
                "schema_version": CK_PROJECT_SCHEMA_VERSION,
                "migration_version": CK_PROJECT_MIGRATION_VERSION,
                "name": "future",
                "board": "arduino:avr:uno",
                "xml": "<xml />",
                "code": "void setup() {}",
                "future_payload": { "must": "survive" }
            });
            future[field] = serde_json::Value::from(version);
            let original = serde_json::to_vec_pretty(&future).unwrap();
            fs::write(&path, &original).unwrap();

            let load_error =
                tauri::async_runtime::block_on(load_project(path.to_string_lossy().to_string()))
                    .expect_err("future project must be rejected on load");
            assert!(load_error.contains("Unsupported CK Project Format"));

            let rename_error = tauri::async_runtime::block_on(rename_project(
                path.to_string_lossy().to_string(),
                format!("renamed-future-{}", field),
            ))
            .expect_err("future project must be rejected before rename");
            assert!(rename_error.contains("Unsupported CK Project Format"));
            assert!(path.is_file());
            assert!(
                !sandbox
                    .child(&format!("renamed-future-{}.ck", field))
                    .exists()
            );

            let save_error = tauri::async_runtime::block_on(save_project(
                path.to_string_lossy().to_string(),
                "changed".to_string(),
                "changed".to_string(),
                None,
                None,
                None,
            None, None,
        ))
            .expect_err("future project must be rejected on save");
            assert!(save_error.contains("Unsupported CK Project Format"));
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn atomic_project_save_replaces_complete_file_and_cleans_temporary() {
        let sandbox = TestSandbox::new();
        let path = sandbox.child("atomic.ck");
        fs::write(&path, b"old-content-that-must-not-remain").unwrap();
        let document = serde_json::json!({
            "name": "atomic",
            "board": "arduino:avr:uno",
            "xml": "",
            "code": "void setup() {}",
            "unknown": "preserved"
        });
        let encoded = serialize_project_document(document).unwrap();

        atomic_write_project_file(&path, &encoded).unwrap();

        assert_eq!(fs::read(&path).unwrap(), encoded);
        let leftovers = fs::read_dir(&sandbox.path)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".ck-write-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn single_file_rename_rejects_path_components_and_publishes_complete_copy() {
        let sandbox = TestSandbox::new();
        let old_path = sandbox.child("rename-source.ck");
        let original = serde_json::json!({
            "format": CK_PROJECT_FORMAT,
            "schema_version": CK_PROJECT_SCHEMA_VERSION,
            "migration_version": CK_PROJECT_MIGRATION_VERSION,
            "name": "rename-source",
            "board": "arduino:avr:uno",
            "xml": "<xml />",
            "code": "void setup() {}",
            "vendor_extension": { "must_survive": true }
        });
        let original_bytes = serde_json::to_vec_pretty(&original).unwrap();
        fs::write(&old_path, &original_bytes).unwrap();

        for unsafe_name in [
            "../escape",
            "child/name",
            "child\\name",
            ".",
            "..",
            "CON",
            " trailing",
        ] {
            let error = tauri::async_runtime::block_on(rename_project(
                old_path.to_string_lossy().to_string(),
                unsafe_name.to_string(),
            ))
            .expect_err("unsafe leaf name must be rejected");
            assert!(error.contains("Project name"), "{unsafe_name}: {error}");
            assert_eq!(fs::read(&old_path).unwrap(), original_bytes);
        }

        let renamed = tauri::async_runtime::block_on(rename_project(
            old_path.to_string_lossy().to_string(),
            "renamed-safe".to_string(),
        ))
        .unwrap();
        let renamed_path = PathBuf::from(renamed);
        assert_eq!(renamed_path, sandbox.child("renamed-safe.ck"));
        assert!(!old_path.exists());
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&renamed_path).unwrap()).unwrap();
        assert_eq!(saved["name"], "renamed-safe");
        assert_eq!(saved["vendor_extension"], original["vendor_extension"]);
        assert_eq!(saved["format"], CK_PROJECT_FORMAT);
    }

    #[test]
    fn single_file_project_round_trips_exact_package_id_for_shared_fqbn() {
        let sandbox = TestSandbox::new();
        let path = sandbox.child("shared-fqbn.maker");
        let target = "esp32:esp32:esp32c6";
        tauri::async_runtime::block_on(save_project_as(
            path.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            target.to_string(),
            Some("{}".to_string()),
            Some("acme-c6-a".to_string()),
            None,
            None,
            None,
        ))
        .unwrap();
        let first =
            tauri::async_runtime::block_on(load_project(path.to_string_lossy().to_string()))
                .unwrap();
        assert_eq!(first.board, target);
        assert_eq!(first.board_package_id, "acme-c6-a");

        tauri::async_runtime::block_on(save_project_as(
            path.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            target.to_string(),
            Some("{}".to_string()),
            Some("acme-c6-b".to_string()),
            None,
            None,
            None,
        ))
        .unwrap();
        let second =
            tauri::async_runtime::block_on(load_project(path.to_string_lossy().to_string()))
                .unwrap();
        assert_eq!(second.board, target);
        assert_eq!(second.board_package_id, "acme-c6-b");

        let listed = list_projects_in_dirs(std::slice::from_ref(&sandbox.path));
        let listed_project = listed
            .iter()
            .find(|project| PathBuf::from(&project.path) == path)
            .expect("saved project is listed");
        assert_eq!(listed_project.board, target);
        assert_eq!(listed_project.board_package_id, "acme-c6-b");
    }

    #[test]
    fn single_file_save_preserves_block_package_migration_evidence() {
        let sandbox = TestSandbox::new();
        let path = sandbox.child("migration-evidence.maker");
        let evidence = serde_json::json!({
            "schema_version": 1,
            "packages": {
                "vendor_sensor": {
                    "version": "2.0.0",
                    "content_sha256": "a".repeat(64),
                    "migration": {
                        "step_ids": ["v1-to-v2"],
                        "checkpoint_id": "checkpoint-before-migration"
                    }
                }
            }
        });
        fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "name": "migration-evidence",
                "board": "arduino:avr:uno",
                "board_package_id": "arduino:avr:uno",
                "xml": "{}",
                "code": "",
                "options": "{}",
                "ck_block_packages": evidence,
                "future_field": { "opaque": true }
            }))
            .unwrap(),
        )
        .unwrap();

        tauri::async_runtime::block_on(save_project_as(
            path.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            None,
            Some(path.to_string_lossy().to_string()),
            None,
        ))
        .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["ck_block_packages"], evidence);
        assert_eq!(saved["future_field"]["opaque"], true);
        assert_eq!(saved["xml"], r#"{"blocks":{"blocks":[]}}"#);
    }

    #[test]
    fn single_file_save_records_verified_enabled_package_inventory() {
        let sandbox = TestSandbox::new();
        let (package, content_sha256) = certified_declarative_package(&sandbox);
        let path = sandbox.child("enabled-inventory.maker");
        let inventory = BlockPackageInventoryInput {
            package_id: "ck_example_serial_blocks".to_string(),
            version: "1.0.0".to_string(),
            content_sha256: content_sha256.clone(),
            package_path: package.to_string_lossy().to_string(),
        };

        tauri::async_runtime::block_on(save_project_as(
            path.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            Some(vec![inventory.clone()]),
            None,
            None,
        ))
        .unwrap();

        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let record = &saved["ck_block_packages"]["packages"]["ck_example_serial_blocks"];
        assert_eq!(
            saved["ck_block_packages"]["inventory_semantics"],
            "enabled-declarative-runtime-packages"
        );
        assert_eq!(record["version"], "1.0.0");
        assert_eq!(record["content_sha256"], content_sha256);
        assert_eq!(record["provenance"], "enabled-runtime-inventory");

        saved["ck_block_packages"]["packages"]["ck_example_serial_blocks"]["migration"] =
            serde_json::json!({"step_ids": ["kept"]});
        fs::write(&path, serde_json::to_vec_pretty(&saved).unwrap()).unwrap();
        tauri::async_runtime::block_on(save_project_as(
            path.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            "arduino:avr:uno".to_string(),
            Some("{}".to_string()),
            Some("arduino:avr:uno".to_string()),
            Some(vec![inventory]),
            Some(path.to_string_lossy().to_string()),
            None,
        ))
        .unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            saved["ck_block_packages"]["packages"]["ck_example_serial_blocks"]["migration"]["step_ids"]
                [0],
            "kept"
        );
    }

    #[test]
    fn legacy_folder_persists_package_id_even_without_explicit_options() {
        let sandbox = TestSandbox::new();
        let project = sandbox.child("legacy-folder");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.json"),
            serde_json::json!({
                "name": "legacy-folder",
                "board": "esp32:esp32:esp32c6"
            })
            .to_string(),
        )
        .unwrap();
        tauri::async_runtime::block_on(save_project(
            project.to_string_lossy().to_string(),
            r#"{"blocks":{"blocks":[]}}"#.to_string(),
            "void setup() {}".to_string(),
            None,
            Some("acme-c6-carrier".to_string()),
            None,
            None, None,
        ))
        .unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(project.join("project.json")).unwrap())
                .unwrap();
        assert_eq!(saved["board_package_id"], "acme-c6-carrier");
    }

    #[test]
    fn project_listing_scans_every_root_and_filters_non_project_files() {
        let sandbox = TestSandbox::new();
        let first = sandbox.child("first");
        let second = sandbox.child("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();

        let first_project = first.join("alpha.maker");
        let second_project = second.join("beta.CK");
        write_project(&first_project, "alpha", "arduino:avr:uno");
        write_project(&second_project, "beta", "esp32:esp32:esp32");
        fs::write(first.join("ignored.txt"), "not a project").unwrap();

        let projects = list_projects_in_dirs(&[first, second]);
        assert_eq!(projects.len(), 2);
        assert!(projects.iter().any(|project| {
            PathBuf::from(&project.path) == first_project
                && project.board == "arduino:avr:uno"
                && project.board_package_id == "arduino:avr:uno"
        }));
        assert!(projects.iter().any(|project| {
            PathBuf::from(&project.path) == second_project
                && project.board == "esp32:esp32:esp32"
                && project.board_package_id == "esp32:esp32:esp32"
        }));
    }

    #[test]
    fn project_root_config_schema_round_trips_all_roots() {
        let sandbox = TestSandbox::new();
        let config_path = sandbox.child("config.json");
        let expected = vec![
            sandbox.child("first").to_string_lossy().to_string(),
            sandbox.child("second").to_string_lossy().to_string(),
        ];
        let config = AppConfig {
            project_roots: expected.clone(),
            project_root: None,
        };

        fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        let loaded: AppConfig =
            serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();

        assert_eq!(loaded.project_roots, expected);
        assert!(loaded.project_root.is_none());
    }
}
