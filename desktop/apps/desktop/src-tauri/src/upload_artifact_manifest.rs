use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

pub const MANIFEST_FILE_NAME: &str = ".ck-upload-artifacts.json";

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadArtifactManifest {
    pub(crate) schema_version: u32,
    pub(crate) canonical_fqbn: String,
    pub(crate) build_signature: String,
    pub(crate) partition_definition: Option<PartitionDefinitionRecord>,
    pub(crate) artifacts: Vec<UploadArtifactRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PartitionDefinitionRecord {
    pub(crate) path: String,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadArtifactRecord {
    pub(crate) path: String,
    pub(crate) role: String,
    pub(crate) flash_address: Option<String>,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

/// Return a typed manifest only after the complete artifact set has passed the
/// same FQBN/signature/hash gate used immediately before transport. Callers may
/// use the result for support metadata or an immutable recovery copy, but must
/// never treat an unverified manifest file as evidence.
pub(crate) fn read_verified(
    build_path: &Path,
    fqbn: &str,
    build_signature: &str,
) -> Result<UploadArtifactManifest, String> {
    validate(build_path, fqbn, build_signature)?;
    read_manifest(build_path)
}

pub fn supports_manifest(fqbn: &str) -> bool {
    target_family(fqbn).is_some()
}

pub fn manifest_path(build_path: &Path) -> PathBuf {
    build_path.join(MANIFEST_FILE_NAME)
}

/// Resolve the Arduino sketch identity from both CK build layouts:
///
/// - legacy: `<cache>/<project>/build`
/// - current: `<cache>/build/<project>`
///
/// Arduino derives ESP32 artifact names from the project directory basename.
/// Keeping this in one helper prevents upload, manifest, and recovery gates
/// from disagreeing when the build directory is moved out of the sketch tree.
pub(crate) fn arduino_project_name_from_build_path(build_path: &Path) -> Result<String, String> {
    let leaf = build_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Upload blocked: cannot determine build directory identity".to_string())?;
    let project_directory_name = if leaf.eq_ignore_ascii_case("build") {
        build_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                "Upload blocked: cannot determine legacy build project identity".to_string()
            })?
    } else {
        leaf
    };
    Ok(format!("{project_directory_name}.ino"))
}

pub fn invalidate(build_path: &Path) -> Result<(), String> {
    let path = manifest_path(build_path);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Upload artifact manifest cannot be inspected at {}: {error}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Upload artifact manifest path is not a regular file: {}",
            path.display()
        ));
    }
    std::fs::remove_file(&path).map_err(|error| {
        format!(
            "Upload artifact manifest cannot be invalidated at {}: {error}",
            path.display()
        )
    })
}

pub fn write(build_path: &Path, fqbn: &str, build_signature: &str) -> Result<PathBuf, String> {
    require_nonempty_signature(build_signature)?;
    let canonical_fqbn = canonical_full_fqbn(fqbn)?;
    let (partition_definition, artifacts) = discover_current_set(build_path, &canonical_fqbn)?;
    let manifest = UploadArtifactManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        canonical_fqbn,
        build_signature: build_signature.to_string(),
        partition_definition,
        artifacts,
    };
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Cannot encode upload artifact manifest: {error}"))?;

    let destination = manifest_path(build_path);
    let temporary = build_path.join(format!(
        "{}.tmp-{}",
        MANIFEST_FILE_NAME,
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = options.open(&temporary).map_err(|error| {
            format!(
                "Cannot create temporary upload artifact manifest {}: {error}",
                temporary.display()
            )
        })?;
        file.write_all(&encoded).map_err(|error| {
            format!(
                "Cannot write temporary upload artifact manifest {}: {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "Cannot flush temporary upload artifact manifest {}: {error}",
                temporary.display()
            )
        })?;
        drop(file);

        if destination.exists() {
            let metadata = std::fs::symlink_metadata(&destination).map_err(|error| {
                format!(
                    "Cannot inspect existing upload artifact manifest {}: {error}",
                    destination.display()
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "Refusing to replace non-regular upload artifact manifest: {}",
                    destination.display()
                ));
            }
            std::fs::remove_file(&destination).map_err(|error| {
                format!(
                    "Cannot replace existing upload artifact manifest {}: {error}",
                    destination.display()
                )
            })?;
        }
        std::fs::rename(&temporary, &destination).map_err(|error| {
            format!(
                "Cannot install upload artifact manifest {}: {error}",
                destination.display()
            )
        })
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result?;

    // Read back the small manifest and compare the complete typed value. The
    // artifact bytes were already hashed exactly once by
    // `discover_current_set`; hashing every firmware image again here merely
    // repeats that work. Upload still performs a fresh full hash validation
    // immediately before transport, so this only removes the duplicate seal
    // pass and does not relax the upload gate.
    let installed = read_manifest(build_path)?;
    if installed != manifest {
        let _ = invalidate(build_path);
        return Err(format!(
            "Cannot verify installed upload artifact manifest at {}",
            destination.display()
        ));
    }
    Ok(destination)
}

pub fn validate(build_path: &Path, fqbn: &str, build_signature: &str) -> Result<(), String> {
    require_nonempty_signature(build_signature)?;
    let expected_fqbn = canonical_full_fqbn(fqbn)?;
    let manifest = read_manifest(build_path)?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Upload blocked: artifact manifest schema {} is unsupported (expected {})",
            manifest.schema_version, MANIFEST_SCHEMA_VERSION
        ));
    }
    if manifest.canonical_fqbn != expected_fqbn {
        return Err(format!(
            "Upload blocked: artifact manifest FQBN mismatch (built for '{}', selected '{}')",
            manifest.canonical_fqbn, expected_fqbn
        ));
    }
    if manifest.build_signature != build_signature {
        return Err(format!(
            "Upload blocked: artifact manifest build signature mismatch (manifest {}, current {})",
            manifest.build_signature, build_signature
        ));
    }

    let (current_partition, current_artifacts) = discover_current_set(build_path, &expected_fqbn)?;
    compare_partition_definition(
        manifest.partition_definition.as_ref(),
        current_partition.as_ref(),
    )?;
    compare_artifacts(&manifest.artifacts, &current_artifacts)
}

