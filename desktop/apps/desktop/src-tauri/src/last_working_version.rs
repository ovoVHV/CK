use crate::upload_artifact_manifest::{self, UploadArtifactManifest};
use ck_core::builder::demo::Esp32DeviceObservation;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: u32 = 1;
const LOCK_SCHEMA_VERSION: u32 = 1;
const MAX_BASELINE_JSON_BYTES: u64 = 24 * 1024 * 1024;
const MAX_FIRMWARE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DEPENDENCY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DEPENDENCY_FILES: usize = 20_000;
const KEEP_VALID_VERSIONS: usize = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastWorkingVersionCapture {
    pub project_path: String,
    /// Exact Blockly serialization at the moment the upload was requested.
    pub workspace_json: String,
    pub generated_code: String,
    pub board: String,
    #[serde(default)]
    pub board_package_id: String,
    pub board_options_json: String,
    pub block_count: u32,
    #[serde(default)]
    pub board_passport_lock: Option<Value>,
}

pub struct SuccessfulUploadContext<'a> {
    pub build_path: &'a Path,
    pub resolved_fqbn: &'a str,
    pub build_signature: &'a str,
    pub cli_version: &'a str,
    pub toolchain_key: &'a str,
    pub compile_profile: &'a str,
    pub optimization: &'a str,
    pub compile_log: &'a str,
    pub upload_log: &'a str,
    pub library_paths: &'a [PathBuf],
    pub device: Option<&'a Esp32DeviceObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastWorkingVersion {
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub verified_at: String,
    pub project: ProjectSnapshot,
    pub lock: LockSummary,
    pub environment: EnvironmentSnapshot,
    pub firmware: FirmwareSnapshot,
    pub device: DeviceSnapshot,
    pub resources: ResourceSnapshot,
    pub logs: LogSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSnapshot {
    pub original_path: String,
    pub name: String,
    pub workspace_json: String,
    pub workspace_sha256: String,
    pub generated_code: String,
    pub generated_code_sha256: String,
    pub board: String,
    #[serde(default)]
    pub board_package_id: String,
    pub board_options_json: String,
    pub block_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockSummary {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub dependencies: Vec<DependencySnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencySnapshot {
    pub name: String,
    pub version: Option<String>,
    pub source_path: String,
    pub snapshot_path: String,
    pub content_sha256: String,
    pub file_count: u32,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentSnapshot {
    pub fqbn: String,
    pub core_id: String,
    pub core_version: Option<String>,
    pub arduino_cli_version: String,
    pub toolchain_key: String,
    pub build_signature: String,
    pub compile_profile: String,
    pub optimization: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirmwareSnapshot {
    pub build_directory: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
    pub partition: Option<PartitionSnapshot>,
    pub artifacts: Vec<FirmwareArtifactSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartitionSnapshot {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirmwareArtifactSnapshot {
    pub path: String,
    pub role: String,
    pub flash_address: Option<String>,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSnapshot {
    pub chip: Option<String>,
    pub revision: Option<String>,
    pub flash_bytes: Option<u64>,
    pub psram_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSnapshot {
    pub flash_used_bytes: Option<u64>,
    pub flash_max_bytes: Option<u64>,
    pub ram_used_bytes: Option<u64>,
    pub ram_max_bytes: Option<u64>,
    pub warning_count: u32,
    #[serde(default)]
    pub linker_map: Option<crate::resource_map::LinkerMapSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogSnapshot {
    pub compile_path: String,
    pub upload_path: String,
}

#[derive(Debug)]
pub struct PreparedFirmwareRestore {
    pub version: LastWorkingVersion,
    pub build_path: PathBuf,
    transport_staging_root: Option<PathBuf>,
}

#[derive(Debug)]
pub struct PreparedLockedBuild {
    pub version: LastWorkingVersion,
    pub dependency_paths: Vec<PathBuf>,
    pub lock_identity: String,
}

impl Drop for PreparedFirmwareRestore {
    fn drop(&mut self) {
        if let Some(root) = self.transport_staging_root.take() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRestoreReport {
    pub core_version: String,
    pub restored: Vec<String>,
    pub already_matching: Vec<String>,
    pub backup_root: Option<String>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?
        .join("last-working-version-v1"))
}

fn normalized_project_path(project_path: &str) -> String {
    let raw = PathBuf::from(project_path.trim());
    let resolved = fs::canonicalize(&raw).unwrap_or(raw);
    let mut normalized = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn project_key(project_path: &str) -> String {
    sha256_bytes(normalized_project_path(project_path).as_bytes())
}

fn project_dir(root: &Path, project_path: &str) -> PathBuf {
    root.join(project_key(project_path))
}

fn version_path(project_root: &Path, id: &str) -> PathBuf {
    project_root.join(id)
}

fn baseline_path(version_root: &Path) -> PathBuf {
    version_root.join("baseline.json")
}

fn validate_capture(capture: &LastWorkingVersionCapture) -> Result<(), String> {
    if capture.project_path.trim().is_empty() {
        return Err("当前工程没有可用于保存‘上一个可用版本’的路径".into());
    }
    if capture.board.trim().is_empty() {
        return Err("当前工程没有板卡配置".into());
    }
    let workspace: Value = serde_json::from_str(&capture.workspace_json)
        .map_err(|error| format!("积木工程不是有效 JSON：{error}"))?;
    if !workspace.is_object() {
        return Err("积木工程必须是一个完整 JSON 对象".into());
    }
    let options: Value = serde_json::from_str(&capture.board_options_json)
        .map_err(|error| format!("板卡配置不是有效 JSON：{error}"))?;
    if !options.is_object() {
        return Err("板卡配置必须是 JSON 对象".into());
    }
    let payload_size = capture
        .workspace_json
        .len()
        .saturating_add(capture.generated_code.len());
    if payload_size as u64 > MAX_BASELINE_JSON_BYTES {
        return Err(format!(
            "工程快照超过 {} MiB 安全上限",
            MAX_BASELINE_JSON_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

pub fn capture_successful_upload(
    app: &AppHandle,
    capture: LastWorkingVersionCapture,
    context: SuccessfulUploadContext<'_>,
) -> Result<LastWorkingVersion, String> {
    validate_capture(&capture)?;
    validate_hardware_evidence(context.resolved_fqbn, context.device)?;
    let source_manifest = upload_artifact_manifest::read_verified(
        context.build_path,
        context.resolved_fqbn,
        context.build_signature,
    )?;

    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4().simple()
    );
    let storage_root = root(app)?;
    let project_root = project_dir(&storage_root, &capture.project_path);
    fs::create_dir_all(&project_root).map_err(|error| error.to_string())?;
    let staging = project_root.join(format!(".tmp-{id}"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;

    let result = (|| -> Result<LastWorkingVersion, String> {
        fs::write(
            staging.join("workspace.json"),
            capture.workspace_json.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        fs::write(
            staging.join("generated.ino"),
            capture.generated_code.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        fs::write(
            staging.join("board-options.json"),
            capture.board_options_json.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        fs::write(staging.join("compile.log"), context.compile_log.as_bytes())
            .map_err(|error| error.to_string())?;
        fs::write(staging.join("upload.log"), context.upload_log.as_bytes())
            .map_err(|error| error.to_string())?;

        let dependencies = snapshot_dependencies(context.library_paths, &staging)?;
        let resolved_optimization = optimization_from_build(context.build_path)
            .unwrap_or_else(|| context.optimization.to_string());
        let core_id = context
            .resolved_fqbn
            .split(':')
            .take(2)
            .collect::<Vec<_>>()
            .join(":");
        let core_version = core_version_from_build(context.build_path, context.resolved_fqbn);
        let lock_value = serde_json::json!({
            "schemaVersion": LOCK_SCHEMA_VERSION,
            "createdAt": created_at,
            "fqbn": source_manifest.canonical_fqbn,
            "boardPackageId": capture.board_package_id.clone(),
            "core": {
                "id": core_id,
                "version": core_version,
            },
            "toolchain": {
                "arduinoCliVersion": context.cli_version,
                "key": context.toolchain_key,
            },
            "build": {
                "signature": context.build_signature,
                "profile": context.compile_profile,
                "optimization": resolved_optimization,
            },
            "dependencies": dependencies,
            "boardPassportLock": capture.board_passport_lock,
        });
        let lock_bytes = serde_json::to_vec_pretty(&lock_value)
            .map_err(|error| format!("无法生成 ck.lock：{error}"))?;
        fs::write(staging.join("ck.lock"), &lock_bytes).map_err(|error| error.to_string())?;

        let copied = copy_recovery_firmware(
            context.build_path,
            &staging,
            &source_manifest,
            context.build_signature,
        )?;
        // A last-working baseline is evidence, not a best-effort UI cache.
        // Refuse to publish it when the exact compile that produced the
        // uploaded artifacts did not carry complete, structured measurements.
        let mut resources = parse_resources(context.compile_log)?;
        resources.linker_map = crate::resource_map::summarize_build_linker_map(
            context.build_path,
            context.resolved_fqbn,
            &created_at,
        )
        .ok();
        let device = context
            .device
            .map(|observation| DeviceSnapshot {
                chip: observation.chip.clone(),
                revision: observation.revision.clone(),
                flash_bytes: observation.detected_flash_bytes.filter(|value| *value > 0),
                psram_bytes: observation.detected_psram_bytes.filter(|value| *value > 0),
            })
            .unwrap_or_default();

        let version = LastWorkingVersion {
            schema_version: SCHEMA_VERSION,
            id: id.clone(),
            created_at: created_at.clone(),
            verified_at: created_at,
            project: ProjectSnapshot {
                original_path: capture.project_path.clone(),
                name: project_name(&capture.project_path),
                workspace_sha256: sha256_bytes(capture.workspace_json.as_bytes()),
                workspace_json: capture.workspace_json,
                generated_code_sha256: sha256_bytes(capture.generated_code.as_bytes()),
                generated_code: capture.generated_code,
                board: capture.board,
                board_package_id: capture.board_package_id,
                board_options_json: capture.board_options_json,
                block_count: capture.block_count,
            },
            lock: LockSummary {
                path: "ck.lock".into(),
                content: String::from_utf8(lock_bytes.clone())
                    .map_err(|error| format!("ck.lock 不是 UTF-8：{error}"))?,
                sha256: sha256_bytes(&lock_bytes),
                dependencies,
            },
            environment: EnvironmentSnapshot {
                fqbn: source_manifest.canonical_fqbn.clone(),
                core_id,
                core_version,
                arduino_cli_version: context.cli_version.to_string(),
                toolchain_key: context.toolchain_key.to_string(),
                build_signature: context.build_signature.to_string(),
                compile_profile: context.compile_profile.to_string(),
                optimization: resolved_optimization,
            },
            firmware: copied,
            device,
            resources,
            logs: LogSnapshot {
                compile_path: "compile.log".into(),
                upload_path: "upload.log".into(),
            },
        };
        write_json_sync(&baseline_path(&staging), &version)?;
        verify_version_directory(&staging, &version)?;
        Ok(version)
    })();

    let version = match result {
        Ok(version) => version,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let destination = version_path(&project_root, &id);
    fs::rename(&staging, &destination).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        format!("无法提交‘上一个可用版本’：{error}")
    })?;
    prune_versions(&project_root, KEEP_VALID_VERSIONS)?;
    Ok(version)
}

fn validate_hardware_evidence(
    fqbn: &str,
    device: Option<&Esp32DeviceObservation>,
) -> Result<(), String> {
    if !fqbn.to_ascii_lowercase().starts_with("esp32:esp32:") {
        return Ok(());
    }
    let observation =
        device.ok_or_else(|| "ESP32 未形成可用版本：本次上传没有取得独立真机证据".to_string())?;
    if observation
        .chip
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        || observation
            .detected_flash_bytes
            .filter(|value| *value > 0)
            .is_none()
    {
        return Err("ESP32 未形成可用版本：芯片型号或实体 Flash 没有被明确报告".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_last_working_version(
    app: AppHandle,
    project_path: String,
) -> Result<Option<LastWorkingVersion>, String> {
    load_latest(&root(&app)?, &project_path).map(|item| item.map(|(_, version)| version))
}

#[tauri::command]
pub async fn delete_last_working_version(
    app: AppHandle,
    project_path: String,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("工程路径不能为空".into());
    }
    let dir = project_dir(&root(&app)?, &project_path);
    if dir.exists() {
        let metadata = fs::symlink_metadata(&dir).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("上一个可用版本存储路径不是普通目录".into());
        }
        fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn restore_last_working_dependencies(
    app: AppHandle,
    project_path: String,
    current_core_version: String,
) -> Result<DependencyRestoreReport, String> {
    let storage_root = root(&app)?;
    let (version_root, version) = load_latest(&storage_root, &project_path)?
        .ok_or_else(|| "当前工程还没有‘上一个可用版本’".to_string())?;
    verify_version_directory(&version_root, &version)?;
    let expected_core = version
        .environment
        .core_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "完整恢复已阻止：可用版本没有记录明确 Core 版本".to_string())?;
    if current_core_version.trim() != expected_core {
        return Err(format!(
            "完整恢复已阻止：可用版本使用 Core {}，当前环境为 {}。CK 不会静默联网安装或降级 Core，请先在核心管理器中准备该版本。",
            expected_core,
            if current_core_version.trim().is_empty() {
                "未安装/未识别"
            } else {
                current_core_version.trim()
            }
        ));
    }

    let ck_root = crate::ck_root_dir();
    let mut allowed_roots = vec![
        ck_root.join("libraries"),
        ck_root.join("board-package-libraries"),
    ];
    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        allowed_roots.push(app_data.join("CK").join("boards"));
    }
    let backup_root = storage_root
        .join("dependency-restore-backups-v1")
        .join(project_key(&project_path))
        .join(format!("{}", chrono::Utc::now().timestamp_millis()));
    let mut restored = Vec::new();
    let mut already_matching = Vec::new();
    let mut backup_created = false;

    for (index, dependency) in version.lock.dependencies.iter().enumerate() {
        let source_snapshot = safe_join(&version_root, &dependency.snapshot_path)?;
        let (snapshot_hash, snapshot_files, snapshot_bytes) = hash_directory(&source_snapshot)?;
        if snapshot_hash != dependency.content_sha256
            || snapshot_files != dependency.file_count as usize
            || snapshot_bytes != dependency.total_bytes
        {
            return Err(format!("完整恢复已阻止：依赖快照损坏 {}", dependency.name));
        }

        let target = PathBuf::from(&dependency.source_path);
        if !path_is_below_any_root(&target, &allowed_roots) {
            return Err(format!(
                "完整恢复已阻止：依赖 {} 的原路径不在 CK 托管库目录中，不能自动覆盖：{}",
                dependency.name,
                target.display()
            ));
        }
        if target.exists() {
            if let Ok((current_hash, current_files, current_bytes)) = hash_directory(&target) {
                if current_hash == dependency.content_sha256
                    && current_files == dependency.file_count as usize
                    && current_bytes == dependency.total_bytes
                {
                    already_matching.push(dependency.name.clone());
                    continue;
                }
            }
        }

        let parent = target
            .parent()
            .ok_or_else(|| format!("依赖恢复目标没有父目录：{}", target.display()))?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let staging = parent.join(format!(
            ".ck-dependency-restore-{}-{}.tmp",
            index,
            uuid::Uuid::new_v4().simple()
        ));
        let mut staged_files = 0usize;
        let mut staged_bytes = 0u64;
        if let Err(error) = copy_dependency_tree(
            &source_snapshot,
            &staging,
            &mut staged_files,
            &mut staged_bytes,
        ) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let (staged_hash, _, _) = hash_directory(&staging)?;
        if staged_hash != dependency.content_sha256 {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("依赖恢复暂存校验失败：{}", dependency.name));
        }

        let backup = backup_root.join(format!("{:03}-{}", index, dependency.name));
        if target.exists() {
            if let Some(parent) = backup.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&target, &backup).map_err(|error| {
                let _ = fs::remove_dir_all(&staging);
                format!("备份当前依赖 {} 失败：{error}", dependency.name)
            })?;
            backup_created = true;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            let _ = fs::remove_dir_all(&staging);
            if backup.exists() && !target.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("提交依赖恢复 {} 失败：{error}", dependency.name));
        }
        restored.push(dependency.name.clone());
    }

    Ok(DependencyRestoreReport {
        core_version: expected_core.to_string(),
        restored,
        already_matching,
        backup_root: backup_created.then(|| path_text(&backup_root)),
    })
}

pub fn prepare_firmware_restore(
    app: &AppHandle,
    project_path: &str,
) -> Result<PreparedFirmwareRestore, String> {
    let (version_root, version) = load_latest(&root(app)?, project_path)?
        .ok_or_else(|| "当前工程还没有‘上一个可用版本’".to_string())?;
    verify_version_directory(&version_root, &version)?;
    let build_path = safe_join(&version_root, &version.firmware.build_directory)?;
    let manifest = upload_artifact_manifest::read_verified(
        &build_path,
        &version.environment.fqbn,
        &version.environment.build_signature,
    )?;
    // Baseline storage deliberately uses content-addressed project/version
    // directories. On Windows that path can exceed what the Python-based
    // esptool bundled by ESP32 cores can open, even though Rust already
    // verified the same files successfully. Re-stage the verified set under a
    // short temp root, rebuild its manifest, and verify it again before the
    // uploader ever sees the path.
    let (transport_staging_root, transport_build_path) =
        stage_firmware_for_transport(&build_path, &manifest, &version.environment.build_signature)?;
    Ok(PreparedFirmwareRestore {
        version,
        build_path: transport_build_path,
        transport_staging_root: Some(transport_staging_root),
    })
}

pub fn prepare_locked_build(
    app: &AppHandle,
    project_path: &str,
) -> Result<PreparedLockedBuild, String> {
    let (version_root, version) = load_latest(&root(app)?, project_path)?
        .ok_or_else(|| "当前工程还没有‘上一个可用版本’。".to_string())?;
    verify_version_directory(&version_root, &version)?;

    let mut dependency_paths = Vec::with_capacity(version.lock.dependencies.len());
    for dependency in &version.lock.dependencies {
        let snapshot = safe_join(&version_root, &dependency.snapshot_path)?;
        if !snapshot.is_dir() {
            return Err(format!(
                "锁定依赖复编译已阻止：依赖快照不存在 {}",
                dependency.name
            ));
        }
        dependency_paths.push(snapshot);
    }

    let lock_identity = format!(
        "ck-clean-build-v1:{}:{}:{}",
        version.lock.sha256, version.environment.toolchain_key, version.environment.fqbn
    );
    Ok(PreparedLockedBuild {
        version,
        dependency_paths,
        lock_identity,
    })
}

fn stage_firmware_for_transport(
    source_build: &Path,
    manifest: &UploadArtifactManifest,
    build_signature: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let staging_root = std::env::temp_dir().join("CKR").join(&token[..12]);
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("无法创建短路径固件恢复暂存目录：{error}"))?;
    let result = (|| -> Result<PathBuf, String> {
        let staged =
            copy_recovery_firmware(source_build, &staging_root, manifest, build_signature)?;
        let staged_build = safe_join(&staging_root, &staged.build_directory)?;
        upload_artifact_manifest::read_verified(
            &staged_build,
            &manifest.canonical_fqbn,
            build_signature,
        )?;
        Ok(staged_build)
    })();
    match result {
        Ok(staged_build) => Ok((staging_root, staged_build)),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_root);
            Err(format!("固件恢复短路径暂存失败：{error}"))
        }
    }
}

fn load_latest(
    storage_root: &Path,
    project_path: &str,
) -> Result<Option<(PathBuf, LastWorkingVersion)>, String> {
    if project_path.trim().is_empty() {
        return Err("工程路径不能为空".into());
    }
    let dir = project_dir(storage_root, project_path);
    if !dir.exists() {
        return Ok(None);
    }
    let mut candidates = fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            (!name.starts_with(".tmp-") && path.is_dir()).then_some(path)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for candidate in candidates {
        let Ok(version) = read_version(&candidate) else {
            continue;
        };
        if project_key(&version.project.original_path) != project_key(project_path) {
            continue;
        }
        if verify_version_directory(&candidate, &version).is_ok() {
            return Ok(Some((candidate, version)));
        }
    }
    Ok(None)
}

fn read_version(version_root: &Path) -> Result<LastWorkingVersion, String> {
    let path = baseline_path(version_root);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_BASELINE_JSON_BYTES
    {
        return Err("上一个可用版本元数据无效".into());
    }
    let version: LastWorkingVersion =
        serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("上一个可用版本元数据损坏：{error}"))?;
    if version.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "不支持的上一个可用版本格式 {}",
            version.schema_version
        ));
    }
    Ok(version)
}

fn verify_version_directory(
    version_root: &Path,
    version: &LastWorkingVersion,
) -> Result<(), String> {
    if version.id.is_empty()
        || !version
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("上一个可用版本 ID 无效".into());
    }
    if sha256_bytes(version.project.workspace_json.as_bytes()) != version.project.workspace_sha256 {
        return Err("上一个可用版本的积木工程哈希不匹配".into());
    }
    if sha256_bytes(version.project.generated_code.as_bytes())
        != version.project.generated_code_sha256
    {
        return Err("上一个可用版本的生成源码哈希不匹配".into());
    }
    let lock_path = safe_join(version_root, &version.lock.path)?;
    if sha256_bytes(version.lock.content.as_bytes()) != version.lock.sha256
        || sha256_file(&lock_path)? != version.lock.sha256
    {
        return Err("上一个可用版本的 ck.lock 哈希不匹配".into());
    }
    for dependency in &version.lock.dependencies {
        let snapshot = safe_join(version_root, &dependency.snapshot_path)?;
        let (hash, files, bytes) = hash_directory(&snapshot)?;
        if hash != dependency.content_sha256
            || files != dependency.file_count as usize
            || bytes != dependency.total_bytes
        {
            return Err(format!(
                "上一个可用版本的依赖快照校验失败：{}",
                dependency.name
            ));
        }
    }
    let manifest_path = safe_join(version_root, &version.firmware.manifest_path)?;
    if sha256_file(&manifest_path)? != version.firmware.manifest_sha256 {
        return Err("上一个可用版本的上传清单哈希不匹配".into());
    }
    let build_path = safe_join(version_root, &version.firmware.build_directory)?;
    for artifact in &version.firmware.artifacts {
        let path = safe_join(&build_path, &artifact.path)?;
        let metadata = regular_file_metadata(&path, &artifact.role)?;
        if metadata.len() != artifact.size || sha256_file(&path)? != artifact.sha256 {
            return Err(format!("上一个可用版本固件段校验失败：{}", artifact.role));
        }
    }
    if let Some(partition) = &version.firmware.partition {
        let path = safe_join(&build_path, &partition.path)?;
        if sha256_file(&path)? != partition.sha256 {
            return Err("上一个可用版本的分区文件哈希不匹配".into());
        }
    }
    Ok(())
}

fn copy_recovery_firmware(
    source_build: &Path,
    version_root: &Path,
    manifest: &UploadArtifactManifest,
    build_signature: &str,
) -> Result<FirmwareSnapshot, String> {
    let project_name =
        upload_artifact_manifest::arduino_project_name_from_build_path(source_build)?;
    let build_parent_name = project_name
        .strip_suffix(".ino")
        .ok_or_else(|| "无法确定固件构建目录身份".to_string())?;
    let relative_build = PathBuf::from("firmware")
        .join(build_parent_name)
        .join("build");
    let destination_build = version_root.join(&relative_build);
    fs::create_dir_all(&destination_build).map_err(|error| error.to_string())?;

    let mut copied_bytes = 0u64;
    let mut destination_names = BTreeSet::new();
    let mut address_files = BTreeMap::<String, String>::new();
    if manifest.canonical_fqbn.starts_with("esp32:esp32:") {
        // Copy ELF before the application BIN. On filesystems where copy does
        // not preserve timestamps, this maintains the existing stale-artifact
        // invariant (application must not be older than its ELF).
        let elf_name = format!("{project_name}.elf");
        let elf_source = source_build.join(&elf_name);
        copied_bytes =
            copied_bytes.saturating_add(regular_file_metadata(&elf_source, "ESP32 ELF")?.len());
        if copied_bytes > MAX_FIRMWARE_BYTES {
            return Err("固件恢复副本超过安全上限".into());
        }
        fs::copy(&elf_source, destination_build.join(&elf_name))
            .map_err(|error| format!("复制 ESP32 ELF 失败：{error}"))?;
    }
    for artifact in &manifest.artifacts {
        if artifact.role == "esp32-flash-arguments" {
            continue;
        }
        let source = manifest_source_path(source_build, &artifact.path)?;
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("固件段路径没有文件名：{}", artifact.path))?
            .to_string();
        if !destination_names.insert(file_name.to_ascii_lowercase()) {
            return Err(format!("固件恢复副本存在重名文件：{file_name}"));
        }
        let size = regular_file_metadata(&source, &artifact.role)?.len();
        copied_bytes = copied_bytes.saturating_add(size);
        if copied_bytes > MAX_FIRMWARE_BYTES {
            return Err(format!(
                "固件恢复副本超过 {} MiB 安全上限",
                MAX_FIRMWARE_BYTES / 1024 / 1024
            ));
        }
        fs::copy(&source, destination_build.join(&file_name))
            .map_err(|error| format!("复制固件段 {file_name} 失败：{error}"))?;
        if let Some(address) = &artifact.flash_address {
            address_files.insert(address.clone(), file_name);
        }
    }

    let options_source = source_build.join("build.options.json");
    let mut options: Value = serde_json::from_slice(
        &fs::read(&options_source).map_err(|error| format!("读取构建配置失败：{error}"))?,
    )
    .map_err(|error| format!("构建配置损坏：{error}"))?;
    options["fqbn"] = Value::String(manifest.canonical_fqbn.clone());
    fs::write(
        destination_build.join("build.options.json"),
        serde_json::to_vec_pretty(&options).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if manifest.canonical_fqbn.starts_with("esp32:esp32:") {
        let flash_args_source = manifest
            .artifacts
            .iter()
            .find(|artifact| artifact.role == "esp32-flash-arguments")
            .ok_or_else(|| "上传清单缺少 flash_args".to_string())?;
        let raw_flash_args =
            fs::read_to_string(manifest_source_path(source_build, &flash_args_source.path)?)
                .map_err(|error| format!("读取 flash_args 失败：{error}"))?;
        let flags = flash_args_flags(&raw_flash_args)?;
        let mut lines = Vec::new();
        if !flags.is_empty() {
            lines.push(flags.join(" "));
        }
        let mut pairs = address_files.into_iter().collect::<Vec<_>>();
        pairs.sort_by_key(|(address, _)| parse_hex_address(address).unwrap_or(u64::MAX));
        for (address, file_name) in pairs {
            lines.push(format!("{address} {file_name}"));
        }
        fs::write(
            destination_build.join("flash_args"),
            format!("{}\n", lines.join("\n")),
        )
        .map_err(|error| format!("写入恢复 flash_args 失败：{error}"))?;

        let partition = manifest
            .partition_definition
            .as_ref()
            .ok_or_else(|| "ESP32 上传清单缺少分区定义".to_string())?;
        let partition_source = manifest_source_path(source_build, &partition.path)?;
        fs::copy(&partition_source, destination_build.join("partitions.csv"))
            .map_err(|error| format!("复制分区定义失败：{error}"))?;
    }

    upload_artifact_manifest::write(
        &destination_build,
        &manifest.canonical_fqbn,
        build_signature,
    )?;
    let copied_manifest = upload_artifact_manifest::read_verified(
        &destination_build,
        &manifest.canonical_fqbn,
        build_signature,
    )?;
    let manifest_file = upload_artifact_manifest::manifest_path(&destination_build);
    let artifacts = copied_manifest
        .artifacts
        .iter()
        .map(|artifact| FirmwareArtifactSnapshot {
            path: artifact.path.clone(),
            role: artifact.role.clone(),
            flash_address: artifact.flash_address.clone(),
            size: artifact.size,
            sha256: artifact.sha256.clone(),
        })
        .collect();
    let partition = copied_manifest
        .partition_definition
        .map(|partition| PartitionSnapshot {
            path: partition.path,
            sha256: partition.sha256,
        });
    let manifest_relative = relative_build.join(upload_artifact_manifest::MANIFEST_FILE_NAME);
    Ok(FirmwareSnapshot {
        build_directory: path_text(&relative_build),
        manifest_path: path_text(&manifest_relative),
        manifest_sha256: sha256_file(&manifest_file)?,
        partition,
        artifacts,
    })
}

fn manifest_source_path(build_path: &Path, stored: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(stored);
    let path = if raw.is_absolute() {
        raw
    } else {
        if raw.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(format!("上传清单路径越界：{stored}"));
        }
        build_path.join(raw)
    };
    let metadata = regular_file_metadata(&path, "上传清单文件")?;
    if metadata.len() == 0 {
        return Err(format!("上传清单文件为空：{}", path.display()));
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn flash_args_flags(raw: &str) -> Result<Vec<String>, String> {
    let tokens = split_quoted_tokens(raw);
    let mut removed = BTreeSet::new();
    for index in 0..tokens.len().saturating_sub(1) {
        if parse_hex_address(&tokens[index]).is_some()
            && tokens[index + 1].to_ascii_lowercase().ends_with(".bin")
        {
            removed.insert(index);
            removed.insert(index + 1);
        }
    }
    if tokens.iter().enumerate().any(|(index, token)| {
        token.to_ascii_lowercase().ends_with(".bin") && !removed.contains(&index)
    }) {
        return Err("flash_args 中存在无法绑定烧录地址的固件段".into());
    }
    Ok(tokens
        .into_iter()
        .enumerate()
        .filter_map(|(index, token)| (!removed.contains(&index)).then_some(token))
        .collect())
}

fn split_quoted_tokens(input: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in input.chars() {
        match quote {
            Some(active) if character == active => quote = None,
            Some(_) => current.push(character),
            None if character == '\'' || character == '"' => quote = Some(character),
            None if character.is_whitespace() => {
                if !current.is_empty() {
                    output.push(std::mem::take(&mut current));
                }
            }
            None => current.push(character),
        }
    }
    if !current.is_empty() {
        output.push(current);
    }
    output
}

fn parse_hex_address(value: &str) -> Option<u64> {
    let digits = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))?;
    u64::from_str_radix(digits, 16).ok()
}

fn snapshot_dependencies(
    paths: &[PathBuf],
    version_root: &Path,
) -> Result<Vec<DependencySnapshot>, String> {
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    let mut accumulated_bytes = 0u64;
    let mut accumulated_files = 0usize;
    for (index, path) in paths.iter().enumerate() {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("无法读取依赖目录 {}：{error}", path.display()))?;
        let root_metadata = fs::symlink_metadata(&canonical)
            .map_err(|error| format!("无法检查依赖目录 {}：{error}", canonical.display()))?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(format!("依赖不是普通目录：{}", canonical.display()));
        }
        let source_path = path_text(&canonical);
        if !seen.insert(source_path.to_ascii_lowercase()) {
            continue;
        }
        let properties = fs::read_to_string(canonical.join("library.properties")).ok();
        let property = |key: &str| {
            properties.as_deref().and_then(|content| {
                content.lines().find_map(|line| {
                    let (candidate, value) = line.split_once('=')?;
                    candidate
                        .trim()
                        .eq_ignore_ascii_case(key)
                        .then(|| value.trim().to_string())
                })
            })
        };
        let name = property("name")
            .or_else(|| {
                canonical
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "未命名库".into());
        let safe_name: String = name
            .chars()
            .take(64)
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        let relative_snapshot = PathBuf::from("dependencies").join(format!(
            "{:03}-{}",
            index,
            if safe_name.is_empty() {
                "library"
            } else {
                safe_name.as_str()
            }
        ));
        let snapshot_root = version_root.join(&relative_snapshot);
        let (file_count, total_bytes) = copy_dependency_tree(
            &canonical,
            &snapshot_root,
            &mut accumulated_files,
            &mut accumulated_bytes,
        )?;
        let (content_sha256, verified_files, verified_bytes) = hash_directory(&snapshot_root)?;
        if file_count != verified_files || total_bytes != verified_bytes {
            return Err(format!("依赖快照复制后统计不一致：{name}"));
        }
        output.push(DependencySnapshot {
            name,
            version: property("version"),
            source_path,
            snapshot_path: path_text(&relative_snapshot),
            content_sha256,
            file_count: file_count.min(u32::MAX as usize) as u32,
            total_bytes,
        });
    }
    output.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.version.cmp(&right.version))
    });
    Ok(output)
}

fn copy_dependency_tree(
    source_root: &Path,
    destination_root: &Path,
    accumulated_files: &mut usize,
    accumulated_bytes: &mut u64,
) -> Result<(usize, u64), String> {
    fs::create_dir_all(destination_root).map_err(|error| error.to_string())?;
    let canonical_root = source_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut local_files = 0usize;
    let mut local_bytes = 0u64;
    for entry in walkdir::WalkDir::new(&canonical_root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
    {
        let entry = entry.map_err(|error| format!("读取依赖快照失败：{error}"))?;
        let path = entry.path();
        if path == canonical_root {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(format!("依赖快照拒绝符号链接：{}", path.display()));
        }
        let relative = path
            .strip_prefix(&canonical_root)
            .map_err(|_| "依赖快照路径越界".to_string())?;
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("依赖快照包含不安全路径".into());
        }
        let destination = destination_root.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            continue;
        }
        if !entry.file_type().is_file() {
            return Err(format!("依赖快照包含特殊文件：{}", path.display()));
        }
        let canonical_file = path
            .canonicalize()
            .map_err(|error| format!("无法解析依赖文件 {}：{error}", path.display()))?;
        if !canonical_file.starts_with(&canonical_root) {
            return Err(format!("依赖文件逃逸源目录：{}", path.display()));
        }
        let size = entry.metadata().map_err(|error| error.to_string())?.len();
        *accumulated_files = accumulated_files.saturating_add(1);
        *accumulated_bytes = accumulated_bytes.saturating_add(size);
        local_files = local_files.saturating_add(1);
        local_bytes = local_bytes.saturating_add(size);
        if *accumulated_files > MAX_DEPENDENCY_FILES || *accumulated_bytes > MAX_DEPENDENCY_BYTES {
            return Err(format!(
                "依赖快照超过安全上限（{} 个文件 / {} MiB）",
                MAX_DEPENDENCY_FILES,
                MAX_DEPENDENCY_BYTES / 1024 / 1024
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&canonical_file, &destination)
            .map_err(|error| format!("复制依赖文件 {} 失败：{error}", path.display()))?;
    }
    if local_files == 0 {
        return Err(format!("依赖目录为空：{}", source_root.display()));
    }
    Ok((local_files, local_bytes))
}

fn hash_directory(root: &Path) -> Result<(String, usize, u64), String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&canonical_root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!("目录哈希拒绝符号链接：{}", entry.path().display()));
        }
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        } else if !entry.file_type().is_dir() {
            return Err(format!("目录哈希拒绝特殊文件：{}", entry.path().display()));
        }
    }
    files.sort_by_key(|path| path_text(path.strip_prefix(&canonical_root).unwrap_or(path)));
    let mut hasher = Sha256::new();
    let mut total_bytes = 0u64;
    for path in &files {
        let relative = path
            .strip_prefix(&canonical_root)
            .map_err(|_| "目录哈希路径越界".to_string())?;
        let relative_text = path_text(relative);
        let metadata = regular_file_metadata(path, "依赖快照文件")?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        hasher.update((relative_text.len() as u64).to_le_bytes());
        hasher.update(relative_text.as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok((hex::encode(hasher.finalize()), files.len(), total_bytes))
}

fn core_version_from_build(build_path: &Path, fqbn: &str) -> Option<String> {
    let package = fqbn.split(':').next()?;
    let architecture = fqbn.split(':').nth(1)?;
    let options: Value =
        serde_json::from_slice(&fs::read(build_path.join("build.options.json")).ok()?).ok()?;
    let folders = options.get("hardwareFolders")?.as_str()?;
    for raw in folders.split([';', ',']) {
        let normalized = raw.trim().replace('\\', "/");
        let marker = format!("/{package}/hardware/{architecture}/");
        if let Some(index) = normalized
            .to_ascii_lowercase()
            .find(&marker.to_ascii_lowercase())
        {
            let version = normalized[index + marker.len()..].split('/').next()?.trim();
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    None
}

fn optimization_from_build(build_path: &Path) -> Option<String> {
    let options: Value =
        serde_json::from_slice(&fs::read(build_path.join("build.options.json")).ok()?).ok()?;
    options
        .get("compiler.optimization_flags")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_resources(log: &str) -> Result<ResourceSnapshot, String> {
    fn captures(log: &str, pattern: &str) -> Option<(u64, u64)> {
        let regex = regex::Regex::new(pattern).ok()?;
        let captures = regex.captures_iter(log).last()?;
        Some((
            captures.get(1)?.as_str().parse().ok()?,
            captures.get(2)?.as_str().parse().ok()?,
        ))
    }
    let flash = captures(
        log,
        r"(?im)^Sketch uses\s+([0-9]+)\s+bytes[^\r\n]*?Maximum is\s+([0-9]+)\s+bytes",
    );
    let ram = captures(
        log,
        r"(?im)^Global variables use\s+([0-9]+)\s+bytes[^\r\n]*?Maximum is\s+([0-9]+)\s+bytes",
    );
    let structured_warning_count =
        regex::Regex::new(r"(?im)^\[DIAG\]\s+Compile evidence:\s+warning_count=([0-9]+)\s*$")
            .ok()
            .and_then(|regex| regex.captures_iter(log).last())
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<u64>().ok());
    let (flash_used_bytes, flash_max_bytes) = flash.ok_or_else(|| {
        "Last-working baseline rejected: compile log has no complete Flash used/maximum measurement."
            .to_string()
    })?;
    let (ram_used_bytes, ram_max_bytes) = ram.ok_or_else(|| {
        "Last-working baseline rejected: compile log has no complete RAM used/maximum measurement."
            .to_string()
    })?;
    let warning_count = structured_warning_count.ok_or_else(|| {
        "Last-working baseline rejected: compile log has no structured warning_count measurement."
            .to_string()
    })?;
    let warning_count = u32::try_from(warning_count).map_err(|_| {
        "Last-working baseline rejected: structured warning_count exceeds u32.".to_string()
    })?;
    if flash_max_bytes == 0 || flash_used_bytes > flash_max_bytes {
        return Err(
            "Last-working baseline rejected: Flash resource measurement is out of bounds."
                .to_string(),
        );
    }
    if ram_max_bytes == 0 || ram_used_bytes > ram_max_bytes {
        return Err(
            "Last-working baseline rejected: RAM resource measurement is out of bounds."
                .to_string(),
        );
    }
    Ok(ResourceSnapshot {
        flash_used_bytes: Some(flash_used_bytes),
        flash_max_bytes: Some(flash_max_bytes),
        ram_used_bytes: Some(ram_used_bytes),
        ram_max_bytes: Some(ram_max_bytes),
        warning_count,
        linker_map: None,
    })
}

fn prune_versions(project_root: &Path, keep: usize) -> Result<(), String> {
    let mut valid = fs::read_dir(project_root)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (!entry.file_name().to_string_lossy().starts_with(".tmp-") && path.is_dir())
                .then_some(path)
        })
        .collect::<Vec<_>>();
    valid.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for path in valid.into_iter().skip(keep) {
        fs::remove_dir_all(&path)
            .map_err(|error| format!("清理旧可用版本失败 {}：{error}", path.display()))?;
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("可用版本路径越界：{relative}"));
    }
    Ok(root.join(path))
}

