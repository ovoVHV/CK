use crate::package_quality::PackageQualityReport;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const RUNTIME_TRUST_SCHEMA_VERSION: u32 = 1;
const RUNTIME_TRUST_DIR: &str = "block-runtime-trust-v1";
const MAX_APPROVAL_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeApprovalRecord {
    pub schema_version: u32,
    pub package_id: String,
    pub content_sha256: String,
    pub approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivationInfo {
    pub state: String,
    pub executable_present: bool,
    pub package_id: String,
    pub content_sha256: Option<String>,
    pub approved_at: Option<String>,
    pub reason: String,
}

impl RuntimeActivationInfo {
    pub fn can_execute(&self) -> bool {
        self.state == "declarative-safe" && !self.executable_present
    }
}

fn valid_package_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn approval_key(package_id: &str, content_sha256: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(package_id.as_bytes());
    digest.update([0]);
    digest.update(content_sha256.as_bytes());
    format!("{:x}", digest.finalize())
}

fn approval_path(dir: &Path, package_id: &str, content_sha256: &str) -> PathBuf {
    dir.join(format!("{}.json", approval_key(package_id, content_sha256)))
}

fn read_approval(path: &Path) -> Option<RuntimeApprovalRecord> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_APPROVAL_FILE_BYTES {
        return None;
    }
    let raw = fs::read(path).ok()?;
    let record: RuntimeApprovalRecord = serde_json::from_slice(&raw).ok()?;
    (record.schema_version == RUNTIME_TRUST_SCHEMA_VERSION
        && valid_package_id(&record.package_id)
        && valid_sha256(&record.content_sha256))
    .then_some(record)
}

fn find_approval(
    dir: &Path,
    package_id: &str,
    content_sha256: &str,
) -> Option<RuntimeApprovalRecord> {
    let path = approval_path(dir, package_id, content_sha256);
    let record = read_approval(&path)?;
    (record.package_id == package_id && record.content_sha256.eq_ignore_ascii_case(content_sha256))
        .then_some(record)
}

fn remove_package_approvals(dir: &Path, package_id: &str) -> Result<usize, String> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if read_approval(&path).is_some_and(|record| record.package_id == package_id) {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Failed to revoke runtime approval '{}': {}",
                    package_id, error
                )
            })?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn write_approval(
    dir: &Path,
    package_id: &str,
    content_sha256: &str,
) -> Result<RuntimeApprovalRecord, String> {
    if !valid_package_id(package_id) {
        return Err("Invalid block package id for runtime approval".to_string());
    }
    if !valid_sha256(content_sha256) {
        return Err("Runtime approval requires a full SHA-256 content hash".to_string());
    }
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    remove_package_approvals(dir, package_id)?;

    let record = RuntimeApprovalRecord {
        schema_version: RUNTIME_TRUST_SCHEMA_VERSION,
        package_id: package_id.to_string(),
        content_sha256: content_sha256.to_ascii_lowercase(),
        approved_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let payload = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    let destination = approval_path(dir, package_id, content_sha256);
    let temporary = dir.join(format!(
        ".{}.{}.tmp",
        approval_key(package_id, content_sha256),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&payload)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|_| record)
}

fn trust_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::app_storage::desktop_dir(&app)
        .map(|root| root.join("CK").join(RUNTIME_TRUST_DIR))
        .map_err(|error| error.to_string())
}

