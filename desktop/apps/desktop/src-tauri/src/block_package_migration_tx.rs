use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const TRANSACTION_SCHEMA_VERSION: u32 = 1;
const PROJECT_PACKAGE_RECORD_SCHEMA_VERSION: u32 = 1;
const TRANSACTION_ROOT_NAME: &str = "block-package-migrations-v1";
const TRANSACTION_METADATA_FILE: &str = "transaction.json";
const STAGED_PACKAGE_DIR: &str = "package";
const MIGRATION_MANIFEST_FILE: &str = "ck-migrations.json";
const USER_INSTALL_MARKER: &str = ".ck-user-installed.json";
const MAX_ARCHIVE_FILES: usize = 5_000;
const MAX_ARCHIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MIGRATION_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_TRANSACTION_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PROJECT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_WORKSPACE_BYTES: usize = 8 * 1024 * 1024;
const PREPARED_LIFETIME_MINUTES: i64 = 30;
const LOCK_STALE_MINUTES: i64 = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareBlockLibraryMigrationInput {
    pub path: String,
    pub board: String,
    #[serde(default)]
    pub board_package_id: Option<String>,
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PreparedOperation {
    NewInstall,
    Upgrade,
    InstallAndMigrate,
    ProjectMigrationOnly,
    PackageOnly,
    Identical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedBlockLibraryMigration {
    pub schema_version: u32,
    pub token: String,
    pub operation: String,
    pub package_id: String,
    pub package_name: String,
    pub installed_from_version: Option<String>,
    pub installed_from_content_sha256: Option<String>,
    pub project_from_version: Option<String>,
    pub project_from_content_sha256: Option<String>,
    pub to_version: String,
    pub to_content_sha256: String,
    pub migration_manifest: Option<Value>,
    pub migration_manifest_sha256: Option<String>,
    pub project_path: String,
    pub project_disk_sha256: String,
    pub requires_project_migration: bool,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitProjectPackageMigrationInput {
    pub workspace_before_json: String,
    pub workspace_after_json: String,
    pub workspace_before_sha256: String,
    pub workspace_after_sha256: String,
    pub checkpoint_id: String,
    pub step_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPreparedBlockLibraryMigrationInput {
    pub token: String,
    #[serde(default)]
    pub project: Option<CommitProjectPackageMigrationInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPreparedBlockLibraryMigrationResult {
    pub status: String,
    pub package_id: String,
    pub package_version: String,
    pub package_content_sha256: String,
    pub package_activated: bool,
    pub project_migrated: bool,
    pub project_disk_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionMetadata {
    schema_version: u32,
    token: String,
    state: String,
    operation: PreparedOperation,
    scope_id: String,
    package_id: String,
    package_name: String,
    installed_from_version: Option<String>,
    installed_from_content_sha256: Option<String>,
    project_from_version: Option<String>,
    project_from_content_sha256: Option<String>,
    to_version: String,
    to_content_sha256: String,
    migration_manifest: Option<Value>,
    migration_manifest_sha256: Option<String>,
    project_path: String,
    project_disk_sha256: String,
    requires_project_migration: bool,
    had_installed_package: bool,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone)]
struct PackageDescriptor {
    id: String,
    name: String,
    version: String,
    content_sha256: String,
}

#[derive(Debug, Clone)]
struct ProjectPackageRecord {
    version: String,
    content_sha256: String,
}

struct TransactionLock {
    path: PathBuf,
}

impl Drop for TransactionLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn normalize_sha256(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let digest = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{} must be a SHA-256 digest", label));
    }
    Ok(digest.to_ascii_lowercase())
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid block package migration token".to_string());
    }
    Ok(())
}

fn validate_checkpoint_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid migration checkpoint id".to_string());
    }
    Ok(())
}

fn canonical_project_file(project_path: &str) -> Result<PathBuf, String> {
    if project_path.trim().is_empty() {
        return Err("Project path is required for block package migration".to_string());
    }
    let path = fs::canonicalize(PathBuf::from(project_path.trim()))
        .map_err(|error| format!("Project path is unavailable: {}", error))?;
    if !path.is_file() {
        return Err(
            "Declarative package migration v1 supports only single-file .maker/.ck projects; legacy folder and XML projects remain unchanged"
                .to_string(),
        );
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case("maker") && !extension.eq_ignore_ascii_case("ck") {
        return Err("Declarative package migration requires a .maker or .ck project".to_string());
    }
    Ok(path)
}

fn read_limited(path: &Path, maximum: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect {}: {}", label, error))?;
    if metadata.len() > maximum {
        return Err(format!("{} exceeds its {} byte limit", label, maximum));
    }
    fs::read(path).map_err(|error| format!("Cannot read {}: {}", label, error))
}

fn parse_project_json(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Project is not valid JSON: {}", error))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Project JSON root must be an object".to_string())
}

fn project_package_record(
    project: &Map<String, Value>,
    package_id: &str,
) -> Result<Option<ProjectPackageRecord>, String> {
    let Some(container) = project.get("ck_block_packages") else {
        return Ok(None);
    };
    let container = container
        .as_object()
        .ok_or("Project ck_block_packages record is malformed")?;
    if container.get("schema_version").and_then(Value::as_u64)
        != Some(PROJECT_PACKAGE_RECORD_SCHEMA_VERSION as u64)
    {
        return Err("Project ck_block_packages schema is unsupported".to_string());
    }
    let packages = container
        .get("packages")
        .and_then(Value::as_object)
        .ok_or("Project ck_block_packages.packages record is malformed")?;
    let Some(record) = packages.get(package_id) else {
        return Ok(None);
    };
    let record = record
        .as_object()
        .ok_or("Project block package record is malformed")?;
    let version = record
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let content_sha256 = record
        .get("content_sha256")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    semver::Version::parse(&version)
        .map_err(|_| "Project block package version is not valid SemVer".to_string())?;
    let content_sha256 = normalize_sha256(&content_sha256, "Project block package hash")?;
    Ok(Some(ProjectPackageRecord {
        version,
        content_sha256,
    }))
}

fn read_library_descriptor(
    root: &Path,
    require_certified_report: bool,
) -> Result<PackageDescriptor, String> {
    let raw = fs::read_to_string(root.join("library.json"))
        .map_err(|error| format!("Cannot read library.json: {}", error))?;
    let json: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Invalid library.json: {}", error))?;
    let id = json
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !crate::package_quality::valid_package_id(&id, true) {
        return Err("Library package id is missing or unsafe".to_string());
    }
    let name = json
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .trim()
        .to_string();
    let version = json
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    semver::Version::parse(&version)
        .map_err(|_| format!("Library package version '{}' is not valid SemVer", version))?;
    let actual_hash = crate::package_quality::hash_package_contents(root)?;
    if require_certified_report {
        let report = crate::package_quality::read_quality_report_with_integrity(root)
            .ok_or("Installed library has no intact quality report")?;
        report.enforce()?;
        let certified = report
            .source_content_sha256
            .as_deref()
            .ok_or("Installed library quality report has no content hash")?;
        if certified != actual_hash {
            return Err(
                "Installed library content hash no longer matches its quality report".to_string(),
            );
        }
    }
    Ok(PackageDescriptor {
        id,
        name,
        version,
        content_sha256: actual_hash,
    })
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    crate::package_quality::validate_local_package_tree(
        source,
        MAX_ARCHIVE_FILES,
        MAX_ARCHIVE_FILE_BYTES,
        MAX_ARCHIVE_BYTES,
    )?;
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in walkdir::WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
        } else {
            return Err(format!(
                "Library package contains an unsupported path: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn resolve_extracted_package_root(extracted: &Path) -> Result<PathBuf, String> {
    if extracted.join("library.json").is_file() {
        return Ok(extracted.to_path_buf());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(extracted).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            && entry.path().join("library.json").is_file()
        {
            candidates.push(entry.path());
        }
    }
    if candidates.len() != 1 {
        return Err(format!(
            "Library archive must contain exactly one root or top-level library.json (found {})",
            candidates.len()
        ));
    }
    Ok(candidates.remove(0))
}

fn stage_local_block_package(
    source: &Path,
    transaction_dir: &Path,
) -> Result<PackageDescriptor, String> {
    let stage = transaction_dir.join(STAGED_PACKAGE_DIR);
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if extension.eq_ignore_ascii_case("json") {
        if source.file_name().and_then(|name| name.to_str()) != Some("library.json") {
            return Err("Select the package's standard library.json manifest".to_string());
        }
        let parent = source.parent().ok_or("Invalid library.json path")?;
        copy_directory(parent, &stage)?;
    } else if extension.eq_ignore_ascii_case("zip") {
        let archive_file = File::open(source)
            .map_err(|error| format!("Cannot open library archive: {}", error))?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|error| format!("Invalid library archive: {}", error))?;
        crate::package_quality::validate_zip_archive(
            &mut archive,
            MAX_ARCHIVE_FILES,
            MAX_ARCHIVE_FILE_BYTES,
            MAX_ARCHIVE_BYTES,
        )?;
        let extracted = transaction_dir.join("extracted");
        fs::create_dir_all(&extracted).map_err(|error| error.to_string())?;
        archive
            .extract(&extracted)
            .map_err(|error| format!("Cannot extract library archive: {}", error))?;
        let package_root = resolve_extracted_package_root(&extracted)?;
        if package_root.join("board.json").is_file() {
            return Err("Board packages must be installed from Board Manager".to_string());
        }
        if package_root == extracted {
            fs::rename(&extracted, &stage).map_err(|error| error.to_string())?;
        } else {
            fs::rename(&package_root, &stage).map_err(|error| error.to_string())?;
            let _ = fs::remove_dir_all(&extracted);
        }
    } else {
        return Err(
            "Block package migration preparation accepts only ZIP or library.json".to_string(),
        );
    }

    crate::package_quality::validate_local_package_tree(
        &stage,
        MAX_ARCHIVE_FILES,
        MAX_ARCHIVE_FILE_BYTES,
        MAX_ARCHIVE_BYTES,
    )?;
    let report = crate::lib_custom_registry::inspect_library_package(&stage, true);
    report.enforce()?;
    crate::package_quality::write_quality_report(&stage, &report)?;
    let marker = serde_json::json!({
        "schema_version": 1,
        "installed_by": "ck-library-manager",
        "source": "local-migration-transaction"
    });
    fs::write(
        stage.join(USER_INSTALL_MARKER),
        serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let descriptor = read_library_descriptor(&stage, true)?;
    if report.package_id.as_deref() != Some(descriptor.id.as_str()) {
        return Err("Quality report is not bound to the staged package id".to_string());
    }
    Ok(descriptor)
}

fn read_migration_manifest(stage: &Path, package_id: &str) -> Result<(Value, String), String> {
    let path = stage.join(MIGRATION_MANIFEST_FILE);
    let bytes = read_limited(&path, MAX_MIGRATION_MANIFEST_BYTES, MIGRATION_MANIFEST_FILE)?;
    let manifest_bytes = bytes
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(bytes.as_slice());
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|error| format!("Invalid {}: {}", MIGRATION_MANIFEST_FILE, error))?;
    let root = manifest
        .as_object()
        .ok_or_else(|| format!("{} root must be an object", MIGRATION_MANIFEST_FILE))?;
    if root.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(format!(
            "{} must use schema_version 1",
            MIGRATION_MANIFEST_FILE
        ));
    }
    if root.get("package_id").and_then(Value::as_str) != Some(package_id) {
        return Err(format!(
            "{} package_id does not match library.json",
            MIGRATION_MANIFEST_FILE
        ));
    }
    if !root.get("migrations").is_some_and(Value::is_array) {
        return Err(format!(
            "{} has no migrations array",
            MIGRATION_MANIFEST_FILE
        ));
    }
    Ok((manifest, sha256_bytes(&bytes)))
}

fn transaction_dir(root: &Path, token: &str) -> PathBuf {
    root.join(token)
}

fn metadata_path(root: &Path, token: &str) -> PathBuf {
    transaction_dir(root, token).join(TRANSACTION_METADATA_FILE)
}

fn write_metadata(root: &Path, metadata: &TransactionMetadata) -> Result<(), String> {
    let path = metadata_path(root, &metadata.token);
    let payload = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&payload)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn load_metadata(root: &Path, token: &str) -> Result<TransactionMetadata, String> {
    validate_token(token)?;
    let bytes = read_limited(
        &metadata_path(root, token),
        MAX_TRANSACTION_METADATA_BYTES,
        "migration transaction metadata",
    )?;
    let metadata: TransactionMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Migration transaction metadata is damaged: {}", error))?;
    if metadata.schema_version != TRANSACTION_SCHEMA_VERSION || metadata.token != token {
        return Err("Migration transaction metadata identity is invalid".to_string());
    }
    if metadata.state != "prepared"
        || !crate::package_quality::valid_package_id(&metadata.scope_id, false)
        || !crate::package_quality::valid_package_id(&metadata.package_id, true)
        || semver::Version::parse(&metadata.to_version).is_err()
        || normalize_sha256(&metadata.to_content_sha256, "Prepared package hash").is_err()
        || normalize_sha256(&metadata.project_disk_sha256, "Prepared project hash").is_err()
    {
        return Err("Migration transaction metadata contract is invalid".to_string());
    }
    let project_path = Path::new(&metadata.project_path);
    let project_extension = project_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !project_path.is_absolute()
        || (!project_extension.eq_ignore_ascii_case("maker")
            && !project_extension.eq_ignore_ascii_case("ck"))
    {
        return Err("Migration transaction project path is invalid".to_string());
    }
    Ok(metadata)
}

fn state_marker(root: &Path, token: &str, state: &str) -> PathBuf {
    transaction_dir(root, token).join(format!("state-{}", state))
}

fn write_state_marker(root: &Path, token: &str, state: &str) -> Result<(), String> {
    let path = state_marker(root, token, state);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{}", Utc::now().to_rfc3339()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    sync_directory(path.parent().unwrap_or_else(|| Path::new(".")))
}

fn transaction_state<'a>(root: &Path, metadata: &'a TransactionMetadata) -> &'a str {
    if state_marker(root, &metadata.token, "committed").is_file() {
        "committed"
    } else if state_marker(root, &metadata.token, "committing").is_file() {
        "committing"
    } else {
        metadata.state.as_str()
    }
}

