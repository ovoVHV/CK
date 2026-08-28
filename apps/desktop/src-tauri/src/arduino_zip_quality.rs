use crate::package_quality::{
    PackageQualityReport, hash_package_contents, read_quality_report_with_integrity,
    validate_local_package_tree, validate_zip_archive, write_quality_report,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const USER_INSTALL_MARKER: &str = ".ck-user-installed.json";
const MAX_LIBRARY_ARCHIVE_FILES: usize = 5_000;
const MAX_LIBRARY_ARCHIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LIBRARY_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct ArduinoZipGateEvidence {
    pub source_content_sha256: String,
    pub source_archive_sha256: String,
    pub library_name: Option<String>,
    pub library_version: Option<String>,
    pub warning_count: usize,
}

#[derive(Debug, Default, Clone)]
struct ArduinoProperties {
    values: BTreeMap<String, String>,
}

impl ArduinoProperties {
    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
}

pub(crate) fn inspect_arduino_library_zip(
    zip_path: &Path,
) -> Result<ArduinoZipGateEvidence, String> {
    let source_archive_sha256 = hash_file(zip_path)?;
    let file = fs::File::open(zip_path)
        .map_err(|error| format!("Failed to open Arduino library ZIP: {}", error))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Invalid Arduino library ZIP: {}", error))?;
    validate_zip_archive(
        &mut archive,
        MAX_LIBRARY_ARCHIVE_FILES,
        MAX_LIBRARY_ARCHIVE_FILE_BYTES,
        MAX_LIBRARY_ARCHIVE_BYTES,
    )?;

    let extraction_dir = std::env::temp_dir()
        .join("CK_ArduinoZipGate")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&extraction_dir).map_err(|error| {
        format!(
            "Failed to create Arduino ZIP inspection directory: {}",
            error
        )
    })?;

    let inspected = (|| -> Result<ArduinoZipGateEvidence, String> {
        archive
            .extract(&extraction_dir)
            .map_err(|error| format!("Failed to safely extract Arduino library ZIP: {}", error))?;
        validate_local_package_tree(
            &extraction_dir,
            MAX_LIBRARY_ARCHIVE_FILES,
            MAX_LIBRARY_ARCHIVE_FILE_BYTES,
            MAX_LIBRARY_ARCHIVE_BYTES,
        )?;

        let library_root = discover_arduino_library_root(&extraction_dir)?;
        let properties = read_arduino_properties(&library_root)?;
        let mut report = inspect_arduino_library_root(&library_root);
        report.pass(
            "archive-safety",
            "ZIP paths, links, duplicates, entry counts and uncompressed sizes passed CK safety checks.",
        );
        report.pass(
            "source-archive-sha256",
            format!("Source archive SHA-256: {}", source_archive_sha256),
        );
        report.finalize();
        report.enforce()?;

        let source_content_sha256 = report
            .source_content_sha256
            .clone()
            .ok_or("Arduino library quality report has no content hash")?;
        Ok(ArduinoZipGateEvidence {
            source_content_sha256,
            source_archive_sha256: source_archive_sha256.clone(),
            library_name: properties
                .as_ref()
                .and_then(|properties| properties.get("name"))
                .map(str::to_string),
            library_version: properties
                .as_ref()
                .and_then(|properties| properties.get("version"))
                .map(str::to_string),
            warning_count: report.warning_count,
        })
    })();

    let _ = fs::remove_dir_all(&extraction_dir);
    inspected
}

