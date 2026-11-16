use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const RECOVERY_DRAFT_SCHEMA_VERSION: u32 = 1;
const MAX_DRAFTS_PER_PROJECT: usize = 3;
const MAX_DRAFT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROJECT_DRAFT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_DRAFTS: usize = 120;
const MAX_TOTAL_DRAFT_BYTES: u64 = 128 * 1024 * 1024;
const DRAFT_SUFFIX: &str = ".draft.json";
const CHECKPOINT_SUFFIX: &str = ".checkpoint.json";
const QUARANTINE_DIR: &str = "_quarantine";
const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecoveryDraftInput {
    pub project_path: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub disk_baseline_hash: String,
    #[serde(default)]
    pub disk_baseline_modified_at: Option<String>,
    /// Exact JSON returned by Blockly.serialization.workspaces.save().
    pub workspace_json: String,
    /// Generated source captured at the same instant as `workspace_json`.
    pub source_code: String,
    pub board: String,
    pub fqbn: String,
    #[serde(default)]
    pub board_package_id: String,
    pub options: String,
    #[serde(default)]
    pub build_target: Option<String>,
    /// Optional client-side calculation of the same full-state hash. Supplying
    /// it catches accidental field skew before a draft is committed.
    #[serde(default)]
    pub expected_full_state_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub schema_version: u32,
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
    pub created_at: String,
    pub disk_baseline_hash: String,
    #[serde(default)]
    pub disk_baseline_modified_at: Option<String>,
    pub full_state_hash: String,
    pub workspace_json: String,
    pub source_code: String,
    pub board: String,
    pub fqbn: String,
    #[serde(default)]
    pub board_package_id: String,
    pub options: String,
    #[serde(default)]
    pub build_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraftMetadata {
    pub schema_version: u32,
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
    pub created_at: String,
    pub disk_baseline_hash: String,
    pub disk_baseline_modified_at: Option<String>,
    pub full_state_hash: String,
    pub board: String,
    pub fqbn: String,
    pub board_package_id: String,
    pub options: String,
    #[serde(default)]
    pub build_target: Option<String>,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecoveryBaseline {
    pub project_path: String,
    pub project_id: String,
    pub sha256: String,
    pub modified_at: Option<String>,
    pub byte_size: u64,
}

#[derive(Debug)]
struct StoredDraft {
    path: PathBuf,
    draft: RecoveryDraft,
    byte_size: u64,
}

fn normalized_project_path(project_path: &str) -> String {
    let path = PathBuf::from(project_path.trim());
    let resolved = fs::canonicalize(&path).unwrap_or(path);
    let mut normalized = resolved.to_string_lossy().to_string();
    if cfg!(windows) {
        normalized = normalized.replace('\\', "/");
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn project_storage_key(project_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_project_path(project_path).as_bytes());
    hex::encode(hasher.finalize())
}

fn default_project_id(project_path: &str) -> String {
    format!("path-sha256:{}", project_storage_key(project_path))
}

fn resolve_project_id(raw: Option<&str>, project_path: &str) -> Result<String, String> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(default_project_id(project_path));
    };
    if value.len() > 256 || value.chars().any(char::is_control) {
        return Err("Project id is invalid".to_string());
    }
    Ok(value.to_string())
}

fn recovery_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    Ok(app_data.join("recovery-drafts-v1"))
}

fn recovery_dir(root: &Path, project_path: &str) -> PathBuf {
    root.join(project_storage_key(project_path))
}

fn draft_file_name(id: &str) -> String {
    format!("{}{}", id, DRAFT_SUFFIX)
}

fn draft_id_from_path(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    name.strip_suffix(DRAFT_SUFFIX)
}

fn validate_draft_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid recovery draft id".to_string());
    }
    Ok(())
}

fn normalize_sha256(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let digest = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{} must be a SHA-256 digest", label));
    }
    Ok(format!("sha256:{}", digest.to_ascii_lowercase()))
}

fn state_hash_payload(
    workspace_json: &str,
    source_code: &str,
    board: &str,
    fqbn: &str,
    board_package_id: &str,
    options: &str,
    build_target: Option<&str>,
) -> Result<String, String> {
    let mut fields = vec![
        "recovery-draft-full-state-v1",
        workspace_json,
        source_code,
        board,
        fqbn,
        board_package_id,
        options,
    ];
    if let Some(target) = build_target { fields.push(target); }
    serde_json::to_string(&fields)
    .map_err(|error| error.to_string())
}

