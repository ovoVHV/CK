//! Integrity-verified AVR Release Core preservation across dependency-graph changes.
//!
//! Arduino CLI deletes the complete build directory when its library options
//! change. For an already performance-qualified AVR target, the Core and variant
//! objects are independent from the sketch/library graph. This module records
//! and verifies those objects against the current local request identity, moves
//! the old graph to a same-volume quarantine, and moves back
//! only the integrity-verified `core/` directory. Every ambiguity fails closed.

use super::native_relink::{self, CapturedNativeRelinkBaseline, NativeReleaseCoreObjectContract};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const SCHEMA_VERSION: u32 = 1;
const ENGINE_CONTRACT: &str = "ck-release-core-seed-v1:avr-certified-core-variant-dep-command";
const CAPABILITY_CLASS: &str = "arduino-avr-release-core-seed";
const MANIFEST_FILE: &str = ".ck-release-core-seed-v1.json";
const CERTIFICATE_SCHEMA_VERSION: u32 = 1;
const CERTIFICATE_ENGINE_CONTRACT: &str = "ck-release-core-seed-certificate-v1";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES: u64 = 512 * 1024;
const MAX_CORE_FILES: usize = 1_024;
const MAX_CORE_OBJECTS: usize = 512;
const MAX_DEPENDENCIES_PER_OBJECT: usize = 4_096;
const MAX_CORE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 32;

static QUARANTINE_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIdentity {
    relative_path: String,
    size: u64,
    modified_ns: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalFileIdentity {
    canonical_path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreObjectIdentity {
    working_directory: String,
    compiler_executable: ExternalFileIdentity,
    source: ExternalFileIdentity,
    object: FileIdentity,
    depfile: FileIdentity,
    command_sha256: String,
    dependencies: Vec<ExternalFileIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseCoreSeedManifest {
    schema_version: u32,
    engine_contract: String,
    capability_class: String,
    canonical_fqbn: String,
    profile: String,
    cli_version: String,
    cli_executable: ExternalFileIdentity,
    toolchain_key: String,
    toolchain_identity_generation: u64,
    authorization_key: String,
    property_contract_sha256: String,
    canonical_build_dir: String,
    core_archive: FileIdentity,
    core_objects: Vec<CoreObjectIdentity>,
    core_tree_sha256: String,
    core_command_graph_sha256: String,
}

/// Independent local cache-integrity commit marker.  This binds the Core seed
/// to the exact request and executables, but is not a claim of resistance to a
/// malicious process running as the same operating-system user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseCoreSeedCertificate {
    schema_version: u32,
    engine_contract: String,
    manifest_sha256: String,
    core_tree_sha256: String,
    core_command_graph_sha256: String,
    property_contract_sha256: String,
    authorization_key: String,
    canonical_fqbn: String,
    profile: String,
    cli_version: String,
    toolchain_key: String,
    toolchain_identity_generation: u64,
    cli_executable: ExternalFileIdentity,
    compiler_executables: Vec<ExternalFileIdentity>,
}

#[derive(Debug, Clone)]
pub(super) struct ReleaseCoreSeedExpected {
    pub fqbn: String,
    pub cli_version: String,
    pub toolchain_key: String,
    pub toolchain_identity_generation: u64,
    pub authorization_key: String,
    pub property_contract_sha256: String,
    pub build_dir: PathBuf,
    pub platform_root: PathBuf,
    pub metadata_root: PathBuf,
    pub certificate_path: PathBuf,
    pub cli_executable: PathBuf,
    pub allowed_working_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub(super) struct ValidatedReleaseCoreSeed {
    manifest: ReleaseCoreSeedManifest,
    certificate: ReleaseCoreSeedCertificate,
    expected: ReleaseCoreSeedExpected,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub(super) struct ReleaseCoreSeedQuarantine {
    pub quarantine_path: PathBuf,
    pub file_count: usize,
    pub total_bytes: u64,
    validated: ValidatedReleaseCoreSeed,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_))
                && !component
                    .as_os_str()
                    .to_string_lossy()
                    .chars()
                    .any(char::is_control)
        })
}

fn map_gate<T>(value: native_relink::GateResult<T>) -> Result<T> {
    value.map_err(|error| anyhow::anyhow!(error.to_string()))
}

fn sha256_file(path: &Path) -> Result<String> {
    map_gate(native_relink::sha256_file(path))
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    map_gate(native_relink::canonical_directory(path))
}

fn canonical_file_within(path: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    map_gate(native_relink::canonical_regular_file_within(path, roots))
}

fn relative_file_identity(path: &Path, build: &Path) -> Result<FileIdentity> {
    let canonical = canonical_file_within(path, &[build.to_path_buf()])?;
    let relative = canonical
        .strip_prefix(build)
        .context("ReleaseCoreSeed file escaped its canonical build directory")?
        .to_string_lossy()
        .replace('\\', "/");
    if !safe_relative_path(&relative) {
        anyhow::bail!("ReleaseCoreSeed file has an unsafe relative path: {relative}");
    }
    let metadata = std::fs::metadata(&canonical)?;
    Ok(FileIdentity {
        relative_path: relative,
        size: metadata.len(),
        modified_ns: super::metadata_modified_ns(&metadata)
            .context("ReleaseCoreSeed file has no stable high-resolution modification time")?,
        sha256: sha256_file(&canonical)?,
    })
}

fn external_file_identity(path: &Path, roots: &[PathBuf]) -> Result<ExternalFileIdentity> {
    let canonical = canonical_file_within(path, roots)?;
    let metadata = std::fs::metadata(&canonical)?;
    Ok(ExternalFileIdentity {
        canonical_path: canonical.to_string_lossy().into_owned(),
        size: metadata.len(),
        sha256: sha256_file(&canonical)?,
    })
}

fn exact_external_file_identity(path: &Path) -> Result<ExternalFileIdentity> {
    if !path.is_absolute() {
        anyhow::bail!(
            "ReleaseCoreSeed executable path is not absolute: {}",
            path.display()
        );
    }
    let parent = path
        .parent()
        .context("ReleaseCoreSeed executable has no parent directory")?;
    let parent = canonical_directory(parent)?;
    external_file_identity(path, std::slice::from_ref(&parent))
}