fn acquire_transaction_lock(root: &Path) -> Result<TransactionLock, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join(".transaction.lock");
    let create = || OpenOptions::new().write(true).create_new(true).open(&path);
    let mut file = match create() {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::metadata(&path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age.as_secs() >= (LOCK_STALE_MINUTES as u64 * 60));
            if !stale {
                return Err("Another block package migration transaction is active".to_string());
            }
            fs::remove_file(&path).map_err(|cause| {
                format!("Cannot recover stale migration transaction lock: {}", cause)
            })?;
            create().map_err(|cause| cause.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    writeln!(file, "{}", Utc::now().to_rfc3339()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(TransactionLock { path })
}

fn operation_label(operation: &PreparedOperation) -> String {
    serde_json::to_value(operation)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn prepared_from_metadata(metadata: &TransactionMetadata) -> PreparedBlockLibraryMigration {
    PreparedBlockLibraryMigration {
        schema_version: metadata.schema_version,
        token: metadata.token.clone(),
        operation: operation_label(&metadata.operation),
        package_id: metadata.package_id.clone(),
        package_name: metadata.package_name.clone(),
        installed_from_version: metadata.installed_from_version.clone(),
        installed_from_content_sha256: metadata.installed_from_content_sha256.clone(),
        project_from_version: metadata.project_from_version.clone(),
        project_from_content_sha256: metadata.project_from_content_sha256.clone(),
        to_version: metadata.to_version.clone(),
        to_content_sha256: metadata.to_content_sha256.clone(),
        migration_manifest: metadata.migration_manifest.clone(),
        migration_manifest_sha256: metadata.migration_manifest_sha256.clone(),
        project_path: metadata.project_path.clone(),
        project_disk_sha256: metadata.project_disk_sha256.clone(),
        requires_project_migration: metadata.requires_project_migration,
        expires_at: metadata.expires_at.clone(),
    }
}

fn prepare_in_roots(
    transaction_root: &Path,
    libraries_scope_root: &Path,
    scope_id: &str,
    source: &Path,
    project_path: &str,
) -> Result<PreparedBlockLibraryMigration, String> {
    let project_path = canonical_project_file(project_path)?;
    let project_bytes = read_limited(&project_path, MAX_PROJECT_BYTES, "project")?;
    let project_json = parse_project_json(&project_bytes)?;
    let project_disk_sha256 = sha256_bytes(&project_bytes);

    let token = Uuid::new_v4().simple().to_string();
    let directory = transaction_dir(transaction_root, &token);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let result = (|| -> Result<PreparedBlockLibraryMigration, String> {
        let staged = stage_local_block_package(source, &directory)?;
        let target = libraries_scope_root.join(&staged.id);
        let installed = if target.is_dir() {
            Some(read_library_descriptor(&target, true)?)
        } else {
            None
        };
        if installed
            .as_ref()
            .is_some_and(|existing| existing.id != staged.id)
        {
            return Err("Installed package identity does not match its directory".to_string());
        }
        let project_record = project_package_record(&project_json, &staged.id)?;
        if project_record.is_none()
            && installed.as_ref().is_some_and(|existing| {
                existing.version != staged.version
                    || existing.content_sha256 != staged.content_sha256
            })
        {
            return Err(
                "BLOCK_PACKAGE_EVIDENCE_REQUIRED: The project has no recorded source version/hash for this package. Open it safely with the currently enabled package and save once to record the enabled declarative package inventory before upgrading. If unknown blocks prevent a safe save, keep the old package and restore from a backup or checkpoint."
                    .to_string(),
            );
        }
        let project_from = project_record;

        if installed.as_ref().is_some_and(|existing| {
            existing.version == staged.version && existing.content_sha256 != staged.content_sha256
        }) {
            return Err(
                "The package content changed without a SemVer version change; migration is blocked"
                    .to_string(),
            );
        }
        if project_from.as_ref().is_some_and(|record| {
            record.version == staged.version && record.content_sha256 != staged.content_sha256
        }) {
            return Err(
                "The project records different package content under the same version; migration is blocked"
                    .to_string(),
            );
        }

        let requires_project_migration = project_from.as_ref().is_some_and(|record| {
            record.version != staged.version || record.content_sha256 != staged.content_sha256
        });
        let package_changes = installed.as_ref().is_none_or(|existing| {
            existing.version != staged.version || existing.content_sha256 != staged.content_sha256
        });
        let operation = match (
            installed.is_some(),
            package_changes,
            requires_project_migration,
        ) {
            (false, _, true) => PreparedOperation::InstallAndMigrate,
            (false, _, false) => PreparedOperation::NewInstall,
            (true, false, true) => PreparedOperation::ProjectMigrationOnly,
            (true, false, false) => PreparedOperation::Identical,
            (true, true, true) => PreparedOperation::Upgrade,
            (true, true, false) => PreparedOperation::PackageOnly,
        };

        let (migration_manifest, migration_manifest_sha256) = if requires_project_migration {
            let (manifest, hash) =
                read_migration_manifest(&directory.join(STAGED_PACKAGE_DIR), &staged.id)?;
            (Some(manifest), Some(hash))
        } else {
            (None, None)
        };
        let now = Utc::now();
        let metadata = TransactionMetadata {
            schema_version: TRANSACTION_SCHEMA_VERSION,
            token: token.clone(),
            state: "prepared".to_string(),
            operation,
            scope_id: scope_id.to_string(),
            package_id: staged.id,
            package_name: staged.name,
            installed_from_version: installed.as_ref().map(|item| item.version.clone()),
            installed_from_content_sha256: installed
                .as_ref()
                .map(|item| item.content_sha256.clone()),
            project_from_version: project_from.as_ref().map(|item| item.version.clone()),
            project_from_content_sha256: project_from
                .as_ref()
                .map(|item| item.content_sha256.clone()),
            to_version: staged.version,
            to_content_sha256: staged.content_sha256,
            migration_manifest,
            migration_manifest_sha256,
            project_path: project_path.to_string_lossy().to_string(),
            project_disk_sha256,
            requires_project_migration,
            had_installed_package: installed.is_some(),
            created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: (now + Duration::minutes(PREPARED_LIFETIME_MINUTES))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        write_metadata(transaction_root, &metadata)?;
        Ok(prepared_from_metadata(&metadata))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
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
    sha256_bytes(normalized_project_path(project_path).as_bytes())
}

fn verify_checkpoint(
    app_data: &Path,
    project_path: &Path,
    checkpoint_id: &str,
    expected_workspace: &str,
) -> Result<(), String> {
    validate_checkpoint_id(checkpoint_id)?;
    let path = app_data
        .join("project-checkpoints-v1")
        .join(project_storage_key(&project_path.to_string_lossy()))
        .join(format!("{}.checkpoint.json", checkpoint_id));
    let bytes = read_limited(&path, 5 * 1024 * 1024, "migration safety checkpoint")?;
    let checkpoint: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Migration safety checkpoint is damaged: {}", error))?;
    let root = checkpoint
        .as_object()
        .ok_or("Migration safety checkpoint root is invalid")?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || root.get("id").and_then(Value::as_str) != Some(checkpoint_id)
        || root.get("reason").and_then(Value::as_str) != Some("before_package_migration")
        || root.get("workspaceJson").and_then(Value::as_str) != Some(expected_workspace)
    {
        return Err(
            "Migration checkpoint does not prove the exact pre-migration workspace".to_string(),
        );
    }
    let checkpoint_project = root
        .get("projectPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if normalized_project_path(checkpoint_project)
        != normalized_project_path(&project_path.to_string_lossy())
    {
        return Err("Migration checkpoint belongs to another project".to_string());
    }
    Ok(())
}

fn validate_workspace_json(value: &str, label: &str) -> Result<String, String> {
    if value.len() > MAX_WORKSPACE_BYTES {
        return Err(format!("{} exceeds the 8 MiB migration limit", label));
    }
    let parsed: Value = serde_json::from_str(value.strip_prefix('\u{feff}').unwrap_or(value))
        .map_err(|error| format!("{} is not valid JSON: {}", label, error))?;
    if !parsed.is_object() {
        return Err(format!("{} must be a Blockly JSON object", label));
    }
    Ok(sha256_bytes(value.as_bytes()))
}

fn validate_step_ids(metadata: &TransactionMetadata, step_ids: &[String]) -> Result<(), String> {
    let manifest = metadata
        .migration_manifest
        .as_ref()
        .and_then(Value::as_object)
        .ok_or("Prepared transaction has no migration manifest")?;
    let available: std::collections::BTreeSet<&str> = manifest
        .get("migrations")
        .and_then(Value::as_array)
        .ok_or("Prepared migration manifest has no migrations")?
        .iter()
        .filter_map(|step| step.get("id").and_then(Value::as_str))
        .collect();
    if step_ids.is_empty() {
        return Err("A version-changing migration must record at least one step".to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    for id in step_ids {
        if id.trim() != id
            || id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("Migration plan contains an invalid step id".to_string());
        }
        if !seen.insert(id.as_str()) {
            return Err("Migration plan contains duplicate step ids".to_string());
        }
        if !available.contains(id.as_str()) {
            return Err(format!(
                "Migration step '{}' is not present in the prepared manifest",
                id
            ));
        }
    }
    Ok(())
}

fn build_migrated_project(
    app_data: &Path,
    metadata: &TransactionMetadata,
    input: &CommitProjectPackageMigrationInput,
) -> Result<(Vec<u8>, String), String> {
    let project_path = canonical_project_file(&metadata.project_path)?;
    let current = read_limited(&project_path, MAX_PROJECT_BYTES, "project")?;
    if sha256_bytes(&current) != metadata.project_disk_sha256 {
        return Err(
            "Project changed on disk after migration preview; package and project were not modified"
                .to_string(),
        );
    }
    let before_hash =
        validate_workspace_json(&input.workspace_before_json, "Pre-migration workspace")?;
    let after_hash = validate_workspace_json(&input.workspace_after_json, "Migrated workspace")?;
    if normalize_sha256(
        &input.workspace_before_sha256,
        "Pre-migration workspace hash",
    )? != before_hash
        || normalize_sha256(&input.workspace_after_sha256, "Migrated workspace hash")? != after_hash
    {
        return Err("Migration workspace hash evidence does not match its payload".to_string());
    }
    verify_checkpoint(
        app_data,
        &project_path,
        &input.checkpoint_id,
        &input.workspace_before_json,
    )?;
    validate_step_ids(metadata, &input.step_ids)?;

    let mut project = parse_project_json(&current)?;
    project.insert(
        "xml".to_string(),
        Value::String(input.workspace_after_json.clone()),
    );

    let existing_lock = project.remove("ck_block_packages");
    let mut lock = match existing_lock {
        Some(Value::Object(lock)) => lock,
        Some(_) => return Err("Project ck_block_packages record is malformed".to_string()),
        None => Map::new(),
    };
    if let Some(version) = lock.get("schema_version") {
        if version.as_u64() != Some(PROJECT_PACKAGE_RECORD_SCHEMA_VERSION as u64) {
            return Err("Project ck_block_packages schema is unsupported".to_string());
        }
    }
    lock.insert(
        "schema_version".to_string(),
        Value::from(PROJECT_PACKAGE_RECORD_SCHEMA_VERSION),
    );
    let mut packages = match lock.remove("packages") {
        Some(Value::Object(packages)) => packages,
        Some(_) => return Err("Project ck_block_packages.packages record is malformed".to_string()),
        None => Map::new(),
    };
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    packages.insert(
        metadata.package_id.clone(),
        serde_json::json!({
            "version": metadata.to_version,
            "content_sha256": metadata.to_content_sha256,
            "recorded_at": now,
            "generated_code_stale": true,
            "migration": {
                "schema_version": 1,
                "from_version": metadata.project_from_version,
                "from_content_sha256": metadata.project_from_content_sha256,
                "manifest_sha256": metadata.migration_manifest_sha256,
                "step_ids": input.step_ids,
                "workspace_before_sha256": before_hash,
                "workspace_after_sha256": after_hash,
                "checkpoint_id": input.checkpoint_id,
                "applied_at": now
            }
        }),
    );
    lock.insert("packages".to_string(), Value::Object(packages));
    project.insert("ck_block_packages".to_string(), Value::Object(lock));
    let payload =
        serde_json::to_vec_pretty(&Value::Object(project)).map_err(|error| error.to_string())?;
    if payload.len() as u64 > MAX_PROJECT_BYTES {
        return Err("Migrated project exceeds the 32 MiB safety limit".to_string());
    }
    let hash = sha256_bytes(&payload);
    Ok((payload, hash))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_project_temp(path: &Path, payload: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(payload).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn package_target(ck_root: &Path, metadata: &TransactionMetadata) -> PathBuf {
    ck_root
        .join("libraries")
        .join(&metadata.scope_id)
        .join(&metadata.package_id)
}

fn package_backup(ck_root: &Path, metadata: &TransactionMetadata) -> PathBuf {
    ck_root
        .join("libraries")
        .join(&metadata.scope_id)
        .join(format!(
            ".ck-migration-backup-{}-{}",
            metadata.package_id, metadata.token
        ))
}

fn project_backup(metadata: &TransactionMetadata) -> PathBuf {
    PathBuf::from(&metadata.project_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".ck-migration-{}.project-backup", metadata.token))
}

fn project_temp(metadata: &TransactionMetadata) -> PathBuf {
    PathBuf::from(&metadata.project_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".ck-migration-{}.project-tmp", metadata.token))
}

fn rollback_incomplete_transaction(
    transaction_root: &Path,
    ck_root: &Path,
    metadata: &TransactionMetadata,
) -> Result<(), String> {
    let project = PathBuf::from(&metadata.project_path);
    let project_backup = project_backup(metadata);
    let project_temp = project_temp(metadata);
    let target = package_target(ck_root, metadata);
    let package_backup = package_backup(ck_root, metadata);
    let stage = transaction_dir(transaction_root, &metadata.token).join(STAGED_PACKAGE_DIR);
    let mut failures = Vec::new();

    if project_backup.exists() {
        if project.exists() {
            if let Err(error) = fs::remove_file(&project) {
                failures.push(format!("remove migrated project: {}", error));
            }
        }
        if !project.exists() {
            if let Err(error) = fs::rename(&project_backup, &project) {
                failures.push(format!("restore original project: {}", error));
            }
        }
    }
    let _ = fs::remove_file(&project_temp);

    if package_backup.exists() {
        if target.exists() {
            if let Err(error) = fs::remove_dir_all(&target) {
                failures.push(format!("remove staged package: {}", error));
            }
        }
        if !target.exists() {
            if let Err(error) = fs::rename(&package_backup, &target) {
                failures.push(format!("restore installed package: {}", error));
            }
        }
    } else if !metadata.had_installed_package && !stage.exists() && target.exists() {
        if let Err(error) = fs::remove_dir_all(&target) {
            failures.push(format!("remove interrupted new package install: {}", error));
        }
    }

    if failures.is_empty() {
        let _ = fs::remove_dir_all(transaction_dir(transaction_root, &metadata.token));
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn recover_transactions(transaction_root: &Path, ck_root: &Path) -> Result<(), String> {
    if !transaction_root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(transaction_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let token = entry.file_name().to_string_lossy().to_string();
        if validate_token(&token).is_err() {
            continue;
        }
        let metadata = match load_metadata(transaction_root, &token) {
            Ok(metadata) => metadata,
            Err(error) => {
                let may_have_mutated = state_marker(transaction_root, &token, "committing")
                    .exists()
                    || state_marker(transaction_root, &token, "committed").exists();
                if may_have_mutated {
                    return Err(format!(
                        "Migration transaction {} has durable commit state but unreadable metadata; refusing further migrations: {}",
                        token, error
                    ));
                }
                log::warn!(
                    "Cannot inspect block package migration {}: {}",
                    token,
                    error
                );
                continue;
            }
        };
        let state = transaction_state(transaction_root, &metadata);
        if state == "committing" {
            rollback_incomplete_transaction(transaction_root, ck_root, &metadata).map_err(
                |error| {
                    format!(
                        "Cannot recover interrupted block package migration: {}",
                        error
                    )
                },
            )?;
        } else if state == "committed" {
            let _ = fs::remove_dir_all(package_backup(ck_root, &metadata));
            let _ = fs::remove_file(project_backup(&metadata));
            let _ = fs::remove_file(project_temp(&metadata));
            let _ = fs::remove_dir_all(transaction_dir(transaction_root, &token));
        } else if state == "prepared" {
            let expired = DateTime::parse_from_rfc3339(&metadata.expires_at)
                .map(|value| value.with_timezone(&Utc) <= Utc::now())
                .unwrap_or(true);
            if expired {
                let _ = fs::remove_dir_all(transaction_dir(transaction_root, &token));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommitFailurePoint {
    AfterPackageActivation,
}

fn commit_in_roots(
    transaction_root: &Path,
    ck_root: &Path,
    app_data: &Path,
    input: CommitPreparedBlockLibraryMigrationInput,
    failure_point: Option<CommitFailurePoint>,
) -> Result<CommitPreparedBlockLibraryMigrationResult, String> {
    let metadata = load_metadata(transaction_root, &input.token)?;
    if transaction_state(transaction_root, &metadata) != "prepared" {
        return Err("Migration transaction is not prepared".to_string());
    }
    let expires = DateTime::parse_from_rfc3339(&metadata.expires_at)
        .map_err(|_| "Migration transaction expiration is invalid")?
        .with_timezone(&Utc);
    if expires <= Utc::now() {
        let _ = fs::remove_dir_all(transaction_dir(transaction_root, &metadata.token));
        return Err("Migration preview expired; prepare it again".to_string());
    }
    let stage = transaction_dir(transaction_root, &metadata.token).join(STAGED_PACKAGE_DIR);
    let staged = read_library_descriptor(&stage, true)?;
    if staged.id != metadata.package_id
        || staged.version != metadata.to_version
        || staged.content_sha256 != metadata.to_content_sha256
    {
        return Err("Staged package changed after migration preview".to_string());
    }
    let target = package_target(ck_root, &metadata);
    if metadata.had_installed_package {
        let installed = read_library_descriptor(&target, true)?;
        if Some(installed.version.as_str()) != metadata.installed_from_version.as_deref()
            || Some(installed.content_sha256.as_str())
                != metadata.installed_from_content_sha256.as_deref()
        {
            return Err("Installed package changed after migration preview".to_string());
        }
    } else if target.exists() {
        return Err("A package with this id was installed after migration preview".to_string());
    }

    if metadata.operation == PreparedOperation::Identical {
        let _ = fs::remove_dir_all(transaction_dir(transaction_root, &metadata.token));
        return Ok(CommitPreparedBlockLibraryMigrationResult {
            status: "identical".to_string(),
            package_id: metadata.package_id,
            package_version: metadata.to_version,
            package_content_sha256: metadata.to_content_sha256,
            package_activated: false,
            project_migrated: false,
            project_disk_sha256: Some(metadata.project_disk_sha256),
        });
    }

    let (project_payload, migrated_project_sha256) = if metadata.requires_project_migration {
        let project = input
            .project
            .as_ref()
            .ok_or("Migration commit requires the previewed workspace and a safety checkpoint")?;
        let (payload, hash) = build_migrated_project(app_data, &metadata, project)?;
        (Some(payload), Some(hash))
    } else {
        if input.project.is_some() {
            return Err("Package-only install must not rewrite the project".to_string());
        }
        (None, None)
    };

    let activates_package = !matches!(metadata.operation, PreparedOperation::ProjectMigrationOnly);
    let package_backup = package_backup(ck_root, &metadata);
    let project_path = PathBuf::from(&metadata.project_path);
    let project_backup = project_backup(&metadata);
    let project_temp = project_temp(&metadata);
    if package_backup.exists() || project_backup.exists() || project_temp.exists() {
        return Err("Migration transaction found unexpected backup files".to_string());
    }
    if let Some(payload) = project_payload.as_deref() {
        write_project_temp(&project_temp, payload)?;
    }

    write_state_marker(transaction_root, &metadata.token, "committing")?;
    let mutation_result = (|| -> Result<(), String> {
        if activates_package {
            if metadata.had_installed_package {
                fs::rename(&target, &package_backup)
                    .map_err(|error| format!("Cannot preserve installed package: {}", error))?;
            }
            fs::rename(&stage, &target)
                .map_err(|error| format!("Cannot activate staged package: {}", error))?;
            sync_directory(target.parent().unwrap_or_else(|| Path::new(".")))?;
        }
        if failure_point == Some(CommitFailurePoint::AfterPackageActivation) {
            return Err("injected failure after package activation".to_string());
        }
        if project_payload.is_some() {
            fs::rename(&project_path, &project_backup)
                .map_err(|error| format!("Cannot preserve original project: {}", error))?;
            fs::rename(&project_temp, &project_path)
                .map_err(|error| format!("Cannot activate migrated project: {}", error))?;
            sync_directory(project_path.parent().unwrap_or_else(|| Path::new(".")))?;
        }
        Ok(())
    })();

    if let Err(error) = mutation_result {
        let rollback = rollback_incomplete_transaction(transaction_root, ck_root, &metadata);
        return match rollback {
            Ok(()) => Err(format!(
                "Block package migration failed and was rolled back: {}",
                error
            )),
            Err(rollback_error) => Err(format!(
                "Block package migration failed ({}) and rollback needs attention ({})",
                error, rollback_error
            )),
        };
    }

    if let Err(error) = write_state_marker(transaction_root, &metadata.token, "committed") {
        let rollback = rollback_incomplete_transaction(transaction_root, ck_root, &metadata);
        return match rollback {
            Ok(()) => Err(format!(
                "Migration commit evidence could not be persisted and all changes were rolled back: {}",
                error
            )),
            Err(rollback_error) => Err(format!(
                "Migration commit evidence failed ({}) and rollback needs attention ({})",
                error, rollback_error
            )),
        };
    }
    let _ = fs::remove_dir_all(&package_backup);
    let _ = fs::remove_file(&project_backup);
    let _ = fs::remove_file(&project_temp);
    let _ = fs::remove_dir_all(transaction_dir(transaction_root, &metadata.token));
    Ok(CommitPreparedBlockLibraryMigrationResult {
        status: "committed".to_string(),
        package_id: metadata.package_id,
        package_version: metadata.to_version,
        package_content_sha256: metadata.to_content_sha256,
        package_activated: activates_package,
        project_migrated: project_payload.is_some(),
        project_disk_sha256: migrated_project_sha256,
    })
}

pub fn recover_block_package_migrations_on_startup(app: &AppHandle) -> Result<(), String> {
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    let transaction_root = app_data.join(TRANSACTION_ROOT_NAME);
    let _lock = acquire_transaction_lock(&transaction_root)?;
    recover_transactions(&transaction_root, &crate::ck_root_dir())
}

#[tauri::command]
pub async fn prepare_block_library_migration(
    app: AppHandle,
    input: PrepareBlockLibraryMigrationInput,
) -> Result<PreparedBlockLibraryMigration, String> {
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    let transaction_root = app_data.join(TRANSACTION_ROOT_NAME);
    let _lock = acquire_transaction_lock(&transaction_root)?;
    recover_transactions(&transaction_root, &crate::ck_root_dir())?;
    let scope_id = crate::lib_custom_registry::library_install_scope_id(
        &app,
        &input.board,
        input.board_package_id.as_deref(),
    )?;
    let libraries_scope_root = crate::ck_root_dir().join("libraries").join(&scope_id);
    fs::create_dir_all(&libraries_scope_root).map_err(|error| error.to_string())?;
    prepare_in_roots(
        &transaction_root,
        &libraries_scope_root,
        &scope_id,
        Path::new(&input.path),
        &input.project_path,
    )
}

#[tauri::command]
pub async fn commit_prepared_block_library_migration(
    app: AppHandle,
    input: CommitPreparedBlockLibraryMigrationInput,
) -> Result<CommitPreparedBlockLibraryMigrationResult, String> {
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    let transaction_root = app_data.join(TRANSACTION_ROOT_NAME);
    let _lock = acquire_transaction_lock(&transaction_root)?;
    recover_transactions(&transaction_root, &crate::ck_root_dir())?;
    commit_in_roots(
        &transaction_root,
        &crate::ck_root_dir(),
        &app_data,
        input,
        None,
    )
}

#[tauri::command]
pub async fn cancel_prepared_block_library_migration(
    app: AppHandle,
    token: String,
) -> Result<(), String> {
    validate_token(&token)?;
    let app_data = crate::app_storage::desktop_dir(&app)
        .map_err(|error| error.to_string())?;
    let transaction_root = app_data.join(TRANSACTION_ROOT_NAME);
    let _lock = acquire_transaction_lock(&transaction_root)?;
    recover_transactions(&transaction_root, &crate::ck_root_dir())?;
    let metadata = load_metadata(&transaction_root, &token)?;
    if transaction_state(&transaction_root, &metadata) != "prepared" {
        return Err("Only a prepared migration can be cancelled".to_string());
    }
    fs::remove_dir_all(transaction_dir(&transaction_root, &token))
        .map_err(|error| error.to_string())
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
                "ck-block-package-migration-{}-{}",
                label,
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn workspace(block_type: &str, field: &str, value: &str) -> String {
        serde_json::json!({
            "blocks": {
                "languageVersion": 0,
                "blocks": [{
                    "type": block_type,
                    "id": "root-block",
                    "fields": { field: value },
                    "extraState": {
                        "opaque": { "type": "must_not_be_touched", "fields": { field: value } }
                    }
                }]
            }
        })
        .to_string()
    }

    fn write_package(
        root: &Path,
        package_id: &str,
        version: &str,
        block_type: &str,
        migration: Option<Value>,
    ) {
        fs::create_dir_all(root.join("blocks")).unwrap();
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": package_id,
                "name": "Migration fixture",
                "version": version,
                "description": "Migration transaction fixture",
                "author": "CK Tests",
                "architectures": ["*"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("ck-blocks.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 1,
                "id": package_id,
                "display_name": "Migration fixture",
                "description": "Migration transaction fixture",
                "compatibility": { "boards": ["*"], "architectures": ["*"] },
                "entrypoints": {
                    "blocks": "blocks/blocks.json",
                    "generator": "blocks/ck-generator.json",
                    "toolbox": "blocks/toolbox.xml"
                },
                "blocks": [{
                    "type": block_type,
                    "display_name": "Migration block",
                    "description": "Migration transaction fixture block",
                    "kind": "statement"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("blocks/blocks.json"),
            serde_json::to_vec_pretty(&serde_json::json!([{
                "type": block_type,
                "message0": "Migration fixture",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 180,
                "tooltip": "Migration transaction fixture block"
            }]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("blocks/ck-generator.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": "ck-generator",
                "version": 1,
                "rules": [{
                    "type": block_type,
                    "kind": "statement",
                    "template": "// migration fixture\n",
                    "order": 0
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("blocks/toolbox.xml"),
            format!(
                "<category name=\"Migration\"><block type=\"{}\" /></category>",
                block_type
            ),
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "test license").unwrap();
        if let Some(migration) = migration {
            fs::write(
                root.join(MIGRATION_MANIFEST_FILE),
                serde_json::to_vec_pretty(&migration).unwrap(),
            )
            .unwrap();
        }
    }

    fn certify_package(root: &Path) -> PackageDescriptor {
        let report = crate::lib_custom_registry::inspect_library_package(root, true);
        assert!(
            matches!(report.status.as_str(), "passed" | "passed_with_warnings"),
            "{:#?}",
            report.checks
        );
        report.enforce().unwrap();
        crate::package_quality::write_quality_report(root, &report).unwrap();
        read_library_descriptor(root, true).unwrap()
    }

    struct Fixture {
        _root: TestRoot,
        transaction_root: PathBuf,
        ck_root: PathBuf,
        app_data: PathBuf,
        libraries_scope: PathBuf,
        source_manifest: PathBuf,
        project_path: PathBuf,
        before_workspace: String,
        after_workspace: String,
        old: PackageDescriptor,
    }

    fn fixture(label: &str) -> Fixture {
        let root = TestRoot::new(label);
        let ck_root = root.path.join("ck-root");
        let app_data = root.path.join("app-data");
        let transaction_root = app_data.join(TRANSACTION_ROOT_NAME);
        let libraries_scope = ck_root.join("libraries/scope");
        let installed = libraries_scope.join("vendor_sensor");
        let source = root.path.join("source-v2");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&transaction_root).unwrap();
        write_package(
            &installed,
            "vendor_sensor",
            "1.0.0",
            "vendor_sensor_read",
            None,
        );
        let old = certify_package(&installed);
        write_package(
            &source,
            "vendor_sensor",
            "2.0.0",
            "vendor_sensor_read_v2",
            Some(serde_json::json!({
                "schema_version": 1,
                "package_id": "vendor_sensor",
                "migrations": [{
                    "id": "v1-to-v2",
                    "from": ">=1.0.0 <2.0.0",
                    "to": "2.0.0",
                    "operations": [
                        { "op": "renameBlockType", "from": "vendor_sensor_read", "to": "vendor_sensor_read_v2" },
                        { "op": "renameField", "block_type": "vendor_sensor_read_v2", "from": "ADDRESS", "to": "I2C_ADDRESS" },
                        { "op": "mapEnum", "block_type": "vendor_sensor_read_v2", "field": "I2C_ADDRESS", "mappings": [{ "from": "72", "to": "0x48" }] }
                    ]
                }]
            })),
        );
        let before_workspace = workspace("vendor_sensor_read", "ADDRESS", "72");
        let after_workspace = workspace("vendor_sensor_read_v2", "I2C_ADDRESS", "0x48");
        let project_path = root.path.join("demo.maker");
        fs::write(
            &project_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "name": "demo",
                "board": "arduino:avr:uno",
                "board_package_id": "arduino:avr:uno",
                "xml": before_workspace,
                "code": "// old generated source",
                "options": "{}",
                "custom_future_field": { "preserve": true },
                "ck_block_packages": {
                    "schema_version": 1,
                    "packages": {
                        "vendor_sensor": {
                            "version": old.version,
                            "content_sha256": old.content_sha256,
                            "recorded_at": "2026-01-01T00:00:00Z"
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        Fixture {
            _root: root,
            transaction_root,
            ck_root,
            app_data,
            libraries_scope,
            source_manifest: source.join("library.json"),
            project_path,
            before_workspace,
            after_workspace,
            old,
        }
    }

    fn write_checkpoint(fixture: &Fixture, id: &str, workspace: &str) {
        let directory = fixture
            .app_data
            .join("project-checkpoints-v1")
            .join(project_storage_key(&fixture.project_path.to_string_lossy()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{}.checkpoint.json", id)),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "id": id,
                "projectPath": fixture.project_path,
                "projectName": "demo",
                "reason": "before_package_migration",
                "createdAt": "2026-07-14T00:00:00Z",
                "workspaceJson": workspace,
                "code": "// old generated source",
                "board": "arduino:avr:uno",
                "boardPackageId": "arduino:avr:uno",
                "options": "{}",
                "blockCount": 1
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn prepare(fixture: &Fixture) -> PreparedBlockLibraryMigration {
        prepare_in_roots(
            &fixture.transaction_root,
            &fixture.libraries_scope,
            "scope",
            &fixture.source_manifest,
            &fixture.project_path.to_string_lossy(),
        )
        .unwrap()
    }

    fn commit_input(
        prepared: &PreparedBlockLibraryMigration,
        fixture: &Fixture,
        checkpoint_id: &str,
    ) -> CommitPreparedBlockLibraryMigrationInput {
        CommitPreparedBlockLibraryMigrationInput {
            token: prepared.token.clone(),
            project: Some(CommitProjectPackageMigrationInput {
                workspace_before_json: fixture.before_workspace.clone(),
                workspace_after_json: fixture.after_workspace.clone(),
                workspace_before_sha256: sha256_bytes(fixture.before_workspace.as_bytes()),
                workspace_after_sha256: sha256_bytes(fixture.after_workspace.as_bytes()),
                checkpoint_id: checkpoint_id.to_string(),
                step_ids: vec!["v1-to-v2".to_string()],
            }),
        }
    }

    #[test]
    fn prepare_stages_upgrade_without_touching_package_or_project() {
        let fixture = fixture("prepare");
        let project_before = fs::read(&fixture.project_path).unwrap();
        let prepared = prepare(&fixture);

        assert_eq!(prepared.operation, "upgrade");
        assert!(prepared.requires_project_migration);
        assert_eq!(prepared.project_from_version.as_deref(), Some("1.0.0"));
        assert_eq!(prepared.to_version, "2.0.0");
        assert!(prepared.migration_manifest.is_some());
        assert_eq!(
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true)
                .unwrap()
                .version,
            "1.0.0"
        );
        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
    }

    #[test]
    fn commit_switches_package_and_project_and_records_complete_evidence() {
        let fixture = fixture("commit");
        let prepared = prepare(&fixture);
        write_checkpoint(
            &fixture,
            "checkpoint-before-migration",
            &fixture.before_workspace,
        );
        let result = commit_in_roots(
            &fixture.transaction_root,
            &fixture.ck_root,
            &fixture.app_data,
            commit_input(&prepared, &fixture, "checkpoint-before-migration"),
            None,
        )
        .unwrap();

        assert!(result.package_activated);
        assert!(result.project_migrated);
        let installed =
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true).unwrap();
        assert_eq!(installed.version, "2.0.0");
        let project: Value =
            serde_json::from_slice(&fs::read(&fixture.project_path).unwrap()).unwrap();
        assert_eq!(project["xml"], fixture.after_workspace);
        assert_eq!(project["code"], "// old generated source");
        assert_eq!(project["custom_future_field"]["preserve"], true);
        let record = &project["ck_block_packages"]["packages"]["vendor_sensor"];
        assert_eq!(record["version"], "2.0.0");
        assert_eq!(record["content_sha256"], installed.content_sha256);
        assert_eq!(record["generated_code_stale"], true);
        assert_eq!(record["migration"]["from_version"], "1.0.0");
        assert_eq!(record["migration"]["step_ids"][0], "v1-to-v2");
        assert_eq!(
            record["migration"]["checkpoint_id"],
            "checkpoint-before-migration"
        );
    }

    #[test]
    fn injected_post_activation_failure_restores_old_package_and_exact_project() {
        let fixture = fixture("rollback");
        let project_before = fs::read(&fixture.project_path).unwrap();
        let prepared = prepare(&fixture);
        write_checkpoint(&fixture, "checkpoint-rollback", &fixture.before_workspace);
        let error = commit_in_roots(
            &fixture.transaction_root,
            &fixture.ck_root,
            &fixture.app_data,
            commit_input(&prepared, &fixture, "checkpoint-rollback"),
            Some(CommitFailurePoint::AfterPackageActivation),
        )
        .unwrap_err();

        assert!(error.contains("rolled back"), "{}", error);
        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
        let installed =
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true).unwrap();
        assert_eq!(installed.version, fixture.old.version);
        assert_eq!(installed.content_sha256, fixture.old.content_sha256);
    }

    #[test]
    fn next_start_recovers_a_crash_between_activation_and_commit_marker() {
        let fixture = fixture("crash-recovery");
        let project_before = fs::read(&fixture.project_path).unwrap();
        let prepared = prepare(&fixture);
        let metadata = load_metadata(&fixture.transaction_root, &prepared.token).unwrap();
        write_state_marker(&fixture.transaction_root, &prepared.token, "committing").unwrap();

        let target = package_target(&fixture.ck_root, &metadata);
        let backup = package_backup(&fixture.ck_root, &metadata);
        let stage =
            transaction_dir(&fixture.transaction_root, &prepared.token).join(STAGED_PACKAGE_DIR);
        fs::rename(&target, &backup).unwrap();
        fs::rename(&stage, &target).unwrap();
        let project_backup = project_backup(&metadata);
        fs::rename(&fixture.project_path, &project_backup).unwrap();
        fs::write(&fixture.project_path, br#"{"half":"committed"}"#).unwrap();

        recover_transactions(&fixture.transaction_root, &fixture.ck_root).unwrap();

        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
        let installed =
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true).unwrap();
        assert_eq!(installed.version, fixture.old.version);
        assert_eq!(installed.content_sha256, fixture.old.content_sha256);
        assert!(!transaction_dir(&fixture.transaction_root, &prepared.token).exists());
    }

    #[test]
    fn changed_disk_project_blocks_commit_before_package_activation() {
        let fixture = fixture("cas");
        let prepared = prepare(&fixture);
        write_checkpoint(&fixture, "checkpoint-cas", &fixture.before_workspace);
        let mut project: Value =
            serde_json::from_slice(&fs::read(&fixture.project_path).unwrap()).unwrap();
        project["external_change"] = Value::Bool(true);
        fs::write(
            &fixture.project_path,
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let changed = fs::read(&fixture.project_path).unwrap();

        let error = commit_in_roots(
            &fixture.transaction_root,
            &fixture.ck_root,
            &fixture.app_data,
            commit_input(&prepared, &fixture, "checkpoint-cas"),
            None,
        )
        .unwrap_err();
        assert!(error.contains("changed on disk"), "{}", error);
        assert_eq!(fs::read(&fixture.project_path).unwrap(), changed);
        assert_eq!(
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true)
                .unwrap()
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn missing_or_wrong_checkpoint_blocks_every_write() {
        let fixture = fixture("checkpoint-proof");
        let project_before = fs::read(&fixture.project_path).unwrap();
        let prepared = prepare(&fixture);
        let error = commit_in_roots(
            &fixture.transaction_root,
            &fixture.ck_root,
            &fixture.app_data,
            commit_input(&prepared, &fixture, "missing-checkpoint"),
            None,
        )
        .unwrap_err();
        assert!(
            error.contains("checkpoint") || error.contains("Checkpoint"),
            "{}",
            error
        );
        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
        assert_eq!(
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true)
                .unwrap()
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn stage_tampering_is_detected_before_commit() {
        let fixture = fixture("stage-tamper");
        let project_before = fs::read(&fixture.project_path).unwrap();
        let prepared = prepare(&fixture);
        write_checkpoint(&fixture, "checkpoint-tamper", &fixture.before_workspace);
        fs::write(
            transaction_dir(&fixture.transaction_root, &prepared.token)
                .join(STAGED_PACKAGE_DIR)
                .join("blocks/blocks.json"),
            "tampered",
        )
        .unwrap();

        assert!(
            commit_in_roots(
                &fixture.transaction_root,
                &fixture.ck_root,
                &fixture.app_data,
                commit_input(&prepared, &fixture, "checkpoint-tamper"),
                None,
            )
            .is_err()
        );
        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
        assert_eq!(
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true)
                .unwrap()
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn legacy_folder_and_xml_projects_fail_closed_before_staging() {
        let root = TestRoot::new("legacy");
        let project = root.path.join("legacy-project");
        fs::create_dir_all(&project).unwrap();
        let error = canonical_project_file(&project.to_string_lossy()).unwrap_err();
        assert!(error.contains("legacy folder and XML projects remain unchanged"));
    }

    #[test]
    fn upgrade_without_project_package_evidence_fails_closed() {
        let fixture = fixture("missing-project-evidence");
        let mut project: Value =
            serde_json::from_slice(&fs::read(&fixture.project_path).unwrap()).unwrap();
        project.as_object_mut().unwrap().remove("ck_block_packages");
        fs::write(
            &fixture.project_path,
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let project_before = fs::read(&fixture.project_path).unwrap();

        let error = prepare_in_roots(
            &fixture.transaction_root,
            &fixture.libraries_scope,
            "scope",
            &fixture.source_manifest,
            &fixture.project_path.to_string_lossy(),
        )
        .unwrap_err();

        assert!(
            error.contains("BLOCK_PACKAGE_EVIDENCE_REQUIRED"),
            "{}",
            error
        );
        assert_eq!(fs::read(&fixture.project_path).unwrap(), project_before);
        assert_eq!(
            read_library_descriptor(&fixture.libraries_scope.join("vendor_sensor"), true)
                .unwrap()
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn unreadable_metadata_with_commit_marker_blocks_future_migrations() {
        let fixture = fixture("damaged-commit-metadata");
        let prepared = prepare(&fixture);
        write_state_marker(&fixture.transaction_root, &prepared.token, "committing").unwrap();
        fs::write(
            metadata_path(&fixture.transaction_root, &prepared.token),
            b"damaged",
        )
        .unwrap();

        let error = recover_transactions(&fixture.transaction_root, &fixture.ck_root).unwrap_err();
        assert!(error.contains("refusing further migrations"), "{}", error);
    }
}