fn full_state_hash(
    workspace_json: &str,
    source_code: &str,
    board: &str,
    fqbn: &str,
    board_package_id: &str,
    options: &str,
    build_target: Option<&str>,
) -> Result<String, String> {
    let payload = state_hash_payload(
        workspace_json,
        source_code,
        board,
        fqbn,
        board_package_id,
        options,
        build_target,
    )?;
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn validate_state_json(workspace_json: &str, options: &str) -> Result<(), String> {
    let workspace = serde_json::from_str::<serde_json::Value>(workspace_json)
        .map_err(|error| format!("Recovery workspace is not valid JSON: {}", error))?;
    if !workspace.is_object() {
        return Err("Recovery workspace must be a JSON object".to_string());
    }
    serde_json::from_str::<serde_json::Value>(options)
        .map_err(|error| format!("Recovery board options are not valid JSON: {}", error))?;
    Ok(())
}

fn validate_modified_at(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    DateTime::parse_from_rfc3339(value)
        .map_err(|error| format!("Disk baseline time is invalid: {}", error))?;
    Ok(Some(value.to_string()))
}

fn project_name(project_path: &str) -> String {
    let path = Path::new(project_path);
    path.file_stem()
        .or_else(|| path.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn canonical_project_path(project_path: &str) -> Result<String, String> {
    let path = PathBuf::from(project_path.trim());
    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("Project path is unavailable: {}", error))?;
    Ok(resolved.to_string_lossy().to_string())
}

fn update_framed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn baseline_file_is_relevant(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Rolling drafts and explicit safety checkpoints are independent local
    // stores, never part of the formal project baseline even if a stale copy
    // is accidentally placed inside a legacy folder project.
    if name.ends_with(DRAFT_SUFFIX) || name.ends_with(CHECKPOINT_SUFFIX) {
        return false;
    }
    if matches!(name.as_str(), "project.json" | "workspace.xml") {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "maker" | "ck" | "json" | "xml" | "ino"
    )
}

fn hash_baseline_file(
    hasher: &mut Sha256,
    path: &Path,
    logical_name: &str,
) -> Result<(u64, Option<std::time::SystemTime>), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    update_framed(hasher, logical_name.as_bytes());
    hasher.update(metadata.len().to_be_bytes());
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let modified = metadata.modified().ok();
    let current = fs::metadata(path).map_err(|error| error.to_string())?;
    if current.len() != metadata.len() || current.modified().ok() != modified {
        return Err(format!(
            "Project file changed while its recovery baseline was being hashed: {}",
            path.display()
        ));
    }
    Ok((metadata.len(), modified))
}

fn system_time_to_rfc3339(value: Option<std::time::SystemTime>) -> Option<String> {
    value.map(|time| {
        let timestamp: DateTime<Utc> = time.into();
        timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn max_modified(
    left: Option<std::time::SystemTime>,
    right: Option<std::time::SystemTime>,
) -> Option<std::time::SystemTime> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn project_recovery_baseline(
    project_path: &str,
    requested_project_id: Option<&str>,
) -> Result<ProjectRecoveryBaseline, String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    let recorded_path = canonical_project_path(project_path)?;
    let path = PathBuf::from(&recorded_path);
    let project_id = resolve_project_id(requested_project_id, &recorded_path)?;
    let mut hasher = Sha256::new();
    hasher.update(b"ck-project-disk-baseline-v1\0");
    let mut byte_size = 0u64;
    let mut modified = fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());

    if path.is_file() {
        let (size, file_modified) = hash_baseline_file(&mut hasher, &path, "project")?;
        byte_size = size;
        modified = max_modified(modified, file_modified);
    } else if path.is_dir() {
        let mut files = Vec::new();
        for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            let entry_path = entry.path();
            if file_type.is_file() && baseline_file_is_relevant(&entry_path) {
                files.push(entry_path);
            }
        }
        files.sort_by(|left, right| {
            let left_name = left
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let right_name = right
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            left_name
                .to_ascii_lowercase()
                .cmp(&right_name.to_ascii_lowercase())
                .then_with(|| left_name.cmp(&right_name))
        });
        for file in files {
            let logical_name = file
                .file_name()
                .map(|name| name.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let (size, file_modified) = hash_baseline_file(&mut hasher, &file, &logical_name)?;
            byte_size = byte_size.saturating_add(size);
            modified = max_modified(modified, file_modified);
        }
    } else {
        return Err("Project path is neither a file nor a directory".to_string());
    }

    Ok(ProjectRecoveryBaseline {
        project_path: recorded_path,
        project_id,
        sha256: format!("sha256:{}", hex::encode(hasher.finalize())),
        modified_at: system_time_to_rfc3339(modified),
        byte_size,
    })
}

fn metadata_from_stored(stored: &StoredDraft) -> RecoveryDraftMetadata {
    RecoveryDraftMetadata {
        schema_version: stored.draft.schema_version,
        id: stored.draft.id.clone(),
        project_id: stored.draft.project_id.clone(),
        project_path: stored.draft.project_path.clone(),
        project_name: stored.draft.project_name.clone(),
        created_at: stored.draft.created_at.clone(),
        disk_baseline_hash: stored.draft.disk_baseline_hash.clone(),
        disk_baseline_modified_at: stored.draft.disk_baseline_modified_at.clone(),
        full_state_hash: stored.draft.full_state_hash.clone(),
        board: stored.draft.board.clone(),
        fqbn: stored.draft.fqbn.clone(),
        board_package_id: stored.draft.board_package_id.clone(),
        options: stored.draft.options.clone(),
        build_target: stored.draft.build_target.clone(),
        byte_size: stored.byte_size,
    }
}

fn validate_stored_draft(path: &Path, draft: &RecoveryDraft) -> Result<(), String> {
    crate::project_build_target::validate_optional(draft.build_target.as_deref(), &draft.board, &draft.board_package_id, &draft.options)?;
    if draft.schema_version != RECOVERY_DRAFT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported recovery draft schema version {}",
            draft.schema_version
        ));
    }
    let file_id = draft_id_from_path(path).ok_or("Invalid recovery draft file name")?;
    validate_draft_id(file_id)?;
    if draft.id != file_id {
        return Err("Recovery draft id does not match its file name".to_string());
    }
    let parent_key = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .ok_or("Recovery draft storage directory is invalid")?;
    if project_storage_key(&draft.project_path) != parent_key {
        return Err("Recovery draft is stored under the wrong project".to_string());
    }
    if draft.project_id.trim().is_empty() {
        return Err("Recovery draft has no project id".to_string());
    }
    DateTime::parse_from_rfc3339(&draft.created_at)
        .map_err(|error| format!("Recovery draft time is invalid: {}", error))?;
    normalize_sha256(&draft.disk_baseline_hash, "Disk baseline hash")?;
    validate_modified_at(draft.disk_baseline_modified_at.as_deref())?;
    validate_state_json(&draft.workspace_json, &draft.options)?;
    if draft.board.trim().is_empty() || draft.fqbn.trim().is_empty() {
        return Err("Recovery draft board and FQBN are required".to_string());
    }
    let calculated = full_state_hash(
        &draft.workspace_json,
        &draft.source_code,
        &draft.board,
        &draft.fqbn,
        &draft.board_package_id,
        &draft.options,
        draft.build_target.as_deref(),
    )?;
    if normalize_sha256(&draft.full_state_hash, "Full state hash")? != calculated {
        return Err("Recovery draft full-state hash does not match its payload".to_string());
    }
    Ok(())
}