fn canonical_working_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut roots = roots
        .iter()
        .map(|root| canonical_directory(root))
        .collect::<Result<Vec<_>>>()?;
    roots.sort_by_key(|root| native_relink::path_key(root));
    roots.dedup_by(|left, right| native_relink::path_key(left) == native_relink::path_key(right));
    if roots.is_empty() {
        anyhow::bail!("ReleaseCoreSeed has no admitted process working root");
    }
    Ok(roots)
}

fn compiler_dependency_root(executable: &ExternalFileIdentity) -> Result<PathBuf> {
    let executable = Path::new(&executable.canonical_path);
    let parent = executable
        .parent()
        .context("ReleaseCoreSeed compiler executable has no parent")?;
    let root = if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        parent
            .parent()
            .context("ReleaseCoreSeed compiler bin directory has no installation root")?
    } else {
        parent
    };
    canonical_directory(root)
}

fn certificate_location(metadata_root: &Path, certificate_path: &Path) -> Result<PathBuf> {
    let metadata_root = canonical_directory(metadata_root)?;
    if !certificate_path.is_absolute() {
        anyhow::bail!("ReleaseCoreSeed certificate path must be absolute");
    }
    let leaf = certificate_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("ReleaseCoreSeed certificate has no UTF-8 leaf name")?;
    if !leaf.starts_with("release_core_seed_certificate_")
        || !leaf.ends_with(".json")
        || leaf.chars().any(char::is_control)
    {
        anyhow::bail!("ReleaseCoreSeed certificate has an unsafe file name");
    }
    let parent = certificate_path
        .parent()
        .context("ReleaseCoreSeed certificate has no parent directory")?;
    let parent = canonical_directory(parent)?;
    if native_relink::path_key(&parent) != native_relink::path_key(&metadata_root) {
        anyhow::bail!("ReleaseCoreSeed certificate escaped the exact metadata root");
    }
    Ok(metadata_root.join(leaf))
}

fn remove_certificate_if_present(metadata_root: &Path, certificate_path: &Path) -> Result<()> {
    let certificate_path = certificate_location(metadata_root, certificate_path)?;
    match std::fs::remove_file(&certificate_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "ReleaseCoreSeed could not revoke certificate {}",
                certificate_path.display()
            )
        }),
    }
}

fn core_command_graph_sha256(objects: &[CoreObjectIdentity], build: &Path) -> String {
    let mut rows = objects
        .iter()
        .map(|object| {
            [
                native_relink::path_key(Path::new(&object.compiler_executable.canonical_path)),
                native_relink::path_key(Path::new(&object.working_directory)),
                native_relink::path_key(Path::new(&object.source.canonical_path)),
                native_relink::path_key(&build.join(&object.object.relative_path)),
                object.command_sha256.clone(),
            ]
        })
        .collect::<Vec<_>>();
    rows.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"ck-native-release-core-command-graph-v1");
    hasher.update([0]);
    for value in rows.iter().flat_map(|row| row.iter()) {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn compiler_identities_from_objects(objects: &[CoreObjectIdentity]) -> Vec<ExternalFileIdentity> {
    let mut identities = objects
        .iter()
        .map(|object| object.compiler_executable.clone())
        .collect::<Vec<_>>();
    identities.sort_by(|left, right| {
        native_relink::path_key(Path::new(&left.canonical_path))
            .cmp(&native_relink::path_key(Path::new(&right.canonical_path)))
    });
    identities.dedup_by(|left, right| {
        native_relink::path_key(Path::new(&left.canonical_path))
            == native_relink::path_key(Path::new(&right.canonical_path))
    });
    identities
}

fn validate_external_identity(identity: &ExternalFileIdentity, roots: &[PathBuf]) -> Result<()> {
    if !is_sha256(&identity.sha256) || identity.size == 0 {
        anyhow::bail!("ReleaseCoreSeed external file identity is malformed");
    }
    let observed = external_file_identity(Path::new(&identity.canonical_path), roots)?;
    if &observed != identity {
        anyhow::bail!(
            "ReleaseCoreSeed external input changed: {}",
            identity.canonical_path
        );
    }
    Ok(())
}

fn validate_relative_identity(identity: &FileIdentity, build: &Path) -> Result<()> {
    if !safe_relative_path(&identity.relative_path)
        || !is_sha256(&identity.sha256)
        || identity.size == 0
        || identity.modified_ns == 0
    {
        anyhow::bail!("ReleaseCoreSeed build file identity is malformed");
    }
    let observed = relative_file_identity(&build.join(&identity.relative_path), build)?;
    if &observed != identity {
        anyhow::bail!(
            "ReleaseCoreSeed build file changed: {}",
            identity.relative_path
        );
    }
    Ok(())
}

fn capture_object(
    contract: &NativeReleaseCoreObjectContract,
    build: &Path,
    platform_root: &Path,
    allowed_working_roots: &[PathBuf],
) -> Result<CoreObjectIdentity> {
    let working_directory = canonical_directory(&contract.working_directory)?;
    let working_roots = canonical_working_roots(allowed_working_roots)?;
    if !working_roots
        .iter()
        .any(|root| working_directory.starts_with(root))
    {
        anyhow::bail!(
            "ReleaseCoreSeed Core command working directory is outside current process roots: {}",
            working_directory.display()
        );
    }
    let compiler_executable = exact_external_file_identity(&contract.compiler_executable)?;
    let source = external_file_identity(&contract.source, &[platform_root.to_path_buf()])?;
    let object = relative_file_identity(&contract.object, build)?;
    let depfile = relative_file_identity(&contract.depfile, build)?;
    if !object.relative_path.replace('\\', "/").starts_with("core/")
        || !depfile
            .relative_path
            .replace('\\', "/")
            .starts_with("core/")
        || !object.relative_path.ends_with(".o")
        || !depfile.relative_path.ends_with(".d")
        || !is_sha256(&contract.command_sha256)
    {
        anyhow::bail!("ReleaseCoreSeed Core object contract is malformed");
    }
    let raw = std::fs::read_to_string(&contract.depfile)
        .context("ReleaseCoreSeed depfile is unavailable or not UTF-8")?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        anyhow::bail!("ReleaseCoreSeed depfile exceeds the bounded size");
    }
    let (targets, dependencies) = map_gate(native_relink::parse_single_rule_depfile(&raw))?;
    if targets.len() != 1
        || native_relink::path_key(&native_relink::resolve_token_path(
            &targets[0].decoded,
            &working_directory,
        )) != native_relink::path_key(&contract.object)
    {
        anyhow::bail!("ReleaseCoreSeed depfile does not target its exact Core object");
    }
    if dependencies.is_empty() || dependencies.len() > MAX_DEPENDENCIES_PER_OBJECT {
        anyhow::bail!("ReleaseCoreSeed dependency count is empty or exceeds the bound");
    }
    let allowed_dependencies = vec![
        platform_root.to_path_buf(),
        compiler_dependency_root(&compiler_executable)?,
    ];
    let source_key = native_relink::path_key(Path::new(&source.canonical_path));
    let mut source_count = 0usize;
    let mut captured = BTreeMap::<String, ExternalFileIdentity>::new();
    for dependency in dependencies {
        let resolved = native_relink::resolve_token_path(&dependency.decoded, &working_directory);
        let identity = external_file_identity(&resolved, &allowed_dependencies)?;
        let key = native_relink::path_key(Path::new(&identity.canonical_path));
        if key == source_key {
            source_count += 1;
        }
        captured.entry(key).or_insert(identity);
    }
    if source_count != 1 {
        anyhow::bail!("ReleaseCoreSeed depfile must bind its Core/variant source exactly once");
    }
    Ok(CoreObjectIdentity {
        working_directory: working_directory.to_string_lossy().into_owned(),
        compiler_executable,
        source,
        object,
        depfile,
        command_sha256: contract.command_sha256.clone(),
        dependencies: captured.into_values().collect(),
    })
}

