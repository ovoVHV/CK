use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Component, Path, PathBuf};

pub const QUALITY_REPORT_FILE: &str = ".ck-quality-report.json";

pub fn validate_zip_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
) -> Result<(), String> {
    if archive.len() > max_files {
        return Err(format!(
            "Package archive has too many entries: {} > {}",
            archive.len(),
            max_files
        ));
    }

    let mut total_bytes = 0u64;
    let mut paths = HashSet::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("Cannot inspect archive entry {}: {}", index, error))?;
        let name = file.name();
        if file.enclosed_name().is_none() || safe_relative_path(name).is_none() {
            return Err(format!("Package archive contains unsafe path: {}", name));
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "Package archive contains a symbolic link: {}",
                name
            ));
        }
        let normalized = name
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        if !paths.insert(normalized) {
            return Err(format!("Package archive contains duplicate path: {}", name));
        }
        if file.size() > max_file_bytes {
            return Err(format!(
                "Package archive entry is too large: {} ({} bytes)",
                name,
                file.size()
            ));
        }
        total_bytes = total_bytes.saturating_add(file.size());
        if total_bytes > max_total_bytes {
            return Err(format!(
                "Package archive exceeds the uncompressed size limit of {} bytes",
                max_total_bytes
            ));
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct QualityCheck {
    pub code: String,
    pub status: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PackageQualityReport {
    pub schema_version: u32,
    pub package_kind: String,
    pub package_id: Option<String>,
    pub status: String,
    pub source_content_sha256: Option<String>,
    pub error_count: usize,
    pub warning_count: usize,
    pub checks: Vec<QualityCheck>,
    #[serde(default)]
    pub validator_id: Option<String>,
    #[serde(default)]
    pub validator_version: Option<String>,
    #[serde(default)]
    pub ruleset_version: Option<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub contract_sha256: Option<String>,
    #[serde(default)]
    pub certification_level: Option<String>,
    #[serde(default)]
    pub validated_consumers: Vec<String>,
}

impl PackageQualityReport {
    pub fn new(package_kind: &str) -> Self {
        let consumer_ids: &[&str] = match package_kind {
            "board" => &["import-gate", "runtime-loader", "pin-preflight"],
            "block-library" => &[
                "import-gate",
                "runtime-loader",
                "block-catalog",
                "pin-preflight",
                "compile-resolver",
            ],
            "arduino-library" => &["import-gate", "compile-resolver"],
            _ => &["import-gate"],
        };
        Self {
            schema_version: 2,
            package_kind: package_kind.to_string(),
            package_id: None,
            status: "pending".to_string(),
            source_content_sha256: None,
            error_count: 0,
            warning_count: 0,
            checks: Vec::new(),
            validator_id: Some("ck.local-package-quality".to_string()),
            validator_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            ruleset_version: Some("ck-package-quality-v2".to_string()),
            generated_at: Some(
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ),
            contract_sha256: Some(ruleset_contract_sha256()),
            certification_level: Some("local-static".to_string()),
            validated_consumers: consumer_ids
                .iter()
                .map(|consumer| (*consumer).to_string())
                .collect(),
        }
    }

    pub fn pass(&mut self, code: &str, message: impl Into<String>) {
        self.push(code, "passed", message);
    }

    pub fn warn(&mut self, code: &str, message: impl Into<String>) {
        self.push(code, "warning", message);
    }

    pub fn error(&mut self, code: &str, message: impl Into<String>) {
        self.push(code, "error", message);
    }

    fn push(&mut self, code: &str, status: &str, message: impl Into<String>) {
        self.checks.push(QualityCheck {
            code: code.to_string(),
            status: status.to_string(),
            message: message.into(),
        });
    }

    pub fn finalize(&mut self) {
        self.error_count = self
            .checks
            .iter()
            .filter(|check| check.status == "error")
            .count();
        self.warning_count = self
            .checks
            .iter()
            .filter(|check| check.status == "warning")
            .count();
        self.status = if self.error_count > 0 {
            "failed"
        } else if self.warning_count > 0 {
            "passed_with_warnings"
        } else {
            "passed"
        }
        .to_string();
    }

    pub fn enforce(&self) -> Result<(), String> {
        if self.error_count == 0 && self.status != "failed" {
            return Ok(());
        }
        let details = self
            .checks
            .iter()
            .filter(|check| check.status == "error")
            .map(|check| format!("[{}] {}", check.code, check.message))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Package quality gate rejected the import ({} error{}):\n{}",
            self.error_count,
            if self.error_count == 1 { "" } else { "s" },
            details
        ))
    }
}