fn require_nonempty_signature(build_signature: &str) -> Result<(), String> {
    if build_signature.trim().is_empty() {
        return Err("Upload blocked: build signature is empty; artifacts cannot be trusted".into());
    }
    Ok(())
}

fn read_manifest(build_path: &Path) -> Result<UploadArtifactManifest, String> {
    let path = manifest_path(build_path);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        format!(
            "Upload blocked: required artifact manifest is missing or unreadable at {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Upload blocked: artifact manifest is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "Upload blocked: artifact manifest size {} is invalid: {}",
            metadata.len(),
            path.display()
        ));
    }
    let bytes = std::fs::read(&path).map_err(|error| {
        format!(
            "Upload blocked: cannot read artifact manifest {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Upload blocked: artifact manifest JSON is invalid at {}: {error}",
            path.display()
        )
    })
}

fn canonical_full_fqbn(fqbn: &str) -> Result<String, String> {
    let trimmed = fqbn.trim();
    let mut parts = trimmed.splitn(4, ':');
    let package = required_fqbn_part(parts.next(), "package", trimmed)?;
    let architecture = required_fqbn_part(parts.next(), "architecture", trimmed)?;
    let board = required_fqbn_part(parts.next(), "board", trimmed)?;
    let base = format!("{package}:{architecture}:{board}");
    let Some(raw_options) = parts.next() else {
        return Ok(base);
    };
    if raw_options.trim().is_empty() {
        return Ok(base);
    }

    let mut options = BTreeMap::<String, String>::new();
    for raw_option in raw_options.split(',') {
        let (key, value) = raw_option
            .trim()
            .split_once('=')
            .ok_or_else(|| format!("Upload blocked: malformed FQBN option in '{trimmed}'"))?;
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Err(format!(
                "Upload blocked: empty FQBN option key/value in '{trimmed}'"
            ));
        }
        options.insert(key.to_string(), value.to_string());
    }
    let canonical_options = options
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{base}:{canonical_options}"))
}

fn required_fqbn_part<'a>(
    part: Option<&'a str>,
    label: &str,
    original: &str,
) -> Result<&'a str, String> {
    part.map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Upload blocked: FQBN {label} is missing in '{original}'"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetFamily {
    Esp32,
    Avr,
}

fn target_family(fqbn: &str) -> Option<TargetFamily> {
    let mut parts = fqbn.trim().split(':');
    let package = parts.next()?.trim();
    let architecture = parts.next()?.trim();
    if package.eq_ignore_ascii_case("esp32") && architecture.eq_ignore_ascii_case("esp32") {
        Some(TargetFamily::Esp32)
    } else if architecture.eq_ignore_ascii_case("avr") {
        Some(TargetFamily::Avr)
    } else {
        None
    }
}