pub(crate) fn inspect_arduino_library_root(root: &Path) -> PackageQualityReport {
    let mut report = PackageQualityReport::new("arduino-library");
    report.package_id = root
        .file_name()
        .and_then(|name| name.to_str())
        .map(package_id_from_folder)
        .filter(|id| !id.is_empty());

    match validate_local_package_tree(
        root,
        MAX_LIBRARY_ARCHIVE_FILES,
        MAX_LIBRARY_ARCHIVE_FILE_BYTES,
        MAX_LIBRARY_ARCHIVE_BYTES,
    ) {
        Ok(()) => report.pass(
            "local-tree-safety",
            "The library tree contains only bounded regular files and directories.",
        ),
        Err(error) => report.error("unsafe-local-library-tree", error),
    }

    let modern_sources = count_supported_sources(&root.join("src"), true);
    let legacy_root_sources = count_supported_sources(root, false);
    let legacy_utility_sources = count_supported_sources(&root.join("utility"), true);
    let legacy_sources = legacy_root_sources.saturating_add(legacy_utility_sources);
    if modern_sources > 0 {
        report.pass(
            "recursive-src-layout",
            format!(
                "Found {} Arduino C/C++/assembly or header file(s) under recursive src/**.",
                modern_sources
            ),
        );
    }
    if legacy_sources > 0 {
        report.pass(
            "legacy-root-utility-layout",
            format!(
                "Found {} legacy Arduino source/header file(s) at the library root or utility/**.",
                legacy_sources
            ),
        );
    }
    if modern_sources == 0 && legacy_sources == 0 {
        report.error(
            "missing-arduino-sources",
            "No Arduino sources or headers were found in recursive src/** or the legacy root + utility/** layout.",
        );
    } else if modern_sources > 0 && legacy_sources > 0 {
        report.warn(
            "mixed-arduino-layout",
            "The library mixes recursive src/** with legacy root/utility sources. CK keeps both, but maintainers should verify the intended Arduino build layout.",
        );
    }

    match read_arduino_properties(root) {
        Ok(Some(properties)) => inspect_properties(&properties, &mut report),
        Ok(None) => report.warn(
            "missing-arduino-library-properties",
            "library.properties is missing. CK allows this legacy compatibility case, but Arduino discovery, versioning and dependency metadata may be incomplete.",
        ),
        Err(error) => report.error("invalid-arduino-library-properties", error),
    }

    if has_license_file(root) {
        report.pass("license", "A LICENSE or COPYING file is present.");
    } else {
        report.warn(
            "missing-license",
            "No LICENSE or COPYING file was found at the Arduino library root.",
        );
    }

    match hash_package_contents(root) {
        Ok(hash) => {
            report.source_content_sha256 = Some(hash);
            report.pass(
                "content-hash",
                "Arduino library contents were fingerprinted with SHA-256.",
            );
        }
        Err(error) => report.error("content-hash-failed", error),
    }
    report.finalize();
    report
}

pub(crate) fn locate_installed_arduino_library(
    libraries_root: &Path,
    evidence: &ArduinoZipGateEvidence,
) -> Result<PathBuf, String> {
    let entries = fs::read_dir(libraries_root).map_err(|error| {
        format!(
            "Failed to inspect Arduino sketchbook libraries at {}: {}",
            libraries_root.display(),
            error
        )
    })?;
    let mut exact_hash_matches = Vec::new();
    let mut metadata_matches = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if hash_package_contents(&path).is_ok_and(|hash| hash == evidence.source_content_sha256) {
            exact_hash_matches.push(path.clone());
            continue;
        }
        let Ok(Some(properties)) = read_arduino_properties(&path) else {
            continue;
        };
        let name_matches = evidence.library_name.as_deref().is_some_and(|expected| {
            properties
                .get("name")
                .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
        });
        let version_matches = match evidence.library_version.as_deref() {
            Some(expected) => properties.get("version") == Some(expected),
            None => true,
        };
        if name_matches && version_matches {
            metadata_matches.push(path);
        }
    }

    choose_unique_installed_match(exact_hash_matches, "content hash").or_else(|hash_error| {
        choose_unique_installed_match(metadata_matches, "library name and version").map_err(
            |metadata_error| {
                format!(
                    "Could not identify the exact Arduino library installed from this ZIP. {} {}",
                    hash_error, metadata_error
                )
            },
        )
    })
}

fn choose_unique_installed_match(
    mut matches: Vec<PathBuf>,
    label: &str,
) -> Result<PathBuf, String> {
    matches.sort();
    matches.dedup();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!("No installed directory matched by {}.", label)),
        count => Err(format!(
            "{} installed directories matched by {}; refusing to certify an ambiguous target.",
            count, label
        )),
    }
}