fn visit_core_tree(
    build: &Path,
    directory: &Path,
    depth: usize,
    out: &mut Vec<FileIdentity>,
    total_bytes: &mut u64,
) -> Result<()> {
    if depth > MAX_TREE_DEPTH {
        anyhow::bail!("ReleaseCoreSeed Core tree exceeds the depth bound");
    }
    let metadata = std::fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        anyhow::bail!("ReleaseCoreSeed Core tree contains an unsafe directory");
    }
    let mut entries = std::fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata_is_reparse(&metadata) {
            anyhow::bail!(
                "ReleaseCoreSeed Core tree contains a reparse/symlink entry: {}",
                path.display()
            );
        }
        if metadata.is_dir() {
            visit_core_tree(build, &path, depth + 1, out, total_bytes)?;
        } else if metadata.is_file() {
            if path.file_name().and_then(|name| name.to_str()) == Some(MANIFEST_FILE) {
                continue;
            }
            if out.len() >= MAX_CORE_FILES {
                anyhow::bail!("ReleaseCoreSeed Core tree exceeds the file-count bound");
            }
            *total_bytes = total_bytes.saturating_add(metadata.len());
            if *total_bytes > MAX_CORE_BYTES {
                anyhow::bail!("ReleaseCoreSeed Core tree exceeds the byte bound");
            }
            out.push(relative_file_identity(&path, build)?);
        } else {
            anyhow::bail!("ReleaseCoreSeed Core tree contains a non-file entry");
        }
    }
    Ok(())
}

fn capture_core_tree(build: &Path) -> Result<(Vec<FileIdentity>, u64, String)> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    visit_core_tree(build, &build.join("core"), 0, &mut files, &mut total_bytes)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    if files.windows(2).any(|pair| {
        pair[0]
            .relative_path
            .eq_ignore_ascii_case(&pair[1].relative_path)
    }) {
        anyhow::bail!("ReleaseCoreSeed Core tree contains duplicate/case-colliding paths");
    }
    let mut hasher = Sha256::new();
    hasher.update(b"ck-release-core-seed-tree-v1\0");
    for file in &files {
        hasher.update((file.relative_path.len() as u64).to_le_bytes());
        hasher.update(file.relative_path.as_bytes());
        hasher.update(file.size.to_le_bytes());
        hasher.update(file.modified_ns.to_le_bytes());
        hasher.update(file.sha256.as_bytes());
    }
    Ok((files, total_bytes, hex::encode(hasher.finalize())))
}

fn expected_core_paths(manifest: &ReleaseCoreSeedManifest) -> BTreeSet<String> {
    std::iter::once(manifest.core_archive.relative_path.clone())
        .chain(manifest.core_objects.iter().flat_map(|object| {
            [
                object.object.relative_path.clone(),
                object.depfile.relative_path.clone(),
            ]
        }))
        .collect()
}

fn validate_manifest_header(
    manifest: &ReleaseCoreSeedManifest,
    expected: &ReleaseCoreSeedExpected,
) -> Result<PathBuf> {
    if manifest.schema_version != SCHEMA_VERSION
        || manifest.engine_contract != ENGINE_CONTRACT
        || manifest.capability_class != CAPABILITY_CLASS
        || manifest.profile != "release"
        || !manifest.canonical_fqbn.starts_with("arduino:avr:")
        || manifest.canonical_fqbn != expected.fqbn
        || manifest.cli_version != expected.cli_version
        || manifest.toolchain_key != expected.toolchain_key
        || manifest.toolchain_identity_generation != expected.toolchain_identity_generation
        || manifest.authorization_key != expected.authorization_key
        || manifest.property_contract_sha256 != expected.property_contract_sha256
        || !is_sha256(&manifest.authorization_key)
        || !is_sha256(&manifest.property_contract_sha256)
        || !is_sha256(&manifest.core_tree_sha256)
        || !is_sha256(&manifest.core_command_graph_sha256)
        || manifest.core_objects.is_empty()
        || manifest.core_objects.len() > MAX_CORE_OBJECTS
    {
        anyhow::bail!("ReleaseCoreSeed manifest header/authorization does not match this request");
    }
    let build = canonical_directory(&expected.build_dir)?;
    if native_relink::path_key(&build)
        != native_relink::path_key(Path::new(&manifest.canonical_build_dir))
    {
        anyhow::bail!("ReleaseCoreSeed canonical build directory changed");
    }
    Ok(build)
}