fn path_is_below_any_root(target: &Path, roots: &[PathBuf]) -> bool {
    let target_key = normalized_project_path(&path_text(target));
    roots.iter().any(|root| {
        let mut root_key = normalized_project_path(&path_text(root));
        while root_key.ends_with('/') {
            root_key.pop();
        }
        !root_key.is_empty() && target_key.starts_with(&(root_key + "/"))
    })
}

fn regular_file_metadata(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} 不可用 {}：{error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err(format!("{label} 不是非空普通文件：{}", path.display()));
    }
    Ok(metadata)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn write_json_sync<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if encoded.len() as u64 > MAX_BASELINE_JSON_BYTES {
        return Err("上一个可用版本元数据超过安全上限".into());
    }
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn project_name(project_path: &str) -> String {
    Path::new(project_path)
        .file_stem()
        .or_else(|| Path::new(project_path).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名工程")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempFixture {
        root: PathBuf,
    }

    impl TempFixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "ck-last-working-{label}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn resource_parser_keeps_latest_flash_and_ram_values() {
        let report = parse_resources(
            "Sketch uses 10 bytes. Maximum is 100 bytes.\nGlobal variables use 4 bytes. Maximum is 20 bytes.\n[DIAG] Compile evidence: warning_count=1\n",
        )
        .unwrap();
        assert_eq!(report.flash_used_bytes, Some(10));
        assert_eq!(report.flash_max_bytes, Some(100));
        assert_eq!(report.ram_used_bytes, Some(4));
        assert_eq!(report.ram_max_bytes, Some(20));
        assert_eq!(report.warning_count, 1);
    }

    #[test]
    fn resource_parser_rejects_incomplete_exact_cache_measurements_without_cross_pairing() {
        let error = parse_resources(
            "Sketch uses 900 bytes (missing maximum)\n\
             Global variables use 40 bytes (20%) of dynamic memory. Maximum is 200 bytes.\n\
             [DIAG] Compile evidence: warning_count=3\n",
        )
        .unwrap_err();
        assert!(error.contains("no complete Flash"));
    }

    #[test]
    fn resource_parser_rejects_a_thin_log_instead_of_inventing_zero_warnings() {
        let error = parse_resources(
            "Sketch uses 10 bytes. Maximum is 100 bytes.\n\
             Global variables use 4 bytes. Maximum is 20 bytes.\n",
        )
        .unwrap_err();
        assert!(error.contains("structured warning_count"));
    }

    #[test]
    fn package_identity_is_optional_for_legacy_baseline_payloads() {
        let capture: LastWorkingVersionCapture = serde_json::from_value(serde_json::json!({
            "projectPath": "C:/CK/legacy.maker",
            "workspaceJson": "{}",
            "generatedCode": "",
            "board": "esp32:esp32:esp32c6",
            "boardOptionsJson": "{}",
            "blockCount": 0
        }))
        .unwrap();
        assert!(capture.board_package_id.is_empty());

        let snapshot: ProjectSnapshot = serde_json::from_value(serde_json::json!({
            "originalPath": "C:/CK/legacy.maker",
            "name": "legacy",
            "workspaceJson": "{}",
            "workspaceSha256": "hash",
            "generatedCode": "",
            "generatedCodeSha256": "hash",
            "board": "esp32:esp32:esp32c6",
            "boardOptionsJson": "{}",
            "blockCount": 0
        }))
        .unwrap();
        assert!(snapshot.board_package_id.is_empty());
    }

    #[test]
    fn flash_argument_rewriter_removes_only_address_binary_pairs() {
        let flags =
            flash_args_flags("--chip esp32s3 --flash-size 16MB 0x0 boot.bin 0x10000 app.bin")
                .unwrap();
        assert_eq!(flags, ["--chip", "esp32s3", "--flash-size", "16MB"]);
    }

    #[test]
    fn safe_join_rejects_absolute_and_parent_paths() {
        let root = Path::new("baseline");
        assert!(safe_join(root, "firmware/build").is_ok());
        assert!(safe_join(root, "../escape").is_err());
        assert!(safe_join(root, "C:/escape").is_err());
    }

    #[test]
    fn esp32_baseline_requires_explicit_chip_and_physical_flash_evidence() {
        assert!(validate_hardware_evidence("arduino:avr:uno", None).is_ok());
        assert!(validate_hardware_evidence("esp32:esp32:esp32c6", None).is_err());
        let incomplete = Esp32DeviceObservation {
            chip: Some("ESP32-C6".into()),
            revision: None,
            mac: None,
            detected_flash_bytes: None,
            detected_psram_bytes: None,
            frontend_lines: Vec::new(),
        };
        assert!(validate_hardware_evidence("esp32:esp32:esp32c6", Some(&incomplete)).is_err());
        let complete = Esp32DeviceObservation {
            detected_flash_bytes: Some(8 * 1024 * 1024),
            ..incomplete
        };
        assert!(validate_hardware_evidence("esp32:esp32:esp32c6", Some(&complete)).is_ok());
    }

    #[test]
    fn dependency_snapshot_is_complete_hashed_and_scoped_to_managed_roots() {
        let fixture = TempFixture::new("dependency-copy");
        let managed = fixture.root.join("libraries");
        let library = managed.join("FastLED");
        fs::create_dir_all(library.join("src")).unwrap();
        fs::write(
            library.join("library.properties"),
            b"name=FastLED\nversion=3.9.2\n",
        )
        .unwrap();
        fs::write(library.join("src/FastLED.h"), b"#pragma once\n").unwrap();
        let version_root = fixture.root.join("version");
        fs::create_dir_all(&version_root).unwrap();
        let dependencies = snapshot_dependencies(&[library.clone()], &version_root).unwrap();
        assert_eq!(dependencies.len(), 1);
        assert_eq!(dependencies[0].name, "FastLED");
        assert_eq!(dependencies[0].version.as_deref(), Some("3.9.2"));
        assert_eq!(dependencies[0].file_count, 2);
        let snapshot = version_root.join(&dependencies[0].snapshot_path);
        let (hash, files, bytes) = hash_directory(&snapshot).unwrap();
        assert_eq!(hash, dependencies[0].content_sha256);
        assert_eq!(files, dependencies[0].file_count as usize);
        assert_eq!(bytes, dependencies[0].total_bytes);
        assert!(path_is_below_any_root(
            &library,
            std::slice::from_ref(&managed)
        ));
        assert!(!path_is_below_any_root(
            &fixture.root.join("packages/core"),
            &[managed]
        ));
        fs::write(snapshot.join("src/FastLED.h"), b"tampered\n").unwrap();
        assert_ne!(
            hash_directory(&snapshot).unwrap().0,
            dependencies[0].content_sha256
        );
    }

    #[test]
    fn esp32_recovery_copy_preserves_every_burn_address_and_revalidates_hashes() {
        let fixture = TempFixture::new("esp32-copy");
        for out_of_tree in [false, true] {
            let project_directory_name = "sketch_esp32_recovery_qfast2";
            let build = if out_of_tree {
                fixture.root.join("build").join(project_directory_name)
            } else {
                fixture.root.join(project_directory_name).join("build")
            };
            let hardware = fixture.root.join("packages/esp32/hardware/esp32/3.3.6");
            fs::create_dir_all(hardware.join("tools/partitions")).unwrap();
            fs::create_dir_all(&build).unwrap();
            fs::write(hardware.join("tools/partitions/boot_app0.bin"), b"boot-app").unwrap();
            let project = "sketch_esp32_recovery_qfast2.ino";
            // Write ELF first so the source set also satisfies the stale-artifact gate.
            fs::write(build.join(format!("{project}.elf")), b"elf").unwrap();
            fs::write(
                build.join(format!("{project}.bootloader.bin")),
                b"bootloader",
            )
            .unwrap();
            fs::write(
                build.join(format!("{project}.partitions.bin")),
                b"partition-bin",
            )
            .unwrap();
            fs::write(build.join(format!("{project}.bin")), b"application").unwrap();
            fs::write(
            build.join("flash_args"),
            format!(
                "--flash-mode dio --flash-size 16MB\n0x0 {project}.bootloader.bin\n0x8000 {project}.partitions.bin\n0xe000 {}\n0x10000 {project}.bin\n",
                hardware
                    .join("tools/partitions/boot_app0.bin")
                    .to_string_lossy()
            ),
        )
        .unwrap();
            fs::write(
                build.join("partitions.csv"),
                b"app0,app,factory,0x10000,0x300000\n",
            )
            .unwrap();
            let fqbn = "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash";
            fs::write(
                build.join("build.options.json"),
                serde_json::json!({
                    "fqbn": fqbn,
                    "hardwareFolders": hardware.to_string_lossy(),
                    "compiler.optimization_flags": "-O1"
                })
                .to_string(),
            )
            .unwrap();
            upload_artifact_manifest::write(&build, fqbn, "signature").unwrap();
            let source =
                upload_artifact_manifest::read_verified(&build, fqbn, "signature").unwrap();

            let destination = fixture.root.join(if out_of_tree {
                "version-out-of-tree"
            } else {
                "version-legacy"
            });
            fs::create_dir_all(&destination).unwrap();
            let copied =
                copy_recovery_firmware(&build, &destination, &source, "signature").unwrap();
            let copied_build = destination.join(&copied.build_directory);
            let verified =
                upload_artifact_manifest::read_verified(&copied_build, fqbn, "signature").unwrap();
            let addresses = verified
                .artifacts
                .iter()
                .filter_map(|artifact| artifact.flash_address.clone())
                .collect::<BTreeSet<_>>();
            assert_eq!(
                addresses,
                BTreeSet::from([
                    "0x0".to_string(),
                    "0x8000".to_string(),
                    "0xe000".to_string(),
                    "0x10000".to_string(),
                ])
            );
            assert!(copied_build.join("boot_app0.bin").is_file());
            assert!(copied.partition.is_some());
            assert_eq!(copied.artifacts.len(), 5);

            let (transport_root, transport_build) =
                stage_firmware_for_transport(&copied_build, &verified, "signature").unwrap();
            let transport_verified =
                upload_artifact_manifest::read_verified(&transport_build, fqbn, "signature")
                    .unwrap();
            assert_eq!(transport_verified.artifacts.len(), 5);
            assert!(
                transport_build
                    .join(format!("{project}.bootloader.bin"))
                    .is_file()
            );
            if cfg!(windows) {
                assert!(
                    transport_build.to_string_lossy().len() < 240,
                    "transport path must remain below common esptool/Win32 limits: {}",
                    transport_build.display()
                );
            }
            fs::remove_dir_all(transport_root).unwrap();
        }
    }
}
