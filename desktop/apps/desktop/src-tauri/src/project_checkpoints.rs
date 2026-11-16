use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const MAX_CHECKPOINTS_PER_PROJECT: usize = 20;
const MAX_CHECKPOINT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PROJECT_CHECKPOINT_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectCheckpointInput {
    pub project_path: String,
    pub reason: String,
    /// The exact JSON returned by Blockly.serialization.workspaces.save().
    /// This intentionally stays opaque so third-party mutation state and custom
    /// serializers (including CK breakpoints) are never reduced or rewritten.
    pub workspace_json: String,
    pub code: String,
    pub board: String,
    #[serde(default)]
    pub board_package_id: String,
    pub options: String,
    #[serde(default)]
    pub build_target: Option<String>,
    pub block_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckpoint {
    pub schema_version: u32,
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub reason: String,
    pub created_at: String,
    pub workspace_json: String,
    pub code: String,
    pub board: String,
    #[serde(default)]
    pub board_package_id: String,
    pub options: String,
    #[serde(default)]
    pub build_target: Option<String>,
    pub block_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckpointMetadata {
    pub id: String,
    pub project_name: String,
    pub reason: String,
    pub created_at: String,
    pub board: String,
    pub board_package_id: String,
    pub block_count: u32,
    pub byte_size: u64,
}

#[derive(Debug)]
struct StoredCheckpoint {
    path: PathBuf,
    checkpoint: ProjectCheckpoint,
    byte_size: u64,
}

fn normalized_project_path(project_path: &str) -> String {
    let path = PathBuf::from(project_path.trim());
    let resolved = fs::canonicalize(&path).unwrap_or(path);
    let normalized = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn project_storage_key(project_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_project_path(project_path).as_bytes());
    hex::encode(hasher.finalize())
}

fn checkpoint_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    Ok(app_data.join("project-checkpoints-v1"))
}

fn checkpoint_dir(root: &Path, project_path: &str) -> PathBuf {
    root.join(project_storage_key(project_path))
}

fn checkpoint_file_name(id: &str) -> String {
    format!("{}.checkpoint.json", id)
}

fn validate_checkpoint_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid checkpoint id".to_string());
    }
    Ok(())
}

fn validate_create_input(input: &CreateProjectCheckpointInput) -> Result<(), String> {
    if input.project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    if input.board.trim().is_empty() {
        return Err("Board is required".to_string());
    }
    let workspace_text = input
        .workspace_json
        .strip_prefix('\u{feff}')
        .unwrap_or(&input.workspace_json);
    let workspace: serde_json::Value = serde_json::from_str(workspace_text)
        .map_err(|error| format!("Checkpoint workspace is not valid JSON: {}", error))?;
    if !workspace.is_object() {
        return Err("Checkpoint workspace must be a JSON object".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&input.options)
        .map_err(|error| format!("Checkpoint board options are not valid JSON: {}", error))?;
    Ok(())
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

fn metadata_from_stored(stored: &StoredCheckpoint) -> ProjectCheckpointMetadata {
    ProjectCheckpointMetadata {
        id: stored.checkpoint.id.clone(),
        project_name: stored.checkpoint.project_name.clone(),
        reason: stored.checkpoint.reason.clone(),
        created_at: stored.checkpoint.created_at.clone(),
        board: stored.checkpoint.board.clone(),
        board_package_id: stored.checkpoint.board_package_id.clone(),
        block_count: stored.checkpoint.block_count,
        byte_size: stored.byte_size,
    }
}

fn read_stored_checkpoint(path: PathBuf) -> Result<StoredCheckpoint, String> {
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_CHECKPOINT_BYTES {
        return Err(format!(
            "Checkpoint exceeds the {} MiB safety limit",
            MAX_CHECKPOINT_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let checkpoint = serde_json::from_slice::<ProjectCheckpoint>(&bytes)
        .map_err(|error| format!("Invalid checkpoint '{}': {}", path.display(), error))?;
    crate::project_build_target::validate_optional(checkpoint.build_target.as_deref(), &checkpoint.board, &checkpoint.board_package_id, &checkpoint.options)?;
    if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported checkpoint schema version {}",
            checkpoint.schema_version
        ));
    }
    Ok(StoredCheckpoint {
        path,
        checkpoint,
        byte_size: metadata.len(),
    })
}

fn list_stored_checkpoints(dir: &Path) -> Result<Vec<StoredCheckpoint>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut checkpoints = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let is_checkpoint = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.ends_with(".checkpoint.json"))
            .unwrap_or(false);
        if !is_checkpoint || !path.is_file() {
            continue;
        }

        // A damaged file must not make every healthy checkpoint unavailable.
        // It is left untouched for manual recovery and ignored by the UI.
        if let Ok(stored) = read_stored_checkpoint(path) {
            checkpoints.push(stored);
        }
    }
    checkpoints.sort_by(|left, right| {
        right
            .checkpoint
            .created_at
            .cmp(&left.checkpoint.created_at)
            .then_with(|| right.checkpoint.id.cmp(&left.checkpoint.id))
    });
    Ok(checkpoints)
}