fn package_path_is_managed(app: &tauri::AppHandle, package_path: &Path) -> Result<bool, String> {
    let package_path = package_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve block package path: {}", error))?;
    let mut roots = vec![crate::ck_root_dir()];
    if let Ok(app_data) = crate::app_storage::desktop_dir(&app) {
        roots.push(app_data.join("CK"));
    }
    for root in roots {
        if !root.exists() {
            continue;
        }
        if let Ok(root) = root.canonicalize() {
            if package_path.starts_with(root) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn runtime_activation_for_package(
    _app: &tauri::AppHandle,
    package_id: &str,
    report: Option<&PackageQualityReport>,
    executable_present: bool,
) -> RuntimeActivationInfo {
    if !executable_present {
        return RuntimeActivationInfo {
            state: "not-applicable".to_string(),
            executable_present: false,
            package_id: package_id.to_string(),
            content_sha256: report.and_then(|item| item.source_content_sha256.clone()),
            approved_at: None,
            reason: "This package has no executable Blockly JavaScript.".to_string(),
        };
    }

    RuntimeActivationInfo {
        state: "legacy-disabled".to_string(),
        executable_present: true,
        package_id: package_id.to_string(),
        content_sha256: report.and_then(|item| item.source_content_sha256.clone()),
        approved_at: None,
        reason: "CK 1.0 has no isolated JavaScript extension host. Quality reports and exact-hash approvals cannot grant main-WebView execution.".to_string(),
    }
}

#[tauri::command]
pub fn approve_block_package_runtime(
    _app: tauri::AppHandle,
    _package_id: String,
    _package_path: String,
    _expected_content_sha256: String,
) -> Result<RuntimeActivationInfo, String> {
    Err(
        "CK 1.0 does not accept runtime approval for executable block JavaScript. Migrate the package to declarative JSON."
            .to_string(),
    )
}

#[tauri::command]
pub fn revoke_block_package_runtime(
    app: tauri::AppHandle,
    package_id: String,
) -> Result<usize, String> {
    if !valid_package_id(&package_id) {
        return Err("Invalid block package id for runtime approval".to_string());
    }
    remove_package_approvals(&trust_dir(&app)?, &package_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ck-runtime-trust-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn exact_hash_approval_is_not_an_execution_capability() {
        let approved_legacy = RuntimeActivationInfo {
            state: "approved".to_string(),
            executable_present: true,
            package_id: "com.example.legacy".to_string(),
            content_sha256: Some("a".repeat(64)),
            approved_at: Some("2026-07-14T00:00:00Z".to_string()),
            reason: "historical provenance record".to_string(),
        };
        assert!(!approved_legacy.can_execute());

        let declarative = RuntimeActivationInfo {
            state: "declarative-safe".to_string(),
            executable_present: false,
            package_id: "com.example.safe".to_string(),
            content_sha256: Some("b".repeat(64)),
            approved_at: None,
            reason: "certified data-only runtime".to_string(),
        };
        assert!(declarative.can_execute());
    }

    #[test]
    fn approval_is_bound_to_exact_package_and_hash() {
        let dir = temp_dir("binding");
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        let record = write_approval(&dir, "com.example.sensor", &hash_a).unwrap();
        assert_eq!(record.package_id, "com.example.sensor");
        assert!(find_approval(&dir, "com.example.sensor", &hash_a).is_some());
        assert!(find_approval(&dir, "com.example.sensor", &hash_b).is_none());
        assert!(find_approval(&dir, "com.example.other", &hash_a).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn approving_an_update_revokes_the_old_hash() {
        let dir = temp_dir("update");
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        write_approval(&dir, "com.example.sensor", &hash_a).unwrap();
        write_approval(&dir, "com.example.sensor", &hash_b).unwrap();
        assert!(find_approval(&dir, "com.example.sensor", &hash_a).is_none());
        assert!(find_approval(&dir, "com.example.sensor", &hash_b).is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn damaged_or_oversized_records_are_ignored() {
        let dir = temp_dir("damage");
        fs::create_dir_all(&dir).unwrap();
        let hash = "c".repeat(64);
        let path = approval_path(&dir, "com.example.sensor", &hash);
        fs::write(&path, b"not-json").unwrap();
        assert!(find_approval(&dir, "com.example.sensor", &hash).is_none());
        fs::write(&path, vec![b'x'; (MAX_APPROVAL_FILE_BYTES + 1) as usize]).unwrap();
        assert!(find_approval(&dir, "com.example.sensor", &hash).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn filenames_do_not_expose_package_ids() {
        let dir = temp_dir("filename");
        let hash = "d".repeat(64);
        write_approval(&dir, "com.example.private-name", &hash).unwrap();
        let names = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
        assert!(!names[0].contains("private-name"));
        let _ = fs::remove_dir_all(dir);
    }
}