fn read_stored_draft(path: PathBuf) -> Result<StoredDraft, String> {
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_DRAFT_BYTES {
        return Err(format!(
            "Recovery draft exceeds the {} MiB safety limit",
            MAX_DRAFT_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let draft = serde_json::from_slice::<RecoveryDraft>(&bytes)
        .map_err(|error| format!("Invalid recovery draft '{}': {}", path.display(), error))?;
    validate_stored_draft(&path, &draft)?;
    Ok(StoredDraft {
        path,
        draft,
        byte_size: metadata.len(),
    })
}

fn quarantine_draft(path: &Path, error: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or("Recovery draft has no parent directory")?;
    let quarantine = parent.join(QUARANTINE_DIR);
    fs::create_dir_all(&quarantine).map_err(|cause| cause.to_string())?;
    let original = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown-draft");
    let suffix = format!(
        "{}-{}",
        Utc::now().timestamp_millis(),
        Uuid::new_v4().simple()
    );
    let target = quarantine.join(format!("{}.{}.corrupt", original, suffix));
    fs::rename(path, &target).map_err(|cause| {
        format!(
            "Failed to quarantine damaged recovery draft '{}': {} (damage: {})",
            path.display(),
            cause,
            error
        )
    })?;
    Ok(target)
}

fn is_recovery_temp_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(body) = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((draft_id, nonce)) = body.rsplit_once('.') else {
        return false;
    };
    validate_draft_id(draft_id).is_ok()
        && nonce.len() == 32
        && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn cleanup_stale_recovery_temps(
    dir: &Path,
    minimum_age: std::time::Duration,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let now = std::time::SystemTime::now();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if !is_file || !is_recovery_temp_file(&path) {
            continue;
        }
        let stale = minimum_age.is_zero()
            || entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())
                .map(|age| age >= minimum_age)
                .unwrap_or(false);
        if stale {
            if let Err(error) = remove_file_if_present(&path) {
                log::warn!(
                    "Failed to clean stale recovery draft temporary file '{}': {}",
                    path.display(),
                    error
                );
            }
        }
    }
    Ok(())
}

fn list_stored_drafts(dir: &Path) -> Result<Vec<StoredDraft>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    // A process killed before the final rename can leave only its unique temp
    // file. Keep young files for concurrent CK windows, but reclaim old ones
    // so repeated crashes cannot bypass the storage budget forever.
    cleanup_stale_recovery_temps(dir, STALE_TEMP_AGE)?;
    let mut drafts = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let is_draft = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(DRAFT_SUFFIX))
                .unwrap_or(false);
        if !is_draft {
            continue;
        }
        match read_stored_draft(path.clone()) {
            Ok(stored) => drafts.push(stored),
            Err(error) => {
                if let Err(quarantine_error) = quarantine_draft(&path, &error) {
                    log::warn!("{}", quarantine_error);
                } else {
                    log::warn!(
                        "Quarantined damaged recovery draft '{}': {}",
                        path.display(),
                        error
                    );
                }
            }
        }
    }
    drafts.sort_by(|left, right| {
        right
            .draft
            .created_at
            .cmp(&left.draft.created_at)
            .then_with(|| right.draft.id.cmp(&left.draft.id))
    });
    Ok(drafts)
}

#[cfg(unix)]
fn sync_directory(dir: &Path) -> Result<(), String> {
    File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_dir: &Path) -> Result<(), String> {
    // Windows guarantees atomic same-volume rename. Opening a directory for
    // fsync requires platform-specific flags, while the file itself is synced
    // before publication below.
    Ok(())
}