fn discover_current_set(
    build_path: &Path,
    canonical_fqbn: &str,
) -> Result<(Option<PartitionDefinitionRecord>, Vec<UploadArtifactRecord>), String> {
    ensure_regular_directory(build_path)?;
    validate_build_options_fqbn(build_path, canonical_fqbn)?;
    match target_family(canonical_fqbn) {
        Some(TargetFamily::Esp32) => discover_esp32_set(build_path),
        Some(TargetFamily::Avr) => discover_avr_set(build_path),
        None => Err(format!(
            "Upload blocked: artifact manifests do not support target '{canonical_fqbn}'"
        )),
    }
}

fn ensure_regular_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Upload blocked: build directory is missing at {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Upload blocked: build path is not a regular directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn discover_esp32_set(
    build_path: &Path,
) -> Result<(Option<PartitionDefinitionRecord>, Vec<UploadArtifactRecord>), String> {
    let flash_args_path = build_path.join("flash_args");
    let flash_args = read_nonempty_regular(&flash_args_path, "ESP32 flash_args")?;
    let tokens = split_quoted_tokens(&String::from_utf8(flash_args).map_err(|error| {
        format!(
            "Upload blocked: ESP32 flash_args is not UTF-8 at {}: {error}",
            flash_args_path.display()
        )
    })?);
    let references = parse_flash_pairs(&tokens)?;
    if references.is_empty() {
        return Err("Upload blocked: ESP32 flash_args contains no address/binary pairs".into());
    }

    let project_name = arduino_project_name_from_build_path(build_path)?;
    let expected_app = format!("{project_name}.bin");
    let expected_bootloader = format!("{project_name}.bootloader.bin");
    let expected_partitions = format!("{project_name}.partitions.bin");

    let mut artifacts = Vec::new();
    let mut roles = BTreeSet::new();
    let mut addresses = BTreeSet::new();
    for (address, raw_path) in references {
        if !addresses.insert(address.clone()) {
            return Err(format!(
                "Upload blocked: ESP32 flash_args repeats burn address {address}"
            ));
        }
        let file_name = Path::new(&raw_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Upload blocked: invalid ESP32 artifact path '{raw_path}'"))?;
        let role = if file_name.eq_ignore_ascii_case(&expected_bootloader) {
            "esp32-bootloader"
        } else if file_name.eq_ignore_ascii_case(&expected_partitions) {
            "esp32-partition-table"
        } else if file_name.eq_ignore_ascii_case("boot_app0.bin") {
            "esp32-boot-app0"
        } else if file_name.eq_ignore_ascii_case(&expected_app) {
            "esp32-application"
        } else {
            return Err(format!(
                "Upload blocked: cannot reliably assign a role to ESP32 upload artifact '{raw_path}'"
            ));
        };
        if !roles.insert(role) {
            return Err(format!(
                "Upload blocked: ESP32 flash_args contains multiple artifacts for role {role}"
            ));
        }
        let resolved = resolve_esp32_reference(build_path, &raw_path, role)?;
        artifacts.push(record_artifact(build_path, &resolved, role, Some(address))?);
    }
    for required in [
        "esp32-bootloader",
        "esp32-partition-table",
        "esp32-boot-app0",
        "esp32-application",
    ] {
        if !roles.contains(required) {
            return Err(format!(
                "Upload blocked: ESP32 flash_args is missing required artifact role {required}"
            ));
        }
    }

    artifacts.push(record_artifact(
        build_path,
        &flash_args_path,
        "esp32-flash-arguments",
        None,
    )?);
    sort_artifacts(&mut artifacts);

    let partition_path = build_path.join("partitions.csv");
    let _ = read_nonempty_regular(&partition_path, "ESP32 selected partition definition")?;
    let partition_definition = PartitionDefinitionRecord {
        path: stored_path(build_path, &partition_path)?,
        sha256: sha256_file(&partition_path)?,
    };
    Ok((Some(partition_definition), artifacts))
}

fn discover_avr_set(
    build_path: &Path,
) -> Result<(Option<PartitionDefinitionRecord>, Vec<UploadArtifactRecord>), String> {
    let mut candidates = std::fs::read_dir(build_path)
        .map_err(|error| {
            format!(
                "Upload blocked: cannot read AVR build directory {}: {error}",
                build_path.display()
            )
        })?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            name.ends_with(".hex")
                && !name.ends_with(".with_bootloader.hex")
                && !name.ends_with(".bootloader.hex")
        })
        .collect::<Vec<_>>();
    candidates.sort();
    if candidates.len() != 1 {
        return Err(format!(
            "Upload blocked: expected exactly one AVR application HEX in {}, found {}",
            build_path.display(),
            candidates.len()
        ));
    }
    let artifact = record_artifact(build_path, &candidates[0], "avr-application", None)?;
    Ok((None, vec![artifact]))
}