fn write_checkpoint_atomically(
    dir: &Path,
    checkpoint: &ProjectCheckpoint,
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let final_path = dir.join(checkpoint_file_name(&checkpoint.id));
    let temp_path = dir.join(format!(".{}.tmp", checkpoint.id));
    let payload = serde_json::to_vec(checkpoint).map_err(|error| error.to_string())?;
    if payload.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Err(format!(
            "Checkpoint is too large (maximum {} MiB)",
            MAX_CHECKPOINT_BYTES / 1024 / 1024
        ));
    }

    let write_result = (|| -> Result<(), String> {
        let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
        file.write_all(&payload)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp_path, &final_path).map_err(|error| error.to_string())?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result.map(|_| final_path)
}

fn prune_checkpoints(dir: &Path) -> Result<(), String> {
    let checkpoints = list_stored_checkpoints(dir)?;
    let mut kept_count = 0usize;
    let mut kept_bytes = 0u64;

    for stored in checkpoints {
        let within_count = kept_count < MAX_CHECKPOINTS_PER_PROJECT;
        let within_capacity =
            kept_bytes.saturating_add(stored.byte_size) <= MAX_PROJECT_CHECKPOINT_BYTES;
        // Always retain the newest valid checkpoint, even if a future schema
        // raises the per-file limit above the per-project capacity.
        if within_count && (within_capacity || kept_count == 0) {
            kept_count += 1;
            kept_bytes = kept_bytes.saturating_add(stored.byte_size);
        } else {
            fs::remove_file(&stored.path).map_err(|error| {
                format!(
                    "Failed to prune checkpoint '{}': {}",
                    stored.path.display(),
                    error
                )
            })?;
        }
    }
    Ok(())
}

fn create_checkpoint_in_root(
    root: &Path,
    input: CreateProjectCheckpointInput,
) -> Result<ProjectCheckpointMetadata, String> {
    validate_create_input(&input)?;
    let now = chrono::Utc::now();
    let id = format!("{}-{}", now.timestamp_millis(), Uuid::new_v4().simple());
    crate::project_build_target::validate_optional(input.build_target.as_deref(), &input.board, &input.board_package_id, &input.options)?;
    let checkpoint = ProjectCheckpoint {
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        id,
        project_path: input.project_path.trim().to_string(),
        project_name: project_name(&input.project_path),
        reason: input.reason.trim().chars().take(80).collect(),
        created_at: now.to_rfc3339(),
        workspace_json: input.workspace_json,
        code: input.code,
        board: input.board,
        board_package_id: input.board_package_id,
        options: input.options,
        build_target: input.build_target,
        block_count: input.block_count,
    };
    let dir = checkpoint_dir(root, &checkpoint.project_path);
    let path = write_checkpoint_atomically(&dir, &checkpoint)?;
    prune_checkpoints(&dir)?;
    let stored = read_stored_checkpoint(path)?;
    Ok(metadata_from_stored(&stored))
}

fn list_checkpoints_in_root(
    root: &Path,
    project_path: &str,
) -> Result<Vec<ProjectCheckpointMetadata>, String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    let dir = checkpoint_dir(root, project_path);
    Ok(list_stored_checkpoints(&dir)?
        .iter()
        .map(metadata_from_stored)
        .collect())
}