fn write_draft_atomically(dir: &Path, draft: &RecoveryDraft) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let final_path = dir.join(draft_file_name(&draft.id));
    let temp_path = dir.join(format!(".{}.{}.tmp", draft.id, Uuid::new_v4().simple()));
    let payload = serde_json::to_vec(draft).map_err(|error| error.to_string())?;
    if payload.len() as u64 > MAX_DRAFT_BYTES {
        return Err(format!(
            "Recovery draft is too large (maximum {} MiB)",
            MAX_DRAFT_BYTES / 1024 / 1024
        ));
    }

    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        file.write_all(&payload)
            .map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temp_path, &final_path).map_err(|error| error.to_string())?;
        sync_directory(dir)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map(|_| final_path)
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn prune_project_with_limits(dir: &Path, max_count: usize, max_bytes: u64) -> Result<(), String> {
    let drafts = list_stored_drafts(dir)?;
    let mut kept_count = 0usize;
    let mut kept_bytes = 0u64;
    for stored in drafts {
        let keep =
            kept_count < max_count && kept_bytes.saturating_add(stored.byte_size) <= max_bytes;
        if keep {
            kept_count += 1;
            kept_bytes = kept_bytes.saturating_add(stored.byte_size);
        } else {
            remove_file_if_present(&stored.path)?;
        }
    }
    Ok(())
}

fn prune_all_with_limits(root: &Path, max_count: usize, max_bytes: u64) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut drafts = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        drafts.extend(list_stored_drafts(&entry.path())?);
    }
    drafts.sort_by(|left, right| {
        right
            .draft
            .created_at
            .cmp(&left.draft.created_at)
            .then_with(|| right.draft.id.cmp(&left.draft.id))
    });
    let mut kept_count = 0usize;
    let mut kept_bytes = 0u64;
    for stored in drafts {
        let keep =
            kept_count < max_count && kept_bytes.saturating_add(stored.byte_size) <= max_bytes;
        if keep {
            kept_count += 1;
            kept_bytes = kept_bytes.saturating_add(stored.byte_size);
        } else {
            remove_file_if_present(&stored.path)?;
        }
    }
    Ok(())
}

fn save_draft_in_root(
    root: &Path,
    input: SaveRecoveryDraftInput,
) -> Result<RecoveryDraftMetadata, String> {
    if input.project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    if input.board.trim().is_empty() || input.fqbn.trim().is_empty() {
        return Err("Board and FQBN are required".to_string());
    }
    let raw_input_bytes = [
        input.project_path.len(),
        input.project_id.as_deref().map(str::len).unwrap_or(0),
        input.disk_baseline_hash.len(),
        input
            .disk_baseline_modified_at
            .as_deref()
            .map(str::len)
            .unwrap_or(0),
        input.workspace_json.len(),
        input.source_code.len(),
        input.board.len(),
        input.fqbn.len(),
        input.board_package_id.len(),
        input.options.len(),
        input
            .expected_full_state_hash
            .as_deref()
            .map(str::len)
            .unwrap_or(0),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add);
    // The serialized envelope can only be larger than the raw UTF-8 fields.
    // Reject obviously oversized IPC input before parsing or hashing it.
    if raw_input_bytes as u64 > MAX_DRAFT_BYTES {
        return Err(format!(
            "Recovery draft is too large (maximum {} MiB)",
            MAX_DRAFT_BYTES / 1024 / 1024
        ));
    }
    validate_state_json(&input.workspace_json, &input.options)?;

    let observed_baseline =
        project_recovery_baseline(&input.project_path, input.project_id.as_deref())?;
    let recorded_path = observed_baseline.project_path.clone();
    let project_id = observed_baseline.project_id.clone();
    let disk_baseline_hash = if input.disk_baseline_hash.trim().is_empty() {
        observed_baseline.sha256.clone()
    } else {
        normalize_sha256(&input.disk_baseline_hash, "Disk baseline hash")?
    };
    let disk_baseline_modified_at =
        match validate_modified_at(input.disk_baseline_modified_at.as_deref())? {
            Some(value) => Some(value),
            None => observed_baseline.modified_at,
        };
    let board_package_id = if input.board_package_id.trim().is_empty() {
        input.board.trim().to_string()
    } else {
        input.board_package_id.trim().to_string()
    };
    crate::project_build_target::validate_optional(input.build_target.as_deref(), &input.board, &board_package_id, &input.options)?;
    let calculated_state_hash = full_state_hash(
        &input.workspace_json,
        &input.source_code,
        input.board.trim(),
        input.fqbn.trim(),
        &board_package_id,
        &input.options,
        input.build_target.as_deref(),
    )?;
    if let Some(expected) = input
        .expected_full_state_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if normalize_sha256(expected, "Expected full state hash")? != calculated_state_hash {
            return Err("Client and backend full-state hashes do not match".to_string());
        }
    }

    let dir = recovery_dir(root, &recorded_path);
    let existing = list_stored_drafts(&dir)?;
    if let Some(same) = existing.first().filter(|stored| {
        stored.draft.full_state_hash == calculated_state_hash
            && stored.draft.disk_baseline_hash == disk_baseline_hash
            && stored.draft.disk_baseline_modified_at == disk_baseline_modified_at
            && stored.draft.project_id == project_id
    }) {
        return Ok(metadata_from_stored(same));
    }

    let now = Utc::now();
    let id = format!("{}-{}", now.timestamp_millis(), Uuid::new_v4().simple());
    let draft = RecoveryDraft {
        schema_version: RECOVERY_DRAFT_SCHEMA_VERSION,
        id,
        project_id,
        project_path: recorded_path.clone(),
        project_name: project_name(&recorded_path),
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        disk_baseline_hash,
        disk_baseline_modified_at,
        full_state_hash: calculated_state_hash,
        workspace_json: input.workspace_json,
        source_code: input.source_code,
        board: input.board.trim().to_string(),
        fqbn: input.fqbn.trim().to_string(),
        board_package_id,
        options: input.options,
        build_target: input.build_target,
    };
    let path = write_draft_atomically(&dir, &draft)?;
    prune_project_with_limits(&dir, MAX_DRAFTS_PER_PROJECT, MAX_PROJECT_DRAFT_BYTES)?;
    prune_all_with_limits(root, MAX_TOTAL_DRAFTS, MAX_TOTAL_DRAFT_BYTES)?;
    let stored = read_stored_draft(path)?;
    Ok(metadata_from_stored(&stored))
}