fn parse_flash_pairs(tokens: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    let mut paired_binary_indices = BTreeSet::new();
    for index in 0..tokens.len().saturating_sub(1) {
        let Some(address) = normalized_flash_address(&tokens[index]) else {
            continue;
        };
        if !tokens[index + 1].to_ascii_lowercase().ends_with(".bin") {
            return Err(format!(
                "Upload blocked: ESP32 flash_args address {address} is not followed by a .bin artifact"
            ));
        }
        pairs.push((address, tokens[index + 1].clone()));
        paired_binary_indices.insert(index + 1);
    }
    for (index, token) in tokens.iter().enumerate() {
        if token.to_ascii_lowercase().ends_with(".bin") && !paired_binary_indices.contains(&index) {
            return Err(format!(
                "Upload blocked: ESP32 flash_args binary '{token}' has no reliable burn address"
            ));
        }
    }
    Ok(pairs)
}

fn normalized_flash_address(token: &str) -> Option<String> {
    let raw = token.trim();
    let digits = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"))?;
    if digits.is_empty() {
        return None;
    }
    let value = u64::from_str_radix(digits, 16).ok()?;
    Some(format!("0x{value:x}"))
}

fn split_quoted_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for character in input.chars() {
        match quote {
            Some(active) if character == active => quote = None,
            Some(_) => current.push(character),
            None if character == '\'' || character == '"' => quote = Some(character),
            None if character.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(character),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn resolve_esp32_reference(
    build_path: &Path,
    raw_path: &str,
    role: &str,
) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw_path);
    if requested.is_absolute() {
        let canonical = canonical_regular_file(&requested, role)?;
        if role == "esp32-boot-app0" {
            ensure_boot_app0_is_from_selected_core(build_path, &canonical)?;
        } else {
            ensure_inside_build(build_path, &canonical, role)?;
        }
        return Ok(canonical);
    }
    if requested.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Upload blocked: ESP32 artifact path escapes the build directory: {raw_path}"
        ));
    }

    let in_build = build_path.join(&requested);
    if in_build.exists() {
        let canonical = canonical_regular_file(&in_build, role)?;
        ensure_inside_build(build_path, &canonical, role)?;
        return Ok(canonical);
    }
    if role == "esp32-boot-app0"
        && requested.file_name().and_then(|name| name.to_str()) == Some("boot_app0.bin")
    {
        return selected_core_boot_app0(build_path);
    }
    Err(format!(
        "Upload blocked: {role} referenced by flash_args is missing: {}",
        in_build.display()
    ))
}

fn selected_core_boot_app0(build_path: &Path) -> Result<PathBuf, String> {
    let roots = selected_hardware_roots(build_path)?;
    let mut candidates = Vec::new();
    for root in roots {
        let candidate = root.join("tools").join("partitions").join("boot_app0.bin");
        if candidate.exists() {
            candidates.push(canonical_regular_file(&candidate, "esp32-boot-app0")?);
        }
    }
    candidates.sort();
    candidates.dedup();
    if candidates.len() != 1 {
        return Err(format!(
            "Upload blocked: expected one boot_app0.bin in selected ESP32 hardware roots, found {}",
            candidates.len()
        ));
    }
    Ok(candidates.remove(0))
}

fn selected_hardware_roots(build_path: &Path) -> Result<Vec<PathBuf>, String> {
    let options = read_build_options(build_path)?;
    let options_path = build_path.join("build.options.json");
    let value = options.get("hardwareFolders").ok_or_else(|| {
        format!(
            "Upload blocked: Arduino build options does not identify selected hardware folders: {}",
            options_path.display()
        )
    })?;
    let raw_roots = if let Some(joined) = value.as_str() {
        joined
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else if let Some(values) = value.as_array() {
        values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut roots = Vec::new();
    for raw in raw_roots {
        let path = PathBuf::from(raw);
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Upload blocked: selected hardware folder is unavailable at {}: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "Upload blocked: selected hardware folder is not a regular directory: {}",
                path.display()
            ));
        }
        roots.push(path.canonicalize().map_err(|error| {
            format!(
                "Upload blocked: cannot canonicalize selected hardware folder {}: {error}",
                path.display()
            )
        })?);
    }
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return Err("Upload blocked: selected hardware folder list is empty".into());
    }
    Ok(roots)
}