pub(crate) fn certify_installed_arduino_library(
    installed_root: &Path,
    source_archive_sha256: &str,
    expected_source_content_sha256: &str,
) -> Result<PackageQualityReport, String> {
    let mut report = inspect_arduino_library_root(installed_root);
    let installed_content_sha256 = report
        .source_content_sha256
        .as_deref()
        .ok_or("Installed Arduino library quality report has no content hash")?;
    if installed_content_sha256 != expected_source_content_sha256 {
        return Err(format!(
            "Arduino CLI installed content does not match the ZIP that passed CK quality inspection (expected {}, found {}). The library was not certified.",
            expected_source_content_sha256, installed_content_sha256
        ));
    }
    report.pass(
        "source-archive-sha256",
        format!("Source archive SHA-256: {}", source_archive_sha256),
    );
    report.finalize();
    report.enforce()?;

    let marker = serde_json::json!({
        "schema_version": 2,
        "installed_by": "ck-library-manager",
        "source": "local-arduino-zip",
        "source_archive_sha256": source_archive_sha256,
        "source_content_sha256": report.source_content_sha256,
        "quality_report": crate::package_quality::QUALITY_REPORT_FILE,
    });
    let marker_payload = serde_json::to_vec_pretty(&marker).map_err(|error| {
        format!(
            "Failed to serialize Arduino library source marker: {}",
            error
        )
    })?;
    fs::write(installed_root.join(USER_INSTALL_MARKER), marker_payload)
        .map_err(|error| format!("Failed to write Arduino library source marker: {}", error))?;
    if let Err(error) = write_quality_report(installed_root, &report) {
        let _ = fs::remove_file(installed_root.join(USER_INSTALL_MARKER));
        return Err(error);
    }

    let verified = read_quality_report_with_integrity(installed_root)
        .ok_or("Installed Arduino library quality report could not be read back")?;
    verified.enforce()?;
    Ok(verified)
}

pub(crate) fn annotate_arduino_library_list_quality(raw: &str) -> Result<String, String> {
    let mut document: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Arduino CLI returned invalid library JSON: {}", error))?;
    let Some(items) = document
        .get_mut("installed_libraries")
        .and_then(Value::as_array_mut)
    else {
        return Ok(raw.to_string());
    };
    for item in items {
        let Some(library) = item.get_mut("library").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(install_dir) = library
            .get("install_dir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
        else {
            continue;
        };
        if let Some(report) = read_quality_report_with_integrity(&install_dir) {
            library.insert(
                "ck_quality_report".to_string(),
                serde_json::to_value(report).map_err(|error| {
                    format!("Failed to expose Arduino quality report: {}", error)
                })?,
            );
        }
        let marker_path = install_dir.join(USER_INSTALL_MARKER);
        if let Ok(raw_marker) = fs::read_to_string(marker_path) {
            if let Ok(marker) = serde_json::from_str::<Value>(&raw_marker) {
                library.insert("ck_install_source".to_string(), marker);
            }
        }
    }
    serde_json::to_string(&document)
        .map_err(|error| format!("Failed to serialize Arduino library list: {}", error))
}

fn discover_arduino_library_root(extraction_dir: &Path) -> Result<PathBuf, String> {
    let mut candidate = extraction_dir.to_path_buf();
    loop {
        // Prefer the current package root before looking at children. Real
        // Arduino libraries may vendor another native library (including its
        // own library.properties) under src/ or extras/; that must not make a
        // valid outer package look like an ambiguous multi-library archive.
        if candidate.join("library.properties").is_file() {
            return Ok(candidate);
        }
        if has_standard_arduino_sources(&candidate) {
            return Ok(candidate);
        }
        let entries = visible_entries(&candidate)?;
        let directories = entries
            .iter()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        let direct_manifest_roots = directories
            .iter()
            .filter(|path| path.join("library.properties").is_file())
            .cloned()
            .collect::<Vec<_>>();
        match direct_manifest_roots.len() {
            1 => return Ok(direct_manifest_roots[0].clone()),
            count if count > 1 => {
                return Err(format!(
                    "Arduino ZIP contains {} top-level library.properties roots; import one library per ZIP.",
                    count
                ));
            }
            _ => {}
        }
        let files = entries
            .iter()
            .filter(|entry| entry.path().is_file())
            .count();
        if files == 0 && directories.len() == 1 {
            candidate = directories[0].clone();
            continue;
        }
        let roots = directories
            .into_iter()
            .filter(|path| has_standard_arduino_sources(path))
            .collect::<Vec<_>>();
        return match roots.len() {
            1 => Ok(roots[0].clone()),
            count if count > 1 => Err(format!(
                "Arduino ZIP contains {} possible legacy library roots; import one library per ZIP.",
                count
            )),
            _ => Err(
                "Could not find a standard Arduino library root (recursive src/** or legacy root + utility/**)."
                    .to_string(),
            ),
        };
    }
}

fn visible_entries(root: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let entries = fs::read_dir(root)
        .map_err(|error| format!("Failed to inspect extracted Arduino ZIP: {}", error))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_str() != Some("__MACOSX"))
        .collect::<Vec<_>>();
    Ok(entries)
}