fn list_drafts_in_root(
    root: &Path,
    project_path: &str,
) -> Result<Vec<RecoveryDraftMetadata>, String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    let dir = recovery_dir(root, project_path);
    Ok(list_stored_drafts(&dir)?
        .iter()
        .map(metadata_from_stored)
        .collect())
}

fn load_draft_in_root(
    root: &Path,
    project_path: &str,
    draft_id: &str,
) -> Result<RecoveryDraft, String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    validate_draft_id(draft_id)?;
    let path = recovery_dir(root, project_path).join(draft_file_name(draft_id));
    if !path.exists() {
        return Err("Recovery draft was not found".to_string());
    }
    match read_stored_draft(path.clone()) {
        Ok(stored) => Ok(stored.draft),
        Err(error) => {
            let quarantined = quarantine_draft(&path, &error)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "quarantine unavailable".to_string());
            Err(format!(
                "Recovery draft is damaged and was quarantined at '{}': {}",
                quarantined, error
            ))
        }
    }
}

fn delete_draft_in_root(root: &Path, project_path: &str, draft_id: &str) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    validate_draft_id(draft_id)?;
    let path = recovery_dir(root, project_path).join(draft_file_name(draft_id));
    remove_file_if_present(&path)
}

fn discard_project_drafts_in_root(root: &Path, project_path: &str) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    let dir = recovery_dir(root, project_path);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_project_recovery_baseline(
    project_path: String,
    project_id: Option<String>,
) -> Result<ProjectRecoveryBaseline, String> {
    project_recovery_baseline(&project_path, project_id.as_deref())
}

#[tauri::command]
pub async fn save_recovery_draft(
    app: AppHandle,
    input: SaveRecoveryDraftInput,
) -> Result<RecoveryDraftMetadata, String> {
    let root = recovery_root(&app)?;
    save_draft_in_root(&root, input)
}