fn validate_manifest(
    manifest: &ReleaseCoreSeedManifest,
    certificate: &ReleaseCoreSeedCertificate,
    expected: &ReleaseCoreSeedExpected,
) -> Result<ValidatedReleaseCoreSeed> {
    let build = validate_manifest_header(manifest, expected)?;
    let platform_root = canonical_directory(&expected.platform_root)?;
    let working_roots = canonical_working_roots(&expected.allowed_working_roots)?;
    let observed_cli = exact_external_file_identity(&expected.cli_executable)?;
    if manifest.cli_executable != observed_cli
        || manifest.cli_executable != certificate.cli_executable
    {
        anyhow::bail!("ReleaseCoreSeed Arduino CLI executable identity changed");
    }
    validate_relative_identity(&manifest.core_archive, &build)?;
    for object in &manifest.core_objects {
        if !is_sha256(&object.command_sha256) {
            anyhow::bail!("ReleaseCoreSeed Core command binding is malformed");
        }
        let observed_compiler =
            exact_external_file_identity(Path::new(&object.compiler_executable.canonical_path))?;
        if observed_compiler != object.compiler_executable {
            anyhow::bail!("ReleaseCoreSeed compiler executable identity changed");
        }
        validate_external_identity(&object.source, std::slice::from_ref(&platform_root))?;
        validate_relative_identity(&object.object, &build)?;
        validate_relative_identity(&object.depfile, &build)?;
        let contract = NativeReleaseCoreObjectContract {
            working_directory: PathBuf::from(&object.working_directory),
            compiler_executable: PathBuf::from(&object.compiler_executable.canonical_path),
            source: PathBuf::from(&object.source.canonical_path),
            object: build.join(&object.object.relative_path),
            depfile: build.join(&object.depfile.relative_path),
            command_sha256: object.command_sha256.clone(),
        };
        let observed = capture_object(&contract, &build, &platform_root, &working_roots)?;
        if observed != *object {
            anyhow::bail!("ReleaseCoreSeed Core object/dependency binding changed");
        }
    }
    let (files, total_bytes, tree_sha256) = capture_core_tree(&build)?;
    let observed_paths = files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect::<BTreeSet<_>>();
    if observed_paths != expected_core_paths(manifest) || tree_sha256 != manifest.core_tree_sha256 {
        anyhow::bail!("ReleaseCoreSeed Core tree membership/content changed");
    }
    if core_command_graph_sha256(&manifest.core_objects, &build)
        != manifest.core_command_graph_sha256
    {
        anyhow::bail!("ReleaseCoreSeed Core command graph identity changed");
    }
    Ok(ValidatedReleaseCoreSeed {
        manifest: manifest.clone(),
        certificate: certificate.clone(),
        expected: expected.clone(),
        file_count: files.len(),
        total_bytes,
    })
}

pub(super) fn commit_from_native_baseline(
    captured: &CapturedNativeRelinkBaseline,
    platform_root: &Path,
    metadata_root: &Path,
    certificate_path: &Path,
    cli_executable: &Path,
    allowed_working_roots: &[PathBuf],
) -> Result<(usize, u64)> {
    // The external certificate file is a local integrity commit marker, not a
    // cryptographic or publisher certificate. Revoke any previous marker before
    // writing the new Core manifest so interruption fails closed.
    remove_certificate_if_present(metadata_root, certificate_path)?;
    let native = &captured.manifest;
    if native.access_mode != "certified"
        || !native.canonical_fqbn.starts_with("arduino:avr:")
        || captured.ccdb_contract.core_objects.is_empty()
        || captured.ccdb_contract.core_objects.len() > MAX_CORE_OBJECTS
    {
        anyhow::bail!(
            "ReleaseCoreSeed requires a locally performance-qualified bounded AVR native baseline"
        );
    }
    let build = canonical_directory(Path::new(&native.canonical_build_dir))?;
    let platform_root = canonical_directory(platform_root)?;
    let working_roots = canonical_working_roots(allowed_working_roots)?;
    let cli_executable = exact_external_file_identity(cli_executable)?;
    let core_archive = relative_file_identity(&build.join("core/core.a"), &build)?;
    let mut core_objects = captured
        .ccdb_contract
        .core_objects
        .iter()
        .map(|contract| capture_object(contract, &build, &platform_root, &working_roots))
        .collect::<Result<Vec<_>>>()?;
    core_objects.sort_by(|left, right| left.object.relative_path.cmp(&right.object.relative_path));
    if core_objects.windows(2).any(|pair| {
        pair[0]
            .object
            .relative_path
            .eq_ignore_ascii_case(&pair[1].object.relative_path)
    }) {
        anyhow::bail!("ReleaseCoreSeed Core object outputs collide");
    }
    let (files, total_bytes, core_tree_sha256) = capture_core_tree(&build)?;
    let observed_core_command_graph_sha256 = core_command_graph_sha256(&core_objects, &build);
    if observed_core_command_graph_sha256 != captured.ccdb_contract.core_command_graph_sha256 {
        anyhow::bail!("ReleaseCoreSeed native CCDB Core command graph changed during capture");
    }
    let manifest = ReleaseCoreSeedManifest {
        schema_version: SCHEMA_VERSION,
        engine_contract: ENGINE_CONTRACT.into(),
        capability_class: CAPABILITY_CLASS.into(),
        canonical_fqbn: native.canonical_fqbn.clone(),
        profile: "release".into(),
        cli_version: native.cli_version.clone(),
        cli_executable: cli_executable.clone(),
        toolchain_key: native.toolchain_key.clone(),
        toolchain_identity_generation: native.toolchain_identity_generation,
        authorization_key: native.authorization_key.clone(),
        property_contract_sha256: native.recipe.property_contract_sha256.clone(),
        canonical_build_dir: build.to_string_lossy().into_owned(),
        core_archive,
        core_objects,
        core_tree_sha256,
        core_command_graph_sha256: observed_core_command_graph_sha256,
    };
    let observed_paths = files
        .iter()
        .map(|file| file.relative_path.clone())
        .collect::<BTreeSet<_>>();
    if observed_paths != expected_core_paths(&manifest) {
        anyhow::bail!("ReleaseCoreSeed Core tree contains unbound files");
    }
    let payload = serde_json::to_vec_pretty(&manifest)?;
    if payload.len() as u64 > MAX_MANIFEST_BYTES {
        anyhow::bail!("ReleaseCoreSeed manifest exceeds the byte bound");
    }
    map_gate(native_relink::atomic_write_regular(
        &build.join("core").join(MANIFEST_FILE),
        &payload,
    ))?;
    let compiler_executables = compiler_identities_from_objects(&manifest.core_objects);
    let certificate = ReleaseCoreSeedCertificate {
        schema_version: CERTIFICATE_SCHEMA_VERSION,
        engine_contract: CERTIFICATE_ENGINE_CONTRACT.into(),
        manifest_sha256: hex::encode(Sha256::digest(&payload)),
        core_tree_sha256: manifest.core_tree_sha256.clone(),
        core_command_graph_sha256: manifest.core_command_graph_sha256.clone(),
        property_contract_sha256: manifest.property_contract_sha256.clone(),
        authorization_key: manifest.authorization_key.clone(),
        canonical_fqbn: manifest.canonical_fqbn.clone(),
        profile: manifest.profile.clone(),
        cli_version: manifest.cli_version.clone(),
        toolchain_key: manifest.toolchain_key.clone(),
        toolchain_identity_generation: manifest.toolchain_identity_generation,
        cli_executable,
        compiler_executables,
    };
    let certificate_payload = serde_json::to_vec_pretty(&certificate)?;
    if certificate_payload.len() as u64 > MAX_CERTIFICATE_BYTES {
        anyhow::bail!("ReleaseCoreSeed certificate exceeds the byte bound");
    }
    let certificate_path = certificate_location(metadata_root, certificate_path)?;
    map_gate(native_relink::atomic_write_regular(
        &certificate_path,
        &certificate_payload,
    ))?;
    Ok((files.len(), total_bytes))
}