fn read_build_options(build_path: &Path) -> Result<serde_json::Value, String> {
    let options_path = build_path.join("build.options.json");
    let options_bytes = read_nonempty_regular(&options_path, "Arduino build options")?;
    serde_json::from_slice(&options_bytes).map_err(|error| {
        format!(
            "Upload blocked: invalid Arduino build options JSON at {}: {error}",
            options_path.display()
        )
    })
}

fn validate_build_options_fqbn(build_path: &Path, expected_fqbn: &str) -> Result<(), String> {
    let options = read_build_options(build_path)?;
    let options_path = build_path.join("build.options.json");
    let actual_raw = options
        .get("fqbn")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            format!(
                "Upload blocked: Arduino build options does not contain the full FQBN: {}",
                options_path.display()
            )
        })?;
    let actual = canonical_full_fqbn(actual_raw)?;
    if actual != expected_fqbn {
        return Err(format!(
            "Upload blocked: build.options.json FQBN mismatch (built for '{actual}', selected '{expected_fqbn}')"
        ));
    }
    Ok(())
}

fn ensure_boot_app0_is_from_selected_core(
    build_path: &Path,
    artifact: &Path,
) -> Result<(), String> {
    let expected = selected_core_boot_app0(build_path)?;
    if expected != artifact {
        return Err(format!(
            "Upload blocked: boot_app0.bin is outside the selected ESP32 core (expected {}, got {})",
            expected.display(),
            artifact.display()
        ));
    }
    Ok(())
}

fn ensure_inside_build(build_path: &Path, artifact: &Path, role: &str) -> Result<(), String> {
    let build = build_path.canonicalize().map_err(|error| {
        format!(
            "Upload blocked: cannot canonicalize build directory {}: {error}",
            build_path.display()
        )
    })?;
    if !artifact.starts_with(&build) {
        return Err(format!(
            "Upload blocked: {role} is outside the current build directory: {}",
            artifact.display()
        ));
    }
    Ok(())
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Upload blocked: {label} is missing at {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Upload blocked: {label} is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() == 0 {
        return Err(format!(
            "Upload blocked: {label} is empty: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|error| {
        format!(
            "Upload blocked: cannot canonicalize {label} at {}: {error}",
            path.display()
        )
    })
}

fn read_nonempty_regular(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    let canonical = canonical_regular_file(path, label)?;
    std::fs::read(&canonical).map_err(|error| {
        format!(
            "Upload blocked: cannot read {label} at {}: {error}",
            canonical.display()
        )
    })
}

fn record_artifact(
    build_path: &Path,
    path: &Path,
    role: &str,
    flash_address: Option<String>,
) -> Result<UploadArtifactRecord, String> {
    let canonical = canonical_regular_file(path, role)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        format!(
            "Upload blocked: cannot read {role} metadata at {}: {error}",
            canonical.display()
        )
    })?;
    Ok(UploadArtifactRecord {
        path: stored_path(build_path, &canonical)?,
        role: role.to_string(),
        flash_address,
        size: metadata.len(),
        sha256: sha256_file(&canonical)?,
    })
}

