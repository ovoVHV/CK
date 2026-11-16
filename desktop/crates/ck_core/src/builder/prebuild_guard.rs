use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const PREBUILD_RESTORE_ARG: &str = "--ck-prebuild-restore";
pub const PREBUILD_RESTORE_MANIFEST_FILE_NAME: &str = ".ck-prebuild-restore-v1.json";
pub const PREBUILD_RESTORE_SCHEMA_VERSION: u32 = 1;
pub const PREBUILD_RESTORE_MANIFEST_MAX_BYTES: u64 = 256 * 1024;
pub const PREBUILD_RESTORE_ENTRY_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const PREBUILD_RESTORE_TOTAL_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
pub const PREBUILD_RESTORE_MAX_ENTRIES: usize = 128;
pub const PREBUILD_RESTORE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const RESTORE_EVENT_MAX: usize = 16;
const RESTORE_EVENT_BYTES: usize = 256;

static PREBUILD_RESTORE_HELPER: OnceLock<PathBuf> = OnceLock::new();
static PREBUILD_RESTORE_HELPER_DISABLED: AtomicBool = AtomicBool::new(false);
static MANIFEST_TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrebuildRestoreEntry {
    pub relative_path: String,
    pub length: u64,
    pub sha256: String,
    pub modified_secs: u64,
    pub modified_nanos: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrebuildRestoreManifest {
    pub schema_version: u32,
    pub canonical_build_path: String,
    pub fqbn: String,
    pub build_signature: String,
    pub created_unix_ms: u64,
    pub expires_unix_ms: u64,
    pub entries: Vec<PrebuildRestoreEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrebuildRestoreSummary {
    pub restored: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub events: Vec<String>,
}

impl PrebuildRestoreSummary {
    fn record(&mut self, message: impl AsRef<str>) {
        if self.events.len() >= RESTORE_EVENT_MAX {
            return;
        }
        let raw = message.as_ref();
        let mut end = raw.len().min(RESTORE_EVENT_BYTES);
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        self.events.push(raw[..end].to_string());
    }

    pub fn bounded_log(&self) -> String {
        let mut out = format!(
            "CK prebuild restore: restored={}, unchanged={}, skipped={}",
            self.restored, self.unchanged, self.skipped
        );
        for event in &self.events {
            out.push_str("\n- ");
            out.push_str(event);
        }
        out
    }
}

#[derive(Debug, Deserialize)]
struct CcdbResponseEntry {
    #[serde(default)]
    directory: String,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    command: String,
}

pub fn register_prebuild_restore_helper(path: &Path) -> Result<PathBuf> {
    if !is_regular_file_without_reparse(path) {
        anyhow::bail!(
            "prebuild restore helper is not a regular non-reparse file: {}",
            path.display()
        );
    }
    let canonical = fs::canonicalize(path)
        .with_context(|| format!("canonicalize prebuild restore helper {}", path.display()))?;
    if let Some(existing) = PREBUILD_RESTORE_HELPER.get() {
        if existing == &canonical {
            return Ok(existing.clone());
        }
        anyhow::bail!(
            "prebuild restore helper is already registered as {}",
            existing.display()
        );
    }
    PREBUILD_RESTORE_HELPER
        .set(canonical.clone())
        .map_err(|_| anyhow::anyhow!("prebuild restore helper registration raced"))?;
    Ok(canonical)
}

pub fn registered_prebuild_restore_helper() -> Option<PathBuf> {
    if PREBUILD_RESTORE_HELPER_DISABLED.load(Ordering::Acquire) {
        return None;
    }
    PREBUILD_RESTORE_HELPER
        .get()
        .filter(|path| is_regular_file_without_reparse(path))
        .cloned()
}

/// Disable the optional helper capability for the remainder of this process.
/// A failed helper spawn must never block native Core compatibility; restarting
/// CK performs a fresh explicit capability registration.
pub fn disable_registered_prebuild_restore_helper() {
    PREBUILD_RESTORE_HELPER_DISABLED.store(true, Ordering::Release);
}

pub fn prebuild_restore_manifest_path(
    metadata_dir: &Path,
    fqbn_safe: &str,
    profile_suffix: &str,
) -> PathBuf {
    metadata_dir.join(format!(
        "prebuild_restore_{}_{}.json",
        fqbn_safe, profile_suffix
    ))
}

pub fn refresh_prebuild_restore_manifest(
    manifest_path: &Path,
    build_path: &Path,
    fqbn: &str,
    build_signature: &str,
) -> Result<usize> {
    let canonical_build = fs::canonicalize(build_path)
        .with_context(|| format!("canonicalize prebuild guard root {}", build_path.display()))?;
    let canonical_build_string = canonical_build
        .to_str()
        .context("prebuild guard root is not valid Unicode")?
        .to_string();
    let entries = collect_response_file_snapshots(&canonical_build)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let created_unix_ms = u64::try_from(now.as_millis()).unwrap_or(u64::MAX);
    let expires_unix_ms = created_unix_ms
        .saturating_add(u64::try_from(PREBUILD_RESTORE_TTL.as_millis()).unwrap_or(u64::MAX));
    let manifest = PrebuildRestoreManifest {
        schema_version: PREBUILD_RESTORE_SCHEMA_VERSION,
        canonical_build_path: canonical_build_string,
        fqbn: bounded_identity(fqbn, "FQBN")?,
        build_signature: bounded_identity(build_signature, "build signature")?,
        created_unix_ms,
        expires_unix_ms,
        entries,
    };
    let entry_count = manifest.entries.len();
    write_manifest_atomic(manifest_path, &manifest)?;
    Ok(entry_count)
}

pub fn invalidate_prebuild_restore_manifest(path: &Path) {
    let _ = fs::remove_file(path);
}

pub fn restore_prebuild_manifest_best_effort(manifest_path: &Path) -> PrebuildRestoreSummary {
    let mut summary = PrebuildRestoreSummary::default();
    let raw = match bounded_regular_file_read(manifest_path, PREBUILD_RESTORE_MANIFEST_MAX_BYTES) {
        Ok(raw) => raw,
        Err(error) => {
            summary.record(format!("manifest unavailable: {error}"));
            return summary;
        }
    };
    let manifest: PrebuildRestoreManifest = match serde_json::from_slice(&raw) {
        Ok(manifest) => manifest,
        Err(error) => {
            summary.record(format!("manifest JSON rejected: {error}"));
            return summary;
        }
    };
    let canonical_build = match validate_manifest(&manifest) {
        Ok(path) => path,
        Err(error) => {
            summary.record(format!("manifest rejected: {error}"));
            return summary;
        }
    };

    for entry in &manifest.entries {
        match restore_one_entry(&canonical_build, entry) {
            Ok(true) => summary.restored += 1,
            Ok(false) => summary.unchanged += 1,
            Err(error) => {
                summary.skipped += 1;
                summary.record(format!("{}: {error}", entry.relative_path));
            }
        }
    }
    summary
}

fn bounded_identity(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 || value.contains(['\0', '\r', '\n']) {
        anyhow::bail!("invalid {label}");
    }
    Ok(value.to_string())
}

fn collect_response_file_snapshots(canonical_build: &Path) -> Result<Vec<PrebuildRestoreEntry>> {
    let ccdb_path = canonical_build.join("compile_commands.json");
    if !ccdb_path.exists() {
        return Ok(Vec::new());
    }
    let raw = bounded_regular_file_read(&ccdb_path, 16 * 1024 * 1024)
        .with_context(|| format!("read response-file CCDB {}", ccdb_path.display()))?;
    let ccdb: Vec<CcdbResponseEntry> = serde_json::from_slice(&raw)
        .with_context(|| format!("parse response-file CCDB {}", ccdb_path.display()))?;
    if ccdb.len() > 8192 {
        anyhow::bail!("response-file CCDB exceeds entry limit");
    }

    let mut candidates = BTreeMap::<String, PathBuf>::new();
    for entry in ccdb {
        let tokens = if !entry.arguments.is_empty() {
            entry.arguments
        } else {
            split_command_line_bounded(&entry.command).unwrap_or_default()
        };
        for token in tokens {
            let Some(raw_path) = token.strip_prefix('@') else {
                continue;
            };
            let raw_path = raw_path.trim().trim_matches('"').trim_matches('\'');
            if raw_path.is_empty() {
                continue;
            }
            let path = PathBuf::from(raw_path);
            let resolved = if path.is_absolute() || entry.directory.trim().is_empty() {
                path
            } else {
                Path::new(&entry.directory).join(path)
            };
            let Ok(canonical) = fs::canonicalize(&resolved) else {
                continue;
            };
            if !canonical.starts_with(canonical_build)
                || !is_regular_file_without_reparse(&canonical)
            {
                continue;
            }
            let Ok(relative) = canonical.strip_prefix(canonical_build) else {
                continue;
            };
            if !safe_relative_path(relative) {
                continue;
            }
            if relative.to_str().is_none() {
                continue;
            }
            let relative_key = normalize_relative_key(relative);
            candidates.insert(relative_key, canonical);
            if candidates.len() > PREBUILD_RESTORE_MAX_ENTRIES {
                anyhow::bail!("response-file snapshot exceeds entry limit");
            }
        }
    }

    let mut total_bytes = 0u64;
    let mut snapshots = Vec::with_capacity(candidates.len());
    for (_, path) in candidates {
        let metadata = fs::metadata(&path)?;
        if metadata.len() > PREBUILD_RESTORE_ENTRY_MAX_BYTES {
            continue;
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > PREBUILD_RESTORE_TOTAL_ENTRY_BYTES {
            anyhow::bail!("response-file snapshot exceeds total byte limit");
        }
        let modified = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                anyhow::anyhow!(
                    "response-file timestamp predates Unix epoch: {}",
                    path.display()
                )
            })?;
        let relative = path
            .strip_prefix(canonical_build)
            .context("response file escaped canonical build root")?;
        snapshots.push(PrebuildRestoreEntry {
            relative_path: relative.to_string_lossy().replace('\\', "/"),
            length: metadata.len(),
            sha256: sha256_regular_file(&path, PREBUILD_RESTORE_ENTRY_MAX_BYTES)?,
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        });
    }
    snapshots.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(snapshots)
}

fn validate_manifest(manifest: &PrebuildRestoreManifest) -> Result<PathBuf> {
    if manifest.schema_version != PREBUILD_RESTORE_SCHEMA_VERSION {
        anyhow::bail!("unsupported schema version");
    }
    bounded_identity(&manifest.fqbn, "FQBN")?;
    bounded_identity(&manifest.build_signature, "build signature")?;
    if manifest.entries.len() > PREBUILD_RESTORE_MAX_ENTRIES {
        anyhow::bail!("entry limit exceeded");
    }
    let now_ms = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    if manifest.expires_unix_ms < now_ms
        || manifest.created_unix_ms > manifest.expires_unix_ms
        || manifest
            .expires_unix_ms
            .saturating_sub(manifest.created_unix_ms)
            > u64::try_from(PREBUILD_RESTORE_TTL.as_millis()).unwrap_or(u64::MAX)
    {
        anyhow::bail!("manifest expired or has an invalid lifetime");
    }
    let build = PathBuf::from(&manifest.canonical_build_path);
    if !build.is_absolute() {
        anyhow::bail!("build root is not absolute");
    }
    let canonical = fs::canonicalize(&build)
        .with_context(|| format!("canonicalize manifest build root {}", build.display()))?;
    if canonical != build || !canonical.is_dir() {
        anyhow::bail!("manifest build root is no longer canonical");
    }
    let total = manifest
        .entries
        .iter()
        .try_fold(0u64, |total, entry| total.checked_add(entry.length))
        .context("entry byte total overflow")?;
    if total > PREBUILD_RESTORE_TOTAL_ENTRY_BYTES {
        anyhow::bail!("entry byte total exceeds limit");
    }
    Ok(canonical)
}

fn restore_one_entry(build_root: &Path, entry: &PrebuildRestoreEntry) -> Result<bool> {
    if entry.length > PREBUILD_RESTORE_ENTRY_MAX_BYTES
        || entry.modified_nanos >= 1_000_000_000
        || !valid_sha256(&entry.sha256)
    {
        anyhow::bail!("invalid entry metadata");
    }
    let relative = PathBuf::from(&entry.relative_path);
    if !safe_relative_path(&relative) {
        anyhow::bail!("unsafe relative path");
    }
    let path = build_root.join(&relative);
    if !is_regular_file_without_reparse(&path) {
        anyhow::bail!("target is missing or not a regular file");
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(build_root) {
        anyhow::bail!("target escapes build root");
    }
    let metadata = fs::metadata(&canonical)?;
    if metadata.len() != entry.length {
        anyhow::bail!("content length changed");
    }
    let current_hash = sha256_regular_file(&canonical, PREBUILD_RESTORE_ENTRY_MAX_BYTES)?;
    if current_hash != entry.sha256 {
        anyhow::bail!("content hash changed");
    }
    let expected = UNIX_EPOCH
        .checked_add(Duration::new(entry.modified_secs, entry.modified_nanos))
        .context("entry timestamp overflow")?;
    if metadata.modified().ok() == Some(expected) {
        return Ok(false);
    }
    let file = OpenOptions::new().write(true).open(&canonical)?;
    file.set_times(fs::FileTimes::new().set_modified(expected))?;
    Ok(true)
}

fn write_manifest_atomic(path: &Path, manifest: &PrebuildRestoreManifest) -> Result<()> {
    let parent = path.parent().context("manifest path has no parent")?;
    fs::create_dir_all(parent)?;
    let payload = serde_json::to_vec(manifest)?;
    if u64::try_from(payload.len()).unwrap_or(u64::MAX) > PREBUILD_RESTORE_MANIFEST_MAX_BYTES {
        anyhow::bail!("prebuild restore manifest exceeds byte limit");
    }
    let temporary = parent.join(format!(
        ".prebuild-restore-{}-{}-{}.tmp",
        std::process::id(),
        manifest.created_unix_ms,
        MANIFEST_TEMP_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        atomic_replace_file(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn bounded_regular_file_read(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    if !is_regular_file_without_reparse(path) {
        anyhow::bail!("not a regular non-reparse file: {}", path.display());
    }
    let metadata = fs::metadata(path)?;
    if metadata.len() > max_bytes {
        anyhow::bail!("file exceeds {} byte limit", max_bytes);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    File::open(path)?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        anyhow::bail!("file grew beyond byte limit while reading");
    }
    Ok(bytes)
}

fn sha256_regular_file(path: &Path, max_bytes: u64) -> Result<String> {
    let bytes = bounded_regular_file_read(path, max_bytes)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn normalize_relative_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        value
    }
}

fn split_command_line_bounded(command: &str) -> Option<Vec<String>> {
    if command.len() > 256 * 1024 || command.contains(['\0', '\r', '\n']) {
        return None;
    }
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in command.chars() {
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                current.push(character);
            }
        } else if matches!(character, '"' | '\'') {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}

fn is_regular_file_without_reparse(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
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
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

pub fn quote_command_argument(value: &OsStr) -> Option<String> {
    let value = value.to_str()?;
    if value.contains(['\0', '\r', '\n']) {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let mut output = String::from("\"");
        let mut slashes = 0usize;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
            } else if character == '"' {
                output.push_str(&"\\".repeat(slashes.saturating_mul(2).saturating_add(1)));
                output.push('"');
                slashes = 0;
            } else {
                output.push_str(&"\\".repeat(slashes));
                slashes = 0;
                output.push(character);
            }
        }
        output.push_str(&"\\".repeat(slashes.saturating_mul(2)));
        output.push('"');
        Some(output)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(format!("'{}'", value.replace('\'', "'\\''")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_for(root: &Path, entry: PrebuildRestoreEntry) -> PrebuildRestoreManifest {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let now_ms = u64::try_from(now.as_millis()).unwrap_or(u64::MAX);
        PrebuildRestoreManifest {
            schema_version: PREBUILD_RESTORE_SCHEMA_VERSION,
            canonical_build_path: fs::canonicalize(root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            fqbn: "vendor:arch:board".into(),
            build_signature: "a".repeat(64),
            created_unix_ms: now_ms,
            expires_unix_ms: now_ms + 60_000,
            entries: vec![entry],
        }
    }

    fn snapshot_entry(root: &Path, file: &Path) -> PrebuildRestoreEntry {
        let metadata = fs::metadata(file).unwrap();
        let modified = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap();
        PrebuildRestoreEntry {
            relative_path: file
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
            length: metadata.len(),
            sha256: sha256_regular_file(file, PREBUILD_RESTORE_ENTRY_MAX_BYTES).unwrap(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        }
    }

    #[test]
    fn identical_response_file_touch_restores_mtime_without_changing_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("build");
        fs::create_dir_all(root.join("sketch")).unwrap();
        let response = root.join("sketch/build.opt");
        fs::write(&response, b"-DVALUE=1\n").unwrap();
        let entry = snapshot_entry(&root, &response);
        std::thread::sleep(Duration::from_millis(25));
        fs::write(&response, b"-DVALUE=1\n").unwrap();
        let manifest = manifest_for(&root, entry.clone());
        let manifest_path = temp.path().join("guard.json");
        write_manifest_atomic(&manifest_path, &manifest).unwrap();

        let summary = restore_prebuild_manifest_best_effort(&manifest_path);
        assert_eq!(summary.restored, 1);
        assert_eq!(fs::read(&response).unwrap(), b"-DVALUE=1\n");
        let restored = fs::metadata(&response)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap();
        assert_eq!(restored.as_secs(), entry.modified_secs);
        assert_eq!(restored.subsec_nanos(), entry.modified_nanos);
    }

    #[test]
    fn same_length_content_change_is_never_restored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("build");
        fs::create_dir_all(&root).unwrap();
        let response = root.join("build.opt");
        fs::write(&response, b"AAAA").unwrap();
        let entry = snapshot_entry(&root, &response);
        fs::write(&response, b"BBBB").unwrap();
        let changed_mtime = fs::metadata(&response).unwrap().modified().unwrap();
        let manifest_path = temp.path().join("guard.json");
        write_manifest_atomic(&manifest_path, &manifest_for(&root, entry)).unwrap();

        let summary = restore_prebuild_manifest_best_effort(&manifest_path);
        assert_eq!(summary.restored, 0);
        assert_eq!(summary.skipped, 1);
        assert_eq!(fs::read(&response).unwrap(), b"BBBB");
        assert_eq!(
            fs::metadata(&response).unwrap().modified().unwrap(),
            changed_mtime
        );
    }

    #[test]
    fn unsafe_expired_and_bad_hash_entries_are_bounded_noops() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("build");
        fs::create_dir_all(&root).unwrap();
        let response = root.join("build.opt");
        fs::write(&response, b"flags").unwrap();
        let mut entry = snapshot_entry(&root, &response);
        entry.sha256 = "g".repeat(64);
        let mut manifest = manifest_for(&root, entry);
        manifest.entries.push(PrebuildRestoreEntry {
            relative_path: "../escape.opt".into(),
            length: 1,
            sha256: "a".repeat(64),
            modified_secs: 1,
            modified_nanos: 0,
        });
        let manifest_path = temp.path().join("guard.json");
        write_manifest_atomic(&manifest_path, &manifest).unwrap();
        let summary = restore_prebuild_manifest_best_effort(&manifest_path);
        assert_eq!(summary.restored, 0);
        assert_eq!(summary.skipped, 2);
        assert!(summary.bounded_log().len() < 8192);

        manifest.expires_unix_ms = 1;
        write_manifest_atomic(&manifest_path, &manifest).unwrap();
        let expired = restore_prebuild_manifest_best_effort(&manifest_path);
        assert_eq!(expired.restored, 0);
        assert!(expired.events.iter().any(|event| event.contains("expired")));
    }

    #[test]
    fn ccdb_snapshot_collects_only_regular_response_files_inside_build_root() {
        let temp = tempfile::tempdir().unwrap();
        let build = temp.path().join("build root");
        fs::create_dir_all(build.join("sketch")).unwrap();
        let inside = build.join("sketch/build.opt");
        let outside = temp.path().join("outside.opt");
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let ccdb = serde_json::json!([{
            "directory": temp.path(),
            "arguments": [
                "gcc",
                format!("@{}", inside.display()),
                format!("@{}", outside.display()),
                "source.c",
                "-o",
                "source.o"
            ],
            "file": "source.c"
        }]);
        fs::write(
            build.join("compile_commands.json"),
            serde_json::to_vec(&ccdb).unwrap(),
        )
        .unwrap();
        let canonical = fs::canonicalize(&build).unwrap();
        let snapshots = collect_response_file_snapshots(&canonical).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].relative_path, "sketch/build.opt");
    }

    #[test]
    fn command_quoting_keeps_space_paths_as_one_argument() {
        let quoted = quote_command_argument(OsStr::new("C:\\Program Files\\CK\\appsdesktop.exe"))
            .expect("quoted argument");
        assert!(quoted.contains("Program Files"));
        assert!(quoted.starts_with(['\'', '"']));
        assert!(quoted.ends_with(['\'', '"']));
    }
}