pub(super) fn validate_for_request(
    expected: ReleaseCoreSeedExpected,
) -> Result<ValidatedReleaseCoreSeed> {
    // The independent local integrity record is the sole commit marker. Validate
    // it and the current CLI identity before trusting or even parsing the
    // Core-local manifest as reusable state. This is not an identity signature.
    let certificate_path =
        certificate_location(&expected.metadata_root, &expected.certificate_path)?;
    let certificate_metadata = std::fs::symlink_metadata(&certificate_path)
        .context("ReleaseCoreSeed certificate is missing")?;
    if !certificate_metadata.is_file()
        || metadata_is_reparse(&certificate_metadata)
        || certificate_metadata.len() == 0
        || certificate_metadata.len() > MAX_CERTIFICATE_BYTES
    {
        anyhow::bail!("ReleaseCoreSeed certificate is unsafe or exceeds the byte bound");
    }
    let certificate: ReleaseCoreSeedCertificate =
        serde_json::from_slice(&std::fs::read(&certificate_path)?)?;
    let observed_cli = exact_external_file_identity(&expected.cli_executable)?;
    if certificate.schema_version != CERTIFICATE_SCHEMA_VERSION
        || certificate.engine_contract != CERTIFICATE_ENGINE_CONTRACT
        || certificate.canonical_fqbn != expected.fqbn
        || certificate.profile != "release"
        || certificate.cli_version != expected.cli_version
        || certificate.toolchain_key != expected.toolchain_key
        || certificate.toolchain_identity_generation != expected.toolchain_identity_generation
        || certificate.authorization_key != expected.authorization_key
        || certificate.property_contract_sha256 != expected.property_contract_sha256
        || certificate.cli_executable != observed_cli
        || !is_sha256(&certificate.manifest_sha256)
        || !is_sha256(&certificate.core_tree_sha256)
        || !is_sha256(&certificate.core_command_graph_sha256)
        || !is_sha256(&certificate.authorization_key)
        || !is_sha256(&certificate.property_contract_sha256)
        || certificate.compiler_executables.is_empty()
    {
        anyhow::bail!("ReleaseCoreSeed certificate does not match the current request identity");
    }

    let manifest_path = expected.build_dir.join("core").join(MANIFEST_FILE);
    let metadata =
        std::fs::symlink_metadata(&manifest_path).context("ReleaseCoreSeed manifest is missing")?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) || metadata.len() > MAX_MANIFEST_BYTES
    {
        anyhow::bail!("ReleaseCoreSeed manifest is unsafe or exceeds the byte bound");
    }
    let manifest_payload = std::fs::read(&manifest_path)?;
    if hex::encode(Sha256::digest(&manifest_payload)) != certificate.manifest_sha256 {
        anyhow::bail!("ReleaseCoreSeed Core manifest changed after integrity sealing");
    }
    let manifest: ReleaseCoreSeedManifest = serde_json::from_slice(&manifest_payload)?;
    if certificate.core_tree_sha256 != manifest.core_tree_sha256
        || certificate.core_command_graph_sha256 != manifest.core_command_graph_sha256
        || certificate.property_contract_sha256 != manifest.property_contract_sha256
        || certificate.authorization_key != manifest.authorization_key
        || certificate.canonical_fqbn != manifest.canonical_fqbn
        || certificate.profile != manifest.profile
        || certificate.cli_version != manifest.cli_version
        || certificate.cli_executable != manifest.cli_executable
        || certificate.toolchain_key != manifest.toolchain_key
        || certificate.toolchain_identity_generation != manifest.toolchain_identity_generation
        || certificate.compiler_executables
            != compiler_identities_from_objects(&manifest.core_objects)
    {
        anyhow::bail!("ReleaseCoreSeed certificate and Core manifest bindings differ");
    }
    for compiler in &certificate.compiler_executables {
        if exact_external_file_identity(Path::new(&compiler.canonical_path))? != *compiler {
            anyhow::bail!("ReleaseCoreSeed recorded compiler executable identity changed");
        }
    }
    validate_manifest(&manifest, &certificate, &expected)
}

fn empty_build_after_failure(build: &Path) -> Result<()> {
    match std::fs::remove_dir_all(build) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "ReleaseCoreSeed could not remove failed target build {}",
                    build.display()
                )
            });
        }
    }
    std::fs::create_dir_all(build).with_context(|| {
        format!(
            "ReleaseCoreSeed could not recreate failed target build {}",
            build.display()
        )
    })?;
    let mut entries = std::fs::read_dir(build).with_context(|| {
        format!(
            "ReleaseCoreSeed could not verify reset target build {}",
            build.display()
        )
    })?;
    if entries.next().transpose()?.is_some() {
        anyhow::bail!(
            "ReleaseCoreSeed reset target build is not empty: {}",
            build.display()
        );
    }
    Ok(())
}