fn load_checkpoint_in_root(
    root: &Path,
    project_path: &str,
    checkpoint_id: &str,
) -> Result<ProjectCheckpoint, String> {
    validate_checkpoint_id(checkpoint_id)?;
    let dir = checkpoint_dir(root, project_path);
    let path = dir.join(checkpoint_file_name(checkpoint_id));
    let stored = read_stored_checkpoint(path)?;
    if stored.checkpoint.id != checkpoint_id {
        return Err("Checkpoint id does not match its file name".to_string());
    }
    if project_storage_key(&stored.checkpoint.project_path) != project_storage_key(project_path) {
        return Err("Checkpoint does not belong to this project".to_string());
    }
    Ok(stored.checkpoint)
}

fn delete_checkpoint_in_root(
    root: &Path,
    project_path: &str,
    checkpoint_id: &str,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }
    validate_checkpoint_id(checkpoint_id)?;
    let dir = checkpoint_dir(root, project_path);
    let path = dir.join(checkpoint_file_name(checkpoint_id));
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_project_checkpoint(
    app: AppHandle,
    input: CreateProjectCheckpointInput,
) -> Result<ProjectCheckpointMetadata, String> {
    let root = checkpoint_root(&app)?;
    create_checkpoint_in_root(&root, input)
}

#[tauri::command]
pub async fn list_project_checkpoints(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<ProjectCheckpointMetadata>, String> {
    let root = checkpoint_root(&app)?;
    list_checkpoints_in_root(&root, &project_path)
}

#[tauri::command]
pub async fn load_project_checkpoint(
    app: AppHandle,
    project_path: String,
    checkpoint_id: String,
) -> Result<ProjectCheckpoint, String> {
    let root = checkpoint_root(&app)?;
    load_checkpoint_in_root(&root, &project_path, &checkpoint_id)
}

#[tauri::command]
pub async fn delete_project_checkpoint(
    app: AppHandle,
    project_path: String,
    checkpoint_id: String,
) -> Result<(), String> {
    let root = checkpoint_root(&app)?;
    delete_checkpoint_in_root(&root, &project_path, &checkpoint_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ck-project-checkpoints-{}-{}",
            label,
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn input(project_path: &str, marker: usize) -> CreateProjectCheckpointInput {
        CreateProjectCheckpointInput {
            project_path: project_path.to_string(),
            reason: "before_compile".to_string(),
            workspace_json: format!(
                r#"{{"blocks":{{"languageVersion":0,"blocks":[{{"type":"text","id":"block-{}","extraState":{{"thirdParty":true}}}}]}},"ckBlockBreakpoints":{{"ids":["block-{}"]}}}}"#,
                marker, marker
            ),
            code: format!("// {}", marker),
            board: "arduino:avr:uno".to_string(),
            board_package_id: "vendor-uno-carrier".to_string(),
            options: r#"{"cpu":"atmega328old"}"#.to_string(),
            build_target: None,
            block_count: marker as u32,
        }
    }

    #[test]
    fn checkpoint_retains_core_and_full_options() {
        let root = temp_root("target-round-trip");
        let project = root.join("demo.ck").to_string_lossy().to_string();
        let mut original = input(&project, 1);
        let target = serde_json::json!({"schemaVersion":1,"board":original.board,"boardPackageId":original.board_package_id,
            "coreId":"arduino:avr","coreVersion":"1.8.6","options":{"cpu":"atmega328old"},"optionsComplete":true,
            "fqbn":"arduino:avr:uno:cpu=atmega328old"}).to_string();
        original.build_target = Some(target.clone());
        let meta = create_checkpoint_in_root(&root, original).unwrap();
        let restored = load_checkpoint_in_root(&root, &project, &meta.id).unwrap();
        assert_eq!(restored.build_target.as_deref(), Some(target.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn round_trip_preserves_full_workspace_payload() {
        let root = temp_root("round-trip");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        let original = input(&project, 7);
        let expected_workspace = original.workspace_json.clone();
        let expected_options = original.options.clone();

        let metadata = create_checkpoint_in_root(&root, original).unwrap();
        let loaded = load_checkpoint_in_root(&root, &project, &metadata.id).unwrap();

        assert_eq!(loaded.workspace_json, expected_workspace);
        assert_eq!(loaded.options, expected_options);
        assert_eq!(loaded.board_package_id, "vendor-uno-carrier");
        assert!(loaded.workspace_json.contains("extraState"));
        assert!(loaded.workspace_json.contains("ckBlockBreakpoints"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn utf8_bom_workspace_is_validated_but_preserved_exactly() {
        let root = temp_root("bom-round-trip");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        let mut original = input(&project, 8);
        original.workspace_json.insert(0, '\u{feff}');
        let expected = original.workspace_json.clone();

        let metadata = create_checkpoint_in_root(&root, original).unwrap();
        let loaded = load_checkpoint_in_root(&root, &project, &metadata.id).unwrap();
        assert_eq!(loaded.workspace_json, expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_checkpoint_without_package_identity_remains_readable() {
        let legacy = serde_json::json!({
            "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
            "id": "legacy-checkpoint",
            "projectPath": "C:/CK/legacy.maker",
            "projectName": "legacy",
            "reason": "before_compile",
            "createdAt": "2026-01-01T00:00:00Z",
            "workspaceJson": "{}",
            "code": "",
            "board": "arduino:avr:uno",
            "options": "{}",
            "blockCount": 0
        });
        let checkpoint: ProjectCheckpoint = serde_json::from_value(legacy).unwrap();
        assert!(checkpoint.board_package_id.is_empty());
    }

    #[test]
    fn retains_only_twenty_newest_checkpoints() {
        let root = temp_root("retention");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        for marker in 0..25 {
            create_checkpoint_in_root(&root, input(&project, marker)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let checkpoints = list_checkpoints_in_root(&root, &project).unwrap();
        assert_eq!(checkpoints.len(), MAX_CHECKPOINTS_PER_PROJECT);
        assert_eq!(checkpoints.first().unwrap().block_count, 24);
        assert!(!checkpoints.iter().any(|item| item.block_count == 0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_json_or_oversized_payloads() {
        let root = temp_root("validation");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        let mut invalid = input(&project, 1);
        invalid.workspace_json = "<xml />".to_string();
        assert!(create_checkpoint_in_root(&root, invalid).is_err());

        let mut oversized = input(&project, 2);
        oversized.code = "x".repeat(MAX_CHECKPOINT_BYTES as usize);
        assert!(create_checkpoint_in_root(&root, oversized).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_corrupt_checkpoint_without_hiding_healthy_entries() {
        let root = temp_root("corrupt");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        create_checkpoint_in_root(&root, input(&project, 1)).unwrap();
        let dir = checkpoint_dir(&root, &project);
        fs::write(dir.join("broken.checkpoint.json"), b"not-json").unwrap();

        let checkpoints = list_checkpoints_in_root(&root, &project).unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0].block_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_removes_only_the_requested_checkpoint() {
        let root = temp_root("delete-one");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        let first = create_checkpoint_in_root(&root, input(&project, 1)).unwrap();
        let second = create_checkpoint_in_root(&root, input(&project, 2)).unwrap();

        delete_checkpoint_in_root(&root, &project, &first.id).unwrap();

        assert!(load_checkpoint_in_root(&root, &project, &first.id).is_err());
        assert_eq!(
            load_checkpoint_in_root(&root, &project, &second.id)
                .unwrap()
                .block_count,
            2
        );
        let remaining = list_checkpoints_in_root(&root, &project).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second.id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_rejects_missing_project_path_and_unsafe_checkpoint_ids() {
        let root = temp_root("delete-validation");
        let project = root.join("demo.maker").to_string_lossy().to_string();
        let checkpoint = create_checkpoint_in_root(&root, input(&project, 1)).unwrap();

        assert_eq!(
            delete_checkpoint_in_root(&root, "   ", &checkpoint.id).unwrap_err(),
            "Project path is required"
        );
        assert_eq!(
            delete_checkpoint_in_root(&root, &project, "../checkpoint").unwrap_err(),
            "Invalid checkpoint id"
        );
        assert!(load_checkpoint_in_root(&root, &project, &checkpoint.id).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