fn ruleset_contract_sha256() -> String {
    let contract = concat!(
        "ck-package-quality-v2\n",
        "archive-path-safety\n",
        "local-tree-safety\n",
        "manifest-structure\n",
        "cross-file-block-contract\n",
        "v2-machine-metadata\n",
        "license-and-dependency-declarations\n",
        "content-integrity-recheck\n",
        "exact-package-id-runtime-binding\n",
        "recommended-core-required\n",
        "explained-known-incompatibilities\n",
        "offline-package-assets\n",
        "native-arduino-library-kind\n"
    );
    format!("{:x}", Sha256::digest(contract.as_bytes()))
}

pub fn write_quality_report(root: &Path, report: &PackageQualityReport) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Failed to serialize quality report: {}", error))?;
    fs::write(root.join(QUALITY_REPORT_FILE), payload)
        .map_err(|error| format!("Failed to write quality report: {}", error))
}

pub fn read_quality_report(root: &Path) -> Option<PackageQualityReport> {
    let raw = fs::read_to_string(root.join(QUALITY_REPORT_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn read_quality_report_with_integrity(root: &Path) -> Option<PackageQualityReport> {
    let mut report = read_quality_report(root)?;
    match (
        report.source_content_sha256.as_deref(),
        hash_package_contents(root),
    ) {
        (Some(expected), Ok(actual)) if expected == actual => {}
        (Some(expected), Ok(actual)) => report.error(
            "installed-content-changed",
            format!(
                "Installed package contents changed after quality certification (expected {}, found {}). Re-import the package before trusting it.",
                expected, actual
            ),
        ),
        (None, Ok(_)) => report.error(
            "missing-certified-content-hash",
            "The saved quality report has no certified content hash. Re-import the package.",
        ),
        (_, Err(error)) => report.error(
            "installed-content-unverifiable",
            format!("Installed package contents could not be verified: {}", error),
        ),
    }
    report.finalize();
    Some(report)
}

/// Executable package content is trusted only when its intact quality report
/// was produced for the expected package contract and explicitly certifies
/// the runtime loader as a consumer. `enforce()` alone is insufficient because
/// legacy/pending reports can have zero recorded errors without being passed.
pub fn runtime_quality_report_is_trusted(
    report: Option<&PackageQualityReport>,
    expected_package_kind: &str,
) -> bool {
    report.is_some_and(|report| {
        report.package_kind == expected_package_kind
            && matches!(report.status.as_str(), "passed" | "passed_with_warnings")
            && report.enforce().is_ok()
            && report
                .validated_consumers
                .iter()
                .any(|consumer| consumer == "runtime-loader")
    })
}

/// Runtime trust additionally binds the signed/hashed report to the package
/// identity currently being loaded. This prevents a valid report copied from
/// another library directory from authorizing the wrong executable package.
pub fn runtime_quality_report_is_trusted_for_package(
    report: Option<&PackageQualityReport>,
    expected_package_kind: &str,
    expected_package_id: &str,
) -> bool {
    runtime_quality_report_is_trusted(report, expected_package_kind)
        && report.is_some_and(|report| report.package_id.as_deref() == Some(expected_package_id))
}

pub fn hash_package_contents(root: &Path) -> Result<String, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry =
            entry.map_err(|error| format!("Failed to inspect package contents: {}", error))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!(
                "Failed to inspect package path {}: {}",
                entry.path().display(),
                error
            )
        })?;
        if path_is_link_or_reparse_point(&metadata) {
            return Err(format!(
                "Package contains a symbolic link or junction: {}",
                entry.path().display()
            ));
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(root).map_err(|_| {
            format!(
                "Package path escapes the package root: {}",
                entry.path().display()
            )
        })?;
        let file_name = relative.file_name().and_then(|name| name.to_str());
        if file_name == Some(QUALITY_REPORT_FILE)
            || file_name == Some(".ck-user-installed.json")
            || file_name == Some("ck.lock")
            || file_name.is_some_and(|name| name.starts_with(".ck-lock-") && name.ends_with(".tmp"))
        {
            continue;
        }
        files.push((
            relative.to_string_lossy().replace('\\', "/"),
            entry.into_path(),
        ));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    for (relative, path) in files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        let mut file = fs::File::open(&path)
            .map_err(|error| format!("Failed to hash {}: {}", relative, error))?;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("Failed to hash {}: {}", relative, error))?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        digest.update([0xff]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub fn base_fqbn_scope(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parts = trimmed.split(':').collect::<Vec<_>>();
    if !(parts.len() == 3 || parts.len() == 4) {
        return Err(format!(
            "Invalid board scope '{}': expected package:architecture:board with optional FQBN menu options.",
            value
        ));
    }
    for (label, token) in ["package", "architecture", "board"]
        .into_iter()
        .zip(parts.iter().take(3))
    {
        if !valid_package_id(token, true) {
            return Err(format!(
                "Invalid board scope '{}': {} token is empty or contains unsafe characters.",
                value, label
            ));
        }
    }
    if parts.len() == 4 {
        let options = parts[3];
        if options.is_empty()
            || options.len() > 2_048
            || !options
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '=' | ','))
        {
            return Err(format!(
                "Invalid board scope '{}': malformed or unsafe FQBN menu options.",
                value
            ));
        }
    }
    Ok(parts[..3].join(":"))
}