fn has_standard_arduino_sources(root: &Path) -> bool {
    count_supported_sources(&root.join("src"), true) > 0
        || count_supported_sources(root, false) > 0
        || count_supported_sources(&root.join("utility"), true) > 0
}

fn count_supported_sources(root: &Path, recursive: bool) -> usize {
    if !root.is_dir() {
        return 0;
    }
    let walker = if recursive {
        walkdir::WalkDir::new(root)
    } else {
        walkdir::WalkDir::new(root).max_depth(1)
    };
    walker
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_arduino_source_or_header(entry.path()))
        .count()
}

fn is_arduino_source_or_header(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "h" | "hh"
                    | "hpp"
                    | "hxx"
                    | "inc"
                    | "ipp"
                    | "tpp"
                    | "c"
                    | "cc"
                    | "cpp"
                    | "cxx"
                    | "s"
            )
        })
}

fn read_arduino_properties(root: &Path) -> Result<Option<ArduinoProperties>, String> {
    let path = root.join("library.properties");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read {}: {}", path.display(), error)),
    };
    let mut values = BTreeMap::new();
    for line in raw.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    Ok(Some(ArduinoProperties { values }))
}

fn inspect_properties(properties: &ArduinoProperties, report: &mut PackageQualityReport) {
    for key in ["name", "version", "architectures"] {
        match properties.get(key).map(str::trim).filter(|value| !value.is_empty()) {
            Some(_) => report.pass(
                &format!("arduino-property-{}", key),
                format!("library.properties declares {}.", key),
            ),
            None if key == "name" => report.error(
                "invalid-arduino-library-name",
                "library.properties requires a non-empty name.",
            ),
            None => report.warn(
                &format!("missing-arduino-property-{}", key),
                format!(
                    "library.properties has no {}; CK keeps the library compatible but discovery metadata is incomplete.",
                    key
                ),
            ),
        }
    }
    if let Some(depends) = properties
        .get("depends")
        .filter(|value| !value.trim().is_empty())
    {
        let count = depends
            .split(',')
            .filter(|item| !item.trim().is_empty())
            .count();
        report.pass(
            "arduino-dependencies-declared",
            format!(
                "library.properties declares {} dependency entry/entries.",
                count
            ),
        );
    } else {
        report.pass(
            "arduino-dependencies-none",
            "library.properties declares no external library dependencies.",
        );
    }
}

fn has_license_file(root: &Path) -> bool {
    fs::read_dir(root).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry.path().is_file()
                && entry.file_name().to_str().is_some_and(|name| {
                    let upper = name.to_ascii_uppercase();
                    upper == "LICENSE"
                        || upper.starts_with("LICENSE.")
                        || upper == "COPYING"
                        || upper.starts_with("COPYING.")
                })
        })
    })
}