pub(super) fn quarantine_preserving_validated_core(
    validated: ValidatedReleaseCoreSeed,
    managed_build_parent: &Path,
) -> Result<ReleaseCoreSeedQuarantine> {
    let parent = canonical_directory(managed_build_parent)?;
    let build = canonical_directory(&validated.expected.build_dir)?;
    if build.parent() != Some(parent.as_path()) {
        anyhow::bail!("ReleaseCoreSeed build is not a direct child of the managed build root");
    }
    // Revalidate immediately before the first rename; no unchecked interval is
    // allowed between local qualification and moving compiler-owned state.
    validate_manifest(
        &validated.manifest,
        &validated.certificate,
        &validated.expected,
    )?;
    let nonce = QUARANTINE_NONCE.fetch_add(1, Ordering::Relaxed);
    let quarantine = parent.join(format!(
        ".ck-release-core-quarantine-v1-{}-{}-{nonce}",
        std::process::id(),
        &validated.manifest.core_tree_sha256[..12]
    ));
    if quarantine.exists() {
        anyhow::bail!("ReleaseCoreSeed quarantine destination already exists");
    }
    std::fs::rename(&build, &quarantine)
        .context("ReleaseCoreSeed could not quarantine the previous build graph")?;
    let operation = (|| -> Result<()> {
        std::fs::create_dir(&build)
            .context("ReleaseCoreSeed could not recreate the empty build directory")?;
        std::fs::rename(quarantine.join("core"), build.join("core"))
            .context("ReleaseCoreSeed could not restore the integrity-verified Core directory")?;
        validate_manifest(
            &validated.manifest,
            &validated.certificate,
            &validated.expected,
        )?;
        Ok(())
    })();
    if let Err(error) = operation {
        empty_build_after_failure(&build).context(
            "ReleaseCoreSeed restore failed and the target build could not be proven empty",
        )?;
        return Err(error.context(
            "ReleaseCoreSeed restore failed; the target build was reset empty for full CLI fallback",
        ));
    }
    let file_count = validated.file_count;
    let total_bytes = validated.total_bytes;
    Ok(ReleaseCoreSeedQuarantine {
        quarantine_path: quarantine,
        file_count,
        total_bytes,
        validated,
    })
}

/// Revalidate the exact staged Core after Arduino CLI exits.  File identities
/// include content and high-resolution modification time, so a compiler touch
/// or rebuild (even with identical bytes) prevents the seeded route marker.
pub(super) fn verify_staged_after_cli(seed: &ReleaseCoreSeedQuarantine) -> Result<()> {
    let observed = validate_for_request(seed.validated.expected.clone())?;
    if observed.manifest != seed.validated.manifest
        || observed.certificate != seed.validated.certificate
        || observed.file_count != seed.file_count
        || observed.total_bytes != seed.total_bytes
    {
        anyhow::bail!("ReleaseCoreSeed staged proof changed while Arduino CLI was running");
    }
    Ok(())
}