pub fn resolve_contained_existing_subdir(root: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(value)
        .filter(|path| {
            path.components()
                .any(|component| component != Component::CurDir)
        })
        .ok_or_else(|| format!("Unsafe package subdirectory: {}", value))?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Cannot resolve package root {}: {}", root.display(), error))?;
    let candidate = canonical_root.join(relative);
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "Package subdirectory '{}' does not exist or cannot be resolved: {}",
            value, error
        )
    })?;
    if canonical_candidate == canonical_root || !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "Package subdirectory escapes the package root: {}",
            value
        ));
    }
    Ok(canonical_candidate)
}

pub fn validate_local_package_tree(
    root: &Path,
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!(
            "Package source is not a directory: {}",
            root.display()
        ));
    }
    let mut files = 0usize;
    let mut total_bytes = 0u64;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| format!("Cannot inspect local package: {}", error))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!(
                "Cannot inspect local package path {}: {}",
                entry.path().display(),
                error
            )
        })?;
        if path_is_link_or_reparse_point(&metadata) {
            return Err(format!(
                "Local package contains a symbolic link or junction: {}",
                entry.path().display()
            ));
        }
        if metadata.is_dir() {
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "Local package contains an unsupported filesystem entry: {}",
                entry.path().display()
            ));
        }
        files += 1;
        if files > max_files {
            return Err(format!(
                "Local package has too many files: {} > {}",
                files, max_files
            ));
        }
        if metadata.len() > max_file_bytes {
            return Err(format!(
                "Local package file is too large: {} ({} bytes)",
                entry.path().display(),
                metadata.len()
            ));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > max_total_bytes {
            return Err(format!(
                "Local package exceeds the total size limit of {} bytes",
                max_total_bytes
            ));
        }
    }
    Ok(())
}

fn path_is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

pub fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return None;
    }
    let path = Path::new(&normalized);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(path.to_path_buf())
}

pub fn valid_package_id(value: &str, allow_dot: bool) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut chars = value.chars();
    if !matches!(chars.next(), Some(ch) if ch.is_ascii_alphanumeric()) {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || (allow_dot && ch == '.'))
}

pub fn valid_semver(value: &str) -> bool {
    semver::Version::parse(value.trim()).is_ok()
}