#[tauri::command]
pub async fn list_recovery_drafts(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<RecoveryDraftMetadata>, String> {
    let root = recovery_root(&app)?;
    list_drafts_in_root(&root, &project_path)
}

#[tauri::command]
pub async fn load_recovery_draft(
    app: AppHandle,
    project_path: String,
    draft_id: String,
) -> Result<RecoveryDraft, String> {
    let root = recovery_root(&app)?;
    load_draft_in_root(&root, &project_path, &draft_id)
}

#[tauri::command]
pub async fn delete_recovery_draft(
    app: AppHandle,
    project_path: String,
    draft_id: String,
) -> Result<(), String> {
    let root = recovery_root(&app)?;
    delete_draft_in_root(&root, &project_path, &draft_id)
}

#[tauri::command]
pub async fn discard_project_recovery_drafts(
    app: AppHandle,
    project_path: String,
) -> Result<(), String> {
    let root = recovery_root(&app)?;
    discard_project_drafts_in_root(&root, &project_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "ck-recovery-drafts-{}-{}",
                label,
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn project(&self, name: &str) -> String {
            let path = self.path.join(format!("{}.maker", name));
            fs::write(&path, r#"{"name":"fixture","xml":"","code":""}"#).unwrap();
            path.to_string_lossy().to_string()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn input(project_path: &str, marker: usize) -> SaveRecoveryDraftInput {
        SaveRecoveryDraftInput {
            project_path: project_path.to_string(),
            project_id: Some("project-stable-id".to_string()),
            disk_baseline_hash: String::new(),
            disk_baseline_modified_at: None,
            workspace_json: format!(
                r#"{{"blocks":{{"languageVersion":0,"blocks":[{{"type":"third_party","id":"block-{}","extraState":{{"opaque":true}}}}]}}}}"#,
                marker
            ),
            source_code: format!("// source {}", marker),
            board: "ESP32-C6".to_string(),
            fqbn: "esp32:esp32:esp32c6:FlashSize=8M".to_string(),
            board_package_id: "ck-c6-carrier".to_string(),
            options: r#"{"FlashSize":"8M"}"#.to_string(),
            build_target: None,
            expected_full_state_hash: None,
        }
    }

    #[test]
    fn recovery_target_round_trip_and_hash_cover_core_changes() {
        let root = TestRoot::new("target-round-trip");
        let project = root.project("demo");
        let mut original = input(&project, 1);
        original.board = "esp32:esp32:esp32c6".into();
        let target = serde_json::json!({"schemaVersion":1,"board":original.board,"boardPackageId":original.board_package_id,
            "coreId":"esp32:esp32","coreVersion":"3.3.6-cn","options":{"FlashSize":"8M"},"optionsComplete":true,
            "fqbn":original.fqbn}).to_string();
        original.build_target = Some(target.clone());
        let meta = save_draft_in_root(&root.path, original.clone()).unwrap();
        let restored = load_draft_in_root(&root.path, &project, &meta.id).unwrap();
        assert_eq!(restored.build_target, Some(target.clone()));
        let mut tampered = restored.clone();
        tampered.build_target = Some(target.replace("3.3.6-cn", "3.3.13"));
        let stored_path = recovery_dir(&root.path, &project).join(format!("{}{}", meta.id, DRAFT_SUFFIX));
        assert!(validate_stored_draft(&stored_path, &tampered).unwrap_err().contains("hash"));
        original.build_target = tampered.build_target;
        let next = save_draft_in_root(&root.path, original).unwrap();
        assert_ne!(next.full_state_hash, meta.full_state_hash);
    }

    #[test]
    fn round_trip_preserves_complete_state_and_hashes() {
        let root = TestRoot::new("round-trip");
        let project = root.project("demo");
        let baseline = project_recovery_baseline(&project, Some("project-stable-id")).unwrap();
        let mut original = input(&project, 7);
        original.disk_baseline_hash = baseline.sha256.clone();
        original.disk_baseline_modified_at = baseline.modified_at.clone();
        let expected_hash = full_state_hash(
            &original.workspace_json,
            &original.source_code,
            &original.board,
            &original.fqbn,
            &original.board_package_id,
            &original.options,
            original.build_target.as_deref(),
        )
        .unwrap();
        original.expected_full_state_hash = Some(expected_hash.clone());

        let metadata = save_draft_in_root(&root.path, original).unwrap();
        let loaded = load_draft_in_root(&root.path, &project, &metadata.id).unwrap();

        assert_eq!(loaded.project_id, "project-stable-id");
        assert_eq!(loaded.disk_baseline_hash, baseline.sha256);
        assert_eq!(loaded.full_state_hash, expected_hash);
        assert!(loaded.workspace_json.contains("extraState"));
        assert_eq!(loaded.source_code, "// source 7");
        assert_eq!(loaded.fqbn, "esp32:esp32:esp32c6:FlashSize=8M");
        assert_eq!(loaded.board_package_id, "ck-c6-carrier");
        assert_eq!(loaded.options, r#"{"FlashSize":"8M"}"#);
    }

    #[test]
    fn full_state_hash_matches_the_typescript_contract_vector() {
        let hash = full_state_hash(
            r#"{"blocks":{"blocks":[{"type":"第三方/温度","id":"b-1"}]}}"#,
            "void setup() {\n  Serial.println(\"温度\");\n}\n",
            "ESP32-C6",
            "esp32:esp32:esp32c6:FlashSize=8M",
            "ck-c6-carrier",
            r#"{"FlashSize":"8M","USBMode":"hwcdc"}"#,
            None,
        )
        .unwrap();
        assert_eq!(
            hash,
            "sha256:6816261b5b983ae86f54d84e52fe0d493617244d0348764dd4751c1104d0a2be"
        );
    }

    #[test]
    fn atomic_save_publishes_only_the_final_file() {
        let root = TestRoot::new("atomic");
        let project = root.project("demo");
        let metadata = save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let dir = recovery_dir(&root.path, &project);
        let names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names
                .iter()
                .any(|name| name == &draft_file_name(&metadata.id))
        );
        assert!(!names.iter().any(|name| name.ends_with(".tmp")));
    }

    #[test]
    fn retains_only_the_three_newest_drafts() {
        let root = TestRoot::new("retention");
        let project = root.project("demo");
        for marker in 0..5 {
            save_draft_in_root(&root.path, input(&project, marker)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let drafts = list_drafts_in_root(&root.path, &project).unwrap();
        assert_eq!(drafts.len(), MAX_DRAFTS_PER_PROJECT);
        let newest = load_draft_in_root(&root.path, &project, &drafts[0].id).unwrap();
        assert_eq!(newest.source_code, "// source 4");
        assert!(!drafts.iter().any(|draft| {
            load_draft_in_root(&root.path, &project, &draft.id)
                .map(|loaded| loaded.source_code == "// source 0")
                .unwrap_or(false)
        }));
    }

    #[test]
    fn project_byte_budget_keeps_the_newest_draft_first() {
        let root = TestRoot::new("project-byte-budget");
        let project = root.project("demo");
        for marker in 0..3 {
            save_draft_in_root(&root.path, input(&project, marker)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let dir = recovery_dir(&root.path, &project);
        let before = list_stored_drafts(&dir).unwrap();
        let newest_id = before[0].draft.id.clone();
        let newest_size = before[0].byte_size;
        drop(before);

        prune_project_with_limits(&dir, usize::MAX, newest_size).unwrap();
        let after = list_stored_drafts(&dir).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].draft.id, newest_id);
        assert!(after.iter().map(|draft| draft.byte_size).sum::<u64>() <= newest_size);
    }

    #[test]
    fn duplicate_state_does_not_churn_the_rolling_window() {
        let root = TestRoot::new("dedupe");
        let project = root.project("demo");
        let first = save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let second = save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(list_drafts_in_root(&root.path, &project).unwrap().len(), 1);
    }

    #[test]
    fn same_state_after_a_new_disk_snapshot_is_not_deduplicated_as_stale() {
        let root = TestRoot::new("dedupe-baseline-time");
        let project = root.project("demo");
        let mut before = input(&project, 1);
        before.disk_baseline_modified_at = Some("2026-07-14T01:00:00Z".to_string());
        let first = save_draft_in_root(&root.path, before).unwrap();

        let mut after = input(&project, 1);
        after.disk_baseline_modified_at = Some("2026-07-14T02:00:00Z".to_string());
        let second = save_draft_in_root(&root.path, after).unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(list_drafts_in_root(&root.path, &project).unwrap().len(), 2);
    }

    #[test]
    fn rejects_invalid_or_oversized_payloads_and_hash_skew() {
        let root = TestRoot::new("validation");
        let project = root.project("demo");
        let mut invalid = input(&project, 1);
        invalid.workspace_json = "<xml />".to_string();
        assert!(save_draft_in_root(&root.path, invalid).is_err());

        let mut oversized = input(&project, 2);
        oversized.source_code = "x".repeat(MAX_DRAFT_BYTES as usize);
        assert!(save_draft_in_root(&root.path, oversized).is_err());

        let mut skewed = input(&project, 3);
        skewed.expected_full_state_hash = Some(format!("sha256:{}", "0".repeat(64)));
        assert!(
            save_draft_in_root(&root.path, skewed)
                .unwrap_err()
                .contains("do not match")
        );
    }

    #[test]
    fn corrupt_drafts_are_moved_out_of_the_candidate_directory() {
        let root = TestRoot::new("quarantine");
        let project = root.project("demo");
        save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let dir = recovery_dir(&root.path, &project);
        fs::write(dir.join("broken.draft.json"), b"not-json").unwrap();

        let candidates = list_drafts_in_root(&root.path, &project).unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(!dir.join("broken.draft.json").exists());
        let quarantined = fs::read_dir(dir.join(QUARANTINE_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(quarantined, 1);
    }

    #[test]
    fn checkpoint_and_temporary_files_never_enter_draft_listing_or_pruning() {
        let root = TestRoot::new("checkpoint-isolation");
        let project = root.project("demo");
        save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let dir = recovery_dir(&root.path, &project);
        let checkpoint = dir.join("safety.checkpoint.json");
        let temporary = dir.join(".interrupted-write.tmp");
        fs::write(&checkpoint, b"checkpoint-sentinel").unwrap();
        fs::write(&temporary, b"partial-sentinel").unwrap();

        assert_eq!(list_stored_drafts(&dir).unwrap().len(), 1);
        prune_project_with_limits(&dir, 0, 0).unwrap();
        assert!(checkpoint.exists());
        assert!(temporary.exists());
        assert!(list_stored_drafts(&dir).unwrap().is_empty());
    }

    #[test]
    fn stale_owned_temporary_files_are_reclaimed_without_touching_foreign_temps() {
        let root = TestRoot::new("stale-temp");
        let project = root.project("demo");
        save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let dir = recovery_dir(&root.path, &project);
        let owned = dir.join(format!(".1700000000000-owned.{}.tmp", "0".repeat(32)));
        let foreign = dir.join("editor-session.tmp");
        fs::write(&owned, b"interrupted recovery write").unwrap();
        fs::write(&foreign, b"not owned by recovery").unwrap();

        // Normal listing preserves a young temp in case another CK process is
        // still publishing it.
        assert_eq!(list_stored_drafts(&dir).unwrap().len(), 1);
        assert!(owned.exists());
        cleanup_stale_recovery_temps(&dir, std::time::Duration::ZERO).unwrap();
        assert!(!owned.exists());
        assert!(foreign.exists());
    }

    #[test]
    fn valid_json_with_a_tampered_state_hash_is_quarantined() {
        let root = TestRoot::new("tampered");
        let project = root.project("demo");
        let metadata = save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        let path = recovery_dir(&root.path, &project).join(draft_file_name(&metadata.id));
        let mut value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["sourceCode"] = serde_json::Value::String("tampered".to_string());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(
            list_drafts_in_root(&root.path, &project)
                .unwrap()
                .is_empty()
        );
        assert!(!path.exists());
    }

    #[test]
    fn list_and_load_are_read_only_while_delete_and_discard_remain_project_scoped() {
        let root = TestRoot::new("discard");
        let first_project = root.project("first");
        let second_project = root.project("second");
        let first = save_draft_in_root(&root.path, input(&first_project, 1)).unwrap();
        let second = save_draft_in_root(&root.path, input(&first_project, 2)).unwrap();
        let other = save_draft_in_root(&root.path, input(&second_project, 3)).unwrap();

        let first_dir = recovery_dir(&root.path, &first_project);
        let first_path = first_dir.join(draft_file_name(&first.id));
        let second_path = first_dir.join(draft_file_name(&second.id));
        let first_bytes = fs::read(&first_path).unwrap();
        let second_bytes = fs::read(&second_path).unwrap();
        let quarantine = first_dir.join(QUARANTINE_DIR);
        fs::create_dir_all(&quarantine).unwrap();
        fs::write(quarantine.join("damaged.draft.json.corrupt"), b"preserve").unwrap();
        let young_temp = first_dir.join(format!(".{}.{}.tmp", second.id, "a".repeat(32)));
        fs::write(&young_temp, b"in-flight").unwrap();

        let listed_once = list_drafts_in_root(&root.path, &first_project).unwrap();
        let listed_twice = list_drafts_in_root(&root.path, &first_project).unwrap();
        assert_eq!(listed_once.len(), 2);
        assert_eq!(listed_once, listed_twice);
        assert_eq!(
            load_draft_in_root(&root.path, &first_project, &first.id)
                .unwrap()
                .source_code,
            "// source 1"
        );
        assert_eq!(
            load_draft_in_root(&root.path, &first_project, &second.id)
                .unwrap()
                .source_code,
            "// source 2"
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_bytes);
        assert_eq!(fs::read(&second_path).unwrap(), second_bytes);
        assert!(young_temp.exists());
        assert!(quarantine.exists());

        delete_draft_in_root(&root.path, &first_project, &first.id).unwrap();
        assert!(load_draft_in_root(&root.path, &first_project, &first.id).is_err());
        assert!(load_draft_in_root(&root.path, &first_project, &second.id).is_ok());
        assert!(young_temp.exists());
        assert!(quarantine.exists());

        discard_project_drafts_in_root(&root.path, &first_project).unwrap();
        assert!(!first_dir.exists());
        assert!(
            list_drafts_in_root(&root.path, &first_project)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            list_drafts_in_root(&root.path, &second_project)
                .unwrap()
                .len(),
            1
        );
        assert!(load_draft_in_root(&root.path, &second_project, &other.id).is_ok());
    }

    #[test]
    fn global_limit_prunes_oldest_drafts_across_projects() {
        let root = TestRoot::new("global-limit");
        let mut newest_id = String::new();
        for marker in 0..4 {
            let project = root.project(&format!("project-{}", marker));
            newest_id = save_draft_in_root(&root.path, input(&project, marker))
                .unwrap()
                .id;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        prune_all_with_limits(&root.path, 2, MAX_TOTAL_DRAFT_BYTES).unwrap();
        let remaining: Vec<StoredDraft> = fs::read_dir(&root.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .flat_map(|entry| list_stored_drafts(&entry.path()).unwrap_or_default())
            .collect();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|stored| stored.draft.id == newest_id));
    }

    #[test]
    fn global_byte_budget_keeps_the_newest_draft_first() {
        let root = TestRoot::new("global-byte-budget");
        let mut newest_project = String::new();
        let mut newest_id = String::new();
        for marker in 0..4 {
            newest_project = root.project(&format!("project-{}", marker));
            newest_id = save_draft_in_root(&root.path, input(&newest_project, marker))
                .unwrap()
                .id;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let newest_path =
            recovery_dir(&root.path, &newest_project).join(draft_file_name(&newest_id));
        let newest_size = fs::metadata(newest_path).unwrap().len();

        prune_all_with_limits(&root.path, usize::MAX, newest_size).unwrap();
        let remaining: Vec<StoredDraft> = fs::read_dir(&root.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .flat_map(|entry| list_stored_drafts(&entry.path()).unwrap_or_default())
            .collect();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].draft.id, newest_id);
        assert!(remaining.iter().map(|draft| draft.byte_size).sum::<u64>() <= newest_size);
    }

    #[test]
    fn disk_baseline_changes_when_the_formal_project_changes() {
        let root = TestRoot::new("baseline");
        let project = root.project("demo");
        let before = project_recovery_baseline(&project, None).unwrap();
        fs::write(&project, r#"{"name":"fixture","xml":"changed"}"#).unwrap();
        let after = project_recovery_baseline(&project, None).unwrap();
        assert_ne!(before.sha256, after.sha256);
        assert_eq!(before.project_id, after.project_id);
    }

    #[test]
    fn folder_baseline_excludes_recovery_drafts_and_checkpoints() {
        let root = TestRoot::new("baseline-isolation");
        let project = root.path.join("legacy-project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.json"),
            br#"{"name":"legacy-project"}"#,
        )
        .unwrap();
        fs::write(project.join("workspace.xml"), b"<xml />").unwrap();
        fs::write(project.join("legacy-project.ino"), b"void setup() {}\n").unwrap();
        let project_path = project.to_string_lossy().to_string();
        let before = project_recovery_baseline(&project_path, None).unwrap();

        fs::write(project.join("manual.checkpoint.json"), b"checkpoint").unwrap();
        fs::write(project.join("autosave.draft.json"), b"draft").unwrap();
        let after = project_recovery_baseline(&project_path, None).unwrap();

        assert_eq!(before.sha256, after.sha256);
        assert_eq!(before.byte_size, after.byte_size);
    }

    #[test]
    fn rejects_unsafe_ids_without_touching_other_files() {
        let root = TestRoot::new("unsafe-id");
        let project = root.project("demo");
        let saved = save_draft_in_root(&root.path, input(&project, 1)).unwrap();
        assert!(delete_draft_in_root(&root.path, &project, "../outside").is_err());
        assert!(load_draft_in_root(&root.path, &project, &saved.id).is_ok());
    }
}