pub(super) fn remove_owned_quarantine(path: &Path, managed_build_parent: &Path) -> Result<()> {
    let parent = canonical_directory(managed_build_parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("ReleaseCoreSeed quarantine has no UTF-8 leaf name")?;
    if !name.starts_with(".ck-release-core-quarantine-v1-")
        || path.parent() != Some(parent.as_path())
    {
        anyhow::bail!("refusing to remove an unowned ReleaseCoreSeed quarantine");
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        anyhow::bail!("ReleaseCoreSeed quarantine is not an ordinary directory");
    }
    std::fs::remove_dir_all(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        managed_parent: PathBuf,
        build: PathBuf,
        platform: PathBuf,
        tools: PathBuf,
        object: PathBuf,
        compiler: PathBuf,
        cli: PathBuf,
        expected: ReleaseCoreSeedExpected,
    }

    fn dep_token(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "\\ ")
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().expect("tempdir");
        let managed_parent = temp.path().join("CK_Builds/build");
        let build = managed_parent.join("sketch_arduino_avr_uno_rel");
        let core = build.join("core");
        let platform = temp.path().join("packages/arduino/hardware/avr/1.8.6");
        let tools = temp.path().join("packages/arduino/tools/avr-gcc/7.3.0");
        let metadata_root = temp.path().join("CK_Builds/metadata");
        let cli = temp.path().join(if cfg!(windows) {
            "bin/arduino-cli.exe"
        } else {
            "bin/arduino-cli"
        });
        let compiler = tools.join(if cfg!(windows) {
            "bin/avr-g++.exe"
        } else {
            "bin/avr-g++"
        });
        let source = platform.join("cores/arduino/main.cpp");
        let header = platform.join("cores/arduino/Arduino.h");
        let object = core.join("main.cpp.o");
        let depfile = core.join("main.cpp.d");
        for directory in [
            &managed_parent,
            &core,
            source.parent().expect("source parent"),
            &tools,
            &metadata_root,
            cli.parent().expect("cli parent"),
            compiler.parent().expect("compiler parent"),
            &build.join("sketch"),
            &build.join("libraries/MsTimer2"),
        ] {
            std::fs::create_dir_all(directory).expect("fixture directory");
        }
        std::fs::write(&source, b"void init_core() {}\n").expect("source");
        std::fs::write(&header, b"#define ARDUINO 10819\n").expect("header");
        std::fs::write(&cli, b"fixture-arduino-cli").expect("cli");
        std::fs::write(&compiler, b"fixture-avr-g++").expect("compiler");
        std::fs::write(&object, b"authenticated-object").expect("object");
        std::fs::write(core.join("core.a"), b"authenticated-archive").expect("archive");
        std::fs::write(
            &depfile,
            format!(
                "{}: {} {}\n",
                dep_token(&object),
                dep_token(&source),
                dep_token(&header)
            ),
        )
        .expect("depfile");
        std::fs::write(build.join("build.options.json"), b"{\"old\":true}").expect("old options");
        std::fs::write(build.join("sketch/old.o"), b"old-sketch").expect("old sketch");
        std::fs::write(build.join("libraries/MsTimer2/old.o"), b"old-library")
            .expect("old library");
        std::fs::write(build.join("firmware.hex"), b":00000001FF\n").expect("old firmware");

        let canonical_build = canonical_directory(&build).expect("canonical build");
        let canonical_platform = canonical_directory(&platform).expect("canonical platform");
        let contract = NativeReleaseCoreObjectContract {
            working_directory: temp.path().to_path_buf(),
            compiler_executable: compiler.clone(),
            source: source.clone(),
            object: object.clone(),
            depfile: depfile.clone(),
            command_sha256: "c".repeat(64),
        };
        let core_object = capture_object(
            &contract,
            &canonical_build,
            &canonical_platform,
            &[temp.path().to_path_buf()],
        )
        .expect("capture object");
        let core_archive =
            relative_file_identity(&core.join("core.a"), &canonical_build).expect("archive id");
        let (files, _, core_tree_sha256) = capture_core_tree(&canonical_build).expect("core tree");
        let mut manifest = ReleaseCoreSeedManifest {
            schema_version: SCHEMA_VERSION,
            engine_contract: ENGINE_CONTRACT.into(),
            capability_class: CAPABILITY_CLASS.into(),
            canonical_fqbn: "arduino:avr:uno".into(),
            profile: "release".into(),
            cli_version: "arduino-cli Version: 1.4.1".into(),
            cli_executable: exact_external_file_identity(&cli).expect("cli identity"),
            toolchain_key: "arduino|avr|1.8.6|strong".into(),
            toolchain_identity_generation: 7,
            authorization_key: "a".repeat(64),
            property_contract_sha256: "b".repeat(64),
            canonical_build_dir: canonical_build.to_string_lossy().into_owned(),
            core_archive,
            core_objects: vec![core_object],
            core_tree_sha256,
            core_command_graph_sha256: String::new(),
        };
        manifest.core_command_graph_sha256 =
            core_command_graph_sha256(&manifest.core_objects, &canonical_build);
        assert_eq!(
            files
                .iter()
                .map(|file| file.relative_path.clone())
                .collect::<BTreeSet<_>>(),
            expected_core_paths(&manifest)
        );
        let payload = serde_json::to_vec_pretty(&manifest).expect("manifest json");
        map_gate(native_relink::atomic_write_regular(
            &core.join(MANIFEST_FILE),
            &payload,
        ))
        .expect("manifest commit");
        let certificate_path =
            metadata_root.join("release_core_seed_certificate_arduino_avr_uno_fixture_rel.json");
        let certificate = ReleaseCoreSeedCertificate {
            schema_version: CERTIFICATE_SCHEMA_VERSION,
            engine_contract: CERTIFICATE_ENGINE_CONTRACT.into(),
            manifest_sha256: hex::encode(Sha256::digest(&payload)),
            core_tree_sha256: manifest.core_tree_sha256.clone(),
            core_command_graph_sha256: manifest.core_command_graph_sha256.clone(),
            property_contract_sha256: manifest.property_contract_sha256.clone(),
            authorization_key: manifest.authorization_key.clone(),
            canonical_fqbn: manifest.canonical_fqbn.clone(),
            profile: manifest.profile.clone(),
            cli_version: manifest.cli_version.clone(),
            toolchain_key: manifest.toolchain_key.clone(),
            toolchain_identity_generation: manifest.toolchain_identity_generation,
            cli_executable: exact_external_file_identity(&cli).expect("cli identity"),
            compiler_executables: compiler_identities_from_objects(&manifest.core_objects),
        };
        map_gate(native_relink::atomic_write_regular(
            &certificate_path,
            &serde_json::to_vec_pretty(&certificate).expect("certificate json"),
        ))
        .expect("certificate commit");
        let expected = ReleaseCoreSeedExpected {
            fqbn: manifest.canonical_fqbn.clone(),
            cli_version: manifest.cli_version.clone(),
            toolchain_key: manifest.toolchain_key.clone(),
            toolchain_identity_generation: manifest.toolchain_identity_generation,
            authorization_key: manifest.authorization_key.clone(),
            property_contract_sha256: manifest.property_contract_sha256.clone(),
            build_dir: build.clone(),
            platform_root: platform.clone(),
            metadata_root: metadata_root.clone(),
            certificate_path,
            cli_executable: cli.clone(),
            allowed_working_roots: vec![temp.path().to_path_buf()],
        };
        Fixture {
            _temp: temp,
            managed_parent,
            build,
            platform,
            tools,
            object,
            compiler,
            cli,
            expected,
        }
    }

    #[test]
    fn safe_relative_path_rejects_escape_and_absolute_paths() {
        assert!(safe_relative_path("core/main.cpp.o"));
        assert!(!safe_relative_path("../core.a"));
        assert!(!safe_relative_path("C:/outside/core.a"));
        assert!(!safe_relative_path(""));
    }

    #[test]
    fn owned_quarantine_removal_rejects_unrelated_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let parent = temp.path().join("build");
        let unrelated = parent.join("user-project");
        std::fs::create_dir_all(&unrelated).expect("unrelated");
        assert!(remove_owned_quarantine(&unrelated, &parent).is_err());
        assert!(unrelated.is_dir());
    }

    #[test]
    fn validated_quarantine_restores_only_core_and_leaves_old_graph_outside() {
        let fixture = fixture();
        let validated = validate_for_request(fixture.expected.clone()).expect("valid seed");
        let outcome = quarantine_preserving_validated_core(validated, &fixture.managed_parent)
            .expect("quarantine");
        assert!(fixture.build.join("core/core.a").is_file());
        assert!(fixture.build.join("core/main.cpp.o").is_file());
        assert!(fixture.build.join("core/main.cpp.d").is_file());
        assert!(fixture.build.join("core").join(MANIFEST_FILE).is_file());
        assert!(!fixture.build.join("build.options.json").exists());
        assert!(!fixture.build.join("sketch").exists());
        assert!(!fixture.build.join("libraries").exists());
        assert!(!fixture.build.join("firmware.hex").exists());
        assert!(outcome.quarantine_path.join("build.options.json").is_file());
        assert!(outcome.quarantine_path.join("sketch/old.o").is_file());
        assert!(
            outcome
                .quarantine_path
                .join("libraries/MsTimer2/old.o")
                .is_file()
        );
        assert!(!outcome.quarantine_path.join("core").exists());
        remove_owned_quarantine(&outcome.quarantine_path, &fixture.managed_parent)
            .expect("owned cleanup");
        assert!(!outcome.quarantine_path.exists());
    }

    #[test]
    fn post_cli_proof_rejects_same_content_mtime_touch() {
        let fixture = fixture();
        let validated = validate_for_request(fixture.expected.clone()).expect("valid seed");
        let outcome = quarantine_preserving_validated_core(validated, &fixture.managed_parent)
            .expect("quarantine");
        verify_staged_after_cli(&outcome).expect("unchanged staged Core");

        let bytes = std::fs::read(&fixture.object).expect("object bytes");
        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(&fixture.object, bytes).expect("same-content touch");
        assert!(verify_staged_after_cli(&outcome).is_err());

        remove_owned_quarantine(&outcome.quarantine_path, &fixture.managed_parent)
            .expect("owned cleanup");
    }

    #[test]
    fn failed_build_reset_is_fallible_and_proves_empty() {
        let temp = tempfile::tempdir().expect("tempdir");
        let build = temp.path().join("build");
        std::fs::create_dir_all(build.join("nested")).expect("build tree");
        std::fs::write(build.join("nested/old.o"), b"old").expect("old object");
        empty_build_after_failure(&build).expect("reset succeeds");
        assert!(std::fs::read_dir(&build).unwrap().next().is_none());

        let not_a_directory = temp.path().join("not-a-directory");
        std::fs::write(&not_a_directory, b"occupied").expect("occupied path");
        assert!(empty_build_after_failure(&not_a_directory).is_err());
        assert!(not_a_directory.is_file());
    }

    #[test]
    fn same_size_core_object_tamper_fails_closed() {
        let fixture = fixture();
        let length = std::fs::metadata(&fixture.object).unwrap().len() as usize;
        std::fs::write(&fixture.object, vec![b'X'; length]).expect("same-size tamper");
        assert!(validate_for_request(fixture.expected).is_err());
        assert!(fixture.build.join("build.options.json").is_file());
    }

    #[test]
    fn request_identity_drift_fails_closed() {
        let fixture = fixture();
        for mutate in ["fqbn", "cli", "toolchain", "authorization", "properties"] {
            let mut expected = fixture.expected.clone();
            match mutate {
                "fqbn" => expected.fqbn = "arduino:avr:mega".into(),
                "cli" => expected.cli_version.push_str("-changed"),
                "toolchain" => expected.toolchain_key.push_str("-changed"),
                "authorization" => expected.authorization_key = "d".repeat(64),
                "properties" => expected.property_contract_sha256 = "e".repeat(64),
                _ => unreachable!(),
            }
            assert!(validate_for_request(expected).is_err(), "{mutate} drift");
        }
    }

    #[test]
    fn missing_certificate_and_manifest_command_tamper_fail_closed() {
        let missing = fixture();
        std::fs::remove_file(&missing.expected.certificate_path).expect("remove certificate");
        assert!(validate_for_request(missing.expected).is_err());

        let tampered = fixture();
        let manifest_path = tampered.build.join("core").join(MANIFEST_FILE);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["coreObjects"][0]["commandSha256"] = serde_json::Value::String("d".repeat(64));
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .expect("tampered manifest");
        assert!(validate_for_request(tampered.expected).is_err());
    }

    #[test]
    fn cli_compiler_and_working_root_drift_fail_closed() {
        let cli_changed = fixture();
        let cli_len = std::fs::metadata(&cli_changed.cli).unwrap().len() as usize;
        std::fs::write(&cli_changed.cli, vec![b'X'; cli_len]).expect("same-size CLI change");
        assert!(validate_for_request(cli_changed.expected).is_err());

        let compiler_changed = fixture();
        let compiler_len = std::fs::metadata(&compiler_changed.compiler).unwrap().len() as usize;
        std::fs::write(&compiler_changed.compiler, vec![b'Y'; compiler_len])
            .expect("same-size compiler change");
        assert!(validate_for_request(compiler_changed.expected).is_err());

        let cwd_changed = fixture();
        let mut expected = cwd_changed.expected;
        expected.allowed_working_roots = vec![cwd_changed.platform];
        assert!(validate_for_request(expected).is_err());
    }

    #[test]
    fn manifest_cli_compiler_and_cwd_tamper_fail_closed() {
        for field in ["cli", "compiler", "cwd"] {
            let case_fixture = fixture();
            let manifest_path = case_fixture.build.join("core").join(MANIFEST_FILE);
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
            match field {
                "cli" => {
                    manifest["cliExecutable"]["canonicalPath"] =
                        serde_json::Value::String(case_fixture.compiler.display().to_string());
                }
                "compiler" => {
                    manifest["coreObjects"][0]["compilerExecutable"]["canonicalPath"] =
                        serde_json::Value::String(case_fixture.cli.display().to_string());
                }
                "cwd" => {
                    manifest["coreObjects"][0]["workingDirectory"] =
                        serde_json::Value::String(case_fixture.platform.display().to_string());
                }
                _ => unreachable!(),
            }
            std::fs::write(
                &manifest_path,
                serde_json::to_vec_pretty(&manifest).unwrap(),
            )
            .expect("tampered manifest");
            assert!(
                validate_for_request(case_fixture.expected).is_err(),
                "{field} tamper"
            );
        }
    }

    #[test]
    fn certificate_path_cannot_escape_exact_metadata_root() {
        let fixture = fixture();
        let mut expected = fixture.expected;
        expected.certificate_path = fixture
            .build
            .join("release_core_seed_certificate_escape_rel.json");
        assert!(validate_for_request(expected).is_err());
    }

    #[test]
    fn dependency_escape_or_reparse_never_validates() {
        let fixture = fixture();
        let outside = fixture._temp.path().join("outside/hostile.h");
        std::fs::create_dir_all(outside.parent().unwrap()).expect("outside dir");
        std::fs::write(&outside, b"#define HOSTILE 1\n").expect("outside header");
        let depfile = fixture.build.join("core/main.cpp.d");
        let source = fixture.platform.join("cores/arduino/main.cpp");
        std::fs::write(
            &depfile,
            format!(
                "{}: {} {}\n",
                dep_token(&fixture.object),
                dep_token(&source),
                dep_token(&outside)
            ),
        )
        .expect("escaped depfile");
        assert!(validate_for_request(fixture.expected.clone()).is_err());

        let linked = fixture.build.join("core/linked");
        #[cfg(windows)]
        junction::create(&fixture.tools, &linked).expect("core junction");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&fixture.tools, &linked).expect("core symlink");
        assert!(capture_core_tree(&fixture.build).is_err());
    }
}