fn stored_path(build_path: &Path, path: &Path) -> Result<String, String> {
    let build = build_path.canonicalize().map_err(|error| {
        format!(
            "Upload blocked: cannot canonicalize build directory {}: {error}",
            build_path.display()
        )
    })?;
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Upload blocked: cannot canonicalize artifact path {}: {error}",
            path.display()
        )
    })?;
    let display_path = canonical.strip_prefix(&build).unwrap_or(&canonical);
    Ok(display_path.to_string_lossy().replace('\\', "/"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    #[cfg(test)]
    SHA256_FILE_CALL_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let file = File::open(path).map_err(|error| {
        format!(
            "Upload blocked: cannot open artifact for SHA-256 at {}: {error}",
            path.display()
        )
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            format!(
                "Upload blocked: cannot hash artifact at {}: {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
thread_local! {
    static SHA256_FILE_CALL_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_sha256_file_call_count() {
    SHA256_FILE_CALL_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn sha256_file_call_count() -> usize {
    SHA256_FILE_CALL_COUNT.with(std::cell::Cell::get)
}

fn sort_artifacts(artifacts: &mut [UploadArtifactRecord]) {
    artifacts.sort_by(|left, right| {
        left.role
            .cmp(&right.role)
            .then_with(|| left.flash_address.cmp(&right.flash_address))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn compare_partition_definition(
    manifest: Option<&PartitionDefinitionRecord>,
    current: Option<&PartitionDefinitionRecord>,
) -> Result<(), String> {
    match (manifest, current) {
        (None, None) => Ok(()),
        (Some(_), None) | (None, Some(_)) => Err(
            "Upload blocked: artifact manifest partition definition presence does not match the selected target"
                .into(),
        ),
        (Some(manifest), Some(current)) => {
            if manifest.path != current.path {
                return Err(format!(
                    "Upload blocked: selected partition definition path mismatch (manifest {}, current {})",
                    manifest.path, current.path
                ));
            }
            if manifest.sha256 != current.sha256 {
                return Err(format!(
                    "Upload blocked: selected partition definition SHA-256 mismatch for {} (manifest {}, current {})",
                    current.path, manifest.sha256, current.sha256
                ));
            }
            Ok(())
        }
    }
}

fn compare_artifacts(
    manifest: &[UploadArtifactRecord],
    current: &[UploadArtifactRecord],
) -> Result<(), String> {
    fn identity(record: &UploadArtifactRecord) -> (&str, &str, Option<&str>) {
        (
            record.role.as_str(),
            record.path.as_str(),
            record.flash_address.as_deref(),
        )
    }
    let manifest_identities = manifest.iter().map(identity).collect::<BTreeSet<_>>();
    let current_identities = current.iter().map(identity).collect::<BTreeSet<_>>();
    if manifest_identities != current_identities || manifest.len() != current.len() {
        let missing = current_identities
            .difference(&manifest_identities)
            .map(|(role, path, address)| {
                format!("{role}:{path}@{}", address.unwrap_or("not-applicable"))
            })
            .collect::<Vec<_>>();
        let stale = manifest_identities
            .difference(&current_identities)
            .map(|(role, path, address)| {
                format!("{role}:{path}@{}", address.unwrap_or("not-applicable"))
            })
            .collect::<Vec<_>>();
        return Err(format!(
            "Upload blocked: artifact manifest role/path/address set mismatch (missing [{}], stale [{}])",
            missing.join(", "),
            stale.join(", ")
        ));
    }

    for expected in manifest {
        let current = current
            .iter()
            .find(|candidate| identity(candidate) == identity(expected))
            .expect("identity sets were checked above");
        if expected.size != current.size {
            return Err(format!(
                "Upload blocked: artifact size mismatch for {} ({}) (manifest {}, current {})",
                current.path, current.role, expected.size, current.size
            ));
        }
        if expected.sha256 != current.sha256 {
            return Err(format!(
                "Upload blocked: artifact SHA-256 mismatch for {} ({}) (manifest {}, current {})",
                current.path, current.role, expected.sha256, current.sha256
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        MANIFEST_FILE_NAME, arduino_project_name_from_build_path, canonical_full_fqbn, invalidate,
        manifest_path, supports_manifest, validate, write,
    };
    use serde_json::Value;
    use std::path::{Path, PathBuf};

    struct Esp32Fixture {
        root: PathBuf,
        build: PathBuf,
        fqbn: String,
        project: String,
    }

    impl Drop for Esp32Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ck-upload-manifest-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn esp32_fixture_with_layout(out_of_tree: bool) -> Esp32Fixture {
        let root = temp_dir("esp32");
        let project_dir = root.join("sketch_esp32_fixture_sfast2");
        let project = "sketch_esp32_fixture_sfast2.ino".to_string();
        let build = if out_of_tree {
            root.join("build").join("sketch_esp32_fixture_sfast2")
        } else {
            project_dir.join("build")
        };
        let hardware = root.join("packages/esp32/hardware/esp32/3.3.6");
        std::fs::create_dir_all(hardware.join("tools/partitions")).expect("hardware root");
        std::fs::create_dir_all(&build).expect("build dir");
        std::fs::write(hardware.join("tools/partitions/boot_app0.bin"), b"boot app")
            .expect("boot app");
        for (suffix, bytes) in [
            (".bootloader.bin", b"bootloader".as_slice()),
            (".partitions.bin", b"partition binary".as_slice()),
            (".bin", b"application".as_slice()),
        ] {
            std::fs::write(build.join(format!("{project}{suffix}")), bytes)
                .expect("build artifact");
        }
        std::fs::write(
            build.join("flash_args"),
            format!(
                "--flash-mode dio --flash-size 16MB\n0x0 {project}.bootloader.bin\n0x8000 {project}.partitions.bin\n0xe000 boot_app0.bin\n0x10000 {project}.bin\n"
            ),
        )
        .expect("flash args");
        std::fs::write(
            build.join("partitions.csv"),
            b"app0,app,factory,0x10000,0x300000\n",
        )
        .expect("partition definition");
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({
                "fqbn": "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash",
                "hardwareFolders": hardware.to_string_lossy()
            })
            .to_string(),
        )
        .expect("build options");
        Esp32Fixture {
            root,
            build,
            fqbn: "esp32:esp32:esp32s3:PartitionScheme=fatflash,FlashSize=16M".into(),
            project,
        }
    }

    fn esp32_fixture() -> Esp32Fixture {
        esp32_fixture_with_layout(false)
    }

    fn read_manifest_json(build: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(manifest_path(build)).expect("manifest bytes"))
            .expect("manifest json")
    }

    #[test]
    fn canonical_fqbn_sorts_options_and_preserves_the_complete_target() {
        assert_eq!(
            canonical_full_fqbn(
                " esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB "
            )
            .unwrap(),
            "esp32:esp32:esp32s3:FlashSize=8M,PSRAM=opi,PartitionScheme=default_8MB"
        );
        assert!(supports_manifest("esp32:esp32:esp32s3"));
        assert!(supports_manifest("arduino:avr:nano:cpu=atmega328old"));
        assert!(supports_manifest("MiniCore:avr:328:clock=16MHz_external"));
        assert!(!supports_manifest("rp2040:rp2040:rpipico"));
    }

    #[test]
    fn project_identity_supports_legacy_and_out_of_tree_build_layouts() {
        let root = temp_dir("project-identity");
        let project = "sketch_esp32_identity_rel";
        assert_eq!(
            arduino_project_name_from_build_path(&root.join(project).join("build")).unwrap(),
            format!("{project}.ino")
        );
        assert_eq!(
            arduino_project_name_from_build_path(&root.join("build").join(project)).unwrap(),
            format!("{project}.ino")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn esp32_manifest_accepts_out_of_tree_build_layout_and_keeps_project_identity() {
        let fixture = esp32_fixture_with_layout(true);
        write(&fixture.build, &fixture.fqbn, "build-signature")
            .expect("write out-of-tree manifest");
        validate(&fixture.build, &fixture.fqbn, "build-signature")
            .expect("validate out-of-tree manifest");
        let json = read_manifest_json(&fixture.build);
        let application = json["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| artifact["role"] == "esp32-application")
            .expect("application record");
        assert_eq!(application["path"], format!("{}.bin", fixture.project));
    }

    #[test]
    fn esp32_manifest_records_fqbn_partition_and_every_upload_artifact() {
        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");
        validate(&fixture.build, &fixture.fqbn, "build-signature").expect("validate manifest");

        let json = read_manifest_json(&fixture.build);
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(
            json["canonicalFqbn"],
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash"
        );
        assert_eq!(json["buildSignature"], "build-signature");
        assert_eq!(json["partitionDefinition"]["path"], "partitions.csv");
        assert_eq!(
            json["partitionDefinition"]["sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        let artifacts = json["artifacts"].as_array().unwrap();
        assert_eq!(artifacts.len(), 5);
        let roles = artifacts
            .iter()
            .map(|artifact| artifact["role"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            roles,
            std::collections::BTreeSet::from([
                "esp32-application",
                "esp32-boot-app0",
                "esp32-bootloader",
                "esp32-flash-arguments",
                "esp32-partition-table",
            ])
        );
        for artifact in artifacts {
            assert!(artifact["path"].as_str().unwrap().len() > 1);
            assert!(artifact["size"].as_u64().unwrap() > 0);
            assert_eq!(artifact["sha256"].as_str().unwrap().len(), 64);
        }
    }

    #[test]
    fn esp32_manifest_rejects_artifact_partition_fqbn_and_signature_changes() {
        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");

        std::fs::write(
            fixture.build.join(format!("{}.bin", fixture.project)),
            b"tampered application",
        )
        .expect("tamper application");
        let error = validate(&fixture.build, &fixture.fqbn, "build-signature")
            .expect_err("artifact tamper must fail");
        assert!(error.contains("artifact size mismatch") || error.contains("SHA-256 mismatch"));

        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");
        std::fs::write(fixture.build.join("partitions.csv"), b"changed partition\n")
            .expect("tamper partition definition");
        let error = validate(&fixture.build, &fixture.fqbn, "build-signature")
            .expect_err("partition tamper must fail");
        assert!(error.contains("partition definition SHA-256 mismatch"));

        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");
        let error = validate(
            &fixture.build,
            "esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB",
            "build-signature",
        )
        .expect_err("FQBN mismatch must fail");
        assert!(error.contains("FQBN mismatch"));
        let error = validate(&fixture.build, &fixture.fqbn, "other-signature")
            .expect_err("signature mismatch must fail");
        assert!(error.contains("build signature mismatch"));

        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");
        let options_path = fixture.build.join("build.options.json");
        let mut options: Value =
            serde_json::from_slice(&std::fs::read(&options_path).unwrap()).unwrap();
        options["fqbn"] =
            Value::String("esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB".into());
        std::fs::write(&options_path, serde_json::to_vec(&options).unwrap()).unwrap();
        let error = validate(&fixture.build, &fixture.fqbn, "build-signature")
            .expect_err("build options from a different configuration must fail");
        assert!(error.contains("build.options.json FQBN mismatch"));
    }

    #[test]
    fn esp32_manifest_rejects_flash_address_changes_and_unknown_roles() {
        let fixture = esp32_fixture();
        write(&fixture.build, &fixture.fqbn, "build-signature").expect("write manifest");
        let flash_args = fixture.build.join("flash_args");
        let changed = std::fs::read_to_string(&flash_args)
            .unwrap()
            .replace("0x10000", "0x20000");
        std::fs::write(&flash_args, changed).expect("change address");
        let error = validate(&fixture.build, &fixture.fqbn, "build-signature")
            .expect_err("address mismatch must fail");
        assert!(error.contains("role/path/address set mismatch"));

        let fixture = esp32_fixture();
        let mut flash_args = std::fs::read_to_string(fixture.build.join("flash_args")).unwrap();
        flash_args.push_str("0x20000 vendor-extra.bin\n");
        std::fs::write(fixture.build.join("vendor-extra.bin"), b"extra").unwrap();
        std::fs::write(fixture.build.join("flash_args"), flash_args).unwrap();
        let error = write(&fixture.build, &fixture.fqbn, "build-signature")
            .expect_err("unknown artifact role must not be fabricated");
        assert!(error.contains("cannot reliably assign a role"));
    }

    #[test]
    fn avr_manifest_uses_only_the_application_hex_and_detects_tampering() {
        let root = temp_dir("avr");
        let build = root.join("build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("blink.ino.hex"), b":00000001FF\n").unwrap();
        std::fs::write(
            build.join("blink.ino.with_bootloader.hex"),
            b":00000001FF\nbootloader",
        )
        .unwrap();
        let fqbn = "arduino:avr:nano:cpu=atmega328old";
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({ "fqbn": fqbn }).to_string(),
        )
        .unwrap();
        write(&build, fqbn, "avr-signature").expect("write AVR manifest");
        validate(&build, fqbn, "avr-signature").expect("validate AVR manifest");
        let json = read_manifest_json(&build);
        assert!(json["partitionDefinition"].is_null());
        assert_eq!(json["artifacts"].as_array().unwrap().len(), 1);
        assert_eq!(json["artifacts"][0]["role"], "avr-application");

        std::fs::write(build.join("blink.ino.hex"), b":tampered\n").unwrap();
        let error =
            validate(&build, fqbn, "avr-signature").expect_err("AVR artifact tampering must fail");
        assert!(error.contains("artifact size mismatch") || error.contains("SHA-256 mismatch"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_manifest_is_rejected_and_invalidation_removes_only_the_manifest() {
        let root = temp_dir("missing");
        let build = root.join("build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("blink.ino.hex"), b":00000001FF\n").unwrap();
        let fqbn = "arduino:avr:uno";
        std::fs::write(
            build.join("build.options.json"),
            serde_json::json!({ "fqbn": fqbn }).to_string(),
        )
        .unwrap();
        let error = validate(&build, fqbn, "signature").expect_err("manifest is mandatory");
        assert!(error.contains("required artifact manifest"));
        write(&build, fqbn, "signature").unwrap();
        assert!(build.join(MANIFEST_FILE_NAME).exists());
        invalidate(&build).unwrap();
        assert!(!build.join(MANIFEST_FILE_NAME).exists());
        assert!(build.join("blink.ino.hex").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