fn package_id_from_folder(folder: &str) -> String {
    let mut id = String::new();
    for ch in folder.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            id.push(ch);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_matches('-').to_string()
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to hash {}: {}", path.display(), error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash {}: {}", path.display(), error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ck_arduino_zip_quality_{}_{}",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        let cursor = writer.finish().unwrap();
        fs::write(path, cursor.into_inner()).unwrap();
    }

    #[test]
    fn ordinary_arduino_zip_gate_rejects_parent_traversal_before_install() {
        let root = temp_root("unsafe");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("unsafe.zip");
        write_zip(
            &zip_path,
            &[
                ("../escape.txt", b"escape"),
                ("Unsafe/src/Unsafe.cpp", b"void unsafe_lib() {}"),
            ],
        );
        let error = inspect_arduino_library_zip(&zip_path).unwrap_err();
        assert!(error.contains("unsafe path"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ordinary_arduino_zip_accepts_recursive_deep_src_and_assembly() {
        let root = temp_root("deep-src");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("deep.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "DeepNative/library.properties",
                    b"name=Deep Native\nversion=1.2.3\narchitectures=*\n",
                ),
                ("DeepNative/src/DeepNative.h", b"#pragma once\n"),
                (
                    "DeepNative/src/drivers/private/DeepNative.c",
                    b"void deep_native(void) {}\n",
                ),
                (
                    "DeepNative/src/arch/esp32/startup.S",
                    b"/* assembly fixture */\n",
                ),
                ("DeepNative/LICENSE", b"MIT\n"),
            ],
        );
        let evidence = inspect_arduino_library_zip(&zip_path).unwrap();
        assert_eq!(evidence.library_name.as_deref(), Some("Deep Native"));
        assert_eq!(evidence.library_version.as_deref(), Some("1.2.3"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn outer_library_root_wins_over_vendored_nested_library_metadata() {
        let root = temp_root("vendored-native");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("vendored.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "Outer/library.properties",
                    b"name=Outer Native\nversion=1.0.0\narchitectures=*\n",
                ),
                ("Outer/src/Outer.h", b"#pragma once\n"),
                (
                    "Outer/src/vendor/library.properties",
                    b"name=Vendored Native\nversion=9.9.9\narchitectures=*\n",
                ),
                ("Outer/src/vendor/Vendored.c", b"void vendored(void) {}\n"),
            ],
        );
        let evidence = inspect_arduino_library_zip(&zip_path).unwrap();
        assert_eq!(evidence.library_name.as_deref(), Some("Outer Native"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_library_properties_is_a_compatibility_warning_not_a_blocker() {
        let root = temp_root("legacy-warning");
        fs::create_dir_all(root.join("LegacyNative/utility")).unwrap();
        fs::write(root.join("LegacyNative/LegacyNative.h"), b"#pragma once\n").unwrap();
        fs::write(
            root.join("LegacyNative/utility/LegacyNative.cpp"),
            b"void legacy_native(void) {}\n",
        )
        .unwrap();
        let report = inspect_arduino_library_root(&root.join("LegacyNative"));
        assert_eq!(report.status, "passed_with_warnings");
        assert!(report.checks.iter().any(|check| {
            check.code == "missing-arduino-library-properties" && check.status == "warning"
        }));
        assert!(report.enforce().is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installed_arduino_report_is_machine_readable_and_tamper_evident() {
        let root = temp_root("tamper");
        let library = root.join("TamperNative");
        fs::create_dir_all(library.join("src")).unwrap();
        fs::write(
            library.join("library.properties"),
            b"name=Tamper Native\nversion=1.0.0\narchitectures=*\n",
        )
        .unwrap();
        fs::write(library.join("src/TamperNative.h"), b"#pragma once\n").unwrap();
        fs::write(library.join("LICENSE"), b"MIT\n").unwrap();
        let expected_hash = hash_package_contents(&library).unwrap();
        let report =
            certify_installed_arduino_library(&library, &"a".repeat(64), &expected_hash).unwrap();
        assert!(matches!(
            report.status.as_str(),
            "passed" | "passed_with_warnings"
        ));
        assert!(
            library
                .join(crate::package_quality::QUALITY_REPORT_FILE)
                .is_file()
        );
        assert!(library.join(USER_INSTALL_MARKER).is_file());

        let listed = annotate_arduino_library_list_quality(
            &serde_json::json!({
                "installed_libraries": [{
                    "library": {
                        "name": "Tamper Native",
                        "version": "1.0.0",
                        "install_dir": library,
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        let listed: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(
            listed["installed_libraries"][0]["library"]["ck_quality_report"]["package_kind"],
            "arduino-library"
        );

        fs::write(
            library.join("src/TamperNative.h"),
            b"#pragma once\n// changed after install\n",
        )
        .unwrap();
        let changed = read_quality_report_with_integrity(&library).unwrap();
        assert_eq!(changed.status, "failed");
        assert!(
            changed
                .checks
                .iter()
                .any(|check| check.code == "installed-content-changed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn repository_arduino_cli_preserves_deep_sources_for_quality_certification() {
        let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("bin/arduino-cli.exe");
        if !cli.is_file() {
            return;
        }

        let root = temp_root("real-cli");
        let sketchbook = root.join("sketchbook");
        let libraries = sketchbook.join("libraries");
        fs::create_dir_all(&libraries).unwrap();
        let config = root.join("arduino-cli.yaml");
        let yaml_path = |path: &Path| path.to_string_lossy().replace('\\', "/");
        fs::write(
            &config,
            format!(
                "directories:\n  data: {}\n  downloads: {}\n  user: {}\n",
                yaml_path(&root.join("data")),
                yaml_path(&root.join("downloads")),
                yaml_path(&sketchbook),
            ),
        )
        .unwrap();

        let zip_path = root.join("deep-cli.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "DeepCli/library.properties",
                    b"name=CK Deep CLI Fixture\nversion=1.0.0\narchitectures=*\n",
                ),
                ("DeepCli/src/CKDeepCli.h", b"#pragma once\n"),
                (
                    "DeepCli/src/native/driver/CKDeepCli.c",
                    b"void ck_deep_cli(void) {}\n",
                ),
                ("DeepCli/LICENSE", b"MIT\n"),
            ],
        );
        let evidence = inspect_arduino_library_zip(&zip_path).unwrap();
        let output = std::process::Command::new(&cli)
            .arg("--config-file")
            .arg(&config)
            .arg("lib")
            .arg("install")
            .arg("--zip-path")
            .arg(&zip_path)
            .env("ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL", "true")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "arduino-cli failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let installed = locate_installed_arduino_library(&libraries, &evidence).unwrap();
        assert!(installed.join("src/native/driver/CKDeepCli.c").is_file());
        certify_installed_arduino_library(
            &installed,
            &evidence.source_archive_sha256,
            &evidence.source_content_sha256,
        )
        .unwrap();
        assert!(
            read_quality_report_with_integrity(&installed)
                .is_some_and(|report| report.status == "passed")
        );

        let legacy_zip = root.join("legacy-cli.zip");
        write_zip(
            &legacy_zip,
            &[
                ("LegacyCli/LegacyCli.h", b"#pragma once\n"),
                (
                    "LegacyCli/utility/LegacyCli.cpp",
                    b"void ck_legacy_cli(void) {}\n",
                ),
            ],
        );
        let legacy_evidence = inspect_arduino_library_zip(&legacy_zip).unwrap();
        assert!(legacy_evidence.warning_count > 0);
        let legacy_output = std::process::Command::new(&cli)
            .arg("--config-file")
            .arg(&config)
            .arg("lib")
            .arg("install")
            .arg("--zip-path")
            .arg(&legacy_zip)
            .env("ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL", "true")
            .output()
            .unwrap();
        assert!(
            legacy_output.status.success(),
            "arduino-cli legacy install failed: {}{}",
            String::from_utf8_lossy(&legacy_output.stdout),
            String::from_utf8_lossy(&legacy_output.stderr)
        );
        let legacy_installed =
            locate_installed_arduino_library(&libraries, &legacy_evidence).unwrap();
        let legacy_report = certify_installed_arduino_library(
            &legacy_installed,
            &legacy_evidence.source_archive_sha256,
            &legacy_evidence.source_content_sha256,
        )
        .unwrap();
        assert_eq!(legacy_report.status, "passed_with_warnings");
        assert!(
            legacy_report
                .checks
                .iter()
                .any(|check| check.code == "missing-arduino-library-properties")
        );
        let _ = fs::remove_dir_all(root);
    }
}