pub fn validate_javascript_structure(source: &str) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Code,
        SingleQuote,
        DoubleQuote,
        Template,
        LineComment,
        BlockComment,
    }

    let mut state = State::Code;
    let mut escaped = false;
    let mut stack: Vec<(char, usize)> = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        match state {
            State::Code => match (ch, next) {
                ('/', Some('/')) => {
                    state = State::LineComment;
                    index += 1;
                }
                ('/', Some('*')) => {
                    state = State::BlockComment;
                    index += 1;
                }
                ('\'', _) => state = State::SingleQuote,
                ('"', _) => state = State::DoubleQuote,
                ('`', _) => state = State::Template,
                ('(' | '[' | '{', _) => stack.push((ch, index)),
                (')' | ']' | '}', _) => {
                    let expected = match ch {
                        ')' => '(',
                        ']' => '[',
                        '}' => '{',
                        _ => unreachable!(),
                    };
                    match stack.pop() {
                        Some((open, _)) if open == expected => {}
                        Some((open, offset)) => {
                            return Err(format!(
                                "Mismatched '{}' at offset {}; '{}' opened at offset {}.",
                                ch, index, open, offset
                            ));
                        }
                        None => {
                            return Err(format!("Unmatched closing '{}' at offset {}.", ch, index));
                        }
                    }
                }
                _ => {}
            },
            State::SingleQuote | State::DoubleQuote | State::Template => {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else {
                    let closes = matches!(
                        (state, ch),
                        (State::SingleQuote, '\'')
                            | (State::DoubleQuote, '"')
                            | (State::Template, '`')
                    );
                    if closes {
                        state = State::Code;
                    }
                }
            }
            State::LineComment => {
                if ch == '\n' {
                    state = State::Code;
                }
            }
            State::BlockComment => {
                if ch == '*' && next == Some('/') {
                    state = State::Code;
                    index += 1;
                }
            }
        }
        index += 1;
    }

    if let Some((open, offset)) = stack.pop() {
        return Err(format!("Unclosed '{}' opened at offset {}.", open, offset));
    }
    match state {
        State::Code | State::LineComment => Ok(()),
        State::BlockComment => Err("Unclosed block comment.".to_string()),
        State::SingleQuote => Err("Unclosed single-quoted string.".to_string()),
        State::DoubleQuote => Err("Unclosed double-quoted string.".to_string()),
        State::Template => Err("Unclosed template string.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn zip_with_entries(entries: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        let cursor = writer.finish().unwrap();
        zip::ZipArchive::new(cursor).unwrap()
    }

    #[test]
    fn package_ids_are_ascii_and_path_safe() {
        assert!(valid_package_id("vendor_sensor-1", false));
        assert!(valid_package_id("vendor.sensor", true));
        assert!(!valid_package_id("vendor.sensor", false));
        assert!(!valid_package_id("../sensor", true));
        assert!(!valid_package_id("传感器", true));
    }

    #[test]
    fn javascript_structure_detects_unbalanced_source() {
        assert!(validate_javascript_structure("fn({ value: '[ok]' });").is_ok());
        assert!(validate_javascript_structure("fn({ value: 1 );").is_err());
        assert!(validate_javascript_structure("/* missing end").is_err());
    }

    #[test]
    fn zip_gate_rejects_unsafe_duplicate_and_oversized_entries() {
        let mut unsafe_archive = zip_with_entries(&[("../escape.txt", b"x")]);
        assert!(validate_zip_archive(&mut unsafe_archive, 10, 10, 10).is_err());

        let mut duplicate_archive =
            zip_with_entries(&[("Blocks/item.js", b"a"), ("blocks/ITEM.js", b"b")]);
        assert!(validate_zip_archive(&mut duplicate_archive, 10, 10, 20).is_err());

        let mut oversized_archive = zip_with_entries(&[("asset.bin", b"four")]);
        assert!(validate_zip_archive(&mut oversized_archive, 10, 3, 10).is_err());
    }

    #[test]
    fn generated_board_lock_does_not_change_package_content_hash() {
        let root =
            std::env::temp_dir().join(format!("ck_quality_lock_hash_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("board.json"), "{}").unwrap();
        let before = hash_package_contents(&root).unwrap();
        fs::write(root.join("ck.lock"), "generated evidence").unwrap();
        let after = hash_package_contents(&root).unwrap();
        assert_eq!(before, after);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn board_scope_requires_three_safe_fqbn_tokens_and_drops_valid_options() {
        assert_eq!(
            base_fqbn_scope("esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_16MB")
                .unwrap(),
            "esp32:esp32:esp32s3"
        );
        for invalid in [
            "esp32",
            "esp32:esp32",
            "esp32:esp32:../outside",
            ".esp32:esp32:esp32c6",
            "esp32::esp32c6",
            "esp32:esp32:esp32c6:FlashSize=16M:extra",
            "esp32:esp32:esp32c6:../../outside",
        ] {
            assert!(base_fqbn_scope(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn contained_subdir_rejects_parent_traversal_and_resolves_real_child() {
        let root = std::env::temp_dir().join(format!("ck_subdir_gate_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("packages/example")).unwrap();
        assert_eq!(
            resolve_contained_existing_subdir(&root, "packages/example").unwrap(),
            fs::canonicalize(root.join("packages/example")).unwrap()
        );
        assert!(resolve_contained_existing_subdir(&root, "../outside").is_err());
        assert!(resolve_contained_existing_subdir(&root, ".").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_tree_gate_enforces_file_and_size_limits() {
        let root =
            std::env::temp_dir().join(format!("ck_local_tree_gate_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one.txt"), b"1234").unwrap();
        fs::write(root.join("two.txt"), b"56").unwrap();
        assert!(validate_local_package_tree(&root, 2, 4, 6).is_ok());
        assert!(validate_local_package_tree(&root, 1, 4, 6).is_err());
        assert!(validate_local_package_tree(&root, 2, 3, 6).is_err());
        assert!(validate_local_package_tree(&root, 2, 4, 5).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn local_tree_gate_rejects_windows_junctions() {
        let root = std::env::temp_dir().join(format!("ck_junction_gate_{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("ck_junction_outside_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        junction::create(&outside, root.join("linked")).unwrap();
        let error = validate_local_package_tree(&root, 10, 1024, 4096).unwrap_err();
        assert!(error.contains("junction"), "{error}");
        let _ = junction::delete(root.join("linked"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn reading_quality_report_marks_installed_content_changes_failed() {
        let root = std::env::temp_dir().join(format!("ck_quality_tamper_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("library.json"), "{}").unwrap();
        let mut report = PackageQualityReport::new("library");
        report.source_content_sha256 = Some(hash_package_contents(&root).unwrap());
        report.pass("fixture", "fixture passed");
        report.finalize();
        write_quality_report(&root, &report).unwrap();

        let unchanged = read_quality_report_with_integrity(&root).unwrap();
        assert_eq!(unchanged.status, "passed");
        fs::write(root.join("library.json"), "{\"changed\":true}").unwrap();
        let changed = read_quality_report_with_integrity(&root).unwrap();
        assert_eq!(changed.status, "failed");
        assert!(
            changed
                .checks
                .iter()
                .any(|check| check.code == "installed-content-changed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn new_quality_reports_carry_machine_readable_local_provenance() {
        let report = PackageQualityReport::new("block-library");
        assert_eq!(report.schema_version, 2);
        assert_eq!(
            report.validator_id.as_deref(),
            Some("ck.local-package-quality")
        );
        assert_eq!(
            report.ruleset_version.as_deref(),
            Some("ck-package-quality-v2")
        );
        assert_eq!(report.certification_level.as_deref(), Some("local-static"));
        assert!(
            report
                .generated_at
                .as_deref()
                .is_some_and(|value| value.ends_with('Z'))
        );
        assert!(report.contract_sha256.as_deref().is_some_and(
            |value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
        ));
        assert!(
            report
                .validated_consumers
                .contains(&"import-gate".to_string())
        );
        assert!(
            report
                .validated_consumers
                .contains(&"runtime-loader".to_string())
        );
        assert!(
            report
                .validated_consumers
                .contains(&"block-catalog".to_string())
        );
        assert!(
            report
                .validated_consumers
                .contains(&"pin-preflight".to_string())
        );
        assert!(
            report
                .validated_consumers
                .contains(&"compile-resolver".to_string())
        );

        let board = PackageQualityReport::new("board");
        assert!(
            board
                .validated_consumers
                .contains(&"runtime-loader".to_string())
        );
        assert!(
            board
                .validated_consumers
                .contains(&"pin-preflight".to_string())
        );
        assert!(
            !board
                .validated_consumers
                .contains(&"block-catalog".to_string())
        );
        assert!(
            !board
                .validated_consumers
                .contains(&"compile-resolver".to_string())
        );

        let native = PackageQualityReport::new("arduino-library");
        assert_eq!(
            native.validated_consumers,
            vec!["import-gate".to_string(), "compile-resolver".to_string()]
        );
    }

    #[test]
    fn runtime_trust_requires_passed_status_consumer_and_expected_kind() {
        let mut report = PackageQualityReport::new("block-library");
        report.pass("fixture", "fixture passed");
        report.finalize();
        assert!(runtime_quality_report_is_trusted(
            Some(&report),
            "block-library"
        ));
        assert!(!runtime_quality_report_is_trusted(Some(&report), "board"));

        report.validated_consumers.clear();
        assert!(!runtime_quality_report_is_trusted(
            Some(&report),
            "block-library"
        ));
        report
            .validated_consumers
            .push("runtime-loader".to_string());
        report.status = "pending".to_string();
        assert!(!runtime_quality_report_is_trusted(
            Some(&report),
            "block-library"
        ));
        assert!(!runtime_quality_report_is_trusted(None, "block-library"));
    }

    #[test]
    fn runtime_trust_is_bound_to_the_exact_package_id() {
        let mut report = PackageQualityReport::new("block-library");
        report.package_id = Some("acme-sensor".to_string());
        report.pass("fixture", "fixture passed");
        report.finalize();

        assert!(runtime_quality_report_is_trusted_for_package(
            Some(&report),
            "block-library",
            "acme-sensor"
        ));
        assert!(!runtime_quality_report_is_trusted_for_package(
            Some(&report),
            "block-library",
            "other-sensor"
        ));
    }
}
